import test from "node:test";
import assert from "node:assert/strict";
import type { SoroSloConfig } from "@soroslo/config";
import { SoroSloStorage, qualifiedCheckId } from "./database.js";

const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const config: SoroSloConfig = {
  version: 1,
  runtime: {
    timezone: "UTC",
    dataDir: "./.soroslo",
    defaultTimeout: "15s"
  },
  networks: {
    testnet: {
      preset: "testnet"
    }
  },
  services: [
    {
      id: "payments",
      name: "Payments",
      checks: [
        {
          id: "health",
          name: "Health",
          network: "testnet",
          every: "5m",
          steps: [
            {
              id: "read",
              contract: CONTRACT_ID,
              function: "value",
              args: [],
              assertions: []
            }
          ]
        }
      ]
    }
  ]
};

void test("migrates and synchronizes services/checks idempotently", () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate("2026-09-29T18:00:00.000Z");
    storage.migrate("2026-09-29T18:01:00.000Z");

    const first = storage.syncConfiguration(config, "hash-a", "2026-09-29T18:00:00.000Z");
    const second = storage.syncConfiguration(config, "hash-b", "2026-09-29T18:01:00.000Z");

    assert.deepEqual(first, ["payments:health"]);
    assert.deepEqual(second, ["payments:health"]);

    const migrationCount = storage.database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    const checkCount = storage.database.prepare("SELECT COUNT(*) AS count FROM checks").get() as {
      count: number;
    };

    assert.equal(migrationCount.count, 3);
    assert.equal(checkCount.count, 1);
  } finally {
    storage.close();
  }
});

void test("persists complete run evidence transactionally and deduplicates scheduled runs", () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-hash");

    const checkId = qualifiedCheckId("payments", "health");
    const input = {
      id: "run-1",
      idempotencyKey: "scheduled:abc",
      checkId,
      scheduledAt: "2026-09-29T18:00:00.000Z",
      startedAt: "2026-09-29T18:00:01.000Z",
      finishedAt: "2026-09-29T18:00:02.000Z",
      state: "service_fail" as const,
      observedLedger: 123,
      rpcEndpointFingerprint: "rpc123",
      configHash: "config-hash",
      steps: [
        {
          stepId: "read",
          ordinal: 0,
          state: "service_fail" as const,
          contractId: CONTRACT_ID,
          functionName: "value",
          result: { value: "0" },
          elapsedMs: 12,
          evidence: { latestLedger: 123 },
          failureKind: "assertion_failed",
          failureMessage: "expected > 0",
          assertions: [
            {
              path: "$.value",
              operator: "gt",
              expected: "0",
              observed: "0",
              passed: false,
              reason: "comparison_failed"
            }
          ]
        }
      ]
    };

    assert.equal(storage.recordRun(input), true);
    assert.equal(storage.recordRun({ ...input, id: "run-2" }), false);
    assert.equal(storage.hasRunIdempotencyKey("scheduled:abc"), true);

    const runs = storage.listReliabilityRuns(
      checkId,
      "2026-09-29T17:00:00.000Z",
      "2026-09-29T19:00:00.000Z"
    );
    assert.deepEqual(runs, [
      {
        id: "run-1",
        state: "service_fail",
        finishedAt: "2026-09-29T18:00:02.000Z"
      }
    ]);

    const assertions = storage.database
      .prepare("SELECT COUNT(*) AS count FROM assertion_results")
      .get() as { count: number };
    assert.equal(assertions.count, 1);
  } finally {
    storage.close();
  }
});

void test("claims schedules once and preserves restart-safe timestamps", () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-hash");
    const checkId = qualifiedCheckId("payments", "health");

    storage.ensureSchedulerState(checkId, "2026-09-29T18:05:00.000Z", "policy-hash");

    assert.equal(
      storage.tryClaimSchedule(
        checkId,
        "2026-09-29T18:05:00.000Z",
        "runner-a",
        "2026-09-29T18:05:00.000Z",
        "2026-09-29T18:06:00.000Z"
      ),
      true
    );
    assert.equal(
      storage.tryClaimSchedule(
        checkId,
        "2026-09-29T18:05:00.000Z",
        "runner-b",
        "2026-09-29T18:05:01.000Z",
        "2026-09-29T18:06:01.000Z"
      ),
      false
    );

    assert.equal(
      storage.completeSchedule(
        checkId,
        "2026-09-29T18:05:00.000Z",
        "2026-09-29T18:10:00.000Z",
        "runner-a"
      ),
      true
    );

    assert.deepEqual(storage.getSchedulerState(checkId), {
      checkId,
      lastScheduledAt: "2026-09-29T18:05:00.000Z",
      nextScheduledAt: "2026-09-29T18:10:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
      schedulePolicyHash: "policy-hash"
    });
  } finally {
    storage.close();
  }
});

void test("persists incident runtime and lifecycle", () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-hash");
    const checkId = qualifiedCheckId("payments", "health");

    storage.recordRun({
      id: "opening-run",
      idempotencyKey: "manual:opening",
      checkId,
      startedAt: "2026-09-29T18:00:00.000Z",
      finishedAt: "2026-09-29T18:00:01.000Z",
      state: "service_fail",
      configHash: "config-hash",
      steps: []
    });

    storage.openIncident({
      id: "incident-1",
      checkId,
      openedAt: "2026-09-29T18:00:01.000Z",
      openingRunId: "opening-run",
      failureCount: 2,
      summary: "Health check failed"
    });
    storage.saveIncidentRuntime(
      checkId,
      {
        state: "incident_open",
        consecutiveFailures: 2,
        consecutivePasses: 0
      },
      "incident-1",
      "2026-09-29T18:00:01.000Z"
    );

    assert.equal(storage.getIncidentRuntime(checkId).activeIncidentId, "incident-1");

    storage.recordRun({
      id: "recovery-run",
      idempotencyKey: "manual:recovery",
      checkId,
      startedAt: "2026-09-29T18:10:00.000Z",
      finishedAt: "2026-09-29T18:10:01.000Z",
      state: "pass",
      configHash: "config-hash",
      steps: []
    });

    assert.equal(
      storage.recoverIncident({
        id: "incident-1",
        recoveredAt: "2026-09-29T18:10:01.000Z",
        recoveryRunId: "recovery-run"
      }),
      true
    );

    assert.equal(storage.getIncident("incident-1")?.state, "recovered");
  } finally {
    storage.close();
  }
});

void test("deduplicates notification events and records delivery attempts", () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-hash");
    const checkId = qualifiedCheckId("payments", "health");

    storage.recordRun({
      id: "opening-run-notify",
      idempotencyKey: "manual:notify-opening",
      checkId,
      startedAt: "2026-09-29T18:20:00.000Z",
      finishedAt: "2026-09-29T18:20:01.000Z",
      state: "service_fail",
      configHash: "config-hash",
      steps: []
    });
    storage.openIncident({
      id: "incident-notify",
      checkId,
      openedAt: "2026-09-29T18:20:01.000Z",
      openingRunId: "opening-run-notify",
      failureCount: 2,
      summary: "Health check failed"
    });

    const claim = {
      eventId: "event-1",
      channelId: "ops",
      incidentId: "incident-notify",
      payloadHash: "payload-hash",
      claimedAt: "2026-09-29T18:20:02.000Z",
      staleBefore: "2026-09-29T18:19:02.000Z"
    };

    assert.equal(storage.claimNotification(claim), true);
    assert.equal(storage.claimNotification(claim), false);

    storage.recordNotificationAttempt({
      id: "attempt-1",
      eventId: "event-1",
      incidentId: "incident-notify",
      channelId: "ops",
      eventType: "opened",
      payloadHash: "payload-hash",
      attempt: 1,
      startedAt: "2026-09-29T18:20:02.000Z",
      finishedAt: "2026-09-29T18:20:03.000Z",
      state: "delivered",
      responseCode: 204
    });
    storage.completeNotification({
      eventId: "event-1",
      channelId: "ops",
      state: "delivered",
      finishedAt: "2026-09-29T18:20:03.000Z"
    });

    assert.equal(
      storage.claimNotification({
        ...claim,
        claimedAt: "2026-09-29T18:30:00.000Z",
        staleBefore: "2026-09-29T18:29:00.000Z"
      }),
      false
    );

    const attempts = storage.listNotificationAttempts("incident-notify");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.channelId, "ops");
    assert.equal(attempts[0]?.state, "delivered");
  } finally {
    storage.close();
  }
});
