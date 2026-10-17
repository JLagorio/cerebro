import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, openDestination } from './boot';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=';
async function watch(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('images.example')) requests.push(request.url());
  });
  await page.route('**://images.example/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(PNG, 'base64') }),
  );
  return requests;
}
test('a mounted README makes no image request until Load and refuses HTTP', async ({ page }) => {
  const requests = await watch(page);
  await boot(page);
  await page.evaluate(() => {
    const roots = (
      window as unknown as {
        __cerebroMockRoots: {
          resetMockRoots(): void;
          seedRoot(seed: { path: string; label: string }): unknown;
          seedFile(root: string, path: string, text: string): void;
        };
      }
    ).__cerebroMockRoots;
    roots.resetMockRoots();
    roots.seedRoot({ path: '/repos/images', label: 'images' });
    roots.seedFile(
      '/repos/images',
      'README.md',
      '# Images\n\n![Badge](https://images.example/badge.png)\n\n![Insecure](http://images.example/no.png)',
    );
  });
  await openDestination(page, 'Work');
  await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'images' }).click();
  await page
    .getByTestId('root-tree')
    .getByTestId('tree-row')
    .filter({ hasText: 'README.md' })
    .click();
  const viewer = page.getByTestId('doc-viewer');
  await expect(viewer.getByText('images.example')).toBeVisible();
  await expect(viewer.getByText('HTTP images are not allowed.')).toBeVisible();
  await expect(viewer.locator('img')).toHaveCount(0);
  expect(requests).toEqual([]);
  await page.screenshot({
    path: '/private/tmp/cerebro-remote-image-gate.png',
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: 'Load image' }).click();
  await expect
    .poll(() =>
      viewer
        .getByRole('img', { name: 'Badge' })
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBe(1);
  expect(requests).toEqual(['https://images.example/badge.png']);
  await expect(viewer.getByRole('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
});
test('editor saves and copies stay inert, Load works, and Mermaid never requests images', async ({
  page,
}) => {
  const requests = await watch(page);
  const path = 'notes/remote-images.md';
  const image = '![](https://images.example/hero.png)';
  await seedFileBeforeBoot(
    page,
    path,
    `# Remote images\n\nBefore\n\n${image}\n\n\`\`\`mermaid\nflowchart TD\n A@{ "img": "https://images.example/diagram.png", label: "Diagram" }\n classDef hot fill:u\\72l(https://images.example/escaped.png)\n class A hot\n classDef picture background-image:image-set("https://images.example/set.png" 1x)\n class A picture\n\`\`\`\n`,
  );
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Remote images');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Remote images' }).first().click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByRole('button', { name: 'Load image' })).toBeVisible();
  await expect(editor.locator('.cb-remote-image img')).toHaveCount(0);
  const before = editor.locator('.bn-inline-content').filter({ hasText: /^Before$/ });
  await before.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' changed');
  await expect.poll(() => readMockFile(page, path)).toContain('Before changed');
  await page.evaluate(() => {
    const image = document.querySelector('.cb-remote-image')!;
    const range = document.createRange();
    range.selectNode(image);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('.bn-editor')!.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    editor.getByTestId('mermaid-diagram').locator('svg[id^="cerebro-mermaid-"]'),
  ).toHaveCount(1);
  expect(requests).toEqual([]);
  expect(await readMockFile(page, path)).toContain(image);
  await editor.getByRole('button', { name: 'Load image' }).click();
  const photo = editor.locator('.cb-remote-image img');
  await expect.poll(() => photo.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  expect(requests).toEqual(['https://images.example/hero.png']);
  expect(await readMockFile(page, path)).toContain(image);
  await page.screenshot({ path: '/private/tmp/cerebro-remote-images.png', animations: 'disabled' });
});

test('diagram directives and encoded HTML labels cannot load a resource', async ({ page }) => {
  const requests = await watch(page);
  const diagram = String.raw`%%{init: {"themeCSS":"@import url(https://images.example/theme.css);","themeVariables":{"fontFamily":"x; background-image:url(https://images.example/font.png)"}}}%%
flowchart TD
 A["<span style='background-image:u\72l(https://images.example/label.png)'>Safe label</span>"]
 B["&lt;img src=&quot;https://images.example/entity.png&quot;&gt;Safe entity"]
 C@{ "\u0069mg": "https://images.example/key.png", label: "Safe shape" }
 A --> B --> C`;
  await seedFileBeforeBoot(
    page,
    'notes/diagram-images.md',
    `# Diagram images\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`,
  );
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Diagram images');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Diagram images' }).first().click();
  await expect(
    page.getByTestId('mermaid-diagram').locator('svg[id^="cerebro-mermaid-"]'),
  ).toHaveCount(1);
  expect(requests).toEqual([]);
});
