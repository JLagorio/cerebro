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

// OFFSOURCE PROPOSAL: append to e2e/data-display-polish.spec.ts after root review.
// Existing imports (expect, test, Page, boot, showDatabases) are sufficient.
// No source registration, execution, or passing claim accompanies this fragment.
// Run against baseline AND each selected candidate. It intentionally contains no
// overflow/class-name assertions and injects no candidate CSS.

async function openClippingAcceptanceFixture(page: Page) {
  const suffix = 'ClipFind東京9527';
  const url = `https://example.invalid/${'unbroken'.repeat(35)}/website-end`;
  const email = `${'longaddress'.repeat(24)}@example.invalid`;
  const localFile = `attachments/${'longfilename'.repeat(20)}.md`;
  const linkedFile = `https://example.invalid/${'linkedattachment'.repeat(20)}.txt`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    ({ suffix, url, email, localFile, linkedFile }) => {
      const seed = () => {
        const fs = window.__cerebroMockFs;
        if (!fs) {
          setTimeout(seed, 10);
          return;
        }
        fs.set(
          'types/clipping-acceptance.md',
          `---
type: Type
fields:
  detail: { kind: text }
  website: { kind: url }
  email: { kind: email }
  files: { kind: files }
  choice:
    kind: select
    options:
      - { id: alpha, label: Alpha }
      - { id: beta, label: Beta boundary target }
views:
  - id: clipping
    name: Clipping acceptance
    presentation:
      type: table
      frozenColumns: 1
      sort: [{ field: title, dir: asc }]
      columns: [{ field: detail, width: 200 }, { field: website, width: 220 }, { field: email, width: 220 }, { field: files, width: 240 }, { field: choice, width: 180 }]
---
# Clipping acceptance
`,
        );
        fs.set(localFile, '# Long attachment\n');
        for (let i = 0; i < 120; i++) {
          const id = String(i).padStart(3, '0');
          const file = i === 1 ? linkedFile : localFile;
          fs.set(
            `clipping-acceptance/${id}.md`,
            `---
type: Clipping acceptance
detail: ${i === 119 ? `${'unbrokenvalue'.repeat(50)}${suffix}` : 'Ordinary field value'}
website: ${url}
email: ${email}
files: [${JSON.stringify(file)}]
choice: alpha
---
# Clip record ${id}
`,
          );
        }
      };
      seed();
    },
    { suffix, url, email, localFile, linkedFile },
  );
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Clipping acceptance' }).click();
  await expect(page.getByTestId('table-row')).toHaveCount(120);
  return { suffix, url, email, localFile, linkedFile };
}

// Geometry + hit testing is required: Playwright's visibility check alone can
// pass a control whose center is behind an ancestor clip or a frozen column.
async function expectClippingControlHit(control: ReturnType<Page['locator']>, insideField = true) {
  const result = await control.evaluate((node, insideField) => {
    const box = node.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    const cell = node.closest('[role="gridcell"]')?.getBoundingClientRect();
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      hit: hit !== null && (hit === node || node.contains(hit)),
      inside:
        !insideField ||
        (cell !== undefined && x > cell.left && x < cell.right && y > cell.top && y < cell.bottom),
    };
  }, insideField);
  if (!result.hit || !result.inside || result.box.width <= 0 || result.box.height <= 0) {
    await test.info().attach('control-hit-failure-geometry', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('control-hit-failure-image', {
      body: await control.page().screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  }
  expect(result.box.width).toBeGreaterThan(0);
  expect(result.box.height).toBeGreaterThan(0);
  expect(result.inside, JSON.stringify(result)).toBe(true);
  expect(result.hit, JSON.stringify(result)).toBe(true);
  return result;
}

test('native find reveals a unique suffix in a long non-title field of the far row', async ({
  page,
}, info) => {
  const { suffix } = await openClippingAcceptanceFixture(page);
  const grid = page.getByTestId('table-view');
  const farRow = page.getByTestId('table-row').filter({ hasText: 'Clip record 119' });
  await expect(farRow).toHaveCount(1);
  await grid.evaluate((node) => {
    node.scrollTop = 0;
    node.scrollLeft = 0;
  });
  // Find runs once. Browser-driven reveal may finish after this JS task.
  const found = await page.evaluate((suffix) => {
    window.getSelection()?.removeAllRanges();
    return (
      window as unknown as Window & {
        find: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean;
      }
    ).find(suffix, false, false, true);
  }, suffix);
  const measureSelection = () =>
    page.evaluate(() => {
      const selection = window.getSelection();
      const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const selectedElement =
        selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? (selection.anchorNode as Element)
          : selection?.anchorNode?.parentElement;
      const cell = selectedElement?.closest('[data-field-kind="text"]');
      const visible = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const clips: { tag: string; left: number; top: number; right: number; bottom: number }[] = [];
      for (
        let node: Element | null = selectedElement ?? null;
        node !== null;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        const bounds = node.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          visible.left = Math.max(visible.left, bounds.left);
          visible.right = Math.min(visible.right, bounds.right);
        }
        if (style.overflowY !== 'visible') {
          visible.top = Math.max(visible.top, bounds.top);
          visible.bottom = Math.min(visible.bottom, bounds.bottom);
        }
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          clips.push({
            tag: node.tagName,
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
          });
        }
      }
      const bounds = range?.getBoundingClientRect();
      const clientRects = Array.from(range?.getClientRects() ?? []).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      // WebKit may expose an empty union for a non-collapsed selected range.
      // Only real positive glyph rectangles may substitute for that union.
      const matchRects =
        bounds !== undefined && bounds.width > 0 && bounds.height > 0 ? [bounds] : clientRects;
      const wholeMatchVisible =
        matchRects.length > 0 &&
        matchRects.every(
          (rect) =>
            rect.left >= visible.left - 1 &&
            rect.right <= visible.right + 1 &&
            rect.top >= visible.top - 1 &&
            rect.bottom <= visible.bottom + 1,
        );
      return {
        text: selection?.toString(),
        isNonTitleField: cell !== null && cell !== undefined,
        path: cell?.closest('[data-path]')?.getAttribute('data-path'),
        match:
          bounds === undefined
            ? null
            : {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
                width: bounds.width,
                height: bounds.height,
              },
        clientRects: clientRects.map((rect) => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        })),
        visible,
        clips,
        wholeMatchVisible,
      };
    });
  let result = await measureSelection();
  let revealFailure: unknown = null;
  try {
    await expect
      .poll(
        async () => {
          // Observe the same selection after frames. Never rerun Find or scroll
          // manually: either action could manufacture the reveal under test.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          result = await measureSelection();
          return result.wholeMatchVisible;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  } catch (error) {
    revealFailure = error;
  }
  // Retain actual geometry and image even when baseline reveal fails.
  await info.attach('non-title-find-geometry', {
    body: JSON.stringify({ found, ...result }, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({
    path: info.outputPath('non-title-suffix-find.png'),
    animations: 'disabled',
  });
  expect(found).toBe(true);
  expect(result.text).toBe(suffix);
  expect(result.isNonTitleField).toBe(true);
  expect(result.path).toBe('clipping-acceptance/119.md');
  expect(result.wholeMatchVisible, JSON.stringify(result)).toBe(true);
  if (revealFailure !== null) throw revealFailure;
  await expect(page.getByTestId('table-row')).toHaveCount(120);
});

test('long URL email and file labels retain their adjacent edit and Remove hit targets', async ({
  page,
}, info) => {
  const values = await openClippingAcceptanceFixture(page);
  const row = page.getByTestId('table-row').filter({ hasText: 'Clip record 000' });
  const metrics = [];
  for (const [kind, label, value] of [
    ['url', 'Website', values.url],
    ['email', 'Email', values.email],
  ] as const) {
    const cell = row.locator(`[data-field-kind="${kind}"]`);
    await cell.evaluate((node) => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await cell.hover();
    const pencil = cell.getByRole('button', { name: `Edit ${label}`, exact: true });
    metrics.push({ kind, control: await expectClippingControlHit(pencil) });
    // Inspect geometry before click: locator.click() may otherwise scroll a
    // hidden-overflow ancestor and mask a missing target at rest.
    await pencil.click();
    const input = row.getByRole('textbox', { name: label, exact: true });
    await expect(input).toHaveValue(value);
    // type=email sanitizes outer ASCII whitespace before React receives it.
    // Preserve exact long input there without asking the browser to keep spaces.
    const draft = kind === 'email' ? `retained-${value}` : `  retained ${value}  `;
    await input.fill(draft);
    await input.press('End');
    await expect(input).toHaveValue(draft);
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.getByTestId('table-view')).toBeFocused();
  }
  for (const [id, file] of [
    ['000', values.localFile],
    ['001', values.linkedFile],
  ] as const) {
    const owner = page.getByTestId('table-row').filter({ hasText: `Clip record ${id}` });
    const cell = owner.locator('[data-field-kind="files"]');
    await cell.evaluate((node) => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await cell.hover();
    const remove = cell.getByRole('button', { name: `Remove ${file}`, exact: true });
    metrics.push({ kind: `files-${id}`, control: await expectClippingControlHit(remove) });
    await remove.click();
    await expect(remove).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate((id) => window.__cerebroMockFs.get(`clipping-acceptance/${id}.md`) ?? '', id),
      )
      .not.toContain(file);
    const after = await page.evaluate(
      (id) => window.__cerebroMockFs.get(`clipping-acceptance/${id}.md`) ?? '',
      id,
    );
    expect(after).toContain(values.url);
    expect(after).toContain(values.email);
  }
  await info.attach('long-value-controls', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  await expect(page.getByTestId('table-row')).toHaveCount(120);
  await page.screenshot({
    path: info.outputPath('long-value-controls.png'),
    animations: 'disabled',
  });
});

test('a nested fixed field picker remains clickable outside its cell at 200% zoom', async ({
  page,
}, info) => {
  await openClippingAcceptanceFixture(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  const row = page.getByTestId('table-row').filter({ hasText: 'Clip record 000' });
  const cell = row.locator('[data-field-kind="select"]');
  await cell.evaluate((node) => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const trigger = cell.locator('[data-cell-primary]');
  await expectClippingControlHit(trigger);
  await trigger.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  const option = listbox.getByRole('option', { name: 'Beta boundary target', exact: true });
  const optionMetrics = await expectClippingControlHit(option, false);
  const cellBox = (await cell.boundingBox())!;
  const optionBox = (await option.boundingBox())!;
  const center = { x: optionBox.x + optionBox.width / 2, y: optionBox.y + optionBox.height / 2 };
  expect(
    center.x < cellBox.x ||
      center.x > cellBox.x + cellBox.width ||
      center.y < cellBox.y ||
      center.y > cellBox.y + cellBox.height,
  ).toBe(true);
  await info.attach('fixed-picker-outside-cell', {
    body: JSON.stringify({ cellBox, optionBox, optionMetrics }, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('fixed-picker-200.png'), animations: 'disabled' });
  await option.click();
  await expect(listbox).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('clipping-acceptance/000.md') ?? ''))
    .toContain('choice: beta');
  await expect(trigger).toContainText('Beta boundary target');
  // Pointer activation does not focus buttons in WebKit. Establish an actual
  // keyboard opener so useFocusRestore has a defined target after Escape.
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(listbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(listbox).toHaveCount(0);
  await info.attach('picker-focus-after-escape', {
    body: JSON.stringify(
      await page.evaluate(() => {
        const active = document.activeElement;
        return {
          tag: active?.tagName,
          role: active?.getAttribute('role'),
          label: active?.getAttribute('aria-label'),
          testId: active?.getAttribute('data-testid'),
          primary: active?.hasAttribute('data-cell-primary'),
        };
      }),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await page.screenshot({
    path: info.outputPath('fixed-picker-escape-200.png'),
    animations: 'disabled',
  });
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('table-row')).toHaveCount(120);
});

// Append-only controls. The original six acceptance assertions stay unchanged.

test('Find reveal keeps bytes and focus, then restores resting truncation on selection clear', async ({
  page,
}, info) => {
  const { suffix } = await openClippingAcceptanceFixture(page);
  const row = page.getByTestId('table-row').filter({ hasText: 'Clip record 119' });
  const value = row.locator('[data-field-kind="text"] .truncate');
  const beforeBytes = await page.evaluate(() =>
    window.__cerebroMockFs.get('clipping-acceptance/119.md'),
  );
  const resting = await value.evaluate((node) => ({
    scrollLeft: node.scrollLeft,
    ellipsis: getComputedStyle(node).textOverflow,
    width: node.getBoundingClientRect().width,
    height: node.getBoundingClientRect().height,
  }));
  const native = await page.evaluateHandle((suffix) => {
    window.getSelection()?.removeAllRanges();
    const found = (
      window as unknown as Window & {
        find: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean;
      }
    ).find(suffix, false, false, true);
    return { found, active: document.activeElement };
  }, suffix);
  expect(await (await native.getProperty('found')).jsonValue()).toBe(true);
  const focusAfterNativeFind = await native.getProperty('active');
  await expect.poll(() => value.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await focusAfterNativeFind.evaluate((node) => node === document.activeElement)).toBe(true);
  await expect(row.getByRole('textbox')).toHaveCount(0);
  expect(await page.evaluate(() => window.__cerebroMockFs.get('clipping-acceptance/119.md'))).toBe(
    beforeBytes,
  );
  const during = await value.boundingBox();
  expect(during!.width).toBe(resting.width);
  expect(during!.height).toBe(resting.height);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect
    .poll(() =>
      value.evaluate((node) => ({
        scrollLeft: node.scrollLeft,
        ellipsis: getComputedStyle(node).textOverflow,
      })),
    )
    .toEqual({ scrollLeft: resting.scrollLeft, ellipsis: resting.ellipsis });
  await info.attach('resting-truncation-restored', {
    body: JSON.stringify({ resting, during }, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({
    path: info.outputPath('find-selection-cleared.png'),
    animations: 'disabled',
  });
  await focusAfterNativeFind.dispose();
  await native.dispose();
});

test('ordinary pointer drag selection retains its exact range without Find scrolling or editing', async ({
  page,
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
        'types/pointer-selection.md',
        `---
type: Type
fields:
  result: { kind: formula, formula: '12345678901234567890' }
views:
  - id: pointer
    name: Pointer
    presentation:
      type: table
      columns: [{ field: result, width: 140 }]
---
# Pointer selection
`,
      );
      fs.set(
        'pointer-selection/specimen.md',
        '---\ntype: Pointer selection\n---\n# Pointer specimen\n',
      );
    };
    seed();
  });
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Pointer selection' }).click();
  const grid = page.getByTestId('table-view');
  // A computed field is ordinary selectable text, not a button whose native
  // pointer-selectability differs by browser. No editor can open in this cell.
  const value = page.getByTestId('table-row').locator('[data-field-kind="formula"] > span');
  await expect(value).toHaveCount(1);
  const box = (await value.boundingBox())!;
  const before = await value.evaluate((node) => ({
    scrollLeft: node.scrollLeft,
    ellipsis: getComputedStyle(node).textOverflow,
  }));
  const gridBefore = await grid.evaluate((node) => ({ x: node.scrollLeft, y: node.scrollTop }));
  const beforeBytes = await page.evaluate(() =>
    window.__cerebroMockFs.get('pointer-selection/specimen.md'),
  );
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 2, 55), box.y + box.height / 2, { steps: 8 });
  const dragged = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(dragged.length).toBeGreaterThan(0);
  await page.mouse.up();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(dragged);
  expect(
    await value.evaluate((node) => ({
      scrollLeft: node.scrollLeft,
      ellipsis: getComputedStyle(node).textOverflow,
    })),
  ).toEqual(before);
  expect(await grid.evaluate((node) => ({ x: node.scrollLeft, y: node.scrollTop }))).toEqual(
    gridBefore,
  );
  await expect(grid.getByRole('textbox')).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__cerebroMockFs.get('pointer-selection/specimen.md')),
  ).toBe(beforeBytes);
  await info.attach('pointer-range-kept', {
    body: JSON.stringify({ dragged, before, gridBefore }, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({
    path: info.outputPath('ordinary-pointer-selection.png'),
    animations: 'disabled',
  });
});

// M93 resting-text integration. Additive to every original Find/drag/control test.
// No CSS/helper injection: these exercise the actual mounted React helper.
const restingTextBox =
  ".cb-row > [role='gridcell'][data-field-kind='text'] > .cb-cell-chrome.items-center > button[data-cell-primary] > span.truncate";
const restingPath = (id: string) => `resting-clip/${id}.md`;
const restingRow = (page: Page, id: string) =>
  page.locator(`[data-testid="table-row"][data-path="${restingPath(id)}"]`);
const restingValue = (page: Page, id: string) =>
  restingRow(page, id).locator(
    '[aria-colindex="3"] > .cb-cell-chrome > button[data-cell-primary] > span',
  );

async function openRestingTextFixture(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = 'ClipFind東京9527',
    second = 'ClipSwitch東京6284';
  await page.addInitScript(
    ({ suffix, second }) => {
      const seed = () => {
        const fs = window.__cerebroMockFs;
        if (!fs) {
          setTimeout(seed, 10);
          return;
        }
        fs.set(
          'types/resting-clip.md',
          `---
type: Type
fields:
  detail: { kind: text }
  wrapped: { kind: text }
  amount: { kind: number }
  result: { kind: formula, formula: '12345678901234567890' }
  website: { kind: url }
  choice:
    kind: select
    options:
      - { id: alpha, label: Alpha }
      - { id: beta, label: Beta boundary target }
views:
  - id: resting
    name: Resting
    presentation:
      type: table
      frozenColumns: 1
      sort: [{ field: title, dir: asc }]
      columns: [{ field: detail, width: 200 }, { field: wrapped, width: 180, wrap: true }, { field: amount, width: 140 }, { field: result, width: 140 }, { field: website, width: 220 }, { field: choice, width: 180 }]
  - id: other-scope
    name: Other scope
    presentation:
      type: table
      columns: [{ field: detail, width: 240 }]
---
# Resting clip acceptance
`,
        );
        for (let i = 0; i < 120; i++) {
          const id = String(i).padStart(3, '0');
          const detail =
            i === 119
              ? `${'unbrokenvalue'.repeat(50)}${suffix}`
              : i === 118
                ? `${'secondlongvalue'.repeat(50)}${second}`
                : `Fits ${id}`;
          fs.set(
            `resting-clip/${id}.md`,
            `---
type: Resting clip acceptance
detail: ${JSON.stringify(detail)}
wrapped: |
  First wrapped line
  Second wrapped line
  Third wrapped line
amount: 42
website: https://example.invalid/${'unbroken'.repeat(25)}
choice: alpha
---
# Resting record ${id}
`,
          );
        }
      };
      seed();
    },
    { suffix, second },
  );
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Resting clip acceptance' }).click();
  await expect(page.getByTestId('table-row')).toHaveCount(120);
  await page.evaluate(() => document.fonts.ready);
  await restingFrames(page);
  return { suffix, second };
}

async function restingFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
async function restingSnapshot(page: Page) {
  const snapshot = await page.evaluate(() => {
    const writes = window.__cerebroMockWrites;
    return {
      writeLogAvailable: Array.isArray(writes),
      writes: Array.isArray(writes) ? writes.length : null,
      files: [...window.__cerebroMockFs].filter(
        ([path]) => path.startsWith('resting-clip/') || path === 'types/resting-clip.md',
      ),
    };
  });
  expect(snapshot.writeLogAvailable).toBe(true);
  expect(snapshot.writes).toBe(0);
  return snapshot;
}
async function restingMode(value: ReturnType<Page['locator']>) {
  return value.evaluate((node) => {
    const style = getComputedStyle(node),
      rect = node.getBoundingClientRect();
    const cell = node.closest('[role="gridcell"]')!.getBoundingClientRect();
    const row = node.closest('.cb-row')!.getBoundingClientRect();
    return {
      x: style.overflowX,
      y: style.overflowY,
      ellipsis: style.textOverflow,
      scroll: node.scrollLeft,
      width: rect.width,
      height: rect.height,
      cellWidth: cell.width,
      cellHeight: cell.height,
      rowHeight: row.height,
      text: node.textContent,
      attribute: node.getAttribute('data-selection-reveal'),
    };
  });
}
async function expectRestingOwnedGlyphMode(
  value: ReturnType<Page['locator']>,
  mode: Awaited<ReturnType<typeof restingMode>>,
) {
  const marker = await value.getAttribute('data-selection-reveal-clip');
  expect(marker === null || marker === 'true').toBe(true);
  expect(mode.ellipsis).toBe(marker === 'true' ? 'clip' : 'ellipsis');
}
async function expectAllResting(page: Page) {
  const state = await page.locator(restingTextBox).evaluateAll((nodes) => ({
    count: nodes.length,
    clipped: nodes.filter((node) => {
      const s = getComputedStyle(node);
      return (
        s.overflowX === 'clip' &&
        s.overflowY === 'clip' &&
        s.textOverflow === 'ellipsis' &&
        node.scrollLeft === 0
      );
    }).length,
  }));
  expect(state).toEqual({ count: 120, clipped: 120 });
  await expect(page.locator('[data-selection-reveal]')).toHaveCount(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
}
async function selectedRestingGlyphs(value: ReturnType<Page['locator']>) {
  return value.evaluate((node) => {
    const selection = getSelection(),
      range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const ancestors = [];
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      const s = getComputedStyle(ancestor),
        r = ancestor.getBoundingClientRect();
      if (s.overflowX !== 'visible') {
        clip.left = Math.max(clip.left, r.left);
        clip.right = Math.min(clip.right, r.right);
      }
      if (s.overflowY !== 'visible') {
        clip.top = Math.max(clip.top, r.top);
        clip.bottom = Math.min(clip.bottom, r.bottom);
      }
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible')
        ancestors.push({
          tag: ancestor.tagName,
          x: s.overflowX,
          y: s.overflowY,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        });
    }
    const union = range?.getBoundingClientRect();
    const positive =
      union && union.width > 0 && union.height > 0
        ? [union]
        : [...(range?.getClientRects() ?? [])].filter((r) => r.width > 0 && r.height > 0);
    return {
      text: selection?.toString() ?? null,
      count: selection?.rangeCount ?? null,
      anchor: selection?.anchorOffset ?? null,
      focus: selection?.focusOffset ?? null,
      connected:
        node.isConnected &&
        !!range?.startContainer.isConnected &&
        !!range?.endContainer.isConnected,
      originalContainsRange:
        !!range && node.contains(range.startContainer) && node.contains(range.endContainer),
      path:
        range?.startContainer.parentElement?.closest('.cb-row')?.getAttribute('data-path') ?? null,
      positive: positive.map((r) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      })),
      clip,
      ancestors,
      visible:
        positive.length > 0 &&
        positive.every(
          (r) =>
            r.left >= clip.left - 1 &&
            r.right <= clip.right + 1 &&
            r.top >= clip.top - 1 &&
            r.bottom <= clip.bottom + 1,
        ),
    };
  });
}
// Each invocation is one real browser Find action. Polling only observes that same range.
async function findRestingOnce(page: Page, text: string, id: string) {
  await restingFrames(page);
  const value = restingValue(page, id),
    original = await value.elementHandle();
  expect(original).not.toBeNull();
  const native = await page.evaluateHandle(
    (text) => ({
      found: (
        window as unknown as Window & {
          find: (text: string, cs: boolean, backwards: boolean, wrap: boolean) => boolean;
        }
      ).find(text, false, false, true),
      active: document.activeElement,
    }),
    text,
  );
  const found = await (await native.getProperty('found')).jsonValue();
  const active = await native.getProperty('active');
  let observed = await selectedRestingGlyphs(value);
  try {
    expect(found).toBe(true);
    await expect
      .poll(
        async () => {
          await restingFrames(page);
          observed = await selectedRestingGlyphs(value);
          return observed.visible && observed.originalContainsRange && observed.text === text;
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    const capture = `resting-find-${test.info().attachments.length}-${id}`;
    const geometryPath = test.info().outputPath(`${capture}.json`);
    const imagePath = test.info().outputPath(`${capture}.png`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(geometryPath, JSON.stringify({ found, ...observed }, null, 2));
    await page.screenshot({ path: imagePath, animations: 'disabled' });
    await test.info().attach(`resting-find-${id}-geometry`, {
      path: geometryPath,
      contentType: 'application/json',
    });
    await test.info().attach(`resting-find-${id}-image`, {
      path: imagePath,
      contentType: 'image/png',
    });
  }
  expect(observed.path).toBe(restingPath(id));
  expect(observed.connected).toBe(true);
  expect(observed.count).toBe(1);
  expect(await value.evaluate((node, original) => node === original, original)).toBe(true);
  expect(await active.evaluate((node) => node === document.activeElement)).toBe(true);
  await active.dispose();
  await native.dispose();
  await original!.dispose();
  return observed;
}

// Capture-only diagnostic. Screenshot before any new style/geometry read of the
// previously selected field; no CSS/helper/Selection or post-Find scroll changes.
async function captureRestingPaintStage(page: Page, stage: string, delayed: boolean) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(test.info().outputDir, { recursive: true });
  const selectionBefore = await page.evaluateHandle(() => {
    const selection = getSelection();
    return {
      anchor: selection?.anchorNode ?? null,
      focus: selection?.focusNode ?? null,
      anchorOffset: selection?.anchorOffset ?? null,
      focusOffset: selection?.focusOffset ?? null,
      count: selection?.rangeCount ?? null,
      text: selection?.toString() ?? null,
      active: document.activeElement,
    };
  });
  const saveImage = async (suffix: string) => {
    const name = `paint-${stage}-${suffix}.png`;
    const pixels = await page.screenshot({ animations: 'disabled', scale: 'device' });
    await writeFile(test.info().outputPath(name), pixels, { flag: 'wx', mode: 0o600 });
    return name;
  };
  const imageFirst = await saveImage('image-first');
  let twoFrames: string | null = null;
  if (delayed) {
    // No style or geometry read between these two images. This bounded wait
    // observes the browser; it does not nudge a repaint or repair the field.
    await restingFrames(page);
    twoFrames = await saveImage('two-frames');
  }
  const factsAfterImages = await page.evaluate(() => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const selection = getSelection(),
      writes = window.__cerebroMockWrites;
    const grid = document.querySelector<HTMLElement>('[data-testid="table-view"]')!;
    return {
      devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      visualScale: visualViewport?.scale ?? null,
      rootInlineZoom: document.documentElement.style.zoom,
      rootComputedZoom: getComputedStyle(document.documentElement).zoom,
      gridScroll: { left: grid.scrollLeft, top: grid.scrollTop },
      selection: {
        text: selection?.toString() ?? null,
        count: selection?.rangeCount ?? null,
        anchorOffset: selection?.anchorOffset ?? null,
        focusOffset: selection?.focusOffset ?? null,
      },
      writeLogAvailable: Array.isArray(writes),
      writes: Array.isArray(writes) ? writes.length : null,
      promoted: [...grid.querySelectorAll('[data-selection-reveal]')].map((node) => ({
        path: node.closest('.cb-row')?.getAttribute('data-path'),
        value: node.getAttribute('data-selection-reveal'),
      })),
      fields: ['117', '118', '119'].map((id) => {
        const node = grid.querySelector<HTMLElement>(
          `[data-path="resting-clip/${id}.md"] [aria-colindex="3"] > .cb-cell-chrome > button[data-cell-primary] > span`,
        )!;
        const style = getComputedStyle(node);
        return {
          id,
          connected: node.isConnected,
          text: node.textContent,
          span: rect(node),
          button: rect(node.parentElement!),
          cell: rect(node.closest('[role="gridcell"]')!),
          row: rect(node.closest('.cb-row')!),
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          scrollLeft: node.scrollLeft,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          minWidth: style.minWidth,
          font: style.font,
          color: style.color,
          attribute: node.getAttribute('data-selection-reveal'),
        };
      }),
    };
  });
  const selectionAndFocusPreserved = await selectionBefore.evaluate((before) => {
    const selection = getSelection();
    return (
      (selection?.anchorNode ?? null) === before.anchor &&
      (selection?.focusNode ?? null) === before.focus &&
      (selection?.anchorOffset ?? null) === before.anchorOffset &&
      (selection?.focusOffset ?? null) === before.focusOffset &&
      (selection?.rangeCount ?? null) === before.count &&
      (selection?.toString() ?? null) === before.text &&
      document.activeElement === before.active
    );
  });
  await writeFile(
    test.info().outputPath(`paint-${stage}-facts-after-images.json`),
    JSON.stringify(
      {
        stage,
        imageFirst,
        twoFrames,
        selectionAndFocusPreserved,
        ordering:
          'Both native viewport images precede these new field style/geometry reads. Computed ellipsis is desired presentation, not painted proof.',
        ...factsAfterImages,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  await selectionBefore.dispose();
  expect(selectionAndFocusPreserved).toBe(true);
}

test('resting text clip promotes only the original Find box, switches matches and restores on clear', async ({
  page,
  browserName,
}) => {
  const { suffix, second } = await openRestingTextFixture(page);
  const before = await restingSnapshot(page);
  expect(before.writeLogAvailable).toBe(true);
  expect(before.writes).toBe(0);
  await expectAllResting(page);
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const tree = await cdp.send('Accessibility.getFullAXTree');
    expect(tree.nodes.some((node) => String(node.name?.value).includes(suffix))).toBe(true);
    await cdp.detach();
  }
  const a = restingValue(page, '119'),
    b = restingValue(page, '118');
  const originalA = await restingMode(a),
    originalB = await restingMode(b);
  await page.getByTestId('table-view').evaluate((grid) => {
    grid.scrollTop = 0;
    grid.scrollLeft = 0;
  });
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
  const during = await restingMode(a);
  expect(during.x).toBe('hidden');
  expect(during.y).toBe('hidden');
  expect(during.scroll).toBeGreaterThan(0);
  expect({
    ...during,
    x: originalA.x,
    y: originalA.y,
    ellipsis: originalA.ellipsis,
    scroll: originalA.scroll,
    attribute: originalA.attribute,
  }).toEqual(originalA);
  expect(
    await page
      .locator(restingTextBox)
      .evaluateAll(
        (nodes) => nodes.filter((node) => getComputedStyle(node).overflowX === 'clip').length,
      ),
  ).toBe(119);
  await findRestingOnce(page, second, '118');
  await captureRestingPaintStage(page, 'after-switch', true);
  expect(await restingMode(a)).toEqual(originalA);
  expect(await a.getAttribute('data-selection-reveal-clip')).toBeNull();
  await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
  expect((await restingMode(b)).scroll).toBeGreaterThan(0);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await expect.poll(() => restingMode(b)).toEqual(originalB);
  await expectAllResting(page);
  await captureRestingPaintStage(page, 'after-clear', true);
  await expect(page.getByTestId('table-view').getByRole('textbox')).toHaveCount(0);
  expect(await restingSnapshot(page)).toEqual(before);
});

test('resting text clip captures initial resting paint in a fresh context without Find', async ({
  page,
}) => {
  await openRestingTextFixture(page);
  const before = await restingSnapshot(page);
  await expectAllResting(page);
  // Separate fresh context: prepainting far values here must not warm or alter
  // the original Find sequence in the other test.
  await page.getByTestId('table-view').evaluate((grid) => {
    grid.scrollTop = grid.scrollHeight;
    grid.scrollLeft = 0;
  });
  await restingFrames(page);
  await captureRestingPaintStage(page, 'initial-resting', false);
  await expectAllResting(page);
  expect(await restingSnapshot(page)).toEqual(before);
});

// These deliberate selection invalidators test the existing eligible non-pointer
// contract. They are not substituted for any of the actual Find glyph proofs.
test('resting text clip clears cross-cell and outside selections without transferring promotion', async ({
  page,
}) => {
  const { suffix } = await openRestingTextFixture(page);
  await expectAllResting(page);
  const before = await restingSnapshot(page);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  await page.evaluate(() => {
    const a = document.querySelector(
      '[data-path="resting-clip/118.md"] [aria-colindex="3"] span.truncate',
    )!.firstChild!;
    const b = document.querySelector(
      '[data-path="resting-clip/119.md"] [aria-colindex="3"] span.truncate',
    )!.firstChild!;
    getSelection()!.setBaseAndExtent(a, 1, b, 3);
  });
  await expect.poll(() => page.locator('[data-selection-reveal]').count()).toBe(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  await expectAllResting(page);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  await page.evaluate(() => {
    const outside = document.querySelector('[data-testid="sidebar-type"]')!;
    const range = document.createRange();
    range.selectNodeContents(outside);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await expect.poll(() => page.locator('[data-selection-reveal]').count()).toBe(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  await expectAllResting(page);
  expect(await restingSnapshot(page)).toEqual(before);
});

for (const mutation of ['path', 'text', 'disconnect'] as const) {
  test(`resting text clip drops queued Find when its physical ${mutation} changes`, async ({
    page,
  }) => {
    const { suffix } = await openRestingTextFixture(page);
    await expectAllResting(page);
    const before = await restingSnapshot(page),
      value = restingValue(page, '119');
    const physical = await value.elementHandle();
    // This clock only holds/releases scheduled callbacks. It never supplies a
    // helper, CSS, selectionchange, Range or Find result.
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
    const action = await page.evaluateHandle((suffix) => {
      const seen = { selectionchange: 0 };
      document.addEventListener(
        'selectionchange',
        () => {
          seen.selectionchange++;
        },
        { once: true },
      );
      getSelection()?.removeAllRanges();
      const found = (
        window as unknown as Window & {
          find: (s: string, a: boolean, b: boolean, c: boolean) => boolean;
        }
      ).find(suffix, false, false, true);
      return { seen, found };
    }, suffix);
    expect(await (await action.getProperty('found')).jsonValue()).toBe(true);
    await expect.poll(() => action.evaluate((action) => action.seen.selectionchange)).toBe(1);
    expect(await value.getAttribute('data-selection-reveal')).toBeNull();
    await value.evaluate((node, mutation) => {
      if (mutation === 'path')
        node.closest('.cb-row')!.setAttribute('data-path', 'resting-clip/reused.md');
      if (mutation === 'text') node.textContent = 'Changed physical text';
      if (mutation === 'disconnect') node.closest('.cb-row')!.remove();
    }, mutation);
    await page.clock.runFor(50);
    expect(
      await physical!.evaluate((node) => ({
        attribute: node.getAttribute('data-selection-reveal'),
        glyphClip: node.getAttribute('data-selection-reveal-clip'),
        scroll: node.scrollLeft,
      })),
    ).toEqual({ attribute: null, glyphClip: null, scroll: 0 });
    await expect(page.locator('[data-selection-reveal]')).toHaveCount(0);
    await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
    expect(await restingSnapshot(page)).toEqual(before);
    await action.dispose();
    await physical!.dispose();
  });
}

test('resting text clip restores on actual filtering, scope change and unmount without reopening a stale match', async ({
  page,
}) => {
  const { suffix } = await openRestingTextFixture(page);
  await expectAllResting(page);
  const before = await restingSnapshot(page),
    old = await restingValue(page, '119').elementHandle();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  await page.getByTestId('view-control-search').click();
  await page.getByTestId('view-search-input').fill('resting-clip/000.md');
  await expect(page.getByTestId('table-row')).toHaveCount(1);
  expect(await old!.evaluate((node) => node.getAttribute('data-selection-reveal'))).toBeNull();
  expect(await old!.evaluate((node) => node.getAttribute('data-selection-reveal-clip'))).toBeNull();
  await page.getByTestId('view-search-input').fill('');
  await expect(page.getByTestId('table-row')).toHaveCount(120);
  await expectAllResting(page);
  await page.getByTestId('view-search-input').press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  await page.getByTestId('view-tab-other-scope').click();
  await expect(page.locator('[data-selection-reveal]')).toHaveCount(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  await page.getByTestId('view-tab-resting').click();
  await expectAllResting(page);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  const lastOwned = await restingValue(page, '119').elementHandle();
  await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByTestId('table-view')).toHaveCount(0);
  expect(
    await lastOwned!.evaluate((node) => node.getAttribute('data-selection-reveal')),
  ).toBeNull();
  expect(
    await lastOwned!.evaluate((node) => node.getAttribute('data-selection-reveal-clip')),
  ).toBeNull();
  expect(await restingSnapshot(page)).toEqual(before);
  await old!.dispose();
  await lastOwned!.dispose();
});

test('resting text clip restores an owned box when its actual pane becomes inactive or parked', async ({
  page,
}) => {
  const { suffix } = await openRestingTextFixture(page);
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Systems map');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first().waitFor();
  await page.keyboard.press('Shift+Enter');
  const origin = page.locator('[data-testid="pane"][data-pane-index="0"]');
  const other = page.locator('[data-testid="pane"][data-pane-index="1"]');
  await expect(other).toHaveAttribute('data-active', 'true');
  await origin.getByTestId('pane-bar').click();
  const before = await restingSnapshot(page);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  // Focus the real pane frame; do not rewrite data-active/inert or Selection.
  await other.focus();
  await expect(origin).toHaveAttribute('data-active', 'false');
  await expect
    .poll(() => restingValue(page, '119').getAttribute('data-selection-reveal'))
    .toBeNull();
  expect((await restingMode(restingValue(page, '119'))).x).toBe('clip');
  expect(await restingValue(page, '119').getAttribute('data-selection-reveal-clip')).toBeNull();
  await origin.getByTestId('pane-bar').click();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  // Both frames remain mounted. Narrowing after the other gains focus parks the
  // older grid; its original element must have relinquished promotion already.
  await other.focus();
  await page.setViewportSize({ width: 700, height: 720 });
  expect((await page.getByTestId('pane-row').boundingBox())!.width).toBeLessThan(832);
  await expect(origin).toHaveAttribute('data-parked', 'true');
  await expect(origin.locator('[data-selection-reveal]')).toHaveCount(0);
  await expect(origin.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  expect(await restingSnapshot(page)).toEqual(before);
});

test('resting text clip retains actual text-button drag behavior and never promotes a pointer range', async ({
  page,
}) => {
  await openRestingTextFixture(page);
  await expectAllResting(page);
  const before = await restingSnapshot(page),
    value = restingValue(page, '000');
  await value.evaluate((node) => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const box = (await value.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(45, box.width - 2), box.y + box.height / 2, { steps: 8 });
  const during = await page.evaluate(() => ({
    text: getSelection()?.toString(),
    count: getSelection()?.rangeCount,
  }));
  await page.mouse.up();
  await restingFrames(page);
  // Root's baseline in both engines opens the button editor on release and
  // supplies no retained text range. No autoscroll capability is invented.
  await expect(
    restingRow(page, '000').getByRole('textbox', { name: 'Detail', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('');
  await expect(page.locator('[data-selection-reveal]')).toHaveCount(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  await test.info().attach('resting-text-pointer-observation', {
    body: JSON.stringify(during),
    contentType: 'application/json',
  });
  await restingRow(page, '000')
    .getByRole('textbox', { name: 'Detail', exact: true })
    .press('Escape');
  await expectAllResting(page);
  expect(await restingSnapshot(page)).toEqual(before);
});

test('resting text clip keeps a Find-owned box while a real pointer is down inside it', async ({
  page,
}) => {
  const { suffix } = await openRestingTextFixture(page);
  await expectAllResting(page);
  const before = await restingSnapshot(page),
    value = restingValue(page, '119');
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await findRestingOnce(page, suffix, '119');
  const revealed = await restingMode(value),
    box = (await value.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(60, box.width - 3), box.y + box.height / 2, { steps: 8 });
  const pointerRange = await selectedRestingGlyphs(value);
  const held = await restingMode(value);
  expect(held.x).toBe('hidden');
  expect(held.attribute).toBe('true');
  expect(held.scroll).toBe(revealed.scroll);
  await page.mouse.up();
  await restingFrames(page);
  const editors = restingRow(page, '119').getByRole('textbox', { name: 'Detail', exact: true });
  if (await editors.count()) {
    // Buttons may open editing instead of allowing a native text selection.
    // That is the measured phase-A limitation, not a substitute selected range.
    const changedNonemptyRange = !!pointerRange.text && pointerRange.text !== suffix;
    expect(
      changedNonemptyRange,
      'A newly pointer-selected range must survive release without opening editing',
    ).toBe(false);
    await editors.press('Escape');
  } else {
    expect(await selectedRestingGlyphs(value)).toMatchObject({
      text: pointerRange.text,
      anchor: pointerRange.anchor,
      focus: pointerRange.focus,
    });
    if (pointerRange.text) expect((await restingMode(value)).x).toBe('hidden');
  }
  await test.info().attach('resting-Find-owned-pointer-range', {
    body: JSON.stringify({ pointerRange, held, revealed, editorOpened: await editors.count() }),
    contentType: 'application/json',
  });
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await expect.poll(() => page.locator('[data-selection-reveal]').count()).toBe(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  expect(await restingSnapshot(page)).toEqual(before);
});

test('resting text clip excludes wrapped computed and control fields and preserves real edit/fit/navigation', async ({
  page,
}) => {
  await openRestingTextFixture(page);
  await expectAllResting(page);
  const row = restingRow(page, '000'),
    grid = page.getByTestId('table-view');
  const untouched = row.locator(
    '[aria-colindex="4"], [data-field-kind="number"], [data-field-kind="formula"], [data-field-kind="url"], [data-field-kind="select"]',
  );
  expect(await untouched.locator('[data-selection-reveal]').count()).toBe(0);
  expect(await untouched.locator('[data-selection-reveal-clip]').count()).toBe(0);
  expect(
    await untouched
      .locator('span')
      .evaluateAll(
        (nodes, selector) => nodes.every((node) => !node.matches(selector)),
        restingTextBox,
      ),
  ).toBe(true);
  const wrapped = row.locator('[aria-colindex="4"]');
  expect((await wrapped.boundingBox())!.height).toBeGreaterThan(36);
  await expect(wrapped).toContainText('Second wrapped line');
  const derived = row.locator('[data-field-kind="formula"] > span');
  expect(await derived.evaluate((node) => getComputedStyle(node).overflowX)).toBe('hidden');
  await restingValue(page, '000').evaluate((node) =>
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
  );
  await row.locator('[aria-colindex="3"] [data-cell-primary]').click();
  const editor = row.getByRole('textbox', { name: 'Detail', exact: true });
  await expect(editor).toHaveValue('Fits 000');
  expect(await editor.evaluate((node, selector) => node.matches(selector), restingTextBox)).toBe(
    false,
  );
  await editor.fill('Cancelled draft');
  await editor.press('Escape');
  expect((await restingMode(restingValue(page, '000'))).text).toBe('Fits 000');
  // The padded cell remains a real edit target; a human commit is exactly the
  // action permitted to change this record, unlike a reveal or cancelled draft.
  await row.locator('[aria-colindex="3"]').click({ position: { x: 2, y: 12 } });
  await expect(editor).toBeVisible();
  await editor.fill('Committed through the original editor');
  await editor.press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('resting-clip/000.md')))
    .toContain('Committed through the original editor');
  await expect(row.getByRole('textbox')).toHaveCount(0);
  expect((await restingMode(restingValue(page, '000'))).x).toBe('clip');
  const resize = page.getByRole('separator', { name: 'Resize Detail column', exact: true });
  const beforeWidth = (await row.locator('[aria-colindex="3"]').boundingBox())!.width;
  await resize.focus();
  await resize.press('Enter');
  await expect
    .poll(async () => (await row.locator('[aria-colindex="3"]').boundingBox())!.width)
    .toBeGreaterThan(beforeWidth);
  await grid.focus();
  await grid.press('End');
  await expect(restingRow(page, '119')).toHaveAttribute('data-focused', 'true');
  expect(await grid.getAttribute('aria-activedescendant')).toBe(
    await restingRow(page, '119')
      .locator('[role="gridcell"][aria-colindex="3"]')
      .getAttribute('id'),
  );
  await expect(page.getByTestId('table-row')).toHaveCount(120);
});

test('resting text clip keeps an exact refused text draft offscreen and retries through the original writer', async ({
  page,
}) => {
  await openRestingTextFixture(page);
  await expectAllResting(page);
  const before = await restingSnapshot(page),
    row = restingRow(page, '119'),
    grid = page.getByTestId('table-view');
  const source = await page.evaluate(() => window.__cerebroMockFs.get('resting-clip/119.md'));
  await restingValue(page, '119').evaluate((node) =>
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
  );
  await row.locator('[aria-colindex="3"] [data-cell-primary]').click();
  const input = row.getByRole('textbox', { name: 'Detail', exact: true });
  const draft = '  Exact refused text draft kept through scroll  ';
  await input.fill(draft);
  // Existing browser mock fault seam: missing disk target makes the real writer
  // refuse. No helper/store replacement and no fake success acknowledgement.
  await page.evaluate(() => window.__cerebroMockFs.delete('resting-clip/119.md'));
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue(draft);
  const status = page.locator(
    `[data-field-status="${await input.getAttribute('aria-describedby')}"]`,
  );
  await expect(status).toBeVisible();
  await grid.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(input).toHaveValue(draft);
  await expect(status).toBeHidden();
  await grid.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(status).toBeVisible();
  await expect(input).toHaveValue(draft);
  const refusedWrites = await page.evaluate(() => ({
    available: Array.isArray(window.__cerebroMockWrites),
    count: Array.isArray(window.__cerebroMockWrites) ? window.__cerebroMockWrites.length : null,
  }));
  expect(refusedWrites).toEqual({ available: true, count: 0 });
  await page.evaluate(
    (source) => window.__cerebroMockFs.set('resting-clip/119.md', source!),
    source,
  );
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(grid).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('resting-clip/119.md')))
    .toContain(draft.trim());
  const written = await page.evaluate(() => ({
    available: Array.isArray(window.__cerebroMockWrites),
    rows: Array.isArray(window.__cerebroMockWrites)
      ? window.__cerebroMockWrites.map((row) => ({ kind: row.kind, path: row.path }))
      : null,
  }));
  expect(written).toEqual({
    available: true,
    rows: [{ kind: 'vault.write', path: 'resting-clip/119.md' }],
  });
  expect((await restingMode(restingValue(page, '119'))).x).toBe('clip');
  expect(
    (
      await page.evaluate(() =>
        [...window.__cerebroMockFs].filter(
          ([path]) => path.startsWith('resting-clip/') || path === 'types/resting-clip.md',
        ),
      )
    ).filter(([path]) => path !== 'resting-clip/119.md'),
  ).toEqual(before.files.filter(([path]) => path !== 'resting-clip/119.md'));
});

// M93 diagnostic only: fresh contexts separate property-transition history
// from nonzero field scroll. The production helper and CSS remain unchanged.
for (const arm of ['prefix', 'suffix'] as const) {
  test(`resting text clip controlled ${arm} Find restores paint after switch and clear`, async ({
    page,
  }) => {
    const { suffix, second } = await openRestingTextFixture(page);
    const before = await restingSnapshot(page);
    await expectAllResting(page);
    const a = restingValue(page, '119'),
      b = restingValue(page, '118');
    const originalA = await restingMode(a),
      originalB = await restingMode(b);
    const originalANode = await a.elementHandle(),
      originalBNode = await b.elementHandle();
    expect(originalANode).not.toBeNull();
    expect(originalBNode).not.toBeNull();
    const queryA = arm === 'prefix' ? 'unbrokenvalue' : suffix,
      queryB = arm === 'prefix' ? 'secondlongvalue' : second;
    const { writeFile } = await import('node:fs/promises');
    const save = async (name: string, facts: unknown) => {
      await writeFile(
        test.info().outputPath(`probe-${name}.json`),
        JSON.stringify(facts, null, 2),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
    };
    try {
      await page.getByTestId('table-view').evaluate((grid) => {
        grid.scrollTop = 0;
        grid.scrollLeft = 0;
      });
      // Match the original case's initial clear; never construct or normalize
      // a match or Range. Each findRestingOnce invokes actual Find exactly once.
      await page.evaluate(() => getSelection()?.removeAllRanges());
      const selectedA = await findRestingOnce(page, queryA, '119');
      const duringA = await restingMode(a);
      await save('first-promoted', { arm, queryA, selectedA, originalA, duringA });
      expect(selectedA.anchor).toBe(originalA.text!.indexOf(queryA));
      expect(selectedA.focus).toBe(originalA.text!.indexOf(queryA) + queryA.length);
      expect(duringA.x).toBe('hidden');
      expect(duringA.y).toBe('hidden');
      await expectRestingOwnedGlyphMode(a, duringA);
      expect(duringA.attribute).toBe('true');
      if (arm === 'prefix') expect(duringA.scroll).toBe(0);
      else expect(duringA.scroll).toBeGreaterThan(0);
      expect({
        ...duringA,
        x: originalA.x,
        y: originalA.y,
        ellipsis: originalA.ellipsis,
        scroll: originalA.scroll,
        attribute: originalA.attribute,
      }).toEqual(originalA);
      await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
      const selectedB = await findRestingOnce(page, queryB, '118');
      // Images precede any additional read of the demoted first field.
      await captureRestingPaintStage(page, `controlled-${arm}-after-switch`, true);
      const restoredA = await restingMode(a),
        duringB = await restingMode(b);
      await save('second-promoted', { arm, queryB, selectedB, restoredA, originalB, duringB });
      expect(selectedB.anchor).toBe(originalB.text!.indexOf(queryB));
      expect(selectedB.focus).toBe(originalB.text!.indexOf(queryB) + queryB.length);
      expect(restoredA).toEqual(originalA);
      expect(await a.getAttribute('data-selection-reveal-clip')).toBeNull();
      expect(duringB.x).toBe('hidden');
      expect(duringB.y).toBe('hidden');
      await expectRestingOwnedGlyphMode(b, duringB);
      expect(duringB.attribute).toBe('true');
      if (arm === 'prefix') expect(duringB.scroll).toBe(0);
      else expect(duringB.scroll).toBeGreaterThan(0);
      expect({
        ...duringB,
        x: originalB.x,
        y: originalB.y,
        ellipsis: originalB.ellipsis,
        scroll: originalB.scroll,
        attribute: originalB.attribute,
      }).toEqual(originalB);
      await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await expect.poll(() => restingMode(b)).toEqual(originalB);
      await expectAllResting(page);
      await captureRestingPaintStage(page, `controlled-${arm}-after-clear`, true);
      expect(await restingMode(a)).toEqual(originalA);
      expect(await restingMode(b)).toEqual(originalB);
      expect(await a.evaluate((node, original) => node === original, originalANode)).toBe(true);
      expect(await b.evaluate((node, original) => node === original, originalBNode)).toBe(true);
      const selection = await page.evaluate(() => ({
        text: getSelection()?.toString(),
        count: getSelection()?.rangeCount,
      }));
      expect(selection).toEqual({ text: '', count: 0 });
      await expect(page.getByTestId('table-view').getByRole('textbox')).toHaveCount(0);
      const after = await restingSnapshot(page);
      await save('complete', { arm, selection, before, after });
      expect(after).toEqual(before);
    } finally {
      await originalANode?.dispose();
      await originalBNode?.dispose();
    }
  });
}

// M93 paint regression: compare real native pixels within this engine/run.
// A separate fresh context supplies initial pixels without prepainting the
// actual Find context. No golden files, CSS/helper injection or Range creation.
async function restingNativePng(png: Buffer) {
  const { inflateSync } = await import('node:zlib');
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Native screenshot is not PNG');
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  if (png[24] !== 8 || channels === 0 || png[28] !== 0 || width * height > 16777216)
    throw new Error('Unsupported native screenshot encoding; pixel comparison unavailable');
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (offset + length + 12 > png.length) throw new Error('Truncated native PNG');
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed)),
    stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('Unexpected native PNG data length');
  const samples = Buffer.alloc(stride * height),
    rgba = Buffer.alloc(width * height * 4);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1),
      filter = raw[row];
    if (filter > 4) throw new Error('Unsupported native PNG filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? samples[i - channels] : 0;
      const up = y > 0 ? samples[i - stride] : 0;
      const corner = y > 0 && x >= channels ? samples[i - stride - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, corner);
      samples[i] = (raw[row + 1 + x] + predictor) & 255;
    }
  }
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = samples[i * channels];
    rgba[i * 4 + 1] = samples[i * channels + 1];
    rgba[i * 4 + 2] = samples[i * channels + 2];
    rgba[i * 4 + 3] = channels === 4 ? samples[i * channels + 3] : 255;
  }
  return { width, height, rgba };
}

async function restingNativePaint(page: Page, stage: string, delayed: boolean) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(test.info().outputDir, { recursive: true });
  const before = await page.evaluateHandle(() => {
    const s = getSelection();
    return {
      anchor: s?.anchorNode,
      focus: s?.focusNode,
      a: s?.anchorOffset,
      f: s?.focusOffset,
      text: s?.toString(),
      count: s?.rangeCount,
      active: document.activeElement,
    };
  });
  const images: { name: string; native: Awaited<ReturnType<typeof restingNativePng>> }[] = [];
  for (const timing of delayed ? ['image-first', 'two-frames'] : ['image-first']) {
    if (timing === 'two-frames') await restingFrames(page);
    const name = 'native-paint-' + stage + '-' + timing + '.png';
    const png = await page.screenshot({ animations: 'disabled', scale: 'device' });
    await writeFile(test.info().outputPath(name), png, { flag: 'wx', mode: 0o600 });
    images.push({ name, native: await restingNativePng(png) });
  }
  // Both native images precede these new field style/geometry reads.
  const facts = await page.evaluate(() => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const s = getSelection(),
      writes = window.__cerebroMockWrites;
    return {
      dpr: devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      visualScale: visualViewport?.scale ?? null,
      rootZoom: getComputedStyle(document.documentElement).zoom,
      selection: { text: s?.toString(), count: s?.rangeCount },
      available: Array.isArray(writes),
      writes: Array.isArray(writes) ? writes.length : null,
      fields: ['117', '118', '119'].map((id) => {
        const node = document.querySelector<HTMLElement>(
          '[data-path="resting-clip/' +
            id +
            '.md"] [aria-colindex="3"] > .cb-cell-chrome > button[data-cell-primary] > span',
        )!;
        const style = getComputedStyle(node);
        return {
          id,
          text: node.textContent,
          connected: node.isConnected,
          cell: rect(node.closest('[role="gridcell"]')!),
          span: rect(node),
          x: style.overflowX,
          y: style.overflowY,
          ellipsis: style.textOverflow,
          scroll: node.scrollLeft,
          reveal: node.getAttribute('data-selection-reveal'),
          glyphClip: node.getAttribute('data-selection-reveal-clip'),
          font: style.font,
          color: style.color,
          whiteSpace: style.whiteSpace,
        };
      }),
    };
  });
  const selectionPreserved = await before.evaluate((old) => {
    const s = getSelection();
    return (
      s?.anchorNode === old.anchor &&
      s?.focusNode === old.focus &&
      s?.anchorOffset === old.a &&
      s?.focusOffset === old.f &&
      s?.toString() === old.text &&
      s?.rangeCount === old.count &&
      document.activeElement === old.active
    );
  });
  await writeFile(
    test.info().outputPath('native-paint-' + stage + '-facts.json'),
    JSON.stringify(
      { stage, images: images.map((image) => image.name), selectionPreserved, ...facts },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  await before.dispose();
  expect(selectionPreserved).toBe(true);
  expect(facts.available).toBe(true);
  expect(facts.writes).toBe(0);
  for (const image of images) {
    expect(image.native.width).toBe(Math.round(facts.viewport.width * facts.dpr));
    expect(image.native.height).toBe(Math.round(facts.viewport.height * facts.dpr));
  }
  return { facts, images };
}

function restingNativeDifference(
  initial: Awaited<ReturnType<typeof restingNativePaint>>,
  restored: Awaited<ReturnType<typeof restingNativePaint>>,
  image: Awaited<ReturnType<typeof restingNativePaint>>['images'][number],
  id: string,
) {
  const a = initial.facts.fields.find((field) => field.id === id)!,
    b = restored.facts.fields.find((field) => field.id === id)!;
  const box = (field: typeof a, dpr: number) => ({
    left: Math.floor(field.cell.x * dpr),
    top: Math.floor(field.cell.y * dpr),
    right: Math.ceil((field.cell.x + field.cell.width) * dpr),
    bottom: Math.ceil((field.cell.y + field.cell.height) * dpr),
    phaseX: field.cell.x * dpr - Math.floor(field.cell.x * dpr),
    phaseY: field.cell.y * dpr - Math.floor(field.cell.y * dpr),
  });
  const first = initial.images[0],
    ar = box(a, initial.facts.dpr),
    br = box(b, restored.facts.dpr);
  const comparable =
    initial.facts.dpr === restored.facts.dpr &&
    initial.facts.visualScale === restored.facts.visualScale &&
    initial.facts.rootZoom === restored.facts.rootZoom &&
    a.text === b.text &&
    a.connected &&
    b.connected &&
    a.cell.width === b.cell.width &&
    a.cell.height === b.cell.height &&
    a.span.width === b.span.width &&
    a.span.height === b.span.height &&
    Math.abs(ar.phaseX - br.phaseX) < 0.000001 &&
    Math.abs(ar.phaseY - br.phaseY) < 0.000001 &&
    ar.right - ar.left === br.right - br.left &&
    ar.bottom - ar.top === br.bottom - br.top &&
    ar.left >= 0 &&
    ar.top >= 0 &&
    br.left >= 0 &&
    br.top >= 0 &&
    ar.right <= first.native.width &&
    ar.bottom <= first.native.height &&
    br.right <= image.native.width &&
    br.bottom <= image.native.height;
  let differentPixels: number | null = null;
  let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
  if (comparable) {
    differentPixels = 0;
    for (let y = 0; y < ar.bottom - ar.top; y++) {
      for (let x = 0; x < ar.right - ar.left; x++) {
        const ai = ((ar.top + y) * first.native.width + ar.left + x) * 4;
        const bi = ((br.top + y) * image.native.width + br.left + x) * 4;
        if (
          !first.native.rgba.subarray(ai, ai + 4).equals(image.native.rgba.subarray(bi, bi + 4))
        ) {
          differentPixels++;
          bounds = bounds
            ? {
                left: Math.min(bounds.left, x),
                top: Math.min(bounds.top, y),
                right: Math.max(bounds.right, x + 1),
                bottom: Math.max(bounds.bottom, y + 1),
              }
            : { left: x, top: y, right: x + 1, bottom: y + 1 };
        }
      }
    }
  }
  return { id, before: first.name, after: image.name, comparable, differentPixels, bounds, ar, br };
}

test('resting text clip restores same-engine native cell pixels after real Find switch and clear', async ({
  page,
  browser,
  baseURL,
}) => {
  // Own and close this separate baseline context even if a baseline guard fails.
  const baselineContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  let initial: Awaited<ReturnType<typeof restingNativePaint>> | null = null;
  try {
    const baseline = await baselineContext.newPage();
    await openRestingTextFixture(baseline);
    await expectAllResting(baseline);
    await expect(baseline.locator('[data-selection-reveal-clip]')).toHaveCount(0);
    await baseline.getByTestId('table-view').evaluate((grid) => {
      grid.scrollTop = grid.scrollHeight;
      grid.scrollLeft = 0;
    });
    await restingFrames(baseline);
    initial = await restingNativePaint(baseline, 'initial-separate-context', false);
    await expectAllResting(baseline);
  } finally {
    await baselineContext.close();
  }
  if (initial === null) throw new Error('Initial native paint unavailable');
  const { suffix, second } = await openRestingTextFixture(page);
  const before = await restingSnapshot(page);
  await expectAllResting(page);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  const a = restingValue(page, '119'),
    b = restingValue(page, '118');
  const originalA = await restingMode(a),
    originalB = await restingMode(b);
  const aNode = await a.elementHandle(),
    bNode = await b.elementHandle();
  expect(aNode).not.toBeNull();
  expect(bNode).not.toBeNull();
  try {
    await page.getByTestId('table-view').evaluate((grid) => {
      grid.scrollTop = 0;
      grid.scrollLeft = 0;
    });
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await findRestingOnce(page, suffix, '119');
    await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
    const duringA = await restingMode(a);
    expect(duringA.x).toBe('hidden');
    expect(duringA.y).toBe('hidden');
    expect(duringA.scroll).toBeGreaterThan(0);
    expect({
      ...duringA,
      x: originalA.x,
      y: originalA.y,
      ellipsis: originalA.ellipsis,
      scroll: originalA.scroll,
      attribute: originalA.attribute,
    }).toEqual(originalA);
    await findRestingOnce(page, second, '118');
    const switched = await restingNativePaint(page, 'after-switch', true);
    expect(await restingMode(a)).toEqual(originalA);
    expect(switched.facts.fields.find((field) => field.id === '119')!.glyphClip).toBeNull();
    await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
    const duringB = await restingMode(b);
    expect(duringB.x).toBe('hidden');
    expect(duringB.y).toBe('hidden');
    expect(duringB.scroll).toBeGreaterThan(0);
    expect({
      ...duringB,
      x: originalB.x,
      y: originalB.y,
      ellipsis: originalB.ellipsis,
      scroll: originalB.scroll,
      attribute: originalB.attribute,
    }).toEqual(originalB);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await expect.poll(() => restingMode(b)).toEqual(originalB);
    await expectAllResting(page);
    const cleared = await restingNativePaint(page, 'after-clear', true);
    expect(await restingMode(a)).toEqual(originalA);
    expect(await restingMode(b)).toEqual(originalB);
    await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
    expect(await a.evaluate((node, original) => node === original, aNode)).toBe(true);
    expect(await b.evaluate((node, original) => node === original, bNode)).toBe(true);
    expect(cleared.facts.selection).toEqual({ text: '', count: 0 });
    await expect(page.getByTestId('table-view').getByRole('textbox')).toHaveCount(0);
    expect(await restingSnapshot(page)).toEqual(before);
    const comparisons = [
      ...switched.images.flatMap((image) =>
        ['117', '119'].map((id) => restingNativeDifference(initial, switched, image, id)),
      ),
      ...cleared.images.flatMap((image) =>
        ['117', '118', '119'].map((id) => restingNativeDifference(initial, cleared, image, id)),
      ),
    ];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      test.info().outputPath('native-paint-comparisons.json'),
      JSON.stringify(
        {
          baselineContextClosed: true,
          comparison: 'same engine, run and field; native RGBA; no tolerance/resampling/golden',
          comparisons,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    expect(
      comparisons.every((result) => result.comparable),
      'Native cell dimensions/pixel phase differ; paint comparison unavailable',
    ).toBe(true);
    expect(
      comparisons.map(({ id, after, differentPixels }) => ({ id, after, differentPixels })),
      'Restored native cell pixels must equal their own initial same-engine paint',
    ).toEqual(comparisons.map(({ id, after }) => ({ id, after, differentPixels: 0 })));
  } finally {
    await aNode?.dispose();
    await bNode?.dispose();
  }
});

// The fixture owns this pre-existing attribute; the production helper must
// restore its exact value rather than treating every marker as its own.
test('resting text clip restores exact prior glyph markers when the real Find owner switches', async ({
  page,
}) => {
  const { suffix, second } = await openRestingTextFixture(page);
  const before = await restingSnapshot(page);
  const a = restingValue(page, '119'),
    b = restingValue(page, '118');
  for (const prior of ['', 'prior-marker-value', 'true']) {
    await expectAllResting(page);
    const originalA = await restingMode(a),
      originalB = await restingMode(b);
    const originalNode = await a.elementHandle();
    expect(originalNode).not.toBeNull();
    try {
      await a.evaluate(
        (node, prior) => node.setAttribute('data-selection-reveal-clip', prior),
        prior,
      );
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await findRestingOnce(page, suffix, '119');
      const during = await restingMode(a);
      await expectRestingOwnedGlyphMode(a, during);
      expect(during.x).toBe('hidden');
      expect(during.y).toBe('hidden');
      expect(during.scroll).toBeGreaterThan(0);
      await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
      await findRestingOnce(page, second, '118');
      expect(await restingMode(a)).toEqual(originalA);
      expect(await a.getAttribute('data-selection-reveal-clip')).toBe(prior);
      expect(await a.evaluate((node, original) => node === original, originalNode)).toBe(true);
      await expectRestingOwnedGlyphMode(b, await restingMode(b));
      expect((await restingMode(b)).scroll).toBeGreaterThan(0);
      await expect(page.locator('[data-selection-reveal="true"]')).toHaveCount(1);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await expect.poll(() => restingMode(b)).toEqual(originalB);
      expect(await b.getAttribute('data-selection-reveal-clip')).toBeNull();
      expect(await a.getAttribute('data-selection-reveal-clip')).toBe(prior);
      await a.evaluate((node) => node.removeAttribute('data-selection-reveal-clip'));
      await expectAllResting(page);
      await expect(page.getByTestId('table-view').getByRole('textbox')).toHaveCount(0);
      expect(await restingSnapshot(page)).toEqual(before);
    } finally {
      await a.evaluate((node) => node.removeAttribute('data-selection-reveal-clip'));
      await originalNode?.dispose();
    }
  }
});
