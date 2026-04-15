import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { FlowDef } from './schema.js';

export interface LoadedFlow {
  path: string;
  hash: string;
  def: FlowDef;
}

export function getFlowsDir(configured?: string): string {
  const dir = configured ?? '~/.uplnk/flows';
  return dir.replace(/^~/, homedir());
}

export function loadFlowFromFile(filePath: string): LoadedFlow {
  const content = readFileSync(filePath, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex');
  const ext = extname(filePath).toLowerCase();

  let raw: unknown;
  if (ext === '.yaml' || ext === '.yml') {
    raw = yaml.load(content);
  } else {
    raw = JSON.parse(content);
  }

  const def = FlowDef.parse(raw);
  return { path: filePath, hash, def };
}

export function listFlows(dir: string): LoadedFlow[] {
  if (!existsSync(dir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: LoadedFlow[] = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') continue;

    const fullPath = join(dir, entry);
    try {
      const loaded = loadFlowFromFile(fullPath);
      results.push(loaded);
    } catch (err) {
      // Skip invalid flow files rather than crashing the list — the user may
      // have a half-edited file. Log to stderr so they can see what's wrong.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[flows] Skipping ${entry}: ${msg}\n`);
    }
  }

  return results;
}

export function findFlow(name: string, dir: string): LoadedFlow | null {
  if (!existsSync(dir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') continue;

    const fullPath = join(dir, entry);
    try {
      const loaded = loadFlowFromFile(fullPath);
      // Match by flow def name or by filename without extension
      const fileBaseName = basename(entry, ext);
      if (loaded.def.name === name || fileBaseName === name) {
        return loaded;
      }
    } catch {
      // Skip unreadable/invalid files
    }
  }

  return null;
}
