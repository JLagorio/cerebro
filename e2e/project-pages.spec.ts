import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';

async function openProject(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('quick-open-input');
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByTestId('quick-open-result').filter({ hasText: name }).first().click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText(name);
}

const progress = (page: Page) =>
  page.getByTestId('page-properties').locator('[data-property="progress"]');

test('a project page lists and creates its work, with related Docs and progress', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await openProject(page, 'Guided onboarding GA');
  await expect(progress(page)).toContainText('25%');
  await page.getByTestId('record-tab-tasks').click();
  const tab = page.getByTestId('view-tab-embed');
  await expect(tab.getByTestId('table-row')).toHaveCount(12);
  await expect(tab.getByText('Blank-state coaching copy')).toBeVisible();
  await expect(tab.getByText('Campaign brief')).toHaveCount(0);
  const body = await tab.boundingBox();
  expect(body).not.toBeNull();
  expect(body!.width).toBeGreaterThan(400);
  await page.screenshot({
    path: testInfo.outputPath('project-tasks.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await tab.getByRole('button', { name: 'New record in Todo', exact: true }).click();
  await tab.getByRole('textbox', { name: 'New record in Todo', exact: true }).fill('Ship docs');
  await tab.getByRole('textbox', { name: 'New record in Todo', exact: true }).press('Enter');
  await expect(tab.getByTestId('table-row')).toHaveCount(13);
  const content = await readMockFile(page, 'records/work-items/ship-docs.md');
  const yaml = /^---\n([\s\S]*?)\n---\n/.exec(content);
  expect(yaml).not.toBeNull();
  expect(YAML.parse(yaml![1])).toMatchObject({
    type: 'Work item',
    key: 'FLD-13',
    status: 'todo',
    project: '[[guided-onboarding-ga]]',
  });
  expect(content).toContain('# Ship docs');
  await expect(progress(page)).toContainText('23%');
  await page.getByTestId('record-tab-docs').click();
  await expect(tab).toContainText('No records yet');

  await openProject(page, 'Phoenix warehouse rollout');
  await expect(progress(page)).toContainText('8%');
  await page.getByTestId('record-tab-docs').click();
  await expect(tab.getByTestId('table-row')).toHaveCount(1);
  await expect(tab.getByText('Phoenix cutover — go-live PRD')).toBeVisible();

  await openProject(page, 'Field App launch campaign');
  await expect(progress(page)).toContainText('0%');
});
