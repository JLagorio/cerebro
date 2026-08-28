import { describe, expect, it } from 'vitest';
import {
  addGroup,
  mintGroupId,
  moveField,
  moveGroup,
  removeGroup,
  renameGroup,
} from '@/engine/layoutEdit';
import type { LayoutConfig } from '@/engine/types';

/**
 * The layout editor's pure structural editors (M45.3).
 *
 * Every input here is deep-frozen — under strict mode ANY write throws,
 * including a transient mutate-then-restore that a compare-after-the-fact
 * would miss (layout.test.ts's purity proof, applied to every editor). Every
 * no-op asserts `toBe`: the SAME reference is the contract the draft's
 * dirty-check and the drag handler both lean on.
 */

const freezeLayout = (config: LayoutConfig): LayoutConfig => {
  Object.freeze(config.heading);
  for (const g of config.groups) {
    Object.freeze(g);
    Object.freeze(g.fields);
  }
  Object.freeze(config.groups);
  return Object.freeze(config);
};

/** Ids are deliberately non-contiguous (`group-1`, `group-3`) so the mint
 * tests can prove the hole-filling walk against the same fixture. */
const base = (): LayoutConfig =>
  freezeLayout({
    heading: ['status'],
    groups: [
      { id: 'group-1', name: 'Planning', fields: ['due', 'estimate'] },
      { id: 'group-3', name: 'People', fields: ['owner'] },
    ],
  });

describe('moveField', () => {
  it('moves group → group, rebuilding only the two touched containers', () => {
    const layout = base();
    const next = moveField(layout, 'due', { container: 'group-3', index: 1 });
    expect(next).toEqual({
      heading: ['status'],
      groups: [
        { id: 'group-1', name: 'Planning', fields: ['estimate'] },
        { id: 'group-3', name: 'People', fields: ['owner', 'due'] },
      ],
    });
    expect(next.heading).toBe(layout.heading);
  });

  it('moves group → heading', () => {
    const next = moveField(base(), 'due', { container: 'heading', index: 0 });
    expect(next.heading).toEqual(['due', 'status']);
    expect(next.groups[0].fields).toEqual(['estimate']);
  });

  it('moves heading → group', () => {
    const layout = base();
    const next = moveField(layout, 'status', { container: 'group-1', index: 1 });
    expect(next.heading).toEqual([]);
    expect(next.groups[0].fields).toEqual(['due', 'status', 'estimate']);
    expect(next.groups[1]).toBe(layout.groups[1]);
  });

  it('moves heading → rest by deletion alone — untouched groups keep identity', () => {
    const layout = base();
    const next = moveField(layout, 'status', { container: 'rest', index: 0 });
    expect(next.heading).toEqual([]);
    expect(next.groups).toBe(layout.groups);
  });

  it('moves group → rest, ignoring the index — rest is derived, not ordered here', () => {
    const layout = base();
    const next = moveField(layout, 'owner', { container: 'rest', index: 5 });
    expect(next.groups[1].fields).toEqual([]);
    expect(next.groups[0]).toBe(layout.groups[0]);
    expect(next.heading).toBe(layout.heading);
  });

  it('moves rest → group — an unplaced name is inserted, nothing removed', () => {
    const layout = base();
    const next = moveField(layout, 'budget', { container: 'group-3', index: 0 });
    expect(next.groups[1].fields).toEqual(['budget', 'owner']);
    expect(next.groups[0]).toBe(layout.groups[0]);
    expect(next.heading).toBe(layout.heading);
  });

  it('moves rest → heading, clamping a runaway index to the end', () => {
    const layout = base();
    const next = moveField(layout, 'budget', { container: 'heading', index: 99 });
    expect(next.heading).toEqual(['status', 'budget']);
    expect(next.groups).toBe(layout.groups);
  });

  it('clamps a negative index to the front', () => {
    const next = moveField(base(), 'budget', { container: 'group-1', index: -5 });
    expect(next.groups[0].fields).toEqual(['budget', 'due', 'estimate']);
  });

  it('counts a within-container slot with the moving name already out', () => {
    // ['due', 'estimate'] with 'due' removed is ['estimate']; slot 1 lands
    // after it — remove-then-insert, dashboard.ts's moveWidget shape.
    const next = moveField(base(), 'due', { container: 'group-1', index: 1 });
    expect(next.groups[0].fields).toEqual(['estimate', 'due']);
  });

  it('is a no-op moving a name to its current position', () => {
    const layout = base();
    expect(moveField(layout, 'due', { container: 'group-1', index: 0 })).toBe(layout);
    expect(moveField(layout, 'status', { container: 'heading', index: 0 })).toBe(layout);
  });

  it('is a no-op when the clamped index lands on the current position', () => {
    const layout = base();
    // group-1 without 'estimate' is ['due']; 99 clamps to 1 — where it sits.
    expect(moveField(layout, 'estimate', { container: 'group-1', index: 99 })).toBe(layout);
  });

  it('is a no-op moving an already-unplaced name to rest', () => {
    const layout = base();
    expect(moveField(layout, 'budget', { container: 'rest', index: 0 })).toBe(layout);
  });

  it('is a no-op against a group id that does not exist', () => {
    const layout = base();
    expect(moveField(layout, 'due', { container: 'group-9', index: 0 })).toBe(layout);
  });

  it('places a name it has never seen — roster-blind, dead pointers prune on Apply', () => {
    const next = moveField(base(), 'never-declared', { container: 'heading', index: 1 });
    expect(next.heading).toEqual(['status', 'never-declared']);
  });
});

describe('addGroup', () => {
  it('appends an empty "New group" with a minted id and reports the id', () => {
    const layout = base();
    const taken = Object.freeze(['group-1', 'group-3']) as string[];
    const { layout: next, id } = addGroup(layout, taken);
    expect(id).toBe('group-2');
    expect(next.groups).toEqual([
      ...layout.groups,
      { id: 'group-2', name: 'New group', fields: [] },
    ]);
    expect(next.heading).toBe(layout.heading);
    expect(next.groups[0]).toBe(layout.groups[0]);
  });

  it('mints group-1 against an empty draft', () => {
    const { id } = addGroup(freezeLayout({ heading: [], groups: [] }), Object.freeze([]) as []);
    expect(id).toBe('group-1');
  });
});

describe('renameGroup', () => {
  it('renames with the trimmed name, rebuilding only that group', () => {
    const layout = base();
    const next = renameGroup(layout, 'group-1', '  Roadmap  ');
    expect(next.groups[0].name).toBe('Roadmap');
    expect(next.groups[0].fields).toBe(layout.groups[0].fields);
    expect(next.groups[1]).toBe(layout.groups[1]);
    expect(next.heading).toBe(layout.heading);
  });

  it('is a no-op on an empty or all-whitespace name', () => {
    const layout = base();
    expect(renameGroup(layout, 'group-1', '')).toBe(layout);
    expect(renameGroup(layout, 'group-1', '   ')).toBe(layout);
  });

  it('is a no-op when the trimmed name is unchanged', () => {
    const layout = base();
    expect(renameGroup(layout, 'group-1', 'Planning')).toBe(layout);
    expect(renameGroup(layout, 'group-1', '  Planning ')).toBe(layout);
  });

  it('is a no-op against an unknown id', () => {
    const layout = base();
    expect(renameGroup(layout, 'group-9', 'Anything')).toBe(layout);
  });
});

describe('removeGroup', () => {
  it('deletes the group — its fields fall to rest by omission, re-homed nowhere', () => {
    const layout = base();
    const next = removeGroup(layout, 'group-1');
    expect(next.groups).toEqual([{ id: 'group-3', name: 'People', fields: ['owner'] }]);
    expect(next.groups[0]).toBe(layout.groups[1]);
    expect(next.heading).toBe(layout.heading);
  });

  it('is a no-op against an unknown id', () => {
    const layout = base();
    expect(removeGroup(layout, 'group-9')).toBe(layout);
  });
});

describe('moveGroup', () => {
  it('reorders by clamped splice, every group keeping identity', () => {
    const layout = base();
    const next = moveGroup(layout, 'group-3', 0);
    expect(next.groups.map((g) => g.id)).toEqual(['group-3', 'group-1']);
    expect(next.groups[0]).toBe(layout.groups[1]);
    expect(next.groups[1]).toBe(layout.groups[0]);
    expect(next.heading).toBe(layout.heading);
  });

  it('clamps a runaway index to the last slot and a negative one to the first', () => {
    expect(moveGroup(base(), 'group-1', 99).groups.map((g) => g.id)).toEqual([
      'group-3',
      'group-1',
    ]);
    expect(moveGroup(base(), 'group-3', -4).groups.map((g) => g.id)).toEqual([
      'group-3',
      'group-1',
    ]);
  });

  it('is a no-op at the current position, clamped or not', () => {
    const layout = base();
    expect(moveGroup(layout, 'group-1', 0)).toBe(layout);
    expect(moveGroup(layout, 'group-3', 99)).toBe(layout);
  });

  it('is a no-op against an unknown id', () => {
    const layout = base();
    expect(moveGroup(layout, 'group-9', 0)).toBe(layout);
  });
});

describe('mintGroupId', () => {
  it('mints group-1 when nothing is taken', () => {
    expect(mintGroupId(Object.freeze([]) as [])).toBe('group-1');
  });

  it('walks past a contiguous run', () => {
    expect(mintGroupId(Object.freeze(['group-1', 'group-2']) as string[])).toBe('group-3');
  });

  it('fills the hole in a non-contiguous set — the schema.ts walk exactly', () => {
    expect(mintGroupId(Object.freeze(['group-1', 'group-3']) as string[])).toBe('group-2');
  });

  it('ignores ids outside the group-N shape', () => {
    expect(mintGroupId(Object.freeze(['custom', 'group-1']) as string[])).toBe('group-2');
  });
});
