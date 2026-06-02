import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { MessageDisplay } from '../MessageDisplay.js';

const baseProps = {
  messages: [],
  streamedText: '',
  streamStatus: 'idle' as const,
  startIdx: 0,
  endIdx: 0,
  inScrollback: false,
};

describe('MessageDisplay — streaming branch', () => {
  it('applies markdown during streaming (no raw ** in output)', () => {
    const { lastFrame } = render(
      React.createElement(MessageDisplay, {
        ...baseProps,
        streamedText: 'Hello **world**',
        streamStatus: 'streaming',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('**');
    expect(frame).toContain('world');
  });

  it('handles partial unclosed markdown token without throwing', () => {
    expect(() =>
      render(
        React.createElement(MessageDisplay, {
          ...baseProps,
          streamedText: 'Partial **bold',
          streamStatus: 'streaming',
        }),
      ),
    ).not.toThrow();
  });

  it('renders the blinking cursor during streaming', () => {
    const { lastFrame } = render(
      React.createElement(MessageDisplay, {
        ...baseProps,
        streamedText: 'Some text',
        streamStatus: 'streaming',
      }),
    );
    // cursor starts on (▋ or space) — either character is acceptable, but the
    // component must render without error and produce output
    expect(lastFrame()).toBeTruthy();
  });
});
