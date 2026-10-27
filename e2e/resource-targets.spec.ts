import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, showConceptDetails } from './boot';

const CONCEPT = 'knowledge/metrics/sync-error-rate.md';
const LOCAL = 'notes/resource-target-local.md';
const LOCAL_BODY = '# Source destination\n\nActual local source.\n';
const CONCEPT_BODY = `---
type: Metric
title: Resource classification
lifecycle: stable
sources:
  - id: local
    resource: /notes/resource-target-local.md
    title: Local source
  - id: web
    resource: https://example.com/reference
    title: Web source
  - id: missing
    resource: notes/missing-source.md
    title: Missing source
  - id: scope
    resource: all sync telemetry in the eu-west region
    usage_count: 42000
  - id: unsafe
    resource: 'javascript:alert(1)'
---

# Reading sources

The list preserves what was cited without claiming it was read.
`;

for (const theme of ['light', 'dark'] as const) {
  test(`resource targets preserve real actions and inert descriptions (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 900, height: 1000 });
    await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
    await seedFileBeforeBoot(page, CONCEPT, CONCEPT_BODY);
    await seedFileBeforeBoot(page, LOCAL, LOCAL_BODY);
    await boot(page, { preserveTheme: true });
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('quick-open-input').fill('Resource classification');
    await page
      .getByTestId('quick-open-result')
      .filter({ hasText: 'Resource classification' })
      .first()
      .click();
    const panel = await showConceptDetails(page);
    await expect(page.getByTestId('doc-page')).toContainText(
      'The list preserves what was cited without claiming it was read.',
      { timeout: 20_000 },
    );
    const rows = panel.getByTestId('concept-source');
    await expect(rows).toHaveCount(5);
    const kinds = ['vault', 'url', 'missing', 'descriptor', 'descriptor'];
    for (let index = 0; index < kinds.length; index++) {
      await expect(rows.nth(index)).toHaveAttribute('data-kind', kinds[index]);
      await expect(rows.nth(index).locator(':scope > span').first()).toHaveText(String(index + 1));
    }
    await expect(
      rows.nth(0).getByRole('button', { name: 'Open Local source', exact: true }),
    ).toBeVisible();
    await expect(rows.nth(1).getByRole('link')).toHaveAttribute(
      'href',
      'https://example.com/reference',
    );
    await expect(rows.nth(1).getByRole('link')).toHaveAttribute('target', '_blank');
    await expect(rows.nth(2)).toContainText('Local source missing');
    await expect(rows.nth(3)).toContainText('all sync telemetry in the eu-west region');
    await expect(rows.nth(3)).toContainText('42,000 uses');
    await expect(rows.nth(4)).toContainText('javascript:alert(1)');
    for (let index = 2; index < 5; index++) {
      await expect(
        rows
          .nth(index)
          .locator('a,button,[role="button"],[data-slot="source"],[data-slot="trace-icon"]'),
      ).toHaveCount(0);
    }
    const local = rows.nth(0).getByRole('button', { name: 'Open Local source', exact: true });
    await local.focus();
    await expect(local).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`resource-targets-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-page')).toContainText('Source destination');
    expect(await readMockFile(page, CONCEPT)).toBe(CONCEPT_BODY);
    expect(await readMockFile(page, LOCAL)).toBe(LOCAL_BODY);
  });
}
