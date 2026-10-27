// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as ipc from '@/lib/ipc';
import { mockRecovery } from '@/lib/mockRecovery';
import { RecoverySettings } from './RecoverySettings';
beforeEach(() => {
  mockRecovery.reset();
  vi.restoreAllMocks();
});
it('is opt-in and disabling retains previous copies until explicit clear confirmation', async () => {
  render(<RecoverySettings vault="v" />);
  const toggle = await screen.findByRole('checkbox', {
    name: 'Keep recovery copies for this vault',
  });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
  expect((toggle as HTMLInputElement).checked).toBe(true);
  mockRecovery.capture('v', 'a.md', 'before', 'after');
  fireEvent.click(toggle);
  await waitFor(() => expect(mockRecovery.status('v').enabled).toBe(false));
  expect(mockRecovery.status('v').entries).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Clear recovery copies' }));
  expect(mockRecovery.status('v').entries).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Delete copies for this vault' }));
  await waitFor(() => expect(mockRecovery.status('v').entries).toBe(0));
});
it('an unavailable status never displays off or zero usage', async () => {
  vi.spyOn(ipc, 'recoveryStatus').mockRejectedValue(new Error('offline'));
  render(<RecoverySettings vault="v" />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'could not be read',
  );
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('a slow old-vault toggle cannot replace the new vault status', async () => {
  let finish!: (value: Awaited<ReturnType<typeof ipc.setRecoveryEnabled>>) => void;
  const set = vi.spyOn(ipc, 'setRecoveryEnabled').mockReturnValue(
    new Promise((done) => {
      finish = done;
    }),
  );
  const view = render(<RecoverySettings vault="old" />);
  fireEvent.click(await screen.findByRole('checkbox'));
  view.rerender(<RecoverySettings vault="new" />);
  await waitFor(() =>
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false),
  );
  await act(async () => finish({ ...mockRecovery.status('old'), enabled: true }));
  expect(set).toHaveBeenCalledWith('old', true);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
it('failed settings reads can be retried without remounting', async () => {
  vi.spyOn(ipc, 'recoveryStatus').mockRejectedValueOnce(new Error('offline'));
  render(<RecoverySettings vault="v" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery settings' }));
  expect(await screen.findByRole('checkbox')).toBeTruthy();
});
