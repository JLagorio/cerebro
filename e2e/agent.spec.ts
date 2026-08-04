import { test, expect, type Page } from '@playwright/test';

/**
 * The panel runs against the scripted mock in browser mode (see
 * src/agent/mockAgent.ts) — the real agent is a local process reached through
 * Tauri. What is under test here is cerebro's half: the transcript, the tool
 * chips, streaming state, and the review loop. The CLI's half is covered by
 * the Rust unit tests over its stream format.
 */

async function boot(page: Page): Promise<void> {
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    // Pin the theme (M16.39). These specs assert on rendered UI, and an unset
    // themeMode resolves 'system' — so a dark display would flip every colour
    // out from under them. The app has two palettes now; the specs assume one.
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

test('agent: the panel streams a reply and shows what it did', async ({ page }) => {
  await boot(page);

  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
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

  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill('What is at risk right now?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('context-chip').first()).toContainText('Home');

  await page
    .getByTestId('rail')
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
  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
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

  // M17.6b: `@` puts it back, and leaves no text behind — a chip is not a
  // mention. (`[[` is the mention; the two tokens do different jobs.)
  const composer = panel.getByLabel('Message the assistant');
  await composer.fill('what about @');
  await expect(panel.getByTestId('attach-menu')).toBeVisible();
  await panel.getByTestId('attach-menu').getByRole('button').first().click();
  await expect(panel.getByTestId('context-chip')).toHaveCount(2);
  await expect(composer).toHaveValue('what about ');
});

test('agent: shell access is one persisted ceiling in Settings, not a per-chat mode', async ({
  page,
}) => {
  await boot(page);

  // M8.1: the three-mode dropdown is gone from the panel. It asked the user to
  // declare a policy before knowing what they were going to ask for; what the
  // agent may change now follows from which folder it is writing to.
  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel').getByRole('combobox')).toHaveCount(0);

  await page.getByTestId('rail').getByRole('button', { name: 'Settings' }).click();
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
  await page.getByTestId('rail').getByRole('button', { name: 'Settings' }).click();
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
  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
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
    .getByTestId('rail')
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

  await page.getByTestId('rail').getByRole('button', { name: 'Library' }).click();
  await expect(page.getByTestId('library-page')).toBeVisible();

  // Collections and Types describe the vault; the library holds the machinery
  // that acts on it. Beside each other, the tree implied a skill lives in a
  // Collection and left a type row highlighted while you edited a trigger.
  await expect(types.first()).toHaveCount(0);

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

test('library: an agent is built in a form, not typed into a file', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: 'Library' }).click();
  await page.getByTestId('library-tab-agent').click();
  await page.getByTestId('library-card').filter({ hasText: 'Release scout' }).click();

  const editor = page.getByTestId('library-editor');
  await expect(editor).toBeVisible();
  // Not a doc canvas and not a property table: the two fields that decide what
  // an unattended process may do are on screen with their consequences.
  await expect(page.getByTestId('agent-scope')).toHaveValue('records/risks');
  await expect(editor).toContainText('Nothing fires it');

  // Building a trigger is picking clauses, not remembering YAML — and the
  // sentence under it is the same one the library prints, so what will fire it
  // is readable before it ever runs.
  await page.getByRole('button', { name: 'Add trigger' }).click();
  const trigger = page.getByTestId('agent-trigger');
  await trigger.getByLabel('Trigger 1 folder').fill('records/risks');
  await trigger.getByLabel('Trigger 1 field').fill('status');
  await trigger.getByLabel('Trigger 1 value').fill('blocked');
  await expect(trigger).toContainText('status');
  await expect(editor).toContainText('On duty');

  // Nothing has been written yet: a half-typed boundary is a wrong boundary,
  // and a background runner does not wait for you to finish typing.
  const path = 'records/agents/release-scout.md';
  const before = await page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', path);
  expect(before).not.toContain('when:');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', path))
    .toContain('blocked');
});

test('editor: selecting prose shows AI controls, and a rewrite is a decision', async ({ page }) => {
  await boot(page);

  // Any doc with a paragraph in it. The point of this test is the AFFORDANCE:
  // M17.16 built the rewrite surface and bound it to Cmd-K, and nothing on
  // screen said so — selecting text looked exactly as it had before the
  // assistant existed.
  await page.getByTestId('rail').getByRole('button', { name: 'Docs' }).click();
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
  await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);

  await page.getByText('The pricing is annual').click({ clickCount: 3 });
  const toolbar = page.getByTestId('selection-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByTestId('selection-ask-ai')).toBeVisible();

  await toolbar.getByTestId('selection-ask-ai').click();
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
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
});
