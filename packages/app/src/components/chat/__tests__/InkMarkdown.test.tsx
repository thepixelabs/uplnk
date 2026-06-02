/**
 * InkMarkdown component tests.
 *
 * ink-testing-library renders Ink trees to a terminal string, so we can assert
 * on the visible output (minus ANSI codes that the testing library strips).
 * These tests cover:
 *   - Plain text passthrough
 *   - Bold, italic, bold-italic
 *   - Inline code
 *   - H1, H2, H3 headers
 *   - Unordered lists
 *   - Ordered lists
 *   - Strikethrough (del)
 *   - Mixed inline styles
 *   - Mid-stream unclosed markers (must not throw)
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { InkMarkdown } from '../InkMarkdown.js';

// Helper: render the component and return the last frame string.
function frame(text: string): string {
  const { lastFrame } = render(React.createElement(InkMarkdown, { text }));
  return lastFrame() ?? '';
}

describe('InkMarkdown', () => {
  // ── Plain text ──────────────────────────────────────────────────────────────

  it('renders plain text unchanged', () => {
    expect(frame('Hello world')).toContain('Hello world');
  });

  it('renders an empty string without throwing', () => {
    expect(() => frame('')).not.toThrow();
  });

  // ── Bold ────────────────────────────────────────────────────────────────────

  it('renders **bold** text (asterisk syntax)', () => {
    const out = frame('This is **bold** text.');
    // The word 'bold' must appear in the output.
    expect(out).toContain('bold');
    // Surrounding plain text must still be present.
    expect(out).toContain('This is');
    expect(out).toContain('text.');
  });

  it('renders __bold__ text (underscore syntax)', () => {
    const out = frame('__bold__');
    expect(out).toContain('bold');
  });

  // ── Italic ──────────────────────────────────────────────────────────────────

  it('renders *italic* text (asterisk syntax)', () => {
    const out = frame('*italic*');
    expect(out).toContain('italic');
  });

  it('renders _italic_ text (underscore syntax)', () => {
    const out = frame('_italic_');
    expect(out).toContain('italic');
  });

  // ── Bold-italic ─────────────────────────────────────────────────────────────

  it('renders ***bold-italic*** text', () => {
    const out = frame('***bold-italic***');
    expect(out).toContain('bold-italic');
  });

  it('renders ___bold-italic___ text (underscore syntax)', () => {
    const out = frame('___bold-italic___');
    expect(out).toContain('bold-italic');
  });

  // ── Inline code ─────────────────────────────────────────────────────────────

  it('renders `inline code` with backtick delimiters visible', () => {
    const out = frame('Run `npm install` now.');
    // We render inline code as `text` so the backticks appear in the output.
    expect(out).toContain('`npm install`');
    // The surrounding sentence must still be present.
    expect(out).toContain('Run');
    expect(out).toContain('now.');
  });

  // ── Headers ─────────────────────────────────────────────────────────────────

  it('renders H1 with # prefix', () => {
    const out = frame('# Title One');
    expect(out).toContain('# Title One');
  });

  it('renders H2 with ## prefix', () => {
    const out = frame('## Section Two');
    expect(out).toContain('## Section Two');
  });

  it('renders H3 with ### prefix', () => {
    const out = frame('### Subsection Three');
    expect(out).toContain('### Subsection Three');
  });

  // ── Unordered lists ─────────────────────────────────────────────────────────

  it('renders unordered list items with • bullet', () => {
    const out = frame('- first\n- second\n- third');
    expect(out).toContain('•');
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).toContain('third');
  });

  it('renders * unordered list items with • bullet', () => {
    const out = frame('* alpha\n* beta');
    expect(out).toContain('•');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  // ── Ordered lists ───────────────────────────────────────────────────────────

  it('renders ordered list items with numbers', () => {
    const out = frame('1. one\n2. two\n3. three');
    expect(out).toContain('1.');
    expect(out).toContain('2.');
    expect(out).toContain('3.');
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('three');
  });

  // ── Nested lists ────────────────────────────────────────────────────────────

  it('renders one level of nested sub-list beneath the parent item', () => {
    // The sub-list marker is indented by two spaces (standard markdown nesting).
    const md = '- a\n  - b';
    const out = frame(md);
    expect(out).toContain('•');
    expect(out).toContain('a');
    // Sub-list item 'b' must appear — it was previously silently dropped because
    // the nested list token fell through to renderInlineTokens as raw markdown.
    expect(out).toContain('b');
  });

  // ── Strikethrough ───────────────────────────────────────────────────────────

  it('renders ~~strikethrough~~ text (content visible)', () => {
    const out = frame('~~deleted~~');
    expect(out).toContain('deleted');
  });

  // ── Mixed styles ────────────────────────────────────────────────────────────

  it('handles a paragraph mixing bold, italic, and code', () => {
    const out = frame('**bold**, *italic*, and `code` in one line.');
    expect(out).toContain('bold');
    expect(out).toContain('italic');
    expect(out).toContain('code');
    expect(out).toContain('in one line.');
  });

  it('renders multiple block elements together', () => {
    const md = '# Heading\n\nA paragraph.\n\n- list item';
    const out = frame(md);
    expect(out).toContain('Heading');
    expect(out).toContain('A paragraph.');
    expect(out).toContain('list item');
    expect(out).toContain('•');
  });

  // ── Streaming safety (unclosed markers) ────────────────────────────────────

  it('does not throw on an unclosed **bold marker mid-stream', () => {
    const out = frame('hello **wor');
    expect(out).toContain('hello');
    // The partial marker must appear verbatim — marked must not promote the
    // incomplete run to a bold token. This pins the no-premature-bold invariant.
    expect(out).toContain('**wor');
  });

  it('does not throw on an unclosed *italic marker mid-stream', () => {
    const out = frame('hello *ital');
    expect(out).toContain('hello');
    // Same invariant for italic: the raw marker characters must be preserved.
    expect(out).toContain('*ital');
  });

  it('does not throw on an unclosed # header mid-stream', () => {
    expect(() => frame('# Partial head')).not.toThrow();
  });

  it('does not throw on truncated list item', () => {
    expect(() => frame('- item one\n- partial')).not.toThrow();
    expect(frame('- item one\n- partial')).toContain('item one');
  });

  it('does not throw on completely empty mid-stream state', () => {
    expect(() => frame(' ')).not.toThrow();
  });

  it('does not crash on deeply nested or pathological input', () => {
    expect(() => frame('***__**x**__***')).not.toThrow();
  });

  // ── Blockquote ──────────────────────────────────────────────────────────────

  it('renders single-line blockquote with a left bar character', () => {
    const out = frame('> quoted line');
    expect(out).toContain('quoted line');
    // Ink's borderStyle="single" emits │ as the left-border character.
    expect(out).toContain('│');
  });

  it('renders multi-line blockquote with the bar present on every line', () => {
    // Two separate quoted paragraphs force a multi-line layout. The borderLeft
    // Box approach scales the │ to the full content height via Yoga layout,
    // unlike the old sibling-Text approach which only rendered the bar on line 1.
    const out = frame('> line one\n>\n> line two');
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    const lines = out.split('\n').filter(l => l.trim() !== '');
    const contentLines = lines.filter(
      l => l.includes('line one') || l.includes('line two'),
    );
    // Every content-bearing line must have a │ character on the same line.
    for (const l of contentLines) {
      expect(l).toContain('│');
    }
  });
});
