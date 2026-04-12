// Uplnk database schema — SQLite via Drizzle ORM
// Driver: better-sqlite3 (synchronous)
// Location: ~/.uplnk/db.sqlite

import {
  sqliteTable,
  text,
  integer,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isoTimestamp = () =>
  sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// ─── Provider Configuration ───────────────────────────────────────────────────

export const providerConfigs = sqliteTable(
  'provider_configs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    providerType: text('provider_type').notNull(),
    baseUrl: text('base_url').notNull(),
    apiKey: text('api_key'),
    defaultModel: text('default_model'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    check(
      'provider_type_check',
      sql`${table.providerType} IN ('ollama', 'vllm', 'lmstudio', 'localai', 'llama-cpp', 'custom')`,
    ),
  ],
);

// ─── Conversations ─────────────────────────────────────────────────────────────

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('New conversation'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    index('conversations_updated_at_idx').on(table.updatedAt),
    index('conversations_deleted_at_idx').on(table.deletedAt),
  ],
);

// ─── Messages ──────────────────────────────────────────────────────────────────

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content'),
    toolCalls: text('tool_calls'),
    toolCallId: text('tool_call_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    timeToFirstToken: integer('time_to_first_token_ms'),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    index('messages_conversation_id_created_at_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    check(
      'message_role_check',
      sql`${table.role} IN ('user', 'assistant', 'system', 'tool')`,
    ),
  ],
);

// ─── Artifacts ─────────────────────────────────────────────────────────────────

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull().default('Untitled'),
    content: text('content').notNull(),
    language: text('language'),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    index('artifacts_message_id_idx').on(table.messageId),
    index('artifacts_conversation_id_idx').on(table.conversationId),
    check(
      'artifact_type_check',
      sql`${table.type} IN ('code', 'diagram', 'doc')`,
    ),
  ],
);

// ─── Inferred types ────────────────────────────────────────────────────────────

export type ProviderConfig = typeof providerConfigs.$inferSelect;
export type NewProviderConfig = typeof providerConfigs.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
