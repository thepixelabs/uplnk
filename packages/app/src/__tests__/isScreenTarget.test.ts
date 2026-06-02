/**
 * isScreenTarget is the gate that decides whether a string handed to App's
 * handleNavigate is a renderable screen (setCurrentScreen) or a chat-level
 * command that needs to be dispatched to ChatScreen (pendingChatCommand).
 *
 * Getting the membership wrong causes the palette to either land on a blank
 * screen ('mcp' / 'fork' false-positively routed as a screen) or to swallow
 * a legitimate screen jump as a no-op command. Lock the table here.
 */

import { describe, it, expect } from 'vitest';
import { isScreenTarget } from '../lib/navigation.js';

describe('isScreenTarget', () => {
  it.each([
    'chat',
    'model-selector',
    'conversations',
    'provider-selector',
    'settings',
    'add-provider',
    'edit-provider',
    'relay-picker',
    'relay-run',
    'relay-editor',
    'network-scan',
    'flow-list',
    'flow-run',
    'altergo',
    'robotic',
  ])('treats %s as a renderable screen', (name) => {
    expect(isScreenTarget(name)).toBe(true);
  });

  it.each([
    'mcp',
    'fork',
    'fork:3',
    'compact',
    'help',
    'export',
    'export:json',
    'export:markdown',
    'role:code-reviewer',
    'role:clear',
    '',
    'unknown-thing',
  ])('routes %s as a chat-level command (not a screen)', (cmd) => {
    expect(isScreenTarget(cmd)).toBe(false);
  });
});
