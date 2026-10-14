import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { boot, seedBeforeBoot } from './boot';

/**
 * Threads come back from Claude Code's own session file (M56.3).
 *
 * The browser has no CLI and no file, so the mock backend holds what reading
 * a session back gives, seeded through `__cerebroSeedCliTranscript`. The
 * events are the two-turn golden Rust folded from the recorded fixtures
 * (conformance/transcript/two-turns.json), so this replays the fold's own
 * output through the panel.
 */

const SESSION = '00000000-0000-4000-8000-000000000001';

const golden = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../conformance/transcript/two-turns.json'),
    'utf8',
  ),
) as { session: { events: unknown[] } };

/** One stored thread, as conversations.ts writes it, open in the panel. */
async function storeThread(page: Page, thread: Record<string, unknown>): Promise<void> {
  await page.addInitScript((stored) => {
    window.localStorage.setItem('cerebro.conversations', JSON.stringify([stored]));
    window.localStorage.setItem('cerebro.activeConversation', String(stored.id));
  }, thread);
}

const thread = (over: Record<string, unknown>) => ({
  id: 'c-restored',
  title: 'Read a.md and b.md',
  usesDefaultTitle: false,
  sessionId: SESSION,
  messages: [],
  createdAt: '2026-07-20T12:00:00.000Z',
  archived: false,
  vault: '/demo-vault',
  ...over,
});

async function openPanel(page: Page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('agent transcript: a thread whose messages are gone rebuilds from its session', async ({
  page,
}) => {
  await storeThread(page, thread({}));
  await seedBeforeBoot(page, '__cerebroSeedCliTranscript', SESSION, {
    state: 'read',
    events: golden.session.events,
    lines: golden.session.events.length,
    unclassified: [],
  });
  await boot(page);
  const panel = await openPanel(page);

  const messages = panel.getByTestId('chat-message');
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(0)).toContainText('Read a.md and b.md with the Read tool');
  await expect(messages.nth(1)).toContainText('done');
  await expect(messages.nth(2)).toContainText('Now answer with the two words all done.');
  await expect(messages.nth(3)).toContainText('all done');
  // Both reads come back as the action cards they were.
  await expect(messages.nth(1).getByTestId('action-card')).toHaveCount(2);
  await expect(panel.getByTestId('transcript-unavailable')).toHaveCount(0);
  await expect(panel.getByLabel('Message the assistant')).toBeVisible();
});

test('agent transcript: an expired thread says Claude Code cleared it and offers a new one', async ({
  page,
}) => {
  await storeThread(page, thread({ updatedAt: '2026-05-01T12:00:00.000Z' }));
  await seedBeforeBoot(page, '__cerebroSeedCliTranscript', SESSION, {
    state: 'unavailable',
    reason: 'expired',
    retention_days: 30,
  });
  await boot(page);
  const panel = await openPanel(page);

  const notice = panel.getByTestId('transcript-unavailable');
  await expect(notice).toHaveAttribute('data-reason', 'expired');
  await expect(notice).toContainText('Cleared by Claude Code');
  await expect(notice).toContainText('30 days');
  // Never an empty thread with a composer whose send would fail.
  await expect(panel.getByTestId('thread-blocked')).toContainText(
    "Claude Code no longer has this conversation, so it can't continue here.",
  );
  await expect(panel.getByLabel('Message the assistant')).toHaveCount(0);

  await panel.getByTestId('thread-start-new').click();
  await expect(panel.getByTestId('thread-blocked')).toHaveCount(0);
  await expect(panel.getByTestId('transcript-unavailable')).toHaveCount(0);
  await expect(panel.getByLabel('Message the assistant')).toBeVisible();
  await expect(panel.getByTestId('chat-message')).toHaveCount(0);
});

test('agent transcript: a first turn stores a UUID session and the vault on its thread', async ({
  page,
}) => {
  await boot(page);
  const panel = await openPanel(page);
  await panel.getByLabel('Message the assistant').fill('What is at risk right now?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const stored = JSON.parse(window.localStorage.getItem('cerebro.conversations') ?? '[]') as {
          sessionId: string | null;
          vault?: string;
          messages: unknown[];
        }[];
        const used = stored.find((c) => c.messages.length > 0);
        return used === undefined ? null : { sessionId: used.sessionId, vault: used.vault };
      }),
    )
    .toEqual({
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      vault: '/demo-vault',
    });
});
