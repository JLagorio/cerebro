// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_CAP_MS } from '@/components/ui/motion';
import { Unfold, UnfoldDetails } from './Unfold';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A fold that keeps its body mounted, hidden while shut, as a read group's. */
function Fold({ open, other = 0 }: { open: boolean; other?: number }) {
  return (
    <Unfold open={open}>
      <div data-testid="body" data-other={other} hidden={!open}>
        <span data-testid="child">inside</span>
      </div>
    </Unfold>
  );
}

const marked = () => screen.getByTestId('body').hasAttribute('data-arrive');

// What a fold reveals drops in each time the person opens it, and at no
// other time: not drawn shut, not on a render that opens nothing, and not
// when the conversation is shown again with the fold still open.
describe('a fold unfolding', () => {
  it('reveals its body as it opens, once, and again on the next opening', () => {
    const { rerender } = render(<Fold open={false} />);
    expect(marked()).toBe(false);
    rerender(<Fold open />);
    expect(marked()).toBe(true);
    // A child's animation ending bubbles through it, and is not its own.
    fireEvent.animationEnd(screen.getByTestId('child'));
    expect(marked()).toBe(true);
    fireEvent.animationEnd(screen.getByTestId('body'));
    expect(marked()).toBe(false);
    rerender(<Fold open other={1} />);
    expect(marked()).toBe(false);
    rerender(<Fold open={false} other={1} />);
    expect(marked()).toBe(false);
    rerender(<Fold open other={1} />);
    expect(marked()).toBe(true);
  });

  it('reveals a body drawn open — a detail drawn on its first unfold', () => {
    render(<Fold open />);
    expect(marked()).toBe(true);
  });

  it('lets the mark go after the cap when nothing reports an end', () => {
    vi.useFakeTimers();
    render(<Fold open />);
    expect(marked()).toBe(true);
    act(() => vi.advanceTimersByTime(LEAVE_CAP_MS));
    expect(marked()).toBe(false);
  });

  it('reads a details element’s own opening from its toggle', () => {
    render(
      <UnfoldDetails data-testid="details" summary={<summary>Input</summary>}>
        <pre data-testid="detail">{'{}'}</pre>
      </UnfoldDetails>,
    );
    const details = screen.getByTestId('details') as HTMLDetailsElement;
    const detail = screen.getByTestId('detail');
    expect(detail.hasAttribute('data-arrive')).toBe(false);
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(detail.hasAttribute('data-arrive')).toBe(true);
    // The body is the one element given, unwrapped, under its summary.
    expect(detail.parentElement).toBe(details);
  });
});
