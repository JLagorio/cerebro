import { describe, expect, it } from 'vitest';
import { emptyPanes, openPane, navigatePane } from './panes';
import {
  isStoredSelection,
  pruneLayout,
  readStoredLayouts,
  toStored,
  type StoredLayout,
} from './paneLayout';
import type { Selection } from './types';
const doc = (path: string): Selection => ({ kind: 'doc', path });
const stored = (rows: Selection[][], active = 0): StoredLayout => ({
  v: 1,
  active,
  panes: rows.map((entries) => ({ entries, index: entries.length - 1 })),
});
describe('pane layout persistence data', () => {
  it('round trips places and focus but omits visit state and transient highlights', () => {
    let layout = emptyPanes();
    layout = navigatePane(layout, layout.active, {
      kind: 'doc',
      path: 'one.md',
      tab: 'comments',
      thread: 'temporary',
    }).layout;
    layout = openPane(
      layout,
      layout.active,
      { kind: 'knowledge', nav: { tab: 'runs', run: 'temporary' } },
      4,
    ).layout;
    layout.panes[0].history[1].state = { 'canvas.scroll': 12 };
    const value = toStored(layout);
    expect(value.active).toBe(1);
    expect(value.panes[0].entries.at(-1)).toEqual({ kind: 'doc', path: 'one.md', tab: 'comments' });
    expect(value.panes[1].entries).toEqual([{ kind: 'knowledge', nav: { tab: 'runs' } }]);
    expect(readStoredLayouts(JSON.stringify({ vault: value }))).toEqual({ vault: value });
  });
  it('refuses junk and malformed required fields or lenses', () => {
    for (const raw of [
      null,
      '',
      'null',
      '[]',
      '{bad',
      '{"v":1}',
      JSON.stringify({ v: { v: 1, active: 3, panes: [] } }),
    ])
      expect(readStoredLayouts(raw)).toEqual({});
    for (const raw of [
      { kind: 'new-kind' },
      { kind: 'doc', path: 2 },
      { kind: 'doc', path: 'a', thread: 'transient' },
      { kind: 'type', name: 'Work', view: 4 },
      { kind: 'inbox', selected: 'a' },
      { kind: 'knowledge', nav: { tab: 'runs', run: 'transient' } },
    ])
      expect(isStoredSelection(raw)).toBe(false);
  });
  it('keeps up to thirty visits around the cursor, including its forward history', () => {
    const layout = emptyPanes();
    const pane = layout.panes[0];
    pane.history = Array.from({ length: 100 }, (_, index) => ({
      selection: doc(`${index}.md`),
      byAgent: false,
    }));
    pane.historyIndex = 50;
    pane.selection = pane.history[50].selection;
    const value = toStored(layout).panes[0];
    expect(value.entries).toHaveLength(30);
    expect(value.index).toBe(15);
    expect(value.entries[15]).toEqual(doc('50.md'));
    expect(value.entries.at(-1)).toEqual(doc('64.md'));
  });
  it('drops dead visits and empty panes, choosing the closest surviving earlier visit', () => {
    const value = stored([[doc('a'), doc('dead'), doc('c')], [doc('dead')], [doc('d')]], 1);
    value.panes[0].index = 1;
    expect(
      pruneLayout(value, (selection) => !('path' in selection) || selection.path !== 'dead'),
    ).toEqual({
      v: 1,
      active: 0,
      panes: [
        { index: 0, entries: [doc('a'), doc('c')] },
        { index: 0, entries: [doc('d')] },
      ],
    });
    expect(pruneLayout(stored([[doc('dead')]]), () => false)).toBeNull();
  });
  it('keeps one editor and one Inbox, stepping later claims back when possible', () => {
    const value = stored(
      [[doc('held')], [doc('before'), doc('held')], [{ kind: 'inbox' }], [{ kind: 'inbox' }]],
      3,
    );
    expect(pruneLayout(value, () => true)).toEqual({
      v: 1,
      active: 2,
      panes: [
        { index: 0, entries: [doc('held')] },
        { index: 0, entries: [doc('before'), doc('held')] },
        { index: 0, entries: [{ kind: 'inbox' }] },
      ],
    });
  });
  it('retains at most four panes around the focused pane', () => {
    const value = stored(
      Array.from({ length: 10 }, (_, index) => [doc(`${index}`)]),
      6,
    );
    const result = pruneLayout(value, () => true)!;
    expect(result.panes.map((pane) => pane.entries[0])).toEqual(['4', '5', '6', '7'].map(doc));
    expect(result.active).toBe(2);
  });
});
