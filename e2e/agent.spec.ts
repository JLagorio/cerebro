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

test('library: skills and agents are findable, and say what they will do', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: 'Library' }).click();
  await expect(page.getByTestId('library-page')).toBeVisible();

  // Both kinds are here. They were reachable only by knowing which folder they
  // lived in — a capability nobody can find is a capability nobody has.
  const rows = page.getByTestId('library-row');
  await expect(rows.filter({ hasText: 'Weekly review' })).toBeVisible();
  await expect(rows.filter({ hasText: 'Release scout' })).toBeVisible();

  // The narrowing is stated where it can be seen: weekly-review declares four
  // read tools and no writer, and that is enforced rather than requested.
  await expect(rows.filter({ hasText: 'Weekly review' })).toContainText('4 tools only');

  // Activation is DERIVED from the record — an agent is active exactly when it
  // has something that fires it. The demo's scout ships unscheduled.
  const scout = rows.filter({ hasText: 'Release scout' });
  await expect(scout).toContainText('Not activated');
  await expect(scout).toContainText('writes records/risks');

  await page.getByLabel('Search the library').fill('release');
  await expect(rows.filter({ hasText: 'Weekly review' })).toHaveCount(0);
  await expect(scout).toBeVisible();

  // A row opens the record, which is where it is actually edited — the screen
  // deliberately owns discovery and activation, not a second frontmatter form.
  await scout.click();
  await expect(page.getByTestId('detail-panel').or(page.getByTestId('doc-title'))).toBeVisible();
});
