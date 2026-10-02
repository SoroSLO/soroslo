import test from "node:test";
import assert from "node:assert/strict";
import { loadConfigText } from "./load.js";

const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function configYaml(extraStep = ""): string {
  return `version: 1
runtime:
  timezone: UTC
  dataDir: ./.soroslo
  defaultTimeout: 15s
networks:
  testnet:
    preset: testnet
services:
  - id: payments
    name: Payments
    checks:
      - id: health
        name: Health
        network: testnet
        every: 5m
        steps:
          - id: first
            contract: ${CONTRACT_ID}
            function: value
            args: []
            assertions:
              - path: $
                op: gt
                value: "0"
${extraStep}
notifications:
  webhooks:
    - id: ops
      url: \${WEBHOOK_URL}
      secret: \${WEBHOOK_SECRET}
`;
}

void test("loads versioned YAML, expands environment, and hashes deterministically", () => {
  const environment = {
    WEBHOOK_URL: "https://example.com/hook",
    WEBHOOK_SECRET: "not-a-stellar-secret"
  };

  const first = loadConfigText(configYaml(), { environment });
  const second = loadConfigText(configYaml(), { environment });

  assert.equal(first.config.version, 1);
  assert.equal(first.config.services[0]?.checks[0]?.steps[0]?.id, "first");
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
});

void test("rejects unknown top-level fields", () => {
  assert.throws(
    () =>
      loadConfigText(
        `${configYaml()}
unexpected: true
`,
        {
          environment: {
            WEBHOOK_URL: "https://example.com/hook",
            WEBHOOK_SECRET: "secret"
          }
        }
      ),
    /Unrecognized key/
  );
});

void test("rejects inline webhook secrets", () => {
  const source = configYaml().replace("secret: ${WEBHOOK_SECRET}", "secret: literal-secret");

  assert.throws(
    () =>
      loadConfigText(source, {
        environment: { WEBHOOK_URL: "https://example.com/hook" }
      }),
    /direct environment reference/
  );
});

void test("accepts prior-step references only to earlier steps", () => {
  const chained = `          - id: second
            contract: ${CONTRACT_ID}
            function: quote
            args:
              - type: i128
                from: $steps.first.result.value
            assertions: []
`;

  const loaded = loadConfigText(configYaml(chained), {
    environment: {
      WEBHOOK_URL: "https://example.com/hook",
      WEBHOOK_SECRET: "secret"
    }
  });

  assert.equal(loaded.config.services[0]?.checks[0]?.steps.length, 2);
});

void test("rejects forward step references", () => {
  const source = configYaml().replace(
    "args: []",
    `args:
              - type: i128
                from: $steps.second.result.value`
  );

  assert.throws(
    () =>
      loadConfigText(source, {
        environment: {
          WEBHOOK_URL: "https://example.com/hook",
          WEBHOOK_SECRET: "secret"
        }
      }),
    /previously completed step/
  );
});
void test("rejects a non-string expected value for string operators at load time", () => {
  const environment = {
    WEBHOOK_URL: "https://example.com/hook",
    WEBHOOK_SECRET: "secret"
  };

  // #25 requires the expected value to be a string for these operators. The
  // loader must reject the mismatch, not leave it to evaluation time.
  for (const [op, value] of [
    ["contains", "42"],
    ["starts_with", "true"],
    ["ends_with", "null"]
  ] as const) {
    const source = configYaml().replace(
      /^(\s*)- path: \$$[\s\S]*?value: "0"/m,
      `$1- path: $\n$1  op: ${op}\n$1  value: ${value}`
    );

    assert.throws(
      () => loadConfigText(source, { environment }),
      new RegExp(`${op} requires a string value`),
      `${op} with value ${value} must be rejected during loadConfigText`
    );
  }
});

void test("accepts a string expected value for string operators", () => {
  const environment = {
    WEBHOOK_URL: "https://example.com/hook",
    WEBHOOK_SECRET: "secret"
  };

  const source = configYaml().replace(
    /^(\s*)- path: \$$[\s\S]*?value: "0"/m,
    `$1- path: $\n$1  op: contains\n$1  value: "transfer"`
  );

  const loaded = loadConfigText(source, { environment });

  assert.equal(loaded.config.services[0]?.checks[0]?.steps[0]?.assertions[0]?.op, "contains");
  assert.equal(loaded.config.services[0]?.checks[0]?.steps[0]?.assertions[0]?.value, "transfer");
});

void test("accepts a between assertion with inclusive bounds", () => {
  const source = configYaml()
    .replace(
      `              - path: $
                op: gt
                value: "0"`,
      `              - path: $.value
                op: between
                value:
                  lower: 1
                  upper: "9007199254740993"`
    )
    .replace(/^notifications:[\s\S]*$/m, "");

  const loaded = loadConfigText(source, { environment: {} });
  const assertion = loaded.config.services[0]?.checks[0]?.steps[0]?.assertions[0];
  assert.equal(assertion?.op, "between");
});

void test("rejects a between assertion whose lower bound exceeds the upper", () => {
  const source = configYaml()
    .replace(
      `              - path: $
                op: gt
                value: "0"`,
      `              - path: $.value
                op: between
                value:
                  lower: 10
                  upper: 1`
    )
    .replace(/^notifications:[\s\S]*$/m, "");

  assert.throws(
    () => loadConfigText(source, { environment: {} }),
    /lower bound must not exceed the upper bound/
  );
});

void test("rejects a between assertion without an object value", () => {
  const source = configYaml()
    .replace(
      `              - path: $
                op: gt
                value: "0"`,
      `              - path: $.value
                op: between
                value: 5`
    )
    .replace(/^notifications:[\s\S]*$/m, "");

  assert.throws(
    () => loadConfigText(source, { environment: {} }),
    /between requires an object with lower and upper bounds/
  );
});

void test("rejects a bounds object for an operator other than between", () => {
  for (const op of ["gt", "equals", "age_lt"] as const) {
    const source = configYaml()
      .replace(
        `              - path: $
                op: gt
                value: "0"`,
        `              - path: $.value
                op: ${op}
                value:
                  lower: 1
                  upper: 5`
      )
      .replace(/^notifications:[\s\S]*$/m, "");

    assert.throws(
      () => loadConfigText(source, { environment: {} }),
      new RegExp(`${op} does not accept an object value`)
    );
  }
});

void test("rejects non-numeric between bounds", () => {
  const source = configYaml()
    .replace(
      `              - path: $
                op: gt
                value: "0"`,
      `              - path: $.value
                op: between
                value:
                  lower: nope
                  upper: 5`
    )
    .replace(/^notifications:[\s\S]*$/m, "");

  assert.throws(() => loadConfigText(source, { environment: {} }), /between bounds must be numeric/);
});

void test("accepts a jitter fraction within the documented cap", () => {
  const source = configYaml()
    .replace("        every: 5m", "        every: 5m\n        jitter: 0.2")
    .replace(/^notifications:[\s\S]*$/m, "");

  const loaded = loadConfigText(source, { environment: {} });
  assert.equal(loaded.config.services[0]?.checks[0]?.jitter, 0.2);
});

void test("omits jitter by default so existing schedules are unchanged", () => {
  const source = configYaml().replace(/^notifications:[\s\S]*$/m, "");

  const loaded = loadConfigText(source, { environment: {} });
  assert.equal(loaded.config.services[0]?.checks[0]?.jitter, undefined);
});

void test("rejects a jitter fraction above the cap", () => {
  const source = configYaml()
    .replace("        every: 5m", "        every: 5m\n        jitter: 0.9")
    .replace(/^notifications:[\s\S]*$/m, "");

  assert.throws(() => loadConfigText(source, { environment: {} }), /jitter|too big/i);
});
