import type { ProviderKind } from './types.js';

export type ProviderErrorCode =
  | 'UNREACHABLE'
  | 'AUTH_FAILED'
  | 'NOT_SUPPORTED'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'SERVER_ERROR'
  | 'TIMEOUT';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderKind;
  readonly cause?: unknown;

  constructor(
    code: ProviderErrorCode,
    provider: ProviderKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    if (cause !== undefined) this.cause = cause;
  }

  /** Human-friendly one-liner for the TUI. */
  get userMessage(): string {
    switch (this.code) {
      case 'UNREACHABLE':
        return `Can't reach server — check the URL and network`;
      case 'AUTH_FAILED':
        return `Authentication failed — check your API key`;
      case 'NOT_SUPPORTED':
        return `Server does not expose a model list`;
      case 'RATE_LIMITED':
        return `Rate limited by provider — try again in a moment`;
      case 'BAD_RESPONSE':
        return `Server responded with unexpected data`;
      case 'SERVER_ERROR':
        return `Server error — try again`;
      case 'TIMEOUT':
        return `Request timed out`;
    }
  }
}
