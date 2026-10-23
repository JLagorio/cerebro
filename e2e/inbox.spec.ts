import { test, expect } from '@playwright/test';
import { boot, readMockFile, openDestination } from './boot';
import { chooseOption } from './select';

test('inbox: queue untyped captures, organize one, and watch it leave', async ({ page }) => {
  await boot(page);

  // -- The nav advertises the queue -----------------------------------
  // Scoped to the destination rows (M37.3): the demo vault has an `inbox/`
  // folder whose tree row matches the same accessible name.
  const inboxNav = page.getByTestId('nav-surfaces').getByRole('button', { name: /^Inbox/ });
  await expect(inboxNav).toBeVisible();
  // Scoped to the Inbox button: Knowledge carries a review badge too.
  const badge = inboxNav.getByTestId('nav-badge');
  await expect(badge).toBeVisible();
  const queuedBefore = Number(await badge.innerText());
  expect(queuedBefore).toBeGreaterThan(0);

  await inboxNav.click();
  await expect(page.getByTestId('inbox-page')).toBeVisible();

  // -- Only unorganized notes are queued -------------------------------
  const rows = page.getByTestId('inbox-row');
  await expect(rows).toHaveCount(queuedBefore);
  // Typed demo records (Objectives, Risks, Work items) must not appear.
  await expect(rows.filter({ hasText: 'Field app readiness' })).toHaveCount(0);

  // -- Opening a capture ------------------------------------------------
  await rows.filter({ hasText: 'Warehouse cutover' }).click();
  await expect(page.getByTestId('inbox-pane-header')).toContainText('Warehouse cutover');

  // -- Assigning a type writes frontmatter -----------------------------
  // Organize is the first section of the capture's inspector, in place of a
  // page's Properties.
  const organize = page.getByTestId('doc-side-panel').locator('[data-section="organize"]');
  await chooseOption(organize.getByLabel('Type'), 'Work item');
  await expect
    .poll(async () => readMockFile(page, 'inbox/warehouse-cutover-thought.md'))
    .toContain('type: Work item');

  // -- Organizing removes it from the queue ----------------------------
  // From the toolbar, where the act sits beside the capture's own marks;
  // the inspector's row is the same act (inbox-redesign).
  await page
    .getByTestId('inbox-pane-header')
    .getByRole('button', { name: 'Mark organized', exact: true })
    .click();
  await expect
    .poll(async () => readMockFile(page, 'inbox/warehouse-cutover-thought.md'))
    .toContain('_organized: true');
  await expect(rows).toHaveCount(queuedBefore - 1);
  await expect(rows.filter({ hasText: 'Warehouse cutover' })).toHaveCount(0);
  // The queue's count is the nav badge's: the list carries no count of its
  // own. The destinations are out of view while the sidebar lends its body
  // to the queue, so the badge is read where it waits.
  await expect(
    page
      .getByTestId('nav-surfaces')
      .locator('button[aria-label^="Inbox"] [data-testid="nav-badge"]'),
  ).toHaveText(String(queuedBefore - 1));

  // -- Auto-advance opened the next capture ----------------------------
  await expect(page.getByTestId('inbox-pane-header')).not.toContainText('Warehouse cutover');
  await expect(organize).toBeVisible();
});

test('inbox: quick capture writes an untyped note into the queue', async ({ page }) => {
  await boot(page);
  await openDestination(page, 'Inbox');

  const rows = page.getByTestId('inbox-row');
  const before = await rows.count();

  // exact: `name` is a case-insensitive SUBSTRING by default, and the
  // toolbar's pager holds "Previous capture" and "Next capture" beside it.
  await page
    .getByTestId('inbox-pane-header')
    .getByRole('button', { name: 'New capture', exact: true })
    .click();
  await expect(rows).toHaveCount(before + 1);

  // A capture is untyped on purpose — that is what keeps it in the queue.
  await expect(
    page
      .getByTestId('doc-side-panel')
      .locator('[data-section="organize"]')
      .getByRole('button', { name: 'Type', exact: true }),
  ).toHaveText('No type');
});
