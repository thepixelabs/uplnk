import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { db, getPylonDir, upsertProviderConfig, getDefaultProvider } from 'pylon-db';

// ─── Schema ───────────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  version: z.literal(1),
  defaultProviderId: z.string().optional(),
  defaultModel: z.string().optional(),
  theme: z.enum(['dark', 'light']).default('dark'),
  /**
   * Anonymous opt-in telemetry. Absent key = disabled (treat same as false).
   * Written on first run after the user responds to the opt-in prompt.
   * Full spec: internal-doc/telemetry-design.md
   */
  telemetry: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  mcp: z
    .object({
      /**
       * Filesystem paths the LLM is allowed to read.
       * Defaults to the current working directory when empty.
       * Each entry is an absolute path.
       */
      allowedPaths: z.array(z.string()).default([]),
      /**
       * Feature flag — command-exec tool is disabled by default.
       * Requires security-engineer sign-off before enabling.
       * Set to true only after reviewing the sandboxing in McpManager.ts.
       */
      commandExecEnabled: z.boolean().default(false),
      /**
       * ISO timestamp set when the user explicitly runs:
       *   pylon config --confirm-command-exec
       *
       * BC-3 (FINDING-004): commandExecEnabled is only honoured when this field
       * is present and contains a valid ISO 8601 timestamp. Prevents a silently
       * dropped config file from enabling command execution without user consent.
       */
      commandExecConfirmedAt: z.string().optional(),
      /**
       * Additional command binaries the user approves beyond the default
       * allowlist. Each entry is a bare binary name (e.g. "rustfmt", "black").
       * Entries in NEVER_ALLOW_COMMANDS are silently ignored — the permanent
       * blocklist cannot be overridden via config.
       */
      commandAllowlistAdditions: z.array(z.string()).default([]),
    })
    .default({}),
  git: z
    .object({
      /**
       * Feature flag — git tools (status, diff, stage, commit) are enabled by default.
       * Stage and commit require user approval via the approval gate.
       */
      enabled: z.boolean().default(true),
    })
    .default({}),
  /**
   * Multi-model routing — automatically selects a model based on task
   * complexity.  Disabled by default; opt-in via config.json.
   *
   * Example config:
   * {
   *   "modelRouter": {
   *     "enabled": true,
   *     "routes": {
   *       "simple":   "llama3.2:3b",
   *       "moderate": "qwen2.5-coder:7b",
   *       "complex":  "qwen2.5-coder:32b"
   *     }
   *   }
   * }
   */
  modelRouter: z
    .object({
      enabled: z.boolean().default(false),
      routes: z.object({
        simple: z.string(),
        moderate: z.string(),
        complex: z.string(),
      }),
    })
    .optional(),
  /**
   * Auto-update settings. When enabled, pylon checks npm for a newer version
   * once every 24h and prints an update notice on startup.
   */
  updates: z
    .object({
      enabled: z.boolean().default(true),
      /** npm package name to check — defaults to the current package name */
      packageName: z.string().default('pylon-dev'),
    })
    .default({}),
  rag: z
    .object({
      /**
       * Feature flag — RAG tools (semantic codebase search + indexing) are
       * disabled by default. Enable once an embedding model is configured.
       */
      enabled: z.boolean().default(false),
      /**
       * Optional embedding endpoint configuration.
       * When absent, mcp_rag_index can still run (chunks stored without embeddings)
       * but mcp_rag_search will not return results.
       */
      embed: z
        .object({
          baseUrl: z.string(),
          apiKey: z.string().default('ollama'),
          model: z.string().default('nomic-embed-text'),
        })
        .optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  version: 1 as const,
  theme: 'dark' as const,
  mcp: {
    allowedPaths: [],
    commandExecEnabled: false,
  },
  git: {
    enabled: true,
  },
  rag: {
    enabled: false,
  },
} satisfies z.input<typeof ConfigSchema>;

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function getConfigPath(): string {
  return join(getPylonDir(), 'config.json');
}

// ─── Read / write ─────────────────────────────────────────────────────────────

export type LoadConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

export function loadConfig(): LoadConfigResult {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const result = ConfigSchema.safeParse(JSON.parse(raw));
    if (result.success) {
      return { ok: true, config: result.data };
    }
    return {
      ok: false,
      error: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    };
  } catch (err) {
    // File not found — not an error, return undefined-like sentinel
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'CONFIG_NOT_FOUND' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(getPylonDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

// ─── Provider seeding ─────────────────────────────────────────────────────────

function seedDefaultProvider(): void {
  if (getDefaultProvider(db) !== undefined) return;
  // OLLAMA_BASE_URL lets Docker/container users point at host.docker.internal
  // without needing to edit config manually on first run.
  const baseUrl =
    process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1';
  upsertProviderConfig(db, {
    id: 'ollama-local',
    name: 'Local Ollama',
    providerType: 'ollama',
    baseUrl,
    apiKey: 'ollama',
    // qwen2.5:7b is the recommended default — llama3.2 has unreliable tool-calling
    // in Ollama (missing structured output support in many builds). qwen2.5:7b
    // handles function/tool calls correctly out of the box. llama3.1:8b is an
    // acceptable alternative if qwen2.5:7b is not available locally.
    defaultModel: 'qwen2.5:7b',
    isDefault: true,
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Load existing config or create a new one with defaults.
 *
 * Unlike `loadConfig()`, this function never returns an error — it creates
 * a fresh config file if one doesn't exist, but DOES surface Zod validation
 * errors on corrupt existing files so the caller can decide to exit.
 *
 * Returns `{ ok: true, config }` on success.
 * Returns `{ ok: false, error }` only when an existing file fails validation
 * (CONFIG_NOT_FOUND is treated as "first run" and creates defaults instead).
 */
export function getOrCreateConfig(): LoadConfigResult {
  const result = loadConfig();

  if (result.ok) {
    seedDefaultProvider();
    return result;
  }

  // First run — no file exists yet
  if (result.error === 'CONFIG_NOT_FOUND') {
    const config = ConfigSchema.parse(DEFAULT_CONFIG);
    seedDefaultProvider();
    saveConfig(config);
    return { ok: true, config };
  }

  // Existing file failed validation — surface the error without overwriting
  return result;
}
