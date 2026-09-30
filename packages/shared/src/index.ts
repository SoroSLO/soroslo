export { canonicalJson } from "./canonical-json.js";
export { isDuration, parseDurationMs } from "./duration.js";
export { getJsonPath } from "./json-path.js";
export type { JsonPathResult } from "./json-path.js";
export { isEligibleForAvailability, runStates } from "./run-state.js";
export type { RunState } from "./run-state.js";
export {
  applyScheduleJitter,
  deterministicJitterMs,
  MAX_JITTER_FRACTION,
  scheduleJitterMs
} from "./schedule-jitter.js";
export const packageName = "@soroslo/shared" as const;
