import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
  }
}

async function boot(page: Page): Promise<void> {
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => window.localStorage.setItem('cerebro.autoLearn', 'false'));
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

/** Expand a Collection row in the sidebar tree. */
async function expand(page: Page, name: string): Promise<void> {
  const caret = page.getByRole('button', { name: `Expand ${name}` });
  if (await caret.isVisible()) await caret.click();
}

test('collections: a container holds lists and docs, and the sidebar walks it', async ({ page }) => {
  await boot(page);

  // The sidebar's top-level concept is Collections, not Views.
  await expect(page.getByText('Collections', { exact: true })).toBeVisible();

  // The demo vault ships one: `delivery/`, holding three Lists and a Doc.
  const delivery = page.getByTestId('collection-node-collection').filter({ hasText: 'Delivery' });
  await expect(delivery).toBeVisible();

  // Collapsed, its contents are not on screen; expanding reveals them.
  await expect(page.getByTestId('collection-node-list')).toHaveCount(0);
  await expand(page, 'Delivery');
  await expect(
    page.getByTestId('collection-node-list').filter({ hasText: 'Delivery schedule' }),
  ).toBeVisible();
  await expect(page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' })).toBeVisible();

  // The Collection has a page of its own: what is in here, and nothing else.
  // A container carries no query, so this is a contents listing, not a canvas.
  await delivery.getByRole('button', { name: 'Delivery', exact: true }).click();
  const page_ = page.getByTestId('collection-page');
  await expect(page_).toBeVisible();
  await expect(page_.getByTestId('collection-content-row')).toHaveCount(4);
  await expect(page_.getByTestId('collection-content-row').filter({ hasText: 'List' })).toHaveCount(3);
  await expect(page_.getByTestId('collection-content-row').filter({ hasText: 'Doc' })).toHaveCount(1);
  // No record canvas on a container.
  await expect(page.getByTestId('table-view')).toHaveCount(0);
  await expect(page.getByTestId('list-view')).toHaveCount(0);

  // A List inside it opens the record canvas.
  await page_.getByRole('button', { name: 'At risk', exact: true }).click();
  await expect(page.getByTestId('table-view')).toBeVisible();
});

test('collections: nothing sits outside a Collection — there is no Lists bucket', async ({ page }) => {
  await boot(page);

  // The one and only top-level grouping. A folder holding Lists IS a Collection,
  // so no List can be orphaned and no home-of-last-resort is needed.
  await expect(page.getByText('Collections', { exact: true })).toBeVisible();
  await expect(page.getByText('Lists', { exact: true })).toHaveCount(0);

  // Every List node in the sidebar is nested under a Collection, never a sibling
  // of one.
  await expand(page, 'Delivery');
  await expand(page, 'Strategy');
  const listCount = await page.getByTestId('collection-node-list').count();
  expect(listCount).toBeGreaterThan(0);
  const orphans = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="collection-node-list"]')].filter((el) => {
      // A list row is legitimate only if a collection row precedes it at a
      // shallower indent — which is what nesting looks like in this flat DOM.
      const indent = parseInt((el as HTMLElement).style.paddingLeft || '0', 10);
      let prev = el.previousElementSibling;
      while (prev !== null) {
        if (prev.getAttribute('data-testid') === 'collection-node-collection') {
          return parseInt((prev as HTMLElement).style.paddingLeft || '0', 10) >= indent;
        }
        prev = prev.previousElementSibling;
      }
      return true;
    }).length,
  );
  expect(orphans).toBe(0);
});

test('collections: a nested table renders the retired hierarchy view’s job', async ({ page }) => {
  await boot(page);
  await expand(page, 'Strategy');
  await page
    .getByTestId('collection-node-list')
    .filter({ hasText: 'OKR tree' })
    .getByRole('button', { name: 'OKR tree', exact: true })
    .click();

  // Written as `type: tree` — the retired Hierarchy view. It opens as a TABLE
  // that nests, because the nesting always lived in the grouping chain.
  await expect(page.getByTestId('table-view')).toBeVisible();
  await expect(page.locator('[data-testid="table-row"][data-depth="1"]').first()).toBeVisible();

  // Switching the view persists to the List's own file, in place.
  await page.getByTestId('view-switch-list').click();
  await expect(page.getByTestId('list-view')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__cerebroMockFs.get('strategy/okr-tree.list.yml') ?? ''),
    )
    .toContain('type: list');
});

test('collections: creating one writes a folder marker and opens its empty page', async ({ page }) => {
  await boot(page);

  await page.getByTestId('new-collection').click();
  await page.getByRole('textbox', { name: 'Collection name' }).fill('Field ops');
  await page.getByRole('button', { name: 'Create' }).click();

  const created = page.getByTestId('collection-page');
  await expect(created).toBeVisible();
  await expect(created.getByText('Nothing in here yet')).toBeVisible();

  // A Collection is a FOLDER holding a marker — containers on screen are
  // containers on disk.
  await expect
    .poll(async () =>
      page.evaluate(() => window.__cerebroMockFs.get('field-ops/collection.yml') ?? ''),
    )
    .toContain('name: Field ops');
});

test('views: all six are reachable, and the date views place records on an axis', async ({ page }) => {
  await boot(page);
  await expand(page, 'Delivery');
  await page
    .getByTestId('collection-node-list')
    .filter({ hasText: 'Delivery schedule' })
    .getByRole('button', { name: 'Delivery schedule', exact: true })
    .click();

  // The six, and only the six: the retired kinds have no segment.
  for (const kind of ['table', 'list', 'board', 'calendar', 'gantt', 'timeline']) {
    await expect(page.getByTestId(`view-switch-${kind}`)).toBeVisible();
  }
  await expect(page.getByTestId('view-switch-tree')).toHaveCount(0);
  await expect(page.getByTestId('view-switch-split')).toHaveCount(0);

  // -- Gantt: the List declares `dateField: window` and `dependencyField:
  // blocked_by`, so it draws bars AND the arrows the data claims.
  const gantt = page.getByTestId('gantt-view');
  await expect(gantt).toBeVisible();
  await expect(gantt).toHaveAttribute('data-date-field', 'window');
  await expect(page.getByTestId('gantt-bar').first()).toBeVisible();
  await expect(page.getByTestId('gantt-arrows')).toBeAttached();
  // The one number a schedule owes you.
  await expect(page.getByTestId('gantt-slips')).toBeVisible();

  // Zoom is an axis control, and it persists to the List's YAML.
  await page.getByTestId('zoom-week').click();
  await expect(page.getByTestId('gantt-view')).toHaveAttribute('data-zoom', 'week');
  await expect
    .poll(async () =>
      page.evaluate(() => window.__cerebroMockFs.get('delivery/delivery-schedule.list.yml') ?? ''),
    )
    .toContain('zoom: week');

  // -- Timeline: same axis, no dependency layer, bars carry their own label.
  await page.getByTestId('view-switch-timeline').click();
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(page.getByTestId('timeline-bar').first()).toBeVisible();

  // -- Calendar: a month grid of 42 days, and a record on every day its span
  // covers rather than one chip on its start date.
  await page.getByTestId('view-switch-calendar').click();
  const calendar = page.getByTestId('calendar-view');
  await expect(calendar).toBeVisible();
  await expect(calendar).toHaveAttribute('data-date-field', 'window');
  await expect(page.getByTestId('calendar-day')).toHaveCount(42);
  await expect(page.getByTestId('calendar-month')).toBeVisible();
  // Paging months keeps the grid the same height — no page jump.
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByTestId('calendar-day')).toHaveCount(42);
});

test('views: a table nests when its grouping chain descends a relation', async ({ page }) => {
  await boot(page);
  // The OKR list bands nothing and descends two relations: Objective → Key
  // result → Work item. This is what the retired Hierarchy view was for.
  await expand(page, 'Strategy');
  await page
    .getByTestId('collection-node-list')
    .filter({ hasText: 'OKR tree' })
    .getByRole('button', { name: 'OKR tree', exact: true })
    .click();
  await page.getByTestId('view-switch-table').click();

  const depth0 = page.locator('[data-testid="table-row"][data-depth="0"]');
  const depth1 = page.locator('[data-testid="table-row"][data-depth="1"]');
  await expect(depth0.first()).toBeVisible();
  await expect(depth1.first()).toBeVisible();

  // Collapsing a parent hides its descendants but keeps the parent.
  const before = await depth1.count();
  // Scoped to the grid: the sidebar's expanded Collections have their own
  // "Collapse …" carets, and an unscoped match hits one of those instead.
  await page
    .getByTestId('table-view')
    .getByRole('button', { name: /^Collapse / })
    .first()
    .click();
  await expect.poll(async () => depth1.count()).toBeLessThan(before);
  await expect(depth0.first()).toBeVisible();
});
