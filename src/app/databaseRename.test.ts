import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as ipc from '@/lib/ipc';
import {
  resetMockFs,
  readNoteSource as readMockSource,
  applyBatch as applyMockBatch,
  scanVault as scanMockVault,
} from '@/lib/mockIpc';
import { __resetOpenPages, registerFlush, registerHold } from '@/editor/openPages';
import { listTypes, type TypeListing } from '@/engine/typeCatalog';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { useUndoStore } from '@/stores/undoStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { rememberLastPlace, readLastPlace } from './lastPlace';
import { renameDatabase } from './typeActions';

const VAULT = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const messages = () => useUiStore.getState().toasts.map((row) => row.message);
const listing = (name = 'Work item'): TypeListing => {
  const entries = useVaultStore.getState().entries;
  const found = listTypes(entries, getSchema(entries)).find((type) => type.name === name);
  if (found === undefined) throw new Error(`Missing database ${name}`);
  return found;
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(ipc, 'readNoteSource');
  vi.spyOn(ipc, 'applyBatch');
  resetMockFs();
  __resetOpenPages();
  useUiStore.setState({ toasts: [] });
  await useVaultStore.getState().openVault(VAULT);
  useUndoStore.getState().clear();
});

afterEach(() => {
  __resetOpenPages();
  useUndoStore.getState().clear();
});

describe('renaming a database', () => {
  it('rewrites all stored references as one undoable batch and restores their exact bytes', async () => {
    const before = new Map(fs());
    useNavStore.getState().reset();
    useNavStore.getState().navigate({ kind: 'type', name: 'Work item', view: 'today' });
    rememberLastPlace(VAULT, { kind: 'type', name: 'Work item', view: 'today' });
    expect(await renameDatabase(listing(), '  Task  ')).toBe(true);
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Task', view: 'today' });
    expect(readLastPlace(VAULT)).toEqual({ kind: 'type', name: 'Task', view: 'today' });
    expect(ipc.applyBatch).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().entries.filter((entry) => entry.type === 'Task')).toHaveLength(
      45,
    );
    expect(fs().get('types/work-item.md')).toContain('# Task');
    expect(fs().get('types/work-item.md')).toContain('target: Task');
    expect(fs().get('types/key-result.md')).toContain('target: Task');
    expect(fs().get('types/epic.md')).toContain('type: Task');
    const changed = [...fs()].filter(([path, content]) => before.get(path) !== content);
    expect(changed).toHaveLength(50);
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(new Map(fs())).toEqual(before);
    expect(await useUndoStore.getState().redo()).toBe(true);
    expect(useVaultStore.getState().entries.filter((entry) => entry.type === 'Task')).toHaveLength(
      45,
    );
  });

  it.each([
    '',
    'Work item',
    'Epic',
    'ePiC',
    'Type',
    'Agent',
    'Skill',
    'Collection',
    '*Task',
    '`Task',
    '[[Task]]',
    'Task\nName',
  ])('refuses %j before any write', async (next) => {
    const before = new Map(fs());
    expect(await renameDatabase(listing(), next)).toBe(false);
    expect(new Map(fs())).toEqual(before);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
    expect(ipc.readNoteSource).not.toHaveBeenCalled();
  });

  it('flushes pending saves and rescans before reading the sources', async () => {
    const order: string[] = [];
    registerFlush(async () => {
      order.push('flush');
    });
    const scanSpy = vi.spyOn(ipc, 'scanVault').mockImplementation(async (vault) => {
      order.push('scan');
      return scanMockVault(vault);
    });
    vi.mocked(ipc.readNoteSource).mockImplementation(async (...args) => {
      order.push('read');
      return readMockSource(...args);
    });
    expect(await renameDatabase(listing(), 'Task')).toBe(true);
    expect(order.slice(0, 3)).toEqual(['flush', 'scan', 'read']);
    scanSpy.mockRestore();
  });

  it('refuses a failed fresh scan without using the last good snapshot', async () => {
    vi.spyOn(ipc, 'scanVault').mockRejectedValueOnce(new Error('disk unavailable'));
    const before = new Map(fs());
    expect(await renameDatabase(listing(), 'Task')).toBe(false);
    expect(new Map(fs())).toEqual(before);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  });

  it('creates a ghost database page before planning the batch', async () => {
    fs().set('records/ideas/first.md', '---\ntype: Idea\n---\n# First\n');
    await useVaultStore.getState().rescan();
    expect(listing('Idea').docPath).toBeNull();
    expect(await renameDatabase(listing('Idea'), 'Thought')).toBe(true);
    expect(fs().get('types/idea.md')).toContain('# Thought');
    expect(fs().get('types/idea.md')).toContain('folder: records/ideas');
    expect(fs().get('records/ideas/first.md')).toContain('type: Thought');
  });

  it('a concurrent write refuses the whole rename without losing the newer bytes', async () => {
    const before = new Map(fs());
    vi.mocked(ipc.applyBatch).mockImplementationOnce(async (...args) => {
      fs().set('types/work-item.md', before.get('types/work-item.md')! + '\nNewer text\n');
      return applyMockBatch(...args);
    });
    expect(await renameDatabase(listing(), 'Task')).toBe(false);
    before.set('types/work-item.md', before.get('types/work-item.md')! + '\nNewer text\n');
    expect(new Map(fs())).toEqual(before);
    expect(useUndoStore.getState().past).toEqual([]);
  });

  it('flags an unreadable page and leaves that page alone', async () => {
    const path = 'types/key-result.md';
    const before = fs().get(path);
    vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, target) => {
      if (target === path) throw new Error('unavailable');
      return readMockSource(vault, target);
    });
    expect(await renameDatabase(listing(), 'Task')).toBe(true);
    expect(fs().get(path)).toBe(before);
    expect(messages().some((message) => message.includes(`Not changed: ${path}`))).toBe(true);
  });

  it('refuses when its own database page cannot be read', async () => {
    const before = new Map(fs());
    vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
      if (path === 'types/work-item.md') throw new Error('unavailable');
      return readMockSource(vault, path);
    });
    expect(await renameDatabase(listing(), 'Task')).toBe(false);
    expect(new Map(fs())).toEqual(before);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
    expect(messages().some((message) => message.includes('could not be read unchanged'))).toBe(
      true,
    );
  });

  it('refuses if a page becomes held while sources are being read', async () => {
    const before = new Map(fs());
    vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
      if (path === 'types/work-item.md') registerHold(() => path);
      return readMockSource(vault, path);
    });
    expect(await renameDatabase(listing(), 'Task')).toBe(false);
    expect(new Map(fs())).toEqual(before);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  });
});
