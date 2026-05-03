import type { UplnkError, UplnkErrorCode } from '@uplnk/shared';

const HINTS: Record<UplnkErrorCode, string> = {
  PROVIDER_UNREACHABLE:
    'Check that Ollama is running: `ollama serve`. Run `uplnk doctor` for a full diagnosis.',
  PROVIDER_AUTH_FAILED:
    'Check your API key in ~/.uplnk/config.json or run `uplnk config`.',
  MODEL_NOT_FOUND:
    'Run `ollama list` to see available models. Pull one with `ollama pull <model>`.',
  PROVIDER_RATE_LIMITED: 'Request was rate-limited. Wait a moment and try again.',
  STREAM_INTERRUPTED:
    'The stream was interrupted. Press Ctrl+R to retry or Ctrl+N for a new conversation.',
  STREAM_TIMEOUT:
    'The model took too long to respond. It may be loading — try again in a few seconds.',
  STREAM_INVALID_RESPONSE:
    'Unexpected response from the provider. Check provider compatibility in the docs.',
  MCP_PROCESS_FAILED:
    'An MCP tool server crashed. Check `uplnk doctor` for details.',
  MCP_TOOL_DENIED:
    'Tool call was blocked by the security policy. Review security.pathAllowlist in ~/.uplnk/config.json.',
  MCP_TOOL_LOOP_LIMIT:
    'The model called tools too many times in a row. Simplify your request.',
  SQLITE_BUSY:
    'Database is busy. Close any other uplnk instances and try again.',
  DB_MIGRATION_FAILED:
    'Database migration failed. Run `uplnk doctor` or delete ~/.uplnk/db.sqlite to reset.',
  CONFIG_INVALID:
    'Config file is invalid. Run `uplnk config` to edit it or delete ~/.uplnk/config.json to reset.',
  CONFIG_NOT_FOUND:
    'No config found. Run `uplnk` and follow the setup prompts.',
  VOICE_UNSUPPORTED_ON_BUN:
    'Voice input is not yet supported under the Bun runtime. Disable voice in ~/.uplnk/config.json (`voice.enabled = false`).',
};

// Minimal structural view of @ai-sdk/provider's APICallError. We duck-type
// instead of importing to avoid coupling this module to the SDK's error
// class (which also keeps the error-mapping cheap to unit-test).
interface ApiCallErrorLike {
  name: string;
  message: string;
  statusCode?: number;
  url?: string;
  cause?: unknown;
}

function isApiCallError(err: unknown): err is ApiCallErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'AI_APICallError'
  );
}

// Walk an error's `cause` chain looking for a Node system error code (e.g.
// ECONNREFUSED emitted by undici). The AI SDK wraps `TypeError: fetch failed`
// into an `APICallError` whose message starts with "Cannot connect to API: …"
// and whose `cause` is the original undici error — so to classify reliably we
// need to inspect the cause, not the outer message.
function findSystemErrorCode(err: unknown, depth = 0): string | undefined {
  if (depth > 5 || typeof err !== 'object' || err === null) return undefined;
  const maybeCode = (err as { code?: unknown }).code;
  if (typeof maybeCode === 'string') return maybeCode;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) return findSystemErrorCode(cause, depth + 1);
  return undefined;
}

export function toUplnkError(err: unknown): UplnkError {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    'hint' in err
  ) {
    return err as UplnkError;
  }

  const message = err instanceof Error ? err.message : String(err);

  // Prefer structural classification on AI SDK APICallError when available:
  // statusCode is authoritative and cause carries the underlying network
  // error from undici (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, …).
  if (isApiCallError(err)) {
    const sysCode = findSystemErrorCode(err);
    if (
      sysCode === 'ECONNREFUSED' ||
      sysCode === 'ENOTFOUND' ||
      sysCode === 'ECONNRESET' ||
      sysCode === 'EHOSTUNREACH' ||
      sysCode === 'ENETUNREACH'
    ) {
      return { code: 'PROVIDER_UNREACHABLE', message, hint: HINTS.PROVIDER_UNREACHABLE, cause: err };
    }
    if (sysCode === 'ETIMEDOUT' || sysCode === 'UND_ERR_CONNECT_TIMEOUT') {
      return { code: 'STREAM_TIMEOUT', message, hint: HINTS.STREAM_TIMEOUT, cause: err };
    }
    const status = err.statusCode;
    if (status === 401 || status === 403) {
      return { code: 'PROVIDER_AUTH_FAILED', message, hint: HINTS.PROVIDER_AUTH_FAILED, cause: err };
    }
    if (status === 404) {
      return { code: 'MODEL_NOT_FOUND', message, hint: HINTS.MODEL_NOT_FOUND, cause: err };
    }
    if (status === 429) {
      return { code: 'PROVIDER_RATE_LIMITED', message, hint: HINTS.PROVIDER_RATE_LIMITED, cause: err };
    }
    // Fall through to message-pattern matching for unknown APICallErrors.
  }

  // Fallback: inspect the stringified message. Covers plain Error objects
  // thrown outside the SDK layer (e.g. JSON parse failures, custom throws).
  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
    return { code: 'PROVIDER_UNREACHABLE', message, hint: HINTS.PROVIDER_UNREACHABLE, cause: err };
  }
  if (message.includes('401') || message.includes('403')) {
    return { code: 'PROVIDER_AUTH_FAILED', message, hint: HINTS.PROVIDER_AUTH_FAILED, cause: err };
  }
  if (message.includes('404') || message.includes('model not found')) {
    return { code: 'MODEL_NOT_FOUND', message, hint: HINTS.MODEL_NOT_FOUND, cause: err };
  }
  if (message.includes('TOOL_DENIED')) {
    return { code: 'MCP_TOOL_DENIED', message, hint: HINTS.MCP_TOOL_DENIED, cause: err };
  }

  return {
    code: 'STREAM_INTERRUPTED',
    message,
    hint: HINTS.STREAM_INTERRUPTED,
    cause: err,
  };
}
