/**
 * Safe expression evaluator for flow conditions and interpolation.
 *
 * Deliberately avoids eval() and new Function(). Supports a small, explicit
 * subset of expressions that covers the common flow-control cases:
 *
 *   - Boolean literals:         true / false
 *   - Step output lookup:       steps.stepId.output
 *   - Input lookup:             inputs.name
 *   - Variable lookup:          vars.name
 *   - String/number literals:   "hello" / 'world' / 42 / 3.14
 *   - Comparison:               == / != / > / < / >= / <=
 *   - Logical:                  && / || / !
 *   - Parentheses for grouping
 *
 * Anything outside this set evaluates to false (safe default).
 *
 * This is intentionally NOT a general-purpose JS evaluator. The goal is
 * predictable, auditable behaviour for a constrained use-case — not
 * Turing completeness.
 */

export interface EvalContext {
  stepOutputs: Record<string, unknown>;
  inputs: Record<string, unknown>;
  variables: Record<string, unknown>;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type TokenKind =
  | 'NUMBER'
  | 'STRING'
  | 'BOOL'
  | 'NULL'
  | 'PATH'  // steps.X.output / inputs.X / vars.X
  | 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE'
  | 'AND' | 'OR' | 'NOT'
  | 'LPAREN' | 'RPAREN'
  | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i]!)) { i++; continue; }

    // String literal
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]!;
      let s = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          i++; // skip backslash
          s += src[i];
        } else {
          s += src[i];
        }
        i++;
      }
      i++; // closing quote
      tokens.push({ kind: 'STRING', value: s });
      continue;
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (two === '==') { tokens.push({ kind: 'EQ', value: '==' }); i += 2; continue; }
    if (two === '!=') { tokens.push({ kind: 'NEQ', value: '!=' }); i += 2; continue; }
    if (two === '<=') { tokens.push({ kind: 'LTE', value: '<=' }); i += 2; continue; }
    if (two === '>=') { tokens.push({ kind: 'GTE', value: '>=' }); i += 2; continue; }
    if (two === '&&') { tokens.push({ kind: 'AND', value: '&&' }); i += 2; continue; }
    if (two === '||') { tokens.push({ kind: 'OR', value: '||' }); i += 2; continue; }

    // Single-char operators
    const ch = src[i]!;
    if (ch === '<') { tokens.push({ kind: 'LT', value: '<' }); i++; continue; }
    if (ch === '>') { tokens.push({ kind: 'GT', value: '>' }); i++; continue; }
    if (ch === '!') { tokens.push({ kind: 'NOT', value: '!' }); i++; continue; }
    if (ch === '(') { tokens.push({ kind: 'LPAREN', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'RPAREN', value: ')' }); i++; continue; }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let n = ch;
      i++;
      while (i < src.length && /[0-9.]/.test(src[i]!)) { n += src[i]; i++; }
      tokens.push({ kind: 'NUMBER', value: n });
      continue;
    }

    // Identifiers: true, false, null, steps.X.Y, inputs.X, vars.X
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < src.length && /[a-zA-Z0-9_.]/.test(src[i]!)) { ident += src[i]; i++; }
      if (ident === 'true' || ident === 'false') {
        tokens.push({ kind: 'BOOL', value: ident });
      } else if (ident === 'null') {
        tokens.push({ kind: 'NULL', value: 'null' });
      } else {
        tokens.push({ kind: 'PATH', value: ident });
      }
      continue;
    }

    // Unknown character — skip it rather than crash
    i++;
  }

  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

// ─── Parser / evaluator ───────────────────────────────────────────────────────

type ParseResult = boolean | string | number | null | undefined;

class Parser {
  private pos = 0;

  constructor(private tokens: Token[], private ctx: EvalContext) {}

  private peek(): Token { return this.tokens[this.pos] ?? { kind: 'EOF', value: '' }; }
  private consume(): Token { return this.tokens[this.pos++] ?? { kind: 'EOF', value: '' }; }

  // expr → orExpr
  parseExpr(): ParseResult { return this.parseOr(); }

  private parseOr(): ParseResult {
    let left = this.parseAnd();
    while (this.peek().kind === 'OR') {
      this.consume();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): ParseResult {
    let left = this.parseNot();
    while (this.peek().kind === 'AND') {
      this.consume();
      const right = this.parseNot();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseNot(): ParseResult {
    if (this.peek().kind === 'NOT') {
      this.consume();
      const val = this.parseNot();
      return !Boolean(val);
    }
    return this.parseComparison();
  }

  private parseComparison(): ParseResult {
    const left = this.parseAtom();
    const opKinds: TokenKind[] = ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE'];
    if (opKinds.includes(this.peek().kind)) {
      const op = this.consume().kind;
      const right = this.parseAtom();
      return compare(op, left, right);
    }
    return left;
  }

  private parseAtom(): ParseResult {
    const tok = this.peek();

    if (tok.kind === 'LPAREN') {
      this.consume();
      const val = this.parseExpr();
      if (this.peek().kind === 'RPAREN') this.consume();
      return val;
    }

    if (tok.kind === 'BOOL') {
      this.consume();
      return tok.value === 'true';
    }

    if (tok.kind === 'NULL') {
      this.consume();
      return null;
    }

    if (tok.kind === 'NUMBER') {
      this.consume();
      return parseFloat(tok.value);
    }

    if (tok.kind === 'STRING') {
      this.consume();
      return tok.value;
    }

    if (tok.kind === 'PATH') {
      this.consume();
      return resolvePath(tok.value, this.ctx);
    }

    // EOF or unrecognised — return undefined (falsy)
    return undefined;
  }
}

function compare(op: TokenKind, left: ParseResult, right: ParseResult): boolean {
  // Normalise undefined to null so `steps.missing.output == null` works.
  const l = left === undefined ? null : left;
  const r = right === undefined ? null : right;

  switch (op) {
    case 'EQ': {
      // Strict equality, with one lenient rule: allow string/number cross-type
      // compare (e.g. `inputs.retries == 3` where inputs arrived as "3").
      if (l === r) return true;
      if (typeof l === 'number' && typeof r === 'string') return l === Number(r);
      if (typeof l === 'string' && typeof r === 'number') return Number(l) === r;
      return false;
    }
    case 'NEQ': {
      if (l === r) return false;
      if (typeof l === 'number' && typeof r === 'string') return l !== Number(r);
      if (typeof l === 'string' && typeof r === 'number') return Number(l) !== r;
      return true;
    }
    // Numeric comparisons: null/undefined → NaN → always false (matches JS).
    case 'LT':  return Number(l) < Number(r);
    case 'LTE': return Number(l) <= Number(r);
    case 'GT':  return Number(l) > Number(r);
    case 'GTE': return Number(l) >= Number(r);
    default:    return false;
  }
}

/**
 * Resolve a dotted path like `steps.stepId.output`, `inputs.name`, `vars.name`
 * against the evaluation context. Returns undefined for any unknown path.
 */
function resolvePath(path: string, ctx: EvalContext): ParseResult {
  const parts = path.split('.');

  if (parts[0] === 'steps' && parts.length >= 3) {
    const stepId = parts[1]!;
    const field = parts.slice(2).join('.');
    const out = ctx.stepOutputs[stepId];
    if (field === 'output') return coercePrimitive(out);
    return undefined;
  }

  if (parts[0] === 'inputs' && parts.length === 2) {
    return coercePrimitive(ctx.inputs[parts[1]!]);
  }

  if (parts[0] === 'vars' && parts.length === 2) {
    return coercePrimitive(ctx.variables[parts[1]!]);
  }

  return undefined;
}

function coercePrimitive(v: unknown): ParseResult {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  // For complex objects, stringify — primarily useful for comparison to 'null' or 'undefined'
  return String(v);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a boolean condition expression. Returns false on any parse error
 * or for unsupported syntax — fail-closed is the correct default for conditions
 * guarding step execution.
 */
export function evaluateCondition(expr: string, ctx: EvalContext): boolean {
  try {
    const tokens = tokenize(expr.trim());
    const parser = new Parser(tokens, ctx);
    const result = parser.parseExpr();
    return Boolean(result);
  } catch {
    return false;
  }
}

/**
 * Resolve a path expression to its raw value (not coerced to boolean).
 * Used by the loop engine to resolve `items` expressions to arrays.
 */
export function resolveExpression(expr: string, ctx: EvalContext): unknown {
  try {
    const tokens = tokenize(expr.trim());
    const parser = new Parser(tokens, ctx);
    return parser.parseExpr();
  } catch {
    return undefined;
  }
}

/**
 * Interpolate ${steps.X.output}, ${inputs.X}, ${vars.X} placeholders
 * in a template string. Uses simple regex scan — no eval.
 */
export function interpolate(template: string, ctx: EvalContext): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, inner: string) => {
    const trimmed = inner.trim();
    try {
      const tokens = tokenize(trimmed);
      const parser = new Parser(tokens, ctx);
      const val = parser.parseExpr();
      return val === null || val === undefined ? '' : String(val);
    } catch {
      return '';
    }
  });
}
