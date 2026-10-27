import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedBeforeBoot } from './boot';

const PATH = 'notes/template-application-target.md';
const TEMPLATE = 'templates/atomic-scaffold.md';
const BEFORE = '# Template application target\n\n';

test('a failed template stays blank, retries atomically and undoes without replacing the editor', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await seedBeforeBoot(page, '__cerebroSeedFiles', {
    [PATH]: BEFORE,
    [TEMPLATE]: '---\nstatus_note: selected\n---\n# {{title}}\n\nA scaffold to work from.\n',
  });
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Template application target');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Template application target' })
    .first()
    .click();
  const editor = await page.getByTestId('markdown-editor').elementHandle();
  expect(editor).not.toBeNull();
  const apply = page.getByRole('button', { name: 'Atomic scaffold', exact: true });
  await expect(apply).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __cerebroFailNext: (command: string) => void }).__cerebroFailNext(
      'apply_batch',
    );
  });
  await apply.focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('status').filter({ hasText: 'apply_batch was told to fail once' }).first(),
  ).toBeVisible();
  await expect(apply).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(BEFORE);
  expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
  await apply.click();
  await expect(page.getByTestId('markdown-editor')).toContainText('A scaffold to work from.');
  await expect.poll(() => readMockFile(page, PATH)).toContain('status_note: selected');
  expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
  await page.screenshot({ path: info.outputPath('template-applied.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => readMockFile(page, PATH)).toBe(BEFORE);
  await expect(apply).toBeVisible();
  expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
});
