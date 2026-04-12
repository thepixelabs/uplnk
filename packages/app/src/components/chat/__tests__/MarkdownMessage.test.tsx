import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { MarkdownMessage } from '../MarkdownMessage.js';

describe('MarkdownMessage', () => {
  it('renders plain text', () => {
    const { lastFrame } = render(
      React.createElement(MarkdownMessage, { text: 'Hello world' }),
    );
    expect(lastFrame()).toContain('Hello world');
  });

  it('renders without errors for empty string', () => {
    expect(() =>
      render(React.createElement(MarkdownMessage, { text: '' })),
    ).not.toThrow();
  });

  it('renders code block language label', () => {
    const text = 'Here:\n```typescript\nconst x = 1;\n```';
    const { lastFrame } = render(
      React.createElement(MarkdownMessage, { text }),
    );
    expect(lastFrame()).toContain('typescript');
  });

  it('shows line count for large code blocks', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const text = '```ts\n' + lines + '\n```';
    const { lastFrame } = render(
      React.createElement(MarkdownMessage, { text }),
    );
    // Should mention line count
    expect(lastFrame()).toContain('lines');
  });

  it('renders raw mode without markdown parsing', () => {
    const text = '```ts\nconst x = 1;\n```';
    const { lastFrame } = render(
      React.createElement(MarkdownMessage, { text, raw: true }),
    );
    // In raw mode, the backticks should appear literally
    expect(lastFrame()).toContain('```');
  });
});
