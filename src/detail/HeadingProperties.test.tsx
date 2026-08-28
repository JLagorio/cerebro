// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadingProperties } from './HeadingProperties';
import { buildSchema } from '@/engine/schema';
import type { Entry, FieldDef, Schema } from '@/engine/types';
import { fixtureVault } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';

describe('HeadingProperties (M45.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  // The strip takes the RESOLVED heading fields as a prop — the hosts run
  // `resolveLayout` (Task 7). The fixture builds the schema the same way
  // RecordProperties.test.tsx does, then picks defs off the built type so the
  // defs carry whatever `visibility` the test wrote onto the Type doc. `due`
  // is left unset on fld-1, so `hide_when_empty` on it folds without also
  // having to blank a field that IS set.
  const setup = (options: {
    heading: string[];
    fieldPatch?: Record<string, unknown>;
    display?: Record<string, unknown>;
    detailsShown?: boolean;
    onToggleDetails?: () => void;
  }) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    const fields = typeProps.fields as Record<string, unknown>;
    for (const [name, spec] of Object.entries(options.fieldPatch ?? {})) {
      fields[name] = spec;
    }
    if (options.display !== undefined) typeProps.display = options.display;
    useVaultStore.setState({ entries, vaultPath: '/vault' });
    const schema: Schema = buildSchema(entries);
    const entry: Entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    const roster = schema.types.get('Work item')!.fields;
    const resolved: FieldDef[] = options.heading.map((name) =>
      roster.find((f) => f.name === name)!,
    );
    render(
      <HeadingProperties
        entry={entry}
        schema={schema}
        fields={resolved}
        detailsShown={options.detailsShown}
        onToggleDetails={options.onToggleDetails}
      />,
    );
  };

  it('renders one labeled editor cell per resolved heading field', () => {
    setup({ heading: ['status', 'priority'] });
    const strip = screen.getByTestId('heading-strip');
    expect(strip).toBeTruthy();
    const cells = strip.querySelectorAll('[data-field]');
    expect([...cells].map((c) => c.getAttribute('data-field'))).toEqual(['status', 'priority']);
    // DS-quiet labels, like the property rows.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Priority')).toBeTruthy();
  });

  it('renders nothing when the resolved heading is empty — no empty container', () => {
    setup({ heading: [] });
    expect(screen.queryByTestId('heading-strip')).toBeNull();
  });

  it('the toggle reads View details / Hide details and calls onToggleDetails', () => {
    const onToggleDetails = vi.fn();
    setup({ heading: ['status'], detailsShown: false, onToggleDetails });
    const toggle = screen.getByTestId('view-details-toggle');
    expect(toggle.textContent).toBe('View details');
    fireEvent.click(toggle);
    expect(onToggleDetails).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ heading: ['status'], detailsShown: true, onToggleDetails });
    expect(screen.getByTestId('view-details-toggle').textContent).toBe('Hide details');
  });

  it('renders no toggle when onToggleDetails is absent — the properties-tab case', () => {
    setup({ heading: ['status'] });
    expect(screen.getByTestId('heading-strip')).toBeTruthy();
    expect(screen.queryByTestId('view-details-toggle')).toBeNull();
  });

  it('a hide field folds out of the strip', () => {
    setup({
      heading: ['status', 'priority'],
      fieldPatch: { priority: { kind: 'select', visibility: 'hide' } },
    });
    const strip = screen.getByTestId('heading-strip');
    expect(
      [...strip.querySelectorAll('[data-field]')].map((c) => c.getAttribute('data-field')),
    ).toEqual(['status']);
  });

  it('hide_when_empty folds an empty field when showEmpty is off', () => {
    setup({
      heading: ['status', 'due'],
      fieldPatch: { due: { kind: 'date', visibility: 'hide_when_empty' } },
    });
    const strip = screen.getByTestId('heading-strip');
    expect(
      [...strip.querySelectorAll('[data-field]')].map((c) => c.getAttribute('data-field')),
    ).toEqual(['status']);
  });

  it('show_empty unfolds the empty hide_when_empty field', () => {
    setup({
      heading: ['status', 'due'],
      fieldPatch: { due: { kind: 'date', visibility: 'hide_when_empty' } },
      display: { show_empty: true },
    });
    const strip = screen.getByTestId('heading-strip');
    expect(
      [...strip.querySelectorAll('[data-field]')].map((c) => c.getAttribute('data-field')),
    ).toEqual(['status', 'due']);
  });

  it('renders null when folding leaves zero cells — even with a toggle handler', () => {
    setup({
      heading: ['due'],
      fieldPatch: { due: { kind: 'date', visibility: 'hide_when_empty' } },
      onToggleDetails: vi.fn(),
    });
    expect(screen.queryByTestId('heading-strip')).toBeNull();
    expect(screen.queryByTestId('view-details-toggle')).toBeNull();
  });
});
