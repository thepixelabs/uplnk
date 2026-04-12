/**
 * exportConversation — exports a conversation to Markdown or JSON.
 *
 * Invoked via the `/export` command in ChatInput.
 * Writes to the current working directory or a specified path.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Message } from 'uplnk-db';

export type ExportFormat = 'markdown' | 'json';

export interface ExportOptions {
  format: ExportFormat;
  outputPath?: string;
  conversationTitle?: string;
}

// ─── Markdown export ──────────────────────────────────────────────────────────

function toMarkdown(messages: Message[], title: string): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `> Exported from Uplnk on ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    if (msg.role === 'system') {
      lines.push('> **[system]**', '');
      lines.push(`> ${(msg.content ?? '').split('\n').join('\n> ')}`, '');
      lines.push('---', '');
      continue;
    }

    const roleLabel = msg.role === 'user' ? '**You**' : '**Uplnk**';
    const timestamp = msg.createdAt
      ? `<small>${msg.createdAt}</small>`
      : '';

    lines.push(`### ${roleLabel} ${timestamp}`, '');
    lines.push(msg.content ?? '', '');
    lines.push('---', '');
  }

  return lines.join('\n');
}

// ─── JSON export ──────────────────────────────────────────────────────────────

function toJson(
  messages: Message[],
  title: string,
): string {
  const payload = {
    title,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content ?? '',
      createdAt: m.createdAt ?? null,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ExportResult {
  path: string;
  format: ExportFormat;
  messageCount: number;
}

export function exportConversation(
  messages: Message[],
  options: ExportOptions,
): ExportResult {
  const { format, conversationTitle = 'Uplnk Conversation' } = options;

  const ext = format === 'markdown' ? 'md' : 'json';
  const safeName = conversationTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = `uplnk-${safeName}-${ts}.${ext}`;

  const outputPath = options.outputPath ?? join(process.cwd(), defaultName);

  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  const content =
    format === 'markdown'
      ? toMarkdown(messages, conversationTitle)
      : toJson(messages, conversationTitle);

  writeFileSync(outputPath, content, 'utf-8');

  return {
    path: outputPath,
    format,
    messageCount: messages.filter((m) => m.role !== 'system').length,
  };
}
