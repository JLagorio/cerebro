import { expect, test } from '@playwright/test';
import { openStateLab } from './boot';

test('credential preview distinguishes five states and keeps the original cancellable import in both themes', async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(60_000);
  const states = {
    ready: 'Credential stored for lab-reader.',
    empty: 'Select an account above',
    'not-recorded': 'No credential recorded for lab-reader.',
    partial: 'Importing credential for lab-reader',
    unavailable: 'Import status is unavailable.',
  } as const;
  const allControls = browserName === 'webkit' && process.platform === 'darwin';
  for (const state of Object.keys(states) as (keyof typeof states)[]) {
    await page.setViewportSize({ width: state === 'partial' ? 480 : 1100, height: 800 });
    await openStateLab(page, 'managed-credential', state);
    const stage = page.getByTestId('lab-stage');
    await expect(stage).toContainText(states[state]);
    await expect(stage).toContainText('Actions require separate permission');
    await expect(stage.getByRole('textbox')).toHaveCount(0);
    await expect(stage.getByRole('button', { name: /^(Import|Replace) credential/ })).toHaveCount(
      0,
    );
    const files = await page.evaluate(() => Array.from(window.__cerebroMockFs.entries()));
    const writes = await page.evaluate(() => window.__cerebroMockWrites.length);
    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') await page.getByTestId('lab-theme').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (state === 'partial' || state === 'unavailable') {
        const check = stage.getByRole('button', { name: 'Check import status' });
        const cancel = stage.getByRole('button', { name: 'Cancel import for lab-reader' });
        expect(
          await cancel.evaluate((node) => {
            const button = node.getBoundingClientRect();
            const container = node.parentElement!.getBoundingClientRect();
            return button.left >= container.left - 0.5 && button.right <= container.right + 0.5;
          }),
        ).toBe(true);
        await check.focus();
        await check.press(allControls ? 'Alt+Tab' : 'Tab');
        await expect(cancel).toBeFocused();
        expect(await cancel.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
        await expect(cancel).not.toHaveCSS('box-shadow', 'none');
      }
      if (state === 'ready' || state === 'partial' || state === 'unavailable') {
        await page.evaluate(() => document.fonts.ready);
        await stage.screenshot({
          path: info.outputPath(`credential-${state}-${theme}.png`),
          animations: 'disabled',
        });
      }
    }
    if (state === 'unavailable') {
      await stage.getByRole('button', { name: 'Check import status' }).click();
      await expect(stage.getByRole('alert')).toHaveCount(0);
      await expect(stage).toContainText('Importing credential for lab-reader');
    }
    if (state === 'partial' || state === 'unavailable') {
      await stage.getByRole('button', { name: 'Cancel import for lab-reader' }).click();
      await expect(stage).toContainText('Import cancelled for lab-reader');
      await expect(stage.getByRole('button', { name: 'Cancel import for lab-reader' })).toHaveCount(
        0,
      );
    }
    expect(await page.evaluate(() => Array.from(window.__cerebroMockFs.entries()))).toEqual(files);
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writes);
  }
});
