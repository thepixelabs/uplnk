/**
 * headless research command — multi-round deep research on a topic.
 *
 *   uplnk research "<topic>" [--provider id] [--model id]
 *
 * Drives the Plan → Search → Extract → Synthesize → Stop generator in
 * lib/deepResearch/runner.ts. Phase progress lines go to stderr; the final
 * synthesized Markdown report goes to stdout, so
 * `uplnk research "x" > report.md` stays clean while progress stays visible.
 * SIGINT aborts the run (mirrors flow.ts).
 *
 * Provider/model resolution mirrors ask.ts:
 *   provider: --provider flag → config.headless.defaultProvider → DB default
 *   model:    --model flag → config.headless.defaultModel → provider default
 *
 * Search backends come from `config.search` (Tavily / Brave / DuckDuckGo
 * fallback chain — see lib/search/fromConfig.ts). With no search provider
 * configured the command fails fast, naming the config keys to set.
 */

import { db, getDefaultProvider, getProviderById } from '@uplnk/db';
import { getOrCreateConfig } from '../../lib/config.js';
import { createLanguageModel } from '../../lib/languageModelFactory.js';
import { resolveSecret } from '../../lib/secrets.js';
import { buildSearchProviderFromConfig } from '../../lib/search/fromConfig.js';
import { runResearch } from '../../lib/deepResearch/runner.js';
import type { ResearchEvent } from '../../lib/deepResearch/runner.js';

// ── Public interface ──────────────────────────────────────────────────────────

export interface ResearchCommandOptions {
  topic: string;
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runResearchCommand(options: ResearchCommandOptions): Promise<void> {
  // ── Config ────────────────────────────────────────────────────────────────
  const configResult = getOrCreateConfig();
  if (!configResult.ok) {
    process.stderr.write(`uplnk research: config error — ${configResult.error}\n`);
    process.exit(1);
  }
  const config = configResult.config;

  // ── Provider resolution (mirrors ask.ts) ──────────────────────────────────
  const providerId = options.provider ?? config.headless.defaultProvider;
  const providerRow = providerId !== undefined
    ? getProviderById(db, providerId)
    : getDefaultProvider(db);

  if (providerRow === undefined) {
    process.stderr.write(
      'uplnk research: no provider configured. Add one via `uplnk` TUI or config.json.\n',
    );
    process.exit(1);
  }

  // ── Model resolution ──────────────────────────────────────────────────────
  const modelId =
    options.model ??
    config.headless.defaultModel ??
    providerRow.defaultModel ??
    'qwen2.5:7b';

  const apiKey = resolveSecret(providerRow.apiKey) ?? 'ollama';
  const languageModel = createLanguageModel({
    providerType: providerRow.providerType,
    baseURL: providerRow.baseUrl,
    apiKey,
    modelId,
  });

  // ── Search provider — fail fast, naming the config keys ──────────────────
  const searchResult = buildSearchProviderFromConfig(config.search);
  if (!searchResult.ok) {
    process.stderr.write(`uplnk research: ${searchResult.error}\n`);
    process.exit(1);
  }

  // ── SIGINT → abort ────────────────────────────────────────────────────────
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

  process.stderr.write(
    `Researching: ${options.topic}\n` +
    `  model: ${modelId}  ·  search: ${searchResult.chain.join(' → ')}\n`,
  );

  let report: string | null = null;
  try {
    const gen = runResearch({
      query: options.topic,
      model: languageModel,
      search: searchResult.provider,
      signal: controller.signal,
    });

    for await (const ev of gen) {
      renderEvent(ev);
      if (ev.type === 'final:done') report = ev.report;
    }

    if (report === null || report.trim() === '') {
      process.stderr.write('uplnk research: no report produced\n');
      process.exit(1);
    }

    // Final report — the ONLY thing written to stdout.
    process.stdout.write(report.endsWith('\n') ? report : `${report}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const verb = controller.signal.aborted ? 'cancelled' : 'failed';
    process.stderr.write(`\nuplnk research: ${verb} — ${msg}\n`);
    process.exit(1);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

// ── Event rendering (stderr) ──────────────────────────────────────────────────

/**
 * Phase progress → stderr. `final:delta` is intentionally NOT streamed to
 * stdout: the runner may quietly replace a too-short report in its one-shot
 * expansion pass, so `final:done.report` is the only authoritative text.
 */
function renderEvent(ev: ResearchEvent): void {
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  switch (ev.type) {
    case 'plan:start':
      err('→ planning research…');
      break;
    case 'plan:done':
      err(`✓ plan ready (category: ${ev.category})`);
      for (const line of ev.planSummary.split('\n')) err(`    ${line}`);
      break;
    case 'round:start':
      err(`→ round ${ev.round} — ${ev.queries.length} ${ev.queries.length === 1 ? 'query' : 'queries'}`);
      for (const q of ev.queries) err(`    · ${q}`);
      break;
    case 'search:result':
      err(`    ${ev.resultCount} result(s) for "${ev.query}"`);
      break;
    case 'extract:start':
      break; // start/done pairs would double the noise — done is enough
    case 'extract:done':
      err(`    extracted ${ev.sourceUrl} (confidence ${ev.confidence.toFixed(2)})`);
      break;
    case 'synthesize:start':
      err(`    synthesizing round ${ev.round}…`);
      break;
    case 'synthesize:done':
      err(`    report at ${ev.reportLength} chars`);
      break;
    case 'stop:check':
      err(`    stop check: ${ev.verdict.stop ? 'stop' : 'continue'} — ${ev.verdict.reason}`);
      break;
    case 'round:end':
      err(`✓ round ${ev.round} done — ${ev.newFindingsCount} new finding(s) in ${(ev.durationMs / 1000).toFixed(1)}s`);
      break;
    case 'final:start':
      err('→ writing final report…');
      break;
    case 'final:delta':
      break;
    case 'final:done':
      err(`✓ done — ${ev.sources.length} source(s), ${(ev.durationMs / 1000).toFixed(1)}s total\n`);
      break;
    case 'error':
      err(`⚠ [${ev.phase}] ${ev.message}`);
      break;
    case 'aborted':
      err(`✗ aborted (${ev.reason})`);
      break;
    default:
      break;
  }
}
