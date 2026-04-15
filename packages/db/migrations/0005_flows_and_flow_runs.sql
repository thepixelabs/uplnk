-- uplnk v2 flows engine
ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'tui';
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN imported_from TEXT;
--> statement-breakpoint
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE TABLE flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id),
  flow_version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  parent_run_id TEXT REFERENCES flow_runs(id)
);
--> statement-breakpoint
CREATE INDEX flow_runs_flow_id_idx ON flow_runs(flow_id);
--> statement-breakpoint
CREATE INDEX flow_runs_status_idx ON flow_runs(status);
--> statement-breakpoint
CREATE TABLE flow_step_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  message_id TEXT REFERENCES messages(id),
  robotic_session_id TEXT
);
--> statement-breakpoint
CREATE INDEX flow_step_results_run_idx ON flow_step_results(run_id, step_index, iteration);
