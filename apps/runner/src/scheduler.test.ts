import test from "node:test";
import assert from "node:assert/strict";
import type { CheckConfig, SoroSloConfig } from "@soroslo/config";
import { SoroSloStorage, qualifiedCheckId } from "@soroslo/storage";
import { runCheckAndPersist } from "./execution.js";
import {
  RestartSafeScheduler,
  nextFutureSchedule,
  scheduledRunIdempotencyKey,
  schedulePolicyHash,
  type ScheduledCheck
} from "./scheduler.js";

const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const check: CheckConfig = {
  id: "health",
  name: "Health",
  network: "testnet",
  every: "5m",
  timeout: "10s",
  steps: [
    {
      id: "read",
      contract: CONTRACT_ID,
      function: "value",
      args: [],
      assertions: []
    }
  ]
};

const config: SoroSloConfig = {
  version: 1,
  runtime: {
    timezone: "UTC",
    dataDir: "./.soroslo",
    defaultTimeout: "15s"
  },
  networks: {
    testnet: { preset: "testnet" }
  },
  services: [
    {
      id: "payments",
      name: "Payments",
      checks: [check]
    }
  ]
};

void test("generates stable scheduled-run idempotency keys", () => {
  const first = scheduledRunIdempotencyKey(
    "payments:health",
    "2026-09-29T18:05:00.000Z",
    "config-a"
  );
  const second = scheduledRunIdempotencyKey(
    "payments:health",
    "2026-09-29T18:05:00.000Z",
    "config-a"
  );

  assert.equal(first, second);
  assert.match(first, /^scheduled:[0-9a-f]{64}$/);
});

void test("advances a missed schedule to the next future interval", () => {
  assert.equal(
    nextFutureSchedule("2026-09-29T18:00:00.000Z", 5 * 60_000, "2026-09-29T18:12:00.000Z"),
    "2026-09-29T18:15:00.000Z"
  );
});

void test("executes a due check once and advances persisted scheduler state", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-a");
    const checkId = qualifiedCheckId("payments", "health");
    storage.ensureSchedulerState(
      checkId,
      "2026-09-29T18:05:00.000Z",
      schedulePolicyHash(checkId, 5 * 60_000, 0)
    );

    const contexts: string[] = [];
    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor(context) {
        contexts.push(context.idempotencyKey);
        return Promise.resolve();
      }
    });

    const results = await scheduler.tick(
      [
        {
          serviceId: "payments",
          check,
          configHash: "config-a",
          defaultTimeoutMs: 15_000
        }
      ],
      new Date("2026-09-29T18:05:01.000Z")
    );

    assert.equal(results[0]?.outcome, "executed");
    assert.equal(contexts.length, 1);
    assert.equal(storage.getSchedulerState(checkId)?.nextScheduledAt, "2026-09-29T18:10:00.000Z");
  } finally {
    storage.close();
  }
});

void test("skips stale missed intervals instead of replaying them", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-a");
    const checkId = qualifiedCheckId("payments", "health");
    storage.ensureSchedulerState(
      checkId,
      "2026-09-29T18:00:00.000Z",
      schedulePolicyHash(checkId, 5 * 60_000, 0)
    );

    let calls = 0;
    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        calls += 1;
        return Promise.resolve();
      }
    });

    const results = await scheduler.tick(
      [
        {
          serviceId: "payments",
          check,
          configHash: "config-a",
          defaultTimeoutMs: 15_000
        }
      ],
      new Date("2026-09-29T18:12:00.000Z")
    );

    assert.equal(results[0]?.outcome, "missed_skipped");
    assert.equal(calls, 0);
    assert.equal(storage.getSchedulerState(checkId)?.nextScheduledAt, "2026-09-29T18:15:00.000Z");
  } finally {
    storage.close();
  }
});

void test("jittered checks get distinct first schedules that survive a restart", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    const twoChecks: SoroSloConfig = {
      ...config,
      services: [
        { id: "alpha", name: "Alpha", checks: [jittered] },
        { id: "beta", name: "Beta", checks: [jittered] },
        { id: "gamma", name: "Gamma", checks: [jittered] }
      ]
    };
    storage.syncConfiguration(twoChecks, "config-a");

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });

    const now = new Date("2026-09-29T18:00:00.000Z");
    await scheduler.tick(
      ["alpha", "beta", "gamma"].map((serviceId) => ({
        serviceId,
        check: jittered,
        configHash: "config-a",
        defaultTimeoutMs: 15_000
      })),
      now
    );

    const due = ["alpha", "beta", "gamma"].map(
      (serviceId) =>
        storage.getSchedulerState(qualifiedCheckId(serviceId, "health"))?.nextScheduledAt
    );

    // Every check was scheduled, and the offsets differ: that is the property
    // that stops three same-interval checks from firing together.
    assert.ok(
      due.every((value) => typeof value === "string"),
      "every check must be scheduled"
    );
    assert.equal(new Set(due).size, 3, `expected distinct schedules, got ${JSON.stringify(due)}`);

    // Each due time stays inside the unjittered schedule plus the policy window.
    const base = Date.parse("2026-09-29T18:05:00.000Z");
    const cap = Date.parse("2026-09-29T18:05:00.000Z") + 5 * 60_000 * 0.2;
    for (const value of due) {
      const at = Date.parse(value);
      assert.ok(at >= base, `a jittered run must not be earlier than the anchor: ${value}`);
      assert.ok(at <= cap, `a jittered run must stay inside the policy window: ${value}`);
    }

    // A restart must reproduce the same first schedules, not reshuffle them.
    const second = SoroSloStorage.open();
    try {
      second.migrate();
      second.syncConfiguration(twoChecks, "config-a");
      const restarted = new RestartSafeScheduler({
        ownerId: "runner-b",
        store: second,
        executor() {
          return Promise.resolve();
        }
      });
      await restarted.tick(
        ["alpha", "beta", "gamma"].map((serviceId) => ({
          serviceId,
          check: jittered,
          configHash: "config-a",
          defaultTimeoutMs: 15_000
        })),
        now
      );
      const repeated = ["alpha", "beta", "gamma"].map(
        (serviceId) =>
          second.getSchedulerState(qualifiedCheckId(serviceId, "health"))?.nextScheduledAt
      );
      assert.deepEqual(repeated, due, "a restart must reproduce the same jittered schedules");
    } finally {
      second.close();
    }
  } finally {
    storage.close();
  }
});

void test("a check without jitter keeps its exact unjittered schedule", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    storage.syncConfiguration(config, "config-a");

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });

    await scheduler.tick(
      [{ serviceId: "payments", check, configHash: "config-a", defaultTimeoutMs: 15_000 }],
      new Date("2026-09-29T18:00:00.000Z")
    );

    // The default path must be byte-for-byte what it was before jitter existed.
    assert.equal(
      storage.getSchedulerState(qualifiedCheckId("payments", "health"))?.nextScheduledAt,
      "2026-09-29T18:05:00.000Z"
    );
  } finally {
    storage.close();
  }
});

void test("a missed interval keeps one stable phase offset instead of drifting", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    const jitteredConfig: SoroSloConfig = {
      ...config,
      services: [{ id: "payments", name: "Payments", checks: [jittered] }]
    };
    storage.syncConfiguration(jitteredConfig, "config-a");
    const checkId = qualifiedCheckId("payments", "health");

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    const scheduled = (): ScheduledCheck[] => [
      { serviceId: "payments", check: jittered, configHash: "config-a", defaultTimeoutMs: 15_000 }
    ];

    // Install the first jittered anchor, which carries the phase offset.
    await scheduler.tick(scheduled(), new Date("2026-09-29T18:00:00.000Z"));
    const anchor = storage.getSchedulerState(checkId)!.nextScheduledAt;
    const anchorMs = Date.parse(anchor);
    const interval = 5 * 60_000;
    const phase = anchorMs % interval;

    // Skip a missed interval and require the next due time to keep the same
    // phase. Before the fix the offset was added a second time here.
    await scheduler.tick(scheduled(), new Date(anchorMs + interval));
    const afterOne = storage.getSchedulerState(checkId)!.nextScheduledAt;
    assert.equal(
      Date.parse(afterOne) % interval,
      phase,
      `phase drifted on the first skip: ${anchor} -> ${afterOne}`
    );

    // Repeat: the drift used to compound on every skip.
    await scheduler.tick(scheduled(), new Date(Date.parse(afterOne) + interval * 2));
    const afterTwo = storage.getSchedulerState(checkId)!.nextScheduledAt;
    assert.equal(
      Date.parse(afterTwo) % interval,
      phase,
      `phase drifted on a repeated skip: ${afterOne} -> ${afterTwo}`
    );

    // Every skip advances by a whole number of intervals, never a partial one.
    const advanced = Date.parse(afterTwo) - anchorMs;
    assert.equal(advanced % interval, 0, `skips advanced by a partial interval: ${advanced}`);
  } finally {
    storage.close();
  }
});

void test("a manual run does not move the next jittered schedule", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    const jitteredConfig: SoroSloConfig = {
      ...config,
      services: [{ id: "payments", name: "Payments", checks: [jittered] }]
    };
    storage.syncConfiguration(jitteredConfig, "config-a");
    const checkId = qualifiedCheckId("payments", "health");

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    await scheduler.tick(
      [
        { serviceId: "payments", check: jittered, configHash: "config-a", defaultTimeoutMs: 15_000 }
      ],
      new Date("2026-09-29T18:00:00.000Z")
    );

    const before = storage.getSchedulerState(checkId)!.nextScheduledAt;

    // This is the path the API's manual-run handler takes: run the check under
    // a `manual:` idempotency key without touching scheduler state. #20
    // requires it to leave the jittered schedule untouched.
    await runCheckAndPersist({
      storage,
      serviceId: "payments",
      check: jittered,
      configHash: "config-a",
      invoker: {
        invoke() {
          return Promise.resolve({
            status: "success",
            latestLedger: 123,
            endpointFingerprint: "rpc123",
            elapsedMs: 5,
            diagnosticEventCount: 0,
            result: "1"
          });
        }
      },
      idempotencyKey: "manual:req-1"
    });

    assert.equal(
      storage.getSchedulerState(checkId)!.nextScheduledAt,
      before,
      "a manual run must not move the jittered schedule"
    );

    // A subsequent tick that is not yet due must also leave it alone.
    const result = await scheduler.tick(
      [
        { serviceId: "payments", check: jittered, configHash: "config-a", defaultTimeoutMs: 15_000 }
      ],
      new Date("2026-09-29T18:01:30.000Z")
    );
    assert.equal(result[0]?.outcome, "not_due");
    assert.equal(storage.getSchedulerState(checkId)!.nextScheduledAt, before);
  } finally {
    storage.close();
  }
});

void test("reconciles jitter onto an existing unjittered schedule", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    const jitteredConfig: SoroSloConfig = {
      ...config,
      services: [{ id: "payments", name: "Payments", checks: [jittered] }]
    };
    storage.syncConfiguration(jitteredConfig, "config-a");
    const checkId = qualifiedCheckId("payments", "health");

    // Simulate a v0.1 deployment: a persisted row with no policy fingerprint and
    // an exact, unjittered due time. Enabling jitter must re-phase it.
    storage.ensureSchedulerState(checkId, "2026-09-29T18:05:00.000Z", "stale-policy");

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    const scheduled = (): ScheduledCheck[] => [
      { serviceId: "payments", check: jittered, configHash: "config-a", defaultTimeoutMs: 15_000 }
    ];

    const result = await scheduler.tick(scheduled(), new Date("2026-09-29T18:00:00.000Z"));

    assert.equal(result[0]?.outcome, "not_due");
    const after = storage.getSchedulerState(checkId)!;
    assert.notEqual(
      after.nextScheduledAt,
      "2026-09-29T18:05:00.000Z",
      "enabling jitter must move the persisted unjittered schedule"
    );
    // It must be a real jittered instant: at or after the anchor, inside the
    // policy window, and carrying the new fingerprint.
    const base = Date.parse("2026-09-29T18:05:00.000Z");
    const at = Date.parse(after.nextScheduledAt);
    assert.ok(
      at >= base && at <= base + 5 * 60_000 * 0.2,
      `out of window: ${after.nextScheduledAt}`
    );
    assert.notEqual(after.schedulePolicyHash, "stale-policy");
  } finally {
    storage.close();
  }
});

void test("reconciles past an expired lease left by a crashed runner", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    storage.syncConfiguration(
      { ...config, services: [{ id: "payments", name: "Payments", checks: [jittered] }] },
      "config-a"
    );
    const checkId = qualifiedCheckId("payments", "health");

    // A crashed runner: the lease owner is still set, but the lease has expired.
    // The old row also sits far in the future, as a 24h schedule would.
    storage.ensureSchedulerState(checkId, "2026-09-30T18:00:00.000Z", "stale-policy");
    storage.tryClaimSchedule(
      checkId,
      "2026-09-30T18:00:00.000Z",
      "crashed-runner",
      "2026-09-29T17:00:00.000Z",
      "2026-09-29T17:05:00.000Z"
    );
    assert.equal(storage.getSchedulerState(checkId)!.leaseOwner, "crashed-runner");

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    const result = await scheduler.tick(
      [
        {
          serviceId: "payments",
          check: jittered,
          configHash: "config-a",
          defaultTimeoutMs: 15_000
        }
      ],
      new Date("2026-09-29T18:00:00.000Z")
    );

    assert.equal(result[0]?.outcome, "not_due");
    const after = storage.getSchedulerState(checkId)!;
    assert.notEqual(
      after.nextScheduledAt,
      "2026-09-30T18:00:00.000Z",
      "an expired lease must not stall the policy change behind the old due time"
    );
    assert.notEqual(after.schedulePolicyHash, "stale-policy");
    const base = Date.parse("2026-09-29T18:05:00.000Z");
    const at = Date.parse(after.nextScheduledAt);
    assert.ok(
      at >= base && at <= base + 5 * 60_000 * 0.2,
      `out of window: ${after.nextScheduledAt}`
    );
  } finally {
    storage.close();
  }
});

void test("does not disturb a genuinely active lease", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    storage.syncConfiguration(
      { ...config, services: [{ id: "payments", name: "Payments", checks: [jittered] }] },
      "config-a"
    );
    const checkId = qualifiedCheckId("payments", "health");

    // The in-flight row: a policy mismatch, but the lease is still valid at the
    // tick's `now`, so reconciliation must leave it exactly as it is.
    storage.ensureSchedulerState(checkId, "2026-09-29T18:05:00.000Z", "stale-policy");
    const now = new Date("2026-09-29T18:04:00.000Z");
    storage.tryClaimSchedule(
      checkId,
      "2026-09-29T18:05:00.000Z",
      "runner-b",
      "2026-09-29T18:03:00.000Z",
      "2026-09-29T18:09:00.000Z"
    );

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    await scheduler.tick(
      [
        {
          serviceId: "payments",
          check: jittered,
          configHash: "config-a",
          defaultTimeoutMs: 15_000
        }
      ],
      now
    );

    const after = storage.getSchedulerState(checkId)!;
    assert.equal(after.nextScheduledAt, "2026-09-29T18:05:00.000Z");
    assert.equal(after.schedulePolicyHash, "stale-policy");
    assert.equal(after.leaseOwner, "runner-b");
  } finally {
    storage.close();
  }
});

void test("reconciles the new policy once the active lease completes", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    storage.syncConfiguration(
      { ...config, services: [{ id: "payments", name: "Payments", checks: [jittered] }] },
      "config-a"
    );
    const checkId = qualifiedCheckId("payments", "health");
    storage.ensureSchedulerState(checkId, "2026-09-29T18:05:00.000Z", "stale-policy");
    storage.tryClaimSchedule(
      checkId,
      "2026-09-29T18:05:00.000Z",
      "runner-b",
      "2026-09-29T18:03:00.000Z",
      "2026-09-29T18:09:00.000Z"
    );

    // The in-flight run finishes and releases the lease, advancing the row.
    const done = storage.completeSchedule(
      checkId,
      "2026-09-29T18:05:00.000Z",
      "2026-09-29T18:06:00.000Z",
      "runner-b"
    );
    assert.equal(done, true);

    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    const result = await scheduler.tick(
      [
        {
          serviceId: "payments",
          check: jittered,
          configHash: "config-a",
          defaultTimeoutMs: 15_000
        }
      ],
      new Date("2026-09-29T18:06:30.000Z")
    );

    assert.equal(result[0]?.outcome, "not_due");
    const after = storage.getSchedulerState(checkId)!;
    assert.equal(
      after.schedulePolicyHash,
      schedulePolicyHash(checkId, 5 * 60_000, 0.2),
      "the released row must pick up the new policy"
    );
    const base = Date.parse("2026-09-29T18:11:30.000Z");
    const at = Date.parse(after.nextScheduledAt);
    assert.ok(
      at >= base && at <= base + 5 * 60_000 * 0.2,
      `out of window: ${after.nextScheduledAt}`
    );
  } finally {
    storage.close();
  }
});

void test("changing and disabling jitter re-phases an existing schedule", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const checkId = qualifiedCheckId("payments", "health");
    const scheduler = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    const now = new Date("2026-09-29T18:00:00.000Z");

    const runWith = async (jitter: number): Promise<string> => {
      const configured: CheckConfig = { ...check, jitter };
      storage.syncConfiguration(
        { ...config, services: [{ id: "payments", name: "Payments", checks: [configured] }] },
        "config-a"
      );
      await scheduler.tick(
        [
          {
            serviceId: "payments",
            check: configured,
            configHash: "config-a",
            defaultTimeoutMs: 15_000
          }
        ],
        now
      );
      return storage.getSchedulerState(checkId)!.nextScheduledAt;
    };

    const withJitter = await runWith(0.2);
    const changed = await runWith(0.05);

    // A different fraction produces a different span, so the offset is
    // recomputed. The two offsets can coincide by chance, so this asserts the
    // stored policy actually changed and that the result is a valid instant for
    // the new policy rather than asserting the instants differ.
    const base = Date.parse("2026-09-29T18:05:00.000Z");
    const changedAt = Date.parse(changed);
    assert.ok(
      changedAt >= base && changedAt <= base + 5 * 60_000 * 0.05,
      `changed fraction produced ${changed}, outside the 0.05 window`
    );
    assert.equal(
      storage.getSchedulerState(checkId)!.schedulePolicyHash,
      schedulePolicyHash(checkId, 5 * 60_000, 0.05)
    );

    const disabled = await runWith(0);
    assert.equal(
      disabled,
      "2026-09-29T18:05:00.000Z",
      "disabling jitter must return the exact unjittered schedule"
    );
    assert.notEqual(withJitter, disabled, "the jittered and unjittered phases must differ");
  } finally {
    storage.close();
  }
});

void test("a restart after reconciliation preserves the new phase", async () => {
  const storage = SoroSloStorage.open();
  try {
    storage.migrate();
    const jittered: CheckConfig = { ...check, jitter: 0.2 };
    const jitteredConfig: SoroSloConfig = {
      ...config,
      services: [{ id: "payments", name: "Payments", checks: [jittered] }]
    };
    storage.syncConfiguration(jitteredConfig, "config-a");
    const checkId = qualifiedCheckId("payments", "health");
    storage.ensureSchedulerState(checkId, "2026-09-29T18:05:00.000Z", "stale-policy");

    const scheduled = (): ScheduledCheck[] => [
      { serviceId: "payments", check: jittered, configHash: "config-a", defaultTimeoutMs: 15_000 }
    ];
    const now = new Date("2026-09-29T18:00:00.000Z");

    const first = new RestartSafeScheduler({
      ownerId: "runner-a",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    await first.tick(scheduled(), now);
    const reconciled = storage.getSchedulerState(checkId)!.nextScheduledAt;

    // A second runner with a different owner id, on the same database, must not
    // re-phase again: the fingerprint now matches the configuration.
    const second = new RestartSafeScheduler({
      ownerId: "runner-b",
      store: storage,
      executor() {
        return Promise.resolve();
      }
    });
    await second.tick(scheduled(), now);

    assert.equal(
      storage.getSchedulerState(checkId)!.nextScheduledAt,
      reconciled,
      "a restart must preserve the reconciled phase"
    );
  } finally {
    storage.close();
  }
});
