import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const cases = JSON.parse(
  readFileSync(new URL('../src-tauri/fixtures/notion-cases.json', import.meta.url), 'utf8'),
) as { cases: { expect: MockNotionCapture['result'] }[] };
import { boot, readMockFile, openAssistantPanel } from './boot';
import type { MockNotionCapture } from '../src/lib/mockNotion';
const PAGE = '11111111111111111111111111111111';
const PATH = 'notion/toy-page.md';
async function setup(page: Page, capture: MockNotionCapture) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.addInitScript(
    ({ id, capture }) => {
      (
        window as unknown as { __cerebroMockCaptures: Record<string, unknown> }
      ).__cerebroMockCaptures = { [id]: capture };
    },
    { id: PAGE, capture },
  );
  await boot(page);
  await openAssistantPanel(page);
}
async function ask(page: Page, reply: string) {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(`import notion ${PAGE} to notion`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 15_000,
  });
}
test('a captured Notion page imports once and its callout, columns and toggle reopen unlossy', async ({
  page,
}, info) => {
  await setup(page, {
    title: 'Toy page',
    result: cases.cases[0].expect as MockNotionCapture['result'],
  });
  await ask(page, 'Imported “Toy page” from Notion to notion/toy-page.md.');
  const bytes = await readMockFile(page, PATH);
  expect(bytes).toContain('source_system: "notion"');
  expect(bytes).toContain('> [!warning]');
  expect(bytes).toContain(':::columns');
  await ask(page, 'notion/toy-page.md already holds this page, unchanged since its import.');
  expect(await readMockFile(page, PATH)).toBe(bytes);
  const state = await page.evaluate(() => ({
    paths: [...window.__cerebroMockFs.keys()].filter((p) => p.startsWith('notion/')),
    writes: window.__cerebroMockWrites.filter((w) => w.path.startsWith('notion/')),
  }));
  expect(state.paths).toEqual([PATH]);
  expect(state.writes).toHaveLength(1);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Toy page');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Toy page' }).first().click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toContainText('Careful');
  await expect(editor.locator('[data-content-type="columnList"]')).toHaveCount(1);
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  expect(await readMockFile(page, PATH)).toBe(bytes);
  await page.screenshot({ path: info.outputPath('notion-import.png'), animations: 'disabled' });
});
test('a database fetch is refused in the transcript and writes no page', async ({ page }, info) => {
  await setup(page, {
    title: 'Database',
    result: {
      refusal: {
        reason: 'database_first',
        words: 'The fetch returned a database. Fetch one page instead.',
      },
    },
  });
  await ask(
    page,
    'import_refused: database_first — The fetch returned a database. Fetch one page instead. Nothing was written.',
  );
  expect(
    await page.evaluate(() =>
      [...window.__cerebroMockFs.keys()].filter((p) => p.startsWith('notion/')),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() =>
      window.__cerebroMockWrites.filter((w) => w.path.startsWith('notion/')),
    ),
  ).toEqual([]);
  await expect(
    page.locator('[data-testid="action-card"][data-tool="import_notion_page"][data-failed="true"]'),
  ).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('notion-refusal.png'), animations: 'disabled' });
});
