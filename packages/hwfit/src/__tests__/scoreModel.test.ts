import { describe, it, expect } from 'vitest';
import { scoreModel } from '../scoreModel.js';
import type { HardwareProfile, ModelFitInput } from '../types.js';

const GB = 1024 ** 3;

/** Synthetic HardwareProfile builder. */
function hw(opts: Partial<HardwareProfile> & { osHint?: HardwareProfile['os'] } = {}): HardwareProfile {
  return {
    os: opts.osHint ?? opts.os ?? 'linux',
    gpus: opts.gpus ?? [],
    systemRamBytes: opts.systemRamBytes ?? 64 * GB,
    cpu: opts.cpu ?? 'Test CPU',
    hints: opts.hints ?? { unifiedMemory: false, ggufOnly: false },
    diagnostics: opts.diagnostics ?? [],
  };
}

describe('scoreModel — fit classification', () => {
  it('7B Q4_K_M at 2k ctx fits a 24GB GPU as "gpu"', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'q4_k_m',
      contextLength: 2048,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
      systemRamBytes: 64 * GB,
    });

    const score = scoreModel(input, profile);

    expect(score.fitLevel).toBe('gpu');
    expect(score.memoryRequiredBytes).toBeGreaterThan(0);
    expect(score.vramHeadroomBytes).toBeGreaterThan(0);
    expect(score.subScores.vramFit).toBeGreaterThan(20);
    expect(score.estimatedTps).toBeDefined();
    expect(score.estimatedTps!).toBeGreaterThan(10);
  });

  it('70B Q4_K_M on 24GB GPU + 128GB RAM falls back to cpu-offload', () => {
    const input: ModelFitInput = {
      parametersB: 70,
      quant: 'q4_k_m',
      contextLength: 512,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
      systemRamBytes: 128 * GB,
    });

    const score = scoreModel(input, profile);

    // Per spec: cpu-offload OR too-tight depending on system RAM.
    // 128 GB RAM > ~73 GB required → cpu-offload.
    expect(score.fitLevel).toBe('cpu-offload');
    expect(score.vramHeadroomBytes).toBeLessThan(0);
    expect(score.subScores.vramFit).toBe(0);
  });

  it('70B Q4_K_M on 24GB GPU + 32GB RAM is too-tight', () => {
    const input: ModelFitInput = {
      parametersB: 70,
      quant: 'q4_k_m',
      contextLength: 1024,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
      systemRamBytes: 32 * GB,
    });

    const score = scoreModel(input, profile);
    expect(score.fitLevel).toBe('too-tight');
  });

  it('AWQ on Apple Silicon is incompatible (ggufOnly hint set)', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'awq',
      contextLength: 2048,
    };
    const profile = hw({
      osHint: 'macos',
      gpus: [{
        vendor: 'apple',
        name: 'Apple M3 Max',
        vramBytes: 24 * GB,
        bandwidthGBs: 400,
      }],
      systemRamBytes: 36 * GB,
      hints: { unifiedMemory: true, ggufOnly: true },
    });

    const score = scoreModel(input, profile);
    expect(score.fitLevel).toBe('incompatible');
    expect(score.notes.join(' ')).toMatch(/CUDA|GGUF/i);
  });

  it('contextFit caps at 50 for a 128k context window', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'q4_k_m',
      contextLength: 128_000,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
    });

    const score = scoreModel(input, profile);
    expect(score.subScores.contextFit).toBeLessThanOrEqual(50);
    expect(score.subScores.contextFit).toBeGreaterThanOrEqual(0);
  });

  it('contextFit is 100 for context <= 32k', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'q4_k_m',
      contextLength: 8192,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
    });

    const score = scoreModel(input, profile);
    expect(score.subScores.contextFit).toBe(100);
  });

  it('no GPU + small GGUF model → cpu-only', () => {
    const input: ModelFitInput = {
      parametersB: 3,
      quant: 'q4_k_m',
      contextLength: 1024,
    };
    const profile = hw({
      gpus: [],
      systemRamBytes: 16 * GB,
    });

    const score = scoreModel(input, profile);
    expect(score.fitLevel).toBe('cpu-only');
    expect(score.estimatedTps).toBeDefined();
  });

  it('no GPU + large model → too-tight', () => {
    const input: ModelFitInput = {
      parametersB: 13,
      quant: 'q4_k_m',
      contextLength: 4096,
    };
    const profile = hw({
      gpus: [],
      systemRamBytes: 16 * GB,
    });

    const score = scoreModel(input, profile);
    expect(score.fitLevel).toBe('too-tight');
  });

  it('picks the largest GPU as primary in multi-GPU rigs', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'q4_k_m',
      contextLength: 1024,
    };
    const profile = hw({
      gpus: [
        { vendor: 'nvidia', name: 'NVIDIA RTX 3080', vramBytes: 10 * GB, bandwidthGBs: 760 },
        { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramBytes: 24 * GB, bandwidthGBs: 1008 },
      ],
    });

    const score = scoreModel(input, profile);
    expect(score.fitLevel).toBe('gpu');
    // vramHeadroom should reflect the 24GB card, not the 10GB one.
    expect(score.vramHeadroomBytes).toBeGreaterThan(0);
  });

  it('reports vramHeadroom as negative when over budget', () => {
    const input: ModelFitInput = {
      parametersB: 70,
      quant: 'fp16',
      contextLength: 8192,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
      systemRamBytes: 128 * GB,
    });

    const score = scoreModel(input, profile);
    expect(score.vramHeadroomBytes).toBeLessThan(0);
  });

  it('omits estimatedTps when GPU bandwidth is unknown', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'q4_k_m',
      contextLength: 1024,
    };
    const profile = hw({
      gpus: [{
        vendor: 'unknown',
        name: 'Mystery GPU',
        vramBytes: 16 * GB,
      }],
    });

    const score = scoreModel(input, profile);
    expect(score.fitLevel).toBe('gpu');
    expect(score.estimatedTps).toBeUndefined();
    expect(score.subScores.speed).toBe(0);
  });

  it('returns notes containing the memory requirement summary on gpu fit', () => {
    const input: ModelFitInput = {
      parametersB: 7,
      quant: 'q4_k_m',
      contextLength: 1024,
    };
    const profile = hw({
      gpus: [{
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24 * GB,
        bandwidthGBs: 1008,
      }],
    });
    const score = scoreModel(input, profile);
    expect(score.notes.length).toBeGreaterThan(0);
    expect(score.notes.join(' ')).toMatch(/Needs/);
  });
});
