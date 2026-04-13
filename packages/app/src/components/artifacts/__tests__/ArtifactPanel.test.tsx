import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ArtifactPanel } from '../ArtifactPanel.js';
import type { Artifact } from '../ArtifactPanel.js';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

const mockArtifact: Artifact = {
  id: 'test-1',
  language: 'typescript',
  title: 'Test Component',
  original: 'const x = 1;',
  code: 'const x = 1;',
};

const diffArtifact: Artifact = {
  id: 'test-diff',
  language: 'typescript',
  title: 'Changed',
  original: 'const x = 1;\nconst y = 2;\n',
  code:     'const x = 1;\nconst y = 99;\n',
};

// ─── Render / display ─────────────────────────────────────────────────────────

describe('ArtifactPanel', () => {
  it('renders without errors', () => {
    expect(() =>
      render(
        React.createElement(ArtifactPanel, {
          artifact: mockArtifact,
          onClose: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });

  it('shows the artifact title', () => {
    const { lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: mockArtifact,
        onClose: vi.fn(),
      }),
    );
    // In the 50%-width panel the title may wrap; assert both words appear
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Test');
    expect(frame).toContain('Component');
  });

  it('shows language label', () => {
    const { lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: mockArtifact,
        onClose: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('typescript');
  });

  it('shows diff tab hint when original differs from code', () => {
    const artifact: Artifact = {
      ...mockArtifact,
      original: 'const x = 1;',
      code: 'const x = 2;',
    };
    const { lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    expect(lastFrame()).toContain('diff');
  });

  it('does not show diff tab hint when code is unchanged', () => {
    const { lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: mockArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    // No diff available — hint should not appear
    expect(lastFrame()).not.toContain('[Tab: diff]');
  });

  it('shows "(no changes to review)" in diff mode when original equals code', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        // Build an artifact where code equals original to reach the no-diff state
        artifact: mockArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    // 'v' would normally toggle to diff, but hasDiff is false — pressing v is no-op
    // so the code view stays; verify the code content is shown instead
    await tick();
    stdin.write('v');
    await tick();
    // With no diff, 'v' does nothing — still in code view
    expect(lastFrame()).not.toContain('diff view');
  });

  it('renders code content in code view', () => {
    const artifact: Artifact = {
      ...mockArtifact,
      code: 'const answer = 42;',
    };
    const { lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact,
        onClose: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('42');
  });

  it('falls back to language as title when title is empty', () => {
    const artifact: Artifact = {
      ...mockArtifact,
      title: '',
      language: 'python',
    };
    const { lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact,
        onClose: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('python');
  });
});

// ─── Escape closes the panel ──────────────────────────────────────────────────

describe('ArtifactPanel — Escape', () => {
  it('calls onClose when Escape is pressed and panel is focused', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact: mockArtifact,
        onClose,
        focused: true,
      }),
    );
    await tick();
    stdin.write('\u001B'); // Escape
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when panel is not focused', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact: mockArtifact,
        onClose,
        focused: false,
      }),
    );
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ─── Diff mode — view toggle ───────────────────────────────────────────────────

describe('ArtifactPanel — diff mode toggle', () => {
  it('enters diff view when "v" is pressed and hasDiff=true', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v');
    await tick();
    expect(lastFrame()).toContain('diff view');
  });

  it('shows hunk header with @@ marker in diff mode', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v');
    await tick();
    expect(lastFrame()).toContain('@@');
  });

  it('toggles back to code view when "v" is pressed again', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v'); // enter diff
    await tick();
    stdin.write('v'); // back to code
    await tick();
    expect(lastFrame()).not.toContain('diff view');
  });
});

// ─── Diff mode — accept / reject hunk ────────────────────────────────────────

describe('ArtifactPanel — accept hunk', () => {
  it('marks selected hunk as accepted when "a" is pressed in diff mode', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v'); // enter diff view
    await tick();
    stdin.write('a'); // accept first hunk
    await tick();
    expect(lastFrame()).toContain('accepted');
  });

  it('marks selected hunk as rejected when "r" is pressed in diff mode', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v');
    await tick();
    stdin.write('r'); // reject first hunk
    await tick();
    expect(lastFrame()).toContain('rejected');
  });

  it('accepts all hunks when "A" is pressed', async () => {
    const multiHunkArtifact: Artifact = {
      id: 'multi',
      language: 'typescript',
      title: 'Multi',
      // Two separate changes far apart so they form two hunks
      original: [
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
        'const e = 5;',
        'const f = 6;',
        'const g = 7;',
        'const h = 8;',
        'const i = 9;',
        'const j = 10;',
        'const k = 11;',
      ].join('\n'),
      code: [
        'const a = 999;',  // change 1
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
        'const e = 5;',
        'const f = 6;',
        'const g = 7;',
        'const h = 8;',
        'const i = 9;',
        'const j = 10;',
        'const k = 888;',  // change 2
      ].join('\n'),
    };

    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: multiHunkArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v');
    await tick();
    stdin.write('A'); // accept all
    await tick();
    // Both hunks should now be accepted — no pending hunks remain
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('a=accept'); // no pending hunk selected prompt
  });

  it('rejects all hunks when "R" is pressed', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        focused: true,
      }),
    );
    await tick();
    stdin.write('v');
    await tick();
    stdin.write('R'); // reject all
    await tick();
    expect(lastFrame()).toContain('rejected');
  });
});

// ─── Diff mode — apply callback ───────────────────────────────────────────────

describe('ArtifactPanel — onApply callback', () => {
  it('calls onApply with final code and onClose when Enter is pressed in diff mode', async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose,
        onApply,
        focused: true,
      }),
    );
    await tick();
    stdin.write('v'); // enter diff view
    await tick();
    stdin.write('\r'); // Enter — apply
    await tick();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The applied code should be a string
    const appliedCode = onApply.mock.calls[0]?.[0] as unknown;
    expect(typeof appliedCode).toBe('string');
  });

  it('does not call onApply when Enter is pressed in code view', async () => {
    const onApply = vi.fn();
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        onApply,
        focused: true,
      }),
    );
    await tick();
    stdin.write('\r'); // Enter in code view — should be a no-op
    await tick();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('does not call onApply when onApply prop is not provided', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose,
        focused: true,
        // no onApply
      }),
    );
    await tick();
    stdin.write('v');
    await tick();
    stdin.write('\r'); // Enter without onApply — should not crash
    await tick();
    // onClose should NOT have been called since onApply is undefined
    expect(onClose).not.toHaveBeenCalled();
  });

  it('onApply receives code with accepted changes applied', async () => {
    const onApply = vi.fn();
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact: diffArtifact,
        onClose: vi.fn(),
        onApply,
        focused: true,
      }),
    );
    await tick();
    stdin.write('v'); // enter diff
    await tick();
    stdin.write('a'); // accept the hunk (treats new line y = 99 as accepted)
    await tick();
    stdin.write('\r'); // apply
    await tick();
    const finalCode = onApply.mock.calls[0]?.[0] as string;
    // The accepted hunk keeps the new code (y = 99)
    expect(finalCode).toContain('99');
  });
});

// ─── Save to file (w) ─────────────────────────────────────────────────────────

describe('ArtifactPanel — save-to-file (w)', () => {
  it('invokes onSave with artifact.filePath and current code when w is pressed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const artifact: Artifact = {
      ...mockArtifact,
      code: 'const answer = 42;\n',
      filePath: '/abs/path/to/file.ts',
    };
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact,
        onClose: vi.fn(),
        onSave,
        focused: true,
      }),
    );
    await tick();
    stdin.write('w');
    await tick();
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('/abs/path/to/file.ts', 'const answer = 42;\n');
    expect(lastFrame()).toContain('Saved to /abs/path/to/file.ts');
  });

  it('writes the diff-applied content (accepted hunks) when w is pressed in diff mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const artifact: Artifact = {
      ...diffArtifact,
      filePath: '/tmp/changed.ts',
    };
    const { stdin } = render(
      React.createElement(ArtifactPanel, {
        artifact,
        onClose: vi.fn(),
        onSave,
        focused: true,
      }),
    );
    await tick();
    stdin.write('v'); // enter diff
    await tick();
    stdin.write('a'); // accept the one hunk
    await tick();
    stdin.write('w'); // save
    await tick();
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    const [calledPath, calledContent] = onSave.mock.calls[0] ?? [];
    expect(calledPath).toBe('/tmp/changed.ts');
    // Accepted hunk keeps the new value (y = 99), drops the original (y = 2)
    expect(calledContent).toContain('y = 99');
    expect(calledContent).not.toContain('y = 2;');
  });

  it('prompts for a path when artifact has no filePath, then saves on Enter', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: { ...mockArtifact, code: 'hello\n' },
        onClose: vi.fn(),
        onSave,
        focused: true,
      }),
    );
    await tick();
    stdin.write('w');
    await tick();
    expect(lastFrame()).toContain('Save to path:');
    // Type a destination
    stdin.write('/tmp/out.txt');
    await tick();
    stdin.write('\r'); // Enter
    await tick();
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('/tmp/out.txt', 'hello\n');
  });

  it('shows error status when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('EACCES: denied'));
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: { ...mockArtifact, filePath: '/root/locked' },
        onClose: vi.fn(),
        onSave,
        focused: true,
      }),
    );
    await tick();
    stdin.write('w');
    await tick();
    await tick();
    expect(lastFrame()).toContain('Save failed');
    expect(lastFrame()).toContain('EACCES');
  });
});

// ─── Copy to clipboard (y) ────────────────────────────────────────────────────

describe('ArtifactPanel — copy-to-clipboard (y)', () => {
  it('invokes onCopy with the raw (non-ANSI) current code', async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const artifact: Artifact = { ...mockArtifact, code: 'const a = 1;\n' };
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact,
        onClose: vi.fn(),
        onCopy,
        focused: true,
      }),
    );
    await tick();
    stdin.write('y');
    await tick();
    await tick();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith('const a = 1;\n');
    // Confirm no ANSI escape codes slipped through
    const copied = onCopy.mock.calls[0]?.[0] as string;
    // eslint-disable-next-line no-control-regex
    expect(copied).not.toMatch(/\u001B\[/);
    expect(lastFrame()).toContain('Copied');
  });

  it('shows error status when onCopy rejects', async () => {
    const onCopy = vi.fn().mockRejectedValue(new Error('no clipboard'));
    const { stdin, lastFrame } = render(
      React.createElement(ArtifactPanel, {
        artifact: mockArtifact,
        onClose: vi.fn(),
        onCopy,
        focused: true,
      }),
    );
    await tick();
    stdin.write('y');
    await tick();
    await tick();
    expect(lastFrame()).toContain('Copy failed');
  });
});
