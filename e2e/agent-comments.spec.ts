import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Agents comment by quote (M70.3): comment_on_note, reply_to_comment and
 * resolve_comment write the page's sidecar, never the page.
 *
 * Through the browser-mode mock agent's comment scripts (src/agent/mockAgent.ts),
 * whose calls go through `agentComment`, `agentReply` and `agentResolve` on
 * the mock disk, in Rust's order and words. This reads the mock fs, not the
 * Comments tab: the sidecar is the record, and the page's bytes are the proof
 * nothing else moved.
 */

const PAGE = 'records/decisions/dec-conflict-resolution-is-manual.md';
const SIDECAR = `.comments/${PAGE}.json`;

interface Sidecar {
  threads: {
    anchor?: { quote: string; occurrence: number };
    resolved?: { by: string };
    comments: { id: string; author: string; body: string }[];
  }[];
}

async function hasSidecar(page: Page): Promise<boolean> {
  return page.evaluate((p) => window.__cerebroMockFs.has(p), SIDECAR);
}

async function sidecar(page: Page): Promise<Sidecar> {
  return JSON.parse(await readMockFile(page, SIDECAR)) as Sidecar;
}

/** Boot and show the assistant. */
async function openAssistant(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();
}

/** Send `message`, and wait until a reply holds all of `done` (the reply
 * streams, so its last words are what say it is whole). */
async function ask(page: Page, message: string, done: RegExp): Promise<string> {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(message);
  await panel.getByRole('button', { name: 'Send' }).click();
  const answer = panel.getByTestId('chat-message').filter({ hasText: done }).last();
  await expect(answer).toBeVisible({ timeout: 10_000 });
  return (await answer.textContent()) ?? '';
}

const POSTED = /as thread [0-9a-f]{16}\./;
const NOTHING = /Nothing was posted\./;

test('a comment on a quoted passage lands in the sidecar, and the page keeps its bytes', async ({
  page,
}) => {
  await openAssistant(page);
  const before = await readMockFile(page, PAGE);
  await ask(page, `comment "Detect the conflict" on ${PAGE}: Who is the crew lead here?`, POSTED);
  const file = await sidecar(page);
  expect(file.threads).toHaveLength(1);
  expect(file.threads[0].anchor).toMatchObject({ quote: 'Detect the conflict', occurrence: 1 });
  expect(file.threads[0].comments[0]).toMatchObject({
    author: 'claude-code',
    body: 'Who is the crew lead here?',
  });
  expect(await readMockFile(page, PAGE)).toBe(before);
});

test('an ambiguous quote is refused with both appearances, and nothing is posted', async ({
  page,
}) => {
  await openAssistant(page);
  const before = await readMockFile(page, PAGE);
  const reply = await ask(page, `comment "conflict" on ${PAGE}: Which one?`, NOTHING);
  expect(reply).toContain(`I could not comment on ${PAGE}`);
  expect(reply).toContain('The quoted text appears 2 times.');
  // The listing's two numbered lines (the panel draws them as a list), each
  // with its body line and context.
  expect(reply).toContain('line 12: "…venting facts.');
  expect(reply).toContain('line 16: "…ic will rise when this ships, because conflicts');
  expect(reply).toContain('Nothing was posted.');
  expect(await hasSidecar(page)).toBe(false);
  expect(await readMockFile(page, PAGE)).toBe(before);
});

test('a reply and a resolve address the thread by the id the comment named', async ({ page }) => {
  await openAssistant(page);
  const before = await readMockFile(page, PAGE);
  const posted = await ask(page, `comment on ${PAGE}: Is this still the plan?`, POSTED);
  expect(posted).toContain(`I commented on ${PAGE} as thread`);
  const id = /as thread ([0-9a-f]{16})/.exec(posted)?.[1];
  expect(id).toBeDefined();
  await ask(
    page,
    `reply to ${id} on ${PAGE}: Yes, until the sync work ships.`,
    new RegExp(`I replied in ${id} on .+\\.md\\.`),
  );
  await ask(
    page,
    `resolve ${id} on ${PAGE}: Confirmed with the crew leads.`,
    new RegExp(`I resolved ${id} on .+\\.md\\.`),
  );
  const thread = (await sidecar(page)).threads[0];
  expect(thread.comments.map((c) => c.body)).toEqual([
    'Is this still the plan?',
    'Yes, until the sync work ships.',
    'Confirmed with the crew leads.',
  ]);
  expect(thread.resolved).toMatchObject({ by: 'claude-code' });
  // Resolved, the thread refuses another reply, and the page never moved.
  const refused = await ask(page, `reply to ${id} on ${PAGE}: One more thing.`, NOTHING);
  expect(refused).toContain(`I could not reply in ${id}`);
  expect(refused).toContain('is resolved');
  expect((await sidecar(page)).threads[0].comments).toHaveLength(3);
  expect(await readMockFile(page, PAGE)).toBe(before);
});
