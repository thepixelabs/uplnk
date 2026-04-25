import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

interface JournalEntry {
  idx: number;
  tag: string;
  version: string;
  when: number;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function readJournal(): Journal {
  const raw = readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8');
  return JSON.parse(raw) as Journal;
}

function readSqlTags(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

describe('migration journal integrity', () => {
  it('every SQL file has a matching entry in the journal', () => {
    const sqlTags = readSqlTags();
    const journal = readJournal();
    const journalTags = new Set(journal.entries.map((e) => e.tag));

    const unregistered = sqlTags.filter((tag) => !journalTags.has(tag));
    expect(unregistered).toEqual([]);
  });

  it('every journal entry points to an existing SQL file', () => {
    const sqlTags = new Set(readSqlTags());
    const journal = readJournal();

    const dangling = journal.entries.filter((e) => !sqlTags.has(e.tag));
    expect(dangling.map((e) => e.tag)).toEqual([]);
  });

  it('journal entries have strictly ascending idx values with no gaps', () => {
    const { entries } = readJournal();

    entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
    });
  });

  it('journal entries have no duplicate idx values', () => {
    const { entries } = readJournal();
    const idxValues = entries.map((e) => e.idx);
    const uniqueIdx = new Set(idxValues);

    expect(uniqueIdx.size).toBe(idxValues.length);
  });
});
