export type RelayErrorCode =
  | 'RELAY_PROVIDER_NOT_FOUND' // providerId in relay file not in DB
  | 'RELAY_SCOUT_FAILED' // Phase 1 stream error
  | 'RELAY_ANCHOR_FAILED' // Phase 2 stream error
  | 'RELAY_FILE_NOT_FOUND' // relay JSON file missing
  | 'RELAY_FILE_INVALID' // Zod validation failed
  | 'RELAY_ABORTED'; // user cancelled

export class RelayError extends Error {
  code: RelayErrorCode;
  phase?: 'scout' | 'anchor' | undefined;

  constructor(code: RelayErrorCode, message: string, phase?: 'scout' | 'anchor') {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    if (phase !== undefined) {
      this.phase = phase;
    }
  }
}
