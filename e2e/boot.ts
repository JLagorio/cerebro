import { expect, type Page } from '@playwright/test';
import { VAULT_TODAY } from '../src/lib/vaultToday';

/**
 * Booting the app into the demo vault, the same way in every spec (M26.3e).
 *
 * This used to be six copies of the same function — five specs plus an inline
 * one in `smoke` — and AGENTS.md told you to add a seventh by copying an
 * existing one. Which meant that when boot needed to learn something new,
 * six files had to learn it, and in practice one of them wouldn't.
 */

/** The day the demo vault was written to be read on; its reasons live in
 * `src/lib/vaultToday.ts`, which the state lab's clock pins too (M64.1). */
export { VAULT_TODAY };

/** What a spec may change about the boot (M57.2). */
export interface BootOptions {
  /** Let the background job runner fire (M8.6): off unless a spec is about
   * a scheduled run. */
  autoLearn?: boolean;
}

export async function boot(page: Page, { autoLearn = false }: BootOptions = {}): Promise<void> {
  // `setFixedTime` and not `install`: this freezes what the clock READS
  // without faking timers, so the app's intervals, debounces and Playwright's
  // own waiting all still run on real time.
  await page.clock.setFixedTime(new Date(VAULT_TODAY));
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript((learn) => {
    window.localStorage.setItem('cerebro.autoLearn', String(learn));
    // Pin the theme (M16.39). These specs assert on rendered UI, and an unset
    // themeMode resolves 'system' — so a dark display would flip every colour
    // out from under them. The app has two palettes now; the specs assume one.
    window.localStorage.setItem('cerebro.themeMode', 'light');
  }, autoLearn);
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
 * Open one of the Knowledge page's three tabs (M51): Concepts (`all`),
 * Review, Activity.
 *
 * M33a.2 folded the Status hub into Knowledge; M50.5 made its views tabs on
 * the Knowledge page; M51 cut the eight tabs to three. The status sections
 * live on as sections of Review (Waiting on you) and Activity (What changed,
 * the lanes, the log), and still carry `data-section`, which is what every
 * assertion downstream addresses. (The fleet lives on Agents — `openAgents`.)
 */
export async function openKnowledgeTab(page: Page, tab: 'all' | 'review' | 'activity') {
  await page.getByRole('button', { name: 'Open Knowledge' }).click();
  await page.getByTestId(`knowledge-tab-${tab}`).click();
}

/** Activity's folded System section: background work and deferral gates. */
export async function openKnowledgeSystem(page: Page) {
  await openKnowledgeTab(page, 'activity');
  const system = page.getByTestId('knowledge-system');
  if ((await system.getAttribute('open')) === null) await system.locator('summary').click();
}

/** A concept page's Details — its side panel, closed until asked (M51.3). */
export async function showConceptDetails(page: Page) {
  const panel = page.getByTestId('knowledge-panel');
  if ((await panel.count()) === 0) await page.getByRole('button', { name: 'Show panel' }).click();
  await expect(panel).toBeVisible();
  return panel;
}

/** The fleet's one home since M50.5: the Agents surface. */
export async function openAgents(page: Page) {
  await page.getByRole('button', { name: 'Open all agents' }).click();
}

/** Read a file's full text (frontmatter + body) from the mock filesystem. */
export async function readMockFile(page: Page, path: string): Promise<string> {
  const text = await page.evaluate((p) => window.__cerebroMockFs.get(p), path);
  if (text === undefined) throw new Error(`mock fs has no file at ${path}`);
  return text;
}

/**
 * Open the state lab on one section's preset (M64.1): the same pinned clock
 * `boot` uses, then `/state-lab.html?section=&state=`, then wait until the
 * preset has been applied and its section mounted.
 *
 * No `cerebro.*` storage is seeded: the lab reads none and writes none, and
 * its theme toggle touches only this document.
 */
export async function openStateLab(page: Page, section: string, state: string): Promise<void> {
  await page.clock.setFixedTime(new Date(VAULT_TODAY));
  const query = new URLSearchParams({ section, state }).toString();
  await page.goto(`/state-lab.html?${query}`);
  await expect(page.locator('[data-testid="lab-stage"][data-ready]')).toBeVisible({
    timeout: 10_000,
  });
}

/** One commit the history seam stages (M58.4), as `SeedCommit` spells it. */
export interface E2eSeedCommit {
  hash: string;
  message: string;
  author?: string;
  date: number;
  files: { path: string; status: string; previousPath?: string }[];
  snapshots: Record<string, string | null>;
  run?: { runId: string; actor: string } | null;
}

/** One lab preset as `window.__cerebroLabPresets` lists it (M64.1). */
export interface E2eLabPreset {
  section: string;
  state: string;
  url: string;
  expect: { present: string[]; absent?: string[]; text?: string };
}

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
    /** The M64.1 fault seam: the next read of this command fails once. */
    __cerebroFailNext: (command: string) => void;
    /** The M59.4 page-text seam: ⌘K's searchVault rejects with this message
     * until it is called again with null. */
    __cerebroFailSearchVault: (message: string | null) => void;
    /** Every state-lab preset, set by the lab page in dev (M64.1). */
    __cerebroLabPresets: E2eLabPreset[];
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
    /** The M58.4 history seam (src/lib/mockGit.ts `seedGitHistory`): stage
     * commits, newest first, each with the bytes its files held and, for a
     * run's commit, the run runtime.db's record names. */
    __cerebroSeedGitHistory: (commits: E2eSeedCommit[]) => void;
    /** The M55.6 write gate. While it holds a promise, the mock agent's write
     * steps wait for it, so a spec can type into the open page between the
     * ask and the write. */
    __cerebroAgentWriteGate?: Promise<void>;
    /** The M55.10 quit seam: ask to quit, as ⌘Q, the close button and ⌘W
     * do in the app, with the deadline Rust would name (5000 by default). */
    __cerebroMockQuit: (deadlineMs?: number) => void;
    /** What the webview answered each quit: `finished` or `cancelled`. */
    __cerebroMockQuitLog: string[];
    /** The M57.2 withheld-tool rows a mock run booked, as Rust's meter
     * writes them under `agent.ask`. */
    __cerebroMockRefusals?: { run: string; code: string; surface: string; detail: string }[];
    /** The M57.2 disclosure seam: what Settings reads as the person's own
     * Claude Code settings. Unset, the browser answers `browser`. */
    __cerebroSeedClaudeSettings?: unknown;
    /** The M57.4c unattended seam: start a run of `actor` nobody watches, as
     * a schedule would, so its ask-first page writes wait in Review. */
    __cerebroRunUnattended: (
      vault: string,
      run: { message: string; actor: string; scope?: string[] | null; askFirst?: boolean },
    ) => Promise<unknown>;
    /** The M70.1 comment probe, on the last mounted editor in browser mode
     * (`CommentProbe` in src/editor/commentHighlights.ts): the selection as
     * an anchor, threads to draw, and how each one resolved. */
    __cerebroCommentProbe?: {
      anchor: () =>
        | { ok: true; anchor: E2eCommentAnchor; start: number; end: number }
        | { ok: false; reason: string };
      show: (threads: { id: string; anchor: E2eCommentAnchor }[]) => void;
      resolutions: () => Record<
        string,
        | { kind: 'attached'; start: number; end: number; moved: boolean }
        | { kind: 'detached'; reason: 'gone' | 'ambiguous'; count: number }
      >;
    };
  }
}

/** A comment anchor as the probe hands it over (`CommentAnchor`, M70.1). */
export interface E2eCommentAnchor {
  quote: string;
  occurrence: number;
  before: string;
  after: string;
}
