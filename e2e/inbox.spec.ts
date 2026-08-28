import { test, expect } from '@playwright/test';
import { boot, readMockFile } from './boot';

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

  // -- The checklist names what is missing -----------------------------
  await rows.filter({ hasText: 'Warehouse cutover' }).click();
  const checklist = page.getByTestId('organize-checklist');
  await expect(checklist).toContainText('Has a type');
  // The capture body links [[phoenix-warehouse-rollout]], so it is connected.
  await expect(checklist).toContainText('Connected to something');

  // -- Assigning a type writes frontmatter -----------------------------
  await page.getByLabel('Organize').getByRole('combobox').first().selectOption('Work item');
  await expect
    .poll(async () => readMockFile(page, 'inbox/warehouse-cutover-thought.md'))
    .toContain('type: Work item');

  // -- Organizing removes it from the queue ----------------------------
  await page.getByRole('button', { name: /Mark organized/i }).click();
  await expect
    .poll(async () => readMockFile(page, 'inbox/warehouse-cutover-thought.md'))
    .toContain('_organized: true');
  await expect(rows).toHaveCount(queuedBefore - 1);
  await expect(rows.filter({ hasText: 'Warehouse cutover' })).toHaveCount(0);
  await expect(badge).toHaveText(String(queuedBefore - 1));

  // -- Auto-advance opened the next capture ----------------------------
  await expect(page.getByLabel('Organize')).toBeVisible();
});

test('inbox: quick capture writes an untyped note into the queue', async ({ page }) => {
  await boot(page);
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();

  const rows = page.getByTestId('inbox-row');
  const before = await rows.count();

  // exact: `name` is a case-insensitive SUBSTRING by default, so 'Capture'
  // also matched the reading pane's "Previous capture" / "Next capture" that
  // M15 added — three matches, strict-mode violation.
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(rows).toHaveCount(before + 1);

  // A capture is untyped on purpose — that is what keeps it in the queue.
  const checklist = page.getByTestId('organize-checklist');
  await expect(checklist).toContainText('Has a type');
});
