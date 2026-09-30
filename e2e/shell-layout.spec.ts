import { test, expect, type Locator, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * M52 — the assistant is never pushed off-screen.
 *
 * The owner, 2026-09-29, on a 2000px window: "when I expand the preview
 * record it doesn't scale with the chat window well." The record's peek took
 * ~1150px and the assistant beside it showed 70px, its text cut mid-word.
 * Measured before the fix at 1440×900: the peek's « control set it to 1000px
 * and the assistant began AT the window's right edge; at 1280×800 the default
 * widths alone clipped 300px of it. Both panels were `flex-none` inside a slot
 * capped at `100% - 400px`, and the slot's `overflow-hidden` cut off whichever
 * came last.
 */

/**
 * A table of Epics, a record open in the peek, and the assistant open.
 * `record` names the row; the first one by default.
 */
async function peekBesideAssistant(
  page: Page,
  record?: string,
): Promise<{ peek: Locator; assistant: Locator }> {
  await page.getByTestId('sidebar-type').filter({ hasText: 'Epic' }).first().click();
  const rows = page.getByTestId('table-row');
  const row = (record === undefined ? rows : rows.filter({ hasText: record })).first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const peek = page.getByTestId('detail-panel');
  await expect(peek).toBeVisible();
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const assistant = page.getByTestId('ai-panel');
  await expect(assistant).toBeVisible();
  return { peek, assistant };
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (b === null) throw new Error('not laid out');
  return b;
}

/** The whole of the panel is inside the window: nothing clipped, nothing off the edge. */
async function expectInsideViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('no viewport');
  const b = await box(locator);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
}

const storedWidth = (page: Page, key: string) =>
  page.evaluate((k) => Number(window.localStorage.getItem(k)), key);

/** Opens a page by title through Quick Open. */
async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
}

async function openAssistant(page: Page): Promise<Locator> {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const assistant = page.getByTestId('ai-panel');
  await expect(assistant).toBeVisible();
  return assistant;
}

const stored = (page: Page, key: string) =>
  page.evaluate((k) => window.localStorage.getItem(k), key);

/** One animation frame, so a scripted resize is drawn before the next one. */
const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

interface Frame {
  /** The window's width when this sample was taken. */
  at: number;
  /** Where it was taken: the window's `resize` event, or an animation frame. */
  when: 'resize' | 'frame';
  /** The drawn assistant's width, and how much of it the window and slot let through. */
  width: number | null;
  shown: number | null;
  /** The right edges of Send and the close button, and of what is visible. */
  send: number | null;
  close: number | null;
  edge: number | null;
  /** The parked tab is on screen, whole. */
  tab: boolean;
}
type FrameLog = { __frames: Frame[] };

/**
 * Samples the assistant at every chance a layout gets: each `resize` event
 * and each animation frame. Either one lays the page out at the new size, so
 * a plan React has not yet caught up with shows up as a bad sample — which is
 * what a decision made from a `matchMedia` listener or a measurement is.
 */
async function logAssistantFrames(page: Page) {
  await page.evaluate(() => {
    const log: Frame[] = [];
    (window as unknown as FrameLog).__frames = log;
    const shown = (el: Element | null) =>
      el !== null && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const sample = (when: Frame['when']) => {
      const ai = document.querySelector('[data-testid="ai-panel"]');
      const slot = document.querySelector('[data-testid="right-panel-slot"]');
      if (ai === null || slot === null) return;
      const tabEl = document.querySelector('[data-testid="ai-parked-tab"]');
      const t = tabEl?.getBoundingClientRect();
      const tab = shown(tabEl) && t !== undefined && t.width > 0 && t.right <= innerWidth + 0.5;
      // Parked is not drawn: hidden, or clipped to a strip no wider than its border.
      if (!shown(ai) || ai.getBoundingClientRect().width <= 1) {
        log.push({
          at: innerWidth,
          when,
          width: null,
          shown: null,
          send: null,
          close: null,
          edge: null,
          tab,
        });
        return;
      }
      const r = ai.getBoundingClientRect();
      const edge = Math.min(r.right, slot.getBoundingClientRect().right, innerWidth);
      const buttons = [...ai.querySelectorAll('button')];
      const right = (b: Element | undefined) => b?.getBoundingClientRect().right ?? null;
      log.push({
        at: innerWidth,
        when,
        width: Math.round(r.width),
        shown: Math.round(edge - r.left),
        send: right(buttons.find((b) => /^(Send|Stop)$/.test(b.textContent?.trim() ?? ''))),
        close: right(buttons.find((b) => b.getAttribute('aria-label') === 'Close AI panel')),
        edge,
        tab,
      });
    };
    window.addEventListener('resize', () => sample('resize'));
    const tick = () => {
      sample('frame');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as unknown as FrameLog).__frames);
}

/** Every sample in which the assistant was clipped, squeezed, or simply gone. */
function badFrames(log: Frame[]): Frame[] {
  return log.filter((f) => {
    if (f.width === null) return !f.tab;
    if (f.width < 319 || (f.shown ?? 0) < f.width - 1) return true;
    const edge = (f.edge ?? 0) + 0.5;
    return (f.send !== null && f.send > edge) || (f.close !== null && f.close > edge);
  });
}

test.describe('shell layout (M52)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the peek shrinks to the room beside the assistant, and the assistant keeps its width', async ({
    page,
  }) => {
    await boot(page);
    const { peek, assistant } = await peekBesideAssistant(page);
    await expectInsideViewport(page, assistant);
    // Already at the default 560 there is less room than that at 1440.
    // Rounded: read mid-entrance, the panel's translate puts float noise in
    // its box (396.00006).
    const drawn = Math.round((await box(peek)).width);
    expect(drawn).toBeLessThan(560);
    expect((await box(assistant)).width).toBe(380);
    // The two sit edge to edge, so nothing is drawn under anything.
    const p = await box(peek);
    expect(Math.round(p.x + p.width)).toBe(Math.round((await box(assistant)).x));

    // The owner's "expand". It stored 1000 and drew what 560 did, then read
    // "Narrow the panel" — a control that changed nothing on screen. With no
    // room to widen into it says so, and why.
    const widen = peek.getByRole('button', { name: 'No room to widen — close the Assistant' });
    await expect(widen).toBeDisabled();
    expect(Math.round((await box(peek)).width)).toBe(drawn);
  });

  test("the owner's window: widening the peek fills the room and leaves the assistant whole", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2000, height: 1293 });
    await boot(page);
    const { peek, assistant } = await peekBesideAssistant(page);
    const before = await box(assistant);
    await peek.getByRole('button', { name: 'Widen the panel' }).click();
    await expect.poll(() => storedWidth(page, 'cerebro.detailWidth')).toBe(1000);

    // Drawn at the room there is — wider than the default, short of 1000 …
    await expect.poll(async () => (await box(peek)).width).toBeGreaterThan(560);
    expect((await box(peek)).width).toBeLessThan(1000);
    // … the assistant still wholly on screen at the width it had …
    await expectInsideViewport(page, assistant);
    expect((await box(assistant)).width).toBe(before.width);
    // … and the control reads what is on screen.
    await expect(peek.getByRole('button', { name: 'Narrow the panel' })).toBeEnabled();
  });

  test('a drag stores only a width it drew, and one that cannot widen stores nothing', async ({
    page,
  }) => {
    // The assistant at its widest leaves the peek only its 320px floor. The
    // drag minimum was 360, so a drag there stored a width never drawn; then
    // the ceiling was the drawn width, so a drag to WIDEN stored 320 over the
    // 560 the user had chosen, and kept it once the room came back.
    await page.addInitScript(() => window.localStorage.setItem('cerebro.aiPanelWidth', '720'));
    await boot(page);
    const { peek, assistant } = await peekBesideAssistant(page);
    const handle = peek.getByRole('separator', { name: 'Resize detail panel' });
    const h = await box(handle);
    await page.mouse.move(h.x + h.width / 2, h.y + 200);
    await page.mouse.down();
    await page.mouse.move(40, h.y + 200, { steps: 8 });
    await page.mouse.up();

    await expectInsideViewport(page, assistant);
    const drawn = Math.round((await box(peek)).width);
    expect(drawn).toBe(320);
    await expect(handle).toHaveAttribute('aria-valuenow', String(drawn));
    expect(await storedWidth(page, 'cerebro.detailWidth')).toBe(560);

    // With the assistant closed the room comes back, and so does the 560.
    await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
    await expect(assistant).toHaveCount(0);
    await expect.poll(async () => Math.round((await box(peek)).width)).toBe(560);

    // A drag that narrows it stores what it draws.
    const g = await box(handle);
    await page.mouse.move(g.x + g.width / 2, g.y + 200);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 100, g.y + 200, { steps: 6 });
    await page.mouse.up();
    const narrowed = Math.round((await box(peek)).width);
    expect(narrowed).toBeLessThan(560);
    await expect.poll(() => storedWidth(page, 'cerebro.detailWidth')).toBe(narrowed);
  });

  test('the sidebar header keeps its controls at the sidebar floor', async ({ page }) => {
    // Peek + assistant at 1280 squeeze the sidebar to its 180px floor, where
    // the wordmark pushed Hide sidebar past the sidebar's clipped edge.
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    await peekBesideAssistant(page);
    const sidebar = page.getByTestId('sidebar');
    const s = await box(sidebar);
    expect(Math.round(s.width)).toBe(180);
    for (const name of ['Assistant', 'Search', 'Hide sidebar']) {
      const b = await box(sidebar.getByRole('button', { name, exact: true }));
      expect(b.x + b.width).toBeLessThanOrEqual(s.x + s.width);
    }
  });

  test("a concept's Details panel stays readable beside the assistant", async ({ page }) => {
    // Verified at 1200 with the default assistant: the reading column at
    // 284px, Verify cut off the review bar, the sidebar still at 264.
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.addInitScript(() => window.localStorage.setItem('cerebro.conceptPanelOpen', 'true'));
    await boot(page);
    const assistant = await openAssistant(page);
    await openPage(page, 'Sync error rate');
    const column = page.getByTestId('doc-column');
    const side = page.getByTestId('doc-side-panel');
    await expect(side).toBeVisible();

    // The sidebar gave first, so the column holds its floor with the panel beside it.
    expect((await box(page.getByTestId('sidebar'))).width).toBeLessThan(264);
    const c = await box(column);
    expect(c.width).toBeGreaterThanOrEqual(360);
    expect(await side.getAttribute('data-overlay')).toBeNull();
    const verify = await box(column.getByRole('button', { name: 'Verify' }));
    expect(verify.x + verify.width).toBeLessThanOrEqual(c.x + c.width);
    await expectInsideViewport(page, assistant);
  });

  test('with no room beside the column the side panel folds, and opens as a drawer', async ({
    page,
  }) => {
    // 1100: the column fell to 200px beside the panel and the title broke
    // mid-word. The fold is derived — it never writes the stored flag.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.addInitScript(() => window.localStorage.setItem('cerebro.conceptPanelOpen', 'true'));
    await boot(page);
    const assistant = await openAssistant(page);
    await openPage(page, 'Sync error rate');
    const column = page.getByTestId('doc-column');
    await expect(page.getByTestId('doc-side-panel')).toHaveCount(0);
    expect((await box(column)).width).toBeGreaterThanOrEqual(360);
    expect(await page.evaluate(() => localStorage.getItem('cerebro.conceptPanelOpen'))).toBe(
      'true',
    );

    // Asked for, it floats over the column rather than crushing it.
    await page.getByTestId('doc-page').getByRole('button', { name: 'Show panel' }).click();
    const side = page.getByTestId('doc-side-panel');
    await expect(side).toHaveAttribute('data-overlay', 'true');
    expect((await box(column)).width).toBeGreaterThanOrEqual(360);
    await expectInsideViewport(page, side);
    await expectInsideViewport(page, assistant);

    // Hiding it is the user's word, and that one is written.
    await page.getByTestId('doc-page').getByRole('button', { name: 'Hide panel' }).click();
    await expect(side).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('cerebro.conceptPanelOpen'))).toBe(
      'false',
    );
  });

  test('a window drag never clips the assistant, not even for a frame', async ({ page }) => {
    // The panels' widths came from a ResizeObserver, so they were drawn a
    // frame behind the window, and for that frame the slot's overflow cut
    // off the assistant's Send and close. CSS does the give now, in the same
    // layout pass as the window. A widened record is the hard case: it is
    // the one that has to give at every step.
    await page.addInitScript(() => window.localStorage.setItem('cerebro.detailWidth', '1000'));
    await boot(page);
    const { assistant } = await peekBesideAssistant(page);
    const frames = await logAssistantFrames(page);
    for (let width = 1440; width >= 1230; width -= 6) {
      await page.setViewportSize({ width, height: 900 });
      await nextFrame(page);
    }
    for (let width = 1230; width <= 1440; width += 6) {
      await page.setViewportSize({ width, height: 900 });
      await nextFrame(page);
    }
    const log = await frames();
    expect(log.length).toBeGreaterThan(60);
    expect(badFrames(log)).toEqual([]);
    await expectInsideViewport(page, assistant);
  });

  test('a jump across the rail and park widths draws no frame of the old plan', async ({
    page,
  }) => {
    // The rail and the park were React state fed by `matchMedia`, whose
    // change arrives after the frame at the new size is laid out. Verified:
    // 1300→1000 drew the assistant 80px wide with Send past the window's edge
    // for a frame, and 1221→1083 drew it 183px wide. CSS decides both now.
    await boot(page);
    await peekBesideAssistant(page);
    const frames = await logAssistantFrames(page);
    const jumps = [1300, 1000, 1300, 1240, 1190, 1240, 1221, 1083, 1221, 1500, 1100, 1500, 1050];
    for (const width of jumps) {
      await page.setViewportSize({ width, height: 900 });
      await nextFrame(page);
      await nextFrame(page);
    }
    const log = await frames();
    // Every width in the list was sampled, drawn or parked.
    expect(jumps.filter((w) => !log.some((f) => f.at === w))).toEqual([]);
    expect(badFrames(log)).toEqual([]);
  });

  test('below 1220 the sidebar steps down to its rail, and the assistant stays', async ({
    page,
  }) => {
    // It used to park the moment the window was under 1220 — the zap still
    // pressed, nothing on screen saying where it went — and the sidebar then
    // jumped 180→264 as the window got smaller.
    await page.setViewportSize({ width: 1150, height: 800 });
    await boot(page);
    const { peek, assistant } = await peekBesideAssistant(page);
    const rail = page.getByTestId('sidebar-rail');
    await expect(rail).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expectInsideViewport(page, assistant);
    const p = await box(peek);
    expect(Math.round(p.x + p.width)).toBe(Math.round((await box(assistant)).x));
    // The rail is derived: the user's collapsed flag is not the shell's word.
    expect(await stored(page, 'cerebro.sidebarCollapsed')).toBeNull();

    // Its expand opens the whole sidebar as a drawer; Escape closes it.
    await rail.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-overlay', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(peek).toBeVisible();
    expect(await stored(page, 'cerebro.sidebarCollapsed')).toBeNull();

    // Too narrow even beside the rail: the record wins (M17.2), and the
    // assistant's tab says so — without the sidebar growing into the room.
    const railWidth = (await box(rail)).width;
    await page.setViewportSize({ width: 1050, height: 800 });
    const tab = page.getByRole('button', {
      name: 'Assistant hidden — close the record to show it',
    });
    await expect(tab).toBeVisible();
    await expectInsideViewport(page, tab);
    await expectInsideViewport(page, peek);
    expect((await box(rail)).width).toBe(railWidth);
    await expect(assistant).toBeHidden();
    await expect(page.getByTestId('ai-panel-frame')).toHaveAttribute('data-parked', 'true');
    // Where the record has no room to widen, the control does not tell you to
    // close an assistant that takes none — the tab beside it says to close
    // the record. (Verified at 900 and 1000: both said so at once.)
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(peek.getByRole('button', { name: 'No room to widen' })).toBeDisabled();
    await expect(peek.getByRole('button', { name: /close the Assistant/ })).toHaveCount(0);
    await expect(tab).toBeVisible();

    // The tab is the way back: the record closes and the assistant is drawn.
    await tab.click();
    await expect(peek).toHaveCount(0);
    await expect(assistant).toBeVisible();
    await expectInsideViewport(page, assistant);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('below the rail width the assistant parks without costing the sidebar', async ({ page }) => {
    // Verified at 1050: pressing the Assistant beside a record took the
    // sidebar from 264 to its 44px rail and parked the assistant anyway.
    await page.setViewportSize({ width: 1050, height: 800 });
    await boot(page);
    await page.getByTestId('sidebar-type').filter({ hasText: 'Epic' }).first().click();
    const row = page.getByTestId('table-row').first();
    await row.hover();
    await row.getByRole('button', { name: /^Open / }).click();
    const peek = page.getByTestId('detail-panel');
    await expect(peek).toBeVisible();
    const sidebar = page.getByTestId('sidebar');
    const before = Math.round((await box(sidebar)).width);

    await sidebar.getByRole('button', { name: 'Assistant' }).click();
    await expect(page.getByTestId('ai-parked-tab')).toBeVisible();
    await expect(page.getByTestId('sidebar-rail')).toBeHidden();
    await expect(sidebar).toBeVisible();
    expect(Math.round((await box(sidebar)).width)).toBe(before);
    await expectInsideViewport(page, peek);
  });

  test("the sidebar's drag stops at the width it can draw", async ({ page }) => {
    // Verified at 1440: dragged wide beside a record and the assistant it
    // stored 460, drew 340, and leapt to 460 the moment the record closed.
    await boot(page);
    const { peek, assistant } = await peekBesideAssistant(page);
    const sidebar = page.getByTestId('sidebar');
    const handle = sidebar.getByRole('separator', { name: 'Resize sidebar' });
    const h = await box(handle);
    await page.mouse.move(h.x + h.width / 2, h.y + 200);
    await page.mouse.down();
    await page.mouse.move(900, h.y + 200, { steps: 8 });
    await page.mouse.up();

    const drawn = Math.round((await box(sidebar)).width);
    expect(drawn).toBe(1440 - (400 + 320 + 380));
    await expect.poll(() => storedWidth(page, 'cerebro.sidebarWidth')).toBe(drawn);
    await expect(handle).toHaveAttribute('aria-valuenow', String(drawn));
    await expectInsideViewport(page, assistant);

    await peek.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(peek).toHaveCount(0);
    expect(Math.round((await box(sidebar)).width)).toBe(drawn);
  });

  test('a drag that cannot widen the sidebar keeps the width it had', async ({ page }) => {
    // Verified at 1280: the ceiling beside a record and the assistant is the
    // sidebar's 180 floor, so a drag to widen it stored 180 over its 264 and
    // it stayed 180 once the record closed.
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    const { peek } = await peekBesideAssistant(page);
    const sidebar = page.getByTestId('sidebar');
    const handle = sidebar.getByRole('separator', { name: 'Resize sidebar' });
    await expect(handle).toHaveAttribute('aria-valuemax', '180');
    const h = await box(handle);
    await page.mouse.move(h.x + h.width / 2, h.y + 200);
    await page.mouse.down();
    await page.mouse.move(900, h.y + 200, { steps: 8 });
    await page.mouse.up();

    expect(Math.round((await box(sidebar)).width)).toBe(180);
    // Untouched, or written back as it was — never the 180 it was drawn at.
    expect((await stored(page, 'cerebro.sidebarWidth')) ?? '264').toBe('264');
    await peek.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(peek).toHaveCount(0);
    await expect.poll(async () => Math.round((await box(sidebar)).width)).toBe(264);
  });

  test("a relation keeps its chevron on the first chip's line at the peek's floor", async ({
    page,
  }) => {
    // At 320px the Delivers chip ellipsised and its chevron wrapped to a line
    // of its own; with two chips on two lines it then sat between them.
    // First-week activation delivers two key results.
    await page.addInitScript(() => window.localStorage.setItem('cerebro.aiPanelWidth', '720'));
    await boot(page);
    const { peek } = await peekBesideAssistant(page, 'First-week activation');
    await expect(peek.getByRole('heading', { name: 'First-week activation' })).toBeVisible();
    expect(Math.round((await box(peek)).width)).toBe(320);
    const field = peek.getByRole('button', { name: 'Edit Delivers' });
    const chips = field.getByTestId('relation-chip');
    await expect(chips).toHaveCount(2);
    const [first, second] = [await box(chips.nth(0)), await box(chips.nth(1))];
    // The case: the chips wrap onto two lines.
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
    const chevron = await box(field.getByTestId('relation-chevron'));
    const middle = chevron.y + chevron.height / 2;
    expect(middle).toBeGreaterThan(first.y);
    expect(middle).toBeLessThan(first.y + first.height);
    const group = await box(field.getByTestId('relation-chips'));
    expect(chevron.x).toBeGreaterThanOrEqual(group.x + group.width - 1);
    const f = await box(field);
    expect(chevron.x + chevron.width).toBeLessThanOrEqual(f.x + f.width + 1);
  });

  test('a drawer closes on Escape and on the column it covers, never writing the flag', async ({
    page,
  }) => {
    // Its header toggle was the only way out.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.addInitScript(() => window.localStorage.setItem('cerebro.conceptPanelOpen', 'true'));
    await boot(page);
    await openAssistant(page);
    await openPage(page, 'Sync error rate');
    const show = page.getByTestId('doc-page').getByRole('button', { name: 'Show panel' });
    const side = page.getByTestId('doc-side-panel');
    const column = page.getByTestId('doc-column');

    await show.click();
    await expect(side).toHaveAttribute('data-overlay', 'true');
    // The drawer takes focus, so the toggle's focus tooltip — which stacked
    // itself above the drawer and took the first Escape — never comes up.
    await expect(side).toBeFocused();
    // Nor does its hover tooltip, with the pointer left resting on the toggle
    // that opened it: that one took the first Escape too, so closing the
    // drawer took two. The toggle withholds it while its drawer is open.
    await page.waitForTimeout(700);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(side).toHaveCount(0);
    expect(await stored(page, 'cerebro.conceptPanelOpen')).toBe('true');
    // Escape is the keyboard's way out, so focus goes back where it came from.
    await expect(show).toBeFocused();

    await show.click();
    await expect(side).toHaveAttribute('data-overlay', 'true');
    const c = await box(column);
    await page.mouse.click(c.x + 40, c.y + c.height / 2);
    await expect(side).toHaveCount(0);
    expect(await stored(page, 'cerebro.conceptPanelOpen')).toBe('true');
    // Folded, not hidden: the toggle still offers the panel.
    await expect(show).toBeVisible();
  });

  test("Escape in the composer's [[ menu closes the menu, not the drawer", async ({ page }) => {
    // The drawer registered as a layer and took Escape on window capture; the
    // menu took it in the textarea's bubble phase, which it never reached.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.addInitScript(() => window.localStorage.setItem('cerebro.conceptPanelOpen', 'true'));
    await boot(page);
    const assistant = await openAssistant(page);
    await openPage(page, 'Sync error rate');
    await page.getByTestId('doc-page').getByRole('button', { name: 'Show panel' }).click();
    const side = page.getByTestId('doc-side-panel');
    await expect(side).toHaveAttribute('data-overlay', 'true');

    const composer = assistant.getByRole('textbox', { name: 'Message the assistant' });
    await composer.click();
    await composer.pressSequentially('see [[Pick');
    const menu = assistant.getByTestId('wikilink-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(side).toHaveAttribute('data-overlay', 'true');
    await expect(composer).toHaveValue('see [[Pick');
    // The next Escape is the drawer's.
    await page.keyboard.press('Escape');
    await expect(side).toHaveCount(0);
  });

  test('a multi-page doc folds its Pages panel before the side panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
    await boot(page);
    await openPage(page, 'How we schedule');
    await page.getByTestId('doc-page').getByRole('button', { name: 'Page options' }).click();
    await page.getByRole('menuitem', { name: 'Add page' }).click();
    await page.getByPlaceholder('Page name').fill('Appendix');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-pages-panel')).toBeVisible();
    const assistant = await openAssistant(page);

    // Pages (216) + side (272) + column beside a 380px assistant: the Pages
    // panel folds to its button, the side panel stays, the column holds.
    await expect(page.getByTestId('doc-pages-panel')).toHaveCount(0);
    await expect(page.getByTestId('doc-side-panel')).toBeVisible();
    expect((await box(page.getByTestId('doc-column'))).width).toBeGreaterThanOrEqual(360);
    await expectInsideViewport(page, assistant);

    // The button opens it as a drawer; the stored flag was never touched.
    const pages = page.getByTestId('doc-pages-panel');
    await page.getByTestId('doc-pages-floating').click();
    await expect(pages).toHaveAttribute('data-overlay', 'true');
    expect(await page.evaluate(() => localStorage.getItem('cerebro.docPagesOpen'))).toBeNull();

    // And it closes the ways a drawer does: Escape — one, with the pointer
    // still resting where the button was — and the column it covers.
    await page.waitForTimeout(700);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(pages).toHaveCount(0);
    await page.getByTestId('doc-pages-floating').click();
    await expect(pages).toHaveAttribute('data-overlay', 'true');
    const column = await box(page.getByTestId('doc-column'));
    await page.mouse.click(column.x + column.width - 40, column.y + column.height / 2);
    await expect(pages).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('cerebro.docPagesOpen'))).toBeNull();
  });

  test('Escape in a field in a drawer leaves the field, keeps what was typed, and the drawer', async ({
    page,
  }) => {
    // The drawer took Escape on window capture, ahead of the field, and
    // unmounted it with its draft unsaved; docked, the same keystroke left the
    // value in the field. A loose frontmatter key commits on blur.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
    await boot(page);
    await openAssistant(page);
    await openPage(page, 'Phoenix cutover standup');
    await page.getByTestId('doc-page').getByRole('button', { name: 'Show panel' }).click();
    const side = page.getByTestId('doc-side-panel');
    await expect(side).toHaveAttribute('data-overlay', 'true');
    await page.getByTestId('doc-panel-tab-info').click();

    const field = side.getByRole('textbox', { name: 'Ingest format' });
    await field.fill('webvtt');
    await page.keyboard.press('Escape');
    await expect(side).toHaveAttribute('data-overlay', 'true');
    await expect(field).toHaveValue('webvtt');
    await expect(side).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => window.__cerebroMockFs.get('inbox/phoenix-cutover-standup.md') ?? ''),
      )
      .toContain('ingest_format: webvtt');

    // Out of the field, the next Escape is the drawer's.
    await page.keyboard.press('Escape');
    await expect(side).toHaveCount(0);
    expect(await stored(page, 'cerebro.docPanelOpen')).toBe('true');
  });

  for (const width of [900, 915, 931]) {
    test(`at ${width}px the parked assistant's tab stays on screen`, async ({ page }) => {
      // Tauri's window floor is 900. Under 932 a sidebar column, the record's
      // floor and the canvas's left the tab 20px of itself at 920 and none at
      // 900, so the assistant was parked behind a tab nobody could see.
      await page.setViewportSize({ width, height: 800 });
      await boot(page);
      await page.getByTestId('sidebar-type').filter({ hasText: 'Epic' }).first().click();
      const row = page.getByTestId('table-row').first();
      await row.hover();
      await row.getByRole('button', { name: /^Open / }).click();
      const peek = page.getByTestId('detail-panel');
      await expect(peek).toBeVisible();
      await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();

      const tab = page.getByTestId('ai-parked-tab');
      await expect(tab).toBeVisible();
      await expectInsideViewport(page, tab);
      expect(Math.round((await box(tab)).width)).toBe(32);
      await expectInsideViewport(page, peek);
      // The rail makes the room, and the user's flag is not what did it.
      await expect(page.getByTestId('sidebar-rail')).toBeVisible();
      await expect(page.getByTestId('sidebar')).toBeHidden();
      expect(await stored(page, 'cerebro.sidebarCollapsed')).toBeNull();

      // Where the column and the tab both fit, the column comes back.
      await page.setViewportSize({ width: 932, height: 800 });
      await expect(page.getByTestId('sidebar')).toBeVisible();
      await expect(page.getByTestId('sidebar-rail')).toBeHidden();
      await expectInsideViewport(page, tab);
    });
  }

  test("the peek's header keeps to one line at its floor", async ({ page }) => {
    // At 320px the type wrapped to "Key / result", the controls were
    // squeezed under their icons, and Close sat past the panel's edge.
    await page.addInitScript(() => window.localStorage.setItem('cerebro.aiPanelWidth', '720'));
    await boot(page);
    for (const type of ['Key result', 'Work item']) {
      await page.getByTestId('sidebar-type').filter({ hasText: type }).first().click();
      const row = page.getByTestId('table-row').first();
      await row.hover();
      await row.getByRole('button', { name: /^Open / }).click();
      const peek = page.getByTestId('detail-panel');
      await expect(peek).toBeVisible();
      if (type === 'Key result') await openAssistant(page);
      await expect.poll(async () => Math.round((await box(peek)).width)).toBe(320);

      const label = peek.getByTestId('detail-type');
      await expect(label).toHaveAttribute('title', type);
      const header = await box(peek.locator('header').first());
      const l = await box(label);
      // One line of 12px text, on the header's one row.
      expect(l.height).toBeLessThanOrEqual(20);
      expect(header.height).toBeLessThan(56);
      const p = await box(peek);
      for (const name of ['Open in full page', 'Record actions', 'Close']) {
        const b = await box(peek.getByRole('button', { name, exact: true }));
        expect(Math.round(b.width)).toBe(24);
        expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width);
      }
      await peek.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(peek).toHaveCount(0);
    }
  });

  test("a person or select field keeps its chevron on the first line at the peek's floor", async ({
    page,
  }) => {
    // The relation field's fix, for the pickers that had the same wrap: the
    // chevron dropped under the values, or sat between two lines of them.
    await page.addInitScript(() => window.localStorage.setItem('cerebro.aiPanelWidth', '720'));
    await boot(page);
    await page.getByTestId('sidebar-type').filter({ hasText: 'Decision' }).first().click();
    const row = page.getByTestId('table-row').filter({ hasText: 'Supervisors get a web console' });
    await row.first().hover();
    await row
      .first()
      .getByRole('button', { name: /^Open / })
      .click();
    const peek = page.getByTestId('detail-panel');
    await expect(
      peek.getByRole('heading', { name: 'Supervisors get a web console' }),
    ).toBeVisible();
    await openAssistant(page);
    await expect.poll(async () => Math.round((await box(peek)).width)).toBe(320);

    // Three deciders wrap onto three lines; the chevron is on the first.
    const people = peek.getByTestId('person-values').filter({ hasText: 'Ana Rios' });
    const button = people.locator('xpath=ancestor::button[1]');
    const first = await box(people.locator(':scope > span').first());
    const all = await box(people);
    expect(all.height).toBeGreaterThan(first.height * 2);
    const chevron = await box(button.getByTestId('person-chevron'));
    const middle = chevron.y + chevron.height / 2;
    expect(middle).toBeGreaterThan(first.y);
    expect(middle).toBeLessThan(first.y + first.height);
    expect(chevron.x).toBeGreaterThanOrEqual(all.x + all.width - 1);
    const b = await box(button);
    expect(chevron.x + chevron.width).toBeLessThanOrEqual(b.x + b.width + 1);

    // The status draws as the table draws it: dot, label, chevron, one line.
    const status = peek.getByTestId('option-values').filter({ hasText: 'Accepted' }).first();
    const s = await box(status);
    expect(s.height).toBeLessThanOrEqual(20);
    const statusChevron = await box(
      status.locator('xpath=ancestor::button[1]').getByTestId('option-chevron'),
    );
    expect(
      Math.abs(statusChevron.y + statusChevron.height / 2 - (s.y + s.height / 2)),
    ).toBeLessThan(2);

    // A value too long for the column truncates beside its dot, as the table
    // draws it, rather than wrapping its label onto a line under the dot.
    const LONG = 'Accepted by the whole steering group after the second review';
    await status.click();
    await page.getByPlaceholder('Search…').fill(LONG);
    await page.getByRole('button', { name: `Create ${LONG}` }).click();
    const long = peek.getByTestId('option-values').filter({ hasText: LONG }).first();
    await expect(long).toBeVisible();
    const lv = await box(long);
    expect(lv.height).toBeLessThanOrEqual(20);
    const dot = await box(long.locator(':scope > span').first());
    const text = long.locator(':scope > span').last();
    const t = await box(text);
    expect(Math.abs(dot.y + dot.height / 2 - (t.y + t.height / 2))).toBeLessThan(2);
    expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const longChevron = await box(
      long.locator('xpath=ancestor::button[1]').getByTestId('option-chevron'),
    );
    expect(Math.abs(longChevron.y + longChevron.height / 2 - (lv.y + lv.height / 2))).toBeLessThan(
      2,
    );
    const lb = await box(long.locator('xpath=ancestor::button[1]'));
    expect(longChevron.x + longChevron.width).toBeLessThanOrEqual(lb.x + lb.width + 1);
  });

  test('a type view marks only its own row current', async ({ page }) => {
    // Home kept aria-current and its selected fill beside the Epic row.
    await boot(page);
    await page.getByTestId('sidebar-type').filter({ hasText: 'Epic' }).first().click();
    await expect(page.getByTestId('table-row').first()).toBeVisible();
    const current = page.getByTestId('sidebar').locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('data-testid', 'sidebar-type');
    await expect(current).toContainText('Epic');
    await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home' }).click();
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName('Home');
  });
});
