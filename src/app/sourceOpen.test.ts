// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  useSourceNavigation,
  sourceVisitOrigin,
  sourceRequestFor,
  sourceMayFocus,
} from './sourceOpen';
import { useNavStore, layoutOf } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { SourceLocator } from '@/engine/sourceLocation';
import { makeEntry } from '@/test/factories';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { DocumentOwner } from '@/editor/documentOwner';
import { invalidatePendingLeaves } from '@/app/leaveGuard';
import { BlockNoteEditor } from '@blocknote/core';
import { cerebroSchema } from '@/editor/MarkdownEditor';
import { markdownToBlocksNow } from '@/editor/markdown';
import { revealSource } from '@/editor/sourceReveal';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  resolveSource: resolve,
}));
const locator: SourceLocator = {
  version: 1,
  vaultId: '/demo',
  path: 'source.md',
  sourceHash: 'a'.repeat(64),
  kind: 'body',
  bodyUtf8Range: { start: 0, end: 4 },
  quote: 'text',
  prefix: '',
  suffix: '',
};
beforeEach(() => {
  __resetOpenPages();
  invalidatePendingLeaves();
  useUiStore.setState({ quickOpenVisible: false });
  resolve.mockReset();
  resolve.mockImplementation(async (_vault, locator) => ({ status: 'exact', locator }));
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
  useVaultStore.setState({
    vaultPath: '/demo',
    entries: [makeEntry({ path: 'source.md', type: null })],
  });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  invalidatePendingLeaves();
});
it('source_reveal_reuses_existing_holder', async () => {
  const nav = useNavStore.getState();
  const held = nav.openPane({ kind: 'doc', path: 'source.md' }).pane;
  nav.focusPane(nav.paneIds[0]);
  const origin = sourceVisitOrigin(locator.vaultId);
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'r1', locator, origin, intent: 'full_page' });
  });
  expect(useNavStore.getState().active).toBe(held);
  expect(sourceRequestFor('source.md', held)?.requestId).toBe('r1');
  expect(useNavStore.getState().paneIds).toHaveLength(2);
});
it('two_reveals_use_latest_request', async () => {
  const origin = sourceVisitOrigin(locator.vaultId);
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'first', locator, origin, intent: 'full_page' });
    await result.current.openSource({ requestId: 'latest', locator, origin, intent: 'full_page' });
  });
  expect(sourceRequestFor('source.md', useNavStore.getState().active)?.requestId).toBe('latest');
  expect(await result.current.returnToSourceOrigin('first')).toBe('origin_unavailable');
});
it('return_to_results_restores_palette_snapshot', async () => {
  const snapshot = {
    query: 'needle',
    category: 'pages' as const,
    level: { kind: 'root' as const },
    expandedFor: 'needle',
    activeRowKey: 'page:source.md',
    scrollTop: 170,
  };
  const origin = { ...sourceVisitOrigin(locator.vaultId), kind: 'QuickOpen' as const, snapshot };
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'r', locator, origin, intent: 'full_page' });
  });
  await act(async () => {
    expect(await result.current.returnToSourceOrigin('r')).toBe('restored');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  expect(useUiStore.getState().quickOpenVisible).toBe(true);
  expect(useNavStore.getState().quickOpenResume).toEqual(snapshot);
});
it('peek_promotion_transfers_source_origin', async () => {
  useVaultStore.setState({ entries: [makeEntry({ path: 'source.md', type: 'Task' })] });
  const origin = sourceVisitOrigin(locator.vaultId);
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'peek', locator, origin, intent: 'default' });
  });
  expect(sourceRequestFor('source.md', 'peek')?.requestId).toBe('peek');
  act(() => {
    useNavStore.getState().navigate({ kind: 'doc', path: 'source.md' });
  });
  expect(sourceRequestFor('source.md', useNavStore.getState().active)?.requestId).toBe('peek');
  expect(sourceRequestFor('source.md', 'peek')).toBeUndefined();
});
it('parked_holder_activates_once', async () => {
  const origin = sourceVisitOrigin(locator.vaultId);
  const held = useNavStore.getState().openPane({ kind: 'doc', path: 'source.md' }).pane;
  useNavStore.getState().focusPane(origin.pane);
  useNavStore.getState().setPaneCapacity(1);
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'parked', locator, origin, intent: 'beside' });
  });
  expect(useNavStore.getState().active).toBe(held);
  expect(useNavStore.getState().paneIds).toHaveLength(2);
});
it('missing_origin_leaves_source_usable', async () => {
  const origin = { ...sourceVisitOrigin(locator.vaultId), visitId: 'deleted' };
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'r', locator, origin, intent: 'full_page' });
  });
  expect(await result.current.returnToSourceOrigin('r')).toBe('origin_unavailable');
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
});

it('foreign locator cannot open the same relative path in this vault', async () => {
  resolve.mockResolvedValue({ status: 'unavailable', reason: 'Source is unavailable.' });
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'foreign',
      locator: { ...locator, vaultId: 'other' },
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});
it('vault A to B to A cancels preflight and never navigates', async () => {
  let complete!: (value: unknown) => void;
  resolve.mockImplementation(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = renderHook(useSourceNavigation);
  const pending = result.current.openSource({
    requestId: 'stale',
    locator,
    origin: sourceVisitOrigin(locator.vaultId),
    intent: 'full_page',
  });
  useVaultStore.setState({ vaultPath: '/other' });
  useVaultStore.setState({ vaultPath: '/demo' });
  await act(async () => {
    complete({ status: 'exact', locator });
    await pending;
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

it('source deletion retires its request and return origin', async () => {
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'delete',
      locator,
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
  });
  act(() => {
    useVaultStore.setState({ entries: [] });
  });
  expect(sourceRequestFor(locator.path, useNavStore.getState().active)).toBeUndefined();
  expect(await result.current.returnToSourceOrigin('delete')).toBe('origin_unavailable');
});
it('latest source preflight supersedes a delayed earlier click', async () => {
  let complete!: (value: unknown) => void;
  resolve.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = renderHook(useSourceNavigation);
  const origin = sourceVisitOrigin(locator.vaultId);
  const old = result.current.openSource({ requestId: 'old', locator, origin, intent: 'full_page' });
  await act(async () => {
    await result.current.openSource({ requestId: 'new', locator, origin, intent: 'full_page' });
    complete({ status: 'exact', locator });
    await old;
  });
  expect(sourceRequestFor(locator.path, useNavStore.getState().active)?.requestId).toBe('new');
});
it('delayed preflight after typing elsewhere cannot navigate', async () => {
  let complete!: (value: unknown) => void;
  resolve.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  const { result } = renderHook(useSourceNavigation);
  const pending = result.current.openSource({
    requestId: 'typing',
    locator,
    origin: sourceVisitOrigin(locator.vaultId),
    intent: 'full_page',
  });
  document.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: 'x' }));
  await act(async () => {
    complete({ status: 'exact', locator });
    await pending;
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

function pendingSave() {
  let complete!: (value: { kind: 'file'; contentHash: string }) => void;
  let fail!: (reason: Error) => void;
  const key = { vaultId: '/demo', path: 'source.md', ownerId: 'return-test' };
  const owner = new DocumentOwner(
    key,
    'before',
    () =>
      new Promise((resolve, reject) => {
        complete = resolve;
        fail = reject;
      }),
  );
  registerSaveParticipant({
    key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  owner.edit('dirty');
  return {
    complete: () => complete({ kind: 'file', contentHash: 'saved' }),
    fail: () => fail(new Error('write failed')),
    started: () => complete !== undefined,
  };
}
async function openReturnFixture(originFile = false) {
  if (originFile) {
    useVaultStore.setState({
      entries: [...useVaultStore.getState().entries, makeEntry({ path: 'origin.md', type: null })],
    });
    useNavStore.getState().navigate({ kind: 'doc', path: 'origin.md' });
  }
  const snapshot = {
    query: 'needle',
    category: 'pages' as const,
    level: { kind: 'root' as const },
    expandedFor: 'needle',
    activeRowKey: 'page:source.md',
    scrollTop: 171,
  };
  const origin = { ...sourceVisitOrigin(locator.vaultId), kind: 'QuickOpen' as const, snapshot };
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({ requestId: 'return', locator, origin, intent: 'full_page' });
  });
  return { result, origin, snapshot };
}
it('return waits for a pending save before restoring the exact palette snapshot', async () => {
  const { result, snapshot } = await openReturnFixture();
  const save = pendingSave();
  const pending = result.current.returnToSourceOrigin('return');
  await vi.waitFor(() => expect(save.started()).toBe(true));
  expect(useUiStore.getState().quickOpenVisible).toBe(false);
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
  await act(async () => {
    save.complete();
    expect(await pending).toBe('restored');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  expect(useUiStore.getState().quickOpenVisible).toBe(true);
  expect(useNavStore.getState().quickOpenResume).toEqual(snapshot);
});
it('failed save leaves the source usable and never reopens stale results', async () => {
  const { result } = await openReturnFixture();
  const save = pendingSave();
  const pending = result.current.returnToSourceOrigin('return');
  await vi.waitFor(() => expect(save.started()).toBe(true));
  await act(async () => {
    save.fail();
    expect(await pending).toBe('origin_unavailable');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' });
  expect(useUiStore.getState().quickOpenVisible).toBe(false);
  expect(useNavStore.getState().quickOpenResume).toBeNull();
});
it('later navigation supersedes a return waiting for save', async () => {
  const { result } = await openReturnFixture();
  const save = pendingSave();
  const pending = result.current.returnToSourceOrigin('return');
  await vi.waitFor(() => expect(save.started()).toBe(true));
  act(() => {
    useNavStore.getState().navigate({ kind: 'pages' });
  });
  await act(async () => {
    save.complete();
    expect(await pending).toBe('origin_unavailable');
  });
  await vi.waitFor(() => expect(useNavStore.getState().selection).toEqual({ kind: 'pages' }));
  expect(useUiStore.getState().quickOpenVisible).toBe(false);
  expect(useNavStore.getState().quickOpenResume).toBeNull();
});
it.each([false, true])(
  'return reuses the sole origin holder acquired during pending save: %s',
  async (duringSave) => {
    const { result, origin, snapshot } = await openReturnFixture(true);
    // A second existing pane may acquire the origin while the source writer saves.
    let other!: typeof origin.pane;
    act(() => {
      other = useNavStore.getState().openPane({ kind: 'pages' }).pane;
      useNavStore.getState().focusPane(origin.pane);
    });
    let pending: ReturnType<typeof result.current.returnToSourceOrigin>;
    if (duringSave) {
      const save = pendingSave();
      act(() => {
        useNavStore.getState().navigateIn(other, { kind: 'doc', path: 'origin.md' });
      });
      await vi.waitFor(() => expect(save.started()).toBe(true));
      pending = result.current.returnToSourceOrigin('return');
      await act(async () => {
        save.complete();
        await pending;
      });
    } else {
      act(() => {
        useNavStore.getState().navigateIn(other, { kind: 'doc', path: 'origin.md' });
        useNavStore.getState().focusPane(origin.pane);
      });
      await act(async () => {
        pending = result.current.returnToSourceOrigin('return');
        expect(await pending).toBe('restored');
      });
    }
    const layout = layoutOf(useNavStore.getState());
    expect(
      layout.panes.filter((p) => p.selection.kind === 'doc' && p.selection.path === 'origin.md'),
    ).toHaveLength(1);
    // No historical layout snapshot overwrites a concurrently changed pane.
    expect(layout.panes.find((p) => p.id === other)?.selection).toEqual({
      kind: 'doc',
      path: 'origin.md',
    });
    if (!duringSave) {
      expect(layout.active).toBe(other);
      expect(useNavStore.getState().quickOpenResume).toEqual(snapshot);
    }
  },
);
it('Tab focus on another control cancels real editor reveal during initialization', async () => {
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'focus',
      locator,
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
  });
  const pane = useNavStore.getState().active;
  const request = sourceRequestFor(locator.path, pane)!;
  const editor = BlockNoteEditor.create({ schema: cerebroSchema });
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, 'text'));
  const host = document.createElement('div');
  document.body.append(host);
  editor.mount(host);
  const button = document.createElement('button');
  document.body.append(button);
  try {
    expect(editor.headless).toBe(true);
    const pending = revealSource(
      { requestId: 'focus', locator },
      {
        editor,
        body: 'text',
        sourceHash: locator.sourceHash,
        isCurrent: () => sourceRequestFor(locator.path, pane)?.requestId === 'focus',
        mayFocus: () => sourceMayFocus(request, pane),
      },
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    button.focus();
    expect(await pending).toBe('cancelled');
    expect(document.activeElement).toBe(button);
  } finally {
    editor.unmount();
    host.remove();
    button.remove();
  }
});

it('a newer return supersedes the pending return and restores results only once', async () => {
  const { result, snapshot } = await openReturnFixture();
  const save = pendingSave();
  const first = result.current.returnToSourceOrigin('return');
  await vi.waitFor(() => expect(save.started()).toBe(true));
  const latest = result.current.returnToSourceOrigin('return');
  await act(async () => {
    save.complete();
    expect(await first).toBe('origin_unavailable');
    expect(await latest).toBe('restored');
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  expect(useNavStore.getState().quickOpenResume).toEqual(snapshot);
  expect(useUiStore.getState().quickOpenVisible).toBe(true);
});
