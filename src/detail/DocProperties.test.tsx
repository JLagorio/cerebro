// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { DocProperties } from '@/detail/DocProperties';
import { buildSchema } from '@/engine/schema';
import { layoutTabScope } from '@/engine/typeCatalog';
import type { Entry, TabDef } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

const DOC = 'inbox/welcome.md';

function setup(docPartial: Partial<Entry> = {}) {
  const entries = fixtureVault();
  const doc: Entry = {
    path: DOC,
    filename: 'welcome.md',
    folder: 'inbox',
    project: null,
    title: 'Welcome',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-02T00:00:00Z',
    parseError: null,
    ...docPartial,
  };
  const all = [...entries, doc];
  const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
  useVaultStore.setState({ entries: all, vaultPath: '/vault', patchFrontmatter });
  const schema = buildSchema(all);
  render(<DocProperties entry={doc} schema={schema} />);
  return { patchFrontmatter };
}

describe('DocProperties', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  // M12.1: docs are docs. The type is not a dropdown — the only way a doc
  // becomes a record is the explicit Convert action, which names the change.
  it('shows Type: Doc with no dropdown', () => {
    setup();
    expect(screen.getByText('Doc')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Type' })).toBeNull();
  });

  it('converts a doc to a record through the explicit Convert action', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByRole('button', { name: 'Convert to record…' }));
    await user.click(screen.getByRole('option', { name: 'Work item' }));
    await user.click(screen.getByRole('button', { name: 'Convert to Work item' }));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { type: 'Work item' });
  });

  // M15: conversion has no inverse in the app, so picking a type in the list
  // must select, not commit — a stray click used to convert immediately.
  it('selects a type without converting until the footer action is pressed', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByRole('button', { name: 'Convert to record…' }));
    const row = screen.getByRole('option', { name: 'Work item' });
    expect(row.getAttribute('aria-selected')).toBe('false');
    await user.click(row);
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'Work item' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('closes the convert dialog on Escape', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Convert to record…' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A text input round-tripped `tags: [work, urgent]` to disk as the single
  // string "work,urgent", silently destroying the YAML list.
  it('shows a list-valued loose key read-only instead of collapsing it', () => {
    setup({ properties: { tags: ['work', 'urgent'] } });
    expect(screen.queryByLabelText('Tags')).toBeNull();
    expect(screen.getByText('work, urgent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Tags' })).toBeTruthy();
  });

  // The remove affordance must exist in the tree (and so in the tab order)
  // rather than appearing only under a pointer.
  it('keeps the remove button mounted without hover', () => {
    setup({ properties: { source: 'imported' } });
    const remove = screen.getByRole('button', { name: 'Remove Source' });
    expect(remove.closest('span')?.className).toContain('opacity-0');
    expect(remove.closest('span')?.className).not.toContain('hidden');
  });

  // An untyped doc has no schema: every kind but the plain ones produced a
  // text box (a Checkbox opened as a text input containing "false").
  it('offers only plain kinds on an untyped doc', () => {
    setup();
    fireEvent.click(screen.getByText('+ Add property'));
    expect((screen.getByTestId('property-kind-text') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('property-kind-number') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('property-kind-checkbox') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('property-kind-date') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers Convert on an already-typed entry', () => {
    setup({ type: 'Person', properties: { type: 'Person' } });
    expect(screen.getByText('Person')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert to record…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Type' })).toBeNull();
  });

  it('renders declared fields for a typed doc', () => {
    setup({ type: 'Work item', properties: { type: 'Work item', status: 'todo' } });
    // The Work item type declares status/priority in the fixture vault.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Priority')).toBeTruthy();
  });

  it('edits an undeclared scalar on blur', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'imported' } });
    const input = screen.getByLabelText('Source') as HTMLInputElement;
    expect(input.value).toBe('imported');
    fireEvent.change(input, { target: { value: 'manual' } });
    fireEvent.blur(input);
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { source: 'manual' });
  });

  it('keeps numeric undeclared values numeric', () => {
    const { patchFrontmatter } = setup({ properties: { effort: 3 } });
    const input = screen.getByLabelText('Effort') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { effort: 5 });
  });

  it('removes an undeclared property', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'imported' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Source' }));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { source: null });
  });

  it('adds a new empty property', () => {
    const { patchFrontmatter } = setup();
    fireEvent.click(screen.getByText('+ Add property'));
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'audience' } });
    fireEvent.keyDown(screen.getByLabelText('Property name'), { key: 'Enter' });
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { audience: '' });
  });

  // M16.9 moved this from a toast after the write was refused to a refusal
  // the surface states while you are still typing — and to the panel itself,
  // so RecordProperties gets the same guard instead of relying on
  // addPropertyToEntry, whose frontmatter-key check cannot see a declared
  // field the open record happens to leave empty.
  it('refuses a duplicate property name in place, before any write', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'x' } });
    fireEvent.click(screen.getByText('+ Add property'));
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'source' } });

    expect(screen.getByRole('alert').textContent).toContain('already a property here');
    expect((screen.getByTestId('property-kind-text') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByLabelText('Property name'), { key: 'Enter' });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});

describe('DocProperties display config (M44.1 follow-up)', () => {
  afterEach(cleanup);

  // Mirrors RecordProperties.test.tsx's fixture mechanics (the Info tab is
  // reachable for a typed record too, via DocPage's side panel): the
  // work-item fields declare no `visibility` by default, so marking `due`
  // `hide_when_empty` is enough to fold it without blanking a field that IS
  // set on fld-1. `hideField` adds a field marked `visibility: 'hide'`
  // outright — hidden on purpose, not merely empty — to pin that show_empty
  // never reaches it here either.
  const setupTyped = (options: { display?: Record<string, unknown>; hideField?: boolean } = {}) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    const fields = typeProps.fields as Record<string, unknown>;
    fields.due = { kind: 'date', visibility: 'hide_when_empty' };
    if (options.hideField === true) {
      fields.internal = { kind: 'text', visibility: 'hide' };
    }
    if (options.display !== undefined) {
      typeProps.display = options.display;
    }
    useVaultStore.setState({ entries, vaultPath: '/vault' });
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<DocProperties entry={entry} schema={buildSchema(entries)} />);
  };

  it('folds empty properties behind the count by default', () => {
    setupTyped();
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeTruthy();
    expect(screen.queryByText('Due')).toBeNull();
  });

  it('show_empty unfolds them and retires the toggle — nothing left to fold', () => {
    setupTyped({ display: { show_empty: true } });
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeNull();
    expect(screen.getByText('Due')).toBeTruthy();
  });

  it('show_empty does not reach a field hidden on purpose', () => {
    setupTyped({ display: { show_empty: true }, hideField: true });
    // `due` was hidden for being empty — show_empty unfolds it.
    expect(screen.getByText('Due')).toBeTruthy();
    // `internal` was hidden on purpose — show_empty speaks about emptiness
    // only, so it stays folded and the toggle reappears counting it alone.
    expect(screen.queryByText('Internal')).toBeNull();
    expect(screen.getByTestId('hidden-properties-toggle')).toBeTruthy();
  });
});
describe('DocProperties layout groups (M45.1)', () => {
  afterEach(cleanup);

  // Mirrors RecordProperties.test.tsx's M45.1 block with this file's typed
  // fixture mechanics: mutate the work-item Type doc, render fld-1. The Type
  // row, Convert flow, and undeclared keys stay exactly as the flat panel
  // renders them — layout arranges only the declared stack.
  const setupLayout = (
    layout: Record<string, unknown>,
    mutate?: (fields: Record<string, unknown>) => void,
  ) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    mutate?.(typeProps.fields as Record<string, unknown>);
    typeProps.layout = layout;
    useVaultStore.setState({ entries, vaultPath: '/vault' });
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<DocProperties entry={entry} schema={buildSchema(entries)} />);
  };

  const rowNames = () =>
    screen.getAllByTestId('property-row').map((r) => r.getAttribute('data-property'));

  it('places fields in their groups, rest after, heading claims out — Type row untouched', () => {
    setupLayout({
      heading: ['status'],
      groups: [{ id: 'g-main', name: 'Main', fields: ['priority'] }],
    });
    const group = screen.getByTestId('property-group');
    expect(group.getAttribute('data-group')).toBe('g-main');
    expect(within(group).getByText('Main')).toBeTruthy();
    expect(within(group).getByText('Priority')).toBeTruthy();
    // Heading-claimed fields live in the strip, not this stack.
    expect(screen.queryByText('Status')).toBeNull();
    // Type row first as ever; rest headerless after the group; undeclared
    // scalars (key, channel) after everything.
    expect(rowNames()).toEqual(['Type', 'priority', 'assignee', 'due', 'key', 'channel']);
  });

  it('pools hidden fields from every container into the one expander', () => {
    setupLayout(
      {
        heading: ['due'],
        groups: [{ id: 'g-main', name: 'Main', fields: ['internal', 'priority'] }],
      },
      (fields) => {
        fields.due = { kind: 'date', visibility: 'hide_when_empty' };
        fields.internal = { kind: 'text', visibility: 'hide' };
        fields.archived = { kind: 'checkbox', visibility: 'hide' };
      },
    );
    const toggle = screen.getByTestId('hidden-properties-toggle');
    expect(toggle.textContent).toContain('3 hidden properties');
    expect(screen.queryByText('Due')).toBeNull();
    fireEvent.click(toggle);
    // Heading folds open at the stack top (under the Type row), the group's
    // inside the group, rest's in rest.
    expect(rowNames()).toEqual([
      'Type',
      'due',
      'internal',
      'priority',
      'status',
      'assignee',
      'archived',
      'key',
      'channel',
    ]);
    expect(within(screen.getByTestId('property-group')).getByText('Internal')).toBeTruthy();
  });

  it('grouped mode renders no reorder grips', () => {
    setupLayout({ groups: [{ id: 'g-main', name: 'Main', fields: ['priority'] }] });
    expect(screen.getByTestId('property-group')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull();
  });
});

/**
 * M45.6 — the same tab seam RecordProperties grew, on this stack. No shipped
 * host passes one (the doc side panel stands BESIDE the page, not on one of
 * its tabs — see the mount in `DocSidePanel`), so these cases mount the
 * component directly: the seam is real, one stack cannot disagree with the
 * other about what a tab holds, and absent stays the pre-tab stack.
 */
describe('DocProperties sections belong to tabs (M45.6)', () => {
  afterEach(cleanup);

  const TABS: TabDef[] = [
    { id: 'one', name: 'One', icon: null, content: 'overview' },
    { id: 'two', name: 'Two', icon: null, content: 'properties' },
  ];

  const setupTab = (activeId: string | null) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    (typeDoc.properties as unknown as Record<string, unknown>).layout = {
      heading: ['status'],
      groups: [
        { id: 'g-alpha', name: 'Alpha', fields: ['priority'], tab: 'one' },
        { id: 'g-beta', name: 'Beta', fields: ['assignee'], tab: 'two' },
        { id: 'g-gamma', name: 'Gamma', fields: ['due'] },
      ],
    };
    useVaultStore.setState({ entries, vaultPath: '/vault' });
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(
      <DocProperties
        entry={entry}
        schema={buildSchema(entries)}
        tab={activeId === null ? undefined : layoutTabScope(TABS, activeId)}
      />,
    );
  };

  const groupIds = () =>
    screen.queryAllByTestId('property-group').map((g) => g.getAttribute('data-group'));
  const rowNames = () =>
    screen.getAllByTestId('property-row').map((r) => r.getAttribute('data-property'));

  it('the default tab shows its own sections and the untabbed ones', () => {
    setupTab('one');
    expect(groupIds()).toEqual(['g-alpha', 'g-gamma']);
    // Rest picks up nothing another tab's section claims — the Type row and
    // the loose keys are all that follow.
    expect(rowNames()).toEqual(['Type', 'priority', 'due', 'key', 'channel']);
  });

  it('a second tab shows only its own', () => {
    setupTab('two');
    expect(groupIds()).toEqual(['g-beta']);
    expect(rowNames()).toEqual(['Type', 'assignee', 'key', 'channel']);
  });

  it('a hostless mount is the pre-tab stack verbatim', () => {
    setupTab(null);
    expect(groupIds()).toEqual(['g-alpha', 'g-beta', 'g-gamma']);
    expect(rowNames()).toEqual(['Type', 'priority', 'assignee', 'due', 'key', 'channel']);
  });
});
