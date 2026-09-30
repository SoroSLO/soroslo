/**
 * @file schedule-jitter.test.ts
 * @description Tests for deterministic schedule jitter (#20).
 * @package @soroslo/shared
 * @license Apache-2.0
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyScheduleJitter,
  deterministicJitterMs,
  MAX_JITTER_FRACTION,
  scheduleJitterMs
} from "./schedule-jitter.js";

const MINUTE = 60_000;

void test("produces the same offset for the same identity every time", () => {
  const first = deterministicJitterMs("payments/health", 100_000);
  const second = deterministicJitterMs("payments/health", 100_000);

  // This is the property a restart depends on: the offset is a pure function
  // of the identity, so nothing reshuffles between processes.
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 100_000);
});

void test("spreads offsets across distinct check identities", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `service/check-${i}`);
  const offsets = new Set(ids.map((id) => deterministicJitterMs(id, 60_000)));

  // Distinct identities must not collapse onto a single offset, which is the
  // whole point of spreading synchronized checks.
  assert.ok(offsets.size > 20, `expected a spread, got ${offsets.size} distinct offsets`);
});

void test("returns zero for a zero span", () => {
  assert.equal(deterministicJitterMs("anything", 0), 0);
});

void test("bounds the offset by the configured fraction", () => {
  const interval = 10 * MINUTE;
  for (let i = 0; i < 50; i += 1) {
    const offset = scheduleJitterMs(`svc/check-${i}`, interval, 0.1);
    assert.ok(offset >= 0, "offset must not be negative");
    assert.ok(offset <= interval * 0.1, `offset ${offset} exceeded the configured share`);
  }
});

void test("caps the fraction at the documented maximum", () => {
  const interval = 10 * MINUTE;
  for (let i = 0; i < 50; i += 1) {
    const capped = scheduleJitterMs(`svc/check-${i}`, interval, 0.9);
    assert.ok(
      capped <= interval * MAX_JITTER_FRACTION,
      `offset ${capped} exceeded the ${MAX_JITTER_FRACTION} cap`
    );
  }
});

void test("treats a zero or negative fraction as jitter disabled", () => {
  assert.equal(scheduleJitterMs("svc/check", 10 * MINUTE, 0), 0);
  assert.equal(scheduleJitterMs("svc/check", 10 * MINUTE, -1), 0);
  assert.equal(scheduleJitterMs("svc/check", 10 * MINUTE, Number.NaN), 0);
});

void test("never moves a run earlier than the unjittered schedule", () => {
  const base = "2026-09-30T12:00:00.000Z";
  const baseMs = Date.parse(base);

  for (let i = 0; i < 40; i += 1) {
    const jittered = Date.parse(
      applyScheduleJitter(base, `svc/check-${i}`, 15 * MINUTE, MAX_JITTER_FRACTION)
    );
    assert.ok(jittered >= baseMs, "a jittered run must not be scheduled before its anchor");
    assert.ok(
      jittered - baseMs <= 15 * MINUTE * MAX_JITTER_FRACTION,
      "a jittered run must stay inside the policy window"
    );
  }
});

void test("is idempotent when applied to its own output-free input", () => {
  const base = "2026-09-30T12:00:00.000Z";
  const once = applyScheduleJitter(base, "svc/check", 10 * MINUTE, 0.2);
  const twice = applyScheduleJitter(base, "svc/check", 10 * MINUTE, 0.2);

  // Same anchor and identity must give the same instant, so re-deriving a
  // schedule after a restart cannot drift.
  assert.equal(once, twice);
});

void test("leaves the timestamp untouched when jitter is disabled", () => {
  const base = "2026-09-30T12:00:00.123Z";
  assert.equal(applyScheduleJitter(base, "svc/check", 10 * MINUTE, 0), base);
});

void test("preserves the exact shifted instant", () => {
  const base = "2026-09-30T12:00:00.456Z";
  const jittered = applyScheduleJitter(base, "svc/check", 13 * MINUTE, MAX_JITTER_FRACTION);
  const expected =
    Date.parse(base) + scheduleJitterMs("svc/check", 13 * MINUTE, MAX_JITTER_FRACTION);

  assert.equal(Date.parse(jittered), expected);
});

void test("stays inside the window for a sub-second anchor at the maximum offset", () => {
  // Rounding to a whole second moved this case past the bound: the anchor's
  // 999ms plus an offset a millisecond under the maximum rounded up beyond
  // the configured window.
  const interval = 15 * MINUTE;
  const span = interval * MAX_JITTER_FRACTION;

  for (const millis of [1, 250, 500, 750, 999]) {
    const baseMs = Date.parse("2026-09-30T12:00:00.000Z") + millis;

    for (let i = 0; i < 200; i += 1) {
      const jitteredMs = Date.parse(
        applyScheduleJitter(new Date(baseMs), `svc/check-${i}`, interval, MAX_JITTER_FRACTION)
      );
      const moved = jitteredMs - baseMs;
      assert.ok(jitteredMs >= baseMs, `run moved earlier than its anchor at +${millis}ms`);
      assert.ok(
        moved <= span,
        `offset ${moved}ms exceeded the ${span}ms window for an anchor at +${millis}ms`
      );
    }
  }
});

void test("rejects an invalid anchor timestamp", () => {
  assert.throws(() => applyScheduleJitter("not a date", "svc/check", 10 * MINUTE, 0.2), TypeError);
});

void test("rejects a negative jitter span", () => {
  assert.throws(() => deterministicJitterMs("svc/check", -1), RangeError);
});

void test("gives different services with the same check id different offsets", () => {
  // A shared id across services is exactly the case where two checks of the
  // same interval would otherwise fire together, so the qualified identity
  // must matter.
  const a = deterministicJitterMs("service-a/health", 5 * MINUTE);
  const b = deterministicJitterMs("service-b/health", 5 * MINUTE);
  assert.notEqual(a, b);
});
