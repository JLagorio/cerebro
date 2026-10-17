import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, openDestination } from './boot';
const PATH = 'notes/grid-budget.md';
const SOURCE =
  '# Grid budget\n\nBefore grid.\n\n```cerebro-sheet\n---\nformat: 1\nname: Budget\n---\n1,10\n2,20\n3,30\n```\n\n```cerebro-sheet\n---\nformat: 1\nname: Summary\n---\n=Budget!B2\n```\n\nClosing notes.\n';
async function open(page: Page) {
  await page.setViewportSize({ width: 1450, height: 1000 });
  await seedFileBeforeBoot(page, PATH, SOURCE);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Grid budget');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Grid budget' }).first().click();
  await expect(page.getByTestId('markdown-editor').getByTestId('sheet-grid')).toHaveCount(2);
  const grids = page.getByTestId('markdown-editor').getByTestId('sheet-grid');
  await expect(grids.nth(1).locator('[data-cell=A1]')).toHaveText('20');
  return grids;
}
async function edit(grid: Locator, cell: string, value: string) {
  await grid.locator(`[data-cell=${cell}]`).dblclick();
  await grid.getByTestId('sheet-cell-editor').fill(value);
  await grid.getByTestId('sheet-cell-editor').press('Enter');
}
async function paste(grid: Locator, text: string) {
  await grid.evaluate((el, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  }, text);
}
test('completion inserts a function and point-selection keeps its draft and argument hint', async ({
  page,
}, info) => {
  const grid = (await open(page)).first();
  await grid.locator('[data-cell=C1]').dblclick();
  const input = grid.getByTestId('sheet-cell-editor');
  await input.fill('=SU');
  await expect(page.getByTestId('sheet-completions').getByRole('option').first()).toHaveText('SUM');
  await page.screenshot({
    path: info.outputPath('sheet-function-list.png'),
    animations: 'disabled',
  });
  await input.press('Enter');
  await expect(input).toHaveValue('=SUM(');
  await expect(page.getByTestId('sheet-arg-hint')).toContainText('number1');
  await grid.locator('[data-cell=A1]').click();
  await expect(input).toHaveValue('=SUM(A1');
  await grid.locator('[data-cell=A3]').click({ modifiers: ['Shift'] });
  await expect(input).toHaveValue('=SUM(A1:A3');
  await input.press('End');
  await input.press(')');
  await input.press('Enter');
  await expect(grid.locator('[data-cell=C1]')).toHaveText('6');
  await page.screenshot({ path: info.outputPath('sheet-completion.png'), animations: 'disabled' });
});
test('fill handle continues a series in one undo step and command-D translates formulas', async ({
  page,
}) => {
  const grid = (await open(page)).first();
  await grid.locator('[data-cell=A1]').click();
  await grid.locator('[data-cell=A2]').click({ modifiers: ['Shift'] });
  const handle = await grid.getByTestId('sheet-fill-handle').boundingBox();
  const target = await grid.locator('[data-cell=A5]').boundingBox();
  if (!handle || !target) throw new Error('Missing fill geometry');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(grid.locator('[data-cell=A5]')).toHaveText('5');
  await grid.press('ControlOrMeta+z');
  await expect.poll(() => readMockFile(page, PATH)).toBe(SOURCE);
  await edit(grid, 'C1', '=A1*2');
  await grid.locator('[data-cell=C1]').click();
  await grid.locator('[data-cell=C3]').click({ modifiers: ['Shift'] });
  await grid.press('ControlOrMeta+d');
  await expect(grid.locator('[data-cell=C3]')).toHaveText('6');
  await expect.poll(() => readMockFile(page, PATH)).toContain('=A3*2');
});
test('Ask about selection opens the assistant with its page and range label', async ({ page }) => {
  const grid = (await open(page)).first();
  await grid.locator('[data-cell=A1]').click();
  await grid.locator('[data-cell=B2]').click({ modifiers: ['Shift'] });
  await grid.getByTestId('sheet-ask').click();
  await page.getByTestId('sheet-ask-input').fill('What is the total?');
  await page.getByTestId('sheet-ask-input').press('Enter');
  await expect(
    page
      .getByTestId('chat-message')
      .filter({ has: page.getByText('What is the total? · Budget!A1:B2', { exact: true }) }),
  ).toBeVisible();
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  await expect(page.getByTestId('context-chip').filter({ hasText: 'Grid budget' })).toBeVisible();
});
test('formulas compute and a 3×3 paste is exactly one page undo step', async ({ page }, info) => {
  const grids = await open(page);
  const grid = grids.first();
  await edit(grid, 'A4', '=SUM(A1:A3)');
  await expect(grid.locator('[data-cell=A4]')).toHaveText('6');
  await expect.poll(() => readMockFile(page, PATH)).toContain('=SUM(A1:A3)');
  const before = await readMockFile(page, PATH);
  await grid.locator('[data-cell=B2]').click();
  await paste(grid, '1\t2\t3\n4\t5\t6\n7\t8\t9');
  await expect(grid.locator('[data-cell=D4]')).toHaveText('9');
  await expect.poll(() => readMockFile(page, PATH)).toContain('2,1,2,3');
  await grid.press('ControlOrMeta+z');
  await expect.poll(() => readMockFile(page, PATH)).toBe(before);
  await expect(grid.locator('[data-cell=D4]')).toHaveText('');
  await page.screenshot({ path: info.outputPath('sheet-grid.png'), animations: 'disabled' });
});
test('two quick commits undo as two steps and redo follows the page', async ({ page }) => {
  const grids = await open(page);
  const grid = grids.first();
  await edit(grid, 'A1', '7');
  await edit(grid, 'A2', '8');
  await expect.poll(() => readMockFile(page, PATH)).toContain('7,10\n8,20');
  await grid.press('ControlOrMeta+z');
  await expect(grid.locator('[data-cell=A2]')).toHaveText('2');
  await expect(grid.locator('[data-cell=A1]')).toHaveText('7');
  await grid.press('ControlOrMeta+z');
  await expect.poll(() => readMockFile(page, PATH)).toBe(SOURCE);
  await grid.press('ControlOrMeta+Shift+z');
  await expect(grid.locator('[data-cell=A1]')).toHaveText('7');
});
test('insert and delete rewrite every sheet once and undo restores both byte for byte', async ({
  page,
}) => {
  const grids = await open(page);
  const grid = grids.first();
  await grid.locator('[data-cell=B2]').click();
  await grid.getByTestId('sheet-structure').click();
  await page.getByRole('menuitem', { name: 'Insert row above', exact: true }).click();
  await expect.poll(() => readMockFile(page, PATH)).toContain('=Budget!B3');
  await expect(grids.nth(1).locator('[data-cell=A1]')).toHaveText('20');
  await grid.press('ControlOrMeta+z');
  await expect.poll(() => readMockFile(page, PATH)).toBe(SOURCE);
  await grid.locator('[data-cell=B2]').click();
  await grid.getByTestId('sheet-structure').click();
  await page.getByRole('menuitem', { name: 'Delete columns', exact: true }).click();
  await expect(grids.nth(1).locator('[data-cell=A1]')).toHaveText('#REF!');
  await expect.poll(() => readMockFile(page, PATH)).toContain('=#REF!');
});
test('grid keys and clipboard stay inside the block, and Escape returns to the page', async ({
  page,
}) => {
  const grids = await open(page);
  const grid = grids.first();
  await grid.locator('[data-cell=A1]').click();
  await page.keyboard.type('/');
  await expect(grid.getByTestId('sheet-cell-editor')).toHaveValue('/');
  await expect(page.getByText('Sheet', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await expect(grid.getByTestId('sheet-cell-editor')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(grids).toHaveCount(2);
  await grid.press('ControlOrMeta+a');
  await expect(grid.getByTestId('sheet-address')).toHaveText('A1:B3');
  await grid.press('Escape');
  await expect(grid.getByTestId('sheet-address')).toHaveText('B3');
  await grid.press('Escape');
  await expect(
    page.getByTestId('markdown-editor').locator('[contenteditable=true]').first(),
  ).toBeFocused();
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
});
test('/sheet makes stable named fences and an open draft flushes when leaving', async ({
  page,
}) => {
  await open(page);
  const editor = page.getByTestId('markdown-editor');
  await editor
    .locator('[data-content-type=paragraph]')
    .filter({ hasText: 'Closing notes.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/sheet');
  await page.getByText('Sheet', { exact: true }).click();
  const grids = editor.getByTestId('sheet-grid');
  await expect(grids).toHaveCount(3);
  await expect(grids.nth(2).getByTestId('sheet-name')).toHaveText('Sheet1');
  await expect(grids.nth(2)).toBeFocused();
  await page.keyboard.type('kept draft');
  await openDestination(page, 'Home');
  await expect.poll(() => readMockFile(page, PATH)).toContain('kept draft');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Grid budget');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Grid budget' }).first().click();
  await expect(page.getByTestId('sheet-grid').nth(2).locator('[data-cell=A1]')).toHaveText(
    'kept draft',
  );
});
test('New Sheet creates a root page whose first grid accepts typing', async ({ page }) => {
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('option', { name: 'Sheet', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New sheet' });
  await dialog.getByPlaceholder('Name the page').fill('Plan numbers');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const grid = page.getByTestId('markdown-editor').getByTestId('sheet-grid');
  await expect(grid).toBeVisible();
  await edit(grid, 'A1', '42');
  await expect.poll(() => readMockFile(page, 'plan-numbers.md')).toContain('42');
  await expect(grid.locator('[data-cell=A1]')).toHaveText('42');
});

test('an editable sheet still moves by the page block grip', async ({ page }) => {
  const grids = await open(page);
  const grid = grids.first();
  const before = await page.getByText('Before grid.', { exact: true }).boundingBox();
  await grid.locator('[data-cell=A1]').hover();
  const grip = page.locator('[data-testid="block-grip"] button');
  await expect(grip).toBeVisible();
  const box = await grip.boundingBox();
  if (!box || !before) throw new Error('missing drag geometry');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(
      box.x + ((before.x + 40 - box.x) * step) / 10,
      box.y + ((before.y + 2 - box.y) * step) / 10,
    );
  await expect(page.getByTestId('block-drop-line')).toBeVisible();
  await page.mouse.up();
  await expect
    .poll(async () => {
      const text = await readMockFile(page, PATH);
      return text.indexOf('```cerebro-sheet') < text.indexOf('Before grid.');
    })
    .toBe(true);
});
