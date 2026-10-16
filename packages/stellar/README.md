# @soroslo/stellar

The Stellar/Soroban boundary for SoroSLO.

M1 establishes a deterministic, non-custodial probe core:

- named network resolution for Testnet, Mainnet, and custom RPCs;
- safe endpoint fingerprinting without logging credential-bearing URLs;
- RPC health/network verification;
- bounded retry behavior for transport, 429, and 5xx failures;
- simulation-only transaction construction using an impossible public source account;
- `simulateTransaction` execution;
- JSON-safe Soroban return normalization;
- resource and ledger evidence extraction;
- deterministic unit/RPC fixtures.

## Adding RPC fixtures

Reusable builders live in `src/fixtures.ts` and are exported from the package entrypoint. Use a builder for a common response or failure shape, then pass an override for the field a test is exercising. Keep malformed payloads and transport errors explicit so invalid input is visible in the test. Fixture builders must use synthetic deterministic values and must not include credentials or live network data.

For a new scenario, add the smallest builder needed, export it from `src/index.ts`, and cover its defaults plus relevant overrides in `src/fixtures.test.ts`.

## Security invariant

This package does not accept or generate a Stellar secret seed. Simulation transactions use the SDK's impossible/null public account:

`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`

Transactions are built only for RPC simulation and are never signed or submitted.

## Mainnet

SoroSLO intentionally has no implicit Mainnet RPC provider. Operators must configure one explicitly. Testnet may default to the public SDF Testnet RPC.
