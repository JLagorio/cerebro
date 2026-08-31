import { test, expect } from '@playwright/test';
import { boot } from './boot';

/**
 * M45.4 — a record tab backed by a database view, corpus bytes to broken card.
 *
 * Epic is the golden-corpus type wearing `tabs:` (Overview + a related-scoped
 * "Work items" view of the Work item database — 2026-08-28-m45.4 plan,
 * Task 5). Epic was picked over the other relation hosts because Work item's
 * `epic` relation already targets it (the type doc's rollup reads the same
 * edge, so the corpus tells one story twice over one relation) and because no
 * other spec opens an Epic record — the strip the corpus tabs raise on every
 * Epic page churns nothing else in the suite.
 *
 * Two claims only this spec can make in a real browser:
 *
 * 1. The whole chain: `tabs:` on the Type doc's corpus bytes → the strip on
 *    an open Epic page → the Work items tab embeds the database scoped
 *    THROUGH the `epic` relation to the host — the four items pointing at
 *    this epic render, the twelve pointing at the other three do not. jsdom
 *    covers every joint (viewTab.test.ts on frozen fixtures, DocPage.test.tsx
 *    on a mutated mock vault); only e2e runs the chain over the scanner's
 *    real relationship shape end to end.
 *
 * 2. The tab is honest when its source dies mid-session. The Work item
 *    database leaves the mock disk — the type doc AND every record, because
 *    the catalog deliberately keeps a GHOST type alive while records still
 *    reference it, so a partial delete would (correctly) keep the tab
 *    working. The mock has no watcher; a store write triggers the rescan
 *    (knowledge.spec's idiom), and the tab must render the broken card's
 *    sentence — never the empty state, which would read as measured-at-zero.
 */
test('view tab: scoped to the host record, and honest when the source dies', async ({ page }) => {
  await boot(page);

  // -- Open the epic in the record panel, then as a full page ----------
  await page.getByTestId('sidebar-type').filter({ hasText: 'Epic' }).first().click();
  const row = page.getByTestId('table-row').filter({ hasText: 'Phoenix warehouse cutover' });
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Open in full page' }).click();

  // -- The corpus tabs raise the strip; Overview is still the default --
  await expect(page.getByTestId('record-tabs')).toBeVisible();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();

  // -- The Work items tab embeds the database, scoped to this epic -----
  await page.getByTestId('record-tab-work-items').click();
  const embed = page.getByTestId('view-tab-embed');
  await expect(embed).toBeVisible();
  // A related row present AND an unrelated row absent, by title: the four
  // items whose `epic` points at this record…
  await expect(embed.getByText('Rehearse the rollback in staging')).toBeVisible();
  await expect(embed.getByTestId('table-row')).toHaveCount(4);
  // …and not the offline-conflict item, whose `epic` points elsewhere.
  await expect(embed.getByText('Detect write conflicts on job close')).toHaveCount(0);
  // M45.4 read the tab as its own whole surface and asserted NO property
  // stack here. M46.1 reversed that on the user's correction — "tabs are only
  // for related data sources. fields shwo above" — so the record's stack
  // stands above this embed, exactly as it does on Overview.
  await expect(page.getByTestId('page-properties')).toBeVisible();

  // -- Kill the source: the Work item database leaves the vault --------
  // The type doc and all 45 records; anchored to the frontmatter line so a
  // List whose nested source mentions the type name is never swept.
  await page.evaluate(() => {
    const fs = window.__cerebroMockFs;
    for (const [path, text] of [...fs.entries()]) {
      if (path === 'types/work-item.md' || /^type: Work item$/m.test(text)) fs.delete(path);
    }
  });
  // The mock has no watcher; a store write triggers the rescan that notices
  // the deletion. The write happens WITHOUT leaving this tab, because since
  // M46.1 the stack the status row lives in stands above the embed — the
  // record keeps its properties on every tab. The value CHIP is named by the
  // value it shows (the row's other buttons are the reorder grip and the
  // property menu).
  await page
    .locator('[data-testid="property-row"][data-property="status"]')
    .getByRole('button', { name: 'Committed' })
    .click();
  await page.getByRole('listbox').getByRole('option', { name: 'Building' }).click();
  // The popover outlives its own selection; Escape dismisses it so nothing
  // floats over the card asserted below.
  await page.keyboard.press('Escape');

  // -- The tab says what died — a sentence, never an empty database ----
  // No tab press to get here: the rescan re-resolves the pointer under the
  // open tab, so the card replaces the embed in place.
  await expect(page.getByTestId('view-tab-broken')).toContainText(
    'This tab points at a type called “Work item” that is no longer in the vault.',
  );
  await expect(page.getByTestId('view-tab-embed')).toHaveCount(0);
  // Not the empty state: "no records yet" and "the database is gone" are
  // opposite sentences (the M33 rule), and the table's empty-state line is
  // the exact lie the broken card exists to prevent.
  await expect(page.getByText('No records yet')).toHaveCount(0);
  await expect(page.getByTestId('table-row')).toHaveCount(0);
});
