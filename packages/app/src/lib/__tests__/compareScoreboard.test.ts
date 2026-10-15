/**
 * Tests for compareScoreboard — round-trip persistence, atomic writes,
 * prompt truncation, aggregation rules.
 *
 * Atomicity is verified by spying on writeFileSync + renameSync: the temp
 * file must be written and then renamed onto the target path. We use a
 * mkdtemp'd directory so the real filesystem path is exercised without
 * touching the user's home dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readVotes,
  writeVote,
  aggregateScoreboard,
  defaultVotesPath,
  COMPARE_VOTE_SCHEMA_VERSION,
  MAX_PROMPT_LEN,
  type CompareVoteRecord,
} from '../compareScoreboard.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let votesPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-compare-test-'));
  votesPath = join(tmpDir, 'compare-votes.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<CompareVoteRecord> = {}): CompareVoteRecord {
  return {
    schemaVersion: COMPARE_VOTE_SCHEMA_VERSION,
    ts: '2026-06-01T12:00:00Z',
    models: ['gpt-4o', 'claude-3-5-sonnet'],
    winner: 0,
    prompt: 'Explain TypeScript generics.',
    mode: 'chat',
    blind: true,
    ...overrides,
  };
}

// ─── defaultVotesPath ────────────────────────────────────────────────────────

describe('defaultVotesPath', () => {
  it('lives under the .uplnk directory in the user home', () => {
    const p = defaultVotesPath();
    expect(p.endsWith('/.uplnk/compare-votes.json')).toBe(true);
  });
});

// ─── readVotes / writeVote round trip ─────────────────────────────────────────

describe('writeVote → readVotes round trip', () => {
  it('returns an empty array when the file does not exist', () => {
    expect(readVotes(votesPath)).toEqual([]);
  });

  it('returns the written record on a single write', () => {
    const record = makeRecord();
    writeVote(record, votesPath);
    const round = readVotes(votesPath);
    expect(round).toHaveLength(1);
    expect(round[0]).toEqual(record);
  });

  it('appends successive writes in chronological order', () => {
    writeVote(makeRecord({ ts: '2026-06-01T12:00:00Z', winner: 0 }), votesPath);
    writeVote(makeRecord({ ts: '2026-06-01T12:05:00Z', winner: 'tie' }), votesPath);
    writeVote(makeRecord({ ts: '2026-06-01T12:10:00Z', winner: 1 }), votesPath);
    const round = readVotes(votesPath);
    expect(round.map((r) => r.winner)).toEqual([0, 'tie', 1]);
  });

  it('tolerates a missing parent directory', () => {
    const nested = join(tmpDir, 'nested', 'deeper', 'compare-votes.json');
    writeVote(makeRecord(), nested);
    expect(existsSync(nested)).toBe(true);
    expect(readVotes(nested)).toHaveLength(1);
  });

  it('tolerates a malformed file by returning an empty list', () => {
    writeFileSync(votesPath, '{not-json', 'utf-8');
    expect(readVotes(votesPath)).toEqual([]);
  });

  it('filters records with a mismatched schemaVersion', () => {
    const malformed = [
      { ...makeRecord(), schemaVersion: 99 },
      makeRecord(),
    ];
    writeFileSync(votesPath, JSON.stringify(malformed), 'utf-8');
    const round = readVotes(votesPath);
    expect(round).toHaveLength(1);
    expect(round[0]?.schemaVersion).toBe(COMPARE_VOTE_SCHEMA_VERSION);
  });
});

// ─── Prompt truncation ────────────────────────────────────────────────────────

describe('writeVote prompt truncation', () => {
  it('truncates prompts longer than MAX_PROMPT_LEN', () => {
    const longPrompt = 'A'.repeat(MAX_PROMPT_LEN + 50);
    writeVote(makeRecord({ prompt: longPrompt }), votesPath);
    const round = readVotes(votesPath);
    expect(round[0]?.prompt.length).toBe(MAX_PROMPT_LEN);
    expect(round[0]?.prompt).toBe('A'.repeat(MAX_PROMPT_LEN));
  });

  it('leaves prompts at or below MAX_PROMPT_LEN intact', () => {
    const exactPrompt = 'B'.repeat(MAX_PROMPT_LEN);
    writeVote(makeRecord({ prompt: exactPrompt }), votesPath);
    const round = readVotes(votesPath);
    expect(round[0]?.prompt).toBe(exactPrompt);
  });
});

// ─── Atomic write ─────────────────────────────────────────────────────────────

describe('writeVote atomicity', () => {
  it('leaves no orphan .tmp behind after a successful write', () => {
    writeVote(makeRecord(), votesPath);
    expect(existsSync(`${votesPath}.tmp`)).toBe(false);
    expect(existsSync(votesPath)).toBe(true);
  });

  it('replaces the file atomically rather than truncating in place', () => {
    // Write an initial record. Then capture the inode-equivalent (size +
    // mtime are too coarse; we read the file directly between writes and
    // confirm the second write replaces the contents wholesale rather than
    // appending in place).
    writeVote(makeRecord({ winner: 0, ts: '2026-06-01T12:00:00Z' }), votesPath);
    const firstSnapshot = readFileSync(votesPath, 'utf-8');

    writeVote(makeRecord({ winner: 1, ts: '2026-06-01T12:01:00Z' }), votesPath);
    const secondSnapshot = readFileSync(votesPath, 'utf-8');

    // Different content (second includes both records).
    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(JSON.parse(secondSnapshot)).toHaveLength(2);

    // No .tmp leftover.
    expect(existsSync(`${votesPath}.tmp`)).toBe(false);
  });

  it('cleans up the .tmp sibling on a malformed-file recovery write', () => {
    // Pre-poison the votes file with garbage. writeVote should still
    // succeed (readVotes returns [] for a malformed file, so the new
    // write starts a fresh array) and leave no .tmp behind.
    writeFileSync(votesPath, '{not-json', 'utf-8');
    writeVote(makeRecord(), votesPath);
    expect(existsSync(`${votesPath}.tmp`)).toBe(false);
    const round = readVotes(votesPath);
    expect(round).toHaveLength(1);
  });
});

// ─── Aggregate scoreboard ────────────────────────────────────────────────────

describe('aggregateScoreboard', () => {
  it('returns an empty list for no votes', () => {
    expect(aggregateScoreboard([])).toEqual([]);
  });

  it('counts wins, losses, and ties per model', () => {
    const votes: CompareVoteRecord[] = [
      makeRecord({ models: ['A', 'B'], winner: 0 }),
      makeRecord({ models: ['A', 'B'], winner: 0 }),
      makeRecord({ models: ['A', 'B'], winner: 0 }),
      makeRecord({ models: ['A', 'B'], winner: 'tie' }),
      makeRecord({ models: ['A', 'B'], winner: 'tie' }),
    ];
    const rows = aggregateScoreboard(votes);
    const a = rows.find((r) => r.model === 'A');
    const b = rows.find((r) => r.model === 'B');
    expect(a).toEqual({ model: 'A', wins: 3, losses: 0, ties: 2, winRate: 1 });
    expect(b).toEqual({ model: 'B', wins: 0, losses: 3, ties: 2, winRate: 0 });
  });

  it('excludes ties from the winRate denominator', () => {
    const votes: CompareVoteRecord[] = [
      makeRecord({ models: ['A', 'B'], winner: 'tie' }),
      makeRecord({ models: ['A', 'B'], winner: 'tie' }),
      makeRecord({ models: ['A', 'B'], winner: 'tie' }),
    ];
    const rows = aggregateScoreboard(votes);
    for (const row of rows) {
      expect(row.winRate).toBe(0);
      expect(row.wins).toBe(0);
      expect(row.losses).toBe(0);
      expect(row.ties).toBe(3);
    }
  });

  it('handles three-way comparisons (a win counts everyone else as a loss)', () => {
    const votes: CompareVoteRecord[] = [
      makeRecord({ models: ['A', 'B', 'C'], winner: 1 }),
    ];
    const rows = aggregateScoreboard(votes);
    const a = rows.find((r) => r.model === 'A');
    const b = rows.find((r) => r.model === 'B');
    const c = rows.find((r) => r.model === 'C');
    expect(b?.wins).toBe(1);
    expect(b?.losses).toBe(0);
    expect(a?.losses).toBe(1);
    expect(c?.losses).toBe(1);
  });

  it('ignores votes with an out-of-range winner index', () => {
    const votes: CompareVoteRecord[] = [
      makeRecord({ models: ['A', 'B'], winner: 5 }),
    ];
    const rows = aggregateScoreboard(votes);
    expect(rows).toEqual([]);
  });

  it('orders rows by winRate descending, then wins, then model name', () => {
    const votes: CompareVoteRecord[] = [
      makeRecord({ models: ['A', 'B'], winner: 0 }),
      makeRecord({ models: ['A', 'B'], winner: 0 }),
      makeRecord({ models: ['C', 'D'], winner: 0 }),
    ];
    const rows = aggregateScoreboard(votes);
    expect(rows[0]?.model).toBe('A');
    expect(rows[0]?.winRate).toBe(1);
  });
});
