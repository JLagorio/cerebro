// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spy mode: every call still reaches the mock backend; a test overrides one.
vi.mock('@/lib/ipc', { spy: true });

import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { useVaultStore } from '@/stores/vaultStore';
import { loadTrash, restoreItem, trashPath } from './trashActions';
import { __resetOpenPages, retainDocumentOwner } from '@/editor/openPages';

const VAULT = '/demo-vault';
const PAGE = 'notes/plan.md';
const BYTES = '# Plan\n\nKeep every byte.\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const listed = (path: string) => useVaultStore.getState().entries.some((e) => e.path === path);

beforeEach(async () => {
  __resetOpenPages();
  resetMockFs();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
  useUndoStore.getState().clear();
  fs().set(PAGE, BYTES);
  await useVaultStore.getState().openVault(VAULT);
});

describe('trashPath', () => {
  it('does not trash a page whose visible draft cannot save', async () => {
    const owner = retainDocumentOwner(
      { vaultId: VAULT, path: PAGE, ownerId: 'p1' },
      BYTES,
      async () => {
        throw new Error('disk_full');
      },
    );
    owner.edit('Exact draft that must not disappear');
    await owner.flush();
    expect(await trashPath(PAGE, 'Plan')).toBeNull();
    expect(ipc.deleteNote).not.toHaveBeenCalled();
    expect(fs().get(PAGE)).toBe(BYTES);
  });
  it('moves the page to the Trash, toasts, rescans and returns the item', async () => {
    const item = await trashPath(PAGE, 'Plan');
    expect(item).toMatchObject({ path: PAGE, kind: 'file', title: 'Plan', pages: 1 });
    expect(fs().get(`.trash/${item!.stamp}/${PAGE}`)).toBe(BYTES);
    expect(toasts()).toEqual(['Moved “Plan” to Trash']);
    expect(listed(PAGE)).toBe(false);
  });

  it('a refusal toasts once, in its words, and returns null', async () => {
    const item = await trashPath('.git/config', 'config');
    expect(item).toBeNull();
    expect(toasts()).toEqual([
      "Couldn't move “config” to Trash: .git/config is not a page Cerebro shows, so it can't go to the Trash.",
    ]);
  });

  it('never throws, even when the backend does', async () => {
    vi.mocked(ipc.deleteNote).mockRejectedValueOnce(new Error('disk full'));
    await expect(trashPath(PAGE, 'Plan')).resolves.toBeNull();
    expect(toasts()).toEqual(["Couldn't move “Plan” to Trash: disk full"]);
    expect(fs().get(PAGE)).toBe(BYTES);
  });

  it('refuses while the store holds another vault’s pages', async () => {
    useVaultStore.setState({ entriesVault: '/elsewhere' });
    expect(await trashPath(PAGE, 'Plan')).toBeNull();
    expect(vi.mocked(ipc.deleteNote)).not.toHaveBeenCalled();
    expect(fs().get(PAGE)).toBe(BYTES);
  });
});

describe('restoreItem', () => {
  it('puts the page back, rescans and toasts its title', async () => {
    const item = await trashPath(PAGE, 'Plan');
    useUiStore.setState({ toasts: [] });
    expect(await restoreItem(item!)).toBe(PAGE);
    expect(fs().get(PAGE)).toBe(BYTES);
    expect(listed(PAGE)).toBe(true);
    expect(toasts()).toEqual(['Restored “Plan”']);
  });

  it('a refusal toasts its words and returns null', async () => {
    const item = await trashPath(PAGE, 'Plan');
    fs().set(PAGE, '# Someone else\n');
    useUiStore.setState({ toasts: [] });
    expect(await restoreItem(item!)).toBeNull();
    expect(toasts()).toEqual([
      `${PAGE} already exists, so nothing was restored. Move or rename that page first.`,
    ]);
    expect(fs().get(PAGE)).toBe('# Someone else\n');
  });
});

describe('loadTrash', () => {
  it('is ready with the items, newest first', async () => {
    const first = await trashPath(PAGE, 'Plan');
    expect(await loadTrash(VAULT)).toEqual({ kind: 'ready', items: [first] });
  });

  it('is unavailable with its reason when the read fails, never empty', async () => {
    vi.mocked(ipc.listTrash).mockRejectedValueOnce(new Error('permission denied'));
    expect(await loadTrash(VAULT)).toEqual({ kind: 'unavailable', reason: 'permission denied' });
  });
});

describe('a Trash move is undoable (M60.7)', () => {
  it('pushes an entry; Undo restores it; redo trashes it again under a new stamp', async () => {
    const item = await trashPath(PAGE, 'Plan');
    expect(useUndoStore.getState().past.map((e) => e.label)).toEqual(['Moved “Plan” to Trash']);
    const [toast] = useUiStore.getState().toasts;
    expect(toast.action?.label).toBe('Undo');
    useUiStore.setState({ toasts: [] });
    toast.action?.run();
    await vi.waitFor(() => expect(toasts()).toEqual(['Undid: Moved “Plan” to Trash']));
    expect(fs().get(PAGE)).toBe(BYTES);
    expect(await useUndoStore.getState().redo()).toBe(true);
    expect(fs().has(PAGE)).toBe(false);
    const [back] = useUndoStore.getState().past;
    const stamp = back.kind === 'trash' ? back.item.stamp : null;
    expect(stamp).not.toBeNull();
    expect(stamp).not.toBe(item?.stamp);
    expect(fs().get(`.trash/${stamp}/${PAGE}`)).toBe(BYTES);
  });

  it('a quiet restore leaves the success toast to its caller', async () => {
    const item = await trashPath(PAGE, 'Plan');
    useUiStore.setState({ toasts: [] });
    expect(await restoreItem(item!, { quiet: true })).toBe(PAGE);
    expect(toasts()).toEqual([]);
  });
});
