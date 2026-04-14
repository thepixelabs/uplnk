import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ChatInput } from '../ChatInput.js';

vi.mock('../../voice/VoiceAssistantProvider.js', () => ({
  useVoiceAssistant: vi.fn(() => ({
    isInitialized: false,
    isDictating: false,
    partialTranscription: '',
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    toggleDictation: vi.fn(),
    registerTranscriptionHandler: vi.fn(() => vi.fn()),
    error: null,
    statusMessage: null,
  })),
  VoiceAssistantProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('ChatInput', () => {
  it('renders without errors', () => {
    const { lastFrame } = render(
      React.createElement(ChatInput, { onSubmit: vi.fn() }),
    );
    expect(lastFrame()).toBeTruthy();
  });

  it('shows placeholder text when empty and enabled', () => {
    const { lastFrame } = render(
      React.createElement(ChatInput, { onSubmit: vi.fn(), disabled: false }),
    );
    expect(lastFrame()).toContain('type a message');
  });

  it('shows streaming indicator when disabled', () => {
    const { lastFrame } = render(
      React.createElement(ChatInput, { onSubmit: vi.fn(), disabled: true }),
    );
    expect(lastFrame()).toContain('streaming');
  });

  it('shows /model hint in placeholder', () => {
    const { lastFrame } = render(
      React.createElement(ChatInput, { onSubmit: vi.fn() }),
    );
    expect(lastFrame()).toContain('/model');
  });
});
