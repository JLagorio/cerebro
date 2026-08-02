import type { ViewType } from '@/engine/types';

/**
 * The six views, in the order they appear everywhere (M10).
 *
 * ONE list, because there were three: the toolbar's segmented control, the
 * settings panel's picker, and the new-view dialog's select each carried their
 * own copy. They had already drifted — the toolbar offered Hierarchy and the
 * dialog offered Browse, so which kinds existed depended on where you asked.
 */
export interface ViewKind {
  value: ViewType;
  label: string;
  icon: string;
  /** What this view needs from the data to show anything at all. */
  requires?: 'date';
}

export const VIEW_KINDS: ViewKind[] = [
  { value: 'table', label: 'Table', icon: 'table-2' },
  { value: 'list', label: 'List', icon: 'list' },
  { value: 'board', label: 'Board', icon: 'columns-3' },
  { value: 'calendar', label: 'Calendar', icon: 'calendar-days', requires: 'date' },
  { value: 'gantt', label: 'Gantt', icon: 'chart-gantt', requires: 'date' },
  { value: 'timeline', label: 'Timeline', icon: 'gantt-chart', requires: 'date' },
];

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
  return viewKind(type).requires === 'date';
}

/**
 * Which view-control axes a layout actually consumes.
 *
 * The tab row offered Group on every layout, including the calendar — which
 * never reads `presentation.group`. Picking a field there tinted the icon,
 * wrote the view file, and left the month grid byte-identical: a control that
 * lies about having done something. ViewSettingsPanel already hid its own
 * Group row for calendars; this is the one place both surfaces can agree.
 */
export function axesFor(type: ViewType): { sort: boolean; group: boolean } {
  // Days ARE the calendar's grouping. Sort still orders the chips inside a day.
  return { sort: true, group: type !== 'calendar' };
}
