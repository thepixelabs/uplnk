/**
 * Bytes-per-parameter table for the quantization formats uplnk's catalog
 * tracks.
 *
 * Values are *typical GGUF blob sizes* for llama-family architectures
 * (Llama 2/3, Mistral, Qwen, Gemma). Non-llama architectures may diverge
 * by up to ~10% depending on attention shape and tied embeddings, but the
 * ordering and the fit-vs-overflow decision stay correct.
 *
 * Sources:
 *   - llama.cpp k-quant whitepaper / `k_quants.h` block constants
 *     (https://github.com/ggerganov/llama.cpp).
 *   - Hugging Face TheBloke / bartowski model card empirical blob sizes
 *     for Llama-3-8B variants (q4_k_m measures ~4.92GB for 8.03B params
 *     → 0.612 BPP, q3_k_m measures ~3.74GB → 0.466 BPP — table values
 *     are slightly more conservative).
 *   - GPTQ / AWQ: typical 4-bit + 16-bit scales/zero-points → ~0.5 BPP.
 *
 * Date checked: 2026-06-03.
 *
 * The catalog feeds quantization names through this map verbatim — if a
 * new GGUF flavour gains traction (e.g. IQ-3-XS), add a row and a Quant
 * entry in types.ts. Until then, callers fall through to `unknown: 0.6`
 * which over-estimates by ~5-15% (safer than under-estimating).
 */

import type { Quant } from './types.js';

/** Bytes per parameter for each Quant. All entries are typed. */
const QUANT_BYTES_PER_PARAM: Readonly<Record<Quant, number>> = {
  // Dense / unquantized
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8: 1,

  // GGUF k-quants (llama.cpp)
  q8_0: 1.0,
  q6_k: 0.81,
  q5_k_m: 0.71,
  q5_k_s: 0.69,
  q4_k_m: 0.57,
  q4_k_s: 0.55,
  q4_0: 0.56,
  q3_k_m: 0.45,
  q2_k: 0.34,

  // CUDA-only 4-bit families
  awq: 0.5,
  gptq: 0.5,

  // Fallback for catalog rows that don't carry a quant string
  unknown: 0.6,
};

/** Look up bytes-per-parameter for a quant. Total over the Quant enum. */
export function bytesPerParam(quant: Quant): number {
  return QUANT_BYTES_PER_PARAM[quant];
}

/** GGUF quant family — anything llama.cpp can run. */
const GGUF_QUANTS: ReadonlySet<Quant> = new Set<Quant>([
  'fp16',
  'bf16',
  'q8_0',
  'q6_k',
  'q5_k_m',
  'q5_k_s',
  'q4_k_m',
  'q4_k_s',
  'q4_0',
  'q3_k_m',
  'q2_k',
]);

/** True if the quant runs under llama.cpp / GGUF runtimes. */
export function isGgufQuant(quant: Quant): boolean {
  return GGUF_QUANTS.has(quant);
}

/** CUDA-only quants (require NVIDIA). */
const CUDA_ONLY_QUANTS: ReadonlySet<Quant> = new Set<Quant>(['awq', 'gptq', 'fp8']);

/** True if this quant requires a CUDA runtime (excludes Apple/AMD-RDNA). */
export function isCudaOnlyQuant(quant: Quant): boolean {
  return CUDA_ONLY_QUANTS.has(quant);
}

/** Iteration helper for tests that walk every entry. */
export function listQuantEntries(): ReadonlyArray<readonly [Quant, number]> {
  return Object.entries(QUANT_BYTES_PER_PARAM) as ReadonlyArray<readonly [Quant, number]>;
}
