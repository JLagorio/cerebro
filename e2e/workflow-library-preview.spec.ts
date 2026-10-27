import { expect, test } from '@playwright/test';
import { openStateLab } from './boot';

test('workflow library preview preserves explicit edits and publications across all five display states', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const states = {
    ready: 'Published version 1',
    empty: 'No workflows yet',
    'not-recorded': 'Draft',
    partial: 'Definition unavailable',
    unavailable: 'Workflows could not be read.',
  } as const;
  for (const state of Object.keys(states) as (keyof typeof states)[]) {
    await page.setViewportSize({ width: state === 'partial' ? 674 : 1000, height: 900 });
    await openStateLab(page, 'workflows', state);
    const stage = page.getByTestId('lab-stage');
    await expect(stage).toContainText(states[state]);
    // The lab reserves 314px for navigation and frame; this is a real 360px content pane.
    if (state === 'partial')
      expect(await stage.getByTestId('workflow-library').evaluate((node) => node.clientWidth)).toBe(
        360,
      );
    await expect(stage).toContainText('Display preview. No native workflow is running.');
    const files = await page.evaluate(() => Array.from(window.__cerebroMockFs.entries()));
    const writes = await page.evaluate(() => window.__cerebroMockWrites.length);
    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') await page.getByTestId('lab-theme').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const library = stage.getByTestId('workflow-library');
      expect(await library.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await library.screenshot({
        path: info.outputPath(`workflow-${state}-${theme}.png`),
        animations: 'disabled',
      });
    }
    if (state === 'unavailable') {
      await stage.getByRole('button', { name: 'Retry workflows', exact: true }).click();
      await expect(stage).toContainText('Published version 1');
      await expect(stage.locator('.section-unavailable')).toHaveCount(0);
    }
    if (state === 'ready') {
      await stage.getByRole('button', { name: 'Open workflow weekly-review', exact: true }).click();
      const save = stage.getByRole('button', { name: 'Save draft', exact: true });
      const publish = stage.getByRole('button', { name: 'Publish saved draft', exact: true });
      await expect(save).toBeDisabled();
      const label = stage.getByLabel('Step 1 label', { exact: true });
      await label.fill('Authored weekly review');
      const exact = '{ "kind": "literal", "value": 9007199254740993.00000000001 }';
      await stage.getByLabel('Step 1 output mapping JSON', { exact: true }).fill(exact);
      await expect(publish).toBeDisabled();
      await stage.getByRole('button', { name: 'Back to workflows', exact: true }).click();
      await stage.getByRole('button', { name: 'Resume draft weekly-review', exact: true }).click();
      await expect(label).toHaveValue('Authored weekly review');
      await expect(stage.getByLabel('Step 1 output mapping JSON', { exact: true })).toHaveValue(
        exact,
      );
      await save.click();
      await expect(save).toBeDisabled();
      await expect(publish).toBeEnabled();
      await stage.getByRole('button', { name: 'Validate draft', exact: true }).click();
      await expect(stage).toContainText('Draft is valid.');
      await publish.click();
      await expect(stage).toContainText('Published version 2');
      await stage.getByRole('button', { name: 'View published version', exact: true }).click();
      await expect(stage.locator('.cb-workflow-versions pre')).toContainText(
        '9007199254740993.00000000001',
      );
      await page.setViewportSize({ width: 674, height: 900 });
      await label.focus();
      await expect(label).toBeFocused();
      expect(await stage.getByTestId('workflow-library').evaluate((node) => node.clientWidth)).toBe(
        360,
      );
      expect(
        await stage.getByRole('tab', { name: 'Workflows', exact: true }).evaluate((node) => {
          const box = node.getBoundingClientRect();
          const strip = node.closest('[role=tablist]')!.getBoundingClientRect();
          return box.left >= strip.left && box.right <= strip.right;
        }),
      ).toBe(true);
      await info.attach('narrow-layout', {
        contentType: 'application/json',
        body: JSON.stringify(
          await stage.getByTestId('workflow-library').evaluate((node) => ({
            width: node.clientWidth,
            scrollWidth: node.scrollWidth,
            overflows: [...node.querySelectorAll('*')]
              .filter((el) => {
                const box = el.getBoundingClientRect();
                return box.right > window.innerWidth || el.scrollWidth > el.clientWidth + 1;
              })
              .map((el) => ({
                tag: el.tagName,
                class: el.className,
                text: el.textContent?.slice(0, 100),
                width: el.clientWidth,
                scrollWidth: el.scrollWidth,
                left: el.getBoundingClientRect().left,
                right: el.getBoundingClientRect().right,
              })),
          })),
        ),
      });
      await stage.getByTestId('workflow-library').screenshot({
        path: info.outputPath('workflow-editor-narrow-before-check.png'),
        animations: 'disabled',
      });
      expect(
        await stage
          .getByTestId('workflow-library')
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
      for (const field of await stage.locator('input, textarea, select').all()) {
        expect(
          await field.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= 0 && box.right <= window.innerWidth;
          }),
        ).toBe(true);
      }
      await stage.locator('.cb-workflow-steps').scrollIntoViewIfNeeded();
      await stage.locator('.cb-workflow-steps').screenshot({
        path: info.outputPath('workflow-editor-narrow-dark.png'),
        animations: 'disabled',
      });
    }
    expect(await page.evaluate(() => Array.from(window.__cerebroMockFs.entries()))).toEqual(files);
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writes);
  }
});
