import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { BoardView, handleDragEnd, NO_VALUE_COLUMN_ID } from '@/views/BoardView';
import { buildSchema } from '@/engine/schema';
import { groupEntries } from '@/engine/grouping';
import { fixtureVault } from '@/test/factories';
import type { Group, Presentation, Schema } from '@/engine/types';

const presentation: Presentation = {
  type: 'board',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }, { field: 'assignee' }],
};

afterEach(cleanup);

describe('BoardView', () => {
  it('renders one column per group and a muted footer counting unparseable entries', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
    render(<BoardView entries={items} presentation={presentation} schema={schema} />);
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // empty column still renders
    expect(screen.getByText('1 unparseable item hidden')).toBeTruthy();
    expect(screen.queryByText('broken.md')).toBeNull();
  });

  // Fix test (execution-log note 17a): an empty project rendered a blank
  // canvas — groupEntries([], …) returns [] so the board had no columns and
  // no empty state.
  it('renders an empty state instead of a blank canvas for an empty project', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(<BoardView entries={[]} presentation={presentation} schema={schema} />);
    expect(screen.getByTestId('board-view')).toBeTruthy();
    expect(screen.getByText('No items yet')).toBeTruthy();
  });
});

describe('handleDragEnd', () => {
  const entries = fixtureVault();
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/') && e.path !== 'projects/onboarding/items/broken.md');
  const groups = groupEntries(items, 'status', schema);

  it('patches the dragged entry frontmatter and toasts the target label', () => {
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = { active: { id: 'projects/onboarding/items/fld-1.md' }, over: { id: 'doing' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, schema, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', { status: 'doing' });
    expect(toast).toHaveBeenCalledWith('Moved to Doing');
  });

  it('is a no-op when dropped on the source column', () => {
    const patchFrontmatter = vi.fn();
    const toast = vi.fn();
    const event = { active: { id: 'projects/onboarding/items/fld-1.md' }, over: { id: 'todo' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, schema, patchFrontmatter, toast });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('writes null when dropped on the no-value column', () => {
    // The fixture items all carry a status, so groupEntries emits no
    // '__none__' group here; append a hand-built one per the plan's note so
    // the no-value drop target exists (boards render it whenever present).
    const noneGroup: Group = { key: '__none__', label: 'No status', color: null, ghost: true, entries: [] };
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-1.md' },
      over: { id: NO_VALUE_COLUMN_ID },
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups: [...groups, noneGroup], schema, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', { status: null });
  });

  it('is a no-op when dropped outside any column', () => {
    const patchFrontmatter = vi.fn();
    const event = { active: { id: 'projects/onboarding/items/fld-1.md' }, over: null } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, schema, patchFrontmatter, toast: vi.fn() });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  // M1.x interim: a drop on a multi-select-grouped board would overwrite the
  // whole array with one scalar — refuse with a toast until add/remove exists.
  it('refuses drops when grouping by a multi-select field', () => {
    const patchFrontmatter = vi.fn();
    const toast = vi.fn();
    const multiSchema = {
      resolveField: () => ({
        def: { name: 'tags', kind: 'multiselect' },
        raw: ['a'],
        display: 'a',
        color: null,
        ghost: false,
      }),
    } as unknown as Schema;
    const dragged = items[0];
    const msGroups: Group[] = [
      { key: 'a', label: 'A', color: null, ghost: false, entries: [dragged] },
      { key: 'b', label: 'B', color: null, ghost: false, entries: [] },
    ];
    const event = { active: { id: dragged.path }, over: { id: 'b' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'tags', groups: msGroups, schema: multiSchema, patchFrontmatter, toast });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Can't move cards grouped by a multi-select field");
  });

  it('wraps the written value as a wikilink when the grouped field is person/relation-kind', () => {
    // Execution-log note 18: a bare-stem write (`assignee: ana-rios`) destroys
    // the wikilink on disk — relationships.assignee is gone after rescan.
    const personGroups = groupEntries(items, 'assignee', schema);
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-2.md' },
      over: { id: 'ana-rios' },
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'assignee', groups: personGroups, schema, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-2.md', { assignee: '[[ana-rios]]' });
    expect(toast).toHaveBeenCalledWith('Moved to Ana Rios');
  });
});
