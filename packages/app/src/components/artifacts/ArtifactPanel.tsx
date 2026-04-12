/**
 * ArtifactPanel — side-panel for expanded code artifacts.
 *
 * Renders when an artifact has been "promoted" (user presses Enter on a code
 * block, or block is >= 15 lines). In split-pane mode, this occupies the
 * right half of the terminal.
 *
 * Supports two view modes:
 *   - code:  full syntax-highlighted source
 *   - diff:  hunk-based diff with per-hunk accept/reject (Phase 5)
 *
 * Keyboard controls (when panel is focused):
 *   Escape      — close panel
 *   Tab         — return keyboard focus to chat input
 *   v           — toggle between code / diff view (if diff is available)
 *   ↑/↓ or j/k  — scroll content / navigate hunks in diff mode
 *   a           — accept selected hunk
 *   r           — reject selected hunk
 *   A           — accept all pending hunks
 *   R           — reject all pending hunks
 *   Enter       — apply accepted changes and update artifact
 */

import { memo, useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { highlight } from '../../lib/syntax.js';

export interface Artifact {
  id: string;
  language: string;
  title: string;
  /** Original code — for diff view */
  original: string;
  /** Current/modified code */
  code: string;
}

type ViewMode = 'code' | 'diff';
type HunkStatus = 'pending' | 'accepted' | 'rejected';

const SCROLL_STEP = 5;
const MAX_PANEL_HEIGHT = 40;
const CONTEXT_LINES = 3;

// ─── LCS-based diff algorithm ─────────────────────────────────────────────────

interface RawDiffLine {
  kind: 'unchanged' | 'added' | 'removed';
  text: string;
  origLine: number; // 1-based line number in original (0 = N/A for added lines)
  modLine: number;  // 1-based line number in modified (0 = N/A for removed lines)
}

/**
 * Myers-style diff using dynamic programming LCS.
 * Returns a sequence of RawDiffLine entries (added, removed, unchanged).
 */
function lcsLineDiff(aLines: string[], bLines: string[]): RawDiffLine[] {
  const m = aLines.length;
  const n = bLines.length;

  // dp[i][j] = LCS length of aLines[0..i-1] vs bLines[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to reconstruct the edit script
  const result: RawDiffLine[] = [];
  let i = m;
  let j = n;
  let origLine = m;
  let modLine = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      result.push({ kind: 'unchanged', text: aLines[i - 1]!, origLine: i, modLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ kind: 'added', text: bLines[j - 1]!, origLine: 0, modLine: j });
      j--;
    } else {
      result.push({ kind: 'removed', text: aLines[i - 1]!, origLine: i, modLine: 0 });
      i--;
    }
  }
  void origLine; void modLine;

  return result.reverse();
}

// ─── Hunk model ───────────────────────────────────────────────────────────────

interface Hunk {
  id: number;
  /** All lines to display for this hunk, including context */
  lines: RawDiffLine[];
  /** Starting line in original for the hunk header */
  origStart: number;
  /** Starting line in modified for the hunk header */
  modStart: number;
  status: HunkStatus;
}

function buildHunks(diff: RawDiffLine[]): Hunk[] {
  // Find indices of changed lines
  const changedIndices = diff
    .map((l, i) => (l.kind !== 'unchanged' ? i : -1))
    .filter((i) => i >= 0);

  if (changedIndices.length === 0) return [];

  // Group changed indices into clusters (within CONTEXT_LINES*2+1 of each other)
  const clusters: number[][] = [];
  let current: number[] = [changedIndices[0]!];

  for (let k = 1; k < changedIndices.length; k++) {
    const prev = changedIndices[k - 1]!;
    const cur = changedIndices[k]!;
    if (cur - prev <= CONTEXT_LINES * 2 + 1) {
      current.push(cur);
    } else {
      clusters.push(current);
      current = [cur];
    }
  }
  clusters.push(current);

  // For each cluster, expand with context lines
  const hunks: Hunk[] = clusters.map((cluster, hunkIdx) => {
    const first = cluster[0]!;
    const last = cluster[cluster.length - 1]!;
    const startIdx = Math.max(0, first - CONTEXT_LINES);
    const endIdx = Math.min(diff.length - 1, last + CONTEXT_LINES);

    const lines = diff.slice(startIdx, endIdx + 1);

    // Find original and modified start lines for the hunk header
    const firstChanged = lines.find((l) => l.kind !== 'unchanged');
    const origStart = firstChanged
      ? (firstChanged.kind === 'removed'
          ? firstChanged.origLine
          : (lines.find((l) => l.origLine > 0)?.origLine ?? 1))
      : (lines[0]?.origLine ?? 1);
    const modStart = firstChanged
      ? (firstChanged.kind === 'added'
          ? firstChanged.modLine
          : (lines.find((l) => l.modLine > 0)?.modLine ?? 1))
      : (lines[0]?.modLine ?? 1);

    return {
      id: hunkIdx,
      lines,
      origStart,
      modStart,
      status: 'pending' as HunkStatus,
    };
  });

  return hunks;
}

/**
 * Apply hunk decisions to compute the final code.
 * - accepted hunks: keep the new lines (additions stay, removals go)
 * - rejected hunks: revert to original lines (removals stay, additions go)
 * - pending hunks: keep the new lines (treated as accepted for preview)
 */
function applyHunks(original: string, modified: string, hunks: Hunk[]): string {
  const aLines = original.split('\n');
  const bLines = modified.split('\n');

  // Build full diff with hunk assignments
  const fullDiff = lcsLineDiff(aLines, bLines);

  // Determine which hunk contains each diff index
  let hunkForIdx = new Array(fullDiff.length).fill(-1) as number[];
  for (const hunk of hunks) {
    // Find where this hunk's first changed line appears in the full diff
    const firstChanged = hunk.lines.find((l) => l.kind !== 'unchanged');
    if (!firstChanged) continue;
    for (let idx = 0; idx < fullDiff.length; idx++) {
      const dl = fullDiff[idx]!;
      if (dl.kind === firstChanged.kind &&
          dl.text === firstChanged.text &&
          (firstChanged.kind === 'removed' ? dl.origLine === firstChanged.origLine : dl.modLine === firstChanged.modLine)) {
        // Mark all lines of this hunk's change cluster
        for (const hunkLine of hunk.lines.filter((l) => l.kind !== 'unchanged')) {
          for (let j = 0; j < fullDiff.length; j++) {
            const fdl = fullDiff[j]!;
            if (fdl.kind === hunkLine.kind && fdl.text === hunkLine.text &&
                (hunkLine.kind === 'removed' ? fdl.origLine === hunkLine.origLine : fdl.modLine === hunkLine.modLine)) {
              hunkForIdx[j] = hunk.id;
            }
          }
        }
        break;
      }
    }
  }

  // Build result: for each diff line, decide whether to include it
  const resultLines: string[] = [];
  for (let idx = 0; idx < fullDiff.length; idx++) {
    const dl = fullDiff[idx]!;
    const hunkId = hunkForIdx[idx] ?? -1;
    const hunk = hunkId >= 0 ? hunks.find((h) => h.id === hunkId) : undefined;
    const status = hunk?.status ?? 'pending';

    if (dl.kind === 'unchanged') {
      resultLines.push(dl.text);
    } else if (dl.kind === 'added') {
      // Include additions for accepted or pending hunks; exclude for rejected
      if (status !== 'rejected') resultLines.push(dl.text);
    } else {
      // dl.kind === 'removed'
      // Include removals (original lines) for rejected hunks; exclude for accepted/pending
      if (status === 'rejected') resultLines.push(dl.text);
    }
  }

  return resultLines.join('\n');
}

// ─── Hunk line renderer ───────────────────────────────────────────────────────

interface HunkViewProps {
  hunk: Hunk;
  isSelected: boolean;
}

const HunkView = memo(function HunkView({ hunk, isSelected }: HunkViewProps) {
  const statusIcon =
    hunk.status === 'accepted' ? '✓' :
    hunk.status === 'rejected' ? '✗' :
    isSelected                  ? '▶' : ' ';
  const headerColor =
    hunk.status === 'accepted' ? 'green' :
    hunk.status === 'rejected' ? 'red'   :
    'cyan';

  const origCount = hunk.lines.filter((l) => l.kind !== 'added').length;
  const modCount  = hunk.lines.filter((l) => l.kind !== 'removed').length;

  return (
    <Box flexDirection="column">
      <Text color={headerColor}>
        {statusIcon} @@ -{hunk.origStart},{origCount} +{hunk.modStart},{modCount} @@
        {hunk.status !== 'pending' ? ` [${hunk.status}]` : isSelected ? ' [a=accept r=reject]' : ''}
      </Text>
      {hunk.lines.map((line, i) => {
        const prefix = line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  ';
        const lineColor =
          line.kind === 'added'   ? 'green' :
          line.kind === 'removed' ? 'red'   :
          'gray';
        return (
          <Box key={i}>
            <Text color={lineColor}>{prefix}</Text>
            <Text color={lineColor} wrap="wrap">{line.text}</Text>
          </Box>
        );
      })}
    </Box>
  );
});

// ─── Code view ────────────────────────────────────────────────────────────────

interface Props {
  artifact: Artifact;
  onClose: () => void;
  /**
   * Called when the user presses Enter in diff mode — passes the final code
   * after applying all hunk decisions. The parent (ChatScreen) should update
   * the artifact's code field with this value.
   */
  onApply?: (finalCode: string) => void;
  /** Panel is focused (receives keyboard input) */
  focused?: boolean;
  /** Panel width as percentage of terminal columns (default 50) */
  widthPct?: number;
}

export const ArtifactPanel = memo(function ArtifactPanel({
  artifact,
  onClose,
  onApply,
  focused = false,
  widthPct = 50,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('code');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedHunk, setSelectedHunk] = useState(0);
  const [hunks, setHunks] = useState<Hunk[]>([]);

  const hasDiff = artifact.original !== artifact.code;

  const highlightedLines = useMemo(
    () => highlight(artifact.code, artifact.language).split('\n'),
    [artifact.code, artifact.language],
  );

  // Compute initial hunks when entering diff mode
  const initialHunks = useMemo(() => {
    if (!hasDiff) return [];
    const aLines = artifact.original.split('\n');
    const bLines = artifact.code.split('\n');
    const diff = lcsLineDiff(aLines, bLines);
    return buildHunks(diff);
  }, [artifact.original, artifact.code, hasDiff]);

  const activeHunks = viewMode === 'diff' ? hunks : initialHunks;

  const handleAcceptHunk = useCallback((idx: number) => {
    setHunks((prev) => {
      const h = prev[idx];
      if (!h || h.status !== 'pending') return prev;
      const next = [...prev];
      next[idx] = { ...h, status: 'accepted' };
      return next;
    });
  }, []);

  const handleRejectHunk = useCallback((idx: number) => {
    setHunks((prev) => {
      const h = prev[idx];
      if (!h || h.status !== 'pending') return prev;
      const next = [...prev];
      next[idx] = { ...h, status: 'rejected' };
      return next;
    });
  }, []);

  const codeLines = artifact.code.split('\n');
  const totalLines = viewMode === 'code' ? codeLines.length : activeHunks.length;
  const maxScroll = Math.max(0, totalLines - MAX_PANEL_HEIGHT);

  useInput(
    (input, key) => {
      if (!focused) return;

      if (key.escape) { onClose(); return; }

      // Toggle diff view
      if (input === 'v' && hasDiff) {
        if (viewMode === 'code') {
          // Entering diff mode — initialize hunks from current state
          setHunks(initialHunks);
          setSelectedHunk(0);
        }
        setViewMode((m) => (m === 'code' ? 'diff' : 'code'));
        setScrollOffset(0);
        return;
      }

      if (viewMode === 'diff') {
        const hunkCount = activeHunks.length;

        // Navigate hunks with ↑/↓ or k/j
        if (key.upArrow || input === 'k') {
          setSelectedHunk((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setSelectedHunk((s) => Math.min(hunkCount - 1, s + 1));
          return;
        }

        // Accept / reject selected hunk
        if (input === 'a') { handleAcceptHunk(selectedHunk); return; }
        if (input === 'r') { handleRejectHunk(selectedHunk); return; }

        // Accept / reject all pending
        if (input === 'A') {
          setHunks((prev) => prev.map((h) => h.status === 'pending' ? { ...h, status: 'accepted' as HunkStatus } : h));
          return;
        }
        if (input === 'R') {
          setHunks((prev) => prev.map((h) => h.status === 'pending' ? { ...h, status: 'rejected' as HunkStatus } : h));
          return;
        }

        // Apply and emit final code
        if (key.return && onApply !== undefined) {
          const finalCode = applyHunks(artifact.original, artifact.code, activeHunks);
          onApply(finalCode);
          onClose();
          return;
        }

        return;
      }

      // Code view: scroll
      if (key.upArrow || input === 'k') {
        setScrollOffset((s) => Math.max(0, s - SCROLL_STEP));
        return;
      }
      if (key.downArrow || input === 'j') {
        setScrollOffset((s) => Math.min(maxScroll, s + SCROLL_STEP));
        return;
      }
    },
  );

  const langLabel = artifact.language.length > 0 ? artifact.language : 'code';
  const title = artifact.title.length > 0 ? artifact.title : langLabel;

  const pendingHunks  = activeHunks.filter((h) => h.status === 'pending').length;
  const acceptedHunks = activeHunks.filter((h) => h.status === 'accepted').length;
  const rejectedHunks = activeHunks.filter((h) => h.status === 'rejected').length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? '#60A5FA' : '#334155'}
      flexShrink={0}
      width={`${widthPct}%`}
    >
      {/* Panel header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="#60A5FA">{title}</Text>
        <Box>
          {hasDiff && (
            <Text dimColor>
              {viewMode === 'code' ? '[v: diff]' : '[v: code]'}
              {'  '}
            </Text>
          )}
          {focused ? (
            viewMode === 'diff' ? (
              <Text dimColor>[j/k nav] [a accept] [r reject] [A/R all] [Enter apply] [Esc close]</Text>
            ) : (
              <Text dimColor>[Tab: focus chat]  [Esc: close]  [[ shrink  [] grow]</Text>
            )
          ) : (
            <Text dimColor>[Tab: focus panel]  [Esc: close]  [[ shrink  [] grow]</Text>
          )}
        </Box>
      </Box>

      {/* View mode indicator */}
      <Box paddingX={1}>
        <Text color="#475569">
          {langLabel}
          {viewMode === 'diff' ? (
            <>
              {'  (diff view)'}
              {activeHunks.length > 0 && (
                <>
                  {`  ${activeHunks.length} hunk${activeHunks.length !== 1 ? 's' : ''}`}
                  {acceptedHunks > 0 && <Text color="green"> ✓{acceptedHunks}</Text>}
                  {rejectedHunks > 0 && <Text color="red"> ✗{rejectedHunks}</Text>}
                  {pendingHunks > 0 && <Text color="gray"> ?{pendingHunks}</Text>}
                </>
              )}
            </>
          ) : (
            totalLines > MAX_PANEL_HEIGHT ? `  ↕ ${scrollOffset + 1}/${totalLines}` : ''
          )}
        </Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" paddingX={1} overflow="hidden">
        {viewMode === 'code' ? (
          <Text>{highlightedLines.slice(scrollOffset, scrollOffset + MAX_PANEL_HEIGHT).join('\n')}</Text>
        ) : activeHunks.length === 0 ? (
          <Text dimColor>(no changes to review)</Text>
        ) : (
          activeHunks.map((hunk, i) => (
            <HunkView key={hunk.id} hunk={hunk} isSelected={i === selectedHunk} />
          ))
        )}
      </Box>
    </Box>
  );
});
