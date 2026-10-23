import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile, showDatabases } from './boot';
import { chooseOption } from './select';

async function drag(page: Page, card: Locator, target: Locator) {
  const start = await card.boundingBox();
  const end = await target.boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 18);
  await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2 + 8, start!.y + 18, { steps: 2 });
  await page.mouse.move(end!.x + end!.width / 2, end!.y + 65, { steps: 12 });
  await page.mouse.up();
}

test('date bands create on days, preserve date moves, and refuse ambiguous periods', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2400, height: 1080 });
  await page.addInitScript(() => {
    const seed = () => {
      const fs = window.__cerebroMockFs;
      const source = fs?.get('types/work-item.md');
      if (source === undefined) {
        setTimeout(seed, 10);
        return;
      }
      fs.set(
        'types/work-item.md',
        source.replace(
          'views:\n',
          'views:\n  - id: by-due\n    name: By due\n    presentation:\n      type: board\n      group: [{ field: due }]\n      columns: [{ field: key }]\n',
        ),
      );
    };
    seed();
  });
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('view-tab-by-due')).toHaveAttribute('aria-selected', 'true');
  const column = (label: string) =>
    page.getByTestId('board-column').filter({ has: page.getByText(label, { exact: true }) });
  const today = column('Today');
  const tomorrow = column('Tomorrow');
  const thisWeek = column('This week');
  const nextWeek = column('Next week');
  await expect(today.getByTestId('board-card')).toHaveCount(0);
  await expect(tomorrow).toContainText('SYN-1');
  for (const key of ['OPS-4', 'LNC-2', 'OPS-3']) await expect(thisWeek).toContainText(key);
  await expect(today.getByRole('button', { name: 'New record in Today' })).toBeVisible();
  await expect(tomorrow.getByRole('button', { name: 'New record in Tomorrow' })).toBeVisible();
  await expect(thisWeek.getByTestId('quick-add')).toHaveCount(0);
  await expect(nextWeek.getByTestId('quick-add')).toHaveCount(0);
  const syn = 'projects/offline-sync-hardening/items/syn-1.md';
  await drag(page, tomorrow.locator(`[data-testid="board-card"][data-path="${syn}"]`), today);
  await expect.poll(() => readMockFile(page, syn)).toContain('due: 2026-07-28');
  await expect(today.locator(`[data-testid="board-card"][data-path="${syn}"]`)).toBeVisible();
  const ops = 'projects/phoenix-warehouse-rollout/items/ops-3.md';
  const before = await readMockFile(page, ops);
  await drag(page, thisWeek.locator(`[data-testid="board-card"][data-path="${ops}"]`), nextWeek);
  await expect(page.getByTestId('toast-host')).toContainText("this band doesn't name one date");
  expect(await readMockFile(page, ops)).toBe(before);
  // dnd-kit briefly suppresses the click immediately after a pointer drop.
  await expect(async () => {
    await page.getByTestId('view-control-settings').click();
    await expect(page.getByTestId('view-settings-panel')).toBeVisible();
  }).toPass();
  await page.getByTestId('view-settings-group').click();
  await chooseOption(page.getByTestId('group-date-bucket-0'), { value: 'month' });
  await expect.poll(() => readMockFile(page, 'types/work-item.md')).toContain('dateBucket: month');
  await expect(column('July 2026')).toBeVisible();
});
