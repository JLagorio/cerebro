import { expect, test } from '@playwright/test';
import { boot, openAgents, openKnowledgeTab, seedBeforeBoot } from './boot';

/**
 * The agents' front door (M41): the roster over the run feed, each agent's
 * own page (M55.12), and the chain trace M34.3's `parent_run_id` waited for.
 * FIXED SHAPES, NO ENGINE — the chain grouping is proved in
 * AgentRunHistory.test; this file proves the SURFACE exists and the pieces
 * reach it.
 */

const ROOT = {
  run_id: 'root-1',
  actor: 'process:release-scout' as string | null,
  vault_id: 'v1',
  mode: 'ambient',
  lane: 'scheduled',
  started_at: '2026-07-28T11:00:00Z',
  ended_at: '2026-07-28T11:02:00Z',
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 9_000,
  output_tokens: 700,
  proposals_submitted: 0,
  applied: 0,
  rejected: 0,
  parent_run_id: null as string | null,
  // M56.7: why it started (null is "why not recorded") and its CLI session.
  cause: null as {
    kind: string;
    why: string;
    subject: string | null;
    detail: string | null;
    due_at: string | null;
  } | null,
  cli_session_id: null as string | null,
};

const HOP = {
  ...ROOT,
  run_id: 'hop-1',
  actor: 'process:knowledge',
  lane: 'agent',
  started_at: '2026-07-28T11:01:00Z',
  parent_run_id: 'root-1',
};

test('agents: the front door — roster, the agent’s page on its Runs, chain trace', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', [ROOT, HOP], {});
  await boot(page);

  // -- The fleet door is the Agents SECTION's open-all reveal (M43) --------
  await page.getByRole('button', { name: 'Open all agents' }).click();
  await expect(page.getByTestId('agents-page')).toBeVisible();
  const roster = page.getByTestId('agent-row');
  await expect(roster).toHaveCount(2);
  await expect(page.getByTestId('fleet-section')).toBeVisible();

  // -- A roster row is a destination: the agent's page, on its Runs tab ----
  await roster.filter({ hasText: 'Release scout' }).click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await expect(page.getByTestId('doc-title')).toContainText('Release scout');
  await expect(page.getByTestId('record-tab-runs')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('agent-properties')).toContainText('records/risks/');

  // -- The chain renders: the hop indents under its root, billing stated ---
  await expect(page.getByTestId('agent-run')).toHaveCount(1);
  // The hop names its agent as its record does (M52.3), not by its stamp.
  await expect(page.getByTestId('agent-run-hop')).toContainText('Knowledge agent');
  await expect(page.getByText(/billed to this run's ceiling/)).toBeVisible();

  // -- The page IS the editor: no door back to a second one ---------------
  await expect(page.getByTestId('agent-edit')).toHaveCount(0);
});

// M52.3 — one worker, one name, wherever you meet it. The corpus's Knowledge
// agent ran once (an addressed turn) and wrote two concepts; the run, the
// agent's page, each concept's byline and the review queue used to credit
// that work to three different writers.
test('agents: a run, its agent and what it wrote tell one story', async ({ page }) => {
  await boot(page);
  await openAgents(page);

  const row = page.locator('[data-testid="fleet-row"][data-run="run-ingest-2"]');
  await expect(row.getByTestId('fleet-actor')).toHaveText('Knowledge agent');
  await row.click();
  const detail = page.getByTestId('run-detail');
  await expect(detail.getByTestId('run-detail-knowledge-write')).toHaveCount(2);

  // The run's header is the agent, and opens its page (M55.12).
  await detail.getByTestId('run-detail-agent').click();
  await expect(page.getByTestId('doc-title')).toContainText('Knowledge agent');
  await page.getByTestId('record-tab-memory').click();
  await expect(page.getByTestId('agent-wrote')).toHaveCount(2);
  await page.getByTestId('record-tab-runs').click();
  await expect(page.getByTestId('agent-run')).toHaveCount(1);
  await page.getByTestId('record-tab-memory').click();

  // A concept it wrote says so, under its title.
  await page.getByTestId('agent-wrote').filter({ hasText: 'Warehouse cutover' }).click();
  await expect(page.getByTestId('review-bar-author')).toContainText('Knowledge agent');

  // And the review queue says who it is new from.
  await openKnowledgeTab(page, 'review');
  await expect(
    page
      .getByTestId('queue-row')
      .filter({ hasText: 'Pick queue drain time' })
      .getByTestId('queue-reason'),
    // The reason's word in the cell, its sentence on hover (M52.5).
  ).toHaveAttribute('title', /^New from Knowledge agent/);
});

// M63.1b — the lobby names what is waiting to wake an agent, and what was
// skipped or expired this week; an agent's Runs tab names its own. Seeded
// rows: M63.1's agent-wakes.spec proves the live path.
const VAULT = '/demo-vault';
const GA_ITEM = 'projects/guided-onboarding-ga/items/fld-1.md';
const WAKES = [
  {
    vault: VAULT,
    agent: 'process:release-scout',
    admittedAt: '2026-07-28T11:50:00Z',
    cause: { kind: 'event', subject: GA_ITEM, detail: 'it changes in projects' },
  },
  {
    vault: VAULT,
    agent: 'process:release-scout',
    admittedAt: '2026-07-28T10:00:00Z',
    finishedAt: '2026-07-28T10:05:00Z',
    outcome: 'skipped',
    reason: 'cycle',
    cause: { kind: 'event', subject: 'records/risks/gone.md' },
  },
  {
    vault: VAULT,
    agent: 'process:knowledge',
    admittedAt: '2026-07-20T09:00:00Z',
    finishedAt: '2026-07-27T09:00:00Z',
    outcome: 'cancelled',
    reason: 'expired',
    cause: { kind: 'event', subject: GA_ITEM },
  },
];

test('agents: the lobby names what is waiting to wake an agent, and its Runs tab its own', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedWakes', WAKES);
  await boot(page);
  await openAgents(page);

  const section = page.locator('[data-section="wakes"]');
  await expect(section).toContainText('Waiting to wake');
  await expect(section).toContainText(
    'Changes that arrive while an agent waits wake it once, together — up to 20 in one run.',
  );
  const rows = section.getByTestId('agent-wake');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-state', 'pending');
  await expect(rows.nth(0)).toContainText('Release scout');
  await expect(rows.nth(0)).toContainText('waiting since 2026-07-28 11:50');
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'skipped');
  await expect(rows.nth(1)).toContainText(
    'skipped (or cancelled) for a reason this version does not name (cycle)',
  );
  await expect(rows.nth(2)).toHaveAttribute('data-state', 'expired');
  await expect(rows.nth(2)).toContainText('Knowledge agent');
  await expect(rows.nth(2)).toContainText('expired — waited more than 7 days');
  // A gone page is plain text; a live one opens.
  await expect(rows.nth(1).getByTestId('agent-wake-subject')).toHaveAttribute('data-gone', 'true');

  // Release scout's own page lists only its wakes, above its runs.
  await page.getByTestId('agent-row').filter({ hasText: 'Release scout' }).click();
  await expect(page.getByTestId('record-tab-runs')).toHaveAttribute('aria-selected', 'true');
  const own = page.getByTestId('agent-wake');
  await expect(own).toHaveCount(2);
  await expect(own.filter({ hasText: 'Knowledge agent' })).toHaveCount(0);

  // Each row opens its page.
  await own.nth(0).getByTestId('agent-wake-subject').click();
  await expect(page.getByTestId('doc-title')).toContainText('First-run walkthrough GA');
});

test('agents: a wake list that cannot be read says so, never that nothing waits', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedWakes', null);
  await boot(page);
  await openAgents(page);
  const section = page.locator('[data-section="wakes"]');
  await expect(section.getByTestId('agent-wakes-unavailable')).toHaveText(
    "Couldn't read what is waiting to wake your agents.",
  );
  await expect(section.getByTestId('agent-wakes-empty')).toHaveCount(0);
});
