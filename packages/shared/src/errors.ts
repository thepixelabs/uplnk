import { z } from 'zod';

export const UplnkErrorCodeSchema = z.enum([
  // Provider errors
  'PROVIDER_UNREACHABLE',
  'PROVIDER_AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'PROVIDER_RATE_LIMITED',
  // Stream errors
  'STREAM_INTERRUPTED',
  'STREAM_TIMEOUT',
  'STREAM_INVALID_RESPONSE',
  // MCP errors
  'MCP_PROCESS_FAILED',
  'MCP_TOOL_DENIED',
  'MCP_TOOL_LOOP_LIMIT',
  // DB errors
  'SQLITE_BUSY',
  'DB_MIGRATION_FAILED',
  // Config errors
  'CONFIG_INVALID',
  'CONFIG_NOT_FOUND',
]);

export type UplnkErrorCode = z.infer<typeof UplnkErrorCodeSchema>;

export interface UplnkError {
  code: UplnkErrorCode;
  message: string;
  /** User-facing recovery hint shown in the ErrorBanner */
  hint: string;
  cause?: unknown;
}

export function isUplnkError(value: unknown): value is UplnkError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'hint' in value
  );
}
