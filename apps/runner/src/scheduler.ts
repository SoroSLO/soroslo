import { createHash } from "node:crypto";
import type { CheckConfig } from "@soroslo/config";
import { applyScheduleJitter, parseDurationMs } from "@soroslo/shared";
import { qualifiedCheckId, type SchedulerState } from "@soroslo/storage";

export interface SchedulerStore {
  getSchedulerState(checkId: string): SchedulerState | null;
  ensureSchedulerState(
    checkId: string,
    nextScheduledAt: string,
    schedulePolicyHash: string
  ): SchedulerState;
  /**
   * Re-phase an existing schedule when the interval or jitter policy changed.
   *
   * The expected current value is passed so the update is a compare-and-set:
   * a concurrent tick that already moved the row makes this a no-op rather
   * than clobbering the newer value.
   *
   * `now` distinguishes an active lease from an expired one. A crashed runner
   * leaves `lease_owner` set after `lease_expires_at` has passed, and
   * `tryClaimSchedule` treats that as reclaimable. Refusing to reconcile on it
   * would stall a policy change behind the old due time — a 24h schedule plus a
   * crashed runner would ignore a new 1m policy on every tick until the old
   * instant arrived. A genuinely active lease is still left alone.
   */
  reconcileSchedulePolicy(
    checkId: string,
    expectedScheduledAt: string,
    nextScheduledAt: string,
    schedulePolicyHash: string,
    now: string
  ): SchedulerState;
  tryClaimSchedule(
    checkId: string,
    scheduledAt: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string
  ): boolean;
  completeSchedule(
    checkId: string,
    scheduledAt: string,
    nextScheduledAt: string,
    leaseOwner: string
  ): boolean;
  skipMissedSchedule(
    checkId: string,
    expectedScheduledAt: string,
    nextScheduledAt: string,
    now: string
  ): boolean;
  releaseScheduleLease(checkId: string, leaseOwner: string): void;
}

export interface ScheduledCheck {
  serviceId: string;
  check: CheckConfig;
  configHash: string;
  defaultTimeoutMs: number;
}

export interface ScheduledExecutionContext {
  checkId: string;
  serviceId: string;
  check: CheckConfig;
  configHash: string;
  scheduledAt: string;
  idempotencyKey: string;
  timeoutMs: number;
}

export type ScheduledExecutor = (context: ScheduledExecutionContext) => Promise<void>;

export interface SchedulerTickResult {
  checkId: string;
  outcome: "not_due" | "missed_skipped" | "lease_not_acquired" | "executed" | "failed";
  scheduledAt?: string;
  error?: string;
}

/**
 * Fingerprint of everything that determines a check's schedule phase.
 *
 * Stored alongside the persisted schedule so a configuration change is
 * detectable: if the stored fingerprint differs from the current one, the
 * persisted phase was produced by a different policy and must be recomputed.
 * The check identity is included because the offset is derived from it.
 */
export function schedulePolicyHash(
  checkId: string,
  intervalMs: number,
  jitterFraction: number
): string {
  return createHash("sha256")
    .update(checkId)
    .update("\0")
    .update(String(intervalMs))
    .update("\0")
    .update(String(jitterFraction))
    .digest("hex");
}

export function scheduledRunIdempotencyKey(
  checkId: string,
  scheduledAt: string,
  configHash: string
): string {
  const digest = createHash("sha256")
    .update(checkId)
    .update("\0")
    .update(scheduledAt)
    .update("\0")
    .update(configHash)
    .digest("hex");
  return `scheduled:${digest}`;
}

export function nextFutureSchedule(
  anchor: string | Date,
  intervalMs: number,
  now: string | Date
): string {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
    throw new RangeError("Scheduler interval must be at least one minute");
  }

  const anchorMs = anchor instanceof Date ? anchor.getTime() : Date.parse(anchor);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);

  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs)) {
    throw new TypeError("Scheduler timestamps must be valid dates");
  }

  if (anchorMs > nowMs) return new Date(anchorMs).toISOString();

  const elapsed = nowMs - anchorMs;
  const intervals = Math.floor(elapsed / intervalMs) + 1;
  return new Date(anchorMs + intervals * intervalMs).toISOString();
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<SchedulerTickResult>
): Promise<SchedulerTickResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Scheduler concurrency must be an integer >= 1");
  }

  const results = new Array<SchedulerTickResult>(values.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker())
  );

  return results;
}

export class RestartSafeScheduler {
  readonly ownerId: string;
  private readonly store: SchedulerStore;
  private readonly executor: ScheduledExecutor;
  private readonly concurrency: number;
  private readonly leaseMs: number;

  constructor(options: {
    ownerId: string;
    store: SchedulerStore;
    executor: ScheduledExecutor;
    concurrency?: number;
    leaseMs?: number;
  }) {
    if (!options.ownerId.trim()) throw new TypeError("Scheduler ownerId must not be empty");

    this.ownerId = options.ownerId;
    this.store = options.store;
    this.executor = options.executor;
    this.concurrency = options.concurrency ?? 4;
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  async tick(checks: readonly ScheduledCheck[], now = new Date()): Promise<SchedulerTickResult[]> {
    return mapWithConcurrency(checks, this.concurrency, (check) => this.tickCheck(check, now));
  }

  private async tickCheck(scheduledCheck: ScheduledCheck, now: Date): Promise<SchedulerTickResult> {
    const checkId = qualifiedCheckId(scheduledCheck.serviceId, scheduledCheck.check.id);
    const intervalMs = parseDurationMs(scheduledCheck.check.every);
    const jitterFraction = scheduledCheck.check.jitter ?? 0;
    const nowIso = now.toISOString();

    // The jitter offset is derived from the check identity, so restarting the
    // runner reproduces the same first due time instead of reshuffling every
    // check. It is a pure function of the identity and the interval.
    const policyHash = schedulePolicyHash(checkId, intervalMs, jitterFraction);
    const phase = (base: Date | string): string =>
      applyScheduleJitter(base, checkId, intervalMs, jitterFraction);

    let state = this.store.getSchedulerState(checkId);
    if (!state) {
      const firstDue = new Date(now.getTime() + intervalMs);
      state = this.store.ensureSchedulerState(checkId, phase(firstDue), policyHash);
    } else if (state.schedulePolicyHash !== policyHash) {
      // A row written under a different interval or jitter policy keeps a phase
      // that no longer matches the configuration. Without this, adding jitter
      // to an existing check would never take effect, because the persisted
      // `nextScheduledAt` is untouched when it is already in the future, and a
      // restart would preserve it. Re-phasing here is what makes the feature
      // work on upgrade rather than only on a fresh database.
      const base = new Date(now.getTime() + intervalMs);
      state = this.store.reconcileSchedulePolicy(
        checkId,
        state.nextScheduledAt,
        phase(base),
        policyHash,
        now.toISOString()
      );
    }

    const scheduledMs = Date.parse(state.nextScheduledAt);
    if (scheduledMs > now.getTime()) {
      return { checkId, outcome: "not_due" };
    }

    if (now.getTime() - scheduledMs >= intervalMs) {
      // `state.nextScheduledAt` is already the jittered anchor, so advancing it
      // by whole intervals preserves the phase offset. Re-applying jitter here
      // would add the same offset a second time and drift the schedule on every
      // skip, compounding across repeated misses.
      const next = nextFutureSchedule(state.nextScheduledAt, intervalMs, now);
      this.store.skipMissedSchedule(checkId, state.nextScheduledAt, next, nowIso);
      return {
        checkId,
        outcome: "missed_skipped",
        scheduledAt: state.nextScheduledAt
      };
    }

    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const claimed = this.store.tryClaimSchedule(
      checkId,
      state.nextScheduledAt,
      this.ownerId,
      nowIso,
      leaseExpiresAt
    );

    if (!claimed) {
      return {
        checkId,
        outcome: "lease_not_acquired",
        scheduledAt: state.nextScheduledAt
      };
    }

    const timeoutMs = scheduledCheck.check.timeout
      ? parseDurationMs(scheduledCheck.check.timeout)
      : scheduledCheck.defaultTimeoutMs;

    const context: ScheduledExecutionContext = {
      checkId,
      serviceId: scheduledCheck.serviceId,
      check: scheduledCheck.check,
      configHash: scheduledCheck.configHash,
      scheduledAt: state.nextScheduledAt,
      idempotencyKey: scheduledRunIdempotencyKey(
        checkId,
        state.nextScheduledAt,
        scheduledCheck.configHash
      ),
      timeoutMs
    };

    try {
      await this.executor(context);
      const next = nextFutureSchedule(new Date(scheduledMs + intervalMs), intervalMs, now);
      this.store.completeSchedule(checkId, state.nextScheduledAt, next, this.ownerId);
      return {
        checkId,
        outcome: "executed",
        scheduledAt: state.nextScheduledAt
      };
    } catch (error) {
      this.store.releaseScheduleLease(checkId, this.ownerId);
      return {
        checkId,
        outcome: "failed",
        scheduledAt: state.nextScheduledAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
