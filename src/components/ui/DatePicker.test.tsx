import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeDateValue } from '@/engine/dates';
import { DatePicker } from './DatePicker';

afterEach(cleanup);

describe('DatePicker reminder labels', () => {
  it.each([
    [null, '12', '9:00 AM'],
    ['16:00', '12', '4:00 PM'],
    ['16:00', '24', '16:00'],
  ] as const)(
    'uses the value time %s / %s throughout the picker',
    async (startTime, timeFormat, time) => {
      const value = {
        ...makeDateValue('2026-07-30'),
        startTime,
        timeFormat,
        remind: '1d' as const,
      };
      const onChange = vi.fn();
      render(
        <DatePicker value={value} today="2026-07-28" onChange={onChange} onClear={() => {}} />,
      );
      await userEvent.click(screen.getByRole('button', { name: `Remind 1 day before, ${time}` }));
      expect(screen.getByRole('menuitemradio', { name: `On day of event, ${time}` })).toBeTruthy();
      await userEvent.click(screen.getByRole('menuitemradio', { name: `1 week before, ${time}` }));
      expect(onChange).toHaveBeenCalledWith({ ...value, remind: '1w' });
      expect(
        screen.getByText(
          'Reminders show in Cerebro. Allow notifications in Settings to also see them in Notification Center. A reminder that passes while Cerebro is closed is said once when it opens.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/desktop notifications/)).toBeNull();
    },
  );
  it('keeps property-cell reminders hidden', () => {
    render(
      <DatePicker
        value={makeDateValue('2026-07-30')}
        showRemind={false}
        onChange={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Remind/ })).toBeNull();
    expect(screen.queryByText(/Reminders show/)).toBeNull();
  });
});
