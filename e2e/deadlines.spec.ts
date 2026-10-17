import { expect, test } from '@playwright/test';
import { boot, readMockFile, showDatabases, openDestination } from './boot';

test('declared deadlines place open work before databases and the switch removes that capability', async ({
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
  await openDestination(page, 'My work');
  const overdue = page.locator('[data-testid="mywork-section"][data-bucket="overdue"]');
  await expect(overdue.getByTestId('mywork-row')).toHaveCount(7);
  const coaching = overdue
    .getByTestId('mywork-row')
    .filter({ hasText: 'Blank-state coaching copy' });
  await expect(coaching.getByTestId('mywork-deadline')).toHaveText('Jul 24');
  await expect(coaching.getByTestId('mywork-deadline')).toHaveClass(/text-danger-600/);
  const tomorrow = page.locator('[data-testid="mywork-section"][data-bucket="tomorrow"]');
  await expect(tomorrow).toContainText('Conflict resolution UX spec');
  await expect(page.locator('[data-testid="mywork-section"][data-bucket="today"]')).toHaveCount(0);
  const first = await overdue.boundingBox();
  const next = await tomorrow.boundingBox();
  expect(first).not.toBeNull();
  expect(next).not.toBeNull();
  expect(first!.y + first!.height).toBeLessThan(next!.y);
  await coaching.click();
  await expect(page.getByTestId('detail-title')).toHaveValue('Blank-state coaching copy');
  await page.keyboard.press('Escape');

  await showDatabases(page);

  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(
    page.locator('[data-testid="board-column"][data-group-key="rel:overdue"]'),
  ).toContainText('Blank-state coaching copy');
  await expect(
    page.locator('[data-testid="board-column"][data-group-key="rel:earlier"]'),
  ).toContainText('Rack layout sign-off');
  await page.getByTestId('view-tab-all').click();
  await page.getByRole('button', { name: 'Due column menu' }).click();
  await page.getByRole('menuitem', { name: 'Edit property', exact: true }).click();
  const toggle = page.getByTestId('property-deadline').getByRole('switch', { name: 'Deadline' });
  await expect(toggle).toBeChecked();
  await page.getByTestId('property-deadline').getByText('Deadline', { exact: true }).click();
  await expect.poll(() => readMockFile(page, 'types/work-item.md')).not.toMatch(/\ndeadline:/);
  await page.keyboard.press('Escape');
  await openDestination(page, 'My work');
  await expect(page.locator('[data-testid="mywork-section"][data-bucket="overdue"]')).toHaveCount(
    0,
  );
  await expect(
    page.locator('[data-testid="mywork-section"][data-bucket="Work item"]'),
  ).toContainText('Blank-state coaching copy');
});
