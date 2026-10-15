import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot } from './boot';
const frame = (page: Page, index: number) =>
  page.locator(`[data-testid="pane"][data-pane-index="${index}"]`);
async function openPage(page: Page, title: string, beside = false) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title);
  await expect(
    page.getByTestId('quick-open-result').filter({ hasText: title }).first(),
  ).toBeVisible();
  await page.keyboard.press(beside ? 'Shift+Enter' : 'Enter');
  await expect(page.getByTestId('quick-open-input')).toHaveCount(0);
  await expect(page).toHaveTitle(`${title} — Cerebro`);
}
test('reload restores two panes and the first focus, without the peek', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openPage(page, 'How we schedule');
  await openPage(page, 'Systems map', true);
  await frame(page, 0).getByTestId('pane-bar').click();
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'My work' }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(frame(page, 0)).toHaveAttribute('data-active', 'true');
  await expect(frame(page, 0).getByTestId('pane-bar')).toContainText('My work');
  await expect(frame(page, 1).getByTestId('pane-bar')).toContainText('Systems map');
  await expect(page.getByTestId('detail-panel')).toHaveCount(0);
  await expect(
    frame(page, 1).getByRole('heading', { name: 'Systems map', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('restored-panes.png'),
    animations: 'disabled',
  });
});
test('a missing stored pane is dropped before a page can render', async ({ page }) => {
  await page.addInitScript(() =>
    window.localStorage.setItem(
      'cerebro.panes',
      JSON.stringify({
        '/demo-vault': {
          v: 1,
          active: 1,
          panes: [
            { index: 0, entries: [{ kind: 'doc', path: 'strategy/systems-map.md' }] },
            { index: 0, entries: [{ kind: 'doc', path: 'notes/gone.md' }] },
          ],
        },
      }),
    ),
  );
  await boot(page);
  await expect(page.getByTestId('pane')).toHaveCount(1);
  await expect(page).toHaveTitle('Systems map — Cerebro');
  await expect(page.getByText('This page no longer exists.')).toHaveCount(0);
});
test('a rename moves the open pane, favorite, Recent and saved layout together', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedFileBeforeBoot(
    page,
    'delivery/how-we-schedule.md',
    '# How we schedule\n\nSee [[systems-map]].\n',
  );
  await boot(page);
  await openPage(page, 'How we schedule');
  await openPage(page, 'Systems map', true);
  await frame(page, 1).getByRole('button', { name: 'Add to favorites' }).click();
  await openPage(page, 'Systems map');
  const tree = page.getByTestId('file-tree');
  const folder = tree.getByTestId('tree-folder').filter({ hasText: 'Strategy' });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  await tree
    .locator('[data-testid="tree-row"][data-path="strategy/systems-map.md"]')
    .getByTestId('tree-file')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByPlaceholder('Page name').fill('Systems atlas');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const prompt = page.getByTestId('rename-links-prompt');
  await expect(prompt).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Rename and update' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(frame(page, 1).getByTestId('pane-bar')).toContainText('Systems atlas');
  await expect(page.getByTestId('nav-favorite')).toContainText('Systems atlas');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('group', { name: 'Recent' })).toContainText('Systems atlas');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(window.localStorage.getItem('cerebro.panes') ?? '{}')[
            '/demo-vault'
          ].panes[1].entries.at(-1).path,
      ),
    )
    .toBe('strategy/systems-atlas.md');
  await page.screenshot({
    path: testInfo.outputPath('renamed-pointers.png'),
    animations: 'disabled',
  });
});
