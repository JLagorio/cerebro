import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';
const PATH = 'boards/cards.canvas';
const DOC = 'notes/board-card-doc.md';
const source = JSON.stringify({
  nodes: [
    {
      id: 'record',
      type: 'file',
      file: 'records/cards-task.md',
      x: 0,
      y: 0,
      width: 320,
      height: 120,
    },
    {
      id: 'doc',
      type: 'file',
      file: DOC,
      subpath: '#Rollback',
      x: 360,
      y: 0,
      width: 320,
      height: 120,
    },
    {
      id: 'missing',
      type: 'file',
      file: 'gone/nowhere.md',
      subpath: '#Keep exactly',
      x: 720,
      y: 0,
      width: 320,
      height: 120,
      vendor: { keep: true },
    },
    {
      id: 'diagram',
      type: 'file',
      file: 'diagrams/cards-flow.mmd',
      x: 0,
      y: 170,
      width: 320,
      height: 240,
    },
    {
      id: 'image',
      type: 'file',
      file: 'attachments/cards-poster.png',
      x: 360,
      y: 170,
      width: 320,
      height: 240,
    },
    {
      id: 'link',
      type: 'link',
      url: 'https://example.com/whiteboard',
      x: 720,
      y: 170,
      width: 320,
      height: 120,
    },
    { id: 'self', type: 'file', file: PATH, x: 0, y: 450, width: 320, height: 240 },
    {
      id: 'inner',
      type: 'file',
      file: 'boards/inside.canvas',
      x: 360,
      y: 450,
      width: 320,
      height: 240,
    },
  ],
  edges: [],
  vendor: { keep: 'root' },
});
async function open(page: Page) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await boot(page);
  await page.evaluate(
    ({ path, source, doc }) => {
      window.__cerebroMockFs.set(path, source);
      window.__cerebroMockFs.set(
        doc,
        '# Board card document\n\n## Rollback\n\nPointer stays exact.\n',
      );
      window.__cerebroMockFs.set(
        'records/cards-task.md',
        '---\ntype: Work item\nstatus: todo\n---\n# Board task\n',
      );
      window.__cerebroMockFs.set(
        'diagrams/cards-flow.mmd',
        'flowchart LR\n A[Card diagram] --> B[Ready]',
      );
      window.__cerebroMockFs.set(
        'boards/inside.canvas',
        JSON.stringify({
          nodes: [
            {
              id: 'inner-text',
              type: 'text',
              text: 'Inside board text',
              x: 0,
              y: 0,
              width: 240,
              height: 100,
            },
          ],
          edges: [],
        }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 100;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#394d70';
      ctx.fillRect(0, 0, 160, 100);
      ctx.fillStyle = '#dde8ff';
      ctx.fillRect(20, 20, 120, 60);
      window.__cerebroMockBytes.seedBytes('0', 'attachments/cards-poster.png', {
        base64: canvas.toDataURL('image/png').split(',')[1],
      });
      localStorage.setItem('cerebro.whiteboard.inspector', 'false');
      localStorage.setItem(
        'cerebro.whiteboard.snap',
        JSON.stringify({ grid: false, objects: false }),
      );
      localStorage.setItem(
        'cerebro.whiteboard.cameras',
        JSON.stringify([
          {
            key: JSON.stringify(['/demo-vault', path]),
            transform: { scale: 0.9, offset: { x: 40, y: 60 } },
          },
        ]),
      );
    },
    { path: PATH, source, doc: DOC },
  );
  await page.evaluate(async () => {
    const path = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(path);
    await useVaultStore.getState().rescan();
  });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Cards');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: PATH })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: PATH }))
    .first()
    .click();
  await expect(page.getByTestId('canvas-page')).toBeVisible();
  await expect(page.locator('[data-node-id="record"]').getByTestId('page-card-title')).toHaveText(
    'Board task',
  );
}
const writes = (page: Page) =>
  page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path).length, PATH);
test('live faces, nested guards and record Open keep the board mounted and write nothing', async ({
  page,
}, info) => {
  await open(page);
  await expect(
    page.locator('[data-node-id="record"]').getByTestId('page-card-status'),
  ).toBeVisible();
  await expect(page.locator('[data-node-id="doc"]').getByTestId('page-card-status')).toHaveCount(0);
  await expect(page.locator('[data-node-id="diagram"] svg[id^="cerebro-mermaid-"]')).toBeVisible();
  const image = page.locator('[data-node-id="image"]').getByTestId('file-image');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160);
  await expect(page.locator('[data-node-id="link"]').getByRole('link')).toHaveAttribute(
    'target',
    '_blank',
  );
  await expect(page.getByText('No page at gone/nowhere.md')).toBeVisible();
  await expect(page.getByText('This whiteboard is already shown here.')).toBeVisible();
  await expect(page.getByText('Inside board text', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('whiteboard-cards.png'), animations: 'disabled' });
  const button = await page
    .locator('[data-node-id="record"]')
    .getByTestId('whiteboard-card-open')
    .boundingBox();
  await page.mouse.click(button!.x + button!.width / 2, button!.y + button!.height / 2);
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await expect(page.getByTestId('canvas-page')).toBeVisible();
  expect(await writes(page)).toBe(0);
  expect(await readMockFile(page, PATH)).toBe(source);
});
test('missing-card movement preserves its pointer and Add card is one undo step', async ({
  page,
}) => {
  await open(page);
  const missing = (await page.locator('[data-node-id="missing"]').boundingBox())!;
  await page.mouse.move(missing.x + 30, missing.y + 25);
  await page.mouse.down();
  await page.mouse.move(missing.x + 80, missing.y + 65, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => writes(page)).toBe(1);
  const saved = JSON.parse((await readMockFile(page, PATH))!);
  expect(saved.nodes.find((node: { id: string }) => node.id === 'missing')).toMatchObject({
    file: 'gone/nowhere.md',
    subpath: '#Keep exactly',
    vendor: { keep: true },
  });
  await page.getByTestId('wb-input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => writes(page)).toBe(2);
  await page.getByRole('button', { name: 'Add card', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find pages' }).fill('Board card document');
  await page.getByTestId('whiteboard-card-option').filter({ hasText: DOC }).click();
  await expect.poll(() => writes(page)).toBe(3);
  expect(
    JSON.parse((await readMockFile(page, PATH))!).nodes.filter(
      (node: { file?: string }) => node.file === DOC,
    ),
  ).toHaveLength(2);
  await page.getByTestId('wb-input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => writes(page)).toBe(4);
  expect(JSON.parse((await readMockFile(page, PATH))!)).toEqual(JSON.parse(source));
});
test('renaming a cited page leaves the exact old whiteboard pointer visibly missing', async ({
  page,
}) => {
  await open(page);
  const tree = page.getByTestId('file-tree'),
    folder = tree.getByTestId('tree-folder').filter({ hasText: 'Notes' });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  await tree
    .locator(`[data-testid="tree-row"][data-path="${DOC}"]`)
    .getByTestId('tree-file')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByPlaceholder('Page name').fill('Renamed board document');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const prompt = page.getByRole('dialog', {
    name: 'Rename “Board card document” to “Renamed board document”?',
  });
  await expect(prompt).toContainText(`1 whiteboard keeps cards pointing at ${DOC}`);
  await prompt.getByRole('button', { name: 'Rename anyway' }).click();
  await expect(page.getByText(`No page at ${DOC}`)).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(source);
  expect(await writes(page)).toBe(0);
});
