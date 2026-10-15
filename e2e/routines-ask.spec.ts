import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedBeforeBoot } from './boot';

const SCOUT = 'records/agents/release-scout.md';
const RISK = 'records/risks/risk-scanner-delivery.md';
const QUESTION = 'Does this threaten the release?';

test('a no checks once, skips with its question and reason, and starts no full run', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedBeforeBoot(page, '__cerebroSeedCondition', 'no');
  await seedBeforeBoot(page, '__cerebroSeedFleet', []);
  await boot(page, { autoLearn: true });
  await page.getByTestId('nav-agent').filter({ hasText: 'Release scout' }).click();
  await page.getByTestId('agent-add-trigger').click();
  const editor = page.getByTestId('agent-editor-trigger-new');
  await editor.getByLabel('Trigger 1 event').selectOption('changed');
  await editor.getByLabel('Trigger 1 field').selectOption('status');
  await editor.getByLabel('Trigger 1 question').fill(QUESTION);
  await expect(editor.getByLabel('Trigger 1 question')).toHaveAttribute('maxlength', '500');
  expect(await readMockFile(page, SCOUT)).not.toContain(QUESTION);
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => readMockFile(page, SCOUT)).toContain(QUESTION);

  await page.getByTestId('sidebar-type').filter({ hasText: /^Risk/ }).first().click();
  const risk = page.locator(`[data-testid="table-row"][data-path="${RISK}"]`);
  await risk.getByRole('button', { name: 'Mitigating', exact: true }).click();
  await page.getByRole('option', { name: 'Open', exact: true }).click();
  await expect.poll(() => readMockFile(page, RISK)).toContain('status: open');
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockWakes().map((wake) => wake.reason)), {
      timeout: 30_000,
    })
    .toEqual(['condition_not_met']);

  await page
    .getByTestId('sidebar')
    .getByRole('button', { name: 'Open all agents', exact: true })
    .click();
  await expect(page.getByTestId('agent-wake-words')).toHaveText('skipped — its check answered no');
  await expect(page.getByTestId('agent-wake-check')).toHaveText(
    `“${QUESTION}” — The check answered no.`,
  );
  await expect(page.getByTestId('fleet-row')).toHaveCount(1);
  await expect(page.getByTestId('fleet-row')).toContainText('Release scout');
  await expect(page.getByTestId('run-why')).toContainText(`checking first: ${QUESTION}`);
  await page.getByTestId('agent-wake-check').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('pre-run-no.png'), fullPage: true });
});
