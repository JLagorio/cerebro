// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CreationDraftRecovery } from './CreationDraftRecovery';
afterEach(cleanup);
it('offers explicit Resume and Discard and describes the session boundary', () => {
  const resume = vi.fn();
  const discard = vi.fn();
  render(<CreationDraftRecovery pending={false} onResume={resume} onDiscard={discard} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(resume).toHaveBeenCalledTimes(1);
  expect(discard).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText(/this session/i)[0]).toBeTruthy();
});
it('cannot discard a pending operation', () => {
  render(<CreationDraftRecovery pending onResume={vi.fn()} onDiscard={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/Creating/)).toBeTruthy();
});
