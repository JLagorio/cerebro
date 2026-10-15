import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';

async function openPage(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(name);
  await page.getByTestId('quick-open-result').filter({ hasText: name }).first().click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText(name);
}
const properties = (text: string): Record<string, unknown> =>
  YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]) as Record<string, unknown>;

test('project agents apply only to work newly filed through a human action', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  const existingPath = 'projects/guided-onboarding-ga/items/fld-4.md';
  const existing = await readMockFile(page, existingPath);
  await openPage(page, 'Guided onboarding GA');
  await page.getByTestId('record-tab-agents').click();
  await expect(page.getByTestId('page-agents-empty')).toBeVisible();
  await page.getByTestId('page-agents-add').click();
  const picker = page.getByTestId('relation-picker');
  await picker.getByTestId('relation-result-row').filter({ hasText: 'Release scout' }).click();
  await picker.getByPlaceholder('Link an agent…').press('Escape');
  await expect(page.getByTestId('page-agent-row')).toContainText("Won't wake on its own");
  await expect(page.getByTestId('page-agents-footers')).toContainText(
    'Docs have no field that takes agents.',
  );
  expect(
    properties(await readMockFile(page, 'records/projects/guided-onboarding-ga.md')).agents,
  ).toEqual(['[[release-scout]]']);
  expect(await readMockFile(page, existingPath)).toBe(existing);
  await page.screenshot({
    path: testInfo.outputPath('project-agents.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.getByTestId('record-tab-tasks').click();
  const tab = page.getByTestId('view-tab-embed');
  await tab.getByRole('button', { name: 'New record in Todo', exact: true }).click();
  await tab.getByRole('textbox', { name: 'New record in Todo', exact: true }).fill('Ship docs');
  await tab.getByRole('textbox', { name: 'New record in Todo', exact: true }).press('Enter');
  await expect(tab.getByTestId('table-row')).toHaveCount(13);
  expect(properties(await readMockFile(page, 'records/work-items/ship-docs.md'))).toMatchObject({
    project: '[[guided-onboarding-ga]]',
    agent: ['[[release-scout]]'],
  });
  expect(await readMockFile(page, existingPath)).toBe(existing);

  await page.getByTestId('record-tab-docs').click();
  await tab.getByRole('button', { name: 'New record', exact: true }).click();
  await tab.getByRole('textbox', { name: 'New record', exact: true }).fill('Launch guide');
  await tab.getByRole('textbox', { name: 'New record', exact: true }).press('Enter');
  await expect(tab.getByTestId('table-row')).toHaveCount(1);
  const doc = properties(await readMockFile(page, 'records/specs/launch-guide.md'));
  expect(doc.project).toBe('[[guided-onboarding-ga]]');
  expect(doc).not.toHaveProperty('agent');

  await openPage(page, 'Rack layout sign-off');
  await page.getByTestId('view-details-toggle').click();
  await page.getByRole('button', { name: 'Edit Project', exact: true }).click();
  await picker.getByRole('button', { name: 'Unlink Phoenix warehouse rollout' }).click();
  await picker
    .getByRole('textbox', { name: 'Search records to link' })
    .fill('Guided onboarding GA');
  await picker
    .getByTestId('relation-result-row')
    .filter({ hasText: 'Guided onboarding GA' })
    .click();
  await expect
    .poll(async () =>
      properties(await readMockFile(page, 'projects/phoenix-warehouse-rollout/items/ops-1.md')),
    )
    .toMatchObject({ project: ['[[guided-onboarding-ga]]'], agent: ['[[release-scout]]'] });
});
