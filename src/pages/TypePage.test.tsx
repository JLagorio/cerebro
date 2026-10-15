import { useNavStore } from '@/stores/navStore';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toIsoDate } from '@/engine/dates';
import type { Entry, FilterGroup } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { TypePage } from '@/pages/TypePage';
import { VIEW_KINDS } from '@/views/viewKinds';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { BatchOp } from '@/engine/batch';
import * as csvActions from '@/app/csvActions';

/**
 * jsdom cannot render mermaid, and the whiteboard tests below are about WHERE
 * a canvas lands rather than what it draws. The stand-in keeps the shared
 * editor's contract and nothing else.
 */
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: () => <div data-testid="fake-editor" />,
}));

let patches: { path: string; patch: Record<string, unknown> }[];

beforeEach(() => {
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'type', name: 'Work item' });
  patches = [];
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: fixtureVault(),
    views: [],
    status: 'ready',
    patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
      patches.push({ path, patch });
      return true;
    }),
    // M60.6: a database-wide rewrite lands as one batch; its patch ops are
    // the writes, in order.
    applyBatch: vi.fn(async (ops: BatchOp[]) => {
      for (const op of ops) if (op.op === 'patch') patches.push({ path: op.path, patch: op.set });
      return { batchId: 'b'.repeat(32), files: [] };
    }),
  });
  useUiStore.setState({ detailPath: null });
});

afterEach(cleanup);

it('exports the selected saved database tab through its menu', () => {
  const exportSpy = vi.spyOn(csvActions, 'exportViewCsv').mockResolvedValue(false);
  try {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    const tab = screen.getAllByRole('tab')[0];
    const view = tab.getAttribute('data-testid')!.replace('view-tab-', '');
    fireEvent.click(tab);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as CSV…' }));
    expect(exportSpy).toHaveBeenCalledWith({ kind: 'type', name: 'Work item', view }, []);
  } finally {
    exportSpy.mockRestore();
  }
});

describe('TypePage names unusable view references (M60.2b)', () => {
  const withFilters = (filters: FilterGroup) =>
    fixtureVault().map((entry) =>
      entry.path !== 'types/work-item.md'
        ? entry
        : {
            ...entry,
            properties: {
              ...entry.properties,
              views: [{ id: 'all', name: 'All', filters, presentation: { type: 'table' } }],
            } as unknown as Entry['properties'],
          },
    );

  it('names every invalid filter, marks its chip, and clears when the saved view is repaired', () => {
    useVaultStore.setState({
      entries: withFilters({
        all: [
          { field: 'ghost_field', op: 'equals', value: 'yes' },
          { field: 'status', op: 'equals', value: 'wip' },
        ],
      }),
    });
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByTestId('view-problems').textContent).toContain(
      '“ghost_field” in the filter: Work item has no property by that name.',
    );
    expect(screen.getByTestId('view-problems').textContent).toContain(
      '“wip” is not an option of Status.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(
      screen
        .getAllByTestId(/^filter-chip-\d+$/)
        .map((chip) => chip.parentElement?.getAttribute('data-problem')),
    ).toEqual(['unknown_field', 'unknown_option']);

    act(() =>
      useVaultStore.setState({
        entries: withFilters({ all: [{ field: 'status', op: 'equals', value: 'todo' }] }),
      }),
    );
    expect(screen.queryByTestId('view-problems')).toBeNull();
    expect(
      screen.getByTestId('filter-chip-0').parentElement?.getAttribute('data-problem'),
    ).toBeNull();
    expect(screen.getByText('Design first-run flow')).toBeTruthy();
  });

  it('checks held keys against the whole database even when the filter returns no rows', () => {
    useVaultStore.setState({
      entries: withFilters({ all: [{ field: 'channel', op: 'equals', value: 'different' }] }),
    });
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
    expect(screen.queryByTestId('view-problems')).toBeNull();
  });
});

describe('TypePage — Records tab', () => {
  it('shows the records of the type and the count', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByRole('heading', { name: 'Work item' })).toBeTruthy();
    expect(screen.getByText('Design first-run flow')).toBeTruthy();
    expect(screen.getByText('Wire field sync banner')).toBeTruthy();
    // Docs of other types stay out.
    expect(screen.queryByText('Guided onboarding')).toBeNull();
  });

  // M10: the type screen opens on the table. It used to default to the `split`
  // browser, which was retired — the open-in-place detail panel gives every
  // view the doc-beside-properties reading that split existed for.
  it('opens on the table, with the retired split browser gone', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByTestId('table-view')).toBeTruthy();
    expect(screen.queryByTestId('view-switch-split')).toBeNull();
    expect(screen.queryByTestId('view-switch-tree')).toBeNull();
  });

  // M12.3: the tab row owns layout — switching goes through the active tab's
  // menu, exactly like a List. The default (unsaved) view carries id 'all'.
  const switchLayout = (kind: string) => {
    fireEvent.click(screen.getByTestId('view-tab-all'));
    fireEvent.click(screen.getByText('Change layout…'));
    fireEvent.click(screen.getByTestId(`view-switch-${kind}`));
  };

  it('offers every declared view kind from the tab menu and switches between them', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByTestId('view-tabs')).toBeTruthy();
    fireEvent.click(screen.getByTestId('view-tab-all'));
    fireEvent.click(screen.getByText('Change layout…'));
    for (const { value } of VIEW_KINDS) {
      expect(screen.getByTestId(`view-switch-${value}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('view-switch-board'));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    // The change persisted to the Type doc — a type's views are saved views.
    expect(patches.some((p) => p.path === 'types/work-item.md' && 'views' in p.patch)).toBe(true);
  });

  it('shows the calendar keyed on the type’s date property', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    switchLayout('calendar');
    const calendar = screen.getByTestId('calendar-view');
    // Work item declares `due: { kind: date }` and nothing else dated, so the
    // view infers it rather than rendering blank until someone configures one.
    expect(calendar.getAttribute('data-date-field')).toBe('due');
  });

  /**
   * A day's "+" writes the date in the shape the field DECLARES (M53.16). It
   * wrote the bare day whatever the field was, so on a calendar keyed to a
   * `daterange` every record it made failed its own validation on the next
   * read: "window must be a start/end range".
   */
  describe('creates on a calendar day (M53.16)', () => {
    // Captured before the stub replaces it, and put back after: the file's
    // beforeEach never resets `createItem`.
    const realCreateItem = useVaultStore.getState().createItem;
    let created: { folder: string; slug: string; frontmatter: Record<string, unknown> }[];

    beforeEach(() => {
      created = [];
      useVaultStore.setState({
        createItem: vi.fn(
          async (args: { folder: string; slug: string; frontmatter: Record<string, unknown> }) => {
            created.push(args);
            return `${args.folder}/${args.slug}.md`;
          },
        ),
      });
    });

    // Unmount FIRST: the page subscribes to `createItem`, and restoring it
    // over a live tree re-renders outside act().
    afterEach(() => {
      cleanup();
      useVaultStore.setState({ createItem: realCreateItem });
    });

    /** Type a title into a day's "+" and submit it; resolves once it is created. */
    const createOn = async (day: string, title: string) => {
      fireEvent.click(screen.getByRole('button', { name: `New record on ${day}` }));
      const input = screen.getByRole('textbox', { name: `New record on ${day}` });
      fireEvent.change(input, { target: { value: title } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(created).toHaveLength(1));
    };

    it('writes an open range into a field declared daterange', async () => {
      // The type screen passes no `today`, so the grid opens on the real one —
      // computed here the way CalendarView computes it.
      const day = toIsoDate(new Date());
      useVaultStore.setState({
        entries: fixtureVault().map((e) =>
          e.path === 'types/work-item.md'
            ? {
                ...e,
                properties: {
                  ...e.properties,
                  fields: {
                    ...(e.properties.fields as unknown as Record<string, unknown>),
                    window: { kind: 'daterange' },
                  },
                } as unknown as typeof e.properties,
              }
            : e,
        ),
      });
      render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
      switchLayout('calendar');
      // A daterange outranks the plain `due` when the calendar infers its key.
      expect(screen.getByTestId('calendar-view').getAttribute('data-date-field')).toBe('window');
      await createOn(day, 'Retro');
      expect(created[0].folder).toBe('records/work-items');
      expect(created[0].frontmatter).toEqual({
        type: 'Work item',
        window: { start: day, end: null },
      });
    });

    it('writes selected hours into a date range through the type page creator', async () => {
      const day = toIsoDate(new Date());
      useVaultStore.setState({
        entries: fixtureVault().map((entry) =>
          entry.type !== 'Type' || entry.title !== 'Work item'
            ? entry
            : {
                ...entry,
                properties: {
                  ...entry.properties,
                  fields: { window: { kind: 'daterange' } },
                } as never,
              },
        ),
      });
      render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
      switchLayout('calendar');
      fireEvent.click(screen.getByTestId('calendar-span-day'));
      const column = screen.getByTestId('calendar-hours-day');
      const pointer = (type: string, y: number) =>
        new MouseEvent(type, { bubbles: true, button: 0, clientY: y });
      fireEvent(column, pointer('pointerdown', 672));
      fireEvent(window, pointer('pointermove', 696));
      fireEvent(window, pointer('pointerup', 696));
      const input = screen.getByRole('textbox', { name: 'New record title' });
      fireEvent.change(input, { target: { value: 'Review' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0].frontmatter).toEqual({
        type: 'Work item',
        window: { start: `${day} 14:00`, end: `${day} 15:00` },
      });
      await waitFor(() => expect(screen.queryByTestId('calendar-new-slot')).toBeNull());
    });

    it('writes the bare day into a field declared date', async () => {
      const day = toIsoDate(new Date());
      // The unpatched fixture declares only `due: { kind: date }`.
      render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
      switchLayout('calendar');
      expect(screen.getByTestId('calendar-view').getAttribute('data-date-field')).toBe('due');
      await createOn(day, 'Retro');
      expect(created[0].frontmatter).toEqual({ type: 'Work item', due: day });
    });
  });

  it('opens a record in the right-hand detail panel from the list layout', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    switchLayout('list');
    fireEvent.click(screen.getByText('Design first-run flow'));
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-1.md');
  });

  it('treats Work item like any other type — no system lock (M12.2)', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.queryByText('System type')).toBeNull();
    // M12.8: the icon and the name ARE the edit affordances — the corner
    // pencil/palette buttons are gone.
    expect(screen.getByTestId('type-icon-edit').getAttribute('title')).toBe('Change icon & color');
    expect(screen.getByTestId('type-title-edit').getAttribute('title')).toBe('Change display name');
    // Delete moved into the floating view-settings menu with the rest of the
    // configuration — no destructive affordance sits in the header.
    fireEvent.click(screen.getByTestId('view-control-settings'));
    expect(screen.getByRole('button', { name: 'Delete database' })).toBeTruthy();
  });

  it('offers rename and delete for custom types', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Person' }} />);
    expect(screen.getByTestId('type-title-edit').getAttribute('title')).toBe('Change display name');
    fireEvent.click(screen.getByTestId('view-control-settings'));
    expect(screen.getByRole('button', { name: 'Delete database' })).toBeTruthy();
  });

  /**
   * The count beside the type's name read `listing.count` — how many records
   * of this type are in the VAULT (M16.31). Narrowing the view with the search
   * box left it untouched, so the header went on reporting the vault while the
   * canvas reported the view. The List page had the milder version of the same
   * bug and both now read what is on screen.
   */
  it('counts the records on screen, not every record of the type', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByTestId('view-count').textContent).toBe('2');
    fireEvent.click(screen.getByLabelText('Search this view'));
    fireEvent.change(screen.getByTestId('view-search-input'), { target: { value: 'sync' } });
    expect(screen.getByTestId('view-count').textContent).toBe('1');
  });
});

describe('TypePage — property configuration (M12.8: floating, never an aside)', () => {
  // Properties live behind the tab row's sliders icon → Properties page, a
  // floating menu; per-property config drills into the same panel.
  const openProperties = (name: string) => {
    render(<TypePage selection={{ kind: 'type', name }} />);
    fireEvent.click(screen.getByTestId('view-control-settings'));
    fireEvent.click(screen.getByTestId('view-settings-properties'));
  };

  it('lists declared fields with nothing locked (M12.2)', () => {
    openProperties('Work item');
    const rows = screen.getAllByTestId(/^property-row-/);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Status'),
      expect.stringContaining('Priority'),
      expect.stringContaining('Assignee'),
      expect.stringContaining('Due'),
    ]);
    // No standard objects: every declared field is the user's to edit.
    expect(screen.queryByText('Built-in')).toBeNull();
    expect(screen.queryByText(/system type/)).toBeNull();
  });

  it('adds a custom property to the type doc via the add panel', async () => {
    openProperties('Work item');
    fireEvent.click(screen.getByTestId('new-property'));
    fireEvent.change(screen.getByLabelText('Property name'), {
      target: { value: 'Severity' },
    });
    fireEvent.click(screen.getByTestId('property-kind-select'));
    await waitFor(() => {
      expect(patches).toEqual([
        {
          path: 'types/work-item.md',
          patch: {
            fields: expect.objectContaining({
              severity: { kind: 'select' },
              status: { kind: 'status' },
            }),
          },
        },
      ]);
    });
    // The panel closes after a successful write.
    await waitFor(() => {
      expect(screen.queryByTestId('add-property-panel')).toBeNull();
    });
  });

  it('names the property after the kind when none is typed (kind-first flow)', async () => {
    openProperties('Work item');
    fireEvent.click(screen.getByTestId('new-property'));
    fireEvent.click(screen.getByTestId('property-kind-checkbox'));
    await waitFor(() => {
      expect(patches).toEqual([
        {
          path: 'types/work-item.md',
          patch: {
            fields: expect.objectContaining({ checkbox: { kind: 'checkbox' } }),
          },
        },
      ]);
    });
  });

  it('removes custom fields but never built-ins', () => {
    openProperties('Person');
    // Fixture Person declares no fields. The panel lists the column universe
    // (observed frontmatter keys included), so the durable contract here is
    // that creation is offered, not that the list is empty.
    expect(screen.getByTestId('new-property')).toBeTruthy();
    cleanup();
    // Give Person a custom field and check its remove affordance.
    useVaultStore.setState({
      entries: fixtureVault().map((e) =>
        e.path === 'types/person.md'
          ? {
              ...e,
              properties: {
                ...e.properties,
                fields: { pronouns: { kind: 'text' } },
              } as unknown as typeof e.properties,
            }
          : e,
      ),
    });
    openProperties('Person');
    fireEvent.click(screen.getByTestId('property-row-pronouns'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete property' }));
    // M16.29: the removal reaches every record of the type, so it asks first.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(patches).toEqual([{ path: 'types/person.md', patch: { fields: {} } }]);
  });

  it('edits select options inline', () => {
    // A custom type with a select field gets the option editor.
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'types/recipe.md',
          title: 'Recipe',
          type: 'Type',
          properties: {
            fields: {
              cuisine: { kind: 'select', options: [{ id: 'thai', color: '#DE3B4E' }] },
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
      ],
    });
    openProperties('Recipe');
    // M12.8: the value editor lives inside the property's flyout page.
    fireEvent.click(screen.getByTestId('property-row-cuisine'));
    expect(screen.getByText('Thai')).toBeTruthy();
    const input = screen.getByLabelText('Add option to Cuisine');
    fireEvent.change(input, { target: { value: 'Oaxacan' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe('types/recipe.md');
    const fields = patches[0].patch.fields as Record<string, { options: unknown[] }>;
    expect(fields.cuisine.options).toHaveLength(2);
  });

  it('renames an option without touching the id records store', () => {
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'types/recipe.md',
          title: 'Recipe',
          type: 'Type',
          properties: {
            fields: {
              cuisine: { kind: 'select', options: [{ id: 'thai', color: '#DE3B4E' }] },
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
      ],
    });
    openProperties('Recipe');
    fireEvent.click(screen.getByTestId('property-row-cuisine'));
    fireEvent.click(screen.getByRole('button', { name: 'Thai' }));
    const input = screen.getByLabelText('Rename Thai');
    fireEvent.change(input, { target: { value: 'Thai (street)' } });
    fireEvent.blur(input);
    const fields = patches[0].patch.fields as Record<
      string,
      { options: { id: string; label: string }[] }
    >;
    expect(fields.cuisine.options[0]).toMatchObject({ id: 'thai', label: 'Thai (street)' });
  });

  it('renames a property and migrates the records carrying it', async () => {
    openProperties('Person');
    // Person declares no fields in the fixture; add one, then rename it.
    useVaultStore.setState({
      entries: fixtureVault().map((e) =>
        e.path === 'types/person.md'
          ? {
              ...e,
              properties: {
                ...e.properties,
                fields: { pronouns: { kind: 'text' } },
              } as unknown as typeof e.properties,
            }
          : e,
      ),
    });
    cleanup();
    openProperties('Person');
    // The field name also appears as a column header — the panel's row has
    // its own testid, and the rename input lives only in the flyout editor.
    fireEvent.click(screen.getByTestId('property-row-pronouns'));
    const input = screen.getByLabelText('Rename Pronouns');
    fireEvent.change(input, { target: { value: 'Uses pronouns' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(patches[0]).toEqual({
        path: 'types/person.md',
        patch: { fields: { uses_pronouns: { kind: 'text' } } },
      });
    });
  });
});

/**
 * M60.2: a field rename rewrites every saved view in one batch, under the
 * open tab. The page re-seeds its local presentation from the stored view,
 * so the change shows at once and the next toolbar edit cannot write the old
 * name back; the search box is where you are looking, so it survives.
 */
describe('TypePage re-seeds when the stored view changes (M60.2)', () => {
  const vaultWith = (person: string) =>
    fixtureVault().map((e) => {
      if (e.path !== 'types/work-item.md') return e;
      const props = e.properties as unknown as { fields: Record<string, unknown> };
      const fields = Object.fromEntries(
        Object.entries(props.fields).map(([k, v]) => [k === 'assignee' ? person : k, v]),
      );
      const all = {
        id: 'all',
        name: 'All',
        icon: null,
        filters: null,
        presentation: {
          type: 'table',
          group: [],
          sort: [{ field: 'due', dir: 'asc' }],
          columns: [{ field: 'status' }, { field: person }],
        },
      };
      return {
        ...e,
        properties: { ...e.properties, fields, views: [all] } as unknown as Entry['properties'],
      };
    });

  it('shows a stored change at once, keeps search, and the next toolbar edit keeps the new name', () => {
    useVaultStore.setState({ entries: vaultWith('assignee') });
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByLabelText('Assignee column menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('view-control-search'));
    fireEvent.change(screen.getByTestId('view-search-input'), { target: { value: 'flow' } });

    act(() => useVaultStore.setState({ entries: vaultWith('assigned_to') }));
    expect(screen.getByLabelText('Assigned to column menu')).toBeTruthy();
    expect(screen.queryByLabelText('Assignee column menu')).toBeNull();
    expect((screen.getByTestId('view-search-input') as HTMLInputElement).value).toBe('flow');

    fireEvent.click(screen.getByLabelText('Status column menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort ascending' }));
    const write = patches.find((p) => p.path === 'types/work-item.md' && 'views' in p.patch);
    const views = write?.patch.views as { presentation: { columns: { field: string }[] } }[];
    expect(views[0].presentation.columns.map((c) => c.field)).toEqual(['status', 'assigned_to']);
  });
});

/**
 * The tenth kind's host on a Type screen (M29.48).
 *
 * A Type's saved views are real views (M12.3), so a whiteboard is one of the
 * tabs it can hold — and its canvas lands beside the Type DOC that owns those
 * views. A type with no doc of its own has no folder to be beside, so its
 * canvases go to a top-level whiteboards/.
 *
 * Measured on the mock disk rather than on a captured prop: the created path
 * IS the contract, and the host's `folder` has no other observable.
 */
describe('TypePage hosts a whiteboard tab (M29.48)', () => {
  const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  // Captured before the stub below replaces it — per-test state, not a
  // permanent amputation of the store for whatever runs after.
  const realRescan = useVaultStore.getState().rescan;

  /** Work item, declaring a whiteboard tab, with its doc wherever asked. */
  const typeDoc = (path: string): Entry =>
    makeEntry({
      path,
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: { status: { kind: 'status' } },
        statuses: [{ id: 'todo', group: 'active', color: '#7E8699' }],
        views: [{ id: 'sketch', name: 'Sketch', presentation: { type: 'whiteboard' } }],
      } as unknown as Entry['properties'],
    });

  function setupType(entries: Entry[], view?: string) {
    resetMockFs();
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries,
      views: [],
      status: 'ready',
      // Create-on-open rescans so the file tree sees the new canvas (M29.46).
      // A real rescan here would reload `entries` from the demo corpus and
      // delete the fixture type mid-test; the assertions read the disk it
      // wrote to instead.
      rescan: vi.fn(async () => {}),
    });
    render(
      <TypePage
        selection={{ kind: 'type', name: 'Work item', ...(view === undefined ? {} : { view }) }}
      />,
    );
  }

  // Unmount FIRST: putting the real action back is a store notification, and a
  // still-mounted WhiteboardView subscribes to `rescan` — restoring it over a
  // live tree re-renders outside act(). Vitest runs afterEach hooks
  // last-registered-first, so this one precedes the file-level `cleanup`.
  afterEach(() => {
    cleanup();
    useVaultStore.setState({ rescan: realRescan });
  });

  // Settled first, asserted second: create-on-open ends by persisting the
  // pointer and opening the editor on it, and waiting for that keeps every
  // state update inside act().
  const opened = () => screen.findByTestId('wb-board');

  it('creates the canvas beside the Type doc that owns the views', async () => {
    setupType([typeDoc('types/work-item.md')], 'sketch');
    await opened();
    expect(fs().get('types/whiteboards/sketch.canvas')).toContain('"nodes": []');
  });

  it('a Type doc at the vault root gets a top-level whiteboards/', async () => {
    setupType([typeDoc('work-item.md')], 'sketch');
    await opened();
    expect(fs().get('whiteboards/sketch.canvas')).toBeTruthy();
  });

  /**
   * A GHOST type — a name only records carry, with no `type: Type` doc
   * (typeCatalog.ts's `docPath: null`). It has no saved views either, so its
   * whiteboard is reached the only way it can be: switching the open tab's
   * layout. There is no folder that belongs to it, and inventing one (`types/`,
   * say) would put the canvas beside a doc that does not exist.
   */
  it('a type with no doc of its own falls back to the vault root', async () => {
    setupType([makeEntry({ path: 'items/a.md', title: 'Alpha', type: 'Work item' })]);
    fireEvent.click(screen.getByTestId('view-tab-all'));
    fireEvent.click(screen.getByText('Change layout…'));
    fireEvent.click(screen.getByTestId('view-switch-whiteboard'));
    await opened();
    // Named after the open tab, which for a type with no saved views is the
    // derived default one.
    expect(fs().get('whiteboards/table.canvas')).toBeTruthy();
  });
});

describe('TypePage visit state (M65.4)', () => {
  function Place() {
    const selection = useNavStore((state) => state.selection);
    return selection.kind === 'type' ? <TypePage selection={selection} /> : <div>Elsewhere</div>;
  }
  it('search and the filter bar come back with Back, but the record peek does not', () => {
    render(<Place />);
    fireEvent.click(screen.getByTestId('view-control-search'));
    fireEvent.change(screen.getByTestId('view-search-input'), { target: { value: 'flow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(screen.getByLabelText('Open Design first-run flow'));
    expect(useUiStore.getState().detailPath).not.toBeNull();
    act(() => useNavStore.getState().navigate({ kind: 'settings' }));
    act(() => useNavStore.getState().back());
    expect((screen.getByTestId('view-search-input') as HTMLInputElement).value).toBe('flow');
    expect(useNavStore.getState().readEntryState('view.controls')).toBe(true);
    expect(screen.getByTestId('filter-add')).toBeTruthy();
    expect(useUiStore.getState().detailPath).toBeNull();
  });
  it('a new tab starts with an empty search', () => {
    render(<Place />);
    fireEvent.click(screen.getByTestId('view-control-search'));
    fireEvent.change(screen.getByTestId('view-search-input'), { target: { value: 'flow' } });
    act(() =>
      useNavStore.getState().navigate({ kind: 'type', name: 'Work item', view: 'another' }),
    );
    expect(useNavStore.getState().readEntryState('view.search')).toBeUndefined();
    expect((screen.getByTestId('view-search-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Wire field sync banner')).toBeTruthy();
  });
});

it('offers a calendar import on a database with a declared date', () => {
  render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
  fireEvent.click(screen.getByTestId('view-control-settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Import calendar file…' }));
  expect((screen.getByLabelText('Calendar database') as HTMLSelectElement).value).toBe('Work item');
  expect((screen.getByTestId('ics-import-submit') as HTMLButtonElement).disabled).toBe(true);
});
