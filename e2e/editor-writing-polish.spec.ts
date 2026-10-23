import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { boot, openDestination, seedFileBeforeBoot, showPagePanel } from './boot';

test.use({ video: 'on' });
const PATH = 'writing-session.md';
const TITLE = 'A considered writing session';
const PASSAGE = 'Clear decisions make the next step easier.';

async function openWriting(page: Page) {
  await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('quick-open-input').fill(TITLE);
  await page.getByTestId('quick-open-result').filter({ hasText: TITLE }).first().click();
  await expect(page.getByTestId('markdown-editor').locator('[data-page-title] h1')).toHaveText(
    TITLE,
  );
}

async function assertSingleTitle(page: Page, info: TestInfo, phase: string) {
  const editor = page.getByTestId('markdown-editor');
  try {
    await expect(editor.locator('.cb-page-title-fallback')).toHaveCount(0);
    await expect(editor.getByRole('heading', { name: TITLE, exact: true })).toHaveCount(1);
    const source = await page.evaluate((path) => window.__cerebroMockFs.get(path), PATH);
    expect(source?.split('\n').filter((line) => line === `# ${TITLE}`)).toHaveLength(1);
  } catch (error) {
    await info.attach(`title-${phase}`, {
      body: JSON.stringify(
        await editor.evaluate((node) => ({
          html: node.outerHTML,
          source: window.__cerebroMockFs.get('writing-session.md'),
          headings: [...node.querySelectorAll('h1')].map((heading) => ({
            text: heading.textContent,
            insideChrome: heading.closest('.cb-page-editor-chrome') !== null,
            outer: heading.closest('[data-node-type="blockOuter"]')?.outerHTML,
          })),
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  }
}

async function selectText(text: Locator) {
  const expected = (await text.textContent())!.trim();
  // Formatting retains the native range. The following contextual action
  // uses that same target, just as a writer does after pressing Bold.
  if (
    await text.evaluate(
      (node, value) => node.ownerDocument.getSelection()?.toString().trim() === value,
      expected,
    )
  ) {
    await expect(text.page().getByTestId('markdown-editor').locator('.bn-editor')).toBeFocused();
    return;
  }
  const points = await text.evaluate((node) => {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode())
      if (walker.currentNode.textContent?.length) texts.push(walker.currentNode as Text);
    const range = node.ownerDocument.createRange();
    range.setStart(texts[0], 0);
    range.setEnd(texts[0], 1);
    const start = range.getBoundingClientRect();
    const last = texts.at(-1)!;
    range.setStart(last, last.length - 1);
    range.setEnd(last, last.length);
    const end = range.getBoundingClientRect();
    return {
      start: { x: start.left + 0.1, y: start.top + start.height / 2 },
      end: { x: end.right + 0.1, y: end.top + end.height / 2 },
    };
  });
  // Start from a real caret before dragging a new native range.
  await text.page().mouse.click(points.start.x, points.start.y);
  await expect
    .poll(() => text.evaluate((node) => node.ownerDocument.getSelection()?.isCollapsed))
    .toBe(true);
  await text.page().mouse.move(points.start.x, points.start.y);
  await text.page().mouse.down();
  await text.page().mouse.move(points.end.x, points.end.y, { steps: 8 });
  await text.page().mouse.up();
  await expect(text.page().getByTestId('markdown-editor').locator('.bn-editor')).toBeFocused();
  await expect
    .poll(() => text.evaluate((node) => node.ownerDocument.getSelection()?.toString().trim()))
    .toBe(expected);
}

async function slash(page: Page, query: string, label: string) {
  const last = page
    .getByTestId('markdown-editor')
    .locator('[data-content-type="paragraph"]')
    .last();
  await last.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/${query}`);
  await page
    .locator('#bn-suggestion-menu [role=option]')
    .filter({ hasText: label })
    .first()
    .click();
}

for (const theme of ['light', 'dark'] as const) {
  test(`writing controls form one durable session in ${theme}`, async ({ page }, info) => {
    await seedFileBeforeBoot(
      page,
      PATH,
      `# ${TITLE}\n\n${PASSAGE}\n\nA block to duplicate.\n\nContinue here.\n`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await openWriting(page);
    await assertSingleTitle(page, info, 'opened');
    const editor = page.getByTestId('markdown-editor');
    const prose = editor.getByText(PASSAGE, { exact: true });
    await expect(prose).toHaveCSS('font-size', '16px');
    await selectText(prose);
    await page.keyboard.press('ControlOrMeta+b');
    await expect
      .poll(() => page.evaluate((p) => window.__cerebroMockFs.get(p), PATH))
      .toContain(`**${PASSAGE}**`);
    await assertSingleTitle(page, info, 'formatted');
    await selectText(prose);
    await expect(page.getByTestId('selection-ask-ai')).toHaveCount(1);
    await page.getByTestId('selection-ask-ai').click();
    await expect(editor.locator('.cb-held-selection')).toHaveText(PASSAGE);
    await expect(page.getByTestId('ask-ai')).toBeVisible();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Block actions', exact: true })).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Writing actions', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Improve writing', exact: true })).toBeVisible();
    await assertSingleTitle(page, info, 'selection');
    await page.screenshot({
      path: info.outputPath(`writing-selection-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ask-ai')).toHaveCount(0);
    await expect(editor.locator('.cb-held-selection')).toHaveCount(0);

    await editor.getByText('A block to duplicate.', { exact: true }).click();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Block actions', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Move down', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+z');
    await editor.getByText('A block to duplicate.', { exact: true }).hover();
    await page.locator('[data-testid="block-grip"] button').click();
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await expect(editor.getByText('A block to duplicate.', { exact: true })).toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.getByText('A block to duplicate.', { exact: true })).toHaveCount(1);

    await slash(page, 'table', 'Table');
    const picker = page.getByRole('dialog', { name: 'Insert Markdown table' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Insert table' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(picker).toContainText('4 rows × 4 columns');
    await page.keyboard.press('Space');
    const table = editor.locator('[data-content-type="table"] table');
    await expect(table.locator('tr')).toHaveCount(4);
    await expect(table.locator('tr').first().locator('th')).toHaveCount(4);
    await table.locator('tr').first().locator('th').first().click();
    await page.keyboard.type('Decision');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Owner');
    await expect(table).toContainText('Decision');
    await expect(table).toContainText('Owner');

    await slash(page, 'callout', 'Callout');
    const callout = page.getByTestId('callout-block');
    await callout.getByRole('button', { name: 'Callout type: info' }).click();
    await page.getByRole('menuitem', { name: 'Warning', exact: true }).click();
    await expect(callout).toHaveAttribute('data-kind', 'warning');
    await callout.locator('.bn-inline-content').click();
    await page.keyboard.type('Check the assumptions before launch.');

    await selectText(prose);
    await page.getByTestId('selection-comment').click();
    await page.getByTestId('comment-draft-submit-input').fill('Review the next step.');
    await page.getByTestId('comment-draft-submit').click();
    await expect(page.getByTestId('comment-thread')).toContainText('Review the next step.');
    await page.getByTestId('discussion-submit-input').fill('An unfinished discussion draft.');
    // Another panel and back: the discussion draft is kept.
    await showPagePanel(page, 'History');
    await showPagePanel(page, 'Comments');
    await expect(page.getByTestId('discussion-submit-input')).toHaveValue(
      'An unfinished discussion draft.',
    );
    // Close, at the panel's edge in the toolbar, closes it.
    await page
      .getByTestId('doc-page')
      .getByRole('button', { name: 'Close panel', exact: true })
      .click();
    await expect(page.getByTestId('doc-side-panel')).toHaveCount(0);
    await page.setViewportSize({ width: 900, height: 600 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(900);
    await expect(page.getByTestId('doc-save-state')).toHaveText('Saved');
    await assertSingleTitle(page, info, 'saved');
    await page.screenshot({
      path: info.outputPath(`writing-document-${theme}.png`),
      animations: 'disabled',
    });
    await expect
      .poll(() => page.evaluate((p) => window.__cerebroMockFs.get(p), PATH))
      .toContain('> [!warning] Check the assumptions before launch.');
    const saved = await page.evaluate((p) => window.__cerebroMockFs.get(p), PATH);
    expect(saved).toContain('Decision');
    expect(saved).toContain(`**${PASSAGE}**`);
    expect(saved).not.toContain('An unfinished discussion draft.');
    await openDestination(page, 'Home');
    await page.keyboard.press('Escape');
    await openWriting(page);
    await assertSingleTitle(page, info, 'reopened');
    await expect(page.getByTestId('callout-block')).toHaveAttribute('data-kind', 'warning');
    await expect(page.getByTestId('markdown-editor').locator('table')).toContainText('Decision');
    expect(await page.evaluate((p) => window.__cerebroMockFs.get(p), PATH)).toBe(saved);
  });
}

test('selection tools stay reachable at narrow width and 200 percent scale', async ({
  page,
}, info) => {
  await seedFileBeforeBoot(page, PATH, `# ${TITLE}\n\n${PASSAGE}\n`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page);
  await openWriting(page);
  await assertSingleTitle(page, info, 'zoom-opened');
  await selectText(page.getByTestId('markdown-editor').getByText(PASSAGE, { exact: true }));
  await page.getByTestId('selection-ask-ai').click();
  const panel = page.getByTestId('ask-ai');
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Writing actions', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
    window.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(async () => {
      const box = (await panel.boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= 901 && box.y + box.height <= 601;
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Summarize', exact: true }).focus();
  const action = (await page
    .getByRole('button', { name: 'Summarize', exact: true })
    .boundingBox())!;
  expect(action.y).toBeGreaterThanOrEqual(0);
  expect(action.y + action.height).toBeLessThanOrEqual(600);
  await page.screenshot({
    path: info.outputPath('writing-selection-200-percent.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});
