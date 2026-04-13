/**
 * AgentRegistry — discovers, parses, and caches agent definitions from .md files.
 *
 * Discovery order (later overrides earlier by `name`):
 *   1. packages/app/src/lib/agents/builtins/*.md  (source: 'builtin')
 *   2. ~/.uplnk/agents/*.md                        (source: 'user')
 *   3. <projectDir>/.uplnk/agents/*.md             (source: 'project')
 *
 * Files that fail validation are skipped with console.warn — registry never throws.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseAgentFile } from './validate.js';
import type { AgentDef, IAgentRegistry } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Builtins live next to this file in ./builtins/
const BUILTINS_DIR = join(__dirname, 'builtins');
const USER_DIR = join(homedir(), '.uplnk', 'agents');

function loadAgentsFromDir(
  dir: string,
  source: 'builtin' | 'user' | 'project',
  into: Map<string, AgentDef>,
): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => extname(f) === '.md');
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const raw = readFileSync(fullPath, 'utf8');
      const def = parseAgentFile(raw, fullPath, source);
      // Later source wins (project > user > builtin)
      into.set(def.name, def);
    } catch (err) {
      console.warn(
        `[AgentRegistry] Skipping invalid agent file ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export class AgentRegistry implements IAgentRegistry {
  private _agents: Map<string, AgentDef> = new Map();
  private _projectDir: string | undefined;

  constructor(opts?: { projectDir?: string }) {
    this._projectDir = opts?.projectDir;
    this._load();
  }

  private _load(): void {
    const agents: Map<string, AgentDef> = new Map();
    // 1. Builtins (lowest priority)
    loadAgentsFromDir(BUILTINS_DIR, 'builtin', agents);
    // 2. User-global (~/.uplnk/agents)
    loadAgentsFromDir(USER_DIR, 'user', agents);
    // 3. Project-local (.uplnk/agents) — highest priority
    if (this._projectDir !== undefined) {
      loadAgentsFromDir(join(this._projectDir, '.uplnk', 'agents'), 'project', agents);
    }
    this._agents = agents;
  }

  list(): AgentDef[] {
    return Array.from(this._agents.values());
  }

  get(name: string): AgentDef | undefined {
    return this._agents.get(name);
  }

  async reload(projectDir?: string): Promise<void> {
    if (projectDir !== undefined) {
      this._projectDir = projectDir;
    }
    this._load();
  }
}

// Module-level singleton
let _registry: AgentRegistry | undefined;

export function getAgentRegistry(opts?: { projectDir?: string }): AgentRegistry {
  if (_registry === undefined) {
    _registry = new AgentRegistry(opts);
  }
  return _registry;
}

/** Test-only: reset the module singleton so each test gets a fresh registry. */
export function __resetRegistryForTests(): void {
  _registry = undefined;
}
