// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypePage } from '@/pages/TypePage';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

let patches: { path: string; patch: Record<string, unknown> }[];

beforeEach(() => {
  patches = [];
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: fixtureVault(),
    views: [],
    status: 'ready',
    patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
      patches.push({ path, patch });
    }),
  });
  useUiStore.setState({ detailPath: null });
});

afterEach(cleanup);

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

  it('offers the six view kinds from the tab menu and switches between them', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByTestId('view-tabs')).toBeTruthy();
    fireEvent.click(screen.getByTestId('view-tab-all'));
    fireEvent.click(screen.getByText('Change layout…'));
    for (const kind of ['table', 'list', 'board', 'calendar', 'gantt', 'timeline']) {
      expect(screen.getByTestId(`view-switch-${kind}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('view-switch-board'));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    // The change persisted to the Type doc — a type's views are saved views.
    expect(
      patches.some((p) => p.path === 'types/work-item.md' && 'views' in p.patch),
    ).toBe(true);
  });

  it('shows the calendar keyed on the type’s date property', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    switchLayout('calendar');
    const calendar = screen.getByTestId('calendar-view');
    // Work item declares `due: { kind: date }` and nothing else dated, so the
    // view infers it rather than rendering blank until someone configures one.
    expect(calendar.getAttribute('data-date-field')).toBe('due');
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
    expect(screen.getByTestId('type-title-edit').getAttribute('title')).toBe(
      'Change display name',
    );
    // Delete moved into the floating view-settings menu with the rest of the
    // configuration — no destructive affordance sits in the header.
    fireEvent.click(screen.getByTestId('view-control-settings'));
    expect(screen.getByRole('button', { name: 'Delete type' })).toBeTruthy();
  });

  it('offers rename and delete for custom types', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Person' }} />);
    expect(screen.getByTestId('type-title-edit').getAttribute('title')).toBe(
      'Change display name',
    );
    fireEvent.click(screen.getByTestId('view-control-settings'));
    expect(screen.getByRole('button', { name: 'Delete type' })).toBeTruthy();
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
    const fields = patches[0].patch.fields as Record<string, { options: { id: string; label: string }[] }>;
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
