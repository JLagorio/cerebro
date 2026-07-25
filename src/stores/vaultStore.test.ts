// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock('@/engine/schema', () => ({
  buildSchema: vi.fn(() => ({ types: new Map() })),
}));
// Spy mode: implementations stay intact (delegating to mockIpc in the
// browser); individual tests override them to simulate the Tauri backend.
vi.mock('@/lib/ipc', { spy: true });
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
import * as mockBackend from '@/lib/mockIpc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { getSchema, useEntry, useVaultStore } from '@/stores/vaultStore';

function findEntry(path: string) {
  return useVaultStore.getState().entries.find((e) => e.path === path);
}

/** Make inTauri() report true; callers must exitTauri() in a finally block. */
function enterTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}
function exitTauri(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function mockFsDisk(): Map<string, string> {
  return (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
}

beforeEach(() => {
  resetMockFs();
  vi.clearAllMocks();
  useVaultStore.setState({ vaultPath: null, entries: [], views: [], status: 'idle', error: null });
});

describe('vaultStore', () => {
  it('openVault scans the demo vault into entries and views', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const s = useVaultStore.getState();
    expect(s.status).toBe('ready');
    expect(s.vaultPath).toBe('/demo-vault');
    expect(s.entries.length).toBeGreaterThan(50);
    expect(Array.isArray(s.views)).toBe(true);
    const item = findEntry('items/fld-1.md');
    expect(item?.title).toBe('First-run walkthrough GA');
    expect(item?.relationships.project).toEqual(['guided-onboarding-ga']);
  });

  it('patchFrontmatter applies optimistically before the write resolves', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const pending = useVaultStore
      .getState()
      .patchFrontmatter('items/fld-1.md', { status: 'done', assignee: '[[sam-ito]]' });
    // Synchronously visible: scalar to properties, wikilink to relationships.
    expect(findEntry('items/fld-1.md')?.properties.status).toBe('done');
    expect(findEntry('items/fld-1.md')?.relationships.assignee).toEqual(['sam-ito']);
    await pending;
    // Survives the reconciling rescan because the mock disk was updated too.
    expect(findEntry('items/fld-1.md')?.properties.status).toBe('done');
    expect(findEntry('items/fld-1.md')?.relationships.assignee).toEqual(['sam-ito']);
  });

  it('patchFrontmatter with null deletes the field', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    await useVaultStore.getState().patchFrontmatter('items/fld-1.md', { due: null });
    expect(findEntry('items/fld-1.md')?.properties).not.toHaveProperty('due');
  });

  it('patchFrontmatter surfaces a failed disk write as a toast and reverts', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.updateFrontmatter).mockRejectedValueOnce(new Error('disk full'));
    await useVaultStore.getState().patchFrontmatter('items/fld-1.md', { status: 'done' });
    // Disk truth wins: the optimistic update is reverted by the rescan.
    expect(findEntry('items/fld-1.md')?.properties.status).toBe('progress');
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Couldn't save changes to items/fld-1.md");
  });

  // Deviation test (Task 23, execution-log note 15a, reported): a stale
  // last-vault boot landed in a dead empty shell — status:'error' was
  // displayed nowhere. openVault failures now also enqueue a toast so the
  // ToastHost surfaces them the moment the shell renders.
  it('openVault surfaces a failed scan via toast alongside the error status', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('not a vault'));
    await useVaultStore.getState().openVault('/bad-vault');
    const s = useVaultStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('not a vault');
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      "Couldn't open vault: not a vault",
    );
  });

  it('createItem returns the new path and the entry appears after rescan', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const path = await useVaultStore.getState().createItem({
      folder: 'items',
      slug: 'fld-99',
      frontmatter: {
        type: 'Work item',
        key: 'FLD-99',
        status: 'todo',
        project: '[[guided-onboarding-ga]]',
      },
    });
    expect(path).toBe('items/fld-99.md');
    const entry = findEntry(path);
    expect(entry?.properties.key).toBe('FLD-99');
    expect(entry?.relationships.project).toEqual(['guided-onboarding-ga']);
  });

  it('createItem rescans even inside Tauri, where the watcher suppresses own writes', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    // Route IPC to the mock backend, then flip on Tauri detection: the store
    // must not rely on a vault-changed event (own-write suppression discards
    // it) and has to rescan itself.
    vi.mocked(ipc.createNote).mockImplementation(mockBackend.createNote);
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.listViews).mockImplementation(mockBackend.listViews);
    enterTauri();
    try {
      const path = await useVaultStore.getState().createItem({
        folder: 'items',
        slug: 'fld-77',
        frontmatter: { type: 'Work item', key: 'FLD-77', status: 'todo' },
      });
      expect(path).toBe('items/fld-77.md');
      expect(findEntry(path)?.properties.key).toBe('FLD-77');
    } finally {
      exitTauri();
      vi.mocked(ipc.createNote).mockReset();
      vi.mocked(ipc.scanVault).mockReset();
      vi.mocked(ipc.listViews).mockReset();
    }
  });

  it('patchFrontmatter treats undefined exactly like null: the key is deleted on disk', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    await useVaultStore.getState().patchFrontmatter('items/fld-1.md', { due: undefined });
    // Normalized to null before the IPC call: JSON serialization to Tauri
    // silently drops undefined keys, and the mock's yaml doc.set would write
    // `due: null` instead of deleting.
    expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalledWith('/demo-vault', 'items/fld-1.md', {
      due: null,
    });
    expect(findEntry('items/fld-1.md')?.properties).not.toHaveProperty('due');
    expect(mockFsDisk().get('items/fld-1.md')).not.toMatch(/^due:/m);
  });

  it('rebinds the vault-changed listener after a failed bind and contains rescan errors', async () => {
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.listViews).mockImplementation(mockBackend.listViews);
    vi.mocked(ipc.startWatcher).mockImplementation(mockBackend.startWatcher);
    enterTauri();
    try {
      // First bind fails: openVault errors, but must NOT latch watcherBound.
      listenMock.mockRejectedValueOnce(new Error('listen failed'));
      await useVaultStore.getState().openVault('/demo-vault');
      expect(useVaultStore.getState().status).toBe('error');

      // Second openVault retries the bind and succeeds.
      listenMock.mockResolvedValue(() => {});
      await useVaultStore.getState().openVault('/demo-vault');
      expect(useVaultStore.getState().status).toBe('ready');
      expect(listenMock).toHaveBeenCalledTimes(2);

      // A failing rescan inside the listener lands in store error state
      // instead of becoming an unhandled rejection.
      const handler = listenMock.mock.calls[1][1] as () => void;
      vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('scan failed'));
      handler();
      await vi.waitFor(() => {
        expect(useVaultStore.getState().status).toBe('error');
        expect(useVaultStore.getState().error).toBe('scan failed');
      });
    } finally {
      exitTauri();
      vi.mocked(ipc.scanVault).mockReset();
      vi.mocked(ipc.listViews).mockReset();
      vi.mocked(ipc.startWatcher).mockReset();
    }
  });

  it('getSchema memoizes buildSchema per entries reference', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const entries = useVaultStore.getState().entries;
    const a = getSchema(entries);
    const b = getSchema(entries);
    expect(a).toBe(b);
    expect(vi.mocked(buildSchema)).toHaveBeenCalledTimes(1);
  });

  it('useEntry returns the entry for a path', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const { result } = renderHook(() => useEntry('items/fld-1.md'));
    expect(result.current?.title).toBe('First-run walkthrough GA');
    const { result: missing } = renderHook(() => useEntry('items/nope.md'));
    expect(missing.current).toBeNull();
  });
});
