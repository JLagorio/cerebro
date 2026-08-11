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
  // RELATIVE, not '110%' (M29.53): the viewer opens on a fit now — it used to
  // open at "100%" that meant nothing in particular, since mermaid sizes its
  // svg to the container, so a wide gantt filled 17% of the viewer at "100%"
  // while the sequence diagram beside it was at natural size for the same
  // number. What this case is about is that the readout MOVES with the button.
  const readout = page.getByRole('button', { name: 'Reset zoom' });
  const before = Number((await readout.textContent())?.replace('%', ''));
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect
    .poll(async () => Number((await readout.textContent())?.replace('%', '')))
    .toBe(Math.round(before * 1.1));
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
  // This comment used to claim BlockNote's trailing-block plugin keeps an empty
  // paragraph after the doc's last (mermaid) block, so that `.last()` was the
  // caret at the end of the document. MEASURED, and false: on a fresh load the
  // plugin has not fired — its `apply` gates on `docChanged` and the mount-time
  // replaceBlocks is the one transaction it misses — so paragraphCount is 1 and
  // `.last()` resolves to the INTRO paragraph at block index 1 of 9. This spec
  // therefore inserts its new block in the MIDDLE of the document, not at the
  // end (M29.53). Left as it is deliberately: the journey it exercises is
  // insert-a-block-and-edit-it, which is just as true mid-document, and the
  // rewrite belongs with whoever owns the trailing-block question. What is
  // fixed here is the comment, which was documenting a mechanism that does not
  // exist. (Keyboard journeys like End/⌘End don't move the caret in mac
  // Chromium contenteditable, so a click is the portable way to place it.)
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

  // -- The dialog's own toolbar can insert a node WITH a shape (M29.39) --
  // This surface mounts StructuralEditor with toolbar={false}, so its controls
  // are DiagramToolbar's. `+ Shape` shipped on the inline block's toolbar first
  // and had to be lifted here; whether the button is reachable at all depends
  // on props this host passes (mode/model), which no component test sees.
  await page.getByRole('button', { name: '+ Shape' }).click();
  await page.getByLabel('Search shapes').fill('hexagon');
  await page.getByRole('button', { name: 'Shape: Hexagon' }).click();
  await expect(host).toContainText('New step', { timeout: 15_000 });

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
  const raw = await page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md'));
  expect(raw).toContain('n1{{New step}}');
});

// M29.29–.33: shapes, colors, and edge animation are surgical text edits that
// real mermaid accepts — the palette writes `@{ shape: … }`, the color menu a
// `style` line, and the animate toggle mints an edge id plus its meta line.
test('shapes, colors, and edge animation round-trip as surgical mermaid', async ({ page }) => {
  // 90s, like the two journeys above rather than the file's older 60s: this one
  // runs three full op → re-render → code → back-to-visual laps, so its
  // per-assertion budgets sum higher than anything else in this file and a cold
  // mermaid chunk would otherwise surface as a confusing outer timeout.
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

  // -- Enter visual editing on the first (flowchart) block ---------------
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // How this test proves REAL mermaid accepted an edit without reaching into
  // mermaid's private svg internals (which Stage C deliberately kept out of our
  // contract — svgBinding.ts binds by id scheme only): renderMermaid stamps
  // every successful render with a fresh `cerebro-mermaid-<seq>` id and caches
  // the result per source, so the id is a function of the CODE; StructuralEditor
  // writes the svg into the host ONLY on success (`if (!r.ok) return` — it holds
  // the last good render otherwise). A changed host svg id therefore means
  // mermaid parsed and drew the edited source; an unchanged one means it refused.
  const hostSvgId = () => host.locator('svg[id^="cerebro-mermaid-"]').getAttribute('id');

  // -- Exotic shape: Idea becomes a cloud through the palette -------------
  const beforeShape = await hostSvgId();
  await host.locator('[id*="flowchart-Idea-"]').first().click();
  await page.getByRole('button', { name: 'Change shape' }).click();
  await page.getByLabel('Search shapes').fill('cloud');
  await page.getByRole('button', { name: 'Shape: Cloud' }).click();
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeShape);

  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(page.getByLabel('Mermaid source')).toHaveValue(/Idea@\{ shape: cloud \}/);
  // The error banner lives in the CODE pane only — `mermaid-edit-error` belongs
  // to LivePreview (MermaidBlockView.tsx), which the visual pane never mounts —
  // so a count-0 check taken in visual mode is vacuously true and proves
  // nothing. Here it is real: the preview renders the same source through the
  // same renderer, so a visible preview svg with no banner is mermaid saying
  // yes to `@{ shape: cloud }`.
  await expect(
    page.getByTestId('mermaid-live-preview').locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Fill color: a style line appears and mermaid still renders ---------
  const beforeStyle = await hostSvgId();
  await host.locator('[id*="flowchart-Idea-"]').first().click();
  await page.getByRole('button', { name: 'Node colors' }).click();
  await page.getByRole('button', { name: 'Fill #eef1fe' }).click();
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeStyle);

  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(page.getByLabel('Mermaid source')).toHaveValue(/style Idea fill:#eef1fe/);
  await expect(
    page.getByTestId('mermaid-live-preview').locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Edge animate: the edge gains an id and its meta line ---------------
  // `path[id*=…]`: the render id prefixes mermaid's own `L_<from>_<to>_<n>`
  // (svgBinding.ts), and pinning the element to a path keeps the edge's label
  // group out of the match.
  const beforeAnimate = await hostSvgId();
  const edge = host.locator('path[id*="L_Idea_Build"]').first();
  // locator.click() cannot be used here, and not because of anything the app
  // does: Idea sits directly above Build, so mermaid draws a PERFECTLY VERTICAL
  // path (`d="M54.219,61.921L54.219,…"`). Playwright's visibility predicate is
  // `width > 0 && height > 0` over the element's IN-PAGE getBoundingClientRect,
  // which for a dead-vertical path is 0 wide — so the locator is "not visible"
  // and click() times out. (Note this is a DIFFERENT box from Playwright's own
  // boundingBox(), which uses the CDP box model and reports ~11px here because
  // it includes the arrowhead marker's ink.) A human clicks this edge fine —
  // the browser hit-tests the 2px stroke, not the box.
  //
  // So drive the real mouse at the centreline instead: still a fully hit-tested
  // click (unlike `force: true`, which would skip the very check that proves
  // the edge is reachable), just aimed by geometry we read ourselves rather
  // than by an undocumented interaction between two different box definitions.
  // scrollIntoViewIfNeeded first: page.mouse takes raw viewport coordinates and
  // will NOT auto-scroll the way locator.click() does.
  await host.scrollIntoViewIfNeeded();
  const edgeRect = await edge.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, height: r.height };
  });
  // x IS the centreline for a vertical path; midpoint down its height.
  await page.mouse.click(edgeRect.x, edgeRect.y + edgeRect.height / 2);
  // Confirm the edge editor actually opened before touching its controls.
  await expect(page.getByLabel('Edge label')).toBeVisible();
  await page.getByRole('button', { name: 'Animate edge' }).click();
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeAnimate);

  await page.getByRole('button', { name: 'Show code' }).click();
  const source = page.getByLabel('Mermaid source');
  await expect(source).toHaveValue(/Idea\[Idea\] e1@--> Build\[Build\]/);
  await expect(source).toHaveValue(/e1@\{ animate: true \}/);
  await expect(
    page.getByTestId('mermaid-live-preview').locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);

  // -- And the mock fs eventually holds all three edits -------------------
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')), {
      timeout: 15_000,
    })
    .toContain('e1@{ animate: true }');
  const raw = await page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md'));
  expect(raw).toContain('Idea@{ shape: cloud }');
  expect(raw).toContain('style Idea fill:#eef1fe');
});

// M29.35–.39: Stage F end to end — a shift-click selection becomes a real
// subgraph, a node takes a lucide icon that real mermaid draws, and a node
// bound to a vault record grows a badge that opens that record's panel. Every
// step is checked twice: the canvas re-rendered (so mermaid ACCEPTED the
// edit), and the source says what we meant to write.
test('stage F: group, icon, and record link, end to end', async ({ page }) => {
  // 120s rather than the file's 90s: this journey runs four op → re-render →
  // code → back-to-visual laps, one more than any other test here, and a cold
  // mermaid chunk plus the lazy lucide icon pack would otherwise surface as an
  // outer timeout instead of the assertion that actually stalled.
  test.setTimeout(120_000);

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
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });
  // The same proof-of-acceptance device the shapes/colors journey above
  // documents: the host svg's id is a function of the SOURCE, and the editor
  // only writes a new svg on a successful render — so a changed id means real
  // mermaid parsed and drew the edited text.
  const hostSvgId = () => host.locator('svg[id^="cerebro-mermaid-"]').getAttribute('id');
  const source = page.getByLabel('Mermaid source');

  // -- Shift-click two nodes, group them into a subgraph -----------------
  // Pinned by node id, never by `g.node` nth: DOM order is mermaid's business,
  // not a contract. Review and Done are joined by exactly one edge line, so the
  // wrap is contiguous and `createSubgraph` moves nothing.
  const beforeGroup = await hostSvgId();
  await host
    .locator('[id*="flowchart-Review-"]')
    .first()
    .click({ modifiers: ['Shift'] });
  await host
    .locator('[id*="flowchart-Done-"]')
    .first()
    .click({ modifiers: ['Shift'] });
  await page.getByLabel('New subgraph title').fill('Grouped');
  await page.getByRole('button', { name: 'Group into subgraph' }).click();
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeGroup);

  await page.getByRole('button', { name: 'Show code' }).click();
  // toHaveValue, not toContainText: the source pane is a <textarea>, whose
  // textContent is its DEFAULT value — an assertion on it would pass or fail
  // for reasons unrelated to what the user is looking at.
  await expect(source).toHaveValue(/subgraph Grouped\[Grouped\]/);
  await expect(source).toHaveValue(/\n\s*end\b/);
  await expect(
    page.getByTestId('mermaid-live-preview').locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Insert a node with a shape, in one gesture ------------------------
  const beforeInsert = await hostSvgId();
  await page.getByRole('button', { name: '+ Shape' }).click();
  await page.getByLabel('Search shapes').fill('hexagon');
  await page.getByRole('button', { name: 'Shape: Hexagon' }).click();
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeInsert);
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(source).toHaveValue(/n1\{\{New step\}\}/);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Put a lucide icon on Idea -----------------------------------------
  const beforeIcon = await hostSvgId();
  await host.locator('[id*="flowchart-Idea-"]').first().click();
  await page.getByRole('button', { name: 'Node icon' }).click();
  await page.getByLabel('Search icons').fill('rocket');
  await page.getByRole('button', { name: 'Icon rocket' }).click();
  // The render changed, so mermaid accepted `@{ icon: … }`. Whether the glyph
  // itself won its race with the lazy pack fetch is not this test's business —
  // an unresolved icon draws mermaid's own placeholder box, which is still a
  // successful render (measured, icons.mermaid.test.ts).
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeIcon);
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(source).toHaveValue(/Idea@\{ icon: "lucide:rocket"/);
  await expect(
    page.getByTestId('mermaid-live-preview').locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mermaid-edit-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Bind Idea to a vault record, and follow the badge ------------------
  // 'Ana Rios' is a Person record in the demo corpus (people/ana-rios.md), and
  // a Person is a record, so `useOpenPath('in-place')` opens the detail panel
  // rather than the doc canvas. The full title, not a stem: 'ana' is also a
  // substring of 'Dana Fox'.
  const beforeLink = await hostSvgId();
  await host.locator('[id*="flowchart-Idea-"]').first().click();
  await page.getByRole('button', { name: 'Node link' }).click();
  await page.getByLabel('Link target').fill('Ana Rios');
  await page.getByRole('button', { name: 'Link to Ana Rios' }).click();
  await expect.poll(hostSvgId, { timeout: 15_000 }).not.toBe(beforeLink);

  const badge = page.getByTestId('mermaid-link-badge').first();
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await badge.click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();

  // -- All four edits reached the (mock) disk through the doc's autosave --
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')), {
      timeout: 15_000,
    })
    .toContain('click Idea "people/ana-rios.md"');
  const raw2 = await page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md'));
  expect(raw2).toContain('subgraph Grouped[Grouped]');
  expect(raw2).toContain('n1{{New step}}');
  expect(raw2).toContain('Idea@{ icon: "lucide:rocket"');
});

// M29.44: Stage G end to end — auto-layout off, a real drag, and the whole
// round trip. The loop under test is toggle -> drag -> FILE -> reopen ->
// toggle back, and every leg is checked twice: real mermaid re-rendered (the
// host svg id is a function of the source, so a new id means mermaid parsed
// and drew our comment lines), and the bytes on the (mock) disk say what the
// gesture meant. The last leg is the one worth the most: toggling auto-layout
// back ON must RETAIN the stored positions in the file while no longer
// applying them to the geometry (spec D7) — "forgotten" and "handed back to
// mermaid" look identical on screen and are opposites in the file.
test('manual layout: a drag writes positions, they survive a reopen, auto returns', async ({
  page,
}) => {
  // 120s like the Stage F journey: this one runs four render laps (toggle,
  // drag, reopen, toggle back) plus two document navigations, and a cold
  // mermaid chunk would otherwise surface as an outer timeout instead of the
  // assertion that actually stalled.
  test.setTimeout(120_000);

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

  const openDoc = async (name: string) => {
    await page.keyboard.press('ControlOrMeta+k');
    const quickOpenInput = page.getByTestId('quick-open-input');
    await expect(quickOpenInput).toBeVisible();
    await quickOpenInput.fill(name);
    const row = page.getByTestId('quick-open-result').filter({ hasText: name }).first();
    await expect(row).toBeVisible();
    await row.click();
  };
  const readFile = () =>
    page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md') ?? '');

  await openDoc('Systems map');
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 20_000 });

  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 20_000 });
  // Same proof-of-acceptance device the two journeys above document.
  const hostSvgId = () => host.locator('svg[id^="cerebro-mermaid-"]').getAttribute('id');
  const build = host.locator('[id*="flowchart-Build-"]').first();
  // Two translates, whitespace-tolerant: ours is APPENDED to mermaid's own
  // (`${base} translate(dx, dy)` in manualLayout.ts), so the pair is the
  // signature of "our pipeline touched this node". One translate is mermaid's
  // untouched positionNode output. MEASURED on the corpus flowchart:
  // auto is `translate(54.21875, 132.25)`; after the drag below it is
  // `translate(54.21875, 132.25) translate(119.78, 59.75)`.
  const OURS = /translate\([^)]*\)\s*translate\(/;
  const MERMAIDS_ALONE = /^\s*translate\([^)]*\)\s*$/;
  // Sums a `translate(a, b) translate(c, d)` chain back into one plane point:
  // mermaid's own translate IS the node centre (nodes.ts:97) and ours is the
  // delta onto the stored position, so the sum must BE the stored position.
  const planeCentre = async (locator: typeof build) => {
    const t = (await locator.getAttribute('transform')) ?? '';
    const parts = [...t.matchAll(/translate\(\s*(-?[\d.]+)\s*,?\s*(-?[\d.]+)\s*\)/g)];
    return parts.reduce((acc, m) => ({ x: acc.x + Number(m[1]), y: acc.y + Number(m[2]) }), {
      x: 0,
      y: 0,
    });
  };

  // -- Auto-layout OFF: the marker reaches the file, mermaid still draws ---
  const autoCentre = await planeCentre(build);
  await expect(build).toHaveAttribute('transform', MERMAIDS_ALONE);
  const beforeManual = await hostSvgId();
  await page.getByRole('button', { name: 'Auto-layout: On' }).click();
  await expect.poll(hostSvgId, { timeout: 20_000 }).not.toBe(beforeManual);
  // The control shows the state it is now IN, not the command it would run.
  await expect(page.getByRole('button', { name: 'Auto-layout: Off' })).toBeVisible();
  await expect.poll(readFile, { timeout: 15_000 }).toContain('%% cerebro:layout manual');
  // Turning it on pins NOTHING by itself: positions are recorded by dragging,
  // not by a mode switch (risk-ledger item 6 — no snapshot-everything).
  expect(await readFile()).not.toContain('%% cerebro:pos');

  // -- Under the threshold it is still a click, not a move ----------------
  // 2px of hand tremor must leave the file alone, or select and double-click
  // rename would each cost an undo step (MOVE_THRESHOLD_PX = 3).
  const box = (await build.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 2, cy);
  await page.mouse.up();
  // Bounded negative: give the autosave debounce room to have fired.
  await page.waitForTimeout(1_000);
  expect(await readFile()).not.toContain('%% cerebro:pos');

  // -- Drag Build 120 right and 60 down -----------------------------------
  // page.mouse, not locator.dragTo: the gesture under test has a 3px
  // click/drag threshold and re-routes edges per frame, so it needs real
  // intermediate moves rather than one synthetic jump.
  const beforeDrag = await hostSvgId();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(cx + (120 * step) / 8, cy + (60 * step) / 8);
  }
  await page.mouse.up();
  // A new svg id = real mermaid parsed and drew a source carrying BOTH our
  // comment lines. (A `%% cerebro:pos` line mermaid choked on would leave the
  // last good render in the host and this poll would time out.)
  await expect.poll(hostSvgId, { timeout: 20_000 }).not.toBe(beforeDrag);

  // -- The drag is in the FILE, as one line, with real coordinates --------
  await expect.poll(readFile, { timeout: 15_000 }).toMatch(/%% cerebro:pos\s+Build\s+-?\d+,-?\d+/);
  const raw = await readFile();
  const stored = raw.match(/%% cerebro:pos\s+Build\s+(-?\d+),(-?\d+)/)!;
  const pos = { x: Number(stored[1]), y: Number(stored[2]) };
  // The distance travelled reached the file — not merely "a line appeared".
  // Plane units, so a diagram rendered below 1:1 stores MORE than the client
  // pixels dragged, never fewer; the bounds are one-sided for that reason.
  // (MEASURED at the corpus's 1:1 scale: `%% cerebro:pos Build 174,192` from
  // an auto centre of 54.22,132.25 — exactly the 120,60 dragged.)
  expect(pos.x - autoCentre.x).toBeGreaterThanOrEqual(100);
  expect(pos.y - autoCentre.y).toBeGreaterThanOrEqual(50);
  // One drag, one line, one node: the sibling nodes were not swept along.
  expect(raw.match(/%% cerebro:pos/g)).toHaveLength(1);
  expect(raw).not.toMatch(/%% cerebro:pos[^\n]*\bIdea\b/);

  // -- Reopen: view mode renders the STORED position ----------------------
  // Not page.reload(): that resets the in-memory mock fs, so the fake disk
  // would forget the drag along with everything else. Closing and reopening
  // the document is a fresh read of the persisting mock disk through the full
  // parse -> render -> apply pipeline in VIEW mode (MermaidDiagram), which is
  // the code path a real reload exercises.
  await openDoc('Welcome');
  await openDoc('Systems map');
  const viewBuild = page
    .getByTestId('mermaid-diagram')
    .first()
    .locator('[id*="flowchart-Build-"]')
    .first();
  await expect(viewBuild).toHaveAttribute('transform', OURS, { timeout: 20_000 });
  // …and not just SOME delta: the two translates sum to the coordinates on
  // disk, so what the file says is where the node is.
  const viewCentre = await planeCentre(viewBuild);
  expect(Math.abs(viewCentre.x - pos.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewCentre.y - pos.y)).toBeLessThanOrEqual(1);

  // -- Auto-layout back ON: marker gone, positions RETAINED, geometry back -
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 20_000 });
  await expect(build).toHaveAttribute('transform', OURS, { timeout: 20_000 });
  const beforeAuto = await hostSvgId();
  await page.getByRole('button', { name: 'Auto-layout: Off' }).click();
  await expect.poll(hostSvgId, { timeout: 20_000 }).not.toBe(beforeAuto);
  await expect(page.getByRole('button', { name: 'Auto-layout: On' })).toBeVisible();
  await expect.poll(readFile, { timeout: 15_000 }).not.toContain('%% cerebro:layout manual');
  // The whole point of the OFF path: remembered, not erased. The line is still
  // there, byte for byte, waiting for the next time manual mode comes on.
  const afterAuto = await readFile();
  expect(afterAuto).toContain(`%% cerebro:pos Build ${pos.x},${pos.y}`);
  // Remembered but no longer APPLIED: mermaid's own single translate is back,
  // which is what "geometry handed back to the engine" looks like in the DOM.
  await expect(build).toHaveAttribute('transform', MERMAIDS_ALONE, { timeout: 20_000 });
});

/**
 * The chrome on a ZOOMED canvas (M29.51) — every case here was live, and none
 * of them was reachable from jsdom.
 *
 * Three defects with one cause and one that shares its blast radius:
 *
 * 1. The edge editor, the group bar and the rename box centre with
 *    `absolute left-1/2`, which inside `canvas-plane` means half the PLANE's
 *    width — then scaled and translated. At the 218% this page opened at they
 *    all sat several hundred pixels past the right-hand edge.
 * 2. Each of them holds an autofocused control, so the browser scrolled the
 *    `overflow-hidden` viewport across to reveal it. Pan and zoom write the
 *    plane's TRANSFORM, so no control could undo that scroll: one double-click
 *    on a node and the diagram left, with Fit and Reset both powerless.
 * 3. Everything else in the overlay layer zoomed WITH the diagram — the node
 *    toolbar drew 74px tall with 46px buttons at 218% and 21px tall with 13px
 *    ones at 63%.
 * 4. The four node popovers reached `Popover` with sizing classes only. That
 *    component contributes `cb-menu-in`, which is an animation; every other
 *    caller in the repo brings its own panel. These four brought none, so they
 *    rendered fully transparent over the diagram.
 *
 * jsdom sees none of it: `useCanvasScale()` is 1 and `useCanvasOverlayHost()`
 * is null in every component test, `getBoundingClientRect` is all zeros, and no
 * stylesheet is applied. Only a real browser at a real zoom can fail these.
 */
test('M29.51: the editor chrome survives a zoom, and a rename keeps the diagram', async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Pipeline');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Pipeline' }).first().click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 30_000 });

  // -- A canvas opens at its natural size, never blown up to fill -----------
  // `fit` is allowed to enlarge only when the user asks for it by hand. The
  // initial pass caps at 100%, which is what stopped a fresh whiteboard opening
  // at MAX_SCALE and minting its first node four times life size.
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('100%');

  const viewport = page.getByTestId('canvas-viewport');
  const scrollOf = () => viewport.evaluate((e) => e.scrollLeft + e.scrollTop);
  const svgLeft = () =>
    host.locator('svg[id^="cerebro-mermaid-"]').evaluate((s) => s.getBoundingClientRect().left);

  // Zoom past 200%, where every one of these defects was live.
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = Number(
    (await page.getByRole('button', { name: 'Reset zoom' }).textContent())!.replace('%', ''),
  );
  expect(zoomed).toBeGreaterThan(200);
  const restingLeft = await svgLeft();

  // -- Rename: the box is on screen and the diagram has not moved -----------
  // Whichever node the zoom left CLEAR of the toolbar — at 214% a four-node
  // chain is taller than the viewport, and which end sticks out is layout's
  // business, not this test's. Asking for `.first()` pinned the assertion to
  // geometry the test does not control.
  const clearNode = async () => {
    const boxes = await host.locator('g.node').evaluateAll((els) =>
      els.map((e, i) => {
        const r = e.getBoundingClientRect();
        return { i, top: r.top, bottom: r.bottom };
      }),
    );
    const vb = (await viewport.boundingBox())!;
    const hit = boxes.find((b) => b.top > vb.y + 8 && b.bottom < vb.y + vb.height - 8);
    if (hit === undefined) throw new Error('no node fully inside the viewport at this zoom');
    return host.locator('g.node').nth(hit.i);
  };
  const node = await clearNode();
  await node.dblclick();
  const rename = page.getByLabel('Node label');
  await expect(rename).toBeVisible();
  // Inside the viewport but NOT inside the plane — the only placement that is
  // both centred on the screen and immune to the transform.
  expect(await viewport.locator('[aria-label="Node label"]').count()).toBe(1);
  expect(await page.getByTestId('canvas-plane').locator('[aria-label="Node label"]').count()).toBe(
    0,
  );
  expect(await scrollOf()).toBe(0);
  expect(await svgLeft()).toBeCloseTo(restingLeft, 0);
  await page.keyboard.press('Escape');

  // -- The node toolbar is a 34px control at 200%+, not a 74px one ----------
  await node.click();
  const toolbar = page.getByTestId('mermaid-node-toolbar');
  await expect(toolbar).toBeVisible();
  const toolbarH = await toolbar.evaluate((e) => e.getBoundingClientRect().height);
  expect(toolbarH).toBeLessThan(44);

  // -- The popovers are opaque panels, not floating glyphs ------------------
  // Fill and border together: a panel with a shadow but no background still
  // shows the diagram straight through it, which is what shipped.
  for (const label of ['Change shape', 'Node colors', 'Node icon', 'Node link']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const panel = page.locator('.cb-menu-in').last();
    const surface = await panel.evaluate((e) => {
      const cs = getComputedStyle(e);
      return { bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow };
    });
    expect(surface.bg, `${label} has no panel background`).not.toBe('rgba(0, 0, 0, 0)');
    expect(surface.border, `${label} has no panel border`).not.toBe('0px');
    expect(surface.shadow, `${label} has no elevation`).not.toBe('none');
    await page.keyboard.press('Escape');
  }

  // -- The edge editor centres on the screen, and takes nothing with it -----
  await page.locator('[data-testid="structural-host"] path.flowchart-link').first().click({
    // A straight edge has a zero-width box, which Playwright reads as
    // invisible; the stroke is still a real hit target for a real click.
    force: true,
  });
  const editor = page.getByTestId('mermaid-edge-editor');
  await expect(editor).toBeVisible();
  expect(await viewport.locator('[data-testid="mermaid-edge-editor"]').count()).toBe(1);
  expect(
    await page.getByTestId('canvas-plane').locator('[data-testid="mermaid-edge-editor"]').count(),
  ).toBe(0);
  expect(await scrollOf()).toBe(0);
  expect(await svgLeft()).toBeCloseTo(restingLeft, 0);

  // -- A background click dismisses it, like every other surface ------------
  // A point that is genuinely BOTH on screen and over the editor's own
  // background: at 214% the host is larger than the viewport and offset from
  // it in both axes, so neither element's own coordinates are a place a user
  // could click. Take the overlap and aim at its left margin, clear of the
  // node column down the middle.
  const spot = await page.evaluate(() => {
    const h = document.querySelector('[data-testid="structural-host"]')!.getBoundingClientRect();
    const v = document.querySelector('[data-testid="canvas-viewport"]')!.getBoundingClientRect();
    const left = Math.max(h.left, v.left);
    const top = Math.max(h.top, v.top);
    const right = Math.min(h.right, v.right);
    const bottom = Math.min(h.bottom, v.bottom);
    return { x: left + (right - left) * 0.08, y: top + (bottom - top) / 2 };
  });
  await page.mouse.click(spot.x, spot.y);
  await expect(editor).toHaveCount(0);
});

/**
 * M29.53 — three fixes that jsdom cannot see, driven where they live.
 *
 * Each replaces a measurement taken against the shipped build: a shape palette
 * that stayed put while its node travelled (-358, -214) under a wheel zoom;
 * focus landing on ProseMirror's root instead of the button the dialog was
 * opened from; and an export naming 'Instrument Sans' in nine places while
 * carrying zero @font-face rules, so every rasterised label was set in the
 * fallback face against box geometry computed for another one.
 */
async function bootVault(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

async function openPipelinePage(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Pipeline');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Pipeline' }).first().click();
  await expect(page.getByTestId('diagram-page')).toBeVisible();
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 30_000 });
}

test('M29.53: a popover tracks its node through a wheel zoom', async ({ page }) => {
  test.setTimeout(90_000);
  await bootVault(page);
  await openPipelinePage(page);
  const node = page.locator('g.node').first();
  await node.click();
  await page.getByRole('button', { name: 'Change shape' }).click();
  const palette = page.getByTestId('shape-palette');
  await expect(palette).toBeVisible();
  const n0 = await node.boundingBox();
  const p0 = await palette.boundingBox();
  // The palette's ANCHOR is the node toolbar it was opened from, not the node
  // — Popover with no anchorRef measures the trigger's own wrapper. So the
  // property is "the gap to the toolbar survives the zoom".
  const t0 = await page.getByTestId('mermaid-node-toolbar').boundingBox();
  const vp = await page.getByTestId('canvas-viewport').boundingBox();
  await page.mouse.move(
    (vp?.x ?? 0) + (vp?.width ?? 0) - 80,
    (vp?.y ?? 0) + (vp?.height ?? 0) - 80,
  );
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(500);
  const open = (await palette.count()) > 0;
  const n1 = await node.boundingBox();
  const p1 = open ? await palette.boundingBox() : null;
  const nd = { x: (n1?.x ?? 0) - (n0?.x ?? 0), y: (n1?.y ?? 0) - (n0?.y ?? 0) };
  const pd = p1 === null ? null : { x: p1.x - (p0?.x ?? 0), y: p1.y - (p0?.y ?? 0) };
  const t1 = await page.getByTestId('mermaid-node-toolbar').boundingBox();
  // "Adjacent to its anchor on one side or the other": the panel is free to
  // flip above/below and to clamp against the viewport edge — both are correct
  // re-placements — and the finding is about it not MOVING AT ALL.
  const adjacency = (t: typeof t0, pa: typeof p0): number | null =>
    t === null || pa === null
      ? null
      : Math.round(Math.min(Math.abs(pa.y - (t.y + t.height)), Math.abs(t.y - (pa.y + pa.height))));
  const g0 = adjacency(t0, p0);
  const g1 = adjacency(t1, p1);
  console.log(
    'V1 node moved',
    JSON.stringify(nd),
    '| palette moved',
    JSON.stringify(pd),
    '| open:',
    open,
    '| gap to its anchor:',
    g0,
    '->',
    g1,
  );
  expect(Math.abs(nd.x) + Math.abs(nd.y)).toBeGreaterThan(10);
  expect(p1).not.toBeNull();
  expect(Math.abs((pd?.x ?? 0) - nd.x)).toBeLessThan(8);
  // Before M29.53 the palette did not move at all while its anchor travelled
  // (-358, -214), so this number was the whole 214px of it.
  expect(g1 ?? 999).toBeLessThan(16);
});

test('M29.53: closing the full-screen dialog hands focus back to its trigger', async ({ page }) => {
  test.setTimeout(90_000);
  await bootVault(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Systems map');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 30_000 });
  const trigger = page.getByRole('button', { name: 'Open full screen' }).first();
  await trigger.click();
  const dialog = page.getByTestId('fullscreen-diagram-editor');
  await expect(dialog).toBeVisible();
  await dialog.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  const onTrigger = await trigger.evaluate((el) => el === document.activeElement);
  const what = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return `${el?.tagName}:${el?.textContent?.slice(0, 24)}`;
  });
  console.log('V3 activeElement:', what, '| is the trigger:', onTrigger);
  expect(onTrigger).toBe(true);
  // …and Escape, the other exit, lands the same way.
  await trigger.click();
  await expect(page.getByTestId('fullscreen-diagram-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fullscreen-diagram-editor')).toHaveCount(0);
  console.log(
    'V3 after Escape, is the trigger:',
    await trigger.evaluate((el) => el === document.activeElement),
  );
});

test('M29.53: an exported svg carries the font it names', async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await bootVault(page);
  await openPipelinePage(page);
  await page.getByRole('button', { name: 'Copy SVG' }).click();
  await page.waitForTimeout(1500);
  const svg = await page.evaluate(() => navigator.clipboard.readText());
  const faces = (svg.match(/@font-face/g) ?? []).length;
  const dataUri = /url\(data:font\/ttf;base64,([A-Za-z0-9+/=]{40})/.exec(svg)?.[1] ?? null;
  console.log('V4 svg', svg.length, 'chars | @font-face:', faces, '| data URI head:', dataUri);
  expect(faces).toBe(1);
  expect(dataUri).toBeTruthy();
  expect(svg).toContain("font-family:'Instrument Sans'");
});

test('M29.53: a link badge closes the dialog deliberately, then navigates', async ({ page }) => {
  test.setTimeout(120_000);
  await bootVault(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Systems map');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open full screen' }).first().click();
  const dialog = page.getByTestId('fullscreen-diagram-editor');
  await expect(dialog).toBeVisible();
  await dialog.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 30_000 });
  await dialog.locator('g.node').first().click();
  await page.getByRole('button', { name: 'Node link' }).click();
  await page.getByLabel('Link target').fill('Phoenix');
  await page.waitForTimeout(400);
  const offers = await page
    .getByRole('button')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label')).filter((l) => l?.startsWith('Link to')),
    );
  const record = offers.find((l) => l !== 'Link to URL')!;
  await page.getByRole('button', { name: record, exact: true }).click();
  const badge = page.getByTestId('mermaid-link-badge').first();
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await badge.click();
  await page.waitForTimeout(900);
  const scrims = await page.locator('.cb-dlg-scrim').count();
  const open = await page.getByTestId('fullscreen-diagram-editor').count();
  const title = await page.getByTestId('doc-title').textContent();
  console.log('M29.53 badge — dialog:', open, '| scrims:', scrims, '| title:', title);
  // The destination is the same; what changed is that the modal came down
  // through its own close rather than being torn out with the document.
  expect(open).toBe(0);
  expect(scrims).toBe(0);
  expect(title).toContain('Phoenix');
});

test('M29.53: at 39% the node toolbar leaves the next node clickable', async ({ page }) => {
  test.setTimeout(90_000);
  await bootVault(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Pipeline');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Pipeline' }).first().click();
  await expect(page.getByTestId('diagram-page')).toBeVisible();
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 30_000 });
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
  const zoom = await page.getByRole('button', { name: 'Reset zoom' }).textContent();
  const nodes = page.locator('g.node');
  await nodes.first().click();
  await expect(page.getByTestId('mermaid-node-toolbar')).toBeVisible();
  const second = await nodes.nth(1).boundingBox();
  const cx = (second?.x ?? 0) + (second?.width ?? 0) / 2;
  const cy = (second?.y ?? 0) + (second?.height ?? 0) / 2;
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el?.closest('[data-testid]')?.getAttribute('data-testid') ?? el?.tagName ?? null;
    },
    [cx, cy],
  );
  console.log('M29.53 toolbar/zoom', zoom, '| elementFromPoint at node 2 centre:', hit);
  expect(hit).not.toBe('mermaid-node-toolbar');
  // The element under that point is the node itself, through its own label —
  // which is the whole claim. What happens NEXT to a plain-click-then-
  // shift-click is a separate, pre-existing story (see the handoff): measured
  // identical at 100% zoom, and identical with every source change stashed.
});
