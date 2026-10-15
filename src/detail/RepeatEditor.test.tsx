// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parseDateProperty } from '@/engine/dates';
import { RepeatEditor } from './RepeatEditor';

afterEach(cleanup);
const anchor = parseDateProperty({ start: '2026-07-28 09:00', end: '2026-07-28 09:15' })!;
function setup(value: unknown = null, date = anchor) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <RepeatEditor
      value={value}
      anchor={date}
      dateField="When"
      onChange={onChange}
      onClose={onClose}
    />,
  );
  return { onChange, onClose };
}
const choose = (value: string) =>
  fireEvent.change(screen.getByTestId('repeat-pattern'), { target: { value } });
const done = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }));

it('offers Tuesday presets and writes only on Done', () => {
  const { onChange, onClose } = setup();
  choose('FREQ=WEEKLY;BYDAY=TU');
  expect(screen.getByTestId('repeat-preview').textContent).toBe('Weekly on Tuesday');
  expect(onChange).not.toHaveBeenCalled();
  done();
  expect(onChange).toHaveBeenCalledWith('FREQ=WEEKLY;BYDAY=TU');
  expect(onClose).toHaveBeenCalled();
});
it('keeps exceptions when replacing a pattern and clears with Does not repeat', () => {
  const { onChange } = setup('FREQ=DAILY\nEXDATE:20260804T090000');
  choose('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  done();
  expect(onChange).toHaveBeenCalledWith('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\nEXDATE:20260804T090000');
  cleanup();
  const cleared = setup('FREQ=DAILY');
  choose('none');
  done();
  expect(cleared.onChange).toHaveBeenCalledWith(null);
});
it('builds every two weeks on Monday and Thursday, ending after ten', () => {
  const { onChange } = setup();
  choose('custom');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Repeat interval' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Ends' }), { target: { value: 'count' } });
  done();
  expect(onChange).toHaveBeenCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10');
});
it('builds the last Friday of each month, ending on an inclusive date', () => {
  const { onChange } = setup();
  choose('custom');
  fireEvent.change(screen.getByRole('combobox', { name: 'Repeat unit' }), {
    target: { value: 'MONTHLY' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Monthly pattern' }), {
    target: { value: 'weekday' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Week number' }), {
    target: { value: '-1' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Day of week' }), {
    target: { value: 'FR' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Ends' }), { target: { value: 'until' } });
  fireEvent.change(screen.getByLabelText('Last repeat date'), { target: { value: '2026-12-31' } });
  done();
  expect(onChange).toHaveBeenCalledWith('FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231');
});
it('shows invalid values without writing and preserves unknown raw text until replacement', () => {
  const raw = 'FREQ=MONTHLY;BYSETPOS=2';
  const { onChange } = setup(raw);
  expect(screen.getByTestId('repeat-raw').textContent).toBe(raw);
  expect(screen.getByRole('button', { name: 'Done' })).toHaveProperty('disabled', true);
  choose('custom');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Repeat interval' }), {
    target: { value: '0' },
  });
  expect(screen.getByRole('alert').textContent).toContain('INTERVAL');
  done();
  expect(onChange).not.toHaveBeenCalled();
});
it('without an anchor only Clear changes the value', () => {
  const onChange = vi.fn();
  render(
    <RepeatEditor
      value="FREQ=DAILY"
      anchor={null}
      dateField="When"
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByTestId('repeat-pattern')).toBeNull();
  expect(screen.getByText('Repeats start from When: give it a date first.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onChange).toHaveBeenCalledWith(null);
});
it('opening an understood complex custom rule and Done preserves every admitted part', () => {
  const raw =
    'FREQ=YEARLY;BYDAY=1MO,-1FR;BYMONTH=3,9;UNTIL=20271231T090000Z;WKST=SU\nEXDATE:20260904T090000';
  const { onChange } = setup(raw);
  done();
  expect(onChange).toHaveBeenCalledWith(raw);
});

it('keeps valid hand-written exceptions when replacing a rule outside the subset', () => {
  const { onChange } = setup('FREQ=MONTHLY;BYSETPOS=2\nEXDATE:20260804T090000');
  choose('FREQ=DAILY');
  done();
  expect(onChange).toHaveBeenCalledWith('FREQ=DAILY\nEXDATE:20260804T090000');
});
