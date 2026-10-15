import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOpenPages, registerFlush, registerHold } from '@/editor/openPages';
import { completeSuggestion } from '@/engine/viewSuggestion';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { typeViews } from '@/engine/typeCatalog';
import { acceptViewSuggestion } from './viewSuggestionActions';

const TYPE = 'types/reading.md';
const PAGE = 'notes/planning.md';
const TYPE_BYTES = '---\ntype: Type\nfields:\n  rating: number\n---\n\n# Reading\n';
const PAGE_BYTES = '\uFEFF---\r\ntype: Doc\r\n---\r\n\r\n# Planning\r\n\r\nKeep every byte.\r\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const view = () =>
  completeSuggestion({
    database: 'Reading',
    view: {
      name: 'High ratings',
      filters: { all: [{ field: 'rating', op: 'gte', value: 4 }] },
      presentation: { type: 'table' },
    },
  });
const accept = (placeOn?: string) =>
  acceptViewSuggestion({ database: 'Reading', view: view(), placeOn });
const messages = () => useUiStore.getState().toasts.map((toast) => toast.message);

beforeEach(async () => {
  vi.restoreAllMocks();
  __resetOpenPages();
  resetMockFs();
  fs().set(TYPE, TYPE_BYTES);
  fs().set(PAGE, PAGE_BYTES);
  await useVaultStore.getState().openVault('/demo-vault');
  useUiStore.setState({ toasts: [] });
  useUndoStore.getState().clear();
});
afterEach(() => {
  __resetOpenPages();
  vi.restoreAllMocks();
});

describe('acceptViewSuggestion', () => {
  it('keeps the default table and adds one tab with one undo', async () => {
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept()).toBe('high-ratings');
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][1]).toEqual([
      expect.objectContaining({ op: 'patch', path: TYPE, expectHash: expect.any(String) }),
    ]);
    expect(
      typeViews('Reading', getSchema(useVaultStore.getState().entries)).map(({ id, name }) => ({
        id,
        name,
      })),
    ).toEqual([
      { id: 'all', name: 'Table' },
      { id: 'high-ratings', name: 'High ratings' },
    ]);
    expect(useUndoStore.getState().past[0].label).toBe('Added “High ratings” to Reading');
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(fs().get(TYPE)).toBe(TYPE_BYTES);
  });
  it('names and ids never collide, including a caseless label', async () => {
    expect(await accept()).toBe('high-ratings');
    const next = { ...view(), name: 'HIGH RATINGS' };
    expect(await acceptViewSuggestion({ database: 'Reading', view: next })).toBe('high-ratings-2');
    expect(fs().get(TYPE)).toContain('name: HIGH RATINGS 2');
  });
  it('flushes before reading and places the fence with one byte-exact undo', async () => {
    const changed = PAGE_BYTES.replace('every byte.', 'every byte, including this edit.');
    registerFlush(async () => {
      if (fs().get(PAGE) === PAGE_BYTES) fs().set(PAGE, changed);
    });
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept(PAGE)).toBe('high-ratings');
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][1].map((op) => op.op)).toEqual(['patch', 'replace_file']);
    expect(fs().get(PAGE)).toBe(
      changed + '\r\n```cerebro-database\r\ndatabase: Reading\r\nview: high-ratings\r\n```\r\n',
    );
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(fs().get(TYPE)).toBe(TYPE_BYTES);
    expect(fs().get(PAGE)).toBe(changed);
  });
  it('refuses an open fence before either write', async () => {
    fs().set(PAGE, '# Planning\n\n```ts\nunfinished');
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept(PAGE)).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(fs().get(TYPE)).toBe(TYPE_BYTES);
    expect(messages()).toEqual([
      "“Planning” ends inside a code block, so the view wasn't placed. Nothing was written.",
    ]);
  });
  it.each(['missing', 'broken'] as const)('a %s Type doc sends no batch', async (kind) => {
    if (kind === 'missing') fs().delete(TYPE);
    else fs().set(TYPE, '---\ntype: Type\nfields: [\n---\n# Reading\n');
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(1);
  });
  it('rechecks the schema after a field disappears', async () => {
    fs().set(TYPE, TYPE_BYTES.replace('  rating: number', '  score: number'));
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()).toEqual(['This view no longer fits Reading.']);
  });
  it.each(['scanVault', 'readNoteSource'] as const)(
    'a failed %s is caught and named once',
    async (method) => {
      vi.spyOn(ipc, method).mockRejectedValueOnce(new Error('disk offline'));
      const batch = vi.spyOn(ipc, 'applyBatch');
      await expect(accept()).resolves.toBeNull();
      expect(batch).not.toHaveBeenCalled();
      expect(messages()).toEqual(["Couldn't add this view: disk offline"]);
    },
  );
  it('a refused batch returns null and toasts once', async () => {
    vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('stale_content'));
    expect(await accept()).toBeNull();
    expect(messages()).toHaveLength(1);
    expect(fs().get(TYPE)).toBe(TYPE_BYTES);
  });
  it('a held page sends nothing', async () => {
    registerHold(() => PAGE);
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept(PAGE)).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()[0]).toContain('changes waiting on you');
  });
  it('a vault switch during the flush writes nothing', async () => {
    registerFlush(async () => {
      useVaultStore.setState({ vaultPath: '/other' });
    });
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await accept(PAGE)).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });
});
