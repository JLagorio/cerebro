import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * A page says which agents can change it, and why (M58.6).
 *
 * Against the demo vault's two agents: release-scout, scoped to
 * records/risks/, and the knowledge agent, whose scope is empty and whose
 * tools change no page but Knowledge's and the cached sources, which both
 * agents' cache_source rewrites past any scope. Settings' shell ceiling stays
 * at its default (off), so only Cerebro's own tools reach a page.
 */

/** A page, found by its title, opened as a page, on its Info tab. */
async function openInfo(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  // A record peeks first; a doc or an agent opens as a page at once.
  const full = page.getByRole('button', { name: 'Open in full page' });
  const editor = page.getByTestId('markdown-editor');
  await expect(full.or(editor).first()).toBeVisible({ timeout: 10_000 });
  if (await full.isVisible()) await full.click();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  if (!(await page.getByTestId('doc-side-panel').isVisible())) {
    await page.getByRole('button', { name: 'Show panel' }).click();
  }
  await page.getByTestId('doc-side-panel').getByTestId('doc-panel-tab-info').click();
  await expect(page.getByTestId('page-access')).toBeVisible();
}

const row = (page: Page, actor: string) =>
  page.locator(`[data-testid="page-access-row"][data-actor="${actor}"]:not([data-panel])`);

test('a page inside release-scout’s scope lists it as able to change it, and why', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page);
  await openInfo(page, 'Warehouse rollback has never been rehearsed');
  await expect(page.getByTestId('page-access-summary')).toHaveText(
    '1 of 2 agents can change this page.',
  );
  const scout = row(page, 'process:release-scout');
  await expect(scout).toHaveAttribute('data-write', 'yes');
  await expect(scout.getByTestId('page-access-reason').first()).toHaveText(
    'Inside its write scope: records/risks/.',
  );
});

test('a page outside every scope says no agent can change it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page);
  await openInfo(page, 'How we schedule');
  await expect(page.getByTestId('page-access-summary')).toHaveText(
    'No agent can change this page.',
  );
  await page.getByTestId('page-access-others-toggle').click();
  const scout = row(page, 'process:release-scout');
  await expect(scout).toHaveAttribute('data-write', 'no');
  await expect(scout.getByTestId('page-access-reason').first()).toHaveText(
    'Outside its write scope: records/risks/.',
  );
});

test('an agent’s own page: only its own notes, and a grant to every other agent', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page);
  await openInfo(page, 'Release scout');
  const scout = row(page, 'process:release-scout');
  await expect(scout).toHaveAttribute('data-write', 'own-notes');
  await expect(scout.getByTestId('page-access-status')).toHaveText('Only its own notes');
  const others = page.getByTestId('page-access-others');
  await others.getByTestId('page-access-others-toggle').click();
  const knowledge = others.locator(
    '[data-testid="page-access-row"][data-actor="process:knowledge"]',
  );
  await expect(knowledge).toHaveAttribute('data-write', 'no');
  await expect(knowledge.getByTestId('page-access-reason')).toContainText([
    'Agent pages are grants. Only people change them.',
  ]);
});

test('a cached source says both agents can rewrite it, past their scopes', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page);
  await openInfo(page, 'PHX-421 — Rehearse the warehouse rollback end to end');
  await expect(page.getByTestId('page-access-summary')).toHaveText(
    '2 of 2 agents can change this page.',
  );
  const knowledge = row(page, 'process:knowledge');
  await expect(knowledge).toHaveAttribute('data-write', 'yes');
  await expect(knowledge.getByTestId('page-access-reason')).toContainText([
    'Rewrites cached sources with: Cache a fetched source, whatever its write scope.',
  ]);
  const scout = row(page, 'process:release-scout');
  await expect(scout).toHaveAttribute('data-write', 'yes');
  await expect(scout.getByTestId('page-access-reason').first()).toHaveText(
    'Outside its write scope: records/risks/.',
  );
});
