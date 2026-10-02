import { canonicalJson, compareExactNumeric, getJsonPath, parseDurationMs } from "@soroslo/shared";

export type AssertionOperator =
  | "equals"
  | "not_equals"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists"
  | "age_lt"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "between";

export interface AssertionSpec {
  path: string;
  op: AssertionOperator;
  value?: unknown;
}

export type AssertionReason =
  | "matched"
  | "missing_path"
  | "unexpected_path"
  | "comparison_failed"
  | "type_mismatch"
  | "invalid_expected_value";

export interface AssertionResult {
  path: string;
  operator: AssertionOperator;
  expected: unknown;
  observed: unknown;
  passed: boolean;
  reason: AssertionReason;
}

function result(
  spec: AssertionSpec,
  observed: unknown,
  passed: boolean,
  reason: AssertionReason
): AssertionResult {
  return {
    path: spec.path,
    operator: spec.op,
    expected: spec.value,
    observed,
    passed,
    reason
  };
}

function equalValues(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function evaluateAssertion(
  spec: AssertionSpec,
  root: unknown,
  options: { observedAtMs?: number } = {}
): AssertionResult {
  const pathResult = getJsonPath(root, spec.path);

  if (spec.op === "not_exists") {
    return result(
      spec,
      pathResult.value,
      !pathResult.found,
      pathResult.found ? "unexpected_path" : "matched"
    );
  }

  if (!pathResult.found) {
    return result(spec, undefined, false, "missing_path");
  }

  if (spec.op === "exists") {
    return result(spec, pathResult.value, true, "matched");
  }

  if (spec.op === "equals" || spec.op === "not_equals") {
    const equal = equalValues(pathResult.value, spec.value);
    const passed = spec.op === "equals" ? equal : !equal;
    return result(spec, pathResult.value, passed, passed ? "matched" : "comparison_failed");
  }

  if (spec.op === "contains" || spec.op === "starts_with" || spec.op === "ends_with") {
    // Both sides must be strings. A non-string observed value is a type
    // mismatch in the evidence rather than a coercion, and an expected value
    // that is not a string cannot describe a string check at all.
    if (typeof spec.value !== "string") {
      return result(spec, pathResult.value, false, "invalid_expected_value");
    }

    if (typeof pathResult.value !== "string") {
      return result(spec, pathResult.value, false, "type_mismatch");
    }

    // Deliberately case-sensitive and free of regex: the operators describe
    // plain substring relationships so the same spec always yields the same
    // verdict on any runtime.
    let passed: boolean;
    switch (spec.op) {
      case "contains":
        passed = pathResult.value.includes(spec.value);
        break;
      case "starts_with":
        passed = pathResult.value.startsWith(spec.value);
        break;
      default:
        passed = pathResult.value.endsWith(spec.value);
        break;
    }

    return result(spec, pathResult.value, passed, passed ? "matched" : "comparison_failed");
  }

  if (spec.op === "between") {
    const bounds = spec.value;
    if (
      typeof bounds !== "object" ||
      bounds === null ||
      Array.isArray(bounds) ||
      !("lower" in bounds) ||
      !("upper" in bounds)
    ) {
      return result(spec, pathResult.value, false, "invalid_expected_value");
    }

    const { lower, upper } = bounds;

    try {
      if (compareExactNumeric(lower, upper) > 0) {
        return result(spec, pathResult.value, false, "invalid_expected_value");
      }
    } catch {
      return result(spec, pathResult.value, false, "invalid_expected_value");
    }

    let observedInRange: boolean;
    try {
      observedInRange =
        compareExactNumeric(pathResult.value, lower) >= 0 &&
        compareExactNumeric(pathResult.value, upper) <= 0;
    } catch {
      return result(spec, pathResult.value, false, "type_mismatch");
    }

    return result(
      spec,
      pathResult.value,
      observedInRange,
      observedInRange ? "matched" : "comparison_failed"
    );
  }

  if (spec.op === "age_lt") {
    if (typeof spec.value !== "string") {
      return result(spec, pathResult.value, false, "invalid_expected_value");
    }

    let maxAgeMs: number;
    try {
      maxAgeMs = parseDurationMs(spec.value);
    } catch {
      return result(spec, pathResult.value, false, "invalid_expected_value");
    }

    const timestamp =
      typeof pathResult.value === "number" || typeof pathResult.value === "string"
        ? Number(pathResult.value)
        : Number.NaN;

    if (!Number.isFinite(timestamp)) {
      return result(spec, pathResult.value, false, "type_mismatch");
    }

    const timestampMs = Math.abs(timestamp) >= 1_000_000_000_000 ? timestamp : timestamp * 1_000;
    const observedAtMs = options.observedAtMs ?? Date.now();
    const passed = observedAtMs - timestampMs < maxAgeMs;
    return result(spec, pathResult.value, passed, passed ? "matched" : "comparison_failed");
  }

  try {
    const comparison = compareExactNumeric(pathResult.value, spec.value);
    const passed =
      spec.op === "gt"
        ? comparison > 0
        : spec.op === "gte"
          ? comparison >= 0
          : spec.op === "lt"
            ? comparison < 0
            : comparison <= 0;

    return result(spec, pathResult.value, passed, passed ? "matched" : "comparison_failed");
  } catch {
    return result(spec, pathResult.value, false, "type_mismatch");
  }
}

export function evaluateAssertions(
  specs: readonly AssertionSpec[],
  root: unknown,
  options: { observedAtMs?: number } = {}
): AssertionResult[] {
  return specs.map((spec) => evaluateAssertion(spec, root, options));
}
