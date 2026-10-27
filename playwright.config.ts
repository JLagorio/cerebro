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
        'conversation-archive-import.spec.ts',
        'm92-rail.spec.ts',
        'floating-assistant.spec.ts',
        'pages-browser.spec.ts',
        'visual-pages.spec.ts',
        'page-title-polish.spec.ts',
        'record-page-composition.spec.ts',
        'editor-writing-polish.spec.ts',
        'selected-rewrite.spec.ts',
        'source-occurrences.spec.ts',
        'mention-link.spec.ts',
        'resource-targets.spec.ts',
        'run-configuration.spec.ts',
        'message-copy.spec.ts',
        'message-save.spec.ts',
        'polish-integration.spec.ts',
        'surface-system.spec.ts',
        'surface-states.spec.ts',
        'hover-preview.spec.ts',
        'data-display-polish.spec.ts',
        'data-reading-polish.spec.ts',
        'grouped-table-polish.spec.ts',
        'record-peek-polish.spec.ts',
        'workspace-redesign.spec.ts',
        'shell-join.spec.ts',
        'shell-layout.spec.ts',
        'status-bar.spec.ts',
        'sidebar-content.spec.ts',
        'workspace-surfaces.spec.ts',
        'home-document-polish.spec.ts',
        'settings-redesign.spec.ts',
        'workspace-backup-preview.spec.ts',
        'managed-credential-preview.spec.ts',
        'managed-access-preview.spec.ts',
        'workflow-library-preview.spec.ts',
        'm94-utilities-composition.spec.ts',
        'm94-embedded-repair.spec.ts',
        'm94-native-control-theme.spec.ts',
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
    // Surfaces arrive and leave in motion (components/ui/motion.ts), and a
    // spec measures a panel, a drawer or the assistant the moment it is on
    // screen — mid-slide, it would measure where it was going. Reduced
    // motion lands everything where it belongs in the commit that put it
    // there, as it does for a reader who asks for that. The motion itself is
    // proven where it plays, in e2e/motion.spec.ts.
    contextOptions: { reducedMotion: 'reduce' },
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
