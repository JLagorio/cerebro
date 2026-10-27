import { expect, test } from '@playwright/test';
import { openStateLab } from './boot';

for (const state of ['ready', 'empty', 'not-recorded', 'partial', 'unavailable'] as const) {
  test(`agent connector inventory: ${state}`, async ({ page }) => {
    await openStateLab(page, 'agent-connector-inventory', state);
    await expect(page.getByTestId('agent-connector-inventory')).toHaveAttribute(
      'data-state',
      state,
    );
    await expect(page.getByTestId('agent-prop-tools')).toBeVisible();
    if (state === 'unavailable') {
      await expect(page.getByRole('button', { name: 'Retry connectors' })).toBeVisible();
      await expect(page.getByTestId('lab-stage')).not.toContainText(
        'This vault has no connectors enabled',
      );
    }
  });
}

test('agent connector Retry retains the open grant draft', async ({ page }) => {
  await openStateLab(page, 'agent-connector-inventory', 'unavailable');
  await expect(page.getByRole('button', { name: 'Retry connectors' })).toBeVisible();
  await page.getByTestId('agent-prop-connectors').getByTestId('agent-prop-open').click();
  const editor = page.getByTestId('agent-editor-connectors');
  await editor.getByRole('button', { name: 'Remove github' }).click();
  await page.getByRole('button', { name: 'Retry connectors' }).click();
  await expect(page.getByTestId('agent-connector-inventory')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Remove github' })).toHaveCount(0);
  await expect(editor).toContainText('None — it reaches no external system.');
  // The closed row remains the stored grant until the person's Done.
  await expect(
    page.getByTestId('agent-prop-connectors').getByTestId('agent-prop-open'),
  ).toContainText('github');
});
