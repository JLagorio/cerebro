import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useUiStore, type ThemeMode } from '@/stores/uiStore';

/** What actually lands on `<html data-theme>` — never 'system'. */
export type ResolvedTheme = 'light' | 'dark';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Resolve a stored choice against what the OS is currently doing.
 *
 * Split out from the hook so the resolution rule is testable on its own and
 * so the pre-paint script in index.html has something to be checked against.
 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemDark ? 'dark' : 'light';
}

/**
 * Write the theme onto the document element.
 *
 * ALWAYS a concrete value: `src/styles/tokens/colors.css` keys its override
 * off `:root[data-theme='dark']` and has no way to interpret "system".
 *
 * `colorScheme` is set alongside it because the two answer different
 * questions. `data-theme` tells our own stylesheet which palette to use;
 * `color-scheme` tells the USER AGENT which way to paint the things we do not
 * style — scrollbars, form controls, the canvas behind the app. The meta tag
 * in index.html says "light dark", i.e. "either is fine", so without this a
 * person on a dark OS who picks Light gets a light app with dark scrollbars.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
}

/**
 * Track `prefers-color-scheme` as React state.
 *
 * `useSyncExternalStore` rather than effect + state so the very first render
 * already knows which way the OS is leaning — the same reason App's
 * `useMediaQuery` uses it. Hosts without `matchMedia` (jsdom without the test
 * shim, or a hardened webview) report "not dark", which is the pre-M16
 * behaviour, never a crash.
 *
 * `subscribe` is memoised against the (ref-stable) MediaQueryList rather than
 * declared inline: `useSyncExternalStore` re-subscribes whenever that function
 * changes identity, so an inline one detaches and reattaches the listener on
 * every render of the app root. Harmless, but pure churn.
 */
function useSystemDark(): boolean {
  const ref = useRef<MediaQueryList | null>(null);
  ref.current ??= typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  const mql = ref.current;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (mql === null) return () => {};
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [mql],
  );
  const getSnapshot = useCallback(() => mql?.matches ?? false, [mql]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Keep `<html data-theme>` in step with the chosen mode (M16.36). Call once,
 * at the app root.
 *
 * The media query is subscribed to in EVERY mode, not only 'system'. Dropping
 * the subscription while the user is on Light would mean that switching back
 * to System later resolved against whatever the OS was doing when the
 * listener was last attached — a stale answer, and exactly the bug this hook
 * exists to prevent. One listener costs nothing.
 */
export function useTheme(): ResolvedTheme {
  const mode = useUiStore((s) => s.themeMode);
  const systemDark = useSystemDark();
  const theme = resolveTheme(mode, systemDark);

  // Layout effect, not a passive one: this runs on every mode change, and an
  // effect that lands after paint shows one frame of the outgoing palette.
  // The FIRST paint is index.html's job — this hook has already missed it.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return theme;
}
