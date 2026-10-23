import { expect, test, type Page } from '@playwright/test';
import { boot, openKnowledgeTab, showDatabases } from './boot';

async function openFixture(
  page: Page,
  theme: 'light' | 'dark' = 'light',
  scalar = false,
  sweep = false,
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((theme) => localStorage.setItem('cerebro.themeMode', theme), theme);
  await page.addInitScript(
    ({ scalar, sweep }) => {
      const seed = () => {
        const fs = window.__cerebroMockFs;
        const source = fs?.get('types/work-item.md');
        if (source === undefined) {
          setTimeout(seed, 10);
          return;
        }
        const columns = `[{ field: status, width: 150 }, { field: priority, width: 150 }, { field: assignee, width: 180 }, { field: due, width: 160 }, { field: ${scalar ? 'capacity' : 'estimate'}, width: 150 }, { field: project, width: 220 }]`;
        const views = (
          sweep
            ? ['table', 'board', 'calendar', 'timeline', 'chart', 'dashboard']
            : ['table', 'gallery', 'list', 'gantt', 'calendar']
        )
          .map(
            (kind) =>
              `  - id: polish-${kind}\n    name: ${kind}\n    filters: null\n    presentation:\n      type: ${kind}\n      group: ${kind === 'board' || kind === 'chart' ? '[{ field: status }]' : '[]'}\n      sort: []\n      columns: ${columns}\n      dateField: window\n${kind === 'chart' ? '      chart: { kind: bar, agg: count, legend: true }\n' : ''}${kind === 'dashboard' ? '      dashboard:\n        rows:\n          - id: overview\n            height: 320\n            widgets:\n              - { id: total, kind: number, title: Records, agg: count }\n              - { id: status-chart, kind: chart, title: By status, group: status, chart: { kind: bar, agg: count } }\n' : ''}`,
          )
          .join('');
        fs.set(
          'types/work-item.md',
          (scalar
            ? source.replace('\nfields:\n', '\nfields:\n  capacity: { kind: number }\n')
            : source
          ).replace(/\nviews:[\s\S]*?(?=\n---)/, `\nviews:\n${views}`),
        );
      };
      seed();
    },
    { scalar, sweep },
  );
  await boot(page, { preserveTheme: true });
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('table-view')).toBeVisible();
}

test('six-column Gantt budgets a readable axis, resizes by keyboard and scrolls columns independently', async ({
  page,
}, info) => {
  await openFixture(page);
  const before = await page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md'));
  await page.screenshot({ path: info.outputPath('table-wide.png'), animations: 'disabled' });
  await page.getByTestId('view-tab-polish-gantt').click();
  const host = page.getByTestId('time-viewport');
  const table = page.getByTestId('time-table-viewport');
  const axis = page.getByTestId('time-axis-viewport');
  const hostBox = (await host.boundingBox())!;
  const tableBox = (await table.boundingBox())!;
  expect(tableBox.width).toBeLessThanOrEqual(hostBox.width / 2);
  expect((await axis.boundingBox())!.width).toBeGreaterThanOrEqual(320);
  await page.screenshot({ path: info.outputPath('gantt-wide.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  await page.screenshot({ path: info.outputPath('gantt-wide-dark.png'), animations: 'disabled' });
  expect(await page.getByTestId('time-table-cell').count()).toBeGreaterThan(6);
  const divider = page.getByRole('separator', { name: 'Table and time divider' });
  const initial = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(Math.round(initial - 12));
  await table.evaluate((node) => {
    node.scrollLeft = 500;
    node.scrollTop = 180;
  });
  await expect.poll(() => axis.evaluate((node) => node.scrollTop)).toBe(180);
  expect(await axis.evaluate((node) => node.scrollLeft)).toBe(0);
  expect(await table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(300);
  expect(await page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md'))).toBe(before);
});

test('default gallery cards and lists reflow in a 360px content host without writing defaults', async ({
  page,
}, info) => {
  await openFixture(page);
  const before = await page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md'));
  await page.getByTestId('view-tab-polish-gallery').click();
  const card = page.getByTestId('gallery-card').first();
  expect((await card.boundingBox())!.width).toBeGreaterThanOrEqual(260);
  await expect(page.getByTestId('gallery-cover')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('gallery-wide.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  await page.screenshot({ path: info.outputPath('gallery-wide-dark.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Theme: dark', exact: true }).click();
  await page.getByRole('button', { name: 'Theme: system', exact: true }).click();
  await page.getByTestId('type-page').evaluate((node) => {
    node.style.width = '360px';
    node.style.maxWidth = '360px';
  });
  const gallery = page.getByTestId('gallery-view');
  await expect
    .poll(() => gallery.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
    .toBe(true);
  expect((await card.boundingBox())!.width).toBeLessThanOrEqual(360);
  await page.screenshot({ path: info.outputPath('gallery-360.png'), animations: 'disabled' });
  await page.getByTestId('view-tab-polish-list').click();
  const list = page.getByTestId('list-view');
  await expect
    .poll(() => list.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
    .toBe(true);
  await expect(page.getByTestId('view-control-settings')).toBeVisible();
  const controls = (await page.getByTestId('view-control-settings').boundingBox())!;
  const tabs = (await page.getByTestId('view-tabs').boundingBox())!;
  expect(controls.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
  await expect(page.getByTestId('list-row')).toHaveCount(45);
  expect((await list.boundingBox())!.height).toBeGreaterThan(600);
  await page.screenshot({ path: info.outputPath('list-360.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  await page.screenshot({ path: info.outputPath('list-360-dark.png'), animations: 'disabled' });
  expect(await page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md'))).toBe(before);
});

test('a missing title target keeps its exact draft, and retry commits once with keyboard focus', async ({
  page,
}, info) => {
  // Reuse the module the mounted app requested, including any Vite HMR query.
  // A bare import can instantiate a different singleton on a warm server.
  const mountedStore: { url: string | null } = { url: null };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/src/stores/vaultStore.ts')
      mountedStore.url = request.url();
  });
  await openFixture(page);
  expect(mountedStore.url).not.toBeNull();
  const row = page.getByTestId('table-row').first();
  const path = (await row.getAttribute('data-path'))!;
  const source = await page.evaluate((path) => window.__cerebroMockFs.get(path), path);
  await row.locator('[data-cell-primary]').first().click();
  const input = page.getByRole('textbox', { name: 'Title', exact: true });
  await input.fill('  Recover this table title  ');
  await page.evaluate((path) => window.__cerebroMockFs.delete(path), path);
  await input.press('Enter');
  await expect(input).toHaveValue('  Recover this table title  ');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.locator(`[data-field-status="${await input.getAttribute('aria-describedby')}"]`),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('table-title-refusal.png'),
    animations: 'disabled',
  });
  expect(await page.evaluate((path) => window.__cerebroMockFs.has(path), path)).toBe(false);
  await page.evaluate(
    async ({ path, source, modulePath }) => {
      window.__cerebroMockFs.set(path, source!);
      // Browser mocks have no disk watcher: deliver the restored-file scan.
      if (modulePath === null) throw new Error('Mounted vault store module was not requested');
      const { useVaultStore } = await import(modulePath);
      if (useVaultStore.getState().vaultPath === null)
        throw new Error('Restoration must rescan the mounted vault store');
      await useVaultStore.getState().rescan();
    },
    { path, source, modulePath: mountedStore.url },
  );
  await expect(
    page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first(),
  ).toContainText('45');
  const writes = await page.evaluate(
    (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
    path,
  );
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId('table-view')).toBeFocused();
  expect(
    await page.evaluate(
      (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
      path,
    ),
  ).toBe(writes + 1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`table chrome and a refused scalar remain legible in ${theme}`, async ({ page }, info) => {
    await openFixture(page, theme, true);
    const grid = page.getByTestId('table-view');
    const row = page.getByTestId('table-row').first();
    await row.hover();
    const title = row.locator('[aria-colindex="2"] [data-cell-primary]');
    expect(await title.evaluate((node) => getComputedStyle(node).fontSize)).toBe('14px');
    expect((await row.boundingBox())!.height).toBe(44);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({ path: info.outputPath(`table-${theme}.png`), animations: 'disabled' });
    const cell = row.locator('[aria-colindex="7"]');
    await cell.locator('[data-cell-primary]').click();
    const input = row.getByRole('textbox', { name: 'Capacity', exact: true });
    await input.fill('not a number');
    await input.press('Enter');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const statusId = await input.getAttribute('aria-describedby');
    await expect(page.locator(`[id="${statusId}"]`)).toHaveAttribute('role', 'status');
    const status = page.locator(`[data-field-status="${statusId}"]`);
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('aria-hidden', 'true');
    expect(await status.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');
    expect(
      await status.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--danger-600)';
        document.body.append(probe);
        const matches = getComputedStyle(node).color === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      }),
    ).toBe(true);
    const statusBox = (await status.boundingBox())!;
    // This passive portal is viewport-clamped. The paper canvas now has a
    // gutter, which the bubble may use without clipping its correction.
    const viewport = page.viewportSize()!;
    expect(statusBox.x).toBeGreaterThanOrEqual(0);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(viewport.width);
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: info.outputPath(`table-scalar-refusal-${theme}.png`),
      animations: 'disabled',
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    await input.evaluate((node) => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await expect
      .poll(async () => {
        const field = (await input.boundingBox())!;
        const pinned = (await row.locator('[aria-colindex="2"]').boundingBox())!;
        return field.x >= pinned.x + pinned.width - 1;
      })
      .toBe(true);
    expect(
      await input.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return (
          document.elementFromPoint(
            Math.min(window.innerWidth - 4, box.x + box.width / 2),
            box.y + box.height / 2,
          ) === node
        );
      }),
    ).toBe(true);
    await expect(status).toBeVisible();
    await expect
      .poll(async () => {
        const box = (await status.boundingBox())!;
        return box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900;
      })
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`table-scalar-refusal-${theme}-200.png`),
      animations: 'disabled',
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });
    await input.press('Escape');
    await expect(grid).toBeFocused();
  });
}

test('database destruction has entity scope and remains outside view settings', async ({
  page,
}) => {
  await openFixture(page);
  await page.getByTestId('view-control-settings').click();
  await expect(page.getByTestId('view-settings-panel')).toContainText('Display this view');
  await expect(page.getByText('Delete database', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close view settings', exact: true }).last().click();
  await page.getByRole('button', { name: 'Database actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete database', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Work item');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('table-view')).toBeVisible();
});

test('Knowledge group bands stick below the same 36px data header', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'all');
  const band = page.getByTestId('concept-group').first();
  await expect(band).toBeVisible();
  expect(await band.evaluate((node) => getComputedStyle(node).top)).toBe('36px');
  const header = page
    .locator('[role="row"]')
    .filter({ has: page.locator('[role="columnheader"]') })
    .first();
  expect((await header.boundingBox())!.height).toBe(36);
});

test('alternate displays show meaningful data in both themes without writing on open', async ({
  page,
}, info) => {
  await openFixture(page, 'light', false, true);
  const before = await page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md'));
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark')
      await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
    for (const kind of ['board', 'calendar', 'timeline', 'chart', 'dashboard'] as const) {
      await page.getByTestId(`view-tab-polish-${kind}`).click();
      const surface = page.getByTestId(`${kind}-view`).first();
      await expect(surface).toBeVisible();
      if (kind === 'board') expect(await surface.getByTestId('board-card').count()).toBe(45);
      if (kind === 'calendar')
        expect(await surface.getByTestId('calendar-bar').count()).toBeGreaterThan(0);
      if (kind === 'timeline')
        expect(await surface.getByTestId('timeline-bar').count()).toBeGreaterThan(0);
      if (kind === 'chart')
        expect(await surface.getByTestId('chart-bar').count()).toBeGreaterThan(0);
      if (kind === 'dashboard')
        await expect(surface.getByTestId('dashboard-number')).toHaveAttribute('data-value', '45');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.screenshot({
        path: info.outputPath(`${kind}-${theme}.png`),
        animations: 'disabled',
      });
      expect(await page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md'))).toBe(
        before,
      );
    }
  }
});

test('fixed rows preserve sticky hit targets, offscreen navigation, find and wrapped content', async ({
  page,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const seed = () => {
      const fs = window.__cerebroMockFs;
      if (!fs) {
        setTimeout(seed, 10);
        return;
      }
      fs.set(
        'types/rendering-proof.md',
        `---
type: Type
fields:
  detail: { kind: text }
  extra: { kind: text }
views:
  - id: fixed
    name: Fixed
    presentation:
      type: table
      columns: [{ field: detail, width: 500 }, { field: extra, width: 500 }]
  - id: wrapped
    name: Wrapped
    presentation:
      type: table
      columns: [{ field: detail, width: 180, wrap: true }]
---
# Rendering proof
`,
      );
      for (let i = 0; i < 400; i++) {
        fs.set(
          `rendering-proof/${String(i).padStart(3, '0')}.md`,
          `---
type: Rendering proof
detail: A longer value with enough words to demonstrate intrinsic wrapping without losing any content.
extra: Another readable value
---
# ${i === 399 ? 'Far endpoint 東京' : `Rendering record ${i}`}
`,
        );
      }
    };
    seed();
  });
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Rendering proof' }).click();
  const grid = page.getByTestId('table-view');
  const rows = page.getByTestId('table-row');
  await expect(rows).toHaveCount(400);
  await expect(page.getByRole('button', { name: 'Far endpoint 東京', exact: true })).toHaveCount(1);
  if (browserName === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Accessibility.enable');
    await expect
      .poll(async () => {
        const tree = await session.send('Accessibility.getFullAXTree');
        return tree.nodes.some((node) => String(node.name?.value).includes('Far endpoint 東京'));
      })
      .toBe(true);
    await session.detach();
  }
  const firstTitle = rows.first().locator('[aria-colindex="2"] [data-cell-primary]');
  const beforeX = (await firstTitle.boundingBox())!.x;
  await grid.evaluate((node) => {
    node.scrollLeft = 700;
  });
  expect(Math.abs((await firstTitle.boundingBox())!.x - beforeX)).toBeLessThan(1);
  await firstTitle.click();
  await expect(rows.first().getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Rendering record 0',
  );
  expect(
    await rows
      .first()
      .locator('[aria-colindex="2"]')
      .evaluate((node) => getComputedStyle(node).position),
  ).toBe('sticky');
  await page.getByRole('textbox', { name: 'Title', exact: true }).press('Escape');
  await grid.press('End');
  await expect(rows.last()).toHaveAttribute('data-focused', 'true');
  expect(await grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(10_000);
  const activeId = await grid.getAttribute('aria-activedescendant');
  expect(await rows.last().getAttribute('id')).toBe(activeId);
  await grid.evaluate((node) => {
    node.scrollTop = 0;
  });
  const found = await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    return (
      window as unknown as Window & {
        find: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean;
      }
    ).find('Far endpoint 東京', false, false, true);
  });
  expect(found).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Far endpoint 東京');
  await grid.press('End');
  await page.screenshot({
    path: info.outputPath('table-offscreen-endpoint.png'),
    animations: 'disabled',
  });
  await grid.evaluate((node) => {
    node.scrollLeft = 0;
  });
  await rows.last().locator('[aria-colindex="3"] [data-cell-primary]').click();
  const draft = rows.last().getByRole('textbox', { name: 'Detail', exact: true });
  await draft.fill('A retained offscreen draft');
  await page.evaluate(() => window.__cerebroMockFs.delete('rendering-proof/399.md'));
  await draft.press('Enter');
  await expect(draft).toHaveAttribute('aria-invalid', 'true');
  const errorStatus = page.locator(
    `[data-field-status="${await draft.getAttribute('aria-describedby')}"]`,
  );
  await expect(errorStatus).toBeVisible();
  expect(await rows.last().evaluate((node) => getComputedStyle(node).contentVisibility)).toBe(
    'visible',
  );
  await grid.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(draft).toHaveValue('A retained offscreen draft');
  await expect(errorStatus).toBeHidden();
  await expect(rows).toHaveCount(400);
  await grid.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(errorStatus).toBeVisible();
  await draft.press('Escape');
  await page.getByTestId('view-tab-wrapped').click();
  expect((await rows.first().boundingBox())!.height).toBeGreaterThan(36);
  expect(await rows.first().evaluate((node) => getComputedStyle(node).contentVisibility)).toBe(
    'visible',
  );
});
