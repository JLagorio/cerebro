import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

const TYPE = 'types/work-item.md';
const PAGE = 'delivery/how-we-schedule.md';
const filters = {
  all: [
    { field: 'due', op: 'before', value: 'today' },
    { field: 'status', op: 'none_of', value: ['done', 'cancelled'] },
  ],
};
const board = {
  database: 'Work item',
  view: {
    name: 'Overdue',
    filters,
    presentation: {
      type: 'board',
      group: [{ field: 'status' }],
      sort: [{ field: 'due', dir: 'asc' }],
    },
  },
};
async function suggest(page: Page, args: unknown) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(`suggest view ${JSON.stringify(args)}`);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('action-card')).toHaveAttribute('data-status', /done|failed/, {
    timeout: 10000,
  });
  return page.getByTestId('view-suggestion-card');
}
async function undo(page: Page) {
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
});

test('the live board is inert, Add saves a tab, Open selects it, and Undo restores bytes', async ({
  page,
}) => {
  const before = await readMockFile(page, TYPE);
  const card = await suggest(page, board);
  await expect(card).toContainText('Live preview · 7 of 45 records');
  const preview = card.getByTestId('view-suggestion-preview');
  await expect(preview.getByText('Blank-state coaching copy')).toHaveCount(1);
  expect((await preview.boundingBox())!.height).toBe(260);
  expect(await preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await preview.hover();
  await page.mouse.wheel(650, 0);
  await expect.poll(() => preview.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  const box = (await preview.boundingBox())!;
  await page.mouse.click(box.x + 50, box.y + 60);
  await expect(page.getByTestId('detail-panel')).toHaveCount(0);
  expect(await readMockFile(page, TYPE)).toBe(before);
  await card.getByRole('button', { name: 'Add as a tab' }).click();
  await expect(card).toContainText('Added as “Overdue”');
  expect(await readMockFile(page, TYPE)).toContain('id: overdue');
  await card.getByRole('button', { name: 'Open Work item' }).click();
  await expect(page.getByTestId('view-tab-overdue')).toHaveAttribute('aria-selected', 'true');
  await undo(page);
  await expect.poll(() => readMockFile(page, TYPE)).toBe(before);
  await expect(card.getByRole('button', { name: 'Add as a tab' })).toBeEnabled();
  await page.screenshot({ path: '/private/tmp/cerebro-view-suggestion.png', fullPage: true });
});

test('a number chart counts the same seven matching rows', async ({ page }) => {
  const card = await suggest(page, {
    database: 'Work item',
    view: {
      name: 'Overdue count',
      filters,
      presentation: { type: 'chart', chart: { kind: 'number', agg: 'count' } },
    },
  });
  await expect(card.getByTestId('chart-number')).toContainText('7');
});

test('an unknown field remains a failed step with its closest name', async ({ page }) => {
  const before = await readMockFile(page, TYPE);
  await suggest(page, {
    ...board,
    view: { ...board.view, presentation: { type: 'board', group: [{ field: 'assigne' }] } },
  });
  await expect(page.getByTestId('view-suggestion-card')).toHaveCount(0);
  await expect(page.getByTestId('action-card')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('ai-panel')).toContainText('assignee');
  expect(await readMockFile(page, TYPE)).toBe(before);
});

test('Place appends a live database block and one Undo restores both files', async ({ page }) => {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
  const beforeType = await readMockFile(page, TYPE),
    beforePage = await readMockFile(page, PAGE);
  const card = await suggest(page, board);
  await card.getByRole('button', { name: 'Add and place on “How we schedule”' }).click();
  await expect(card).toContainText('Added as “Overdue”');
  await expect
    .poll(() => readMockFile(page, PAGE))
    .toContain('```cerebro-database\ndatabase: Work item\nview: overdue\n```');
  await expect(page.getByTestId('markdown-editor').getByTestId('database-block')).toBeVisible();
  await undo(page);
  await expect.poll(() => readMockFile(page, TYPE)).toBe(beforeType);
  await expect.poll(() => readMockFile(page, PAGE)).toBe(beforePage);
  await expect(page.getByTestId('markdown-editor').getByTestId('database-block')).toHaveCount(0);
});
