export interface RedactorOptions {
  /**
   * Regex patterns matched against env var KEY names.
   * Any env var whose key matches a pattern will have its VALUE redacted
   * from any text passing through scrub().
   */
  envPatterns: string[];
  /**
   * Additional verbatim regex patterns applied to the text itself
   * (e.g. to redact specific token formats regardless of env var names).
   */
  customPatterns: string[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redactor — scrubs secrets from text before injection into target CLIs.
 *
 * Two layers:
 *  1. Env-var scrubbing: any env var whose KEY matches an envPattern has
 *     its VALUE redacted wherever it appears in the text.
 *  2. Custom pattern scrubbing: extra regexes supplied directly by the user.
 *
 * Values shorter than 8 chars are skipped — too many false positives (port
 * numbers, common words, etc. can be 1-7 chars and live in env vars).
 */
export class Redactor {
  private patterns: RegExp[];

  constructor(opts: RedactorOptions) {
    this.patterns = this.buildPatterns(opts);
  }

  private buildPatterns(opts: RedactorOptions): RegExp[] {
    const patterns: RegExp[] = [];

    // Compile key-name patterns once so we don't recompile per env var
    const keyMatchers = opts.envPatterns.map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    }).filter((r): r is RegExp => r !== null);

    for (const [key, value] of Object.entries(process.env)) {
      if (!value || value.length < 8) continue;
      const isSensitive = keyMatchers.some((re) => re.test(key));
      if (isSensitive) {
        patterns.push(new RegExp(escapeRegex(value), 'g'));
      }
    }

    for (const p of opts.customPatterns) {
      try {
        patterns.push(new RegExp(p, 'gi'));
      } catch {
        // Skip invalid patterns silently — user-supplied, may be malformed
      }
    }

    return patterns;
  }

  /**
   * Return a copy of text with all sensitive values replaced by [REDACTED].
   */
  scrub(text: string): string {
    let result = text;
    for (const pattern of this.patterns) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
}
