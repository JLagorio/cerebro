import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReminderSettings, PERMISSION_WORDS } from './ReminderSettings';
import * as ipc from '@/lib/ipc';
vi.mock('@/lib/ipc', () => ({
  notificationPermission: vi.fn(),
  requestNotificationPermission: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
it.each(Object.entries(PERMISSION_WORDS))(
  'says %s honestly and offers Allow only when not asked',
  async (state, words) => {
    vi.mocked(ipc.notificationPermission).mockResolvedValue(state as ipc.NotificationPermission);
    render(<ReminderSettings />);
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.getByTestId('notification-permission').dataset.state).toBe(state);
    expect(screen.queryByTestId('reminders-allow') !== null).toBe(state === 'not-asked');
    expect(ipc.requestNotificationPermission).not.toHaveBeenCalled();
  },
);
it('asks once on the button and re-reads on focus', async () => {
  vi.mocked(ipc.notificationPermission)
    .mockResolvedValueOnce('not-asked')
    .mockResolvedValue('denied');
  vi.mocked(ipc.requestNotificationPermission).mockResolvedValue('quiet');
  render(<ReminderSettings />);
  fireEvent.click(await screen.findByTestId('reminders-allow'));
  await screen.findByText(PERMISSION_WORDS.quiet);
  expect(ipc.requestNotificationPermission).toHaveBeenCalledOnce();
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByText(PERMISSION_WORDS.denied);
  expect(ipc.notificationPermission).toHaveBeenCalledTimes(2);
});
it('holds a failed read as unavailable and recovers on focus', async () => {
  vi.mocked(ipc.notificationPermission)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue('allowed');
  render(<ReminderSettings />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'could not be read',
  );
  expect(screen.queryByTestId('notification-permission')).toBeNull();
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByText(PERMISSION_WORDS.allowed);
});
it('an ask failure stays unavailable, and a focus during the prompt cannot strand Allow', async () => {
  vi.mocked(ipc.notificationPermission).mockResolvedValue('not-asked');
  let reject!: (e: Error) => void;
  vi.mocked(ipc.requestNotificationPermission).mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  render(<ReminderSettings />);
  fireEvent.click(await screen.findByTestId('reminders-allow'));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(ipc.notificationPermission).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('failed')));
  await waitFor(() => expect(screen.getByTestId('section-unavailable')).toBeTruthy());
});
