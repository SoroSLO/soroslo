# @soroslo/assertions

Deterministic assertion engine for SoroSLO.

M2 baseline supports:

- `equals` / `not_equals`;
- `gt`, `gte`, `lt`, `lte` with exact decimal/integer comparison;
- `exists` / `not_exists`;
- `age_lt` operational freshness checks;
- structured reasons for missing paths, type mismatches, and failed comparisons.

The package executes no JavaScript, regex configuration, shell commands, templates, or plugins.

## Post-v0.1 additions

These operators are merged after the v0.1/M2 baseline, so a configuration that
uses them is not portable to a baseline runtime.

- `contains`, `starts_with`, `ends_with` — string matching. The expected value
  must be a string; the loader rejects a non-string value for these operators.
  Comparison is case-sensitive, with no regex or pattern language and no Unicode
  normalization or coercion. A non-string observed value reports
  `type_mismatch`.
- `between` — inclusive numeric interval. Both bounds are inclusive, and bounds
  may be numbers or decimal strings. Exact comparison is used for large integers
  and decimals; inverted or non-numeric bounds are invalid expected values, while
  a non-numeric observed value reports `type_mismatch`.
