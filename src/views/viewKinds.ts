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
  /** Draws records as cards, so it gets the Cards settings page (M16.22). */
  cards?: boolean;
  /** Draws an aggregation rather than records, so it gets the Chart page
   * (M16.27). Its X axis is the grouping chain, hence `groupable` too. */
  charted?: boolean;
  /** Composed of blocks rather than records, so it gets the Blocks page
   * (M16.28). It renders other views, so it cannot itself be one of them. */
  blocks?: boolean;
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
  gallery: {
    label: 'Gallery',
    icon: 'layout-grid',
    groupable: true,
    chips: true,
    cards: true,
  },
  chart: {
    label: 'Chart',
    icon: 'chart-column',
    // The grouping chain IS the X axis, so the Group control configures the
    // chart and there is no second "group by" to drift from it.
    groupable: true,
    charted: true,
  },
  dashboard: {
    label: 'Dashboard',
    icon: 'layout-dashboard',
    // Deliberately not groupable: a dashboard shows blocks, and each block
    // brings its own view with its own grouping. A Group control here would
    // be a control that changes nothing — the calendar's bug (M16.3).
    blocks: true,
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

/** True for the layouts that draw records as cards (M16.22). */
export function showsCards(type: ViewType): boolean {
  return viewKind(type).cards === true;
}

/** True for the layouts that draw an aggregation rather than records (M16.27). */
export function isCharted(type: ViewType): boolean {
  return viewKind(type).charted === true;
}

/**
 * True for the layouts composed of blocks (M16.28).
 *
 * Also the recursion guard: a dashboard embeds saved views, and a block
 * pointing at another dashboard would nest until the stack ran out. Asking the
 * kind — rather than comparing to the string 'dashboard' at the one call site
 * that noticed — means a second block-composed kind is caught by the same
 * check on the day it exists.
 */
export function hasBlocks(type: ViewType): boolean {
  return viewKind(type).blocks === true;
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
