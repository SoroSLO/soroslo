# Drips Stellar Wave readiness

This is the maintainer preparation checklist for submitting SoroSLO to a future Stellar Wave Program cycle.

## Repository pitch

**Short description**

Self-hosted synthetic SLO monitoring for Stellar/Soroban: simulation-only contract checks, durable evidence, incidents, and error budgets.

**Why SoroSLO belongs in the Stellar Wave Program**

SoroSLO is built specifically for Stellar/Soroban operators and maintainers. It runs deterministic, read-only Soroban simulations against deployed contracts, evaluates application-level assertions, persists evidence, and turns those observations into run-based SLI/SLO, error-budget, and incident state.

The project is intentionally non-custodial: normal runtime checks do not accept signing keys, do not sign transactions, and do not submit transactions.

## Current maturity evidence

- Public Apache-2.0 repository under the `SoroSLO` GitHub organization.
- Public `v0.1.0` release.
- Green pull-request and `main` CI.
- Unit, integration, Docker Compose validation, and Playwright E2E coverage.
- Real Stellar Testnet acceptance evidence.
- Documented security boundary and threat model.
- Contributor guide, maintainer policy, support guide, CODEOWNERS, changelog, issue templates, and PR template.
- 24 scoped contributor issues, all marked `help wanted`.
- 3 narrower issues marked `good first issue`.
- Contributor issues include problem statements, scope, acceptance criteria, verification, likely packages, non-goals, dependencies, and security/compatibility notes.
- One external contributor has four merged pull requests (#45–#48), including maintainer-resolved conflict integration that preserves the contributor history.

## Contributor backlog planning

The current Wave-ready backlog contains 24 issues.

Suggested working complexity:

- Trivial: 0 issues / 0 points
- Medium: 18 issues / 2,700 points
- High: 6 issues / 1,200 points
- Total planning value: 3,900 points

These are planning values only. Final complexity must be set in the Drips maintainer UI and must respect the repository/org points budget assigned by the Wave Program.

See [wave-backlog.md](wave-backlog.md).

## Maintainer operating plan

During an active Wave:

1. Review applications daily.
2. Assign contributors promptly through the Drips Wave flow.
3. Keep Wave-targeted issues unassigned until contributor selection.
4. Answer scope questions in the GitHub issue thread.
5. Review PRs against the issue acceptance criteria and security boundary.
6. Prioritize end-of-Wave review so completed contributor work can be resolved in time.
7. Leave post-Wave contributor reviews within the Drips review window.

## GitHub repository metadata

Recommended GitHub repository description:

> Self-hosted synthetic SLO monitoring for Stellar/Soroban — simulation-only contract checks, durable evidence, incidents, and error budgets.

Recommended topics:

- `stellar`
- `soroban`
- `stellar-network`
- `synthetic-monitoring`
- `observability`
- `slo`
- `sre`
- `reliability-engineering`
- `self-hosted`
- `typescript`
- `open-source`

## Recommended `main` branch ruleset

Create an active ruleset targeting the default branch.

Recommended rules:

- require a pull request before merging;
- require status checks before merging:
  - `quality`
  - `e2e`
- require conversation resolution before merging;
- block force pushes;
- restrict branch deletion.

Because the project currently has one listed maintainer, do not require an external approving review yet. Add an approval requirement once there is a second active maintainer/reviewer.

Do not require signed commits at this stage because that would raise unnecessary friction for new contributors.

## Application guardrails

Keep the application evidence-based:

- describe the public v0.1 release, Testnet acceptance, CI/security controls, merged external contribution history, and contributor-ready backlog exactly as they exist;
- do not claim production adoption, users, stars, or ecosystem endorsements that are not independently evidenced;
- treat all proposed complexity/point totals as planning estimates until they are set in Drips;
- do not create filler issues or downscope meaningful work just to increase the number of Wave tasks;
- re-check repository state immediately before submitting because Program admission remains an organizer decision.

## Maintainer-readiness audit — 2026-10-02

Verified baseline:

- repository description and Stellar/Soroban/open-source topics are configured;
- `main` is covered by an active GitHub ruleset requiring pull requests, `quality`, `e2e`, resolved review conversations, and blocking force-push/deletion;
- `v0.1.0` is a public non-prerelease release;
- all 24 remaining contributor issues are open, unassigned, and carry `help wanted`;
- the three remaining deliberately narrower entry tasks also carry `good first issue`; those labels indicate accessibility, not Trivial Drips complexity;
- every contributor issue contains Problem, Scope, Acceptance criteria, Tests/verification, Non-goals, Dependencies, and Security/compatibility sections;
- the four external-contributor PRs (#45–#48) are merged; the two conflict-heavy branches were integrated through maintainer resolution while preserving contributor ancestry;
- current GitHub Actions dependencies were upgraded through green Dependabot pull requests;
- the complexity plan was re-reviewed against current Drips guidance; no task is being labeled Trivial merely to increase issue count;
- the one-off v0.1 release automation is being replaced by a reusable tag-verified release workflow;
- CodeQL analysis is being added for pull requests, `main`, and a weekly scheduled scan.

At the opening of a new Wave cycle, revalidate the dynamic checks below before submitting the repository application.

## Pre-application checklist

Before submitting SoroSLO to the next Stellar Wave cycle:

- [ ] repository description is set;
- [ ] repository topics are set;
- [ ] `main` branch ruleset is active;
- [ ] latest `main` CI is green;
- [ ] latest release remains publicly visible;
- [ ] all Wave-targeted issues are still open and unassigned;
- [ ] no stale or duplicate contributor issues remain;
- [ ] issue complexity classifications have been re-reviewed;
- [ ] application copy reflects the current repository state.

## After repository approval

Once SoroSLO is approved into the Stellar Wave Program:

1. Open the Drips maintainer issue dashboard.
2. Review the actual per-repo and per-org points budget.
3. Add as many accurately scoped issues as the budget permits.
4. Set each issue to Trivial, Medium, or High in the Drips UI.
5. Prefer a balanced mix of entry-level and deeper Stellar/reliability work.
6. Keep remaining issues ready for later Waves instead of understating their complexity.
