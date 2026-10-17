import { expect, test, type Page } from '@playwright/test';
import { boot, openDestination, openHistory, readMockFile } from './boot';

async function seedWorkspace(page: Page) {
  await page.evaluate(() => {
    const roots = (
      window as unknown as {
        __cerebroMockRoots: {
          resetMockRoots(): void;
          seedRoot(seed: { path: string; label: string }): { id: string };
          seedFile(root: string, path: string, source: string): void;
        };
      }
    ).__cerebroMockRoots;
    roots.resetMockRoots();
    const root = roots.seedRoot({ path: '/repos/redesign', label: 'Reading room' });
    roots.seedFile('/repos/redesign', 'README.md', '# Reading room\n\nThe same open document.');
    roots.seedFile('/repos/redesign', 'budget.csv', 'Item,Amount\nRent,1200\nFood,300');
    const image = document.createElement('canvas');
    image.width = 1200;
    image.height = 800;
    const context = image.getContext('2d')!;
    context.fillStyle = '#394d70';
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = '#dde8ff';
    context.font = '64px sans-serif';
    context.fillText('Contained image', 160, 400);
    window.__cerebroMockBytes.seedBytes(root.id, 'preview.png', {
      base64: image.toDataURL('image/png').split(',')[1],
    });
  });
}

async function noOverflow(page: Page, width: number) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test('Work lends one Explorer to the shell and keeps the open file through compact keyboard navigation', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await seedWorkspace(page);
  await openDestination(page, 'Work');
  const sidebar = page.getByTestId('sidebar');
  const tree = sidebar.getByTestId('root-tree');
  await expect(tree).toBeVisible();
  await expect(page.getByTestId('root-tree')).toHaveCount(1);
  await expect(page.getByTestId('workspace-page').getByTestId('root-tree')).toHaveCount(0);
  await tree.getByRole('treeitem', { name: /Reading room/ }).click();
  await tree.getByRole('treeitem', { name: /README.md/ }).click();
  const viewer = page.getByTestId('doc-viewer');
  await expect(viewer).toContainText('The same open document.');
  const original = await viewer.elementHandle();
  const sideBox = await sidebar.boundingBox();
  const paneBox = await page.getByTestId('editor-groups').boundingBox();
  expect(Math.abs(paneBox!.x - (sideBox!.x + sideBox!.width))).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath('work-wide.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(sidebar).toBeHidden();
  await page
    .getByTestId('workspace-page')
    .getByRole('button', { name: 'Files', exact: true })
    .click();
  await expect(tree).toBeVisible();
  const readme = tree.getByRole('treeitem', { name: /README.md/ });
  await readme.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).toBeHidden();
  await expect(
    page.getByTestId('workspace-page').getByRole('button', { name: 'Files', exact: true }),
  ).toBeFocused();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await viewer.getByText('The same open document.').click();
  await page.getByTestId('crumb-root').click();
  await expect(tree).toBeVisible();
  await page.getByTestId('mount-root').click();
  await expect(page.getByTestId('mount-dialog')).toBeVisible();
  await page.getByTestId('mount-cancel').click();
  await page.keyboard.press('Escape');
  await noOverflow(page, 900);
  await page.screenshot({ path: info.outputPath('work-compact.png'), animations: 'disabled' });
});

for (const theme of ['light', 'dark'] as const) {
  test(`file preview controls stay reachable and retain their behavior in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    await seedWorkspace(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await openDestination(page, 'Work');
    const tree = page.getByTestId('root-tree');
    await tree.getByRole('treeitem', { name: /Reading room/ }).click();
    await tree.getByRole('treeitem', { name: /preview.png/ }).click();
    const image = page.getByTestId('file-image');
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(1200);
    await expect(page.getByRole('button', { name: 'Fit', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: '100%', exact: true }).click();
    await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-fit', 'actual');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const frame = await page.locator('.image-viewer-frame').boundingBox();
    const imageBox = await image.boundingBox();
    expect(imageBox!.width).toBeLessThan(frame!.width);
    expect(imageBox!.height).toBeLessThan(frame!.height);
    await page.screenshot({ path: info.outputPath(`image-${theme}.png`), animations: 'disabled' });
    await tree.getByRole('treeitem', { name: /budget.csv/ }).click();
    await expect(page.getByTestId('table-viewer')).toContainText('2 rows');
    await expect(page.getByRole('columnheader', { name: 'Amount' })).toBeVisible();
    await page.getByRole('button', { name: 'View as text' }).click();
    await expect(page.getByTestId('code-viewer')).toBeVisible();
    await page.getByRole('button', { name: 'View as table' }).click();
    await expect(page.getByRole('cell', { name: '1200' })).toBeVisible();
    await noOverflow(page, 1280);
  });

  test(`History and whiteboard keep a clear heading and usable canvas in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await openHistory(page);
    const heading = page.getByRole('heading', { name: 'History', exact: true });
    await expect(heading).toBeVisible();
    expect(
      await heading.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(20);
    await page.screenshot({
      path: info.outputPath(`history-${theme}.png`),
      animations: 'disabled',
    });
    const path = 'boards/presentation.canvas';
    const source =
      '{"nodes":[{"id":"a","type":"text","text":"Reading room","x":0,"y":0,"width":280,"height":160}],"edges":[]}';
    await page.evaluate(({ path, source }) => window.__cerebroMockFs.set(path, source), {
      path,
      source,
    });
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('quick-open-input').fill('Presentation');
    await page
      .getByTestId('quick-open-result')
      .filter({ hasText: 'Presentation' })
      .or(page.getByTestId('quick-open-content-result').filter({ hasText: 'Presentation' }))
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Presentation', exact: true })).toBeVisible();
    await expect(page.getByTestId('canvas-summary')).toHaveText('1 card · 0 connections');
    const inspector = page.getByTestId('wb-inspector');
    await expect(inspector).toContainText('Nothing selected');
    expect((await inspector.boundingBox())!.height).toBeLessThan(180);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page, width);
      expect((await page.getByTestId('canvas-board').boundingBox())!.height).toBeGreaterThan(600);
      await expect(page.getByTestId('wb-toolbar')).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`whiteboard-${theme}-${width}.png`),
        animations: 'disabled',
      });
    }
    expect(await readMockFile(page, path)).toBe(source);
  });
}
