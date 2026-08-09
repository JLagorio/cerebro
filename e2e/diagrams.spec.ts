import { test, expect } from '@playwright/test';

// M29.8: the golden-corpus mermaid doc renders on the real editor surface in
// real Chromium — all four fences (flowchart, sequence, gantt, and an
// ELK-layout flowchart, the last proving the lazy elk chunk actually loads) —
// and the lightbox opens, zooms, and closes.
test('mermaid renders in docs, and the lightbox zooms', async ({ page }) => {
  // A cold run downloads mermaid (~1MB) and then the lazy ELK chunk mid-test;
  // the per-assertion budgets below (10s boot + 2×20s diagram waits) can sum
  // past the global 30s test timeout and fail with a confusing outer timeout.
  test.setTimeout(60_000);

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
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });

  // -- Open the corpus doc through quick open ---------------------------
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await expect(quickOpenInput).toBeVisible();
  await quickOpenInput.fill('Systems map');
  const result = page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');

  // -- All four fences render as diagrams -------------------------------
  // The doc opens in the BlockNote editor, where each fence is a
  // mermaid-block whose view mode hosts the shared MermaidDiagram. The
  // fourth asks for `layout: elk`, so its svg appearing proves mermaid
  // fetched and ran the lazy ELK chunk.
  // `svg[id^=...]` targets mermaid's own output — a bare `svg` also matches
  // the Expand button's icon and trips strict mode.
  const diagrams = page.getByTestId('mermaid-diagram');
  await expect(diagrams).toHaveCount(4, { timeout: 20_000 });
  await expect(diagrams.first().locator('svg[id^="cerebro-mermaid-"]')).toBeVisible();
  await expect(diagrams.nth(3).locator('svg[id^="cerebro-mermaid-"]')).toBeVisible({
    timeout: 20_000,
  });
  // None fell back to the error card.
  await expect(page.getByTestId('mermaid-error')).toHaveCount(0);

  // -- Lightbox: expand the first diagram, zoom, readout moves ----------
  await diagrams.first().hover();
  await page.getByRole('button', { name: 'Expand diagram' }).first().click();
  await expect(page.getByTestId('lightbox-canvas').locator('svg')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toContainText('110%');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lightbox-canvas')).toHaveCount(0);
});

// M29.13: the authoring loop in real Chromium — insert a fresh block via the
// slash menu, pick a template from the grid, watch the live preview render,
// break the source and get a lined error while the last good preview stays,
// fix it, and commit with Done.
test('authoring: template, live preview, error banner, commit', async ({ page }) => {
  // Same chunk-load headroom as the render test above.
  test.setTimeout(60_000);

  // -- Boot (same as above) ---------------------------------------------
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) {
    await demoButton.click();
  }
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });

  // -- Open the corpus doc through quick open ---------------------------
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await expect(quickOpenInput).toBeVisible();
  await quickOpenInput.fill('Systems map');
  const result = page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  // Wait for the existing diagrams so the editor is fully hydrated before
  // we start typing into it.
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 20_000 });

  // -- Insert a fresh mermaid block via the slash menu ------------------
  // The doc's last CONTENT block is a mermaid fence (contentEditable=false),
  // but BlockNote's trailing-block plugin keeps an empty paragraph after it —
  // click that to get a caret at the end of the doc. (Keyboard journeys like
  // End/⌘End don't move the caret in mac Chromium contenteditable, so a
  // click is the portable way to place it.)
  await page.locator('.bn-editor [data-content-type="paragraph"]').last().click();
  await page.keyboard.type('/mermaid');
  // 'Mermaid diagram' is the slash item's title in MarkdownEditor.tsx.
  await page.getByText('Mermaid diagram', { exact: true }).click();

  // -- Template grid → Flowchart → live preview appears -----------------
  // A freshly inserted block has empty code, so it opens on the grid (M29.11).
  const grid = page.getByTestId('mermaid-template-grid');
  await grid.waitFor();
  await grid.getByRole('button', { name: 'Flowchart', exact: true }).click();
  const livePreview = page.getByTestId('mermaid-live-preview');
  await expect(livePreview.locator('svg[id^="cerebro-mermaid-"]')).toBeVisible({
    timeout: 15_000,
  });

  // -- Break it → lined error, previous preview retained ----------------
  const source = page.getByLabel('Mermaid source');
  await source.fill('flowchart TD\n  A --?>> B');
  await expect(page.getByTestId('mermaid-edit-error')).toBeVisible({ timeout: 15_000 });
  await expect(livePreview.locator('svg[id^="cerebro-mermaid-"]')).toBeVisible();

  // -- Fix → banner clears → Done → block shows the committed diagram ---
  await source.fill('flowchart TD\n  A[Emerald] --> B[Quartz]');
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // The committed block leaves edit mode and renders through the normal
  // view path. The node labels appear nowhere else in the corpus doc (and
  // hasText is a case-insensitive substring — 'One' would match 'Done' and
  // 'Milestone'), so the filter pins the new diagram regardless of where it
  // sits in the doc.
  const committed = page.getByTestId('mermaid-diagram').filter({ hasText: 'Emerald' });
  await expect(committed.locator('svg[id^="cerebro-mermaid-"]')).toBeVisible({ timeout: 15_000 });
});
