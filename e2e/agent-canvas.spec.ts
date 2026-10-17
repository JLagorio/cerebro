import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, openAssistantPanel } from './boot';
const PATH = 'boards/agent-plan.canvas';
const SOURCE = JSON.stringify({
  nodes: [{ id: 'goals', type: 'text', text: 'Goals', x: 0, y: 0, width: 240, height: 120 }],
  edges: [],
  vendor: { keep: 'unknown' },
});
async function open(page: Page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await seedFileBeforeBoot(page, PATH, SOURCE);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Agent plan');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Agent plan' }).first().click();
  await expect(page.getByTestId('canvas-summary')).toHaveText('1 card · 0 connections');
  await openAssistantPanel(page);
}
async function ask(page: Page, ops: unknown, reply: string) {
  const panel = page.getByTestId('ai-panel');
  await panel
    .getByLabel('Message the assistant')
    .fill(`edit canvas ${PATH}: ${JSON.stringify(ops)}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 15000,
  });
}
const writes = (page: Page) =>
  page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path), PATH);
test('agent edits an open Obsidian board once and retains unknown data', async ({ page }, info) => {
  await open(page);
  await ask(
    page,
    [
      {
        op: 'add_node',
        id: 'next',
        type: 'text',
        text: 'Next steps',
        x: 280,
        y: 0,
        width: 240,
        height: 120,
      },
      {
        op: 'add_node',
        id: 'file',
        type: 'file',
        file: 'notes/plan.md',
        x: 280,
        y: 160,
        width: 240,
        height: 100,
      },
      { op: 'add_edge', id: 'e', fromNode: 'goals', toNode: 'next', toEnd: 'arrow' },
    ],
    `I edited the whiteboard ${PATH}.`,
  );
  await expect(page.getByTestId('canvas-summary')).toHaveText('3 cards · 1 connection');
  await expect(
    page.getByTestId('canvas-board').getByText('Next steps', { exact: true }),
  ).toBeVisible();
  const board = JSON.parse((await readMockFile(page, PATH))!);
  expect(board.vendor).toEqual({ keep: 'unknown' });
  expect(board.nodes).toHaveLength(3);
  expect(board.edges).toHaveLength(1);
  expect(await writes(page)).toHaveLength(1);
  expect((await writes(page))[0]).toMatchObject({
    kind: 'vault.write',
    path: PATH,
    actor: 'claude-code',
  });
  await page.getByRole('button', { name: 'Whiteboard inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  const goal = (await page.locator('[data-testid="wb-node"][data-node-id="goals"]').boundingBox())!;
  await page.mouse.click(goal.x + goal.width / 2, goal.y + goal.height / 2);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  const afterHuman = JSON.parse((await readMockFile(page, PATH))!);
  expect(afterHuman.nodes).toHaveLength(3);
  expect(afterHuman.edges).toHaveLength(1);
  expect(afterHuman.vendor).toEqual({ keep: 'unknown' });
  expect((await writes(page))[1]).toMatchObject({ actor: 'human:me' });
  await page.screenshot({ path: info.outputPath('agent-canvas-edit.png'), animations: 'disabled' });
});
for (const [name, ops, words] of [
  [
    'dangling',
    [
      { op: 'add_node', id: 'next', type: 'group', x: 0, y: 0, width: 1, height: 1 },
      { op: 'add_edge', fromNode: 'next', toNode: 'missing' },
    ],
    'the edge would point at "missing"',
  ],
  [
    '26 operations',
    Array.from({ length: 26 }, () => ({ op: 'add_node' })),
    'edit_canvas takes at most 25 ops',
  ],
] as const)
  test(`${name} refuses without changing bytes or recording a row`, async ({ page }) => {
    await open(page);
    await ask(page, ops, words);
    await expect(
      page.locator('[data-testid="action-card"][data-tool="edit_canvas"][data-failed="true"]'),
    ).toHaveCount(1);
    expect(await readMockFile(page, PATH)).toBe(SOURCE);
    expect(await writes(page)).toEqual([]);
  });

test('agent creates filled boards once, chooses a free name, and the change card opens it', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  const ops = [
    { op: 'add_node', id: 'a', type: 'text', text: 'Goals', x: 0, y: 0, width: 240, height: 120 },
    {
      op: 'add_node',
      id: 'b',
      type: 'text',
      text: 'Next steps',
      x: 280,
      y: 0,
      width: 240,
      height: 120,
    },
    { op: 'add_edge', id: 'e', fromNode: 'a', toNode: 'b', toEnd: 'arrow' },
  ];
  for (const path of ['boards/q4-board.canvas', 'boards/q4-board-2.canvas']) {
    await panel
      .getByLabel('Message the assistant')
      .fill(`create canvas q4-board in boards: ${JSON.stringify(ops)}`);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(
      panel.getByTestId('chat-message').filter({ hasText: `I created ${path}.` }),
    ).toHaveCount(1);
    const data = JSON.parse((await readMockFile(page, path))!);
    expect(data.nodes).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
    const logged = await page.evaluate(
      (p) => window.__cerebroMockWrites.filter((row) => row.path === p),
      path,
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: 'vault.create', actor: 'claude-code' });
    const card = page.locator('[data-testid="action-card"][data-tool="create_canvas"]').last();
    await card.getByRole('button').first().click();
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByTestId('canvas-summary')).toHaveText('2 cards · 1 connection');
  }
  await page.getByRole('button', { name: 'Whiteboard inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('agent-canvas-create.png'),
    animations: 'disabled',
  });
});
