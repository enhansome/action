import { configDefaults, defineConfig } from 'vitest/config';

// Single config driving both `vite build` and `vitest`. Importing defineConfig
// from 'vitest/config' gives us Vite's build options plus the `test` key typing.
export default defineConfig({
  build: {
    outDir: 'dist',
    // Wipe dist/ each build so stale .test.js / .d.ts from the old tsc setup
    // never linger (dist is gitignored, built at runtime by the action).
    emptyOutDir: true,
    sourcemap: true,
    // Readable output — this is a GitHub Action, not a browser payload.
    minify: false,
    // SSR/Node build (not lib/browser mode): Vite externalizes node built-ins
    // (fs, path, url, ...) AND package.json `dependencies` by default, so only
    // our source is bundled and the output targets Node — no "externalized for
    // browser compatibility" stubs. ESM output matches `"type": "module"`.
    ssr: 'src/main.ts',
  },
  test: {
    // Vitest automatically provides globals like describe, it, expect
    // so you don't have to import them every time.
    globals: true,
    // We are testing Node.js code, not browser code.
    environment: 'node',
    // Exclude the bundled output so vitest doesn't try to run it as a test.
    exclude: [...configDefaults.exclude, 'dist/**', '.claude/**', 'tuning/**'],
  },
});
