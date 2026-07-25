/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // tolaria-main/ is a vendored reference repo (gitignored) with its own tests — never run them,
    // wherever it lives (it has moved between repo root and docs/). e2e/ holds
    // Playwright specs (@playwright/test crashes under vitest).
    exclude: [...configDefaults.exclude, '**/tolaria-main/**', 'e2e/**'],
  },
});
