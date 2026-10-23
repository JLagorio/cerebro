import { expect, test } from '@playwright/test';
import { boot, openDatabase, openDestination, seedFileBeforeBoot } from './boot';

test('record metadata reads as an editable byline beneath one page title', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const path = 'projects/field-app-launch-campaign/items/lnc-3.md';
  const before = await page.evaluate((file) => window.__cerebroMockFs.get(file), path);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('quick-open-input').fill('Launch email sequence');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Launch email sequence' })
    .first()
    .click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  const title = page.getByTestId('markdown-editor').locator('[data-page-title] h1');
  await expect(title).toHaveText('Launch email sequence (3 touches)');
  await expect(title).toHaveCSS('font-size', '40px');
  const strip = page.getByTestId('heading-strip');
  const status = strip.locator('[data-field="status"]');
  const label = status.locator('.cb-heading-property-label');
  const value = status.locator('[data-cell-primary]');
  await expect(value).toBeVisible();
  const headingBox = (await title.boundingBox())!;
  const stripBox = (await strip.boundingBox())!;
  const labelBox = (await label.boundingBox())!;
  const valueBox = (await value.boundingBox())!;
  expect(stripBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
  expect(Math.abs(stripBox.x - headingBox.x)).toBeLessThanOrEqual(4);
  expect(
    Math.abs(labelBox.y + labelBox.height / 2 - valueBox.y - valueBox.height / 2),
  ).toBeLessThanOrEqual(2);
  expect(valueBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
  expect(stripBox.height).toBeLessThanOrEqual(36);
  await value.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('record-byline.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeVisible();
  await expect(page.getByTestId('view-details-toggle')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
  expect(await page.evaluate((file) => window.__cerebroMockFs.get(file), path)).toBe(before);
});

for (const theme of ['light', 'dark'] as const) {
  test(`document canvas keeps readable space across desktop widths in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    if (theme === 'dark') {
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    }
    await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByTestId('quick-open-input').fill('How we schedule');
    await page
      .getByTestId('quick-open-result')
      .filter({ hasText: 'How we schedule' })
      .first()
      .click();
    await expect(
      page.getByTestId('markdown-editor').getByText('Windows, not deadlines'),
    ).toBeVisible();
    await page.mouse.move(700, 80);
    for (const width of [1440, 1280, 1024, 900, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const column = await page.getByTestId('doc-column').boundingBox();
      const content = await page.getByTestId('doc-content').boundingBox();
      const rail = await page.getByTestId('app-rail').boundingBox();
      expect(column!.width).toBeGreaterThanOrEqual(400);
      expect(content!.width).toBeLessThanOrEqual(880);
      expect(rail!.width).toBe(54);
      expect(rail!.x).toBe(0);
      expect(content!.x + content!.width).toBeLessThanOrEqual(width);
      await expect(page.getByRole('button', { name: 'Page options' })).toBeVisible();
      if (width === 1440 || width === 900) {
        await page.screenshot({
          path: info.outputPath(`document-${theme}-${width}.png`),
          animations: 'disabled',
        });
      }
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`a rich document keeps long content within its reading frame in ${theme}`, async ({
    page,
  }, info) => {
    const title =
      'Workspace visual review — a deliberately long page title describing a complex project with several decisions and a detailed delivery schedule';
    const columns = Array.from({ length: 8 }, (_, index) => `Column ${index + 1}`);
    const body = `---\ncover: blue\n---\n\n# ${title}\n\n## Working notes\n\nA readable paragraph before the wide content.\n\n\`\`\`ts\nconst values = [${Array.from({ length: 80 }, (_, index) => `'item-${index}'`).join(', ')}];\n\`\`\`\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.map(() => 'A detailed value for review').join(' | ')} |\n`;
    await seedFileBeforeBoot(page, 'visual-review.md', body);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByTestId('quick-open-input').fill('Workspace visual review');
    await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
    await expect(page.getByTestId('markdown-editor').locator('[data-page-title] h1')).toHaveText(
      title,
    );
    await expect(
      page.getByTestId('markdown-editor').getByText('Working notes', { exact: true }),
    ).toBeVisible();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const titleHeading = page
        .getByTestId('markdown-editor')
        .getByRole('heading', { name: title, level: 1 });
      await expect(titleHeading).toBeVisible();
      await expect(titleHeading).toHaveCSS('font-size', '40px');
      const code = page
        .getByTestId('markdown-editor')
        .locator('[data-content-type="codeBlock"] code');
      await expect(code).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const titleBox = await titleHeading.boundingBox();
      const frame = await page.getByTestId('doc-column').boundingBox();
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
      await page.screenshot({ path: info.outputPath(`rich-document-${theme}-${width}.png`) });
    }
    expect(await page.evaluate(() => window.__cerebroMockFs.get('visual-review.md'))).toBe(body);
  });
}

test('Studio lends its page picker to the sidebar and keeps its preview through drawer changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await openDestination(page, 'Studio');
  await page.getByTestId('studio-new').click();
  await page.getByLabel('Prototype name').fill('Reading room');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const preview = page.getByTestId('studio-preview');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.getByTestId('studio-page-row')).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Reading room' })).toBeVisible();
  const side = await sidebar.boundingBox();
  const canvas = await preview.boundingBox();
  expect(Math.abs(canvas!.x - (side!.x + side!.width))).toBeLessThanOrEqual(2);
  const original = await preview.elementHandle();
  const originalBytes = await page.evaluate(() =>
    window.__cerebroMockFs.get('studio/reading-room/index.md'),
  );
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(sidebar).toBeHidden();
  await preview.getByRole('button', { name: 'Prototype pages' }).click();
  await expect(sidebar.getByTestId('studio-page-row')).toBeVisible();
  await sidebar.getByTestId('studio-page-row').click();
  await expect(sidebar).toBeHidden();
  await expect(preview.getByRole('button', { name: 'Prototype pages' })).toBeFocused();
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(preview.getByRole('heading', { name: 'Reading room' })).toBeVisible();
  expect(
    await page.evaluate(() => window.__cerebroMockFs.get('studio/reading-room/index.md')),
  ).toBe(originalBytes);
});

for (const theme of ['light', 'dark'] as const) {
  test(`workspace page hierarchy stays readable in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await boot(page);
    if (theme === 'dark') {
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    }
    for (const name of ['My work', 'Library', 'Knowledge', 'Database'] as const) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      if (name === 'Database') await openDatabase(page, 'Project');
      else await openDestination(page, name);
      const surface = page.getByTestId(
        name === 'My work'
          ? 'mywork-page'
          : name === 'Library'
            ? 'library-page'
            : name === 'Knowledge'
              ? 'knowledge-page'
              : 'type-page',
      );
      await expect(surface).toBeVisible();
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 1000 });
        const heading = surface.locator('.cb-page-heading');
        await expect(heading).toBeVisible();
        await expect
          .poll(() => heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
          .toBeGreaterThanOrEqual(20);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual(width);
        const box = await heading.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        if (name === 'My work') {
          const row = await surface.getByTestId('mywork-row').first().boundingBox();
          expect(row?.height).toBeGreaterThanOrEqual(46);
        }
        if (name === 'Library') {
          await expect(
            surface.getByRole('button', { name: 'New skill', exact: true }),
          ).toBeVisible();
          const card = await surface.getByTestId('library-card').first().boundingBox();
          expect(card?.width).toBeGreaterThanOrEqual(260);
          const title = await surface
            .getByTestId('library-card')
            .first()
            .locator('button > span')
            .first()
            .boundingBox();
          expect(title!.x + title!.width).toBeLessThanOrEqual(card!.x + card!.width);
        }
        if (name === 'Knowledge') {
          await expect(surface.getByTestId('knowledge-summary')).toBeVisible();
          await expect(surface.getByTestId('knowledge-start-review')).toBeVisible();
        }
        await page.screenshot({
          path: info.outputPath(`${name.toLowerCase().replaceAll(' ', '-')}-${theme}-${width}.png`),
        });
      }
    }
  });
}

test('Library keeps a bounded shelf and usable controls from wide to compact windows', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await boot(page);
  await openDestination(page, 'Library');
  const library = page.getByTestId('library-page');
  const originalFiles = await page.evaluate(() => [...window.__cerebroMockFs]);
  for (const width of [1920, 900, 640]) {
    await page.setViewportSize({ width, height: 900 });
    const heading = await library
      .getByRole('heading', { name: 'Library', exact: true })
      .boundingBox();
    const shelf = await library.locator('.cb-library-grid').boundingBox();
    const card = await library.getByTestId('library-card').first().boundingBox();
    const newSkill = await library
      .getByRole('button', { name: 'New skill', exact: true })
      .boundingBox();
    expect(Math.abs(heading!.x - shelf!.x)).toBeLessThanOrEqual(1);
    expect(shelf!.width).toBeLessThanOrEqual(1120);
    expect(card!.width).toBeGreaterThanOrEqual(260);
    if (width === 1920) expect(card!.width).toBeLessThanOrEqual(400);
    // This action explicitly chooses the shared compact control role.
    expect(newSkill!.height).toBe(28);
    expect(newSkill!.x + newSkill!.width).toBeLessThanOrEqual(width);
    await expect(library.getByRole('textbox', { name: 'Search the library' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: info.outputPath(`library-shelf-${width}.png`) });
  }
  await library.getByTestId('library-tab-skill').focus();
  await page.keyboard.press('ArrowRight');
  await expect(library.getByTestId('library-tab-agent')).toHaveAttribute('aria-selected', 'true');
  await expect(library.getByTestId('library-tab-agent')).toBeFocused();
  await expect(
    library.getByTestId('library-card').first().getByTestId('library-tag').first(),
  ).toBeVisible();
  const search = library.getByRole('textbox', { name: 'Search the library' });
  await search.fill('No matching agent for this query');
  await expect(
    library.getByText('Nothing matches “No matching agent for this query”'),
  ).toBeVisible();
  await search.clear();
  await expect(library.getByTestId('library-card').first()).toBeVisible();
  expect(await page.evaluate(() => [...window.__cerebroMockFs])).toEqual(originalFiles);
});
