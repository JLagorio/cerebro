// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Picker, type PickerOption } from './Picker';

afterEach(cleanup);

const OPTIONS: PickerOption[] = [
  { value: 'get_note', label: 'Read a note', hint: 'Open one page by path', group: 'Read' },
  { value: 'search', label: 'Search notes', hint: 'Find pages by words', group: 'Read' },
  { value: 'write', label: 'Write a note', hint: 'Create or replace a page', group: 'Write' },
  { value: 'append', label: 'Append', hint: 'Add lines to the end of a page', group: 'Write' },
  { value: 'bash', label: 'Shell', group: 'Host' },
];

function open() {
  render(
    <Picker
      options={OPTIONS}
      selected={[]}
      onChange={vi.fn()}
      addLabel="Choose tools"
      emptyLabel="No tools"
      ariaLabel="Tools"
    />,
  );
  fireEvent.click(screen.getByTestId('picker-add'));
}

const search = (q: string) =>
  fireEvent.change(screen.getByLabelText('Search tools'), { target: { value: q } });
const shown = () =>
  screen.queryAllByTestId('picker-option').map((o) => o.querySelector('.text-n-800')?.textContent);
const groups = () =>
  screen.queryAllByTestId('picker-group').map((g) => g.querySelector('span')?.textContent);

// M59.3 — option lists filter through nameMatches and keep their designed order.
describe('Picker filter', () => {
  it('matches a query that spans the label and the hint', () => {
    open();
    search('append add');
    expect(shown()).toEqual(['Append']);
  });

  it('matches two words that are apart', () => {
    open();
    search('read page');
    expect(shown()).toEqual(['Read a note']);
  });

  it('keeps the group order and the option order', () => {
    open();
    search('note');
    expect(groups()).toEqual(['Read', 'Write']);
    expect(shown()).toEqual(['Read a note', 'Search notes', 'Write a note']);
    search('');
    expect(groups()).toEqual(['Read', 'Write', 'Host']);
    expect(shown()).toHaveLength(OPTIONS.length);
  });

  it('matches nothing for punctuation alone', () => {
    open();
    search('--');
    expect(shown()).toEqual([]);
  });
});
