/**
 * Navigation taxonomy shared by App's handleNavigate and the Ctrl+K palette.
 *
 * Targets either point at a renderable screen (handleNavigate switches
 * currentScreen) or describe a chat-level command (fork, mcp, help, role:*,
 * export:*) that ChatScreen must execute. The split lives here so the
 * dispatch decision is one place and easy to unit-test without dragging
 * the whole React tree into the test.
 */

export type Screen =
  | 'chat'
  | 'model-selector'
  | 'conversations'
  | 'provider-selector'
  | 'settings'
  | 'add-provider'
  | 'edit-provider'
  | 'relay-picker'
  | 'relay-run'
  | 'relay-editor'
  | 'network-scan'
  | 'flow-list'
  | 'flow-run'
  | 'altergo'
  | 'robotic';

const SCREEN_TARGETS: ReadonlySet<Screen> = new Set([
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
]);

/**
 * True when `target` names a screen that App can `setCurrentScreen` to.
 * False for chat-level commands (fork, mcp, help, role:*, export:*, …),
 * which App must hand off to ChatScreen via the pendingChatCommand
 * channel instead — otherwise the palette dispatches a command, App sets
 * currentScreen to a value no render branch matches, and the user sees a
 * blank frame until they press Esc.
 */
export function isScreenTarget(target: string): target is Screen {
  return SCREEN_TARGETS.has(target as Screen);
}
