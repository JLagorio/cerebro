// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Arrival, useArrival, useDrawn } from '@/components/ui/motion';

afterEach(cleanup);

function Marked({ when }: { when: boolean }) {
  return (
    <div data-testid="marked" {...useArrival(when)}>
      <span data-testid="child">inside</span>
    </div>
  );
}

/** Wraps a block that mounts once its list is drawn, as a streamed reply's do. */
function Blocks({ count }: { count: number }) {
  const drawn = useDrawn();
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <Arrival key={i} when={drawn}>
          <p data-testid="block">{`Block ${i}`}</p>
        </Arrival>
      ))}
    </div>
  );
}

describe('an arrival', () => {
  it('is marked from its mount until its own entrance ends, and once only', () => {
    const { rerender } = render(<Marked when />);
    const marked = screen.getByTestId('marked');
    expect(marked.hasAttribute('data-arrive')).toBe(true);
    // A child's animation ending bubbles through it, and is not its own.
    fireEvent.animationEnd(screen.getByTestId('child'));
    expect(marked.hasAttribute('data-arrive')).toBe(true);
    fireEvent.animationEnd(marked);
    expect(marked.hasAttribute('data-arrive')).toBe(false);
    // Shown again — the panel unfolding — it has nothing left to play.
    rerender(<Marked when />);
    expect(screen.getByTestId('marked').hasAttribute('data-arrive')).toBe(false);
  });

  it('takes its word at mount: what was there first never arrives later', () => {
    const { rerender } = render(<Marked when={false} />);
    rerender(<Marked when />);
    expect(screen.getByTestId('marked').hasAttribute('data-arrive')).toBe(false);
  });

  it('marks what a drawn list adds, never what it was drawn with', () => {
    const { rerender } = render(<Blocks count={2} />);
    rerender(<Blocks count={3} />);
    const blocks = screen.getAllByTestId('block');
    expect(blocks.map((b) => b.hasAttribute('data-arrive'))).toEqual([false, false, true]);
    // The mark is on the block itself: no box was added around it.
    expect(blocks[2].parentElement).toBe(blocks[0].parentElement);
  });
});
