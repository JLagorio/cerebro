import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';
const path = 'diagrams/pipeline.mmd';
const code = [
  'flowchart LR',
  '%% cerebro:layout manual',
  '%% cerebro:pos A 160,140 B 560,140 C 900,140',
  'subgraph work[Work]',
  'A[Schedule] -->|ready| B{Choose}',
  'end',
  'C[Done]',
  'B --> C',
  'A ~~~ C',
  'click A "delivery/how-we-schedule.md"',
  'style B fill:#aBc',
  'classDef hot fill:#f96',
  '',
].join('\n');
test('converts a manual Mermaid board with a loss report and leaves its source unchanged', async ({
  page,
}, info) => {
  await seedFileBeforeBoot(page, path, code);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Pipeline');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Pipeline' }).first().click();
  await expect(page.getByTestId('diagram-title')).toHaveText('Pipeline');
  await expect(page.getByTestId('structural-host').locator('svg')).toBeVisible();
  await page.getByTestId('diagram-convert').click();
  const dialog = page.getByTestId('convert-board-dialog');
  await expect(dialog).toContainText('diagrams/pipeline.canvas');
  await expect(dialog).toContainText('diamond ×1');
  await expect(dialog).toContainText('1 invisible link');
  await expect(dialog).toContainText('classDef hot fill:#f96');
  await expect(dialog).not.toContainText('took a default size');
  expect(await readMockFile(page, path)).toBe(code);
  await page.screenshot({ path: info.outputPath('conversion-report.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.__cerebroMockFs.has('diagrams/pipeline.canvas'))).toBe(
    false,
  );
  await page.getByTestId('diagram-convert').click();
  await page.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(page.getByTestId('canvas-title')).toHaveText('Pipeline');
  await expect(page.getByTestId('wb-input')).toBeVisible();
  const raw = await readMockFile(page, 'diagrams/pipeline.canvas');
  const board = JSON.parse(raw) as {
    nodes: Array<{
      id: string;
      type: string;
      file?: string;
      label?: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
    }>;
    edges: Array<{ fromNode: string; toNode: string; label?: string; toEnd?: string }>;
  };
  expect(board.nodes.find((n) => n.id === 'A')).toMatchObject({
    type: 'file',
    file: 'delivery/how-we-schedule.md',
    width: 320,
    height: 120,
  });
  expect(board.nodes[0]).toMatchObject({ id: 'group-work', type: 'group', label: 'Work' });
  expect(board.nodes.find((n) => n.id === 'B')).toMatchObject({ type: 'text', color: '#aabbcc' });
  expect(board.edges).toHaveLength(2);
  expect(board.edges[0]).toMatchObject({
    fromNode: 'A',
    toNode: 'B',
    label: 'ready',
    toEnd: 'arrow',
  });
  for (const [id, x, y] of [
    ['A', 160, 140],
    ['B', 560, 140],
    ['C', 900, 140],
  ] as const) {
    const node = board.nodes.find((n) => n.id === id)!;
    expect(Math.abs(node.x + node.width / 2 - x)).toBeLessThanOrEqual(2);
    expect(Math.abs(node.y + node.height / 2 - y)).toBeLessThanOrEqual(2);
  }
  const group = board.nodes[0];
  for (const id of ['A', 'B']) {
    const node = board.nodes.find((n) => n.id === id)!;
    expect(node.x - group.x).toBeGreaterThanOrEqual(24);
    expect(group.x + group.width - node.x - node.width).toBeGreaterThanOrEqual(24);
  }
  expect(await readMockFile(page, path)).toBe(code);
  await page.screenshot({ path: info.outputPath('converted-board.png'), animations: 'disabled' });
});
