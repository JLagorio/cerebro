import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile, showDatabases } from './boot';

/**
 * A database-wide change is one batch (M60.6), on the mock backend. Renaming
 * a property rewrites the Type doc and every record holding it under one
 * batch id; deleting two checked rows moves both under `.trash/`, byte for
 * byte, with one toast. The crash half — a batch stopped partway is put back
 * on the next start — is cargo's (src-tauri/src/vault/batch.rs) and the
 * packaged check's.
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

/** A page's frontmatter, parsed. */
const frontmatterOf = (text: string): Record<string, unknown> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return (block === null ? {} : YAML.parse(block[1])) as Record<string, unknown>;
};

async function openType(page: Page, name: string): Promise<void> {
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();
}

test('renaming a property rewrites the Type doc and every record under one batch', async ({
  page,
}) => {
  await boot(page);
  const before = await disk(page);
  const holders = Object.entries(before)
    .filter(([path]) => path.endsWith('.md') && path !== TYPE_DOC)
    .filter(([, text]) => frontmatterOf(text).type === 'Work item')
    .filter(([, text]) => 'estimate' in frontmatterOf(text))
    .map(([path]) => path);
  expect(holders.length).toBeGreaterThan(10);
  await openType(page, 'Work item');
  const writesBefore = (await logged(page)).length;

  // -- Estimate column menu → rename to "Size points" ------------------------
  await page.getByRole('button', { name: 'Estimate column menu' }).click();
  const rename = page.getByLabel('Rename Estimate');
  await rename.fill('Size points');
  await rename.press('Enter');

  await expect
    .poll(async () => Object.keys(frontmatterOf(await readMockFile(page, TYPE_DOC)).fields ?? {}))
    .toContain('size_points');
  const fields = frontmatterOf(await readMockFile(page, TYPE_DOC)).fields as Record<
    string,
    unknown
  >;
  expect(Object.keys(fields)).not.toContain('estimate');
  const after = await disk(page);
  for (const path of holders) {
    const was = frontmatterOf(before[path]);
    const now = frontmatterOf(after[path]);
    expect(now, path).not.toHaveProperty('estimate');
    expect(now.size_points, path).toEqual(was.estimate);
  }

  // -- One change: the Type doc and every record, under one batch id ---------
  // The views' columns are renamed inside the same batch (M60.2).
  const rows = (await logged(page)).slice(writesBefore).filter((r) => r.batchId !== undefined);
  expect(rows.map((r) => r.path).sort()).toEqual([TYPE_DOC, ...holders].sort());
  expect(rows.every((r) => r.kind === 'vault.write')).toBe(true);
  const ids = new Set(rows.map((r) => r.batchId));
  expect(ids.size).toBe(1);
  expect([...ids][0]).toMatch(/^[0-9a-f]{32}$/);
});

test('deleting two checked rows moves both to the Trash, byte for byte, with one toast', async ({
  page,
}) => {
  await boot(page);
  await openType(page, 'Work item');
  const rowsOnScreen = page.getByTestId('table-row');
  const titles = [];
  for (const row of [rowsOnScreen.nth(0), rowsOnScreen.nth(1)]) {
    const box = row.getByRole('checkbox', { name: /^Select / });
    titles.push(((await box.getAttribute('aria-label')) ?? '').replace(/^Select /, ''));
    await box.click();
  }
  const before = await disk(page);
  const writesBefore = (await logged(page)).length;

  await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByText('Moved 2 records to Trash')).toHaveCount(1);
  const rows = (await logged(page)).slice(writesBefore);
  const deleted = rows.filter((r) => r.kind === 'vault.delete').map((r) => r.path);
  expect(deleted).toHaveLength(2);
  expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
  const after = await disk(page);
  for (const path of deleted) {
    expect(after[path], path).toBeUndefined();
    const copies = Object.entries(after).filter(
      ([key, text]) =>
        key.startsWith('.trash/') && key.endsWith(`/${path}`) && text === before[path],
    );
    expect(copies, path).toHaveLength(1);
  }
  for (const title of titles) {
    await expect(page.getByTestId('table-row').filter({ hasText: title })).toHaveCount(0);
  }
});
