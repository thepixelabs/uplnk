-- Continuation lineage for agent runs: when a finished run is resumed via
-- delegate_to_agent(run_id), the NEW run records the prior run's id here.
-- Nullable — regular (non-resumed) runs leave it NULL. Not a FK on purpose,
-- matching parent_invocation_id (walk lineage in app code, no cascade surprises).
ALTER TABLE agent_runs ADD COLUMN resumed_from_run_id TEXT;
--> statement-breakpoint
CREATE INDEX agent_runs_resumed_from_idx ON agent_runs(resumed_from_run_id);
