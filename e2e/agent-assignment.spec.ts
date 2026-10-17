import { expect, test } from '@playwright/test';
import { boot, readMockFile, showDatabases, openAgents } from './boot';

test('a Work item links an existing Agent and opens its page', async ({ page }, testInfo) => {
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Blank-state coaching copy');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Blank-state coaching copy' })
    .first()
    .click();
  await expect(page.getByTestId('detail-panel')).toContainText('Blank-state coaching copy');
  await page.getByTestId('view-details-toggle').click();
  await page.getByRole('button', { name: 'Edit Agent', exact: true }).click();
  const picker = page.getByTestId('relation-picker');
  await expect(
    picker.getByTestId('relation-result-row').filter({ hasText: 'Release scout' }),
  ).toBeVisible();
  await expect(
    picker.getByTestId('relation-result-row').filter({ hasText: 'Knowledge agent' }),
  ).toBeVisible();
  await expect(picker.getByTestId('relation-picker-library-hint')).toHaveText(
    'Agents are made in the Library and start paused.',
  );
  const input = picker.getByPlaceholder('Link an agent…');
  await input.fill('Nobody');
  await expect(picker.getByTestId('relation-create')).toHaveCount(0);
  await input.press('Enter');
  await expect(picker).toBeVisible();
  await input.fill('');
  await picker.getByTestId('relation-result-row').filter({ hasText: 'Release scout' }).click();
  await expect
    .poll(() => readMockFile(page, 'projects/guided-onboarding-ga/items/fld-4.md'))
    .toMatch(/agent:\s*\n\s+- ['"]?\[\[release-scout\]\]/);
  await expect(picker.getByTestId('relation-linked-row')).toContainText('Release scout');
  await page.screenshot({ path: testInfo.outputPath('agent-relation.png') });
  await picker.getByRole('button', { name: 'Open Release scout' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('Release scout');
  await expect(page.getByTestId('agent-properties')).toBeVisible();
});

test('the property catalog declares Agent only as a one-way Relation', async ({ page }) => {
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await page.getByRole('button', { name: 'Add a column', exact: true }).click();
  await page.getByTestId('property-kind-relation').click();
  await page.getByTestId('relation-target-Agent').click();
  await expect(page.getByRole('switch', { name: 'Add related property' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId('property-kind-person').click();
  await expect(page.getByText('People come from', { exact: true })).toBeVisible();
  await expect(page.getByTestId('relation-target-Agent')).toHaveCount(0);
});

test('an assigned trigger drains three bulk-linked pages and a re-add wakes again', async ({
  page,
}, testInfo) => {
  await boot(page, { autoLearn: true });
  const scout = 'records/agents/release-scout.md';
  await openAgents(page);
  await page.getByTestId('nav-agent').filter({ hasText: 'Release scout' }).click();
  await page.getByTestId('agent-add-trigger').click();
  const editor = page.getByTestId('agent-editor-trigger-new');
  await editor.getByLabel('Trigger 1 event').selectOption('assigned');
  await expect(editor.getByLabel('Trigger 1 value')).toHaveCount(0);
  await editor.getByLabel('Trigger 1 field').selectOption('agent');
  await expect(editor).toContainText('Only links made while Cerebro is open wake it.');
  expect(await readMockFile(page, scout)).not.toContain('event: assigned');
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => readMockFile(page, scout)).toContain('event: assigned');
  await expect.poll(() => readMockFile(page, scout)).toContain('field: agent');

  await showDatabases(page);

  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  const rows = page.getByTestId('table-row');
  await expect(rows).toHaveCount(45);
  const paths = await rows.evaluateAll((nodes) =>
    nodes.slice(0, 3).map((node) => node.getAttribute('data-path')!),
  );
  for (const path of paths)
    await page
      .locator(`[data-testid="table-row"][data-path="${path}"]`)
      .getByRole('checkbox')
      .click();
  await expect(page.getByTestId('bulk-bar')).toContainText('3 selected');
  await page.getByTestId('bulk-set').click();
  await page.getByTestId('bulk-set-field-agent').click();
  await page.getByRole('button', { name: 'Edit Agent', exact: true }).click();
  await page.getByTestId('relation-result-row').filter({ hasText: 'Release scout' }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('bulk-set-apply').click();
  const wakes = () =>
    page.evaluate(() =>
      window.__cerebroMockWakes().filter((wake) => wake.cause.kind === 'assigned'),
    );
  await expect.poll(async () => (await wakes()).length).toBe(3);
  expect((await wakes()).map((wake) => wake.cause.subject).sort()).toEqual([...paths].sort());
  expect(new Set((await wakes()).map((wake) => wake.wakeKey)).size).toBe(3);
  expect((await wakes()).every((wake) => wake.cause.detail === 'via agent')).toBe(true);
  await openAgents(page);
  await page.getByTestId('nav-agent').filter({ hasText: 'Release scout' }).click();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await expect(page.getByTestId('agent-wake-cause').first()).toHaveText(
    'work was assigned to it (via agent)',
  );
  await page.getByTestId('agent-wake-cause').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('assigned-wakes.png') });
  await expect
    .poll(async () => (await wakes()).map((wake) => wake.outcome), { timeout: 30_000 })
    .toEqual(['succeeded', 'succeeded', 'succeeded']);

  // A human removal writes no new wake; a later re-add admits a fourth.
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  const first = page.locator(`[data-testid="table-row"][data-path="${paths[0]}"]`);
  await first.getByRole('checkbox').click();
  await page.getByTestId('bulk-set').click();
  await page.getByTestId('bulk-set-field-agent').click();
  await page.getByRole('button', { name: 'Clear value', exact: true }).click();
  await page.getByTestId('bulk-set-apply').click();
  await expect.poll(() => readMockFile(page, paths[0])).not.toContain('release-scout');
  expect(await wakes()).toHaveLength(3);
  await first.getByRole('checkbox').click();
  await page.getByTestId('bulk-set').click();
  await page.getByTestId('bulk-set-field-agent').click();
  await page.getByRole('button', { name: 'Edit Agent', exact: true }).click();
  await page.getByTestId('relation-result-row').filter({ hasText: 'Release scout' }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('bulk-set-apply').click();
  await expect.poll(async () => (await wakes()).length).toBe(4);
  await expect.poll(async () => (await wakes())[3].outcome, { timeout: 15_000 }).toBe('succeeded');
});
