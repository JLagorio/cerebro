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
    return render(
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

  it('sets the strip label smaller AND heavier than a panel row label (§A8)', () => {
    // The portable half of the measurement: 13/500/18 here against 14/400/20
    // in the panel, because this label is a COLUMN HEADER rather than a row
    // label. Ours made them identical — 12/400/20 on both — which was the
    // real defect; the sizes themselves come from our own ramp.
    setup({ heading: ['status'] });
    const label = screen.getByText('Status');
    expect(label.className).toContain('text-sm');
    expect(label.className).toContain('font-medium');
    expect(label.className).toContain('leading-[18px]');
    expect(label.className).toContain('truncate');
  });

  it('gaps the strip icon at 2px and keeps the panel row slot (§A10)', () => {
    setup({ heading: ['status'] });
    const cell = screen.getByTestId('heading-strip').querySelector('[data-field]')!;
    const labelRow = cell.firstElementChild as HTMLElement;
    // 2px here, 6px in the panel — measured, and the one number of the row
    // anatomy that is deliberately different between the two surfaces.
    expect(labelRow.className).toContain('gap-0.5');
    expect(labelRow.className).not.toContain('gap-1.5');
    // The 18 x 24 slot is shared with the panel, so a strip cell and a row
    // start their text at the same offset even though the glyph is smaller.
    const slot = labelRow.firstElementChild as HTMLElement;
    expect(slot.className).toContain('h-6');
    expect(slot.className).toContain('w-[18px]');
    expect(slot.querySelector('svg')?.getAttribute('width')).toBe('14');
  });

  it('gives the strip value the measured 30px box (§A.2)', () => {
    setup({ heading: ['status'] });
    const value = screen.getByTestId('heading-strip').querySelector('[data-cell-primary]')!;
    expect(value.className).toContain('min-h-[30px]');
    expect(value.className).toContain('rounded-xs');
    expect(value.className).not.toContain('rounded-md');
    // The strip's value keeps its wash: no hover was measured on this surface
    // either way, and the value is the only thing in the column you can click
    // — so it is the strip's own version of one-region-lights, not a guess at
    // a number nobody read.
    expect(value.className).toContain('hover:bg-n-50');
  });

  it('renders nothing when the resolved heading is empty — no empty container', () => {
    // The root of the render, not the testid: an unmarked empty div would
    // still slip past a queryByTestId null.
    const { container } = setup({ heading: [] });
    expect(container.firstChild).toBeNull();
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
    const { container } = setup({
      heading: ['due'],
      fieldPatch: { due: { kind: 'date', visibility: 'hide_when_empty' } },
      onToggleDetails: vi.fn(),
    });
    // Nothing at all — the toggle folds away with the strip it would expand.
    expect(container.firstChild).toBeNull();
  });
});
