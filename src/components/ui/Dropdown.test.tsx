// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropdown } from './Dropdown';

const options = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Group: status' },
  { value: 'priority', label: 'Group: priority' },
];

function setup(onChange = vi.fn()) {
  render(
    <Dropdown options={options} value="status" onChange={onChange} label="Group by" size="sm" />,
  );
  return onChange;
}

afterEach(cleanup);

describe('Dropdown', () => {
  it('renders the selected label on the trigger, closed by default', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Group by' });
    expect(trigger.textContent).toContain('Group: status');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click and picks an option, reporting the value', () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'No grouping' }));
    expect(onChange).toHaveBeenCalledWith('none');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marks the current value with aria-selected', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
    expect(
      screen.getByRole('option', { name: /Group: status/ }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('option', { name: 'No grouping' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('supports full keyboard flow: ArrowDown opens, arrows move, Enter picks', () => {
    const onChange = setup();
    const trigger = screen.getByRole('button', { name: 'Group by' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    // Active starts on the selected option (index 1); ArrowDown → priority.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('priority');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes without reporting a change', () => {
    const onChange = setup();
    const trigger = screen.getByRole('button', { name: 'Group by' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('re-picking the current value closes without reporting a change', () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
    fireEvent.click(screen.getByRole('option', { name: /Group: status/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /**
   * The highlight was paint only (M16.35). DOM focus never leaves the trigger,
   * so without `aria-activedescendant` the listbox reads to assistive tech as
   * though nothing in it were current and Enter appears to pick at random.
   */
  it('names the highlighted row with aria-activedescendant', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Group by' });
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    const status = screen.getByRole('option', { name: /Group: status/ });
    const priority = screen.getByRole('option', { name: /Group: priority/ });
    // Opening homes the highlight on the current value.
    expect(list.getAttribute('aria-activedescendant')).toBe(status.id);
    expect(status.id).not.toBe('');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(priority.id);

    // The pointer drives the same cursor, so the announcement follows it too.
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'No grouping' }));
    expect(list.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'No grouping' }).id,
    );
  });

  it('closes on backdrop click', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
