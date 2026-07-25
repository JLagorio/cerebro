import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
  }
}

/** Read a file's full text (frontmatter + body) from the mock filesystem. */
async function readMockFile(page: Page, path: string): Promise<string> {
  const text = await page.evaluate((p) => window.__cerebroMockFs.get(p), path);
  if (text === undefined) throw new Error(`mock fs has no file at ${path}`);
  return text;
}

test('smoke: boot demo vault, list, board drag writes disk, rename, quick open', async ({ page }) => {
  // -- Boot -----------------------------------------------------------
  await page.goto('/');

  // With no persisted vault the first-launch chooser renders "Open demo
  // vault"; if the mock IPC restored a last vault it boots straight to the
  // shell. Handle both.
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarProjects = page.getByTestId('sidebar-project');
  await expect(demoButton.or(sidebarProjects.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) {
    await demoButton.click();
  }

  // -- Sidebar lists top-level projects (v2: no spaces) -----------------
  await expect(sidebarProjects.first()).toBeVisible({ timeout: 10_000 });
  expect(await sidebarProjects.count()).toBeGreaterThanOrEqual(1);

  // -- Open the first project -------------------------------------------
  await sidebarProjects.first().click();

  // -- List view: grouped section headers visible ----------------------
  const groupHeaders = page.getByTestId('list-group-header');
  await expect(groupHeaders.first()).toBeVisible();
  expect(await groupHeaders.count()).toBeGreaterThanOrEqual(1);

  // -- Switch to board via the toolbar ---------------------------------
  await page.getByTestId('view-switch-board').click();
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
  await page.mouse.move(
    cardBox.x + cardBox.width / 2 + 12,
    cardBox.y + cardBox.height / 2 + 12,
    { steps: 4 },
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + Math.min(targetBox.height - 8, 160),
    { steps: 16 },
  );
  await page.mouse.up();

  // -- Card renders in the target column -------------------------------
  const movedCard = targetColumn.locator(
    `[data-testid="board-card"][data-path="${cardPath}"]`,
  );
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
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarProjects = page.getByTestId('sidebar-project');
  await expect(demoButton.or(sidebarProjects.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) {
    await demoButton.click();
  }
  await expect(sidebarProjects.first()).toBeVisible({ timeout: 10_000 });
  await sidebarProjects.first().click();

  // -- Create a saved view from the tab row ------------------------------
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByPlaceholder('View name').fill('Smoke board');
  await page.getByRole('button', { name: 'Save' }).click();
  const smokeTab = page.getByRole('tab', { name: 'Smoke board' });
  await expect(smokeTab).toHaveAttribute('aria-selected', 'true');

  // Locate the view file on the mock disk (project dir derived from it).
  const findViewPath = () =>
    page.evaluate(() =>
      [...window.__cerebroMockFs.keys()].find((k) => k.endsWith('/views/smoke-board.yml')),
    );
  await expect.poll(findViewPath, { timeout: 5_000 }).toBeDefined();
  const viewPath = await findViewPath();
  if (!viewPath) throw new Error('smoke-board view file missing from mock fs');

  // -- Tab switching keeps working, toolbar edits auto-persist ------------
  await page.getByRole('tab', { name: 'Items' }).click();
  await smokeTab.click();
  await page.getByTestId('view-switch-board').click();
  await expect(page.getByTestId('board-column').first()).toBeVisible();
  await expect
    .poll(() => readMockFile(page, viewPath), { timeout: 5_000 })
    .toContain('type: board');

  // -- Pages tab: new folder, new page inside it --------------------------
  await page.getByRole('tab', { name: 'Pages' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByPlaceholder('Folder name').fill('Notes');
  await page.getByRole('button', { name: 'Create' }).click();
  const notesFolder = page.getByRole('button', { name: 'notes' });
  await expect(notesFolder).toBeVisible();
  await notesFolder.hover();
  await page.getByRole('button', { name: 'New page in notes' }).click();
  await page.getByPlaceholder('Page name').fill('Smoke Notes');
  await page.getByRole('button', { name: 'Create' }).click();

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

  // -- Navigate away and back through the Docs rail (disk round trip) -----
  await page.getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Docs' }).click();
  const recent = page
    .getByTestId('recent-doc')
    .filter({ hasText: 'Smoke Notes' })
    .first();
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Smoke Notes');
  await expect(
    page.locator('[data-testid="markdown-editor"]').getByText('Written by the smoke test.'),
  ).toBeVisible({ timeout: 10_000 });
});
