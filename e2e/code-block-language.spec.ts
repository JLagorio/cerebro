import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';
import { chooseOption } from './select';

/**
 * A code block's language picker (CV-63). BlockNote builds it as a native
 * <select>; the block draws the design system's Select in its place. These
 * run in a browser because jsdom lays nothing out: the picker waits out of
 * the code's way until the block is hovered, and a pick rewrites the fence
 * word and nothing else.
 */

const PATH = 'code-language.md';
const SOURCE = [
  '# Code language',
  '',
  'Intro.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '```',
  'npm install',
  '```',
  '',
  'After.',
  '',
].join('\n');

async function openPage(page: Page, path: string, text: string, title: string) {
  await seedFileBeforeBoot(page, path, text);
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('quick-open-input').fill(title);
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  const blocks = page.getByTestId('markdown-editor').locator('[data-content-type="codeBlock"]');
  await expect(blocks.first()).toBeVisible();
  // Away from the page, so no block starts out hovered.
  await page.mouse.move(1, 1);
  return blocks;
}

test('a code block picks its language with the design system Select, and the fence alone changes', async ({
  page,
}) => {
  const blocks = await openPage(page, PATH, SOURCE, 'Code language');
  await expect(blocks).toHaveCount(2);
  await expect(page.getByTestId('markdown-editor').locator('select')).toHaveCount(0);
  const ts = blocks.nth(0);
  const picker = ts.getByRole('button', { name: 'Code language' });
  await expect(picker).toHaveText('TypeScript');
  await expect(blocks.nth(1).getByRole('button', { name: 'Code language' })).toHaveText(
    'Plain Text',
  );

  // Out of the code's way until the block is hovered, then in its top corner.
  const corner = ts.locator('.cb-code-language');
  await expect(corner).toHaveCSS('opacity', '0');
  await ts.hover();
  await expect(corner).toHaveCSS('opacity', '1');
  const block = (await ts.boundingBox())!;
  const box = (await picker.boundingBox())!;
  expect(box.y - block.y).toBeGreaterThanOrEqual(0);
  expect(box.y - block.y).toBeLessThanOrEqual(12);
  expect(block.x + block.width - (box.x + box.width)).toBeGreaterThanOrEqual(0);
  expect(block.x + block.width - (box.x + box.width)).toBeLessThanOrEqual(12);

  // Opening and hovering write nothing; a pick rewrites the fence word alone.
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
  await chooseOption(picker, 'Python');
  await expect(picker).toHaveText('Python');
  await expect.poll(() => readMockFile(page, PATH)).toBe(SOURCE.replace('```ts', '```python'));

  // The rebuilt picker keeps focus, so the keyboard carries on from it:
  // Enter opens the list, typing finds a row, Enter takes it.
  await expect(picker).toBeFocused();
  await page.mouse.move(1, 1);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.type('rus');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveText('Rust');
  await expect.poll(() => readMockFile(page, PATH)).toBe(SOURCE.replace('```ts', '```rust'));
  await expect(page.getByTestId('markdown-editor').locator('select')).toHaveCount(0);
});

test('a read-only page shows each language and offers a pick once it is unlocked', async ({
  page,
}) => {
  const path = 'locked-code.md';
  const text = [
    '# Locked code',
    '',
    '<div align="center">raw html island</div>',
    '',
    '```ts',
    'const answer = 42;',
    '```',
    '',
  ].join('\n');
  const blocks = await openPage(page, path, text, 'Locked code');
  await expect(page.getByTestId('lossy-import-banner')).toBeVisible();
  const picker = blocks.first().getByRole('button', { name: 'Code language' });
  await expect(picker).toHaveText('TypeScript');
  await expect(picker).toBeDisabled();
  // Unlocking makes the editor editable without rebuilding its blocks.
  await page.getByRole('button', { name: 'Edit anyway (raw HTML will be removed)' }).click();
  await expect(picker).toBeEnabled();
  expect(await readMockFile(page, path)).toBe(text);
});
