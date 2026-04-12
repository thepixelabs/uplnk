CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text DEFAULT 'Untitled' NOT NULL,
	`content` text NOT NULL,
	`language` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_type_check" CHECK("artifacts"."type" IN ('code', 'diagram', 'doc'))
);
--> statement-breakpoint
CREATE INDEX `artifacts_message_id_idx` ON `artifacts` (`message_id`);--> statement-breakpoint
CREATE INDEX `artifacts_conversation_id_idx` ON `artifacts` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`provider_id` text,
	`model_id` text,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `conversations_updated_at_idx` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `conversations_deleted_at_idx` ON `conversations` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`tool_calls` text,
	`tool_call_id` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`time_to_first_token_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_role_check" CHECK("messages"."role" IN ('user', 'assistant', 'system', 'tool'))
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_id_created_at_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider_type` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text,
	`default_model` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "provider_type_check" CHECK("provider_configs"."provider_type" IN ('ollama', 'vllm', 'lmstudio', 'localai', 'llama-cpp', 'custom'))
);
