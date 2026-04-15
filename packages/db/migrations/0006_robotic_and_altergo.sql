-- uplnk v2 robotic mode + altergo integration
CREATE TABLE robotic_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  target TEXT NOT NULL,
  altergo_account TEXT,
  transport TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'aborted')),
  conversation_id TEXT REFERENCES conversations(id),
  flow_run_id TEXT REFERENCES flow_runs(id)
);
--> statement-breakpoint
CREATE INDEX robotic_sessions_status_idx ON robotic_sessions(status);
--> statement-breakpoint
CREATE TABLE robotic_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES robotic_sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  meta_json TEXT
);
--> statement-breakpoint
CREATE INDEX robotic_turns_session_idx ON robotic_turns(session_id, idx);
--> statement-breakpoint
CREATE TABLE altergo_accounts (
  id TEXT PRIMARY KEY,
  providers_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  meta_json TEXT
);
--> statement-breakpoint
CREATE TABLE altergo_imports (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  message_count INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX altergo_imports_account_idx ON altergo_imports(account, provider);
