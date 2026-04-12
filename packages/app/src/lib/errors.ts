import type { UplnkError, UplnkErrorCode } from 'uplnk-shared';

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
    'Database is busy. Close any other Uplnk instances and try again.',
  DB_MIGRATION_FAILED:
    'Database migration failed. Run `uplnk doctor` or delete ~/.uplnk/db.sqlite to reset.',
  CONFIG_INVALID:
    'Config file is invalid. Run `uplnk config` to edit it or delete ~/.uplnk/config.json to reset.',
  CONFIG_NOT_FOUND:
    'No config found. Run `uplnk` and follow the setup prompts.',
};

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

  // Try to infer code from error message patterns
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
