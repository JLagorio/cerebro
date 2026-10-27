import { expect, test } from '@playwright/test';
import { boot } from './boot';

for (const theme of ['light', 'dark']) {
  for (const role of ['collection', 'utility']) {
    test(`${role} composition follows its host width in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await boot(page);
      for (const width of [360, 599, 600, 959, 960]) {
        await page.goto(`/state-lab.html?composition=${role}&width=${width}&theme=${theme}`);
        const host = page.getByTestId('composition-host');
        const heading = host.getByRole('heading', { level: 1 });
        const content = page.getByTestId('composition-content');
        await expect(heading).toBeVisible();
        const expectedInset = width < 600 ? 16 : width < 960 ? 24 : 32;
        const box = (await host.boundingBox())!;
        const headingBox = (await heading.boundingBox())!;
        const contentEdge = await content.evaluate(
          (node) => node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft),
        );
        expect(Math.abs(headingBox.x - box.x - expectedInset)).toBeLessThanOrEqual(2);
        expect(Math.abs(contentEdge - headingBox.x)).toBeLessThanOrEqual(2);
        expect(
          Math.abs(headingBox.y - box.y - (role === 'collection' ? 40 : 32)),
        ).toBeLessThanOrEqual(2);
        await expect(heading).toHaveCSS('font-size', role === 'collection' ? '28px' : '24px');
        const action = host.locator('.cb-page-header-actions button');
        const actionBox = (await action.boundingBox())!;
        expect(actionBox.height).toBe(32);
        expect(actionBox.x).toBeGreaterThanOrEqual(box.x + expectedInset - 2);
        expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
          box.x + box.width - expectedInset + 2,
        );
        expect(await host.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await action.focus();
        await expect(action).toBeFocused();
        await page.screenshot({
          path: info.outputPath(`${role}-${width}-${theme}.png`),
          animations: 'disabled',
        });
      }
      // The same content and host make a reviewable pair without adopting the
      // proposal in an application surface or updating historical snapshots.
      for (const variant of ['current', 'proposed']) {
        await page.goto(
          `/state-lab.html?composition=${role}&width=600&theme=${theme}&variant=${variant}`,
        );
        const host = page.getByTestId('composition-host');
        await expect(host.getByRole('heading', { level: 1 })).toBeVisible();
        await host.locator('.cb-page-header-actions button').focus();
        await page.screenshot({
          path: info.outputPath(`${role}-pair-${variant}-${theme}.png`),
          animations: 'disabled',
        });
      }
    });
  }
}
