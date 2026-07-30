import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableView } from '@/views/TableView';
import { buildSchema } from '@/engine/schema';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import type { Entry, Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }],
};

function setup() {
  const entries = fixtureVault();
  useVaultStore.setState({ entries });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Work item');
  const fields = schema.types.get('Work item')?.fields ?? [];
  render(
    <TableView entries={items} presentation={presentation} schema={schema} fields={fields} />,
  );
  return { items };
}

afterEach(cleanup);

describe('TableView row opening (M9.3)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
    // Standing in a saved view — the case that used to navigate away.
    useNavStore.setState({
      selection: { kind: 'list', id: 'at-risk-work' },
      history: [{ kind: 'list', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  it('opens a work item in the detail panel without leaving the view', async () => {
    const user = userEvent.setup();
    const { items } = setup();
    const item = items[0];

    await user.click(screen.getByLabelText(`Open ${item.title}`));

    expect(useUiStore.getState().detailPath).toBe(item.path);
    // The regression: this used to become { kind: 'project', … }.
    expect(useNavStore.getState().selection).toEqual({ kind: 'list', id: 'at-risk-work' });
  });

  it('still navigates when the row is a Project record', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.type === 'Project')!;
    render(
      <TableView
        entries={[project]}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Project')?.fields ?? []}
      />,
    );

    await user.click(screen.getByLabelText(`Open ${project.title}`));

    // A project is a page, not a panel — it is the one kind that still moves.
    expect(useNavStore.getState().selection).toEqual({ kind: 'project', path: project.path });
  });
});

/**
 * Column resizing (M11).
 *
 * The old resizer called `onColumnsChange` on every mousemove, which meant a
 * YAML write and a vault rescan per pixel — the drag fought a stream of
 * re-renders carrying stale widths, which is why it "barely worked". These pin
 * the fix: paint continuously, persist exactly once.
 */
describe('TableView column resizing (M11)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  function grid(onColumnsChange = vi.fn(), onPresentationChange = vi.fn()) {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
        onColumnsChange={onColumnsChange}
        onPresentationChange={onPresentationChange}
      />,
    );
    return { onColumnsChange, onPresentationChange };
  }

  // jsdom has no PointerEvent, and testing-library's `pointerDown` helper then
  // falls back to a bare Event, which silently drops clientX. Dispatching a
  // MouseEvent named `pointerdown` reaches the same listener with coordinates
  // intact — the listeners are registered by name, not by event class.
  const at = (type: string, clientX: number) =>
    new MouseEvent(type, { clientX, bubbles: true });

  const drag = (handle: HTMLElement, from: number, to: number) => {
    fireEvent(handle, at('pointerdown', from));
    fireEvent(window, at('pointermove', (from + to) / 2));
    fireEvent(window, at('pointermove', to));
    fireEvent(window, at('pointerup', to));
  };

  it('persists a column width once, on release — not per pointer move', () => {
    const { onColumnsChange } = grid();
    drag(screen.getByLabelText('Resize Status column'), 100, 160);
    // One write for the whole gesture. Anything more is a disk write and a
    // rescan per pixel.
    expect(onColumnsChange).toHaveBeenCalledTimes(1);
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 210 });
  });

  it('measures from where the drag started, so a fast drag lands on the pointer', () => {
    // The old resizer accumulated per-event deltas, which drifted whenever a
    // move outran a repaint. Two moves ending at the same x must produce the
    // same width as one.
    const { onColumnsChange } = grid();
    const handle = screen.getByLabelText('Resize Status column');
    fireEvent(handle, at('pointerdown', 0));
    fireEvent(window, at('pointermove', 500));
    fireEvent(window, at('pointermove', 40));
    fireEvent(window, at('pointerup', 40));
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 190 });
  });

  it('clamps a column to the minimum rather than collapsing it', () => {
    const { onColumnsChange } = grid();
    drag(screen.getByLabelText('Resize Status column'), 400, 0);
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 60 });
  });

  it('resizes the name column, which nothing could resize before', () => {
    const { onPresentationChange } = grid();
    drag(screen.getByLabelText('Resize Name column'), 280, 380);
    expect(onPresentationChange).toHaveBeenCalledTimes(1);
    expect(onPresentationChange.mock.calls[0][0].titleWidth).toBe(380);
  });

  it('resizes from the keyboard, so the affordance is not pointer-only', () => {
    const { onColumnsChange } = grid();
    fireEvent.keyDown(screen.getByLabelText('Resize Status column'), { key: 'ArrowRight' });
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 158 });
  });

  it('offers no resizer on a surface with no view file to write to', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
    expect(screen.queryByLabelText('Resize Status column')).toBeNull();
    expect(screen.queryByLabelText('Resize Name column')).toBeNull();
  });
});

/**
 * Relation chips (M11).
 *
 * A related record is a chip, not an arrow glyph followed by a title. Whether
 * the chip also carries the target type's icon is a per-view setting, because
 * it is a question about this table's density rather than about the data.
 */
describe('TableView relation chips (M11)', () => {
  const OBJECTIVE = 'records/objectives/grow-eu.md';

  function withRelation(chips?: 'plain' | 'type-icon') {
    const entries: Entry[] = [
      ...fixtureVault(),
      makeEntry({
        path: 'types/objective.md',
        title: 'Objective',
        type: 'Type',
        properties: { icon: 'target', color: '#3D8BE8' } as Entry['properties'],
      }),
      makeEntry({
        path: 'types/bet.md',
        title: 'Bet',
        type: 'Type',
        properties: {
          fields: { objective: { kind: 'relation', target: 'Objective' } },
        } as unknown as Entry['properties'],
      }),
      makeEntry({ path: OBJECTIVE, title: 'Grow EU revenue', type: 'Objective' }),
      makeEntry({
        path: 'records/bets/eu-push.md',
        title: 'EU push',
        type: 'Bet',
        relationships: { objective: ['grow-eu'] },
      }),
    ];
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Bet')}
        presentation={{
          type: 'table',
          group: [],
          sort: [],
          columns: [{ field: 'objective' }],
          ...(chips === undefined ? {} : { chips }),
        }}
        schema={schema}
        fields={schema.types.get('Bet')?.fields ?? []}
      />,
    );
  }

  it('renders the linked record as a chip carrying its title', () => {
    withRelation();
    const chip = screen.getByTestId('relation-chip');
    expect(chip.textContent).toBe('Grow EU revenue');
    // The arrow glyph is gone: the chip shape already says "this is a link",
    // and in a narrow cell the icon cost a fifth of the width.
    expect(chip.querySelector('svg')).toBeNull();
  });

  it('carries the target type’s icon when the view asks for it', () => {
    withRelation('type-icon');
    const chip = screen.getByTestId('relation-chip');
    expect(chip.textContent).toBe('Grow EU revenue');
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('defaults to plain chips', () => {
    withRelation(undefined);
    expect(screen.getByTestId('relation-chip').querySelector('svg')).toBeNull();
  });
});
