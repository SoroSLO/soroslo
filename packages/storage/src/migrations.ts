import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-operational-schema",
    sql: `
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  local_id TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  schedule TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, local_id)
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  scheduled_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pass', 'service_fail', 'observer_error', 'cancelled')),
  observed_ledger INTEGER,
  rpc_endpoint_fingerprint TEXT,
  config_hash TEXT NOT NULL,
  observer_error_code TEXT,
  observer_error_message TEXT
) STRICT;

CREATE INDEX runs_check_finished_idx
  ON runs(check_id, finished_at DESC);

CREATE TABLE step_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pass', 'service_fail', 'observer_error', 'cancelled')),
  contract_id TEXT NOT NULL,
  function_name TEXT NOT NULL,
  result_json TEXT,
  raw_return_xdr TEXT,
  min_resource_fee TEXT,
  elapsed_ms INTEGER,
  evidence_json TEXT,
  failure_kind TEXT,
  failure_message TEXT,
  UNIQUE(run_id, ordinal)
) STRICT;

CREATE TABLE assertion_results (
  id TEXT PRIMARY KEY,
  step_result_id TEXT NOT NULL REFERENCES step_results(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  path TEXT NOT NULL,
  operator TEXT NOT NULL,
  expected_json TEXT,
  observed_json TEXT,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  reason TEXT NOT NULL,
  UNIQUE(step_result_id, ordinal)
) STRICT;

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  recovered_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'recovered')),
  opening_run_id TEXT NOT NULL REFERENCES runs(id),
  recovery_run_id TEXT REFERENCES runs(id),
  failure_count INTEGER NOT NULL,
  summary TEXT NOT NULL
) STRICT;

CREATE INDEX incidents_check_state_idx
  ON incidents(check_id, state, opened_at DESC);

CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  state TEXT NOT NULL,
  response_code INTEGER,
  error_class TEXT
) STRICT;

CREATE TABLE scheduler_state (
  check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
  last_scheduled_at TEXT,
  next_scheduled_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT
) STRICT;

CREATE TABLE check_runtime_state (
  check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
  operational_state TEXT NOT NULL
    CHECK (operational_state IN ('healthy', 'pending_failure', 'incident_open', 'pending_recovery')),
  consecutive_failures INTEGER NOT NULL,
  consecutive_passes INTEGER NOT NULL,
  active_incident_id TEXT REFERENCES incidents(id),
  updated_at TEXT NOT NULL
) STRICT;
`
  },
  {
    version: 2,
    name: "notification-delivery-deduplication",
    sql: `
ALTER TABLE notification_attempts ADD COLUMN event_id TEXT;
ALTER TABLE notification_attempts ADD COLUMN payload_hash TEXT;

CREATE INDEX notification_attempts_event_idx
  ON notification_attempts(event_id, channel_id, started_at);

CREATE TABLE notification_events (
  event_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('delivering', 'delivered', 'failed')),
  claimed_at TEXT NOT NULL,
  finished_at TEXT,
  last_error TEXT,
  PRIMARY KEY(event_id, channel_id)
) STRICT;

CREATE INDEX notification_events_incident_idx
  ON notification_events(incident_id, state, claimed_at DESC);
`
  },
  {
    version: 3,
    name: "scheduler-schedule-policy-fingerprint",
    sql: `
ALTER TABLE scheduler_state ADD COLUMN schedule_policy_hash TEXT;
`
  }
] as const;

export function runMigrations(database: DatabaseSync, appliedAt = new Date().toISOString()): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const existing = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => Number((row as Record<string, unknown>).version));
  const applied = new Set(existing);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, appliedAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
