import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { ChainBuilder, type ChainBuilderProps } from './ChainBuilder';

/**
 * The ordered-chain editor (M9.1): each level, and the row that adds one, is
 * the design system's select — never a native one (owner, 2026-10-18).
 */

afterEach(cleanup);

const FIELDS = [
  { value: 'status', label: 'Status' },
  { value: 'due', label: 'Due' },
];

function chain(over: Partial<ChainBuilderProps> = {}) {
  const props: ChainBuilderProps = {
    label: 'Sorting',
    icon: 'arrow-up-down',
    testId: 'sort-chain',
    summary: '',
    rows: [{ value: 'status', options: FIELDS, dir: 'asc' }],
    addOptions: [{ value: 'owner', label: 'Owner' }],
    addLabel: 'Add a sort key…',
    onChange: vi.fn(),
    onToggleDir: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
    ...over,
  };
  render(<ChainBuilder {...props} />);
  fireEvent.click(screen.getByTestId(props.testId));
  return props;
}

describe('ChainBuilder', () => {
  it('names each level, and a pick changes only that level', () => {
    const props = chain();
    const level = screen.getByRole('button', { name: 'Level 1' });
    expect(level.getAttribute('aria-haspopup')).toBe('listbox');
    expect(level.getAttribute('data-value')).toBe('status');
    chooseOption(level, 'Due');
    expect(props.onChange).toHaveBeenCalledWith(0, 'due');
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('the add row holds no value: it says what it is for, and a pick adds a level', () => {
    const props = chain();
    const add = screen.getByRole('button', { name: 'Add a sort key…' });
    expect(add.getAttribute('data-value')).toBe('');
    expect(add.textContent).toBe('Add a sort key…');
    // Its label is the placeholder, never a row of its own.
    expect(optionLabels(add)).toEqual(['Owner']);
    chooseOption(add, 'Owner');
    expect(props.onAdd).toHaveBeenCalledWith('owner');
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('a press inside an open list leaves the chain open around it', () => {
    chain();
    const dialog = screen.getByRole('dialog', { name: 'Sorting' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Level 1' }));
    const row = within(screen.getByRole('listbox')).getByRole('option', { name: 'Due' });
    // The list is portalled out of the dialog; the press is still not an
    // outside press for it.
    fireEvent.pointerDown(row);
    fireEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Sorting' })).toBe(dialog);
  });

  it('offers no add row at its cap', () => {
    chain({
      rows: [
        { value: 'status', options: FIELDS },
        { value: 'due', options: FIELDS },
      ],
      max: 2,
    });
    expect(screen.queryByRole('button', { name: 'Add a sort key…' })).toBeNull();
    expect(screen.getByText(/2 levels is the maximum/)).toBeTruthy();
  });
});
