// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { cssMillis, DRAWER_LEAVE, leaveDrawer, revealTheme, THEME_REVEAL } from './shellMotion';

/**
 * The navigation's motion that needs the document (app/shellMotion.ts), and
 * the shipped rules that time the rest (app/shell.css).
 *
 * jsdom has no Web Animations and no View Transitions, which is the window
 * every other test runs in: there, both helpers do their work in the call.
 * The cases that play stand in for what a browser would start.
 */

/** A window that plays motion: Web Animations present, no reduced motion. */
function allowMotion() {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: () => [],
  });
}

/** A window that plays motion, where a drawer's copy plays its way out
 *  until the case ends it. */
function playDrawerExit() {
  let end: () => void = () => undefined;
  const finished = new Promise<void>((done) => (end = done));
  const exit = {
    playState: 'running',
    finished,
    finish: () => undefined,
    effect: { getComputedTiming: () => ({ iterations: 1 }) },
  } as unknown as Animation;
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value(this: Element) {
      return this.classList.contains(DRAWER_LEAVE) ? [exit] : [];
    },
  });
  return {
    end: async () => {
      end();
      await finished;
      await Promise.resolve();
    },
  };
}

/** A View Transition whose steps the case runs: its update, then its ready
 *  and finished promises. */
function viewTransitions() {
  let update: () => void = () => undefined;
  let ready: () => void = () => undefined;
  let finished: () => void = () => undefined;
  const start = vi.fn((callback: () => void) => {
    update = callback;
    return {
      ready: new Promise<void>((done) => (ready = done)),
      finished: new Promise<void>((done) => (finished = done)),
      updateCallbackDone: Promise.resolve(),
      skipTransition: () => undefined,
    };
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    writable: true,
    value: start,
  });
  return {
    start,
    update: () => update(),
    ready: async () => {
      ready();
      await Promise.resolve();
      await Promise.resolve();
    },
    finished: async () => {
      finished();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  delete (document.documentElement as { animate?: unknown }).animate;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.removeAttribute(THEME_REVEAL);
  document.body.replaceChildren();
});

describe('revealTheme', () => {
  const root = document.documentElement;
  const control = () => {
    const button = document.createElement('button');
    button.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 36, height: 36, right: 46, bottom: 56 }) as DOMRect;
    document.body.append(button);
    return button;
  };

  beforeEach(() => {
    useUiStore.setState({ themeMode: 'light' });
    root.setAttribute('data-theme', 'light');
  });

  it('writes the mode in the call where there is nothing to draw with', () => {
    // jsdom: no View Transitions, no Web Animations.
    revealTheme('dark', control());
    expect(useUiStore.getState().themeMode).toBe('dark');
    expect(root.hasAttribute(THEME_REVEAL)).toBe(false);
  });

  it('writes the mode in the call for a reader who asked for less motion', () => {
    allowMotion();
    const transitions = viewTransitions();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList,
    );
    revealTheme('dark', control());
    expect(transitions.start).not.toHaveBeenCalled();
    expect(useUiStore.getState().themeMode).toBe('dark');
  });

  it('just changes a step that lands on the palette already on screen', () => {
    allowMotion();
    const transitions = viewTransitions();
    // System resolves to light here (the test window is not dark).
    revealTheme('system', control());
    expect(transitions.start).not.toHaveBeenCalled();
    expect(useUiStore.getState().themeMode).toBe('system');
  });

  it('spreads light and dark trading places out from the control', async () => {
    allowMotion();
    const transitions = viewTransitions();
    const animate = vi.fn();
    root.animate = animate as unknown as typeof root.animate;
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) =>
        ({ '--dur-enter': ' 240ms', '--ease-enter': ' cubic-bezier(0.16, 1, 0.3, 1)' })[name] ?? '',
    } as CSSStyleDeclaration);

    revealTheme('dark', control());
    expect(transitions.start).toHaveBeenCalledOnce();
    expect(root.hasAttribute(THEME_REVEAL)).toBe(true);
    // The old snapshot is taken before the update runs: the word waits for it.
    expect(useUiStore.getState().themeMode).toBe('light');
    transitions.update();
    expect(useUiStore.getState().themeMode).toBe('dark');

    await transitions.ready();
    const radius = Math.hypot(
      Math.max(28, window.innerWidth - 28),
      Math.max(38, window.innerHeight - 38),
    );
    expect(animate).toHaveBeenCalledWith(
      { clipPath: ['circle(0px at 28px 38px)', `circle(${radius}px at 28px 38px)`] },
      {
        duration: 480,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    );
    await transitions.finished();
    expect(root.hasAttribute(THEME_REVEAL)).toBe(false);
  });
});

describe('leaveDrawer', () => {
  /** A shell row holding a nav drawn as a drawer, and the canvas after it. */
  const shell = () => {
    const row = document.createElement('div');
    const nav = document.createElement('nav');
    nav.className = 'm71-sidebar m71-sidebar-drawer fixed';
    nav.setAttribute('data-testid', 'sidebar');
    nav.setAttribute('data-overlay', 'true');
    nav.setAttribute('aria-label', 'Sidebar');
    nav.innerHTML =
      '<button data-testid="sidebar-collapse" aria-label="Hide sidebar" tabindex="0">x</button>';
    const canvas = document.createElement('div');
    row.append(nav, canvas);
    document.body.append(row);
    return { nav, canvas };
  };
  /** What the nav's own update writes as the drawer closes. */
  const close = (nav: HTMLElement) => {
    nav.removeAttribute('data-overlay');
    nav.classList.remove('m71-sidebar-drawer', 'fixed');
    nav.hidden = true;
  };
  const copy = () => document.querySelector<HTMLElement>(`.${DRAWER_LEAVE}`);

  it('leaves a nameless, inert copy of the drawer it was, after the commit', async () => {
    playDrawerExit();
    const { nav, canvas } = shell();
    leaveDrawer(nav);
    close(nav);
    // Taken now, placed only after the commit.
    expect(copy()).toBeNull();
    await Promise.resolve();
    const ghost = copy();
    expect(ghost).not.toBeNull();
    // Under the nav, which draws over it: a drawer opened again at once is
    // never covered by its last leaving.
    expect(ghost?.nextElementSibling).toBe(nav);
    expect(nav.nextElementSibling).toBe(canvas);
    // Still drawn as the drawer, and playing its way out.
    expect(ghost?.classList.contains('m71-sidebar-drawer')).toBe(true);
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    // Nobody's target: no test id, no name, no drawer for DrawerScrim to find.
    expect(ghost?.hasAttribute('data-overlay')).toBe(false);
    expect(ghost?.querySelector('[data-testid], [aria-label], [tabindex]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="sidebar"]')).toHaveLength(1);
  });

  it('leaves with what was typed into it, and passes a file field by', async () => {
    playDrawerExit();
    const { nav } = shell();
    const field = document.createElement('input');
    const file = document.createElement('input');
    file.type = 'file';
    nav.append(field, file);
    field.value = 'half a search';
    // A clone keeps an input's first value, not what was typed since.
    expect(() => leaveDrawer(nav)).not.toThrow();
    close(nav);
    await Promise.resolve();
    expect(copy()?.querySelector<HTMLInputElement>('input:not([type])')?.value).toBe(
      'half a search',
    );
  });

  it('goes when its exit has played', async () => {
    const motion = playDrawerExit();
    const { nav } = shell();
    leaveDrawer(nav);
    close(nav);
    await Promise.resolve();
    expect(copy()).not.toBeNull();
    await motion.end();
    expect(copy()).toBeNull();
  });

  it('never strands a copy whose exit never ends', async () => {
    playDrawerExit();
    vi.useFakeTimers();
    const { nav } = shell();
    leaveDrawer(nav);
    close(nav);
    await Promise.resolve();
    expect(copy()).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(copy()).toBeNull();
  });

  it('leaves nothing while the nav is still a drawer (a development remount)', async () => {
    allowMotion();
    const { nav } = shell();
    leaveDrawer(nav);
    await Promise.resolve();
    expect(copy()).toBeNull();
  });

  it('leaves nothing where motion does not play', async () => {
    const { nav } = shell();
    leaveDrawer(nav);
    close(nav);
    await Promise.resolve();
    expect(copy()).toBeNull();
  });
});

describe('cssMillis', () => {
  it('reads a token’s time in milliseconds, and nothing else', () => {
    expect(cssMillis(' 240ms')).toBe(240);
    expect(cssMillis('0.24s')).toBe(240);
    expect(cssMillis('0s')).toBe(0);
    expect(cssMillis('')).toBeNull();
    expect(cssMillis('var(--dur-enter)')).toBeNull();
  });
});

/**
 * The SHIPPED rules, read from disk (styles/motion.test.ts's rule: pasting
 * the CSS under test in only proves the paste agrees with itself).
 */
describe('the navigation’s motion rules (shell.css)', () => {
  const CSS = readFileSync(resolve(process.cwd(), 'src/app/shell.css'), 'utf8');
  /** The declarations of the first rule whose selector list ends `selector`. */
  const rule = (selector: string): string => {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
    return CSS.slice(at, CSS.indexOf('}', at));
  };
  const OWNED = [
    '.m71-rail-button',
    '.m71-icon-button',
    '.cb-sync-badge--quiet',
    '.m71-sidebar[data-returns]:not(.m71-sidebar-drawer)',
    '.m71-sidebar-drawer',
    '.m71-sidebar-drawer.m71-sidebar-leave',
    '.cb-chevron',
    '.cb-fold-in',
    '.cb-reveal',
    '.m71-theme-glyph',
    '.m71-rail-arrive',
  ];

  it('spend the motion tokens, never a number of their own', () => {
    // A literal opts a rule out of reduced motion, which collapses the tokens.
    for (const selector of OWNED) {
      const body = rule(selector);
      expect(body, selector).toMatch(/var\(--(?:motion|dur)-/);
      expect(body, selector).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
      expect(body, selector).not.toMatch(/transition:\s*all/);
    }
  });

  it('turn one chevron instead of swapping glyphs', () => {
    expect(rule('.cb-chevron')).toMatch(/rotate var\(--motion-turn\)/);
    expect(rule('.cb-chevron--open')).toMatch(/rotate:\s*90deg/);
  });

  it('drop a fold’s contents in from its header, on the arrival pair', () => {
    const fold = rule('.cb-fold-in');
    expect(fold).toMatch(/--rise:\s*-4px/);
    expect(fold).toMatch(/animation:\s*cb-rise-in var\(--motion-enter\) backwards/);
  });

  it('bring the drawer out from behind the rail and take it back quicker', () => {
    expect(rule('.m71-sidebar-drawer')).toMatch(/m71-drawer-in var\(--motion-enter\) backwards/);
    expect(rule('.m71-sidebar-drawer.m71-sidebar-leave')).toMatch(
      /m71-drawer-out var\(--motion-exit\) forwards/,
    );
    // Nothing inside the copy arrives again on its way out: leaveGhost
    // finishes what was arriving before the copy plays its exit
    // (components/ui/motion.ts), so the stylesheet need not say so.
  });

  it('keep the hover washes on the 20ms guard', () => {
    for (const selector of ['.m71-rail-button', '.m71-icon-button', '.cb-sync-badge--quiet']) {
      expect(rule(selector), selector).toMatch(/background-color var\(--motion-hover\)/);
    }
    expect(rule('.cb-reveal')).toMatch(/opacity var\(--motion-pop\)/);
    expect(rule('.cb-reveal')).toMatch(/background-color var\(--motion-hover\)/);
  });

  it('replace the default crossfade only while a theme reveal runs', () => {
    expect(CSS).toContain(':root[data-theme-reveal]::view-transition-new(root)');
    expect(CSS).not.toMatch(/(^|\n)::view-transition/);
  });
});
