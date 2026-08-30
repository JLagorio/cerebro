// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DragEndEvent } from '@dnd-kit/core';
import { canvasCollision, handleLayoutDragEnd } from '@/detail/LayoutCanvas';
import { LayoutEditorDialog } from '@/detail/LayoutEditorDialog';
import { gripClass } from '@/components/ui/Grip';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
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

/**
 * The canvas's drop TARGETING (M46.2 Task 3), driven the way
 * `handleLayoutDragEnd` is: synthetic geometry, because jsdom lays nothing
 * out. The partition itself is proved in `dropPartition.test.ts` — what these
 * cases hold is the wiring, and the id grammar the wiring filters by.
 */
describe('canvasCollision (M46.2 Task 3)', () => {
  /** The stack the void was MEASURED in: 6px slots at the 33px row pitch of
   * the baseline. Task 7 has since taken the row pitch to 38, and this fixture
   * deliberately keeps 33 — it is the geometry the regression lives in, and
   * the partition rule is pitch-independent by construction. */
  const slots = (ids: string[], start = 245) =>
    ids.map((id, i) => ({
      id,
      rect: {
        top: start + i * 33,
        bottom: start + i * 33 + 6,
        left: 0,
        right: 600,
        width: 600,
        height: 6,
      },
    }));

  const args = (
    activeId: string,
    targets: ReturnType<typeof slots>,
    pointer: { x: number; y: number } | null,
    grip: { top: number; left: number; width: number; height: number },
    rects: Map<string, unknown> = new Map(targets.map((t) => [t.id, t.rect])),
  ) =>
    ({
      active: { id: activeId },
      collisionRect: { ...grip, bottom: grip.top + grip.height, right: grip.left + grip.width },
      droppableRects: rects,
      droppableContainers: targets.map((t) => ({ id: t.id })),
      pointerCoordinates: pointer,
    }) as unknown as Parameters<typeof canvasCollision>[0];

  const collide = (
    activeId: string,
    targets: ReturnType<typeof slots>,
    pointer: { x: number; y: number } | null,
    grip = { top: 245, left: 20, width: 16, height: 24 },
  ) => canvasCollision(args(activeId, targets, pointer, grip)).map((c) => String(c.id));

  it('the measured dead band is lit — y 248, 249 and 250 all name a target', () => {
    // The baseline swept this exact stack and found 248-250 lit NOTHING.
    const targets = slots(['slot:g1:0', 'slot:g1:1', 'slot:g1:2']);
    for (const y of [248, 249, 250]) {
      expect(collide('field:a', targets, { x: 300, y }), `y ${y}`).toHaveLength(1);
    }
  });

  it('the whole stack lights exactly one target per pixel', () => {
    const targets = slots(['slot:g1:0', 'slot:g1:1', 'slot:g1:2', 'slot:g1:3']);
    for (let y = 245; y <= 245 + 3 * 33 + 6; y += 1) {
      expect(collide('field:a', targets, { x: 300, y }), `y ${y}`).toHaveLength(1);
    }
  });

  it('the pointer decides even from the gutter the grips live in', () => {
    // The grips sit 20px LEFT of the slots' own left edge, so the dragged
    // rect never overlaps a target at all. An x-sensitive rule reads that as
    // "nowhere"; this one reads the row the pointer is on.
    const targets = slots(['slot:g1:0', 'slot:g1:1']);
    expect(collide('field:a', targets, { x: -18, y: 260 })).toEqual(['slot:g1:0']);
  });

  it('a group drag never lights a field slot, and a field drag never a group gap', () => {
    // Interleaved on purpose: at y 280 both grammars have a candidate, so the
    // answer is about eligibility and not about which one happens to be near.
    const mixed = [
      ...slots(['slot:g1:0', 'slot:g1:1', 'slot:g1:2']),
      ...slots(['groupslot:0'], 278),
    ];
    expect(collide('field:a', mixed, { x: 300, y: 280 })).toEqual(['slot:g1:1']);
    expect(collide('group:g1', mixed, { x: 300, y: 280 })).toEqual(['groupslot:0']);
    // A group carried up among the field rows has only its own gaps to land
    // in, and above the topmost one there is nothing.
    expect(collide('group:g1', mixed, { x: 300, y: 246 })).toEqual([]);
  });

  it('a keyboard drag reports no pointer and falls back to the dragged rect centre', () => {
    const targets = slots(['slot:g1:0', 'slot:g1:1', 'slot:g1:2']);
    // Grip top 260, height 24 -> centre y 272, which is slot 1's band.
    expect(
      collide('field:a', targets, null, { top: 260, left: 20, width: 16, height: 24 }),
    ).toEqual(['slot:g1:1']);
  });

  it('a target with no measured rect is simply not a target', () => {
    const targets = slots(['slot:g1:0', 'slot:g1:1']);
    const out = canvasCollision(
      args(
        'field:a',
        targets,
        { x: 300, y: 249 },
        { top: 0, left: 0, width: 16, height: 24 },
        new Map(),
      ),
    );
    expect(out).toEqual([]);
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
  tabs?: unknown,
) {
  return makeEntry({
    path: DOC,
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: 'text', priority: 'text', notes: 'text' },
      layout,
      ...(tabs !== undefined ? { tabs } : {}),
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

  it('both canvas handles are the BLOCK grip, out in the gutter (M46.2 Task 6)', () => {
    setup();
    // Kind decides the primitive: a canvas row and a canvas group both MOVE A
    // BLOCK among blocks, so both take the larger gutter handle — 18 x 24, a
    // 20px mark in the dimmer ink, its own 4px radius and wash (§B7) — where a
    // property row, which reorders within a list, takes the row grip.
    for (const el of [
      ...screen.getAllByTestId('layout-grip'),
      ...screen.getAllByTestId('layout-group-grip'),
    ]) {
      expect(el.className).toContain(gripClass('block'));
      expect(el.className).not.toContain(gripClass('row'));
      // In the gutter, not in the row: `-left-6` is the canvas's own `p-6`,
      // so the handle never hangs outside the scroller at a narrow width.
      expect(el.className).toContain('-left-6');
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

// M45.4 — the canvas does NOT live-embed a view tab (plan Decision: weight
// without fidelity); the ACTIVE view tab gets a quiet placeholder naming its
// source straight off the pointer, no resolution. M45.5 Task 2 retired the
// first-tab-only pin: the strip is live and the canvas holds the selection,
// so "active" is whichever tab was last pressed.
describe('the view-tab placeholder (M45.4)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  it('the active view tab names its source, inert, inside the tabs block', () => {
    setup([
      typeDoc(undefined, [
        { id: 'v1', name: 'Blocked', content: 'view', source: { type: 'Work item' } },
        { id: 's1', name: 'Notes', content: 'sections' },
      ]),
      RECORD,
    ]);
    const tabsBlock = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'tabs');
    if (tabsBlock === undefined) throw new Error('tabs shell missing');
    const placeholder = within(tabsBlock).getByTestId('layout-preview-viewtab');
    expect(placeholder.textContent).toBe('View of Work item — shown on the record');
    // Preview, not surface: the placeholder lives inside an inert fragment.
    expect(placeholder.closest('[data-testid="layout-preview-content"]')).not.toBeNull();
  });

  it('a list-source tab names the list id; a sourceless one says so', () => {
    setup([
      typeDoc(undefined, [{ id: 'v1', name: 'Work', content: 'view', source: { list: 'work' } }]),
      RECORD,
    ]);
    expect(screen.getByTestId('layout-preview-viewtab').textContent).toBe(
      'View of work — shown on the record',
    );
    cleanup();
    resetLayers();
    setup([typeDoc(undefined, [{ id: 'v1', name: 'Broken', content: 'view' }]), RECORD]);
    expect(screen.getByTestId('layout-preview-viewtab').textContent).toBe(
      'View of a missing source — shown broken on the record',
    );
  });

  it('the placeholder follows the ACTIVE tab, not the first (M45.5 Task 2)', () => {
    setup([
      typeDoc(undefined, [
        { id: 'o1', name: 'Overview', content: 'overview' },
        { id: 'v1', name: 'Blocked', content: 'view', source: { type: 'Work item' } },
      ]),
      RECORD,
    ]);
    // Standing on the non-view first tab: nothing to place.
    expect(screen.getByTestId('record-tabs')).toBeTruthy();
    expect(screen.queryByTestId('layout-preview-viewtab')).toBeNull();
    // Pressing the view tab selects it — and the placeholder is ITS source.
    fireEvent.click(screen.getByTestId('record-tab-v1'));
    expect(screen.getByTestId('layout-preview-viewtab').textContent).toBe(
      'View of Work item — shown on the record',
    );
    // And back: the placeholder belongs to the active tab, never the first.
    fireEvent.click(screen.getByTestId('record-tab-o1'));
    expect(screen.queryByTestId('layout-preview-viewtab')).toBeNull();
  });
});

// M45.5 Task 1 — Notion's canvas anatomy: the heading stands FIRST with the
// tab strip below it, and every block wears its zone boundary OPENLY — a
// persistent border and an always-visible header label — with the cortex
// ring kept as the hover/focus upgrade. One label per zone: the shell header
// IS the label, so no GroupLabel renders inside canvas content (the real
// record page keeps its own).
describe('Notion order and persistent zone boundaries (M45.5 Task 1)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  it('the heading renders FIRST, and the tab strip after the property stack (M46.1)', () => {
    setup([typeDoc(undefined, [{ id: 's1', name: 'Notes', content: 'sections' }]), RECORD]);
    const ids = screen.getAllByTestId('layout-block').map((b) => b.getAttribute('data-block'));
    // Notion's page order, which M46.1 restored: the whole property stack
    // stands above the strip, so the strip is LAST, not second.
    expect(ids).toEqual(['heading', 'g1', 'rest', 'tabs']);
  });

  it('every block wears a persistent border and an always-visible label chip', () => {
    setup([typeDoc(undefined, [{ id: 's1', name: 'Notes', content: 'sections' }]), RECORD]);
    const shells = screen.getAllByTestId('layout-block');
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) {
      expect(shell.className).toContain('border-n-200');
      const chip = within(shell).getByTestId('layout-block-label');
      expect(chip.className).not.toContain('opacity-0');
      // The ring stays the hover/focus UPGRADE — never part of the resting look.
      expect(shell.className).toContain('hover:ring-1');
      expect(shell.className.split(' ')).not.toContain('ring-1');
    }
  });

  it('one label per zone — the shell header is THE label, no inner GroupLabel', () => {
    setup();
    const g1 = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'g1');
    if (g1 === undefined) throw new Error('g1 shell missing');
    const labels = within(g1).getAllByText('Planning');
    expect(labels).toHaveLength(1);
    // The one label is chrome, standing outside the inert preview.
    expect(labels[0].closest('[data-testid="layout-preview-content"]')).toBeNull();
  });

  it('the drop indicator cross-fades — on the TARGET, not on the gap', () => {
    // M46.2 Task 3 put the cross-fade on the slot: always the accent colour,
    // revealed by opacity, so the outgoing target fades over the same 200ms
    // the incoming one arrives in (reference §D7). Task 4 kept that mechanism
    // and moved it onto the block being pointed at (§C-II.3), because a line
    // owned by the CONTAINER is one fixed width for every row it will ever
    // point at, while a child at `inset-inline: 0` inherits its target's own
    // width and indent.
    setup();
    const line = document.querySelector('[data-line="slot:g1:0"]');
    expect(line?.className).toContain('motion-move');
    expect(line?.className).toContain('bg-cortex-500/43');
    expect(line?.className).toContain('opacity-0');
    expect(line?.className).toContain('inset-x-0');
    // It hangs inside the row it points at, so it moves and indents with it.
    expect(line?.closest('[data-drag-id="field:priority"]')).not.toBeNull();
    // And the gap it stands for no longer paints anything itself.
    expect(bySlot('slot:g1:0')?.className).not.toContain('bg-cortex');
    // The drag-hover ring on the whole-container targets hands off in the
    // same 200ms, so travel between the two grammars is one movement.
    const area = screen
      .getAllByTestId('layout-droparea')
      .find((a) => a.getAttribute('data-slot')?.startsWith('slot:heading:'));
    expect(area?.className).toContain('motion-move');
  });

  it('every insertion gap is drawn exactly once, by a block it sits against', () => {
    // The invariant `lineHosts` exists for. A gap has a block on either side
    // and both could legitimately hug it; if both do, one drop point lights
    // twice. Held over the REAL canvas rather than over a fabricated list, so
    // a call site that forgets to pass its hosts fails here too.
    setup();
    const gaps = [...document.querySelectorAll('[data-testid="layout-slot"]')].map((s) =>
      s.getAttribute('data-slot'),
    );
    const drawn = [...document.querySelectorAll('[data-line]')].map((l) =>
      l.getAttribute('data-line'),
    );
    expect(gaps.length).toBeGreaterThan(0);
    expect([...drawn].sort()).toEqual([...gaps].sort());
  });

  it('the gutter grip fades in — but the dragged row is never given a transition', () => {
    setup();
    const grip = screen.getAllByTestId('layout-grip')[0];
    expect(grip.className).toContain('motion-move');
    // The row's own dim is inline and in the drag's hot path: a source that
    // faded over 200ms would still look undragged for the first frames of the
    // gesture that moved it.
    const row = grip.parentElement;
    expect(row?.className).not.toContain('motion-move');
  });

  it('block slots stand taller than row slots — the chip overhang needs the headroom', () => {
    setup();
    // Between bordered shells only 6px would leave the -top-2 chip (8px
    // overhang) colliding with the block above; in-group row slots have no
    // chip hanging over them and keep the 6px row gap.
    expect(bySlot('groupslot:0')?.className).toContain('h-3');
    expect(bySlot('groupslot:1')?.className).toContain('h-3');
    expect(bySlot('slot:g1:0')?.className).toContain('h-1.5');
  });

  it('an empty zone keeps ONE label and only the bare hint sentence', () => {
    setup([typeDoc({ heading: [], groups: [] }), RECORD]);
    const heading = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'heading');
    if (heading === undefined) throw new Error('heading shell missing');
    // ShellEmptyHint no longer repeats the label — the shell header carries it.
    expect(within(heading).getAllByText('Heading')).toHaveLength(1);
    expect(heading.textContent).toContain('No properties yet');
  });
});

// M46.1 — the reversal of M45.6, after live testing: "sorry tabs are only for
// related data sources. fields shwo above. just like notion." A section
// belongs to the RECORD. The whole property stack — heading, sections, page
// properties — stands ABOVE the strip and renders on every tab; the tab holds
// the page body or a data source, and that is all that swaps.
describe('properties stand above the tabs, on every tab (M46.1)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  // One tab of each surviving kind, so the claim is made against all three.
  const TABBED = [
    { id: 'one', name: 'One', content: 'overview' },
    { id: 's1', name: 'Notes', content: 'sections' },
    { id: 'v1', name: 'Blocked', content: 'view', source: { type: 'Work item' } },
  ];
  const THREE = {
    heading: [],
    groups: [
      { id: 'g1', name: 'Planning', fields: ['status'] },
      { id: 'g2', name: 'Details', fields: ['notes'] },
      { id: 'g3', name: 'Later', fields: ['owner', 'due'] },
    ],
  };
  const FILLED = makeEntry({
    path: 'items/alpha.md',
    title: 'Alpha record',
    type: 'Work item',
    properties: {
      status: 'todo',
      priority: 'high',
      notes: 'keep',
      owner: 'ada',
      due: '2026-01-01',
    },
  });

  function tabbed(fields: unknown = undefined, layout: unknown = THREE) {
    return [
      makeEntry({
        path: DOC,
        title: 'Work item',
        type: 'Type',
        properties: {
          fields: fields ?? {
            status: 'text',
            priority: 'text',
            notes: 'text',
            owner: 'text',
            due: 'text',
          },
          layout,
          tabs: TABBED,
        } as unknown as ReturnType<typeof makeEntry>['properties'],
      }),
      FILLED,
    ];
  }

  const blockIds = () =>
    screen.getAllByTestId('layout-block').map((b) => b.getAttribute('data-block'));
  const groupBlocks = () => blockIds().filter((b) => b !== null && b.startsWith('g'));
  const blockOf = (container: string) => {
    const shell = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === container);
    if (shell === undefined) throw new Error(`${container} shell missing`);
    return shell;
  };

  it('every section stands on EVERY tab — switching swaps only the tab’s own content', () => {
    setup(tabbed());
    expect(groupBlocks()).toEqual(['g1', 'g2', 'g3']);
    // Overview is the one kind that renders the body, on BOTH hosts.
    expect(screen.getByTestId('layout-preview-body')).toBeTruthy();

    fireEvent.click(screen.getByTestId('record-tab-s1'));
    expect(groupBlocks()).toEqual(['g1', 'g2', 'g3']);

    fireEvent.click(screen.getByTestId('record-tab-v1'));
    expect(groupBlocks()).toEqual(['g1', 'g2', 'g3']);
  });

  it('the property stack renders ABOVE the tab strip, structurally', () => {
    setup(tabbed());
    const strip = blockOf('tabs');
    // Document position, not testid order: the claim is about where the
    // browser paints these, and a list of ids would still pass if the strip
    // were nested inside the stack it is supposed to stand under.
    for (const container of ['heading', 'g1', 'g2', 'g3', 'rest']) {
      const block = blockOf(container);
      expect(block.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(strip.contains(block)).toBe(false);
    }
  });

  it('a view tab keeps the stack, shows its placeholder, and drops the body', () => {
    setup(tabbed());
    fireEvent.click(screen.getByTestId('record-tab-v1'));
    expect(screen.getByTestId('layout-preview-viewtab').textContent).toBe(
      'View of Work item — shown on the record',
    );
    // The stack is untouched, the + still adds to it, and the body — the
    // Overview's own content — is the one thing that stood down.
    expect(blockIds()).toEqual(['heading', 'g1', 'g2', 'g3', 'rest', 'tabs']);
    expect(screen.getByRole('button', { name: 'Add section' })).toBeTruthy();
    expect(screen.queryByTestId('layout-preview-body')).toBeNull();
  });

  it('a sections tab keeps the stack and shows the free-text stand-in', () => {
    setup(tabbed());
    fireEvent.click(screen.getByTestId('record-tab-s1'));
    expect(screen.getByTestId('layout-preview-sectionstab').textContent).toBe(
      'Free text, written on each record — shown on the record',
    );
    expect(blockIds()).toEqual(['heading', 'g1', 'g2', 'g3', 'rest', 'tabs']);
    expect(screen.queryByTestId('layout-preview-body')).toBeNull();
    // Preview, not surface — the stand-in lives inside an inert fragment.
    expect(
      screen
        .getByTestId('layout-preview-sectionstab')
        .closest('[data-testid="layout-preview-content"]'),
    ).not.toBeNull();
  });

  it('the + adds to the record, not to a tab — and Apply carries no tab: key', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup(tabbed());
    // Pressed while standing on a view tab: the section it stages is a
    // property section, so it lands in the stack that view tab also shows.
    fireEvent.click(screen.getByTestId('record-tab-v1'));
    await user.click(screen.getByRole('button', { name: 'Add section' }));
    expect(groupBlocks()).toEqual(['g1', 'g2', 'g3', 'group-1']);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    const groups = (
      (patchFrontmatter.mock.calls[0][1] as Record<string, unknown>).layout as LayoutConfig
    ).groups;
    // `toEqual` fails on a surplus key, so this is the no-`tab:` assertion —
    // said again by hand below, because absent and undefined read alike.
    expect(groups).toEqual([
      { id: 'g1', name: 'Planning', fields: ['status'] },
      { id: 'g2', name: 'Details', fields: ['notes'] },
      { id: 'g3', name: 'Later', fields: ['owner', 'due'] },
      { id: 'group-1', name: 'New group', fields: [] },
    ]);
    // Pins the WRITE CONTRACT, not a draft guard: serializeLayoutConfig
    // rebuilds every group as {id,name,fields}, so a stray draft `tab`
    // could never reach the payload anyway. The behavioural guard against
    // re-scoping is this file's every-section-on-every-tab describe.
    for (const g of groups) expect('tab' in g).toBe(false);
  });

  it('a folded row still occupies its CONFIG slot — the field ids say so', () => {
    // The one index divergence the canvas still has to convert: `rows` is
    // FOLDED and the config is not, so the second visible row is the third
    // config slot. Reading the slot off the render index would name `1`.
    setup(
      tabbed(
        {
          status: 'text',
          notes: { kind: 'text', visibility: 'hide' },
          owner: 'text',
          due: 'text',
        },
        {
          heading: [],
          groups: [{ id: 'g1', name: 'Planning', fields: ['status', 'notes', 'owner'] }],
        },
      ),
    );
    expect(bySlot('slot:g1:0')).toBeTruthy();
    expect(bySlot('slot:g1:2')).toBeTruthy();
    expect(bySlot('slot:g1:3')).toBeTruthy();
    // The hidden field's own slot never renders — its row is folded away.
    expect(bySlot('slot:g1:1')).toBeNull();
  });
});

// M45.5 Task 3 — Notion's circular + below the last block. It walks the SAME
// staging the popover footer's "Add section" walks (two doors, one editor),
// so the assertions are the popover suite's: the fresh shell stands, its
// editor opens on it, and Apply carries the group.
describe('the add-section button (M45.5 Task 3)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  const addButton = () => screen.getByRole('button', { name: 'Add section' });
  const blocks = () =>
    screen.getAllByTestId('layout-block').map((b) => b.getAttribute('data-block'));

  it('stages a group into the draft and opens ITS editor', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(addButton());
    // The fresh shell stands …
    expect(blocks()).toContain('group-1');
    // … and the editor opened on the NEW group, rename box ready.
    const name = within(screen.getByTestId('group-editor')).getByRole('textbox', {
      name: 'Section name',
    });
    expect((name as HTMLInputElement).value).toBe('New group');
    fireEvent.keyDown(document, { key: 'Escape' });

    // Staged, not written, until Apply.
    fireEvent.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    expect((patchFrontmatter.mock.calls[0][1] as Record<string, unknown>).layout).toEqual({
      heading: ['status'],
      groups: [
        { id: 'g1', name: 'Planning', fields: ['priority'] },
        { id: 'group-1', name: 'New group', fields: [] },
      ],
    });
  });

  it('mints past the ids the draft already took', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc({
        heading: [],
        groups: [
          { id: 'group-1', name: 'One', fields: [] },
          { id: 'group-3', name: 'Three', fields: [] },
        ],
      }),
      RECORD,
    ]);
    await user.click(addButton());
    // mintGroupId fills the hole rather than appending group-4.
    expect(blocks()).toContain('group-2');
  });

  it('paints its glyph in theme-stable ink, not the inverting neutral', () => {
    setup();
    const btn = addButton();
    // --text-inverse is #ffffff in BOTH themes; --n-0 inverts to #15181f, and
    // on this cortex-600 fill that measured 2.4:1 in dark — the resting state
    // of the one control whose whole job is being found.
    expect(btn.className).toContain('text-inverse');
    expect(btn.className).not.toContain('text-n-0');
    expect(btn.className).toContain('bg-cortex-600');
  });

  it('is a real button, keyboard reachable, standing after the last group slot', async () => {
    const user = userEvent.setup();
    setup();
    const btn = addButton();
    expect(btn.tagName).toBe('BUTTON');
    // Between the last block slot and the rest shell — Notion's position.
    const lastSlot = bySlot('groupslot:1');
    const rest = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'rest');
    if (lastSlot === null || rest === undefined) throw new Error('canvas anatomy missing');
    expect(lastSlot.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(btn.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A real button activates on Enter — the whole reason it is not a div.
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await user.keyboard('{Enter}');
    expect(blocks()).toContain('group-1');
  });
});

/**
 * A live canvas drag owns Escape (M46.2).
 *
 * Measured: dnd-kit cancels correctly, but its `handleKeydown` calls
 * `handleCancel()` from a `document` BUBBLE listener with no `preventDefault`
 * and no `stopPropagation` — so one Escape cancelled the drag AND closed the
 * whole layout editor dialog.
 *
 * The fix is a `'gesture'` layer for the drag's life, NOT a capture listener
 * that swallows the key: swallowing would stop the event before dnd-kit's own
 * handler ever ran, and cancel nothing at all. Both halves are asserted below —
 * the drag must cancel, and the dialog must survive.
 */
describe('a live canvas drag owns Escape (M46.2)', () => {
  beforeEach(() => resetLayers());
  afterEach(() => {
    cleanup();
    resetLayers();
    useUiStore.setState({ layoutEditor: null });
  });

  /** dnd-kit's own announcements, which say what the drag actually did. */
  const announced = () =>
    [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ');

  /**
   * The keyboard sensor's pick-up: `keyboardCodes.start` is `Space` by CODE.
   *
   * The await is not optional. `KeyboardSensor.attach` adds its own keydown
   * listener inside a `setTimeout(0)`, so a synchronous Escape after the
   * pick-up reaches every OTHER handler in the app and never reaches dnd-kit —
   * which would make this whole suite pass over a drag nothing could cancel.
   */
  const pickUp = async () => {
    const grip = screen.getAllByTestId('layout-grip')[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
    // Vacuity guard: with no drag in flight every case below is about nothing.
    // Matched on the item rather than on the pick-up sentence, because since
    // M46.2 Task 3 the canvas resolves a target from the pointer and the
    // pick-up announcement is superseded by the first "moved over" in the
    // same tick. Either sentence proves what this guard is for: a drag is
    // live, and it is this grip's.
    expect(announced()).toContain('field:priority');
    await new Promise((r) => setTimeout(r, 0));
    return grip;
  };
  const escape = (on: Element) => fireEvent.keyDown(on, { key: 'Escape', code: 'Escape' });

  it('cancels the drag without closing the editor behind it', async () => {
    setup();
    const grip = await pickUp();

    escape(grip);

    // dnd-kit's cancel still ran — the proof that the layer did not swallow.
    expect(announced()).toContain('Dragging was cancelled');
    // The measured defect: the same keystroke closed the whole dialog.
    expect(screen.queryByTestId('layout-editor')).not.toBeNull();
  });

  it('hands Escape back once the cancel has settled', async () => {
    setup();
    const grip = await pickUp();
    escape(grip);
    // The claim outlives the keystroke that ended the drag, and not a moment
    // longer (M46.2 Task 1b review): dnd-kit cancels from `document` bubble,
    // so a layer released there is gone before the `window`-bubble surfaces
    // have been asked. One task later it is the dialog's key again — a claim
    // that outlived THAT would leave the editor no way out but the mouse.
    await new Promise((r) => setTimeout(r, 0));
    escape(grip);
    expect(screen.queryByTestId('layout-editor')).toBeNull();
  });

  it('hands Escape back on a drop too', async () => {
    setup();
    // Asserted on the LAYER rather than by driving the dialog shut, because
    // since M46.2 Task 3 a drop always lands somewhere: jsdom measures every
    // rect at 0x0, so the resolved slot is the first droppable rather than
    // the row's own, the drop commits a real move, and the next Escape is the
    // discard confirm's rather than the dialog's. The claim the name makes —
    // a released gesture stops owning the key — is this line.
    pushLayer('panel');
    const grip = await pickUp();
    expect(ownsEscape('panel')).toBe(false);
    // Space again is the keyboard sensor's DROP, not a cancel.
    fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
    expect(ownsEscape('panel')).toBe(true);
  });

  it('leaves Escape alone when no drag is running', () => {
    setup();
    escape(document.body);
    expect(screen.queryByTestId('layout-editor')).toBeNull();
  });

  it('hands the layer back when the canvas unmounts mid-drag', async () => {
    setup();
    // What DetailPanel and Dialog both register; their handlers ask the stack
    // who owns the keystroke.
    pushLayer('panel');
    await pickUp();
    expect(ownsEscape('panel')).toBe(false);

    cleanup();

    // A leaked gesture layer sits on the stack forever, and every later Escape
    // in the app finds it there instead of the surface it was aimed at.
    expect(ownsEscape('panel')).toBe(true);
  });
});

/**
 * The C-II ghost, live (M46.2 Task 4).
 *
 * Driven through the keyboard sensor, which is the only pick-up jsdom can
 * honestly perform — the pointer sensor needs real geometry. That is enough
 * for what these cases are about: WHAT EXISTS during a drag and what does not.
 * The ghost's placement is arithmetic, and it is held against the measured
 * numbers in `BlockDrag.test.tsx`; here every rect is 0x0, so nothing below
 * asserts a coordinate.
 */
describe('a dragged block sends a ghost and keeps its source (M46.2 Task 4)', () => {
  beforeEach(() => resetLayers());
  afterEach(() => {
    cleanup();
    resetLayers();
    useUiStore.setState({ layoutEditor: null });
  });

  /** See the Escape suite's twin: the await is not optional, because
   * `KeyboardSensor.attach` registers its listener inside a `setTimeout(0)`. */
  const pickUp = async () => {
    const grip = screen.getAllByTestId('layout-grip')[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
    await new Promise((r) => setTimeout(r, 0));
    return grip;
  };

  it('puts a 40% clone under the cursor and leaves the source at full strength', async () => {
    setup();
    const source = document.querySelector<HTMLElement>('[data-drag-id="field:priority"]');
    if (source === null) throw new Error('the dragged row is not marked as a drag source');
    expect(screen.queryByTestId('drag-layer')).toBeNull();

    await pickUp();

    // The clone: a real copy of the source subtree, at the measured 0.4.
    const ghost = screen.getByTestId('drag-ghost');
    expect(ghost.style.opacity).toBe('0.4');
    expect(ghost.style.pointerEvents).toBe('none');
    expect(ghost.children).toHaveLength(1);
    // The inverted half of the old grammar: ours dimmed the source to 0.6 and
    // put nothing at all under the pointer (baseline §D3). The source now
    // stays exactly where it was, undimmed.
    expect(source.style.opacity).toBe('');
    expect(source.isConnected).toBe(true);
  });

  it('the clone answers to no identity of its own', async () => {
    setup();
    await pickUp();
    const ghost = screen.getByTestId('drag-ghost');
    // Duplicated `data-testid`s would make `getAllByTestId('layout-grip')[0]`
    // a coin toss for the length of every drag — including this suite's own
    // pick-up — and a clone still wearing `data-drag-id` could be picked up as
    // the SOURCE of the next one.
    expect(ghost.querySelectorAll('[data-testid]')).toHaveLength(0);
    expect(ghost.querySelectorAll('[data-drag-id]')).toHaveLength(0);
    expect(ghost.querySelectorAll('[data-line]')).toHaveLength(0);
    // The layer is inert, so the cloned preview is as unreachable as the
    // preview it copies — the invariant the layout editor is built on.
    expect(screen.getByTestId('drag-layer').hasAttribute('inert')).toBe(true);
  });

  it('lights exactly ONE drop indicator anywhere on the canvas', async () => {
    setup();
    // The canvas speaks two drop grammars — an insertion LINE where there is a
    // box to insert against, a whole-area RING where an index would be a lie
    // (heading appends, rest is derived). This holds the seam between them:
    // one pointer, one indicator, whichever grammar owns it. Both were
    // separately capable of lighting, and the old slot bar plus the ring could
    // both be on at once for the same drag.
    const lit = () => [
      ...[...document.querySelectorAll('[data-line]')].filter(
        (l) => l.getAttribute('data-lit') === 'true',
      ),
      ...[...screen.getAllByTestId('layout-droparea')].filter((a) =>
        a.className.includes('ring-1'),
      ),
    ];
    expect(lit()).toHaveLength(0);
    // Vacuity guard: the unlit lines must be MOUNTED, or "exactly one" is
    // satisfied by there being nothing to light. Their staying mounted is
    // also what the outgoing half of the cross-fade fades.
    expect(document.querySelectorAll('[data-line]').length).toBeGreaterThan(1);

    await pickUp();

    expect(lit()).toHaveLength(1);
    // jsdom measures every rect at 0x0, so WHICH target the partition
    // resolves to is arbitrary here — the reason this asserts the count and
    // the id grammar rather than a position. That the resolution is
    // continuous and midpoint-based is `dropPartition.test.ts`'s case.
    const gap = lit()[0].getAttribute('data-line') ?? lit()[0].getAttribute('data-slot');
    expect(document.querySelector(`[data-slot="${gap}"]`)).not.toBeNull();
  });

  it('Escape takes the ghost and the line with it, and leaves the editor open', async () => {
    setup();
    const grip = await pickUp();
    expect(screen.queryByTestId('drag-layer')).not.toBeNull();

    fireEvent.keyDown(grip, { key: 'Escape', code: 'Escape' });

    expect(screen.queryByTestId('drag-layer')).toBeNull();
    expect(
      [...document.querySelectorAll('[data-line]')].filter(
        (l) => l.getAttribute('data-lit') === 'true',
      ),
    ).toHaveLength(0);
    // The editor behind it is still standing — Task 1b's claim, unbroken.
    expect(screen.queryByTestId('layout-editor')).not.toBeNull();
  });
});
