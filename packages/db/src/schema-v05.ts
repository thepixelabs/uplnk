// ─────────────────────────────────────────────────────────────────────────────
// Pylon v0.5 — PROPOSED schema additions / modifications
// ─────────────────────────────────────────────────────────────────────────────
// STATUS: PLANNING ONLY. Do NOT import from app code. Do NOT run drizzle-kit
// generate against this file. It exists as a design artifact to be reviewed
// before promotion into `schema.ts`.
//
// Scope covered:
//   1. Multi-provider profiles         (extend provider_configs)
//   2. Conversation branching          (self-FK on conversations + messages)
//   3. System prompt templates         (new table)
//   4. Project context                 (new table + FK from conversations)
//   5. Artifacts                       (already exists; minor tightening)
//   6. Export metadata                 (new table)
//
// Design principles applied:
//   - Every new FK uses ON DELETE CASCADE or SET NULL explicitly — no implicit
//     behaviour. WAL mode is on and foreign_keys pragma is ON (client.ts).
//   - Every new table has created_at / updated_at where mutation is expected.
//   - Soft-delete (deleted_at) is used only where UX requires undo — templates
//     and projects are hard-deleted.
//   - Indexes added only for documented access patterns, not speculatively.
//     Every index has a write-cost; callers listed in comments.
//   - CHECK constraints for enums instead of app-level validation where cheap.
// ─────────────────────────────────────────────────────────────────────────────

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const isoTimestamp = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. PROVIDER PROFILES  (modifies existing `provider_configs`)
// ─────────────────────────────────────────────────────────────────────────────
// The existing table already models most of what a "profile" needs (name,
// base_url, api_key, default_model, is_default). Gaps for v0.5:
//   - Only one row can be "default", but nothing enforces it. Add a partial
//     unique index so the database guarantees the invariant instead of the app.
//   - Add `headers` (JSON text) for custom auth schemes (e.g. OpenRouter).
//   - Add `enabled` flag so a user can keep a profile row but hide it from
//     the model selector without deleting keys.
//   - Add `sort_order` for stable ordering in the UI (selector screen).
//   - Rename note: we are NOT replacing the table. Drizzle ALTER TABLE on
//     SQLite is limited — additive columns only. Keep it additive.
// ─────────────────────────────────────────────────────────────────────────────

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

    // NEW — custom headers as JSON text. NULL means "none".
    // Kept as TEXT(JSON) rather than a child table: headers are per-profile,
    // never queried individually, and there's no aggregate use case.
    headers: text('headers'),

    // NEW — hide a profile without destroying its secret.
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    // NEW — UI ordering in ModelSelectorScreen. Integer, densely packed by app.
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    check(
      'provider_type_check',
      sql`${table.providerType} IN ('ollama', 'vllm', 'lmstudio', 'localai', 'llama-cpp', 'openai', 'anthropic', 'openrouter', 'custom')`,
    ),
    // NEW — "only one default" enforced at the DB layer. SQLite supports
    // partial indexes, so we only index rows where is_default = 1.
    uniqueIndex('provider_configs_one_default_idx')
      .on(table.isDefault)
      .where(sql`${table.isDefault} = 1`),
    // NEW — ModelSelectorScreen lists enabled profiles ordered by sort_order.
    index('provider_configs_enabled_sort_idx').on(table.enabled, table.sortOrder),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROJECTS  (new table; feature 4 — project context)
// ─────────────────────────────────────────────────────────────────────────────
// A project is a named directory. Conversations reference a project so the
// MCP filesystem tool can scope its allowed paths automatically.
//
// Why a table and not a column on conversations?
//   - A project has metadata (last opened, default system prompt template)
//     that is reused across many conversations.
//   - Avoids repeating the same absolute path string in every conversation row.
//   - Allows future features (project-level usage stats) without migration.
// ─────────────────────────────────────────────────────────────────────────────

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Absolute path on disk. Stored as-is; app normalises before insert.
    rootPath: text('root_path').notNull(),
    // Optional default template used when a new conversation is started
    // inside this project. SET NULL on template delete so we don't cascade.
    defaultTemplateId: text('default_template_id').references(
      () => systemPromptTemplates.id,
      { onDelete: 'set null' },
    ),
    lastOpenedAt: text('last_opened_at'),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    // A given absolute path may only correspond to one project.
    uniqueIndex('projects_root_path_idx').on(table.rootPath),
    // "Recent projects" picker.
    index('projects_last_opened_at_idx').on(table.lastOpenedAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. SYSTEM PROMPT TEMPLATES  (new table; feature 3)
// ─────────────────────────────────────────────────────────────────────────────
// Built-ins ship with the binary but are still rows in this table, so a user
// can "fork" a built-in by cloning it. Built-ins are protected at the app
// layer (is_builtin = 1 rows are not editable or deletable through the UI).
// We do NOT enforce that via trigger — keep the schema dumb, logic in app.
// ─────────────────────────────────────────────────────────────────────────────

export const systemPromptTemplates = sqliteTable(
  'system_prompt_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    content: text('content').notNull(),
    description: text('description'),
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    // Template picker lists user templates first, then built-ins, alpha.
    index('system_prompt_templates_builtin_name_idx').on(
      table.isBuiltin,
      table.name,
    ),
    // Names must be unique *per scope* (builtin vs user). Partial-unique
    // indexes keep this enforced cheaply.
    uniqueIndex('system_prompt_templates_user_name_idx')
      .on(table.name)
      .where(sql`${table.isBuiltin} = 0`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONVERSATIONS  (modified; features 2 + 4)
// ─────────────────────────────────────────────────────────────────────────────
// Branching model:
//   - `branched_from_conversation_id` → parent conversation (nullable).
//   - `branched_from_message_id`      → exact message that was the fork point.
//   Both nullable for root conversations. When the parent is deleted we
//   SET NULL rather than cascading — a branch survives its parent.
//
// Project link:
//   - `project_id` nullable; conversations without a project still work.
// ─────────────────────────────────────────────────────────────────────────────

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('New conversation'),
    providerId: text('provider_id').references(() => providerConfigs.id, {
      onDelete: 'set null',
    }),
    modelId: text('model_id'),

    // NEW — optional project scope.
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),

    // NEW — optional template used to seed the first system message.
    // Not a live link; we snapshot the content into messages on conversation
    // start so template edits don't mutate history.
    templateId: text('template_id').references(
      () => systemPromptTemplates.id,
      { onDelete: 'set null' },
    ),

    // NEW — branching.
    branchedFromConversationId: text('branched_from_conversation_id'),
    branchedFromMessageId: text('branched_from_message_id'),

    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    createdAt: text('created_at').notNull().default(isoTimestamp()),
    updatedAt: text('updated_at').notNull().default(isoTimestamp()),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    index('conversations_updated_at_idx').on(table.updatedAt),
    index('conversations_deleted_at_idx').on(table.deletedAt),
    // NEW — list branches of a given parent.
    index('conversations_branched_from_idx').on(table.branchedFromConversationId),
    // NEW — "conversations in this project, most recent first".
    index('conversations_project_updated_idx').on(
      table.projectId,
      table.updatedAt,
    ),
  ],
);
// NOTE: branchedFrom* FKs are declared via raw SQL in the migration, not
// here — Drizzle's self-referential FK on the same statement is awkward on
// SQLite. Target behaviour:
//   FOREIGN KEY (branched_from_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
//   FOREIGN KEY (branched_from_message_id)      REFERENCES messages(id)      ON DELETE SET NULL
// Because SQLite cannot ALTER TABLE ADD CONSTRAINT, this requires a
// table-rebuild migration for existing databases — see schema-evolution.md.

// ─────────────────────────────────────────────────────────────────────────────
// 5. MESSAGES  (unchanged apart from one new optional column)
// ─────────────────────────────────────────────────────────────────────────────
// `branch_point` is a convenience flag set on the message that was used as
// a fork anchor. Not strictly needed — you can derive it from conversations
// — but the UI wants a quick "this message has N branches" badge without a
// correlated subquery per row.
// ─────────────────────────────────────────────────────────────────────────────

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
    // NEW — count of child branches forked from this message.
    // Maintained by app code in the same txn as conversation insert.
    branchCount: integer('branch_count').notNull().default(0),
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. ARTIFACTS  (already exists; small tightening only)
// ─────────────────────────────────────────────────────────────────────────────
// Changes:
//   - Add `diff` to the type enum (feature 5 mentions diffs explicitly).
//   - Add `size_bytes` for the "big artifact" warning in the UI.
//   - Add a stable `slug` per conversation for the "open artifact by name"
//     command palette.
// ─────────────────────────────────────────────────────────────────────────────

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
    slug: text('slug'), // NEW — human-readable handle, unique per conversation
    content: text('content').notNull(),
    language: text('language'),
    sizeBytes: integer('size_bytes'), // NEW
    createdAt: text('created_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    index('artifacts_message_id_idx').on(table.messageId),
    index('artifacts_conversation_id_idx').on(table.conversationId),
    uniqueIndex('artifacts_conversation_slug_idx')
      .on(table.conversationId, table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
    check(
      'artifact_type_check',
      sql`${table.type} IN ('code', 'diagram', 'doc', 'diff')`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// 7. EXPORTS  (new table; feature 6)
// ─────────────────────────────────────────────────────────────────────────────
// Tracks what the user has exported, where, and when. Used to warn on
// "you already exported this conversation 5 minutes ago" and to populate a
// history view.
//
// Scope is the conversation (one export = one conversation snapshot).
// Artifact exports are not tracked here — they'd fire too often and their
// history is low-value.
// ─────────────────────────────────────────────────────────────────────────────

export const exports = sqliteTable(
  'exports',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    format: text('format').notNull(), // 'markdown' | 'json' | 'html'
    // Absolute filesystem path the user exported to. NULL if exported to
    // clipboard or stdout.
    destinationPath: text('destination_path'),
    // Snapshot counts at time of export — useful for "N new messages since
    // your last export" UX.
    messageCount: integer('message_count').notNull(),
    exportedAt: text('exported_at').notNull().default(isoTimestamp()),
  },
  (table) => [
    // History-per-conversation view.
    index('exports_conversation_exported_at_idx').on(
      table.conversationId,
      table.exportedAt,
    ),
    check(
      'export_format_check',
      sql`${table.format} IN ('markdown', 'json', 'html')`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderConfig = typeof providerConfigs.$inferSelect;
export type NewProviderConfig = typeof providerConfigs.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type SystemPromptTemplate = typeof systemPromptTemplates.$inferSelect;
export type NewSystemPromptTemplate = typeof systemPromptTemplates.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

export type Export = typeof exports.$inferSelect;
export type NewExport = typeof exports.$inferInsert;
