import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CodeOverlay } from './CodeOverlay';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const source = () => screen.getByLabelText('Mermaid source') as HTMLTextAreaElement;

describe('CodeOverlay', () => {
  it('shows the code, the Auto-update switch on, and no Apply button', () => {
    render(<CodeOverlay code={'graph TD\n  A --> B'} onChangeCode={() => {}} onClose={() => {}} />);
    expect(source().value).toBe('graph TD\n  A --> B');
    expect((screen.getByRole('switch', { name: 'Auto-update' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('Auto-update streams edits out after the 250ms debounce', async () => {
    const onChangeCode = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />);
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> B' } });
    expect(onChangeCode).not.toHaveBeenCalled();
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> B'));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
  });

  it('Auto-update OFF buffers: a dirty dot appears, only Apply commits', async () => {
    const onChangeCode = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Auto-update'));
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> C' } });
    await sleep(350); // past the debounce window — nothing may have flowed out
    expect(onChangeCode).not.toHaveBeenCalled();
    expect(screen.getByTestId('code-overlay-dirty')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> C');
  });

  it('flipping Auto-update back ON commits the buffered draft', async () => {
    const onChangeCode = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Auto-update'));
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> D' } });
    await userEvent.click(screen.getByText('Auto-update'));
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> D'));
  });

  it('an external code change refreshes an idle draft', () => {
    const { rerender } = render(
      <CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={() => {}} />,
    );
    rerender(
      <CodeOverlay code={'graph TD\n  X[Renamed]'} onChangeCode={() => {}} onClose={() => {}} />,
    );
    expect(source().value).toBe('graph TD\n  X[Renamed]');
  });

  it('unmount flushes a pending Auto-Update draft — keystrokes never die with the panel', () => {
    const onChangeCode = vi.fn();
    const { unmount } = render(
      <CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />,
    );
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> E' } });
    unmount(); // inside the 250ms window
    expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> E');
  });

  it('keydown never escapes the panel (host shortcuts must not fire while typing)', () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={() => {}} />
      </div>,
    );
    fireEvent.keyDown(source(), { key: 'a' });
    fireEvent.keyDown(source(), { key: 'Backspace' });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('the close button calls onClose', async () => {
    const onClose = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Auto-update OFF discards a pending draft on unmount — closing must not commit', async () => {
    const onChangeCode = vi.fn();
    const { unmount } = render(
      <CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByText('Auto-update'));
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> G' } });
    unmount();
    expect(onChangeCode).not.toHaveBeenCalled();
  });

  it('a dirty draft wins over an external code change — unsent keystrokes survive', () => {
    const { rerender } = render(
      <CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(source(), { target: { value: 'graph TD\n  MINE[Typed]' } });
    rerender(
      <CodeOverlay
        code={'graph TD\n  THEIRS[External]'}
        onChangeCode={() => {}}
        onClose={() => {}}
      />,
    );
    expect(source().value).toBe('graph TD\n  MINE[Typed]');
  });

  // The contract Task D4 rests on. React runs PASSIVE cleanups parent-first,
  // so a host whose unmount-save is a useEffect cleanup gated on its own timer
  // (DiagramPage.tsx:152-157) reads its buffer BEFORE a child useEffect flush
  // could fill it — and saves nothing. The overlay's flush is therefore a
  // LAYOUT effect: layout cleanups run in the mutation phase, ahead of every
  // passive cleanup. This host mimics DiagramPage's exact shape.
  it("the flush beats a host's passive-cleanup save (parent-first ordering)", () => {
    const saved: string[] = [];
    function Host() {
      const latest = useRef('graph TD');
      const timer = useRef<number | null>(null);
      const handleChange = (next: string) => {
        latest.current = next;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          saved.push(latest.current);
        }, 500);
      };
      useEffect(() => {
        return () => {
          if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
            saved.push(latest.current);
          }
        };
      }, []);
      return <CodeOverlay code="graph TD" onChangeCode={handleChange} onClose={() => {}} />;
    }
    const { unmount } = render(<Host />);
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> F' } });
    unmount(); // inside the 250ms window — the host must still have the bytes
    expect(saved).toEqual(['graph TD\n  A --> F']);
  });
});
