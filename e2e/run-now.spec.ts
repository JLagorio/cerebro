import { expect, test, type Page } from '@playwright/test';
import { boot, openDestination } from './boot';

const log = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('cerebro.runLog') ?? '[]') as {
        source: string;
        trigger: string;
        status: string;
      }[],
  );
async function openScout(page: Page) {
  await openDestination(page, 'Agents');
  await page
    .getByTestId('sidebar')
    .getByRole('button', { name: 'Release scout', exact: true })
    .click();
  await expect(page.getByTestId('doc-title')).toHaveText('Release scout');
}
test('Run now works with Learn off, and both pause doors refuse it without another row', async ({
  page,
}, testInfo) => {
  await boot(page, { autoLearn: false });
  await openScout(page);
  await page.getByTestId('agent-run-now').click();
  await expect
    .poll(() => log(page))
    .toEqual([
      expect.objectContaining({
        source: 'records/agents/release-scout.md',
        trigger: 'manual',
        status: 'ok',
      }),
    ]);
  await expect(page.getByTestId('agent-run-now')).toHaveText('Run now');
  await page.getByTestId('agent-duty-toggle').click();
  await expect(page.getByTestId('agent-duty-toggle')).toHaveText('Resume');
  await page.getByTestId('agent-run-now').click();
  await expect(
    page.getByText('Release scout is paused. Resume it to run it now.', { exact: true }),
  ).toBeVisible();
  expect(await log(page)).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('run-now-paused.png'), fullPage: true });
  await page.getByTestId('agent-duty-toggle').click();
  await expect(page.getByTestId('agent-duty-toggle')).toHaveText('Pause');
  await openDestination(page, 'Agents');
  const row = page.getByTestId('agent-row').filter({ hasText: 'Release scout' });
  await row.locator('..').getByTestId('agent-pause').click();
  await expect(page.getByText('Release scout paused', { exact: true })).toBeVisible();
  await openScout(page);
  await page.getByTestId('agent-run-now').click();
  await expect(
    page.getByText('Release scout is paused on the fleet. Resume it there to run it now.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await log(page)).toHaveLength(1);
});
