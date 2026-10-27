import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import {
  askAssistant,
  assistantSettled,
  boot,
  openAssistantCanvas,
  readMockFile,
  seedBeforeBoot,
} from './boot';

/**
 * The rail's Changes card (M92.5, M92.12): what the conversation changed,
 * its turns' changesets summed file by file. A row's first action shows
 * where its file changed, in its turn's changeset in the canvas; its second
 * opens the page, or the diff of a page a turn deleted, and floats the
 * conversation first, since the canvas hides both. The runs of the
 * conversation's session that no reply holds come back from Cerebro's own
 * records through the heal (`conversation_changes`, which the browser's mock
 * reads from its fleet and repository), and a heal read that fails says so,
 * never that nothing changed (CV-05).
 */

const VAULT = join(dirname(fileURLToPath(import.meta.url)), '../demo-vault');
const SCHEDULE = 'delivery/how-we-schedule.md';
const MAP = 'strategy/systems-map.md';

const rail = (panel: Locator) =>
  panel.getByRole('region', { name: 'Conversation details', exact: true });
const toggle = (panel: Locator) =>
  panel.getByRole('button', { name: 'Conversation details', exact: true });
const changeRow = (changes: Locator, path: string) =>
  changes.locator(`[data-testid="rail-change"][data-path="${path}"]`);

/** A line count, "+a −b", in some text; null where it says none. */
const linesIn = (text: string | null): string | null => /\+\d+ −\d+/.exec(text ?? '')?.[0] ?? null;

test('a writing turn lists its files with counts, shows each in the canvas, and opens it outside', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  await askAssistant(page, `append "- call the vendor" to ${SCHEDULE}`);
  await assistantSettled(page, 1);

  // The file the turn changed, with the lines its turn's own changeset
  // counted, and the card's sum of them.
  const changes = rail(panel).getByTestId('rail-changes');
  await expect(changes).toHaveAttribute('data-state', 'ready');
  const row = changeRow(changes, SCHEDULE);
  await expect(row).toHaveAttribute('data-kind', 'modified');
  const file = panel
    .getByTestId('chat-scroll')
    .locator(`[data-slot="file-tree-file"][data-path="${SCHEDULE}"]`);
  const counted = linesIn(await file.textContent());
  expect(counted, 'the turn’s changeset counts the file').not.toBeNull();
  expect(linesIn(await row.textContent())).toBe(counted);
  await expect(changes.getByTestId('rail-changes-summary')).toHaveText(`${counted} across 1 turn`);
  await expect(changes).not.toContainText('+0 −0');

  // Its first action: the file's row in the turn's changeset, in the canvas.
  await row.getByRole('button', { name: /^Jump to where how-we-schedule\.md changed/ }).click();
  await expect.poll(() => file.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(file).toBeInViewport();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');

  // Its second: the page, which the canvas would hide, so it floats first.
  // (Its body is the lazy editor's, which a cold dev server builds slowly:
  // the page's own heading and the file on disk say which page and what
  // changed.)
  await row.getByRole('button', { name: 'Open how-we-schedule.md (leaves full screen)' }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  await expect(page.getByTestId('doc-page')).toContainText('How we schedule');
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
  expect(await readMockFile(page, SCHEDULE)).toContain('- call the vendor');
});

/** A commit runtime.db names a run for, as `__cerebroSeedGitHistory` takes
 *  it: its file, the bytes it held after (null for one it deleted), and the
 *  commit before it, which holds the bytes it changed. */
function history(
  run: string,
  path: string,
  before: string,
  after: string | null,
  [made, base]: [string, string],
) {
  return [
    {
      hash: made,
      message: after === null ? 'Retire the systems map' : 'Note the vendor call',
      author: 'Cerebro',
      date: 1_785_237_660,
      files: [{ path, status: after === null ? 'deleted' : 'modified' }],
      snapshots: { [path]: after },
      run: { runId: run, actor: 'process:assistant' },
    },
    {
      hash: base,
      message: 'Before the conversation',
      date: 1_785_150_000,
      files: [{ path, status: 'modified' }],
      snapshots: { [path]: before },
    },
  ];
}

test('a page a turn deleted opens the diff that deleted it, the conversation floated first', async ({
  page,
}) => {
  // The turn deleted the systems map, and the person since restored it from
  // the Trash: the page is back, and the diff at the turn's commit shows
  // what the turn removed.
  const run = '0000000000000000000000000092153a';
  const commit = '92153a92153a92153a92153a92153a92153a9215';
  const map = readFileSync(join(VAULT, MAP), 'utf8');
  const lines = map.replace(/\n$/, '').split('\n').length;
  await page.addInitScript(
    (stored) => {
      window.localStorage.setItem('cerebro.conversations', JSON.stringify([stored]));
      window.localStorage.setItem('cerebro.activeConversation', stored.id);
    },
    {
      id: 'm92-deleted',
      title: 'Retire the systems map',
      usesDefaultTitle: false,
      sessionId: null,
      createdAt: '2026-07-28T11:00:00.000Z',
      archived: false,
      vault: '/demo-vault',
      messages: [
        { id: 'm92-retire', role: 'user', text: 'Retire the systems map.', tools: [] },
        {
          id: 'm92-retired',
          role: 'assistant',
          text: 'The systems map is retired.',
          tools: [],
          changesets: [
            {
              state: 'committed',
              run_id: run,
              commit,
              files: [
                {
                  path: MAP,
                  previous_path: null,
                  kind: 'deleted',
                  additions: 0,
                  deletions: lines,
                  also_by: [],
                },
              ],
              additions: 0,
              deletions: lines,
              binary: 0,
              shell_unrecorded: false,
            },
          ],
        },
      ],
    },
  );
  await seedBeforeBoot(
    page,
    '__cerebroSeedGitHistory',
    history(run, MAP, map, null, [commit, '92153b92153b92153b92153b92153b92153b9215']),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);

  const changes = rail(panel).getByTestId('rail-changes');
  await expect(changes).toHaveAttribute('data-state', 'ready');
  const row = changeRow(changes, MAP);
  await expect(row).toHaveAttribute('data-kind', 'deleted');
  await expect(row).toContainText(`+0 −${lines}`);

  // A deleted file has no page to open, so its second action is its diff
  // at the commit that deleted it, floated out of the canvas first.
  await row
    .getByRole('button', { name: 'Open the diff of systems-map.md (leaves full screen)' })
    .click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  const diff = page.getByTestId('inline-diff');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText(commit.slice(0, 7));
  await expect(diff).toContainText('pieces talk to each other');
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
});

test('after a reload, an older turn’s changes come back through the heal, and a failed heal read is unavailable, never none', async ({
  page,
}) => {
  // A conversation whose stored copy lost its messages: they rebuild from its
  // session file, which holds no changeset. Its run is in the fleet, and the
  // commit runtime.db names for it is in the repository: the heal's to read.
  const session = '00000000-0000-4000-8000-000000092155';
  const run = '0000000000000000000000000092155a';
  const schedule = readFileSync(join(VAULT, SCHEDULE), 'utf8');
  const noted = `${schedule}\n- call the vendor\n`;
  await page.addInitScript(
    (stored) => {
      // Stored once: what the conversation holds after this survives the reload.
      if (window.localStorage.getItem('cerebro.conversations') !== null) return;
      window.localStorage.setItem('cerebro.conversations', JSON.stringify([stored]));
      window.localStorage.setItem('cerebro.activeConversation', stored.id);
    },
    {
      id: 'm92-healed',
      title: 'Schedule the vendor call',
      usesDefaultTitle: false,
      sessionId: session,
      createdAt: '2026-07-28T11:00:00.000Z',
      archived: false,
      vault: '/demo-vault',
      messages: [],
    },
  );
  const events = [
    {
      kind: 'UserPrompt',
      text: 'Note the vendor call in the schedule.',
      uuid: '00000000-0000-4000-8000-000000092156',
    },
    { kind: 'ModelChanged', model: 'claude-sonnet-5' },
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__append_to_note',
      tool_id: 'toolu_m92_heal_append',
      input: JSON.stringify({ path: SCHEDULE, content: '- call the vendor' }),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_m92_heal_append',
      output: `Appended to ${SCHEDULE}.`,
      is_error: false,
    },
    { kind: 'Text', message_id: 'msg_m92_heal', text: 'The vendor call is in the schedule.' },
    {
      kind: 'TurnEnded',
      stop_reason: 'end_turn',
      last_uuid: '00000000-0000-4000-8000-000000092157',
    },
  ];
  await seedBeforeBoot(page, '__cerebroSeedCliTranscript', session, {
    state: 'read',
    events,
    lines: events.length,
    unclassified: [],
  });
  await seedBeforeBoot(
    page,
    '__cerebroSeedFleet',
    [
      {
        run_id: run,
        actor: 'process:assistant',
        vault_id: 'demo',
        mode: 'attended',
        lane: 'agent',
        started_at: '2026-07-28T11:20:00Z',
        ended_at: '2026-07-28T11:21:00Z',
        outcome: 'succeeded',
        usage_state: 'exact',
        input_tokens: 9_210,
        output_tokens: 412,
        proposals_submitted: null,
        applied: null,
        rejected: null,
        parent_run_id: null,
        cause: null,
        cli_session_id: session,
      },
    ],
    {},
  );
  await seedBeforeBoot(
    page,
    '__cerebroSeedGitHistory',
    history(run, SCHEDULE, schedule, noted, [
      '92155a92155a92155a92155a92155a92155a9215',
      '92155b92155b92155b92155b92155b92155b9215',
    ]),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  let panel = await openAssistantCanvas(page);
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);

  // The older turn's file, read back from its commit: counted by git, with
  // nothing in the transcript to show it in, and who else edited it not
  // recorded (a commit read back from history cannot know).
  const healed = (changes: Locator) => changeRow(changes, SCHEDULE);
  let changes = rail(panel).getByTestId('rail-changes');
  await expect(healed(changes)).toHaveAttribute('data-kind', 'modified');
  await expect(healed(changes)).toContainText('+2 −0');
  await expect(healed(changes)).toContainText('who else edited it: not recorded');
  await expect(healed(changes).getByRole('button', { name: /^Jump to where/ })).toHaveCount(0);
  await expect(changes).toHaveAttribute('data-state', 'ready');

  // A newer turn changes another page; its changeset is the reply's own.
  await askAssistant(page, `append "- confirm the dates" to ${MAP}`);
  await assistantSettled(page, 2);
  await expect(changeRow(changes, MAP)).toHaveAttribute('data-kind', 'modified');
  await expect(changes.getByTestId('rail-changes-summary')).toContainText('across 2 turns');

  // Reloaded, the newer turn's changes come from the stored conversation and
  // the older one's through the heal again.
  await boot(page);
  panel = await openAssistantCanvas(page);
  await expect(panel.getByTestId('chat-message')).toHaveCount(4);
  changes = rail(panel).getByTestId('rail-changes');
  await expect(healed(changes)).toContainText('+2 −0');
  await expect(healed(changes).getByRole('button', { name: /^Jump to where/ })).toHaveCount(0);
  await expect(
    changeRow(changes, MAP).getByRole('button', { name: /^Jump to where systems-map\.md/ }),
  ).toBeVisible();
  await expect(changes).toHaveAttribute('data-state', 'ready');

  // The heal's read fails as the rail shows again: the card is unavailable,
  // and the older turn reads not recorded, never as a turn that changed
  // nothing.
  await page.evaluate(() => window.__cerebroFailNext('conversation_changes'));
  await toggle(panel).click();
  await expect(rail(panel)).toBeHidden();
  await toggle(panel).click();
  changes = rail(panel).getByTestId('rail-changes');
  await expect(changes).toHaveAttribute('data-state', 'unavailable');
  await expect(changes.getByTestId('section-unavailable')).toHaveText(
    "Couldn't read back this conversation's earlier changes.",
  );
  await expect(healed(changes)).toHaveCount(0);
  await expect(changes).toContainText('Changes not recorded for 1 turn.');
  await expect(changeRow(changes, MAP)).toBeVisible();
  await expect(changes).not.toContainText('None');
});
