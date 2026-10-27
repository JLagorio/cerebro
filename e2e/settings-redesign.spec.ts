import { expect, test } from '@playwright/test';
import { boot, chooseSettingsSection, openDestination } from './boot';

test('Settings lends its section navigation to the shell and aligns its utility detail', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openDestination(page, 'Settings');
  const settings = page.getByTestId('settings-page');
  const navigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(
    page.getByTestId('sidebar').getByRole('navigation', { name: 'Settings sections' }),
  ).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'General', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(settings.getByRole('tablist', { name: 'Theme' })).toBeVisible();
  await expect(page.getByTestId('nav-surfaces')).toBeHidden();
  // Both edges measure the pane's content width, including on WebKit where
  // a non-overlay vertical scrollbar occupies part of the outer box.
  const frame = await settings.evaluate((node) => ({
    x: node.getBoundingClientRect().x,
    y: node.getBoundingClientRect().y,
    width: node.clientWidth,
  }));
  const heading = (await settings.getByTestId('settings-heading').boundingBox())!;
  const edge = await settings
    .locator('.cb-settings-content')
    .evaluate(
      (node) => node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft),
    );
  const inset = frame.width < 600 ? 16 : frame.width < 960 ? 24 : 32;
  expect(Math.abs(heading.x - frame.x - inset)).toBeLessThanOrEqual(2);
  expect(Math.abs(heading.y - frame.y - 32)).toBeLessThanOrEqual(2);
  expect(Math.abs(edge - heading.x)).toBeLessThanOrEqual(2);
  const appearance = (await settings.getByRole('heading', { name: 'Appearance' }).boundingBox())!;
  expect(Math.abs(appearance.x - heading.x)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath('settings-general.png'), animations: 'disabled' });

  await chooseSettingsSection(page, 'Assistant');
  await expect(settings.getByRole('tablist', { name: 'Theme' })).toBeHidden();
  await expect(page.getByTestId('settings-claude-code')).toBeVisible();
  await expect(page.getByTestId('shell-hint')).toContainText(
    "can't run commands or edit files directly",
  );
  await page.getByTestId('shell-ask').click();
  await expect(page.getByTestId('shell-hint')).toContainText("Scheduled agents can't ask");
  expect(await page.evaluate(() => localStorage.getItem('cerebro.agentShell'))).toBe('ask');
  await page.screenshot({
    path: info.outputPath('settings-assistant.png'),
    animations: 'disabled',
  });
});

test('Settings keeps unsaved local drafts across sections and the theme survives a reload', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, { preserveTheme: true });
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Other apps');
  const port = page.getByRole('textbox', { name: 'Client port' });
  await expect(port).toBeEnabled();
  await port.fill('45678');
  const handle = await port.elementHandle();
  await chooseSettingsSection(page, 'General');
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await chooseSettingsSection(page, 'Other apps');
  await expect(port).toHaveValue('45678');
  expect(await port.evaluate((element, old) => element === old, handle)).toBe(true);
  await page.screenshot({
    path: info.outputPath('settings-other-apps-dark.png'),
    animations: 'disabled',
  });
  await page.reload();
  await expect(page.getByTestId('app-rail')).toBeVisible();
  await openDestination(page, 'Settings');
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('compact Settings opens its section drawer and returns focus to a usable detail', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(page.getByTestId('settings-heading')).toBeVisible();
  await page.getByTestId('settings-page').getByRole('button', { name: 'Sections' }).click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-overlay', 'true');
  await page.screenshot({
    path: info.outputPath('settings-sections-compact.png'),
    animations: 'disabled',
  });
  await chooseSettingsSection(page, 'Mail');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(
    page.getByTestId('settings-page').getByRole('button', { name: 'Sections' }),
  ).toBeFocused();
  await expect(page.getByTestId('mail-gate')).toContainText(
    'No run can save mail digests until it is enabled.',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
  const detail = (await page.getByTestId('settings-page').boundingBox())!;
  expect(detail.y + detail.height).toBeLessThanOrEqual(600);
  await page.getByTestId('settings-page').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: info.outputPath('settings-mail-compact.png'),
    animations: 'disabled',
  });
  await page
    .getByTestId('app-rail')
    .getByRole('button', { name: 'Theme: light', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: info.outputPath('settings-mail-compact-dark.png'),
    animations: 'disabled',
  });
});
