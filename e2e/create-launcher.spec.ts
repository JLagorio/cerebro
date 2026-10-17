import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

test('the launcher explains its groups, creates a database with starter statuses, and remembers it', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true }).click();
  const launcher = page.getByTestId('create-launcher');
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole('group')).toHaveCount(7);
  await expect(launcher.getByTestId('create-lands')).toHaveText('At the top of the vault.');
  await page.screenshot({
    path: '/private/tmp/cerebro-create-launcher.png',
    fullPage: true,
    animations: 'disabled',
  });
  await launcher.getByRole('option', { name: 'Database', exact: true }).click();
  await page.getByPlaceholder('e.g. Recipe, Book, Habit…').fill('Recipes');
  await page
    .getByRole('dialog', { name: 'New database' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(page).toHaveTitle('Recipes — Cerebro');
  const source = await readMockFile(page, 'types/recipes.md');
  expect(source).toContain('statuses:');
  expect(source).toContain('folder: records/recipes');
  expect(source).toContain('kind: status');
  await page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true }).click();
  await expect(
    page
      .getByRole('group', { name: 'Recent' })
      .getByRole('option', { name: 'Database', exact: true }),
  ).toBeVisible();
});

test('creation chords work with collapsed navigation and stay text inside a page', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });
  await page.keyboard.press('c');
  await page.keyboard.press('n');
  await expect(page.getByTestId('create-launcher')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('option', { name: 'Capture', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await page.keyboard.press('p');
  await page.getByPlaceholder('Page title').fill('Launch notes');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page).toHaveTitle('Launch notes — Cerebro');
  await page.locator('.bn-editor').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('cp');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readMockFile(page, 'launch-notes.md')).toContain('cp');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('New Whiteboard and its chord create deduped files and open them as pages', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('group', { name: 'Diagram', exact: true })
    .getByRole('option', { name: 'Whiteboard', exact: true })
    .click();
  await page.getByPlaceholder('Whiteboard title').fill('Launch map');
  await page.getByRole('button', { name: 'Create whiteboard', exact: true }).click();
  await expect(page).toHaveTitle('Launch map — Cerebro');
  await expect(page.getByTestId('wb-board')).toBeVisible();
  expect(JSON.parse(await readMockFile(page, 'launch-map.canvas'))).toMatchObject({
    nodes: [],
    edges: [],
  });
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });
  await page.keyboard.press('c');
  await page.keyboard.press('w');
  await expect(page.getByRole('dialog', { name: 'New whiteboard' })).toBeVisible();
  await page.getByPlaceholder('Whiteboard title').fill('Launch map');
  await page.getByRole('button', { name: 'Create whiteboard', exact: true }).click();
  await expect(page).toHaveTitle('Launch map 2 — Cerebro');
  expect(JSON.parse(await readMockFile(page, 'launch-map-2.canvas'))).toMatchObject({
    nodes: [],
    edges: [],
  });
});
