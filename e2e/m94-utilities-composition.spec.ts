import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, chooseSettingsSection, openDestination, seedBeforeBoot } from './boot';

const LONG_TITLE =
  'Review the complete release plan and the decisions still open across every workspace';
const FIXTURES = {
  'records/skills/m94-composition-fixture.md':
    '---\ntype: Skill\nslug: m94-composition-fixture\n---\n\n# ' +
    LONG_TITLE +
    '\n\nRead the existing release decisions before preparing a draft.\n',
  'records/epics/m94-composition-fixture.md':
    '---\ntype: Epic\nstatus: building\ntarget: 2026-08-30\n---\n\n# ' +
    LONG_TITLE +
    '\n\nAn open item for the existing My work list.\n',
};
const SURFACES = [
  { name: 'Knowledge', id: 'knowledge-page', content: '.cb-knowledge-content' },
  { name: 'Agents', id: 'agents-page', content: '.cb-agents-content' },
  { name: 'My work', id: 'mywork-page', content: '.cb-work-groups' },
  { name: 'Settings', id: 'settings-page', content: '.cb-settings-content' },
  { name: 'Library', id: 'library-page', content: '.cb-library-controls' },
] as const;

// Resize the real mounted surface, as a pane does, without changing its
// controller or the viewport. Account for WebKit's non-overlay scrollbar so
// 600/960 mean the inline-size container's actual available width.
async function sizeHost(host: Locator, width: number) {
  await host.evaluate((node, width) => {
    const element = node as HTMLElement;
    element.style.flex = '0 0 auto';
    element.style.maxWidth = 'none';
    element.style.width = width + 'px';
    element.style.width = width + element.offsetWidth - element.clientWidth + 'px';
    element.scrollTop = 0;
  }, width);
  await expect.poll(() => host.evaluate((node) => node.clientWidth)).toBe(width);
}

async function mockFiles(page: Page) {
  return page.evaluate(() =>
    [...window.__cerebroMockFs.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

for (const theme of ['light', 'dark'] as const) {
  for (const surface of SURFACES) {
    test(
      surface.name + ' adopts pane composition without replacing its owner in ' + theme,
      async ({ page }, info) => {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await seedBeforeBoot(page, '__cerebroSeedFiles', FIXTURES);
        await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
        await boot(page, { preserveTheme: true });
        await openDestination(page, surface.name);
        const host = page.getByTestId(surface.id);
        await expect(host).toBeVisible();
        if (surface.name === 'Settings') {
          await chooseSettingsSection(page, 'Other apps');
          await host.getByRole('textbox', { name: 'Client port' }).fill('45678');
        }
        if (surface.name === 'Library') {
          await host.getByRole('textbox', { name: 'Search the library' }).fill(LONG_TITLE);
          await expect(host.getByTestId('library-card')).toHaveCount(1);
        }
        const original = await host.elementHandle();
        const draft =
          surface.name === 'Settings'
            ? await host.getByRole('textbox', { name: 'Client port' }).elementHandle()
            : null;
        const before = await mockFiles(page);
        const heading = host.getByRole('heading', { level: 1 });
        const description = host.locator('.cb-page-description');
        const content = host.locator(surface.content);

        for (const width of [360, 599, 600, 959, 960]) {
          await sizeHost(host, width);
          const inset = width < 600 ? 16 : width < 960 ? 24 : 32;
          const frame = (await host.boundingBox())!;
          const title = (await heading.boundingBox())!;
          const desc = (await description.boundingBox())!;
          const edge = await content.evaluate(
            (node) =>
              node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft),
          );
          expect(Math.abs(title.x - frame.x - inset)).toBeLessThanOrEqual(2);
          expect(Math.abs(desc.x - title.x)).toBeLessThanOrEqual(2);
          expect(Math.abs(edge - title.x)).toBeLessThanOrEqual(2);
          expect(
            Math.abs(title.y - frame.y - (surface.name === 'Settings' ? 32 : 40)),
          ).toBeLessThanOrEqual(2);
          await expect(heading).toHaveCSS(
            'font-size',
            surface.name === 'Settings' ? '24px' : '28px',
          );
          expect(await host.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
          expect(await host.evaluate((node, old) => node === old, original)).toBe(true);

          if (surface.name === 'Settings') {
            const port = host.getByRole('textbox', { name: 'Client port' });
            await expect(port).toHaveValue('45678');
            expect(await port.evaluate((node, old) => node === old, draft)).toBe(true);
          }
          if (surface.name === 'Library') {
            await expect(host.getByRole('textbox', { name: 'Search the library' })).toHaveValue(
              LONG_TITLE,
            );
            const cardTitle = host
              .getByTestId('library-card')
              .getByText(LONG_TITLE, { exact: true });
            expect(await cardTitle.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
              true,
            );
            if (width === 360) {
              expect((await cardTitle.boundingBox())!.height).toBeGreaterThan(32);
              const shelves = host.getByRole('tablist', { name: 'Library section' });
              await host.getByTestId('library-tab-skill').focus();
              // Templates is the last shelf owned by this same LibraryIndex.
              // Workflows is a separate native-backed owner, tested below.
              await page.keyboard.press('ArrowRight');
              await page.keyboard.press('ArrowRight');
              const templates = host.getByTestId('library-tab-template');
              await expect(templates).toBeFocused();
              await expect(templates).toHaveAttribute('aria-selected', 'true');
              const strip = (await shelves.boundingBox())!;
              const selected = (await templates.boundingBox())!;
              expect(selected.x).toBeGreaterThanOrEqual(strip.x - 2);
              expect(selected.x + selected.width).toBeLessThanOrEqual(strip.x + strip.width + 2);
              await page.keyboard.press('Home');
              await expect(host.getByTestId('library-tab-skill')).toHaveAttribute(
                'aria-selected',
                'true',
              );
              await expect(host.getByTestId('library-card')).toHaveCount(1);
            }
            // Content, shelf controls and title share an edge; the cards keep
            // their existing interior padding and density.
            const cardsEdge = await host
              .locator('.cb-library-content')
              .evaluate(
                (node) =>
                  node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft),
              );
            expect(Math.abs(cardsEdge - title.x)).toBeLessThanOrEqual(2);
          }
          if (surface.name === 'Knowledge') {
            const tabsEdge = await host
              .locator('.cb-knowledge-tabs')
              .evaluate(
                (node) =>
                  node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft),
              );
            expect(Math.abs(tabsEdge - title.x)).toBeLessThanOrEqual(2);
            await expect(host.getByRole('navigation', { name: 'Knowledge views' })).toBeVisible();
            await expect(host.getByTestId('concept-list-scroll')).toBeVisible();
          }
          const action =
            surface.name === 'Knowledge'
              ? host.getByTestId('knowledge-start-review')
              : surface.name === 'Agents'
                ? host.getByTestId('agents-new')
                : surface.name === 'Library'
                  ? host.getByRole('button', { name: 'New skill', exact: true }).first()
                  : surface.name === 'Settings'
                    ? host.getByRole('button', { name: 'Save port', exact: true })
                    : host.getByTestId('mywork-row').first();
          await action.focus();
          await action.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(action).toBeFocused();
          const button = (await action.boundingBox())!;
          if (surface.name !== 'My work') expect(button.height).toBe(28);
          expect(button.x).toBeGreaterThanOrEqual(frame.x + inset - 2);
          expect(button.x + button.width).toBeLessThanOrEqual(frame.x + width - inset + 2);
          await page.screenshot({
            path: info.outputPath(surface.id + '-' + width + '-' + theme + '.png'),
            animations: 'disabled',
          });
        }
        expect(await mockFiles(page)).toEqual(before);

        // Keyboard activation reaches each surface's existing task controller.
        if (surface.name === 'Knowledge') {
          await host.getByTestId('knowledge-start-review').press('Enter');
          await expect(page.getByTestId('concept-review-bar')).toBeVisible();
        } else if (surface.name === 'Agents') {
          await host.getByTestId('agents-new').press('Enter');
          await expect(page.getByTestId('library-tab-agent')).toHaveAttribute(
            'aria-selected',
            'true',
          );
        } else if (surface.name === 'My work') {
          await host.getByTestId('mywork-row').first().press('Enter');
          await expect(page.getByTestId('detail-panel')).toBeVisible();
        } else if (surface.name === 'Library') {
          await host.getByRole('button', { name: 'New skill', exact: true }).first().press('Enter');
          await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
        } else {
          await host.getByRole('button', { name: 'Save port', exact: true }).press('Enter');
          await expect(host.getByRole('textbox', { name: 'Client port' })).toHaveValue('45678');
        }
      },
    );
  }

  test('Library End keeps focus on its current last tab across owners in ' + theme, async ({ page }, info) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
    await boot(page, { preserveTheme: true });
    await openDestination(page, 'Library');
    const original = page.getByTestId('library-page');
    await expect(original).toBeVisible();
    await sizeHost(original, 360);
    await original.getByTestId('library-tab-skill').focus();
    await page.keyboard.press('End');

    // End selects the actual final tab, whose owner replaces LibraryIndex.
    // Observe the new strip without restoring focus or adopting the old owner.
    const workflow = page.getByTestId('workflow-library');
    await expect(workflow).toBeVisible();
    await sizeHost(workflow, 360);
    const strip = page.getByRole('tablist', { name: 'Library section' });
    const last = strip.getByRole('tab', { name: 'Workflows', exact: true });
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await info.attach('library-end-owner-observation', {
      body: JSON.stringify(await page.evaluate(() => {
        const active = document.activeElement;
        const selected = document.querySelector('[role="tablist"][aria-label="Library section"] [role="tab"][aria-selected="true"]');
        return { activeTag: active?.tagName ?? null, activeRole: active?.getAttribute('role') ?? null, activeTestId: active?.getAttribute('data-testid') ?? null, activeText: active?.textContent ?? null, selectedText: selected?.textContent ?? null, selectedHasFocus: active === selected };
      })),
      contentType: 'application/json',
    });
    await expect(last).toBeFocused();
    const frame = (await strip.boundingBox())!;
    const selected = (await last.boundingBox())!;
    expect(selected.x).toBeGreaterThanOrEqual(frame.x - 2);
    expect(selected.x + selected.width).toBeLessThanOrEqual(frame.x + frame.width + 2);

    await page.keyboard.press('Home');
    const first = page.getByRole('tablist', { name: 'Library section' }).getByRole('tab', { name: /^Skills(?:\s|$)/ });
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(first).toBeFocused();
  });

  test(
    'compact Settings retains an invalid draft through repair navigation in ' + theme,
    async ({ page }, info) => {
      await page.setViewportSize({ width: 900, height: 600 });
      await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
      await boot(page, { preserveTheme: true });
      await openDestination(page, 'Settings');
      await chooseSettingsSection(page, 'Other apps');
      const host = page.getByTestId('settings-page');
      const port = host.getByRole('textbox', { name: 'Client port' });
      await port.fill('1');
      const original = await port.elementHandle();
      await host.getByRole('button', { name: 'Save port', exact: true }).press('Enter');
      await expect(port).toHaveValue('1');
      await expect(
        page.getByText('Choose a port from 1024 to 65535.', { exact: true }),
      ).toBeVisible();
      await chooseSettingsSection(page, 'General');
      await chooseSettingsSection(page, 'Other apps');
      await expect(port).toHaveValue('1');
      expect(await port.evaluate((node, old) => node === old, original)).toBe(true);
      await port.fill('45678');
      await host.getByRole('button', { name: 'Save port', exact: true }).press('Enter');
      await expect(port).toHaveValue('45678');
      const sections = host.getByRole('button', { name: 'Sections', exact: true });
      await sections.press('Enter');
      const navigation = page.getByRole('navigation', { name: 'Settings sections' });
      const general = navigation.getByRole('button', { name: 'General', exact: true });
      await general.focus();
      await general.press('Enter');
      await expect(sections).toBeFocused();
      await expect(page.getByTestId('sidebar')).toBeHidden();
      await expect(host.getByTestId('settings-heading')).toHaveText('General');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        900,
      );
      await page.screenshot({
        path: info.outputPath('settings-repair-return-' + theme + '.png'),
        animations: 'disabled',
      });
    },
  );
}

// Visual regressions supplement the original 24 acceptance cases above.
async function primaryStatusClipping(scroll: Locator) {
  return scroll.evaluate((node) => {
    const port = node as HTMLElement;
    const bounds = port.getBoundingClientRect();
    const left = bounds.left + port.clientLeft;
    const right = left + port.clientWidth - (port.scrollWidth > port.clientWidth + 2 ? 32 : 0);
    const failures: { label: string; reason: string }[] = [];
    for (const primary of port.querySelectorAll<HTMLElement>('[data-status-value]')) {
      const label = primary.lastElementChild as HTMLElement | null;
      const cell = primary.closest<HTMLElement>('[role="cell"]');
      if (label === null || cell === null) continue;
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const cellBox = cell.getBoundingClientRect();
      const labelText = label.textContent ?? '';
      if (label.scrollWidth > label.clientWidth + 1) {
        failures.push({ label: labelText, reason: 'text truncated inside its label' });
      }
      if (text.left < cellBox.left - 1 || text.right > cellBox.right + 1) {
        failures.push({ label: labelText, reason: 'text clipped by its status cell' });
      }
      if (text.left < left - 1 || text.right > right + 1) {
        failures.push({ label: labelText, reason: 'text outside the unfaded scrollport' });
      }
    }
    return failures;
  });
}

// Check complete units, not merely a non-empty viewport intersection.
async function knowledgeReadability(scroll: Locator) {
  return scroll.evaluate((node) => {
    const port = node as HTMLElement;
    const bounds = port.getBoundingClientRect();
    const left = bounds.left + port.clientLeft;
    const right = left + port.clientWidth - (port.scrollWidth > port.clientWidth + 2 ? 32 : 0);
    const failures: string[] = [];
    const words: { word: string; lines: number; rowHeight: number; titleWidth: number }[] = [];
    for (const element of port.querySelectorAll<HTMLElement>(
      '[data-status-value], [data-testid="concept-proposal"], [data-testid="queue-proposal"], [data-concept-title]',
    )) {
      const cell = element.closest<HTMLElement>('[role="cell"]');
      if (cell === null) continue;
      const cellBox = cell.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (
          rect.left < Math.max(left, cellBox.left) - 1 ||
          rect.right > Math.min(right, cellBox.right) + 1 ||
          rect.top < cellBox.top - 1 ||
          rect.bottom > cellBox.bottom + 1
        ) {
          failures.push((element.textContent ?? '') + ': text outside its complete visible cell');
        }
      }
      if (element.hasAttribute('data-concept-title')) {
        const text = element.firstChild;
        if (text?.nodeType !== Node.TEXT_NODE) continue;
        for (const word of ['Onboarding', 'Warehouse']) {
          const index = (text.textContent ?? '').indexOf(word);
          if (index < 0) continue;
          range.setStart(text, index);
          range.setEnd(text, index + word.length);
          const lines = new Set(
            Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)),
          ).size;
          const row = cell.closest<HTMLElement>('[role="row"]');
          words.push({
            word,
            lines,
            rowHeight: row?.getBoundingClientRect().height ?? 0,
            titleWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
          });
          if (lines !== 1)
            failures.push(word + ': ordinary word fragmented across ' + lines + ' lines');
        }
      } else {
        const unit = element.getBoundingClientRect();
        if (
          unit.left < Math.max(left, cellBox.left) - 1 ||
          unit.right > Math.min(right, cellBox.right) + 1 ||
          unit.top < cellBox.top - 1 ||
          unit.bottom > cellBox.bottom + 1
        ) {
          failures.push((element.textContent ?? '') + ': complete status/proposal unit clipped');
        }
      }
    }
    return { failures, words };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(
    'Library visual regression: growing the pane retains populated columns in ' + theme,
    async ({ page }, info) => {
      const prefix = 'Visual column fixture';
      const cards = Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [
          'records/skills/m94-visual-column-' + index + '.md',
          '---\ntype: Skill\nslug: m94-visual-column-' +
            index +
            '\n---\n\n# ' +
            prefix +
            ' ' +
            index +
            ': ' +
            LONG_TITLE +
            '\n\nRead the existing decisions.\n',
        ]),
      );
      await page.setViewportSize({ width: 1600, height: 1000 });
      await seedBeforeBoot(page, '__cerebroSeedFiles', cards);
      await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
      await boot(page, { preserveTheme: true });
      await openDestination(page, 'Library');
      const host = page.getByTestId('library-page');
      const search = host.getByRole('textbox', { name: 'Search the library' });
      await search.fill(prefix);
      await expect(host.getByTestId('library-card')).toHaveCount(6);
      const originalSearch = await search.elementHandle();
      const before = await mockFiles(page);
      let previous: { width: number; columns: number; cardWidth: number } | null = null;
      for (const [index, width] of [599, 600, 959, 960, 959, 960].entries()) {
        await sizeHost(host, width);
        const boxes = await host.getByTestId('library-card').evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width };
          }),
        );
        const top = Math.min(...boxes.map((box) => box.y));
        const columns = boxes.filter((box) => Math.abs(box.y - top) <= 2).length;
        expect(columns).toBe(width < 959 ? 1 : 2);
        if (previous !== null && width > previous.width) {
          expect(columns, 'columns must not disappear when the pane grows').toBeGreaterThanOrEqual(
            previous.columns,
          );
          if (previous.width === 959 && width === 960) {
            expect(columns).toBe(previous.columns);
            expect(Math.abs(boxes[0].width - previous.cardWidth)).toBeLessThanOrEqual(16);
          }
        }
        previous = { width, columns, cardWidth: boxes[0].width };
        await expect(search).toHaveValue(prefix);
        expect(await search.evaluate((node, original) => node === original, originalSearch)).toBe(
          true,
        );
        expect(await host.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        for (const card of await host.getByTestId('library-card').all()) {
          const title = card.getByText(new RegExp('^' + prefix));
          expect(await title.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
        if (index === 2 || index === 3) {
          await host.getByRole('button', { name: 'New skill', exact: true }).first().focus();
          await page.screenshot({
            path: info.outputPath('library-populated-' + width + '-' + theme + '.png'),
            animations: 'disabled',
          });
        }
      }
      expect(await mockFiles(page)).toEqual(before);
    },
  );

  test(
    'Knowledge visual regression: titles and status stay readable at 360 in ' + theme,
    async ({ page }, info) => {
      const unknownPath = 'knowledge/metrics/m94-visual-unknown-source.md';
      await seedBeforeBoot(page, '__cerebroSeedFiles', {
        [unknownPath]:
          '---\ntype: Metric\ntitle: Visual unknown source fixture\nlifecycle: stable\n---\n\n# Definition\n\nNo source count was recorded.\n',
      });
      await page.setViewportSize({ width: 2000, height: 1000 });
      await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
      await boot(page, { preserveTheme: true });
      await openDestination(page, 'Knowledge');
      const host = page.getByTestId('knowledge-page');
      const unknown = host.locator('[data-testid="concept-row"][data-path="' + unknownPath + '"]');
      await sizeHost(host, 1500);
      await expect(unknown.locator('[data-column="sources"]')).toHaveText('not recorded');
      const before = await mockFiles(page);
      for (const tab of ['all', 'review'] as const) {
        await host.getByTestId('knowledge-tab-' + tab).click();
        await sizeHost(host, 360);
        const scroll = host.getByTestId(
          tab === 'all' ? 'concept-list-scroll' : 'review-queue-scroll',
        );
        await expect(scroll).toBeVisible();
        await expect(scroll.locator('[data-status-value]').first()).toBeVisible();
        await expect(
          scroll.locator('[data-status-value]').filter({ hasText: 'Unreviewed' }).first(),
        ).toBeVisible();
        await scroll.evaluate((node) => {
          node.scrollLeft = 0;
        });
        await expect.poll(() => primaryStatusClipping(scroll)).toEqual([]);
        // At rest, the full primary/proposal units and ordinary title words
        // must be readable before any hover, focus or scrolling helps them.
        await expect.poll(async () => (await knowledgeReadability(scroll)).failures).toEqual([]);
        const readability = await knowledgeReadability(scroll);
        expect(readability.words.some((word) => word.word === 'Warehouse')).toBe(true);
        if (tab === 'all')
          expect(readability.words.some((word) => word.word === 'Onboarding')).toBe(true);
        await info.attach('knowledge-readability-' + tab, {
          body: JSON.stringify(readability),
          contentType: 'application/json',
        });
        const headers = scroll.getByRole('columnheader');
        await expect(headers).toHaveCount(2);
        await expect(headers.nth(0)).toHaveText('Concept');
        await expect(headers.nth(1)).toHaveText('Status');
        const originalScroll = await scroll.elementHandle();
        const rows = scroll.getByTestId(tab === 'all' ? 'concept-row' : 'queue-row');
        expect(await rows.count()).toBeGreaterThan(1);
        const originalFirstRow = await rows.first().elementHandle();
        await scroll.focus();
        await expect(scroll).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(0)).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(1)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(rows.nth(0)).toBeFocused();
        await page.keyboard.press('End');
        await expect(rows.last()).toBeFocused();
        await page.keyboard.press('Home');
        await expect(rows.first()).toBeFocused();
        const extent = await scroll.evaluate((node) => node.scrollWidth - node.clientWidth);
        if (extent > 2) {
          // Native wheel reachability applies only to a genuinely overflowing
          // box. Plain Right has no application scrolling contract.
          const box = await scroll.boundingBox();
          expect(box).not.toBeNull();
          await page.mouse.move(
            box!.x + box!.width / 2,
            Math.max(box!.y + 1, Math.min(box!.y + box!.height / 2, 900)),
          );
          await page.mouse.wheel(160, 0);
          await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        } else {
          expect(await scroll.evaluate((node) => node.scrollLeft)).toBe(0);
        }
        const metadata = scroll
          .getByTestId(tab === 'all' ? 'concept-proposal' : 'queue-proposal')
          .filter({ hasText: '+1 link' })
          .first();
        await expect(metadata).toBeVisible();
        await metadata.hover();
        await expect(metadata.locator('[title]')).toHaveAttribute('title', /^Add a link:/);
        expect(await scroll.evaluate((node, original) => node === original, originalScroll)).toBe(
          true,
        );
        await scroll.evaluate((node) => {
          node.scrollLeft = 0;
        });
        await expect.poll(() => primaryStatusClipping(scroll)).toEqual([]);
        expect(await host.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({
          path: info.outputPath('knowledge-primary-' + tab + '-360-' + theme + '.png'),
          animations: 'disabled',
        });
        await sizeHost(host, 1500);
        await expect.poll(() => headers.count()).toBeGreaterThan(2);
        expect(
          await rows.first().evaluate((node, original) => node === original, originalFirstRow),
        ).toBe(true);
        expect(await scroll.evaluate((node, original) => node === original, originalScroll)).toBe(
          true,
        );
      }
      await host.getByTestId('knowledge-tab-all').click();
      await sizeHost(host, 1500);
      await expect(unknown.locator('[data-column="sources"]')).toHaveText('not recorded');
      expect(await mockFiles(page)).toEqual(before);
    },
  );
}

// Compact polish regressions are independent of the preserved 32 cases above.
async function settleCompactLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function compactOpenGeometry(button: Locator) {
  return button.evaluate((node) => {
    const element = node as HTMLElement;
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    const lines = new Set(rects.map((rect) => Math.round(rect.top))).size;
    const failures: string[] = [];
    if (lines !== 1) failures.push('Open word spans ' + lines + ' lines');
    if (
      rects.some(
        (rect) =>
          rect.left < box.left - 1 ||
          rect.right > box.right + 1 ||
          rect.top < box.top - 1 ||
          rect.bottom > box.bottom + 1,
      )
    ) {
      failures.push('Open text leaves its button');
    }
    const cell = element.closest<HTMLElement>('[role="cell"]');
    const cellBox = cell?.getBoundingClientRect();
    if (
      cellBox === undefined ||
      box.left < cellBox.left - 1 ||
      box.right > cellBox.right + 1 ||
      box.top < cellBox.top - 1 ||
      box.bottom > cellBox.bottom + 1
    ) {
      failures.push('Open button leaves its title cell');
    }
    return {
      failures,
      text: element.textContent?.trim() ?? '',
      lines,
      width: box.width,
      height: box.height,
      opacity: getComputedStyle(element).opacity,
    };
  });
}

async function compactNavigationGeometry(host: Locator) {
  return host.evaluate((node) => {
    const nav = node.querySelector<HTMLElement>('nav[aria-label="Knowledge views"]');
    if (nav === null) throw new Error('Knowledge navigation missing');
    const box = nav.getBoundingClientRect();
    const action = node.querySelector<HTMLElement>('[data-testid="knowledge-start-review"]');
    const actionBox = action?.getBoundingClientRect();
    const failures: string[] = [];
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('button')).map((button) => {
      const rect = button.getBoundingClientRect();
      const label = Array.from(button.childNodes)
        .filter((part) => part.nodeType === Node.TEXT_NODE)
        .map((part) => part.textContent ?? '')
        .join('')
        .trim();
      if (
        rect.left < box.left - 1 ||
        rect.right > box.right + 1 ||
        rect.top < box.top - 1 ||
        rect.bottom > box.bottom + 1
      )
        failures.push(label + ': button clipped by navigation');
      const range = document.createRange();
      range.selectNodeContents(button);
      for (const text of Array.from(range.getClientRects())) {
        if (
          text.width > 0 &&
          text.height > 0 &&
          (text.left < Math.max(box.left, rect.left) - 1 ||
            text.right > Math.min(box.right, rect.right) + 1 ||
            text.top < rect.top - 1 ||
            text.bottom > rect.bottom + 1)
        )
          failures.push(label + ': label/icon/count clipped');
      }
      if (
        actionBox !== undefined &&
        rect.left < actionBox.right &&
        rect.right > actionBox.left &&
        rect.top < actionBox.bottom &&
        rect.bottom > actionBox.top
      )
        failures.push(label + ': overlaps review action');
      return {
        label,
        text: button.textContent ?? '',
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
    if (nav.scrollWidth > nav.clientWidth + 1)
      failures.push('Navigation still needs horizontal scrolling');
    return {
      failures,
      buttons,
      clientWidth: nav.clientWidth,
      scrollWidth: nav.scrollWidth,
      actionHeight: actionBox?.height ?? null,
    };
  });
}

async function compactFleetGeometry(host: Locator) {
  return host.evaluate((node) => {
    const port = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const left = port.left + parseFloat(style.paddingLeft);
    const right = port.right - parseFloat(style.paddingRight);
    const failures: string[] = [];
    const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-testid="fleet-row"]')).map(
      (row) => {
        const box = row.getBoundingClientRect();
        const line = row.querySelector<HTMLElement>('[data-slot="trace-line"]');
        if (line === null) throw new Error('Fleet trace missing');
        // Read existing semantic content, not the new presentation hooks, so
        // the same assertions observe real clipping before product adoption.
        const facts = Array.from(line.children)
          .filter(
            (child): child is HTMLElement =>
              child instanceof HTMLElement &&
              !child.matches('.sr-only, [data-testid="fleet-actor"], [data-testid="run-why"]') &&
              (child.textContent ?? '').trim() !== '',
          )
          .map((fact) => {
            const range = document.createRange();
            range.selectNodeContents(fact);
            const rects = Array.from(range.getClientRects()).filter(
              (rect) => rect.width > 0 && rect.height > 0,
            );
            const text = (fact.textContent ?? '').trim();
            if (rects.length === 0)
              failures.push(row.dataset.run + ': ' + text + ': no text geometry');
            for (const rect of rects) {
              if (
                rect.left < Math.max(left, box.left) - 1 ||
                rect.right > Math.min(right, box.right) + 1 ||
                rect.top < box.top - 1 ||
                rect.bottom > box.bottom + 1
              )
                failures.push(row.dataset.run + ': ' + text + ': fact clipped');
            }
            return text;
          });
        const actor = row.querySelector<HTMLElement>('[data-testid="fleet-actor"]');
        const why = row.querySelector<HTMLElement>('[data-testid="run-why"]');
        if (actor === null || why === null || actor.clientWidth < 48 || why.clientWidth < 48)
          failures.push(row.dataset.run + ': actor/reason lost meaningful width');
        return {
          run: row.dataset.run ?? '',
          facts,
          actor: actor?.textContent ?? null,
          actorTitle: actor?.getAttribute('title') ?? null,
          why: why?.textContent ?? null,
          whyTitle: why?.getAttribute('title') ?? null,
          actorWidth: actor?.clientWidth ?? null,
          whyWidth: why?.clientWidth ?? null,
          height: box.height,
        };
      },
    );
    return { failures, rows };
  });
}

type CompactRun = import('../src/lib/ipc').FleetRun;
type CompactDetail = import('../src/lib/ipc').FleetRunDetail;
const COMPACT_RECORDED: CompactRun = {
  run_id: 'compact-recorded',
  actor: 'agent:m26-ingest',
  vault_id: 'v1',
  mode: 'ambient',
  lane: 'filed',
  started_at: '2026-07-28T10:00:00Z',
  ended_at: '2026-07-28T10:01:00Z',
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 1200,
  output_tokens: 300,
  proposals_submitted: 2,
  applied: 1,
  rejected: 1,
  parent_run_id: null,
  cause: {
    kind: 'ingest',
    why: 'background ingest of new material',
    subject: null,
    detail: null,
    due_at: null,
  },
  cli_session_id: null,
};
const COMPACT_RUNS: CompactRun[] = [
  COMPACT_RECORDED,
  {
    ...COMPACT_RECORDED,
    run_id: 'compact-legacy',
    actor: null,
    cause: null,
    started_at: '2026-07-28T09:00:00Z',
    ended_at: null,
    outcome: 'abandoned_usage_unknown',
    usage_state: 'unknown',
    input_tokens: 0,
    output_tokens: 0,
    proposals_submitted: null,
    applied: null,
    rejected: null,
  },
  {
    ...COMPACT_RECORDED,
    run_id: 'compact-hop',
    actor: 'process:weekly-digest',
    parent_run_id: 'compact-recorded',
    started_at: '2026-07-28T10:00:10Z',
    ended_at: '2026-07-28T10:00:40Z',
    input_tokens: 0,
    output_tokens: 0,
    proposals_submitted: 0,
    applied: 0,
    rejected: 0,
  },
];
const COMPACT_DETAILS: Record<string, CompactDetail> = Object.fromEntries(
  COMPACT_RUNS.map((run) => [
    run.run_id,
    {
      run,
      cost_components: null,
      assembly: null,
      model_id: null,
      refusals: [],
      refusals_total: 0,
      wrote: { state: 'not_recorded' },
    } satisfies CompactDetail,
  ]),
);

for (const theme of ['light', 'dark'] as const) {
  test(
    'compact Open label stays whole on its existing concept row in ' + theme,
    async ({ page }, info) => {
      await page.setViewportSize({ width: 2000, height: 1000 });
      await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
      await boot(page, { preserveTheme: true });
      await openDestination(page, 'Knowledge');
      const host = page.getByTestId('knowledge-page');
      const before = await mockFiles(page);
      for (const tab of ['all', 'review'] as const) {
        await host.getByTestId('knowledge-tab-' + tab).click();
        const scroll = host.getByTestId(
          tab === 'all' ? 'concept-list-scroll' : 'review-queue-scroll',
        );
        const rows = scroll.getByTestId(tab === 'all' ? 'concept-row' : 'queue-row');
        const row = rows.filter({
          has: page.locator('[data-concept-title]').filter({
            hasText:
              tab === 'all'
                ? /^Onboarding completion$/
                : /^Warehouse cutover: go-live and rollback$/,
          }),
        });
        await expect(row).toHaveCount(1);
        const button = row.getByTestId('concept-open');
        const originalRow = await row.elementHandle();
        const originalButton = await button.elementHandle();
        const originalScroll = await scroll.elementHandle();
        const title = await row.locator('[data-concept-title]').innerText();
        await sizeHost(host, 360);
        await settleCompactLayout(page);
        await row.hover();
        if (tab === 'all') {
          await page.screenshot({
            path: info.outputPath('compact-open-all-360-' + theme + '.png'),
            animations: 'disabled',
          });
          await info.attach('compact-open-observation', {
            body: JSON.stringify({
              version: 1,
              project: info.project.name,
              theme,
              width: 360,
              view: tab,
              geometry: await compactOpenGeometry(button),
            }),
            contentType: 'application/json',
          });
        }
        await expect.poll(async () => (await compactOpenGeometry(button)).failures).toEqual([]);
        await expect(button).toHaveText('Open');
        await expect(button).toHaveAttribute('aria-label', 'Open ' + title);
        const initial = await compactOpenGeometry(button);
        expect(initial.width).toBeGreaterThanOrEqual(28);
        expect(initial.height).toBe(28);
        await expect(button).toHaveCSS('opacity', '1');
        await expect.poll(async () => (await knowledgeReadability(scroll)).failures).toEqual([]);
        for (const width of [960, 360]) {
          await sizeHost(host, width);
          await settleCompactLayout(page);
          await row.hover();
          await expect.poll(async () => (await compactOpenGeometry(button)).failures).toEqual([]);
          expect(await row.evaluate((node, original) => node === original, originalRow)).toBe(true);
          expect(await button.evaluate((node, original) => node === original, originalButton)).toBe(
            true,
          );
          expect(await scroll.evaluate((node, original) => node === original, originalScroll)).toBe(
            true,
          );
          if (width === 360)
            await expect
              .poll(async () => (await knowledgeReadability(scroll)).failures)
              .toEqual([]);
          if (width === 960 && tab === 'all')
            await page.screenshot({
              path: info.outputPath('compact-open-all-960-' + theme + '.png'),
              animations: 'disabled',
            });
        }
        // Exercise the real row cursor before native opener activation. Focus
        // plus Enter below proves activation, not sequential Tab traversal.
        await scroll.focus();
        await page.keyboard.press('Home');
        await expect(rows.first()).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(1)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(rows.first()).toBeFocused();
        await button.focus();
        await expect(button).toBeFocused();
        await expect(button).toHaveCSS('opacity', '1');
        if (tab === 'review')
          await page.screenshot({
            path: info.outputPath('compact-open-review-360-' + theme + '.png'),
            animations: 'disabled',
          });
        if (tab === 'all') await button.click();
        else await button.press('Enter');
        await expect(page.getByTestId('concept-title')).toHaveValue(title);
        await expect(page.getByTestId('concept-review-bar')).toBeVisible();
        if (tab === 'review')
          await expect(page.getByTestId('review-pager')).toContainText(/Review \d+ of \d+/);
        // Same established Back command used by history-state.spec.ts, after
        // leaving the editor's focus so it cannot consume an editing shortcut.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('ControlOrMeta+[');
        await expect(host.getByTestId('knowledge-tab-' + tab)).toHaveAttribute(
          'aria-current',
          'page',
        );
      }
      expect(await mockFiles(page)).toEqual(before);
    },
  );

  test(
    'compact Knowledge navigation shows every existing view at rest in ' + theme,
    async ({ page }, info) => {
      await page.setViewportSize({ width: 2000, height: 1000 });
      await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
      await boot(page, { preserveTheme: true });
      await openDestination(page, 'Knowledge');
      const host = page.getByTestId('knowledge-page');
      const nav = host.getByRole('navigation', { name: 'Knowledge views' });
      await expect(host.getByTestId('knowledge-tab-review')).toHaveText(/^Review\d+$/);
      const buttons = nav.getByRole('button');
      const identities = await buttons.elementHandles();
      const counts = await buttons.allTextContents();
      const before = await mockFiles(page);
      for (const [index, width] of [360, 599, 600, 959, 960, 360].entries()) {
        await sizeHost(host, width);
        await settleCompactLayout(page);
        if (index === 0) {
          await page.screenshot({
            path: info.outputPath('compact-knowledge-views-360-' + theme + '.png'),
            animations: 'disabled',
          });
          await info.attach('compact-knowledge-navigation-observation', {
            body: JSON.stringify({
              version: 1,
              project: info.project.name,
              theme,
              width,
              geometry: await compactNavigationGeometry(host),
            }),
            contentType: 'application/json',
          });
        }
        await expect.poll(async () => (await compactNavigationGeometry(host)).failures).toEqual([]);
        const geometry = await compactNavigationGeometry(host);
        expect(geometry.buttons.map((button) => button.label)).toEqual([
          'Concepts',
          'Review',
          'Activity',
        ]);
        expect(geometry.buttons.map((button) => button.height)).toEqual([32, 32, 32]);
        expect(geometry.actionHeight).toBe(28);
        if (width === 960) {
          expect(new Set(geometry.buttons.map((button) => Math.round(button.y))).size).toBe(1);
          await page.screenshot({
            path: info.outputPath('compact-knowledge-views-960-' + theme + '.png'),
            animations: 'disabled',
          });
        }
        await expect(buttons).toHaveText(counts);
        for (const [i, original] of identities.entries())
          expect(await buttons.nth(i).evaluate((node, old) => node === old, original)).toBe(true);
        expect(await host.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await host.getByTestId('knowledge-tab-activity').click();
      await expect(host.getByTestId('knowledge-tab-activity')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(host.getByTestId('knowledge-system')).toBeVisible();
      await expect.poll(async () => (await compactNavigationGeometry(host)).failures).toEqual([]);
      await page.screenshot({
        path: info.outputPath('compact-knowledge-activity-360-' + theme + '.png'),
        animations: 'disabled',
      });
      await page.keyboard.press('ControlOrMeta+[');
      await expect(host.getByTestId('knowledge-tab-all')).toHaveAttribute('aria-current', 'page');
      await host.getByTestId('knowledge-tab-review').focus();
      await host.getByTestId('knowledge-tab-review').press('Enter');
      await expect(host.getByTestId('review-queue-scroll')).toBeVisible();
      await host.getByTestId('knowledge-start-review').press('Enter');
      await expect(page.getByTestId('concept-review-bar')).toBeVisible();
      expect(await mockFiles(page)).toEqual(before);
    },
  );

  test(
    'compact Agents facts stay readable on their existing run buttons in ' + theme,
    async ({ page }, info) => {
      await page.setViewportSize({ width: 2000, height: 1000 });
      await seedBeforeBoot(page, '__cerebroSeedFleet', COMPACT_RUNS, COMPACT_DETAILS);
      await page.addInitScript((mode) => localStorage.setItem('cerebro.themeMode', mode), theme);
      await boot(page, { preserveTheme: true });
      await openDestination(page, 'Agents');
      const host = page.getByTestId('agents-page');
      const fleet = host.getByTestId('fleet-section');
      const rows = fleet.getByTestId('fleet-row');
      await expect(rows).toHaveCount(3);
      const before = await mockFiles(page);
      const rowKeys = ['compact-recorded', 'compact-hop', 'compact-legacy'];
      const identities = await rows.elementHandles();
      const filters = await fleet.locator('[data-testid^="fleet-filter-"]').allTextContents();
      await expect(fleet.locator('[data-hops="compact-recorded"]')).toContainText(
        '0 applied · 0 rejected',
      );
      const measured = fleet.locator('[data-testid="fleet-row"][data-run="compact-recorded"]');
      const legacy = fleet.locator('[data-testid="fleet-row"][data-run="compact-legacy"]');
      await expect(measured).toContainText('1,500 tokens');
      await expect(measured).toContainText('1 applied · 1 rejected');
      await expect(measured.getByTestId('fleet-took')).toHaveText('1m');
      await expect(measured.getByTestId('fleet-actor')).toHaveAttribute(
        'title',
        'agent:m26-ingest',
      );
      await expect(measured.getByTestId('run-why')).toHaveAttribute(
        'title',
        'background ingest of new material',
      );
      await expect(legacy.getByTestId('fleet-actor')).toHaveText('unattributed');
      await expect(legacy.getByTestId('usage-unknown')).toHaveText('unknown');
      await expect(legacy.getByTestId('proposals-unrecorded')).toHaveText('proposals not recorded');
      await expect(legacy.getByTestId('run-why')).toHaveText('why not recorded');
      await expect(legacy.getByTestId('run-why')).toHaveAttribute('title', 'why not recorded');
      await expect(
        fleet.locator('[data-testid="fleet-row"][data-run="compact-hop"]'),
      ).toContainText('0 tokens');
      await expect(legacy.getByTestId('fleet-took')).toHaveCount(0);
      let baseline: string[][] | null = null;
      for (const [index, width] of [360, 960, 360].entries()) {
        await sizeHost(host, width);
        await settleCompactLayout(page);
        await fleet.scrollIntoViewIfNeeded();
        if (index === 0) {
          await page.screenshot({
            path: info.outputPath('compact-fleet-360-' + theme + '.png'),
            animations: 'disabled',
          });
          await info.attach('compact-fleet-observation', {
            body: JSON.stringify({
              version: 1,
              project: info.project.name,
              theme,
              width,
              geometry: await compactFleetGeometry(host),
            }),
            contentType: 'application/json',
          });
        }
        await expect.poll(async () => (await compactFleetGeometry(host)).failures).toEqual([]);
        const geometry = await compactFleetGeometry(host);
        expect(geometry.rows.map((row) => row.run)).toEqual(rowKeys);
        expect(geometry.rows.every((row) => row.facts.length >= 5)).toBe(true);
        if (baseline === null) baseline = geometry.rows.map((row) => row.facts);
        else expect(geometry.rows.map((row) => row.facts)).toEqual(baseline);
        for (const [i, original] of identities.entries())
          expect(await rows.nth(i).evaluate((node, old) => node === old, original)).toBe(true);
        await expect(fleet.locator('[data-testid^="fleet-filter-"]')).toHaveText(filters);
        expect(await host.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        if (width === 960)
          await page.screenshot({
            path: info.outputPath('compact-fleet-960-' + theme + '.png'),
            animations: 'disabled',
          });
      }
      const hop = fleet.locator('[data-testid="fleet-row"][data-run="compact-hop"]');
      await hop.focus();
      await expect(hop).toBeFocused();
      await hop.press('Enter');
      await expect(page.getByTestId('run-detail')).toHaveAttribute('data-run', 'compact-hop');
      await page.screenshot({
        path: info.outputPath('compact-fleet-detail-360-' + theme + '.png'),
        animations: 'disabled',
      });
      await page.getByTestId('run-detail-close').click();
      await measured.click();
      await expect(page.getByTestId('run-detail')).toHaveAttribute('data-run', 'compact-recorded');
      expect(await mockFiles(page)).toEqual(before);
    },
  );
}
