/**
 * Cross-platform hardware probe.
 *
 * Goals (in order):
 *   1. ALWAYS return a HardwareProfile. Probing is best-effort — every shell
 *      step is wrapped in try/catch and on failure pushes a diagnostic
 *      instead of throwing.
 *   2. Never block longer than ~3 s per shell call. All execSync invocations
 *      pass `{ timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }`.
 *   3. Be conservative: when bandwidth/VRAM/family is uncertain, omit the
 *      field rather than invent. The scorer degrades gracefully on
 *      `undefined` and reports an "unknown fit" rather than a wrong fit.
 *
 * Per-OS strategy:
 *   - macOS: `sysctl` for memsize, CPU brand, ARM64 flag. Apple Silicon →
 *     unified memory; GPU budget = 67-80% of total RAM (scaled by total).
 *   - Linux + NVIDIA: `nvidia-smi --query-gpu=memory.total,name --format=csv`
 *     one row per GPU.
 *   - Linux + AMD: per-card `/sys/class/drm/cardN/device/mem_info_vram_total`
 *     plus `rocminfo` for gfx ISA → CDNA (gfx9xx) vs RDNA (gfx10/11/12).
 *     RDNA is gguf-only (no ROCm vLLM/AWQ path in 2026).
 *   - Windows: a single PowerShell call returns JSON with RAM + CPU; then
 *     `nvidia-smi` if present for GPUs.
 *   - Anything else: fall back to `os.totalmem()` + empty `gpus[]` and a
 *     diagnostic ("unknown OS").
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import { getBandwidthGBs } from './bandwidthTable.js';
import type { GpuInfo, GpuVendor, HardwareProfile } from './types.js';

const SHELL_TIMEOUT_MS = 3000;

interface ExecOk {
  ok: true;
  out: string;
}
interface ExecErr {
  ok: false;
  err: string;
}
type ExecResult = ExecOk | ExecErr;

/**
 * Run a shell command with a hard 3s timeout. Returns a tagged result —
 * NEVER throws to the caller. stderr is normalised into the error message.
 */
function tryExec(cmd: string): ExecResult {
  try {
    const buf = execSync(cmd, {
      timeout: SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, out: buf.toString().trim() };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr =
      e.stderr !== undefined && e.stderr !== null
        ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString()).trim()
        : '';
    const msg = stderr.length > 0 ? stderr : (e.message ?? String(err));
    return { ok: false, err: msg };
  }
}

/**
 * Apple Silicon unified-memory budget. macOS reserves headroom for the OS;
 * the practical GPU budget scales with total RAM:
 *   8GB  → ~5.3 GB  (67%)
 *   16GB → ~11 GB   (69%)
 *   32GB → ~24 GB   (75%)
 *   64GB → ~51 GB   (80%)
 *   128GB → ~102 GB (80%)
 * These match the documented `iogpu.wired_limit` defaults plus a small
 * empirical fudge. Capped at 80% — even tuned, you can't use more without
 * paging OOM kills.
 */
function appleSiliconGpuBudgetFraction(totalRamBytes: number): number {
  const GB = 1024 ** 3;
  const totalGb = totalRamBytes / GB;
  if (totalGb >= 64) return 0.8;
  if (totalGb >= 32) return 0.75;
  if (totalGb >= 16) return 0.69;
  return 0.67;
}

// ─── macOS ──────────────────────────────────────────────────────────────────

function probeMacos(diagnostics: string[]): {
  cpu: string;
  systemRamBytes: number;
  gpus: GpuInfo[];
  hints: HardwareProfile['hints'];
} {
  let cpu = 'Unknown CPU';
  let systemRamBytes = os.totalmem();
  let isAppleSilicon = false;

  const memRes = tryExec('sysctl -n hw.memsize');
  if (memRes.ok) {
    const parsed = Number.parseInt(memRes.out, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      systemRamBytes = parsed;
    } else {
      diagnostics.push('macos: hw.memsize returned non-numeric output');
    }
  } else {
    diagnostics.push(`macos: sysctl hw.memsize failed (${memRes.err})`);
  }

  const cpuRes = tryExec('sysctl -n machdep.cpu.brand_string');
  if (cpuRes.ok && cpuRes.out.length > 0) {
    cpu = cpuRes.out;
  } else if (!cpuRes.ok) {
    diagnostics.push(`macos: sysctl cpu.brand_string failed (${cpuRes.err})`);
  }

  const arm64Res = tryExec('sysctl -n hw.optional.arm64');
  if (arm64Res.ok) {
    isAppleSilicon = arm64Res.out.trim() === '1';
  }
  // arm64Res failure isn't fatal — fall back to vendor parsing on cpu string
  if (!isAppleSilicon && /apple m[1-9]/i.test(cpu)) {
    isAppleSilicon = true;
  }

  const gpus: GpuInfo[] = [];
  if (isAppleSilicon) {
    const fraction = appleSiliconGpuBudgetFraction(systemRamBytes);
    const vramBytes = Math.floor(systemRamBytes * fraction);
    const bandwidthGBs = getBandwidthGBs(cpu);
    const gpu: GpuInfo = {
      vendor: 'apple',
      name: cpu,
      vramBytes,
    };
    if (bandwidthGBs !== undefined) gpu.bandwidthGBs = bandwidthGBs;
    gpus.push(gpu);
  } else {
    diagnostics.push('macos: Intel/AMD discrete GPU detection unsupported');
  }

  return {
    cpu,
    systemRamBytes,
    gpus,
    hints: {
      unifiedMemory: isAppleSilicon,
      // Apple Silicon can only run GGUF/Metal — no AWQ/GPTQ/fp8 path
      ggufOnly: isAppleSilicon,
    },
  };
}

// ─── Linux NVIDIA ───────────────────────────────────────────────────────────

function probeLinuxNvidia(diagnostics: string[]): GpuInfo[] {
  const res = tryExec(
    'nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits',
  );
  if (!res.ok) {
    diagnostics.push(`linux: nvidia-smi unavailable (${res.err})`);
    return [];
  }
  const gpus: GpuInfo[] = [];
  for (const line of res.out.split(/\r?\n/)) {
    const row = line.trim();
    if (row.length === 0) continue;
    // CSV: "<mem_MiB>, <name>"
    const commaIdx = row.indexOf(',');
    if (commaIdx <= 0) {
      diagnostics.push(`linux: nvidia-smi row not CSV: "${row}"`);
      continue;
    }
    const memMib = Number.parseInt(row.slice(0, commaIdx).trim(), 10);
    const name = row.slice(commaIdx + 1).trim();
    if (!Number.isFinite(memMib) || memMib <= 0 || name.length === 0) {
      diagnostics.push(`linux: nvidia-smi row malformed: "${row}"`);
      continue;
    }
    const displayName = `NVIDIA ${name}`;
    const bandwidthGBs = getBandwidthGBs(displayName);
    const gpu: GpuInfo = {
      vendor: 'nvidia',
      name: displayName,
      vramBytes: memMib * 1024 * 1024,
    };
    if (bandwidthGBs !== undefined) gpu.bandwidthGBs = bandwidthGBs;
    gpus.push(gpu);
  }
  return gpus;
}

// ─── Linux AMD ──────────────────────────────────────────────────────────────

interface AmdIsaInfo {
  hasCdna: boolean;
  hasRdna: boolean;
  /** Last seen ISA name for display (e.g. "gfx1100"). */
  lastIsa: string | null;
}

function probeAmdIsa(diagnostics: string[]): AmdIsaInfo {
  const res = tryExec('rocminfo');
  if (!res.ok) {
    diagnostics.push(`linux: rocminfo unavailable (${res.err})`);
    return { hasCdna: false, hasRdna: false, lastIsa: null };
  }
  let hasCdna = false;
  let hasRdna = false;
  let lastIsa: string | null = null;
  // rocminfo emits lines like "Name: gfx1100" or "Name: amdgcn-amd-amdhsa--gfx940"
  const re = /gfx(\d{3,4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.out)) !== null) {
    const isaNum = m[1];
    if (isaNum === undefined) continue;
    lastIsa = `gfx${isaNum}`;
    // CDNA = gfx9xx (MI100/200/300); RDNA = gfx10xx/11xx/12xx (consumer)
    const major = Number.parseInt(isaNum.slice(0, isaNum.length - 2), 10);
    if (major === 9) {
      hasCdna = true;
    } else if (major === 10 || major === 11 || major === 12) {
      hasRdna = true;
    }
  }
  return { hasCdna, hasRdna, lastIsa };
}

function probeLinuxAmd(diagnostics: string[]): {
  gpus: GpuInfo[];
  ggufOnly: boolean;
} {
  // Discover candidate card paths via shell glob — execSync handles the glob.
  const listRes = tryExec('ls -1 /sys/class/drm/ 2>/dev/null');
  if (!listRes.ok) {
    return { gpus: [], ggufOnly: false };
  }
  const cards = listRes.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^card\d+$/.test(s));
  if (cards.length === 0) {
    return { gpus: [], ggufOnly: false };
  }

  const isa = probeAmdIsa(diagnostics);
  const gpus: GpuInfo[] = [];
  for (const card of cards) {
    const vramRes = tryExec(
      `cat /sys/class/drm/${card}/device/mem_info_vram_total 2>/dev/null`,
    );
    if (!vramRes.ok) continue;
    const vramBytes = Number.parseInt(vramRes.out, 10);
    if (!Number.isFinite(vramBytes) || vramBytes <= 0) continue;

    // Pick vendor by ISA mix. If we saw both, prefer the higher-VRAM
    // assumption (CDNA cards are typically much larger than RDNA).
    let vendor: GpuVendor = 'amd-rdna';
    if (isa.hasCdna && !isa.hasRdna) vendor = 'amd-cdna';
    else if (isa.hasCdna && isa.hasRdna && vramBytes >= 32 * 1024 ** 3) vendor = 'amd-cdna';

    const name = isa.lastIsa !== null ? `AMD ${isa.lastIsa}` : `AMD ${card}`;
    const bandwidthGBs = getBandwidthGBs(name);
    const gpu: GpuInfo = {
      vendor,
      name,
      vramBytes,
    };
    if (bandwidthGBs !== undefined) gpu.bandwidthGBs = bandwidthGBs;
    gpus.push(gpu);
  }

  // RDNA on Linux is gguf-only in 2026 (vLLM ROCm targets CDNA exclusively;
  // AWQ kernels haven't been ported to RDNA).
  const ggufOnly = isa.hasRdna && !isa.hasCdna;
  return { gpus, ggufOnly };
}

// ─── Windows ────────────────────────────────────────────────────────────────

interface WindowsSystemInfo {
  ram: number;
  cpu: string;
}

function probeWindows(diagnostics: string[]): {
  cpu: string;
  systemRamBytes: number;
  gpus: GpuInfo[];
} {
  let cpu = 'Unknown CPU';
  let systemRamBytes = os.totalmem();

  // Single combined PowerShell call. Avoid second invocation cost.
  const psCmd =
    'powershell -NoProfile -Command "ConvertTo-Json -InputObject @{ ram = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; cpu = (Get-CimInstance Win32_Processor).Name }"';
  const sysRes = tryExec(psCmd);
  if (sysRes.ok) {
    try {
      const parsed = JSON.parse(sysRes.out) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Partial<WindowsSystemInfo>;
        if (typeof p.ram === 'number' && p.ram > 0) {
          systemRamBytes = p.ram;
        } else if (typeof p.ram === 'string') {
          const r = Number.parseInt(p.ram, 10);
          if (Number.isFinite(r) && r > 0) systemRamBytes = r;
        }
        if (typeof p.cpu === 'string' && p.cpu.length > 0) {
          cpu = p.cpu;
        }
      }
    } catch (e) {
      diagnostics.push(`windows: PowerShell JSON parse failed (${(e as Error).message})`);
    }
  } else {
    diagnostics.push(`windows: PowerShell probe failed (${sysRes.err})`);
  }

  const gpus = probeLinuxNvidia(diagnostics); // nvidia-smi works on Windows identically
  return { cpu, systemRamBytes, gpus };
}

// ─── Top-level ──────────────────────────────────────────────────────────────

/**
 * Run a full hardware probe. Always resolves to a HardwareProfile — even when
 * every probe step fails (in which case `gpus` is empty and `diagnostics` is
 * populated with the failure reasons).
 *
 * Async signature for future-proofing (we may add async probes — e.g. an
 * HTTP-based remote profile fetch). Today the body is fully synchronous.
 */
export async function detectHardware(): Promise<HardwareProfile> {
  const diagnostics: string[] = [];
  const platform = process.platform;

  // Default profile: degraded fallback that wins if every branch errors.
  const fallback: HardwareProfile = {
    os: 'unknown',
    gpus: [],
    systemRamBytes: os.totalmem(),
    cpu: 'Unknown CPU',
    hints: { unifiedMemory: false, ggufOnly: false },
    diagnostics: [],
  };

  try {
    if (platform === 'darwin') {
      const probed = probeMacos(diagnostics);
      return {
        os: 'macos',
        gpus: probed.gpus,
        systemRamBytes: probed.systemRamBytes,
        cpu: probed.cpu,
        hints: probed.hints,
        diagnostics: Object.freeze(diagnostics.slice()),
      };
    }
    if (platform === 'linux') {
      // Try NVIDIA first — common case and cheapest.
      const nvidiaGpus = probeLinuxNvidia(diagnostics);
      const amd = probeLinuxAmd(diagnostics);
      const gpus = [...nvidiaGpus, ...amd.gpus];

      // CPU + RAM
      let cpu = 'Unknown CPU';
      let systemRamBytes = os.totalmem();
      const cpuRes = tryExec(
        // Grep 'model name' first line; works on x86 and arm64 (arm puts
        // 'CPU implementer' instead, but 'Hardware' / 'Model' rows differ
        // by distro; we accept a blank fallback).
        'grep -m1 "model name" /proc/cpuinfo 2>/dev/null',
      );
      if (cpuRes.ok && cpuRes.out.length > 0) {
        const idx = cpuRes.out.indexOf(':');
        if (idx >= 0) cpu = cpuRes.out.slice(idx + 1).trim();
      }
      const memRes = tryExec(
        'grep -m1 "MemTotal" /proc/meminfo 2>/dev/null',
      );
      if (memRes.ok && memRes.out.length > 0) {
        const match = /(\d+)\s*kB/.exec(memRes.out);
        if (match && match[1] !== undefined) {
          const kb = Number.parseInt(match[1], 10);
          if (Number.isFinite(kb) && kb > 0) {
            systemRamBytes = kb * 1024;
          }
        }
      }

      return {
        os: 'linux',
        gpus,
        systemRamBytes,
        cpu,
        hints: {
          unifiedMemory: false,
          ggufOnly: amd.ggufOnly && nvidiaGpus.length === 0,
        },
        diagnostics: Object.freeze(diagnostics.slice()),
      };
    }
    if (platform === 'win32') {
      const probed = probeWindows(diagnostics);
      return {
        os: 'windows',
        gpus: probed.gpus,
        systemRamBytes: probed.systemRamBytes,
        cpu: probed.cpu,
        hints: { unifiedMemory: false, ggufOnly: false },
        diagnostics: Object.freeze(diagnostics.slice()),
      };
    }
    diagnostics.push(`unknown platform: ${platform}`);
    return {
      ...fallback,
      diagnostics: Object.freeze(diagnostics.slice()),
    };
  } catch (err) {
    diagnostics.push(
      `probe top-level threw: ${(err as Error).message ?? String(err)}`,
    );
    return {
      ...fallback,
      diagnostics: Object.freeze(diagnostics.slice()),
    };
  }
}
