// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionFile } from '@/engine/types';
import { deleteNote, saveCollection } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { deleteCollection, updateCollection } from './listActions';

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  saveCollection: vi.fn(async () => undefined),
  deleteNote: vi.fn(async () => undefined),
}));

/**
 * A collection its PAGE declares (M47.5) is edited on that page.
 *
 * Every collection action used to write or delete `collection.yml` only. For
 * a page-declared collection that marker does not exist: a rename wrote one
 * the page then overruled, so the edit vanished on the next scan and left a
 * stray file behind, and "Remove collection" tried to delete a file that was
 * never there and toasted "Couldn't remove".
 */
const page = makeEntry({ path: 'delivery/delivery.md', title: 'Delivery', type: 'Collection' });
const declaredByPage: CollectionFile = {
  folder: 'delivery',
  declared: true,
  page: page.path,
  definition: { name: 'Delivery', icon: null, color: null, order: null, description: null },
};

let patches: { path: string; patch: Record<string, unknown> }[];
beforeEach(() => {
  patches = [];
  vi.mocked(saveCollection).mockClear();
  vi.mocked(deleteNote).mockReset().mockResolvedValue(undefined);
  useUiStore.setState({ toast: vi.fn() });
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [page],
    rescan: vi.fn(async () => undefined),
    patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
      patches.push({ path, patch });
      return true;
    }),
  });
});

describe('updateCollection on a page-declared collection', () => {
  it('writes the definition onto the page, never a marker', async () => {
    const ok = await updateCollection(declaredByPage, {
      ...declaredByPage.definition,
      name: 'Shipping',
      icon: 'rocket',
      description: 'What ships next',
    });
    expect(ok).toBe(true);
    expect(saveCollection).not.toHaveBeenCalled();
    expect(patches).toEqual([
      {
        path: 'delivery/delivery.md',
        patch: {
          name: 'Shipping',
          icon: 'rocket',
          color: null,
          order: null,
          description: 'What ships next',
        },
      },
    ]);
  });

  // The page's title already names it, so `name:` is written only as a
  // deviation — the same deviations-only rule every writer here follows.
  it('leaves `name:` off when the name is the page title', async () => {
    await updateCollection(declaredByPage, { ...declaredByPage.definition, icon: 'rocket' });
    expect(patches[0].patch.name).toBeNull();
  });

  it('still writes the marker for a collection.yml collection', async () => {
    const { page: _page, ...marker } = declaredByPage;
    await updateCollection(marker, { ...marker.definition, name: 'Shipping' });
    expect(saveCollection).toHaveBeenCalledTimes(1);
    expect(patches).toEqual([]);
  });
});

describe('deleteCollection on a page-declared collection', () => {
  it('un-declares the page and keeps it, instead of deleting a marker', async () => {
    expect(await deleteCollection(declaredByPage)).toBe(true);
    expect(patches).toEqual([{ path: 'delivery/delivery.md', patch: { type: null } }]);
    expect(deleteNote).not.toHaveBeenCalledWith('/demo-vault', 'delivery/delivery.md');
  });

  // A stray marker from before edits reached the page would bring the
  // collection straight back; its usual absence is not a failure.
  it('clears a stray marker, and succeeds when there is none', async () => {
    vi.mocked(deleteNote).mockRejectedValue(new Error('not found'));
    expect(await deleteCollection(declaredByPage)).toBe(true);
    expect(deleteNote).toHaveBeenCalledWith('/demo-vault', 'delivery/collection.yml');
  });

  it('answers false when the page write fails', async () => {
    useVaultStore.setState({ patchFrontmatter: vi.fn(async () => false) });
    expect(await deleteCollection(declaredByPage)).toBe(false);
    expect(deleteNote).not.toHaveBeenCalled();
  });
});
