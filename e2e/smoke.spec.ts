import { test, expect } from '@playwright/test';
import { boot, readMockFile } from './boot';

test('smoke: boot demo vault, list, board drag writes disk, rename, quick open', async ({
  page,
}) => {
  // -- Boot -----------------------------------------------------------
  await boot(page);

  // -- M12: records live on their type screens, and a type keeps saved
  // views like a List — layout switching goes through the active tab's menu.
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('table-view')).toBeVisible();

  const switchLayout = async (kind: string) => {
    await page.getByTestId('view-tabs').getByRole('tab').first().click();
    await page.getByText('Change layout…').click();
    await page.getByTestId(`view-switch-${kind}`).click();
  };

  // -- List view: grouped section headers visible ----------------------
  await switchLayout('list');
  const groupHeaders = page.getByTestId('list-group-header');
  await expect(groupHeaders.first()).toBeVisible();
  expect(await groupHeaders.count()).toBeGreaterThanOrEqual(1);

  // -- Switch to board via the tab menu --------------------------------
  await switchLayout('board');
  const columns = page.getByTestId('board-column');
  await expect(columns.first()).toBeVisible();
  expect(await columns.count()).toBeGreaterThanOrEqual(2);

  // -- Pick a source card and a different target column ----------------
  const sourceColumn = columns.filter({ has: page.getByTestId('board-card') }).first();
  const sourceKey = await sourceColumn.getAttribute('data-group-key');
  const card = sourceColumn.getByTestId('board-card').first();
  const cardPath = await card.getAttribute('data-path');
  const itemKey = (await card.getByTestId('card-key').innerText()).trim();
  const targetColumn = page
    .locator(`[data-testid="board-column"]:not([data-group-key="${sourceKey}"])`)
    .first();
  const targetKey = await targetColumn.getAttribute('data-group-key');
  if (!cardPath || !sourceKey || !targetKey) {
    throw new Error('board columns/cards are missing data attributes');
  }
  expect(targetKey).not.toBe(sourceKey);
  expect(itemKey.length).toBeGreaterThan(0);

  // -- Drag the card into the target column ----------------------------
  // PRIMARY APPROACH: raw pointer steps. dnd-kit's PointerSensor listens to
  // pointerdown/pointermove/pointerup. page.dragAndDrop() / locator.dragTo()
  // synthesize HTML5 drag events (dragstart/drop), which dnd-kit ignores —
  // they are NOT a working fallback for this board. If this sequence flakes
  // in CI, the fallback is tuning, not a different API: raise `steps`, add
  // `await page.waitForTimeout(100)` before mouse.up(), and drop onto the
  // target column's first card instead of the column body.
  const cardBox = await card.boundingBox();
  const targetBox = await targetColumn.boundingBox();
  if (!cardBox || !targetBox) throw new Error('missing drag geometry');
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  // Small first move clears dnd-kit's activation distance constraint.
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 12, cardBox.y + cardBox.height / 2 + 12, {
    steps: 4,
  });
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + Math.min(targetBox.height - 8, 160),
    { steps: 16 },
  );
  await page.mouse.up();

  // -- Card renders in the target column -------------------------------
  const movedCard = targetColumn.locator(`[data-testid="board-card"][data-path="${cardPath}"]`);
  await expect(movedCard).toBeVisible();

  // -- The mock filesystem was written (disk-first write) --------------
  await expect
    .poll(() => readMockFile(page, cardPath), { timeout: 5_000 })
    .toMatch(new RegExp(`status:\\s*['"]?${targetKey}['"]?`));

  // -- Detail panel: rename the title ----------------------------------
  // dnd-kit suppresses the click that immediately follows a drag on the
  // dragged element — retry the click until the panel opens.
  await expect(async () => {
    await movedCard.click();
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  const titleInput = page.getByTestId('detail-title');
  await expect(titleInput).toBeVisible();
  await titleInput.fill('Renamed by smoke');
  await titleInput.press('Enter'); // commits the rename (Task 22 wiring)
  await expect
    .poll(() => readMockFile(page, cardPath), { timeout: 5_000 })
    .toContain('# Renamed by smoke');
  await page.keyboard.press('Escape'); // close the detail panel

  // -- Quick open finds the item by key --------------------------------
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await expect(quickOpenInput).toBeVisible();
  await quickOpenInput.fill(itemKey);
  const results = page.getByTestId('quick-open-result');
  await expect(results.first()).toBeVisible();
  await expect(results.filter({ hasText: itemKey }).first()).toBeVisible();
});

// M2 Task 13 smoke v2: saved-view tabs, doc creation in a folder, BlockNote
// editing, and a full disk round trip. The plan's "reload persists" step is
// navigate-away-and-back here: the mock filesystem reseeds on page reload,
// so cross-reload persistence belongs to the tauri-dev shakeout. Coming
// back still exercises the whole chain — save → rescan → readNote → parse.
test('smoke v2: view tabs persist edits, page created in folder, BlockNote round trip', async ({
  page,
}) => {
  // -- Boot -------------------------------------------------------------
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    // Pin the theme (M16.39). These specs assert on rendered UI, and an unset
    // themeMode resolves 'system' — so a dark display would flip every colour
    // out from under them. The app has two palettes now; the specs assume one.
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) {
    await demoButton.click();
  }
  // -- M47.6: a database is created from a Collection's + ----------------
  // This used to create a LIST here. M47 retired that lane: a saved view
  // belongs to the database it queries, so the `+` offers a page or a
  // database and nothing authors a `*.list.yml` any more.
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
  const deliveryRow = page
    .getByTestId('collection-node-collection')
    .filter({ hasText: 'Delivery' });
  await expect(deliveryRow).toBeVisible();
  await deliveryRow.hover();
  await page.getByRole('button', { name: 'Add to Delivery' }).click();
  await expect(page.getByRole('menuitem', { name: 'New list' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'New database' }).click();

  // Lands on the new database. Its Type doc is the file that holds the schema
  // AND the saved views — the two things a List file used to hold separately.
  const typeDocPath = 'types/untitled-database.md';
  await expect
    .poll(() => readMockFile(page, typeDocPath), { timeout: 5_000 })
    .toContain('type: Type');

  // -- The tab row owns layout; changing it persists to the Type doc ------
  await page.getByTestId('view-tabs').getByRole('tab').first().click();
  await page.getByText('Change layout…').click();
  await page.getByTestId('view-switch-board').click();
  // The ROOT, not a column: a database with no records yet groups into no
  // buckets, so `board-column` would assert on the rows rather than on the
  // layout the tab row just changed.
  await expect(page.getByTestId('board-view')).toBeVisible();
  await expect
    .poll(() => readMockFile(page, typeDocPath), { timeout: 5_000 })
    .toContain('type: board');

  // -- Pages: new folder, new page inside it (the standing tree, M38.3) ----
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByPlaceholder('Folder name').fill('Notes');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  // exact: Playwright's `name` is a case-insensitive SUBSTRING by default, so
  // 'notes' also matched this row's "New page in Notes" and "Options for
  // Notes" once M15 stopped gating those on hover — three matches, strict-mode
  // violation. The row actions are in the DOM now whether or not you hover.
  const notesFolder = page.getByRole('button', { name: 'Notes', exact: true });
  await expect(notesFolder).toBeVisible();
  await notesFolder.hover();
  await page.getByRole('button', { name: 'New page in Notes', exact: true }).click();
  await page.getByPlaceholder('Page name').fill('Smoke Notes');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // -- Lands on the doc page with the typed-capitalization H1 -------------
  await expect(page.getByTestId('doc-title')).toHaveText('Smoke Notes');
  const editor = page.locator('[data-testid="markdown-editor"] .bn-editor');
  await expect(editor).toBeVisible({ timeout: 10_000 });

  // The file on disk is clean markdown — H1 only, no frontmatter.
  const docPath = await page.evaluate(() =>
    [...window.__cerebroMockFs.keys()].find((k) => k.endsWith('notes/smoke-notes.md')),
  );
  if (!docPath) throw new Error('created page missing from mock fs');
  expect(await readMockFile(page, docPath)).toBe('# Smoke Notes\n');

  // -- Edit in BlockNote: new paragraph under the heading ------------------
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Written by the smoke test.');
  await expect
    .poll(() => readMockFile(page, docPath), { timeout: 5_000 })
    .toContain('Written by the smoke test.');

  // -- Navigate away and back through the Pages tree (disk round trip) -----
  await page.getByRole('button', { name: 'Home' }).click();
  // The Notes folder was expanded during creation and expansion persists, so
  // the new page's row is already in the standing tree.
  const recent = page
    .getByTestId('file-tree')
    .getByRole('button', { name: 'Smoke Notes', exact: true });
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Smoke Notes');
  await expect(
    page.locator('[data-testid="markdown-editor"]').getByText('Written by the smoke test.'),
  ).toBeVisible({ timeout: 10_000 });
});
