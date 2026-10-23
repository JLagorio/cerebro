/**
 * Shared sidebar chrome.
 *
 * The sidebar has one frame and several modes — Workspace, Docs, Knowledge —
 * and each mode lists a different corpus. These helpers are what makes a row
 * or a fold in one mode look and move like one in another; they live apart
 * from any single mode so adding one never means copying them. The rules they
 * name are in app/shell.css.
 */

export const SECTION_LABEL = 'px-2 pb-1 pt-3 text-xs font-medium text-(--text-meta)';

export function rowClass(active: boolean): string {
  // Navigation is quiet chrome; readable selection stays distinct from hover
  // through its darker neutral fill and medium-weight label.
  return [
    'cb-nav-row',
    // The nav is the surface a pointer crosses fastest — a dozen rows in one
    // flick — so an undeclared wash strobes. 20ms is the guard (M46.2).
    'motion-hover',
    active
      ? 'cb-nav-row--selected font-medium text-n-900'
      : 'bg-transparent font-normal text-n-700 hover:bg-n-100',
  ].join(' ');
}

/**
 * A fold's one chevron. It points right while the fold is shut and turns
 * down as it opens, rather than trading `chevron-right` for `chevron-down`,
 * so the change reads as the fold moving. Draw `chevron-right` and give it
 * this class; the state it shows is its control's `aria-expanded`.
 */
export function chevronClass(open: boolean): string {
  return open ? 'cb-chevron cb-chevron--open' : 'cb-chevron';
}

/**
 * What a fold's contents wear: they drop in under the header as it opens,
 * and arrive with their shelf when an area or the sidebar comes into view.
 * On the wrapper of what the fold holds, never on the header.
 */
export const FOLD_IN = 'cb-fold-in';

/** Controls a header or row reveals on hover fade rather than pop. */
export const REVEAL = 'cb-reveal';

/** A control inside a nav row washes a step past the row's own fill. */
export const ROW_CONTROL = 'cb-row-control';
