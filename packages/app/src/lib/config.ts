import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { db, getPylonDir, upsertProviderConfig, getDefaultProvider, getProviderById, setDefaultProvider } from '@uplnk/db';
import { migratePlaintext, isSecretRef } from './secrets.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  version: z.literal(1),
  defaultProviderId: z.string().optional(),
  defaultModel: z.string().optional(),
  theme: z.enum(['dark', 'light']).default('dark'),
  /**
   * Anonymous opt-in telemetry. Absent key = disabled (treat same as false).
   * Written on first run after the user responds to the opt-in prompt.
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
       * Set to true only after reviewing the sandboxing in McpManager.ts.
       */
      commandExecEnabled: z.boolean().default(false),
      /**
       * ISO timestamp set when the user explicitly runs:
       *   uplnk config --confirm-command-exec
       *
       * commandExecEnabled is only honoured when this field
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
      /**
       * User-configured MCP servers. Merged with project-local `.mcp.json`
       * and installed plugins. Discriminated on `type`; stdio servers require
       * a `command`, http servers require a `url`. Ids starting with
       * `__uplnk_builtin_` are rejected to prevent collision with built-in
       * servers.
       */
      servers: z
        .array(
          z.discriminatedUnion('type', [
            z.object({
              id: z.string().min(1).refine((v) => !v.startsWith('__uplnk_builtin_'), {
                message: 'id must not start with __uplnk_builtin_',
              }),
              name: z.string().min(1),
              type: z.literal('stdio'),
              command: z.string().min(1),
              args: z.array(z.string()).default([]),
              env: z.record(z.string()).optional(),
            }),
            z.object({
              id: z.string().min(1).refine((v) => !v.startsWith('__uplnk_builtin_'), {
                message: 'id must not start with __uplnk_builtin_',
              }),
              name: z.string().min(1),
              type: z.literal('http'),
              url: z.string().url(),
            }),
          ]),
        )
        .default([])
        .refine(
          (servers) => new Set(servers.map((s) => s.id)).size === servers.length,
          { message: 'mcp.servers ids must be unique' },
        ),
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
   * Auto-update settings. When enabled, uplnk checks npm for a newer version
   * once every 24h and prints an update notice on startup.
   */
  updates: z
    .object({
      enabled: z.boolean().default(true),
      /** npm package name to check — defaults to the current package name */
      packageName: z.string().default('uplnk'),
    })
    .default({}),
  /**
   * Team-wide providers that should be seeded into SQLite on every startup.
   * Each entry is upserted — the `config.json` copy is the source of truth
   * for any id listed here, so editing a team dotfile will propagate to all
   * engineers on next launch. Providers added via the TUI wizard and NOT
   * listed here are left untouched in the DB.
   *
   * `apiKeySecretRef` lets a team config point at a key stored in the
   * SecretsBackend instead of writing the raw key to `config.json`. Either
   * `apiKey` (plaintext, for local/untrusted providers like Ollama) or
   * `apiKeySecretRef` (opaque reference resolved at startup) may be set.
   */
  providers: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        providerType: z.enum([
          'ollama',
          'openai-compatible',
          'lmstudio',
          'vllm',
          'localai',
          'llama-cpp',
          'anthropic',
          'openai',
          'custom',
        ]),
        baseUrl: z.string().min(1),
        authMode: z.enum(['none', 'api-key', 'bearer']).default('none'),
        apiKey: z.string().optional(),
        apiKeySecretRef: z.string().optional(),
        defaultModel: z.string().optional(),
        isDefault: z.boolean().default(false),
      }),
    )
    .default([])
    .refine(
      (list) => new Set(list.map((p) => p.id)).size === list.length,
      { message: 'providers ids must be unique' },
    ),
  rag: z
    .object({
      /**
       * Feature flag — RAG tools (semantic codebase search + indexing) are
       * disabled by default. Enable explicitly OR rely on `autoDetect` to
       * flip this on at startup when a local Ollama with `nomic-embed-text`
       * is reachable.
       */
      enabled: z.boolean().default(false),
      /**
       * When true (default), startup probes the local Ollama for an
       * embedding model and auto-enables RAG if one is found. Set to
       * `false` to make RAG strictly opt-in via the `enabled` flag and
       * skip the probe entirely (saves ~200ms on first launch).
       */
      autoDetect: z.boolean().default(true),
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
  /**
   * Relay mode — Scout/Anchor two-phase workflow. Disabled by default.
   * When enabled, the relay picker is accessible from the chat screen.
   */
  relayMode: z
    .object({
      enabled: z.boolean().default(false),
      defaultRelayId: z.string().optional(),
    })
    .default({}),
  /**
   * Network scanner settings. Used by the /scan command and the
   * NetworkScanScreen. Subnet scanning requires explicit user consent
   * (confirmed via `uplnk config --confirm-subnet`).
   */
  networkScanner: z
    .object({
      /**
       * ISO timestamp set when the user confirms subnet scanning via
       * `uplnk config --confirm-subnet`. Required for subnet scope to
       * be reachable in the TUI.
       */
      subnetConfirmedAt: z.string().optional(),
      /** Per-host probe timeout in milliseconds. */
      timeoutMs: z.number().int().positive().default(2000),
      /** Maximum concurrent probe connections. */
      concurrency: z.number().int().positive().default(16),
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

/**
 * Upsert every provider declared in `config.json` into SQLite.
 *
 * Conflict policy: `config.json` wins for declared ids. A provider added via
 * the TUI wizard (not in `config.json`) is never touched here. If any config
 * entry has `isDefault: true`, that becomes the new default — the last one
 * wins to match Zod's declaration order.
 *
 * Secret handling: `apiKey` and `apiKeySecretRef` are mutually exclusive.
 * `apiKeySecretRef` resolves through the SecretsBackend at connection time;
 * this function writes the ref into the row so the chat path reads it.
 */
function seedConfigProviders(configProviders: Config['providers']): void {
  let explicitDefaultId: string | null = null;
  for (const p of configProviders) {
    // Any plaintext `apiKey` from config.json must go through the secrets
    // backend so it lands in the DB as a `@secret:` ref, not as cleartext.
    // `apiKeySecretRef` is passed through as-is (it's already a ref from
    // a previous seed or a hand-written one). If both are set, `apiKey`
    // wins — fresher data source.
    let storedKey: string | null = null;
    if (p.apiKey !== undefined && p.apiKey !== '') {
      storedKey = migratePlaintext(p.apiKey);
    } else if (p.apiKeySecretRef !== undefined && p.apiKeySecretRef !== '') {
      storedKey = isSecretRef(p.apiKeySecretRef)
        ? p.apiKeySecretRef
        : migratePlaintext(p.apiKeySecretRef);
    }

    upsertProviderConfig(db, {
      id: p.id,
      name: p.name,
      providerType: p.providerType,
      baseUrl: p.baseUrl,
      authMode: p.authMode,
      apiKey: storedKey,
      defaultModel: p.defaultModel ?? null,
      isDefault: p.isDefault,
    });
    if (p.isDefault) explicitDefaultId = p.id;
  }
  // Ensure the default flag is single-valued. upsertProviderConfig doesn't
  // demote others, so if any config entry opted in as default we promote it
  // through setDefaultProvider which runs the transaction.
  if (explicitDefaultId !== null && getProviderById(db, explicitDefaultId) !== undefined) {
    setDefaultProvider(db, explicitDefaultId);
  }
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
/**
 * Validate that an Ollama base URL is safe to probe at startup.
 *
 * Auto-probing happens before user consent — the URL must come from a
 * trusted source AND point at a local-only address. Anything else opens
 * an SSRF window: an attacker who can set `OLLAMA_BASE_URL` (malicious
 * dotfile, postinstall script, shared machine) could otherwise force the
 * uplnk process to fetch from arbitrary internal addresses.
 *
 * Returns the canonicalised base URL on success, or `null` if the URL
 * fails validation. Allowed hosts: `localhost`, `127.0.0.1`, `::1`. Any
 * other host is rejected unless `UPLNK_TRUST_OLLAMA_URL=1` is set, which
 * is the user's explicit opt-in for non-localhost auto-probing (e.g. a
 * trusted LAN address inside their own network).
 */
function validateOllamaProbeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!allowed && process.env['UPLNK_TRUST_OLLAMA_URL'] !== '1') {
    return null;
  }
  return raw;
}

/**
 * Probe a local Ollama for any embedding model whose name contains
 * `nomic-embed-text`. Returns the matched model id (e.g.
 * `nomic-embed-text:latest`) or `null` if Ollama is unreachable or
 * does not have a suitable model installed.
 *
 * Runs with a 1.5 s timeout — the auto-detect path must never delay
 * startup by more than the time it takes to fail.
 *
 * The URL is validated through `validateOllamaProbeUrl` before fetching
 * to avoid SSRF via `OLLAMA_BASE_URL`. Non-localhost URLs require the
 * `UPLNK_TRUST_OLLAMA_URL=1` opt-in.
 */
export async function probeOllamaEmbedder(
  baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
): Promise<string | null> {
  // Strip a trailing `/v1` HERE in the function body so explicit callers
  // passing `http://host:11434/v1` (the OpenAI-compat mount form) hit the
  // native `/api/tags` endpoint instead of `/v1/api/tags`.
  const stripped = baseUrl.replace(/\/v1\/?$/, '');
  const validated = validateOllamaProbeUrl(stripped);
  if (validated === null) return null;
  try {
    const res = await fetch(`${validated.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    if (!Array.isArray(body.models)) return null;
    const match = body.models.find((m) => typeof m.name === 'string' && m.name.includes('nomic-embed-text'));
    return match?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * If `config.rag.autoDetect` is enabled and the user has not already
 * explicitly enabled RAG with an `embed` block, probe the local Ollama
 * and turn on RAG with the discovered embedder model. This mutates the
 * config in place — callers should pass the same object they hand to
 * `App` so the effect is visible at first render.
 *
 * Returns `true` when RAG was auto-enabled, `false` otherwise. The
 * caller may print a status line so the user knows RAG turned on for
 * them.
 */
export async function maybeAutoEnableRag(config: Config): Promise<boolean> {
  if (config.rag.enabled === true) return false; // already on
  if (config.rag.autoDetect === false) return false; // user opted out
  if (config.rag.embed !== undefined) return false; // explicit embed config — respect it
  const model = await probeOllamaEmbedder();
  if (model === null) return false;
  const baseUrl = (process.env['OLLAMA_BASE_URL']?.replace(/\/v1\/?$/, '') ?? 'http://localhost:11434') + '/v1';
  config.rag.enabled = true;
  config.rag.embed = {
    baseUrl,
    apiKey: 'ollama',
    model,
  };
  return true;
}

export function getOrCreateConfig(): LoadConfigResult {
  const result = loadConfig();

  if (result.ok) {
    seedDefaultProvider();
    seedConfigProviders(result.config.providers);
    return result;
  }

  // First run — no file exists yet
  if (result.error === 'CONFIG_NOT_FOUND') {
    const config = ConfigSchema.parse(DEFAULT_CONFIG);
    seedDefaultProvider();
    seedConfigProviders(config.providers);
    saveConfig(config);
    return { ok: true, config };
  }

  // Existing file failed validation — surface the error without overwriting
  return result;
}
