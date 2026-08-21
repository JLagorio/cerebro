import { expect, test } from '@playwright/test';
import { boot, seedBeforeBoot } from './boot';

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

  // -- The destination exists and composes roster + run feed --------------
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Agents' }).click();
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
  await expect(page.getByTestId('agent-run-hop')).toContainText('process:knowledge');
  await expect(page.getByText(/billed to this run's ceiling/)).toBeVisible();

  // -- Editing stays the Library's: one editor, one save path --------------
  await page.getByTestId('agent-edit').click();
  await expect(page.getByTestId('library-editor')).toBeVisible();
});
