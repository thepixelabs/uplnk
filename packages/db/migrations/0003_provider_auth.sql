ALTER TABLE `provider_configs` ADD `auth_mode` text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE `provider_configs` ADD `last_tested_at` text;
--> statement-breakpoint
ALTER TABLE `provider_configs` ADD `last_test_status` text;
--> statement-breakpoint
ALTER TABLE `provider_configs` ADD `last_test_detail` text;
--> statement-breakpoint
UPDATE `provider_configs` SET `auth_mode` = 'bearer' WHERE `api_key` IS NOT NULL AND `api_key` != '' AND `api_key` != 'ollama';
