import { expect, test, type Locator } from '@playwright/test';
import { boot, chooseSettingsSection, openDestination, seedFileBeforeBoot } from './boot';
import { chooseOption } from './select';

async function contrast(control: Locator) {
  return control.evaluate((node) => {
    const style = getComputedStyle(node);
    const luminance = (value: string) => {
      const rgb = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((n) => {
          const c = n / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const values = [luminance(style.color), luminance(style.backgroundColor)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
}

for (const theme of ['light', 'dark']) {
  test(`shared controls retain contrast, size and focus in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page);
    if (theme === 'dark') {
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    }
    await openDestination(page, 'Library');
    const library = page.locator('.cb-library-page');
    await expect(library.getByRole('heading', { name: 'Library', exact: true })).toHaveCSS(
      'font-size',
      '24px',
    );
    const action = library.locator('.cb-page-header-actions .cb-btn-primary');
    await expect(action).toBeVisible();
    expect((await action.boundingBox())!.height).toBe(28);
    expect(await contrast(action)).toBeGreaterThanOrEqual(4.5);
    await action.hover();
    await expect.poll(() => contrast(action)).toBeGreaterThanOrEqual(4.5);
    await page.mouse.down();
    await expect.poll(() => contrast(action)).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await action.focus();
    await expect(action).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`foundation-library-${theme}.png`),
      animations: 'disabled',
    });
    // Bundled-font macOS baselines are reviewed separately for each browser.
    // They are provisional implementation evidence, not owner aesthetic approval.
    if (process.platform === 'darwin' && theme === 'light') {
      await expect(library).toHaveScreenshot('library-foundation-light.png', {
        animations: 'disabled',
        maxDiffPixels: 100,
      });
    }
    const contextCreate = page.getByTestId('sidebar').getByRole('button', {
      name: 'New',
      exact: true,
    });
    await contextCreate.click();
    await expect(page.getByTestId('create-launcher')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(contextCreate).toBeFocused();
    await page.setViewportSize({ width: 900, height: 600 });
    const create = page.getByTestId('app-rail').getByRole('button', { name: 'New', exact: true });
    await create.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('animation-duration', '0s');
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(16);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
    await page.screenshot({
      path: info.outputPath(`foundation-dialog-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(create).toBeFocused();
    await openDestination(page, 'Settings');
    await chooseSettingsSection(page, 'Knowledge');
    const thumb = page.locator('.cb-settings .cb-track:visible').first();
    await expect(thumb).toBeVisible();
    expect(
      await thumb.evaluate((node) => getComputedStyle(node, '::after').transitionDuration),
    ).toBe('0s');
    await chooseSettingsSection(page, 'Mail');
    const retention = page.getByRole('button', { name: 'Mail retention window' });
    await expect(retention).toHaveCSS('font-size', '14px');
    expect((await retention.boundingBox())!.height).toBe(32);
    await chooseOption(retention, '30 days');
    await expect(retention).toHaveAttribute('data-value', '30');
    await expect(page.getByTestId('mail-prune')).toContainText('older than 30 days.');
    await page.screenshot({
      path: info.outputPath(`foundation-mail-${theme}.png`),
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      900,
    );
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    const search = page
      .getByTestId('app-rail')
      .getByRole('button', { name: 'Search', exact: true });
    await search.focus();
    const tooltip = page.getByRole('tooltip').filter({ hasText: 'Search' });
    await expect(tooltip).toBeVisible();
    const anchorBounds = (await search.boundingBox())!;
    const tipBounds = (await tooltip.boundingBox())!;
    const anchorGap = Math.min(
      Math.abs(anchorBounds.y - tipBounds.y - tipBounds.height),
      Math.abs(tipBounds.y - anchorBounds.y - anchorBounds.height),
    );
    // Six CSS pixels remain six CSS pixels at 2x; raw screen coordinates
    // assigned as fixed CSS offsets would visibly detach the tooltip.
    expect(Math.abs(anchorGap - 12)).toBeLessThanOrEqual(2);
    expect(tipBounds.x).toBeGreaterThanOrEqual(0);
    expect(tipBounds.x + tipBounds.width).toBeLessThanOrEqual(900);
    expect(tipBounds.y + tipBounds.height).toBeLessThanOrEqual(600);
  });

  test(`My work wraps long names and keeps an invalid deadline honest in ${theme}`, async ({
    page,
  }, info) => {
    const title =
      'Review the professional workspace presentation with a long task name that still exposes its uncertain deadline and current work status';
    await seedFileBeforeBoot(
      page,
      'work/polish-surface-check.md',
      `---\ntype: Work item\nstatus: progress\ndue: sometime\n---\n# ${title}\n`,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    if (theme === 'dark') {
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    }
    await openDestination(page, 'My work');
    const row = page.getByTestId('mywork-row').filter({ hasText: title });
    const name = row.locator('.cb-work-title');
    const deadline = row.getByTestId('mywork-deadline');
    await expect(row).toBeVisible();
    await expect(deadline).toHaveText('Not a date');
    await expect(name).toHaveCSS('font-size', '14px');
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    // Exercise the same local-width rule used when a pane is narrower than
    // the outer window, without adding a production-only viewport breakpoint.
    await page.setViewportSize({ width: 600, height: 600 });
    await row.scrollIntoViewIfNeeded();
    const bounds = (await row.boundingBox())!;
    const titleBounds = (await name.boundingBox())!;
    const deadlineBounds = (await deadline.boundingBox())!;
    expect(titleBounds.height).toBeGreaterThan(20);
    expect(titleBounds.height).toBeLessThanOrEqual(40);
    expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(deadlineBounds.x);
    expect(deadlineBounds.x + deadlineBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      600,
    );
    await page.screenshot({
      path: info.outputPath(`mywork-long-title-${theme}.png`),
      animations: 'disabled',
    });
  });
}
