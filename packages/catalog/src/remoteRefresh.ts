import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CatalogEntry } from './types.js';

const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

// Model name patterns that indicate cloud/API-backed models (require an Ollama account/plan).
// Local open-weight models (llama, qwen, gemma, deepseek, phi, mistral-7B, etc.) are not listed here.
const CLOUD_NAME_PATTERNS: RegExp[] = [
  /^gemini/,           // Google Gemini via Ollama cloud
  /^gpt-/,             // OpenAI via Ollama cloud
  /^minimax/,          // MiniMax
  /^kimi/,             // Kimi / Moonshot
  /^magistral$/,       // Mistral commercial
  /^mistral-large/,    // Mistral commercial
  /^mistral-medium/,   // Mistral commercial
  /^codestral$/,       // Mistral commercial
  /^devstral/,         // Mistral DevStral (cloud-hosted)
  /^command-/,         // Cohere Command family
  /^lfm2/,             // Liquid AI
];

function isCloudModel(name: string): boolean {
  return CLOUD_NAME_PATTERNS.some((p) => p.test(name));
}

// Best-effort family inference from the model name.
function inferFamily(name: string): string | undefined {
  if (/^llama/.test(name)) return 'llama';
  if (/^qwen/.test(name)) return 'qwen';
  if (/^gemma/.test(name)) return 'gemma';
  if (/^gemini/.test(name)) return 'gemini';
  if (/^mistral|^mixtral/.test(name)) return 'mistral';
  if (/^deepseek/.test(name)) return 'deepseek';
  if (/^phi/.test(name)) return 'phi';
  if (/^falcon/.test(name)) return 'falcon';
  if (/^dolphin/.test(name)) return 'dolphin';
  if (/^granite/.test(name)) return 'granite';
  if (/^minimax/.test(name)) return 'minimax';
  if (/^kimi/.test(name)) return 'kimi';
  if (/^glm/.test(name)) return 'glm';
  if (/^command/.test(name)) return 'cohere';
  if (/embed|nomic|bge|mxbai/.test(name)) return 'embed';
  return undefined;
}

/**
 * Fetch the Ollama model library page, extract model family names via href
 * parsing, and write a CatalogEntry[] to catalogPath.
 *
 * The library page at ollama.com/library is server-side rendered and contains
 * /library/<name> links for each available model family.
 */
export async function refreshCatalogFromRemote(
  catalogPath: string,
  signal?: AbortSignal,
): Promise<CatalogEntry[]> {
  const res = await fetch(OLLAMA_LIBRARY_URL, signal !== undefined ? { signal } : undefined);
  if (!res.ok) throw new Error(`ollama.com/library fetch failed: HTTP ${String(res.status)}`);

  const html = await res.text();

  // Extract unique model names from href="/library/<name>" (no sub-paths).
  // Matches single or double-quoted attributes; stops at the next quote or /.
  const seen = new Set<string>();
  const re = /href=['"]\/library\/([\w.-]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = m[1];
    if (name) seen.add(name);
  }

  const entries: CatalogEntry[] = Array.from(seen).map((name) => {
    const family = inferFamily(name);
    const cloud = isCloudModel(name);
    return {
      canonicalKey: `ollama/${name}`,
      displayId: name,
      kind: 'ollama' as const,
      ...(family !== undefined && { family }),
      ...(cloud && { isCloud: true }),
    };
  });

  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, JSON.stringify(entries, null, 2), 'utf-8');

  return entries;
}
