/**
 * Memory-bandwidth lookup table (GB/s) for GPUs and SoCs that uplnk users
 * realistically run local models on.
 *
 * Numbers are *peak theoretical* bandwidth from vendor specs as of 2026-06-03.
 * Sources (one row may pull from several — checked against both for sanity):
 *   - NVIDIA product pages:
 *       https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/
 *       https://www.nvidia.com/en-us/data-center/h100/
 *       https://www.nvidia.com/en-us/data-center/a100/
 *       https://www.nvidia.com/en-us/data-center/l40s/
 *   - AMD product pages:
 *       https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html
 *       https://www.amd.com/en/products/graphics/radeon-rx-7900xtx
 *       https://www.amd.com/en/products/professional-graphics/radeon-pro-w7900
 *   - Apple Silicon — Apple's chip-launch press releases + Tech Specs pages:
 *       https://www.apple.com/newsroom/  (M2 Ultra, M3 Pro/Max, M4 Pro/Max)
 *   - Snapdragon X Elite — Qualcomm product brief.
 *   - Wikipedia cross-checks (List of NVIDIA graphics processing units,
 *     List of AMD graphics processing units, Apple silicon).
 *
 * When in doubt the entry is OMITTED. A consumer that misses a lookup gets
 * `undefined` from `getBandwidthGBs()` and the scorer degrades gracefully
 * rather than reporting an invented tok/s number.
 *
 * NOTE: Apple Silicon bandwidth varies by chip *bin* (e.g. M3 Max comes in
 * a 300 GB/s 14-core-GPU bin and a 400 GB/s 30/40-core bin). We list the
 * higher-end bin — most users with an M3 Max bought the higher bin, and a
 * slight over-estimate here is far less harmful than a missed match.
 */

/** GB/s entries. Lower-cased key match against a normalised probe string. */
const BANDWIDTH_TABLE: ReadonlyMap<string, number> = new Map([
  // NVIDIA — consumer
  ['rtx 5090', 1792],
  ['rtx 4090', 1008],
  ['rtx 4080', 717],
  ['rtx 4070 ti', 504],
  ['rtx 3090', 936],
  ['rtx 3080', 760],

  // NVIDIA — datacenter / pro
  ['a100', 2039],            // 80GB SXM variant — 40GB PCIe is 1555, omitted to avoid mis-match
  ['h100', 3000],            // SXM5; PCIe is 2000, omitted
  ['l40s', 864],

  // AMD — datacenter
  ['mi300x', 5300],

  // AMD — consumer / pro
  ['rx 7900 xtx', 960],
  ['radeon rx 7900 xtx', 960],
  ['rx 7900 xt', 800],
  ['radeon rx 7900 xt', 800],
  ['radeon pro w7900', 864],

  // Apple Silicon
  ['m4 max', 546],
  ['m4 pro', 273],
  ['m3 max', 400],
  ['m3 pro', 150],
  ['m2 ultra', 800],
  ['m2 max', 400],

  // Mobile SoCs with NPUs that uplnk might end up on
  ['snapdragon x elite', 135],
  ['lunar lake', 120],       // Intel Core Ultra 200V, approximate (8533 MT/s LPDDR5X)
]);

/**
 * Look up bandwidth for a probed device string. Case-insensitive substring
 * match — the table key must appear anywhere in the input.
 *
 * Returns `undefined` for an unknown chip (caller should NOT invent a value).
 */
export function getBandwidthGBs(deviceName: string): number | undefined {
  const haystack = deviceName.toLowerCase();
  for (const [key, value] of BANDWIDTH_TABLE) {
    if (haystack.includes(key)) {
      return value;
    }
  }
  return undefined;
}

/** Read-only export for callers (tests) that want to iterate the whole table. */
export function listBandwidthEntries(): ReadonlyArray<readonly [string, number]> {
  return Array.from(BANDWIDTH_TABLE.entries());
}
