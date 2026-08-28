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
 * 2. The preview is INERT. jsdom does not implement the `inert` attribute's
 *    behavior (its clicks are synthetic dispatches that ignore hit-testing),
 *    so the unit suite can only assert the attribute exists. A real
 *    browser's hit-test is the thing under test: a click at a live
 *    FieldEditor chip's coordinates must open nothing and write nothing.
 */
test('layout editor: strip to vault bytes, and the preview stays inert', async ({ page }) => {
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
  // The same chip button the control group just proved opens a listbox.
  const chip = preview
    .getByTestId('heading-strip')
    .locator('[data-field="status"]')
    .getByRole('button', { includeHidden: true });
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
});
