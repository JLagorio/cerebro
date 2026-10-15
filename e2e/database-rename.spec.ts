import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot } from './boot';

const disk = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => Object.fromEntries(window.__cerebroMockFs.entries()));

const frontmatter = (content: string): Record<string, unknown> => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  return match === null ? {} : (YAML.parse(match[1]) as Record<string, unknown>);
};

const typeRow = (page: Page, name: string) =>
  page.getByTestId('sidebar-type').filter({ hasText: name }).first();

test('database rename keeps records, relations, tabs and embeds connected; one Undo restores all 50 files', async ({
  page,
}) => {
  await boot(page);
  await typeRow(page, 'Work item').click();
  await expect(page.getByTestId('type-page')).toBeVisible();
  const before = await disk(page);
  const records = Object.entries(before).filter(
    ([path, content]) => path.endsWith('.md') && frontmatter(content).type === 'Work item',
  );
  expect(records).toHaveLength(45);

  await page.getByTestId('type-title-edit').click();
  const dialog = page.getByRole('dialog', { name: 'Change display name' });
  await dialog.getByLabel('Display name').fill('Task');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('type-title-edit')).toHaveText('Task');
  await expect(typeRow(page, 'Task')).toBeVisible();
  await expect(typeRow(page, 'Work item')).toHaveCount(0);
  const after = await disk(page);
  const changed = Object.keys(after).filter((path) => after[path] !== before[path]);
  expect(changed).toHaveLength(50);
  for (const [path] of records) expect(frontmatter(after[path]).type, path).toBe('Task');

  const own = frontmatter(after['types/work-item.md']);
  expect(after['types/work-item.md']).toContain('\n# Task\n');
  expect(own.fields).toMatchObject({ blocked_by: { target: 'Task' } });
  expect(frontmatter(after['types/key-result.md']).fields).toMatchObject({
    deliverables: { target: 'Task' },
  });
  const epic = frontmatter(after['types/epic.md']);
  expect(epic.fields).toMatchObject({ progress: { from: { type: 'Task', field: 'epic' } } });
  expect(epic.tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'work-items', source: { type: 'Task' }, scope: 'related' }),
    ]),
  );
  expect(frontmatter(after['types/project.md']).tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'tasks', source: { type: 'Task' }, scope: 'related' }),
    ]),
  );
  expect(after['delivery/delivery.md']).toBe(
    before['delivery/delivery.md'].replaceAll('database: Work item', 'database: Task'),
  );

  const delivery = page.getByTestId('collection-node-collection').filter({ hasText: 'Delivery' });
  await delivery.getByRole('button', { name: 'Delivery', exact: true }).click();
  await expect(page.getByTestId('database-block')).toHaveCount(3);
  await expect(page.getByTestId('database-block-missing')).toHaveCount(0);
  for (const block of await page.getByTestId('database-block').all()) {
    await expect(block.getByTestId('view-problems')).toHaveCount(0);
  }

  await typeRow(page, 'Epic').click();
  const row = page.getByTestId('table-row').filter({ hasText: 'Phoenix warehouse cutover' });
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Open in full page' }).click();
  await page.getByTestId('record-tab-work-items').click();
  await expect(page.getByTestId('view-tab-broken')).toHaveCount(0);
  const related = page.getByTestId('view-tab-embed');
  await expect(related.getByTestId('table-row')).toHaveCount(4);
  await expect(related.getByText('Rehearse the rollback in staging')).toBeVisible();

  await typeRow(page, 'Task').click();
  await page.getByTestId('table-view').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => disk(page)).toEqual(before);
  await expect(typeRow(page, 'Work item')).toBeVisible();
  await expect(typeRow(page, 'Task')).toHaveCount(0);
});
