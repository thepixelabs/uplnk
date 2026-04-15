import type { Config } from '../../lib/config.js';

export interface TargetConfig {
  /** Canonical name, used as a lookup key */
  name: string;
  /** Human-readable name for the UI */
  displayName: string;
  /** Command + args to spawn the target CLI (PTY/pipe transports) */
  launch: string[];
  /** Regex that matches when the target is ready for input */
  readyRegex: string;
  /** String literal that indicates the prompt is visible */
  promptMarker?: string;
  /** Keys to send to gracefully quit the target */
  quitKeys?: string;
  /** Hint about which AI provider this target talks to */
  providerHint?: string;
}

export const BUILTIN_TARGETS: Record<string, TargetConfig> = {
  'claude-code': {
    name: 'claude-code',
    displayName: 'Claude Code',
    launch: ['claude'],
    readyRegex: '\\$|>|\\?',
    promptMarker: '> ',
    quitKeys: 'q',
    providerHint: 'anthropic',
  },
  gemini: {
    name: 'gemini',
    displayName: 'Gemini CLI',
    launch: ['gemini'],
    readyRegex: '\\$|>',
    quitKeys: 'q',
    providerHint: 'google',
  },
  codex: {
    name: 'codex',
    displayName: 'OpenAI Codex',
    launch: ['codex'],
    readyRegex: '\\$|>',
    quitKeys: 'q',
    providerHint: 'openai',
  },
};

/**
 * Resolve a target name to a TargetConfig. Looks up built-in targets first,
 * then falls through to user-defined custom targets from config.
 *
 * When neither matches, returns the claude-code default — it's the most common
 * use case and a better UX than throwing.
 */
export function resolveTarget(
  name: string,
  customTargets?: Config['robotic']['targets'],
): TargetConfig {
  // Built-ins take precedence over user config — prevents name shadowing
  if (name in BUILTIN_TARGETS) return BUILTIN_TARGETS[name]!;

  if (customTargets !== undefined && name in customTargets) {
    const ct = customTargets[name]!;
    // User config uses a single `launch` string; split into args array
    const resolved: TargetConfig = {
      name,
      displayName: name,
      launch: ct.launch.split(/\s+/),
      readyRegex: ct.readyRegex,
      quitKeys: ct.quitKeys,
    };
    if (ct.promptMarker !== undefined) {
      resolved.promptMarker = ct.promptMarker;
    }
    return resolved;
  }

  return BUILTIN_TARGETS['claude-code']!;
}
