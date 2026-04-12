#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { App } from '../src/index.js';
import { WORDMARK } from '../src/lib/colors.js';
import { runMigrations } from 'uplnk-db';

// ─── IPv4-first global fetch dispatcher ──────────────────────────────────────
// Node's undici-based fetch tries addresses in DNS return order. When a
// hostname (e.g. a LAN alias like "pixelmusic") resolves to both a link-local
// IPv6 address (fe80::) and an IPv4 address, it tries IPv6 first. Link-local
// IPv6 without a scope-ID is not routable, so the connection hangs until the
// AbortController timeout fires — IPv4 never gets a chance.
//
// --dns-result-order=ipv4first only affects the legacy net/http core modules,
// not undici. The correct fix is a custom Agent with an overridden lookup that
// reorders results to put AF_INET (IPv4) before AF_INET6 before undici races
// them. We set this once here so every fetch call in the process — including
// those inside the AI SDK's streamText — inherits the same behaviour.
{
  const { Agent, setGlobalDispatcher } = await import('undici');
  const { lookup: dnsLookup } = await import('node:dns');

  // Note: we deliberately avoid `typeof dnsLookup` here. The Node `dns.lookup`
  // type carries a `__promisify__` brand that a hand-written function literal
  // cannot satisfy under `exactOptionalPropertyTypes`. The undici Agent
  // `connect.lookup` option only checks the call signature, not the brand,
  // so an unbranded function value works at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ipv4FirstLookup = ((hostname: string, optionsOrCb: any, maybeCallback: any) => {
    // dns.lookup can be called as (host, callback) or (host, options, callback).
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCallback!;
    const options  = typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb : {};

    // Always request all addresses so we can sort IPv4 before IPv6.
    dnsLookup(hostname, { ...options, all: true, family: 0 }, (err, addresses) => {
      if (err != null || !Array.isArray(addresses) || addresses.length === 0) {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          err, '', 0,
        );
        return;
      }
      // Sort: IPv4 (family 4) before IPv6 (family 6).
      const sorted = [...addresses].sort((a, b) => a.family - b.family);

      // undici v7 Happy Eyeballs calls lookup with { all: true } and expects
      // the callback in array form: (err, LookupAddress[]).
      // When called with { all: false } (or no options), it expects single form:
      // (err, address, family). We must mirror the form the caller requested.
      const wantsAll = typeof optionsOrCb === 'object' && optionsOrCb !== null
        && (optionsOrCb as { all?: boolean }).all === true;

      if (wantsAll) {
        (callback as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(
          null, sorted,
        );
      } else {
        const { address, family } = sorted[0]!;
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null, address, family,
        );
      }
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  // autoSelectFamily=false disables undici's own Happy Eyeballs so it uses
  // exactly the single address our lookup returns instead of racing IPv4/IPv6.
  setGlobalDispatcher(new Agent({ connect: { lookup: ipv4FirstLookup, autoSelectFamily: false } }));
}

// Crash log lives in the user's private `~/.pylon` directory, NOT in
// `/tmp`. `/tmp` is world-writable on POSIX systems, which opens a
// symlink-race / local-information-disclosure class of attacks on
// multi-user machines. `~/.pylon` is created by getOrCreateConfig()
// with inherited umask (typically 0o700 via the parent mkdir below)
// and is already our single source of truth for per-user Pylon state.
const CRASH_LOG_PATH = join(homedir(), '.uplnk', 'crash.log');
try { mkdirSync(join(homedir(), '.uplnk'), { recursive: true, mode: 0o700 }); } catch { /* handled below */ }

// Synchronous handlers so nothing is missed regardless of crash type.
const logCrash = (label: string, err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    appendFileSync(
      CRASH_LOG_PATH,
      `\n--- ${label} ${new Date().toISOString()} ---\n${msg}\n`,
      { mode: 0o600 },
    );
  } catch { /* swallow — crash logging must never throw */ }
};
process.on('uncaughtException',    (err) => { logCrash('UNCAUGHT', err);   process.exit(1); });
process.on('unhandledRejection',   (err) => { logCrash('REJECTION', err);  process.exit(1); });

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model:                   { type: 'string',  short: 'm' },
    provider:                { type: 'string',  short: 'p' },
    conversation:            { type: 'string',  short: 'c' },
    theme:                   { type: 'string',  short: 't' },
    project:                 { type: 'string',  short: 'P' },
    help:                    { type: 'boolean', short: 'h' },
    version:                 { type: 'boolean', short: 'v' },
    plugin:                  { type: 'string' },
    'confirm-command-exec':  { type: 'boolean' },
  },
  allowPositionals: true,
});

if (values.version) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const pkg = require('../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  console.log(`
${WORDMARK}  —  terminal LLM developer assistant

USAGE
  pylon [command] [options]

COMMANDS
  chat                          Start or resume a conversation (default)
  doctor                        Run preflight checks
  doctor migrate-secrets        Migrate legacy plaintext API keys into the secrets backend
  doctor prune-secrets          Drop orphaned refs from the secrets store
  config                        Open config in $EDITOR
  conversations                 List saved conversations

PLUGIN COMMANDS
  --plugin install <url-or-json>   Install a community MCP plugin
  --plugin list                    List installed plugins
  --plugin remove <id>             Uninstall a plugin by ID

OPTIONS
  -m, --model         Model name (e.g. llama3.2, qwen2.5-coder:7b)
  -p, --provider      Provider ID from config
  -c, --conversation  Resume conversation by ID
  -t, --theme         Color theme: dark (default) or light
  -P, --project       Project directory to index into context
  -h, --help          Show this help
  -v, --version       Show version
  `);
  process.exit(0);
}

const [subcommand] = positionals;

if (subcommand === 'doctor') {
  // `uplnk doctor migrate-secrets` and `uplnk doctor prune-secrets` are
  // sub-subcommands taken from the next positional. The plain `uplnk doctor`
  // form runs the original 4-check preflight. An UNKNOWN action exits with
  // an explicit error so a typo doesn't silently run the wrong command
  // (e.g. `uplnk doctor purge-secrets` should fail loudly, not run the
  // 4-check preflight and exit 0).
  const action = positionals[1];
  const KNOWN_DOCTOR_ACTIONS = new Set(['migrate-secrets', 'prune-secrets']);
  if (action !== undefined && !KNOWN_DOCTOR_ACTIONS.has(action)) {
    process.stderr.write(
      `uplnk: unknown doctor action '${action}'.\n` +
      `       Valid actions: ${Array.from(KNOWN_DOCTOR_ACTIONS).join(', ')}\n` +
      `       Run 'uplnk doctor' (no arguments) for the standard preflight checks.\n`,
    );
    process.exit(1);
  }
  if (action === 'migrate-secrets') {
    runMigrations();
    const { runMigrateSecrets } = await import('../src/lib/doctor.js');
    await runMigrateSecrets();
    process.exit(0);
  }
  if (action === 'prune-secrets') {
    runMigrations();
    const { runPruneSecrets } = await import('../src/lib/doctor.js');
    await runPruneSecrets();
    process.exit(0);
  }
  const { runDoctor } = await import('../src/lib/doctor.js');
  await runDoctor();
  process.exit(0);
}

// ─── config subcommand ────────────────────────────────────────────────────────
if (subcommand === 'config') {
  if (values['confirm-command-exec'] === true) {
    //: interactive confirmation stamps commandExecConfirmedAt
    // so the runtime knows the user deliberately enabled command execution.
    const { getOrCreateConfig: getConfig, saveConfig } = await import('../src/lib/config.js');
    const cfgResult = getConfig();
    if (!cfgResult.ok) {
      process.stderr.write(
        `\npylon: CONFIG_INVALID — ${cfgResult.error}\n` +
        `Fix or delete ~/.pylon/config.json and try again.\n\n`,
      );
      process.exit(1);
    }
    const cfg = cfgResult.config;
    const confirmedAt = new Date().toISOString();
    const updatedConfig = {
      ...cfg,
      mcp: {
        ...cfg.mcp,
        commandExecEnabled: true,
        commandExecConfirmedAt: confirmedAt,
      },
    };
    saveConfig(updatedConfig);
    process.stdout.write(
      `\npylon: commandExecEnabled confirmed at ${confirmedAt}\n` +
      `Command execution is now enabled.\n\n`,
    );
    process.exit(0);
  }

  // Unknown config flag
  process.stderr.write(
    `uplnk config: unknown option. Available options:\n` +
    `  --confirm-command-exec   Confirm interactive consent for mcp.commandExecEnabled\n`,
  );
  process.exit(1);
}

// ─── Plugin commands (one-shot, no TUI) ──────────────────────────────────────
if (values.plugin !== undefined) {
  const { join } = await import('node:path');
  const { getPylonDir } = await import('uplnk-db');
  const { PluginRegistry, PluginManifestSchema } = await import(
    '../src/lib/plugins/registry.js'
  );

  const pluginsDir = join(getPylonDir(), 'plugins');
  const registry = new PluginRegistry(pluginsDir);
  const pluginAction = values.plugin;
  const [pluginArg] = positionals;

  if (pluginAction === 'list') {
    const installed = registry.list();
    if (installed.length === 0) {
      console.log('No plugins installed.');
    } else {
      console.log(`Installed plugins (${installed.length}):\n`);
      for (const p of installed) {
        console.log(`  ${p.id}@${p.version}  —  ${p.displayName}`);
        console.log(`    ${p.description}`);
        if (p.homepage !== undefined) {
          console.log(`    ${p.homepage}`);
        }
        console.log('');
      }
    }
    process.exit(0);
  }

  if (pluginAction === 'remove') {
    if (pluginArg === undefined) {
      process.stderr.write('Usage: uplnk --plugin remove <id>\n');
      process.exit(1);
    }
    try {
      await registry.uninstall(pluginArg);
      console.log(`Plugin "${pluginArg}" uninstalled.`);
    } catch (err) {
      process.stderr.write(`uplnk: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (pluginAction === 'install') {
    if (pluginArg === undefined) {
      process.stderr.write('Usage: uplnk --plugin install <manifest-url-or-json>\n');
      process.exit(1);
    }

    let rawManifest: unknown;

    // Detect if the argument is a URL or inline JSON
    if (pluginArg.startsWith('http://') || pluginArg.startsWith('https://')) {
      // Fetch manifest from URL
      process.stdout.write(`Fetching manifest from ${pluginArg} ...\n`);
      const { default: https } = await import('node:https');
      const { default: http } = await import('node:http');
      const client = pluginArg.startsWith('https://') ? https : http;
      rawManifest = await new Promise<unknown>((resolve, reject) => {
        client.get(pluginArg, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown);
            } catch (e) {
              reject(new Error(`Failed to parse manifest JSON from URL: ${String(e)}`));
            }
          });
          res.on('error', reject);
        }).on('error', reject);
      });
    } else {
      // Try inline JSON
      try {
        rawManifest = JSON.parse(pluginArg) as unknown;
      } catch {
        process.stderr.write(
          `uplnk: "--plugin install" argument must be a URL or valid JSON manifest.\n`,
        );
        process.exit(1);
      }
    }

    // Validate with Zod before installing
    const parsed = PluginManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      process.stderr.write(
        `uplnk: Invalid plugin manifest:\n` +
        parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n') +
        '\n',
      );
      process.exit(1);
    }

    await registry.install(parsed.data);
    console.log(`Plugin "${parsed.data.id}" (${parsed.data.displayName} v${parsed.data.version}) installed.`);
    process.exit(0);
  }

  process.stderr.write(
    `uplnk: Unknown plugin action "${pluginAction}". Use: install | list | remove\n`,
  );
  process.exit(1);
}

// Apply theme flag before rendering — must happen before config load
// so that UPLNK_THEME is available to the color system at init time.
if (values.theme === 'light') {
  process.env['UPLNK_THEME'] = 'light';
} else if (values.theme === 'dark') {
  process.env['UPLNK_THEME'] = 'dark';
}

// ─── Alternate screen (full-screen TUI mode) ─────────────────────────────────
// Enter the alternate screen buffer so Pylon takes over the terminal without
// touching the user's scroll history. The original content is restored on exit.
// Skipped when stdout is not a TTY (piped output, CI, --version, etc.) — all
// early-exit paths above this point call process.exit() before reaching here.
let altScreenActive = false;

function enterAltScreen(): void {
  if (!process.stdout.isTTY) return;
  altScreenActive = true;
  process.stdout.write('\x1b[?1049h'); // enter alternate screen buffer
  process.stdout.write('\x1b[2J');     // clear screen
  process.stdout.write('\x1b[H');      // move cursor to top-left
}

function exitAltScreen(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  process.stdout.write('\x1b[?1049l'); // exit alternate screen — restores previous content
}

// Always restore on process exit, regardless of how we got here.
process.on('exit', exitAltScreen);

enterAltScreen();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

runMigrations();

// Initialise the secrets backend BEFORE config load, because config load
// runs seedConfigProviders() which may need to resolve `apiKeySecretRef`
// values, and because ChatScreen reads secrets during first render. Backend
// selection order: @napi-rs/keyring → encrypted file → plaintext warning.
const { initSecretsBackend } = await import('../src/lib/secrets.js');
await initSecretsBackend();

// Load config here — before render — so a corrupt config file causes a clean
// exit with a human-readable error rather than a React render crash.
// C4 fix: arch-critical-fixes Phase 1.
const { getOrCreateConfig, maybeAutoEnableRag } = await import('../src/lib/config.js');
const configResult = getOrCreateConfig();
if (configResult.ok) {
  // Auto-detect a local Ollama embedder and turn on RAG without requiring
  // the user to edit config.json. Skipped when `rag.autoDetect=false` or
  // when RAG is already explicitly enabled. Capped at 1.5s — the probe
  // must never block startup measurably.
  const enabled = await maybeAutoEnableRag(configResult.config);
  if (enabled) {
    process.stderr.write(
      `[uplnk] RAG auto-enabled — found ${configResult.config.rag.embed?.model ?? 'embedder'} on local Ollama\n`,
    );
  }
}
if (!configResult.ok) {
  process.stderr.write(
    `\npylon: CONFIG_INVALID — ${configResult.error}\n` +
    `Fix or delete ~/.pylon/config.json and try again.\n\n`,
  );
  process.exit(1);
}

//: warn when commandExecEnabled=true but the user never ran
// uplnk config --confirm-command-exec.  A config file dropped silently (e.g.
// by a malicious package postinstall) must not enable command execution without
// explicit user consent.  The flag is enforced again in useMcp/McpManager, but
// an early stderr warning ensures the user sees it at startup.
if (
  configResult.config.mcp.commandExecEnabled === true &&
  (configResult.config.mcp.commandExecConfirmedAt === undefined ||
    configResult.config.mcp.commandExecConfirmedAt.trim() === '')
) {
  process.stderr.write(
    `WARNING: mcp.commandExecEnabled is set but was not confirmed interactively. ` +
    `Command execution is disabled until you run: uplnk config --confirm-command-exec\n`,
  );
}

// Non-blocking update check — runs in background, prints notice after TUI exits.
// checkForUpdate respects UPLNK_NO_UPDATE=1, CI=true, and the 24h cache.
const updateCheckPromise = import('../src/lib/selfUpdate.js').then(({ checkForUpdate }) =>
  checkForUpdate({
    packageName: configResult.config.updates.packageName,
    enabled: configResult.config.updates.enabled,
  }).catch(() => null),
);

const { waitUntilExit } = render(
  React.createElement(App, {
    ...(values.model !== undefined ? { initialModel: values.model } : {}),
    ...(values.provider !== undefined ? { initialProvider: values.provider } : {}),
    ...(values.conversation !== undefined ? { resumeConversationId: values.conversation } : {}),
    ...(values.theme === 'light' || values.theme === 'dark' ? { theme: values.theme } : {}),
    ...(values.project !== undefined ? { projectDir: values.project } : {}),
    subcommand: subcommand ?? 'chat',
    config: configResult.config,
  }),
  { exitOnCtrlC: false },
);

try {
  await waitUntilExit();
} catch (err) {
  // Ink rejects waitUntilExit when its internal error boundary catches a
  // React render error. The error has already been displayed via Ink's
  // ErrorOverview. Write it to the crash log (same private path as the
  // uncaught handlers above), surface the path to stderr, and exit.
  const stamp = new Date().toISOString();
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    appendFileSync(CRASH_LOG_PATH, `\n--- RENDER ${stamp} ---\n${msg}\n`, { mode: 0o600 });
  } catch { /* swallow */ }
  process.stderr.write(`\npylon crashed — see ${CRASH_LOG_PATH}\n`);
  process.exit(1);
}

// Restore the terminal before printing anything post-exit so the update notice
// appears in the normal scroll buffer, not the alternate screen.
exitAltScreen();

// Print update notice after TUI exits (doesn't interrupt the session).
const updateResult = await updateCheckPromise;
if (updateResult?.updateAvailable) {
  process.stdout.write(
    `\n  pylon ${updateResult.latestVersion} is available (you have ${updateResult.currentVersion}).\n` +
    `  Run: ${updateResult.updateCommand}\n\n`,
  );
}

process.exit(0);
