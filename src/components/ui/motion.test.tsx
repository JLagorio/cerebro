// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaveGhost, motionAllowed, Presence, useGhostOnUnmount } from './motion';

/**
 * How surfaces leave (components/ui/motion.ts). jsdom has no Web Animations,
 * which is the window every other test runs in: there, nothing waits. The
 * cases that play an exit hand the element a stand-in for the animation its
 * CSS would start, whose end the case decides.
 */

/** Stands in for the Web Animations a stylesheet would start: every element
 *  reports one animation, which ends when the returned `end` is called. */
function playing() {
  let end: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    end = resolve;
  });
  const animation = {
    playState: 'running',
    finished,
    // What a copy finishes of the arrivals it was cloned in the middle of;
    // the stand-in's own end stays the case's to decide.
    finish: () => undefined,
    effect: { getComputedTiming: () => ({ iterations: 1 }) },
  } as unknown as Animation;
  const spy = vi.fn(() => [animation]);
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: spy,
  });
  return {
    end: async () => {
      end();
      // The promise settles, then its callback renders.
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
  vi.useRealTimers();
});

function Panel({ initial = true, label = 'first' }: { initial?: boolean; label?: string }) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
      <Presence<HTMLDivElement>
        open={open}
        render={({ closing, ref }) => (
          <div ref={ref} data-testid="panel" data-state={closing ? 'closed' : 'open'}>
            {label}
          </div>
        )}
      />
    </>
  );
}

describe('motionAllowed', () => {
  it('is false where nothing animates, and in a window asked for less motion', () => {
    expect(motionAllowed()).toBe(false);
    playing();
    expect(motionAllowed()).toBe(true);
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList) as never;
    try {
      expect(motionAllowed()).toBe(false);
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});

describe('Presence', () => {
  it('goes in the commit that closed it where nothing animates', () => {
    render(<Panel />);
    act(() => screen.getByRole('button').click());
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('stays, closing, until its exit has played', async () => {
    render(<Panel />);
    const motion = playing();
    act(() => screen.getByRole('button').click());
    const panel = screen.getByTestId('panel');
    expect(panel.dataset.state).toBe('closed');
    await motion.end();
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('opened again on its way out, simply stays open', async () => {
    render(<Panel />);
    const motion = playing();
    act(() => screen.getByRole('button').click());
    act(() => screen.getByRole('button').click());
    await motion.end();
    expect(screen.getByTestId('panel').dataset.state).toBe('open');
  });

  it('leaves as it was last drawn open', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      const [label, setLabel] = useState('as it was');
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setLabel('as it is now');
            }}
          >
            close
          </button>
          <Presence<HTMLDivElement>
            open={open}
            render={({ ref }) => (
              <div ref={ref} data-testid="panel">
                {label}
              </div>
            )}
          />
        </>
      );
    }
    render(<Host />);
    const motion = playing();
    act(() => screen.getByRole('button').click());
    expect(screen.getByTestId('panel').textContent).toBe('as it was');
    await motion.end();
  });
});

describe('leaveGhost', () => {
  function surface() {
    const el = document.createElement('div');
    el.id = 'menu-1';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Actions');
    el.dataset.testid = 'menu';
    el.className = 'cb-menu-in surface';
    el.innerHTML =
      '<button id="item" role="menuitem" data-testid="item" tabindex="0" title="Do">Do</button><input value="typed">';
    document.body.append(el);
    (el.querySelector('input') as HTMLInputElement).value = 'typed by hand';
    return el;
  }

  it('leaves nothing where nothing animates', () => {
    const el = surface();
    leaveGhost(el, 'leaving');
    expect(document.querySelector('[data-ghost]')).toBeNull();
    el.remove();
  });

  it('leaves an inert copy that names nothing, plays its exit and goes', async () => {
    const el = surface();
    const motion = playing();
    leaveGhost(el, 'leaving', { strip: ['cb-menu-in'] });
    el.remove();
    await Promise.resolve();
    const ghost = document.querySelector<HTMLElement>('[data-ghost]')!;
    expect(ghost).not.toBeNull();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('inert')).toBe(true);
    expect(ghost.classList.contains('leaving')).toBe(true);
    expect(ghost.classList.contains('cb-menu-in')).toBe(false);
    for (const node of [ghost, ...ghost.querySelectorAll('*')]) {
      for (const name of ['id', 'role', 'data-testid', 'tabindex', 'title', 'aria-label'])
        expect(node.hasAttribute(name)).toBe(false);
    }
    // What the copy cannot clone, it is given: what was typed.
    expect(ghost.querySelector('input')!.value).toBe('typed by hand');
    await motion.end();
    expect(document.querySelector('[data-ghost]')).toBeNull();
  });

  it('floats a copy out of a stack, so the rest close up at once', async () => {
    const el = surface();
    playing();
    leaveGhost(el, 'leaving', { float: 'top' });
    el.remove();
    await Promise.resolve();
    const ghost = document.querySelector<HTMLElement>('[data-ghost]')!;
    expect(ghost.style.position).toBe('absolute');
    expect(ghost.style.margin).toBe('0px');
    ghost.remove();
  });

  it('leaves nothing for a surface that never left', async () => {
    // React's development mode unmounts and remounts on mount: the element
    // stays in the document, and no copy may be left over it.
    const el = surface();
    playing();
    leaveGhost(el, 'leaving');
    await Promise.resolve();
    expect(document.querySelector('[data-ghost]')).toBeNull();
    el.remove();
  });

  it('as a component unmounts, from the element it held', async () => {
    function Menu() {
      const ref = useRef<HTMLDivElement>(null);
      useGhostOnUnmount(ref, 'leaving');
      return (
        <div ref={ref} data-testid="menu">
          menu
        </div>
      );
    }
    const motion = playing();
    const { unmount } = render(<Menu />);
    unmount();
    await Promise.resolve();
    expect(screen.queryByTestId('menu')).toBeNull();
    expect(document.querySelector('[data-ghost].leaving')?.textContent).toBe('menu');
    await motion.end();
    expect(document.querySelector('[data-ghost]')).toBeNull();
  });
});
