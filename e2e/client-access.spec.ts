import { expect, test, type Page } from '@playwright/test';
import { chooseSettingsSection, boot, openStateLab, seedBeforeBoot, openDestination } from './boot';
async function settings(page: Page) {
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Other apps');
  await expect(page.getByTestId('client-access')).toBeVisible();
  return page.getByTestId('client-access');
}
test('a token is shown once, with safe snippets, and revoke asks first', async ({ page }, info) => {
  const section = await settings(page);
  const toggle = page.getByRole('switch', { name: 'Let other apps connect' });
  await expect(toggle).toBeEnabled();
  await section.locator('label.cb-switch').filter({ has: toggle }).click();
  await expect(section.getByTestId('client-access-status')).toHaveText(
    'Listening at http://127.0.0.1:37421/mcp.',
  );
  await section.getByRole('button', { name: 'Make a token' }).click();
  await page.getByRole('textbox', { name: 'Token name' }).fill('Terminal');
  await page.getByRole('button', { name: 'Make token', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Your token' });
  const secret = (await dialog.getByTestId('client-token-secret').textContent())!;
  expect(secret).toMatch(/^cbr_[0-9a-f]{64}$/);
  await expect(dialog.locator('[data-client="claude-code"]')).toContainText(secret);
  await expect(dialog.locator('[data-client="cursor"]')).toContainText(secret);
  await expect(dialog).toContainText('Claude Desktop needs a local bridge');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
  // Screenshots deliberately show only the placeholder view after the secret is cleared.
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('body')).not.toContainText(secret);
  await expect(section.locator('[data-client="claude-code"]')).toContainText('<your token>');
  await section.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: info.outputPath('other-apps-settings.png') });
  await section.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Revoke Terminal?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(section.getByTestId('client-token')).toHaveCount(1);
  await section.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke token', exact: true }).click();
  await expect(section).toContainText('No app has a token yet.');
});
test('writing tokens require named folders and use whole-vault reads by default', async ({
  page,
}, info) => {
  const section = await settings(page);
  await section.getByRole('button', { name: 'Make a token' }).click();
  await page.getByRole('textbox', { name: 'Token name' }).fill('Writer');
  await page.getByRole('checkbox', { name: /Write to the vault/ }).check();
  await page.getByRole('button', { name: 'Make token', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose from 1 to 20 write folders.');
  await page.getByRole('button', { name: 'Choose write folders' }).click();
  await page
    .getByTestId('picker-option')
    .filter({ hasText: /^records$/ })
    .click();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('scoped-token-dialog.png') });
  await page.getByRole('button', { name: 'Make token', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Your token' })
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect(section.getByTestId('client-token')).toContainText('Writes records');
  await expect(section.getByTestId('client-token')).toContainText('Reads the whole vault');
});
test('twenty tokens is the global cap', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedClientTokens', 20);
  const section = await settings(page);
  await expect(section.getByTestId('client-token')).toHaveCount(20);
  await expect(section.getByRole('button', { name: 'Make a token' })).toBeDisabled();
  await expect(section).toContainText('You have 20 tokens. Revoke one to make another.');
});
test('the listener reports its address and refuses invalid ports in words', async ({ page }) => {
  const section = await settings(page);
  await expect(section.getByTestId('client-access-status')).toHaveText(
    "Off. Other apps can't connect.",
  );
  const toggle = page.getByRole('switch', { name: 'Let other apps connect' });
  await expect(toggle).toBeEnabled();
  await section.locator('label.cb-switch').filter({ has: toggle }).click();
  await expect(section.getByTestId('client-access-status')).toHaveText(
    'Listening at http://127.0.0.1:37421/mcp.',
  );
  await section.getByRole('textbox', { name: 'Client port' }).fill('80');
  await section.getByRole('button', { name: 'Save port' }).click();
  await expect(page.locator('body')).toContainText('Choose a port from 1024 to 65535.');
  await section.getByRole('textbox', { name: 'Client port' }).fill('37500');
  await section.getByRole('button', { name: 'Save port' }).click();
  await expect(section.getByTestId('client-access-status')).toHaveText(
    'Listening at http://127.0.0.1:37500/mcp.',
  );
});

test('Other apps renders every state-lab preset', async ({ page }) => {
  const expected = {
    ready: 'App 2',
    empty: 'No app has a token yet.',
    'not-recorded': 'Never used',
    partial: "Couldn't read whether other apps can connect.",
    unavailable: "Couldn't read tokens.",
  };
  for (const [state, text] of Object.entries(expected)) {
    await openStateLab(page, 'client-access', state);
    await expect(page.getByTestId('lab-stage')).toContainText(text);
    if (state === 'unavailable')
      await expect(page.getByTestId('lab-stage')).not.toContainText('No app has a token yet.');
  }
});
