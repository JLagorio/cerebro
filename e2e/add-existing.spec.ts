import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';

const CAMPAIGN = 'projects/field-app-launch-campaign/items/lnc-1.md';
const POSITIONING = 'projects/field-app-launch-campaign/items/lnc-2.md';
const filing = (content: string) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(content)![1]).project;

async function openTasks(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Guided onboarding GA');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Guided onboarding GA' })
    .first()
    .click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await page.getByTestId('record-tab-tasks').click();
  await expect(page.getByTestId('view-tab-embed').getByTestId('table-row')).toHaveCount(12);
  await page.getByTestId('view-tab-add-existing').click();
}

async function stage(page: Page, title: string) {
  const picker = page.getByTestId('relation-picker');
  await picker.getByRole('textbox', { name: 'Search records to link' }).fill(title);
  await picker.getByTestId('relation-result-row').filter({ hasText: title }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
});

test('Add existing moves two records together and Undo restores exact bytes', async ({
  page,
}, testInfo) => {
  const before = [await readMockFile(page, CAMPAIGN), await readMockFile(page, POSITIONING)];
  await openTasks(page);
  const picker = page.getByTestId('relation-picker');
  await expect(picker.getByTestId('relation-picker-confirm')).toBeDisabled();
  await stage(page, 'Campaign brief');
  await stage(page, 'Positioning + message house');
  await expect(picker).toContainText('Selected · 2');
  await expect(picker.getByTestId('relation-picker-confirm')).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  expect(await readMockFile(page, CAMPAIGN)).toBe(before[0]);
  expect(await readMockFile(page, POSITIONING)).toBe(before[1]);
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(400);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: testInfo.outputPath('add-existing.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await picker.getByRole('button', { name: 'Add 2 records', exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByTestId('view-tab-embed').getByTestId('table-row')).toHaveCount(14);
  expect(filing(await readMockFile(page, CAMPAIGN))).toEqual(['[[guided-onboarding-ga]]']);
  expect(filing(await readMockFile(page, POSITIONING))).toEqual(['[[guided-onboarding-ga]]']);
  const toast = page.getByTestId('toast-host');
  await expect(toast).toContainText('Added 2 records to “Guided onboarding GA”');
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('view-tab-embed').getByTestId('table-row')).toHaveCount(12);
  expect(await readMockFile(page, CAMPAIGN)).toBe(before[0]);
  expect(await readMockFile(page, POSITIONING)).toBe(before[1]);
});

test('a changed staged record stays selected and named while the ready record is added', async ({
  page,
}) => {
  await openTasks(page);
  await stage(page, 'Campaign brief');
  await stage(page, 'Positioning + message house');
  const newer = (await readMockFile(page, CAMPAIGN)) + '\nAn edit from another app.\n';
  await page.evaluate(([path, text]) => window.__cerebroMockFs.set(path, text), [CAMPAIGN, newer]);
  const picker = page.getByTestId('relation-picker');
  await picker.getByRole('button', { name: 'Add 2 records', exact: true }).click();
  await expect(picker).toContainText('Selected · 1');
  await expect(picker.getByTestId('relation-linked-row')).toHaveCount(1);
  await expect(picker.getByTestId('relation-linked-row')).toContainText('Campaign brief');
  await expect(picker.getByRole('alert')).toContainText(
    "1 couldn't be added. “Campaign brief” changed since the table showed it.",
  );
  expect(await readMockFile(page, CAMPAIGN)).toBe(newer);
  expect(filing(newer)).toBe('[[field-app-launch-campaign]]');
  expect(filing(await readMockFile(page, POSITIONING))).toEqual(['[[guided-onboarding-ga]]']);
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('view-tab-embed').getByTestId('table-row')).toHaveCount(13);
});
