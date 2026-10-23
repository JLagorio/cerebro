import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

async function openCanvas(page: Page) {
  await page
    .getByTestId('app-rail')
    .getByRole('button', { name: 'Assistant', exact: true })
    .click();
  const panel = page.getByTestId('ai-panel');
  if ((await panel.getAttribute('data-presentation')) !== 'canvas') {
    if ((await panel.getAttribute('data-presentation')) === 'floating') {
      await panel.getByRole('button', { name: 'Conversation options' }).click();
      await page.getByRole('menuitem', { name: 'Expand conversation' }).click();
    } else {
      await panel.getByRole('button', { name: 'Expand conversation' }).click();
    }
  }
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  return panel;
}

test('conversation canvas gives the greeting and composer a centered reading column', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const panel = await openCanvas(page);
  await expect(
    panel.getByRole('heading', { name: 'What would you like to work on?' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await expect(panel.getByLabel('Message the assistant')).toBeFocused();
  const bounds = await panel.boundingBox();
  const composer = await panel.getByTestId('chat-composer').boundingBox();
  expect(bounds).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(composer!.width).toBeGreaterThan(600);
  expect(composer!.width).toBeLessThanOrEqual(760);
  expect(
    Math.abs(composer!.x + composer!.width / 2 - (bounds!.x + bounds!.width / 2)),
  ).toBeLessThan(2);
  expect(composer!.y + composer!.height).toBeLessThan(bounds!.y + bounds!.height);
  const welcome = (await panel.getByTestId('chat-welcome').boundingBox())!;
  const starters = (await panel.getByTestId('chat-starters').boundingBox())!;
  const body = (await panel.locator('.cb-chat-body').boundingBox())!;
  expect(composer!.y - (welcome.y + welcome.height)).toBeGreaterThan(0);
  expect(composer!.y - (welcome.y + welcome.height)).toBeLessThan(40);
  expect(starters.y).toBeGreaterThan(composer!.y + composer!.height);
  expect(
    Math.abs((welcome.y + starters.y + starters.height) / 2 - (body.y + body.height / 2)),
  ).toBeLessThan(4);
  expect(
    await panel
      .getByTestId('ai-suggestion')
      .first()
      .evaluate((el) => getComputedStyle(el).borderWidth),
  ).toBe('0px');
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  await panel.getByLabel('Message the assistant').fill('Help me with');
  await panel.getByRole('button', { name: 'Add context', exact: true }).click();
  const menu = panel.getByTestId('attach-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button').first().click();
  await expect(panel.getByLabel('Message the assistant')).toHaveValue('Help me with ');
  await expect(panel.getByTestId('context-chip')).toHaveCount(2);
  await expect(panel.getByLabel('Message the assistant')).toBeFocused();
});

test('docking a live conversation keeps its draft, turn, and transcript exactly once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const panel = await openCanvas(page);
  const input = panel.getByLabel('Message the assistant');
  const original = await input.elementHandle();
  await input.fill('wait for me');
  await input.press('Enter');
  await expect(panel.getByTestId('action-card').first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  // The first send changes layout, never the input or the controller that
  // owns the turn. The same invariant holds when it docks afterward.
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(panel.getByTestId('chat-starters')).toHaveCount(0);
  const bounds = (await panel.boundingBox())!;
  const composer = (await panel.getByTestId('chat-composer').boundingBox())!;
  expect(composer.y).toBeGreaterThan(bounds.y + bounds.height * 0.65);
  expect(bounds.y + bounds.height - (composer.y + composer.height)).toBeLessThan(75);
  await input.fill('Keep this draft');
  await panel.getByRole('button', { name: 'Dock conversation' }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'panel');
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(input).toHaveValue('Keep this draft');
  await panel.getByRole('button', { name: 'Expand conversation' }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Keep this draft');
  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
  const replies = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(replies).toHaveCount(1);
  await expect(replies).toContainText('Done waiting.');
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(1);
  await expect(input).toHaveValue('Keep this draft');
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

for (const theme of ['light', 'dark'] as const) {
  test(`empty chat stays usable in a short ${theme} window, including context completion`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 760, height: 600 });
    await page.addInitScript((theme) => localStorage.setItem('cerebro.themeMode', theme), theme);
    await boot(page, { preserveTheme: true });
    const panel = await openCanvas(page);
    const input = panel.getByLabel('Message the assistant');
    const welcome = (await panel.getByTestId('chat-welcome').boundingBox())!;
    const composer = (await panel.getByTestId('chat-composer').boundingBox())!;
    const starters = (await panel.getByTestId('chat-starters').boundingBox())!;
    expect(welcome.y).toBeGreaterThanOrEqual(58);
    expect(composer.y).toBeGreaterThan(welcome.y + welcome.height);
    expect(starters.y).toBeGreaterThan(composer.y + composer.height);
    expect(starters.y + starters.height).toBeLessThanOrEqual(574);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`chat-empty-${theme}.png`) });

    await panel.getByRole('button', { name: 'Add context', exact: true }).click();
    await expect
      .poll(() => input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart))
      .toBe(1);
    const menu = panel.getByTestId('attach-menu');
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    const header = (await panel.locator('.cb-chat-header').boundingBox())!;
    expect(menuBox.y).toBeGreaterThanOrEqual(header.y + header.height);
    await menu.getByRole('button').first().click();
    await expect(input).toHaveValue('');
    await expect(panel.getByTestId('context-chip')).toHaveCount(2);
    await panel.getByTestId('ai-suggestion').first().click();
    await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveText(
      'What is at risk right now?',
    );
    await expect(panel.getByTestId('chat-starters')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`chat-active-${theme}.png`) });
  });
}

test('conversation navigation reuses existing threads and a narrow composer keeps every action reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const panel = await openCanvas(page);
  const input = panel.getByLabel('Message the assistant');
  await input.fill('What is at risk right now?');
  await input.press('Enter');
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: 'New conversation' })
    .click();
  await expect(panel.getByTestId('chat-welcome')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByTestId('conversation-row')
    .filter({ hasText: 'What is at risk right now?' })
    .getByRole('button')
    .first()
    .click();
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
  await expect(
    page.getByRole('navigation', { name: 'Conversations' }).locator('button[aria-current="true"]'),
  ).toContainText('What is at risk right now?');
  await page.setViewportSize({ width: 760, height: 700 });
  await input.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'));
  const bounds = await panel.boundingBox();
  for (const control of [
    input,
    panel.getByRole('button', { name: 'Send', exact: true }),
    panel.getByTestId('run-options'),
    panel.getByRole('button', { name: 'Add context', exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  }
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(184);
});

test('a full queue and multiline draft keep the transcript and Stop reachable in a short window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await boot(page);
  const panel = await openCanvas(page);
  const input = panel.getByLabel('Message the assistant');
  await input.fill('wait for me');
  await input.press('Enter');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  for (let i = 1; i <= 10; i += 1) {
    await input.fill(`Queued message ${i}`);
    await input.press('Enter');
  }
  await expect(panel.getByTestId('up-next-entry')).toHaveCount(10);
  await input.fill(Array.from({ length: 12 }, (_, i) => `Draft line ${i + 1}`).join('\n'));
  const transcript = await panel.getByTestId('chat-scroll').boundingBox();
  expect(transcript!.height).toBeGreaterThan(100);
  for (const control of [input, panel.getByRole('button', { name: 'Stop', exact: true })]) {
    const box = await control.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  }
  const last = panel.getByTestId('up-next-entry').last();
  await last.getByRole('button', { name: 'Remove from Up next' }).click();
  await expect(panel.getByTestId('up-next-entry')).toHaveCount(9);
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(panel.getByTestId('up-next-held')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('an open approval survives docking and expanding and writes only after Allow', async ({
  page,
}) => {
  const path = 'delivery/how-we-schedule.md';
  const body = '# How we schedule\n\nWe ship on Thursdays, after the freeze.\n';
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  await page.evaluate(
    ({ path, body }) => {
      window.__cerebroMockFs.set(path, body);
      (window as unknown as { __cerebroMockAsk: string[] }).__cerebroMockAsk = ['append_to_note'];
    },
    { path, body },
  );
  const panel = await openCanvas(page);
  await panel.getByLabel('Message the assistant').fill(`append "- call the vendor" to ${path}`);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible();
  const original = await card.elementHandle();
  await card.getByTestId('interaction-deny-message').fill('A draft response');
  expect(await readMockFile(page, path)).toBe(body);

  await panel.getByRole('button', { name: 'Dock conversation' }).click();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(card.getByTestId('interaction-deny-message')).toHaveValue('A draft response');
  expect(await readMockFile(page, path)).toBe(body);
  await panel.getByRole('button', { name: 'Expand conversation' }).click();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(card.getByTestId('interaction-deny-message')).toHaveValue('A draft response');
  expect(await readMockFile(page, path)).toBe(body);

  await card.getByTestId('interaction-allow').click();
  await expect(card).toBeHidden();
  await expect(panel.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(1);
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: `I appended that to ${path}.` }),
  ).toHaveCount(1);
  await expect.poll(() => readMockFile(page, path)).toBe(`${body}\n- call the vendor\n`);
  expect(
    await page.evaluate(
      (path) => window.__cerebroMockWrites.filter((row) => row.path === path).length,
      path,
    ),
  ).toBe(1);
});
