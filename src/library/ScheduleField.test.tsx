// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { chooseOption } from '@/test/chooseOption';
import { ScheduleField } from './ScheduleField';
const NOW = new Date(2026, 6, 28, 12);
afterEach(cleanup);
function setup(initial: string[] = []) {
  const changed = vi.fn();
  function Harness() {
    const [value, set] = useState(initial);
    return (
      <ScheduleField
        now={NOW}
        value={value}
        onChange={(next) => {
          changed(next);
          set(next);
        }}
      />
    );
  }
  render(<Harness />);
  return changed;
}
it.each([
  ['hourly', 'hourly'],
  ['daily', 'daily 09:00'],
  ['weekdays', 'weekdays 09:00'],
  ['weekly', 'weekly mon 09:00'],
  ['days', 'weekly mon,thu 09:00'],
  ['monthly', 'monthly 1 09:00'],
  ['once', 'once 2026-07-28 09:00'],
])('emits the canonical %s option', (value, wanted) => {
  const change = setup();
  chooseOption(screen.getByLabelText('Repeat'), { value });
  expect(change).toHaveBeenLastCalledWith([wanted]);
});
it('one selected day becomes weekly and a last-day monthly choice survives a time change', () => {
  const change = setup(['weekly mon,thu 09:00']);
  fireEvent.click(screen.getByLabelText('Thursday'));
  expect(change).toHaveBeenLastCalledWith(['weekly mon 09:00']);
  expect(screen.getByLabelText('Repeat').getAttribute('data-value')).toBe('weekly');
  chooseOption(screen.getByLabelText('Repeat'), 'Every month');
  chooseOption(screen.getByLabelText('Day of month'), 'Last day');
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '18:00' } });
  expect(change).toHaveBeenLastCalledWith(['monthly last 18:00']);
});
it('adds up to eight times and removes one without changing the other authored bytes', () => {
  const change = setup(['  Weekly Friday 9:00  ']);
  for (let i = 1; i < 8; i++) fireEvent.click(screen.getByText('Add a time'));
  expect(screen.queryByText('Add a time')).toBeNull();
  expect(screen.getAllByLabelText('Repeat')).toHaveLength(8);
  fireEvent.click(screen.getAllByText('Remove this time')[1]);
  expect(change.mock.lastCall?.[0][0]).toBe('  Weekly Friday 9:00  ');
  expect(screen.getByText('Add a time')).toBeTruthy();
});
it('shows invalid authored text and a passed once without changing either on open', () => {
  const change = setup(['every 30th', 'once 2026-07-27 09:00']);
  expect(screen.getByRole('alert').textContent).toContain('every 30th');
  expect(
    screen.getByText('That time has passed, so this never runs. Pick a later one.'),
  ).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
});
it('parses a phrase into one item and refuses one it cannot honor', () => {
  const change = setup(['daily 09:00', 'hourly']);
  const input = screen.getByLabelText('Type a schedule');
  fireEvent.change(input, { target: { value: 'mondays and thursdays at 5pm' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(change).toHaveBeenLastCalledWith(['weekly mon,thu 17:00']);
  fireEvent.change(input, { target: { value: 'every 30th at 9am' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('alert').textContent).toContain('days 1 to 28');
  expect(change).toHaveBeenCalledTimes(1);
});
it('names this computer clock, catch-up and activation boundaries', () => {
  setup();
  expect(screen.getByTestId('schedule-clock').textContent).toContain(
    "Times use this computer's clock (",
  );
  expect(screen.getByTestId('schedule-clock').textContent).toContain(
    'Resuming or changing the schedule waits for its next time.',
  );
});
