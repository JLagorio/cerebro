import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, showDatabases } from './boot';

/**
 * A field rename follows every stored reference (M60.2), on the mock
 * backend. Renaming Assignee from the Work item table's column menu rewrites
 * the Type doc's `fields:`, all four of its saved views and its layout, and
 * every Work item record, as one batch with one id; no frontmatter key, view
 * or layout name, or relation key says `assignee` afterwards (prose may).
 * The toast's Undo puts all 46 files back byte for byte.
 */

const TYPE_DOC = 'types/work-item.md';

/** Each row the mock logged, with the batch it belongs to. */
interface LoggedWrite {
  kind: string;
  path: string;
  batchId?: string;
}

const logged = (page: Page): Promise<LoggedWrite[]> =>
  page.evaluate(() =>
    (window as unknown as { __cerebroMockWrites: LoggedWrite[] }).__cerebroMockWrites.map((w) => ({
      kind: w.kind,
      path: w.path,
      batchId: w.batchId,
    })),
  );

const disk = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => Object.fromEntries(window.__cerebroMockFs.entries()));

const frontmatterOf = (text: string): Record<string, unknown> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return (block === null ? {} : YAML.parse(block[1])) as Record<string, unknown>;
};

/** The keys whose string values are field names in a view, a layout or a
 * field spec. A filter's `value` is a value, so it is not one of them. */
const NAME_KEYS = new Set([
  'field',
  'fields',
  'heading',
  'relation',
  'property',
  'xField',
  'groupBy',
  'cover',
  'dateField',
  'dependencyField',
  'group',
]);

/** Where `node` names `name`: as a key anywhere, or as a name-holding value. */
function namings(node: unknown, name: string, at: string[] = []): string[] {
  if (typeof node === 'string') {
    return node === name && NAME_KEYS.has(at[at.length - 1] ?? '') ? [at.join('.')] : [];
  }
  if (Array.isArray(node)) {
    // An item keeps its list's key, so a name in `fields: [...]` still counts.
    return node.flatMap((item) => namings(item, name, at));
  }
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) => [
      ...(key === name ? [[...at, key].join('.')] : []),
      ...namings(value, name, [...at, key]),
    ]);
  }
  return [];
}

async function openType(page: Page, name: string): Promise<void> {
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();
}

const toasts = (page: Page) => page.getByTestId('toast-host');

test('renaming Assignee rewrites every stored reference in one batch, and one Undo puts every file back', async ({
  page,
}) => {
  await boot(page);
  const before = await disk(page);
  const items = Object.entries(before)
    .filter(([path]) => path.endsWith('.md') && !path.startsWith('.trash/'))
    .filter(([, text]) => frontmatterOf(text).type === 'Work item')
    .map(([path]) => path)
    .sort();
  expect(items).toHaveLength(45);
  const touched = [TYPE_DOC, ...items].sort();
  await openType(page, 'Work item');
  const writesBefore = (await logged(page)).length;

  // -- Assignee column menu → rename to "Assigned to" -----------------------
  await page.getByRole('button', { name: 'Assignee column menu' }).click();
  const rename = page.getByLabel('Rename Assignee');
  await rename.fill('Assigned to');
  await rename.press('Enter');
  await expect(
    toasts(page).getByText('Renamed “Assignee” to “Assigned to” on 46 pages'),
  ).toBeVisible();
  // The open view shows the new name at once.
  await expect(page.getByRole('button', { name: 'Assigned to column menu' })).toBeVisible();

  // -- Every record moved its value -----------------------------------------
  const after = await disk(page);
  for (const path of items) {
    const was = frontmatterOf(before[path]);
    const now = frontmatterOf(after[path]);
    expect(now, path).not.toHaveProperty('assignee');
    expect(now.assigned_to, path).toEqual(was.assignee);
  }

  // -- The Type doc: fields, all four views, the layout ---------------------
  const doc = frontmatterOf(after[TYPE_DOC]);
  expect(Object.keys(doc.fields as object)).toContain('assigned_to');
  const views = doc.views as { id: string; presentation: Record<string, unknown> }[];
  expect(views.map((v) => v.id)).toEqual([
    'all',
    'at-risk-work',
    'this-month',
    'delivery-schedule',
  ]);
  for (const view of views) {
    const columns = view.presentation.columns as { field: string }[];
    expect(
      columns.map((c) => c.field),
      view.id,
    ).toContain('assigned_to');
  }
  const atRisk = views[1].presentation.group as { field: string }[];
  expect(atRisk.map((g) => g.field)).toEqual(['status', 'assigned_to']);
  const layout = doc.layout as { groups: { id: string; fields: string[] }[] };
  expect(layout.groups[0].fields).toEqual(['assigned_to', 'due', 'estimate']);

  // -- No file keeps an assignee key or name --------------------------------
  for (const [path, text] of Object.entries(after)) {
    if (!path.endsWith('.md') || path.startsWith('.trash/')) continue;
    expect(namings(frontmatterOf(text), 'assignee'), path).toEqual([]);
  }

  // -- One change: every touched file under one batch id, nothing after it --
  const rows = (await logged(page)).slice(writesBefore);
  expect(rows.map((r) => r.path).sort()).toEqual(touched);
  expect(rows.every((r) => r.kind === 'vault.write')).toBe(true);
  const ids = new Set(rows.map((r) => r.batchId));
  expect(ids.size).toBe(1);
  expect([...ids][0]).toMatch(/^[0-9a-f]{32}$/);

  // -- The toast's Undo: all 46 files are the snapshot again -----------------
  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => {
      const now = await disk(page);
      return touched.filter((path) => now[path] !== before[path]);
    })
    .toEqual([]);
  await expect(page.getByRole('button', { name: 'Assignee column menu' })).toBeVisible();
});
