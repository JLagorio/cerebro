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
