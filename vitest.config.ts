/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest automatically provides globals like describe, it, expect
    // so you don't have to import them every time.
    globals: true,
    // We are testing Node.js code, not browser code.
    environment: 'node',
  },
});