/**
 * InkMarkdown — renders inline markdown as Ink primitives.
 *
 * Uses the marked lexer (block + inline token tree) to walk markdown and
 * produce <Text bold>, <Text italic>, etc. rather than an ANSI string.
 * Keeping each styled run as its own <Text> node lets Ink handle word-wrap
 * correctly — pre-concatenating to an ANSI string would break Ink's layout.
 *
 * Design contract:
 * - Block-level tokens (heading, paragraph, list, space) each become a <Box>
 *   with flexDirection="column".
 * - Inline tokens within a paragraph are collected into a single <Text wrap="wrap">
 *   so the whole paragraph wraps together.
 * - Code fences must already have been stripped out by parseMarkdown() before
 *   this component is called. Only inline code (single backtick) is handled here.
 * - Streaming-safe: unclosed markers produce incomplete tokens which marked
 *   wraps as plain text — so a mid-stream "hello **wor" never throws.
 * - All rendering is wrapped in try/catch; on any parse error the raw text
 *   is returned as a bare <Text>.
 *
 * Color palette (matches existing components):
 *   H1         bold + #60A5FA (matches the 'uplnk' label color)
 *   H2         bold + #A78BFA (lighter violet — scrollback cursor color)
 *   H3         bold + #94A3B8 (slate 400 — dimmed but distinct)
 *   inline code  #86EFAC on bg dim (green 300 — matches syntax.ts string color)
 *   bullet/num   #475569 (slate 600 — same as code border color)
 *   strikethrough uses Ink's native strikethrough={true} prop
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';

// ─── Inline token renderer ────────────────────────────────────────────────────

/**
 * Walk a list of inline tokens and return an array of React nodes.
 * These nodes are designed to be placed inside a wrapping <Text wrap="wrap">.
 */
function renderInlineTokens(
  tokens: Token[],
  key: string,
  ctx: InlineCtx,
): React.ReactNode[] {
  return tokens.map((tok, i) => renderInlineToken(tok, `${key}-${i}`, ctx));
}

interface InlineCtx {
  bold?: boolean;
  italic?: boolean;
}

function renderInlineToken(tok: Token, key: string, ctx: InlineCtx): React.ReactNode {
  switch (tok.type) {
    case 'text': {
      const t = tok as Tokens.Text;
      // Text tokens may themselves carry nested inline tokens (e.g. inside a list item).
      if (t.tokens !== undefined && t.tokens.length > 0) {
        return (
          <React.Fragment key={key}>
            {renderInlineTokens(t.tokens, key, ctx)}
          </React.Fragment>
        );
      }
      return renderStyledText(t.text, key, ctx);
    }
    case 'strong': {
      const t = tok as Tokens.Strong;
      const inner = renderInlineTokens(t.tokens, key, { ...ctx, bold: true });
      return (
        <Text key={key} bold={true} {...(ctx.italic === true ? { italic: true } : {})}>
          {inner}
        </Text>
      );
    }
    case 'em': {
      const t = tok as Tokens.Em;
      const inner = renderInlineTokens(t.tokens, key, { ...ctx, italic: true });
      return (
        <Text key={key} italic={true} {...(ctx.bold === true ? { bold: true } : {})}>
          {inner}
        </Text>
      );
    }
    case 'codespan': {
      const t = tok as Tokens.Codespan;
      // Inline code: green text (matches string color in syntax.ts), dimmed background.
      return (
        <Text key={key} color="#86EFAC">
          {`\`${t.text}\``}
        </Text>
      );
    }
    case 'del': {
      const t = tok as Tokens.Del;
      const inner = renderInlineTokens(t.tokens, key, ctx);
      return (
        <Text key={key} strikethrough={true}>
          {inner}
        </Text>
      );
    }
    case 'br': {
      return <Text key={key}>{'\n'}</Text>;
    }
    case 'escape': {
      const t = tok as Tokens.Escape;
      return renderStyledText(t.text, key, ctx);
    }
    case 'link': {
      // Render link text only — terminal can't open URLs interactively.
      const t = tok as Tokens.Link;
      const inner = renderInlineTokens(t.tokens, key, ctx);
      return (
        <Text key={key} color="#60A5FA">
          {inner}
        </Text>
      );
    }
    default: {
      // Unknown / future token types — fall back to raw text.
      const raw = (tok as { raw?: string }).raw ?? '';
      return renderStyledText(raw, key, ctx);
    }
  }
}

function renderStyledText(text: string, key: string, ctx: InlineCtx): React.ReactNode {
  if (ctx.bold === true && ctx.italic === true) {
    return <Text key={key} bold italic>{text}</Text>;
  }
  if (ctx.bold === true) {
    return <Text key={key} bold>{text}</Text>;
  }
  if (ctx.italic === true) {
    return <Text key={key} italic>{text}</Text>;
  }
  // No special style — just a fragment so the parent <Text wrap> sees plain text.
  return <React.Fragment key={key}>{text}</React.Fragment>;
}

// ─── Heading colors ───────────────────────────────────────────────────────────

const HEADING_COLORS: Record<number, string> = {
  1: '#60A5FA', // Blue 400 — matches the 'uplnk' label
  2: '#A78BFA', // Violet 400 — lighter accent
  3: '#94A3B8', // Slate 400 — subdued but distinct
};

function headingColor(depth: number): string {
  return HEADING_COLORS[depth] ?? '#94A3B8';
}

// ─── Block token renderer ─────────────────────────────────────────────────────

function renderBlockToken(tok: Token, index: number): React.ReactNode {
  switch (tok.type) {
    case 'space': {
      return null;
    }
    case 'heading': {
      const t = tok as Tokens.Heading;
      const prefix = '#'.repeat(t.depth) + ' ';
      const inline = renderInlineTokens(t.tokens, `h${index}`, {});
      return (
        <Box key={index} flexDirection="column" marginBottom={1}>
          <Text bold color={headingColor(t.depth)} wrap="wrap">
            {prefix}
            {inline}
          </Text>
        </Box>
      );
    }
    case 'paragraph': {
      const t = tok as Tokens.Paragraph;
      const inline = renderInlineTokens(t.tokens, `p${index}`, {});
      return (
        <Box key={index} marginBottom={1}>
          <Text wrap="wrap">
            {inline}
          </Text>
        </Box>
      );
    }
    case 'list': {
      const t = tok as Tokens.List;
      return (
        <Box key={index} flexDirection="column" marginBottom={1}>
          {t.items.map((item, itemIdx) => renderListItem(item, itemIdx, t.ordered, t.start))}
        </Box>
      );
    }
    case 'code': {
      // A code fence that managed to slip through (e.g. the text segment ends
      // mid-fence and marked creates a code block from incomplete input).
      // Render as a dimmed verbatim block rather than crashing.
      const t = tok as Tokens.Code;
      return (
        <Box key={index} flexDirection="column" marginBottom={1}>
          <Text dimColor wrap="wrap">
            {t.text}
          </Text>
        </Box>
      );
    }
    case 'blockquote': {
      const t = tok as Tokens.Blockquote;
      const inner = t.tokens.map((child, ci) => renderBlockToken(child, ci));
      return (
        // borderLeft on the wrapping Box produces a left rule that scales to the
        // full height of the content via Yoga's own layout — a sibling <Text>
        // node does not stretch, so the old flexDirection="row" + │ Text approach
        // only rendered the bar on line 1 of multi-line blockquotes.
        <Box
          key={index}
          borderStyle="single"
          borderLeft={true}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderLeftColor="#475569"
          paddingLeft={1}
          marginBottom={1}
          flexDirection="column"
        >
          {inner}
        </Box>
      );
    }
    case 'hr': {
      // Horizontal rule — three em-dashes as a compact symbolic separator.
      // We avoid reading terminal width or using a <Box borderStyle> here because
      // borderStyle adds a full-width box frame rather than a single rule, and
      // dynamic width detection would couple us to process.stdout which is
      // unavailable in test environments. Three dashes are unambiguous as a
      // separator at any column width.
      return (
        <Box key={index} marginBottom={1}>
          <Text dimColor>{'───'}</Text>
        </Box>
      );
    }
    default: {
      // html, table, def, or unknown — render raw text.
      const raw = (tok as { raw?: string }).raw ?? '';
      if (!raw) return null;
      return (
        <Box key={index} marginBottom={1}>
          <Text wrap="wrap">{raw}</Text>
        </Box>
      );
    }
  }
}

function renderListItem(
  item: Tokens.ListItem,
  itemIdx: number,
  ordered: boolean,
  start: number | '',
): React.ReactNode {
  const bullet = ordered
    ? `${typeof start === 'number' ? start + itemIdx : itemIdx + 1}. `
    : '• ';

  // Separate the item's children into inline tokens (for the text line) and
  // nested block tokens (sub-lists, blockquotes, etc.) that render beneath it.
  const inlineSourceTokens: Token[] = [];
  const nestedBlocks: Token[] = [];

  for (const t of item.tokens) {
    if (t.type === 'list') {
      // A nested list renders as a block beneath the item's inline text.
      nestedBlocks.push(t);
    } else if (t.type === 'text') {
      // Text tokens carry their own inline sub-tokens; unwrap them so the
      // parent <Text wrap> sees a flat inline sequence.
      const tt = t as Tokens.Text;
      if (tt.tokens !== undefined && tt.tokens.length > 0) {
        inlineSourceTokens.push(...tt.tokens);
      } else {
        inlineSourceTokens.push(t);
      }
    } else {
      inlineSourceTokens.push(t);
    }
  }

  const inline = renderInlineTokens(inlineSourceTokens, `li${itemIdx}`, {});

  return (
    <Box key={itemIdx} flexDirection="column">
      <Box flexDirection="row">
        <Text color="#475569">{bullet}</Text>
        <Box flexShrink={1}>
          <Text wrap="wrap">{inline}</Text>
        </Box>
      </Box>
      {nestedBlocks.length > 0 && (
        // Indent nested blocks by two spaces to align under the item text.
        <Box flexDirection="column" paddingLeft={2}>
          {nestedBlocks.map((bt, bi) => renderBlockToken(bt, bi))}
        </Box>
      )}
    </Box>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface InkMarkdownProps {
  /** Markdown prose text. Code fences should already be stripped. */
  text: string;
}

/**
 * Render markdown prose text as Ink primitives.
 *
 * Streaming-safe: incomplete tokens (unclosed `**`, mid-paragraph, etc.)
 * degrade gracefully to plain text via marked's own recovery — this component
 * never throws on partial input.
 *
 * Do NOT wrap with React.memo here; MarkdownMessage already memos at the
 * segment level, and the text prop changes every token during streaming.
 */
export function InkMarkdown({ text }: InkMarkdownProps): React.ReactElement {
  try {
    // Lexer.lex() is the block-level parse. gfm:true enables ~~del~~ and tables.
    const tokens = Lexer.lex(text, { gfm: true });
    const blocks = tokens.map((tok, i) => renderBlockToken(tok, i));
    return <Box flexDirection="column">{blocks}</Box>;
  } catch {
    // Absolute safety net — if marked ever throws on pathological input,
    // fall back to raw text so the streaming chat doesn't hard-crash.
    return (
      <Box>
        <Text wrap="wrap">{text}</Text>
      </Box>
    );
  }
}
