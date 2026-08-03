import { VIEW_TYPES, type ViewType } from '@/engine/types';

/**
 * Every view kind and what it can do, in the order they appear everywhere.
 *
 * ONE list, because there were three: the toolbar's segmented control, the
 * settings panel's picker, and the new-view dialog's select each carried their
 * own copy. They had already drifted — the toolbar offered Hierarchy and the
 * dialog offered Browse, so which kinds existed depended on where you asked.
 *
 * M16.3 moved the *capabilities* here too. They used to be four untyped string
 * comparisons scattered through a 1056-line settings panel — two plain
 * `Set<string>` and two hardcoded `p.type === '…'` — so a new kind compiled
 * clean and then silently had no settings. A capability the compiler can see
 * is a capability a new kind cannot forget to declare.
 */
export interface ViewKind {
  value: ViewType;
  label: string;
  icon: string;
  /** Places records on a date axis: needs a date field, gets the Axis page. */
  dated?: boolean;
  /** Reads `presentation.group` — the calendar's grouping IS the day grid. */
  groupable?: boolean;
  /** Renders relation chips, so the chip-style section applies. */
  chips?: boolean;
  /** Scrolls a time axis, so it gets the zoom control. */
  zoomable?: boolean;
  /** Draws dependency arrows between bars. */
  dependencies?: boolean;
}

/**
 * `satisfies Record<ViewType, …>` is the enforcement: add a member to
 * VIEW_TYPES and this object stops compiling until the kind is described. A
 * plain array could not do that — the old one was a bare `ViewKind[]`, so a
 * new kind was simply invisible in all five pickers with no error.
 */
const CAPABILITIES = {
  table: { label: 'Table', icon: 'table-2', groupable: true, chips: true },
  list: { label: 'List', icon: 'list', groupable: true, chips: true },
  board: { label: 'Board', icon: 'columns-3', groupable: true, chips: true },
  calendar: { label: 'Calendar', icon: 'calendar-days', dated: true },
  gantt: {
    label: 'Gantt',
    icon: 'chart-gantt',
    dated: true,
    groupable: true,
    zoomable: true,
    dependencies: true,
  },
  timeline: {
    label: 'Timeline',
    // Not chart-gantt: gantt and timeline shared that icon, which made them
    // indistinguishable in all five pickers (M16.3).
    icon: 'chart-no-axes-gantt',
    dated: true,
    groupable: true,
    zoomable: true,
  },
} satisfies Record<ViewType, Omit<ViewKind, 'value'>>;

/** Order comes from VIEW_TYPES, so there is one place that decides it. */
export const VIEW_KINDS: ViewKind[] = VIEW_TYPES.map((value) => ({
  value,
  ...CAPABILITIES[value],
}));

/** Segmented-control options, with the test ids the e2e suite navigates by. */
export const VIEW_SEGMENTS = VIEW_KINDS.map((k) => ({
  value: k.value,
  label: k.label,
  icon: k.icon,
  testId: `view-switch-${k.value}`,
}));

export function viewKind(type: ViewType): ViewKind {
  return VIEW_KINDS.find((k) => k.value === type) ?? VIEW_KINDS[0];
}

/** True for the views that place records on a date axis. */
export function needsDate(type: ViewType): boolean {
  return viewKind(type).dated === true;
}

export function isZoomable(type: ViewType): boolean {
  return viewKind(type).zoomable === true;
}

export function hasDependencies(type: ViewType): boolean {
  return viewKind(type).dependencies === true;
}

export function showsChips(type: ViewType): boolean {
  return viewKind(type).chips === true;
}

/**
 * Which view-control axes a layout actually consumes.
 *
 * The tab row offered Group on every layout, including the calendar — which
 * never reads `presentation.group`. Picking a field there tinted the icon,
 * wrote the view file, and left the month grid byte-identical: a control that
 * lies about having done something.
 */
export function axesFor(type: ViewType): { sort: boolean; group: boolean } {
  // Days ARE the calendar's grouping. Sort still orders the chips inside a day.
  return { sort: true, group: viewKind(type).groupable === true };
}
