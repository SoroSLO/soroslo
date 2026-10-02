import { StrKey } from "@stellar/stellar-sdk";
import { compareExactNumeric, isDuration, MAX_JITTER_FRACTION } from "@soroslo/shared";
import { z } from "zod";

export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a lowercase SoroSLO identifier");

const durationSchema = z.string().refine(isDuration, "must be a duration such as 10s, 5m, or 7d");
const scheduleSchema = z.enum(["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h"]);
const referenceSchema = z
  .string()
  .regex(
    /^\$steps\.[a-z0-9][a-z0-9-]{0,62}\.result(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/,
    "must reference a previous step result"
  );

export const argumentTypeSchema = z.enum([
  "bool",
  "u32",
  "i32",
  "u64",
  "i64",
  "u128",
  "i128",
  "u256",
  "i256",
  "timepoint",
  "duration",
  "symbol",
  "string",
  "bytes",
  "address"
]);

const literalArgumentSchema = z
  .object({
    type: argumentTypeSchema,
    value: z.union([z.string(), z.number(), z.boolean()])
  })
  .strict()
  .superRefine((argument, context) => {
    const { type, value } = argument;

    if (type === "bool" && typeof value !== "boolean") {
      context.addIssue({ code: "custom", message: "bool arguments require a boolean value" });
      return;
    }

    if (["symbol", "string", "bytes", "address"].includes(type) && typeof value !== "string") {
      context.addIssue({ code: "custom", message: `${type} arguments require a string value` });
      return;
    }

    if (type === "bytes" && typeof value === "string" && !/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
      context.addIssue({
        code: "custom",
        message: "bytes arguments must be an even-length hex string"
      });
      return;
    }

    if (
      !["bool", "symbol", "string", "bytes", "address"].includes(type) &&
      !(
        (typeof value === "number" && Number.isInteger(value)) ||
        (typeof value === "string" && /^-?\d+$/.test(value))
      )
    ) {
      context.addIssue({ code: "custom", message: `${type} arguments require an integer value` });
    }
  });

const referenceArgumentSchema = z
  .object({
    type: argumentTypeSchema,
    from: referenceSchema
  })
  .strict();

export const argumentSchema = z.union([literalArgumentSchema, referenceArgumentSchema]);
export type ArgumentConfig = z.infer<typeof argumentSchema>;

export const assertionOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "not_exists",
  "age_lt",
  "contains",
  "starts_with",
  "ends_with",
  "between"
]);

const assertionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Operators whose expected value is a string by contract.
 *
 * Without this the loader accepted `op: contains, value: 42`, and the mismatch
 * only surfaced at evaluation time, far from the config field that caused it.
 */
const STRING_EXPECTED_OPERATORS = ["contains", "starts_with", "ends_with"] as const;

export const assertionBoundsSchema = z
  .object({
    lower: assertionValueSchema,
    upper: assertionValueSchema
  })
  .strict();
export type AssertionBounds = z.infer<typeof assertionBoundsSchema>;

export const assertionSchema = z
  .object({
    path: z
      .string()
      .regex(/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/, "must be a supported JSON path"),
    op: assertionOperatorSchema,
    value: z.union([assertionValueSchema, assertionBoundsSchema]).optional()
  })
  .strict()
  .superRefine((assertion, context) => {
    const existenceOperator = assertion.op === "exists" || assertion.op === "not_exists";
    if (!existenceOperator && assertion.value === undefined) {
      context.addIssue({ code: "custom", message: `${assertion.op} requires a value` });
      return;
    }

    if (
      (STRING_EXPECTED_OPERATORS as readonly string[]).includes(assertion.op) &&
      typeof assertion.value !== "string"
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${assertion.op} requires a string value`
      });
    }

    const isBoundsObject =
      typeof assertion.value === "object" &&
      assertion.value !== null &&
      !Array.isArray(assertion.value);

    if (assertion.op !== "between") {
      if (isBoundsObject) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `${assertion.op} does not accept an object value`
        });
      }
      return;
    }

    const bounds = assertionBoundsSchema.safeParse(assertion.value);
    if (!bounds.success) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "between requires an object with lower and upper bounds"
      });
      return;
    }

    try {
      if (compareExactNumeric(bounds.data.lower, bounds.data.upper) > 0) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "between lower bound must not exceed the upper bound"
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "between bounds must be numeric"
      });
    }
  });
export type AssertionConfig = z.infer<typeof assertionSchema>;

export const stepSchema = z
  .object({
    id: idSchema,
    contract: z
      .string()
      .refine((value) => StrKey.isValidContract(value), "must be a valid Stellar contract strkey"),
    function: z.string().min(1).max(64),
    args: z.array(argumentSchema).default([]),
    assertions: z.array(assertionSchema).default([])
  })
  .strict();
export type StepConfig = z.infer<typeof stepSchema>;

const sloSchema = z
  .object({
    target: z.number().gt(0).lte(100),
    window: durationSchema,
    minEligibleRuns: z.number().int().nonnegative(),
    maxObserverErrorRate: z.number().min(0).max(100)
  })
  .strict();

const incidentPolicySchema = z
  .object({
    failuresToOpen: z.number().int().positive(),
    passesToRecover: z.number().int().positive()
  })
  .strict();

export const checkSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    network: idSchema,
    every: scheduleSchema,
    /**
     * Share of the interval that a run's start time may be moved later by, to
     * spread checks that share an interval. Omitted or `0` disables jitter, so
     * existing configurations keep their exact schedule.
     */
    jitter: z.number().min(0).max(MAX_JITTER_FRACTION).optional(),
    timeout: durationSchema.optional(),
    incidentPolicy: incidentPolicySchema.optional(),
    slo: sloSchema.optional(),
    steps: z.array(stepSchema).min(1)
  })
  .strict();
export type CheckConfig = z.infer<typeof checkSchema>;

export const networkSchema = z
  .object({
    preset: z.enum(["testnet", "mainnet"]).optional(),
    rpcUrl: z.url().optional(),
    networkPassphrase: z.string().min(1).optional()
  })
  .strict()
  .superRefine((network, context) => {
    if (network.preset === "mainnet" && !network.rpcUrl) {
      context.addIssue({ code: "custom", message: "mainnet requires an explicit rpcUrl" });
    }

    if (network.preset === undefined && (!network.rpcUrl || !network.networkPassphrase)) {
      context.addIssue({
        code: "custom",
        message: "custom networks require rpcUrl and networkPassphrase"
      });
    }
  });
export type NetworkConfig = z.infer<typeof networkSchema>;

const serviceSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    checks: z.array(checkSchema).min(1)
  })
  .strict();

const webhookSchema = z
  .object({
    id: idSchema,
    url: z.url().refine((value) => value.startsWith("https://"), "webhook URL must use HTTPS"),
    secret: z.string().min(1)
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    runtime: z
      .object({
        timezone: z.string().min(1),
        dataDir: z.string().min(1),
        defaultTimeout: durationSchema
      })
      .strict(),
    networks: z.record(idSchema, networkSchema),
    services: z.array(serviceSchema).min(1),
    notifications: z
      .object({
        webhooks: z.array(webhookSchema).default([])
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((config, context) => {
    const serviceIds = new Set<string>();

    for (const [serviceIndex, service] of config.services.entries()) {
      if (serviceIds.has(service.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate service id '${service.id}'`,
          path: ["services", serviceIndex, "id"]
        });
      }
      serviceIds.add(service.id);

      const checkIds = new Set<string>();
      for (const [checkIndex, check] of service.checks.entries()) {
        if (checkIds.has(check.id)) {
          context.addIssue({
            code: "custom",
            message: `duplicate check id '${check.id}' in service '${service.id}'`,
            path: ["services", serviceIndex, "checks", checkIndex, "id"]
          });
        }
        checkIds.add(check.id);

        if (!(check.network in config.networks)) {
          context.addIssue({
            code: "custom",
            message: `unknown network '${check.network}'`,
            path: ["services", serviceIndex, "checks", checkIndex, "network"]
          });
        }

        const priorStepIds = new Set<string>();
        for (const [stepIndex, step] of check.steps.entries()) {
          if (priorStepIds.has(step.id)) {
            context.addIssue({
              code: "custom",
              message: `duplicate step id '${step.id}'`,
              path: ["services", serviceIndex, "checks", checkIndex, "steps", stepIndex, "id"]
            });
          }

          for (const [argumentIndex, argument] of step.args.entries()) {
            if (!("from" in argument)) continue;
            const referencedStep = /^\$steps\.([a-z0-9][a-z0-9-]{0,62})\.result/.exec(
              argument.from
            )?.[1];

            if (!referencedStep || !priorStepIds.has(referencedStep)) {
              context.addIssue({
                code: "custom",
                message: `reference '${argument.from}' must target a previously completed step`,
                path: [
                  "services",
                  serviceIndex,
                  "checks",
                  checkIndex,
                  "steps",
                  stepIndex,
                  "args",
                  argumentIndex,
                  "from"
                ]
              });
            }
          }

          priorStepIds.add(step.id);
        }
      }
    }
  });

export type SoroSloConfig = z.infer<typeof configSchema>;
