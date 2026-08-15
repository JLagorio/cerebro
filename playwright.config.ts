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
    // Reuse is OPT-IN (M32.7): a busy port now fails loudly instead of
    // silently testing another worktree's branch. Set CEREBRO_E2E_REUSE=1
    // to attach to a dev server you know is yours.
    reuseExistingServer: !process.env.CI && process.env.CEREBRO_E2E_REUSE === '1',
    timeout: 30_000,
  },
});
