import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile, showDatabases, showPages } from './boot';

/** M60.2b: a broken saved view explains its references on its full page and
 * in every embed; a field rename leaves every saved view usable. */
const TYPE_DOC = 'types/work-item.md';

async function openWork(page: Page) {
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('type-page')).toBeVisible();
}

async function openTab(page: Page, id: string) {
  const tab = page.getByTestId(`view-tab-${id}`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function openDelivery(page: Page) {
  await showPages(page);
  const row = page.getByTestId('collection-node-collection').filter({ hasText: 'Delivery' });
  await row.getByRole('button', { name: 'Delivery', exact: true }).click();
  await expect(page.getByTestId('database-block')).toHaveCount(3);
}

test('renamed fields stay valid; hand-edited broken filters are named and marked everywhere', async ({
  page,
}) => {
  await boot(page);
  await openWork(page);
  await page.getByRole('button', { name: 'Assignee column menu' }).click();
  const rename = page.getByLabel('Rename Assignee');
  await rename.fill('Assigned to');
  await rename.press('Enter');
  await expect(page.getByRole('button', { name: 'Assigned to column menu' })).toBeVisible();

  for (const id of ['all', 'at-risk-work', 'this-month', 'delivery-schedule']) {
    await openTab(page, id);
    await expect(page.getByTestId('view-problems')).toHaveCount(0);
  }
  await openDelivery(page);
  await expect(page.getByTestId('view-problems')).toHaveCount(0);

  // Simulate editing YAML outside Cerebro. A record create supplies a real
  // write-and-rescan without writing the Type doc from stale view props.
  await openWork(page);
  await openTab(page, 'all');
  const raw = await readMockFile(page, TYPE_DOC);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  expect(match).not.toBeNull();
  const doc = YAML.parse(match![1]) as {
    views: { id: string; filters: unknown }[];
  };
  doc.views.find((view) => view.id === 'at-risk-work')!.filters = {
    all: [
      { field: 'ghost_field', op: 'equals', value: 'yes' },
      { field: 'status', op: 'equals', value: 'wip' },
    ],
  };
  const edited = `---\n${YAML.stringify(doc)}---\n${raw.slice(match![0].length)}`;
  await page.evaluate(([path, text]) => window.__cerebroMockFs.set(path, text), [TYPE_DOC, edited]);
  await page.getByTestId('quick-add').first().click();
  const title = page.getByPlaceholder('Title — Enter to create');
  await title.fill('View check refresh');
  await title.press('Enter');
  await expect(
    page.getByTestId('table-row').filter({ hasText: 'View check refresh' }),
  ).toBeVisible();

  await openTab(page, 'at-risk-work');
  const problems = page.getByTestId('view-problems');
  await expect(problems).toContainText(
    '“ghost_field” in the filter: Work item has no property by that name.',
  );
  await expect(problems).toContainText('“wip” is not an option of Status.');
  await page.getByTestId('view-control-filter').click();
  await expect(page.getByTestId('filter-chip-0').locator('..')).toHaveAttribute(
    'data-problem',
    'unknown_field',
  );
  await expect(page.getByTestId('filter-chip-1').locator('..')).toHaveAttribute(
    'data-problem',
    'unknown_option',
  );
  const strip = await problems.boundingBox();
  const canvas = await page.getByTestId('table-view').boundingBox();
  expect(strip).not.toBeNull();
  expect(canvas).not.toBeNull();
  expect(strip!.height).toBeGreaterThan(0);
  expect(strip!.y + strip!.height).toBeLessThanOrEqual(canvas!.y + 1);

  await openDelivery(page);
  const embed = page.getByTestId('database-block').first();
  await expect(embed.getByTestId('view-problems')).toContainText(
    '“wip” is not an option of Status.',
  );
  await expect(embed.getByTestId('view-problems')).toContainText('“ghost_field” in the filter');
  await expect(page.getByTestId('view-problems')).toHaveCount(1);
});
