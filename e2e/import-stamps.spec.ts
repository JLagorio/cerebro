import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

const PATH = 'records/issues/fix-login.md';
const PREFIX =
  '---\ntitle: Fix login\nsource_system: linear\nsource_record_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nsource_url: https://linear.app/example/issue/ABC-1\nimported_at: 2026-10-15T12:00:00Z\nimported_by: human:me\nimport_hash: original\n---\n';
const SOURCE = `${PREFIX}# Fix login\n\nThe login form needs a fix.\n`;
async function ask(page: Page, message: string, reply: string) {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(message);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 15_000,
  });
}
test('an imported page names its source and agent writes preserve its stamps', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await seedFileBeforeBoot(page, PATH, SOURCE);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Fix login');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Fix login' }).first().click();
  await expect(page.getByTestId('import-provenance')).toHaveText(
    'Imported from Linear · 2026-10-15',
  );
  const doc = page.getByTestId('doc-page');
  await expect(doc.getByTestId('import-provenance')).toHaveText(
    'Imported from Linear · 2026-10-15',
  );
  await expect(doc.getByText('import_hash', { exact: true })).toHaveCount(0);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  await ask(
    page,
    `set import_hash to "x" on ${PATH}`,
    'Agent writes may not add, change or remove',
  );
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
  await ask(page, `append "An ordinary appendix." to ${PATH}`, `I appended that to ${PATH}.`);
  const after = await readMockFile(page, PATH);
  expect(after).toContain('An ordinary appendix.');
  expect(after.startsWith(PREFIX)).toBe(true);
  await page.screenshot({ path: info.outputPath('import-provenance.png'), animations: 'disabled' });
});
