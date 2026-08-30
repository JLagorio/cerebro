// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordProperties } from './RecordProperties';
import { buildSchema } from '@/engine/schema';
import { layoutTabScope } from '@/engine/typeCatalog';
import type { TabDef } from '@/engine/types';
import { fixtureVault } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';

describe('RecordProperties display config (M44.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  // `fixtureVault()`'s work-item fields declare no `visibility` at all, so by
  // default `splitByVisibility` never folds anything (M16.10's default is
  // `show`, not `hide_when_empty`). `due` is left unset on fld-1, so marking
  // it `hide_when_empty` on the type is enough to produce a hidden property
  // without also having to blank a field that IS set. `hideField` adds a
  // second field marked `visibility: 'hide'` outright — deliberately hidden,
  // not merely empty — to pin the plan decision that `show_empty` never
  // reaches it.
  const setup = (options: { display?: Record<string, unknown>; hideField?: boolean } = {}) => {
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
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
  };

  it('folds empty properties behind the count by default', () => {
    setup();
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeTruthy();
    expect(screen.queryByText('Due')).toBeNull();
  });

  it('show_empty unfolds them and retires the toggle — nothing left to fold', () => {
    setup({ display: { show_empty: true } });
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeNull();
    expect(screen.getByText('Due')).toBeTruthy();
  });

  it('show_empty does not reach a field hidden on purpose', () => {
    setup({ display: { show_empty: true }, hideField: true });
    // `due` was hidden for being empty — show_empty unfolds it.
    expect(screen.getByText('Due')).toBeTruthy();
    // `internal` was hidden on purpose — show_empty speaks about emptiness
    // only, so it stays folded and the toggle reappears counting it alone.
    expect(screen.queryByText('Internal')).toBeNull();
    expect(screen.getByTestId('hidden-properties-toggle')).toBeTruthy();
  });

  it('_sections never renders as a property row — the _ namespace hides it (M44.5)', () => {
    const entries = fixtureVault();
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    (entry.properties as Record<string, unknown>)._sections = {
      spec: [{ heading: 'Goal', text: 'Ship it' }],
    };
    useVaultStore.setState({ entries, vaultPath: '/vault' });
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
    const rows = screen.getAllByTestId('property-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.textContent?.toLowerCase() ?? '').not.toContain('section');
    }
  });
});

describe('RecordProperties layout groups (M45.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  // The same fixture mechanics as the display-config block above: mutate the
  // work-item Type doc, render fld-1 against the rebuilt schema. `mutate` lets
  // a test add visibility-marked fields before the layout is applied.
  const setupLayout = (
    layout: Record<string, unknown>,
    mutate?: (fields: Record<string, unknown>) => void,
  ) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    mutate?.(typeProps.fields as Record<string, unknown>);
    typeProps.layout = layout;
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
  };

  const rowNames = () =>
    screen.getAllByTestId('property-row').map((r) => r.getAttribute('data-property'));

  it('places fields in their groups, rest after, heading claims out of the stack', () => {
    setupLayout({
      heading: ['status'],
      groups: [{ id: 'g-main', name: 'Main', fields: ['priority'] }],
    });
    const group = screen.getByTestId('property-group');
    expect(group.getAttribute('data-group')).toBe('g-main');
    expect(within(group).getByText('Main')).toBeTruthy();
    expect(within(group).getByText('Priority')).toBeTruthy();
    // Heading-claimed fields live in the strip, not the stack — in NO container.
    expect(screen.queryByText('Status')).toBeNull();
    // Rest follows the named group with no header of its own; undeclared
    // (channel) stays after everything, then the add-property trigger.
    expect(rowNames()).toEqual(['priority', 'assignee', 'due', 'channel']);
    expect(within(group).queryByText('Assignee')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
  });

  it('pools hidden fields from every container — heading folds included — into the one expander', () => {
    setupLayout(
      {
        heading: ['due'],
        groups: [{ id: 'g-main', name: 'Main', fields: ['internal', 'priority'] }],
      },
      (fields) => {
        // due: empty on fld-1, folds out of the STRIP; internal folds inside
        // the group; archived folds in rest. One expander counts all three.
        fields.due = { kind: 'date', visibility: 'hide_when_empty' };
        fields.internal = { kind: 'text', visibility: 'hide' };
        fields.archived = { kind: 'checkbox', visibility: 'hide' };
      },
    );
    const toggle = screen.getByTestId('hidden-properties-toggle');
    expect(toggle.textContent).toContain('3 hidden properties');
    expect(screen.queryByText('Due')).toBeNull();
    fireEvent.click(toggle);
    // Each fold surfaces in its own container: the heading's at the stack top
    // (the strip cannot reveal it), the group's inside the group, rest's in rest.
    expect(rowNames()).toEqual([
      'due',
      'internal',
      'priority',
      'status',
      'assignee',
      'archived',
      'channel',
    ]);
    expect(within(screen.getByTestId('property-group')).getByText('Internal')).toBeTruthy();
  });

  it('grouped mode renders no reorder grips', () => {
    setupLayout({ groups: [{ id: 'g-main', name: 'Main', fields: ['priority'] }] });
    expect(screen.getByTestId('property-group')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull();
  });

  it('an all-dead layout keeps the flat stack — grips included', () => {
    setupLayout({
      heading: ['ghost'],
      groups: [{ id: 'g-dead', name: 'Gone', fields: ['phantom'] }],
    });
    expect(screen.queryByTestId('property-group')).toBeNull();
    expect(screen.getByRole('button', { name: /^Reorder Status/ })).toBeTruthy();
  });

  it('an empty group renders nothing — header included — until a reveal fills it', () => {
    setupLayout(
      {
        groups: [
          { id: 'g-dead', name: 'Dead', fields: ['ghost'] },
          { id: 'g-folded', name: 'Folded', fields: ['internal'] },
          { id: 'g-live', name: 'Main', fields: ['priority'] },
        ],
      },
      (fields) => {
        fields.internal = { kind: 'text', visibility: 'hide' };
      },
    );
    const ids = () =>
      screen.getAllByTestId('property-group').map((g) => g.getAttribute('data-group'));
    expect(ids()).toEqual(['g-live']);
    expect(screen.queryByText('Dead')).toBeNull();
    expect(screen.queryByText('Folded')).toBeNull();
    fireEvent.click(screen.getByTestId('hidden-properties-toggle'));
    expect(ids()).toEqual(['g-folded', 'g-live']);
    expect(screen.getByText('Folded')).toBeTruthy();
  });
});

/**
 * M45.6 — a section belongs to a tab, so the stack shows the OPEN tab's
 * sections. The user's second defect (2026-08-29: "thers no way to put
 * anything in the tabs"): `tab` was a dimension the config had and the
 * surfaces ignored, so a section assigned to a tab rendered on all of them.
 *
 * The seam is one optional prop carrying `layoutTabScope`'s answer — absent
 * is the pre-M45.6 stack VERBATIM, which is what a host with no tabs at all
 * (InboxPage) mounts.
 */
describe('RecordProperties sections belong to tabs (M45.6)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  const TABS: TabDef[] = [
    { id: 'one', name: 'One', icon: null, content: 'overview' },
    { id: 'two', name: 'Two', icon: null, content: 'properties' },
  ];

  // Alpha lives on tab one, Beta on tab two, Gamma nowhere — the three cases
  // one fixture has to hold to prove a section shows on exactly one tab.
  const LAYOUT = {
    heading: ['status'],
    groups: [
      { id: 'g-alpha', name: 'Alpha', fields: ['priority'], tab: 'one' },
      { id: 'g-beta', name: 'Beta', fields: ['assignee'], tab: 'two' },
      { id: 'g-gamma', name: 'Gamma', fields: ['due'] },
    ],
  };

  const setupTab = (activeId: string | null, layout: Record<string, unknown> = LAYOUT) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    (typeDoc.properties as unknown as Record<string, unknown>).layout = layout;
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(
      <RecordProperties
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
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Assignee')).toBeNull();
  });

  it('a second tab shows only its own — the untabbed section stays home', () => {
    setupTab('two');
    expect(groupIds()).toEqual(['g-beta']);
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
  });

  // The leak: `rest` is the remainder of the ROSTER, counted across every
  // tab. Resolving the tab's groups first would make a field placed on the
  // other tab look unclaimed here and render it loose — the same property on
  // two tabs, one of them without its section.
  it('rest never picks up a field another tab’s section claims', () => {
    setupTab('two');
    // assignee (this tab's section) and the undeclared key only: priority and
    // due are claimed elsewhere, not loose here.
    expect(rowNames()).toEqual(['assignee', 'channel']);
  });

  it('and the same on the default tab', () => {
    setupTab('one');
    expect(rowNames()).toEqual(['priority', 'due', 'channel']);
  });

  // Every vault written before M45.6, and every host that has no tabs to
  // pass: one stack, every section.
  it('a hostless mount is the pre-tab stack verbatim', () => {
    setupTab(null);
    expect(groupIds()).toEqual(['g-alpha', 'g-beta', 'g-gamma']);
    expect(rowNames()).toEqual(['priority', 'assignee', 'due', 'channel']);
  });

  // A section whose tab died — deleted, or re-kinded to one that renders no
  // stack — falls back onto the default tab VISIBLE. The engine owns that
  // rule; this pins that the surface does not undo it.
  it('a section on a tab that no longer exists comes home to the default', () => {
    setupTab('one', {
      groups: [{ id: 'g-ghost', name: 'Ghost', fields: ['priority'], tab: 'gone' }],
    });
    expect(groupIds()).toEqual(['g-ghost']);
  });

  // The expander promises rows. A folded field inside another tab's section
  // is not hidden HERE — it is elsewhere — and counting it would promise a
  // row this stack cannot produce.
  it('the hidden count is what this tab can actually reveal', () => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    const fields = typeProps.fields as Record<string, unknown>;
    fields.internal = { kind: 'text', visibility: 'hide' };
    fields.archived = { kind: 'checkbox', visibility: 'hide' };
    typeProps.layout = {
      groups: [
        { id: 'g-alpha', name: 'Alpha', fields: ['priority', 'internal'], tab: 'one' },
        { id: 'g-beta', name: 'Beta', fields: ['assignee', 'archived'], tab: 'two' },
      ],
    };
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(
      <RecordProperties entry={entry} schema={buildSchema(entries)} tab={layoutTabScope(TABS, 'one')} />,
    );
    const toggle = screen.getByTestId('hidden-properties-toggle');
    expect(toggle.textContent).toContain('1 hidden property');
    fireEvent.click(toggle);
    expect(within(screen.getByTestId('property-group')).getByText('Internal')).toBeTruthy();
    expect(screen.queryByText('Archived')).toBeNull();
  });
});
