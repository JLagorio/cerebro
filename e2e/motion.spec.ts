import { expect, test, type Page } from '@playwright/test';
import { boot, openDestination } from './boot';

/**
 * The motion layer where it plays (owner, 2026-10-19: "add more animations
 * … feel like Notion and ChatGPT"). Every other spec runs with reduced
 * motion (playwright.config.ts), so surfaces land in the commit that put
 * them there; this one asks for motion and proves it runs: what arrives
 * plays its entrance, what leaves stays on screen for its exit and then
 * goes on its own — well inside the second after which motion.ts gives up
 * on an exit — and nothing is left behind.
 */
test.use({ contextOptions: { reducedMotion: 'no-preference' } });

async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}

/** The names of the CSS animations running on what `selector` finds. */
const running = (page: Page, selector: string) =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].flatMap((el) =>
        el
          .getAnimations()
          .filter((a): a is CSSAnimation => 'animationName' in a)
          .map((a) => a.animationName),
      ),
    selector,
  );

/** Plays every animation at half its speed (Chromium's DevTools protocol),
 *  so what arrives or leaves can be looked at on its way: an exit then
 *  takes 280ms, still well short of the second motion.ts would wait. */
async function slowMotion(page: Page) {
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Animation.enable');
  await devtools.send('Animation.setPlaybackRate', { playbackRate: 0.5 });
}

/** How long `locator` takes to be gone, from now. */
async function goneWithin(locator: ReturnType<Page['locator']>) {
  const started = Date.now();
  await expect(locator).toHaveCount(0);
  return Date.now() - started;
}

test('the side panel slides in, switches in place, and leaves before the page takes its column', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'false'));
  await boot(page);
  await openPage(page, 'How we schedule');
  const doc = page.getByTestId('doc-page');
  const toolbar = doc.locator('.cb-document-toolbar');
  const panel = page.getByTestId('doc-side-panel');
  await slowMotion(page);

  await toolbar.getByRole('button', { name: 'Details', exact: true }).click();
  await expect.poll(() => running(page, '[data-testid="doc-side-panel"]')).toContain('cb-side-in');
  // It arrives once: the mark that plays it comes off when it has.
  await expect(panel).not.toHaveAttribute('data-arrive');

  // Another panel arrives in the same slot, its content fading in.
  await toolbar.getByRole('button', { name: 'History', exact: true }).click();
  await expect.poll(() => running(page, '.cb-inspector-body > *')).toContain('cb-fade-in');

  // Closed, it stays a moment to leave — inert, while the frame keeps its
  // column — and then goes on its own.
  const before = (await doc.locator('.cb-page-frame-body').boundingBox())!.width;
  await toolbar.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(doc).not.toHaveAttribute('data-panel');
  await expect(panel).toHaveAttribute('data-state', 'closed');
  await expect(panel).toHaveAttribute('inert', '');
  expect((await doc.locator('.cb-page-frame-body').boundingBox())!.width).toBe(before);
  expect(await goneWithin(panel)).toBeLessThan(900);
  expect((await doc.locator('.cb-page-frame-body').boundingBox())!.width).toBeGreaterThan(before);
});

test('a menu grows out of its trigger and leaves a copy that fades and goes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openPage(page, 'How we schedule');
  const toolbar = page.getByTestId('doc-page').locator('.cb-document-toolbar');

  await toolbar.getByRole('button', { name: 'Page options', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // Nothing left over from opening (development mode mounts twice).
  await expect(page.locator('[data-ghost]')).toHaveCount(0);

  await slowMotion(page);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // The copy names nothing a spec or a screen reader could find…
  const ghost = page.locator('[data-ghost]');
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toHaveAttribute('aria-hidden', 'true');
  expect(await ghost.getAttribute('role')).toBeNull();
  await expect(ghost.locator('[role], [id], [data-testid]')).toHaveCount(0);
  // …and is gone once its exit has played.
  expect(await goneWithin(ghost)).toBeLessThan(900);
  // Focus went back to the trigger at once, not when the copy left.
  await expect(toolbar.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
});

test('a tooltip pops from its button, and the next one along opens at once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openPage(page, 'How we schedule');
  const toolbar = page.getByTestId('doc-page').locator('.cb-document-toolbar');

  await toolbar.getByRole('button', { name: 'History', exact: true }).hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveText('History');
  await expect(tip).toHaveClass(/cb-tooltip/);

  // Warm: the next button's tooltip does not wait out the first's 400ms.
  await toolbar.getByRole('button', { name: 'Details', exact: true }).hover();
  await expect(tip).toHaveText('Details', { timeout: 300 });
  await page.mouse.move(700, 500);
  await expect(tip).toHaveCount(0);
  await expect(page.locator('[data-ghost]')).toHaveCount(0);
});

test('the outline card grows from its marks and its headings follow it in', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'false'));
  await boot(page);
  await openPage(page, 'How we schedule');
  const outline = page.getByTestId('doc-outline');
  const items = outline.locator('.cb-doc-outline-card li');
  await expect(items.first()).toHaveCSS('opacity', '0');
  await page.getByTestId('doc-outline-rail').hover();
  await expect(items.first()).toHaveCSS('opacity', '1');
  // A beat apart: the second waits on the first.
  const delays = await items.evaluateAll((lis) =>
    lis.slice(0, 2).map((li) => getComputedStyle(li).transitionDelay),
  );
  expect(delays[0]).not.toBe(delays[1]);
});

test('a filed capture leaves its row as a copy that closes its room, and the next one opens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openDestination(page, 'Inbox');
  const rows = page.getByTestId('inbox-row');
  await rows.first().click();
  const count = await rows.count();
  const filed = (await rows.first().getAttribute('data-path'))!;
  await slowMotion(page);

  await page
    .getByTestId('inbox-pane-header')
    .getByRole('button', { name: 'Mark organized', exact: true })
    .click();
  // The row went in the commit that filed it; its copy plays the leaving.
  await expect(rows).toHaveCount(count - 1);
  await expect(page.locator(`[data-testid="inbox-row"][data-path="${filed}"]`)).toHaveCount(0);
  const copy = page.locator('[data-ghost].m75-row-leave');
  await expect(copy).toHaveCount(1);
  await expect.poll(() => running(page, '[data-ghost].m75-row-leave')).toContain('m75-row-close');
  expect(await goneWithin(copy)).toBeLessThan(900);
  // The way back opened its own line over the page, and nothing is left.
  await expect(page.getByTestId('inbox-undo')).toBeVisible();
  await expect(page.locator('[data-ghost]')).toHaveCount(0);
});
