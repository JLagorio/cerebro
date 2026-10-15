import { expect, it } from 'vitest';
import type { Selection } from './types';
import {
  CLAIM_RULES,
  checkLayout,
  claimOf,
  closePane,
  emptyPanes,
  focusPane,
  navigatePane,
  openPane,
  paneById,
  remapPaths,
  stepPane,
  type PaneLayout,
} from './panes';
const doc = (path: string): Selection => ({ kind: 'doc', path });
const current = (layout: PaneLayout) => paneById(layout, layout.active)!;
it('claims every kind by the file it edits, without claiming a lens', () => {
  const examples = {
    home: [{ kind: 'home' }, null],
    inbox: [{ kind: 'inbox' }, 'place:inbox'],
    mywork: [{ kind: 'mywork' }, null],
    changes: [{ kind: 'changes' }, null],
    pulse: [{ kind: 'pulse' }, null],
    settings: [{ kind: 'settings' }, null],
    doc: [{ kind: 'doc', path: 'a.md', tab: 'comments' }, 'a.md'],
    diagram: [{ kind: 'diagram', path: 'a.mmd' }, 'a.mmd'],
    file: [{ kind: 'file', path: 'attachments/a.pdf' }, 'attachments/a.pdf'],
    knowledge: [{ kind: 'knowledge', path: 'a.md' }, 'a.md'],
    library: [{ kind: 'library', path: 'a.md', tab: 'skill' }, 'a.md'],
    collection: [{ kind: 'collection', folder: 'notes/work' }, 'notes/work/work.md'],
    list: [{ kind: 'list', id: 'a', view: 'all' }, null],
    type: [{ kind: 'type', name: 'Task' }, null],
    workspace: [{ kind: 'workspace', root: 'a', path: 'b' }, 'place:workspace'],
    studio: [{ kind: 'studio', project: 'a' }, null],
    agents: [{ kind: 'agents', actor: 'a' }, null],
  } satisfies { [K in Selection['kind']]: [Extract<Selection, { kind: K }>, string | null] };
  expect(Object.keys(CLAIM_RULES)).toHaveLength(Object.keys(examples).length);
  for (const [selection, claim] of Object.values(examples)) expect(claimOf(selection)).toBe(claim);
  expect(claimOf({ kind: 'knowledge' })).toBeNull();
  expect(claimOf({ kind: 'collection', folder: '' })).toBeNull();
});
it('inserts beside, reuses a held file across lenses, falls back when full, and never recycles ids', () => {
  let layout = emptyPanes();
  const first = layout.active;
  layout = navigatePane(layout, first, doc('a.md')).layout;
  layout = openPane(layout, first, doc('b.md')).layout;
  const second = layout.active;
  expect(layout.panes.map((pane) => pane.id)).toEqual([first, second]);
  const reused = navigatePane(layout, first, { kind: 'doc', path: 'b.md', tab: 'comments' });
  expect(reused.outcome).toEqual({ kind: 'reused', pane: second });
  expect(current(reused.layout).history).toHaveLength(2);
  const full = openPane(reused.layout, first, { kind: 'settings' }, 2);
  expect(full.outcome).toEqual({ kind: 'full', pane: first });
  expect(current(full.layout).selection).toEqual({ kind: 'settings' });
  layout = closePane(full.layout, first);
  expect(layout.active).toBe(second);
  layout = openPane(layout, second, { kind: 'home' }).layout;
  expect(layout.active).toBe('p3');
  expect(checkLayout(layout)).toEqual([]);
});
it('a replace onto a held page removes its forwarding slot and preserves the holder history', () => {
  let layout = emptyPanes();
  const first = layout.active;
  layout = navigatePane(layout, first, doc('a.md')).layout;
  layout = openPane(layout, first, { kind: 'agents' }).layout;
  const second = layout.active;
  layout = navigatePane(layout, second, { kind: 'agents', actor: 'process:scout' }).layout;
  layout = navigatePane(layout, second, doc('a.md'), { replace: true }).layout;
  expect(layout.active).toBe(first);
  expect(paneById(layout, second)!.history.map((slot) => slot.selection)).toEqual([
    { kind: 'agents' },
  ]);
  expect(paneById(layout, first)!.history).toHaveLength(2);
});
it('Back skips held entries without dropping them, and dead slots still go', () => {
  let layout = emptyPanes();
  const first = layout.active;
  for (const path of ['a.md', 'dead.md', 'b.md'])
    layout = navigatePane(layout, first, doc(path)).layout;
  layout = openPane(layout, first, doc('a.md')).layout;
  layout = stepPane(
    layout,
    first,
    -1,
    (selection) => !('path' in selection) || selection.path !== 'dead.md',
  ).layout;
  expect(paneById(layout, first)!.selection).toEqual({ kind: 'home' });
  expect(paneById(layout, first)!.history.map((slot) => slot.selection)).toEqual([
    { kind: 'home' },
    doc('a.md'),
    doc('b.md'),
  ]);
  layout = closePane(layout, layout.active);
  layout = stepPane(layout, first, 1).layout;
  expect(current(layout).selection).toEqual(doc('a.md'));
});
it('closing the last pane returns Home and remapping moves every history and library path', () => {
  let layout = emptyPanes();
  layout = navigatePane(layout, layout.active, { kind: 'library', path: 'old/a.md' }).layout;
  layout = navigatePane(layout, layout.active, { kind: 'knowledge', path: 'old/b.md' }).layout;
  layout = openPane(layout, layout.active, { kind: 'collection', folder: 'old/work' }).layout;
  layout = remapPaths(layout, 'old', 'new');
  expect(layout.panes[0].history[1].selection).toEqual({ kind: 'library', path: 'new/a.md' });
  expect(current(layout).selection).toEqual({ kind: 'collection', folder: 'new/work' });
  layout = closePane(layout, layout.active);
  layout = closePane(layout, layout.active);
  expect(current(layout).selection).toEqual({ kind: 'home' });
  expect(checkLayout(layout)).toEqual([]);
  expect(checkLayout({ ...layout, active: 'p999', focusOrder: [] })).toEqual([
    'active pane missing',
    'focus order',
  ]);
});
it('invariants hold over random sequences', () => {
  for (let seed = 1; seed <= 20; seed++) {
    let random = seed;
    const next = () => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random;
    };
    let layout = emptyPanes();
    const choices: Selection[] = [
      { kind: 'home' },
      { kind: 'settings' },
      { kind: 'inbox' },
      { kind: 'workspace', root: 'repo' },
      ...Array.from({ length: 8 }, (_, i) => doc(`${i}.md`)),
    ];
    for (let step = 0; step < 2000; step++) {
      const from = layout.panes[next() % layout.panes.length].id;
      const target = choices[next() % choices.length];
      switch (next() % 7) {
        case 0:
          layout = navigatePane(layout, from, target).layout;
          break;
        case 1:
          layout = navigatePane(layout, from, target, { replace: true }).layout;
          break;
        case 2:
          layout = openPane(layout, from, target, 1 + (next() % 4)).layout;
          break;
        case 3:
          layout = closePane(layout, from);
          break;
        case 4:
          layout = focusPane(layout, from);
          break;
        case 5:
          layout = stepPane(layout, from, -1).layout;
          break;
        case 6:
          layout = stepPane(
            layout,
            from,
            1,
            (selection) => !('path' in selection) || selection.path !== '4.md',
          ).layout;
          break;
      }
      expect(checkLayout(layout), `seed ${seed}, step ${step}`).toEqual([]);
    }
  }
});

it('a dead current page with only held survivors falls Home without retaining dead history', () => {
  let layout = emptyPanes();
  const first = layout.active;
  layout = navigatePane(layout, first, doc('held.md'), { replace: true }).layout;
  layout = navigatePane(layout, first, doc('dead.md')).layout;
  layout = openPane(layout, first, doc('held.md')).layout;
  layout = stepPane(
    layout,
    first,
    -1,
    (selection) => !('path' in selection) || selection.path !== 'dead.md',
  ).layout;
  expect(paneById(layout, first)!.selection).toEqual({ kind: 'home' });
  expect(paneById(layout, first)!.history.map((slot) => slot.selection)).toEqual([
    doc('held.md'),
    { kind: 'home' },
  ]);
  expect(checkLayout(layout)).toEqual([]);
  expect(openPane(layout, 'p999', doc('new.md')).outcome.kind).toBe('unchanged');
});
