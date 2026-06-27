/// <reference types="vitest" />
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest automatically provides globals like describe, it, expect
    // so you don't have to import them every time.
    globals: true,
    // We are testing Node.js code, not browser code.
    environment: 'node',
    // vitest v4 dropped dist from the default excludes; `tsc` compiles the
    // *.test.ts files into dist/, so exclude it to avoid running stale copies.
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
