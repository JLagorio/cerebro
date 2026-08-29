import { test, expect } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * M45.2 — the layout editor, strip to vault bytes.
 *
 * Work item is the golden-corpus type wearing `layout:` (heading
 * [status, priority] + one Planning group — 2026-08-28-m45.2 plan, Task 6),
 * picked because the suite already opens its records everywhere (smoke's
 * board card, agent's table rows, whiteboard's chip) while asserting nothing
 * about the property panel itself.
 *
 * Two claims only this spec can make in a real browser:
 *
 * 1. The whole round trip: strip on the open record → stack behind View
 *    details → ⋯ → Customize layout → the rail stages `show_file` → Apply →
 *    the record panel grows the file row AND the Type doc's frontmatter in
 *    the mock vault carries the bit. jsdom covers every joint; only e2e
 *    covers the chain.
 * 2. The block CONTENT is inert. M45.3 moved the boundary inward — the
 *    canvas, its block shells, and Task 6's drag layer are live; each
 *    preview FRAGMENT (the heading strip here, a field row)
 *    carries the `inert`. jsdom does not implement the attribute's behavior (its
 *    clicks are synthetic dispatches that ignore hit-testing), so the unit
 *    suite can only assert where the attribute sits. A real browser's
 *    hit-test is the thing under test: a click at a live FieldEditor chip's
 *    coordinates must open nothing and write nothing.
 * 3. The group editor's eye, stage to page fold (M45.3 Task 7): a shell
 *    click opens the Planning editor, its eye hides `estimate`, and one
 *    Apply later the record panel folds the row behind the expander while
 *    the Type doc's bytes carry the verdict.
 */
test('layout editor: strip to vault bytes, inert preview, and the eye folds the page', async ({
  page,
}) => {
  await boot(page);

  // -- Open a Work item in the record panel ----------------------------
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  const row = page.getByTestId('table-row').first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  // -- The strip shows the heading; the stack ships folded -------------
  // Every corpus Work item has a status, so the strip never folds away.
  // The panel has no page-properties wrapper (that testid is DocPage's) —
  // the folded stack IS the absence of its rows.
  await expect(panel.getByTestId('heading-strip')).toBeVisible();
  await expect(panel.getByTestId('property-row')).toHaveCount(0);

  // -- View details unfolds the full stack, Planning group and all -----
  await panel.getByTestId('view-details-toggle').click();
  await expect(panel.getByTestId('property-row').first()).toBeVisible();
  await expect(panel.getByTestId('property-group').filter({ hasText: 'Planning' })).toBeVisible();

  // -- Control group for the inert claim below -------------------------
  // The LIVE strip's status chip opens a FieldPopover (role=listbox) on
  // click. Proving that first is what keeps the preview assertion honest:
  // the same chip, the same idiom, so its silence there means `inert`
  // worked — not that the click missed.
  await panel
    .getByTestId('heading-strip')
    .locator('[data-field="status"]')
    .getByRole('button')
    .click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);

  // -- ⋯ → Customize layout raises the fullscreen editor ---------------
  await panel.getByRole('button', { name: 'Record actions' }).click();
  await page.getByTestId('record-customize-layout').click();
  const editor = page.getByTestId('layout-editor');
  await expect(editor).toBeVisible();
  const preview = page.getByTestId('layout-preview');
  await expect(preview.getByTestId('heading-strip')).toBeVisible();

  // -- The inert claim: a real click on a live chip does nothing -------
  // The previewed record is whatever the picker holds; its bytes are the
  // write target a NON-inert FieldEditor would hit.
  const previewedPath = await page.getByTestId('layout-preview-picker').inputValue();
  const before = await readMockFile(page, previewedPath);
  // The same chip button the control group just proved opens a listbox —
  // reached through the heading BLOCK's inert content div, because that is
  // where the boundary sits now (M45.3): the shell around it is live, so a
  // click that lands must be swallowed by the content's inert, not by a
  // still-inert canvas.
  const chip = preview
    .locator('[data-block="heading"]')
    .getByTestId('layout-preview-content')
    .getByTestId('heading-strip')
    .locator('[data-field="status"]')
    .getByRole('button', { includeHidden: true });
  // Vacuity guard (review): a below-the-fold chip would hand mouse.click an
  // off-viewport point and the inert claim would pass over empty pixels.
  await chip.scrollIntoViewIfNeeded();
  const box = await chip.boundingBox();
  if (box === null) throw new Error('preview status cell has no geometry');
  // page.mouse, not locator.click(): the point is the browser's own
  // hit-test at these coordinates, which `inert` removes the subtree from —
  // locator.click() would wait forever for an actionability that never comes.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // A FieldPopover renders role=listbox; give one a beat to appear, then
  // hold that it never did and the record's bytes never moved.
  await page.waitForTimeout(250);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  expect(await readMockFile(page, previewedPath)).toBe(before);
  // The swallowed click has a SECOND life since Task 5: hit-testing skips
  // the inert content, so the heading SHELL received it and its group
  // editor sits open now (deliberate — the chip stayed dead, which was the
  // claim). The rail press below dismisses it in passing: outside
  // pointerdown closes the popover, and the click still lands on the rail.
  await expect(page.getByRole('dialog', { name: 'Edit Heading' })).toBeVisible();

  // -- Stage Show file path; nothing lands before Apply ----------------
  const fileSwitch = page.getByRole('switch', { name: 'Show file path' });
  await expect(fileSwitch).not.toBeChecked();
  await page.getByTestId('layout-rail').getByText('Show file path').click();
  await expect(fileSwitch).toBeChecked();
  expect(await readMockFile(page, 'types/work-item.md')).not.toContain('show_file');

  // -- Apply writes the Type doc and closes the editor -----------------
  await page.getByTestId('layout-apply').click();
  await expect(editor).toHaveCount(0);

  // -- The open record wears the file row now --------------------------
  await expect(panel.getByTestId('detail-file')).toBeVisible();

  // -- …because the vault's Type doc carries the bit -------------------
  const typeDoc = await readMockFile(page, 'types/work-item.md');
  expect(typeDoc).toMatch(/display:\s*\n\s+show_file: true/);
  // The golden-corpus layout survived the round trip alongside it.
  expect(typeDoc).toContain('- status');
  expect(typeDoc).toContain('name: Planning');

  // -- Act two (M45.3 Task 7): the eye's verdict lands in the vault ----
  // Precondition, or the fold below proves nothing: the open record HAS an
  // estimate, so its row stands before the eye acts. (Nearly every corpus
  // work item carries one; this pins the assumption to the one on stage.)
  const estimateRow = panel.locator('[data-testid="property-row"][data-property="estimate"]');
  await expect(estimateRow).toHaveCount(1);
  // The expander's count BEFORE — the eye must grow it by exactly one. A
  // record with every field set has no expander at all; that reads as zero.
  const expander = panel.getByTestId('hidden-properties-toggle');
  const hiddenBefore =
    (await expander.count()) === 0
      ? 0
      : Number(((await expander.textContent()) ?? '').match(/\d+/)?.[0]);
  expect(Number.isNaN(hiddenBefore)).toBe(false);

  // -- Reopen the editor; the Planning SHELL opens its group editor ----
  await panel.getByRole('button', { name: 'Record actions' }).click();
  await page.getByTestId('record-customize-layout').click();
  await expect(editor).toBeVisible();
  // Anywhere inside the block lands on the live shell (the inert fragments
  // are unhittable, as act one proved) and click-to-edit opens the editor.
  await preview.locator('[data-block="planning"]').click();
  const groupEditor = page.getByTestId('group-editor');
  await expect(groupEditor).toBeVisible();

  // -- Eye OFF estimate: staged only, nothing in the vault yet ---------
  await groupEditor.getByRole('button', { name: 'Hide Estimate' }).click();
  // The eye reads its own stage back — hide flips the label to Show.
  await expect(groupEditor.getByRole('button', { name: 'Show Estimate' })).toBeVisible();
  expect(await readMockFile(page, 'types/work-item.md')).not.toContain('visibility');

  // -- Apply: the editor closes and the record surface folds the row ---
  // The popover is still open; the press reaches Apply THROUGH its
  // dismiss — outside pointerdown closes the layer, the click still lands
  // (the same mechanics the rail press rode in act one).
  await page.getByTestId('layout-apply').click();
  await expect(editor).toHaveCount(0);
  await expect(estimateRow).toHaveCount(0);
  await expect(expander).toContainText(`${hiddenBefore + 1} hidden`);

  // -- …because the Type doc's estimate spec carries the verdict -------
  const after = await readMockFile(page, 'types/work-item.md');
  const estimateBlock = after.match(/\n {2}estimate:\n((?: {3,}.*\n)*)/)?.[1] ?? '';
  // Capture guard first: an empty match would pass a bare toContain
  // vacuously. The block is estimate's — then the verdict sits inside it.
  expect(estimateBlock).toContain('kind: select');
  expect(estimateBlock).toContain('visibility: hide');
});

/**
 * M45.5 — the two headline parity defects, live browser to vault bytes.
 *
 * Epic is the corpus type wearing `tabs:` (Overview + the M45.4 "Work items"
 * view), so the editor's strip has something real to edit; Work item, the
 * other spec's subject, is tabless and would only ever render the Simple
 * canvas. `view-tabs.spec.ts` opens Epic too, but as a full PAGE and without
 * writing its Type doc, so the two never see each other's state.
 *
 * Three claims only a real browser can make:
 *
 * 1. Defect 2 — the zone boundaries are PERSISTENT. jsdom can read a class
 *    list; it cannot tell you what the pixel does, and `toBeVisible` alone
 *    would have passed on the old `opacity-0` chip just as happily (Playwright
 *    counts a transparent element as visible). The assertion is the COMPUTED
 *    opacity with the pointer parked off the canvas, plus a real border width
 *    on the block — the two halves of "visible without hover".
 * 2. Defect 1 — heading first, tabs second. The user's words were "tabs are on
 *    top"; the DOM order of the block shells is that sentence's negation.
 * 3. Defects 1 and 3 to the disk: rename a tab IN the editor's strip and mint
 *    a section with the + button, and one Apply later the Type doc's own bytes
 *    carry both. Every joint is covered in jsdom; only this covers the chain —
 *    two different draft slices (`tabs` and `layout.groups`) staged through
 *    the same door and landing in one atomic write.
 */
test('layout editor: the strip renames a tab, the + mints a section, both land in the bytes', async ({
  page,
}) => {
  await boot(page);

  // -- Open an Epic in the record panel --------------------------------
  await page.getByTestId('sidebar-type').filter({ hasText: 'Epic' }).first().click();
  const row = page.getByTestId('table-row').first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  // -- ⋯ → Customize layout raises the fullscreen editor ---------------
  await panel.getByRole('button', { name: 'Record actions' }).click();
  await page.getByTestId('record-customize-layout').click();
  const editor = page.getByTestId('layout-editor');
  await expect(editor).toBeVisible();
  const preview = page.getByTestId('layout-preview');

  // -- Defect 2: every zone is bounded and named, with nothing hovered --
  // Park the pointer in the dialog's corner first — the press that opened
  // the editor left it wherever that menu item was, which may well be over a
  // block, and a hover would make the assertion vacuous.
  await page.mouse.move(0, 0);
  const tabsBlock = preview.locator('[data-block="tabs"]');
  await expect(tabsBlock).toHaveCSS('border-top-width', '1px');
  await expect(tabsBlock).toHaveCSS('border-top-style', 'solid');
  const tabsLabel = tabsBlock.getByTestId('layout-block-label');
  await expect(tabsLabel).toHaveText('Tabs');
  await expect(tabsLabel).toHaveCSS('opacity', '1');
  // Not the tabs shell alone — the heading's chip rode the same opacity-0.
  await expect(
    preview.locator('[data-block="heading"]').getByTestId('layout-block-label'),
  ).toHaveCSS('opacity', '1');

  // -- Defect 1a: heading first, tabs second (Notion's order) ----------
  const order = await preview
    .getByTestId('layout-block')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block')));
  expect(order.slice(0, 2)).toEqual(['heading', 'tabs']);

  // -- Defect 1b: the strip EDITS — rename Overview in place -----------
  const strip = preview.getByTestId('record-tabs');
  const overview = strip.getByTestId('record-tab-overview');
  await expect(overview).toHaveText('Overview');
  // Pressing the tab you are standing on opens its menu — the strip's own
  // idiom, unchanged inside the canvas.
  await overview.click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const tabName = strip.getByRole('textbox', { name: 'Tab name' });
  await tabName.fill('Summary');
  // Enter blurs the input, and the blur is what commits (RenameTab). A
  // synthetic blur event would not fire React's handler; a real key press
  // through a real input does.
  await tabName.press('Enter');
  await expect(overview).toHaveText('Summary');

  // -- Defect 3: the + button mints a section and opens its editor -----
  await preview.getByTestId('layout-add-section').click();
  const groupEditor = page.getByTestId('group-editor');
  await expect(groupEditor).toBeVisible();
  const sectionName = groupEditor.getByRole('textbox', { name: 'Section name' });
  await expect(sectionName).toHaveValue('New group');
  await sectionName.fill('Delivery');
  await sectionName.press('Enter');
  // The canvas grew a bordered zone wearing the new name.
  await expect(
    preview.getByTestId('layout-block-label').filter({ hasText: 'Delivery' }),
  ).toBeVisible();

  // -- Nothing has been written yet ------------------------------------
  const before = await readMockFile(page, 'types/epic.md');
  expect(before).toContain('name: Overview');
  expect(before).not.toContain('Delivery');

  // -- Apply lands the whole draft in one write ------------------------
  // The group editor is still open; the press reaches Apply through its
  // dismiss, the same mechanics the first spec rides.
  await page.getByTestId('layout-apply').click();
  await expect(editor).toHaveCount(0);

  // -- The Type doc's bytes carry the rename AND the new section -------
  const typeDoc = await readMockFile(page, 'types/epic.md');
  // The rename is a NAME edit: the id the records' section content hangs
  // off is untouched, and the sibling view tab is still there.
  expect(typeDoc).toContain('name: Summary');
  expect(typeDoc).not.toContain('name: Overview');
  expect(typeDoc).toContain('id: overview');
  expect(typeDoc).toContain('id: work-items');
  // The minted section: a group under `layout:`, empty because nothing was
  // put in it — which is what "add a section" alone means. Scoped to the
  // layout block first, so a `name:` from the tab list can never stand in
  // for the group's (the capture guard the eye assertion above uses).
  const layoutBlock = typeDoc.match(/\nlayout:\n((?: {2,}.*\n)*)/)?.[1] ?? '';
  expect(layoutBlock).toContain('groups:');
  expect(layoutBlock).toContain('name: Delivery');
});
