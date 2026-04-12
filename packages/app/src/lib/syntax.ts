/**
 * Terminal syntax highlighter — pure chalk, no external highlighter libs.
 *
 * Design choices:
 * - Zero runtime dependencies beyond chalk (already in tree).
 * - Token regex patterns are good-enough for developer workflows; perfect
 *   parse fidelity is not the goal — visual signal is.
 * - Falls back to plain text for unknown languages.
 * - Never throws; malformed input just renders as plain text.
 */

import chalk from 'chalk';

// ─── Token types ──────────────────────────────────────────────────────────────

type TokenKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'function'
  | 'type'
  | 'number'
  | 'operator'
  | 'plain';

interface Token {
  kind: TokenKind;
  text: string;
}

// ─── Color map ────────────────────────────────────────────────────────────────

const NO_COLOR = process.env['NO_COLOR'] !== undefined;
const LIGHT_THEME = process.env['PYLON_THEME'] === 'light';

function color(dark: string, light?: string): (s: string) => string {
  if (NO_COLOR) return (s) => s;
  const hex = LIGHT_THEME && light !== undefined ? light : dark;
  return (s: string) => chalk.hex(hex)(s);
}

const PALETTE: Record<TokenKind, (s: string) => string> = {
  keyword:  color('#C084FC', '#7C3AED'),  // Purple 400 / Violet 700
  string:   color('#86EFAC', '#15803D'),  // Green 300 / Green 700
  comment:  color('#475569', '#94A3B8'),  // Slate 600 / Slate 400
  function: color('#60A5FA', '#2563EB'),  // Blue 400 / Blue 600
  type:     color('#FCD34D', '#B45309'),  // Amber 300 / Amber 700
  number:   color('#FB923C', '#C2410C'),  // Orange 400 / Orange 700
  operator: color('#94A3B8', '#64748B'),  // Slate 400 / Slate 500
  plain:    color('#E2E8F0', '#1E293B'),  // Slate 200 / Slate 800
};

// ─── Language tokenisers ──────────────────────────────────────────────────────

// Ordered: each rule is tested in order; first match wins.
// Pattern MUST have exactly one capture group — the matched text.
interface Rule {
  kind: TokenKind;
  pattern: RegExp;
}

const JS_TS_RULES: Rule[] = [
  // Line comments
  { kind: 'comment',  pattern: /^(\/\/[^\n]*)/ },
  // Block comments
  { kind: 'comment',  pattern: /^(\/\*[\s\S]*?\*\/)/ },
  // Template literals (must come before string)
  { kind: 'string',   pattern: /^(`(?:[^`\\]|\\.)*`)/ },
  // Double-quoted strings
  { kind: 'string',   pattern: /^("(?:[^"\\]|\\.)*")/ },
  // Single-quoted strings
  { kind: 'string',   pattern: /^('(?:[^'\\]|\\.)*')/ },
  // Keywords
  { kind: 'keyword',  pattern: /^((?:const|let|var|function|class|extends|implements|interface|type|enum|namespace|module|import|export|from|as|default|return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|new|delete|typeof|instanceof|in|of|void|null|undefined|true|false|async|await|yield|static|readonly|private|public|protected|abstract|override|declare|satisfies|keyof|infer|never|unknown|any)\b)/ },
  // Type constructors / built-ins
  { kind: 'type',     pattern: /^((?:string|number|boolean|object|symbol|bigint|Array|Map|Set|Record|Promise|Date|Error|RegExp|URL|Request|Response|Headers|ReadableStream|WritableStream|Uint8Array|Buffer|NodeJS|React|JSX)\b)/ },
  // Function call: word followed by (
  { kind: 'function', pattern: /^([a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())/ },
  // Numbers (hex, float, int, binary, octal)
  { kind: 'number',   pattern: /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/ },
  // Operators
  { kind: 'operator', pattern: /^([=!<>]=?|&&|\|\||[+\-*/&|^~%]=?|=>|\.{3}|[?!:;,[\]{}()])/ },
  // Identifiers
  { kind: 'plain',    pattern: /^([a-zA-Z_$][a-zA-Z0-9_$]*)/ },
  // Whitespace / newlines
  { kind: 'plain',    pattern: /^([ \t\n\r]+)/ },
  // Any other single char
  { kind: 'plain',    pattern: /^([\s\S])/ },
];

const PYTHON_RULES: Rule[] = [
  { kind: 'comment',  pattern: /^(#[^\n]*)/ },
  { kind: 'string',   pattern: /^("""[\s\S]*?"""|'''[\s\S]*?''')/ },
  { kind: 'string',   pattern: /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/ },
  { kind: 'keyword',  pattern: /^((?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b)/ },
  { kind: 'type',     pattern: /^((?:int|float|str|bool|list|dict|tuple|set|bytes|type|object|None|Any|Optional|Union|List|Dict|Tuple|Set|FrozenSet|Callable|TypeVar|Generic|Protocol|ClassVar|Final|Annotated|Literal|TypedDict)\b)/ },
  { kind: 'function', pattern: /^([a-zA-Z_][a-zA-Z0-9_]*(?=\s*\())/ },
  { kind: 'number',   pattern: /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/ },
  { kind: 'operator', pattern: /^([=!<>]=?|[-+*/&|^~%]=?|[,;:[\]{}()])/ },
  { kind: 'plain',    pattern: /^([a-zA-Z_][a-zA-Z0-9_]*)/ },
  { kind: 'plain',    pattern: /^([ \t\n\r]+)/ },
  { kind: 'plain',    pattern: /^([\s\S])/ },
];

const SHELL_RULES: Rule[] = [
  { kind: 'comment',  pattern: /^(#[^\n]*)/ },
  { kind: 'string',   pattern: /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/ },
  { kind: 'keyword',  pattern: /^((?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|local|export|readonly|unset|shift|set|source|alias|echo|cd|ls|grep|sed|awk|curl|cat|mkdir|rm|cp|mv|chmod|chown|sudo|git|npm|pnpm|yarn|node|python|pip|docker|kubectl)\b)/ },
  { kind: 'number',   pattern: /^(\d+)/ },
  { kind: 'operator', pattern: /^([|&;()<>!])/ },
  { kind: 'plain',    pattern: /^([^\s|&;()<>!"'#]+)/ },
  { kind: 'plain',    pattern: /^([ \t\n\r]+)/ },
  { kind: 'plain',    pattern: /^([\s\S])/ },
];

const GO_RULES: Rule[] = [
  { kind: 'comment',  pattern: /^(\/\/[^\n]*)/ },
  { kind: 'comment',  pattern: /^(\/\*[\s\S]*?\*\/)/ },
  { kind: 'string',   pattern: /^(`[^`]*`)/ },
  { kind: 'string',   pattern: /^("(?:[^"\\]|\\.)*")/ },
  { kind: 'keyword',  pattern: /^((?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|nil|true|false|iota)\b)/ },
  { kind: 'type',     pattern: /^((?:string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|complex64|complex128|bool|byte|rune|error|any)\b)/ },
  { kind: 'function', pattern: /^([a-zA-Z_][a-zA-Z0-9_]*(?=\s*\())/ },
  { kind: 'number',   pattern: /^(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)/ },
  { kind: 'operator', pattern: /^([=!<>]=?|:=|&&|\|\||[-+*/&|^~%]=?|[,;:[\]{}()])/ },
  { kind: 'plain',    pattern: /^([a-zA-Z_][a-zA-Z0-9_]*)/ },
  { kind: 'plain',    pattern: /^([ \t\n\r]+)/ },
  { kind: 'plain',    pattern: /^([\s\S])/ },
];

const RUST_RULES: Rule[] = [
  { kind: 'comment',  pattern: /^(\/\/[^\n]*)/ },
  { kind: 'comment',  pattern: /^(\/\*[\s\S]*?\*\/)/ },
  { kind: 'string',   pattern: /^("(?:[^"\\]|\\.)*")/ },
  { kind: 'keyword',  pattern: /^((?:as|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while|async|await)\b)/ },
  { kind: 'type',     pattern: /^((?:bool|char|f32|f64|i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|str|String|Vec|HashMap|HashSet|Option|Result|Box|Rc|Arc|RefCell|Mutex|RwLock)\b)/ },
  { kind: 'function', pattern: /^([a-zA-Z_][a-zA-Z0-9_]*(?=\s*\())/ },
  { kind: 'number',   pattern: /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?)/ },
  { kind: 'operator', pattern: /^([=!<>]=?|&&|\|\||[-+*/&|^~%]=?|::|=>|[,;:[\]{}()])/ },
  { kind: 'plain',    pattern: /^([a-zA-Z_][a-zA-Z0-9_]*)/ },
  { kind: 'plain',    pattern: /^([ \t\n\r]+)/ },
  { kind: 'plain',    pattern: /^([\s\S])/ },
];

// ─── Language → rules map ─────────────────────────────────────────────────────

const LANG_RULES: Record<string, Rule[]> = {
  js:         JS_TS_RULES,
  javascript: JS_TS_RULES,
  jsx:        JS_TS_RULES,
  ts:         JS_TS_RULES,
  typescript: JS_TS_RULES,
  tsx:        JS_TS_RULES,
  py:         PYTHON_RULES,
  python:     PYTHON_RULES,
  sh:         SHELL_RULES,
  bash:       SHELL_RULES,
  zsh:        SHELL_RULES,
  shell:      SHELL_RULES,
  go:         GO_RULES,
  golang:     GO_RULES,
  rs:         RUST_RULES,
  rust:       RUST_RULES,
};

// ─── Tokeniser ────────────────────────────────────────────────────────────────

function tokenise(code: string, rules: Rule[]): Token[] {
  const tokens: Token[] = [];
  let remaining = code;

  while (remaining.length > 0) {
    let matched = false;
    for (const rule of rules) {
      const m = rule.pattern.exec(remaining);
      if (m !== null && m[1] !== undefined) {
        tokens.push({ kind: rule.kind, text: m[1] });
        remaining = remaining.slice(m[1].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Safety valve — consume one char to avoid infinite loop
      tokens.push({ kind: 'plain', text: remaining[0]! });
      remaining = remaining.slice(1);
    }
  }

  return tokens;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Syntax-highlight a code block for terminal output.
 * Returns a chalk-coloured string ready for console output or Ink <Text>.
 *
 * @param code     Raw source code (no fences)
 * @param language Language identifier (e.g. 'ts', 'python'). Optional.
 */
export function highlight(code: string, language?: string): string {
  try {
    const lang = language?.toLowerCase().trim() ?? '';
    const rules = LANG_RULES[lang] ?? null;

    if (rules === null) {
      // Unknown language — return plain text with code color
      return NO_COLOR ? code : chalk.hex('#E2E8F0')(code);
    }

    const tokens = tokenise(code, rules);
    return tokens.map((t) => PALETTE[t.kind](t.text)).join('');
  } catch {
    return code; // Never crash — just return raw text
  }
}

// ─── Markdown segment types ───────────────────────────────────────────────────

export type MarkdownSegment =
  | { kind: 'text';  text: string }
  | { kind: 'code';  text: string; language: string; highlighted: string };

// ─── Markdown code fence parser ───────────────────────────────────────────────

/**
 * Parse markdown text into segments, splitting on code fences.
 * Returns an array of segments so the caller (React component) can
 * render code blocks differently from prose text.
 *
 * Handles:
 *   ```lang\ncode\n```  — fenced blocks
 *   `inline code`       — left as text (rendered inline with code color)
 */
export function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // Match ``` fences: optional language identifier, then newline, content, closing ```
  const FENCE = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FENCE.exec(text)) !== null) {
    // Text before this fence
    const before = text.slice(lastIndex, match.index);
    if (before) {
      segments.push({ kind: 'text', text: before });
    }

    const language = match[1] ?? '';
    const code = match[2] ?? '';
    const highlighted = highlight(code, language);
    segments.push({ kind: 'code', text: code, language, highlighted });

    lastIndex = match.index + match[0].length;
  }

  // Text after last fence
  const remainder = text.slice(lastIndex);
  if (remainder) {
    segments.push({ kind: 'text', text: remainder });
  }

  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}
