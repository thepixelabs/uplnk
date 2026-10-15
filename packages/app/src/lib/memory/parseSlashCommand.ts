/**
 * parseRememberCommand — detect an EXPLICIT memory-save command in user input.
 *
 * Two forms, both case-insensitive and whitespace-tolerant:
 *   /remember <text>
 *   remember: <text>
 *
 * Returns the captured text trimmed, or null when the input is anything else.
 * Whoever wires this in Wave 2 should ALSO check the natural-language signal
 * detector before passing the message through to the LLM — the two are
 * complementary triggers, not competitors.
 */

const SLASH_RE = /^\s*\/remember\s+(.+?)\s*$/is;
const COLON_RE = /^\s*remember:\s*(.+?)\s*$/is;

export interface RememberCommand {
  save: string;
}

export function parseRememberCommand(input: string): RememberCommand | null {
  const slash = SLASH_RE.exec(input);
  if (slash !== null && slash[1] !== undefined) {
    const save = slash[1].trim();
    return save.length > 0 ? { save } : null;
  }
  const colon = COLON_RE.exec(input);
  if (colon !== null && colon[1] !== undefined) {
    const save = colon[1].trim();
    return save.length > 0 ? { save } : null;
  }
  return null;
}
