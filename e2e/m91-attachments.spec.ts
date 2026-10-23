import { expect, test, type Page } from '@playwright/test';
import { askAssistant, assistantSettled, boot, openAssistantPanel } from './boot';

/**
 * Composer attachments (M91.15, M91.17): a file dropped on the composer from
 * outside the vault waits on it as a chip, and the send copies it into
 * attachments/ through the human attachment door (CV-56) before the turn
 * goes, so the turn's context names it by its vault path. The send's toast
 * offers one Undo, which moves the new copy to the vault's Trash (CV-37).
 * The drop is the OS router's mock (`window.__cerebroMockDrop`).
 */

const BRIEF = '/outside/Launch brief.pdf';
const COPY = 'attachments/Launch brief.pdf';

async function dropOnComposer(page: Page) {
  const composer = page.getByTestId('ai-panel').getByTestId('chat-composer');
  const box = await composer.boundingBox();
  if (box === null) throw new Error('the composer has no bounds');
  await page.evaluate(
    ({ at, path }) => window.__cerebroMockDrop({ at, files: [{ path, base64: 'JVBERi0xLjcK' }] }),
    { at: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, path: BRIEF },
  );
}

const disk = (page: Page) => page.evaluate(() => [...window.__cerebroMockFs.keys()]);

test('a file dropped on the composer waits as a chip, is copied in on send, and one Undo moves the copy to the Trash', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');

  // Dropped: a chip on the composer, waiting, and nothing written yet.
  await dropOnComposer(page);
  const files = panel.getByRole('list', { name: 'Attached files', exact: true });
  const chip = files.getByTestId('composer-attachment');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('data-state', 'idle');
  await expect(chip).toContainText('Launch brief.pdf');
  await expect(chip).toContainText('PDF · copied in when you send');
  await expect(
    chip.getByRole('button', { name: 'Remove Launch brief.pdf from context', exact: true }),
  ).toBeVisible();
  expect(await disk(page)).not.toContain(COPY);

  // Sent: copied in by the person's own door, before the run, and the chip
  // now names the copy in the vault, which the turn's context carries.
  await askAssistant(page, 'What does the brief say?');
  await expect(chip).toHaveAttribute('data-state', 'done');
  await expect(chip).toHaveAttribute('data-path', COPY);
  await expect.poll(() => disk(page)).toContain(COPY);
  const copied = await page.evaluate(
    (path) => window.__cerebroMockWrites.filter((write) => write.path === path),
    COPY,
  );
  expect(copied).toMatchObject([{ kind: 'vault.create', actor: 'human:me' }]);
  await assistantSettled(page, 1);
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]').last()).toHaveText(
    'What does the brief say?',
  );
  await expect(chip).toHaveAttribute('data-path', COPY);

  // One Undo: the copy goes to the vault's Trash, and its chip goes with it.
  const toasts = page.getByTestId('toast-host');
  await expect(toasts).toContainText('Added 1 file to attachments/');
  await toasts.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toasts).toContainText('Undid: Added 1 file to attachments/');
  await expect.poll(() => disk(page)).not.toContain(COPY);
  expect(
    (await disk(page)).filter((path) =>
      /^\.trash\/[^/]+\/attachments\/Launch brief\.pdf$/.test(path),
    ),
  ).toHaveLength(1);
  await expect(chip).toHaveCount(0);
});
