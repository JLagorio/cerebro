import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  askAssistant,
  assistantSettled,
  boot,
  chooseSettingsSection,
  contextReadingsWithoutBreakdown,
  holdClock,
  openAssistantCanvas,
  openDestination,
  seedBeforeBoot,
  stepUntil,
  stepUntilSettled,
} from './boot';

/**
 * The conversation rail's frame (M92.1): in the canvas, a third grid area of
 * the panel's own aside. It docks beside the transcript where the canvas
 * frame holds 960px (a 1440 window beside the default sidebar), folds away
 * under that and opens as a drawer over the transcript when asked, and a
 * person's word on it outlives a reload. Moving the same conversation
 * between presentations keeps its input, its turn and the rail.
 *
 * Its cards (M92.4–M92.6, M92.9, M92.11, M92.14, M92.17) act in the canvas:
 * a row's first action shows where in the conversation its thing happened,
 * and its open floats the conversation first, so the page it opens is on
 * screen. A docked rail's Plan card holds the plan, and chat.css hides the
 * dock's steps only where the rail docks. The setup cards read what the
 * conversation handed off, its context, its connectors and its vault. The
 * transcript's hand-off line floats first too, as the rail's opens do.
 *
 * WebKit runs this file as well (the packaged app is WKWebView), and walks
 * the rail's controls by Tab: each is a tab stop of its own, since WebKit
 * leaves a control without one out of the Tab order.
 */

const RAIL_KEY = 'cerebro.chatRailOpen';

/** One finished turn, so the conversation no longer welcomes (Q7). */
async function askOnce(panel: Locator) {
  const input = panel.getByLabel('Message the assistant');
  await input.fill('What is at risk right now?');
  await input.press('Enter');
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
}

const rail = (panel: Locator) =>
  panel.getByRole('region', { name: 'Conversation details', exact: true });
const toggle = (panel: Locator) =>
  panel.getByRole('button', { name: 'Conversation details', exact: true });

test('docks beside the transcript at 1440, the header across both', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  // A fresh conversation in the canvas shows no rail: nothing speaks first.
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  await askOnce(panel);
  await expect(rail(panel)).toBeVisible();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByTestId('conversation-rail')).not.toHaveAttribute('data-drawer');

  const box = (await panel.boundingBox())!;
  const docked = (await rail(panel).boundingBox())!;
  const header = (await panel.locator('.cb-chat-header').boundingBox())!;
  const transcript = (await panel.getByTestId('chat-scroll').boundingBox())!;
  const composer = (await panel.getByTestId('chat-composer').boundingBox())!;
  expect(docked.width).toBeCloseTo(300, 0);
  expect(docked.x + docked.width).toBeCloseTo(box.x + box.width, 0);
  expect(docked.y).toBeCloseTo(header.y + header.height, 0);
  expect(docked.y + docked.height).toBeCloseTo(box.y + box.height, 0);
  expect(header.width).toBeCloseTo(box.width, 0);
  // Beside the transcript, never over it: the composer narrows with it.
  expect(transcript.x + transcript.width).toBeLessThanOrEqual(docked.x + 1);
  expect(composer.x + composer.width).toBeLessThanOrEqual(docked.x);
  expect(
    Math.abs(composer.x + composer.width / 2 - (transcript.x + transcript.width / 2)),
  ).toBeLessThan(2);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('folds away at 1100 and opens there as a drawer that writes nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  await askOnce(panel);
  // On by the preference, and folded: the canvas has no room to dock it.
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  const transcript = (await panel.getByTestId('chat-scroll').boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(transcript.width).toBeCloseTo(box.width, 0);

  await toggle(panel).click();
  await expect(rail(panel)).toBeVisible();
  await expect(panel.getByTestId('conversation-rail')).toHaveAttribute('data-drawer', 'true');
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');
  await expect(
    panel.getByRole('heading', { level: 2, name: 'Conversation details', exact: true }),
  ).toBeFocused();
  const drawer = (await rail(panel).boundingBox())!;
  const header = (await panel.locator('.cb-chat-header').boundingBox())!;
  expect(drawer.width).toBeCloseTo(300, 0);
  expect(drawer.x + drawer.width).toBeCloseTo(box.x + box.width, 0);
  expect(drawer.y).toBeCloseTo(header.y + header.height, 0);
  // Over the transcript, which keeps its whole width beneath it.
  expect((await panel.getByTestId('chat-scroll').boundingBox())!.width).toBeCloseTo(
    transcript.width,
    0,
  );

  await page.keyboard.press('Escape');
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), RAIL_KEY)).toBeNull();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
});

test('a person’s word on the rail outlives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  let panel = await openAssistantCanvas(page);
  await askOnce(panel);
  await expect(rail(panel)).toBeVisible();
  await toggle(panel).click();
  await expect(rail(panel)).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), RAIL_KEY)).toBe('false');

  await boot(page);
  panel = await openAssistantCanvas(page);
  await expect(panel.getByTestId('chat-message').first()).toBeVisible();
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  await toggle(panel).click();
  await expect(rail(panel)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), RAIL_KEY)).toBe('true');

  await boot(page);
  panel = await openAssistantCanvas(page);
  await expect(panel.getByTestId('chat-message').first()).toBeVisible();
  await expect(rail(panel)).toBeVisible();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');
});

test('canvas, floating and canvas again mid-turn keep the input, the turn and the rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  const input = panel.getByLabel('Message the assistant');
  const original = await input.elementHandle();
  await input.fill('wait for me');
  await input.press('Enter');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(rail(panel)).toBeVisible();
  await input.fill('Keep this draft');

  await panel.getByRole('button', { name: 'Float conversation', exact: true }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  await expect(panel.getByTestId('conversation-rail')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);

  await panel.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Expand with conversation details', exact: true })
    .click();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  await expect(rail(panel)).toBeVisible();
  await expect(
    panel.getByRole('heading', { level: 2, name: 'Conversation details', exact: true }),
  ).toBeFocused();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(input).toHaveValue('Keep this draft');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
  const replies = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(replies).toHaveCount(1);
  await expect(replies).toContainText('Done waiting.');
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(1);
  await expect(input).toHaveValue('Keep this draft');
  await expect(rail(panel)).toBeVisible();
});

test('a subagent row jumps to its line in the canvas, and a source opens its page outside it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  await askAssistant(page, 'research the open risks with subagents');
  await assistantSettled(page, 1);
  const details = rail(panel);
  await expect(details).toBeVisible();
  const rows = details.getByTestId('rail-subagent');
  await expect(rows).toHaveCount(2);
  await expect(details.getByTestId('rail-subagents')).toHaveAttribute('data-state', 'ready');

  // Each researcher folds to its line once done; the row opens it there.
  const id = await rows.first().getAttribute('data-tool-id');
  const line = panel.getByTestId('chat-scroll').locator(`[data-tool-id="${id}"]`);
  const fold = line.getByRole('button', { name: /^Done: Read the open risks/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await rows.first().click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(fold).toBeFocused();
  await expect(fold).toBeInViewport();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  await expect(details).toBeVisible();

  // What the researchers read, under the reply that used it. Opening a
  // record floats the conversation first: the peek it opens in is drawn,
  // and the page under it is live.
  const scanner = details.getByTestId('rail-source').filter({ hasText: 'Scanner' });
  await expect(scanner).toHaveCount(1);
  await scanner.getByTestId('rail-source-open').click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  const peek = page.getByTestId('detail-panel');
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('Scanner');
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
});

test('a Changes row shows its change in the canvas, and its open leaves the page on screen', async ({
  page,
}) => {
  const path = 'delivery/how-we-schedule.md';
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  await askAssistant(page, `append "- call the vendor" to ${path}`);
  await assistantSettled(page, 1);
  const changes = rail(panel).getByTestId('rail-changes');
  await expect(changes).toHaveAttribute('data-state', 'ready');
  const row = changes.locator(`[data-testid="rail-change"][data-path="${path}"]`);

  // Its first action: the file's row in the turn's changeset, in the canvas.
  await row.getByRole('button', { name: /^Jump to where how-we-schedule\.md changed/ }).click();
  const file = panel
    .getByTestId('chat-scroll')
    .locator(`[data-slot="file-tree-file"][data-path="${path}"]`);
  await expect.poll(() => file.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');

  // Its second: the page, which the canvas would hide, so it floats first.
  await row.getByRole('button', { name: 'Open how-we-schedule.md (leaves full screen)' }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  const doc = page.getByTestId('doc-page');
  await expect(doc).toBeVisible();
  await expect(doc).toContainText('call the vendor');
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
});

test('in the canvas, a docked rail holds the plan, and the dock’s shows only without it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  await holdClock(page);
  await askAssistant(page, 'make a todo list of the open risks');
  const plan = rail(panel).getByTestId('rail-plan');
  const items = plan.locator('[data-section="todo"] [data-slot="queue-item"]');
  await stepUntil(page, async () => (await items.count()) === 3, 'the rail’s plan');
  // One list on screen: the rail's card, the dock's kept hidden.
  const dock = panel.getByTestId('live-plan');
  await expect(dock).toHaveCount(1);
  await expect(dock).toBeHidden();
  await expect(panel.getByRole('region', { name: 'Plan', exact: true })).toHaveCount(0);
  // Mid-turn, Changes says its changes land when the turn ends: a summary
  // longer than the line wraps, and no card's name is cut short for it.
  await expect(rail(panel).getByTestId('rail-changes')).toContainText('land when this turn ends');
  expect(
    await rail(panel).evaluate((details) =>
      [...details.querySelectorAll<HTMLElement>('.cb-ai-rail-section-title')]
        .filter((title) => title.scrollWidth > title.clientWidth)
        .map((title) => title.textContent),
    ),
  ).toEqual([]);

  // The rail turned off takes its card with it: the dock's shows the list.
  await toggle(panel).click();
  await expect(rail(panel)).toBeHidden();
  await expect(dock).toBeVisible();
  await expect(dock.locator('[data-section="todo"] [data-slot="queue-item"]')).toHaveCount(3);
  await toggle(panel).click();
  await expect(plan).toBeVisible();
  await expect(dock).toBeHidden();

  // Narrower than the dock width, the rail folds away and the dock's plan
  // shows, in the layout pass that folds it: no frame without the list.
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rail(panel)).toBeHidden();
  await expect(dock).toBeVisible();
  // A drawer over the transcript leaves it showing too.
  await toggle(panel).click();
  await expect(panel.getByTestId('conversation-rail')).toHaveAttribute('data-drawer', 'true');
  await expect(plan).toBeVisible();
  await expect(dock).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail(panel)).toBeHidden();
  await expect(dock).toBeVisible();
  // Wide again, docked: the rail's card holds the list once more.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(plan).toBeVisible();
  await expect(dock).toBeHidden();

  // The turn ends: the dock's plan goes, and the rail keeps the list.
  await stepUntilSettled(page, 1);
  await expect(panel.getByTestId('live-plan')).toHaveCount(0);
  await expect(plan).toHaveAttribute('data-state', 'ready');
  await expect(plan).toContainText('3 of 3 done');
});

/** A run the stored thread handed work to (M92.11), as fleet.rs serves its
 *  row: attended, caused by the hand-off, and done. A made-up id. */
const HANDED_RUN = '0000000000000000000000000092150c';
const HANDED = {
  run_id: HANDED_RUN,
  actor: 'process:release-scout',
  vault_id: 'demo',
  mode: 'attended',
  lane: 'agent',
  started_at: '2026-07-28T11:20:00Z',
  ended_at: '2026-07-28T11:24:00Z',
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 7_420,
  output_tokens: 515,
  proposals_submitted: null,
  applied: null,
  rejected: null,
  parent_run_id: null,
  cause: {
    kind: 'handoff',
    why: 'another agent handed it work',
    subject: null,
    detail: null,
    due_at: null,
  },
  cli_session_id: null,
};

/** The stored thread, as conversations.ts writes one: its reply handed the
 *  release brief to the scout, whose run is HANDED. */
const HANDOFF_TOOL = 'toolu_m92_handoff';
const HANDED_THREAD = {
  id: 'm92-handed',
  title: 'Release brief',
  usesDefaultTitle: false,
  sessionId: null,
  createdAt: '2026-07-28T11:00:00.000Z',
  archived: false,
  vault: '/demo-vault',
  messages: [
    { id: 'm92-ask', role: 'user', text: 'Get the release brief current.', tools: [] },
    {
      id: 'm92-reply',
      role: 'assistant',
      text: 'The release brief is with the scout now.',
      tools: [
        {
          id: HANDOFF_TOOL,
          name: 'mcp__cerebro__hand_to',
          input: JSON.stringify({
            agent: 'release-scout',
            message: 'Bring the release brief up to date.',
          }),
          output: `Started Release scout (run ${HANDED_RUN}) with what you handed it.`,
          done: true,
          failed: false,
        },
      ],
    },
  ],
};

/** Open HANDED_THREAD as the stored, active conversation, and its run in the
 *  fleet, before the app boots. */
async function storeHandedThread(page: Page) {
  await page.addInitScript((stored) => {
    window.localStorage.setItem('cerebro.conversations', JSON.stringify([stored]));
    window.localStorage.setItem('cerebro.activeConversation', stored.id);
  }, HANDED_THREAD);
  await seedBeforeBoot(page, '__cerebroSeedFleet', [HANDED], {
    [HANDED_RUN]: {
      run: HANDED,
      cost_components: null,
      assembly: null,
      model_id: null,
      refusals: [],
      refusals_total: 0,
      wrote: { state: 'not_recorded' },
    },
  });
}

/** Settings' Connectors switch on, with one connector in the vault's list. */
async function addConnector(page: Page) {
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  const switched = page.getByRole('switch', { name: 'Connectors', exact: true });
  if (!(await switched.isChecked())) {
    await page.locator('label.cb-switch').filter({ has: switched }).click();
  }
  const settings = page.getByTestId('connector-settings');
  await settings.getByPlaceholder('Name').fill('Gmail');
  await settings.getByPlaceholder('https://…/mcp').fill('https://gmail.example.test/mcp');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(settings.getByTestId('connector-status')).toHaveText('Gmail — not observed yet');
}

test('the setup cards read what was handed off, the context, the connectors and the vault', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await storeHandedThread(page);
  await boot(page);
  await addConnector(page);

  const panel = await openAssistantCanvas(page);
  const details = rail(panel);
  await expect(details).toBeVisible();

  // Handed off: the run the reply started, as runtime.db reads it back. Its
  // row shows the hand-off's own line, in the canvas.
  const handoffs = details.getByTestId('rail-handoffs');
  await expect(handoffs).toHaveAttribute('data-state', 'ready');
  await expect(handoffs).toContainText('1 done');
  const handoff = handoffs.locator(`[data-testid="rail-handoff"][data-run-id="${HANDED_RUN}"]`);
  await expect(handoff).toHaveAttribute('data-state', 'done');
  await handoff.getByTestId('rail-handoff-show').click();
  const line = panel
    .getByTestId('chat-scroll')
    .locator(`[data-testid="action-card"][data-tool-id="${HANDOFF_TOOL}"]`);
  await expect(line.locator('[data-slot="subagent-handoff-run"]')).toBeFocused();
  await expect(line).toBeInViewport();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');

  // A turn: its run says what it reaches as it starts, and its end files
  // the session's reading, Claude Code's breakdown with it.
  await askAssistant(page, 'What is at risk right now?');
  await assistantSettled(page, 2);

  // Context: the composer ring's figure, then what the context holds.
  const context = details.getByTestId('rail-context');
  await expect(context).toHaveAttribute('data-state', 'ready');
  await expect(context.getByTestId('rail-context-categories')).toBeVisible();
  const ring = await panel.getByTestId('context-use').textContent();
  await expect(context).toContainText(`${ring} used`);
  await expect(context.getByTestId('rail-context-freshness')).toContainText(
    'Read when the last turn ended',
  );

  // Connectors: the vault's list in Settings' words, and what the turn's run
  // loaded of it.
  const connectors = details.getByTestId('rail-connectors');
  await expect(connectors).toHaveAttribute('data-state', 'ready');
  const gmail = connectors.locator('[data-testid="rail-connector"][data-name="Gmail"]');
  await expect(gmail).toHaveAttribute('data-status', 'not_observed');
  await expect(gmail).toHaveAttribute('data-run', 'not-loaded');

  // Environment: the vault, who answers in it, and what the run reached.
  const environment = details.getByTestId('rail-environment');
  await expect(environment).toHaveAttribute('data-state', 'ready');
  await expect(environment.getByTestId('rail-environment-vault')).toContainText('demo-vault');
  await expect(environment.getByTestId('rail-environment-answers')).toContainText('Assistant');
  await expect(environment.getByTestId('rail-environment-pages')).toBeVisible();
  await expect(environment.getByTestId('rail-environment-reach-not-recorded')).toHaveCount(0);

  // A reading with no breakdown: the count alone, and the card says why.
  await contextReadingsWithoutBreakdown(page);
  await askAssistant(page, 'Which of the risks has a date?');
  await assistantSettled(page, 3);
  await expect(context).toHaveAttribute('data-state', 'partial');
  await expect(context).toContainText('Breakdown not recorded for this turn');
  await expect(context.getByTestId('rail-context-categories')).toHaveCount(0);
  await expect(context.getByTestId('rail-context-figure')).toBeVisible();
  await expect(context).toContainText(
    `${await panel.getByTestId('context-use').textContent()} used`,
  );

  // The hand-off's own line opens the run it started: the canvas would hide
  // that page, so the conversation floats first, and the page is live.
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  await line.locator('[data-slot="subagent-handoff-run"]').click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  await expect(page.locator('[data-testid="base-section"][data-section="fleet"]')).toBeVisible();
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
});

test('WebKit: Tab walks from the composer through every card’s controls in order, and Shift+Tab walks back', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'webkit',
    'WebKit, as WKWebView, tabs only to a control that carries its own tab stop',
  );
  // Settings, four turns and a fifth that waits, then the walk: more than one
  // test's worth of a busy machine.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A conversation that handed work off, and a connector in the vault's list,
  // as the setup cards' test has them.
  await storeHandedThread(page);
  await boot(page);
  await addConnector(page);
  const panel = await openAssistantCanvas(page);
  // Turns that give the other cards something to show: subagents and what
  // they read, a plan, and a page changed.
  await askAssistant(page, 'research the open risks with subagents');
  await assistantSettled(page, 2);
  await askAssistant(page, 'make a todo list of the open risks');
  await assistantSettled(page, 3);
  await askAssistant(page, 'append "- call the vendor" to delivery/how-we-schedule.md');
  await assistantSettled(page, 4);
  // A turn whose write waits on the person: Waiting on you leads the rail
  // for as long as its card waits.
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk: string[] }).__cerebroMockAsk = ['append_to_note'];
  });
  await askAssistant(page, 'append "- confirm the dates" to strategy/systems-map.md');
  await expect(panel.getByTestId('interaction-card')).toBeVisible();
  const details = rail(panel);
  const shown = [
    'rail-waiting',
    'rail-plan',
    'rail-subagents',
    'rail-changes',
    'rail-handoffs',
    'rail-context',
    'rail-sources',
    'rail-connectors',
    'rail-environment',
  ];
  // Each says what it holds; the stored reply recorded no changes, so
  // Changes is partial.
  for (const card of shown) {
    await expect(details.getByTestId(card)).toHaveAttribute('data-state', /^(ready|partial)$/);
  }

  // Every control the rail draws now, numbered in document order: none under
  // a closed fold, nothing inert or hidden. Every card shows something, so
  // each has its fold at least, in Q5's order.
  const { count, cards } = await details.evaluate((rail) => {
    const controls = [
      ...rail.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'),
    ].filter(
      (control) =>
        control.tabIndex >= 0 &&
        !(control instanceof HTMLButtonElement && control.disabled) &&
        control.closest('[hidden], [inert]') === null &&
        control.getClientRects().length > 0,
    );
    controls.forEach((control, at) => control.setAttribute('data-tab-probe', String(at)));
    const holders = controls.map(
      (control) => control.closest<HTMLElement>('[data-slot="rail-section"]')?.dataset.testid,
    );
    return { count: controls.length, cards: [...new Set(holders)] };
  });
  expect(cards).toEqual(shown);
  /** Where focus is: a numbered control, else in or out of the rail. */
  const focused = () =>
    page.evaluate(() => {
      const at = document.activeElement;
      if (!(at instanceof HTMLElement) || at === document.body) return 'nowhere';
      if (at.dataset.tabProbe !== undefined) return Number(at.dataset.tabProbe);
      return at.closest('[data-testid="conversation-rail"]') === null ? 'outside' : 'unnumbered';
    });

  // From the composer, Tab leaves what follows it and enters the rail at its
  // first control, then visits each in turn.
  const composer = panel.getByLabel('Message the assistant');
  await composer.focus();
  let at = await focused();
  for (let press = 0; at === 'outside' && press < 40; press += 1) {
    await page.keyboard.press('Tab');
    at = await focused();
  }
  expect(at, 'the rail’s first control').toBe(0);
  for (let next = 1; next < count; next += 1) {
    await page.keyboard.press('Tab');
    expect(await focused(), `control ${next} of ${count}`).toBe(next);
  }

  // Shift+Tab walks the same controls back, then out of the rail to the
  // composer.
  for (let next = count - 2; next >= 0; next -= 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await focused(), `control ${next} of ${count}, backwards`).toBe(next);
  }
  for (let press = 0; press < 40; press += 1) {
    if (await composer.evaluate((input) => input === document.activeElement)) break;
    await page.keyboard.press('Shift+Tab');
    expect(await focused(), 'between the rail and the composer').toBe('outside');
  }
  await expect(composer).toBeFocused();
});
