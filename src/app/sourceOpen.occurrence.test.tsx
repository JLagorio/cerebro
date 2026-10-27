// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSourceNavigation, sourceVisitOrigin } from './sourceOpen';
import { useNavStore, layoutOf } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/engine/testHelpers';
import type { SourceLocator } from '@/engine/sourceLocation';
import { DocumentOwner } from '@/editor/documentOwner';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { invalidatePendingLeaves } from './leaveGuard';
const resolve = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  resolveSource: resolve,
}));
const locator: SourceLocator = {
  version: 1,
  vaultId: 'vault',
  path: 'source.md',
  sourceHash: 'a'.repeat(64),
  kind: 'body',
  bodyUtf8Range: { start: 0, end: 10 },
  quote: '[[target]]',
  prefix: '',
  suffix: '',
};
beforeEach(() => {
  __resetOpenPages();
  invalidatePendingLeaves();
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [
      makeEntry({ path: 'source.md', type: null }),
      makeEntry({ path: 'record.md', type: 'Issue' }),
      makeEntry({ path: 'other.md', type: 'Issue' }),
    ],
  });
  useUiStore.setState({
    detailPath: null,
    detailPane: null,
    siblingsByPane: {},
    detailSiblings: [],
  });
  resolve
    .mockReset()
    .mockImplementation(async (_vault, location) => ({ status: 'exact', locator: location }));
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  invalidatePendingLeaves();
});
function originWithPeek() {
  const nav = useNavStore.getState();
  nav.navigate({ kind: 'pages' });
  const pane = useNavStore.getState().active;
  useUiStore.getState().setDetailSiblings(['record.md', 'other.md'], pane);
  nav.openPeek('record.md', { from: pane });
  return sourceVisitOrigin(locator.vaultId, pane);
}
it('peek context returns through the existing originating Visit after opening a recorded occurrence', async () => {
  const origin = originWithPeek();
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'peek-origin',
      locator,
      origin,
      intent: 'full_page',
    });
  });
  expect(useUiStore.getState().detailPath).toBeNull();
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
  await act(async () => {
    expect(await result.current.returnToSourceOrigin('peek-origin')).toBe('restored');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'pages' });
  expect(useUiStore.getState().detailPath).toBe('record.md');
  expect(useUiStore.getState().detailPane).toBe(useNavStore.getState().active);
  expect(useUiStore.getState().detailSiblings).toEqual(['record.md', 'other.md']);
});
it('an unreadable or deleted originating peek reports origin unavailable before leaving the source', async () => {
  const origin = originWithPeek();
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'deleted-peek',
      locator,
      origin,
      intent: 'full_page',
    });
  });
  act(() =>
    useVaultStore.setState({
      entries: useVaultStore.getState().entries.filter((entry) => entry.path !== 'record.md'),
    }),
  );
  await act(async () => {
    expect(await result.current.returnToSourceOrigin('deleted-peek')).toBe('origin_unavailable');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
  expect(useUiStore.getState().detailPath).toBeNull();
});
it('return reuses the originating record if another pane now holds it', async () => {
  const origin = originWithPeek();
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'held-peek',
      locator,
      origin,
      intent: 'full_page',
    });
  });
  let held = useNavStore.getState().active;
  act(() => {
    held = useNavStore.getState().openPane({ kind: 'doc', path: 'record.md' }).pane;
  });
  await act(async () => {
    expect(await result.current.returnToSourceOrigin('held-peek')).toBe('restored');
  });
  expect(useNavStore.getState().active).toBe(held);
  expect(useUiStore.getState().detailPath).toBeNull();
  expect(
    layoutOf(useNavStore.getState()).panes.filter(
      (pane) => pane.selection.kind === 'doc' && pane.selection.path === 'record.md',
    ),
  ).toHaveLength(1);
});

it('a scan-known unreadable peek origin leaves the source usable', async () => {
  const origin = originWithPeek();
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'unreadable-peek',
      locator,
      origin,
      intent: 'full_page',
    });
  });
  act(() =>
    useVaultStore.setState({
      entries: useVaultStore
        .getState()
        .entries.map((entry) =>
          entry.path === 'record.md'
            ? { ...entry, parseError: 'unreadable: invalid UTF-8', hash: null }
            : entry,
        ),
    }),
  );
  await act(async () => {
    expect(await result.current.returnToSourceOrigin('unreadable-peek')).toBe('origin_unavailable');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
  expect(useUiStore.getState().detailPath).toBeNull();
});

it.each([
  {
    name: 'unreadable bytes',
    parseError: 'unreadable: invalid UTF-8',
    hash: null,
    outcome: 'origin_unavailable',
  },
  {
    name: 'readable body with malformed YAML',
    parseError: 'invalid YAML: expected mapping',
    hash: 'b'.repeat(64),
    outcome: 'restored',
  },
])(
  'Return rechecks $name after the real pending source save',
  async ({ parseError, hash, outcome }) => {
    const origin = originWithPeek();
    const { result } = renderHook(useSourceNavigation);
    await act(async () => {
      await result.current.openSource({
        requestId: 'save-peek',
        locator,
        origin,
        intent: 'full_page',
      });
    });
    let complete!: (ack: { kind: 'file'; contentHash: string }) => void;
    const key = { vaultId: 'vault', path: 'source.md', ownerId: 'peek-return-save' };
    const owner = new DocumentOwner(
      key,
      'before',
      () =>
        new Promise((answer) => {
          complete = answer;
        }),
    );
    const unregister = registerSaveParticipant({
      key,
      prepare: () => {},
      snapshot: () => owner.snapshot(),
      flush: () => owner.flush(),
    });
    owner.edit('changed source');
    try {
      const pending = result.current.returnToSourceOrigin('save-peek');
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
      act(() =>
        useVaultStore.setState({
          entries: useVaultStore
            .getState()
            .entries.map((entry) =>
              entry.path === 'record.md' ? { ...entry, parseError, hash } : entry,
            ),
        }),
      );
      await act(async () => {
        complete({ kind: 'file', contentHash: 'saved' });
        expect(await pending).toBe(outcome);
      });
      expect(owner.snapshot().acknowledgedGeneration).toBe(owner.snapshot().generation);
      expect(useNavStore.getState().selection).toEqual(
        outcome === 'restored' ? { kind: 'pages' } : { kind: 'doc', path: 'source.md' },
      );
      expect(useUiStore.getState().detailPath).toBe(outcome === 'restored' ? 'record.md' : null);
    } finally {
      unregister();
    }
  },
);
