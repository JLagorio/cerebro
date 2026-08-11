import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
  }
}

/**
 * Stage H end to end (M29.45–M29.50): the whiteboard is the tenth view kind,
 * and this journey is the only place the whole chain runs for real — a tab
 * created through the picker, a `.mmd` written to the (mock) disk by
 * `write_text_file`'s mirror, a pointer persisted into the List's own YAML,
 * real mermaid in real Chromium accepting every edit, a record bound through a
 * `click` line naming its actual vault path, and the chip over that node
 * opening the record in place.
 *
 * A new file rather than more of collections.spec: this flow mutates the mock
 * disk heavily (a created view, a created file, three edits to it), and
 * collections.spec's tests read the seeded corpus as it shipped.
 *
 * How each step proves REAL mermaid accepted the edit, without reaching into
 * mermaid's private svg internals: `renderMermaid` stamps every successful
 * render with a fresh `cerebro-mermaid-<seq>` id and caches per source, so the
 * id is a function of the CODE, and StructuralEditor only writes a new svg into
 * its host on success (`if (!r.ok) return` — it holds the last good render
 * otherwise). A CHANGED host svg id therefore means mermaid parsed and drew the
 * edited source. This is the device diagrams.spec.ts documents at :492-499.
 */

async function boot(page: Page): Promise<void> {
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    // Pin the theme (M16.39). These specs assert on rendered UI, and an unset
    // themeMode resolves 'system' — so a dark display would flip every colour
    // out from under them.
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

/** Expand a Collection row in the sidebar tree. */
async function expand(page: Page, name: string): Promise<void> {
  const caret = page.getByRole('button', { name: `Expand ${name}` });
  if (await caret.isVisible()) await caret.click();
}

/** Open the Delivery schedule List — a Work item list inside the Delivery collection. */
async function openDeliverySchedule(page: Page): Promise<void> {
  await expand(page, 'Delivery');
  await page
    .getByTestId('collection-node-list')
    .filter({ hasText: 'Delivery schedule' })
    .getByRole('button', { name: 'Delivery schedule', exact: true })
    .click();
}

/** + → Whiteboard → Create, the same idiom collections.spec uses for a board. */
async function addWhiteboardTab(page: Page): Promise<void> {
  await page.getByTestId('new-view').click();
  await page.getByTestId('new-view-whiteboard').click();
  await page.getByTestId('create-view').click();
}

/** Every `.mmd` the whiteboard machinery could have created for this List. */
const canvasFiles = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...window.__cerebroMockFs.keys()].filter((k) => /^delivery\/whiteboards\/.+\.mmd$/.test(k)),
  );

test('whiteboard: a tab creates its canvas, takes a record, and opens it', async ({ page }) => {
  // 120s like the Stage F/G journeys: this one runs a cold mermaid chunk load
  // plus two op → re-render laps and three debounced disk waits, and a cold
  // run would otherwise surface as an outer timeout rather than the assertion
  // that actually stalled.
  test.setTimeout(120_000);

  await boot(page);
  await openDeliverySchedule(page);
  await addWhiteboardTab(page);

  // -- Create-on-open: the canvas exists ON DISK, once ---------------------
  // `<host folder>/whiteboards/<view-slug>.mmd` — the Delivery collection's
  // own folder, because that is where the `.list.yml` lives.
  await expect(page.getByTestId('whiteboard-view')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => canvasFiles(page), { timeout: 10_000 }).toHaveLength(1);
  const mmdPath = (await canvasFiles(page))[0];
  const readCanvas = () =>
    page.evaluate((p) => window.__cerebroMockFs.get(p) ?? '', mmdPath) as Promise<string>;
  // The seed is a valid empty flowchart asking for manual layout (M29.41):
  // a whiteboard node lands where it was dropped.
  const seed = await readCanvas();
  expect(seed).toContain('flowchart TD');
  expect(seed).toContain('%% cerebro:layout manual');

  // -- …and the pointer is persisted through the List's own YAML ----------
  // Not a sidecar and not app state: the tab's `whiteboard.file` is presentation
  // data, so it round-trips through `serializePresentation`'s allowlist.
  const readList = () =>
    page.evaluate(
      () => window.__cerebroMockFs.get('delivery/delivery-schedule.list.yml') ?? '',
    ) as Promise<string>;
  await expect.poll(readList, { timeout: 10_000 }).toContain('whiteboard:');
  expect(await readList()).toContain(mmdPath);

  // -- Real mermaid drew the seed -----------------------------------------
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 30_000 });
  const hostSvgId = () => host.locator('svg[id^="cerebro-mermaid-"]').getAttribute('id');

  // -- An edit through the code overlay reaches the file ------------------
  // This is the whole point of `useDiagramFile` (M29.23, extracted in H2): the
  // whiteboard has DiagramPage's debounced, keyed autosave, not a fresh one.
  const beforeEdit = await hostSvgId();
  await page.getByRole('button', { name: 'Show code' }).click();
  const source = page.getByLabel('Mermaid source');
  await expect(source).toHaveValue(/flowchart TD/);
  await source.fill(`${await source.inputValue()}  Sketch[Sketch]\n`);
  await expect.poll(hostSvgId, { timeout: 20_000 }).not.toBe(beforeEdit);
  await expect.poll(readCanvas, { timeout: 15_000 }).toContain('Sketch[Sketch]');
  // 'Hide code' is AMBIGUOUS while the panel is open — DiagramToolbar's text
  // toggle and CodeOverlay's close IconButton both carry it — so scope it.
  await page.getByTestId('diagram-toolbar').getByRole('button', { name: 'Hide code' }).click();
  await expect(page.getByTestId('code-overlay')).toHaveCount(0);

  // -- Add a record: the picker offers the VIEW's own rows -----------------
  const beforeAdd = await hostSvgId();
  await page.getByTestId('whiteboard-add-record').click();
  const firstOption = page.getByTestId('whiteboard-add-option').first();
  await expect(firstOption).toBeVisible();
  // The row's own title span (the button also holds a folder span), and the
  // button's `title` attribute IS the record's vault path.
  const pickedTitle = ((await firstOption.locator('span').first().textContent()) ?? '').trim();
  const pickedPath = (await firstOption.getAttribute('title')) ?? '';
  expect(pickedTitle).not.toBe('');
  // A real vault path, and NOT the List's own folder: the Delivery schedule
  // queries `type: Work item` vault-wide, and the demo corpus keeps its work
  // items under `projects/<project>/items/`. The canvas therefore has to store
  // the record's true path, not something reconstructed from where it sits.
  expect(pickedPath).toMatch(/^projects\/.+\/items\/.+\.md$/);
  await firstOption.click();

  // -- The binding is a `click` line naming the record's REAL path ---------
  // Node + label + binding are one `onChangeCode` (spec D10), so this is one
  // undo step; on disk it is one debounced write.
  await expect.poll(hostSvgId, { timeout: 20_000 }).not.toBe(beforeAdd);
  await expect
    .poll(readCanvas, { timeout: 15_000 })
    .toMatch(new RegExp(`click\\s+\\S+\\s+"${pickedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  // The node carries the record's title as its label, not its path.
  expect(await readCanvas()).toContain(`[${pickedTitle}]`);
  // The earlier edit is still there: the insertion is surgical, not a rewrite.
  expect(await readCanvas()).toContain('Sketch[Sketch]');

  // -- The bound node wears its record chip --------------------------------
  const chip = page.getByTestId('whiteboard-record-chip');
  await expect(chip).toHaveCount(1, { timeout: 20_000 });
  await expect(chip).toBeVisible();
  // NOT the title (M29.53): the node's own label IS the record's title, so the
  // chip printed it twice and spent its whole width doing it. The name is in
  // the accessible label below, which is where a screen reader reads it.
  await expect(chip).not.toContainText(pickedTitle);
  // The chip names the record it opens, for a screen reader and for the tooltip.
  await expect(chip).toHaveAttribute('aria-label', `Open ${pickedTitle}`);
  await expect(chip).toHaveAttribute('title', pickedPath);
  // Only the BOUND node gets one: `Sketch` has no click line.
  expect(await page.getByTestId('whiteboard-record-chip').count()).toBe(1);

  // -- …and clicking it opens the record IN PLACE (M9.3) -------------------
  // The detail panel over the canvas you are standing on — the whiteboard is
  // still mounted behind it, which is what `useOpenPath('in-place')` buys.
  await chip.click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await expect(page.getByTestId('detail-panel')).toContainText(pickedTitle);
  await expect(page.getByTestId('whiteboard-view')).toBeVisible();
});

test('whiteboard: reopening the tab finds the same canvas, not a second file', async ({ page }) => {
  // A cold mermaid chunk load again, and the whole point is a NEGATIVE: no
  // second file. Give the (never-arriving) second write room to have happened.
  test.setTimeout(120_000);

  await boot(page);
  await openDeliverySchedule(page);
  await addWhiteboardTab(page);
  await expect(page.getByTestId('whiteboard-view')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => canvasFiles(page), { timeout: 10_000 }).toHaveLength(1);
  const mmdPath = (await canvasFiles(page))[0];
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 30_000 });

  // Away to the List's original tab, and back.
  const tabs = page.getByTestId('view-tabs');
  await tabs.getByRole('tab').first().click();
  await expect(page.getByTestId('whiteboard-view')).toHaveCount(0);
  await tabs.getByRole('tab').last().click();
  await expect(page.getByTestId('whiteboard-view')).toBeVisible();
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 30_000 });

  // Still exactly one canvas, and the SAME one: create-on-open is once for the
  // tab's life, not once per visit. (A per-visit creation would show up as
  // `…-2.mmd`, which is what `write_text_file`'s stem dedupe would mint.)
  await page.waitForTimeout(1_000);
  expect(await canvasFiles(page)).toEqual([mmdPath]);
});

/**
 * M29.53 — the picker says which row Enter will take.
 *
 * MEASURED on the shipped build: 25 options, ArrowDown moved nothing,
 * aria-activedescendant null, every row's computed background rgba(0,0,0,0) —
 * while Enter DID place a record. The cause was one layer down: `autoFocus` is
 * applied when React inserts the element, and a Popover is `visibility: hidden`
 * until it has measured itself, so the search box never received focus at all.
 * jsdom ignores visibility when it decides what is focusable, which is why the
 * unit tests said otherwise.
 */
test('whiteboard: the record picker marks the row Enter will take', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openDeliverySchedule(page);
  await addWhiteboardTab(page);
  await expect(page.getByTestId('whiteboard-view')).toBeVisible({ timeout: 15_000 });
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 30_000 });
  await page.getByTestId('whiteboard-add-record').click();
  await expect(page.getByTestId('whiteboard-record-picker')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const opts = [...document.querySelectorAll('[data-testid="whiteboard-add-option"]')];
    return {
      activeDescendant: active?.getAttribute('aria-activedescendant'),
      options: opts.length,
      marked: opts.filter((o) => o.getAttribute('aria-selected') === 'true').length,
      painted: opts.filter((o) => getComputedStyle(o).backgroundColor !== 'rgba(0, 0, 0, 0)')
        .length,
      markedIsSecond: opts[1]?.getAttribute('aria-selected') === 'true',
    };
  });
  console.log('V2', JSON.stringify(state));
  expect(state.marked).toBe(1);
  expect(state.painted).toBe(1);
  expect(state.markedIsSecond).toBe(true);
  expect(state.activeDescendant).toBeTruthy();
});

test('whiteboard: a chip adds only what the node does not say, and drags it', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  await openDeliverySchedule(page);
  await addWhiteboardTab(page);
  await expect(page.getByTestId('whiteboard-view')).toBeVisible({ timeout: 15_000 });
  await page
    .getByTestId('structural-host')
    .locator('svg[id^="cerebro-mermaid-"]')
    .waitFor({ timeout: 30_000 });
  await page.getByTestId('whiteboard-add-record').click();
  await page.getByTestId('whiteboard-add-option').first().click();
  await page.waitForTimeout(900);
  const chip = page.getByTestId('whiteboard-record-chip').first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  const node = page.locator('g.node').first();
  const nodeText = (await node.textContent())?.trim() ?? '';
  const chipText = (await chip.textContent())?.trim() ?? '';
  const cb = await chip.boundingBox();
  const nb0 = await node.boundingBox();
  console.log(
    'M29.53 chip — node text:',
    JSON.stringify(nodeText),
    '| chip text:',
    JSON.stringify(chipText),
  );
  expect(chipText).not.toContain(nodeText);

  await page.mouse.move((cb?.x ?? 0) + (cb?.width ?? 0) / 2, (cb?.y ?? 0) + (cb?.height ?? 0) / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      (cb?.x ?? 0) + (cb?.width ?? 0) / 2 - 25 * i,
      (cb?.y ?? 0) + (cb?.height ?? 0) / 2 - 15 * i,
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const nb1 = await node.boundingBox();
  const moved = Math.round(
    Math.abs((nb1?.x ?? 0) - (nb0?.x ?? 0)) + Math.abs((nb1?.y ?? 0) - (nb0?.y ?? 0)),
  );
  const panel = await page.getByTestId('detail-panel').count();
  console.log('M29.53 chip — node moved by', moved, 'px | detail panel opened by the drag:', panel);
  expect(moved).toBeGreaterThan(20);
  expect(panel).toBe(0);
  // A click that goes nowhere still opens the record.
  await chip.click();
  await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 10_000 });
});
