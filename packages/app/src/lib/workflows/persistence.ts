import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPylonDir } from '@uplnk/db';
import { RelayPlanSchema, type RelayPlan } from './planSchema.js';
import { RelayError } from './errors.js';

/**
 * Validates that a relay `id` is safe to use in a filesystem path.
 *
 * Relay ids are constrained by RelayPlanSchema to `^[a-zA-Z0-9_-]+$`, but we
 * re-apply that check here as a defence-in-depth measure so that callers who
 * supply an id without going through Zod (e.g. loadRelay/deleteRelay called
 * directly) cannot perform path traversal attacks.
 *
 * Throws RelayError('RELAY_FILE_NOT_FOUND') for any id that contains a
 * path separator, a dot, or characters outside the allowed set.
 */
function assertSafeRelayId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new RelayError(
      'RELAY_FILE_NOT_FOUND',
      `Invalid relay id: ${JSON.stringify(id)}`,
    );
  }
}

/**
 * Confirms that a resolved file path is inside the relays directory.
 * Second line of defence against path traversal after assertSafeRelayId.
 */
function assertInsideRelaysDir(filePath: string): void {
  const relaysDir = resolve(getRelaysDir());
  const resolved = resolve(filePath);
  if (!resolved.startsWith(relaysDir + '/') && resolved !== relaysDir) {
    throw new RelayError(
      'RELAY_FILE_NOT_FOUND',
      `Relay path escapes relays directory: ${filePath}`,
    );
  }
}

export function getRelaysDir(): string {
  return join(getPylonDir(), 'relays');
}

export function ensureRelaysDir(): void {
  mkdirSync(getRelaysDir(), { recursive: true });
}

/**
 * Return all valid relay plans from ~/.uplnk/relays/*.json.
 * Files that fail Zod validation are skipped with a console.warn — we
 * don't crash the entire list because one relay file is corrupt.
 */
export function listRelays(): RelayPlan[] {
  ensureRelaysDir();
  const dir = getRelaysDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const plans: RelayPlan[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const result = RelayPlanSchema.safeParse(parsed);
      if (result.success) {
        plans.push(result.data);
      } else {
        const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        console.warn(`[pylon relays] skipping invalid relay file ${entry}: ${issues}`);
      }
    } catch (err) {
      console.warn(`[pylon relays] skipping unreadable relay file ${entry}: ${String(err)}`);
    }
  }
  return plans;
}

/**
 * Load a single relay plan by id.
 * Throws RelayError('RELAY_FILE_NOT_FOUND') when the file is absent,
 * RelayError('RELAY_FILE_INVALID') when Zod validation fails.
 */
export function loadRelay(id: string): RelayPlan {
  assertSafeRelayId(id);
  ensureRelaysDir();
  const filePath = join(getRelaysDir(), `${id}.json`);
  assertInsideRelaysDir(filePath);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new RelayError(
      'RELAY_FILE_NOT_FOUND',
      `Could not read relay file ${filePath}: ${String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RelayError('RELAY_FILE_INVALID', `Relay file is not valid JSON: ${filePath}`);
  }

  const result = RelayPlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new RelayError('RELAY_FILE_INVALID', `Relay validation failed for ${id}: ${issues}`);
  }

  return result.data;
}

/**
 * Persist a relay plan to ~/.uplnk/relays/<plan.id>.json.
 * Validates with Zod before writing so the file is always schema-valid.
 */
export function saveRelay(plan: RelayPlan): void {
  ensureRelaysDir();

  // Re-validate to catch callers that constructed the object manually
  const result = RelayPlanSchema.safeParse(plan);
  if (!result.success) {
    const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new RelayError('RELAY_FILE_INVALID', `Cannot save invalid relay plan: ${issues}`);
  }

  // The schema regex already guards id, but apply the path checks defensively
  // so that any future schema relaxation cannot silently allow path traversal.
  assertSafeRelayId(result.data.id);
  const filePath = join(getRelaysDir(), `${result.data.id}.json`);
  assertInsideRelaysDir(filePath);
  writeFileSync(filePath, JSON.stringify(result.data, null, 2), 'utf-8');
}

/**
 * Delete a relay file by id.
 * Throws RelayError('RELAY_FILE_NOT_FOUND') when the file does not exist.
 */
export function deleteRelay(id: string): void {
  assertSafeRelayId(id);
  ensureRelaysDir();
  const filePath = join(getRelaysDir(), `${id}.json`);
  assertInsideRelaysDir(filePath);

  try {
    unlinkSync(filePath);
  } catch (err) {
    throw new RelayError(
      'RELAY_FILE_NOT_FOUND',
      `Cannot delete relay: ${String(err)}`,
    );
  }
}
