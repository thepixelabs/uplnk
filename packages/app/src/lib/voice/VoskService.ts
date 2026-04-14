import { Model, Recognizer, RecognitionResults } from 'vosk-koffi';
import record from 'node-record-lpcm16';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';

export interface VoiceResult {
  text: string;
}

export interface PartialVoiceResult {
  partial: string;
}

export class VoskService extends EventEmitter {
  private model: Model | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognizer: Recognizer<any> | null = null;
  private micStream: import('stream').Readable | null = null;
  private isListening = false;
  private modelPath: string;

  constructor() {
    super();
    // Default model path in user's home directory to keep the project light
    this.modelPath = path.join(os.homedir(), '.uplnk', 'models', 'vosk-model-small-en-us');
  }

  async initialize() {
    if (this.model) return;

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Vosk model not found at ${this.modelPath}. Please run the model downloader first.`);
    }

    try {
      this.model = new Model(this.modelPath);
      this.recognizer = new Recognizer({ model: this.model, sampleRate: 16000 });
    } catch (error) {
      console.error('Failed to initialize Vosk:', error);
      throw error;
    }
  }

  startListening() {
    if (this.isListening || !this.recognizer) return;

    this.isListening = true;
    try {
      this.micStream = record.record({
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
            const result = this.recognizer.result() as { alternatives: RecognitionResults[] };
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
