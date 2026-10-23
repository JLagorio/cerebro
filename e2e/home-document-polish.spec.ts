import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`Home gives actual work a clear first view in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
    const home = page.locator('.cb-home');
    const work = home.locator('[data-lane="mywork"]');
    const entry = home.getByRole('button', { name: /What would you like to work on/ });
    await expect(work.getByTestId('home-row').first()).toBeVisible();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      // WebKit's non-overlay scrollbar occupies part of the outer box.
      // Content centres in the scrollport, not in that scrollbar's gutter.
      const canvas = await home.evaluate((node) => ({
        x: node.getBoundingClientRect().x,
        width: node.clientWidth,
      }));
      const ask = await entry.boundingBox();
      const lane = await work.boundingBox();
      const row = await work.getByTestId('home-row').first().boundingBox();
      expect(ask!.width).toBeGreaterThan(600);
      expect(ask!.width).toBeLessThanOrEqual(880);
      expect(Math.abs(ask!.x + ask!.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(2);
      expect(lane!.y).toBeLessThan(500);
      expect(row!.height).toBeGreaterThanOrEqual(48);
      await expect(home.getByRole('button', { name: 'New page', exact: true })).toBeVisible();
      await expect(home.getByRole('button', { name: 'New whiteboard', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.mouse.move(1, 500);
      await page.screenshot({ path: info.outputPath(`home-${theme}-${width}.png`) });
    }
    const learned = home.getByTestId('learned-card');
    await expect(learned).toHaveCount(1);
    expect(
      await learned.evaluate((node) => {
        const lanes = document.querySelector('.cb-home-lanes');
        return (
          lanes !== null &&
          Boolean(lanes.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);
    await home.getByRole('button', { name: 'New page', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New page', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await home.getByRole('button', { name: 'Find something', exact: true }).click();
    await expect(page.getByTestId('quick-open-input')).toBeFocused();
  });

  test(`ordinary document prose has a reading rhythm without changing its bytes in ${theme}`, async ({
    page,
  }, info) => {
    const path = 'reading-room.md';
    const paragraph =
      'A focused page gives an idea room to develop. The workspace keeps the writing at the centre, with familiar controls close by when you need them.';
    const source = `---\nsummary: Keep this metadata\n---\n\n# A place to think\n\n${paragraph}\n\n## Working notes\n\nMake the next step clear, then leave enough space to read it.\n\n\`\`\`ts\nconst message = 'The code keeps its own scale';\n\`\`\`\n\n- One useful detail\n- Another useful detail\n`;
    await seedFileBeforeBoot(page, path, source);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByTestId('quick-open-input').fill('A place to think');
    await page
      .getByTestId('quick-open-result')
      .filter({ hasText: 'A place to think' })
      .first()
      .click();
    const editor = page.getByTestId('markdown-editor');
    const prose = editor.getByText(paragraph, { exact: true });
    await expect(prose).toBeVisible();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(prose).toHaveCSS('font-size', '16px');
      await expect(prose).toHaveCSS('line-height', '28px');
      await expect(
        editor.getByRole('heading', { name: 'A place to think', exact: true }),
      ).toHaveCSS('font-size', '40px');
      const code = editor.locator('[data-content-type="codeBlock"]');
      expect(
        await code.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
      ).toBeLessThan(16);
      const proseBox = await prose.boundingBox();
      const headingBox = await editor
        .getByRole('heading', { name: 'Working notes', exact: true })
        .boundingBox();
      expect(headingBox!.y - (proseBox!.y + proseBox!.height)).toBeGreaterThanOrEqual(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeVisible();
      await page.mouse.move(1, 500);
      await page.screenshot({ path: info.outputPath(`document-${theme}-${width}.png`) });
    }
    expect(await readMockFile(page, path)).toBe(source);
    await prose.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A saved thought.');
    await expect.poll(() => readMockFile(page, path)).toContain('A saved thought.');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readMockFile(page, path)).not.toContain('A saved thought.');
    expect(await readMockFile(page, path)).toContain('summary: Keep this metadata');
  });
}
