import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

const PATH = 'notes/m94-native-control-theme.md';
const TITLE = 'Native control theme journey';
const BODY =
  '# ' +
  TITLE +
  '\n\n- [ ] Keep the custom checklist appearance\n\n' +
  '```cerebro-database\ndatabase: Epic\nview: all\n```\n';

test('embedded native selection controls follow the real theme without resetting the editor', async ({
  page,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedFileBeforeBoot(page, PATH, BODY);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(TITLE);
  await page.getByTestId('quick-open-result').filter({ hasText: TITLE }).first().click();
  const host = page.getByTestId('doc-page');
  const editor = host.getByTestId('markdown-editor');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(host.locator('[data-page-title] h1')).toHaveText(TITLE);
  const editorOwner = await editor.elementHandle();
  const vendor = editor.locator('.bn-container.bn-mantine');
  const embedded = editor.getByTestId('database-block');
  const rowBoxes = embedded.getByTestId('row-select');
  const all = embedded.getByTestId('select-all');
  await expect(rowBoxes).toHaveCount(4);
  const first = rowBoxes.first();
  const nativeOwner = await first.elementHandle();
  const custom = editor.locator(
    '.bn-block-content[data-content-type="checkListItem"] input[type="checkbox"]',
  );
  await expect(custom).toHaveCount(1);
  const source = await readMockFile(page, PATH);
  const writes = await page.evaluate(
    (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
    PATH,
  );
  await host.evaluate((node) => {
    const host = node as HTMLElement;
    host.style.flex = '0 0 auto';
    host.style.maxWidth = 'none';
    host.style.width = '360px';
    host.style.width = 360 + host.offsetWidth - host.clientWidth + 'px';
  });
  await expect.poll(() => host.evaluate((node) => node.clientWidth)).toBe(360);
  await page.evaluate(() => document.fonts.ready);

  for (const [index, theme] of ['light', 'dark', 'light'].entries()) {
    if (theme === 'dark') {
      await page
        .getByTestId('app-rail')
        .getByRole('button', { name: 'Theme: light', exact: true })
        .click();
    } else if (index === 2) {
      await page
        .getByTestId('app-rail')
        .getByRole('button', { name: 'Theme: dark', exact: true })
        .click();
      await page
        .getByTestId('app-rail')
        .getByRole('button', { name: 'Theme: system', exact: true })
        .click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await first.focus();
    await expect(first).not.toBeChecked();
    const geometry = await first.boundingBox();
    expect(geometry).not.toBeNull();
    expect(geometry!.width).toBe(14);
    expect(geometry!.height).toBe(14);
    const schemes = await first.evaluate((node) => ({
      root: getComputedStyle(document.documentElement).colorScheme,
      vendor: getComputedStyle(node.closest('.bn-mantine')!).colorScheme,
      native: getComputedStyle(node).colorScheme,
      appearance: getComputedStyle(node).appearance,
    }));
    await info.attach('native-control-schemes-' + index + '-' + theme, {
      body: JSON.stringify({ theme, geometry, schemes }),
      contentType: 'application/json',
    });
    await embedded.screenshot({
      path: info.outputPath('native-unchecked-' + index + '-' + theme + '.png'),
      animations: 'disabled',
    });
    expect(schemes.root).toBe(theme);
    await expect(vendor).toHaveCSS('color-scheme', theme);
    await expect(first).toHaveCSS('color-scheme', theme);
    expect(schemes.appearance).not.toBe('none');
    await expect(custom).toHaveCSS('appearance', 'none');
    await expect(first).toBeFocused();
    await expect(first).toHaveCSS('opacity', '1');
    // Traverse actual controls so focus-visible is keyboard-derived, rather
    // than relying only on a programmatic focus assertion or hover paint.
    // macOS WebKit uses Option-Tab to include buttons in keyboard traversal.
    // https://support.apple.com/guide/safari/keyboard-shortcuts-and-gestures-cpsh003/mac
    const allControlsTab = browserName === 'webkit' && process.platform === 'darwin';
    await first.press(allControlsTab ? 'Alt+Tab' : 'Tab');
    const rowAction = embedded.getByTestId('row-menu').first();
    await expect(rowAction).toBeFocused();
    await expect(rowAction).toHaveCSS('opacity', '1');
    await rowAction.press(allControlsTab ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(first).toBeFocused();
    expect(await first.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
    await expect(first).toHaveCSS('opacity', '1');
    await embedded.screenshot({
      path: info.outputPath('native-keyboard-unchecked-' + index + '-' + theme + '.png'),
      animations: 'disabled',
    });
    await first.press('Space');
    await expect(first).toBeChecked();
    await expect(all).toHaveJSProperty('indeterminate', true);
    await expect(first).toBeFocused();
    await embedded.screenshot({
      path: info.outputPath('native-mixed-' + index + '-' + theme + '.png'),
      animations: 'disabled',
    });
    await all.focus();
    await all.press('Space');
    for (const checkbox of await rowBoxes.all()) await expect(checkbox).toBeChecked();
    await expect(all).toHaveJSProperty('indeterminate', false);
    await embedded.screenshot({
      path: info.outputPath('native-checked-' + index + '-' + theme + '.png'),
      animations: 'disabled',
    });
    await all.press('Space');
    for (const checkbox of await rowBoxes.all()) await expect(checkbox).not.toBeChecked();
    await expect(all).toBeFocused();
    await expect(all).toHaveCSS('opacity', '1');
    expect(await all.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
    await embedded.screenshot({
      path: info.outputPath('native-header-keyboard-unchecked-' + index + '-' + theme + '.png'),
      animations: 'disabled',
    });
    expect(await editorOwner!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await nativeOwner!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(editor).toHaveCount(1);
    expect(await readMockFile(page, PATH)).toBe(source);
    expect(
      await page.evaluate(
        (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
        PATH,
      ),
    ).toBe(writes);
  }
});
