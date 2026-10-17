import { expect, test } from '@playwright/test';
import { boot, openDestination } from './boot';

// M59.1 — one destination table feeds the nav, ⌘K and the window title.
test('the window title names the place, and ⌘K speaks the nav’s words', async ({ page }) => {
  await boot(page);
  await expect(page).toHaveTitle('Home — Cerebro');

  await openDestination(page, 'History');
  await expect(page).toHaveTitle('History — Cerebro');

  // An untyped page is a Page, and opening it titles the window with it.
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('quick-open-input');
  await input.fill('systems map');
  const map = page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first();
  await expect(map).toContainText(/Page$/);
  await map.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await expect(page).toHaveTitle('Systems map — Cerebro');

  // The places say History; nothing says Pulse.
  await page.keyboard.press('ControlOrMeta+k');
  await input.fill('history');
  const history = page
    .getByTestId('quick-open-result')
    .filter({ has: page.getByText('History', { exact: true }) })
    .filter({ has: page.getByText('Go to', { exact: true }) });
  await expect(history).toHaveCount(1);
  await input.fill('pulse');
  await expect(page.getByTestId('quick-open-result').filter({ hasText: /^Pulse/ })).toHaveCount(0);
});
