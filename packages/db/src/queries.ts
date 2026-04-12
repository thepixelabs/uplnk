import { randomUUID } from 'node:crypto';
import { eq, isNull, desc, asc, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  conversations,
  messages,
  providerConfigs,
  type Conversation,
  type NewConversation,
  type Message,
  type NewMessage,
  type ProviderConfig,
  type NewProviderConfig,
} from './schema.js';

// ─── Conversations ────────────────────────────────────────────────────────────

export function createConversation(
  db: Db,
  data: NewConversation,
): Conversation {
  const rows = db.insert(conversations).values(data).returning().all();
  return rows[0]!;
}

export function getConversation(
  db: Db,
  id: string,
): Conversation | undefined {
  const rows = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)
    .all();
  return rows[0];
}

export function listConversations(db: Db): Conversation[] {
  return db
    .select()
    .from(conversations)
    .where(isNull(conversations.deletedAt))
    .orderBy(desc(conversations.updatedAt))
    .limit(50)
    .all();
}

export function updateConversationTitle(
  db: Db,
  id: string,
  title: string,
): void {
  db.update(conversations)
    .set({ title })
    .where(eq(conversations.id, id))
    .run();
}

export function softDeleteConversation(db: Db, id: string): void {
  db.update(conversations)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(conversations.id, id))
    .run();
}

export function touchConversation(db: Db, id: string): void {
  db.update(conversations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, id))
    .run();
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function insertMessage(db: Db, data: NewMessage): Message {
  const rows = db.insert(messages).values(data).returning().all();
  return rows[0]!;
}

/**
 * Update the text content of an existing message in-place.
 * Used for incremental assistant persistence during streaming:
 * an empty row is inserted before streaming starts, then updated
 * as chunks arrive so a SIGKILL mid-stream leaves partial text visible.
 */
export function updateMessageContent(
  db: Db,
  id: string,
  content: string,
): void {
  db.update(messages)
    .set({ content })
    .where(eq(messages.id, id))
    .run();
}

export function getMessages(db: Db, conversationId: string): Message[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
}

// ─── Provider Configs ─────────────────────────────────────────────────────────

export function upsertProviderConfig(
  db: Db,
  data: NewProviderConfig,
): void {
  db.insert(providerConfigs)
    .values(data)
    .onConflictDoUpdate({
      target: providerConfigs.id,
      set: {
        name: data.name,
        providerType: data.providerType,
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        defaultModel: data.defaultModel,
        isDefault: data.isDefault,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
}

export function getDefaultProvider(
  db: Db,
): ProviderConfig | undefined {
  const rows = db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.isDefault, true))
    .limit(1)
    .all();
  return rows[0];
}

export function listProviders(db: Db): ProviderConfig[] {
  return db.select().from(providerConfigs).all();
}

// ─── Conversation Branching ───────────────────────────────────────────────────

/**
 * Fork a conversation at a given message.
 *
 * Copies all messages up to and including `forkAtMessageId` into a new
 * conversation, then returns the new conversation.
 *
 * The fork point message gets its `branch_count` incremented.
 * The new conversation has `branched_from_conversation_id` and
 * `branched_from_message_id` set.
 *
 * Uses a SQLite transaction so both the conversation insert and all
 * message copies are atomic.
 */
export function forkConversation(
  db: Db,
  sourceConversationId: string,
  forkAtMessageId: string,
  newTitle?: string,
): Conversation {
  const sourceConv = getConversation(db, sourceConversationId);
  if (sourceConv === undefined) {
    throw new Error(`Source conversation not found: ${sourceConversationId}`);
  }

  // Get all messages up to and including the fork point
  const allMessages = getMessages(db, sourceConversationId);
  const forkIdx = allMessages.findIndex((m) => m.id === forkAtMessageId);
  if (forkIdx === -1) {
    throw new Error(`Fork message not found: ${forkAtMessageId}`);
  }
  const messagesToCopy = allMessages.slice(0, forkIdx + 1);

  const newConvId = randomUUID();
  const title = newTitle ?? `Fork of: ${sourceConv.title}`;

  // All inserts in a single transaction
  db.transaction(() => {
    // Create the new (forked) conversation
    db.insert(conversations)
      .values({
        id: newConvId,
        title,
        providerId: sourceConv.providerId,
        modelId: sourceConv.modelId,
        // Type assertion: schema has these columns in v0.5 migration
        branchedFromConversationId: sourceConversationId,
        branchedFromMessageId: forkAtMessageId,
      } as typeof conversations.$inferInsert)
      .run();

    // Copy messages into the new conversation
    for (const msg of messagesToCopy) {
      db.insert(messages)
        .values({
          id: randomUUID(),
          conversationId: newConvId,
          role: msg.role,
          content: msg.content,
          toolCalls: msg.toolCalls,
          toolCallId: msg.toolCallId,
          inputTokens: msg.inputTokens,
          outputTokens: msg.outputTokens,
          timeToFirstToken: msg.timeToFirstToken,
        })
        .run();
    }

    // Increment branch_count on the fork point message (best-effort)
    try {
      db.run(
        sql`UPDATE messages SET branch_count = COALESCE(branch_count, 0) + 1 WHERE id = ${forkAtMessageId}`,
      );
    } catch {
      // Column may not exist yet on older DBs — non-fatal
    }
  });

  return getConversation(db, newConvId)!;
}
