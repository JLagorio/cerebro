import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Page cards (M55.14). A `/Page` card shows its target live — the icon set
 * through M55.11's picker, the title, a record's status — and opens it with
 * Open. A lone page link pasted on an empty line becomes the same card. Each
 * card is a ```cerebro-page fence on disk, and a card whose page does not
 * exist keeps its pointer byte for byte through a save it had no part in.
 */

const ROCKET = '\u{1F680}';
const SCHEDULE = 'delivery/how-we-schedule.md';
const HOST = 'inbox/onboarding-webinar-idea.md';
const SEEDED = 'inbox/pick-queue-drain-timing.md';
const CARD = '```cerebro-page\n[[how-we-schedule]]\n```';
const ITEM_CARD = '```cerebro-page\n[[fld-4]]\n```';

const count = (text: string, part: string) => text.split(part).length - 1;

/** Open a page by title through Quick Open. */
async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText(title, { timeout: 10_000 });
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

/**
 * A new empty line after the page's last paragraph, holding the caret. Clicked
 * at the right end of its last line, because End only reaches the end of the
 * line it is on, and a paragraph that wraps would be split.
 */
async function newLine(page: Page) {
  const last = page
    .getByTestId('markdown-editor')
    .locator('[data-content-type="paragraph"]')
    .last();
  const box = await last.boundingBox();
  if (box === null) throw new Error('the paragraph is not on screen');
  await last.click({ position: { x: box.width - 2, y: box.height - 4 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

/** `/page` on a new line, then pick the first page matching `query`. */
async function insertCard(page: Page, query: string, title: string) {
  await newLine(page);
  await page.keyboard.type('/page');
  await page
    .locator('#bn-suggestion-menu [role=option]')
    .filter({ hasText: 'Show another page here' })
    .click();
  // The card's search takes the caret: typing lands in it.
  const search = page.getByLabel('Find a page', { exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.type(query);
  await page.getByTestId('page-card-option').filter({ hasText: title }).first().click();
}

const cardFor = (page: Page, title: string) =>
  page
    .getByTestId('markdown-editor')
    .locator('[data-testid="page-card"][data-state="resolved"]')
    .filter({ hasText: title });

test('a /page card shows its page live, a pasted link becomes one, and Open lands', async ({
  page,
}) => {
  await boot(page);

  // -- The target gets an icon through M55.11's picker ----------------------
  await openPage(page, 'How we schedule');
  await page.getByTestId('page-chrome-add').hover();
  await page.getByTestId('page-add-icon').click();
  await page.getByLabel('Emoji', { exact: true }).fill(ROCKET);
  await page.getByLabel('Emoji', { exact: true }).press('Enter');
  await expect
    .poll(() => readMockFile(page, SCHEDULE), { timeout: 5_000 })
    .toContain(`icon: ${ROCKET}`);

  // -- On another page, /page and pick it -----------------------------------
  await openPage(page, 'Run the onboarding webinar as office hours instead');
  await insertCard(page, 'how we schedule', 'How we schedule');
  const card = cardFor(page, 'How we schedule');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('img', { name: ROCKET })).toBeVisible();
  await expect(card.getByTestId('page-card-title')).toHaveText('How we schedule');
  await expect.poll(() => readMockFile(page, HOST), { timeout: 6_000 }).toContain(CARD);

  // -- A Work item card shows its status chip -------------------------------
  await insertCard(page, 'blank-state', 'Blank-state coaching copy');
  const item = cardFor(page, 'Blank-state coaching copy');
  await expect(item.getByTestId('page-card-status')).toBeVisible();
  await expect(item.getByTestId('page-card-status')).not.toHaveText('');
  await expect.poll(() => readMockFile(page, HOST), { timeout: 6_000 }).toContain(ITEM_CARD);

  // -- A lone link pasted on an empty line becomes a card --------------------
  await newLine(page);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '[[how-we-schedule]]');
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(cardFor(page, 'How we schedule')).toHaveCount(2);
  await expect
    .poll(async () => count(await readMockFile(page, HOST), CARD), { timeout: 6_000 })
    .toBe(2);
  const saved = await readMockFile(page, HOST);
  expect(saved).toContain('Cheaper to run, and we could measure it against the same key result.');
  expect(count(saved, '```cerebro-page')).toBe(3);

  // -- Open lands on the page -------------------------------------------------
  await cardFor(page, 'How we schedule').first().getByRole('button', { name: 'Open' }).click();
  // The crumb carries the page's icon now.
  await expect(page.getByTestId('doc-title')).toHaveText(`${ROCKET}How we schedule`, {
    timeout: 10_000,
  });
});

test('a card naming no page shows so, and keeps its pointer through a save', async ({ page }) => {
  await boot(page);
  const seeded = [
    '# How long does the pick queue actually take to drain?',
    '',
    'Notes.',
    '',
    '```cerebro-page',
    '[[no-such-page]]',
    '```',
    '',
  ].join('\n');
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [SEEDED, seeded]);
  await openPage(page, 'How long does the pick queue actually take to drain?');

  const card = page.getByTestId('markdown-editor').getByTestId('page-card');
  await expect(card).toHaveAttribute('data-state', 'missing');
  await expect(card).toContainText('No page named “no-such-page”');
  await expect(card.getByRole('button', { name: 'Choose a page' })).toBeVisible();

  // An edit elsewhere saves the page; the card's pointer is written as held.
  await page.getByTestId('markdown-editor').getByText('Notes.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await expect
    .poll(() => readMockFile(page, SEEDED), { timeout: 6_000 })
    .toBe(seeded.replace('Notes.', 'Notes. More.'));
});

test('a card picked among pages sharing a stem shows and opens the one picked', async ({
  page,
}) => {
  await boot(page);
  // Four projects hold a meetings/kickoff.md, and `[[kickoff]]` reaches only
  // the first: the picker writes this one by its title instead.
  const title = 'Offline sync hardening kickoff';
  await openPage(page, 'Run the onboarding webinar as office hours instead');
  await insertCard(page, 'offline sync hardening kick', title);
  const card = cardFor(page, title);
  await expect(card.getByTestId('page-card-title')).toHaveText(title);
  await expect
    .poll(() => readMockFile(page, HOST), { timeout: 6_000 })
    .toContain(`\`\`\`cerebro-page\n[[${title}]]\n\`\`\``);
  // A Meeting is a record: Open lands on its row, with this one's panel open.
  await card.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title, {
    timeout: 10_000,
  });
});
