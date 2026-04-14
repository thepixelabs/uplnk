declare module 'node-record-lpcm16' {
  export interface RecordOptions {
    sampleRate?: number;
    threshold?: number;
    thresholdStart?: number | null;
    thresholdEnd?: number | null;
    silence?: string;
    verbose?: boolean;
    recordProgram?: 'rec' | 'sox' | 'arecord';
    device?: string | null;
  }

  export interface Recording {
    stop(): void;
    pause(): void;
    resume(): void;
    stream(): NodeJS.ReadableStream;
  }

  export function record(options?: RecordOptions): Recording;
}
