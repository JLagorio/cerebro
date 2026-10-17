import { defineConfig } from '@playwright/test';

const port = process.env.PORT ?? '5173';
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  /**
   * One worker in CI, Playwright's own default (half the cores) locally.
   *
   * It was `1` everywhere. MEASURED on a 10-core machine, three consecutive
   * runs each: 124 passed in 2.8m at one worker, and in 1.0m / 1.2m / 1.1m at
   * five. Nothing here is serial — every test gets its own browser context and
   * its own mock disk, and the dev server only ever serves the bundle — so the
   * single worker was buying nothing and costing two thirds of the wall clock.
   *
   * CI is left exactly as it was on purpose: its runners are smaller and
   * shared, its flake budget is already spent on `retries: 2`, and this change
   * has only been measured here.
   */
  workers: process.env.CI ? 1 : undefined,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // The packaged app is WKWebView. The carrier spec runs there too (M55.4,
    // Q6): what a block writes to disk is the one claim jsdom and Chromium
    // can both pass while the shipped engine fails it.
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testMatch: [
        'editor-carriers.spec.ts',
        'sheets.spec.ts',
        'pdf-viewer.spec.ts',
        'page-attachments.spec.ts',
        'inbox-documents.spec.ts',
        'remote-images.spec.ts',
        'chat-canvas.spec.ts',
        'visual-pages.spec.ts',
        'workspace-redesign.spec.ts',
        'workspace-surfaces.spec.ts',
        'home-document-polish.spec.ts',
        'settings-redesign.spec.ts',
        'inbox-redesign.spec.ts',
      ],
    },
  ],
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
