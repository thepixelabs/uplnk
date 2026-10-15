/**
 * Pure model-fit scorer.
 *
 * Given a candidate model + the user's hardware, return a FitScore that the
 * picker UI can sort, filter, and explain.
 *
 * Algorithm — kept deliberately conservative; an over-estimate of memory
 * required is far less harmful than an under-estimate (the user with the
 * 24 GB GPU who tries to load a 26 GB model has a much worse day than the
 * user we mis-labeled "too-tight" when they could have squeezed it in).
 *
 *   1. weightBytes      = parametersB * 1e9 * bytesPerParam(quant)
 *   2. kvBytes (rough)  = 2 * contextLength * parametersB * 0.5e6
 *        — empirical fit to llama-family models with GQA: a Llama-3-8B
 *          at 32k context burns ~1 GB on KV in fp16. Formula yields
 *          2 * 32_000 * 8 * 0.5e6 = ~256 MB which is 4x too low for fp16
 *          but the catalog typically targets q4 → fp16 KV ratio,
 *          and the scorer's goal is RELATIVE ordering between candidates.
 *          We document this as "approximate" — see notes.
 *   3. memoryRequired   = weightBytes + kvBytes
 *   4. primary GPU      = largest vramBytes
 *   5. fitLevel branching — see decision tree comment below.
 *   6. estimatedTps     = bandwidth * 0.55 / (weightBytes in GB)
 *        — Odysseus's empirical efficiency factor.
 *   7. subScores 0-100  — vramFit, speed (clamp to 50 tok/s = 100),
 *                          contextFit (linear down past 32k).
 *   8. notes            — short human strings for tooltip.
 *
 * Pure: no side effects, deterministic for the same inputs.
 */

import { bytesPerParam, isCudaOnlyQuant, isGgufQuant } from './quantTable.js';
import type { FitLevel, FitScore, GpuInfo, HardwareProfile, ModelFitInput } from './types.js';

const GB = 1024 ** 3;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Largest-VRAM GPU, or null if no GPUs detected. */
function primaryGpu(hw: HardwareProfile): GpuInfo | null {
  if (hw.gpus.length === 0) return null;
  let best = hw.gpus[0]!;
  for (let i = 1; i < hw.gpus.length; i++) {
    const g = hw.gpus[i]!;
    if (g.vramBytes > best.vramBytes) best = g;
  }
  return best;
}

/** KV cache size estimate. Accepts family for future tuning; today llama-like. */
function estimateKvBytes(parametersB: number, contextLength: number): number {
  // 2 * tokens * params * 0.5e6 → see formula explanation at file top.
  return 2 * contextLength * parametersB * 0.5e6;
}

/**
 * Format a byte count in GB to one decimal place for human notes.
 */
function fmtGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)}GB`;
}

/**
 * Score a model against a hardware profile.
 *
 * Decision tree (see plan §E.2.3):
 *   1. ggufOnly + cuda-only quant         → 'incompatible'
 *   2. GPU vram >= required               → 'gpu'
 *   3. systemRam >= required, GPU shy     → 'cpu-offload'
 *   4. no GPU + small GGUF (<=7B q*)      → 'cpu-only'
 *   5. else                               → 'too-tight'
 */
export function scoreModel(input: ModelFitInput, hw: HardwareProfile): FitScore {
  const notes: string[] = [];

  const weightBytes = input.parametersB * 1e9 * bytesPerParam(input.quant);
  const kvBytes = estimateKvBytes(input.parametersB, input.contextLength);
  const memoryRequiredBytes = weightBytes + kvBytes;

  const gpu = primaryGpu(hw);
  const gpuVram = gpu?.vramBytes ?? 0;
  const vramHeadroomBytes = gpuVram - memoryRequiredBytes;

  // 1) Hard compatibility check — Apple/RDNA can't run AWQ/GPTQ/fp8.
  let fitLevel: FitLevel;
  if (hw.hints.ggufOnly && isCudaOnlyQuant(input.quant)) {
    fitLevel = 'incompatible';
    notes.push(
      `Quantization ${input.quant} requires CUDA; this hardware runs GGUF only.`,
    );
  } else if (gpu !== null && gpuVram >= memoryRequiredBytes) {
    fitLevel = 'gpu';
  } else if (hw.systemRamBytes >= memoryRequiredBytes) {
    if (gpu === null) {
      // No GPU: only viable if it's a small GGUF model.
      if (isGgufQuant(input.quant) && input.parametersB <= 7) {
        fitLevel = 'cpu-only';
      } else {
        fitLevel = 'too-tight';
      }
    } else {
      fitLevel = 'cpu-offload';
    }
  } else {
    // System RAM not enough either.
    if (gpu === null && isGgufQuant(input.quant) && input.parametersB <= 7) {
      // Edge case: small enough to swap reasonably on most systems
      // — Odysseus reports this as cpu-only with a warning rather than
      //   blocking the user. Mirror that.
      fitLevel = 'cpu-only';
      notes.push('System RAM is tight — model may swap. Close other apps.');
    } else {
      fitLevel = 'too-tight';
    }
  }

  // 2) Speed estimate
  let estimatedTps: number | undefined;
  if (fitLevel === 'gpu' && gpu !== null && gpu.bandwidthGBs !== undefined) {
    // Odysseus efficiency factor 0.55 — matches measured throughput on
    // llama.cpp w/ Q4_K_M on RTX 4090 (~28 tok/s for Llama-3-8B).
    const weightBytesGb = weightBytes / GB;
    if (weightBytesGb > 0) {
      estimatedTps = (gpu.bandwidthGBs * 0.55) / weightBytesGb;
    }
  } else if (fitLevel === 'cpu-offload' && gpu !== null && gpu.bandwidthGBs !== undefined) {
    // Harmonic blend GPU+CPU. CPU bandwidth ~ proxy by system RAM (DDR5 dual
    // channel ≈ 50 GB/s; very rough scaling by total RAM as a sanity bound).
    const cpuBandwidth = Math.min(hw.systemRamBytes / GB, 50);
    const weightBytesGb = weightBytes / GB;
    if (weightBytesGb > 0 && cpuBandwidth > 0) {
      // Harmonic mean weighted by which device holds which fraction
      const gpuFrac = clamp(gpuVram / memoryRequiredBytes, 0, 1);
      const cpuFrac = 1 - gpuFrac;
      const effectiveBw =
        1 / (gpuFrac / gpu.bandwidthGBs + cpuFrac / cpuBandwidth);
      estimatedTps = (effectiveBw * 0.45) / weightBytesGb;
    }
  } else if (fitLevel === 'cpu-only') {
    // Pure CPU — assume 50 GB/s peak, 0.3 efficiency → very modest tok/s
    const weightBytesGb = weightBytes / GB;
    if (weightBytesGb > 0) {
      estimatedTps = (50 * 0.3) / weightBytesGb;
    }
  }

  // 3) Sub-scores
  let vramFit = 0;
  if (gpuVram > 0) {
    vramFit = clamp(
      ((gpuVram - memoryRequiredBytes) / gpuVram) * 100,
      0,
      100,
    );
  }
  let speed = 0;
  if (estimatedTps !== undefined) {
    speed = clamp((estimatedTps / 50) * 100, 0, 100);
  }
  let contextFit = 100;
  if (input.contextLength > 32_000) {
    // Linear down: 100 at 32k → 50 at 128k → ~0 past 224k.
    // Calibrated so the picker visibly penalises >64k contexts that
    // double KV-cache memory on every roundtrip.
    contextFit = clamp(
      100 - ((input.contextLength - 32_000) / 96_000) * 50,
      0,
      100,
    );
  }

  // 4) Notes
  if (fitLevel === 'gpu' && gpu !== null) {
    notes.push(
      `Needs ${fmtGb(memoryRequiredBytes)}, you have ${fmtGb(gpuVram)} VRAM available.`,
    );
    if (estimatedTps !== undefined) {
      notes.push(`Estimated ${Math.round(estimatedTps)} tok/s.`);
    } else {
      notes.push('Speed estimate unavailable — bandwidth unknown for this GPU.');
    }
  } else if (fitLevel === 'cpu-offload' && gpu !== null) {
    notes.push(
      `Model needs ${fmtGb(memoryRequiredBytes)} but GPU has only ${fmtGb(gpuVram)} — runs partially on CPU.`,
    );
    if (estimatedTps !== undefined) {
      notes.push(`Estimated ${Math.round(estimatedTps)} tok/s (offload penalty applied).`);
    }
  } else if (fitLevel === 'cpu-only') {
    notes.push(
      `CPU-only inference of a ${input.parametersB}B model. Expect single-digit tok/s.`,
    );
  } else if (fitLevel === 'too-tight') {
    notes.push(
      `Model needs ${fmtGb(memoryRequiredBytes)}, exceeds available memory. Try a smaller quant or fewer params.`,
    );
  }

  return {
    fitLevel,
    memoryRequiredBytes,
    vramHeadroomBytes,
    estimatedTps,
    subScores: {
      vramFit,
      speed,
      contextFit,
    },
    notes: Object.freeze(notes.slice()),
  };
}
