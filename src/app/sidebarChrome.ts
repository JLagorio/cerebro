/**
 * Shared sidebar chrome.
 *
 * The sidebar has one frame and several modes — Workspace, Docs, Knowledge —
 * and each mode lists a different corpus. These two helpers are what makes a
 * row in one mode look like a row in another; they live apart from any single
 * mode so adding one never means copying them.
 */

export const SECTION_LABEL =
  'px-2 pb-1 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-n-500';

export function rowClass(active: boolean): string {
  return [
    'flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 px-2 text-left text-[13px]',
    active
      ? 'bg-n-100 font-medium text-n-900'
      : 'bg-transparent font-normal text-n-700 hover:bg-n-100',
  ].join(' ');
}
