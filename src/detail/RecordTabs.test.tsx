// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListFile, TabDef } from '@/engine/types';
import { RecordTabs } from '@/detail/RecordTabs';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const TABS: TabDef[] = [
  { id: 'overview', name: 'Overview', icon: null, content: 'overview' },
  { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
];

function setup(overrides: Partial<React.ComponentProps<typeof RecordTabs>> = {}) {
  // The mocks stay named so their `.mock` records keep their type through the
  // spread below — no test overrides the handlers, only tabs/activeId.
  const onSelect = vi.fn();
  const onChange = vi.fn();
  const props = { tabs: TABS, activeId: 'overview', onSelect, onChange, ...overrides };
  render(<RecordTabs {...props} />);
  return { ...props, onSelect, onChange };
}

afterEach(cleanup);

describe('RecordTabs (M44.5)', () => {
  it('renders a tablist and selects on press', () => {
    const props = setup();
    expect(screen.getByTestId('record-tabs')).toBeTruthy();
    expect(screen.getByTestId('record-tab-overview').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('record-tab-spec'));
    expect(props.onSelect).toHaveBeenCalledWith('spec');
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('pressing the active tab opens its menu instead of reselecting', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
  });

  it('rename commits the trimmed name through onChange', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Tab name');
    fireEvent.change(input, { target: { value: '  Summary ' } });
    fireEvent.blur(input);
    expect(props.onChange).toHaveBeenCalledWith([{ ...TABS[0], name: 'Summary' }, TABS[1]]);
  });

  it('the add popover mints a sections tab with a unique id', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('new-record-tab'));
    fireEvent.change(screen.getByLabelText('Tab name'), { target: { value: 'Notes' } });
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ name: 'Notes', content: 'sections' });
    expect(new Set(next.map((t) => t.id)).size).toBe(3);
  });

  it('the add popover suggests a free name and takes a picked content kind', () => {
    const props = setup({ tabs: [TABS[0], { ...TABS[1], name: 'Tab' }] });
    fireEvent.click(screen.getByTestId('new-record-tab'));
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    // "Tab" is taken by a sibling, so the suggestion moves along.
    expect(next[2]).toMatchObject({ name: 'Tab 2', content: 'properties' });
  });

  it('the last tab cannot be deleted', () => {
    setup({ tabs: [TABS[0]] });
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    expect(screen.queryByRole('menuitem', { name: 'Delete tab' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
  });

  it('delete asks first, then commits the removal', () => {
    const props = setup();
    // Right-click reaches a non-active tab's menu without selecting it first.
    fireEvent.contextMenu(screen.getByTestId('record-tab-spec'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete tab' }));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Spec"?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete tab' }));
    expect(props.onChange).toHaveBeenCalledWith([TABS[0]]);
    // The dying tab was not the open one — selection has nothing to do.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('deleting the ACTIVE tab hands selection to a survivor', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete tab' }));
    expect(props.onSelect).toHaveBeenCalledWith('spec');
    expect(props.onChange).toHaveBeenCalledWith([TABS[1]]);
  });

  it('Move right reorders through onChange', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }));
    expect(props.onChange).toHaveBeenCalledWith([TABS[1], TABS[0]]);
  });

  it('Move left is not offered at the head of the strip', () => {
    setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    expect(screen.queryByRole('menuitem', { name: 'Move left' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Move right' })).toBeTruthy();
  });

  it('Duplicate copies the tab beside itself with fresh id and name', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next.map((t) => t.name)).toEqual(['Overview', 'Overview 2', 'Spec']);
    expect(new Set(next.map((t) => t.id)).size).toBe(3);
    expect(next[1].content).toBe('overview');
  });

  // M45.6 — the strip's horizontal inset is the HOST's measurement, not its
  // own: the page and the editor canvas are 24px columns, the peek is a 16px
  // one, and a strip that carried the page's gutter into the panel would sit
  // misaligned under everything above it. Default = the page, so the two
  // older hosts pass nothing.
  it('sits in the host’s gutter: the page by default, narrower on request', () => {
    setup();
    expect(screen.getByTestId('record-tabs').parentElement?.className).toContain('px-6');
    cleanup();
    setup({ gutter: 'panel' });
    const strip = screen.getByTestId('record-tabs').parentElement;
    expect(strip?.className).toContain('px-4');
    expect(strip?.className).not.toContain('px-6');
  });
});

describe('RecordTabs keyboard contract (M44.5)', () => {
  it('is one tab stop: only the open tab is tabbable, and arrows rove', () => {
    const props = setup();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    fireEvent.keyDown(screen.getByTestId('record-tab-overview'), { key: 'ArrowRight' });
    expect(props.onSelect).toHaveBeenCalledWith('spec');
    expect(document.activeElement).toBe(screen.getByTestId('record-tab-spec'));
  });

  it('reorders from the grip without switching tabs', () => {
    const props = setup();
    fireEvent.keyDown(screen.getByLabelText(/^Reorder Overview/), { key: 'ArrowRight' });
    expect(props.onChange).toHaveBeenCalledWith([TABS[1], TABS[0]]);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// M45.4 — a new tab can be a view of any database.
// ---------------------------------------------------------------------------

/** Project ← Task (Task holds the relation), plus a relation-less Note and
 * two typeless "everything" Lists — one qualifying source, the rest never
 * offer the related toggle. Task saves TWO views so the view picker has a
 * reason to exist; Note's synthesized single default keeps it hidden. The
 * second list's collection legally contains `::` — the case that broke a
 * composite-keyed option value and keeps the roster index-keyed. */
const makeList = (id: string, collection: string, name: string): ListFile => ({
  id,
  collection,
  project: null,
  path: `${collection}/${id}.list.yml`,
  definition: {
    name,
    icon: null,
    color: null,
    order: null,
    source: { type: null, project: null },
    views: [
      {
        id: 'main',
        name: 'All',
        icon: null,
        filters: null,
        presentation: { type: 'table', group: [], sort: [], columns: [] },
      },
    ],
  },
});

const READING_LIST = makeList('reading', 'crm', 'Reading list');
const CLIPS_LIST = makeList('clips', 'notes::archive', 'Clips');

function seedVault() {
  useVaultStore.setState({
    entries: [
      makeEntry({ path: 'types/project.md', title: 'Project', type: 'Type' }),
      makeEntry({
        path: 'types/task.md',
        title: 'Task',
        type: 'Type',
        properties: {
          fields: { project: { kind: 'relation', target: 'Project' } },
          views: [
            { id: 'all', name: 'Everything' },
            { id: 'open', name: 'Open' },
          ],
        } as never,
      }),
      makeEntry({ path: 'types/note.md', title: 'Note', type: 'Type' }),
    ],
    views: [READING_LIST, CLIPS_LIST],
  });
}

/** A saved view tab wearing all three optional keys — the prefill fixture. */
const VIEW_TAB: TabDef = {
  id: 'tasks',
  name: 'Tasks',
  icon: null,
  content: 'view',
  source: { type: 'Task' },
  view: 'open',
  scope: 'related',
};

/** Open the add popover and stand on the View tile. */
function openViewForm() {
  fireEvent.click(screen.getByTestId('new-record-tab'));
  fireEvent.click(screen.getByTestId('new-tab-kind-view'));
}

const pickSource = (value: string) =>
  fireEvent.change(screen.getByTestId('view-tab-source'), { target: { value } });

describe('RecordTabs view tabs (M45.4)', () => {
  beforeEach(seedVault);
  // Unmount BEFORE the store empties — a reset under a live ViewSourcePicker
  // is a state update no test fired (the act warning it produced).
  afterEach(() => {
    cleanup();
    useVaultStore.setState({ entries: [], views: [] });
  });

  it('offers the View tile last and drills into the source roster', () => {
    setup({ hostType: 'Project' });
    fireEvent.click(screen.getByTestId('new-record-tab'));
    const tiles = screen.getAllByTestId(/^new-tab-kind-/);
    expect(tiles.at(-1)?.getAttribute('data-testid')).toBe('new-tab-kind-view');
    // The drill-in belongs to the View tile alone.
    expect(screen.queryByTestId('view-tab-source')).toBeNull();
    fireEvent.click(screen.getByTestId('new-tab-kind-view'));
    const select = screen.getByTestId('view-tab-source') as HTMLSelectElement;
    // Types first (listTypes' sorted catalog), then Lists labeled by their
    // definition name (the dashboard submenu's labeling) and VALUED by roster
    // index — UI-transient keys that never need parsing back apart.
    expect([...select.options].map((o) => o.text)).toEqual([
      'Choose a database…',
      'Note',
      'Project',
      'Task',
      'Type',
      'Reading list',
      'Clips',
    ]);
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'type:Note',
      'type:Project',
      'type:Task',
      'type:Type',
      'list:0',
      'list:1',
    ]);
    // No source yet — nothing to add a view of.
    const create = screen.getByTestId('create-record-tab') as HTMLButtonElement;
    expect(create.textContent).toBe('Add view');
    expect(create.disabled).toBe(true);
  });

  it('offers the saved-view picker only when the source has more than one view', () => {
    setup({ hostType: 'Project' });
    openViewForm();
    pickSource('type:Note');
    expect(screen.queryByTestId('view-tab-view')).toBeNull();
    pickSource('type:Task');
    const picker = screen.getByTestId('view-tab-view') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.text)).toEqual(['Everything', 'Open']);
  });

  it('offers the related toggle default-ON when the source stores a relation at the host type', () => {
    setup({ hostType: 'Project' });
    openViewForm();
    pickSource('type:Task');
    const toggle = screen.getByRole('switch', {
      name: 'Only related to this record',
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // Note declares no relation at Project — the toggle goes away, never grays.
    pickSource('type:Note');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('offers no toggle when the host type is unqualified', () => {
    // Task's relation targets Project, not Note — a Note record cannot scope it.
    setup({ hostType: 'Note' });
    openViewForm();
    pickSource('type:Task');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('offers no toggle when the host has no type at all', () => {
    setup();
    openViewForm();
    pickSource('type:Task');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('creates the full view TabDef: source, picked view, related scope', () => {
    const props = setup({ hostType: 'Project' });
    openViewForm();
    pickSource('type:Task');
    fireEvent.change(screen.getByTestId('view-tab-view'), { target: { value: 'open' } });
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    // The name comes from the SOURCE, the id from the name — exact shape,
    // every optional key present.
    expect(next[2]).toEqual({
      id: 'task',
      name: 'Task',
      icon: null,
      content: 'view',
      source: { type: 'Task' },
      view: 'open',
      scope: 'related',
    });
  });

  it('creates the minimal view TabDef: list source, default view, no scope keys', () => {
    const props = setup({ hostType: 'Project' });
    openViewForm();
    pickSource('list:0');
    // One view, typeless source: no picker, no toggle.
    expect(screen.queryByTestId('view-tab-view')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next[2]).toEqual({
      id: 'reading-list',
      name: 'Reading list',
      icon: null,
      content: 'view',
      source: { list: 'reading', collection: 'crm' },
    });
  });

  it('a collection legally containing :: survives the index-keyed pick intact', () => {
    const props = setup({ hostType: 'Project' });
    openViewForm();
    pickSource('list:1');
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    // The pointer is read off the roster ROW, never parsed out of the option
    // value — the collection path comes through whole, the id unglued.
    expect(next[2]).toEqual({
      id: 'clips',
      name: 'Clips',
      icon: null,
      content: 'view',
      source: { list: 'clips', collection: 'notes::archive' },
    });
  });

  it('moves the suggested name along when a sibling took it, and a toggled-off scope is absent', () => {
    const props = setup({
      hostType: 'Project',
      tabs: [TABS[0], { id: 'task', name: 'Task', icon: null, content: 'sections' } as TabDef],
    });
    openViewForm();
    pickSource('type:Task');
    fireEvent.click(screen.getByRole('switch', { name: 'Only related to this record' }));
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next[2]).toMatchObject({ name: 'Task 2', content: 'view', source: { type: 'Task' } });
    expect('scope' in next[2]).toBe(false);
    expect('view' in next[2]).toBe(false);
    expect(new Set(next.map((t) => t.id)).size).toBe(3);
  });

  it('offers Change source… on view tabs only', () => {
    setup({ tabs: [TABS[0], VIEW_TAB], hostType: 'Project' });
    fireEvent.contextMenu(screen.getByTestId('record-tab-overview'));
    expect(screen.queryByRole('menuitem', { name: 'Change source…' })).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('record-tab-tasks'));
    expect(screen.getByRole('menuitem', { name: 'Change source…' })).toBeTruthy();
  });

  it('Change source… reopens the drill-in prefilled and commits the rewrite', () => {
    const props = setup({ tabs: [TABS[0], VIEW_TAB], hostType: 'Project' });
    fireEvent.contextMenu(screen.getByTestId('record-tab-tasks'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change source…' }));
    // Prefilled from the tab: source, saved view, scope.
    expect((screen.getByTestId('view-tab-source') as HTMLSelectElement).value).toBe('type:Task');
    expect((screen.getByTestId('view-tab-view') as HTMLSelectElement).value).toBe('open');
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
    pickSource('list:0');
    fireEvent.click(screen.getByTestId('change-source-save'));
    // The old pointer's view/scope never survive a source change: the new
    // source has one view and no type, so both keys are GONE, not stale.
    expect(props.onChange).toHaveBeenCalledWith([
      TABS[0],
      {
        id: 'tasks',
        name: 'Tasks',
        icon: null,
        content: 'view',
        source: { list: 'reading', collection: 'crm' },
      },
    ]);
  });

  it('non-view tabs still create through the plain path', () => {
    const props = setup({ hostType: 'Project' });
    fireEvent.click(screen.getByTestId('new-record-tab'));
    fireEvent.click(screen.getByTestId('new-tab-kind-view'));
    // Stepping back off the View tile abandons the drill-in entirely.
    fireEvent.click(screen.getByTestId('new-tab-kind-sections'));
    expect(screen.queryByTestId('view-tab-source')).toBeNull();
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next[2]).toEqual({ id: 'tab', name: 'Tab', icon: null, content: 'sections' });
  });
});
