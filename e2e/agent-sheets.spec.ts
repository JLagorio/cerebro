import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, openAssistantPanel } from './boot';

const PATH = 'notes/budget.md';
const SOURCE =
  '# Budget\n\n```cerebro-sheet\n---\nformat: 1\nname: Budget\n---\nItem,Cost\nRent,1200\nFood,300\n```\n';

async function openBudget(page: Page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await seedFileBeforeBoot(page, PATH, SOURCE);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Budget');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Budget' }).first().click();
  await expect(page.getByTestId('markdown-editor').getByTestId('sheet-block')).toBeVisible();
  await openAssistantPanel(page);
}
async function ask(page: Page, args: unknown, reply: string) {
  const panel = page.getByTestId('ai-panel');
  await panel
    .getByLabel('Message the assistant')
    .fill(`edit sheet in ${PATH}: ${JSON.stringify(args)}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 15_000,
  });
}
const writes = (page: Page) =>
  page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path), PATH);

test('an agent sheet edit updates the open grid, saves formulas, and records one write', async ({
  page,
}, info) => {
  await openBudget(page);
  await ask(
    page,
    {
      ops: [
        {
          op: 'set_cells',
          sheet: 'Budget',
          cells: [
            { address: 'A4', value: 'Total' },
            { address: 'B4', value: '=SUM(B2:B3)' },
          ],
        },
      ],
    },
    `I edited the sheets on ${PATH}.`,
  );
  const grid = page.getByTestId('markdown-editor').getByTestId('sheet-block');
  await expect(grid.locator('[data-address=B4]')).toHaveText('1500');
  expect(await readMockFile(page, PATH)).toContain('Total,=SUM(B2:B3)');
  expect(await readMockFile(page, PATH)).not.toContain('1500');
  expect(await writes(page)).toHaveLength(1);
  expect((await writes(page))[0]).toMatchObject({ path: PATH, kind: 'vault.write' });
  await page.screenshot({ path: info.outputPath('agent-sheet-edit.png'), animations: 'disabled' });
});

test('26 sheet operations are refused without changing the page or recording a write', async ({
  page,
}, info) => {
  await openBudget(page);
  await ask(
    page,
    { ops: Array.from({ length: 26 }, (_, n) => ({ op: 'add_sheet', name: `Extra${n}` })) },
    'edit_sheet takes at most 25 ops in one call; this call has 26.',
  );
  await expect(
    page.locator('[data-testid="action-card"][data-tool="edit_sheet"][data-failed="true"]'),
  ).toHaveCount(1);
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
  expect(await writes(page)).toEqual([]);
  await page.screenshot({
    path: info.outputPath('agent-sheet-refusal.png'),
    animations: 'disabled',
  });
});
