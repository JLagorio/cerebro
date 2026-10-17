import { expect, test, type Page } from '@playwright/test';
import {
  chooseSettingsSection,
  boot,
  openAgents,
  openAssistantPanel,
  openDestination,
} from './boot';

/**
 * Shell access is off, ask or on (M57.2), and the tool-approval table
 * decides what each run does with the CLI's own tools. In the browser the
 * mock agent plans every run by the same table (src/lib/policy/toolApproval.ts):
 * `run "<command>"` calls Bash, deciding as the table says, and since M57.7
 * `fetch "<url>"` calls WebFetch, which Web access decides. AskUserQuestion's
 * cases live in agent-questions.spec.ts (M57.3).
 */

const PERSON_DENIED =
  "The person said no, so this did not run. Don't try it again this turn; carry on without it, or say what you needed it for.";

/** Boot with Shell access set to `ceiling` before the app reads it. */
async function bootUnder(page: Page, ceiling: string, options: { autoLearn?: boolean } = {}) {
  await page.addInitScript((value) => {
    window.localStorage.setItem('cerebro.agentShell', value);
  }, ceiling);
  await boot(page, options);
}

async function openPanel(page: Page) {
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function send(page: Page, text: string) {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

const replies = (page: Page, text: string) =>
  page.getByTestId('ai-panel').getByTestId('chat-message').filter({ hasText: text });

test('tool approval: under Ask a command waits on a card; Allow once runs it, and the next asks again', async ({
  page,
}) => {
  await bootUnder(page, 'ask');
  const panel = await openPanel(page);
  await send(page, 'run "git status"');

  const card = panel.getByTestId('permission-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('Run this command?');
  await expect(card).toContainText('The assistant is waiting for your answer.');
  await expect(card.getByTestId('permission-subject')).toHaveText('git status');

  await card.getByTestId('permission-allow-once').click();
  await expect(card).toBeHidden();
  await expect(replies(page, 'I ran git status.')).toHaveCount(1, { timeout: 10_000 });

  // Allow once is once.
  await send(page, 'run "git status"');
  await expect(panel.getByTestId('permission-card')).toBeVisible({ timeout: 10_000 });
});

test('tool approval: This conversation runs the same command again with no card', async ({
  page,
}) => {
  await bootUnder(page, 'ask');
  const panel = await openPanel(page);
  await send(page, 'run "git status"');
  const card = panel.getByTestId('permission-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByTestId('permission-allow-conversation').click();
  await expect(card).toBeHidden();
  await expect(replies(page, 'I ran git status.')).toHaveCount(1, { timeout: 10_000 });

  await send(page, 'run "git status"');
  await expect(replies(page, 'I ran git status.')).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.getByTestId('permission-card')).toHaveCount(0);
});

test('tool approval: Deny returns the person-denied message', async ({ page }) => {
  await bootUnder(page, 'ask');
  const panel = await openPanel(page);
  await send(page, 'run "rm -rf build"');
  const card = panel.getByTestId('permission-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByTestId('permission-deny').click();
  await expect(card).toBeHidden();
  await expect(replies(page, 'you declined it')).toBeVisible({ timeout: 10_000 });

  const row = panel.getByTestId('action-card').last();
  await expect(row).toHaveAttribute('data-status', 'failed');
  await row.getByRole('button').first().click();
  await expect(row.getByTestId('action-output')).toContainText(PERSON_DENIED);
});

test('tool approval: a scheduled shell agent under Ask runs without the shell, and its run says so', async ({
  page,
}) => {
  const PROBE = [
    '---',
    'type: Agent',
    'slug: shell-probe',
    'tools: shell',
    'schedule: daily 09:00',
    '---',
    '',
    '# Shell probe',
    '',
    'run "git status"',
    '',
  ].join('\n');
  // On the mock disk before the first scan, so the job runner sees it.
  await page.addInitScript((md) => {
    const plant = () => {
      const fs = (window as unknown as { __cerebroMockFs?: Map<string, string> }).__cerebroMockFs;
      if (fs === undefined) {
        setTimeout(plant, 5);
        return;
      }
      fs.set('records/agents/shell-probe.md', md);
    };
    plant();
  }, PROBE);
  await bootUnder(page, 'ask', { autoLearn: true });

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.__cerebroMockRefusals ?? []).filter((r) => r.surface === 'agent.ask'),
        ),
      { timeout: 30_000 },
    )
    .toHaveLength(1);
  const [refusal] = await page.evaluate(() => window.__cerebroMockRefusals ?? []);
  expect(refusal.code).toBe('capability_unavailable');
  expect(refusal.detail).toContain('Write, Edit, MultiEdit, NotebookEdit, Bash');
  // Nobody watches a schedule: no card anywhere.
  await expect(page.getByTestId('permission-card')).toHaveCount(0);

  await openAgents(page);
  const section = page.locator('[data-section="fleet"]');
  const row = section.locator(`[data-testid="fleet-row"][data-run="${refusal.run}"]`);
  await row.click();
  const refused = section.getByTestId('run-detail').getByTestId('run-detail-refused');
  await expect(refused).toContainText('agent.ask');
  await expect(refused).toContainText('Bash');
});

test('tool approval: Settings counts the person’s own rules and hook events', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __cerebroSeedClaudeSettings: unknown }).__cerebroSeedClaudeSettings = {
      state: 'read',
      path: '~/.claude/settings.json',
      allow: 201,
      ask: 0,
      deny: 3,
      hook_events: [
        'PreToolUse',
        'PostToolUse',
        'Notification',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit',
        'SessionStart',
      ],
    };
  });
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  const rules = page.getByTestId('shell-user-rules');
  await expect(rules).toContainText('201 allow rules');
  await expect(rules).toContainText('hooks on 7 events');
  await expect(rules).toContainText('A command they allow runs without a card.');
});

test('tool approval: Web access gates WebFetch, and the switch survives a reload (M57.7)', async ({
  page,
}) => {
  await boot(page);
  await openPanel(page);
  // Off by default: argv denies the web, so the run reads it is not there.
  await send(page, 'fetch "https://example.com"');
  await expect(replies(page, 'WebFetch is not available in this run.')).toHaveCount(1, {
    timeout: 10_000,
  });

  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  const web = page.getByRole('switch', { name: 'Web access' });
  await expect(web).not.toBeChecked();
  // The checkbox itself is 0×0 by design; the label is what a user clicks.
  await page.locator('label.cb-switch').filter({ has: web }).click();
  await expect(web).toBeChecked();

  await page.reload();
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  await expect(page.getByRole('switch', { name: 'Web access' })).toBeChecked();

  // The panel was open before the reload, and it remembers that.
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  await send(page, 'fetch "https://example.com"');
  await expect(replies(page, 'I fetched https://example.com.')).toHaveCount(1, {
    timeout: 10_000,
  });
});
