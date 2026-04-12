import { describe, it, expect } from 'vitest';
import { highlight, parseMarkdown } from '../syntax.js';

// Strip ANSI escape codes for test comparison
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('highlight', () => {
  it('returns raw code for unknown language', () => {
    const code = 'hello world';
    const result = highlight(code, 'cobol');
    expect(stripAnsi(result)).toBe(code);
  });

  it('does not throw on empty code', () => {
    expect(() => highlight('', 'ts')).not.toThrow();
  });

  it('highlights TypeScript keywords', () => {
    const code = 'const x = 42;';
    const result = highlight(code, 'typescript');
    // With color support off (NO_COLOR env), still returns the text
    expect(stripAnsi(result)).toContain('const');
    expect(stripAnsi(result)).toContain('42');
  });

  it('highlights Python keywords', () => {
    const code = 'def greet(name):\n    return f"Hello {name}"';
    const result = highlight(code, 'python');
    expect(stripAnsi(result)).toContain('def');
    expect(stripAnsi(result)).toContain('return');
  });

  it('highlights shell commands', () => {
    const code = 'git commit -m "initial"';
    const result = highlight(code, 'bash');
    expect(stripAnsi(result)).toContain('git');
  });

  it('highlights Go code', () => {
    const code = 'func main() {\n\tfmt.Println("hello")\n}';
    const result = highlight(code, 'go');
    expect(stripAnsi(result)).toContain('func');
    expect(stripAnsi(result)).toContain('main');
  });

  it('does not throw on malformed unicode', () => {
    expect(() => highlight('\u{1F600} \u{1F4A9}', 'ts')).not.toThrow();
  });

  it('handles ts/tsx/jsx aliases', () => {
    const code = 'const x = 1;';
    expect(() => highlight(code, 'tsx')).not.toThrow();
    expect(() => highlight(code, 'jsx')).not.toThrow();
    expect(() => highlight(code, 'js')).not.toThrow();
  });
});

describe('parseMarkdown', () => {
  it('returns single text segment for plain text', () => {
    const result = parseMarkdown('Hello world');
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('text');
    expect(result[0]?.text).toBe('Hello world');
  });

  it('extracts a fenced code block', () => {
    const text = 'Here is some code:\n```ts\nconst x = 1;\n```\nDone.';
    const result = parseMarkdown(text);
    expect(result).toHaveLength(3);
    expect(result[0]?.kind).toBe('text');
    expect(result[1]?.kind).toBe('code');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result[1] as any).language).toBe('ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripAnsi((result[1] as any).highlighted)).toContain('const');
    expect(result[2]?.kind).toBe('text');
  });

  it('handles multiple code blocks', () => {
    const text = '```js\nconsole.log(1);\n```\n\n```py\nprint(2)\n```';
    const result = parseMarkdown(text);
    const codeBlocks = result.filter((s) => s.kind === 'code');
    expect(codeBlocks).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((codeBlocks[0] as any).language).toBe('js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((codeBlocks[1] as any).language).toBe('py');
  });

  it('handles code block without language identifier', () => {
    const text = '```\nsome code\n```';
    const result = parseMarkdown(text);
    expect(result[0]?.kind).toBe('code');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result[0] as any).language).toBe('');
  });

  it('handles text with no code blocks', () => {
    const text = 'Plain text without any fences.';
    const result = parseMarkdown(text);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('text');
  });

  it('does not throw on empty string', () => {
    expect(() => parseMarkdown('')).not.toThrow();
  });

  it('does not throw on nested backticks', () => {
    expect(() => parseMarkdown('Use `const` for constants')).not.toThrow();
  });
});
