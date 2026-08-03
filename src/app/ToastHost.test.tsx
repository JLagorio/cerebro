import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastHost } from '@/app/ToastHost';
import { useUiStore } from '@/stores/uiStore';

afterEach(cleanup);

describe('ToastHost', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  // The live region has to pre-exist the toast: a container that appears
  // already carrying its text is routinely never announced.
  it('renders an empty, click-through live region while the queue is empty', () => {
    render(<ToastHost />);
    const host = screen.getByTestId('toast-host');
    expect(host.getAttribute('role')).toBe('status');
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(host.getAttribute('aria-atomic')).toBe('false');
    expect(host.style.pointerEvents).toBe('none');
    expect(host.childElementCount).toBe(0);
  });

  it('takes pointer events once a toast is in it', () => {
    render(<ToastHost />);
    act(() => useUiStore.getState().toast('Saved'));
    expect(screen.getByTestId('toast-host').style.pointerEvents).toBe('');
  });

  it('does not put a second live region on the toast itself', () => {
    render(<ToastHost />);
    act(() => useUiStore.getState().toast('Saved'));
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('auto-dismisses a toast 6 seconds after it appears', () => {
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      act(() => useUiStore.getState().toast('Saved'));
      expect(screen.getByText('Saved')).toBeTruthy();
      act(() => vi.advanceTimersByTime(5999));
      expect(screen.getByText('Saved')).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText('Saved')).toBeNull();
      expect(useUiStore.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes the countdown while the pointer is inside the stack', () => {
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      act(() => useUiStore.getState().toast('Could not rename item'));
      act(() => {
        fireEvent.mouseEnter(screen.getByTestId('toast-host'));
      });
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText('Could not rename item')).toBeTruthy();
      act(() => {
        fireEvent.mouseLeave(screen.getByTestId('toast-host'));
      });
      act(() => vi.advanceTimersByTime(6000));
      expect(screen.queryByText('Could not rename item')).toBeNull();
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
