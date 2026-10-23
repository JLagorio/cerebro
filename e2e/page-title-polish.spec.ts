import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot } from './boot';

async function openPage(page: Page, title: string) {
  await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('quick-open-input').fill(title);
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}

for (const leading of [true, false]) {
  test(`the ${leading ? 'leading' : 'nonleading'} H1 is one native title with unchanged source order`, async ({
    page,
  }, info) => {
    const title = 'Title projection specimen';
    const bytes = `${leading ? '' : 'A paragraph stored before the title.\n\n'}# ${title}\n\nThe first writing paragraph.\n\n# Another section\n\nSection text.\n`;
    await seedFileBeforeBoot(page, 'title-projection.md', bytes);
    await boot(page);
    await openPage(page, title);
    const heading = page
      .getByTestId('markdown-editor')
      .getByRole('heading', { name: title, exact: true });
    await expect(heading).toHaveCount(1);
    const firstText = page.getByText(
      leading ? 'The first writing paragraph.' : 'A paragraph stored before the title.',
      { exact: true },
    );
    expect((await heading.boundingBox())!.y).toBeLessThan((await firstText.boundingBox())!.y);
    await expect(heading).toHaveCSS('font-size', '40px');
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(heading).toBeVisible();
    expect(await page.evaluate(() => window.__cerebroMockFs.get('title-projection.md'))).toBe(
      bytes,
    );
    await heading.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      (node.closest('[contenteditable=true]') as HTMLElement).focus();
    });
    await page.keyboard.type(' edited');
    await expect
      .poll(() => page.evaluate(() => window.__cerebroMockFs.get('title-projection.md')))
      .toContain(`# ${title} edited`);
    const edited = await page.evaluate(() => window.__cerebroMockFs.get('title-projection.md'));
    if (!leading) expect(edited!.indexOf('A paragraph')).toBeLessThan(edited!.indexOf('# Title'));
    await page.keyboard.press('ControlOrMeta+z');
    await expect(heading).toHaveText(title);
    await heading.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      (node.closest('[contenteditable=true]') as HTMLElement).focus();
    });
    await page.keyboard.press('ArrowDown');
    const selected = await page.evaluate(
      () =>
        window.getSelection()?.anchorNode?.parentElement?.closest('.bn-block-content')?.textContent,
    );
    expect(selected).toBe(
      leading ? 'The first writing paragraph.' : 'A paragraph stored before the title.',
    );
    await page.screenshot({
      path: info.outputPath(`title-${leading ? 'leading' : 'nonleading'}.png`),
      animations: 'disabled',
    });
  });
}

test('a filename title writes no H1 until the person adopts it', async ({ page }) => {
  const bytes = 'Body without a title.\n';
  await seedFileBeforeBoot(page, 'untitled-specimen.md', bytes);
  await boot(page);
  await openPage(page, 'Untitled specimen');
  const title = page.getByTestId('doc-title-heading');
  await expect(title).toBeVisible();
  expect(await page.evaluate(() => window.__cerebroMockFs.get('untitled-specimen.md'))).toBe(bytes);
  await title.fill('Adopted title');
  await page.getByRole('heading', { name: 'Adopted title', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Adopted title', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('untitled-specimen.md')))
    .toContain('# Adopted title');
});

async function titleCaret(page: Page, title: string, at: 'start' | 'end' = 'end') {
  if (at === 'start') {
    await page
      .getByTestId('markdown-editor')
      .locator('[data-page-title] h1')
      .click({ position: { x: 2, y: 12 } });
    return;
  }
  await page
    .getByTestId('markdown-editor')
    .locator('[data-page-title] h1')
    .filter({ hasText: title })
    .evaluate(async (node) => {
      (node.closest('[contenteditable=true]') as HTMLElement).focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
}

for (const [kind, carrier] of [
  ['image', '![An unavailable local image](attachments/title-boundary.png)'],
  ['database', '```cerebro-database\ndatabase: Work item\nview: all\n```'],
  ['sheet', '```cerebro-sheet\n---\nformat: 1\nname: Boundary\n---\nItem,Value\nFirst,2\n```'],
] as const) {
  test(`title navigation preserves the first atomic ${kind} block`, async ({ page }, info) => {
    const title = `Before ${kind}`;
    const bytes = `# ${title}\n\n${carrier}\n\nAfter the embed.\n`;
    const path = `title-${kind}.md`;
    await seedFileBeforeBoot(page, path, bytes);
    await boot(page);
    await openPage(page, title);
    await titleCaret(page, title);
    await page.keyboard.press('ArrowDown');
    const atoms = page
      .getByTestId('markdown-editor')
      .locator(`.bn-block-content[data-content-type="${kind}"]`);
    expect(
      await atoms.evaluateAll(
        (nodes) =>
          new Set(
            nodes.map((node) =>
              node.closest('[data-node-type="blockOuter"]')?.getAttribute('data-id'),
            ),
          ).size,
      ),
    ).toBe(1);
    expect(await page.evaluate((p) => window.__cerebroMockFs.get(p), path)).toBe(bytes);
    await page.keyboard.press('ArrowUp');
    expect(
      await page.evaluate(() => {
        const node = window.getSelection()?.anchorNode;
        return (node instanceof Element ? node : node?.parentElement)?.closest('h1')?.textContent;
      }),
    ).toBe(title);
    await page.keyboard.press('Enter');
    await page.keyboard.type('An intentional writing line.');
    await expect
      .poll(() => page.evaluate((p) => window.__cerebroMockFs.get(p), path))
      .toContain('An intentional writing line.');
    const saved = (await page.evaluate((p) => window.__cerebroMockFs.get(p), path))!;
    expect(saved).toContain(carrier);
    expect(saved.indexOf('An intentional')).toBeLessThan(saved.indexOf(carrier));
    await page.screenshot({ path: info.outputPath(`title-${kind}.png`), animations: 'disabled' });
  });
}

test('an unchanged filename title is adopted only by an explicit Enter', async ({ page }) => {
  const bytes = 'This page has no H1.\n';
  await seedFileBeforeBoot(page, 'filename-title.md', bytes);
  await boot(page);
  await openPage(page, 'Filename title');
  const title = page.getByRole('textbox', { name: 'Document title' });
  await title.focus();
  expect(await page.evaluate(() => window.__cerebroMockFs.get('filename-title.md'))).toBe(bytes);
  await title.press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('filename-title.md')))
    .toContain('# Filename title');
  expect(
    await page.evaluate(
      () =>
        window.getSelection()?.anchorNode?.parentElement?.closest('.bn-block-content')?.textContent,
    ),
  ).toBe('This page has no H1.');
});

test('adopting a filename title on a related tab keeps its body hidden', async ({ page }) => {
  const path = 'related-filename.md';
  const bytes = '---\ntype: Project\n---\n\nA hidden writing body.\n';
  await seedFileBeforeBoot(page, path, bytes);
  await boot(page);
  await openPage(page, 'Related filename');
  await page.getByTestId('record-tab-tasks').click();
  const body = page.getByText('A hidden writing body.', { exact: true });
  await expect(body).toBeHidden();
  expect(await page.evaluate((p) => window.__cerebroMockFs.get(p), path)).toBe(bytes);
  await page.getByRole('textbox', { name: 'Document title' }).press('Enter');
  await expect(page.getByTestId('markdown-editor').locator('[data-page-title] h1')).toHaveText(
    'Related filename',
  );
  await expect(body).toBeHidden();
  await expect
    .poll(() =>
      page
        .getByTestId('page-editor-chrome')
        .evaluate((node) => node.contains(document.activeElement)),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate((p) => window.__cerebroMockFs.get(p), path))
    .toContain('# Related filename');
});

test('wrapped title arrows travel inside the heading before crossing into prose', async ({
  page,
}) => {
  const title =
    'A deliberately long document title that wraps through several lines inside this narrow reading column and keeps its native text selection';
  const bytes = `# ${title}\n\nWriting starts here.\n`;
  await seedFileBeforeBoot(page, 'wrapped-title.md', bytes);
  await page.setViewportSize({ width: 900, height: 600 });
  await boot(page);
  await openPage(page, title);
  await titleCaret(page, title, 'start');
  await page.keyboard.press('ArrowDown');
  expect(
    await page.evaluate(() => {
      const node = window.getSelection()?.anchorNode;
      return (node instanceof Element ? node : node?.parentElement)?.closest('h1')?.textContent;
    }),
  ).toBe(title);
  await titleCaret(page, title);
  await page.keyboard.press('ArrowDown');
  expect(
    await page.evaluate(
      () =>
        window.getSelection()?.anchorNode?.parentElement?.closest('.bn-block-content')?.textContent,
    ),
  ).toBe('Writing starts here.');
  expect(await page.evaluate(() => window.__cerebroMockFs.get('wrapped-title.md'))).toBe(bytes);
});

test('a title with nested children retains child order and copies document content only', async ({
  page,
}, info) => {
  const bytes =
    '---\ntype: Project\nprivate_label: Metadata must stay outside clipboard\n---\n\n# Nested title\n\n:::indent\nFirst nested child.\n\nSecond nested child.\n:::\n\nTop-level body.\n';
  await seedFileBeforeBoot(page, 'nested-title.md', bytes);
  await boot(page);
  await openPage(page, 'Nested title');
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  const title = page.getByTestId('markdown-editor').locator('[data-page-title] h1');
  const chrome = page.getByTestId('page-editor-chrome');
  const nested = page.getByText('First nested child.', { exact: true });
  await expect(nested).toBeVisible();
  await info.attach('title-projection-dom', {
    body: await page.getByTestId('markdown-editor').evaluate((node) => node.outerHTML),
    contentType: 'text/html',
  });
  expect((await title.boundingBox())!.y + (await title.boundingBox())!.height).toBeLessThanOrEqual(
    (await chrome.boundingBox())!.y,
  );
  expect(
    (await chrome.boundingBox())!.y + (await chrome.boundingBox())!.height,
  ).toBeLessThanOrEqual((await nested.boundingBox())!.y);
  await page.getByTestId('record-tab-tasks').click();
  await expect(nested).toBeHidden();
  await expect(page.getByText('Top-level body.', { exact: true })).toBeHidden();
  await expect(title).toBeVisible();
  await page.getByTestId('record-tab-overview').click();
  await expect(nested).toBeVisible();
  await titleCaret(page, 'Nested title');
  await page.keyboard.press('ArrowDown');
  expect(
    await page.evaluate(
      () =>
        window.getSelection()?.anchorNode?.parentElement?.closest('.bn-block-content')?.textContent,
    ),
  ).toBe('First nested child.');
  expect(await page.evaluate(() => window.__cerebroMockFs.get('nested-title.md'))).toBe(bytes);
  await nested.click();
  await page.keyboard.press('ControlOrMeta+a');
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain('Nested title');
  const copied = await page
    .getByTestId('markdown-editor')
    .locator('.bn-editor')
    .evaluate((editor) => {
      const data = new DataTransfer();
      editor.dispatchEvent(
        new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }),
      );
      return data.getData('text/plain');
    });
  expect(copied).toContain('Nested title');
  expect(copied).toContain('First nested child.');
  expect(copied).not.toContain('Metadata must stay outside clipboard');
  expect(copied.indexOf('First nested')).toBeLessThan(copied.indexOf('Second nested'));
  expect(copied.indexOf('Second nested')).toBeLessThan(copied.indexOf('Top-level body'));
});
