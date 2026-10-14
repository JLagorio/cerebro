import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Every block the `/` menu offers is written as a carrier, and opens again as
 * itself (M55.4).
 *
 * jsdom passes what a browser breaks: an image the parser reads itself takes
 * its url from `img.src`, which an engine resolves against the page, and the
 * toggle's chevron and the file panel only exist where BlockNote renders. So
 * the carriers are held here too, in Chromium and in WebKit, the engine the
 * packaged app embeds (playwright.config.ts). Asserted against the FILE, and
 * against the page opened again from it.
 */

const PAGE = 'delivery/how-we-schedule.md';

/** One of every carrier, written the way a save writes it. */
const EVERY = [
  '# How we schedule',
  '',
  'We ship on Thursdays, after the freeze.',
  '',
  ':::toggle Open **questions** for [[kickoff]]',
  'Who owns the migration?',
  ':::',
  '',
  ':::toggle-heading',
  '## The freeze',
  '',
  'It starts a week before the release.',
  ':::',
  '',
  'The cadence.',
  '',
  ':::indent',
  'Every second Thursday.',
  ':::',
  '',
  '![Plan|320](attachments/plan.png "The plan")',
  '',
  '![](clips/demo.mp4 "Walkthrough")',
  '',
  '![Standup](clips/standup.m4a)',
  '',
  '![Contract](docs/contract.pdf "v2")',
  '',
  '* Item',
  '',
  ':::indent',
  '![Shot](attachments/shot.png "Cap")',
  ':::',
  '',
].join('\n');

/** Open the page from the sidebar, expanding its collection only if it is folded. */
async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

/** Leave the page for Home, so the next open reads the file again. */
async function goHome(page: Page): Promise<void> {
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home' }).click();
}

/** Seed the page (the mock disk reseeds on reload, so "again" is never a reload) and open it. */
async function seedAndOpen(page: Page, md: string): Promise<void> {
  await boot(page);
  await page.evaluate(([path, text]) => window.__cerebroMockFs.set(path, text), [PAGE, md]);
  await openSchedule(page);
}

/**
 * The block types on the page, in document order, by BlockNote's own marking:
 * a block that folds says so, and an empty paragraph (the one BlockNote keeps
 * at the end of a page, or not) is left out.
 */
const blockTypes = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="markdown-editor"] [data-node-type="blockContainer"] > [data-content-type]',
      ),
    ]
      .filter((el) => el.getAttribute('data-content-type') !== 'paragraph' || el.textContent !== '')
      .map((el) => {
        const type = el.getAttribute('data-content-type') ?? '';
        return el.closest('.bn-toggle-wrapper') !== null || el.querySelector('.bn-toggle-wrapper')
          ? `${type}+toggle`
          : type;
      }),
  );

test('a page holding every carrier opens editable and writes each one back unchanged', async ({
  page,
}) => {
  await seedAndOpen(page, EVERY);
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByText('We ship on Thursdays')).toBeVisible();
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);

  const opened = await blockTypes(page);
  for (const type of [
    'toggleListItem+toggle',
    'heading+toggle',
    'image',
    'video',
    'audio',
    'file',
  ]) {
    expect(opened, type).toContain(type);
  }
  expect(opened.filter((type) => type === 'image')).toHaveLength(2);

  // Opening writes nothing: the page is already in its saved form.
  await page.waitForTimeout(1200);
  expect(await readMockFile(page, PAGE)).toBe(EVERY);

  // The toggle shows what it folds once opened.
  await editor.locator('[data-content-type="toggleListItem"] .bn-toggle-button').first().click();
  await expect(editor.getByText('Who owns the migration?')).toBeVisible();

  // One unrelated edit, and every carrier line comes back as it was.
  await editor.getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  const edited = EVERY.replace('after the freeze.', 'after the freeze. Edited.');
  await expect.poll(() => readMockFile(page, PAGE), { timeout: 6_000 }).toBe(edited);

  // Opened again from the file: the same blocks.
  await goHome(page);
  await openSchedule(page);
  await expect(editor.getByText('Edited.', { exact: false })).toBeVisible({ timeout: 10_000 });
  expect(await blockTypes(page)).toEqual(opened);
  await page.waitForTimeout(1200);
  expect(await readMockFile(page, PAGE)).toBe(edited);
});

/** Put the caret in the empty paragraph BlockNote keeps at the end of every page. */
async function atEnd(page: Page): Promise<void> {
  await page
    .getByTestId('markdown-editor')
    .locator('[data-content-type="paragraph"]')
    .last()
    .click();
}

/** Insert one `/` entry into the empty paragraph at the end of the page. */
async function slash(page: Page, query: string, title: string): Promise<void> {
  await atEnd(page);
  await page.keyboard.type(`/${query}`);
  await page
    .locator('#bn-suggestion-menu [role=option]')
    .filter({ hasText: title })
    .first()
    .click();
}

/** Embed a URL through the file panel `/image`, `/video`, `/audio` and `/file` open. */
async function embed(page: Page, url: string, button: string): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Embed' });
  if (await tab.isVisible()) await tab.click();
  await page.getByPlaceholder('Enter URL').fill(url);
  await page.getByRole('button', { name: button }).click();
}

test('/ inserts each block, writes it as its carrier, and opens it again as itself', async ({
  page,
}) => {
  await seedAndOpen(page, '# How we schedule\n\nWe ship on Thursdays.\n');
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByText('We ship on Thursdays.')).toBeVisible();

  await slash(page, 'image', 'Image');
  await embed(page, 'attachments/plan.png', 'Embed image');
  await slash(page, 'video', 'Video');
  await embed(page, 'clips/demo.mp4', 'Embed video');
  await slash(page, 'audio', 'Audio');
  await embed(page, 'clips/standup.m4a', 'Embed audio');
  await slash(page, 'file', 'File');
  await embed(page, 'docs/contract.pdf', 'Embed file');
  await slash(page, 'table', 'Table');
  await slash(page, 'toggle list', 'Toggle List');
  await page.keyboard.type('Open questions');
  await slash(page, 'toggle heading 1', 'Toggle Heading 1');
  await page.keyboard.type('Freeze');
  // A paragraph Tab-nested under the one above it.
  await atEnd(page);
  await page.keyboard.type('Parent line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Nested line');
  await page.keyboard.press('Tab');

  const carriers = [
    /^!\[plan\.png\]\(attachments\/plan\.png\)$/m,
    /^!\[demo\.mp4\]\(clips\/demo\.mp4\)$/m,
    /^!\[standup\.m4a\]\(clips\/standup\.m4a\)$/m,
    /^!\[contract\.pdf\]\(docs\/contract\.pdf\)$/m,
    // A table with its header row: no empty one invented above the cells.
    /^\| +\| +\| +\|\n\| -+ \| -+ \| -+ \|\n\| +\| +\| +\|$/m,
    /^:::toggle Open questions\n:::$/m,
    /^:::toggle-heading\n# Freeze\n:::$/m,
    /^Parent line\n\n:::indent\nNested line\n:::$/m,
  ];
  await expect
    .poll(
      async () => {
        const saved = await readMockFile(page, PAGE);
        return carriers.filter((carrier) => !carrier.test(saved)).map(String);
      },
      { timeout: 8_000 },
    )
    .toEqual([]);
  const saved = await readMockFile(page, PAGE);
  expect(saved).not.toMatch(/BlockNote image|Add (image|video|audio|file)|http/);

  const before = await blockTypes(page);
  for (const type of ['image', 'video', 'audio', 'file', 'table']) {
    expect(before, type).toContain(type);
  }
  expect(before).toContain('toggleListItem+toggle');
  expect(before).toContain('heading+toggle');
  await goHome(page);
  await openSchedule(page);
  await expect(editor.getByText('Nested line')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  expect(await blockTypes(page)).toEqual(before);
  await page.waitForTimeout(1200);
  expect(await readMockFile(page, PAGE)).toBe(saved);
});

test('a list-item image keeps its relative url through a save', async ({ page }) => {
  await seedAndOpen(
    page,
    '# How we schedule\n\nWe ship on Thursdays.\n\n* ![Shot](attachments/shot.png "Cap")\n',
  );
  const editor = page.getByTestId('markdown-editor');
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  await expect(editor.locator('[data-content-type="image"]')).toHaveCount(1);
  await editor.getByText('We ship on Thursdays.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 6_000 })
    .toContain('Thursdays. Edited.');
  const saved = await readMockFile(page, PAGE);
  expect(saved).toContain('\n![Shot](attachments/shot.png "Cap")\n');
  expect(saved).not.toContain('http');
});
