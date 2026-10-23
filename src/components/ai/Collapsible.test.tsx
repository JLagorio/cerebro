// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './Collapsible';

/**
 * The disclosure under every AI trace row (M91.7). jsdom has no Web
 * Animations, so a region closes in the commit that closed it; the cases
 * that play an exit stand in for the animation its CSS would start, as
 * components/ui/motion.test.tsx does.
 */

/** Every element reports one animation, which ends when the case says. */
function playing() {
  let end: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    end = resolve;
  });
  const animation = {
    playState: 'running',
    finished,
    effect: { getComputedTiming: () => ({ iterations: 1 }) },
  } as unknown as Animation;
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: vi.fn(() => [animation]),
  });
  return {
    end: async () => {
      end();
      await act(async () => {
        await finished;
        await Promise.resolve();
      });
    },
  };
}

afterEach(() => {
  cleanup();
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

function Details({ keepMounted, defaultOpen }: { keepMounted?: boolean; defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger>Details</CollapsibleTrigger>
      <CollapsibleContent keepMounted={keepMounted} data-testid="region">
        Shipped to Lisbon
      </CollapsibleContent>
    </Collapsible>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Details' });

describe('Collapsible', () => {
  it('starts closed: the trigger names its region, which is not drawn', () => {
    render(<Details />);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBeTruthy();
    expect(trigger().getAttribute('type')).toBe('button');
    expect(screen.queryByTestId('region')).toBeNull();
  });

  it('opens and closes on its trigger, which controls the region by id', () => {
    render(<Details />);
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByTestId('region');
    expect(region.id).toBe(trigger().getAttribute('aria-controls'));
    expect(region.dataset.state).toBe('open');
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('region')).toBeNull();
  });

  it('drawn open from the start does not drop in; opened by the reader, it does', () => {
    render(<Details defaultOpen />);
    expect(screen.getByTestId('region').hasAttribute('data-reveal')).toBe(false);
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.getByTestId('region').hasAttribute('data-reveal')).toBe(true);
  });

  it('gives up the reveal mark once its own entrance ends, not a child’s', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent data-testid="region">
          <span data-testid="child">inside</span>
        </CollapsibleContent>
      </Collapsible>,
    );
    fireEvent.click(trigger());
    fireEvent.animationEnd(screen.getByTestId('child'));
    expect(screen.getByTestId('region').hasAttribute('data-reveal')).toBe(true);
    fireEvent.animationEnd(screen.getByTestId('region'));
    expect(screen.getByTestId('region').hasAttribute('data-reveal')).toBe(false);
  });

  it('controlled, it reports the reader and draws what it is told', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Collapsible open={false} onOpenChange={onOpenChange}>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent data-testid="region">Shipped</CollapsibleContent>
      </Collapsible>,
    );
    fireEvent.click(trigger());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId('region')).toBeNull();
    rerender(
      <Collapsible open onOpenChange={onOpenChange}>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent data-testid="region">Shipped</CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.getByTestId('region')).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('uncontrolled, it still tells a listener', () => {
    const onOpenChange = vi.fn();
    render(
      <Collapsible onOpenChange={onOpenChange}>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
      </Collapsible>,
    );
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keepMounted keeps the closed region in the document, hidden, state and all', () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          {`Counted ${count}`}
        </button>
      );
    }
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent keepMounted data-testid="region">
          <Counter />
        </CollapsibleContent>
      </Collapsible>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Counted 0' }));
    fireEvent.click(trigger());
    const region = screen.getByTestId('region');
    expect(region.hidden).toBe(true);
    expect(region.id).toBe(trigger().getAttribute('aria-controls'));
    fireEvent.click(trigger());
    expect(screen.getByTestId('region').hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Counted 1' })).toBeTruthy();
  });

  it('keepMounted drawn closed is hidden, and closed, from the first render', () => {
    render(<Details keepMounted />);
    expect(screen.getByTestId('region').hidden).toBe(true);
    expect(screen.getByTestId('region').dataset.state).toBe('closed');
  });

  it('stays, closing, until its exit has played', async () => {
    render(<Details defaultOpen />);
    const motion = playing();
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('region').dataset.state).toBe('closed');
    await motion.end();
    expect(screen.queryByTestId('region')).toBeNull();
  });

  it('keepMounted hides only once its exit has played', async () => {
    render(<Details defaultOpen keepMounted />);
    const motion = playing();
    fireEvent.click(trigger());
    const region = screen.getByTestId('region');
    expect(region.dataset.state).toBe('closed');
    expect(region.hidden).toBe(false);
    await motion.end();
    expect(screen.getByTestId('region').hidden).toBe(true);
    expect(screen.getByTestId('region').dataset.state).toBe('closed');
  });

  it('a disabled collapsible ignores the reader', () => {
    render(
      <Collapsible disabled>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent data-testid="region">Shipped</CollapsibleContent>
      </Collapsible>,
    );
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trigger());
    expect(screen.queryByTestId('region')).toBeNull();
  });

  it('a click the trigger’s own onClick prevents changes nothing', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger onClick={(event) => event.preventDefault()}>Details</CollapsibleTrigger>
      </Collapsible>,
    );
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves Escape alone: a collapsible is not a layer', () => {
    render(<Details defaultOpen />);
    fireEvent.keyDown(trigger(), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('takes a wrapper’s optional props as they are: absent `open` keeps its own', () => {
    function Row(props: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
      return (
        <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
          <CollapsibleTrigger>Details</CollapsibleTrigger>
          <CollapsibleContent data-testid="region">Shipped</CollapsibleContent>
        </Collapsible>
      );
    }
    const { rerender } = render(<Row />);
    fireEvent.click(trigger());
    expect(screen.getByTestId('region')).toBeTruthy();
    rerender(<Row open={false} />);
    expect(screen.queryByTestId('region')).toBeNull();
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('refuses its parts outside a Collapsible', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<CollapsibleTrigger>Details</CollapsibleTrigger>)).toThrow(
        'CollapsibleTrigger must sit inside a Collapsible',
      );
    } finally {
      quiet.mockRestore();
    }
  });
});
