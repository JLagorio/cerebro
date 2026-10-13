import { expect, test } from '@playwright/test';
import { boot, openAgents, openKnowledgeTab, seedBeforeBoot } from './boot';

/**
 * The agents' front door (M41): the roster over the run feed, one page per
 * agent, and the chain trace M34.3's `parent_run_id` waited for. FIXED
 * SHAPES, NO ENGINE — the chain grouping is proved in AgentsPage.test; this
 * file proves the SURFACE exists and the pieces reach it.
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
};

const HOP = {
  ...ROOT,
  run_id: 'hop-1',
  actor: 'process:knowledge',
  lane: 'agent',
  started_at: '2026-07-28T11:01:00Z',
  parent_run_id: 'root-1',
};

test('agents: the front door — roster, agent page, chain trace, one editor', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', [ROOT, HOP], {});
  await boot(page);

  // -- The fleet door is the Agents SECTION's open-all reveal (M43) --------
  await page.getByRole('button', { name: 'Open all agents' }).click();
  await expect(page.getByTestId('agents-page')).toBeVisible();
  const roster = page.getByTestId('agent-row');
  await expect(roster).toHaveCount(2);
  await expect(page.getByTestId('fleet-section')).toBeVisible();

  // -- A roster row is a destination here, not a filter --------------------
  await roster.filter({ hasText: 'Release scout' }).click();
  await expect(page.getByTestId('agent-grants')).toBeVisible();
  await expect(page.getByTestId('agent-charter')).toBeVisible();

  // -- The chain renders: the hop indents under its root, billing stated ---
  await expect(page.getByTestId('agent-run')).toHaveCount(1);
  // The hop names its agent as its record does (M52.3), not by its stamp.
  await expect(page.getByTestId('agent-run-hop')).toContainText('Knowledge agent');
  await expect(page.getByText(/billed to this run's ceiling/)).toBeVisible();

  // -- Editing stays the Library's: one editor, one save path --------------
  await page.getByTestId('agent-edit').click();
  await expect(page.getByTestId('library-editor')).toBeVisible();
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

  // The run's header is the agent, and opens it.
  await detail.getByTestId('run-detail-agent').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Knowledge agent' })).toBeVisible();
  await expect(page.getByTestId('agent-wrote')).toHaveCount(2);
  await expect(page.getByTestId('agent-run')).toHaveCount(1);

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
