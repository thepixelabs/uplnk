import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Header } from '../Header.js';

describe('Header', () => {
  it('shows version, cwd, title, model, and connectivity details', () => {
    const home = process.env.HOME ?? '/Users/netz';
    const { lastFrame } = render(
      React.createElement(Header, {
        modelName: 'llama3.2',
        conversationTitle: 'Refactor auth middleware',
        currentDirectory: `${home}/Documents/git/uplnk`,
        version: '0.3.0',
        connectionLabel: 'server connected · 182ms',
        connectionDetail: 'llm.example.com:11434',
        connectionColor: '#22C55E',
      }),
    );

    const frame = lastFrame();
    expect(frame).toContain('UPLNK');
    expect(frame).toContain('v0.3.0');
    expect(frame).toContain('cwd ~/Documents/git/uplnk');
    expect(frame).toContain('Refactor');
    expect(frame).toContain('llama3.2');
    expect(frame).toContain('server');
    expect(frame).toContain('182ms');
    expect(frame).toContain('llm.example.com:11434');
  });
});
