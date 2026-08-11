import { describe, expect, it } from 'vitest';
import {
  activeTab,
  allTabs,
  closeGroup,
  closeInGroup,
  closeOthersInGroup,
  cycleTab,
  dropRoot,
  emptyLayout,
  focusGroupAt,
  focusGroup,
  groupById,
  MAX_GROUPS,
  moveTab,
  openInGroup,
  splitGroup,
  splitWithTab,
  type Layout,
  type OpenTab,
} from './editorGroups';

const t = (path: string, rootId = 'r1'): OpenTab => ({ rootId, path });

/** Open a list of files into the focused group, left to right. */
const withTabs = (...paths: string[]): Layout =>
  paths.reduce((l, p) => openInGroup(l, t(p)), emptyLayout());

/** Every invariant the module promises, checked in one place. */
function expectInvariants(layout: Layout): void {
  expect(layout.groups.length).toBeGreaterThan(0);
  if (layout.groups.length > 1) {
    expect(layout.groups.every((g) => g.tabs.length > 0)).toBe(true);
  }
  for (const g of layout.groups) {
    if (g.tabs.length === 0) expect(g.active).toBeNull();
    else expect(g.tabs.some((x) => x.path === g.active?.path)).toBe(true);
  }
  expect(layout.groups.some((g) => g.id === layout.activeGroupId)).toBe(true);
}

describe('openInGroup', () => {
  it('opens into the focused group and shows it', () => {
    const l = withTabs('a.md');
    expect(activeTab(l)).toEqual(t('a.md'));
    expect(l.groups).toHaveLength(1);
    expectInvariants(l);
  });

  it('focuses an already-open file rather than duplicating it', () => {
    const l = openInGroup(withTabs('a.md', 'b.md'), t('a.md'));
    expect(l.groups[0]?.tabs).toHaveLength(2);
    expect(activeTab(l)).toEqual(t('a.md'));
  });

  it('keeps the same path in two roots apart', () => {
    const l = openInGroup(withTabs('README.md'), t('README.md', 'r2'));
    expect(l.groups[0]?.tabs).toHaveLength(2);
  });

  it('opens into a named group and moves focus there', () => {
    const split = splitGroup(withTabs('a.md', 'b.md'));
    const first = split.groups[0] as { id: string };
    const l = openInGroup(split, t('c.md'), first.id);
    expect(l.activeGroupId).toBe(first.id);
    expect(l.groups[0]?.tabs.map((x) => x.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('ignores an unknown group instead of losing the file', () => {
    const l = withTabs('a.md');
    expect(openInGroup(l, t('b.md'), 'nope')).toBe(l);
  });
});

describe('closeInGroup', () => {
  it('falls back to the LEFT neighbour', () => {
    const l = closeInGroup(withTabs('a.md', 'b.md', 'c.md'), t('c.md'));
    expect(activeTab(l)).toEqual(t('b.md'));
  });

  it('falls back rightwards only when there is nothing to the left', () => {
    const three = withTabs('a.md', 'b.md', 'c.md');
    const l = closeInGroup(three, t('a.md'));
    // 'c.md' was showing, so closing 'a.md' does not move focus at all.
    expect(activeTab(l)).toEqual(t('c.md'));
    const l2 = closeInGroup(openInGroup(three, t('a.md')), t('a.md'));
    expect(activeTab(l2)).toEqual(t('b.md'));
  });

  it('leaves one empty group when the last tab closes', () => {
    const l = closeInGroup(withTabs('a.md'), t('a.md'));
    expect(l.groups).toHaveLength(1);
    expect(activeTab(l)).toBeNull();
    expectInvariants(l);
  });

  it('removes a group that runs empty and focuses its left neighbour', () => {
    const split = splitGroup(withTabs('a.md'));
    expect(split.groups).toHaveLength(2);
    const l = closeInGroup(split, t('a.md'), split.activeGroupId);
    expect(l.groups).toHaveLength(1);
    expect(l.activeGroupId).toBe(split.groups[0]?.id);
    expectInvariants(l);
  });

  it('closing in an unfocused group does not steal focus', () => {
    const l = splitGroup(withTabs('a.md', 'b.md'));
    const left = l.groups[0] as { id: string };
    const after = closeInGroup(l, t('a.md'), left.id);
    expect(after.activeGroupId).toBe(l.activeGroupId);
    expect(after.groups[0]?.tabs.map((x) => x.path)).toEqual(['b.md']);
  });
});

describe('closeOthersInGroup', () => {
  it('leaves exactly the named tab, showing', () => {
    const l = closeOthersInGroup(withTabs('a.md', 'b.md', 'c.md'), t('b.md'));
    expect(l.groups[0]?.tabs).toEqual([t('b.md')]);
    expect(activeTab(l)).toEqual(t('b.md'));
  });
});

describe('splitGroup', () => {
  it('puts the active tab in a new group to the right, keeping the original', () => {
    const l = splitGroup(withTabs('a.md', 'b.md'));
    expect(l.groups).toHaveLength(2);
    expect(l.groups[0]?.tabs.map((x) => x.path)).toEqual(['a.md', 'b.md']);
    expect(l.groups[1]?.tabs.map((x) => x.path)).toEqual(['b.md']);
    expect(l.activeGroupId).toBe(l.groups[1]?.id);
    expectInvariants(l);
  });

  it('inserts beside its SOURCE, not at the far end', () => {
    const three = splitGroup(splitGroup(withTabs('a.md')));
    const first = three.groups[0] as { id: string };
    const l = splitGroup(three, t('a.md'), first.id);
    expect(l.groups[1]?.tabs).toEqual([t('a.md')]);
  });

  it('does nothing when the group is empty', () => {
    const l = emptyLayout();
    expect(splitGroup(l)).toBe(l);
  });

  it('refuses past MAX_GROUPS rather than rendering unusable columns', () => {
    let l = withTabs('a.md');
    for (let i = 0; i < 10; i += 1) l = splitGroup(l);
    expect(l.groups).toHaveLength(MAX_GROUPS);
  });

  it('never recycles an id', () => {
    const split = splitGroup(withTabs('a.md'));
    const closed = closeGroup(split, split.activeGroupId);
    const again = splitGroup(closed);
    expect(again.activeGroupId).not.toBe(split.activeGroupId);
  });
});

describe('closeGroup', () => {
  it('drops the group and its tabs, focusing the left neighbour', () => {
    const l = closeGroup(splitGroup(withTabs('a.md', 'b.md')), 'g2');
    expect(l.groups).toHaveLength(1);
    expect(l.activeGroupId).toBe('g1');
  });

  it('closing the only group leaves an empty one', () => {
    const l = closeGroup(withTabs('a.md'), 'g1');
    expect(l.groups).toHaveLength(1);
    expect(l.groups[0]?.tabs).toEqual([]);
    expectInvariants(l);
  });
});

describe('moveTab', () => {
  it('reorders within one group', () => {
    const l = moveTab(withTabs('a.md', 'b.md', 'c.md'), t('a.md'), 'g1', 'g1', 2);
    expect(l.groups[0]?.tabs.map((x) => x.path)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('moves a tab into another group and focuses it there', () => {
    const split = splitGroup(withTabs('a.md', 'b.md'));
    const right = split.activeGroupId;
    const l = moveTab(split, t('a.md'), 'g1', right, 0);
    expect(l.groups[0]?.tabs.map((x) => x.path)).toEqual(['b.md']);
    expect(l.groups[1]?.tabs.map((x) => x.path)).toEqual(['a.md', 'b.md']);
    expect(activeTab(l)).toEqual(t('a.md'));
    expectInvariants(l);
  });

  it('collapses the source group when its last tab leaves', () => {
    const split = splitGroup(withTabs('a.md'));
    const l = moveTab(split, t('a.md'), split.activeGroupId, 'g1', 0);
    expect(l.groups).toHaveLength(1);
    expectInvariants(l);
  });

  it('clamps an out-of-range index rather than dropping the tab', () => {
    const l = moveTab(withTabs('a.md', 'b.md'), t('a.md'), 'g1', 'g1', 99);
    expect(l.groups[0]?.tabs.map((x) => x.path)).toEqual(['b.md', 'a.md']);
  });

  it('ignores a tab the source group does not hold', () => {
    const l = withTabs('a.md');
    expect(moveTab(l, t('zzz.md'), 'g1', 'g1', 0)).toBe(l);
  });
});

describe('splitWithTab', () => {
  it('moves the tab into a new group on the chosen side', () => {
    const l = splitWithTab(withTabs('a.md', 'b.md'), t('a.md'), 'g1', 'g1', 'right');
    expect(l.groups.map((g) => g.tabs.map((x) => x.path))).toEqual([['b.md'], ['a.md']]);
    expect(activeTab(l)).toEqual(t('a.md'));
    expectInvariants(l);
  });

  it('inserts on the LEFT when asked, not always at the end', () => {
    const l = splitWithTab(withTabs('a.md', 'b.md'), t('a.md'), 'g1', 'g1', 'left');
    expect(l.groups.map((g) => g.tabs.map((x) => x.path))).toEqual([['a.md'], ['b.md']]);
  });

  /** Move, not copy — the difference from `splitGroup`. */
  it('leaves no copy behind in the source group', () => {
    const l = splitWithTab(withTabs('a.md', 'b.md'), t('a.md'), 'g1', 'g1', 'right');
    expect(allTabs(l).filter((x) => x.path === 'a.md')).toHaveLength(1);
  });

  it('refuses to pull a lone tab out of its own pane', () => {
    const l = withTabs('only.md');
    expect(splitWithTab(l, t('only.md'), 'g1', 'g1', 'right')).toBe(l);
  });

  it('collapses a source pane the move emptied', () => {
    const split = splitGroup(withTabs('a.md', 'b.md'));
    const right = split.activeGroupId;
    // The right pane holds only b.md; dropping it beside the left pane empties it.
    const l = splitWithTab(split, t('b.md'), right, 'g1', 'left');
    expect(l.groups).toHaveLength(2);
    expect(l.groups[0]?.tabs.map((x) => x.path)).toEqual(['b.md']);
    expectInvariants(l);
  });

  it('a move that empties its source is allowed at MAX_GROUPS', () => {
    let l = withTabs('a.md', 'b.md');
    while (l.groups.length < MAX_GROUPS) l = splitGroup(l);
    expect(l.groups).toHaveLength(MAX_GROUPS);
    const lone = l.groups[MAX_GROUPS - 1] as { id: string; tabs: OpenTab[] };
    const moved = splitWithTab(l, lone.tabs[0] as OpenTab, lone.id, 'g1', 'left');
    expect(moved.groups).toHaveLength(MAX_GROUPS);
    expect(moved).not.toBe(l);
  });

  it('refuses a move that would grow past MAX_GROUPS', () => {
    let l = withTabs('a.md', 'b.md');
    while (l.groups.length < MAX_GROUPS) l = splitGroup(l);
    // g1 still holds two tabs, so pulling one out does not free a slot.
    expect(splitWithTab(l, t('a.md'), 'g1', 'g1', 'right')).toBe(l);
  });

  it('ignores a tab the source group does not hold', () => {
    const l = withTabs('a.md');
    expect(splitWithTab(l, t('zzz.md'), 'g1', 'g1', 'right')).toBe(l);
  });
});

describe('dropRoot', () => {
  it('forgets that root everywhere and collapses emptied groups', () => {
    const two = openInGroup(withTabs('a.md'), t('x.md', 'r2'));
    const split = splitGroup(two, t('a.md'));
    const l = dropRoot(split, 'r1');
    expect(allTabs(l).every((x) => x.rootId === 'r2')).toBe(true);
    expectInvariants(l);
  });

  it('leaves an empty workspace when the last root goes', () => {
    const l = dropRoot(withTabs('a.md', 'b.md'), 'r1');
    expect(activeTab(l)).toBeNull();
    expectInvariants(l);
  });
});

describe('focus', () => {
  it('focuses by id and by index, and ignores both when out of range', () => {
    const l = splitGroup(withTabs('a.md'));
    expect(focusGroup(l, 'g1').activeGroupId).toBe('g1');
    expect(focusGroup(l, 'nope')).toBe(l);
    expect(focusGroupAt(l, 0).activeGroupId).toBe('g1');
    expect(focusGroupAt(l, 9)).toBe(l);
  });

  /**
   * Panes focus themselves on every pointer-down. A fresh object for a
   * no-op re-rendered the pane between mousedown and mouseup, replacing the
   * node under the pointer so no click was ever produced — which broke every
   * link inside a rendered document.
   */
  it('re-focusing the focused group is the SAME layout, not an equal one', () => {
    const l = splitGroup(withTabs('a.md'));
    expect(focusGroup(l, l.activeGroupId)).toBe(l);
    expect(focusGroupAt(l, 1)).toBe(l);
  });
});

describe('cycleTab', () => {
  it('steps forward and wraps', () => {
    const l = withTabs('a.md', 'b.md', 'c.md');
    expect(activeTab(cycleTab(l, 1))).toEqual(t('a.md'));
    expect(activeTab(cycleTab(l, -1))).toEqual(t('b.md'));
  });

  it('is a no-op on an empty group', () => {
    const l = emptyLayout();
    expect(cycleTab(l, 1)).toBe(l);
  });
});

describe('groupById', () => {
  it('resolves and refuses', () => {
    const l = withTabs('a.md');
    expect(groupById(l, 'g1')?.tabs).toHaveLength(1);
    expect(groupById(l, 'nope')).toBeNull();
  });
});
