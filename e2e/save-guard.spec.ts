import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

test('a stale Home tick refreshes and the next click checks the relocated task', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true }).click();
  await page
    .locator('[data-lane="mywork"]')
    .getByRole('button', { name: /Show all/ })
    .click();
  const path = 'projects/phoenix-warehouse-rollout/meetings/kickoff.md';
  const row = page
    .getByTestId('home-task')
    .filter({ has: page.locator(`button[title="${path}"]`) })
    .filter({ hasText: 'Confirm scope' });
  const checkbox = row.getByRole('checkbox', { name: 'Mark "Confirm scope" done' });
  await expect(checkbox).toBeVisible();
  await page.evaluate((path) => {
    const content = window.__cerebroMockFs.get(path)!;
    window.__cerebroMockFs.set(
      path,
      content.replace('- [ ] Confirm scope', 'An outside edit.\n- [ ] Confirm scope'),
    );
  }, path);
  await checkbox.click();
  await expect(page.getByRole('status').filter({ hasText: "the tick wasn't saved" })).toBeVisible();
  let content = await readMockFile(page, path);
  expect(content).toContain('An outside edit.');
  expect(content).not.toContain('- [x] Confirm scope');
  await expect(checkbox).toBeVisible();
  await checkbox.click();
  await expect.poll(() => readMockFile(page, path)).toContain('- [x] Confirm scope');
  content = await readMockFile(page, path);
  expect(content).toContain('An outside edit.\n- [x] Confirm scope');
});

test('Library keeps an outside edit and offers to load its new version', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  await page.getByTestId('library-card').filter({ hasText: 'Weekly review' }).click();
  const instructions = page.getByLabel('Instructions', { exact: true });
  await expect(instructions).toBeVisible();
  await instructions.fill('# Weekly review\n\nMy unsaved draft.');
  const path = 'records/skills/weekly-review.md';
  await page.evaluate((path) => {
    window.__cerebroMockFs.set(path, `${window.__cerebroMockFs.get(path)!}\nAn outside edit.\n`);
  }, path);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const stale = page.getByTestId('library-stale');
  await expect(stale).toContainText(
    '“Weekly review” changed on disk since you opened it, so nothing was saved.',
  );
  expect(await readMockFile(page, path)).toContain('An outside edit.');
  expect(await readMockFile(page, path)).not.toContain('My unsaved draft.');
  await expect(instructions).toHaveValue('# Weekly review\n\nMy unsaved draft.');
  await page.screenshot({ path: '/private/tmp/cerebro-library-stale.png', animations: 'disabled' });
  await stale.getByRole('button', { name: 'Load the new version' }).click();
  await expect(instructions).toHaveValue(/An outside edit\./);
  await expect(stale).toHaveCount(0);
});
