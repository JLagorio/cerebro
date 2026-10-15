import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

async function editProperty(page: Page, name: string) {
  await page.getByRole('button', { name: `${name} column menu`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit property', exact: true }).click();
}
async function sumColumn(page: Page, name: string) {
  await page.getByRole('button', { name: `${name} column menu`, exact: true }).click();
  await page.getByTestId('calculate').click();
  await page.getByTestId('calc-option-sum').click();
}

test('formulas compute on read, follow renames, protect inputs and count skipped values', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2400, height: 1080 });
  await boot(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Key result' }).first().click();
  await page.getByTestId('add-column').click();
  await page.getByTestId('show-column-current_value').click();
  await page.getByTestId('add-column').click();
  const panel = page.getByTestId('add-property-panel');
  await panel.getByLabel('Property name').fill('Gap');
  await panel.getByTestId('property-kind-formula').click();
  await expect.poll(() => readMockFile(page, 'types/key-result.md')).toMatch(/kind: formula/);
  await editProperty(page, 'Gap');
  await page.getByTestId('formula-input').fill('{Target value} - current_value');
  await expect(page.getByTestId('formula-result')).toContainText('number');
  await page.getByTestId('formula-save').click();
  await expect
    .poll(() => readMockFile(page, 'types/key-result.md'))
    .toContain('formula: target_value - current_value');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const webinar = page
    .getByTestId('table-row')
    .filter({ hasText: 'Field champions webinar hits 200 attendees' });
  await expect(webinar.getByRole('gridcell').last()).toHaveText('70');

  // Clear a stored input through the ordinary field editor. The output must
  // become absent even though the target is still 70.
  const weekly = page.getByTestId('table-row').filter({ hasText: 'Weekly active crews' });
  await weekly.getByText('41', { exact: true }).click();
  const input = weekly.getByRole('textbox');
  await input.fill('');
  await input.press('Enter');
  await expect(weekly.getByRole('gridcell').last()).toHaveText('—');
  await expect
    .poll(() => readMockFile(page, 'records/key-results/kr-weekly-active-crews.md'))
    .not.toMatch(/current_value: 41/);

  await sumColumn(page, 'Gap');
  await expect(page.getByTestId('calc-gap')).toContainText('373.6');
  await expect(page.getByTestId('calc-skipped-gap')).toHaveText('· 1 skipped');
  await expect(page.getByTestId('calc-skipped-gap')).toHaveAttribute(
    'title',
    '1 row has no number here, so the sum leaves it out.',
  );
  await sumColumn(page, 'Current value');
  await expect(page.getByTestId('calc-current_value')).toContainText('519.4');
  await expect(page.getByTestId('calc-skipped-current_value')).toHaveText('· 1 skipped');

  await editProperty(page, 'Current value');
  await page.getByRole('textbox', { name: 'Rename Current value', exact: true }).fill('Current');
  await page.getByRole('textbox', { name: 'Rename Current value', exact: true }).press('Enter');
  await expect
    .poll(() => readMockFile(page, 'types/key-result.md'))
    .toContain('formula: target_value - current');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(webinar.getByRole('gridcell').last()).toHaveText('70');
  await editProperty(page, 'Target value');
  await page.getByRole('button', { name: 'Delete property', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete "Target value"?' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(
    page.getByText(
      "Can't delete “Target value”: the formula “Gap” reads it. Change that formula first.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(() => readMockFile(page, 'types/key-result.md')).toMatch(/target_value:/);
});
