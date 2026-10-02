/**
 * @file diagnostics.ts
 * @description Structured configuration diagnostics with normalized YAML paths.
 * @package @soroslo/config
 * @license Apache-2.0
 */
import { parseDocument } from "yaml";
import type { z } from "zod";

/** Stable, machine-readable category for a diagnostic. */
export type DiagnosticKind =
  | "unknown_field"
  | "invalid_type"
  | "invalid_id"
  | "invalid_duration"
  | "invalid_reference"
  | "invalid_contract_id"
  | "invalid_value"
  | "unresolved_environment";

export interface ConfigDiagnostic {
  /** Normalized dotted path with bracketed indexes, e.g. `services[0].checks[1].slo.target`. */
  path: string;
  /** Stable category so a caller can branch without parsing the message. */
  kind: DiagnosticKind;
  /** Human-readable explanation, safe to print. */
  message: string;
  /** The Zod issue code, or a config-specific code, kept for CLI JSON output. */
  code: string;
  /**
   * For an unresolved environment reference, the variable name. Present so the
   * caller can report *which* variable is missing without ever resolving or
   * echoing a secret value.
   */
  environmentVariable?: string;
  /**
   * For an invalid `$steps.<id>.result...` reference, the referenced step id
   * and the JSON path within its result. Carried structurally so a consumer can
   * act on the target without parsing it back out of the message.
   */
  referencedStepId?: string;
  referencedResultPath?: string;
}

/**
 * Render a path segment list as `a.b[0].c`.
 *
 * Zod reports paths as a mixed array of keys and numeric indexes
 * (`["services", 0, "checks", 1]`). Joining with dots alone produces
 * `services.0.checks.1`, which cannot be pasted into a YAML search and does not
 * distinguish an index from a literal key named "0".
 */
export function formatPath(segments: readonly (string | number | symbol)[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
      continue;
    }
    const key = String(segment);
    // A key that is a bare identifier reads better as `a.b`; anything else
    // needs brackets so the path stays unambiguous.
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      out += out.length === 0 ? key : `.${key}`;
    } else {
      out += `[${JSON.stringify(key)}]`;
    }
  }
  return out.length === 0 ? "$" : out;
}

/** Map a Zod issue code onto the diagnostic vocabulary. */
function kindFor(code: string): DiagnosticKind {
  switch (code) {
    case "unrecognized_keys":
      return "unknown_field";
    case "invalid_type":
      return "invalid_type";
    case "too_small":
    case "too_big":
    case "invalid_string":
    case "invalid_format":
    case "invalid_enum_value":
    case "invalid_value":
      return "invalid_value";
    default:
      return "invalid_value";
  }
}

/**
 * Attach a diagnostic kind based on the schema the issue came from.
 * IDs, durations, references and contract ids read as generic Zod failures by
 * default, which is exactly the complaint the diagnostics exist to fix.
 *
 * Messages are deliberately path-free. The path is carried by `path` and
 * rendered once by whoever formats the diagnostic, so a structured consumer
 * does not have to strip a prefix and a human does not read it twice.
 */
function refineKind(issue: z.core.$ZodIssue): { kind: DiagnosticKind; message: string } {
  const path = formatPath(issue.path);

  if (issue.code === "unrecognized_keys" && "keys" in issue && Array.isArray(issue.keys)) {
    // Keep the schema's own wording so existing consumers that match on it
    // still work; the path prefix is the addition.
    return {
      kind: "unknown_field",
      message: `Unrecognized key${
        issue.keys.length === 1 ? "" : "s"
      }: ${issue.keys.map((k) => `'${String(k)}'`).join(", ")}`
    };
  }

  // Zod carries the custom refine message verbatim, so the message text is the
  // most reliable signal for which schema produced the issue.
  const message = issue.message;
  if (/previously completed step|previous step|must reference a previous step/i.test(message)) {
    return { kind: "invalid_reference", message };
  }
  if (/contract/i.test(message) || /\.contract$/.test(path)) {
    return {
      kind: "invalid_contract_id",
      message: "must be a Soroban contract address (a C... StrKey)"
    };
  }
  if (/duration/i.test(message)) {
    return { kind: "invalid_duration", message };
  }
  if (/lowercase|identifier/i.test(message) || /(^|\.)id$/.test(path)) {
    return { kind: "invalid_id", message };
  }

  return { kind: kindFor(issue.code), message };
}

/** Convert a Zod error into the structured diagnostic list. */
export function diagnosticsFromZod(error: z.ZodError): ConfigDiagnostic[] {
  return error.issues.map((issue) => {
    const { kind, message } = refineKind(issue);
    const diagnostic: ConfigDiagnostic = {
      path: formatPath(issue.path),
      kind,
      message,
      code: String(issue.code)
    };

    // The referenced step and the path within its result are recovered so a
    // consumer gets the source field path and the target as separate fields,
    // not one sentence with both embedded. Zod does not carry the offending
    // value for a `custom` issue, so it comes from the message, which is
    // generated by the one schema that raises this kind.
    if (kind === "invalid_reference") {
      const value = /\$steps\.[a-z0-9][a-z0-9-]{0,62}\.result(?:[.[][^'\s]*)*/.exec(message)?.[0];
      const reference = value
        ? /^\$steps\.([a-z0-9][a-z0-9-]{0,62})\.result(.*)$/.exec(value)
        : null;
      if (reference?.[1] !== undefined) diagnostic.referencedStepId = reference[1];
      if (reference?.[2]) diagnostic.referencedResultPath = reference[2];
      if (value !== undefined) diagnostic.message = message;
    }

    return diagnostic;
  });
}

/**
 * Walk parsed YAML and record the path of every `${NAME}` reference.
 *
 * The reference is a string value, so its position comes from the parse tree
 * rather than from counting indentation. The earlier line-scanning version
 * remembered the last service or check it had seen, which reported a
 * `notifications.webhooks[0].secret` reference as belonging to whichever check
 * happened to precede it.
 *
 * Every location is recorded, not just the first per variable: the same
 * variable can be referenced from several fields and an operator needs all of
 * them.
 */
function collectEnvironmentReferences(
  value: unknown,
  path: (string | number)[],
  into: { name: string; path: string }[]
): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
      const name = match[1];
      if (name === undefined) continue;
      const at = formatPath(path);
      if (!into.some((seen) => seen.name === name && seen.path === at)) {
        into.push({ name, path: at });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((child, index) => collectEnvironmentReferences(child, [...path, index], into));
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectEnvironmentReferences(child, [...path, key], into);
    }
  }
}

/**
 * Find every `${NAME}` reference in the raw source and report the ones the
 * environment cannot satisfy.
 *
 * Only the variable name and the config path are reported. The resolved value
 * is never included, formatted or logged by the diagnostic path, so a
 * diagnostic cannot leak a secret even when the variable is a webhook secret
 * or a signing key. Expansion itself necessarily reads the value to substitute
 * it; only the reporting is constrained here.
 *
 * The message is path-free; the location is carried by `path` alone, because
 * the caller renders the path once alongside it. One diagnostic is returned per
 * reference location, so a variable used in several fields lists all of them.
 *
 * Every unresolved reference is collected before returning, so one load
 * reports all of them instead of stopping at the first.
 */
export function unresolvedEnvironmentDiagnostics(
  source: string,
  environment: NodeJS.ProcessEnv
): ConfigDiagnostic[] {
  const found: { name: string; path: string }[] = [];

  let parsed: unknown;
  try {
    parsed = parseDocument(source).toJS();
  } catch {
    // A source that does not parse has no reliable structure to report
    // against, and the parse error is reported separately by the loader.
    return [];
  }

  collectEnvironmentReferences(parsed, [], found);

  return found
    .filter(({ name }) => environment[name] === undefined)
    .map(({ name, path }) => ({
      path,
      kind: "unresolved_environment" as const,
      message: `Environment variable '${name}' is required but not set`,
      code: "unresolved_environment",
      environmentVariable: name
    }));
}
