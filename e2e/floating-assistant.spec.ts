import { expect, test, type Page } from '@playwright/test';
import { boot, openDatabase, readMockFile } from './boot';

async function openFloating(page: Page) {
  await page
    .getByTestId('app-rail')
    .getByRole('button', { name: 'Assistant', exact: true })
    .click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  await expect(panel).not.toHaveAttribute('data-minimized');
  return panel;
}

/**
 * Minimized, the conversation is one 48px round button in the canvas corner,
 * `inset` from its right and bottom edges. Nothing else of it is drawn, and
 * the page keeps every click outside the circle, its box's corners included.
 */
async function expectRestingButton(page: Page, inset: number) {
  const panel = page.getByTestId('ai-panel');
  const fab = page.getByTestId('ai-panel-fab');
  await expect(panel).toHaveAttribute('data-minimized', 'true');
  await expect(fab).toBeVisible();
  await expect(panel.locator('.cb-chat-header')).toBeHidden();
  await expect(panel.locator('.cb-chat-body')).toBeHidden();
  const row = (await page.locator('.m91-canvas-row').boundingBox())!;
  for (const target of [page.getByTestId('ai-panel-frame'), panel, fab]) {
    const box = (await target.boundingBox())!;
    expect(box.width).toBeCloseTo(48, 1);
    expect(box.height).toBeCloseTo(48, 1);
    expect(row.x + row.width - (box.x + box.width)).toBeCloseTo(inset, 1);
    expect(row.y + row.height - (box.y + box.height)).toBeCloseTo(inset, 1);
  }
  const box = (await fab.boundingBox())!;
  const owner = (x: number, y: number) =>
    page.evaluate(
      ([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest('[data-testid="ai-panel-fab"]')) return 'button';
        return hit?.closest('[data-testid="ai-panel-frame"]') ? 'assistant' : 'page';
      },
      [x, y],
    );
  expect(await owner(box.x + 24, box.y + 24)).toBe('button');
  // The rim belongs to the button too, so the whole visible circle opens it.
  expect(await owner(box.x + 1, box.y + 24)).toBe('button');
  expect(await owner(box.x + 2, box.y + 2)).toBe('page');
  expect(await owner(box.x + 46, box.y + 46)).toBe('page');
  expect(await owner(box.x - 4, box.y + 24)).toBe('page');
  expect(await owner(box.x + 24, box.y - 4)).toBe('page');
}

test('floating chat preserves page geometry, input, draft and live turn across presentations', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  await openDatabase(page, 'Epic');
  const main = page.locator('#main');
  const before = await main.boundingBox();
  const panel = page.getByTestId('ai-panel');
  const fab = page.getByTestId('ai-panel-fab');
  await expectRestingButton(page, 20);
  await expect(fab).not.toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('database-button.png') });
  await openFloating(page);
  expect(await main.boundingBox()).toEqual(before);
  await expect(main).not.toHaveAttribute('inert');
  const input = panel.getByLabel('Message the assistant');
  const original = await input.elementHandle();
  await input.fill('wait for me');
  await input.press('Enter');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await input.fill('Keep this draft');
  await panel.getByRole('button', { name: 'Minimize conversation' }).click();
  await expect(panel).toHaveAttribute('data-minimized', 'true');
  // The button keeps the turn in view: a turning ring while it works.
  await expect(fab).toBeFocused();
  await expect(fab).toHaveAttribute('data-state', 'working');
  await expect(fab.locator('.cb-chat-fab-ring')).toBeVisible();
  await expect(input).toHaveValue('Keep this draft');
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  expect(await main.boundingBox()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('database-button-working.png') });
  await fab.click();
  await expect(panel).not.toHaveAttribute('data-minimized');
  await expect(input).toBeFocused();
  await panel.getByRole('button', { name: 'Conversation options' }).click();
  await page.getByRole('menuitem', { name: 'Expand conversation' }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  await panel.getByRole('button', { name: 'Minimize conversation' }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  await expect(fab).toBeFocused();
  await openFloating(page);
  await expect(input).toHaveValue('Keep this draft');
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns(): void }).__cerebroReleaseMockRuns(),
  );
  await expect(panel.locator('[data-role="assistant"]')).toContainText('Done waiting.');
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(1);
  expect(await main.boundingBox()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('database-floating-chat.png') });
});

for (const [width, height, theme] of [
  [1440, 960, 'light'],
  [1024, 720, 'dark'],
  [760, 600, 'light'],
] as const) {
  test(`floating chat and page stay usable at ${width}×${height} in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript((theme) => localStorage.setItem('cerebro.themeMode', theme), theme);
    await boot(page, { preserveTheme: true });
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('quick-open-input').fill('How we schedule');
    await page
      .getByTestId('quick-open-result')
      .filter({ hasText: 'How we schedule' })
      .first()
      .click();
    await expect(page.getByTestId('doc-page')).toBeVisible();
    await expect(page.getByTestId('doc-page').locator('[data-page-title] h1')).toHaveText(
      'How we schedule',
    );
    // In the text: the page's outline lists the same heading by name.
    await expect(
      page.getByTestId('markdown-editor').getByText('Windows, not deadlines'),
    ).toBeVisible();
    await page.mouse.click(width - 100, 85);
    const main = page.locator('#main');
    const before = await main.boundingBox();
    // 760 is the narrow layout's first width it does not apply to.
    await expectRestingButton(page, 20);
    await page.screenshot({ path: testInfo.outputPath(`page-${theme}-${width}.png`) });
    const panel = await openFloating(page);
    expect(await main.boundingBox()).toEqual(before);
    const input = panel.getByLabel('Message the assistant');
    await expect(input).toHaveAttribute('placeholder', 'Work with this page…');
    const emptyDock = (await panel.locator('.cb-chat-dock').boundingBox())!;
    expect(emptyDock.height).toBeLessThanOrEqual(60);
    await expect(panel.getByTestId('chat-welcome')).toHaveCount(0);
    await input.fill('A draft that stays with this page');
    const panelBox = (await panel.boundingBox())!;
    const dockBox = (await panel.locator('.cb-chat-dock').boundingBox())!;
    expect(dockBox.height).toBeLessThanOrEqual(60);
    expect(Math.abs(panelBox.y + panelBox.height - dockBox.y - dockBox.height)).toBeLessThanOrEqual(
      2,
    );
    for (const target of [panel, input, panel.getByRole('button', { name: 'Send', exact: true })]) {
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }
    const context = panel.getByRole('button', { name: /^Context:/ });
    await context.click();
    await expect(
      page.getByRole('button', { name: 'Remove How we schedule from context' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(context).toBeFocused();
    await expect(panel).not.toHaveAttribute('data-minimized');
    await input.focus();
    await input.press('Escape');
    await expect(panel).toHaveAttribute('data-minimized', 'true');
    await expect(page.getByTestId('ai-panel-fab')).toBeFocused();
    await expect(input).toHaveValue('A draft that stays with this page');
    await page.keyboard.press('ControlOrMeta+j');
    await expect(panel).not.toHaveAttribute('data-minimized');
    await expect(input).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`floating-${theme}-${width}.png`) });
    // ⌘J from the composer folds it back onto the button, focus and all.
    await page.keyboard.press('ControlOrMeta+j');
    await expectRestingButton(page, 20);
    await expect(page.getByTestId('ai-panel-fab')).toBeFocused();
    await expect(input).toHaveValue('A draft that stays with this page');
  });
}

test('below 760px the button rests 10px from the corner and still opens the same draft', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 700, height: 640 });
  await page.addInitScript(() => localStorage.setItem('cerebro.themeMode', 'dark'));
  await boot(page, { preserveTheme: true });
  await expectRestingButton(page, 10);
  await page.screenshot({ path: testInfo.outputPath('narrow-button-dark.png') });
  const panel = page.getByTestId('ai-panel');
  const fab = page.getByTestId('ai-panel-fab');
  await fab.click();
  await expect(panel).not.toHaveAttribute('data-minimized');
  const input = panel.getByLabel('Message the assistant');
  await expect(input).toBeFocused();
  await input.fill('A narrow draft');
  await input.press('Escape');
  await expectRestingButton(page, 10);
  await expect(fab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).not.toHaveAttribute('data-minimized');
  await expect(input).toHaveValue('A narrow draft');
  await expect(input).toBeFocused();
});

test('a long draft restored behind the button opens at its full height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const panel = page.getByTestId('ai-panel');
  const fab = page.getByTestId('ai-panel-fab');
  const draft = 'First line\nSecond line\nThird line\nFourth line';
  await fab.click();
  const input = panel.getByLabel('Message the assistant');
  await input.fill(draft);
  const typed = (await input.boundingBox())!.height;
  expect(typed).toBeGreaterThanOrEqual(4 * 24);
  await input.press('Escape');
  await expect(fab).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('cerebro.composerDrafts')))
    .toContain('Fourth line');
  // Launch again: the thread and its draft come back while the composer is
  // hidden behind the button, where it has no box to be measured in.
  await boot(page);
  await expectRestingButton(page, 20);
  await expect(fab).not.toBeFocused();
  await expect(input).toHaveValue(draft);
  await fab.click();
  await expect(input).toBeFocused();
  expect((await input.boundingBox())!.height).toBeCloseTo(typed, 0);
});

test('minimizing preserves a waiting approval and writes only after Allow', async ({ page }) => {
  const path = 'delivery/how-we-schedule.md';
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const before = await readMockFile(page, path);
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk: string[] }).__cerebroMockAsk = ['append_to_note'];
  });
  const panel = await openFloating(page);
  await panel.getByLabel('Message the assistant').fill(`append "- call the vendor" to ${path}`);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible();
  const original = await card.elementHandle();
  await card.getByTestId('interaction-deny-message').fill('My unsent response');
  await panel.getByRole('button', { name: 'Minimize conversation' }).click();
  await expect(card).toBeHidden();
  // Waiting on the person: the button carries a dot instead of a ring.
  const fab = page.getByTestId('ai-panel-fab');
  await expect(fab).toHaveAttribute('data-state', 'waiting');
  await expect(fab.locator('.cb-chat-fab-dot')).toBeVisible();
  await expect(fab.locator('.cb-chat-fab-ring')).toHaveCount(0);
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  expect(await readMockFile(page, path)).toBe(before);
  await fab.click();
  await expect(panel).not.toHaveAttribute('data-minimized');
  await expect(card.getByTestId('interaction-deny-message')).toHaveValue('My unsent response');
  await card.getByTestId('interaction-allow').click();
  await expect.poll(() => readMockFile(page, path)).toContain('- call the vendor');
  expect(
    await page.evaluate(
      (path) => window.__cerebroMockWrites.filter((row) => row.path === path).length,
      path,
    ),
  ).toBe(1);
});
