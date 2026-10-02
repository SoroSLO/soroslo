# Wave-ready contributor backlog

This document is a maintainer planning view of the public contributor backlog. It does **not** assign work and does not replace the issue body or the Drips Wave maintainer dashboard.

The complexity values below are suggested working classifications for future Stellar Wave submissions:

- **Trivial — 100 points:** narrow, localized changes with limited cross-package impact;
- **Medium — 150 points:** multi-file or multi-package work with meaningful tests;
- **High — 200 points:** cross-cutting reliability/Stellar/storage work with larger integration surface.

Final Wave complexity should be set in the Drips maintainer UI after the repository is accepted into a Wave Program.

## Trivial — 100 points each

No current issue is classified as Trivial. The present `good first issue` tasks are intentionally approachable, but their implementation/test surface is larger than a typo, minor copy change, or very small bug fix.

## Medium — 150 points each

- [#22 Dashboard empty/loading/error states](https://github.com/SoroSLO/soroslo/issues/22) — multiple dashboard states plus Playwright coverage.
- [#26 Safe build/runtime metadata](https://github.com/SoroSLO/soroslo/issues/26) — API schema plus Docker/build metadata handling.
- [#27 Reusable Stellar RPC fixture builders](https://github.com/SoroSLO/soroslo/issues/27) — shared test infrastructure plus fixture migration.

- [#8 CLI config validation and one-shot checks](https://github.com/SoroSLO/soroslo/issues/8) — reuses existing execution APIs with multiple failure modes.
- [#16 Run filtering and pagination](https://github.com/SoroSLO/soroslo/issues/16) — dashboard query state and E2E behavior.
- [#17 Cursor pagination for runs/incidents](https://github.com/SoroSLO/soroslo/issues/17) — stable opaque cursors and compatibility.
- [#18 Portable JSON evidence export](https://github.com/SoroSLO/soroslo/issues/18) — deterministic export and redaction.
- [#19 SQLite backup and restore](https://github.com/SoroSLO/soroslo/issues/19) — operationally sensitive but bounded.
- [#21 Structured logs and correlation IDs](https://github.com/SoroSLO/soroslo/issues/21) — cross-component context and redaction.
- [#23 Dashboard accessibility pass](https://github.com/SoroSLO/soroslo/issues/23) — multiple views and automated checks.
- [#28 SLO time-range selection](https://github.com/SoroSLO/soroslo/issues/28) — read-model and UI state.
- [#29 Incident timeline visualization](https://github.com/SoroSLO/soroslo/issues/29) — aggregated evidence and E2E coverage.
- [#30 OpenAPI generation](https://github.com/SoroSLO/soroslo/issues/30) — schema integration and drift checks.
- [#31 Deterministic API error envelopes](https://github.com/SoroSLO/soroslo/issues/31) — cross-route compatibility.
- [#32 Graceful-shutdown draining state](https://github.com/SoroSLO/soroslo/issues/32) — lifecycle and readiness semantics.
- [#33 Migration integrity verification](https://github.com/SoroSLO/soroslo/issues/33) — read-only integrity tooling.
- [#34 Disable individual checks](https://github.com/SoroSLO/soroslo/issues/34) — cross-surface state behavior.
- [#35 Configurable webhook timeout/retries](https://github.com/SoroSLO/soroslo/issues/35) — bounded delivery policy and deterministic tests.

## High — 200 points each

- [#9 Evidence retention and safe pruning](https://github.com/SoroSLO/soroslo/issues/9) — must preserve SLO/incident evidence transactionally.
- [#10 Dead-letter visibility and webhook redelivery](https://github.com/SoroSLO/soroslo/issues/10) — cross-cutting idempotency and security behavior.
- [#11 Multi-RPC observer corroboration](https://github.com/SoroSLO/soroslo/issues/11) — network identity, evidence, and classification semantics.
- [#12 Typed vec/map/struct arguments](https://github.com/SoroSLO/soroslo/issues/12) — recursive typed encoding and XDR conversion.
- [#13 Multi-window SLO burn-rate alerts](https://github.com/SoroSLO/soroslo/issues/13) — SLO engine, incidents, notifications, and dashboard.
- [#37 Simulation resource-usage trends](https://github.com/SoroSLO/soroslo/issues/37) — cross-stack aggregation and visualization.

## Working totals

- Trivial: **0 issues / 0 points**
- Medium: **18 issues / 2,700 points**
- High: **6 issues / 1,200 points**
- Total: **24 issues / 3,900 points**

These totals are planning estimates only. The actual Wave submission must respect the points budget assigned by Drips to the repository/organization.

## Submission principles

When a new Stellar Wave opens:

1. Apply/confirm SoroSLO for the Wave Program before assigning Wave-targeted issues.
2. Keep candidate issues unassigned until the Wave application flow selects contributors.
3. Submit as many high-quality issues as the repository points budget permits.
4. Keep contributor accessibility separate from complexity: a `good first issue` may still be Medium when it spans meaningful code, tests, and documentation.
5. Do not invent low-value Trivial work or downgrade complexity merely to fit more issues inside a points budget.
6. Keep unresolved contributor issues available for later Waves rather than weakening scope.
