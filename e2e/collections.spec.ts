import { test, expect, type Page } from '@playwright/test';
import { boot } from './boot';

/** Expand a Collection row in the sidebar tree. */
async function expand(page: Page, name: string): Promise<void> {
  const caret = page.getByRole('button', { name: `Expand ${name}` });
  if (await caret.isVisible()) await caret.click();
}

/**
 * Open the layout picker of the view tab you are standing on (M11).
 *
 * A List's layout moved out of the toolbar and into the tab's own menu:
 * pressing a pill used to overwrite the view you had configured, where opening
 * another tab takes you to a different one.
 */
async function openLayoutPicker(page: Page): Promise<void> {
  await page.getByTestId('view-tabs').getByRole('tab', { selected: true }).click();
  await page.getByRole('menuitem', { name: 'Change layout…' }).click();
}

/** Change the open view's layout. */
async function switchLayout(page: Page, kind: string): Promise<void> {
  await openLayoutPicker(page);
  await page.getByTestId(`view-switch-${kind}`).click();
}

/**
 * Open one of a database's saved views (M47.5).
 *
 * These used to be `*.list.yml` files clicked in a Collection's subtree. The
 * corpus converted: three Lists over Work item are three TABS of Work item,
 * and the OKR tree is a tab of Objective. The subjects below did not change —
 * layouts, nesting, the date axes — only the route to them.
 */
async function openDatabaseView(page: Page, database: string, view: string): Promise<void> {
  await page.getByTestId('sidebar-type').filter({ hasText: database }).first().click();
  const tab = page.getByTestId('view-tabs').getByRole('tab', { name: view });
  await expect(tab).toBeVisible();
  // Pressing the tab you are ALREADY on opens its menu (that is how the
  // layout picker is reached), and the menu's backdrop then swallows every
  // later click in the test. The first view of a database is selected on
  // arrival, so this is the common case rather than the corner one.
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
}

test('collections: a container is a page that holds docs and databases', async ({ page }) => {
  await boot(page);

  // The sidebar's top-level concept is Collections, not Views. (Scoped to
  // the sidebar: since M12.5 Home's grid carries the same heading.)
  const sidebar = page.getByLabel('Sidebar', { exact: true });
  await expect(sidebar.getByText('Collections', { exact: true })).toBeVisible();

  // M47.5: `delivery/` is a PAGE — `delivery/delivery.md` carrying
  // `type: Collection` — holding a doc and, in its own body, the three views
  // that used to be three `*.list.yml` files sitting beside it.
  const delivery = page.getByTestId('collection-node-collection').filter({ hasText: 'Delivery' });
  await expect(delivery).toBeVisible();

  // Collapsed, its contents are not on screen; expanding reveals them.
  await expect(page.getByTestId('collection-node-doc')).toHaveCount(0);
  await expand(page, 'Delivery');
  await expect(
    page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' }),
  ).toBeVisible();
  // The Lists are gone from the tree because they are gone from disk.
  await expect(page.getByTestId('collection-node-list')).toHaveCount(0);

  // The container's home page carries its own BODY — the thing it could not
  // do while it was a marker file and a listing, and the reason its empty
  // state used to tell you to go and use the sidebar.
  await delivery.getByRole('button', { name: 'Delivery', exact: true }).click();
  const page_ = page.getByTestId('collection-page');
  await expect(page_).toBeVisible();
  await expect(page_.getByText('Everything in flight')).toBeVisible();
  await expect(
    page_.locator('[data-testid="collection-content-row"][data-kind="doc"]'),
  ).toHaveCount(1);

  // And a database block in that body draws real rows, in place.
  const block = page.getByTestId('database-block').first();
  await expect(block).toBeVisible();
  await expect(block.getByText('Work item')).toBeVisible();
  await expect(block.getByTestId('table-view')).toBeVisible();
});

test('collections: nothing sits outside a Collection — there is no Lists bucket', async ({
  page,
}) => {
  await boot(page);

  // The one and only top-level grouping. A folder holding Lists IS a Collection,
  // so no List can be orphaned and no home-of-last-resort is needed. (Scoped
  // to the sidebar: since M12.5 Home's grid carries the same heading.)
  const sidebar = page.getByLabel('Sidebar', { exact: true });
  await expect(sidebar.getByText('Collections', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('Lists', { exact: true })).toHaveCount(0);

  // M47.5 converted the corpus's Lists into views of their databases, so the
  // rule holds in a stronger form than the orphan walk this used to do: there
  // is no list node anywhere in the tree that COULD be orphaned. The reader
  // still understands one — a hand-written `*.list.yml` keeps working, which
  // is D9 — so this asserts the corpus is converted, not that lists died.
  await expand(page, 'Delivery');
  await expand(page, 'Strategy');
  await expect(page.getByTestId('collection-node-list')).toHaveCount(0);
});

test('collections: a nested table renders the retired hierarchy view’s job', async ({ page }) => {
  await boot(page);
  await openDatabaseView(page, 'Objective', 'OKR tree');

  // Written as `type: tree` — the retired Hierarchy view. It opens as a TABLE
  // that nests, because the nesting always lived in the grouping chain.
  await expect(page.getByTestId('table-view')).toBeVisible();
  await expect(page.locator('[data-testid="table-row"][data-depth="1"]').first()).toBeVisible();

  // Switching the LAYOUT of the open tab persists — to the DATABASE's own
  // Type doc now that the view lives there, but the contract is unchanged:
  // the tab keeps its identity, it just draws differently.
  await switchLayout(page, 'list');
  await expect(page.getByTestId('list-view')).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => window.__cerebroMockFs.get('types/objective.md') ?? ''))
    .toContain('type: list');
});

test('collections: creating one writes a folder marker and opens its empty page', async ({
  page,
}) => {
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

test('views: every kind is offered, and the date views place records on an axis', async ({
  page,
}) => {
  await boot(page);
  await openDatabaseView(page, 'Work item', 'Delivery schedule');

  // Every kind in the catalog is offered — this roster is the e2e twin of
  // viewKinds.test's registration contract — and the retired kinds are offered
  // nowhere. M11 moved the picker into the open tab's menu. (This said "the
  // six" for four milestones while the app grew to ten, which is why the
  // roster is spelled out and never counted.)
  await openLayoutPicker(page);
  for (const kind of [
    'table',
    'list',
    'board',
    'calendar',
    'gantt',
    'timeline',
    'gallery',
    'chart',
    'dashboard',
    'whiteboard',
  ]) {
    await expect(page.getByTestId(`view-switch-${kind}`)).toBeVisible();
  }
  await expect(page.getByTestId('view-switch-tree')).toHaveCount(0);
  await expect(page.getByTestId('view-switch-split')).toHaveCount(0);
  // At the corner, deliberately. "Close layout picker" is a `fixed inset-0`
  // backdrop, so a default click lands at the CENTRE of the viewport — which
  // is now inside the picker's own menu and hits a layout row instead of
  // dismissing. Escape is not an option either: this picker still mounts
  // through the pre-M16.1 `FixedBelowAnchor`, which registers no dismiss
  // layer, so nothing is listening for the key.
  await page.getByLabel('Close layout picker').click({ position: { x: 4, y: 4 } });

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
    .poll(async () => page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md') ?? ''))
    .toContain('zoom: week');

  // -- Timeline: same axis, no dependency layer, bars carry their own label.
  await switchLayout(page, 'timeline');
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(page.getByTestId('timeline-bar').first()).toBeVisible();

  // -- Calendar: a month grid of 42 days, and a record on every day its span
  // covers rather than one chip on its start date.
  await switchLayout(page, 'calendar');
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
  // The OKR view bands nothing and descends two relations: Objective → Key
  // result → Work item. This is what the retired Hierarchy view was for.
  await openDatabaseView(page, 'Objective', 'OKR tree');
  await switchLayout(page, 'table');

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

/**
 * Multiple views per database (M11, rehomed M47.5).
 *
 * The regression this guards is the one the whole change exists to prevent: a
 * List used to carry exactly one presentation, so "look at this as a board"
 * REPLACED the table you had configured. Two tabs must be able to disagree
 * about layout, filters and grouping while querying the same records.
 *
 * The tabs belong to the DATABASE now rather than to a `*.list.yml`, which is
 * the same contract reached through one file instead of two — and the corpus
 * arrives with three of them, where a converted List used to arrive with one.
 */
test('views: a database keeps several views as tabs, each with its own layout', async ({
  page,
}) => {
  await boot(page);
  await openDatabaseView(page, 'Work item', 'At risk');

  const tabs = page.getByTestId('view-tabs');
  const before = await tabs.getByRole('tab').count();
  expect(before).toBeGreaterThan(1);
  await expect(page.getByTestId('table-view')).toBeVisible();
  // And no pill strip in the toolbar — layout belongs to the tab now.
  await expect(page.getByTestId('view-switch-board')).toHaveCount(0);

  // Add a board view. The layout is chosen when the view is made.
  await page.getByTestId('new-view').click();
  await page.getByTestId('new-view-board').click();
  await page.getByTestId('create-view').click();

  await expect(tabs.getByRole('tab')).toHaveCount(before + 1);
  await expect(page.getByTestId('board-column').first()).toBeVisible();

  // Every view lives in the one Type doc, which is what makes them views of
  // the same database.
  const yaml = () => page.evaluate(() => window.__cerebroMockFs.get('types/work-item.md') ?? '');
  await expect.poll(yaml, { timeout: 5_000 }).toContain('type: board');
  await expect.poll(yaml).toContain('type: table');

  // Going back to the first tab returns the TABLE — the board did not
  // overwrite it, which is exactly what the old pill row did.
  await tabs.getByRole('tab').first().click();
  await expect(page.getByTestId('table-view')).toBeVisible();
  await expect(page.getByTestId('board-column')).toHaveCount(0);
});
