import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { BoardView, handleDragEnd, NO_VALUE_COLUMN_ID } from '@/views/BoardView';
import { buildSchema } from '@/engine/schema';
import { groupEntries } from '@/engine/grouping';
import { fixtureVault } from '@/test/factories';
import type { Group, Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'board',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['status', 'priority', 'assignee'],
};

afterEach(cleanup);

describe('BoardView', () => {
  it('renders one column per group and a muted footer counting unparseable entries', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('items/'));
    render(<BoardView entries={items} presentation={presentation} schema={schema} />);
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // empty column still renders
    expect(screen.getByText('1 unparseable item hidden')).toBeTruthy();
    expect(screen.queryByText('broken.md')).toBeNull();
  });
});

describe('handleDragEnd', () => {
  const entries = fixtureVault();
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('items/') && e.path !== 'items/broken.md');
  const groups = groupEntries(items, 'status', schema);

  it('patches the dragged entry frontmatter and toasts the target label', () => {
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = { active: { id: 'items/fld-1.md' }, over: { id: 'doing' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { status: 'doing' });
    expect(toast).toHaveBeenCalledWith('Moved to Doing');
  });

  it('is a no-op when dropped on the source column', () => {
    const patchFrontmatter = vi.fn();
    const toast = vi.fn();
    const event = { active: { id: 'items/fld-1.md' }, over: { id: 'todo' } } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast });
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
      active: { id: 'items/fld-1.md' },
      over: { id: NO_VALUE_COLUMN_ID },
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups: [...groups, noneGroup], patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { status: null });
  });

  it('is a no-op when dropped outside any column', () => {
    const patchFrontmatter = vi.fn();
    const event = { active: { id: 'items/fld-1.md' }, over: null } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', groups, patchFrontmatter, toast: vi.fn() });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});
