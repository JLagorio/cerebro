import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

const OLD = 'strategy/systems-map.md';
const NEXT = 'strategy/systems-atlas.md';
const DECISION = 'records/decisions/rename-proof.md';
const WORK = 'records/work-items/rename-proof.md';
const CONCEPT = 'knowledge/systems/offline-guarantee.md';
const DECISION_BYTES =
  "---\nrelated: '[[Systems map]]'\n---\n# Rename decision\n\nRead [[systems-map]] and [[systems-map|the map]].\n";
const WORK_BYTES = '# Rename work\n\nCheck [[systems-map#Rollback]].\n';
const CONCEPT_BYTES =
  '---\ntype: Reference\nabout: "[[systems-map]]"\nsources:\n  - resource: /strategy/systems-map.md\n---\n# Rename concept\n\nThe text keeps [[systems-map]].\n';

async function seedLinks(page: Page) {
  await page.evaluate(
    (files) => {
      for (const [path, content] of files) window.__cerebroMockFs.set(path, content);
    },
    [
      [DECISION, DECISION_BYTES],
      [WORK, WORK_BYTES],
      [CONCEPT, CONCEPT_BYTES],
    ],
  );
}

async function beginRename(page: Page) {
  const tree = page.getByTestId('file-tree');
  const folder = tree.getByTestId('tree-folder').filter({ hasText: 'Strategy' });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  const row = tree.locator(`[data-testid="tree-row"][data-path="${OLD}"]`);
  await row.getByTestId('tree-file').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByPlaceholder('Page name').fill('Systems atlas');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
}

const has = (page: Page, path: string) => page.evaluate((p) => window.__cerebroMockFs.has(p), path);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
});

test('a Pages rename updates links and Undo restores their exact bytes', async ({
  page,
}, testInfo) => {
  await seedLinks(page);
  const originalPage = await readMockFile(page, OLD);
  await beginRename(page);
  const prompt = page.getByTestId('rename-links-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Updates 4 links in 2 pages.');
  await expect(prompt).toContainText('Points 1 knowledge concept at the new name.');
  await expect(prompt).toContainText('Rename concept — 1 link in its text');
  await expect(prompt).toContainText(
    'Rename concept — its source still names /strategy/systems-map.md',
  );
  const dialog = page.getByRole('dialog', { name: 'Rename “Systems map” to “Systems atlas”?' });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: testInfo.outputPath('rename-prompt.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'Rename and update' }).click();
  await expect(prompt).toBeHidden();
  await expect.poll(() => has(page, NEXT)).toBe(true);
  expect(await has(page, OLD)).toBe(false);
  expect(await readMockFile(page, NEXT)).toContain('# Systems atlas');
  expect(await readMockFile(page, DECISION)).toBe(
    DECISION_BYTES.replace('Systems map', 'systems-atlas').replaceAll(
      'systems-map',
      'systems-atlas',
    ),
  );
  expect(await readMockFile(page, WORK)).toBe(WORK_BYTES.replace('systems-map', 'systems-atlas'));
  const concept = await readMockFile(page, CONCEPT);
  expect(concept).toContain('[[systems-atlas]]');
  expect(concept).toContain('The text keeps [[systems-map]].');
  expect(concept).toContain('/strategy/systems-map.md');
  const batches = await page.evaluate(
    ([decision, work, old]) => {
      const rows = window.__cerebroMockWrites as ((typeof window.__cerebroMockWrites)[number] & {
        batchId?: string;
      })[];
      return rows
        .filter((row) => [decision, work, old].includes(row.path))
        .map((row) => row.batchId ?? null);
    },
    [DECISION, WORK, OLD],
  );
  expect(batches.length).toBeGreaterThanOrEqual(3);
  expect(new Set(batches).size).toBe(1);
  expect(batches[0]).not.toBeNull();
  await page
    .getByTestId('file-tree')
    .locator(`[data-testid="tree-row"][data-path="${NEXT}"]`)
    .getByTestId('tree-file')
    .click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems atlas');
  const showPanel = page.getByRole('button', { name: 'Show panel', exact: true });
  if (await showPanel.isVisible()) await showPanel.click();
  await page.getByTestId('doc-panel-tab-links').click();
  await expect(page.getByTestId('doc-links')).toContainText('Rename decision');
  await expect(page.getByTestId('doc-links')).toContainText('Rename work');
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => has(page, OLD)).toBe(true);
  expect(await has(page, NEXT)).toBe(false);
  expect(await readMockFile(page, OLD)).toBe(originalPage);
  expect(await readMockFile(page, DECISION)).toBe(DECISION_BYTES);
  expect(await readMockFile(page, WORK)).toBe(WORK_BYTES);
  expect(await readMockFile(page, CONCEPT)).toContain('about: "[[systems-map]]"');
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await page.getByTestId('toast-host').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => has(page, NEXT)).toBe(true);
  expect(await has(page, OLD)).toBe(false);
  expect(await readMockFile(page, DECISION)).toContain('[[systems-atlas|the map]]');
  expect(await readMockFile(page, WORK)).toContain('[[systems-atlas#Rollback]]');
  await expect(page.getByTestId('doc-title')).toHaveText('Systems atlas');
});

test('Escape cancels the link prompt without changing any file', async ({ page }) => {
  await seedLinks(page);
  const before = await readMockFile(page, OLD);
  await beginRename(page);
  await expect(page.getByTestId('rename-links-prompt')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rename-links-prompt')).toBeHidden();
  expect(await readMockFile(page, OLD)).toBe(before);
  expect(await has(page, NEXT)).toBe(false);
  expect(await readMockFile(page, DECISION)).toBe(DECISION_BYTES);
  expect(await readMockFile(page, CONCEPT)).toBe(CONCEPT_BYTES);
  await expect(page.getByPlaceholder('Page name')).toBeVisible();
});

test('a citer changed during confirmation refuses the entire rename', async ({ page }) => {
  await seedLinks(page);
  const before = await readMockFile(page, OLD);
  await beginRename(page);
  await expect(page.getByTestId('rename-links-prompt')).toBeVisible();
  const newer = `${DECISION_BYTES}\nWritten elsewhere.\n`;
  await page.evaluate(
    ([path, content]) => window.__cerebroMockFs.set(path, content),
    [DECISION, newer],
  );
  await page.getByRole('button', { name: 'Rename and update' }).click();
  await expect(page.getByTestId('toast-host')).toContainText(
    'A page changed while renaming, so nothing was renamed. Try again.',
  );
  expect(await readMockFile(page, OLD)).toBe(before);
  expect(await has(page, NEXT)).toBe(false);
  expect(await readMockFile(page, DECISION)).toBe(newer);
  expect(await readMockFile(page, WORK)).toBe(WORK_BYTES);
  expect(await readMockFile(page, CONCEPT)).toBe(CONCEPT_BYTES);
});

test('an uncited page renames without the link prompt', async ({ page }) => {
  await beginRename(page);
  await expect.poll(() => has(page, NEXT)).toBe(true);
  expect(await has(page, OLD)).toBe(false);
  await expect(page.getByTestId('rename-links-prompt')).toHaveCount(0);
  expect(await readMockFile(page, NEXT)).toContain('# Systems atlas');
});

test('Move to folder keeps a cited stem without a rewrite prompt', async ({ page }) => {
  await page.evaluate(
    ([decision, decisionBytes, work, workBytes]) => {
      window.__cerebroMockFs.set(decision, decisionBytes);
      window.__cerebroMockFs.set(work, workBytes);
    },
    [DECISION, DECISION_BYTES, WORK, WORK_BYTES],
  );
  const tree = page.getByTestId('file-tree');
  await tree.getByTestId('tree-folder').filter({ hasText: 'Strategy' }).click();
  await tree
    .locator(`[data-testid="tree-row"][data-path="${OLD}"]`)
    .getByTestId('tree-file')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move "Systems map"' });
  await dialog.getByRole('button', { name: 'Inbox', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.poll(() => has(page, 'inbox/systems-map.md')).toBe(true);
  await expect(page.getByTestId('rename-links-prompt')).toHaveCount(0);
  expect(await has(page, OLD)).toBe(false);
  expect(await readMockFile(page, DECISION)).toBe(DECISION_BYTES);
  expect(await readMockFile(page, WORK)).toBe(WORK_BYTES);
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  const showPanel = page.getByRole('button', { name: 'Show panel', exact: true });
  if (await showPanel.isVisible()) await showPanel.click();
  await page.getByTestId('doc-panel-tab-links').click();
  await expect(page.getByTestId('doc-links')).toContainText('Rename decision');
  await expect(page.getByTestId('doc-links')).toContainText('Rename work');
});

test('a whiteboard citer is named and its bytes stay untouched after Rename anyway', async ({
  page,
}, info) => {
  const board = 'boards/rename-citer.canvas';
  const bytes = JSON.stringify({
    nodes: [{ id: 'page', type: 'file', x: 0, y: 0, width: 100, height: 100, file: OLD }],
    edges: [],
    unknown: { keep: 'exact' },
  });
  await page.evaluate(({ board, bytes }) => window.__cerebroMockFs.set(board, bytes), {
    board,
    bytes,
  });
  await beginRename(page);
  const prompt = page.getByTestId('rename-links-prompt');
  await expect(prompt).toContainText(`1 whiteboard keeps cards pointing at ${OLD}.`);
  await expect(prompt).toContainText(board);
  await page.screenshot({
    path: info.outputPath('rename-board-pointer.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Rename anyway', exact: true }).click();
  await expect.poll(() => has(page, NEXT)).toBe(true);
  expect(await readMockFile(page, board)).toBe(bytes);
});
