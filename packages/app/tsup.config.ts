import { defineConfig } from 'tsup';

export default defineConfig([
  // Binary entry — written directly to bin/ so package.json "bin" field resolves correctly.
  // The shebang banner is unconditional within this entry config.
  {
    entry: { pylon: 'bin/pylon.ts' },
    outDir: 'bin',
    format: ['esm'],
    target: 'node20',
    bundle: true,
    dts: false,
    clean: false,
    // better-sqlite3 is a native addon — cannot be bundled.
    // ink and react must remain external so their singleton state (hooks, context)
    // is shared correctly across the render tree.
    external: ['better-sqlite3', 'ink', 'react'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // Library entry — dist/ for programmatic imports and type declarations.
  {
    entry: { index: 'src/index.tsx' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    bundle: true,
    dts: true,
    clean: true,
    external: ['better-sqlite3', 'ink', 'react'],
  },
]);
