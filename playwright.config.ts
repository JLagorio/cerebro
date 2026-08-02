import { defineConfig } from '@playwright/test';

const port = process.env.PORT ?? '5173';
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    baseURL,
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
