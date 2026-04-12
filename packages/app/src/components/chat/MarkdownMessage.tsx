/**
 * MarkdownMessage — renders assistant text with code block syntax highlighting.
 *
 * Code fences (``` ... ```) are extracted and rendered with:
 *   - A language label header
 *   - Chalk syntax highlighting applied via the highlight() function
 *   - A distinct border to visually separate code from prose
 *
 * Large code blocks (>= PROMOTE_THRESHOLD lines) display an "expand" hint
 * and can trigger the artifact panel via the onPromote callback.
 *
 * This component is intentionally memo-wrapped because it may re-render
 * frequently during streaming. The parseMarkdown + highlight work is
 * memoised via useMemo.
 */

import { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import { parseMarkdown } from '../../lib/syntax.js';
import { PROMOTE_THRESHOLD } from '../../hooks/useArtifacts.js';
import type { Artifact } from '../artifacts/ArtifactPanel.js';

interface Props {
  text: string;
  /** When true, skip parsing and render raw — used for user messages */
  raw?: boolean;
  /** Called when a large code block should be promoted to artifact panel */
  onPromote?: (artifact: Artifact) => void;
  /** Source message id — used for artifact id generation */
  messageId?: string;
}

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  raw = false,
  onPromote,
  messageId: _messageId,
}: Props) {
  const segments = useMemo(
    () => (raw ? [{ kind: 'text' as const, text }] : parseMarkdown(text)),
    [text, raw],
  );

  return (
    <Box flexDirection="column">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return (
            <Text key={i} wrap="wrap">
              {seg.text}
            </Text>
          );
        }

        // Code block
        const langLabel = seg.language.length > 0 ? seg.language : 'code';
        const lineCount = seg.text.split('\n').length;
        const isLarge = lineCount >= PROMOTE_THRESHOLD;

        // For large blocks, truncate to first 10 lines in inline view
        const displayCode = isLarge
          ? seg.highlighted.split('\n').slice(0, 10).join('\n') + '\n…'
          : seg.highlighted;

        return (
          <Box key={i} flexDirection="column" marginY={1}>
            {/* Language label header */}
            <Box paddingX={1} borderStyle="single" borderColor="#334155">
              <Text color="#475569">{langLabel}</Text>
              {isLarge && (
                <Text dimColor>  {lineCount} lines  [Enter to expand]</Text>
              )}
            </Box>
            {/* Code content — pre-highlighted with chalk ANSI codes */}
            <Box paddingX={1} borderStyle="single" borderColor="#1E293B" borderTop={false}>
              <Text>{displayCode}</Text>
            </Box>
            {isLarge && onPromote !== undefined && (
              <Box paddingX={1}>
                <Text dimColor>  press E to expand in panel</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
});
