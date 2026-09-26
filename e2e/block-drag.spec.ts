import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * The editor's block drag (M48.4).
 *
 * This file could not have existed a slice ago. BlockNote's drag is the
 * browser's HTML5 drag-and-drop, and MEASURED, neither Playwright's `dragTo`
 * nor a hand-stepped mouse drag moves a block or changes the file — so every
 * assertion below would have passed vacuously or not run at all. The pointer
 * drag that replaced it is the reason there is anything here to assert.
 */

const PAGE = [
  '# Order matters',
  '',
  'First paragraph.',
  '',
  'Second paragraph.',
  '',
  'Third paragraph.',
  '',
  ':::columns',
  '::::column',
  'Inside the left column.',
  '::::',
  '::::column',
  'Inside the right column.',
  '::::',
  ':::',
  '',
].join('\n');

const PATH = 'delivery/how-we-schedule.md';

async function openPage(page: Page): Promise<void> {
  await boot(page);
  await page.evaluate((md) => {
    window.__cerebroMockFs.set('delivery/how-we-schedule.md', md);
  }, PAGE);
  await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await page
    .getByTestId('collection-node-doc')
    .filter({ hasText: 'How we schedule' })
    .getByRole('button', { name: 'How we schedule' })
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Inside the left column.')).toBeVisible({ timeout: 10_000 });
}

/** Press the grip on the block holding `text` and drag onto `target`. */
async function dragBlock(page: Page, text: string, target: { x: number; y: number }) {
  const block = page.getByText(text, { exact: true });
  await block.hover();
  // The BUTTON inside the grip: the grip itself is `display: contents` so it
  // does not disturb the menu BlockNote positions, and therefore has no box.
  const grip = page.locator('[data-testid="block-grip"] button');
  await expect(grip).toBeVisible();
  const box = await grip.boundingBox();
  if (box === null) throw new Error('no grip');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Several steps: the first crosses the threshold that turns a press into a
  // drag, the rest let the drop line settle where it is going.
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(
      box.x + (target.x - box.x) * (i / 8),
      box.y + (target.y - box.y) * (i / 8),
    );
  }
  return async () => {
    await page.mouse.up();
  };
}

/** The prose lines of the file, in order, ignoring the layout markers. */
async function proseOrder(page: Page): Promise<string[]> {
  const md = await readMockFile(page, PATH);
  return md
    .split('\n')
    .filter((l) => l.endsWith('paragraph.') || l.startsWith('Inside the'))
    .map((l) => l.trim());
}

test('a block dragged up lands where the line says, and the file agrees', async ({ page }) => {
  await openPage(page);
  const first = await page.getByText('First paragraph.', { exact: true }).boundingBox();
  if (first === null) throw new Error('no first paragraph');

  const drop = await dragBlock(page, 'Third paragraph.', { x: first.x + 40, y: first.y + 2 });
  // The line is painted, and it names where the block would go.
  const line = page.getByTestId('block-drop-line');
  await expect(line).toBeVisible();
  await drop();

  await expect
    .poll(() => proseOrder(page), { timeout: 6_000 })
    .toEqual([
      'Third paragraph.',
      'First paragraph.',
      'Second paragraph.',
      'Inside the left column.',
      'Inside the right column.',
    ]);
});

/* The move BlockNote's drag could not make at all. */
test('a block can be dragged INTO a column', async ({ page }) => {
  await openPage(page);
  const inColumn = await page.getByText('Inside the left column.', { exact: true }).boundingBox();
  if (inColumn === null) throw new Error('no column paragraph');

  const drop = await dragBlock(page, 'First paragraph.', {
    x: inColumn.x + 20,
    y: inColumn.y + inColumn.height - 1,
  });
  await expect(page.getByTestId('block-drop-line')).toBeVisible();
  await drop();

  await expect
    .poll(() => readMockFile(page, PATH), { timeout: 6_000 })
    .toMatch(/::::column\n[\s\S]*First paragraph\.[\s\S]*\n::::/);
  // And it left the top level, rather than being copied.
  const md = await readMockFile(page, PATH);
  expect(md.split('\n').filter((l) => l === 'First paragraph.')).toHaveLength(1);
});

/* Picking a block up and putting it back is the commonest gesture there is.
   Committing it would push an undo entry and dirty the file for nothing. */
test('dropping a block back where it started changes nothing', async ({ page }) => {
  await openPage(page);
  const before = await readMockFile(page, PATH);
  const second = await page.getByText('Second paragraph.', { exact: true }).boundingBox();
  if (second === null) throw new Error('no second paragraph');

  const drop = await dragBlock(page, 'Second paragraph.', {
    x: second.x + 40,
    y: second.y + 1,
  });
  // No line, because there is nowhere to go.
  await expect(page.getByTestId('block-drop-line')).toHaveCount(0);
  await drop();
  await page.waitForTimeout(900);
  expect(await readMockFile(page, PATH)).toBe(before);
});

/* A press that never travels is a click, and the click still belongs to the
   menu — that is what keeps this one control instead of two. */
test('a click on the grip still opens the block menu', async ({ page }) => {
  await openPage(page);
  await page.getByText('Second paragraph.', { exact: true }).hover();
  await page.locator('[data-testid="block-grip"] button').click();
  await expect(page.getByText('Delete', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
});
