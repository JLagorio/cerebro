import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavStore, layoutOf } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useOpenLogStore, pruneOpenLogToSnapshot } from '@/stores/openLogStore';
import { useVaultStore } from '@/stores/vaultStore';
import { readLastPlace, rememberLastPlace, LAST_PLACE_KEY } from './lastPlace';
import { beginPointerRename, followRename, followTypeRename } from './pointers';
beforeEach(() => {
  vi.restoreAllMocks();
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
  useVaultStore.setState({ vaultPath: '/a', entriesVault: '/a', status: 'ready', entries: [] });
  useUiStore.setState({ favorites: {}, pendingRenames: {} });
  useOpenLogStore.setState({ logs: {}, saved: true });
  window.localStorage.removeItem(LAST_PLACE_KEY);
});
describe('rename pointers', () => {
  it('moves every pane, visit, favorite, recent and last place, preserving order and other vaults', () => {
    const nav = useNavStore.getState();
    nav.navigate({ kind: 'doc', path: 'old/page.md' });
    nav.openPane({ kind: 'doc', path: 'old/sub/child.md' });
    rememberLastPlace('/a', { kind: 'doc', path: 'old/page.md', tab: 'comments' });
    useUiStore.setState({
      favorites: {
        '/a': ['old/page.md', 'new/page.md', 'old/sub/child.md'],
        '/b': ['old/page.md'],
      },
    });
    useOpenLogStore.getState().record('/a', 'old/page.md', 1);
    useOpenLogStore.getState().record('/a', 'old/sub/child.md', 2);
    useOpenLogStore.getState().record('/b', 'old/page.md', 3);
    followRename('/a', 'old', 'new');
    expect(layoutOf(useNavStore.getState()).panes.map((pane) => pane.selection)).toEqual([
      { kind: 'doc', path: 'new/page.md' },
      { kind: 'doc', path: 'new/sub/child.md' },
    ]);
    expect(useUiStore.getState().favorites).toEqual({
      '/a': ['new/page.md', 'new/sub/child.md'],
      '/b': ['old/page.md'],
    });
    expect(readLastPlace('/a')).toEqual({ kind: 'doc', path: 'new/page.md', tab: 'comments' });
    expect(useOpenLogStore.getState().logs['/a'].map((entry) => entry.path)).toEqual([
      'new/sub/child.md',
      'new/page.md',
    ]);
    expect(useOpenLogStore.getState().logs['/b'][0].path).toBe('old/page.md');
  });
  it('renames type places in every history without dropping their view', () => {
    useNavStore.getState().navigate({ kind: 'type', name: 'Task', view: 'today' });
    useNavStore.getState().openPane({ kind: 'type', name: 'Task', view: 'all' });
    rememberLastPlace('/a', { kind: 'type', name: 'Task', view: 'today' });
    followTypeRename('/a', 'Task', 'Work');
    expect(layoutOf(useNavStore.getState()).panes.map((pane) => pane.selection)).toEqual([
      { kind: 'type', name: 'Work', view: 'today' },
      { kind: 'type', name: 'Work', view: 'all' },
    ]);
    expect(readLastPlace('/a')).toEqual({ kind: 'type', name: 'Work', view: 'today' });
  });
  it('never moves another vault’s live panes and ignores no-op renames', () => {
    useNavStore.getState().navigate({ kind: 'doc', path: 'old.md' });
    const before = useNavStore.getState();
    followRename('/b', 'old.md', 'new.md');
    followRename('/a', 'old.md', 'old.md');
    followTypeRename('/a', 'Work', 'Work');
    expect(useNavStore.getState()).toBe(before);
  });
  it('cannot throw on unavailable local storage, and releases nested prune holds exactly once', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    useUiStore.setState({ favorites: { '/a': ['old.md'] } });
    useOpenLogStore.getState().record('/a', 'old.md');
    const first = beginPointerRename('/a'),
      second = beginPointerRename('/a');
    first();
    first();
    expect(useUiStore.getState().pendingRenames['/a']).toBe(1);
    pruneOpenLogToSnapshot();
    expect(useOpenLogStore.getState().logs['/a']).toHaveLength(1);
    expect(() => followRename('/a', 'old.md', 'new.md')).not.toThrow();
    expect(useUiStore.getState().favorites['/a']).toEqual(['new.md']);
    second();
    expect(useUiStore.getState().pendingRenames).toEqual({});
  });
  it('only the rename hook remaps pointer stores', () => {
    const allowed = new Set([
      'app/pointers.ts',
      'app/lastPlace.ts',
      'stores/navStore.ts',
      'stores/uiStore.ts',
      'stores/openLogStore.ts',
    ]);
    const offenders: string[] = [];
    for (const file of readdirSync('src', { recursive: true }).filter(
      (file): file is string =>
        typeof file === 'string' && /\.tsx?$/.test(file) && !/\.test\./.test(file),
    )) {
      if (allowed.has(file)) continue;
      const source = readFileSync(`src/${file}`, 'utf8');
      if (
        /\.(?:replacePath|remapFavorites|renameType)\s*\(|\b(?:remapLastPlace|renameLastPlaceType)\s*\(|useOpenLogStore\.getState\(\)\.remap\s*\(/.test(
          source,
        )
      )
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
