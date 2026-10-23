import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, openAssistantPanel, readMockFile, showPagePanel } from './boot';

/**
 * The page's side panel: one panel at a time — Details, Comments or History,
 * each opened by its own button in the toolbar — the page's full height,
 * under the toolbar's actions (owner, 2026-10-19: "just like in Notion and be
 * collapsible"). Details is a stack of folding sections ruled apart, ending
 * with Info, and the outline is on the page. jsdom holds the contract; this
 * holds what only a browser lays out — the panel's edge from top to bottom,
 * the actions over its head, the section a reveal scrolls to, the outline's
 * hover, and the one text edge every row keeps (owner, 2026-10-18).
 */

/** A page, found by its title, opened as a page (a record peeks first). */
async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  const full = page.getByRole('button', { name: 'Open in full page' });
  const editor = page.getByTestId('markdown-editor');
  await expect(full.or(editor).first()).toBeVisible({ timeout: 10_000 });
  if (await full.isVisible()) await full.click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
}

const sectionIds = (page: Page) =>
  page
    .getByTestId('doc-side-panel')
    .locator('.cb-inspector-section')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.section));

/** Where an element's words start: its text measured, not its box. */
const textLeft = (locator: Locator) =>
  locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  });

/** The panel's text edge: its 16px gutter inside its border, which every
 *  section keeps. */
const textEdge = (panel: Locator) =>
  panel.evaluate((el) => el.getBoundingClientRect().left + el.clientLeft + 16);

const style = (locator: Locator) =>
  locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, family: cs.fontFamily, background: cs.backgroundColor };
  });

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('not laid out');
  return box;
};

/** The panel spans its page from top to bottom, and the toolbar's end — its
 *  Close, then the actions — sits over its head, inside its edges. */
async function expectFullHeightUnderActions(page: Page, panel: Locator) {
  const frame = await boxOf(page.getByTestId('doc-page'));
  const side = await boxOf(panel);
  expect(Math.abs(side.y - frame.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(side.y + side.height - (frame.y + frame.height))).toBeLessThanOrEqual(1);
  expect(await panel.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('1px');
  const toolbar = page.getByTestId('doc-page').locator('.cb-document-toolbar');
  const actions = await boxOf(toolbar.locator('.cb-document-actions'));
  const close = await boxOf(toolbar.getByRole('button', { name: 'Close panel', exact: true }));
  for (const box of [actions, close]) {
    expect(box.x).toBeGreaterThanOrEqual(side.x);
    expect(box.x + box.width).toBeLessThanOrEqual(side.x + side.width);
    expect(box.y + box.height).toBeLessThanOrEqual(side.y + 64);
  }
  // Close leads, at the panel's own edge; the crumbs stop short of it.
  expect(close.x - side.x).toBeLessThanOrEqual(12);
  const crumbs = await boxOf(toolbar.locator('.cb-document-breadcrumbs'));
  expect(crumbs.x + crumbs.width).toBeLessThanOrEqual(side.x);
}

/** A drawer hangs from under the toolbar to the page's bottom, at its right
 *  edge, and the toolbar keeps its row: Close and the actions above it. */
async function expectDrawerUnderToolbar(page: Page, panel: Locator) {
  const frame = await boxOf(page.getByTestId('doc-page'));
  const side = await boxOf(panel);
  const toolbar = page.getByTestId('doc-page').locator('.cb-document-toolbar');
  const bar = await boxOf(toolbar);
  expect(Math.abs(side.y - (bar.y + bar.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(side.y + side.height - (frame.y + frame.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(side.x + side.width - (frame.x + frame.width))).toBeLessThanOrEqual(1);
  for (const target of [
    toolbar.locator('.cb-document-actions'),
    toolbar.getByRole('button', { name: 'Close panel', exact: true }),
  ]) {
    const box = await boxOf(target);
    expect(box.y + box.height).toBeLessThanOrEqual(side.y);
  }
}

/** Docked, the panel runs the page's height under the actions; folded, it is
 *  a drawer under the toolbar. Which one the width gives is the page's call. */
async function expectPanelPlaced(page: Page, panel: Locator) {
  if ((await panel.getAttribute('data-overlay')) === 'true') {
    await expectDrawerUnderToolbar(page, panel);
  } else {
    await expectFullHeightUnderActions(page, panel);
  }
}

test('the side panel runs the page full height, one panel at a time, under the actions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openPage(page, 'Warehouse rollback has never been rehearsed');
  const toolbar = page.getByTestId('doc-page').locator('.cb-document-toolbar');
  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toHaveAttribute('data-panel', 'details');
  // No tab strip and no picker: the toolbar's buttons choose the panel.
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(panel.locator('select, [role="combobox"], [aria-haspopup="listbox"]')).toHaveCount(
    0,
  );
  const details = toolbar.getByRole('button', { name: 'Details', exact: true });
  await expect(details).toHaveAttribute('aria-pressed', 'true');
  expect(Math.round((await boxOf(panel)).width)).toBe(300);
  await expectFullHeightUnderActions(page, panel);

  // Each panel's button opens it in the same slot, and closes it when open.
  await toolbar.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(panel).toHaveAttribute('data-panel', 'comments');
  await expect(panel.getByRole('heading', { level: 2, name: 'Comments' })).toBeVisible();
  await expect(details).toHaveAttribute('aria-pressed', 'false');
  const history = toolbar.getByRole('button', { name: 'History', exact: true });
  await history.click();
  await expect(panel).toHaveAttribute('data-panel', 'history');
  await expect(panel.getByTestId('page-history')).toBeVisible();
  await expectFullHeightUnderActions(page, panel);
  await history.click();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem('cerebro.docPanelOpen'))).toBe(
    'false',
  );
  // Closed, the actions keep their corner and Close is gone.
  await expect(toolbar.getByRole('button', { name: 'Close panel', exact: true })).toHaveCount(0);
  await details.click();
  await expect(panel).toHaveAttribute('data-panel', 'details');
  // Close, at the panel's edge, folds it away the same way.
  await toolbar.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await details.click();

  expect(await sectionIds(page)).toEqual([
    'properties',
    'links',
    'backlinks',
    'knowledge',
    'access',
    'info',
  ]);
  // Ruled apart: a hairline over each section but the first, which opens
  // under the toolbar, and Access folded until asked.
  const rule = (id: string) =>
    panel.locator(`[data-section="${id}"]`).evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(await rule('properties')).toBe('rgba(0, 0, 0, 0)');
  expect(await rule('links')).not.toBe('rgba(0, 0, 0, 0)');
  await expect(panel.getByRole('button', { name: 'Access', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(panel.getByTestId('page-access-summary')).toBeVisible();

  const properties = panel.getByRole('button', { name: 'Properties', exact: true });
  await properties.click();
  await expect(properties).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByTestId('doc-properties')).toBeHidden();
  expect(await page.evaluate(() => window.localStorage.getItem('cerebro.inspectorCollapsed'))).toBe(
    '["properties"]',
  );
  // Another page keeps the fold: it says what the person reads.
  await openPage(page, 'How we schedule');
  await expect(panel.getByRole('button', { name: 'Properties', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await panel.getByRole('button', { name: 'Properties', exact: true }).click();
  await expect(panel.getByTestId('doc-properties')).toBeVisible();
});

test('folded beside a narrow page, the panel opens as a drawer under the toolbar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openAssistantPanel(page);
  await openPage(page, 'How we schedule');
  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toHaveCount(0);
  const panelAside = await showPagePanel(page, 'Details', page.getByTestId('doc-page'));
  await expect(panelAside).toHaveAttribute('data-overlay', 'true');
  await expectDrawerUnderToolbar(page, panelAside);
  expect((await boxOf(page.getByTestId('doc-column'))).width).toBeGreaterThanOrEqual(360);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('the Knowledge strip opens Details on its section, in view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await boot(page);
  await openPage(page, 'Phoenix warehouse rollout');
  await expect(page.getByTestId('doc-side-panel')).toHaveCount(0);
  await page
    .getByTestId('knowledge-strip')
    .getByRole('button', { name: 'Knowledge', exact: true })
    .click();

  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toHaveAttribute('data-panel', 'details');
  const section = panel.locator('[data-section="knowledge"]');
  await expect(section.getByRole('button', { name: 'Knowledge', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // Below the page's properties and links, so the body scrolled to bring it up.
  const body = panel.locator('.cb-inspector-body');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const frame = await boxOf(body);
  const header = await boxOf(section.locator('.cb-inspector-section-head'));
  expect(header.y).toBeGreaterThanOrEqual(frame.y - 1);
  expect(header.y + header.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
});

test('beside a docked assistant the column keeps its floor, and the panel never draws under its actions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openAssistantPanel(page);
  await openPage(page, 'How we schedule');
  // Docked while the column keeps its floor beside it; folded below that, and
  // a drawer when asked for. Either way the panel never draws narrower than
  // the actions over its head, and the column keeps its 360.
  const panel = await showPagePanel(page, 'Details', page.getByTestId('doc-page'));
  const actions = await boxOf(page.getByTestId('doc-page').locator('.cb-document-actions'));
  expect((await boxOf(panel)).width).toBeGreaterThanOrEqual(actions.width);
  expect((await boxOf(page.getByTestId('doc-column'))).width).toBeGreaterThanOrEqual(360);
  await expectPanelPlaced(page, panel);
});

test('Details end in Info, and every row keeps the panel text edge', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openPage(page, 'Warehouse rollback has never been rehearsed');
  const panel = page.getByTestId('doc-side-panel');
  const edge = await textEdge(panel);
  const label = panel.locator('[data-section="properties"] .cb-inspector-section-label');
  expect(Math.abs((await textLeft(label)) - edge)).toBeLessThanOrEqual(1);
  await expect(panel.locator('[data-section="access"] .cb-inspector-section-label')).toHaveText(
    'Access',
  );

  // Last in the body, a section of its own: when the page was made and
  // changed and who changed it, label and value on the property grid.
  const info = panel.getByTestId('page-info');
  expect(
    await panel
      .locator('.cb-inspector-body')
      .evaluate((el) => el.lastElementChild?.getAttribute('data-testid')),
  ).toBe('page-info');
  await expect(info.locator('dt')).toHaveText(['Created', 'Modified', 'Changed by']);
  const changed = info.getByTestId('last-change-line');
  await expect(changed).toHaveText('Not recorded');
  await expect(changed).toHaveAttribute('title', 'Who changed this page was not recorded');
  await expect(info.getByTestId('page-created')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  const created = info.locator('dt').first();
  expect(Math.abs((await textLeft(created)) - edge)).toBeLessThanOrEqual(1);
  // A fact's value lands where a property's value text does.
  const mitigation = panel
    .locator('[data-testid="property-row"][data-property="mitigation"] [data-cell-primary]')
    .first();
  const valueLeft = await mitigation.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  });
  expect(
    Math.abs((await textLeft(info.getByTestId('page-created'))) - valueLeft),
  ).toBeLessThanOrEqual(1);
  const look = await style(info.getByTestId('page-created'));
  expect(look.family).not.toMatch(/mono/i);
  await expect(panel.getByTestId('doc-properties')).not.toContainText('Created');

  // A link row is 28px, its type's glyph on the text edge, and the property
  // a link rides is plain 12px words at its end.
  const row = panel
    .getByTestId('doc-link-row')
    .filter({ has: page.getByTestId('doc-link-via') })
    .first();
  expect(Math.round((await boxOf(row)).height)).toBe(28);
  expect(Math.abs((await boxOf(row.locator('svg').first())).x - edge)).toBeLessThanOrEqual(1);
  const via = await style(row.getByTestId('doc-link-via'));
  expect(via.size).toBe('12px');
  expect(via.background).toBe('rgba(0, 0, 0, 0)');

  // Add property is the list's own last row: a row's height, its plus on
  // the property icons' axis.
  const add = panel.getByRole('button', { name: 'Add property', exact: true });
  expect(Math.round((await boxOf(add)).height)).toBe(30);
  const plus = await boxOf(add.locator('svg'));
  const glyph = await boxOf(panel.getByTestId('property-row').first().locator('svg').first());
  expect(Math.abs(plus.x + plus.width / 2 - (glyph.x + glyph.width / 2))).toBeLessThanOrEqual(1);
});

test("a doc's Type value is the Convert trigger, on the Type row itself", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openPage(page, 'How we schedule');
  const panel = page.getByTestId('doc-side-panel');
  const typeRow = panel.locator('[data-testid="property-row"][data-property="Type"]');
  const trigger = typeRow.getByRole('button', { name: 'Doc, convert to record…', exact: true });
  await expect(trigger).toHaveText('Doc');
  await expect(trigger).toHaveAttribute('title', 'Convert to record…');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  // One row: no button hangs under it, and the trigger stays inside it.
  await expect(panel.getByText('Convert to record…', { exact: true })).toHaveCount(0);
  const rowBox = await boxOf(typeRow);
  const box = await boxOf(trigger);
  expect(box.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  // A chip, as a record's type is: a quiet fill at rest, a deeper one under
  // the pointer.
  const rest = (await style(trigger)).background;
  expect(rest).not.toBe('rgba(0, 0, 0, 0)');
  await trigger.hover();
  await expect.poll(async () => (await style(trigger)).background).not.toBe(rest);

  const before = await readMockFile(page, 'delivery/how-we-schedule.md');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Convert to record' });
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await readMockFile(page, 'delivery/how-we-schedule.md')).toBe(before);
});

test('Comments and History keep the Details text edge, under their titles', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openPage(page, 'How we schedule');
  const edge = await textEdge(page.getByTestId('doc-side-panel'));

  // An empty Comments panel is one quiet note under its label: no icon well.
  const comments = await showPagePanel(page, 'Comments');
  const title = comments.getByRole('heading', { level: 2, name: 'Comments' });
  expect(Math.abs((await textLeft(title)) - edge)).toBeLessThanOrEqual(1);
  const discussion = comments.getByTestId('comments-discussion');
  const label = discussion.getByRole('heading', { name: 'Discussion', exact: true });
  expect(Math.abs((await textLeft(label)) - edge)).toBeLessThanOrEqual(1);
  const empty = discussion.getByText('No comments yet', { exact: true });
  await expect(empty).toBeVisible();
  expect(Math.abs((await textLeft(empty)) - edge)).toBeLessThanOrEqual(1);
  expect((await style(empty)).size).toBe('12px');
  await expect(discussion.getByTestId('comments-empty').locator('svg')).toHaveCount(0);
  // One box: the field and its button inside it.
  const box = await boxOf(discussion.locator('.cb-composer'));
  const post = await boxOf(discussion.getByTestId('discussion-submit'));
  expect(post.x + post.width).toBeLessThanOrEqual(box.x + box.width);
  expect(post.y + post.height).toBeLessThanOrEqual(box.y + box.height);

  const history = await showPagePanel(page, 'History');
  expect(
    Math.abs((await textLeft(history.getByRole('heading', { level: 2, name: 'History' }))) - edge),
  ).toBeLessThanOrEqual(1);
  const line = history
    .getByTestId('page-history')
    .locator(':scope > p, [data-testid="page-history-day"]')
    .first();
  await expect(line).toBeVisible();
  expect(Math.abs((await textLeft(line)) - edge)).toBeLessThanOrEqual(1);
});

test('the outline sits at the page edge and opens into its headings on hover', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openPage(page, 'How we schedule');
  const column = page.getByTestId('doc-column');
  const outline = column.getByTestId('doc-outline');
  await expect(outline).toBeVisible();
  // On the page, not in the panel, and clear of the text it outlines.
  await expect(page.getByTestId('doc-side-panel').getByTestId('doc-outline')).toHaveCount(0);
  const rail = await boxOf(outline.getByTestId('doc-outline-rail'));
  const columnBox = await boxOf(column);
  expect(rail.x + rail.width).toBeLessThanOrEqual(columnBox.x + columnBox.width);
  const text = await page
    .getByTestId('markdown-editor')
    .locator('.bn-editor')
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.right - parseFloat(getComputedStyle(el).paddingRight);
    });
  expect(rail.x).toBeGreaterThanOrEqual(text);
  // At rest, a mark per heading under the title, the title not among them;
  // under the pointer, those headings by name.
  // The card stays in the page so Tab can reach it: hidden by its fade, and
  // taking no pointer until it opens.
  const card = outline.getByTestId('doc-outline-card');
  await expect(card).toHaveCSS('opacity', '0');
  await expect(card).toHaveCSS('pointer-events', 'none');
  await expect(outline.getByTestId('doc-outline-rail').locator(':scope > *')).toHaveCount(3);
  await outline.getByTestId('doc-outline-rail').hover();
  await expect(card).toHaveCSS('opacity', '1');
  await expect(card).toHaveCSS('pointer-events', 'auto');
  await expect(card.getByRole('button')).toHaveText([
    'Windows, not deadlines',
    'Blocking is a relation',
    'Nesting is grouping',
  ]);
  // A heading jumps the page to it, the outline marking where you are.
  const scroller = column.locator('.overflow-y-auto').first();
  await card.getByRole('button', { name: 'Nesting is grouping' }).click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(card.getByRole('button', { name: 'Nesting is grouping' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  // Off it, the card folds back into its marks.
  await page.mouse.move(columnBox.x + 40, columnBox.y + columnBox.height / 2);
  await expect(card).toHaveCSS('opacity', '0');
  await expect(card).toHaveCSS('pointer-events', 'none');
});

test('the resting assistant sits beside a docked panel, and back in the corner without it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem('cerebro.docPanelOpen', 'true'));
  await boot(page);
  await openPage(page, 'How we schedule');
  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toHaveAttribute('data-panel', 'details');
  const fab = page.getByTestId('ai-panel-fab');
  await expect(fab).toBeVisible();
  // Beside the panel's edge, not over its last rows.
  const side = await boxOf(panel);
  await expect
    .poll(async () => (await boxOf(fab)).x + (await boxOf(fab)).width)
    .toBeLessThanOrEqual(side.x);
  // Closed, the canvas corner is the page's again.
  await page
    .getByTestId('doc-page')
    .getByRole('button', { name: 'Close panel', exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  const row = await boxOf(page.locator('.m91-canvas-row'));
  await expect
    .poll(async () => row.x + row.width - ((await boxOf(fab)).x + (await boxOf(fab)).width))
    .toBeCloseTo(20, 0);
});

test("the resting assistant clears the Inbox's wider panel too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.locator('body').press('g');
  await page.locator('body').press('i');
  await page.getByTestId('inbox-row').first().click();
  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toHaveAttribute('data-panel', 'details');
  const fab = page.getByTestId('ai-panel-fab');
  await expect(fab).toBeVisible();
  const side = await boxOf(panel);
  await expect
    .poll(async () => (await boxOf(fab)).x + (await boxOf(fab)).width)
    .toBeLessThanOrEqual(side.x);
});
