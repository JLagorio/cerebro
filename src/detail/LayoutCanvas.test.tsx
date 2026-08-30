// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
