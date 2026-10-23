import { expect, test } from '@playwright/test';
import {
  askAssistant,
  boot,
  holdClock,
  openAssistantPanel,
  stepUntil,
  stepUntilSettled,
} from './boot';

/**
 * Model and effort (M91.15): the composer's Model Selector is one trigger
 * and one popover holding the Model and Effort radio groups, which stay open
 * through each pick (§3.3's deliberate deviation from shadcn's two menus),
 * keeping `run-options`, `run-model-*`, `run-effort-*` and the "Model and
 * effort: …" name. The pick rides the conversation's next turn, and it cannot
 * change while a turn is in flight. The mock answers as `mock-<model>`.
 */

test('Model and effort: one popover holds both groups, stays open through each pick, and the turn runs on the pick', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  const picker = panel.getByTestId('run-options');
  await expect(picker).toHaveAccessibleName('Model and effort: Claude Code default');
  await expect(picker).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');

  await picker.click();
  const popover = page.getByRole('dialog', { name: 'Model and effort', exact: true });
  const models = popover.getByRole('radiogroup', { name: 'Model', exact: true });
  const efforts = popover.getByRole('radiogroup', { name: 'Effort', exact: true });
  await expect(models.getByRole('radio', { name: 'Claude Code default' })).toBeChecked();
  await expect(efforts.getByRole('radio', { name: 'Claude Code default' })).toBeChecked();
  await expect(popover.getByRole('textbox', { name: 'Other model' })).toBeVisible();

  // Each pick lands at once and the popover stays open for the other.
  await page.getByTestId('run-model-opus').click();
  await expect(popover).toBeVisible();
  await expect(models.getByRole('radio', { name: 'Opus' })).toBeChecked();
  await expect(picker).toHaveAccessibleName('Model and effort: Opus');
  await page.getByTestId('run-effort-high').click();
  await expect(popover).toBeVisible();
  await expect(efforts.getByRole('radio', { name: 'High', exact: true })).toBeChecked();
  await expect(picker).toHaveAccessibleName('Model and effort: Opus · High');

  // Escape closes it and hands focus back to its trigger.
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');

  // In flight, the pick holds still; the turn runs on it.
  await holdClock(page);
  await askAssistant(page, 'hello');
  await stepUntil(page, () => picker.isDisabled(), 'the turn in flight');
  await stepUntilSettled(page, 1);
  await expect(picker).toBeEnabled();
  await expect(panel.getByTestId('turn-model')).toHaveText('mock-opus');
  await expect(picker).toHaveAccessibleName('Model and effort: Opus · High');
});
