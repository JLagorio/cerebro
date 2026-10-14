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
