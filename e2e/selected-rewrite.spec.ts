import { expect, test, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';
import { boot, holdClock, readMockFile, seedFileBeforeBoot, stepUntil } from './boot';

// The existing mock skill script returns a deterministic text-only proposal.
// It starts no real CLI and gives the selected-passage run no tools.
const PATH = 'notes/selected-rewrite-browser.md';
const TITLE = 'Selected passage browser';
const PASSAGE = 'A clear sentence deserves careful editing.';
const OTHER = 'An untouched second paragraph.';
const CHANGED = 'A concurrent second paragraph.';
const RAW = `# ${TITLE}\n\n${PASSAGE}\n\n${OTHER}\n`;
const PROPOSAL = 'A rewrite proof: I read its sources. This recipe writes nothing.';

async function open(page: Page, theme: 'light' | 'dark', info: TestInfo) {
  const startupAt = Date.now();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  await seedFileBeforeBoot(page, PATH, RAW);
  await seedFileBeforeBoot(
    page,
    'skills/a-rewrite-proof.md',
    '---\ntype: Skill\nslug: a-rewrite-proof\n---\n# A rewrite proof\n\nRewrite the selected passage.\n',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  if (theme === 'dark')
    await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
  await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('quick-open-input').fill(TITLE);
  await page.getByTestId('quick-open-result').filter({ hasText: TITLE }).first().click();
  const editor = page.getByTestId('markdown-editor');
  const prose = editor.getByText(PASSAGE, { exact: true });
  const editorWaitAt = Date.now();
  try {
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(prose).toBeVisible();
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    await info.attach('selected-rewrite-editor-readiness', {
      body: JSON.stringify(
        {
          theme,
          startupElapsedMs: Date.now() - startupAt,
          editorWaitMs: Date.now() - editorWaitAt,
          pageErrors,
          consoleErrors,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
  const points = await prose.evaluate((node) => {
    const text = node.firstChild!;
    const range = node.ownerDocument.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const start = range.getBoundingClientRect();
    range.setStart(text, text.textContent!.length - 1);
    range.setEnd(text, text.textContent!.length);
    const end = range.getBoundingClientRect();
    return { x1: start.left + 0.1, x2: end.right + 0.1, y: start.top + start.height / 2 };
  });
  await page.mouse.click(points.x1, points.y);
  await page.mouse.move(points.x1, points.y);
  await page.mouse.down();
  await page.mouse.move(points.x2, points.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(PASSAGE);
  await page.getByTestId('selection-ask-ai').click();
  await expect(page.getByLabel('What should the assistant do with this passage?')).toBeFocused();
  await expect(editor.locator('.cb-held-selection')).toHaveText(PASSAGE);
  // The contextual control belongs beside the selected passage, including after
  // held-selection decoration replaces the editor's text nodes.
  const askPanel = page.getByTestId('ask-ai');
  await expect.poll(async () => (await askPanel.boundingBox())?.x).toBeGreaterThan(points.x1 - 24);
  await expect.poll(async () => (await askPanel.boundingBox())?.x).toBeLessThan(points.x1 + 24);
  await expect.poll(async () => (await askPanel.boundingBox())?.y).toBeGreaterThan(points.y);

  await holdClock(page);
  await page.getByTestId('ask-ai-skill').filter({ hasText: '/a-rewrite-proof' }).click();
  await expect(page.getByTestId('ask-ai-working')).toBeVisible();
  return editor;
}

async function decide(page: Page) {
  await stepUntil(
    page,
    () => page.getByTestId('ask-ai-decision').isVisible(),
    'the rewrite decision',
  );
  await expect(page.getByTestId('ask-ai-hunks')).toContainText(
    'rewrite proof: I read its sources. This recipe writes nothing.',
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`selected rewrite applies once and Undo restores saved bytes in ${theme}`, async ({
    page,
  }, info) => {
    const editor = await open(page, theme, info);
    await decide(page);
    expect(await readMockFile(page, PATH)).toBe(RAW);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByTestId('ask-ai')).toHaveCount(0);
    await expect(editor.getByText(PROPOSAL, { exact: true })).toBeVisible();
    await page.clock.runFor(1000);
    await expect.poll(() => readMockFile(page, PATH)).toBe(RAW.replace(PASSAGE, PROPOSAL));
    await expect(editor.locator('.cb-held-selection')).toHaveCount(0);
    expect(
      await page.evaluate(
        (path) => window.__cerebroMockWrites.filter((row) => row.path === path).length,
        PATH,
      ),
    ).toBe(1);
    await page.screenshot({
      path: info.outputPath(`selected-rewrite-applied-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.getByText(PASSAGE, { exact: true })).toBeVisible();
    await page.clock.runFor(1000);
    await expect.poll(() => readMockFile(page, PATH)).toBe(RAW);
  });

  test(`a concurrent edit keeps the proposal and Cancel saves nothing in ${theme}`, async ({
    page,
  }, info) => {
    const editor = await open(page, theme, info);
    await page.evaluate(
      async ({ path, raw }) => {
        window.__cerebroMockFs.set(path, raw);
        const modulePath = '/src/stores/vaultStore.ts';
        const { useVaultStore } = await import(modulePath);
        await useVaultStore.getState().rescan();
      },
      { path: PATH, raw: RAW.replace(OTHER, CHANGED) },
    );
    await stepUntil(
      page,
      () => editor.getByText(CHANGED, { exact: true }).isVisible(),
      'the concurrent page change',
    );
    await decide(page);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    const panel = page.getByTestId('ask-ai');
    await expect(panel.getByRole('alert')).toContainText('Reselect');
    await expect(panel.getByTestId('ask-ai-hunks')).toContainText(
      'rewrite proof: I read its sources. This recipe writes nothing.',
    );
    await expect(panel.getByRole('button', { name: 'Reselect passage' })).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`selected-rewrite-conflict-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await page.clock.runFor(1000);
    expect(await readMockFile(page, PATH)).toBe(RAW.replace(OTHER, CHANGED));
    expect(
      await page.evaluate(
        (path) => window.__cerebroMockWrites.filter((row) => row.path === path).length,
        PATH,
      ),
    ).toBe(0);
  });
}
