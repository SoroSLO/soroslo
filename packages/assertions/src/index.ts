export { evaluateAssertion, evaluateAssertions } from "./assertion.js";
export type {
  AssertionOperator,
  AssertionReason,
  AssertionResult,
  AssertionSpec
} from "./assertion.js";
export { compareExactNumeric } from "@soroslo/shared";
export const packageName = "@soroslo/assertions" as const;
