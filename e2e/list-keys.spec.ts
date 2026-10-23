import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { boot, openKnowledgeTab, readMockFile, seedFileBeforeBoot, openDestination } from './boot';

test('My work keys peek in place, type in the body, and close one thing per Escape', async ({
  page,
}, testInfo) => {
  const bodyPath = 'projects/phoenix-warehouse-rollout/items/ops-2.md';
  await seedFileBeforeBoot(
    page,
    bodyPath,
    `${readFileSync(`demo-vault/${bodyPath}`, 'utf8')}\nKeyboard body.\n`,
  );
  await boot(page);
  await openDestination(page, 'My work');
  const rows = page.getByRole('listbox', { name: 'My work' }).getByRole('option');
  const second = await rows.nth(1).getAttribute('data-cursor-key');
  const third = await rows.nth(2).getAttribute('data-cursor-key');
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('j');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('j');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('x');
  await expect(page.getByTestId('list-selection')).toContainText('1 selected');
  await page.keyboard.press('Enter');
  const peek = page.getByTestId('detail-panel');
  await expect(peek).toBeVisible();
  await expect(page.locator(`[data-cursor-key="${second}"]`)).toHaveAttribute(
    'data-focused',
    'true',
  );
  const secondTitle = (await page
    .getByTestId('detail-panel')
    .locator('[data-page-title] h1')
    .textContent())!;
  await page.keyboard.press('j');
  await expect(page.locator(`[data-cursor-key="${third}"]`)).toHaveAttribute(
    'data-focused',
    'true',
  );
  await expect(page.getByTestId('detail-panel').locator('[data-page-title] h1')).not.toHaveText(
    secondTitle,
  );
  const title = (await page
    .getByTestId('detail-panel')
    .locator('[data-page-title] h1')
    .textContent())!;
  const body = peek.locator('.bn-editor [data-content-type="paragraph"]').first();
  await body.click();
  await page.keyboard.type('j');
  await expect(body).toContainText('j');
  await expect.poll(() => readMockFile(page, third!)).toMatch(/\n[^#\n]*j/);
  await expect(page.getByTestId('detail-panel').locator('[data-page-title] h1')).toHaveText(title);
  await page.screenshot({ path: testInfo.outputPath('my-work-peek.png') });
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  await expect(page.getByTestId('list-selection')).toContainText('1 selected');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('list-selection')).toHaveCount(0);
});

test('Inbox j advances the capture and Enter opens its page', async ({ page }) => {
  await boot(page);
  await openDestination(page, 'Inbox');
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('j');
  await expect(page.getByText(/^2 of \d+$/)).toBeVisible();
  await expect(page.getByTestId('inbox-row').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-title')).toBeVisible();
});

test('Concepts j then Enter opens the first concept page', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'all');
  const first = page.getByTestId('concept-row').first();
  const title = await first.locator('[data-concept-title]').textContent();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('j');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-title')).toHaveText(title ?? '');
});
