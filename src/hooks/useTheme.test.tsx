import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { DARK_QUERY, resolveTheme, useTheme } from './useTheme';

/**
 * A `prefers-color-scheme` the test can flip.
 *
 * jsdom's own matchMedia never matches and never fires, and the suite-wide
 * shim in src/test/setup.ts is a no-op — neither can express "the OS just went
 * dark", which is the behaviour under test.
 */
function mockMatchMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = dark;
  // Cumulative, unlike `listeners.size`: an attach/detach pair leaves the set
  // the same size, which is exactly the re-subscribe churn worth catching.
  let attaches = 0;
  const mql = {
    get matches() {
      return matches;
    },
    media: DARK_QUERY,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
      attaches += 1;
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
      listeners.delete(fn);
    },
    dispatchEvent: () => true,
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql as unknown as MediaQueryList);
  return {
    listenerCount: () => listeners.size,
    attachCount: () => attaches,
    /** What the OS flipping to (or away from) dark looks like from in here. */
    flip(next: boolean) {
      matches = next;
      act(() => {
        for (const fn of [...listeners]) fn({ matches: next } as MediaQueryListEvent);
      });
    },
  };
}

function Probe() {
  useTheme();
  return null;
}

const themeAttr = () => document.documentElement.getAttribute('data-theme');

describe('useTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
    window.localStorage.removeItem('cerebro.themeMode');
    useUiStore.setState({ themeMode: 'system' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('writes the chosen theme onto <html>', () => {
    mockMatchMedia(false);
    render(<Probe />);
    act(() => useUiStore.getState().setThemeMode('dark'));
    expect(themeAttr()).toBe('dark');
    act(() => useUiStore.getState().setThemeMode('light'));
    expect(themeAttr()).toBe('light');
  });

  /**
   * The attribute is what colors.css keys its override off
   * (`:root[data-theme='dark']`), and it cannot interpret "system" — so
   * "system" must never reach the DOM, in either direction.
   */
  it('resolves system through prefers-color-scheme, never writing "system"', () => {
    mockMatchMedia(true);
    render(<Probe />);
    expect(themeAttr()).toBe('dark');
    act(() => useUiStore.getState().setThemeMode('system'));
    expect(themeAttr()).toBe('dark');
  });

  it('follows the OS live while on system', () => {
    const media = mockMatchMedia(false);
    render(<Probe />);
    expect(themeAttr()).toBe('light');
    media.flip(true);
    expect(themeAttr()).toBe('dark');
    media.flip(false);
    expect(themeAttr()).toBe('light');
  });

  it('ignores the OS while a concrete theme is chosen', () => {
    const media = mockMatchMedia(false);
    render(<Probe />);
    act(() => useUiStore.getState().setThemeMode('light'));
    media.flip(true);
    expect(themeAttr()).toBe('light');
  });

  /**
   * The subscription is held in every mode on purpose. Dropping it on Light
   * would mean a later switch back to System resolved against whatever the OS
   * was doing when the listener was last attached.
   */
  it('picks up an OS change that happened while a concrete theme was chosen', () => {
    const media = mockMatchMedia(false);
    render(<Probe />);
    act(() => useUiStore.getState().setThemeMode('light'));
    media.flip(true);
    act(() => useUiStore.getState().setThemeMode('system'));
    expect(themeAttr()).toBe('dark');
  });

  it('removes the media listener on unmount', () => {
    const media = mockMatchMedia(false);
    const { unmount } = render(<Probe />);
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  /**
   * `useSyncExternalStore` re-subscribes whenever `subscribe` changes
   * identity, and this hook lives at the app root — an inline closure would
   * detach and reattach the OS listener on every render of the whole tree.
   */
  it('subscribes to the media query once, not per render', () => {
    const media = mockMatchMedia(false);
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    act(() => useUiStore.getState().setThemeMode('dark'));
    rerender(<Probe />);
    expect(media.attachCount()).toBe(1);
    expect(media.listenerCount()).toBe(1);
  });

  it('sets color-scheme alongside data-theme so UA chrome follows', () => {
    mockMatchMedia(false);
    render(<Probe />);
    act(() => useUiStore.getState().setThemeMode('dark'));
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  // A hardened webview without matchMedia must still get a theme, not a crash.
  // Removed outright rather than stubbed: the hook branches on `typeof
  // window.matchMedia === 'function'`, so a stub that returns undefined would
  // test the wrong branch.
  it('treats a host without matchMedia as light', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true });
    try {
      expect(() => render(<Probe />)).not.toThrow();
      expect(themeAttr()).toBe('light');
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: original, configurable: true });
    }
  });

  it('resolveTheme prefers the explicit choice over the system signal', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
