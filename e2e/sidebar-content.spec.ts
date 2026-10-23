import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { boot, showPages } from './boot';

const areas = ['Knowledge', 'Databases', 'Agents', 'Pages', 'Home'] as const;

for (const area of areas) {
  test(`${area} sidebar keeps contextual navigation distinct from the global rail`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await boot(page);
    const sidebar = page.getByTestId('sidebar');
    const door = page.getByTestId('app-rail').getByRole('button', { name: area, exact: true });
    if ((await door.getAttribute('aria-pressed')) !== 'true' || !(await sidebar.isVisible())) {
      await door.click();
    }
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-nav-area', area.toLowerCase());
    await expect(door).toHaveAttribute('aria-pressed', 'true');

    if (area === 'Knowledge') await expect(page.getByTestId('knowledge-page')).toBeVisible();
    if (area === 'Agents') await expect(page.getByTestId('agents-page')).toBeVisible();
    if (area === 'Pages') await expect(page.getByTestId('pages-browser')).toBeVisible();
    if (area === 'Databases')
      await expect(sidebar.getByTestId('sidebar-type').first()).toBeVisible();
    if (area === 'Home') await expect(page.getByTestId('nav-surfaces')).toBeVisible();

    // Retain real rendered content and geometry for review. A contextual area
    // has one label; the global rail remains a separate navigation scope.
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(8, 8);
    const content = await sidebar.evaluate((node) => {
      const shown = (element: Element) => element.getClientRects().length > 0;
      return {
        area: node.getAttribute('data-nav-area'),
        text: (node as HTMLElement).innerText,
        width: node.querySelector('.m71-context-body')!.clientWidth,
        contentWidth: node.querySelector('.m71-context-body')!.scrollWidth,
        buttons: [...node.querySelectorAll<HTMLButtonElement>('button')]
          .filter(shown)
          .map((button) => ({
            label: button.getAttribute('aria-label') ?? button.innerText,
            expanded: button.getAttribute('aria-expanded'),
            current: button.getAttribute('aria-current'),
          })),
        sections: [...node.querySelectorAll<HTMLElement>('[data-section]')]
          .filter(shown)
          .map((section) => section.dataset.section),
      };
    });
    expect(content.contentWidth).toBeLessThanOrEqual(content.width + 1);
    expect(content.text.split('\n').filter((line) => line.trim() === area)).toHaveLength(1);
    await expect(sidebar.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
    await expect(
      page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true }),
    ).toBeVisible();
    await writeFile(info.outputPath('sidebar-content.json'), JSON.stringify(content, null, 2));
    await sidebar.screenshot({
      path: info.outputPath(`sidebar-${area.toLowerCase()}.png`),
      animations: 'disabled',
    });

    await page.screenshot({
      path: info.outputPath(`workspace-${area.toLowerCase()}.png`),
      animations: 'disabled',
    });

    if (area === 'Knowledge' || area === 'Databases' || area === 'Agents') {
      const toggle = sidebar.getByRole('button', { name: area, exact: true });
      const first = sidebar
        .getByTestId(
          area === 'Knowledge'
            ? 'knowledge-nav-row'
            : area === 'Databases'
              ? 'sidebar-type'
              : 'nav-agent',
        )
        .first();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await toggle.focus();
      await toggle.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(first).not.toBeVisible();
      // The same persisted fold survives leaving this contextual area.
      await page
        .getByTestId('app-rail')
        .getByRole('button', { name: 'Pages', exact: true })
        .click();
      await door.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(first).not.toBeVisible();
      await toggle.focus();
      await toggle.press('Enter');
      await expect(first).toBeVisible();
    }

    // Exercise one real contextual destination in each area after the
    // overview capture, so simplified chrome cannot strand its content.
    if (area === 'Knowledge') {
      await sidebar.getByTestId('knowledge-nav-row').filter({ hasText: 'Review' }).click();
      await expect(page.getByTestId('knowledge-tab-review')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByTestId('queue-row').first()).toBeVisible();
    } else if (area === 'Databases') {
      await sidebar.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).click();
      await expect(page.getByTestId('type-page')).toBeVisible();
      await expect(page.getByTestId('type-title-edit')).toHaveText('Work item');
    } else if (area === 'Agents') {
      const agent = sidebar.getByTestId('nav-agent').first();
      const title = (await agent.innerText()).trim();
      await agent.click();
      await expect(page.getByTestId('doc-page')).toBeVisible();
      await expect(page.getByTestId('doc-page').locator('[data-page-title] h1')).toHaveText(title);
      await expect(agent).toHaveAttribute('aria-current', 'page');
    } else if (area === 'Pages') {
      const collections = sidebar.getByRole('button', { name: 'Collections', exact: true });
      const folders = sidebar.getByRole('button', { name: 'Folders', exact: true });
      const expectSingleTree = async () => {
        for (const label of ['Delivery', 'Strategy']) {
          await expect(
            sidebar.getByText(label, { exact: true }).filter({ visible: true }),
          ).toHaveCount(1);
        }
      };
      await expect(collections).toHaveAttribute('aria-expanded', 'true');
      await expect(folders).toHaveAttribute('aria-expanded', 'false');
      await expectSingleTree();
      const collectionDelivery = sidebar
        .getByTestId('collection-node-collection')
        .filter({ hasText: 'Delivery' });
      await collectionDelivery
        .getByRole('button', { name: 'Expand Delivery', exact: true })
        .click();
      await expect(
        collectionDelivery.getByRole('button', { name: 'Collapse Delivery', exact: true }),
      ).toBeVisible();
      await collectionDelivery
        .getByRole('button', { name: 'Collapse Delivery', exact: true })
        .click();

      await folders.click();
      await expect(folders).toHaveAttribute('aria-expanded', 'true');
      await expect(collections).toHaveAttribute('aria-expanded', 'false');
      await expect(collectionDelivery).not.toBeVisible();
      await expectSingleTree();
      await page.mouse.move(8, 8);
      await page.screenshot({
        path: info.outputPath('workspace-pages-folders.png'),
        animations: 'disabled',
      });
      const folderDelivery = sidebar.getByTestId('tree-folder').filter({ hasText: 'Delivery' });
      await folderDelivery.click();
      await expect(folderDelivery).toHaveAttribute('aria-expanded', 'true');
      await folderDelivery.click();
      await expect(folderDelivery).toHaveAttribute('aria-expanded', 'false');

      // Browse mode persists independently of the existing section folds.
      await page.reload();
      await expect(page.getByTestId('app-rail')).toBeVisible();
      await showPages(page);
      await expect(folders).toHaveAttribute('aria-expanded', 'true');
      await expect(collections).toHaveAttribute('aria-expanded', 'false');
      await expectSingleTree();
      await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
      await expect(collections).toHaveAttribute('aria-expanded', 'true');
      await expect(collectionDelivery).toBeVisible();
      await showPages(page);
      await expect(folders).toHaveAttribute('aria-expanded', 'true');
      await expectSingleTree();
      await expect(
        sidebar.getByRole('button', { name: 'Browse all pages', exact: true }),
      ).toHaveCount(0);
      await sidebar.getByRole('button', { name: 'All pages', exact: true }).click();
      await expect(page.getByTestId('pages-browser')).toBeVisible();
      await expect(sidebar.getByRole('button', { name: 'All pages', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    } else {
      await sidebar
        .getByTestId('nav-surfaces')
        .getByRole('button', { name: 'History', exact: true })
        .click();
      await expect(page.getByTestId('history-heatmap')).toBeVisible();
    }
  });
}

test('folded Folders keeps its creation actions reachable without writing on open or cancel', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
  const sidebar = page.getByTestId('sidebar');
  const folders = sidebar.getByRole('button', { name: 'Folders', exact: true });
  const collections = sidebar.getByRole('button', { name: 'Collections', exact: true });
  const collectionDelivery = sidebar
    .getByTestId('collection-node-collection')
    .filter({ hasText: 'Delivery' });
  const before = await page.evaluate(() => [...window.__cerebroMockFs.entries()]);
  for (const action of ['New page', 'New folder']) {
    if ((await collections.getAttribute('aria-expanded')) !== 'true') await collections.click();
    await expect(collections).toHaveAttribute('aria-expanded', 'true');
    await expect(collectionDelivery).toBeVisible();
    await expect(folders).toHaveAttribute('aria-expanded', 'false');
    const create = sidebar.getByRole('button', { name: action, exact: true });
    await create.focus();
    await create.press('Enter');
    const dialog = page.getByRole('dialog', { name: action, exact: true });
    await expect(dialog).toBeVisible();
    await expect(folders).toHaveAttribute('aria-expanded', 'true');
    await expect(collections).toHaveAttribute('aria-expanded', 'false');
    await expect(collectionDelivery).not.toBeVisible();
    await expect(dialog.getByRole('textbox')).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`${action.toLowerCase().replace(' ', '-')}-from-folded.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  expect(await page.evaluate(() => [...window.__cerebroMockFs.entries()])).toEqual(before);
});
