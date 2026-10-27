import { expect, test, type Frame, type Page, type Request, type Response } from '@playwright/test';
import { boot, showDatabases } from './boot';

const fixturePrefix = 'selection-range/';
const targetPath = 'selection-range/002.md';
const suffix = 'RangeFind東京8642';

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

async function openFixture(page: Page) {
  // Use the singleton actually requested by this mounted app, including its HMR query.
  const mountedStore: { url: string | null } = { url: null };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/src/stores/vaultStore.ts')
      mountedStore.url = request.url();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    ({ suffix }) => {
      const seed = () => {
        const fs = window.__cerebroMockFs;
        if (!fs) {
          setTimeout(seed, 10);
          return;
        }
        fs.set(
          'types/selection-range.md',
          `---
type: Type
fields:
  detail: { kind: text }
views:
  - id: selection-range
    name: Selection range
    presentation:
      type: table
      sort: [{ field: title, dir: asc }]
      columns: [{ field: detail, width: 200 }]
---
# Selection range compatibility
`,
        );
        for (let i = 0; i < 3; i++) {
          const id = String(i).padStart(3, '0');
          const detail = i === 2 ? `${'unbrokenvalue'.repeat(50)}${suffix}` : `Fits ${id}`;
          fs.set(
            `selection-range/${id}.md`,
            `---
type: Selection range compatibility
detail: ${JSON.stringify(detail)}
---
# Selection range record ${id}
`,
          );
        }
      };
      seed();
    },
    { suffix },
  );
  await boot(page);
  await showDatabases(page);
  await page
    .getByTestId('sidebar-type')
    .filter({ hasText: 'Selection range compatibility' })
    .click();
  await expect(page.getByTestId('table-row')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  await expect(target(page)).toHaveText('unbrokenvalue'.repeat(50) + suffix);
  return mountedStore;
}

// Test-local module identity only; no request bodies, new requests or alternate store.
function observeMountedStore(page: Page) {
  const responses = new WeakMap<Request, number | null>();
  let url: string | null = null;
  let pending = 0;
  let completed = 0;
  let navigations = 0;
  let failure: string | null = null;
  let identity: { url: string; origin: string; pageUrl: string } | null = null;
  const onRequest = (request: Request) => {
    const rawUrl = request.url();
    if (new URL(rawUrl).pathname !== '/src/stores/vaultStore.ts') return;
    if (identity !== null) failure = 'Mounted store was requested after its identity was frozen';
    if (url !== null && url !== rawUrl)
      failure = 'Distinct mounted-store module URLs were requested';
    url ??= rawUrl;
    try {
      if (request.method() !== 'GET' || request.frame() !== page.mainFrame())
        failure = 'Mounted store must be a GET in the main page realm';
    } catch {
      failure = 'Mounted-store request has no identifiable page realm';
    }
    responses.set(request, null);
    pending++;
  };
  const onResponse = (response: Response) => {
    if (responses.has(response.request())) responses.set(response.request(), response.status());
  };
  const onFinished = (request: Request) => {
    if (!responses.has(request)) return;
    const status = responses.get(request);
    responses.delete(request);
    pending--;
    if (status !== 200) failure = 'Mounted-store request did not complete with a recorded 200';
    else completed++;
  };
  const onFailed = (request: Request) => {
    if (!responses.has(request)) return;
    responses.delete(request);
    pending--;
    failure = 'Mounted-store request failed';
  };
  const onNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    navigations++;
    if (navigations > 1) failure = 'Page navigation made the mounted-store identity ambiguous';
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  return {
    freeze() {
      if (failure !== null) throw new Error(failure);
      if (url === null || completed === 0 || pending !== 0 || navigations !== 1)
        throw new Error('Mounted store needs completed requests in one page navigation');
      const pageUrl = page.url();
      const origin = new URL(pageUrl).origin;
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.origin !== origin ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.hash !== ''
      )
        throw new Error('Mounted-store URL must retain the exact page origin');
      identity = Object.freeze({ url, origin, pageUrl });
      return identity;
    },
    assertStable() {
      if (failure !== null) throw new Error(failure);
      if (identity === null || page.url() !== identity.pageUrl || navigations !== 1)
        throw new Error('Prepared mounted-store identity no longer belongs to this page');
    },
    dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      page.off('framenavigated', onNavigated);
    },
  };
}

function target(page: Page) {
  return page.locator(
    `[data-testid="table-row"][data-path="${targetPath}"] [role="gridcell"][aria-colindex="3"][data-field-kind="text"] > .cb-cell-chrome > button[data-cell-primary] > span.truncate`,
  );
}

async function vaultSnapshot(page: Page) {
  const snapshot = await page.evaluate((prefix) => {
    const writes = window.__cerebroMockWrites;
    return {
      writeLogAvailable: Array.isArray(writes),
      writes: Array.isArray(writes) ? writes.length : null,
      files: [...window.__cerebroMockFs].filter(
        ([path]) => path.startsWith(prefix) || path === 'types/selection-range.md',
      ),
    };
  }, fixturePrefix);
  expect(snapshot.writeLogAvailable).toBe(true);
  expect(snapshot.writes).toBe(0);
  return snapshot;
}

async function restingFacts(page: Page) {
  return target(page).evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      reveal: node.getAttribute('data-selection-reveal'),
      glyphClip: node.getAttribute('data-selection-reveal-clip'),
      scroll: node.scrollLeft,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      text: node.textContent,
      title: node.closest('button')?.getAttribute('title') ?? null,
    };
  });
}

async function expectResting(page: Page) {
  await expect(page.locator('[data-selection-reveal]')).toHaveCount(0);
  await expect(page.locator('[data-selection-reveal-clip]')).toHaveCount(0);
  expect(await restingFacts(page)).toMatchObject({
    reveal: null,
    glyphClip: null,
    scroll: 0,
    overflowX: 'clip',
    overflowY: 'clip',
    textOverflow: 'ellipsis',
  });
}

test('a collapsed caret in a long text scalar stays unpromoted without changing the range', async ({
  page,
}) => {
  await openFixture(page);
  await expectResting(page);
  const beforeVault = await vaultSnapshot(page);
  const beforeBox = await restingFacts(page);
  // A real collapsed Range must not acquire the Find-only scrolling/paint mode.
  const observation = await target(page).evaluateHandle((node) => {
    const text = node.firstChild;
    const selection = getSelection();
    if (text?.nodeType !== Node.TEXT_NODE || selection === null)
      throw new Error('Fixture must expose its original text and Selection');
    const range = document.createRange();
    range.setStart(text, 7);
    range.collapse(true);
    const state = {
      node,
      text,
      range,
      active: document.activeElement,
      trustedSelectionChanges: 0,
      onSelection: (event: Event) => {
        if (event.isTrusted) state.trustedSelectionChanges++;
      },
    };
    document.addEventListener('selectionchange', state.onSelection);
    selection.removeAllRanges();
    selection.addRange(range);
    return state;
  });
  try {
    await expect
      .poll(() => observation.evaluate((state) => state.trustedSelectionChanges))
      .toBeGreaterThan(0);
    await frames(page);
    expect(
      await observation.evaluate((state) => {
        const selection = getSelection();
        const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
        return {
          physical: state.node.isConnected && state.node.firstChild === state.text,
          sameRange: range === state.range,
          collapsed: range?.collapsed ?? null,
          start: range !== null && range.startContainer === state.text && range.startOffset === 7,
          end: range !== null && range.endContainer === state.text && range.endOffset === 7,
          anchor:
            selection !== null &&
            selection.anchorNode === state.text &&
            selection.anchorOffset === 7,
          focus:
            selection !== null && selection.focusNode === state.text && selection.focusOffset === 7,
          sameActive: document.activeElement === state.active,
        };
      }),
    ).toEqual({
      physical: true,
      sameRange: true,
      collapsed: true,
      start: true,
      end: true,
      anchor: true,
      focus: true,
      sameActive: true,
    });
    await expectResting(page);
    expect(await restingFacts(page)).toEqual(beforeBox);
    await expect(page.getByTestId('table-view').getByRole('textbox')).toHaveCount(0);
    expect(await vaultSnapshot(page)).toEqual(beforeVault);
  } finally {
    await observation.evaluate((state) =>
      document.removeEventListener('selectionchange', state.onSelection),
    );
    await observation.dispose();
  }
});

test('entries replacement restores a Find-owned scalar while retaining its physical selection', async ({
  page,
}, info) => {
  info.annotations.push({ type: 'fixture-version', description: 'prepared-mounted-store-v1' });
  const mountedModule = observeMountedStore(page);
  try {
    const mountedStore = await openFixture(page);
    expect(mountedStore.url).not.toBeNull();
    await expectResting(page);
    const beforeVault = await vaultSnapshot(page);
    const beforeBox = await restingFacts(page);
    const identity = mountedModule.freeze();
    expect(identity.url).toBe(mountedStore.url);
    // Prepared-store coverage: resolve the actual export before native Find owns the selection.
    const preparedStore = await page.evaluateHandle(
      async ({ modulePath, origin, targetPath }) => {
        if (location.origin !== origin)
          throw new Error('Mounted-store preparation changed page origin');
        const { useVaultStore } = await import(modulePath);
        if (
          typeof useVaultStore !== 'function' ||
          typeof useVaultStore.getState !== 'function' ||
          typeof useVaultStore.setState !== 'function'
        )
          throw new Error('Mounted module must expose the actual vault store API');
        const state = useVaultStore.getState();
        if (
          !state ||
          typeof state.vaultPath !== 'string' ||
          !Array.isArray(state.entries) ||
          !state.entries.some((entry: { path: string }) => entry.path === targetPath)
        )
          throw new Error('The prepared mounted store must own the fixture record');
        return useVaultStore;
      },
      { modulePath: identity.url, origin: identity.origin, targetPath },
    );
    try {
      mountedModule.assertStable();
      await page.evaluate(() => getSelection()?.removeAllRanges());
      const found = await page.evaluate(
        (text) =>
          (
            window as unknown as Window & {
              find: (
                text: string,
                caseSensitive: boolean,
                backwards: boolean,
                wrap: boolean,
              ) => boolean;
            }
          ).find(text, false, false, true),
        suffix,
      );
      expect(found).toBe(true);
      await expect(target(page)).toHaveAttribute('data-selection-reveal', 'true');
      await frames(page);
      const observation = await target(page).evaluateHandle((node) => {
        const selection = getSelection();
        const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
        if (
          !selection ||
          !range ||
          !node.contains(range.startContainer) ||
          !node.contains(range.endContainer)
        )
          throw new Error('Real Find must select the original scalar');
        const state = {
          node,
          text: node.firstChild,
          range,
          start: range.startContainer,
          startOffset: range.startOffset,
          end: range.endContainer,
          endOffset: range.endOffset,
          anchor: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focus: selection.focusNode,
          focusOffset: selection.focusOffset,
          selectedText: selection.toString(),
          active: document.activeElement,
          trustedSelectionChanges: 0,
          onSelection: (event: Event) => {
            if (event.isTrusted) state.trustedSelectionChanges++;
          },
        };
        document.addEventListener('selectionchange', state.onSelection);
        return state;
      });
      try {
        expect(await observation.evaluate((state) => state.selectedText)).toBe(suffix);
        mountedModule.assertStable();
        const replacement = await preparedStore.evaluate((useVaultStore, targetPath) => {
          const before = useVaultStore.getState();
          if (
            before.vaultPath === null ||
            !before.entries.some((entry: { path: string }) => entry.path === targetPath)
          )
            throw new Error('The mounted store must own the fixture record');
          // Controlled read-state replacement only: no rescan, disk write or UI/Selection action.
          const entries = [...before.entries];
          useVaultStore.setState({ entries });
          const after = useVaultStore.getState();
          return {
            replaced: after.entries !== before.entries,
            sameVault: after.vaultPath === before.vaultPath,
            sameRecords:
              after.entries.length === before.entries.length &&
              after.entries.every(
                (entry: unknown, index: number) => entry === before.entries[index],
              ),
          };
        }, targetPath);
        expect(replacement).toEqual({ replaced: true, sameVault: true, sameRecords: true });
        await expect(target(page)).not.toHaveAttribute('data-selection-reveal', 'true');
        await frames(page);
        await expectResting(page);
        expect(await restingFacts(page)).toEqual(beforeBox);
        const retained = await observation.evaluate((state) => {
          const selection = getSelection();
          const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
          return {
            physical: state.node.isConnected && state.node.firstChild === state.text,
            sameRange: range === state.range,
            start:
              range !== null &&
              range.startContainer === state.start &&
              range.startOffset === state.startOffset,
            end:
              range !== null &&
              range.endContainer === state.end &&
              range.endOffset === state.endOffset,
            anchor:
              selection !== null &&
              selection.anchorNode === state.anchor &&
              selection.anchorOffset === state.anchorOffset,
            focus:
              selection !== null &&
              selection.focusNode === state.focus &&
              selection.focusOffset === state.focusOffset,
            selectedText: selection?.toString() ?? null,
            sameActive: document.activeElement === state.active,
            trustedSelectionChanges: state.trustedSelectionChanges,
          };
        });
        expect(retained).toMatchObject({
          physical: true,
          sameRange: true,
          start: true,
          end: true,
          anchor: true,
          focus: true,
          selectedText: suffix,
          sameActive: true,
        });
        await expect(page.getByTestId('table-row')).toHaveCount(3);
        expect(await vaultSnapshot(page)).toEqual(beforeVault);
        // Informational only: do not manufacture or require a late native notification.
        await info.attach('retained-selection-observation', {
          body: JSON.stringify(retained, null, 2),
          contentType: 'application/json',
        });
      } finally {
        await observation.evaluate((state) =>
          document.removeEventListener('selectionchange', state.onSelection),
        );
        await observation.dispose();
      }
      mountedModule.assertStable();
    } finally {
      await preparedStore.dispose();
    }
  } finally {
    mountedModule.dispose();
  }
});
