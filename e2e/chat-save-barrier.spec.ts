import { expect, test } from '@playwright/test';
import { boot, openDatabase, readMockFile, seedFileBeforeBoot } from './boot';

test('chat keeps a blocked question and reviews it after its page field is saved', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const path = 'records/chat-barrier/specimen.md';
  await seedFileBeforeBoot(
    page,
    'types/chat-barrier.md',
    '---\ntype: Type\nfolder: records/chat-barrier\nfields:\n  estimate: { kind: number }\n---\n# Chat barrier\n',
  );
  await seedFileBeforeBoot(
    page,
    path,
    '---\ntype: Chat barrier\nestimate: 3\n---\n# Barrier specimen\n',
  );
  await boot(page);
  await openDatabase(page, 'Chat barrier');
  const row = page.getByTestId('table-row').filter({ hasText: 'Barrier specimen' });
  await row
    .locator('[data-field-kind="number"]')
    .getByRole('button', { name: '3', exact: true })
    .click();
  const field = page.getByRole('textbox', { name: 'Estimate', exact: true });
  await field.fill('  Infinity  ');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(
    page.getByRole('button', { name: 'Retry saving Estimate', exact: true }),
  ).toBeVisible();
  await page
    .getByTestId('app-rail')
    .getByRole('button', { name: 'Assistant', exact: true })
    .click();
  const panel = page.getByTestId('ai-panel');
  const composer = panel.getByLabel('Message the assistant');
  const composerNode = await composer.elementHandle();
  await composer.fill('wait for me');
  await composer.press('Enter');
  const failure = panel.getByTestId('turn-error');
  await expect(failure).toContainText('Your pages have unsaved changes');
  await expect(
    failure.getByRole('button', { name: 'Review what happened', exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(
    panel.getByTestId('chat-scroll').getByText('wait for me', { exact: true }),
  ).toBeVisible();
  await expect(field).toHaveValue('  Infinity  ');
  expect(await readMockFile(page, path)).toContain('estimate: 3');
  await page.screenshot({ path: info.outputPath('chat-save-blocked.png'), animations: 'disabled' });

  await composer.fill('Keep newer composer words');
  await panel.getByRole('button', { name: 'Minimize conversation' }).click();
  await field.fill('8');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readMockFile(page, path)).toContain('estimate: 8');
  await page.getByTestId('ai-panel-fab').click();
  const inspect = failure.getByRole('button', { name: 'Review what happened', exact: true });
  await inspect.click();
  const review = panel.getByRole('region', { name: 'Review what happened' });
  await expect(review).toBeVisible();
  await expect(review.getByText('wait for me', { exact: true })).toBeVisible();
  await expect(review).toContainText('Your pages have unsaved changes');
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('Keep newer composer words');
  expect(await composer.evaluate((node, original) => node === original, composerNode)).toBe(true);
  await review.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(inspect).toBeFocused();
  await expect(failure).toContainText('Your pages have unsaved changes');
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
  await expect(composer).toHaveValue('Keep newer composer words');
  expect(await composer.evaluate((node, original) => node === original, composerNode)).toBe(true);
  await page.screenshot({
    path: info.outputPath('chat-save-reviewed.png'),
    animations: 'disabled',
  });
});
