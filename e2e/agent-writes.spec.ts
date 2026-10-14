import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, VAULT_TODAY } from './boot';

/**
 * Agent writes reach the open page (M53.6).
 *
 * The agent writes straight to disk through its MCP tools, and the app's own
 * `write_file` registers every write as the app's, so the watcher drops the
 * echo. Before this, nothing told an open page: it went on showing the
 * version from before the write, and the next keystroke's save put that
 * version back over the agent's work. The write tools now announce what they
 * changed, by path, and a turn lands the page's pending save before its child
 * starts.
 *
 * Through the browser-mode mock agent's two write scripts
 * (src/agent/mockAgent.ts): `append "…" to <note>`, whose append goes through
 * `agentAppend` on the mock disk, and `edit "…" to "…" in <note>` (M55.5),
 * whose edit goes through `agentEdit`. The second append matters as much as
 * the first: `boot` pins the clock, so the file's modifiedAt cannot move after
 * the first save, and only the per-path announcement can tell the page that
 * the file changed.
 */

const PAGE = 'delivery/how-we-schedule.md';

// No "inbox", "organize" or "risk" anywhere on the page or in the asks: the
// mock agent picks its script by keyword.
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');

/** Open the page from the sidebar, expanding its collection only if it is folded. */
async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

/** Ask the mock agent to append `line` to the page, and wait for its reply. */
async function askToAppend(page: Page, line: string, replies: number): Promise<void> {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(`append "${line}" to ${PAGE}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: `I appended that to ${PAGE}.` }),
  ).toHaveCount(replies, { timeout: 10_000 });
}

/** Ask the mock agent to replace `old` with `replacement` on the page, and
 * wait for a reply holding `reply`. */
async function askToEdit(
  page: Page,
  old: string,
  replacement: string,
  reply: string,
): Promise<void> {
  const panel = page.getByTestId('ai-panel');
  await panel
    .getByLabel('Message the assistant')
    .fill(`edit "${old}" to "${replacement}" in ${PAGE}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 10_000,
  });
}

/** A new paragraph at the end of the line holding `after`, typed as `text`. */
async function typeAfter(page: Page, after: string, text: string): Promise<void> {
  await page.getByTestId('markdown-editor').getByText(after).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test('an agent append during a turn shows on the open page and survives the next save', async ({
  page,
}) => {
  // Wide enough for the page and the assistant beside the sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  // The clock the stamps are read from does not move: every write after the
  // first lands on the same modifiedAt.
  expect(await page.evaluate(() => new Date().toISOString())).toBe(
    new Date(VAULT_TODAY).toISOString(),
  );
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await openSchedule(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  const editor = page.getByTestId('markdown-editor');

  // Typed, and asked about within the debounce: the turn lands the save
  // first, so the agent appends to what is on screen.
  await typeAfter(page, 'We ship on Thursdays', 'Typed before asking.');
  await askToAppend(page, 'Agent line one.', 1);

  await expect(editor.getByText('Agent line one.')).toBeVisible({ timeout: 10_000 });
  await expect(editor.getByText('Typed before asking.')).toBeVisible();
  await expect(page.getByTestId('external-change-banner')).toHaveCount(0);
  await expect.poll(() => readMockFile(page, PAGE)).toContain('Typed before asking.');
  await expect.poll(() => readMockFile(page, PAGE)).toContain('Agent line one.');

  // The next save writes the page as it now stands, the agent's line in it.
  await typeAfter(page, 'Agent line one.', 'Typed after the agent.');
  await expect.poll(() => readMockFile(page, PAGE)).toContain('Typed after the agent.');
  expect(await readMockFile(page, PAGE)).toContain('Agent line one.');
  expect(await readMockFile(page, PAGE)).toContain('Typed before asking.');

  // A second append, on a stamp that can no longer move.
  await askToAppend(page, 'Agent line two.', 2);
  await expect(editor.getByText('Agent line two.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('external-change-banner')).toHaveCount(0);
  await typeAfter(page, 'Agent line two.', 'Last words.');
  await expect.poll(() => readMockFile(page, PAGE)).toContain('Last words.');
  const saved = await readMockFile(page, PAGE);
  for (const line of [
    'Typed before asking.',
    'Agent line one.',
    'Typed after the agent.',
    'Agent line two.',
  ]) {
    expect(saved).toContain(line);
  }
});

test('an agent edit replaces only the quoted text on the open page, and an ambiguous quote changes nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const body = [
    '# How we schedule',
    '',
    'We ship on Thursdays, after the freeze.',
    'Thursdays are quiet.',
    '',
  ].join('\n');
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, body]);
  await openSchedule(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  const editor = page.getByTestId('markdown-editor');

  // A unique quote lands in place, and the open page shows it.
  await askToEdit(page, 'after the freeze', 'after the Wednesday freeze', `I edited ${PAGE}.`);
  await expect(editor.getByText('We ship on Thursdays, after the Wednesday freeze.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('external-change-banner')).toHaveCount(0);
  await expect
    .poll(() => readMockFile(page, PAGE))
    .toContain('We ship on Thursdays, after the Wednesday freeze.');
  expect(await readMockFile(page, PAGE)).toContain('Thursdays are quiet.');

  // A quote that appears twice is refused with its listing, the card says
  // the call failed, and not a byte moves.
  const before = await readMockFile(page, PAGE);
  await askToEdit(page, 'Thursdays', 'Fridays', 'appears 2 times');
  await expect(
    page.locator('[data-testid="action-card"][data-tool="edit_note"][data-failed="true"]'),
  ).toHaveCount(1);
  expect(await readMockFile(page, PAGE)).toBe(before);
  await expect(editor.getByText('Thursdays are quiet.')).toBeVisible();
});
