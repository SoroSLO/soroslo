export {
  DEFAULT_TESTNET_RPC_URL,
  fingerprintRpcEndpoint,
  resolveNetworkConfig
} from "./network.js";
export type { NetworkConfigInput, NetworkPreset, ResolvedNetworkConfig } from "./network.js";

export { StellarObserverError, classifyObserverError, isRetryableObserverError } from "./errors.js";
export type { ObserverErrorCode } from "./errors.js";

export { StellarRpcClient, observerErrorCode } from "./rpc-client.js";
export type { RpcIdentity, RpcRetryOptions, StellarRpcClientOptions } from "./rpc-client.js";

export { NULL_SIMULATION_ACCOUNT, buildSimulationTransaction } from "./transaction.js";
export type { SimulationTransactionInput } from "./transaction.js";

export { normalizeScVal } from "./normalize.js";
export type { NormalizedScalar, NormalizedValue } from "./normalize.js";

export { toSimulationEvidence } from "./evidence.js";
export type {
  SimulationEvidence,
  SimulationEvidenceStatus,
  SimulationResourceEvidence
} from "./evidence.js";

export { simulateInvocation } from "./simulate.js";
export type { SimulateInvocationInput } from "./simulate.js";

export {
  buildBoundedLargePayload,
  buildContractErrorSimulationResponse,
  buildMalformedRpcResponse,
  buildNetworkFixture,
  buildRetryableHttpError,
  buildSuccessfulSimulationResponse,
  buildTransportError,
  deterministicRpcFixtures
} from "./fixtures.js";
export type {
  NetworkFixtureOverrides,
  SimulationResponseOverrides,
  TransportErrorOverrides,
  MalformedResponseOverrides
} from "./fixtures.js";

export const packageName = "@soroslo/stellar" as const;
export type PackageName = typeof packageName;
