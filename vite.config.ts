import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  // PORT lets a second checkout (worktree, CI lane) run its own dev server
  // beside an interactive one; strictPort keeps a taken port an error instead
  // of a silent drift onto a server built from different sources.
  server: { port: Number(process.env.PORT ?? 5173), strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // docs/ holds vendored reference repos (gitignored) with test suites of
    // their own — never run them. tolaria-main kept by name because it has
    // lived at the repo root too. e2e/ holds Playwright specs
    // (@playwright/test crashes under vitest).
    exclude: [...configDefaults.exclude, 'docs/**', '**/tolaria-main/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // RATCHET floors (M14.4): set a hair under measured reality
      // (49.45 / 59.15 / 81.8 on 2026-08-01) so they can only move UP.
      // Never edit downward — raise them as coverage grows.
      thresholds: {
        lines: 48,
        statements: 48,
        functions: 58,
        branches: 80,
      },
    },
  },
});
