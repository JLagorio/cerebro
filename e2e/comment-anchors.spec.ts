import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, type E2eCommentAnchor } from './boot';

/**
 * Comment anchors drawn in a real browser (M70.1), through the browser-mode
 * probe (`window.__cerebroCommentProbe`): a keyboard selection becomes an
 * anchor, the anchor is drawn as a decoration, and nothing of it reaches the
 * page's bytes or its undo. jsdom lays nothing out, so the highlight's place
 * on screen is asserted here. Chromium only: the packaged WKWebView check is
 * M70.2b's.
 */

const PAGE = 'delivery/how-we-schedule.md';
const FREEZE = 'We ship on Thursdays, after the freeze.';
const SEED = ['# How we schedule', '', 'Owner: TBD.', '', 'Deadline: TBD.', '', FREEZE, ''].join(
  '\n',
);

/** Open the page from the sidebar, expanding its collection only if it is folded. */
async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  // A click that lands while the sidebar is still settling opens nothing (seen
  // once under load), so the click is retried until the page is open.
  await expect(async () => {
    await node.getByRole('button', { name: 'How we schedule' }).click();
    await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => window.__cerebroCommentProbe !== undefined))
    .toBe(true);
}

/** The paragraph holding `text`. */
const paragraph = (page: Page, text: string) =>
  page.getByTestId('markdown-editor').locator('.bn-block-content').filter({ hasText: text }).last();

/** Select the last `length` characters before the final period of the
 * paragraph holding `text`, with the keyboard. macOS has no End for a line
 * (it scrolls the page), so there the line's end is ⌘→. */
async function selectBeforePeriod(page: Page, text: string, length: number): Promise<void> {
  // Collapse any selection first, so its formatting toolbar is not in the way.
  await page.keyboard.press('ArrowRight');
  await paragraph(page, text).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < length; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
    // One frame per key: ProseMirror reads the browser's selection on
    // `selectionchange`, and a burst of keys outruns it.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  }
}

/** The selection as an anchor on `quote`. ProseMirror reads a keyboard
 * selection from the DOM on `selectionchange`, after the key has landed, so
 * the anchor is polled until the editor has caught up. */
async function anchorSelection(page: Page, quote: string): Promise<E2eCommentAnchor> {
  let anchor: E2eCommentAnchor | null = null;
  await expect
    .poll(async () => {
      const result = await page.evaluate(() => window.__cerebroCommentProbe!.anchor());
      anchor = result.ok ? result.anchor : null;
      return anchor?.quote ?? null;
    })
    .toBe(quote);
  return anchor!;
}

const show = (page: Page, threads: { id: string; anchor: E2eCommentAnchor }[]) =>
  page.evaluate((t) => window.__cerebroCommentProbe!.show(t), threads);

const resolutions = (page: Page) =>
  page.evaluate(() => window.__cerebroCommentProbe!.resolutions());

/** Each drawn highlight: its thread, its text and the paragraph it sits in. */
const highlights = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="markdown-editor"] .cb-comment')].map((el) => ({
      thread: el.getAttribute('data-thread'),
      text: el.textContent,
      paragraph: el.closest('.bn-block-content')?.textContent ?? null,
    })),
  );

test('a comment anchor is drawn outside the page, survives a reopen and edits, and detaches when its quote goes', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(([path, text]) => window.__cerebroMockFs.set(path, text), [PAGE, SEED]);
  await openSchedule(page);
  const editor = page.getByTestId('markdown-editor');

  // A keyboard selection becomes an anchor, drawn on exactly its text.
  await selectBeforePeriod(page, FREEZE, 'after the freeze'.length);
  const freeze = await anchorSelection(page, 'after the freeze');
  expect(freeze).toMatchObject({ quote: 'after the freeze', occurrence: 1 });
  await show(page, [{ id: 'freeze', anchor: freeze }]);
  const span = editor.locator('.cb-comment[data-thread="freeze"]');
  await expect(span).toHaveCount(1);
  await expect(span).toHaveText('after the freeze');
  const box = (await span.boundingBox())!;
  const holder = (await paragraph(page, FREEZE).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(holder.x);
  expect(box.y).toBeGreaterThanOrEqual(holder.y);
  expect(box.x + box.width).toBeLessThanOrEqual(holder.x + holder.width);
  expect(box.y + box.height).toBeLessThanOrEqual(holder.y + holder.height);

  // The page never learns of it: the bytes stay the seed past the save debounce.
  await page.waitForTimeout(800);
  expect(await readMockFile(page, PAGE)).toBe(SEED);

  // ⌘Z changes neither the bytes nor the highlight.
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(800);
  expect(await readMockFile(page, PAGE)).toBe(SEED);
  await expect(span).toHaveText('after the freeze');

  // The second TBD anchors as occurrence 2 and is drawn there.
  await selectBeforePeriod(page, 'Deadline: TBD.', 'TBD'.length);
  const tbd = await anchorSelection(page, 'TBD');
  expect(tbd).toMatchObject({ quote: 'TBD', occurrence: 2 });
  const threads = [
    { id: 'freeze', anchor: freeze },
    { id: 'tbd', anchor: tbd },
  ];
  await show(page, threads);
  const drawn = [
    { thread: 'tbd', text: 'TBD', paragraph: 'Deadline: TBD.' },
    { thread: 'freeze', text: 'after the freeze', paragraph: FREEZE },
  ];
  expect(await highlights(page)).toEqual(drawn);

  // Home and back: a fresh editor, the same highlights.
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home' }).click();
  await expect(editor).toHaveCount(0);
  await openSchedule(page);
  await show(page, threads);
  expect(await highlights(page)).toEqual(drawn);
  expect(await readMockFile(page, PAGE)).toBe(SEED);

  // A copy typed above: the TBD highlight stays on the deadline.
  await paragraph(page, 'Owner: TBD.').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  await page.keyboard.type('Also TBD.');
  await page.keyboard.press('Enter');
  await expect(editor.getByText('Also TBD.')).toBeVisible();
  await expect
    .poll(() => resolutions(page))
    .toMatchObject({ tbd: { kind: 'attached', moved: true } });
  await expect.poll(() => highlights(page)).toEqual(drawn);

  // The quote deleted: the thread reads gone within a second.
  await selectBeforePeriod(page, FREEZE, 'after the freeze'.length);
  await page.keyboard.press('Backspace');
  await expect
    .poll(() => resolutions(page), { timeout: 1_000 })
    .toMatchObject({ freeze: { kind: 'detached', reason: 'gone' } });
  await expect(editor.locator('.cb-comment[data-thread="freeze"]')).toHaveCount(0);
});
