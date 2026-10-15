import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Page comments end to end (M70.2b), on the mock backend: a selection takes a
 * comment through the toolbar, the thread lives in the page's sidecar
 * (`.comments/<page>.json`), the page's bytes never change for it, and the
 * Comments tab walks a thread through reply, resolve, reopen and delete.
 * Chromium only: the packaged WKWebView check is the owner's.
 */

const DECISION = 'records/decisions/dec-offline-window-72h.md';
const DECISION_TITLE = 'Offline window is 72 hours, not indefinite';
const GUARANTEE = 'Guarantee 72 hours.';
const QUESTION = 'Is 72 enough for rural crews?';

const SCHEDULE = 'delivery/how-we-schedule.md';
const FREEZE = 'We ship on Thursdays, after the freeze.';
const SCHEDULE_SEED = [
  '# How we schedule',
  '',
  'Owner: TBD.',
  '',
  'Deadline: TBD.',
  '',
  FREEZE,
  '',
].join('\n');

const sidecarOf = (path: string) => `.comments/${path}.json`;

interface Sidecar {
  threads: {
    anchor?: { quote: string };
    resolved?: { at: string; by: string };
    deleted?: { at: string; by: string };
    comments: { id: string; body: string; deleted?: { at: string; by: string } }[];
  }[];
}
const readSidecar = async (page: Page, path: string): Promise<Sidecar> =>
  JSON.parse(await readMockFile(page, sidecarOf(path))) as Sidecar;

/** A record, found by its title, opened as a page. */
async function openRecordPage(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await page.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}

/** The schedule doc, from the sidebar, expanding its collection only if folded. */
async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await expect(async () => {
    await node.getByRole('button', { name: 'How we schedule' }).click();
    await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
}

/** Home, then Back (⌘[): the page is mounted afresh and reads its threads again. */
async function homeAndBack(page: Page): Promise<void> {
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByTestId('markdown-editor')).toHaveCount(0);
  // Not while typing: ⌘[ is outdent inside an editor.
  await page.locator('body').press('ControlOrMeta+BracketLeft');
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}

/** The side panel, on its Comments tab. */
async function showComments(page: Page): Promise<void> {
  if (!(await page.getByTestId('doc-side-panel').isVisible())) {
    await page.getByRole('button', { name: 'Show panel' }).click();
  }
  await page.getByTestId('doc-panel-tab-comments').click();
}

/** The paragraph holding `text`. */
const paragraph = (page: Page, text: string) =>
  page.getByTestId('markdown-editor').locator('.bn-block-content').filter({ hasText: text }).last();

const frame = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));

/** Select `length` characters with the keyboard, from the start of the
 * paragraph holding `text` (`fromEnd`: ending just before its final period).
 * macOS has no Home or End for a line, so there they are ⌘← and ⌘→. */
async function select(page: Page, text: string, length: number, fromEnd = false): Promise<void> {
  // Collapse any selection first, so its toolbar is not in the way.
  await page.keyboard.press('ArrowRight');
  // At the paragraph's top left: a click in its middle lands on a wrapped
  // line, whose start is not the paragraph's.
  await paragraph(page, text).click({ position: { x: 2, y: 4 } });
  const mac = process.platform === 'darwin';
  if (fromEnd) {
    await page.keyboard.press(mac ? 'Meta+ArrowRight' : 'End');
    // A frame between moves too: under load the ArrowLeft was lost and the
    // selection took the trailing period.
    await frame(page);
    await page.keyboard.press('ArrowLeft');
  } else {
    await page.keyboard.press(mac ? 'Meta+ArrowLeft' : 'Home');
  }
  await frame(page);
  for (let i = 0; i < length; i++) {
    await page.keyboard.press(fromEnd ? 'Shift+ArrowLeft' : 'Shift+ArrowRight');
    // One frame per key: ProseMirror reads the browser's selection on
    // `selectionchange`, and a burst of keys outruns it.
    await frame(page);
  }
}

/** Press the toolbar's Comment, write `body` and post it. */
async function comment(page: Page, body: string): Promise<void> {
  await page.getByTestId('selection-comment').click();
  const draft = page.getByTestId('comment-draft');
  await expect(draft).toBeVisible();
  await draft.getByTestId('comment-draft-submit-input').fill(body);
  await draft.getByTestId('comment-draft-submit').click();
  await expect(draft).toHaveCount(0);
}

const highlight = (page: Page) => page.getByTestId('markdown-editor').locator('.cb-comment');
const threadCard = (page: Page) => page.getByTestId('comment-thread');

/** Comment on "Guarantee 72 hours." on the decision page. */
async function commentOnGuarantee(page: Page): Promise<void> {
  await openRecordPage(page, DECISION_TITLE);
  await select(page, GUARANTEE, GUARANTEE.length);
  await comment(page, QUESTION);
}

test('a comment on a sentence shows a thread, lives in the sidecar, and leaves the page alone', async ({
  page,
}) => {
  await boot(page);
  const seed = await readMockFile(page, DECISION);
  await commentOnGuarantee(page);

  const onPage = page.getByTestId('comments-on-page');
  await expect(onPage.getByTestId('comment-thread')).toHaveCount(1);
  await expect(onPage.getByTestId('comment-quote')).toHaveText(GUARANTEE);
  await expect(onPage.getByText(QUESTION)).toBeVisible();
  await expect(highlight(page)).toHaveText(GUARANTEE);
  const sidecar = await readSidecar(page, DECISION);
  expect(sidecar.threads).toHaveLength(1);
  expect(sidecar.threads[0].anchor?.quote).toBe(GUARANTEE);
  expect(sidecar.threads[0].comments[0].body).toBe(QUESTION);
  // Past the save debounce, the page is the seed.
  await page.waitForTimeout(800);
  expect(await readMockFile(page, DECISION)).toBe(seed);

  // Home and back: the thread and its highlight are read back.
  await homeAndBack(page);
  await showComments(page);
  await expect(page.getByTestId('comments-on-page').getByText(QUESTION)).toBeVisible();
  await expect(highlight(page)).toHaveText(GUARANTEE);
  expect(await readMockFile(page, DECISION)).toBe(seed);
});

test('deleting the quoted sentence moves its thread to Discussion, quote and all', async ({
  page,
}) => {
  await boot(page);
  await commentOnGuarantee(page);
  await expect(highlight(page)).toHaveText(GUARANTEE);

  await select(page, GUARANTEE, GUARANTEE.length);
  await page.keyboard.press('Backspace');

  const discussion = page.getByTestId('comments-discussion');
  await expect(discussion.getByTestId('comment-thread')).toHaveCount(1);
  await expect(discussion.getByTestId('comment-quote')).toHaveText(GUARANTEE);
  await expect(discussion.getByTestId('comment-note')).toHaveText(
    'The text this comment was about is no longer on the page.',
  );
  await expect(page.getByTestId('comments-on-page')).toHaveCount(0);
  await expect(highlight(page)).toHaveCount(0);
  expect((await readSidecar(page, DECISION)).threads[0].anchor?.quote).toBe(GUARANTEE);
});

test('a thread is replied to, resolved, reopened and deleted, and the sidecar keeps the stamps', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(
    ([path, text]) => window.__cerebroMockFs.set(path, text),
    [SCHEDULE, SCHEDULE_SEED],
  );
  await openSchedule(page);
  await showComments(page);

  // A thread about the whole page.
  await page.getByTestId('discussion-submit-input').fill('Who owns the freeze calendar?');
  await page.getByTestId('discussion-submit').click();
  const discussion = page.getByTestId('comments-discussion');
  await expect(discussion.getByText('Who owns the freeze calendar?')).toBeVisible();

  // And one on the text, with a reply.
  await select(page, FREEZE, 'after the freeze'.length, true);
  await comment(page, 'Which freeze?');
  const inline = page.getByTestId('comments-on-page').getByTestId('comment-thread');
  await expect(inline).toHaveAttribute('data-anchor', 'after the freeze');
  await inline.getByTestId('comment-reply-submit-input').fill('The release freeze.');
  await inline.getByTestId('comment-reply-submit').click();
  await expect(inline.getByText('The release freeze.')).toBeVisible();

  // Resolved: into Resolved, and off the page.
  await inline.getByTestId('comment-resolve').click();
  const resolved = page.getByTestId('comments-resolved');
  await expect(resolved.getByTestId('comment-thread')).toHaveCount(1);
  await expect(highlight(page)).toHaveCount(0);

  // Reopened: back on the page.
  await resolved.getByTestId('comment-reopen').click();
  await expect(page.getByTestId('comments-on-page').getByTestId('comment-thread')).toHaveCount(1);
  await expect(highlight(page)).toHaveText('after the freeze');

  // The root deleted: a tombstone, and the reply stays.
  const reopened = page.getByTestId('comments-on-page').getByTestId('comment-thread');
  await reopened.getByTestId('comment').first().getByTestId('comment-delete').click();
  await reopened.getByTestId('comment-delete-confirm').click();
  await expect(reopened.getByTestId('comment-tombstone')).toHaveText('Comment deleted.');
  await expect(reopened.getByText('The release freeze.')).toBeVisible();

  // The thread deleted: gone from the tab.
  await reopened.getByTestId('comment-thread-delete').click();
  await expect(reopened.getByText('Delete this thread and its 1 comment?')).toBeVisible();
  await reopened.getByTestId('comment-thread-delete-confirm').click();
  await expect(page.getByTestId('comments-on-page')).toHaveCount(0);
  await expect(threadCard(page)).toHaveCount(1);

  const sidecar = await readSidecar(page, SCHEDULE);
  const gone = sidecar.threads.find((t) => t.anchor?.quote === 'after the freeze');
  expect(gone?.deleted?.by).toBe('human:owner');
  expect(gone?.comments.map((c) => [c.body, c.deleted?.by])).toEqual([
    ['', 'human:owner'],
    ['', 'human:owner'],
  ]);
  expect(gone?.resolved).toBeUndefined();
  expect(await readMockFile(page, SCHEDULE)).toBe(SCHEDULE_SEED);
});

test('a conflicted sidecar is unavailable, and a comment on it is refused without a write', async ({
  page,
}) => {
  await boot(page);
  const conflicted = '<<<<<<< HEAD\n{"format": 1, "threads": []}\n=======\n{}\n>>>>>>> theirs\n';
  await page.evaluate(
    ([path, text, sidecar, bytes]) => {
      window.__cerebroMockFs.set(path, text);
      window.__cerebroMockFs.set(sidecar, bytes);
    },
    [SCHEDULE, SCHEDULE_SEED, sidecarOf(SCHEDULE), conflicted],
  );
  await openSchedule(page);
  await showComments(page);
  await expect(page.getByTestId('section-unavailable')).toContainText(
    'unresolved merge conflict markers',
  );
  await expect(page.getByTestId('discussion-submit')).toHaveCount(0);

  await select(page, FREEZE, 'after the freeze'.length, true);
  await page.getByTestId('selection-comment').click();
  await expect(page.getByTestId('toast-host')).toContainText('merge conflict markers');
  await expect(page.getByTestId('comment-draft')).toHaveCount(0);
  expect(await readMockFile(page, sidecarOf(SCHEDULE))).toBe(conflicted);
});

test('a click on a highlight opens Comments on its thread', async ({ page }) => {
  await boot(page);
  await commentOnGuarantee(page);
  // Back to a page with nothing in focus, its panel on another tab.
  await homeAndBack(page);
  await page.getByTestId('doc-panel-tab-outline').click();
  await expect(page.getByTestId('comments-tab')).toHaveCount(0);

  await highlight(page).click();
  const card = page.getByTestId('comments-on-page').getByTestId('comment-thread');
  await expect(card).toHaveAttribute('data-focused', 'true');
  await expect(highlight(page)).toHaveClass(/cb-comment-active/);
});
