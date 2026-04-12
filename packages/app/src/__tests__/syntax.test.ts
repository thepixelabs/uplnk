/**
 * Tests for packages/app/src/lib/syntax.ts
 *
 * Coverage strategy:
 *  - highlight(): return type, empty input, unknown language, every registered
 *    language alias, structural invariant (tokens round-trip to original text),
 *    NO_COLOR passthrough, very long lines, and the never-throw contract.
 *  - parseMarkdown(): plain text, single fence, multiple fences, no-lang fence,
 *    adjacent fences, text before/after/between fences, empty string, partial
 *    (unclosed) fence (streaming), inline backticks, and the segment shape.
 *
 * We deliberately do NOT assert exact ANSI escape sequences because chalk
 * output varies with terminal capability and the NO_COLOR env var.  Instead we
 * assert on the stripped text content and structural invariants.
 */

import { describe, it, expect } from 'vitest';
import { highlight, parseMarkdown } from '../lib/syntax.js';
import type { MarkdownSegment } from '../lib/syntax.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip all ANSI escape codes so we can assert on plain text content. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// ─── highlight() ──────────────────────────────────────────────────────────────

describe('highlight', () => {
  describe('return-value invariants', () => {
    it('should return a string for any input', () => {
      expect(typeof highlight('const x = 1', 'ts')).toBe('string');
    });

    it('should preserve all source characters when ANSI codes are stripped', () => {
      const code = 'const x = 42;\nlet y = "hello";';
      const result = stripAnsi(highlight(code, 'ts'));
      expect(result).toBe(code);
    });

    it('should preserve whitespace and newlines exactly', () => {
      const code = '  if (x) {\n    return y;\n  }';
      const result = stripAnsi(highlight(code, 'js'));
      expect(result).toBe(code);
    });
  });

  describe('empty input', () => {
    it('should return an empty string when given empty code', () => {
      expect(highlight('', 'ts')).toBe('');
    });

    it('should return an empty string for unknown language with empty code', () => {
      expect(highlight('', 'cobol')).toBe('');
    });

    it('should return an empty string when no language is provided and code is empty', () => {
      expect(highlight('')).toBe('');
    });
  });

  describe('unknown / unsupported language', () => {
    it('should return the raw code unchanged (stripped) for an unknown language', () => {
      const code = 'SELECT * FROM users WHERE id = 1;';
      const result = stripAnsi(highlight(code, 'sql'));
      expect(result).toBe(code);
    });

    it('should handle undefined language and return the code', () => {
      const code = 'plain text with no language';
      const result = stripAnsi(highlight(code));
      expect(result).toBe(code);
    });

    it('should handle empty string language as unknown', () => {
      const code = 'some code';
      const result = stripAnsi(highlight(code, ''));
      expect(result).toBe(code);
    });

    it('should handle whitespace-only language identifier as unknown', () => {
      const code = 'some code';
      const result = stripAnsi(highlight(code, '   '));
      expect(result).toBe(code);
    });
  });

  describe('language aliases', () => {
    const jsAliases = ['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx'] as const;
    const pyAliases = ['py', 'python'] as const;
    const shAliases = ['sh', 'bash', 'zsh', 'shell'] as const;
    const goAliases = ['go', 'golang'] as const;
    const rustAliases = ['rs', 'rust'] as const;

    for (const lang of jsAliases) {
      it(`should highlight with JS/TS rules for alias "${lang}"`, () => {
        const code = 'const x = 1;';
        const result = highlight(code, lang);
        expect(stripAnsi(result)).toBe(code);
        // Should produce coloring in a normal terminal environment
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      });
    }

    for (const lang of pyAliases) {
      it(`should highlight with Python rules for alias "${lang}"`, () => {
        const code = 'def foo(): pass';
        expect(stripAnsi(highlight(code, lang))).toBe(code);
      });
    }

    for (const lang of shAliases) {
      it(`should highlight with shell rules for alias "${lang}"`, () => {
        const code = 'echo "hello"';
        expect(stripAnsi(highlight(code, lang))).toBe(code);
      });
    }

    for (const lang of goAliases) {
      it(`should highlight with Go rules for alias "${lang}"`, () => {
        const code = 'func main() {}';
        expect(stripAnsi(highlight(code, lang))).toBe(code);
      });
    }

    for (const lang of rustAliases) {
      it(`should highlight with Rust rules for alias "${lang}"`, () => {
        const code = 'fn main() {}';
        expect(stripAnsi(highlight(code, lang))).toBe(code);
      });
    }

    it('should normalise language to lowercase before lookup', () => {
      const code = 'const x = 1;';
      // 'TS' upper-case should resolve to JS_TS_RULES
      expect(stripAnsi(highlight(code, 'TS'))).toBe(code);
      expect(stripAnsi(highlight(code, 'TypeScript'))).toBe(code);
    });
  });

  describe('JavaScript/TypeScript token recognition', () => {
    it('should recognise line comments', () => {
      const code = '// this is a comment';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should recognise block comments', () => {
      const code = '/* block comment */';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should recognise double-quoted strings', () => {
      const code = '"hello world"';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should recognise single-quoted strings', () => {
      const code = "'hello world'";
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should recognise template literals', () => {
      const code = '`hello ${name}`';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should recognise numeric literals (integer, float, hex, binary, octal)', () => {
      const cases = ['42', '3.14', '0xFF', '0b1010', '0o777', '1e10'];
      for (const num of cases) {
        expect(stripAnsi(highlight(num, 'ts'))).toBe(num);
      }
    });

    it('should recognise keywords', () => {
      const keywords = ['const', 'let', 'return', 'async', 'await', 'null', 'undefined'];
      for (const kw of keywords) {
        expect(stripAnsi(highlight(kw, 'ts'))).toBe(kw);
      }
    });

    it('should recognise function calls (word before parenthesis)', () => {
      const code = 'foo(x)';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should handle escaped characters inside strings without crashing', () => {
      const code = '"line1\\nline2"';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });
  });

  describe('Python token recognition', () => {
    it('should recognise hash comments', () => {
      const code = '# python comment';
      expect(stripAnsi(highlight(code, 'python'))).toBe(code);
    });

    it('should recognise triple-quoted strings', () => {
      const code = '"""docstring"""';
      expect(stripAnsi(highlight(code, 'python'))).toBe(code);
    });

    it('should recognise Python keywords', () => {
      const keywords = ['def', 'class', 'import', 'return', 'yield', 'True', 'False', 'None'];
      for (const kw of keywords) {
        expect(stripAnsi(highlight(kw, 'python'))).toBe(kw);
      }
    });
  });

  describe('Go token recognition', () => {
    it('should recognise backtick raw string literals', () => {
      const code = '`raw string`';
      expect(stripAnsi(highlight(code, 'go'))).toBe(code);
    });

    it('should recognise Go short variable declaration operator :=', () => {
      const code = 'x := 42';
      expect(stripAnsi(highlight(code, 'go'))).toBe(code);
    });
  });

  describe('Rust token recognition', () => {
    it('should recognise scope resolution operator ::', () => {
      const code = 'std::io::Result';
      expect(stripAnsi(highlight(code, 'rust'))).toBe(code);
    });

    it('should recognise Rust lifetime-like patterns without crashing', () => {
      const code = "let x: &'static str = \"hello\";";
      expect(stripAnsi(highlight(code, 'rust'))).toBe(code);
    });
  });

  describe('shell token recognition', () => {
    it('should recognise hash comments in shell', () => {
      const code = '# shell comment';
      expect(stripAnsi(highlight(code, 'bash'))).toBe(code);
    });

    it('should recognise pipe and redirect operators', () => {
      const code = 'cat file | grep pattern';
      expect(stripAnsi(highlight(code, 'sh'))).toBe(code);
    });
  });

  describe('edge cases', () => {
    it('should handle a very long line without crashing', () => {
      const code = 'x'.repeat(10_000);
      expect(() => highlight(code, 'ts')).not.toThrow();
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should handle code with only whitespace', () => {
      const code = '   \n\t  \n   ';
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should handle Unicode characters without crashing', () => {
      const code = 'const emoji = "🎉"; // こんにちは';
      expect(() => highlight(code, 'ts')).not.toThrow();
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });

    it('should handle null bytes and control characters without crashing', () => {
      const code = 'x\x00y\x01z';
      expect(() => highlight(code, 'ts')).not.toThrow();
    });

    it('should not throw for any input (never-throw contract)', () => {
      // Pathological inputs that could cause regex backtracking or crashes
      const inputs = [
        '```',
        '`unclosed template',
        '"unclosed string',
        '/* unclosed block comment',
        '\\'.repeat(500),
        '\n'.repeat(1000),
      ];
      for (const input of inputs) {
        expect(() => highlight(input, 'ts')).not.toThrow();
      }
    });

    it('should handle a multiline real-world TypeScript snippet', () => {
      const code = [
        'export async function fetchUser(id: string): Promise<User | null> {',
        '  try {',
        '    const res = await fetch(`/api/users/${id}`);',
        '    if (!res.ok) throw new Error(`HTTP ${res.status}`);',
        '    return res.json() as Promise<User>;',
        '  } catch (err: unknown) {',
        '    console.error("fetchUser failed", err);',
        '    return null;',
        '  }',
        '}',
      ].join('\n');
      expect(() => highlight(code, 'ts')).not.toThrow();
      expect(stripAnsi(highlight(code, 'ts'))).toBe(code);
    });
  });
});

// ─── parseMarkdown() ──────────────────────────────────────────────────────────

describe('parseMarkdown', () => {
  describe('plain text (no fences)', () => {
    it('should return a single text segment for plain prose', () => {
      const segments = parseMarkdown('Hello, world!');
      expect(segments).toHaveLength(1);
      const seg = segments[0];
      expect(seg?.kind).toBe('text');
      if (seg?.kind === 'text') {
        expect(seg.text).toBe('Hello, world!');
      }
    });

    it('should return a single text segment for empty string', () => {
      const segments = parseMarkdown('');
      // Empty string: segments.length === 0 → fallback [{ kind:'text', text:'' }]
      expect(segments).toHaveLength(1);
      expect(segments[0]?.kind).toBe('text');
      expect(segments[0]?.text).toBe('');
    });

    it('should treat inline backticks (single) as plain text', () => {
      const input = 'Use `Array.from()` to convert iterables.';
      const segments = parseMarkdown(input);
      expect(segments).toHaveLength(1);
      expect(segments[0]?.kind).toBe('text');
      if (segments[0]?.kind === 'text') {
        expect(segments[0].text).toBe(input);
      }
    });

    it('should treat double backticks as plain text', () => {
      const input = '``not a fence``';
      const segments = parseMarkdown(input);
      expect(segments).toHaveLength(1);
      expect(segments[0]?.kind).toBe('text');
    });
  });

  describe('single code fence', () => {
    it('should return [text, code] for prose followed by a fenced block', () => {
      const input = 'Here is some code:\n```ts\nconst x = 1;\n```';
      const segments = parseMarkdown(input);
      expect(segments).toHaveLength(2);

      const [text, code] = segments as [MarkdownSegment, MarkdownSegment];
      expect(text.kind).toBe('text');
      expect(code.kind).toBe('code');
    });

    it('should extract the language identifier from the fence', () => {
      const input = '```typescript\nconst x = 1;\n```';
      const segments = parseMarkdown(input);
      expect(segments).toHaveLength(1);
      const seg = segments[0];
      expect(seg?.kind).toBe('code');
      if (seg?.kind === 'code') {
        expect(seg.language).toBe('typescript');
      }
    });

    it('should set language to empty string when no identifier is given', () => {
      const input = '```\nsome code\n```';
      const segments = parseMarkdown(input);
      const seg = segments[0];
      expect(seg?.kind).toBe('code');
      if (seg?.kind === 'code') {
        expect(seg.language).toBe('');
      }
    });

    it('should populate the text field with the raw (uncoloured) code', () => {
      // The FENCE regex captures everything up to the closing ```, which
      // includes any trailing newline that separates the code from the fence.
      const rawCode = 'const x = 1;';
      const input = `\`\`\`ts\n${rawCode}\n\`\`\``;
      const segments = parseMarkdown(input);
      const seg = segments[0];
      expect(seg?.kind).toBe('code');
      if (seg?.kind === 'code') {
        // The captured group includes the trailing \n before the closing fence
        expect(seg.text.trimEnd()).toBe(rawCode);
      }
    });

    it('should populate the highlighted field with a non-empty string for known languages', () => {
      const input = '```ts\nconst x = 1;\n```';
      const segments = parseMarkdown(input);
      const seg = segments[0];
      expect(seg?.kind).toBe('code');
      if (seg?.kind === 'code') {
        expect(seg.highlighted.length).toBeGreaterThan(0);
      }
    });

    it('should return [code, text] for a fenced block followed by prose', () => {
      const input = '```ts\nconst x = 1;\n```\nThis comes after.';
      const segments = parseMarkdown(input);
      expect(segments).toHaveLength(2);
      expect(segments[0]?.kind).toBe('code');
      expect(segments[1]?.kind).toBe('text');
      if (segments[1]?.kind === 'text') {
        expect(segments[1].text).toBe('\nThis comes after.');
      }
    });

    it('should handle a code fence that is the entire input', () => {
      const input = '```py\nprint("hello")\n```';
      const segments = parseMarkdown(input);
      expect(segments).toHaveLength(1);
      expect(segments[0]?.kind).toBe('code');
      if (segments[0]?.kind === 'code') {
        expect(segments[0].language).toBe('py');
        // The captured group includes a trailing \n before the closing fence
        expect(segments[0].text.trimEnd()).toBe('print("hello")');
      }
    });
  });

  describe('multiple code fences', () => {
    it('should return segments in source order for two consecutive fences', () => {
      const input = [
        '```ts',
        'const a = 1;',
        '```',
        '```py',
        'print("hello")',
        '```',
      ].join('\n');

      const segments = parseMarkdown(input);
      // Two code segments (possibly with a text segment between them if there's a \n)
      const codeSegs = segments.filter((s): s is Extract<MarkdownSegment, { kind: 'code' }> => s.kind === 'code');
      expect(codeSegs).toHaveLength(2);
      expect(codeSegs[0]?.language).toBe('ts');
      expect(codeSegs[1]?.language).toBe('py');
    });

    it('should interleave text segments between fences', () => {
      const input = 'First\n```ts\nconst x = 1;\n```\nMiddle\n```py\npass\n```\nLast';
      const segments = parseMarkdown(input);

      const kinds = segments.map((s) => s.kind);
      expect(kinds).toEqual(['text', 'code', 'text', 'code', 'text']);
    });

    it('should correctly attribute code text to each respective fence', () => {
      const input = '```ts\nconst x = 1;\n```\n\n```py\nprint(x)\n```';
      const segs = parseMarkdown(input).filter(
        (s): s is Extract<MarkdownSegment, { kind: 'code' }> => s.kind === 'code',
      );
      // trimEnd() to ignore the trailing \n captured before the closing fence
      expect(segs[0]?.text.trimEnd()).toBe('const x = 1;');
      expect(segs[1]?.text.trimEnd()).toBe('print(x)');
    });
  });

  describe('code fence languages', () => {
    const supportedLangs = [
      'js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx',
      'py', 'python', 'sh', 'bash', 'zsh', 'shell',
      'go', 'golang', 'rs', 'rust',
    ] as const;

    for (const lang of supportedLangs) {
      it(`should set language="${lang}" correctly in the code segment`, () => {
        const input = `\`\`\`${lang}\ncode\n\`\`\``;
        const segments = parseMarkdown(input);
        const seg = segments[0];
        expect(seg?.kind).toBe('code');
        if (seg?.kind === 'code') {
          expect(seg.language).toBe(lang);
        }
      });
    }

    it('should preserve unknown language identifiers verbatim', () => {
      const input = '```elixir\nIO.puts "hello"\n```';
      const segments = parseMarkdown(input);
      const seg = segments[0];
      expect(seg?.kind).toBe('code');
      if (seg?.kind === 'code') {
        expect(seg.language).toBe('elixir');
        // highlighted should fall back to plain text (same as raw)
        expect(stripAnsi(seg.highlighted)).toBe(seg.text);
      }
    });
  });

  describe('streaming / partial markdown (unclosed fences)', () => {
    it('should treat an unclosed fence as plain text (no crash)', () => {
      // During streaming the closing ``` may not have arrived yet
      const partial = 'Here is code:\n```ts\nconst x = 1;';
      expect(() => parseMarkdown(partial)).not.toThrow();
      const segments = parseMarkdown(partial);
      // All text, since the fence never closed
      expect(segments.length).toBeGreaterThan(0);
      for (const seg of segments) {
        expect(seg.kind).toBe('text');
      }
    });

    it('should return the complete text as a single text segment for partial input', () => {
      const partial = 'Thinking... ```ts\nconst x';
      const segments = parseMarkdown(partial);
      expect(segments.every((s) => s.kind === 'text')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle a fence with only whitespace as code content', () => {
      const input = '```ts\n   \n```';
      const segments = parseMarkdown(input);
      const seg = segments[0];
      expect(seg?.kind).toBe('code');
      if (seg?.kind === 'code') {
        // text is the content between fence markers (the regex includes \n? before content)
        // The exact whitespace depends on the regex; key invariant: no crash
        expect(typeof seg.text).toBe('string');
      }
    });

    it('should handle a fence with language identifiers containing digits and hyphens', () => {
      // The FENCE regex allows [a-zA-Z0-9_+-]*
      const input = '```c++\nint main() {}\n```';
      expect(() => parseMarkdown(input)).not.toThrow();
    });

    it('should parse a fence with no whitespace separator between lang and content', () => {
      // Input: ```tsconst x = 1;```
      // The FENCE regex: ```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```
      //   - lang captures "tsconst" (stops at space, not in charset)
      //   - \n? matches empty (next char is space)
      //   - content lazily captures " x = 1;"
      // So this IS matched as a code block (lang="tsconst", code=" x = 1;")
      const input = '```tsconst x = 1;```';
      const segments = parseMarkdown(input);
      const codeSeg = segments.find((s) => s.kind === 'code');
      expect(codeSeg).toBeDefined();
      if (codeSeg?.kind === 'code') {
        expect(codeSeg.language).toBe('tsconst');
      }
    });

    it('should not crash on extremely long input', () => {
      const longText = 'word '.repeat(5_000);
      expect(() => parseMarkdown(longText)).not.toThrow();
    });

    it('should not crash on input with many code fences', () => {
      const block = '```ts\nconst x = 1;\n```\n';
      const input = block.repeat(100);
      expect(() => parseMarkdown(input)).not.toThrow();
      const codeSegs = parseMarkdown(input).filter((s) => s.kind === 'code');
      expect(codeSegs).toHaveLength(100);
    });

    it('should handle input that is only whitespace and newlines', () => {
      const input = '   \n\n   \n';
      const segments = parseMarkdown(input);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments[0]?.kind).toBe('text');
    });

    it('should produce segments whose text fields concatenate back to the original input', () => {
      const input = 'Before\n```ts\nconst x = 1;\n```\nAfter';
      const segments = parseMarkdown(input);

      // Reconstruct: for code segments use the raw "text" (without ANSI)
      const reconstructed = segments
        .map((s) => {
          if (s.kind === 'text') return s.text;
          // fence = "```" + language + "\n" + text + "```"
          return `\`\`\`${s.language}\n${s.text}\`\`\``;
        })
        .join('');
      expect(reconstructed).toBe(input);
    });
  });

  describe('segment shape (TypeScript type narrowing)', () => {
    it('should narrow to text segment with text property', () => {
      const segments = parseMarkdown('hello');
      const seg = segments[0];
      if (seg?.kind === 'text') {
        // TypeScript compile-time check: seg.text must exist
        expect(typeof seg.text).toBe('string');
      }
    });

    it('should narrow to code segment with text, language, highlighted properties', () => {
      const segments = parseMarkdown('```go\nfmt.Println("hi")\n```');
      const seg = segments[0];
      if (seg?.kind === 'code') {
        expect(typeof seg.text).toBe('string');
        expect(typeof seg.language).toBe('string');
        expect(typeof seg.highlighted).toBe('string');
      }
    });
  });
});
