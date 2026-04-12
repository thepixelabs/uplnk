// Pylon database schema — SQLite via Drizzle ORM
// Driver: better-sqlite3 (synchronous)
// Location: ~/.uplnk/db.sqlite

import {
  sqliteTable,
  text,
  integer,
  blob,
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
    authMode: text('auth_mode').notNull().default('none'),
    lastTestedAt: text('last_tested_at'),
    lastTestStatus: text('last_test_status'),
    lastTestDetail: text('last_test_detail'),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    check(
      'provider_type_check',
      sql`${table.providerType} IN ('ollama', 'openai-compatible', 'lmstudio', 'vllm', 'localai', 'llama-cpp', 'anthropic', 'openai', 'custom')`,
    ),
    check(
      'auth_mode_check',
      sql`${table.authMode} IN ('none', 'api-key', 'bearer')`,
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
    relayId: text('relay_id'),
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

// ─── RAG Chunks ────────────────────────────────────────────────────────────────

/**
 * RAG chunk storage — each row stores one text chunk of a source file along
 * with its vector embedding (serialised Float32Array as a BLOB).
 *
 * Embedding dimensions are NOT fixed — they vary by model. The BLOB length
 * divided by 4 gives the number of Float32 values.
 *
 * indexed_at: ISO-8601 timestamp of when this chunk was last written.
 */
export const ragChunks = sqliteTable(
  'rag_chunks',
  {
    id: text('id').primaryKey(),
    filePath: text('file_path').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    /** Serialised Float32Array — null when embedding is not yet generated. */
    embedding: blob('embedding', { mode: 'buffer' }),
    indexedAt: text('indexed_at').notNull(),
  },
  (table) => [
    index('rag_chunks_file_path_idx').on(table.filePath),
    index('rag_chunks_file_chunk_idx').on(table.filePath, table.chunkIndex),
  ],
);

// ─── Relay Runs ────────────────────────────────────────────────────────────────

export const relayRuns = sqliteTable(
  'relay_runs',
  {
    id: text('id').primaryKey(),
    relayId: text('relay_id').notNull(),
    relayName: text('relay_name').notNull(),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    input: text('input').notNull(),
    scoutOutput: text('scout_output'),
    anchorOutput: text('anchor_output'),
    scoutProviderId: text('scout_provider_id').notNull(),
    scoutModel: text('scout_model').notNull(),
    anchorProviderId: text('anchor_provider_id').notNull(),
    anchorModel: text('anchor_model').notNull(),
    status: text('status').notNull(),
    scoutInputTokens: integer('scout_input_tokens'),
    scoutOutputTokens: integer('scout_output_tokens'),
    anchorInputTokens: integer('anchor_input_tokens'),
    anchorOutputTokens: integer('anchor_output_tokens'),
    errorMessage: text('error_message'),
    startedAt: text('started_at').notNull().default(isoTimestamp()),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('relay_runs_relay_id_idx').on(table.relayId),
    index('relay_runs_started_at_idx').on(table.startedAt),
    check(
      'relay_run_status_check',
      sql`${table.status} IN ('running', 'completed', 'failed', 'cancelled')`,
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

export type RagChunk = typeof ragChunks.$inferSelect;
export type NewRagChunk = typeof ragChunks.$inferInsert;

export type RelayRun = typeof relayRuns.$inferSelect;
export type NewRelayRun = typeof relayRuns.$inferInsert;
