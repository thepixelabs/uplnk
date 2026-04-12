ALTER TABLE `conversations` ADD `relay_id` text;
--> statement-breakpoint
CREATE TABLE `relay_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `relay_id` text NOT NULL,
  `relay_name` text NOT NULL,
  `conversation_id` text REFERENCES `conversations`(`id`) ON DELETE SET NULL,
  `input` text NOT NULL,
  `scout_output` text,
  `anchor_output` text,
  `scout_provider_id` text NOT NULL,
  `scout_model` text NOT NULL,
  `anchor_provider_id` text NOT NULL,
  `anchor_model` text NOT NULL,
  `status` text NOT NULL,
  `scout_input_tokens` integer,
  `scout_output_tokens` integer,
  `anchor_input_tokens` integer,
  `anchor_output_tokens` integer,
  `error_message` text,
  `started_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  `completed_at` text
);
--> statement-breakpoint
CREATE INDEX `relay_runs_relay_id_idx` ON `relay_runs` (`relay_id`);
--> statement-breakpoint
CREATE INDEX `relay_runs_started_at_idx` ON `relay_runs` (`started_at`);
