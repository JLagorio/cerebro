import { expect, test, type Page } from '@playwright/test';
import { boot, openDatabase, readMockFile, seedBeforeBoot } from './boot';

const PATH = 'projects/field-app-launch-campaign/items/lnc-8.md';

async function openItem(page: Page) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const before = await readMockFile(page, PATH);
  await openDatabase(page, 'Work item');
  const tab = page.getByTestId('view-tabs').getByRole('tab', { name: 'At risk', exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  const row = page
    .getByTestId('table-row')
    .filter({ hasText: 'Rewrite messaging for the console split' });
  await row.hover();
  await row.getByRole('button', { name: 'Open Rewrite messaging for the console split' }).click();
  return { peek: page.getByTestId('detail-panel'), before };
}

test('a work item peek leads with its content and keeps supporting context reachable', async ({
  page,
}, info) => {
  const { peek, before } = await openItem(page);
  await expect(peek.locator('[data-page-title] h1')).toHaveText(
    'Rewrite messaging for the console split',
  );
  await expect(
    peek.getByText('Every asset currently describes one app for both audiences, which', {
      exact: false,
    }),
  ).toBeVisible();
  const title = peek.locator('[data-page-title] h1');
  const body = peek
    .locator('.bn-block-content[data-content-type="paragraph"]')
    .filter({ hasText: 'Every asset' });
  const titleBox = (await title.boundingBox())!;
  const bodyBox = (await body.boundingBox())!;
  const knowledge = peek.getByTestId('detail-knowledge');
  const knowledgeBox = (await knowledge.boundingBox())!;
  expect(knowledgeBox.y).toBeGreaterThan(bodyBox.y + bodyBox.height);
  expect(Math.abs(bodyBox.x - titleBox.x)).toBeLessThanOrEqual(4);
  expect(bodyBox.y - titleBox.y - titleBox.height).toBeLessThan(100);
  await expect(peek.getByTestId('detail-knowledge-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await peek.locator('.cb-peek-header').click({ position: { x: 260, y: 20 } });
  await page.screenshot({ path: info.outputPath('work-item-peek.png'), animations: 'disabled' });
  await peek.getByTestId('detail-knowledge-toggle').press('Enter');
  await expect(peek.getByTestId('page-knowledge')).toBeVisible();
  await expect(
    peek.getByRole('button', { name: 'Learn from this page', exact: true }),
  ).toBeVisible();
  expect((await body.boundingBox())!.y).toBe(bodyBox.y);
  await peek.locator('.cb-peek-header').click({ position: { x: 260, y: 20 } });
  await page.screenshot({ path: info.outputPath('work-item-context.png'), animations: 'disabled' });
  await peek.getByTestId('detail-knowledge-toggle').press('Enter');
  await peek.getByTestId('view-details-toggle').press('Enter');
  await expect(peek.getByRole('button', { name: 'Add property', exact: true })).toBeVisible();
  await peek.getByTestId('view-details-toggle').press('Enter');
  await expect(peek.getByTestId('page-properties')).toBeHidden();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(title).toBeVisible();
  await expect(body).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
  expect(await readMockFile(page, PATH)).toBe(before);
});

test('peek history is quiet until opened and still opens the recorded version', async ({
  page,
}, info) => {
  await seedBeforeBoot(page, '__cerebroSeedGitHistory', [
    {
      hash: 'a'.repeat(40),
      message: 'Clarify the console messaging',
      date: 1785153600,
      files: [{ path: PATH, status: 'modified' }],
      snapshots: { [PATH]: '# Rewrite messaging for the console split\n\nEarlier wording.\n' },
    },
  ]);
  const { peek, before } = await openItem(page);
  await expect(peek.locator('[data-page-title] h1')).toHaveText(
    'Rewrite messaging for the console split',
  );
  await expect(
    peek
      .locator('.bn-block-content[data-content-type="paragraph"]')
      .filter({ hasText: 'Every asset' }),
  ).toBeVisible();
  const toggle = peek.getByTestId('peek-history-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(
    peek.getByRole('button', { name: 'Clarify the console messaging', exact: true }),
  ).toBeHidden();
  await toggle.press('Enter');
  const version = peek.getByRole('button', { name: 'Clarify the console messaging', exact: true });
  await expect(version).toBeVisible();
  await peek.locator('.cb-peek-header').click({ position: { x: 260, y: 20 } });
  await page.screenshot({ path: info.outputPath('work-item-history.png'), animations: 'disabled' });
  await version.click();
  await expect(peek.getByTestId('inline-diff')).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(before);
});
