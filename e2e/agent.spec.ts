import { test, expect } from '@playwright/test';
import { boot, seedBeforeBoot } from './boot';

/**
 * The panel runs against the scripted mock in browser mode (see
 * src/agent/mockAgent.ts) — the real agent is a local process reached through
 * Tauri. What is under test here is cerebro's half: the transcript, the tool
 * chips, streaming state, and the review loop. The CLI's half is covered by
 * the Rust unit tests over its stream format.
 */

test('agent: the panel streams a reply and shows what it did', async ({ page }) => {
  await boot(page);

  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();

  await panel.getByLabel('Message the assistant').fill('What is at risk right now?');
  await panel.getByRole('button', { name: 'Send' }).click();

  // The user's message is in the transcript immediately.
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'What is at risk' }),
  ).toBeVisible();

  // Tool use is visible, not hidden: an agent that reads your vault should
  // say so. M9.5 replaced the chip with an expandable action card, so the
  // read is nameable AND inspectable rather than merely announced.
  const card = panel.getByTestId('action-card').filter({ hasText: 'search notes' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-write', 'false');

  // The reply arrives and wikilinks in it are rendered as links.
  const reply = panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' });
  await expect(reply).toBeVisible({ timeout: 10_000 });
  await expect(reply.getByRole('button', { name: /scanner/i })).toBeVisible();
});

test('agent: walking away keeps the thread, and moves the context with you', async ({ page }) => {
  await boot(page);

  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill('What is at risk right now?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('context-chip').first()).toContainText('Home');

  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();

  // The transcript stays put — the assistant navigates you around by design,
  // so a panel that re-threaded on navigation would lose the answer you were
  // reading (M17.2's bug, one layer up).
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible();

  // …and the context follows you, because you ARE somewhere else. It briefly
  // did the opposite: the chip kept naming the thread's anchor, so the context
  // was wrong and the only cure on offer was "start a new conversation" — the
  // app handing its own bookkeeping to the user. Where the conversation began
  // is told to the agent as a fact instead (`startedIn`), never as a chore.
  await expect(panel.getByTestId('context-chip').first()).toContainText('Inbox');
  await expect(panel.getByTestId('thread-elsewhere')).toHaveCount(0);

  // The thread is still filed under where it happened, which is what the
  // anchor is actually for.
  await panel.getByTestId('conversation-switcher').click();
  await expect(page.getByTestId('conversation-row').filter({ hasText: 'Home' })).toBeVisible();
});

test('agent: context is shown as chips you can take away', async ({ page }) => {
  // Wide enough for the record panel AND the assistant (M17.2's
  // SHELL_TWO_PANEL_MIN); below that the record wins and the assistant parks.
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');

  // Where you are is context, and it says so rather than being folded
  // invisibly into the system prompt.
  const chips = panel.getByTestId('context-chip');
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute('data-kind', 'place');
  await expect(chips.first()).toContainText('Home');

  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(panel.getByTestId('context-chip').first()).toContainText('Work item');

  // Opening a record adds it. The open record is CONTEXT, never the place —
  // the agent opens records itself, so a place that moved with it would
  // re-anchor the thread the assistant was answering in.
  const row = page.getByTestId('table-row').first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  const record = panel.locator('[data-testid="context-chip"][data-kind="record"]');
  await expect(record).toHaveCount(1);

  // …and taking it away is one click. This is the useful direction: an answer
  // about the wrong record reads as the model being stupid right up until you
  // can see which page the app handed it.
  await record.getByRole('button', { name: /^Remove/ }).click();
  await expect(panel.locator('[data-testid="context-chip"][data-kind="record"]')).toHaveCount(0);
  // The record is still open — removing it from context is about what the
  // agent is told, not about what the user is reading.
  await expect(page.getByTestId('detail-panel')).toBeVisible();

  // M17.6b: `@` puts it back, and a record row leaves no text behind — a chip
  // is not a mention. (`[[` mentions a note; `@agent-slug` addresses an agent
  // and does stay as text, which is the one exception — see the test below.)
  const composer = panel.getByLabel('Message the assistant');
  await composer.fill('what about @');
  await expect(panel.getByTestId('attach-menu')).toBeVisible();
  await panel.getByTestId('attach-menu').getByRole('button').first().click();
  await expect(panel.getByTestId('context-chip')).toHaveCount(2);
  await expect(composer).toHaveValue('what about ');
});

/**
 * M33b.6 — you can address an agent by name, and it changes who the turn goes
 * to and nothing else (D8).
 *
 * The routing itself is asserted in useAgentChat.test.tsx, against the run
 * options. What only the real app can show is the other half: that `@` offers
 * the agent, that the handle SURVIVES as text where every other row in that
 * menu consumes it, and that the thread it was typed in stays exactly where it
 * was.
 */
test('agent: a turn can be addressed by name, and the thread stays put', async ({ page }) => {
  await boot(page);

  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  const composer = panel.getByLabel('Message the assistant');
  await expect(panel.getByTestId('context-chip').first()).toContainText('Home');

  // `@` offers the vault's agents, under their own heading. Only after a key
  // is pressed: nothing volunteers an agent at anybody.
  //
  // Typed rather than `fill`ed: the menu is anchored to the CARET, and a
  // programmatic value set leaves the selection where the harness left it —
  // which opens the menu or not depending on timing.
  await composer.click();
  await composer.pressSequentially('@release');
  const menu = panel.getByTestId('attach-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: /@release-scout/ }).click();
  // Completed into the message, not taken out of it — the recipient is read
  // back out of the text at send.
  await expect(composer).toHaveValue('@release-scout ');

  await composer.fill('@release-scout what is slipping?');
  await panel.getByRole('button', { name: 'Send' }).click();
  const asked = panel.getByTestId('chat-message').filter({ hasText: 'what is slipping' });
  await expect(asked.getByTestId('turn-addressed')).toContainText('To Release scout');
  // Send returns when the turn ends — the composer's own signal, and the one
  // that matters here: the hook takes one turn per conversation, so a second
  // send fired mid-stream is dropped rather than queued.
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 10_000 });

  // D8: an existing thread gained a recipient. It did not become a different
  // surface — same thread, same anchor, one conversation. The stored anchor is
  // the assertion that matters: addressing an agent must not file the thread
  // under the agent instead of under where it happened.
  await expect(panel.getByTestId('context-chip').first()).toContainText('Home');
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
  const threads = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('cerebro.conversations') ?? '[]'),
  );
  expect(threads).toHaveLength(1);
  expect(threads[0].place).toEqual({ kind: 'home' });
  expect(threads[0].placeLabel).toBe('Home');

  // A name nothing answers to is text, and says so rather than failing or
  // going quiet.
  await composer.fill('@nobody-here are you there?');
  await panel.getByRole('button', { name: 'Send' }).click();
  const missed = panel.getByTestId('chat-message').filter({ hasText: 'are you there' });
  await expect(missed.getByTestId('turn-addressed')).toContainText('No agent called @nobody-here');
});

test('agent: shell access is one persisted ceiling in Settings, not a per-chat mode', async ({
  page,
}) => {
  await boot(page);

  // M8.1: the three-mode dropdown is gone from the panel. It asked the user to
  // declare a policy before knowing what they were going to ask for; what the
  // agent may change now follows from which folder it is writing to.
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel').getByRole('combobox')).toHaveCount(0);

  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Settings' }).click();
  const shell = page.getByRole('switch', { name: 'Shell access' });
  // Off by default — shell access is chosen, never inherited.
  await expect(shell).not.toBeChecked();
  // The checkbox itself is 0×0 by design; the label is what a user clicks.
  await page
    .locator('label.cb-switch')
    .filter({ has: page.getByRole('switch', { name: 'Shell access' }) })
    .click();
  await expect(shell).toBeChecked();

  await page.reload();
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('switch', { name: 'Shell access' })).toBeChecked();
});

const PROPOSED = 'inbox/warehouse-cutover-thought.md';

test('agent: a suggested filing is shown for approval, never applied', async ({ page }) => {
  await boot(page);

  // Driven through the panel, not by reaching into the module: the previous
  // version imported agentIpc inside page.evaluate, which Vite serves at a
  // different URL than the app's own copy once the file has been touched
  // since the dev server started (`?t=<hmr>`). Two module instances, two
  // listener sets, and the emit reached nobody — so the test passed on a cold
  // server and failed on a warm one.
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill('Help me clear the Inbox');
  await panel.getByRole('button', { name: 'Send' }).click();

  // Proposing lands you on the Inbox, on the capture the proposal is ABOUT —
  // not on whatever the queue would otherwise have opened.
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  await expect(page.locator(`[data-testid="inbox-row"][data-path="${PROPOSED}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const capturePath = PROPOSED;
  const card = page.getByTestId('proposal-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('reads as a task-like record');
  await expect(card).toContainText('Work item');

  // Still untyped: a proposal is a suggestion until the user acts on it.
  const beforeType = await page.evaluate(
    (p) => window.__cerebroMockFs.get(p as string) ?? '',
    capturePath,
  );
  expect(beforeType).not.toContain('type: Work item');

  await card.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(async () =>
      page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', capturePath),
    )
    .toContain('type: Work item');
  await expect(card).toBeHidden();
});

test('agent: organizing AI-written work records who signed off', async ({ page }) => {
  await boot(page);
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();

  // The seeded capture carrying `generated: {by: claude-code}` is labelled.
  const aiRow = page
    .getByTestId('inbox-row')
    .filter({ has: page.getByTestId('from-ai') })
    .first();
  await expect(aiRow).toBeVisible();
  const path = await aiRow.getAttribute('data-path');
  await aiRow.click();

  await page.getByRole('button', { name: /Mark organized/i }).click();

  // Organizing agent output IS the review, so it leaves a human stamp —
  // that is what closes the loop the knowledge bundle opened.
  await expect
    .poll(async () => page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', path))
    .toContain('human:me');
});

test('library: three shelves, no workspace nav, and nothing posing as a type', async ({ page }) => {
  await boot(page);

  // The types sidebar is the vault's SUBJECT MATTER. Skill and Agent are how
  // the vault works, and listing them here gave both a type screen, a place in
  // every List, and a generic property table for editing a security boundary.
  const types = page.getByTestId('sidebar-type');
  await expect(types.filter({ hasText: 'Risk' }).first()).toBeVisible();
  await expect(types.filter({ hasText: 'Skill' })).toHaveCount(0);
  await expect(types.filter({ hasText: 'Agent' })).toHaveCount(0);

  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Library' }).click();
  await expect(page.getByTestId('library-page')).toBeVisible();

  // Collections and Types describe the vault; the library holds the machinery
  // that acts on it. M37.3's one nav column keeps both on screen — what still
  // matters is that no type row claims the Library page: nothing is active.
  await expect(types.first()).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-type"][aria-current="page"]')).toHaveCount(0);

  const cards = page.getByTestId('library-card');
  await expect(cards.filter({ hasText: 'Weekly review' })).toBeVisible();
  await expect(cards.filter({ hasText: 'Weekly review' })).toContainText('4 tools only');

  await page.getByTestId('library-tab-agent').click();
  const scout = cards.filter({ hasText: 'Release scout' });
  await expect(scout).toContainText('writes records/risks');

  // Templates are library too — stationery is machinery, not subject matter.
  await page.getByTestId('library-tab-template').click();
  await expect(cards.filter({ hasText: 'PRD' })).toBeVisible();
  await expect(cards.filter({ hasText: 'PRD' })).toContainText('fills itself');
});

test('library: an agent is built from pickers, not from remembered strings', async ({ page }) => {
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Library' }).click();
  await page.getByTestId('library-tab-agent').click();
  await page.getByTestId('library-card').filter({ hasText: 'Release scout' }).click();

  const editor = page.getByTestId('library-editor');
  await expect(editor).toBeVisible();
  // Not a doc canvas and not a property table: what an unattended process may
  // do is on screen, as a chip you can see and remove.
  const scope = page.getByTestId('agent-scope');
  await expect(scope.getByTestId('picker-chip')).toHaveText(/records\/risks/);
  await expect(editor).toContainText('Nothing fires it');

  // Scope is PICKED from folders that exist, with what is in each. Typed, it
  // accepted a folder that does not exist and scoped the agent to nothing.
  await scope.getByTestId('picker-add').click();
  const options = page.getByTestId('picker-option');
  await expect(options.filter({ hasText: 'records/agents' })).toBeVisible();
  await expect(options.filter({ hasText: 'knowledge' }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Tools come from the catalog the server actually serves, in sets — and the
  // picker says the one thing it owes you: can this change my files?
  await page.getByText('Restrict this agent to specific tools').click();
  const tools = page.getByTestId('agent-allowed-tools');
  await tools.getByTestId('picker-add').click();
  await page.getByTestId('picker-group').filter({ hasText: 'Read the vault' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('agent-tools-summary')).toContainText('Read-only');

  // A trigger is clauses, not YAML, and the sentence under it is the same one
  // the library prints — so what will fire it is readable before it ever runs.
  await page.getByRole('button', { name: 'Add trigger' }).click();
  const trigger = page.getByTestId('agent-trigger');
  await trigger.getByLabel('Trigger 1 field').selectOption('status');
  // The value list is what the field has ACTUALLY held in this vault. Typed,
  // `status: blocked` in a vault whose statuses are todo/progress/done fires
  // never, and nothing anywhere would say so.
  const value = trigger.getByLabel('Trigger 1 value');
  await expect(value.locator('option')).toContainText(['any value', 'at-risk']);
  await value.selectOption('at-risk');
  // M18.5: what this waking in particular is for, on top of the standing
  // instructions. One agent usefully answers differently depending on what
  // woke it, and the alternative is three agents sharing 90% of their prose.
  await trigger.getByLabel('Trigger 1 instructions').fill('Check the release date first.');
  await expect(trigger).toContainText('then: Check the release date first.');
  await expect(trigger).toContainText('status');
  await expect(editor).toContainText('On duty');

  // Nothing has been written yet: a half-typed boundary is a wrong boundary,
  // and a background runner does not wait for you to finish typing.
  const path = 'records/agents/release-scout.md';
  const before = await page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', path);
  expect(before).not.toContain('when:');

  await page.getByRole('button', { name: 'Save' }).click();
  const after = expect.poll(async () =>
    page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', path),
  );
  await after.toContain('at-risk');
  await after.toContain('Check the release date first.');
});

test('library: an agent record carries its own run history (M33.6)', async ({ page }) => {
  // The dossier answers "what has this agent done, what did it cost, when
  // does it run next" without leaving the editor — and nothing about the
  // agent itself is stored outside the vault to do it.
  await seedBeforeBoot(
    page,
    '__cerebroSeedFleet',
    [
      {
        run_id: 'scout-1',
        actor: 'process:release-scout',
        vault_id: 'v1',
        mode: 'attended',
        lane: 'agent',
        started_at: '2026-07-28T09:00:00Z',
        ended_at: '2026-07-28T09:01:00Z',
        outcome: 'succeeded',
        usage_state: 'exact',
        input_tokens: 900,
        output_tokens: 100,
        proposals_submitted: 0,
        applied: 0,
        rejected: 0,
      },
    ],
    {},
  );
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Library' }).click();
  await page.getByTestId('library-tab-agent').click();
  await page.getByTestId('library-card').filter({ hasText: 'Release scout' }).click();

  const dossier = page.getByTestId('agent-dossier');
  await expect(dossier).toBeVisible();
  await expect(dossier).toHaveAttribute('data-actor', 'process:release-scout');
  await expect(dossier.getByTestId('fleet-row')).toHaveCount(1);
  await expect(dossier.getByTestId('dossier-runs')).toContainText('1');
  await expect(dossier.getByTestId('dossier-last')).toContainText('succeeded');
  // On duty is DERIVED. The demo scout has no schedule and no trigger, so
  // nothing can fire it — and the strip says that rather than showing a
  // stored flag.
  await expect(dossier.getByTestId('dossier-duty')).toHaveAttribute('data-on-duty', 'false');
});

test('library: an agent with no runs says so, rather than showing a table of zeros', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', [], {});
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Library' }).click();
  await page.getByTestId('library-tab-agent').click();
  await page.getByTestId('library-card').filter({ hasText: 'Release scout' }).click();

  const dossier = page.getByTestId('agent-dossier');
  await expect(dossier.getByTestId('section-empty')).toContainText('No runs yet');
  await expect(dossier.getByTestId('fleet-row')).toHaveCount(0);
  await expect(dossier.getByTestId('dossier-last')).toContainText('never run');
});

test('library: a schedule is built, never typed as a grammar', async ({ page }) => {
  // An unparseable `schedule:` is not an error — it is silently not a
  // schedule, so the agent never runs and nothing anywhere would say why.
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Library' }).click();
  await page.getByTestId('library-tab-agent').click();
  await page.getByTestId('library-card').filter({ hasText: 'Release scout' }).click();

  await page.getByLabel('Repeat').selectOption('weekly');
  await page.getByLabel('Day').selectOption('5');
  await page.getByTestId('schedule-time').fill('17:30');
  await expect(page.getByTestId('library-editor')).toContainText('On duty');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        (p) => window.__cerebroMockFs.get(p as string) ?? '',
        'records/agents/release-scout.md',
      ),
    )
    .toContain('weekly fri 17:30');
});

test('editor: selecting prose shows AI controls, and a rewrite is a decision', async ({ page }) => {
  await boot(page);

  // Any doc with a paragraph in it. The point of this test is the AFFORDANCE:
  // M17.16 built the rewrite surface and bound it to Cmd-K, and nothing on
  // screen said so — selecting text looked exactly as it had before the
  // assistant existed.
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Docs' }).click();
  await page.getByRole('button', { name: 'New page', exact: true }).first().click();
  await page.getByPlaceholder('Page name').fill('Selection test');
  await page.getByRole('button', { name: 'Create' }).click();

  const editor = page.locator('[data-testid="markdown-editor"] .bn-editor');
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('The pricing is annual and the trial is short.');

  // Nothing selected, nothing floating: a toolbar that hangs around while you
  // type is chrome, not an affordance.
  await expect(page.getByTestId('selection-ask-ai')).toHaveCount(0);

  // ONE toolbar — the editor's own, with AI at its head. The first attempt
  // floated a second bar of its own and the two fought for the same pixels
  // on every selection.
  await page.getByText('The pricing is annual').click({ clickCount: 3 });
  await expect(page.locator('.bn-formatting-toolbar')).toHaveCount(1);
  const askAi = page.getByTestId('selection-ask-ai');
  await expect(askAi).toBeVisible();
  // Bold is still one click away: this adds to the toolbar, it does not
  // replace it.
  await expect(page.locator('.bn-formatting-toolbar').getByLabel('Bold')).toBeVisible();

  await askAi.click();
  await expect(page.getByTestId('ask-ai')).toBeVisible();
  // The passage travelled with the click. Reading the DOM selection at apply
  // time would find the popover's own input instead.
  await expect(page.getByLabel(/What should the assistant do/)).toBeVisible();
});

test('editor: the same AI controls appear on a record, not only in Docs', async ({ page }) => {
  // Records and docs are deliberately different surfaces, but the body of a
  // record is prose in the same editor — so "highlight text, get AI" must not
  // be a thing that only works in one of them.
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  const row = page.getByTestId('table-row').first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  const body = panel.locator('[data-testid="markdown-editor"] .bn-editor');
  await expect(body).toBeVisible({ timeout: 10_000 });
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' The pricing is annual.');
  await page.getByText('The pricing is annual').click({ clickCount: 3 });
  await expect(page.getByTestId('selection-ask-ai')).toBeVisible();
});
