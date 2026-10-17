import { expect, test, type Page } from '@playwright/test';
import { boot, openAssistantPanel } from './boot';

/**
 * A run commits only what it wrote (M58.3, CV-34), in the browser.
 *
 * The person is typing in one note while a turn appends to two others, and
 * that third note is already modified. When the turn ends, its own commit
 * holds exactly the two notes it wrote, the third stays the person's, the
 * reply's footer says what changed, and View diff opens the run's commit
 * rather than the working tree, which that commit has just made clean.
 *
 * Through the browser-mode mock agent's write script chained with " then "
 * (src/agent/mockAgent.ts), and the mock repository's run commit
 * (src/lib/mockGit.ts `settleMockRun`), which `window.__cerebroMockGit`
 * exposes.
 */

const MINE = 'delivery/how-we-schedule.md';
const ONE = 'delivery/turn-one.md';
const TWO = 'delivery/turn-two.md';

// No "inbox", "organize" or "risk" in the pages or the ask: the mock agent
// picks its script by keyword.
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');

interface MockGitView {
  commits: { hash: string; shortHash: string; changes: { files: { path: string }[] } | null }[];
  modified: { path: string }[];
}

const mockGit = (page: Page): Promise<MockGitView> =>
  page.evaluate(() => {
    const git = (window as unknown as { __cerebroMockGit: MockGitView }).__cerebroMockGit;
    return JSON.parse(JSON.stringify(git)) as MockGitView;
  });

test('a turn commits exactly the two notes it wrote, and View diff opens its commit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.evaluate(
    ([mine, one, two, body]) => {
      const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
      fs.set(mine, body);
      fs.set(one, '# Turn one\n');
      fs.set(two, '# Turn two\n');
      const git = (
        window as unknown as {
          __cerebroMockGit: { modified: { path: string; status: string; staged: boolean }[] };
        }
      ).__cerebroMockGit;
      git.modified = [{ path: mine, status: 'modified', staged: false }];
    },
    [MINE, ONE, TWO, BODY],
  );
  const before = (await mockGit(page)).commits.length;

  // The person's note, open and being typed in.
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed while the turn runs.');

  // The turn: two appends, chained.
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  await panel
    .getByLabel('Message the assistant')
    .fill(`append "First line." to ${ONE} then append "Second line." to ${TWO}`);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: `I appended that to ${ONE} and ${TWO}.` }),
  ).toHaveCount(1, { timeout: 10_000 });

  // The footer reads what the commit did.
  const footer = panel.getByTestId('turn-changeset');
  await expect(footer).toContainText('Changed 2 files', { timeout: 10_000 });
  await expect(footer.getByTestId('turn-changeset-file')).toHaveCount(2);

  // The run's commit holds exactly its two notes; the third stays modified.
  const git = await mockGit(page);
  expect(git.commits.length).toBe(before + 1);
  const [commit] = git.commits;
  expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
  expect(commit.changes?.files.map((f) => f.path)).toEqual([ONE, TWO]);
  expect(git.modified.map((f) => f.path)).toEqual([MINE]);

  // View diff opens the run's commit, not the clean working tree.
  await footer.getByTestId('turn-changeset-view-diff').click();
  const diff = page.getByTestId('inline-diff');
  await expect(diff).toBeVisible({ timeout: 10_000 });
  await expect(diff).toContainText(commit.shortHash);
  await expect(diff).toContainText('First line.');
  await expect(diff).not.toContainText('No uncommitted changes to this note.');
});

test('an ordinary append cannot change a mail digest or create a commit', async ({
  page,
}, info) => {
  await boot(page);
  await page.evaluate(() =>
    window.__cerebroMockFs.set('sources/mail/synthetic.md', '# Synthetic header\n'),
  );
  const before = (await mockGit(page)).commits.length;
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await panel
    .getByLabel('Message the assistant')
    .fill('append "Reviewed." to sources/mail/synthetic.md');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'I could not append' }),
  ).toContainText('sources/mail/ holds mail digests, which only cache_source writes.', {
    timeout: 10_000,
  });
  await expect(panel.getByTestId('turn-changeset-kept-out')).toHaveCount(0);
  expect((await mockGit(page)).commits.length).toBe(before);
  expect(await page.evaluate(() => window.__cerebroMockFs.get('sources/mail/synthetic.md'))).toBe(
    '# Synthetic header\n',
  );
  await page.screenshot({
    path: info.outputPath('mail-append-refused.png'),
    animations: 'disabled',
  });
});

test('a restored mail-only turn names the file kept out of git', async ({ page }, info) => {
  // The native cache door and mockGit receipt tests prove withholding. Here
  // restore its recorded result through the real conversation store; ordinary
  // note writers are deliberately unable to manufacture a mail write.
  await page.addInitScript(() => {
    const thread = {
      id: 'mail-cache-result',
      title: 'Cache a thread header',
      usesDefaultTitle: false,
      sessionId: null,
      createdAt: '2026-07-20T12:00:00.000Z',
      archived: false,
      vault: '/demo-vault',
      messages: [
        { id: 'mail-ask', role: 'user', text: 'Cache this thread header.', tools: [] },
        {
          id: 'mail-result',
          role: 'assistant',
          text: 'The thread header is cached.',
          tools: [],
          changesets: [
            { state: 'nothing', run_id: 'mail-only', shell_unrecorded: false, kept_out_of_git: 1 },
          ],
        },
      ],
    };
    localStorage.setItem('cerebro.conversations', JSON.stringify([thread]));
    localStorage.setItem('cerebro.activeConversation', thread.id);
  });
  await boot(page);
  const before = (await mockGit(page)).commits.length;
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await expect(panel.getByTestId('turn-changeset-kept-out')).toHaveText(
    'Kept 1 mail file out of git.',
  );
  await expect(panel.getByTestId('turn-changeset-view-diff')).toHaveCount(0);
  expect((await mockGit(page)).commits.length).toBe(before);
  await page.screenshot({ path: info.outputPath('mail-kept-out.png'), animations: 'disabled' });
});
