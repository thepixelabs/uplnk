import { describe, it, expect } from 'vitest';
import {
  getBandwidthGBs,
  listBandwidthEntries,
} from '../bandwidthTable.js';
import {
  bytesPerParam,
  isCudaOnlyQuant,
  isGgufQuant,
  listQuantEntries,
} from '../quantTable.js';
import type { Quant } from '../types.js';

describe('bandwidthTable', () => {
  it('contains entries with non-zero bandwidth values', () => {
    const entries = listBandwidthEntries();
    expect(entries.length).toBeGreaterThanOrEqual(20);
    for (const [key, value] of entries) {
      expect(key.length).toBeGreaterThan(0);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('looks up RTX 4090 by full nvidia-smi-style name', () => {
    expect(getBandwidthGBs('NVIDIA GeForce RTX 4090')).toBe(1008);
  });

  it('looks up M4 Max via Apple CPU brand string', () => {
    expect(getBandwidthGBs('Apple M4 Max')).toBe(546);
  });

  it('looks up MI300X via probed device name', () => {
    expect(getBandwidthGBs('AMD Instinct MI300X')).toBe(5300);
  });

  it('returns undefined for an unknown chip', () => {
    expect(getBandwidthGBs('Voodoo3 3000')).toBeUndefined();
  });

  it('is case-insensitive on the input', () => {
    expect(getBandwidthGBs('rtx 5090')).toBe(1792);
    expect(getBandwidthGBs('RTX 5090')).toBe(1792);
  });
});

describe('quantTable', () => {
  it('has fp16 at exactly 2 bytes per param', () => {
    expect(bytesPerParam('fp16')).toBe(2);
  });

  it('has fp32 at exactly 4 bytes per param', () => {
    expect(bytesPerParam('fp32')).toBe(4);
  });

  it('has q4_k_m roughly 0.57 bytes per param', () => {
    expect(bytesPerParam('q4_k_m')).toBeCloseTo(0.57, 2);
  });

  it('covers every Quant enum member', () => {
    const expected: Quant[] = [
      'fp32', 'fp16', 'bf16', 'fp8',
      'q8_0', 'q6_k', 'q5_k_m', 'q5_k_s', 'q4_k_m', 'q4_k_s', 'q4_0', 'q3_k_m', 'q2_k',
      'awq', 'gptq', 'unknown',
    ];
    const entries = listQuantEntries();
    const present = new Set(entries.map(([k]) => k));
    for (const q of expected) {
      expect(present.has(q)).toBe(true);
    }
    expect(entries.length).toBe(expected.length);
  });

  it('classifies q4_k_m as GGUF', () => {
    expect(isGgufQuant('q4_k_m')).toBe(true);
    expect(isGgufQuant('q8_0')).toBe(true);
  });

  it('classifies AWQ / GPTQ / fp8 as CUDA-only', () => {
    expect(isCudaOnlyQuant('awq')).toBe(true);
    expect(isCudaOnlyQuant('gptq')).toBe(true);
    expect(isCudaOnlyQuant('fp8')).toBe(true);
  });

  it('classifies GGUF quants as NOT CUDA-only', () => {
    expect(isCudaOnlyQuant('q4_k_m')).toBe(false);
    expect(isCudaOnlyQuant('q3_k_m')).toBe(false);
  });

  it('uses 0.6 conservative default for unknown', () => {
    expect(bytesPerParam('unknown')).toBe(0.6);
  });
});
