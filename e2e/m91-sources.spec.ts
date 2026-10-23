import { expect, test, type Page } from '@playwright/test';
import { askAssistant, assistantSettled, boot, openAssistantPanel } from './boot';

/**
 * What a reply drew on (M91.15): the mock's `search the web` script searches
 * and fetches with Claude Code's web tools, with the results Rust's fold
 * sends, and answers with links. Once the turn is done its Sources list each
 * page as a link that opens a new tab (CV-16: an http(s) href is all a web
 * link needs), and each link in the answer is an inline citation whose card
 * opens on hover and on keyboard focus — the `:focus-visible` path jsdom
 * cannot exercise (M91.9b) — and describes its link while it is open. Web
 * access is on, as a person turns it on in Settings.
 */

const LEAD_TIMES = 'https://example.com/scanners/lead-times';
const CUTOVER = 'https://example.org/guides/cutover';

async function searched(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('cerebro.agentWebAccess', 'true'));
  await boot(page);
  await openAssistantPanel(page);
  await askAssistant(page, 'search the web for scanner lead times');
  await assistantSettled(page, 1);
  return page
    .getByTestId('ai-panel')
    .locator('[data-testid="chat-message"][data-role="assistant"]');
}

test('search the web: Sources lists each page the turn found, as a link that opens a new tab', async ({
  page,
  context,
}) => {
  const reply = await searched(page);
  await expect(
    reply.getByRole('button', { name: /^Searched the web warehouse scanner lead times/ }),
  ).toBeVisible();
  await expect(reply.getByRole('button', { name: `Fetched a page ${LEAD_TIMES}` })).toBeVisible();

  // Closed until asked, then a link per page, in the order the turn met them.
  const sources = reply.getByTestId('turn-sources');
  const opener = sources.getByRole('button', { name: 'Used 2 sources', exact: true });
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await opener.click();
  const links = sources.locator('[data-slot="sources-list"]').getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAccessibleName(
    'Scanner lead times - Example Logistics example.com (opens in a new tab)',
  );
  await expect(links.nth(1)).toHaveAccessibleName(
    'Planning a warehouse cutover example.org (opens in a new tab)',
  );
  for (const [link, href] of [
    [links.nth(0), LEAD_TIMES],
    [links.nth(1), CUTOVER],
  ] as const) {
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  }

  // It opens in a tab of its own, and the app stays where it was. The page is
  // stood in for: no spec reaches the network.
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Lead times</title>' }),
  );
  const app = page.url();
  const [tab] = await Promise.all([context.waitForEvent('page'), links.nth(0).click()]);
  await expect(tab).toHaveURL(LEAD_TIMES);
  expect(page.url()).toBe(app);
  await expect(page.getByTestId('ai-panel')).toBeVisible();
});

test('an inline citation opens its card on hover and on keyboard focus, and the card describes its link', async ({
  page,
}) => {
  const reply = await searched(page);
  const first = reply.getByRole('link', { name: 'Example Logistics', exact: true });
  const second = reply.getByRole('link', { name: 'Planning a warehouse cutover', exact: true });
  const card = page.getByRole('group', { name: 'Source', exact: true });

  // Hover: the card names the source and links out, and describes the link.
  await first.hover();
  await expect(card).toContainText('Example Logistics');
  await expect(
    card.getByRole('link', { name: 'example.com (opens in a new tab)' }),
  ).toHaveAttribute('href', LEAD_TIMES);
  await expect(first).toHaveAttribute('aria-describedby', (await card.getAttribute('id')) ?? '');
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
  await expect(first).not.toHaveAttribute('aria-describedby', /.+/);

  // Keyboard: Tab onto the next citation opens its card, which describes it,
  // and Escape closes the card while the link keeps focus.
  await first.focus();
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
  await expect(card).toContainText('Planning a warehouse cutover');
  await expect(
    card.getByRole('link', { name: 'example.org (opens in a new tab)' }),
  ).toHaveAttribute('href', CUTOVER);
  await expect(second).toHaveAttribute('aria-describedby', (await card.getAttribute('id')) ?? '');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(second).toBeFocused();
});
