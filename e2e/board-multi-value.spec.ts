import { expect, test } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';

test('moving one decider membership keeps the other decider and both rendered cards', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    const seed = () => {
      const fs = window.__cerebroMockFs;
      const path = 'types/decision.md';
      const source = fs?.get(path);
      if (source === undefined) {
        setTimeout(seed, 10);
        return;
      }
      fs.set(
        path,
        source.replace(
          'type: Type\n',
          'type: Type\nviews:\n  - id: by-decider\n    name: By decider\n    presentation:\n      type: board\n      group: [{ field: deciders }]\n      columns: [{ field: status }]\n',
        ),
      );
    };
    seed();
  });
  await boot(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Decision' }).first().click();
  await expect(page.getByTestId('view-tab-by-decider')).toHaveAttribute('aria-selected', 'true');
  const source = page
    .getByTestId('board-column')
    .filter({ has: page.getByText('Marcus Webb', { exact: true }) });
  const target = page
    .getByTestId('board-column')
    .filter({ has: page.getByText('Sam Ito', { exact: true }) });
  const other = page
    .getByTestId('board-column')
    .filter({ has: page.getByText('Elena Vasquez', { exact: true }) });
  const path = 'records/decisions/dec-no-custom-scanner-hardware.md';
  const card = source.locator(`[data-testid="board-card"][data-path="${path}"]`);
  await expect(card).toBeVisible();
  await expect(other.locator(`[data-testid="board-card"][data-path="${path}"]`)).toBeVisible();
  const start = await card.boundingBox();
  const end = await target.boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 20);
  await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2 + 8, start!.y + 20, { steps: 2 });
  await page.mouse.move(end!.x + end!.width / 2, end!.y + 70, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const content = await readMockFile(page, path);
      const yaml = /^---\n([\s\S]*?)\n---\n/.exec(content)![1];
      return (YAML.parse(yaml) as { deciders: string[] }).deciders;
    })
    .toEqual(['[[sam-ito]]', '[[elena-vasquez]]']);
  await expect(target.locator(`[data-testid="board-card"][data-path="${path}"]`)).toBeVisible();
  await expect(other.locator(`[data-testid="board-card"][data-path="${path}"]`)).toBeVisible();
  await expect(source.locator(`[data-testid="board-card"][data-path="${path}"]`)).toHaveCount(0);
  await expect(page.getByTestId('toast-host')).toContainText('Moved from Marcus Webb to Sam Ito');
});
