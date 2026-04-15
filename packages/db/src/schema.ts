// uplnk database schema — SQLite via Drizzle ORM
// Driver: better-sqlite3 (synchronous)
// Location: ~/.uplnk/db.sqlite

import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  check,
  type AnySQLiteColumn,
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
    source: text('source').notNull().default('tui'),
    importedFrom: text('imported_from'),
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

// ─── Flows ────────────────────────────────────────────────────────────────────

export const flows = sqliteTable(
  'flows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    version: integer('version').notNull().default(1),
    sourcePath: text('source_path').notNull(),
    sourceHash: text('source_hash').notNull(),
    definitionJson: text('definition_json').notNull(),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
  },
);

// ─── Flow Runs ────────────────────────────────────────────────────────────────

export const flowRuns = sqliteTable(
  'flow_runs',
  {
    id: text('id').primaryKey(),
    flowId: text('flow_id').notNull().references(() => flows.id),
    flowVersion: integer('flow_version').notNull(),
    trigger: text('trigger').notNull(), // 'manual'|'file'|'cron'|'webhook'|'flow-child'
    status: text('status').notNull(),   // 'pending'|'running'|'succeeded'|'failed'|'cancelled'
    startedAt: text('started_at').notNull().default(isoTimestamp()),
    endedAt: text('ended_at'),
    inputJson: text('input_json'),
    outputJson: text('output_json'),
    errorJson: text('error_json'),
    parentRunId: text('parent_run_id').references((): AnySQLiteColumn => flowRuns.id),
  },
  (table) => [
    index('flow_runs_flow_id_idx').on(table.flowId),
    index('flow_runs_status_idx').on(table.status),
    check('flow_run_status_check', sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')`),
  ],
);

// ─── Flow Step Results ────────────────────────────────────────────────────────

export const flowStepResults = sqliteTable(
  'flow_step_results',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull().references(() => flowRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    stepIndex: integer('step_index').notNull(),
    iteration: integer('iteration').notNull().default(0),
    status: text('status').notNull(),
    startedAt: text('started_at').notNull().default(isoTimestamp()),
    endedAt: text('ended_at'),
    inputJson: text('input_json'),
    outputJson: text('output_json'),
    errorJson: text('error_json'),
    messageId: text('message_id').references(() => messages.id),
    roboticSessionId: text('robotic_session_id'),
  },
  (table) => [
    index('flow_step_results_run_idx').on(table.runId, table.stepIndex, table.iteration),
  ],
);

// ─── Robotic Sessions ─────────────────────────────────────────────────────────

export const roboticSessions = sqliteTable(
  'robotic_sessions',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    endedAt: text('ended_at'),
    target: text('target').notNull(),
    altergoAccount: text('altergo_account'),
    transport: text('transport').notNull(),
    goal: text('goal').notNull(),
    status: text('status').notNull(),
    conversationId: text('conversation_id').references(() => conversations.id),
    flowRunId: text('flow_run_id').references(() => flowRuns.id),
  },
  (table) => [
    index('robotic_sessions_status_idx').on(table.status),
    check('robotic_session_status_check', sql`${table.status} IN ('running', 'succeeded', 'failed', 'aborted')`),
  ],
);

// ─── Robotic Turns ────────────────────────────────────────────────────────────

export const roboticTurns = sqliteTable(
  'robotic_turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => roboticSessions.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    direction: text('direction').notNull(), // 'uplnk->target' | 'target->uplnk'
    content: text('content').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    metaJson: text('meta_json'),
  },
  (table) => [
    index('robotic_turns_session_idx').on(table.sessionId, table.idx),
  ],
);

// ─── Altergo Accounts ─────────────────────────────────────────────────────────

export const altergoAccounts = sqliteTable(
  'altergo_accounts',
  {
    id: text('id').primaryKey(),
    providersJson: text('providers_json').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    metaJson: text('meta_json'),
  },
);

// ─── Altergo Imports ──────────────────────────────────────────────────────────

export const altergoImports = sqliteTable(
  'altergo_imports',
  {
    id: text('id').primaryKey(),
    account: text('account').notNull(),
    provider: text('provider').notNull(),
    sourcePath: text('source_path').notNull().unique(),
    sourceHash: text('source_hash').notNull(),
    conversationId: text('conversation_id').notNull().references(() => conversations.id),
    importedAt: text('imported_at').notNull().default(isoTimestamp()),
    messageCount: integer('message_count').notNull(),
  },
  (table) => [
    index('altergo_imports_account_idx').on(table.account, table.provider),
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

export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
export type FlowRun = typeof flowRuns.$inferSelect;
export type NewFlowRun = typeof flowRuns.$inferInsert;
export type FlowStepResult = typeof flowStepResults.$inferSelect;
export type NewFlowStepResult = typeof flowStepResults.$inferInsert;
export type RoboticSession = typeof roboticSessions.$inferSelect;
export type NewRoboticSession = typeof roboticSessions.$inferInsert;
export type RoboticTurn = typeof roboticTurns.$inferSelect;
export type NewRoboticTurn = typeof roboticTurns.$inferInsert;
export type AltergoAccount = typeof altergoAccounts.$inferSelect;
export type NewAltergoAccount = typeof altergoAccounts.$inferInsert;
export type AltergoImport = typeof altergoImports.$inferSelect;
export type NewAltergoImport = typeof altergoImports.$inferInsert;
