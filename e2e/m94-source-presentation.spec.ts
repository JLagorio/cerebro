import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

for (const theme of ['light', 'dark']) {
  for (const presentation of ['peek', 'page']) {
    test(`source presentation controls align and retain focus in ${presentation}, ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await boot(page);
      if (theme === 'dark')
        await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
      const path = 'records/projects/guided-onboarding-ga.md';
      const before = await readMockFile(page, path);
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('quick-open-input').fill('Guided onboarding GA');
      await page
        .getByTestId('quick-open-result')
        .filter({ hasText: 'Guided onboarding GA' })
        .first()
        .click();
      if (presentation === 'page')
        await page
          .getByTestId('detail-panel')
          .getByRole('button', { name: 'Open in full page' })
          .click();
      const host = page.getByTestId(presentation === 'page' ? 'doc-page' : 'detail-panel');
      const title = host.locator('[data-page-title] h1');
      await expect(title).toHaveText('Guided onboarding GA');
      const controls = host.getByRole('group', { name: 'Page presentation' });
      const rich = controls.getByRole('button', { name: 'Rich text', exact: true });
      const source = controls.getByRole('button', { name: 'Source', exact: true });
      await expect(source).toBeEnabled();
      const titleBox = (await title.boundingBox())!;
      const richBox = (await rich.boundingBox())!;
      expect(Math.abs(titleBox.x - richBox.x)).toBeLessThanOrEqual(2);
      expect(richBox.height).toBe(28);
      await expect(rich).toHaveAttribute('aria-pressed', 'true');
      const selected = await rich.evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(await source.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
        selected,
      );
      await source.focus();
      await source.press('Enter');
      await expect(source).toHaveAttribute('aria-pressed', 'true');
      await expect(source).toBeFocused();
      await expect(host.getByRole('textbox', { name: 'Page source' })).toBeVisible();
      expect(await readMockFile(page, path)).toBe(before);
      await page.screenshot({
        path: info.outputPath(`source-${presentation}-${theme}.png`),
        animations: 'disabled',
      });
      await rich.focus();
      await rich.press('Enter');
      await expect(rich).toHaveAttribute('aria-pressed', 'true');
      await expect(rich).toBeFocused();
      await expect(title).toBeVisible();
      expect(await readMockFile(page, path)).toBe(before);
      await page.screenshot({
        path: info.outputPath(`rich-${presentation}-${theme}.png`),
        animations: 'disabled',
      });
    });
  }
}
