import { expect, type Page } from '@playwright/test';

/**
 * Booting the app into the demo vault, the same way in every spec (M26.3e).
 *
 * This used to be six copies of the same function — five specs plus an inline
 * one in `smoke` — and AGENTS.md told you to add a seventh by copying an
 * existing one. Which meant that when boot needed to learn something new,
 * six files had to learn it, and in practice one of them wouldn't.
 */

/**
 * The day the demo vault was written to be read on.
 *
 * The corpus is a story with absolute dates in it: knowledge stamps run from
 * 2026-07-19 to 2026-07-28, and the work it describes is dated 2026-07-29
 * onward. Read on any other day the story drifts — and read far enough after
 * it, parts of it expire. That is not hypothetical: `recentlyLearned` offers
 * concepts written in the last fortnight, so on 2026-08-11 the Home card the
 * augment spec asserts on stopped rendering at all, and the spec had been
 * failing on every tree including a clean one.
 *
 * So the clock is pinned rather than the fixtures bumped. Bumping the stamps
 * moves the expiry by a fortnight and leaves the class of failure in place;
 * pinning removes it. Midday so that no plausible offset can roll the local
 * date either way, and the browser timezone is fixed to UTC in
 * `playwright.config.ts` so `todayIso()` — which reads LOCAL date parts —
 * cannot disagree with it.
 */
export const VAULT_TODAY = '2026-07-28T12:00:00Z';

export async function boot(page: Page): Promise<void> {
  // `setFixedTime` and not `install`: this freezes what the clock READS
  // without faking timers, so the app's intervals, debounces and Playwright's
  // own waiting all still run on real time.
  await page.clock.setFixedTime(new Date(VAULT_TODAY));
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    // Pin the theme (M16.39). These specs assert on rendered UI, and an unset
    // themeMode resolves 'system' — so a dark display would flip every colour
    // out from under them. The app has two palettes now; the specs assume one.
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  // With no persisted vault the first-launch chooser renders "Open demo
  // vault"; if the mock IPC restored a last vault it boots straight to the
  // shell. Handle both.
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Stage a mock seam BEFORE the app boots. Call this above `boot(page)`.
 *
 * Several seams (`__cerebroSeedReview`, `__cerebroSeedFleet`, …) have to be
 * populated before the first render, but they are installed by a module the
 * page loads — so the script polls for the seam rather than assuming it. This
 * used to be copy-pasted into whichever spec needed it, which is how
 * `review.spec.ts` ended up with a private boot that never pinned the clock.
 */
export async function seedBeforeBoot(page: Page, seam: string, ...args: unknown[]): Promise<void> {
  await page.addInitScript(
    ({ seam, args }) => {
      const install = () => {
        const seed = (window as unknown as Record<string, unknown>)[seam];
        if (typeof seed !== 'function') {
          setTimeout(install, 10);
          return;
        }
        (seed as (...a: unknown[]) => void)(...args);
      };
      install();
    },
    { seam, args },
  );
}

/**
 * Open one of the Knowledge tab's sections.
 *
 * M33a.2 folded the Status hub into Knowledge, and M37.3 flattened the rail
 * into the one nav column. M43.10 made Base a SECTION whose rows stand on
 * every surface, so the entry is the knowledge nav row itself. The sections
 * still carry `data-section`, which is what every assertion downstream
 * addresses.
 */
export async function openKnowledgeTab(page: Page, row: string) {
  await page.getByTestId('knowledge-nav-row').filter({ hasText: row }).click();
}

/** Read a file's full text (frontmatter + body) from the mock filesystem. */
export async function readMockFile(page: Page, path: string): Promise<string> {
  const text = await page.evaluate((p) => window.__cerebroMockFs.get(p), path);
  if (text === undefined) throw new Error(`mock fs has no file at ${path}`);
  return text;
}

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
    /** The M27.5 chip seam. The browser has no ledger, so a spec that wants
     * axes on screen stages the rows it wants to see. */
    __cerebroSeedChips: (rows: unknown[]) => void;
    /** The M27.8 lane seam. Same reason as the chips: every sentence in a
     * lane is composed in Rust, so a spec stages prose and asserts placement. */
    __cerebroSeedLanes: (view: unknown) => void;
    /** The M27.8 convergence seam. `null` restores the refusal a vault with
     * no ledger store gives, which a spec has to be able to render too. */
    __cerebroSeedChanges: (view: unknown) => void;
    /** The M28.1 gate seam. Evaluations are Rust over a real runtime DB, so
     * a spec that wants a recorded result on the board paints it. */
    __cerebroSeedTriggerLatest: (gate: string, latest: unknown) => void;
    /** The M24.9 review seam. The browser has no ledger, so a spec stages the
     * cards `policy/review.rs` would have returned. */
    __cerebroSeedReview: (fixture: unknown) => void;
  }
}
