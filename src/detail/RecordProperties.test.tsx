// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordProperties } from './RecordProperties';
import { buildSchema } from '@/engine/schema';
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
 * M46.1 — a section belongs to the RECORD, not to a tab (user, 2026-08-29:
 * "sorry tabs are only for related data sources. fields shwo above. just like
 * notion."). This stack takes no tab and knows of none: every container the
 * layout resolves renders, on whatever surface mounted it.
 *
 * M45.6's per-tab cases are deleted rather than weakened — they described a
 * scoping seam that no longer exists.
 */
describe('the stack is the record’s, not a tab’s (M46.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  const groupIds = () =>
    screen.queryAllByTestId('property-group').map((g) => g.getAttribute('data-group'));
  const rowNames = () =>
    screen.getAllByTestId('property-row').map((r) => r.getAttribute('data-property'));

  it('renders every section, and the remainder after them', () => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    (typeDoc.properties as unknown as Record<string, unknown>).layout = {
      heading: ['status'],
      groups: [
        { id: 'g-alpha', name: 'Alpha', fields: ['priority'] },
        { id: 'g-beta', name: 'Beta', fields: ['assignee'] },
        { id: 'g-gamma', name: 'Gamma', fields: ['due'] },
      ],
    };
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
    expect(groupIds()).toEqual(['g-alpha', 'g-beta', 'g-gamma']);
    // `status` heads the strip its host renders, so it stays out of the
    // stack; the undeclared key rides the headerless remainder.
    expect(rowNames()).toEqual(['priority', 'assignee', 'due', 'channel']);
  });

  /**
   * The expander promises rows, and it promises them across CONTAINERS: a
   * folded field inside a section is hidden HERE, so the count pools every
   * one of them and each opens inside its own section. `revealableFields`
   * owns that union (engine/layout.ts) so a fourth container joins the count
   * in one place rather than in two hand-rolled ones.
   */
  it('the hidden count pools every container the stack can reveal', () => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    const fields = typeProps.fields as Record<string, unknown>;
    fields.internal = { kind: 'text', visibility: 'hide' };
    fields.archived = { kind: 'checkbox', visibility: 'hide' };
    typeProps.layout = {
      groups: [
        { id: 'g-alpha', name: 'Alpha', fields: ['priority', 'internal'] },
        { id: 'g-beta', name: 'Beta', fields: ['assignee', 'archived'] },
      ],
    };
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
    const toggle = screen.getByTestId('hidden-properties-toggle');
    expect(toggle.textContent).toContain('2 hidden properties');
    fireEvent.click(toggle);
    const [alpha, beta] = screen.getAllByTestId('property-group');
    expect(within(alpha).getByText('Internal')).toBeTruthy();
    expect(within(beta).getByText('Archived')).toBeTruthy();
  });
});

/**
 * The measured property-row anatomy (M46.2 Task 7), read at the surface that
 * assembles it. Numbers are quoted from
 * `docs/superpowers/specs/2026-08-29-notion-drag-and-row-reference.md` §A.1;
 * what travels is the GEOMETRY and the relationship between the two cells —
 * the colours are ours, because Notion's are translucencies over its own
 * background and ours are steps in a designed neutral ramp.
 */
describe('the measured row anatomy (M46.2 Task 7)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  const mount = () => {
    const entries = fixtureVault();
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
  };

  it('spaces rows by 4px, so a 34px row lands on the measured 38px pitch (§A1)', () => {
    mount();
    const row = screen.getAllByTestId('property-row')[0];
    const container = row.parentElement!;
    // The 4 is the container's GAP and never the row's padding: the reference
    // is explicit that the gap must not be part of the hover target, and the
    // hover target is the row's label cell.
    expect(container.className).toContain('gap-1');
    expect(container.className).not.toContain('gap-[7px]');
    expect(row.className).toContain('min-h-[34px]');
  });

  it('gives the value cell the measured box and NO hover wash (§A5, §A6)', () => {
    mount();
    const cells = [...document.querySelectorAll('[data-cell-primary]')];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.className).toContain('p-1.5'); // 6px
      expect(c.className).toContain('min-h-[34px]');
      expect(c.className).toContain('overflow-hidden');
      expect(c.className).toContain('cursor-pointer');
      // 4px — SMALLER than the label cell's 6px. Ours was 8px against 6, the
      // exact inverse of the measured hierarchy.
      expect(c.className).toContain('rounded-xs');
      expect(c.className).not.toContain('rounded-md');
      // Only the label lights.
      expect(c.className).not.toContain('hover:bg-');
    }
  });

  it('draws an unset value as the literal word Empty, in an identical box (§A7)', () => {
    mount();
    // Never a zero, never a dash, never a collapsed row: an empty property is
    // still a row you can click, and it is the same size as a full one.
    const empty = screen.getAllByText('Empty')[0].closest('[data-cell-primary]');
    expect(empty).not.toBeNull();
    const filled = [...document.querySelectorAll('[data-cell-primary]')].find(
      (c) => c !== empty && c.textContent !== '' && !c.textContent!.includes('Empty'),
    );
    expect(filled).toBeTruthy();
    // Not whole-string equality — kinds differ in whether their chips wrap.
    // What must not differ is the BOX: padding, radius, floor height.
    for (const token of ['p-1.5', 'rounded-xs', 'min-h-[34px]', 'overflow-hidden']) {
      expect(empty!.className).toContain(token);
      expect(filled!.className).toContain(token);
    }
  });
});
