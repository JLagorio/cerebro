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
    // The app reads LOCAL date parts (`todayIso`, `toIsoDate`), and `boot()`
    // pins the clock to an instant. Both only agree if the browser's zone is
    // fixed too — otherwise the same pinned instant is a different calendar
    // day on a developer's machine than it is in CI (M26.3e).
    timezoneId: 'UTC',
  },
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
