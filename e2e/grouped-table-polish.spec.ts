import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { boot, openDatabase, readMockFile } from './boot';

for (const width of [1440, 1728]) {
  test(`nested At risk groups retain their fields and controls at ${width}px beside a peek`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1080 });
    await page.addInitScript(() => localStorage.setItem('cerebro.detailWidth', '560'));
    await boot(page);
    const before = await readMockFile(page, 'types/work-item.md');
    await openDatabase(page, 'Work item');
    await page.getByTestId('view-tab-at-risk-work').click();
    const grid = page.getByTestId('table-view');
    await expect(grid.getByTestId('table-row')).toHaveCount(13);
    expect(
      await grid
        .getByTestId('table-row')
        .evaluateAll((rows) => new Set(rows.map((row) => row.getAttribute('data-path'))).size),
    ).toBe(13);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(8, 8);
    await page.screenshot({ path: info.outputPath('at-risk-wide.png'), animations: 'disabled' });
    const wide = await grid.evaluate((node) => ({
      width: node.clientWidth,
      content: node.scrollWidth,
    }));
    expect(wide.content).toBeLessThanOrEqual(wide.width + 1);
    const target = grid
      .getByTestId('table-row')
      .filter({ hasText: 'Rewrite messaging for the console split' });
    await target.hover();
    await target
      .getByRole('button', { name: 'Open Rewrite messaging for the console split', exact: true })
      .click();
    const peek = page.getByTestId('detail-panel');
    await expect(peek).toBeVisible();
    for (const group of await grid.getByTestId('table-group-header').all()) {
      if ((await group.getAttribute('data-depth')) !== '1') continue;
      const toggle = group.getByRole('button', { name: /^Collapse / });
      if (
        (await toggle.count()) > 0 &&
        !/Dana Fox|Maya Chen/.test((await toggle.getAttribute('aria-label'))!)
      ) {
        await toggle.click();
      }
    }
    await grid.evaluate((node) => {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    });
    await page.mouse.move(8, 8);
    await page.screenshot({ path: info.outputPath('at-risk-peek.png'), animations: 'disabled' });
    const metrics = await grid.evaluate((node) => {
      const rows = [...node.querySelectorAll<HTMLElement>('[data-testid="table-row"]')];
      const headings = [
        ...node.querySelectorAll<HTMLElement>('[data-testid="table-group-header"]'),
      ];
      return {
        width: node.clientWidth,
        content: node.scrollWidth,
        columns: [...node.querySelectorAll<HTMLElement>('[role="columnheader"]')].map((cell) => ({
          name: cell.textContent,
          width: cell.getBoundingClientRect().width,
        })),
        rows: rows.map((row) => ({
          title: row.querySelector('[data-cell-primary]')?.textContent,
          y: row.getBoundingClientRect().y,
          height: row.getBoundingClientRect().height,
        })),
        groups: headings.map((heading) => ({
          name: heading.textContent,
          depth: heading.dataset.depth,
          height: heading.getBoundingClientRect().height,
        })),
      };
    });
    await info.attach('geometry', {
      body: JSON.stringify({ wide, peek: metrics }, null, 2),
      contentType: 'application/json',
    });
    await writeFile(
      info.outputPath('geometry.json'),
      JSON.stringify({ wide, peek: metrics }, null, 2),
    );
    expect(
      metrics.groups.filter((group) => group.depth === '1').every((group) => group.height === 28),
    ).toBe(true);
    expect(metrics.columns.find((column) => column.name?.includes('Due'))?.width).toBe(120);
    const firstTitle = grid.getByTestId('table-row').first().locator('[data-cell-primary]').first();
    const nameHeader = grid.getByRole('button', { name: 'Name column menu', exact: true });
    expect(
      Math.abs((await firstTitle.boundingBox())!.x - (await nameHeader.boundingBox())!.x),
    ).toBeLessThanOrEqual(1);
    const nameBeforeScroll = (await nameHeader.boundingBox())!.x;
    expect(await readMockFile(page, 'types/work-item.md')).toBe(before);
    await expect(grid.getByRole('columnheader')).toHaveCount(6);
    await grid.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    expect((await nameHeader.boundingBox())!.x).toBe(nameBeforeScroll);
    const add = grid.getByRole('button', { name: 'Add a column', exact: true });
    await expect(add).toBeInViewport();
    await add.click();
    await expect(page.getByTestId('add-property-panel')).toBeVisible();
  });
}
