// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { parseDateProperty } from '@/engine/dates';
import { parseRepeat, type CalendarItem } from '@/engine/recurrence';
import { useNavStore } from '@/stores/navStore';
import * as actions from '@/app/recurrenceActions';
import { OccurrenceMenu } from './OccurrenceMenu';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup() {
  const entry = makeEntry({ path: 'series.md', title: 'Daily standup' });
  const parsed = parseRepeat('FREQ=WEEKLY;BYDAY=TU,TH');
  if (parsed?.kind !== 'rule') throw new Error('fixture');
  const item: CalendarItem = {
    key: 'series@date',
    entry,
    series: entry,
    value: parseDateProperty({ start: '2026-08-04 09:00', end: '2026-08-04 09:15' }),
    repeat: 'occurrence',
    rule: parsed.rule,
  };
  const onClose = vi.fn();
  const anchor = document.createElement('button');
  document.body.append(anchor);
  render(<OccurrenceMenu item={item} anchor={anchor} onClose={onClose} />);
  return { item, onClose };
}
it('shows the occurrence and rule, and opens All events as its page', () => {
  const { onClose } = setup();
  const navigate = vi.spyOn(useNavStore.getState(), 'navigate');
  expect(screen.getByTestId('occurrence-menu').textContent).toContain(
    'Tuesday, August 4 · 9:00 AM – 9:15 AM',
  );
  expect(screen.getByText('Weekly on Tuesday and Thursday')).toBeTruthy();
  fireEvent.click(screen.getByTestId('occurrence-all'));
  expect(navigate).toHaveBeenCalledWith({ kind: 'doc', path: 'series.md' });
  expect(onClose).toHaveBeenCalled();
});
it('This event calls the action once and stays open after refusal', async () => {
  const detach = vi.spyOn(actions, 'detachOccurrence').mockResolvedValue(null);
  const { item, onClose } = setup();
  fireEvent.click(screen.getByTestId('occurrence-this'));
  fireEvent.click(screen.getByTestId('occurrence-this'));
  await waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
  expect(detach).toHaveBeenCalledWith('series.md', item.value);
  expect(onClose).not.toHaveBeenCalled();
});
it('Escape and an outside click close the popover', () => {
  const first = setup();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(first.onClose).toHaveBeenCalled();
  cleanup();
  const next = setup();
  fireEvent.pointerDown(document.body);
  expect(next.onClose).toHaveBeenCalled();
});
