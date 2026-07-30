// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelationPicker } from '@/detail/RelationPicker';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { Entry } from '@/engine/types';

const ENTRIES: Entry[] = [
  makeEntry({ path: 'types/objective.md', title: 'Objective', type: 'Type' }),
  makeEntry({ path: 'records/objectives/grow-eu.md', title: 'Grow EU revenue', type: 'Objective' }),
  makeEntry({ path: 'records/objectives/cut-churn.md', title: 'Cut churn', type: 'Objective' }),
  makeEntry({ path: 'records/objectives/hire.md', title: 'Hire two engineers', type: 'Objective' }),
  makeEntry({ path: 'records/risks/latency.md', title: 'Latency', type: 'Risk' }),
];

const schema = buildSchema(ENTRIES);

function setup(value: string[] = [], onChange = vi.fn()) {
  render(
    <RelationPicker
      fieldName="key_results"
      targetType="Objective"
      value={value}
      entries={ENTRIES}
      schema={schema}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  return onChange;
}

const rowTitles = (testId: string) =>
  screen.queryAllByTestId(testId).map((el) => el.textContent ?? '');

afterEach(cleanup);

describe('RelationPicker (M11)', () => {
  it('lists only records of the target type', () => {
    setup();
    const titles = rowTitles('relation-result-row').join(' ');
    expect(titles).toContain('Grow EU revenue');
    expect(titles).toContain('Cut churn');
    // A relation declares what it points at; offering a Risk here would let
    // you write a link the schema forbids.
    expect(titles).not.toContain('Latency');
  });

  it('shows what is already linked, separately from what could be', () => {
    setup(['grow-eu']);
    expect(rowTitles('relation-linked-row').join(' ')).toContain('Grow EU revenue');
    // Already linked, so it is not offered again in the search results.
    expect(rowTitles('relation-result-row').join(' ')).not.toContain('Grow EU revenue');
  });

  it('links a record by pressing its row', () => {
    const onChange = setup(['grow-eu']);
    fireEvent.click(screen.getByText('Cut churn'));
    expect(onChange).toHaveBeenCalledWith(['grow-eu', 'cut-churn']);
  });

  it('unlinks from the linked list', () => {
    const onChange = setup(['grow-eu', 'cut-churn']);
    fireEvent.click(screen.getByLabelText('Unlink Cut churn'));
    expect(onChange).toHaveBeenCalledWith(['grow-eu']);
  });

  it('reorders linked records, because the order is what renders', () => {
    const onChange = setup(['grow-eu', 'cut-churn']);
    fireEvent.click(screen.getByLabelText('Move Cut churn up'));
    expect(onChange).toHaveBeenCalledWith(['cut-churn', 'grow-eu']);
  });

  it('pins the ends of the order — nothing moves off the list', () => {
    setup(['grow-eu', 'cut-churn']);
    expect(screen.getByLabelText('Move Grow EU revenue up')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Move Cut churn down')).toHaveProperty('disabled', true);
  });

  it('filters by title as you type', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'churn' },
    });
    const titles = rowTitles('relation-result-row').join(' ');
    expect(titles).toContain('Cut churn');
    expect(titles).not.toContain('Grow EU revenue');
  });

  it('Enter links the first match without leaving the keyboard', () => {
    const onChange = setup();
    const input = screen.getByLabelText('Search records to link');
    fireEvent.change(input, { target: { value: 'hire' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['hire']);
  });

  it('offers to create a record that does not exist yet', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'Launch in Japan' },
    });
    expect(screen.getByTestId('relation-create')).toBeTruthy();
  });

  it('does not offer to create when the name already exists', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'Cut churn' },
    });
    expect(screen.queryByTestId('relation-create')).toBeNull();
  });

  it('shows a link whose target is gone rather than hiding it', () => {
    setup(['deleted-elsewhere']);
    const linked = rowTitles('relation-linked-row').join(' ');
    expect(linked).toContain('deleted-elsewhere');
    expect(linked).toContain('Not found in this vault');
  });

  it('says so when there is nothing left to link', () => {
    setup(['grow-eu', 'cut-churn', 'hire']);
    expect(screen.getByText(/already linked/)).toBeTruthy();
  });
});
