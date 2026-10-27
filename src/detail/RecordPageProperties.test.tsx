// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { fixtureVault } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { RecordPageProperties, recordPageSummary } from './RecordPageProperties';

afterEach(cleanup);

function fixture(layout?: unknown) {
  const entries = fixtureVault();
  const type = entries.find((entry) => entry.path === 'types/work-item.md')!;
  if (layout !== undefined) (type.properties as Record<string, unknown>).layout = layout;
  const entry = entries.find((row) => row.path.endsWith('fld-1.md'))!;
  const schema = buildSchema(entries);
  useVaultStore.setState({ entries, vaultPath: '/vault' });
  return { entries, type, entry, schema };
}

describe('record page summary', () => {
  it('uses filled capabilities in stable schema order without writing layout', () => {
    const { entry, schema, entries, type } = fixture();
    const before = JSON.stringify(type.properties);
    expect(recordPageSummary(entry, schema, entries).fields.map((field) => field.name)).toEqual([
      'status',
      'priority',
      'assignee',
    ]);
    expect(JSON.stringify(type.properties)).toBe(before);
  });

  it('honors an authored empty heading and the last Type definition', () => {
    const { entry, schema, entries, type } = fixture({ heading: [] });
    expect(recordPageSummary(entry, schema, entries)).toMatchObject({
      automatic: false,
      fields: [],
    });
    const earlier: Entry = { ...type, properties: { ...type.properties } };
    delete earlier.properties.layout;
    expect(recordPageSummary(entry, schema, [earlier, ...entries]).automatic).toBe(false);
  });

  it('never promotes hidden or unset fields and preserves recorded zero and false', () => {
    const { entry, entries, type } = fixture();
    (type.properties as Record<string, unknown>).fields = {
      hidden: { kind: 'status', visibility: 'hide' },
      unset: { kind: 'number' },
      capacity: { kind: 'number' },
      enabled: { kind: 'checkbox' },
    };
    entry.properties = { hidden: 'todo', capacity: 0, enabled: false };
    const schema = buildSchema(entries);
    expect(recordPageSummary(entry, schema, entries).fields.map((field) => field.name)).toEqual([
      'capacity',
      'enabled',
    ]);
  });

  it('keeps Properties reachable when every summary field is unset', () => {
    const { entry, schema } = fixture();
    entry.properties = {};
    entry.relationships = {};
    render(<RecordPageProperties entry={entry} schema={schema} />);
    expect(
      screen.getByTestId('record-summary').querySelectorAll('.cb-record-summary-field'),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Show all properties/ }));
    expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
  });

  it('opens the one manager from a summary with keyboard focus and exposes undeclared values', async () => {
    const { entry, schema } = fixture();
    const patch = vi.spyOn(useVaultStore.getState(), 'patchFrontmatter');
    render(<RecordPageProperties entry={entry} schema={schema} />);
    expect(screen.queryByTestId('page-properties')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Status property' }));
    const manager = screen.getByTestId('page-properties');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(manager).getByRole('button', { name: /Todo/ })),
    );
    expect(within(manager).getByText('Channel')).toBeTruthy();
    expect(within(manager).getByText('field-ops')).toBeTruthy();
    fireEvent.click(screen.getByTestId('record-properties-toggle'));
    expect(manager.hidden).toBe(true);
    fireEvent.click(screen.getByTestId('record-properties-toggle'));
    expect(screen.getByTestId('page-properties')).toBe(manager);
    expect(patch).not.toHaveBeenCalled();
    patch.mockRestore();
  });

  it('keeps the manager open while the add-property flyout owns a draft', () => {
    const { entry, schema } = fixture();
    render(<RecordPageProperties entry={entry} schema={schema} />);
    fireEvent.click(screen.getByTestId('record-properties-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    expect(screen.getByTestId('add-property-panel')).toBeTruthy();
    const toggle = screen.getByTestId('record-properties-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(screen.getByTestId('page-properties').hidden).toBe(false);
  });

  it('keeps the full manager visible for an intentionally empty heading', () => {
    const { entry, schema } = fixture({ heading: [] });
    render(<RecordPageProperties entry={entry} schema={schema} />);
    expect(screen.queryByTestId('record-summary')).toBeNull();
    expect(screen.getByTestId('page-properties').hidden).toBe(false);
  });
});
