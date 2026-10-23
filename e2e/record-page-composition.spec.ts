import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

test('a real project gives its content priority and keeps its property manager reachable', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const path = 'records/projects/guided-onboarding-ga.md';
  const before = await readMockFile(page, path);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Guided onboarding GA');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Guided onboarding GA' })
    .first()
    .click();
  const peek = page.getByTestId('detail-panel');
  await expect(peek.getByTestId('record-summary')).toBeVisible();
  await expect(peek.getByTestId('page-properties')).toHaveCount(0);
  await peek.getByRole('button', { name: 'Open in full page' }).click();
  const title = page.getByTestId('markdown-editor').locator('[data-page-title] h1');
  await expect(title).toHaveText('Guided onboarding GA');
  await expect(page.getByTestId('record-tab-overview')).toBeVisible();
  const summary = page.getByTestId('record-summary');
  await expect(summary).toBeVisible();
  await expect(page.getByTestId('page-properties')).toHaveCount(0);
  const knowledge = page.getByTestId('knowledge-strip');
  const titleBox = (await title.boundingBox())!;
  const knowledgeBox = (await knowledge.boundingBox())!;
  const tabsBox = (await page.getByTestId('record-tabs').boundingBox())!;
  expect(Math.abs(knowledgeBox.x - titleBox.x)).toBeLessThanOrEqual(4);
  expect(tabsBox.y - titleBox.y - titleBox.height).toBeLessThan(120);
  await page.locator('.cb-document-toolbar').click({ position: { x: 10, y: 55 } });
  await page.screenshot({ path: info.outputPath('project-overview.png'), animations: 'disabled' });
  const stateSummary = summary.getByRole('button', { name: 'Show State property' });
  await stateSummary.focus();
  await page.keyboard.press('Tab');
  await expect(summary.getByRole('button', { name: 'Show Progress property' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(summary.getByRole('button', { name: 'Show Key property' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('record-properties-toggle')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(stateSummary).toBeFocused();
  await page.keyboard.press('Enter');
  const manager = page.getByTestId('page-properties');
  await expect(manager).toBeVisible();
  const state = manager.locator('[data-property="state"] [data-cell-primary]');
  await expect(state).toBeFocused();
  await expect(manager.getByText('Color', { exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Add property', exact: true })).toBeVisible();
  expect((await manager.locator('[data-property="state"]').boundingBox())!.height).toBe(34);
  await page.locator('.cb-document-toolbar').click({ position: { x: 10, y: 55 } });
  await page.screenshot({
    path: info.outputPath('project-properties.png'),
    animations: 'disabled',
  });
  await manager.getByRole('button', { name: 'FLD', exact: true }).click();
  const draft = manager.getByRole('textbox', { name: 'Key', exact: true });
  await draft.fill('A draft kept while editing');
  await expect(page.getByTestId('record-properties-toggle')).toBeDisabled();
  await draft.press('Escape');
  await page.getByTestId('record-properties-toggle').click();
  await expect(manager).toBeHidden();
  await page.getByTestId('record-tab-tasks').click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();
  await page.locator('.cb-document-toolbar').click({ position: { x: 10, y: 55 } });
  await page.screenshot({ path: info.outputPath('project-tasks.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.getByTestId('record-properties-toggle')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
  expect(await readMockFile(page, path)).toBe(before);
});
