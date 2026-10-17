import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, openAssistantPanel } from './boot';

/**
 * An agent's edit lands in the open page in place (M55.6).
 *
 * Before, an announced write remounted the page: the caret, the undo history
 * and every node view went, and a page with unsaved typing got an all-or-
 * nothing question. Now the write is applied as edits to the blocks it
 * changed, as its own undo step, and merged with what was typed; only a block
 * both changed raises a choice.
 *
 * Through the mock agent's edit script and its write gate (`boot.ts`
 * declares `__cerebroAgentWriteGate`): the spec asks, the run waits at its
 * write, the spec puts the caret or types, and then lets the write land.
 */

const PAGE = 'delivery/how-we-schedule.md';
const FIRST = 'We ship on Thursdays, after the freeze.';
const EDITED = 'We ship on Thursdays, after the Wednesday freeze.';
const SECOND = 'Releases go out at noon.';
// No "inbox", "organize" or "risk" anywhere on the page or in the ask: the
// mock agent picks its script by keyword.
const BODY = ['# How we schedule', '', FIRST, '', SECOND, ''].join('\n');

/** Hold every agent write until `openWrites`. */
async function holdWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seam = window as unknown as { __openAgentWrites?: () => void };
    window.__cerebroAgentWriteGate = new Promise<void>((resolve) => {
      seam.__openAgentWrites = resolve;
    });
  });
}

async function openWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __openAgentWrites?: () => void }).__openAgentWrites?.();
    delete window.__cerebroAgentWriteGate;
  });
}

/** Boot, open the page with BODY on disk, and show the assistant. */
async function openSchedule(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('markdown-editor').getByText(SECOND)).toBeVisible();
  await openAssistantPanel(page);
  await expect(page.getByTestId('ai-panel')).toBeVisible();
}

/** Ask for the edit with writes held, and wait until the run reaches its write. */
async function askHeld(page: Page): Promise<void> {
  await holdWrites(page);
  const panel = page.getByTestId('ai-panel');
  await panel
    .getByLabel('Message the assistant')
    .fill(`edit "after the freeze" to "after the Wednesday freeze" in ${PAGE}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.locator('[data-testid="action-card"][data-tool="edit_note"]').first(),
  ).toBeAttached({ timeout: 10_000 });
}

async function replied(page: Page): Promise<void> {
  await expect(
    page
      .getByTestId('ai-panel')
      .getByTestId('chat-message')
      .filter({ hasText: `I edited ${PAGE}.` }),
  ).toHaveCount(1, { timeout: 10_000 });
}

/** The caret at the end of the paragraph holding `text`. macOS has no End
 * for a line (it scrolls the page), so there the line's end is ⌘→. */
async function caretAtEnd(page: Page, text: string): Promise<void> {
  await page.getByTestId('markdown-editor').getByText(text).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
}

test('an edit lands in place: the editor stays, the caret stays, and ⌘Z undoes only it', async ({
  page,
}) => {
  await openSchedule(page);
  await askHeld(page);
  await caretAtEnd(page, SECOND);
  const surface = await page
    .getByTestId('markdown-editor')
    .locator('[contenteditable="true"]')
    .elementHandle();
  expect(surface).not.toBeNull();

  await openWrites(page);
  await replied(page);
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByText(EDITED)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('merge-choices')).toHaveCount(0);

  // The same editor, not a new one.
  expect(await surface!.evaluate((el) => el.isConnected)).toBe(true);
  // The caret where it was: the end of the second paragraph.
  const caret = await page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.focusNode ?? null;
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    return {
      block: element?.closest('.bn-block-content')?.textContent ?? null,
      atEnd: selection?.isCollapsed === true && selection.focusOffset === node?.textContent?.length,
    };
  });
  expect(caret).toEqual({ block: SECOND, atEnd: true });

  // ⌘Z takes back the agent's edit, and only it; the undo is saved.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.getByText(FIRST)).toBeVisible();
  await expect(editor.getByText(SECOND)).toBeVisible();
  await page.keyboard.type(' Typed after.');
  await expect.poll(() => readMockFile(page, PAGE)).toContain(`${SECOND} Typed after.`);
  const saved = await readMockFile(page, PAGE);
  expect(saved).toContain(FIRST);
  expect(saved).not.toContain('Wednesday');
});

test('typing elsewhere inside the debounce merges with the edit, with no choice', async ({
  page,
}) => {
  await openSchedule(page);
  await askHeld(page);
  await caretAtEnd(page, SECOND);
  await page.keyboard.type(' Typed by me.');
  await openWrites(page);
  await replied(page);

  await expect.poll(() => readMockFile(page, PAGE)).toContain(`${SECOND} Typed by me.`);
  await expect.poll(() => readMockFile(page, PAGE)).toContain(EDITED);
  await expect(page.getByTestId('merge-choices')).toHaveCount(0);
  await expect(page.getByTestId('markdown-editor').getByText(EDITED)).toBeVisible();
});

test('typing in the paragraph the agent edits asks, and Keep yours writes yours', async ({
  page,
}) => {
  await openSchedule(page);
  await askHeld(page);
  await caretAtEnd(page, FIRST);
  await page.keyboard.type(' Mine.');
  await openWrites(page);
  await replied(page);

  await expect(page.getByTestId('merge-choice')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByRole('group', { name: 'Choose a version' })).toBeVisible();
  // Nothing saves while the choice is open: the disk keeps the agent's text.
  expect(await readMockFile(page, PAGE)).toContain(EDITED);
  await page.waitForTimeout(800);
  expect(await readMockFile(page, PAGE)).toContain(EDITED);

  await page.getByTestId('merge-keep-mine').click();
  await expect(page.getByTestId('merge-choices')).toHaveCount(0);
  await expect.poll(() => readMockFile(page, PAGE)).toContain(`${FIRST} Mine.`);
  expect(await readMockFile(page, PAGE)).not.toContain('Wednesday');
});
