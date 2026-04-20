-- Attribute messages to specific agents / invocations / turns.
-- All new columns are nullable (or default-null-safe) so existing rows stay valid.
ALTER TABLE messages ADD COLUMN sender_agent_name TEXT;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN addressee_agent_name TEXT;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN turn_id TEXT;
--> statement-breakpoint
CREATE INDEX messages_conv_sender_idx ON messages(conversation_id, sender_agent_name);
--> statement-breakpoint
CREATE INDEX messages_agent_run_idx ON messages(agent_run_id);
--> statement-breakpoint
CREATE INDEX messages_turn_idx ON messages(conversation_id, turn_id);
