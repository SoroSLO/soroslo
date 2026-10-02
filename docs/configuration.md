# Configuration

SoroSLO v0.1 reads `soroslo.yml`.

Configuration is strict and non-executable. Environment-variable expansion occurs before schema validation. Unknown fields fail validation.

## Minimal Testnet configuration

```yaml
version: 1

runtime:
  timezone: UTC
  dataDir: ./.soroslo
  defaultTimeout: 15s

networks:
  testnet:
    preset: testnet

services:
  - id: fixture-service
    name: Fixture service
    checks:
      - id: healthy-read
        name: Healthy read
        network: testnet
        every: 5m
        steps:
          - id: healthy
            contract: ${SOROSLO_TESTNET_FIXTURE_CONTRACT}
            function: healthy
            args: []
            assertions:
              - path: $
                op: equals
                value: true
```

## Runtime

- `timezone` — operator display/configuration timezone. v0.1 examples use UTC.
- `dataDir` — local runtime data directory.
- `defaultTimeout` — fallback check timeout.

## Networks

### Testnet

```yaml
testnet:
  preset: testnet
```

The official SDF Testnet RPC is used unless `rpcUrl` is explicitly supplied.

### Mainnet

Mainnet requires an explicit RPC URL:

```yaml
mainnet:
  preset: mainnet
  rpcUrl: ${SOROSLO_MAINNET_RPC_URL}
```

### Custom network

A custom network requires both `rpcUrl` and `networkPassphrase`.

## Checks

Supported schedules are:

`1m`, `5m`, `15m`, `30m`, `1h`, `6h`, `12h`, `24h`.

Every check contains one or more ordered steps. v0.1 is fail-fast.

Later steps may reference an earlier result:

```yaml
args:
  - type: i128
    from: $steps.base.result
```

Simulations do not mutate network state, so a later step cannot observe a mutation from an earlier simulated step.

### Schedule jitter

Checks that share an interval would otherwise start together and stay together, sending a burst at the same RPC endpoint on every tick. A check may opt into a deterministic offset within a bounded share of its interval:

```yaml
checks:
  - id: healthy-read
    every: 5m
    jitter: 0.1
    # ... the check's steps, as in the example above
```

- The offset is derived from the check's stable identity, so it is stable across restarts and does not reshuffle. It is not random, and it is not a per-run value.
- `jitter` is a fraction of the interval, omitted or `0` by default, which leaves the schedule unchanged.
- The maximum is **`0.2`** of the interval. A larger value is rejected during config validation.
- A run is only ever moved later, never earlier than the configured interval allows.
- Changing or removing `jitter` re-phases the next run. The persisted schedule records the policy that produced it, so an existing deployment picks the change up on its next tick rather than keeping the old phase forever.
- Manual runs do not alter the next jittered schedule.

## Argument types

`bool`, `u32`, `i32`, `u64`, `i64`, `u128`, `i128`, `u256`, `i256`, `timepoint`, `duration`, `symbol`, `string`, `bytes`, and `address`.

Large integer values should be written as decimal strings.

## Assertions

Operators in the published v0.1 baseline:

- `equals`
- `not_equals`
- `gt`
- `gte`
- `lt`
- `lte`
- `exists`
- `not_exists`
- `age_lt`

Numeric comparisons are exact. There is no JavaScript, regex, shell, or plugin execution.

### Post-v0.1 additions

These operators are merged after the v0.1 release, so a configuration that uses
them is not portable to a v0.1 runtime.

- `between` applies to numeric values and asserts an inclusive interval. Both
  `lower` and `upper` are inclusive. Bounds may be numbers or decimal strings
  and use the same exact comparison as the other numeric operators, including
  values beyond IEEE-754 safe-integer precision. An inverted interval is
  rejected during config loading.

```yaml
assertions:
  - path: $.ledger
    op: between
    value:
      lower: 1000
      upper: 2000
  - path: $.ratio
    op: between
    value:
      lower: "0.75"
      upper: "1.25"
```

- `contains`, `starts_with` and `ends_with` apply to string values only: a
  non-string expected value is reported as `invalid_expected_value`, a
  non-string observed value as `type_mismatch`, and comparison is
  case-sensitive with no Unicode normalization or coercion. There is no regex or
  pattern language.

```yaml
assertions:
  - path: $.memo
    op: starts_with
    value: "Payment"
  - path: $.event.type
    op: contains
    value: "transfer"
  - path: $.asset.code
    op: ends_with
    value: "USDC"
```

## SLO policy

```yaml
slo:
  target: 99.9
  window: 7d
  minEligibleRuns: 100
  maxObserverErrorRate: 1
```

The SLI is run-based: passing eligible runs divided by `pass + service_fail`. Observer errors are reported separately.

## Incident policy

```yaml
incidentPolicy:
  failuresToOpen: 2
  passesToRecover: 2
```

Observer errors neither open nor recover a service incident.

## Webhooks

```yaml
notifications:
  webhooks:
    - id: ops
      url: ${SOROSLO_WEBHOOK_URL}
      secret: ${SOROSLO_WEBHOOK_SECRET}
```

Webhook URLs must use HTTPS. Secrets must be direct environment references in the source YAML; inline notification secrets are rejected by the loader.
