-- Migration 0001: v0.5 additions (branching + system prompt templates)
ALTER TABLE `conversations` ADD COLUMN `branched_from_conversation_id` text REFERENCES `conversations`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `conversations` ADD COLUMN `branched_from_message_id` text REFERENCES `messages`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `conversations_branched_from_idx` ON `conversations` (`branched_from_conversation_id`);
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `branch_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_prompt_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `content` text NOT NULL,
  `description` text,
  `is_builtin` integer DEFAULT false NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `system_prompt_templates_builtin_name_idx` ON `system_prompt_templates` (`is_builtin`, `name`);
