-- uplnk multi-agent core: agent_runs + conversation_agents + ephemeral_agents
-- plus conversations.mode / conversations.floor_agent_name.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_invocation_id TEXT NOT NULL,
  parent_invocation_id TEXT,
  agent_name TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  ancestry_json TEXT NOT NULL DEFAULT '[]',
  trigger_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  model TEXT,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'errored', 'aborted')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  CHECK(depth >= 0)
);
--> statement-breakpoint
CREATE INDEX agent_runs_conv_started_idx ON agent_runs(conversation_id, started_at);
--> statement-breakpoint
CREATE INDEX agent_runs_root_idx ON agent_runs(root_invocation_id);
--> statement-breakpoint
CREATE INDEX agent_runs_parent_idx ON agent_runs(parent_invocation_id);
--> statement-breakpoint
CREATE TABLE conversation_agents (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  is_ephemeral INTEGER NOT NULL DEFAULT 0,
  provider_override TEXT,
  model_override TEXT,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  left_at TEXT,
  PRIMARY KEY(conversation_id, agent_name, joined_at)
);
--> statement-breakpoint
CREATE INDEX conversation_agents_conv_idx ON conversation_agents(conversation_id);
--> statement-breakpoint
CREATE INDEX conversation_agents_active_idx ON conversation_agents(conversation_id, left_at);
--> statement-breakpoint
CREATE TABLE ephemeral_agents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(conversation_id, name)
);
--> statement-breakpoint
CREATE INDEX ephemeral_agents_conv_name_idx ON ephemeral_agents(conversation_id, name);
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'single';
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN floor_agent_name TEXT;
