import { expect, test, type Page } from '@playwright/test';
import { chooseSettingsSection, boot, seedBeforeBoot, openDestination } from './boot';

/**
 * Connector status in Settings (M54.11), and the presets (M69.1). The
 * browser runs no agent, so the last-seen rows Rust would read from
 * runtime.db are seeded through the mock's `__cerebroSeedConnectorStatus`;
 * everything after that is the page.
 */

const GMAIL_URL = 'https://gmail.example.test/mcp';

async function openConnectors(page: Page) {
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  const toggle = page.getByRole('switch', { name: 'Connectors', exact: true });
  if (!(await toggle.isChecked())) {
    // The checkbox itself is 0×0 by design; the label is what a user clicks.
    await page.locator('label.cb-switch').filter({ has: toggle }).click();
  }
  await expect(page.getByTestId('connector-settings')).toBeVisible();
}

async function addHttp(page: Page, name: string, url: string) {
  const settings = page.getByTestId('connector-settings');
  await settings.getByPlaceholder('Name').fill(name);
  await settings.getByPlaceholder('https://…/mcp').fill(url);
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
}

test('connectors: one that needs sign-in shows the command that fixes it (M54.11)', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedConnectorStatus', [
    {
      connector: 'Gmail',
      cli_name: 'Gmail',
      refused: null,
      state: 'needs_sign_in',
      signal: 'init',
      seen_at: '2026-07-28T11:00:00.000Z',
      run_id: 'run-1',
    },
  ]);
  await boot(page);
  await openConnectors(page);
  await addHttp(page, 'Gmail', GMAIL_URL);

  const settings = page.getByTestId('connector-settings');
  await expect(settings.getByTestId('connector-status')).toHaveText('Gmail — needs sign-in');
  await expect(settings.getByTestId('connector-status')).toHaveAttribute(
    'data-state',
    'needs_sign_in',
  );
  await expect(settings.getByTestId('connector-sign-in-command')).toHaveText(
    `claude mcp add --transport http Gmail ${GMAIL_URL}`,
  );
  await expect(settings.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  // The clock is pinned to VAULT_TODAY, an hour after the seeded run.
  await expect(settings.getByTestId('connector-seen')).toHaveText('seen 1 hour ago');
  await expect(page.locator('body')).not.toContainText('nothing connected');
  await expect(settings).not.toContainText('registered');
});

test('connectors: one no run has used reads not observed yet', async ({ page }) => {
  await boot(page);
  await openConnectors(page);
  await addHttp(page, 'Gmail', GMAIL_URL);

  const settings = page.getByTestId('connector-settings');
  await expect(settings.getByTestId('connector-status')).toHaveText('Gmail — not observed yet');
  await expect(settings.getByTestId('connector-sign-in')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('nothing connected');
});

test('connectors: a status read that fails says so, never not observed yet', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedConnectorStatus', 'fail');
  await boot(page);
  await openConnectors(page);
  await addHttp(page, 'Gmail', GMAIL_URL);

  const settings = page.getByTestId('connector-settings');
  await expect(settings.getByTestId('section-unavailable')).toBeVisible();
  await expect(settings.getByTestId('connector-status')).toHaveText('Gmail');
  await expect(settings).not.toContainText('not observed yet');
  await expect(page.locator('body')).not.toContainText('nothing connected');
});

test('connectors: Add Linear signs in under its name with its scopes, and Remove says the sign-in stays (M69.1)', async ({
  page,
}) => {
  await boot(page);
  await openConnectors(page);
  const settings = page.getByTestId('connector-settings');
  await expect(settings).toContainText('Add a connector:');
  await settings.getByTestId('connector-preset-linear').click();

  await expect(settings.getByTestId('connector-status')).toHaveText('linear — not observed yet');
  await expect(settings).toContainText('https://mcp.linear.app/mcp · oauth scopes: read write');
  const command = settings.getByTestId('connector-sign-in-command');
  await expect(command).toContainText('claude mcp add-json linear');
  await expect(command).toContainText('"scopes":"read write"');
  await expect(settings.getByTestId('connector-signin-linear')).toBeVisible();
  const preset = settings.getByTestId('connector-preset-linear');
  await expect(preset).toBeDisabled();
  await expect(preset).toHaveAttribute('title', 'Already listed as linear');
  await expect(settings.getByTestId('connector-preset-notion')).toBeEnabled();

  await settings.getByRole('button', { name: 'Remove linear' }).click();
  await expect(page.getByTestId('toast-host')).toContainText(
    'Removed linear. Claude Code keeps the sign-in it stored for linear in your keychain; Cerebro never held it.',
  );
  await expect(settings.getByTestId('connector-preset-linear')).toBeEnabled();
});
