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

  // -- Template grid → Flowchart → visual editor, then over to code ------
  // A freshly inserted block has empty code, so it opens on the grid (M29.11).
  // Since Stage C a flowchart template enters the VISUAL editor first
  // (entryMode in MermaidBlockView.tsx); the Stage-B code loop this test
  // exercises lives behind 'Show code'.
  const grid = page.getByTestId('mermaid-template-grid');
  await grid.waitFor();
  await grid.getByRole('button', { name: 'Flowchart', exact: true }).click();
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Show code' }).click();
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

// M29.19: the structural editor round-trips — a double-click rename on the
// rendered svg becomes a surgical text edit (Idea[Spark], id untouched), shows
// up verbatim in code view, lands on the (mock) disk through the debounced
// autosave, and cmd+z through BlockNote history restores the old label in the
// visual view.
test('structural editing round-trips to the file', async ({ page }) => {
  // Same chunk-load headroom as the tests above.
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
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 20_000 });

  // -- Enter visual editing on the first (flowchart) block ---------------
  // Edit on a flowchart opens VISUAL mode first (entryMode in
  // MermaidBlockView.tsx); the structural editor renders mermaid's svg into
  // the structural-host and binds it.
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Rename "Idea" by double-clicking its node -------------------------
  // Mermaid's group id embeds the node ID, namespaced under the render id
  // (cerebro-mermaid-N-flowchart-Idea-C), and node IDs never change on
  // rename — only the label text does. `id*=` because of that prefix.
  await page.locator('[id*="flowchart-Idea-"]').dblclick();
  const labelInput = page.getByLabel('Node label');
  await labelInput.fill('Spark');
  await labelInput.press('Enter');
  await expect(host).toContainText('Spark', { timeout: 15_000 });

  // -- The code view shows the surgical edit -----------------------------
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(page.getByLabel('Mermaid source')).toHaveValue(/Idea\[Spark\]/);

  // -- And the mock fs eventually holds it (autosave is debounced) -------
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')), {
      timeout: 15_000,
    })
    .toContain('Idea[Spark]');

  // -- Undo restores the previous label in the visual view ---------------
  // Visual ops commit through onChangeCode — the same channel typing uses —
  // so BlockNote history holds one step per op and cmd+z reverses it. The
  // keystroke must reach the BlockNote editor, so put focus in a paragraph
  // first; the block's editing state survives the click (only Escape/Done
  // close it), and the structural editor renders the `code` prop live, so
  // the restored label appears without leaving visual mode.
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });
  await page.locator('.bn-editor [data-content-type="paragraph"]').first().click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(host).toContainText('Idea', { timeout: 15_000 });
});

// M29.21–.23: a standalone .mmd opens as a full diagram page, and edits
// round-trip RAW — the file's leading `---` block is mermaid config, and it
// must still be the first bytes on (mock) disk after the debounced autosave.
test('a .mmd file opens as a diagram page and edits round-trip raw', async ({ page }) => {
  // Same chunk-load headroom as the tests above (the seed pins ELK layout,
  // so this render fetches the lazy elk chunk too).
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

  // -- Open the seeded diagram through quick open ------------------------
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await expect(quickOpenInput).toBeVisible();
  await quickOpenInput.fill('Pipeline');
  const result = page.getByTestId('quick-open-result').filter({ hasText: 'Pipeline' }).first();
  await expect(result).toBeVisible();
  // Quick Open labels the row as a Diagram, not a Note (M29.21).
  await expect(result).toContainText('Diagram');
  await result.click();

  // -- The page IS an editor: a flowchart opens in the structural editor --
  await expect(page.getByTestId('diagram-page')).toBeVisible();
  await expect(page.getByTestId('diagram-title')).toHaveText('Pipeline');
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 20_000 });

  // -- Edit through the code pane and let the autosave settle -------------
  await page.getByRole('button', { name: 'Show code' }).click();
  const source = page.getByLabel('Mermaid source');
  // The whole file is in the textarea, mermaid header included.
  await expect(source).toHaveValue(/^---\nconfig:/);
  const current = await source.inputValue();
  await source.fill(`${current}  D --> E[Ship]\n`);
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('diagrams/pipeline.mmd')), {
      timeout: 15_000,
    })
    .toContain('E[Ship]');

  // -- The raw round-trip: the config header is still the first bytes -----
  const raw = await page.evaluate(() => window.__cerebroMockFs.get('diagrams/pipeline.mmd'));
  expect(raw?.startsWith('---\nconfig:\n  layout: elk\n---\n')).toBe(true);
});

// M29.24–.27: the .mmd page is now a full-screen canvas — pan/zoom viewport,
// zoom cluster, floating code overlay with Auto-Update and Apply — and the
// page's keyed debounced autosave still writes raw bytes underneath it all.
test('the diagram page is a pan/zoom canvas with a floating code overlay', async ({ page }) => {
  // 90s, not the file's usual 60s: this journey's per-assertion budgets sum to
  // ~85s, so a cold lazy-chunk run could blow the outer timeout and report that
  // instead of the assertion that actually stalled.
  test.setTimeout(90_000);

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

  // -- Open the seeded diagram through quick open ------------------------
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await expect(quickOpenInput).toBeVisible();
  await quickOpenInput.fill('Pipeline');
  const result = page.getByTestId('quick-open-result').filter({ hasText: 'Pipeline' }).first();
  await expect(result).toBeVisible();
  // Quick Open labels the row as a Diagram, not a Note (M29.21).
  await expect(result).toContainText('Diagram');
  await result.click();

  // -- Canvas up, sidebar gone (SIDEBARLESS) -----------------------------
  await expect(page.getByTestId('diagram-page')).toBeVisible();
  const viewport = page.getByTestId('canvas-viewport');
  await expect(viewport).toBeVisible();
  await expect(page.getByTestId('sidebar-type')).toHaveCount(0);
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 20_000 });

  // -- Wheel zoom moves the readout --------------------------------------
  // Pin 100% first: initialFit may have landed on any scale.
  const readout = page.getByRole('button', { name: 'Reset zoom' });
  await readout.click();
  await expect(readout).toContainText('100%');
  await viewport.hover();
  await page.mouse.wheel(0, -100);
  await expect(readout).toContainText('110%');

  // -- Overlay: Auto-Update streams edits onto the canvas ----------------
  // Strict-mode trap for whoever writes the next journey here: once the panel
  // is open, 'Hide code' is an AMBIGUOUS accessible name — the toolbar's text
  // toggle and the overlay's close IconButton both carry it. Clicking it needs
  // a scope, e.g. inside [data-testid="diagram-toolbar"]. ('Show code' is
  // unambiguous, which is why this line needs none.)
  await page.getByRole('button', { name: 'Show code' }).click();
  const overlay = page.getByTestId('code-overlay');
  await expect(overlay).toBeVisible();
  const source = page.getByLabel('Mermaid source');
  await expect(source).toHaveValue(/^---\nconfig:/);
  const current = await source.inputValue();
  await source.fill(`${current}  D --> Quill[Quill]\n`);
  await expect(host).toContainText('Quill', { timeout: 15_000 });
  // …and the page's raw autosave got it too (250ms overlay + 500ms save).
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('diagrams/pipeline.mmd')), {
      timeout: 15_000,
    })
    .toContain('Quill[Quill]');

  // -- Auto-Update OFF buffers until Apply -------------------------------
  await page.getByText('Auto-update').click(); // the Switch input is 0×0; its label text is the click target
  const buffered = await source.inputValue();
  await source.fill(`${buffered}  D --> Vega[Vega]\n`);
  // Bounded negative: give the (disabled) debounce room to have fired.
  await page.waitForTimeout(800);
  await expect(host).not.toContainText('Vega');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(host).toContainText('Vega', { timeout: 15_000 });
});

// M29.27: a doc block opens the SAME editor full screen in a Dialog layer,
// wired to the block's own code channel — a structural rename made there
// lands back in the block render and, through the doc's autosave, on disk.
test('a doc block opens full screen, and a rename flows back into the block', async ({ page }) => {
  // 90s for the same reason as the journey above — this one sums to ~105s.
  test.setTimeout(90_000);

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
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 20_000 });

  // -- Open the first (flowchart) block full screen ----------------------
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Open full screen' }).click();
  const editor = page.getByTestId('fullscreen-diagram-editor');
  await expect(editor).toBeVisible();
  // The structural editor is unique on the page (the block behind is a plain
  // render), so structural-host scopes every node locator below — a bare
  // [id*=…] would also match the block's svg and trip strict mode.
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Rename by double-click, same gesture as the inline editor ---------
  await host.locator('[id*="flowchart-Idea-"]').dblclick();
  const labelInput = page.getByLabel('Node label');
  await labelInput.fill('Quasar');
  await labelInput.press('Enter');
  await expect(host).toContainText('Quasar', { timeout: 15_000 });

  // -- Close the dialog; the block shows the rename ----------------------
  await page.locator('.cb-dlg').getByRole('button', { name: 'Close' }).click();
  await expect(editor).toHaveCount(0);
  await expect(block.getByTestId('mermaid-diagram')).toContainText('Quasar', { timeout: 15_000 });
  // The surgical edit reached the (mock) disk through the doc's autosave.
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')), {
      timeout: 15_000,
    })
    .toContain('Idea[Quasar]');
});
