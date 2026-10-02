import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { canonicalJson } from "@soroslo/shared";
import { parse } from "yaml";
import {
  diagnosticsFromZod,
  unresolvedEnvironmentDiagnostics,
  type ConfigDiagnostic
} from "./diagnostics.js";
import { configSchema, type SoroSloConfig } from "./schema.js";

export class ConfigError extends Error {
  /**
   * Structured diagnostics, when the failure came from validation or an
   * unresolved environment reference. A YAML parse failure carries none.
   */
  readonly diagnostics: readonly ConfigDiagnostic[];

  constructor(
    message: string,
    options: { cause?: unknown; diagnostics?: readonly ConfigDiagnostic[] } = {}
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "ConfigError";
    this.diagnostics = options.diagnostics ?? [];
  }
}

export interface LoadedConfig {
  config: SoroSloConfig;
  hash: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertWebhookSecretsAreReferences(rawConfig: unknown): void {
  const root = asRecord(rawConfig);
  const notifications = asRecord(root?.notifications);
  const webhooks = notifications?.webhooks;

  if (!Array.isArray(webhooks)) return;

  for (const [index, webhook] of webhooks.entries()) {
    const secret = asRecord(webhook)?.secret;
    if (typeof secret !== "string" || !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(secret)) {
      throw new ConfigError(
        `notifications.webhooks[${index}].secret must be a direct environment reference`
      );
    }
  }
}

function assertNoStellarSecretSeeds(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (StrKey.isValidEd25519SecretSeed(value)) {
      throw new ConfigError(`Stellar secret seed is forbidden in configuration at ${path}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoStellarSecretSeeds(child, `${path}[${index}]`));
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const [key, child] of Object.entries(record)) {
    assertNoStellarSecretSeeds(child, `${path}.${key}`);
  }
}

export function expandEnvironment(
  source: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  // Every unresolved reference is collected before failing, so one load reports
  // all of them rather than making the operator rerun to find the next one.
  // This is safe because reading the source cannot mutate anything, and the
  // diagnostic path never includes, formats or logs a resolved value.
  const unresolved = unresolvedEnvironmentDiagnostics(source, environment);
  if (unresolved.length > 0) {
    // One diagnostic is emitted per reference location, so the count of
    // diagnostics is the number of *references*, not of missing variables. The
    // header names variables, so it counts distinct names or the sentence reads
    // "2 environment variables" when one variable is named in two fields.
    const distinctVariables = new Set(unresolved.map((d) => d.environmentVariable)).size;
    throw new ConfigError(
      [
        `Configuration requires ${distinctVariables} environment ${
          distinctVariables === 1 ? "variable" : "variables"
        } that ${distinctVariables === 1 ? "is" : "are"} not set:`,
        ...unresolved.map((diagnostic) => `  ${diagnostic.path}: ${diagnostic.message}`)
      ].join("\n"),
      { diagnostics: unresolved }
    );
  }

  return source.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = environment[name];
    if (value === undefined) {
      // Unreachable while the collection above passes, but the expansion still
      // refuses to proceed rather than substituting an empty string.
      throw new ConfigError(`Environment variable '${name}' is required but not set`);
    }
    return value;
  });
}

export function hashConfig(config: SoroSloConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

export function loadConfigText(
  source: string,
  options: { environment?: NodeJS.ProcessEnv } = {}
): LoadedConfig {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ConfigError("Unable to parse SoroSLO YAML", { cause: error });
  }

  assertWebhookSecretsAreReferences(raw);

  const expandedSource = expandEnvironment(source, options.environment ?? process.env);

  let expanded: unknown;
  try {
    expanded = parse(expandedSource);
  } catch (error) {
    throw new ConfigError("Unable to parse expanded SoroSLO YAML", { cause: error });
  }

  assertNoStellarSecretSeeds(expanded);

  const result = configSchema.safeParse(expanded);
  if (!result.success) {
    const diagnostics = diagnosticsFromZod(result.error);
    // Every issue is reported, not just the first: an operator fixing a config
    // wants the whole list, and these are independent findings by construction.
    throw new ConfigError(
      [
        `Invalid SoroSLO configuration (${diagnostics.length} ${
          diagnostics.length === 1 ? "error" : "errors"
        }):`,
        ...diagnostics.map((diagnostic) => `  ${diagnostic.path}: ${diagnostic.message}`)
      ].join("\n"),
      { diagnostics }
    );
  }

  return {
    config: result.data,
    hash: hashConfig(result.data)
  };
}
