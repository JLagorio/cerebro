import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { boot, openDatabase, readMockFile, seedFileBeforeBoot, showPagePanel } from './boot';

const documentPath = 'm94-review/document.md';
const documentBody = `A note kept before the heading in the stored source.\n\n# A workspace for decisions that outlast a meeting\n\nOur shared workspace should make the next action clear without hiding the evidence behind it. This review follows one proposal from early research to a decision the team can revisit.\n\n## What we learned\n\n${Array.from({ length: 6 }, (_, i) => `### Observation ${i + 1}\n\nPeople move between notes, records and conversations throughout the day. Clear titles, predictable controls and retained drafts help them continue their work without rebuilding context.\n\n- Keep the original evidence available.\n- Record uncertainty before acting.\n- Make the next review easy to find.\n`).join('\n')}\n`;
const recordPath = 'm94-review/record.md';
const recordBody = `---\ntype: Comparison record\n${Array.from({ length: 18 }, (_, i) => `field_${i + 1}: ${i % 5 === 0 ? "''" : `Review detail ${i + 1}`}`).join('\n')}\nreview_date: 2026-10-23\nrelated:\n  - '[[m94-review/document]]'\n---\n# Review the complete workspace experience\n\nThis record keeps its properties and authored explanation together.\n`;

async function openFullPage(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(name);
  await page.getByTestId('quick-open-result').filter({ hasText: name }).first().click();
  const peek = page.getByTestId('detail-panel');
  if (await peek.isVisible()) await peek.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-page').locator('[data-page-title] h1')).toHaveText(name);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(8, 8);
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
  const metrics = await page.evaluate(() => {
    const selectors = [
      '[data-testid="pane"]',
      '[data-testid="doc-page"]',
      '[data-page-title] h1',
      '.cb-document-toolbar',
      '[data-testid="page-properties"]',
      '[data-testid="doc-side-panel"]',
      '[data-testid="pages-browser"]',
      '[data-testid="table-view"]',
    ];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      deviceScale: devicePixelRatio,
      cssZoom: getComputedStyle(document.documentElement).zoom,
      theme: document.documentElement.getAttribute('data-theme'),
      overflow: document.documentElement.scrollWidth > innerWidth,
      surfaces: selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((node) => {
          const rect = node.getBoundingClientRect();
          return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      ),
    };
  });
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(metrics, null, 2) + '\n');
  expect(metrics.overflow).toBe(false);
}

for (const theme of ['light', 'dark']) {
  test(`current four-surface baseline in ${theme}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedFileBeforeBoot(page, documentPath, documentBody);
    await seedFileBeforeBoot(
      page,
      'types/comparison-record.md',
      `---\ntype: Type\nfields:\n${Array.from({ length: 18 }, (_, i) => `  field_${i + 1}: { kind: text }`).join('\n')}\n  review_date: { kind: date }\n  related: { kind: relation }\n---\n# Comparison record\n`,
    );
    await seedFileBeforeBoot(page, recordPath, recordBody);
    for (let i = 0; i < 12; i++) {
      await seedFileBeforeBoot(
        page,
        `m94-shelf/page-${i}.md`,
        `# M94 shelf ${i === 2 ? 'A long title about the decisions behind the release and what comes next' : String(i + 1).padStart(2, '0')}\n${i % 3 === 0 ? '' : '\nResearch and planning notes for the upcoming review.\n'}`,
      );
    }
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await openFullPage(page, 'A workspace for decisions that outlast a meeting');
    await capture(page, info, `document-${theme}`);
    expect(await readMockFile(page, documentPath)).toBe(documentBody);
    await openFullPage(page, 'Review the complete workspace experience');
    const properties = page.getByTestId('page-properties');
    if (!(await properties.isVisible())) await page.getByTestId('record-properties-toggle').click();
    await expect(properties.locator('[data-property]')).toHaveCount(20);
    await capture(page, info, `record-properties-${theme}`);
    await showPagePanel(page, 'Details');
    await capture(page, info, `record-panel-${theme}`);
    expect(await readMockFile(page, recordPath)).toBe(recordBody);
    await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
    const browser = page.getByTestId('pages-browser');
    await browser.getByLabel('Search pages').fill('M94 shelf');
    await expect(browser.getByTestId('page-browser-item')).toHaveCount(12);
    await capture(page, info, `pages-list-${theme}`);
    await browser.getByRole('button', { name: 'Grid view' }).click();
    await capture(page, info, `pages-grid-${theme}`);
    await openDatabase(page, 'Work item');
    await page.getByTestId('view-tab-at-risk-work').click();
    await expect(page.getByTestId('table-row')).toHaveCount(13);
    await capture(page, info, `table-${theme}`);
  });
}
