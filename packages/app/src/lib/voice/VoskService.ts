// Voice service — uses vosk-koffi (FFI) + node-record-lpcm16 (sox subprocess).
// Both native deps are loaded LAZILY because:
//   1. They are not supported under the Bun runtime (koffi has no Bun FFI port).
//      A static import would crash app startup on every Bun launch even when
//      voice is disabled.
//   2. They are an opt-in feature; users who never enable voice should not pay
//      the load cost or hit a "missing native binary" error at app startup.
// The Bun guard in initialize() throws a typed UplnkError before any native
// import is attempted, so the user sees a clear "voice not supported on Bun"
// message instead of a koffi/dlopen stack trace.

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { UplnkError } from '@uplnk/shared';

// Type-only imports — erased at compile, no runtime resolution.
type VoskModule = typeof import('vosk-koffi');
// node-record-lpcm16 only ships a default export; ESM type interop is awkward,
// so type the dynamic-import shape we actually use rather than the package's
// declared types (which assume CJS interop).
type RecordModule = {
  record: (opts: {
    sampleRate?: number;
    threshold?: number;
    verbose?: boolean;
    recordProgram?: string;
  }) => { stream: () => unknown };
};

export interface VoiceResult {
  text: string;
}

export interface PartialVoiceResult {
  partial: string;
}

export class VoskService extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognizer: any = null;
  private micStream: import('stream').Readable | null = null;
  private isListening = false;
  private modelPath: string;
  private vosk: VoskModule | null = null;
  private record: RecordModule | null = null;

  constructor() {
    super();
    this.modelPath = path.join(os.homedir(), '.uplnk', 'models', 'vosk-model-small-en-us');
  }

  async initialize() {
    if (this.model) return;

    if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
      const err: UplnkError = {
        code: 'VOICE_UNSUPPORTED_ON_BUN',
        message: 'Voice input is not supported under the Bun runtime yet.',
        hint: 'Voice features rely on vosk-koffi (FFI) which is not yet ported to Bun. Disable voice in config to silence this error.',
      };
      throw err;
    }

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Vosk model not found at ${this.modelPath}. Please run the model downloader first.`);
    }

    try {
      this.vosk = await import('vosk-koffi');
      const recordMod = (await import('node-record-lpcm16')) as { default: RecordModule } & RecordModule;
      this.record = recordMod.default ?? recordMod;
      this.model = new this.vosk.Model(this.modelPath);
      this.recognizer = new this.vosk.Recognizer({ model: this.model, sampleRate: 16000 });
    } catch (error) {
      console.error('Failed to initialize Vosk:', error);
      throw error;
    }
  }

  startListening() {
    if (this.isListening || !this.recognizer || !this.record) return;

    this.isListening = true;
    try {
      this.micStream = this.record.record({
        sampleRate: 16000,
        threshold: 0,
        verbose: false,
        recordProgram: 'sox',
      }).stream() as unknown as import('stream').Readable;

      const mic = this.micStream;
      mic.on('data', (data: Buffer) => {
        try {
          if (!this.recognizer) return;

          if (this.recognizer.acceptWaveform(data)) {
            const result = this.recognizer.result() as { alternatives: { text: string }[] };
            const text = result.alternatives[0]?.text;
            if (text) {
              this.emit('finalResult', text);
            }
          } else {
            const partial = this.recognizer.partialResult();
            if (partial?.partial) {
              this.emit('partialResult', partial.partial);
            }
          }
        } catch {
          // Silent catch for individual waveform errors
        }
      });

      mic.on('error', (err: Error) => {
        this.emit('error', err);
        this.stopListening();
      });
    } catch {
      this.isListening = false;
    }
  }

  stopListening() {
    if (!this.isListening) return;

    if (this.micStream) {
      this.micStream.destroy();
      this.micStream = null;
    }
    this.isListening = false;
  }

  destroy() {
    this.stopListening();
    if (this.recognizer) {
      this.recognizer.free();
      this.recognizer = null;
    }
    if (this.model) {
      this.model.free();
      this.model = null;
    }
  }
}

export const voskService = new VoskService();
