import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * M49.6 (K28): the divergence path, rendered and driven end to end — it had
 * never been rendered in any test before the 2026-09 incident. The browser
 * mock keeps no ledger, so each spec seeds the status it needs before the
 * app loads.
 */

const EDITED = {
  path: 'knowledge/metrics/sync-error-rate.md',
  class: 'adoptable',
  reason: 'edited outside Cerebro',
};
const FORGED = {
  path: 'knowledge/systems/status-model.md',
  class: 'refused',
  reason: 'provenance forgery: the verified stamp changed out of band — refused',
};

async function seedThenBoot(page: Page, seed: Record<string, unknown>) {
  await page.addInitScript((s) => {
    (window as unknown as { __cerebroLedgerSeed: unknown }).__cerebroLedgerSeed = s;
  }, seed);
  await boot(page);
}

test('M49.6: the banner names each diverged file, and Keep-all says what it could not keep', async ({
  page,
}) => {
  await seedThenBoot(page, { quarantined: [EDITED, FORGED] });
  const banner = page.getByTestId('reconciliation-banner');
  await expect(banner).toContainText('2 knowledge files differ from their recorded history.');
  const rows = page.getByTestId('quarantine-list').getByRole('listitem');
  await expect(rows).toHaveCount(2);
  // Keep is offered only where it can work.
  await expect(rows.nth(0).getByRole('button', { name: 'Keep' })).toBeVisible();
  await expect(rows.nth(1).getByRole('button', { name: 'Keep' })).toHaveCount(0);
  await expect(rows.nth(1)).toContainText('provenance forgery');

  await banner.getByRole('button', { name: 'Keep all' }).click();
  await expect(page.getByTestId('reconciliation-error')).toContainText('kept 1 of 2 files');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-path', FORGED.path);
});

test('M49.6: Restore asks first, then closes the divergence', async ({ page }) => {
  await seedThenBoot(page, { quarantined: [FORGED] });
  const banner = page.getByTestId('reconciliation-banner');
  const row = page.getByTestId('quarantine-list').getByRole('listitem');
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(banner).toBeVisible();
  await row.getByRole('button', { name: 'Confirm restore' }).click();
  await expect(banner).toHaveCount(0);
});

test('M49.6: a status read that fails is said, never shown as nothing wrong', async ({ page }) => {
  await seedThenBoot(page, { unreadable: 'the ledger could not be read' });
  const recording = page.getByTestId('recording-banner');
  await expect(recording).toHaveAttribute('data-state', 'unavailable');
  await expect(recording).toContainText('the ledger could not be read');
});

test('M49.2: a vault another Cerebro is recording says so', async ({ page }) => {
  await seedThenBoot(page, {
    writer: {
      state: 'lost-lock',
      detail: 'ledger_lock_held: another Cerebro instance holds this vault (held by pid 42)',
    },
  });
  const recording = page.getByTestId('recording-banner');
  await expect(recording).toHaveAttribute('data-state', 'lost-lock');
  await expect(recording).toContainText('Not recording knowledge.');
  await expect(recording).toContainText('pid 42');
});
