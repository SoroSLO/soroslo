import type { RunState } from "@soroslo/shared";
import type { IncidentRuntimeState } from "@soroslo/slo-engine";

export interface PersistedAssertionInput {
  path: string;
  operator: string;
  expected?: unknown;
  observed?: unknown;
  passed: boolean;
  reason: string;
}

export interface PersistedStepInput {
  stepId: string;
  ordinal: number;
  state: RunState;
  contractId: string;
  functionName: string;
  result?: unknown;
  rawReturnXdr?: string;
  minResourceFee?: string;
  elapsedMs?: number;
  evidence?: unknown;
  failureKind?: string;
  failureMessage?: string;
  assertions: readonly PersistedAssertionInput[];
}

export interface PersistedRunInput {
  id: string;
  idempotencyKey: string;
  checkId: string;
  scheduledAt?: string;
  startedAt: string;
  finishedAt: string;
  state: RunState;
  observedLedger?: number;
  rpcEndpointFingerprint?: string;
  configHash: string;
  observerErrorCode?: string;
  observerErrorMessage?: string;
  steps: readonly PersistedStepInput[];
}

export interface StoredReliabilityRun {
  id: string;
  state: RunState;
  finishedAt: string;
}

export interface SchedulerState {
  checkId: string;
  lastScheduledAt: string | null;
  nextScheduledAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  /**
   * Fingerprint of the scheduling policy (interval and jitter) that produced
   * `nextScheduledAt`. Null for rows written before the column existed, which
   * are reconciled on first sight.
   */
  schedulePolicyHash: string | null;
}

export interface StoredIncidentRuntime extends IncidentRuntimeState {
  activeIncidentId: string | null;
}

export interface StoredIncident {
  id: string;
  checkId: string;
  openedAt: string;
  recoveredAt: string | null;
  state: "open" | "recovered";
  openingRunId: string;
  recoveryRunId: string | null;
  failureCount: number;
  summary: string;
}

export interface ServiceSummary {
  id: string;
  name: string;
  configHash: string;
  createdAt: string;
  updatedAt: string;
  checkCount: number;
  enabledCheckCount: number;
}

export interface CheckSummary {
  id: string;
  localId: string;
  serviceId: string;
  name: string;
  network: string;
  schedule: string;
  configHash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  operationalState: string;
  activeIncidentId: string | null;
  lastRunId: string | null;
  lastRunState: RunState | null;
  lastRunFinishedAt: string | null;
}

export interface ServiceDetail extends ServiceSummary {
  checks: CheckSummary[];
}

export interface RunSummary {
  id: string;
  checkId: string;
  scheduledAt: string | null;
  startedAt: string;
  finishedAt: string;
  state: RunState;
  observedLedger: number | null;
  rpcEndpointFingerprint: string | null;
  configHash: string;
  observerErrorCode: string | null;
  observerErrorMessage: string | null;
}

export interface AssertionDetail {
  id: string;
  ordinal: number;
  path: string;
  operator: string;
  expected: unknown;
  observed: unknown;
  passed: boolean;
  reason: string;
}

export interface StepResultDetail {
  id: string;
  stepId: string;
  ordinal: number;
  state: RunState;
  contractId: string;
  functionName: string;
  result: unknown;
  rawReturnXdr: string | null;
  minResourceFee: string | null;
  elapsedMs: number | null;
  evidence: unknown;
  failureKind: string | null;
  failureMessage: string | null;
  assertions: AssertionDetail[];
}

export interface RunDetail extends RunSummary {
  steps: StepResultDetail[];
}

export interface IncidentSummary extends StoredIncident {
  checkName: string;
  serviceId: string;
  serviceName: string;
}

export interface NotificationAttemptSummary {
  id: string;
  incidentId: string;
  channelId: string;
  eventType: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  state: string;
  responseCode: number | null;
  errorClass: string | null;
}
