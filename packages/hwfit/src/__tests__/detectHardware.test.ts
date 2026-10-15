/**
 * detectHardware tests.
 *
 * Strategy: mock node:child_process.execSync via vi.hoisted so we can drive
 * arbitrary shell-call outputs per test. Also mock node:os.totalmem to keep
 * RAM fallback deterministic across CI machines.
 *
 * process.platform is swapped per-test via Object.defineProperty inside a
 * try/finally so subsequent tests inherit the right OS.
 *
 * NO actual shell process ever spawns under these tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn<(cmd: string, opts?: object) => string>(),
  totalmem: vi.fn<() => number>(),
}));

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    totalmem: mocks.totalmem,
  };
});

import { detectHardware } from '../detectHardware.js';

const GB = 1024 ** 3;
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.totalmem.mockReturnValue(16 * GB);
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

// ─── macOS ──────────────────────────────────────────────────────────────────

describe('detectHardware — macOS', () => {
  it('detects Apple Silicon M4 Max with unified memory + ggufOnly', async () => {
    setPlatform('darwin');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.includes('hw.memsize')) return String(64 * GB);
      if (cmd.includes('cpu.brand_string')) return 'Apple M4 Max';
      if (cmd.includes('hw.optional.arm64')) return '1';
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('macos');
    expect(profile.cpu).toBe('Apple M4 Max');
    expect(profile.systemRamBytes).toBe(64 * GB);
    expect(profile.hints.unifiedMemory).toBe(true);
    expect(profile.hints.ggufOnly).toBe(true);
    expect(profile.gpus).toHaveLength(1);
    expect(profile.gpus[0]!.vendor).toBe('apple');
    expect(profile.gpus[0]!.name).toBe('Apple M4 Max');
    expect(profile.gpus[0]!.bandwidthGBs).toBe(546);
    // 64GB at 0.80 fraction = ~51GB GPU budget
    expect(profile.gpus[0]!.vramBytes).toBeGreaterThan(40 * GB);
    expect(profile.gpus[0]!.vramBytes).toBeLessThan(64 * GB);
  });

  it('detects Intel Mac and does NOT mark unifiedMemory', async () => {
    setPlatform('darwin');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.includes('hw.memsize')) return String(32 * GB);
      if (cmd.includes('cpu.brand_string')) return 'Intel(R) Core(TM) i9-9980HK CPU';
      if (cmd.includes('hw.optional.arm64')) return '0';
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('macos');
    expect(profile.cpu).toMatch(/Intel/);
    expect(profile.hints.unifiedMemory).toBe(false);
    expect(profile.hints.ggufOnly).toBe(false);
    expect(profile.gpus).toEqual([]);
    expect(profile.diagnostics.join(' ')).toMatch(/Intel\/AMD discrete/);
  });

  it('gracefully degrades when sysctl throws', async () => {
    setPlatform('darwin');
    mocks.execSync.mockImplementation(() => {
      throw new Error('sysctl: command not found');
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('macos');
    expect(profile.gpus).toEqual([]);
    expect(profile.diagnostics.length).toBeGreaterThan(0);
    expect(profile.diagnostics.join(' ')).toMatch(/sysctl/);
  });
});

// ─── Linux NVIDIA ───────────────────────────────────────────────────────────

describe('detectHardware — Linux NVIDIA', () => {
  it('parses a multi-GPU nvidia-smi response into GpuInfo entries', async () => {
    setPlatform('linux');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.startsWith('nvidia-smi')) {
        return [
          '24564, NVIDIA GeForce RTX 4090',
          '10240, NVIDIA GeForce RTX 3080',
        ].join('\n');
      }
      if (cmd.includes('ls -1 /sys/class/drm/')) {
        throw new Error('no drm');
      }
      if (cmd.includes('rocminfo')) throw new Error('no rocm');
      if (cmd.includes('/proc/cpuinfo')) return 'model name : AMD EPYC 9654';
      if (cmd.includes('/proc/meminfo')) return 'MemTotal:       131072000 kB';
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('linux');
    expect(profile.gpus).toHaveLength(2);
    expect(profile.gpus[0]!.vendor).toBe('nvidia');
    expect(profile.gpus[0]!.name).toContain('RTX 4090');
    expect(profile.gpus[0]!.vramBytes).toBe(24564 * 1024 * 1024);
    expect(profile.gpus[0]!.bandwidthGBs).toBe(1008);
    expect(profile.gpus[1]!.bandwidthGBs).toBe(760);
    expect(profile.cpu).toContain('AMD EPYC 9654');
  });

  it('records a diagnostic when nvidia-smi is missing', async () => {
    setPlatform('linux');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.startsWith('nvidia-smi')) throw new Error('nvidia-smi: not found');
      if (cmd.includes('ls -1 /sys/class/drm/')) throw new Error('no drm');
      if (cmd.includes('/proc/cpuinfo')) return '';
      if (cmd.includes('/proc/meminfo')) return '';
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('linux');
    expect(profile.gpus).toEqual([]);
    expect(profile.diagnostics.join(' ')).toMatch(/nvidia-smi/);
  });
});

// ─── Linux AMD ──────────────────────────────────────────────────────────────

describe('detectHardware — Linux AMD', () => {
  it('classifies AMD MI300X as CDNA via gfx940 rocminfo', async () => {
    setPlatform('linux');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.startsWith('nvidia-smi')) throw new Error('not found');
      if (cmd.includes('ls -1 /sys/class/drm/')) return 'card0\ncard1\nrenderD128';
      if (cmd.includes('mem_info_vram_total')) return String(192 * GB);
      if (cmd.includes('rocminfo')) return 'Name: amdgcn-amd-amdhsa--gfx940';
      if (cmd.includes('/proc/cpuinfo')) return 'model name : AMD EPYC';
      if (cmd.includes('/proc/meminfo')) return 'MemTotal:       262144000 kB';
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.gpus.length).toBeGreaterThan(0);
    expect(profile.gpus[0]!.vendor).toBe('amd-cdna');
    expect(profile.gpus[0]!.name).toContain('gfx940');
    expect(profile.hints.ggufOnly).toBe(false);
  });

  it('classifies AMD RX 7900 as RDNA via gfx1100 and sets ggufOnly', async () => {
    setPlatform('linux');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.startsWith('nvidia-smi')) throw new Error('not found');
      if (cmd.includes('ls -1 /sys/class/drm/')) return 'card0';
      if (cmd.includes('mem_info_vram_total')) return String(24 * GB);
      if (cmd.includes('rocminfo')) return 'Name: gfx1100\nMarketing Name: AMD Radeon RX 7900 XTX';
      if (cmd.includes('/proc/cpuinfo')) return 'model name : AMD Ryzen';
      if (cmd.includes('/proc/meminfo')) return 'MemTotal:       65536000 kB';
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.gpus.length).toBeGreaterThan(0);
    expect(profile.gpus[0]!.vendor).toBe('amd-rdna');
    expect(profile.gpus[0]!.name).toContain('gfx1100');
    expect(profile.hints.ggufOnly).toBe(true);
  });
});

// ─── Windows ────────────────────────────────────────────────────────────────

describe('detectHardware — Windows', () => {
  it('parses PowerShell JSON output for RAM + CPU', async () => {
    setPlatform('win32');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.startsWith('powershell')) {
        return JSON.stringify({
          ram: 32 * GB,
          cpu: '13th Gen Intel(R) Core(TM) i9-13900K',
        });
      }
      if (cmd.startsWith('nvidia-smi')) {
        return '24564, NVIDIA GeForce RTX 4090';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('windows');
    expect(profile.cpu).toContain('Intel');
    expect(profile.systemRamBytes).toBe(32 * GB);
    expect(profile.gpus).toHaveLength(1);
    expect(profile.gpus[0]!.name).toContain('RTX 4090');
    expect(profile.hints.unifiedMemory).toBe(false);
  });

  it('records a diagnostic on Windows when PowerShell fails', async () => {
    setPlatform('win32');
    mocks.execSync.mockImplementation((cmd: string): string => {
      if (cmd.startsWith('powershell')) throw new Error('powershell.exe not found');
      if (cmd.startsWith('nvidia-smi')) throw new Error('nvidia-smi not found');
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('windows');
    expect(profile.diagnostics.join(' ')).toMatch(/PowerShell/);
    expect(profile.gpus).toEqual([]);
  });
});

// ─── Complete failure / unknown OS ──────────────────────────────────────────

describe('detectHardware — graceful degrade', () => {
  it('returns a degraded HardwareProfile when every probe throws', async () => {
    setPlatform('linux');
    mocks.execSync.mockImplementation(() => {
      throw new Error('all subprocess calls fail');
    });

    const profile = await detectHardware();

    // Must NOT throw — should return a populated profile with diagnostics.
    expect(profile.os).toBe('linux');
    expect(profile.gpus).toEqual([]);
    expect(profile.diagnostics.length).toBeGreaterThan(0);
    expect(profile.systemRamBytes).toBeGreaterThan(0);
  });

  it('handles a platform we do not recognise (freebsd) without throwing', async () => {
    setPlatform('freebsd' as NodeJS.Platform);
    mocks.execSync.mockImplementation(() => {
      throw new Error('shall not reach');
    });

    const profile = await detectHardware();

    expect(profile.os).toBe('unknown');
    expect(profile.gpus).toEqual([]);
    expect(profile.diagnostics.join(' ')).toMatch(/unknown platform/);
  });
});
