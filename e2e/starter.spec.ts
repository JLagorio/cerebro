import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boot, openStateLab, openDestination } from './boot';

async function home(page: import('@playwright/test').Page) {
  await openDestination(page, 'Home');
}
test('an empty vault accepts the kit once and opens its Getting started page', async ({ page }) => {
  await boot(page, { vault: 'empty' });
  await home(page);
  const offer = page.getByTestId('starter-offer');
  await expect(offer.getByRole('button', { name: 'Add the starter kit' })).toBeVisible();
  await page.screenshot({ path: '/private/tmp/cerebro-starter-offer.png', fullPage: true });
  await offer.getByRole('button', { name: 'Add the starter kit' }).click();
  await expect(page.getByTestId('doc-title')).toContainText('Getting started');
  const files = await page.evaluate(() => Object.fromEntries(window.__cerebroMockFs));
  const kit = readdirSync(fileURLToPath(new URL('../shared/starter/vault/', import.meta.url)), {
    recursive: true,
  })
    .map(String)
    .filter((path) => path.endsWith('.md'));
  expect(
    Object.keys(files)
      .filter((path) => path.endsWith('.md'))
      .sort(),
  ).toEqual(kit.sort());
  expect(files['types/tasks.md']).toContain('deadline: due');
  expect(Object.keys(files).filter((path) => path.startsWith('tasks/'))).toHaveLength(3);
  expect(Object.keys(files).some((path) => path.startsWith('knowledge/'))).toBe(false);
  for (const name of ['task-helper', 'weekly-notes']) {
    expect(files[`records/agents/${name}.md`]).toContain('paused: true');
  }
  expect(JSON.parse(files['.cerebro/starter.json'])).toMatchObject({ kit: 1, outcome: 'added' });
  await home(page);
  await expect(offer).toHaveCount(0);
});
test('No thanks writes only a marker and stays declined', async ({ page }) => {
  await boot(page, { vault: 'empty' });
  await home(page);
  await page.getByTestId('starter-offer').getByRole('button', { name: 'No thanks' }).click();
  await expect(page.getByTestId('starter-offer')).toHaveCount(0);
  expect(await page.evaluate(() => [...window.__cerebroMockFs.keys()])).toEqual([
    '.cerebro/starter.json',
  ]);
  await openDestination(page, 'Inbox');
  await home(page);
  await expect(page.getByTestId('starter-offer')).toHaveCount(0);
});
test('the demo never offers the starter kit', async ({ page }) => {
  await boot(page);
  await home(page);
  await expect(page.getByTestId('starter-offer')).toHaveCount(0);
  expect(await page.evaluate(() => window.__cerebroMockFs.has('.cerebro/starter.json'))).toBe(
    false,
  );
});
test('marker failure and install refusal remain readable and retryable', async ({ page }) => {
  await openStateLab(page, 'starter-offer', 'unavailable');
  await expect(page.getByTestId('section-unavailable')).toContainText(
    'The starter offer could not be read.',
  );
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add the starter kit' })).toBeVisible();
  await openStateLab(page, 'starter-offer', 'partial');
  await page.getByRole('button', { name: 'Add the starter kit' }).click();
  await expect(page.getByTestId('starter-offer')).toBeVisible();
  expect(await page.evaluate(() => [...window.__cerebroMockFs.keys()])).toEqual([]);
});
