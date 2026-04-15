import { defineConfig } from 'tsup';

export default defineConfig([
  // Binary entry — compiled to dist/ to keep bin/ as source-only.
  // package.json "bin" field points to dist/uplnk.js.
  // splitting: false ensures a single self-contained file with no stray chunks.
  {
    entry: { uplnk: 'bin/uplnk.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    bundle: true,
    splitting: false,
    dts: false,
    clean: false,
    // better-sqlite3 is a native addon — cannot be bundled.
    // ink and react must remain external so their singleton state (hooks, context)
    // is shared correctly across the render tree.
    external: ['better-sqlite3', 'ink', 'react'],
    // Shebang is in bin/uplnk.ts source — tsup preserves it at line 1.
    // Do NOT add a shebang banner here — it would be duplicated.
    // This createRequire shim lets bundled CJS code (e.g. undici) call
    // require() for Node built-ins inside an ESM bundle.
    banner: {
      js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
  },
  // Library entry — dist/ for programmatic imports and type declarations.
  {
    entry: { index: 'src/index.tsx' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    bundle: true,
    splitting: false,
    dts: true,
    clean: true,
    external: ['better-sqlite3', 'ink', 'react'],
  },
]);
