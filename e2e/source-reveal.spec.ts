import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot, readMockFile } from './boot';

const PATH = 'notes/source-reveal.md';
const BODY = '# Source reveal fixture\n\nCafé 😀 before.\n\nThe needle passage is here.\n';
async function search(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('needle passage');
  await page.getByTestId('palette-category-pages').click();
  return page.getByTestId('quick-open-content-result').filter({ hasText: 'Source reveal fixture' });
}
for (const width of [1440, 720]) {
  test(`search reveals once and return restores results at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await seedFileBeforeBoot(page, PATH, BODY);
    await boot(page);
    await (await search(page)).click();
    // A cold dev server may still be loading the lazy editor. Reveal's
    // five-second deadline begins only once its installed DOM is ready.
    await expect(page.getByTestId('doc-page').locator('.bn-editor')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('source-reveal-status')).toContainText(
      'Source passage revealed.',
    );
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString()))
      .toBe('The needle passage is here.');
    expect(await readMockFile(page, PATH)).toBe(BODY);
    await page.screenshot({
      path: info.outputPath(`source-reveal-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Return to results', exact: true }).click();
    await expect(page.getByTestId('quick-open-input')).toHaveValue('needle passage');
    await expect(page.getByTestId('palette-category-pages')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByTestId('quick-open-content-result').filter({ hasText: 'Source reveal fixture' }),
    ).toHaveAttribute('aria-selected', 'true');
  });
}
test('peek promotion keeps source origin and reveal does not write', async ({ page }, info) => {
  const raw = '---\ntype: Task\n---\n\n' + BODY;
  await seedFileBeforeBoot(page, PATH, raw);
  await boot(page);
  await (await search(page)).click();
  const peek = page.getByTestId('detail-panel');
  await expect(peek.getByTestId('source-reveal-status')).toContainText('Source passage revealed.');
  await peek.getByRole('button', { name: 'Open in full page', exact: true }).click();
  await expect(page.getByTestId('doc-page').getByTestId('source-reveal-status')).toContainText(
    'Source passage revealed.',
  );
  await expect(page.getByRole('button', { name: 'Return to results', exact: true })).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(raw);
  await page.screenshot({ path: info.outputPath('promoted-source.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Return to results', exact: true }).click();
  await expect(page.getByTestId('quick-open-input')).toHaveValue('needle passage');
});
test('open beside preserves the origin pane and reuses an existing source holder', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await seedFileBeforeBoot(page, PATH, BODY);
  await boot(page);
  const row = await search(page);
  await row.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-pane-id]')).toHaveCount(2);
  await expect(page.getByTestId('source-reveal-status')).toContainText('Source passage revealed.');
  await (await search(page)).click();
  await expect(page.locator('[data-pane-id]')).toHaveCount(2);
  await expect(page.getByTestId('source-reveal-status')).toContainText('Source passage revealed.');
  expect(await readMockFile(page, PATH)).toBe(BODY);
  await page.screenshot({ path: info.outputPath('beside-source.png'), animations: 'disabled' });
});
test('unsupported wikilink alias retains source context with useful status', async ({
  page,
}, info) => {
  const raw = '# Source reveal fixture\n\n[[other|needle passage]]\n';
  await seedFileBeforeBoot(page, PATH, raw);
  await boot(page);
  await (await search(page)).click();
  await expect(page.getByTestId('source-reveal-status')).toContainText(
    'does not support exact passage reveal',
  );
  await expect(page.getByRole('button', { name: 'Return to results', exact: true })).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(raw);
  await page.screenshot({
    path: info.outputPath('unsupported-source.png'),
    animations: 'disabled',
  });
});
