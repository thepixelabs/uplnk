import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'bin/pylon': 'bin/pylon.ts',
    index: 'src/index.tsx',
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  // Inject shebang only into the bin entry
  banner: {
    js: (ctx) => (ctx.entry?.includes('pylon') ? '#!/usr/bin/env node' : ''),
  },
  // better-sqlite3 is a native module — cannot be bundled
  external: ['better-sqlite3'],
});
