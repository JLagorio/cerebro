import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Change type keeps every value (M60.5).
 *
 * Proven against the mock disk, because the claim is about bytes: a lossy
 * change never touches the old property's values, and a lossless one that
 * changes no value writes nothing but the Type doc.
 */

const BETS = [
  'records/bets/bet-office-hours-beat-webinars.md',
  'records/bets/bet-conflict-ui-lowers-support.md',
  'records/bets/bet-named-customer-unlocks-pipeline.md',
  'records/bets/bet-paper-fallback-is-the-real-competitor.md',
];

/** Every file under a folder, as the mock disk holds it. */
const filesUnder = (page: Page, folder: string) =>
  page.evaluate(
    (prefix) =>
      Object.fromEntries(
        [...window.__cerebroMockFs.entries()].filter(([path]) => path.startsWith(prefix)),
      ),
    folder,
  );

const stakeLine = (text: string): string => text.split('\n').find((l) => l.startsWith('stake:'))!;

async function openType(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-type').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();
}

/** Column menu → Edit property → Type: the list KindChangeList draws. */
async function openKindList(page: Page, column: string): Promise<void> {
  await page.getByRole('button', { name: `${column} column menu` }).click();
  await page.getByTestId('edit-property').click();
  await page.getByTestId('property-editor-type').click();
}

test('a lossy change converts into a new property and leaves the old one byte for byte', async ({
  page,
}) => {
  await boot(page);
  await openType(page, 'Bet');

  // -- Set one bet's Stake to 5 in its record panel --------------------
  const row = page.getByTestId('table-row').filter({ hasText: 'Office hours beat webinars' });
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  const toggle = panel.getByTestId('view-details-toggle');
  if ((await toggle.count()) > 0) await toggle.click();
  const stakeRow = panel.locator('[data-testid="property-row"][data-property="stake"]');
  await stakeRow
    .getByRole('button', { name: 'Four weeks of one person, and the Q3 webinar slot' })
    .click();
  // The value's editor takes focus where it opens; replace what it holds.
  const input = page.locator('input:focus, textarea:focus');
  await expect(input).toHaveCount(1);
  await input.fill('5');
  await input.press('Enter');
  await expect
    .poll(async () => stakeLine(await readMockFile(page, BETS[0])))
    .toMatch(/^stake: ['"]?5['"]?$/);
  await page.keyboard.press('Escape');

  const before = await Promise.all(BETS.map(async (p) => stakeLine(await readMockFile(page, p))));

  // -- Stake → Edit property → Type: Number reads "3 won't convert" ---
  await openKindList(page, 'Stake');
  await expect(page.getByTestId('change-type-hint-number')).toHaveText(
    "3 won't convert · Converts into a new property",
  );
  await page.getByTestId('change-type-number').click();
  await expect(page.getByText('Convert "Stake" into a new Number property?')).toBeVisible();
  await page.getByRole('button', { name: 'Convert into a new property' }).click();

  // -- types/bet.md declares stake_number right after stake ------------
  await expect
    .poll(async () => readMockFile(page, 'types/bet.md'))
    .toMatch(/\n {2}stake:[^\n]*\n(?: {4}[^\n]*\n)* {2}stake_number:/);
  // -- That bet holds stake_number: 5, and no stake byte moved ---------
  await expect.poll(async () => readMockFile(page, BETS[0])).toMatch(/\nstake_number: 5\n/);
  const after = await Promise.all(BETS.map(async (p) => stakeLine(await readMockFile(page, p))));
  expect(after).toEqual(before);
  for (const path of BETS.slice(1)) {
    expect(await readMockFile(page, path)).not.toContain('stake_number');
  }
});

test('a lossless change that alters no value writes only the Type doc', async ({ page }) => {
  await boot(page);
  const people = await filesUnder(page, 'people/');
  expect(Object.keys(people).length).toBeGreaterThan(0);
  await openType(page, 'Person');

  await openKindList(page, 'Team');
  await page.getByTestId('change-type-select').click();
  await expect(page.getByTestId('kind-change-body')).toHaveText(
    'Every value converts, and no record changes on disk.',
  );
  await page.getByRole('button', { name: 'Change type' }).click();

  // types/person.md gains the seeded options…
  await expect
    .poll(async () => readMockFile(page, 'types/person.md'))
    .toMatch(/team:\s*\n\s+kind: select\s*\n\s+options:/);
  const typeDoc = await readMockFile(page, 'types/person.md');
  expect(typeDoc).toContain('Field Platform');
  // …and every person file is byte-identical.
  expect(await filesUnder(page, 'people/')).toEqual(people);
});
