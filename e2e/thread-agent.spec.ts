import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile, showPagePanel } from './boot';

/**
 * An @agent in a page's comment thread (M70.4), on the mock backend: a
 * person's comment that names an agent posts a pending placeholder, authored
 * by the agent, and the agent's answer then takes its place in the same
 * thread. A deleted placeholder drops the answer; an agent's own comment, or
 * a reply that names nobody, asks nobody. The mock runs the person's text
 * with its @handle taken off, so "@release-scout wait for me" holds on
 * M57.5's script until `window.__cerebroReleaseMockRuns()`. Chromium only:
 * the real CLI turn is the owner's packaged check.
 */

const PAGE = 'records/decisions/dec-conflict-resolution-is-manual.md';
const TITLE = 'Conflicts are resolved by a person, not a rule';
const SIDECAR = `.comments/${PAGE}.json`;

interface Sidecar {
  threads: {
    comments: { id: string; author: string; body: string; state?: string; answers?: string }[];
  }[];
}

async function sidecar(page: Page): Promise<Sidecar> {
  return JSON.parse(await readMockFile(page, SIDECAR)) as Sidecar;
}

/** The decision, found by its title, opened as a page, showing its Comments. */
async function openDecisionComments(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(TITLE.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: TITLE }).first().click();
  await page.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
  await showPagePanel(page, 'Comments');
}

/** Start a discussion about the whole page; answers its thread card. */
async function discuss(page: Page, text: string): Promise<Locator> {
  await page.getByTestId('discussion-submit-input').fill(text);
  await page.getByTestId('discussion-submit').click();
  const thread = page
    .getByTestId('comments-discussion')
    .getByTestId('comment-thread')
    .filter({ hasText: text });
  await expect(thread).toHaveCount(1);
  return thread;
}

/** Let held runs go until `done` holds: a release before the run holds frees
 * nothing, so it is repeated. */
async function releaseUntil(page: Page, done: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.evaluate(() =>
      (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
    );
    await done();
  }).toPass({ timeout: 15_000 });
}

test('"@release-scout wait for me" posts a placeholder, then the answer in its place', async ({
  page,
}) => {
  await boot(page);
  const before = await readMockFile(page, PAGE);
  await openDecisionComments(page);
  const thread = await discuss(page, '@release-scout wait for me');

  const pending = thread.locator('[data-testid="comment"][data-state="pending"]');
  await expect(pending).toHaveCount(1);
  await expect(pending.getByTestId('comment-pending')).toHaveText('Release scout is answering…');
  const id = await pending.getAttribute('data-comment-id');
  expect(id).toMatch(/^[0-9a-f]{16}$/);

  const row = thread.locator(`[data-comment-id="${id}"]`);
  await releaseUntil(page, async () => {
    await expect(row).toHaveAttribute('data-state', 'answered', { timeout: 500 });
  });
  await expect(row).toContainText('Done waiting.');
  await expect(thread.getByTestId('comment')).toHaveCount(2);

  const file = await sidecar(page);
  const answer = file.threads.flatMap((t) => t.comments).find((c) => c.id === id);
  expect(answer).toMatchObject({
    author: 'process:release-scout',
    state: 'answered',
    body: 'Done waiting.',
  });
  expect(await readMockFile(page, PAGE)).toBe(before);
});

test('a deleted placeholder drops the answer', async ({ page }) => {
  await boot(page);
  await openDecisionComments(page);
  const thread = await discuss(page, '@release-scout wait for me');
  const pending = thread.locator('[data-testid="comment"][data-state="pending"]');
  await expect(pending).toHaveCount(1);
  const id = await pending.getAttribute('data-comment-id');

  await pending.getByLabel('Comment actions').click();
  await pending.getByTestId('comment-delete').click();
  await thread.getByTestId('comment-delete-confirm').click();
  await expect(thread.getByTestId('comment-tombstone')).toHaveCount(1);

  // Release, again and again for a while: a release before the run holds
  // frees nothing, and once it is freed it ends in milliseconds.
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() =>
      (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
    );
    await page.waitForTimeout(100);
  }
  const file = await sidecar(page);
  const placeholder = file.threads.flatMap((t) => t.comments).find((c) => c.id === id);
  expect(placeholder?.body).toBe('');
  expect(placeholder?.state).toBe('pending');
  await expect(thread.locator('[data-state="answered"]')).toHaveCount(0);
  await expect(thread.getByTestId('comment')).toHaveCount(1);
});

test('"@release-scout check this" ends answered in the same thread', async ({ page }) => {
  await boot(page);
  await openDecisionComments(page);
  const thread = await discuss(page, '@release-scout check this');
  const answered = thread.locator('[data-testid="comment"][data-state="answered"]');
  await expect(answered).toHaveCount(1, { timeout: 10_000 });
  await expect(thread.getByTestId('comment')).toHaveCount(2);
  const file = await sidecar(page);
  const answer = file.threads.flatMap((t) => t.comments).find((c) => c.state === 'answered');
  expect(answer?.author).toBe('process:release-scout');
  expect(answer?.body).not.toBe('');
});

test("an agent's reply naming @release-scout, and a plain human reply, start no turn", async ({
  page,
}) => {
  await boot(page);
  await openDecisionComments(page);
  const thread = await discuss(page, 'Who decides a conflict?');
  const threadId = (await sidecar(page)).threads[0].comments[0].id;

  // The person replies with no mention.
  if (await thread.getByRole('button', { name: 'Reply…', exact: true }).isVisible())
    await thread.getByRole('button', { name: 'Reply…', exact: true }).click();
  await thread.getByTestId('comment-reply-submit-input').fill('Thanks, that settles it.');
  await thread.getByTestId('comment-reply-submit').click();
  await expect(thread.getByText('Thanks, that settles it.')).toBeVisible();

  // An agent replies in the thread, naming release-scout (M70.3's reply
  // script, run as a schedule would run it, so the panel's own @addressing
  // stays out of it).
  await page.evaluate(
    async ([path, thread]) => {
      const run = (
        window as unknown as {
          __cerebroRunUnattended: (
            vault: string,
            run: { message: string; actor: string },
          ) => Promise<unknown>;
        }
      ).__cerebroRunUnattended;
      await run('/demo-vault', {
        message: `reply to ${thread} on ${path}: @release-scout please look`,
        actor: 'process:knowledge',
      });
    },
    [PAGE, threadId],
  );
  await expect(thread.getByText('@release-scout please look')).toBeVisible();

  await page.waitForTimeout(300);
  const comments = (await sidecar(page)).threads.flatMap((t) => t.comments);
  expect(comments.map((c) => c.author)).toEqual([
    'human:owner',
    'human:owner',
    'process:knowledge',
  ]);
  expect(comments.some((c) => c.state !== undefined || c.answers !== undefined)).toBe(false);
  await expect(page.locator('[data-testid="comment"][data-state="pending"]')).toHaveCount(0);
});
