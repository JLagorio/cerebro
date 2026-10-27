import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';
import { chooseOption } from './select';

const metadata = (content: string) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(content)![1]);
async function composer(page: Page) {
  await page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'New', exact: true })
    .getByRole('group', { name: 'Data', exact: true })
    .getByRole('option', { name: 'Record', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New record', exact: true });
  // The title takes focus as the composer opens. Asserted before the pick:
  // a picked option leaves focus on the database trigger, as a clicked
  // native select kept it.
  await expect(dialog.getByTestId('composer-title')).toBeFocused();
  const database = dialog.getByRole('button', { name: 'Database', exact: true });
  await chooseOption(database, 'Work item');
  if ((await dialog.getByRole('button', { name: 'Resume', exact: true }).count()) === 0)
    await expect(database).toHaveAttribute('data-value', 'Work item');
  return dialog;
}
async function high(page: Page) {
  const field = page.getByTestId('heading-strip').locator('[data-field="priority"]');
  await field.getByRole('button').click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
});

test('heading fields and similar records precede a keyboard create that opens its page', async ({
  page,
}, testInfo) => {
  const dialog = await composer(page);
  const title = dialog.getByTestId('composer-title');
  await title.fill('Landing page');
  await expect(
    dialog.getByTestId('similar-record').filter({ hasText: 'Landing page refresh' }),
  ).toBeVisible();
  await high(page);
  const strip = dialog.getByTestId('heading-strip');
  await expect(strip.getByRole('button', { name: 'Backlog', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'High', exact: true })).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(250);
  expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: testInfo.outputPath('record-composer.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await title.press('ControlOrMeta+Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('doc-title')).toHaveText('Landing page');
  const content = await readMockFile(page, 'records/work-items/landing-page.md');
  expect(metadata(content)).toMatchObject({
    type: 'Work item',
    status: 'backlog',
    priority: 'high',
  });
  expect(content).toContain('# Landing page\n');
});

test('Create more makes two records, retaining fields and title focus', async ({ page }) => {
  const dialog = await composer(page);
  await high(page);
  await dialog.getByTestId('composer-create-more').check();
  const title = dialog.getByTestId('composer-title');
  for (const name of ['Alpha', 'Beta']) {
    await title.fill(name);
    await title.press('Enter');
    await expect(title).toHaveValue('');
    await expect(title).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'High', exact: true })).toBeVisible();
    const content = await readMockFile(page, `records/work-items/${name.toLowerCase()}.md`);
    expect(metadata(content)).toMatchObject({
      type: 'Work item',
      status: 'backlog',
      priority: 'high',
    });
  }
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('toast-host')).toContainText('Created “Beta”');
});

test('an unavailable similar search says so and never blocks creation', async ({ page }) => {
  await page.evaluate(() => window.__cerebroFailSearchVault('down'));
  const dialog = await composer(page);
  await dialog.getByTestId('composer-title').fill('Search unavailable');
  await expect(dialog.getByTestId('similar-unavailable')).toHaveText(
    "Couldn't check for similar records.",
  );
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('Search unavailable');
  expect(await readMockFile(page, 'records/work-items/search-unavailable.md')).toContain(
    '# Search unavailable\n',
  );
});

test('Cancel and database changes retain scoped drafts with explicit Resume and Discard', async ({
  page,
}) => {
  const dialog = await composer(page);
  await dialog.getByTestId('composer-title').fill('  Keep my record  ');
  await high(page);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const reopened = await composer(page);
  await reopened.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(reopened.getByTestId('composer-title')).toHaveValue('  Keep my record  ');
  await expect(reopened.getByRole('button', { name: 'High', exact: true })).toBeVisible();
  await expect(reopened.getByTestId('creation-destination')).toContainText('records/work-items');
  await chooseOption(reopened.getByTestId('composer-database'), 'Person');
  await expect(reopened.getByRole('region', { name: 'Change draft destination' })).toContainText(
    'To: In Person · records/persons',
  );
  await reopened.getByRole('button', { name: 'Leave draft and start here', exact: true }).click();
  await expect(reopened.getByTestId('composer-title')).toHaveValue('');
  await chooseOption(reopened.getByTestId('composer-database'), 'Work item');
  await reopened.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(reopened.getByTestId('composer-title')).toHaveValue('');
});

for (const theme of ['light', 'dark'] as const) {
  test(`session controls fit a narrow host in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 520, height: 760 });
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    const dialog = await composer(page);
    await dialog.getByTestId('composer-title').fill('Narrow session');
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(520);
    await expect(dialog.getByTestId('creation-destination')).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`creation-destination-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const recovered = await composer(page);
    await expect(recovered.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await expect(recovered.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
    await expect(recovered).toContainText('until the app closes');
    await page.screenshot({
      path: info.outputPath(`creation-recovery-${theme}.png`),
      animations: 'disabled',
    });
  });
}
