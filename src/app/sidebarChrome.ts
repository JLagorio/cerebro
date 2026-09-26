/**
 * Shared sidebar chrome.
 *
 * The sidebar has one frame and several modes — Workspace, Docs, Knowledge —
 * and each mode lists a different corpus. These two helpers are what makes a
 * row in one mode look like a row in another; they live apart from any single
 * mode so adding one never means copying them.
 */

export const SECTION_LABEL =
  'px-2 pb-1 pt-3.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500';

export function rowClass(active: boolean): string {
  // Selection is a cortex wash with cortex ink (DS: `--surface-selected` +
  // cortex-700), never a gray — gray is what HOVER says (M42.1).
  return [
    'flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 px-2 text-left text-sm',
    // The nav is the surface a pointer crosses fastest — a dozen rows in one
    // flick — so an undeclared wash strobes. 20ms is the guard (M46.2).
    'motion-hover',
    active
      ? 'bg-surface-selected font-medium text-cortex-700'
      : 'bg-transparent font-normal text-n-700 hover:bg-n-100',
  ].join(' ');
}
