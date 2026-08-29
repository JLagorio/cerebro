// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { handleLayoutDragEnd } from '@/detail/LayoutCanvas';
import { LayoutEditorDialog } from '@/detail/LayoutEditorDialog';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import type { LayoutConfig } from '@/engine/types';

/**
 * The canvas's drag layer (M45.3 Task 6). The pure handler is tested by
 * synthesizing DragEndEvents directly — the DashboardView `handleWidgetDragEnd`
 * idiom (M44.4): dnd-kit's collision detection needs real geometry jsdom does
 * not have, but the drop RESOLUTION — id grammar, the visual-slot decrement,
 * the identity guard — is pure over the config. The component cases render
 * through LayoutEditorDialog's real mount, the sibling suites' fixture.
 */

const drag = (activeId: string, overId: string | null): DragEndEvent =>
  ({
    active: { id: activeId },
    over: overId === null ? null : { id: overId },
  }) as unknown as DragEndEvent;

const base = (): LayoutConfig => ({
  heading: ['a', 'b', 'c'],
  groups: [
    { id: 'g1', name: 'One', fields: ['x', 'y'] },
    { id: 'g2', name: 'Two', fields: [] },
  ],
});

describe('handleLayoutDragEnd (M45.3 Task 6)', () => {
  it('a same-container FORWARD drag decrements the visual slot (the M44.4 lesson)', () => {
    const commit = vi.fn();
    // heading [a,b,c]: the gap the user saw at visual slot 2 (between b and
    // c) was counted with `a` still in place — post-removal that is index 1.
    handleLayoutDragEnd(drag('field:a', 'slot:heading:2'), { layout: base(), commit });
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0][0] as LayoutConfig).heading).toEqual(['b', 'a', 'c']);
  });

  it('a same-container BACKWARD drag needs no decrement', () => {
    const commit = vi.fn();
    handleLayoutDragEnd(drag('field:c', 'slot:heading:0'), { layout: base(), commit });
    expect((commit.mock.calls[0][0] as LayoutConfig).heading).toEqual(['c', 'a', 'b']);
  });

  it('a cross-container drop lands at the slot as seen — the source is not in the target count', () => {
    const commit = vi.fn();
    handleLayoutDragEnd(drag('field:a', 'slot:g1:1'), { layout: base(), commit });
    const next = commit.mock.calls[0][0] as LayoutConfig;
    expect(next.heading).toEqual(['b', 'c']);
    expect(next.groups[0].fields).toEqual(['x', 'a', 'y']);
  });

  it('dropping on the rest area unplaces the field from its group', () => {
    const commit = vi.fn();
    handleLayoutDragEnd(drag('field:x', 'slot:rest:0'), { layout: base(), commit });
    const next = commit.mock.calls[0][0] as LayoutConfig;
    expect(next.groups[0].fields).toEqual(['y']);
    expect(next.heading).toEqual(['a', 'b', 'c']);
  });

  it('identity drops commit nothing — own slot and the gap just past it', () => {
    const commit = vi.fn();
    // Both gaps around the dragged field's own position resolve to where it
    // already sits; the pure editor returns the same reference and the
    // handler must read that as "nothing to commit".
    handleLayoutDragEnd(drag('field:a', 'slot:heading:0'), { layout: base(), commit });
    handleLayoutDragEnd(drag('field:a', 'slot:heading:1'), { layout: base(), commit });
    // A rest row dropped back on the rest area is the same non-move.
    const restLayout: LayoutConfig = { heading: ['a'], groups: [] };
    handleLayoutDragEnd(drag('field:unplaced', 'slot:rest:0'), { layout: restLayout, commit });
    expect(commit).not.toHaveBeenCalled();
  });

  it('a missing target, a malformed id, and an unknown group are silent no-ops', () => {
    const commit = vi.fn();
    handleLayoutDragEnd(drag('field:a', null), { layout: base(), commit });
    handleLayoutDragEnd(drag('field:a', 'nonsense'), { layout: base(), commit });
    handleLayoutDragEnd(drag('field:a', 'slot:ghost:0'), { layout: base(), commit });
    expect(commit).not.toHaveBeenCalled();
  });

  it('mismatched kinds never route: a field on a group slot, a group on a field slot', () => {
    const commit = vi.fn();
    handleLayoutDragEnd(drag('field:a', 'groupslot:1'), { layout: base(), commit });
    handleLayoutDragEnd(drag('group:g1', 'slot:heading:0'), { layout: base(), commit });
    expect(commit).not.toHaveBeenCalled();
  });

  it('a group id carrying a colon parses greedy to the LAST colon (moveToSlot regex lesson)', () => {
    const commit = vi.fn();
    const layout: LayoutConfig = {
      heading: ['h'],
      groups: [{ id: 'notes:extra', name: 'Notes', fields: ['p', 'q'] }],
    };
    handleLayoutDragEnd(drag('field:h', 'slot:notes:extra:1'), { layout, commit });
    const next = commit.mock.calls[0][0] as LayoutConfig;
    expect(next.groups[0].fields).toEqual(['p', 'h', 'q']);
    expect(next.heading).toEqual([]);
  });

  it('a group FORWARD drag decrements its block slot the same way', () => {
    const commit = vi.fn();
    const layout: LayoutConfig = {
      heading: [],
      groups: [
        { id: 'g1', name: 'One', fields: [] },
        { id: 'g2', name: 'Two', fields: [] },
        { id: 'g3', name: 'Three', fields: [] },
      ],
    };
    handleLayoutDragEnd(drag('group:g1', 'groupslot:2'), { layout, commit });
    const next = commit.mock.calls[0][0] as LayoutConfig;
    expect(next.groups.map((g) => g.id)).toEqual(['g2', 'g1', 'g3']);
  });

  it('a group dropped in either gap around itself commits nothing', () => {
    const commit = vi.fn();
    handleLayoutDragEnd(drag('group:g1', 'groupslot:0'), { layout: base(), commit });
    handleLayoutDragEnd(drag('group:g1', 'groupslot:1'), { layout: base(), commit });
    handleLayoutDragEnd(drag('group:ghost', 'groupslot:0'), { layout: base(), commit });
    expect(commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Component cases: the drag layer standing in the real mount.

const DOC = 'types/work-item.md';

function typeDoc(
  layout: unknown = {
    heading: ['status'],
    groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
  },
) {
  return makeEntry({
    path: DOC,
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: 'text', priority: 'text', notes: 'text' },
      layout,
    } as unknown as ReturnType<typeof makeEntry>['properties'],
  });
}

const RECORD = makeEntry({
  path: 'items/alpha.md',
  title: 'Alpha record',
  type: 'Work item',
  properties: { status: 'todo', priority: 'high', notes: 'keep' },
});

function setup(entries: ReturnType<typeof makeEntry>[] = [typeDoc(), RECORD]) {
  const patchFrontmatter = vi.fn().mockResolvedValue(true);
  useVaultStore.setState({ entries, vaultPath: '/vault', patchFrontmatter });
  useUiStore.setState({ layoutEditor: { type: 'Work item' }, toasts: [] });
  render(<LayoutEditorDialog />);
  return { patchFrontmatter };
}

// Quoted attribute values need no escaping for the ids' colons (and jsdom
// has no CSS.escape to lean on anyway).
const bySlot = (id: string) => document.querySelector(`[data-slot="${id}"]`);

describe('the drag layer on the canvas (M45.3 Task 6)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  it('the EMPTY heading keeps its droppable — §3.4 Move-to-page needs the promote target', () => {
    setup([typeDoc({ heading: [], groups: [] }), RECORD]);
    const heading = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'heading');
    if (heading === undefined) throw new Error('heading shell missing');
    expect(within(heading).getByTestId('layout-droparea').getAttribute('data-slot')).toBe(
      'slot:heading:0',
    );
  });

  it('slots bracket rows and groups; areas cover heading and rest', () => {
    setup();
    // g1 holds one row: a slot before it and the trailing config-end slot.
    expect(bySlot('slot:g1:0')).toBeTruthy();
    expect(bySlot('slot:g1:1')).toBeTruthy();
    // One group: block slots bracket it.
    expect(bySlot('groupslot:0')).toBeTruthy();
    expect(bySlot('groupslot:1')).toBeTruthy();
    // The heading appends at its config end; rest ignores index by design.
    expect(bySlot('slot:heading:1')).toBeTruthy();
    expect(bySlot('slot:rest:0')).toBeTruthy();
  });

  it('grips and slots stand OUTSIDE every inert fragment — the layer is live', () => {
    setup();
    // One row grip per rendered field row: priority (g1) and notes (rest).
    const grips = screen.getAllByTestId('layout-grip');
    expect(grips.map((g) => g.getAttribute('aria-label')).sort()).toEqual([
      'Drag Notes',
      'Drag Priority',
    ]);
    // One shell grip per GROUP (block reorder) — never on heading or rest.
    const shellGrips = screen.getAllByTestId('layout-group-grip');
    expect(shellGrips.map((g) => g.getAttribute('aria-label'))).toEqual(['Drag Planning']);
    const interactive = [
      ...grips,
      ...shellGrips,
      ...document.querySelectorAll('[data-slot]'),
    ] as Element[];
    for (const el of interactive) {
      // Inside an inert subtree every pointer and focus path is dead — a
      // drag control there would render but never fire (Task 6's whole
      // reason for the fragment boundary).
      expect(el.closest('[data-testid="layout-preview-content"]')).toBeNull();
    }
  });

  it('every FieldEditor-bearing row sits INSIDE an inert fragment — the boundary from the other side', () => {
    setup();
    // The complement of the live-layer case above: grips and slots stand
    // outside every inert fragment, and the preview rows — each one a live
    // FieldEditor that would write the vault if it could fire — stand inside
    // one. Both halves, or the boundary is only half-proved.
    const rows = screen
      .getAllByTestId('layout-preview')
      .flatMap((p) => [...p.querySelectorAll('[data-testid="property-row"]')]) as Element[];
    // Vacuity guard: the fixture renders priority (g1) and notes (rest).
    expect(rows.map((r) => r.getAttribute('data-property')).sort()).toEqual(['notes', 'priority']);
    for (const row of rows) {
      expect(row.closest('[inert]')).not.toBeNull();
    }
  });

  it('keys on a focused grip never open the group editor — the shell guards its own target', () => {
    setup();
    const grip = screen.getAllByTestId('layout-grip')[0];
    // Space belongs to the KeyboardSensor's pick-up; bubbling to the shell's
    // role=button activation would open the editor OVER the drag.
    fireEvent.keyDown(grip, { key: ' ' });
    fireEvent.keyDown(grip, { key: 'Enter' });
    expect(screen.queryByTestId('group-editor')).toBeNull();
    // The shell's own keys still activate (the popover suite holds the
    // positive half; this asserts the guard did not overreach).
    const shell = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'g1');
    if (shell === undefined) throw new Error('g1 shell missing');
    fireEvent.keyDown(shell, { key: 'Enter' });
    expect(screen.getByTestId('group-editor')).toBeTruthy();
  });

  it('a fold-emptied group still offers its config-end slot', () => {
    setup([
      makeEntry({
        path: DOC,
        title: 'Work item',
        type: 'Type',
        properties: {
          fields: { status: 'text', priority: { kind: 'text', visibility: 'hide' } },
          layout: {
            heading: ['status'],
            groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
          },
        } as unknown as ReturnType<typeof makeEntry>['properties'],
      }),
      RECORD,
    ]);
    // The one row folded away; the shell persists (Task 4 ruling) and so
    // must its drop target — at the CONFIG length, past the hidden field.
    expect(bySlot('slot:g1:1')).toBeTruthy();
    // Nothing renders a row here (status sits in the heading, priority is
    // folded, rest is empty) — so no grips, but the targets stand.
    expect(screen.queryAllByTestId('layout-grip')).toHaveLength(0);
  });
});
