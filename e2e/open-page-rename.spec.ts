import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  holdClock,
  openDestination,
  readMockFile,
  seedFileBeforeBoot,
  showPageFolders,
} from './boot';

// The cold module graph can exceed the default budget on the shared dev machine.
test.setTimeout(60_000);

async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title);
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
}

async function renameOpenPage(page: Page, from: string, name: string, links = false) {
  await showPageFolders(page);
  const tree = page.getByTestId('file-tree');
  const folder = tree.getByTestId('tree-folder').filter({ hasText: 'Strategy' });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  await tree
    .locator(`[data-testid="tree-row"][data-path="${from}"]`)
    .getByTestId('tree-file')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByPlaceholder('Page name').fill(name);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  if (links) await page.getByRole('button', { name: 'Rename and update', exact: true }).click();
}

const exists = (page: Page, path: string) =>
  page.evaluate((value) => window.__cerebroMockFs.has(value), path);

test('an already-open source page retains its owner and exact bytes through rename Undo/Redo', async ({
  page,
}, info) => {
  const old = 'strategy/source-move.md';
  const next = 'strategy/source-shifted.md';
  const raw = '\ufeff---\r\ntags: [preserved]\r\n---\r\n# Source move\r\n\r\n<div>keep😀</div>\r\n';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedFileBeforeBoot(page, old, raw);
  await boot(page);
  await openPage(page, 'Source move');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Page source' });
  await expect(source).toBeVisible();
  await page.evaluate(async (path) => {
    const modulePath = '/src/editor/openPages.ts';
    const { retainedDocumentOwner } = await import(modulePath);
    const navPath = '/src/stores/navStore.ts';
    const vaultPath = '/src/stores/vaultStore.ts';
    const { useNavStore } = await import(navPath);
    const { useVaultStore } = await import(vaultPath);
    const owner = retainedDocumentOwner({
      vaultId: useVaultStore.getState().vaultPath,
      path,
      ownerId: useNavStore.getState().active,
    });
    if (!owner) throw new Error('The actual source editor has no retained owner.');
    (window as unknown as { renameOwner: unknown }).renameOwner = owner;
  }, old);
  await holdClock(page);
  await renameOpenPage(page, old, 'Source shifted');
  await expect.poll(() => exists(page, next)).toBe(true);
  expect(await exists(page, old)).toBe(false);
  await expect(source).toHaveValue('# Source shifted\n\n<div>keep😀</div>\n');
  expect(await readMockFile(page, next)).toBe(raw.replace('Source move', 'Source shifted'));

  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => exists(page, old)).toBe(true);
  expect(await readMockFile(page, old)).toBe(raw);
  await expect(source).toHaveValue('# Source move\n\n<div>keep😀</div>\n');
  await page.getByTestId('toast-host').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => exists(page, next)).toBe(true);
  await expect(source).toHaveValue('# Source shifted\n\n<div>keep😀</div>\n');
  expect(
    await page.evaluate(async (path) => {
      const modulePath = '/src/editor/openPages.ts';
      const { retainedDocumentOwner } = await import(modulePath);
      const navPath = '/src/stores/navStore.ts';
      const vaultPath = '/src/stores/vaultStore.ts';
      const { useNavStore } = await import(navPath);
      const { useVaultStore } = await import(vaultPath);
      return (
        retainedDocumentOwner({
          vaultId: useVaultStore.getState().vaultPath,
          path,
          ownerId: useNavStore.getState().active,
        }) === (window as unknown as { renameOwner: unknown }).renameOwner
      );
    }, next),
  ).toBe(true);
  await page.clock.resume();
  await source.fill('# Source shifted\n\n<div>newest😀</div>\n');
  await openDestination(page, 'Home');
  await expect
    .poll(() => readMockFile(page, next))
    .toBe(raw.replace('Source move', 'Source shifted').replace('keep', 'newest'));
  expect(await exists(page, old)).toBe(false);
  await openPage(page, 'Source shifted');
  await expect(source).toHaveValue('# Source shifted\n\n<div>newest😀</div>\n');
  await page.screenshot({
    path: info.outputPath('open-source-renamed.png'),
    animations: 'disabled',
  });
});

test('an already-open cited whiteboard keeps scene Undo after file rename Undo/Redo', async ({
  page,
}, info) => {
  const old = 'strategy/board-move.canvas';
  const next = 'strategy/board-shifted.canvas';
  const original = { nodes: [], edges: [], vendor: { preserved: true } };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedFileBeforeBoot(page, old, JSON.stringify(original));
  // File Undo is offered for link-updating renames; a plain uncited file move
  // retains its existing non-undoable contract. Exercise the real batch door.
  await seedFileBeforeBoot(
    page,
    'strategy/board-reference.md',
    '# Board reference\n\n[[board-move.canvas]]\n',
  );
  await boot(page);
  await openPage(page, 'Board move');
  const canvas = page.getByTestId('wb-input');
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await page.keyboard.press('r');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 140, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + 340, box.y + 260, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => JSON.parse((await readMockFile(page, old))!).nodes.length).toBe(1);
  const withShape = await readMockFile(page, old);
  await holdClock(page);
  await renameOpenPage(page, old, 'Board shifted', true);
  await expect.poll(() => exists(page, next)).toBe(true);
  expect(await exists(page, old)).toBe(false);
  expect(await readMockFile(page, next)).toBe(withShape);
  await expect(canvas).toBeVisible();
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => exists(page, old)).toBe(true);
  expect(await readMockFile(page, old)).toBe(withShape);
  await page.getByTestId('toast-host').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => exists(page, next)).toBe(true);
  await page.clock.resume();
  await page.getByRole('button', { name: 'Undo in whiteboard', exact: true }).click();
  await expect.poll(async () => JSON.parse((await readMockFile(page, next))!).nodes.length).toBe(0);
  expect(JSON.parse((await readMockFile(page, next))!).vendor).toEqual(original.vendor);
  expect(await exists(page, old)).toBe(false);
  await openDestination(page, 'Home');
  await openPage(page, 'Board shifted');
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId('wb-node')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('open-board-renamed.png'),
    animations: 'disabled',
  });
});
