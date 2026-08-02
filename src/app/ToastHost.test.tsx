import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastHost } from '@/app/ToastHost';
import { useUiStore } from '@/stores/uiStore';

afterEach(cleanup);

describe('ToastHost', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  it('renders nothing while the toast queue is empty', () => {
    const { container } = render(<ToastHost />);
    expect(container.firstChild).toBeNull();
  });

  it('auto-dismisses a toast 3 seconds after it appears', () => {
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      act(() => useUiStore.getState().toast('Saved'));
      expect(screen.getByText('Saved')).toBeTruthy();
      act(() => vi.advanceTimersByTime(2999));
      expect(screen.getByText('Saved')).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText('Saved')).toBeNull();
      expect(useUiStore.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses a toast immediately from its dismiss button', async () => {
    const user = userEvent.setup();
    render(<ToastHost />);
    act(() => useUiStore.getState().toast('Saved'));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useUiStore.getState().toasts).toHaveLength(0);
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
