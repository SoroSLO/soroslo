import { DatabaseSync } from "node:sqlite";
import type { SoroSloConfig } from "@soroslo/config";
import { canonicalJson, type RunState } from "@soroslo/shared";
import type { IncidentRuntimeState, OperationalState } from "@soroslo/slo-engine";
import { runMigrations } from "./migrations.js";
import type {
  AssertionDetail,
  CheckSummary,
  IncidentSummary,
  NotificationAttemptSummary,
  PersistedRunInput,
  RunDetail,
  RunSummary,
  SchedulerState,
  ServiceDetail,
  ServiceSummary,
  StepResultDetail,
  StoredIncident,
  StoredIncidentRuntime,
  StoredReliabilityRun
} from "./models.js";

function record(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new TypeError("SQLite row is not an object");
  }
  return row as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`SQLite field '${field}' is not a string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`SQLite field '${field}' is not a number`);
  }
  return value;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : canonicalJson(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function qualifiedCheckId(serviceId: string, checkId: string): string {
  return `${serviceId}:${checkId}`;
}

export class SoroSloStorage {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  static open(path = ":memory:"): SoroSloStorage {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return new SoroSloStorage(database);
  }

  migrate(appliedAt?: string): void {
    runMigrations(this.database, appliedAt);
  }

  close(): void {
    this.database.close();
  }

  syncConfiguration(
    config: SoroSloConfig,
    configHash: string,
    now = new Date().toISOString()
  ): string[] {
    const checkIds: string[] = [];

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE checks SET enabled = 0, updated_at = ?").run(now);

      const upsertService = this.database.prepare(`
        INSERT INTO services(id, name, config_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          config_hash = excluded.config_hash,
          updated_at = excluded.updated_at
      `);

      const upsertCheck = this.database.prepare(`
        INSERT INTO checks(
          id, local_id, service_id, name, network, schedule,
          config_hash, enabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          local_id = excluded.local_id,
          service_id = excluded.service_id,
          name = excluded.name,
          network = excluded.network,
          schedule = excluded.schedule,
          config_hash = excluded.config_hash,
          enabled = 1,
          updated_at = excluded.updated_at
      `);

      const ensureRuntime = this.database.prepare(`
        INSERT INTO check_runtime_state(
          check_id, operational_state, consecutive_failures,
          consecutive_passes, active_incident_id, updated_at
        )
        VALUES (?, 'healthy', 0, 0, NULL, ?)
        ON CONFLICT(check_id) DO NOTHING
      `);

      for (const service of config.services) {
        upsertService.run(service.id, service.name, configHash, now, now);

        for (const check of service.checks) {
          const checkId = qualifiedCheckId(service.id, check.id);
          checkIds.push(checkId);
          upsertCheck.run(
            checkId,
            check.id,
            service.id,
            check.name,
            check.network,
            check.every,
            configHash,
            now,
            now
          );
          ensureRuntime.run(checkId, now);
        }
      }

      this.database.exec("COMMIT");
      return checkIds;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordRun(input: PersistedRunInput): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT 1 AS present FROM runs WHERE idempotency_key = ?")
        .get(input.idempotencyKey);
      if (existing !== undefined) {
        this.database.exec("ROLLBACK");
        return false;
      }

      this.database
        .prepare(
          `
          INSERT INTO runs(
            id, idempotency_key, check_id, scheduled_at, started_at,
            finished_at, state, observed_ledger, rpc_endpoint_fingerprint,
            config_hash, observer_error_code, observer_error_message
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.id,
          input.idempotencyKey,
          input.checkId,
          input.scheduledAt ?? null,
          input.startedAt,
          input.finishedAt,
          input.state,
          input.observedLedger ?? null,
          input.rpcEndpointFingerprint ?? null,
          input.configHash,
          input.observerErrorCode ?? null,
          input.observerErrorMessage ?? null
        );

      const insertStep = this.database.prepare(`
        INSERT INTO step_results(
          id, run_id, step_id, ordinal, state, contract_id, function_name,
          result_json, raw_return_xdr, min_resource_fee, elapsed_ms,
          evidence_json, failure_kind, failure_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAssertion = this.database.prepare(`
        INSERT INTO assertion_results(
          id, step_result_id, ordinal, path, operator,
          expected_json, observed_json, passed, reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const step of input.steps) {
        const stepResultId = `${input.id}:step:${step.ordinal}`;
        insertStep.run(
          stepResultId,
          input.id,
          step.stepId,
          step.ordinal,
          step.state,
          step.contractId,
          step.functionName,
          jsonOrNull(step.result),
          step.rawReturnXdr ?? null,
          step.minResourceFee ?? null,
          step.elapsedMs ?? null,
          jsonOrNull(step.evidence),
          step.failureKind ?? null,
          step.failureMessage ?? null
        );

        for (const [ordinal, assertion] of step.assertions.entries()) {
          insertAssertion.run(
            `${stepResultId}:assertion:${ordinal}`,
            stepResultId,
            ordinal,
            assertion.path,
            assertion.operator,
            jsonOrNull(assertion.expected),
            jsonOrNull(assertion.observed),
            assertion.passed ? 1 : 0,
            assertion.reason
          );
        }
      }

      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  hasRunIdempotencyKey(idempotencyKey: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 AS present FROM runs WHERE idempotency_key = ?")
        .get(idempotencyKey) !== undefined
    );
  }

  listReliabilityRuns(
    checkId: string,
    since: string,
    until = new Date().toISOString()
  ): StoredReliabilityRun[] {
    return this.database
      .prepare(
        `
        SELECT id, state, finished_at
        FROM runs
        WHERE check_id = ? AND finished_at >= ? AND finished_at <= ?
        ORDER BY finished_at ASC
      `
      )
      .all(checkId, since, until)
      .map((rawRow) => {
        const row = record(rawRow);
        return {
          id: requiredString(row.id, "id"),
          state: requiredString(row.state, "state") as RunState,
          finishedAt: requiredString(row.finished_at, "finished_at")
        };
      });
  }

  getSchedulerState(checkId: string): SchedulerState | null {
    const rawRow = this.database
      .prepare(
        `
        SELECT check_id, last_scheduled_at, next_scheduled_at,
               lease_owner, lease_expires_at, schedule_policy_hash
        FROM scheduler_state
        WHERE check_id = ?
      `
      )
      .get(checkId);
    if (rawRow === undefined) return null;

    const row = record(rawRow);
    return {
      checkId: requiredString(row.check_id, "check_id"),
      lastScheduledAt: nullableString(row.last_scheduled_at),
      nextScheduledAt: requiredString(row.next_scheduled_at, "next_scheduled_at"),
      leaseOwner: nullableString(row.lease_owner),
      leaseExpiresAt: nullableString(row.lease_expires_at),
      schedulePolicyHash: nullableString(row.schedule_policy_hash)
    };
  }

  ensureSchedulerState(
    checkId: string,
    nextScheduledAt: string,
    schedulePolicyHash: string
  ): SchedulerState {
    this.database
      .prepare(
        `
        INSERT INTO scheduler_state(
          check_id, last_scheduled_at, next_scheduled_at,
          lease_owner, lease_expires_at, schedule_policy_hash
        )
        VALUES (?, NULL, ?, NULL, NULL, ?)
        ON CONFLICT(check_id) DO NOTHING
      `
      )
      .run(checkId, nextScheduledAt, schedulePolicyHash);

    const state = this.getSchedulerState(checkId);
    if (!state) throw new Error(`Unable to initialize scheduler state for ${checkId}`);
    return state;
  }

  /**
   * Re-phase an existing schedule after the interval or jitter policy changed.
   *
   * The update is conditional on the row still holding `expectedScheduledAt`,
   * so two runners reconciling at once cannot overwrite each other: the loser
   * re-reads the row the winner wrote. A leased row is left alone, because the
   * lease holder owns the transition.
   */
  reconcileSchedulePolicy(
    checkId: string,
    expectedScheduledAt: string,
    nextScheduledAt: string,
    schedulePolicyHash: string,
    now: string
  ): SchedulerState {
    this.database
      .prepare(
        `
        UPDATE scheduler_state
        SET next_scheduled_at = ?, schedule_policy_hash = ?
        WHERE check_id = ?
          AND next_scheduled_at = ?
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      `
      )
      .run(nextScheduledAt, schedulePolicyHash, checkId, expectedScheduledAt, now);

    const state = this.getSchedulerState(checkId);
    if (!state) throw new Error(`Unable to reconcile scheduler state for ${checkId}`);
    return state;
  }

  tryClaimSchedule(
    checkId: string,
    scheduledAt: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string
  ): boolean {
    const result = this.database
      .prepare(
        `
        UPDATE scheduler_state
        SET lease_owner = ?, lease_expires_at = ?
        WHERE check_id = ?
          AND next_scheduled_at = ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `
      )
      .run(leaseOwner, leaseExpiresAt, checkId, scheduledAt, now);

    return Number(result.changes) === 1;
  }

  completeSchedule(
    checkId: string,
    scheduledAt: string,
    nextScheduledAt: string,
    leaseOwner: string
  ): boolean {
    const result = this.database
      .prepare(
        `
        UPDATE scheduler_state
        SET last_scheduled_at = ?,
            next_scheduled_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE check_id = ?
          AND next_scheduled_at = ?
          AND lease_owner = ?
      `
      )
      .run(scheduledAt, nextScheduledAt, checkId, scheduledAt, leaseOwner);

    return Number(result.changes) === 1;
  }

  skipMissedSchedule(
    checkId: string,
    expectedScheduledAt: string,
    nextScheduledAt: string,
    now: string
  ): boolean {
    const result = this.database
      .prepare(
        `
        UPDATE scheduler_state
        SET last_scheduled_at = ?,
            next_scheduled_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE check_id = ?
          AND next_scheduled_at = ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `
      )
      .run(expectedScheduledAt, nextScheduledAt, checkId, expectedScheduledAt, now);

    return Number(result.changes) === 1;
  }

  releaseScheduleLease(checkId: string, leaseOwner: string): void {
    this.database
      .prepare(
        `
        UPDATE scheduler_state
        SET lease_owner = NULL, lease_expires_at = NULL
        WHERE check_id = ? AND lease_owner = ?
      `
      )
      .run(checkId, leaseOwner);
  }

  getIncidentRuntime(checkId: string): StoredIncidentRuntime {
    const rawRow = this.database
      .prepare(
        `
        SELECT operational_state, consecutive_failures,
               consecutive_passes, active_incident_id
        FROM check_runtime_state
        WHERE check_id = ?
      `
      )
      .get(checkId);

    if (rawRow === undefined) {
      return {
        state: "healthy",
        consecutiveFailures: 0,
        consecutivePasses: 0,
        activeIncidentId: null
      };
    }

    const row = record(rawRow);
    return {
      state: requiredString(row.operational_state, "operational_state") as OperationalState,
      consecutiveFailures: requiredNumber(row.consecutive_failures, "consecutive_failures"),
      consecutivePasses: requiredNumber(row.consecutive_passes, "consecutive_passes"),
      activeIncidentId: nullableString(row.active_incident_id)
    };
  }

  saveIncidentRuntime(
    checkId: string,
    runtime: IncidentRuntimeState,
    activeIncidentId: string | null,
    updatedAt: string
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO check_runtime_state(
          check_id, operational_state, consecutive_failures,
          consecutive_passes, active_incident_id, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(check_id) DO UPDATE SET
          operational_state = excluded.operational_state,
          consecutive_failures = excluded.consecutive_failures,
          consecutive_passes = excluded.consecutive_passes,
          active_incident_id = excluded.active_incident_id,
          updated_at = excluded.updated_at
      `
      )
      .run(
        checkId,
        runtime.state,
        runtime.consecutiveFailures,
        runtime.consecutivePasses,
        activeIncidentId,
        updatedAt
      );
  }

  openIncident(input: {
    id: string;
    checkId: string;
    openedAt: string;
    openingRunId: string;
    failureCount: number;
    summary: string;
  }): void {
    this.database
      .prepare(
        `
        INSERT INTO incidents(
          id, check_id, opened_at, recovered_at, state,
          opening_run_id, recovery_run_id, failure_count, summary
        )
        VALUES (?, ?, ?, NULL, 'open', ?, NULL, ?, ?)
      `
      )
      .run(
        input.id,
        input.checkId,
        input.openedAt,
        input.openingRunId,
        input.failureCount,
        input.summary
      );
  }

  recoverIncident(input: { id: string; recoveredAt: string; recoveryRunId: string }): boolean {
    const result = this.database
      .prepare(
        `
        UPDATE incidents
        SET recovered_at = ?,
            recovery_run_id = ?,
            state = 'recovered'
        WHERE id = ? AND state = 'open'
      `
      )
      .run(input.recoveredAt, input.recoveryRunId, input.id);

    return Number(result.changes) === 1;
  }

  getIncident(id: string): StoredIncident | null {
    const rawRow = this.database
      .prepare(
        `
        SELECT id, check_id, opened_at, recovered_at, state,
               opening_run_id, recovery_run_id, failure_count, summary
        FROM incidents
        WHERE id = ?
      `
      )
      .get(id);
    if (rawRow === undefined) return null;

    const row = record(rawRow);
    return {
      id: requiredString(row.id, "id"),
      checkId: requiredString(row.check_id, "check_id"),
      openedAt: requiredString(row.opened_at, "opened_at"),
      recoveredAt: nullableString(row.recovered_at),
      state: requiredString(row.state, "state") as "open" | "recovered",
      openingRunId: requiredString(row.opening_run_id, "opening_run_id"),
      recoveryRunId: nullableString(row.recovery_run_id),
      failureCount: requiredNumber(row.failure_count, "failure_count"),
      summary: requiredString(row.summary, "summary")
    };
  }

  listServices(): ServiceSummary[] {
    return this.database
      .prepare(
        `
        SELECT
          s.id,
          s.name,
          s.config_hash,
          s.created_at,
          s.updated_at,
          COUNT(c.id) AS check_count,
          COALESCE(SUM(CASE WHEN c.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_check_count
        FROM services s
        LEFT JOIN checks c ON c.service_id = s.id
        GROUP BY s.id
        ORDER BY s.name ASC, s.id ASC
      `
      )
      .all()
      .map((rawRow) => {
        const row = record(rawRow);
        return {
          id: requiredString(row.id, "id"),
          name: requiredString(row.name, "name"),
          configHash: requiredString(row.config_hash, "config_hash"),
          createdAt: requiredString(row.created_at, "created_at"),
          updatedAt: requiredString(row.updated_at, "updated_at"),
          checkCount: requiredNumber(row.check_count, "check_count"),
          enabledCheckCount: requiredNumber(row.enabled_check_count, "enabled_check_count")
        };
      });
  }

  listChecks(serviceId?: string): CheckSummary[] {
    const sql = `
      SELECT
        c.id,
        c.local_id,
        c.service_id,
        c.name,
        c.network,
        c.schedule,
        c.config_hash,
        c.enabled,
        c.created_at,
        c.updated_at,
        COALESCE(crs.operational_state, 'healthy') AS operational_state,
        crs.active_incident_id,
        lr.id AS last_run_id,
        lr.state AS last_run_state,
        lr.finished_at AS last_run_finished_at
      FROM checks c
      LEFT JOIN check_runtime_state crs ON crs.check_id = c.id
      LEFT JOIN runs lr ON lr.id = (
        SELECT r2.id
        FROM runs r2
        WHERE r2.check_id = c.id
        ORDER BY r2.finished_at DESC, r2.id DESC
        LIMIT 1
      )
      WHERE (? IS NULL OR c.service_id = ?)
      ORDER BY c.service_id ASC, c.name ASC, c.id ASC
    `;

    return this.database
      .prepare(sql)
      .all(serviceId ?? null, serviceId ?? null)
      .map((rawRow) => {
        const row = record(rawRow);
        const lastRunState = nullableString(row.last_run_state);
        return {
          id: requiredString(row.id, "id"),
          localId: requiredString(row.local_id, "local_id"),
          serviceId: requiredString(row.service_id, "service_id"),
          name: requiredString(row.name, "name"),
          network: requiredString(row.network, "network"),
          schedule: requiredString(row.schedule, "schedule"),
          configHash: requiredString(row.config_hash, "config_hash"),
          enabled: requiredNumber(row.enabled, "enabled") === 1,
          createdAt: requiredString(row.created_at, "created_at"),
          updatedAt: requiredString(row.updated_at, "updated_at"),
          operationalState: requiredString(row.operational_state, "operational_state"),
          activeIncidentId: nullableString(row.active_incident_id),
          lastRunId: nullableString(row.last_run_id),
          lastRunState: lastRunState as RunState | null,
          lastRunFinishedAt: nullableString(row.last_run_finished_at)
        };
      });
  }

  getServiceDetail(serviceId: string): ServiceDetail | null {
    const rawRow = this.database
      .prepare(
        `
        SELECT
          s.id,
          s.name,
          s.config_hash,
          s.created_at,
          s.updated_at,
          COUNT(c.id) AS check_count,
          COALESCE(SUM(CASE WHEN c.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_check_count
        FROM services s
        LEFT JOIN checks c ON c.service_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `
      )
      .get(serviceId);

    if (rawRow === undefined) return null;
    const row = record(rawRow);
    return {
      id: requiredString(row.id, "id"),
      name: requiredString(row.name, "name"),
      configHash: requiredString(row.config_hash, "config_hash"),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      checkCount: requiredNumber(row.check_count, "check_count"),
      enabledCheckCount: requiredNumber(row.enabled_check_count, "enabled_check_count"),
      checks: this.listChecks(serviceId)
    };
  }

  getCheckSummary(checkId: string): CheckSummary | null {
    return this.listChecks().find((check) => check.id === checkId) ?? null;
  }

  listRuns(checkId: string, limit = 50, before?: string): RunSummary[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return this.database
      .prepare(
        `
        SELECT
          id, check_id, scheduled_at, started_at, finished_at, state,
          observed_ledger, rpc_endpoint_fingerprint, config_hash,
          observer_error_code, observer_error_message
        FROM runs
        WHERE check_id = ?
          AND (? IS NULL OR finished_at < ?)
        ORDER BY finished_at DESC, id DESC
        LIMIT ?
      `
      )
      .all(checkId, before ?? null, before ?? null, boundedLimit)
      .map((rawRow) => this.toRunSummary(rawRow));
  }

  getRunDetail(runId: string): RunDetail | null {
    const rawRun = this.database
      .prepare(
        `
        SELECT
          id, check_id, scheduled_at, started_at, finished_at, state,
          observed_ledger, rpc_endpoint_fingerprint, config_hash,
          observer_error_code, observer_error_message
        FROM runs
        WHERE id = ?
      `
      )
      .get(runId);
    if (rawRun === undefined) return null;

    const run = this.toRunSummary(rawRun);
    const steps = this.database
      .prepare(
        `
        SELECT
          id, step_id, ordinal, state, contract_id, function_name,
          result_json, raw_return_xdr, min_resource_fee, elapsed_ms,
          evidence_json, failure_kind, failure_message
        FROM step_results
        WHERE run_id = ?
        ORDER BY ordinal ASC
      `
      )
      .all(runId)
      .map((rawStep) => {
        const row = record(rawStep);
        const stepResultId = requiredString(row.id, "id");
        const assertions: AssertionDetail[] = this.database
          .prepare(
            `
            SELECT
              id, ordinal, path, operator, expected_json,
              observed_json, passed, reason
            FROM assertion_results
            WHERE step_result_id = ?
            ORDER BY ordinal ASC
          `
          )
          .all(stepResultId)
          .map((rawAssertion) => {
            const assertion = record(rawAssertion);
            return {
              id: requiredString(assertion.id, "id"),
              ordinal: requiredNumber(assertion.ordinal, "ordinal"),
              path: requiredString(assertion.path, "path"),
              operator: requiredString(assertion.operator, "operator"),
              expected: parseJson(assertion.expected_json),
              observed: parseJson(assertion.observed_json),
              passed: requiredNumber(assertion.passed, "passed") === 1,
              reason: requiredString(assertion.reason, "reason")
            };
          });

        const step: StepResultDetail = {
          id: stepResultId,
          stepId: requiredString(row.step_id, "step_id"),
          ordinal: requiredNumber(row.ordinal, "ordinal"),
          state: requiredString(row.state, "state") as RunState,
          contractId: requiredString(row.contract_id, "contract_id"),
          functionName: requiredString(row.function_name, "function_name"),
          result: parseJson(row.result_json),
          rawReturnXdr: nullableString(row.raw_return_xdr),
          minResourceFee: nullableString(row.min_resource_fee),
          elapsedMs: nullableNumber(row.elapsed_ms),
          evidence: parseJson(row.evidence_json),
          failureKind: nullableString(row.failure_kind),
          failureMessage: nullableString(row.failure_message),
          assertions
        };
        return step;
      });

    return { ...run, steps };
  }

  listIncidents(
    options: {
      state?: "open" | "recovered";
      checkId?: string;
      limit?: number;
    } = {}
  ): IncidentSummary[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
    return this.database
      .prepare(
        `
        SELECT
          i.id, i.check_id, i.opened_at, i.recovered_at, i.state,
          i.opening_run_id, i.recovery_run_id, i.failure_count, i.summary,
          c.name AS check_name, c.service_id, s.name AS service_name
        FROM incidents i
        JOIN checks c ON c.id = i.check_id
        JOIN services s ON s.id = c.service_id
        WHERE (? IS NULL OR i.state = ?)
          AND (? IS NULL OR i.check_id = ?)
        ORDER BY i.opened_at DESC, i.id DESC
        LIMIT ?
      `
      )
      .all(
        options.state ?? null,
        options.state ?? null,
        options.checkId ?? null,
        options.checkId ?? null,
        boundedLimit
      )
      .map((rawRow) => {
        const row = record(rawRow);
        return {
          id: requiredString(row.id, "id"),
          checkId: requiredString(row.check_id, "check_id"),
          openedAt: requiredString(row.opened_at, "opened_at"),
          recoveredAt: nullableString(row.recovered_at),
          state: requiredString(row.state, "state") as "open" | "recovered",
          openingRunId: requiredString(row.opening_run_id, "opening_run_id"),
          recoveryRunId: nullableString(row.recovery_run_id),
          failureCount: requiredNumber(row.failure_count, "failure_count"),
          summary: requiredString(row.summary, "summary"),
          checkName: requiredString(row.check_name, "check_name"),
          serviceId: requiredString(row.service_id, "service_id"),
          serviceName: requiredString(row.service_name, "service_name")
        };
      });
  }

  claimNotification(input: {
    eventId: string;
    channelId: string;
    incidentId: string;
    payloadHash: string;
    claimedAt: string;
    staleBefore: string;
  }): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rawRow = this.database
        .prepare(
          `
          SELECT state, payload_hash, claimed_at
          FROM notification_events
          WHERE event_id = ? AND channel_id = ?
        `
        )
        .get(input.eventId, input.channelId);

      if (rawRow === undefined) {
        this.database
          .prepare(
            `
            INSERT INTO notification_events(
              event_id, channel_id, incident_id, payload_hash,
              state, claimed_at, finished_at, last_error
            )
            VALUES (?, ?, ?, ?, 'delivering', ?, NULL, NULL)
          `
          )
          .run(
            input.eventId,
            input.channelId,
            input.incidentId,
            input.payloadHash,
            input.claimedAt
          );
        this.database.exec("COMMIT");
        return true;
      }

      const row = record(rawRow);
      const state = requiredString(row.state, "state");
      const payloadHash = requiredString(row.payload_hash, "payload_hash");
      const claimedAt = requiredString(row.claimed_at, "claimed_at");

      if (payloadHash !== input.payloadHash) {
        throw new Error(`Notification event collision for ${input.eventId}/${input.channelId}`);
      }

      if (state === "delivered") {
        this.database.exec("COMMIT");
        return false;
      }

      if (state === "delivering" && claimedAt > input.staleBefore) {
        this.database.exec("COMMIT");
        return false;
      }

      this.database
        .prepare(
          `
          UPDATE notification_events
          SET incident_id = ?,
              state = 'delivering',
              claimed_at = ?,
              finished_at = NULL,
              last_error = NULL
          WHERE event_id = ? AND channel_id = ?
        `
        )
        .run(input.incidentId, input.claimedAt, input.eventId, input.channelId);

      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordNotificationAttempt(input: {
    id: string;
    eventId: string;
    incidentId: string;
    channelId: string;
    eventType: string;
    payloadHash: string;
    attempt: number;
    startedAt: string;
    finishedAt: string;
    state: "delivered" | "retrying" | "failed";
    responseCode?: number;
    errorClass?: string;
  }): void {
    this.database
      .prepare(
        `
        INSERT INTO notification_attempts(
          id, incident_id, channel_id, event_type, attempt,
          started_at, finished_at, state, response_code, error_class,
          event_id, payload_hash
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.id,
        input.incidentId,
        input.channelId,
        input.eventType,
        input.attempt,
        input.startedAt,
        input.finishedAt,
        input.state,
        input.responseCode ?? null,
        input.errorClass ?? null,
        input.eventId,
        input.payloadHash
      );
  }

  completeNotification(input: {
    eventId: string;
    channelId: string;
    state: "delivered" | "failed";
    finishedAt: string;
    lastError?: string;
  }): void {
    this.database
      .prepare(
        `
        UPDATE notification_events
        SET state = ?,
            finished_at = ?,
            last_error = ?
        WHERE event_id = ? AND channel_id = ?
      `
      )
      .run(input.state, input.finishedAt, input.lastError ?? null, input.eventId, input.channelId);
  }

  listNotificationAttempts(incidentId: string): NotificationAttemptSummary[] {
    return this.database
      .prepare(
        `
        SELECT
          id, incident_id, channel_id, event_type, attempt,
          started_at, finished_at, state, response_code, error_class
        FROM notification_attempts
        WHERE incident_id = ?
        ORDER BY started_at ASC, attempt ASC
      `
      )
      .all(incidentId)
      .map((rawRow) => {
        const row = record(rawRow);
        return {
          id: requiredString(row.id, "id"),
          incidentId: requiredString(row.incident_id, "incident_id"),
          channelId: requiredString(row.channel_id, "channel_id"),
          eventType: requiredString(row.event_type, "event_type"),
          attempt: requiredNumber(row.attempt, "attempt"),
          startedAt: requiredString(row.started_at, "started_at"),
          finishedAt: nullableString(row.finished_at),
          state: requiredString(row.state, "state"),
          responseCode: nullableNumber(row.response_code),
          errorClass: nullableString(row.error_class)
        };
      });
  }

  private toRunSummary(rawRow: unknown): RunSummary {
    const row = record(rawRow);
    return {
      id: requiredString(row.id, "id"),
      checkId: requiredString(row.check_id, "check_id"),
      scheduledAt: nullableString(row.scheduled_at),
      startedAt: requiredString(row.started_at, "started_at"),
      finishedAt: requiredString(row.finished_at, "finished_at"),
      state: requiredString(row.state, "state") as RunState,
      observedLedger: nullableNumber(row.observed_ledger),
      rpcEndpointFingerprint: nullableString(row.rpc_endpoint_fingerprint),
      configHash: requiredString(row.config_hash, "config_hash"),
      observerErrorCode: nullableString(row.observer_error_code),
      observerErrorMessage: nullableString(row.observer_error_message)
    };
  }
}
