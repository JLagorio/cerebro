// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine/schema', () => ({
  buildSchema: vi.fn(() => ({ types: new Map() })),
}));

import { buildSchema } from '@/engine/schema';
import { resetMockFs } from '@/lib/mockIpc';
import { getSchema, useEntry, useVaultStore } from '@/stores/vaultStore';

function findEntry(path: string) {
  return useVaultStore.getState().entries.find((e) => e.path === path);
}

beforeEach(() => {
  resetMockFs();
  vi.mocked(buildSchema).mockClear();
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
