import { Networks, SorobanDataBuilder, xdr, type rpc } from "@stellar/stellar-sdk";

const DEFAULT_LEDGER = 1_000_000;
const DEFAULT_PAYLOAD_SIZE = 64 * 1024;

export interface SimulationResponseOverrides {
  id?: string;
  latestLedger?: number;
  minResourceFee?: string;
  result?: rpc.Api.SimulateHostFunctionResult;
  events?: xdr.DiagnosticEvent[];
  transactionData?: SorobanDataBuilder;
}

export interface NetworkFixtureOverrides {
  passphrase?: string;
  protocolVersion?: string;
  latestLedger?: number;
  oldestLedger?: number;
  ledgerRetentionWindow?: number;
}

export interface MalformedResponseOverrides {
  id?: string;
  latestLedger?: unknown;
  events?: unknown;
}

export interface TransportErrorOverrides {
  code?: string;
  message?: string;
}

/** Build a fresh deterministic successful `simulateTransaction` response. */
export function buildSuccessfulSimulationResponse(
  overrides: SimulationResponseOverrides = {}
): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: overrides.id ?? "fixture-simulation-1",
    latestLedger: overrides.latestLedger ?? DEFAULT_LEDGER,
    events: overrides.events ?? [],
    _parsed: true,
    transactionData:
      overrides.transactionData ??
      new SorobanDataBuilder().setResources(10_000, 128, 64).setResourceFee("100"),
    minResourceFee: overrides.minResourceFee ?? "100",
    result: overrides.result ?? {
      auth: [],
      retval: xdr.ScVal.scvU32(42)
    }
  };
}

/** Build a fresh deterministic simulation response containing a contract error. */
export function buildContractErrorSimulationResponse(
  overrides: Omit<SimulationResponseOverrides, "result" | "transactionData"> & {
    error?: string;
  } = {}
): rpc.Api.SimulateTransactionErrorResponse {
  return {
    id: overrides.id ?? "fixture-simulation-error-1",
    latestLedger: overrides.latestLedger ?? DEFAULT_LEDGER,
    events: overrides.events ?? [],
    _parsed: true,
    error: overrides.error ?? "Error(Contract, #1)"
  };
}

/** Build an intentionally malformed RPC payload for validation tests. */
export function buildMalformedRpcResponse(overrides: MalformedResponseOverrides = {}): unknown {
  return {
    id: overrides.id ?? "fixture-malformed-1",
    latestLedger: overrides.latestLedger ?? "not-a-ledger",
    events: overrides.events ?? null
  };
}

/** Build a deterministic transport failure that can be passed to error classification. */
export function buildTransportError(
  overrides: TransportErrorOverrides = {}
): Error & { code: string } {
  const error = new Error(overrides.message ?? "fixture transport failure") as Error & {
    code: string;
  };
  error.code = overrides.code ?? "ECONNRESET";
  return error;
}

/** Build a deterministic retryable HTTP failure for 429 or 5xx handling. */
export function buildRetryableHttpError(status: number = 503): {
  response: { status: number };
} {
  if (status !== 429 && (status < 500 || status > 599)) {
    throw new RangeError("fixture HTTP status must be 429 or a 5xx status");
  }
  return { response: { status } };
}

/** Build deterministic network and health responses, with independent field overrides. */
export function buildNetworkFixture(overrides: NetworkFixtureOverrides = {}): {
  network: rpc.Api.GetNetworkResponse;
  health: rpc.Api.GetHealthResponse;
} {
  const latestLedger = overrides.latestLedger ?? DEFAULT_LEDGER;
  return {
    network: {
      passphrase: overrides.passphrase ?? Networks.TESTNET,
      protocolVersion: overrides.protocolVersion ?? "23"
    },
    health: {
      status: "healthy",
      latestLedger,
      oldestLedger:
        overrides.oldestLedger ?? latestLedger - (overrides.ledgerRetentionWindow ?? 50_000),
      ledgerRetentionWindow: overrides.ledgerRetentionWindow ?? 50_000
    }
  };
}

/** Build a bounded deterministic payload for response-size and truncation tests. */
export function buildBoundedLargePayload(size = DEFAULT_PAYLOAD_SIZE): { payload: string } {
  if (!Number.isInteger(size) || size < 0) {
    throw new TypeError("fixture payload size must be a non-negative integer");
  }
  return { payload: "x".repeat(size) };
}

export const deterministicRpcFixtures = {
  testnetNetwork: buildNetworkFixture().network,
  healthyRpc: buildNetworkFixture().health,
  rateLimitedError: buildRetryableHttpError(429),
  unavailableError: buildRetryableHttpError(503),
  timeoutError: Object.assign(new Error("request timeout"), {
    code: "ETIMEDOUT"
  })
} as const;
