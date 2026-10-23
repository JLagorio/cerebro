import { flushSync } from 'react-dom';
import { leaveGhost, motionAllowed } from '@/components/ui/motion';
import { DARK_QUERY, resolveTheme } from '@/hooks/useTheme';
import { useUiStore, type ThemeMode } from '@/stores/uiStore';

/**
 * Motion the navigation needs the document for (owner, 2026-10-19: "add more
 * animations and polish … feel like Notion and ChatGPT and Morrow"). What
 * arrives is CSS's (app/shell.css); these two are the sidebar drawer's way
 * out and the theme's change of palette. Neither plays where motion does not
 * — jsdom, or a reader who asked for less of it — and each then does its
 * work in the call, which is also what keeps the tests' timing exact.
 */

/** The class the copy plays its way out under (shell.css). */
export const DRAWER_LEAVE = 'm71-sidebar-leave';

/**
 * The sidebar drawer leaves as a copy of itself (M52's drawer).
 *
 * The nav never unmounts — a drawer opening or closing must not remount
 * everything open inside it — so it takes its closed shape in the commit
 * that closed it, and the drawer's layer, its Escape and its focus return
 * all belong to that moment. `leaveGhost` (components/ui/motion.ts) leaves
 * the copy of the drawer it was, sliding back under the rail, once the nav
 * has really stopped being one: React's development remount, or a drawer
 * opened again at once, leaves nothing behind.
 *
 * Call it as the drawer closes, while `nav` is still drawn as one (a layout
 * effect's cleanup in a child of the nav runs before the nav's own update is
 * written).
 */
export function leaveDrawer(nav: HTMLElement | null): void {
  const parent = nav?.parentNode ?? null;
  leaveGhost(nav, DRAWER_LEAVE, {
    left: (el) => el.isConnected && el.parentNode === parent && !el.hasAttribute('data-overlay'),
  });
}

/** A CSS time in milliseconds — `240ms`, `0.24s` — or null for anything else. */
export function cssMillis(value: string): number | null {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

/** The attribute on `<html>` while a reveal runs (shell.css). */
export const THEME_REVEAL = 'data-theme-reveal';

/** How many reveals are under way, so the last one to end takes the mark. */
let revealing = 0;

/**
 * Sets the stored theme from a control, drawn.
 *
 * When light and dark actually trade places, the new palette spreads out in
 * a circle from the control's centre over the old one (thought-desk's look
 * transition, on View Transitions). A step that lands on the palette already
 * on screen — System resolving to the one you were on — changes nothing
 * anyone could see, so it simply changes.
 *
 * The stored word is written the same way either way (`setThemeMode`, which
 * `useTheme` resolves onto `<html data-theme>`), and in this call wherever
 * there is nothing to draw with: no View Transitions, jsdom, or a reader who
 * asked for less motion.
 */
export function revealTheme(next: ThemeMode, origin: Element | null): void {
  const write = () => useUiStore.getState().setThemeMode(next);
  const root = document.documentElement;
  const start = (document as Partial<Pick<Document, 'startViewTransition'>>).startViewTransition;
  const systemDark =
    typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
  if (
    typeof start !== 'function' ||
    !motionAllowed() ||
    root.getAttribute('data-theme') === resolveTheme(next, systemDark)
  ) {
    write();
    return;
  }
  const box = origin?.getBoundingClientRect();
  const x = box === undefined ? window.innerWidth / 2 : box.left + box.width / 2;
  const y = box === undefined ? 0 : box.top + box.height / 2;
  // One mark for every reveal under way: a second toggle skips the first,
  // whose end must not take the mark from the one still drawing.
  revealing += 1;
  root.setAttribute(THEME_REVEAL, '');
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    revealing -= 1;
    if (revealing === 0) root.removeAttribute(THEME_REVEAL);
  };
  let transition: ViewTransition;
  try {
    transition = start.call(document, () => {
      // useTheme writes data-theme in a layout effect: committing the store's
      // change here puts the new palette in the snapshot the circle reveals.
      flushSync(write);
    });
  } catch {
    settle();
    write();
    return;
  }
  transition.ready
    .then(() => {
      const styles = getComputedStyle(root);
      // A circle that crosses the whole window travels further than a panel
      // does, so it takes two arrivals' time on the arrival curve. Without
      // the tokens there is nothing to time it by, and the swap just lands.
      const enter = cssMillis(styles.getPropertyValue('--dur-enter'));
      const easing = styles.getPropertyValue('--ease-enter').trim();
      if (enter === null || easing === '') return;
      const radius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: enter * 2, easing, pseudoElement: '::view-transition-new(root)' },
      );
    })
    // Skipped — another transition began, or the page went hidden: the
    // palette is already written, and only the drawing is lost.
    .catch(() => {});
  transition.finished.then(settle, settle);
}
