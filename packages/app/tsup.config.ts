import { defineConfig } from 'tsup';

// `bun:sqlite` (and any other `bun:*` built-in scheme) is a Bun runtime
// built-in. esbuild has no resolver for it, so tsup must mark it external —
// the bundled output imports the scheme as-is, and Bun resolves it natively
// at runtime. Tsup's external array doesn't accept regex, so list every
// scheme we currently transit; add to this list if a new `bun:*` import
// surfaces during build.
const BUN_BUILTINS = ['bun:sqlite'];

// ink and react must remain external so their singleton state (hooks,
// context) is shared correctly across the render tree.
const SHARED_EXTERNAL = ['ink', 'react', ...BUN_BUILTINS];

export default defineConfig([
  // Binary entry — compiled to dist/ to keep bin/ as source-only.
  // package.json "bin" field points to dist/uplnk.js. Used by the Docker
  // image (which executes the bundled output via `bun dist/uplnk.js`); the
  // standalone cross-platform binaries are produced by `bun build --compile`
  // in build-binaries.yml, not by this tsup pipeline.
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
    external: SHARED_EXTERNAL,
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
    external: SHARED_EXTERNAL,
  },
]);
