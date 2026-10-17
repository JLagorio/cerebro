import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile, openDestination } from './boot';

/**
 * The AI block survives being written (M53.9).
 *
 * MEASURED in Chromium before this (macro reference 03-editor.md, section 8):
 * a save wrote the block's chrome — the question run into the
 * "Answer"/"Recompute" label in one paragraph, its type and props gone — a
 * save inside the unmount flush dropped the block, and the question field a
 * `/` insert opened was blurred shut before anyone could type into it.
 * Asserted against the FILE, and against the page after it is opened
 * again from that file, because a block that looks right and does not survive
 * being written is a rendering, not a block.
 */

const PAGE = 'delivery/how-we-schedule.md';

// No "inbox", "organize" or "risk" anywhere on the page or in the question:
// the mock agent picks its script by keyword, and those would answer with a
// filing proposal or a risk summary instead of its plain reply.
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');
const QUESTION = 'What does this page decide?';
/** The start of the mock agent's plain reply (src/agent/mockAgent.ts). */
const ANSWER = 'This vault tracks work as typed markdown';
/** An answer from an earlier day, and a note written after it — which Recompute must leave alone. */
const OLD_ANSWER = 'The freeze moves to Wednesday.';
const NOTE = 'My own note, typed after the answer.';

/** Open the page from the sidebar, expanding its collection only if it is folded. */
async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

/**
 * Put the caret at the end of a paragraph that wraps: clicked at the right end
 * of its last line, because End only reaches the end of the line it is on.
 */
async function caretToEndOf(paragraph: Locator): Promise<void> {
  const box = await paragraph.boundingBox();
  if (box === null) throw new Error('the paragraph is not on screen');
  await paragraph.click({ position: { x: box.width - 2, y: box.height - 4 } });
  await paragraph.page().keyboard.press('End');
}

test('an AI block asked from the / menu is written as its carrier and opens again as itself', async ({
  page,
}) => {
  await boot(page);
  // Written onto a page that already exists: the mock disk reseeds on reload,
  // so "opened again" is leaving the page and coming back, never a reload.
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await openSchedule(page);

  const editor = page.getByTestId('markdown-editor');
  await editor.getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/AI block');
  await page.getByText('A standing question', { exact: false }).first().click();

  // The field is open and holds the caret: typing lands in it, not the page.
  const field = page.getByTestId('ai-block-prompt-input');
  await expect(field).toBeFocused();
  await page.keyboard.type(QUESTION);
  await expect(field).toHaveValue(QUESTION);
  await page.keyboard.press('Enter');

  await expect(editor.getByText(ANSWER, { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ai-block-prompt')).toHaveText(QUESTION);
  await expect(page.getByTestId('ai-block-run')).toHaveText('Recompute');

  // A click on the question opens it WITH the caret, so the next keystroke
  // edits it. Escape puts the question back as it was.
  await page.getByTestId('ai-block-prompt').click();
  await expect(field).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' Really?');
  await expect(field).toHaveValue(`${QUESTION} Really?`);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ai-block-prompt')).toHaveText(QUESTION);

  // Saved as the carrier: the question and the day on the opening line, the
  // answer under it as ordinary markdown, and none of the block's chrome.
  // The clock is pinned (boot), so the day is the vault's.
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 6_000 })
    .toContain(`:::ai{prompt="${QUESTION}" generated="2026-07-28"}`);
  const saved = await readMockFile(page, PAGE);
  expect(saved).toMatch(
    /^:::ai\{prompt="What does this page decide\?" generated="2026-07-28"\}\nThis vault tracks work as typed markdown[^\n]*\n:::$/m,
  );
  expect(saved).not.toContain('Recompute');
  expect(saved).not.toContain('Answered');

  // Edit the answer, then leave at once, inside the save debounce: the write
  // that lands is normally the unmount flush's, where nothing renders. (Not
  // always — the debounce can still win the race; MarkdownEditor.test.tsx
  // holds the flush path itself.)
  await caretToEndOf(editor.getByText(ANSWER, { exact: false }));
  await page.keyboard.type(' Checked by hand.');
  await openDestination(page, 'Home');
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 6_000 })
    .toContain('Checked by hand.');
  const flushed = await readMockFile(page, PAGE);
  expect(flushed).toContain(`:::ai{prompt="${QUESTION}" generated="2026-07-28"}`);
  expect(flushed).not.toContain('Recompute');

  // Opened again from the file: the same block, its question, its answer.
  await openSchedule(page);
  await expect(page.getByTestId('ai-block-prompt')).toHaveText(QUESTION, { timeout: 10_000 });
  await expect(page.getByTestId('ai-block-run')).toHaveText('Recompute');
  await expect(editor.getByText('Checked by hand.', { exact: false })).toBeVisible();
  await expect(editor.getByText(ANSWER, { exact: false })).toBeVisible();
  // Opening it wrote nothing back: the round trip is byte-stable.
  await page.waitForTimeout(1200);
  expect(await readMockFile(page, PAGE)).toBe(flushed);
});

/*
 * The answer is the block's children, and BlockNote's Enter makes a sibling of
 * the block it splits: a note started after the answer landed INSIDE the
 * block, and the next Recompute, which replaces every child, took it.
 *
 * Seeded with an answer of its own because the mock agent's plain reply says
 * "Inbox", and asked again over that, it answers with its filing script, which
 * opens the Inbox.
 */
test('Enter at the end of an answer starts a paragraph after the block, and Recompute keeps it', async ({
  page,
}) => {
  await boot(page);
  const md = `${BODY}\n:::ai{prompt="${QUESTION}" generated="2026-07-20"}\n${OLD_ANSWER}\n:::\n`;
  await page.evaluate(([path, text]) => window.__cerebroMockFs.set(path, text), [PAGE, md]);
  await openSchedule(page);
  const editor = page.getByTestId('markdown-editor');

  // An open `/` menu at the end of the answer keeps its Enter: the key picks
  // the item — Paragraph, which under a block with words in it adds a new one
  // — and the caret lands in that paragraph, inside the answer. Had the Enter
  // reached the editor too, BlockNote would have lifted the empty paragraph
  // out of the block.
  await caretToEndOf(editor.getByText(OLD_ANSWER));
  await page.keyboard.type('/Paragraph');
  await expect(page.getByText('The body of your document')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor.getByText('/Paragraph')).toHaveCount(0);
  await page.keyboard.type('Confirmed.');

  // And Enter at the end of the answer's last block leaves the block.
  await page.keyboard.press('Enter');
  await page.keyboard.type(NOTE);
  const answered = md.replace(OLD_ANSWER, `${OLD_ANSWER}\n\nConfirmed.`);
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 6_000 })
    .toBe(`${answered}\n${NOTE}\n`);

  // Recompute replaces the answer, and the note after the block stays — on
  // screen and on disk.
  await page.getByTestId('ai-block-run').click();
  await expect.poll(() => readMockFile(page, PAGE), { timeout: 10_000 }).not.toContain(OLD_ANSWER);
  const recomputed = await readMockFile(page, PAGE);
  expect(recomputed).toContain(`:::ai{prompt="${QUESTION}" generated="2026-07-28"}\n${ANSWER}`);
  expect(recomputed).toMatch(/\n:::\n\nMy own note, typed after the answer\.\n$/);
  await expect(editor.getByText(NOTE)).toBeVisible();
  await expect(editor.getByText(ANSWER, { exact: false })).toBeVisible();
});
