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

  it('opens a record in the right-hand detail panel on click', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    fireEvent.click(screen.getByText('Design first-run flow'));
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-1.md');
  });

  it('marks system types with a locked badge', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Work item' }} />);
    expect(screen.getByText('System type')).toBeTruthy();
    // Rename/delete are system-locked; customize stays available.
    expect(screen.getByRole('button', { name: 'Customize icon & color' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change display name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete type' })).toBeNull();
  });

  it('offers rename and delete for custom types', () => {
    render(<TypePage selection={{ kind: 'type', name: 'Person' }} />);
    expect(screen.getByRole('button', { name: 'Change display name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete type' })).toBeTruthy();
  });
});

describe('TypePage — Properties tab', () => {
  const openProperties = (name: string) => {
    render(<TypePage selection={{ kind: 'type', name }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
  };

  it('lists declared fields, locking built-ins on system types', () => {
    openProperties('Work item');
    const rows = screen.getAllByTestId('type-field-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Status'),
      expect.stringContaining('Priority'),
      expect.stringContaining('Assignee'),
      expect.stringContaining('Due'),
    ]);
    // All four demo fields are built-ins of the system type: locked.
    expect(screen.getAllByText('Built-in')).toHaveLength(4);
    expect(screen.getByText(/system type/)).toBeTruthy();
  });

  it('adds a custom property to the type doc via the add panel', async () => {
    openProperties('Work item');
    fireEvent.click(screen.getByText('+ Add property'));
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

  it('removes custom fields but never built-ins', () => {
    openProperties('Person');
    // fixture Person type declares no fields — add-only surface.
    expect(screen.getByText('No properties declared yet.')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pronouns' }));
    expect(patches).toEqual([{ path: 'types/person.md', patch: { fields: {} } }]);
  });

  it('edits select options inline', () => {
    openProperties('Work item');
    // priority is locked (system built-in): no option editing UI.
    expect(screen.queryByLabelText('Add option to Priority')).toBeNull();
    cleanup();
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
    expect(screen.getByText('Thai')).toBeTruthy();
    const input = screen.getByLabelText('Add option to Cuisine');
    fireEvent.change(input, { target: { value: 'Oaxacan' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe('types/recipe.md');
    const fields = patches[0].patch.fields as Record<string, { options: unknown[] }>;
    expect(fields.cuisine.options).toHaveLength(2);
  });
});
