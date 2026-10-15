/**
 * compareScoreboard — pure persistence + aggregation for /compare mode votes.
 *
 * Stores a flat JSON array of CompareVoteRecord values at
 * `~/.uplnk/compare-votes.json` (override via the `path` argument for tests).
 *
 * Schema versioning rule: bump CompareVoteRecord.schemaVersion the moment the
 * shape changes. readVotes() filters out records whose schemaVersion does not
 * match the current code, returning only records the current build understands.
 * On a bump, write a one-shot migration that reads with the OLD schema, maps
 * to the new shape, then writes back — never silently mutate the file in-place.
 *
 * Writes are atomic: we serialise into a `<file>.tmp` sibling and then call
 * fs.renameSync — POSIX rename is atomic on the same filesystem, so a SIGKILL
 * mid-write never leaves the user with a truncated votes file. The previous
 * file is replaced wholesale; we never partially update an existing one.
 *
 * Prompt truncation: any vote whose prompt exceeds MAX_PROMPT_LEN characters
 * is silently truncated to MAX_PROMPT_LEN before writing — matches the
 * existing audit-log invariant style (no surprise data loss; the caller
 * sees the on-disk record reflect the truncation via the readVotes roundtrip).
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Current schema version. Bump on every breaking change to the record shape. */
export const COMPARE_VOTE_SCHEMA_VERSION = 1 as const;

/** Maximum stored prompt length — longer prompts are truncated on write. */
export const MAX_PROMPT_LEN = 200;

export interface CompareVoteRecord {
  /** v1 — bump on schema change. */
  schemaVersion: 1;
  /** ISO timestamp recorded at write time. */
  ts: string;
  /** Models in the comparison round, ordered by pane index. */
  models: readonly string[];
  /** Index into models[] for the winner, or 'tie'. */
  winner: number | 'tie';
  /** Prompt that produced the round; truncated to MAX_PROMPT_LEN chars. */
  prompt: string;
  /** Round mode — chat vs deep research. */
  mode: 'chat' | 'research';
  /** Whether labels were hidden when the user voted. */
  blind: boolean;
}

export interface CompareAggregateRow {
  model: string;
  wins: number;
  losses: number;
  ties: number;
  /** wins / (wins + losses); 0 when no decisive rounds. Ties are excluded. */
  winRate: number;
}

/** Default on-disk location for the votes file. */
export function defaultVotesPath(): string {
  return join(homedir(), '.uplnk', 'compare-votes.json');
}

/** Read all known votes from disk. Returns [] when the file is missing. */
export function readVotes(path: string = defaultVotesPath()): CompareVoteRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const records: CompareVoteRecord[] = [];
  for (const candidate of parsed) {
    if (isCompareVoteRecord(candidate)) {
      records.push(candidate);
    }
  }
  return records;
}

/** Append a vote record to disk. Writes atomically via a temp file + rename. */
export function writeVote(
  record: CompareVoteRecord,
  path: string = defaultVotesPath(),
): void {
  const normalised: CompareVoteRecord = {
    ...record,
    prompt: truncatePrompt(record.prompt),
  };
  const existing = readVotes(path);
  existing.push(normalised);
  const serialised = JSON.stringify(existing, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, serialised, 'utf-8');
  renameSync(tmpPath, path);
}

/**
 * Aggregate per-model win/loss/tie counts.
 *
 * Ties contribute to `ties` but are intentionally excluded from the winRate
 * denominator — winRate = wins / (wins + losses). A model that has only ever
 * tied has a winRate of 0 with no wins or losses recorded.
 */
export function aggregateScoreboard(
  votes: readonly CompareVoteRecord[],
): CompareAggregateRow[] {
  const tally = new Map<string, { wins: number; losses: number; ties: number }>();

  function bump(model: string, key: 'wins' | 'losses' | 'ties'): void {
    const current = tally.get(model) ?? { wins: 0, losses: 0, ties: 0 };
    current[key] += 1;
    tally.set(model, current);
  }

  for (const vote of votes) {
    if (vote.winner === 'tie') {
      for (const model of vote.models) bump(model, 'ties');
      continue;
    }
    const winnerIdx = vote.winner;
    if (winnerIdx < 0 || winnerIdx >= vote.models.length) continue;
    const winnerModel = vote.models[winnerIdx];
    if (winnerModel === undefined) continue;
    for (let i = 0; i < vote.models.length; i++) {
      const model = vote.models[i];
      if (model === undefined) continue;
      bump(model, i === winnerIdx ? 'wins' : 'losses');
    }
  }

  const rows: CompareAggregateRow[] = [];
  for (const [model, counts] of tally.entries()) {
    const decisive = counts.wins + counts.losses;
    const winRate = decisive === 0 ? 0 : counts.wins / decisive;
    rows.push({ model, wins: counts.wins, losses: counts.losses, ties: counts.ties, winRate });
  }
  // Stable order: highest winRate first, then by wins descending, then model name.
  rows.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.model.localeCompare(b.model);
  });
  return rows;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function truncatePrompt(prompt: string): string {
  return prompt.length <= MAX_PROMPT_LEN ? prompt : prompt.slice(0, MAX_PROMPT_LEN);
}

function isCompareVoteRecord(value: unknown): value is CompareVoteRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CompareVoteRecord> & { schemaVersion?: unknown };
  if (candidate.schemaVersion !== COMPARE_VOTE_SCHEMA_VERSION) return false;
  if (typeof candidate.ts !== 'string') return false;
  if (!Array.isArray(candidate.models)) return false;
  for (const m of candidate.models) {
    if (typeof m !== 'string') return false;
  }
  if (typeof candidate.prompt !== 'string') return false;
  if (candidate.mode !== 'chat' && candidate.mode !== 'research') return false;
  if (typeof candidate.blind !== 'boolean') return false;
  if (candidate.winner === 'tie') return true;
  return typeof candidate.winner === 'number' && Number.isInteger(candidate.winner);
}
