import { expect, test } from '@playwright/test';
import { openStateLab } from './boot';

test('run access preview distinguishes all five states, keeps controls in bounds, and preserves explicit choices', async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  const states = {
    ready: 'Exact inputs only',
    empty: 'No managed account is ready.',
    'not-recorded': 'The original run was not recorded.',
    partial: 'Exact inputs only · Unavailable',
    unavailable: 'Access is unavailable.',
  } as const;
  for (const state of Object.keys(states) as (keyof typeof states)[]) {
    await page.setViewportSize({ width: state === 'partial' ? 360 : 1000, height: 800 });
    await openStateLab(page, 'managed-access', state);
    const stage = page.getByTestId('lab-stage');
    await expect(stage).toContainText(states[state]);
    const files = await page.evaluate(() => Array.from(window.__cerebroMockFs.entries()));
    const writes = await page.evaluate(() => window.__cerebroMockWrites.length);
    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') {
        if (state !== 'not-recorded')
          await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Close', exact: true })
            .first()
            .click();
        await page.getByTestId('lab-theme').click();
        if (state !== 'not-recorded')
          await stage.getByRole('button', { name: 'Review run access' }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (state !== 'not-recorded') {
        const dialog = page.getByRole('dialog', { name: 'Access for this run' });
        await expect(dialog).toBeVisible();
        expect(
          await dialog.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.right <= window.innerWidth &&
              box.bottom <= window.innerHeight &&
              node.scrollWidth <= node.clientWidth + 1
            );
          }),
        ).toBe(true);
        for (const button of await dialog.getByRole('button').all()) {
          expect(
            await button.evaluate((node) => {
              const box = node.getBoundingClientRect();
              const parent = node.closest('[role="dialog"]')!.getBoundingClientRect();
              return box.left >= parent.left - 0.5 && box.right <= parent.right + 0.5;
            }),
          ).toBe(true);
        }
        const close = dialog.getByRole('button', { name: 'Close', exact: true }).first();
        await close.focus();
        await close.press(
          browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab',
        );
        expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        if (state === 'ready' || state === 'partial' || state === 'unavailable') {
          await page.evaluate(() => document.fonts.ready);
          await dialog.screenshot({
            path: info.outputPath(`access-${state}-${theme}.png`),
            animations: 'disabled',
          });
        }
      }
    }
    if (state === 'unavailable') {
      await page.getByRole('button', { name: 'Reload current access' }).click();
      await expect(page.getByRole('dialog')).toContainText('Current access reloaded.');
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    if (state === 'ready') {
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Account', { exact: true }).click();
      await page.getByRole('option', { name: 'Research workspace · lab-reader' }).click();
      await dialog.getByLabel('Action', { exact: true }).click();
      await page.getByRole('option', { name: 'github.issue.read', exact: true }).click();
      await dialog.getByLabel('Allowed inputs').click();
      await page.getByRole('option', { name: 'Only these exact inputs' }).click();
      const exact = '{"number":9007199254740993.00000000001}';
      await dialog.getByLabel('Exact action inputs').fill(exact);
      await expect(dialog.getByLabel('Exact action inputs')).toHaveValue(exact);
      await dialog.getByRole('button', { name: 'Add action', exact: true }).click();
      await expect(
        dialog.getByRole('region', { name: 'Selected actions' }).getByRole('listitem'),
      ).toHaveCount(2);
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
      await stage.getByRole('button', { name: 'Review run access' }).click();
      await expect(
        dialog.getByRole('region', { name: 'Selected actions' }).getByRole('listitem'),
      ).toHaveCount(2);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(dialog).toContainText('Access saved for this run.');
    }
    expect(await page.evaluate(() => Array.from(window.__cerebroMockFs.entries()))).toEqual(files);
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writes);
  }
});
