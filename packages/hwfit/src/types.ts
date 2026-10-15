/**
 * Public type surface for @uplnk/hwfit.
 *
 * Two consumers:
 *   1. The model picker UI: sorts/filters a catalog using FitScore.subScores.
 *   2. The provider boot path: surfaces HardwareProfile.diagnostics if a probe
 *      step partially failed (e.g. nvidia-smi present but returned no rows).
 *
 * Everything here is data-only — no functions, no side effects.
 */

/** Identifies a GPU vendor for capability gating (e.g. AWQ requires CUDA). */
export type GpuVendor =
  | 'nvidia'
  | 'amd-cdna'
  | 'amd-rdna'
  | 'apple'
  | 'intel'
  | 'unknown';

/** Single detected GPU. Multi-GPU rigs report each entry separately. */
export interface GpuInfo {
  vendor: GpuVendor;
  /** Display name from probe — "NVIDIA RTX 4090", "Apple M4 Max", "AMD MI300X". */
  name: string;
  /** Total VRAM in bytes. On Apple Silicon this is the GPU budget portion of unified RAM. */
  vramBytes: number;
  /** Memory bandwidth GB/s from the table, or `undefined` if unknown. */
  bandwidthGBs?: number | undefined;
}

/** Aggregate machine profile. Always returned (graceful degrade on probe failure). */
export interface HardwareProfile {
  /** OS family. */
  os: 'macos' | 'linux' | 'windows' | 'unknown';
  /** All detected GPUs. Multi-GPU rigs report each. */
  gpus: GpuInfo[];
  /** Total system RAM in bytes. */
  systemRamBytes: number;
  /** CPU display string. */
  cpu: string;
  /** Hints used by scorers: 'apple-silicon' true → only GGUF; 'amd-rdna' true → only GGUF. */
  hints: {
    unifiedMemory: boolean;
    ggufOnly: boolean;
  };
  /** Diagnostics captured during probe — surfaced when a probe partially fails. */
  diagnostics: readonly string[];
}

/** Quantization label. Covers GGUF families + dense-tensor formats. */
export type Quant =
  | 'fp32'
  | 'fp16'
  | 'bf16'
  | 'fp8'
  | 'q8_0'
  | 'q6_k'
  | 'q5_k_m'
  | 'q5_k_s'
  | 'q4_k_m'
  | 'q4_k_s'
  | 'q4_0'
  | 'q3_k_m'
  | 'q2_k'
  | 'awq'
  | 'gptq'
  | 'unknown';

/** Per-model query to scoreModel(). */
export interface ModelFitInput {
  /** Parameter count in billions — e.g. 7 for "7B". */
  parametersB: number;
  quant: Quant;
  /** Context window the user plans to run at. */
  contextLength: number;
  /** Family hint for KV-cache calc — defaults assume llama-like. */
  family?: string | undefined;
}

/** Coarse classification surfaced as a badge in the picker. */
export type FitLevel =
  | 'gpu'
  | 'cpu-offload'
  | 'cpu-only'
  | 'too-tight'
  | 'incompatible';

/** Result of scoreModel(). All bytes counts; all sub-scores 0-100. */
export interface FitScore {
  fitLevel: FitLevel;
  /** Estimated weight bytes + KV cache bytes. */
  memoryRequiredBytes: number;
  /** Headroom in bytes (negative if over budget). */
  vramHeadroomBytes: number;
  /** Best-guess generation tok/s. `undefined` if we can't estimate. */
  estimatedTps?: number | undefined;
  /** Sub-scores for UI sort: each 0-100. */
  subScores: {
    vramFit: number;
    speed: number;
    contextFit: number;
  };
  /** Plain-English explanation surfaced in the picker tooltip. */
  notes: readonly string[];
}
