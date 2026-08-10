import { VIEW_TYPES, type Presentation, type ViewType } from '@/engine/types';

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
  /**
   * Draws a snippet of the record's BODY on its card (Notion's "Card preview
   * › Page content"). Narrower than `cards`: the gallery's card is a cover,
   * a title and chips, so offering the control there set a key nothing read.
   */
  preview?: boolean;
  /** Draws a COVER on its cards, from a media property. Narrower than `cards`
   * for the mirror-image reason: the board's card has no cover slot. */
  covers?: boolean;
  /**
   * Draws each group as its own side-by-side COLUMN, which is what lets a
   * column be tinted and dropped onto. The gallery bands its cards into
   * stacked sections instead, so "Color columns" there coloured nothing.
   */
  groupColumns?: boolean;
  /**
   * Places records in a day GRID rather than on a scrolling axis — so it has
   * a span, a week start, and weekends to drop.
   *
   * This was `isDayGrid`, a local `type === 'calendar'` predicate inside the
   * settings panel whose own comment said it belonged here and was blocked
   * only by the panel and this file being in different phases (M16.22).
   */
  dayGrid?: boolean;
  /**
   * Draws records as a grid of rows and columns: row height, wrapping,
   * freezing, where the name column sits and what its footer calculates.
   */
  tabular?: boolean;
  /**
   * Keeps a name column whose width the view stores. Wider than `tabular` —
   * a timeline and a gantt draw a table BESIDE the axis (M16.24) and size its
   * name column with the same key the table does.
   */
  nameColumn?: boolean;
  /** Draws an aggregation rather than records, so it gets the Chart page
   * (M16.27). Its X axis is the grouping chain, hence `groupable` too. */
  charted?: boolean;
  /** Composed of blocks rather than records, so it gets the Blocks page
   * (M16.28). It renders other views, so it cannot itself be one of them. */
  blocks?: boolean;
  /**
   * Draws a free-form CANVAS rather than records (M29.45): the tab's content
   * is a `.mmd` file it owns, so it gets no record-layout pages and exactly
   * one presentation key — `whiteboard`, the file pointer.
   *
   * Optional like every flag above it — the file's style is that absence IS
   * false, and only the kind that has a capability says so. The `satisfies`
   * on CAPABILITIES therefore demands nothing new from the existing nine
   * records: they stay byte-identical, and `isCanvas` reads `=== true`.
   */
  canvas?: boolean;
}

/**
 * `satisfies Record<ViewType, …>` is the enforcement: add a member to
 * VIEW_TYPES and this object stops compiling until the kind is described. A
 * plain array could not do that — the old one was a bare `ViewKind[]`, so a
 * new kind was simply invisible in all five pickers with no error.
 */
const CAPABILITIES = {
  table: {
    label: 'Table',
    icon: 'table-2',
    groupable: true,
    chips: true,
    tabular: true,
    nameColumn: true,
  },
  list: { label: 'List', icon: 'list', groupable: true, chips: true },
  // `cards` was added by the gallery (M16.22) while the board's own card-ness
  // still lived in a second capability table inside BoardSettings.tsx, so the
  // board never declared it here. Collapsing the two tables at merge time is
  // what surfaced that — which is the argument for one registry, made by the
  // registry itself.
  board: {
    label: 'Board',
    icon: 'columns-3',
    groupable: true,
    chips: true,
    cards: true,
    preview: true,
    groupColumns: true,
  },
  calendar: { label: 'Calendar', icon: 'calendar-days', dated: true, dayGrid: true },
  gantt: {
    label: 'Gantt',
    icon: 'chart-gantt',
    dated: true,
    groupable: true,
    zoomable: true,
    dependencies: true,
    nameColumn: true,
  },
  timeline: {
    label: 'Timeline',
    // Not chart-gantt: gantt and timeline shared that icon, which made them
    // indistinguishable in all five pickers (M16.3).
    icon: 'chart-no-axes-gantt',
    dated: true,
    groupable: true,
    zoomable: true,
    nameColumn: true,
  },
  gallery: {
    label: 'Gallery',
    icon: 'layout-grid',
    groupable: true,
    chips: true,
    cards: true,
    covers: true,
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
  whiteboard: {
    label: 'Whiteboard',
    // 'presentation' — the easel — verified present in lucide-react (as is
    // 'frame', the runner-up). NOT 'waypoints': the diagram surfaces claimed
    // that one (M29.21 page header, block header), and the distinct-icon
    // test below only defends uniqueness against other VIEW KINDS, not
    // against the rest of the app's iconography.
    icon: 'presentation',
    // Deliberately nothing else. Every record-layout capability would be a
    // control that changes nothing on a canvas — the calendar's M16.3 bug.
    canvas: true,
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

/** True for the card layouts that draw a body snippet on the card (M16.29). */
export function showsPreview(type: ViewType): boolean {
  return viewKind(type).preview === true;
}

/** True for the card layouts that draw a cover (M16.29). */
export function showsCovers(type: ViewType): boolean {
  return viewKind(type).covers === true;
}

/** True for the layouts whose groups are side-by-side columns (M16.29). */
export function hasGroupColumns(type: ViewType): boolean {
  return viewKind(type).groupColumns === true;
}

/** True for the layouts that place records in a day grid (M16.29). */
export function isDayGrid(type: ViewType): boolean {
  return viewKind(type).dayGrid === true;
}

/** True for the layouts that draw a grid of rows and columns (M16.29). */
export function isTabular(type: ViewType): boolean {
  return viewKind(type).tabular === true;
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

/** True for the layouts that draw a free-form canvas, not records (M29.45). */
export function isCanvas(type: ViewType): boolean {
  return viewKind(type).canvas === true;
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

/** Everything on a ViewKind that answers yes/no about what a layout can do. */
type Capability = Exclude<keyof ViewKind, 'value' | 'label' | 'icon'>;

/**
 * The presentation keys every layout reads, so they always travel.
 *
 * These are the QUERY — which records, in what order, banded how, showing
 * which properties. "Another view of this data" that arrived as a blank table
 * would be worse than one carrying a key too many.
 */
type SharedKey = 'type' | 'group' | 'sort' | 'columns' | 'limit';

/**
 * Which capability each layout-specific presentation key needs to mean
 * anything (M16.29).
 *
 * `satisfies Record<Exclude<keyof Presentation, …>, Capability>` is the
 * enforcement, and the reason this map is worth its length: add a key to
 * `Presentation` and this stops compiling until someone says which layouts
 * read it. There is no way to add a key that quietly travels everywhere.
 */
const KEY_NEEDS = {
  rowHeight: 'tabular',
  frozenColumns: 'tabular',
  titlePosition: 'tabular',
  titleCalc: 'tabular',
  titleWidth: 'nameColumn',
  chips: 'chips',
  cardSize: 'cards',
  cardPreview: 'preview',
  colorColumns: 'groupColumns',
  gallery: 'covers',
  dateField: 'dated',
  calendarSpan: 'dayGrid',
  showWeekends: 'dayGrid',
  weekStart: 'dayGrid',
  zoom: 'zoomable',
  showTable: 'zoomable',
  dependencyField: 'dependencies',
  chart: 'charted',
  dashboard: 'blocks',
  whiteboard: 'canvas',
} satisfies Record<Exclude<keyof Presentation, SharedKey>, Capability>;

/**
 * Keys `carryOver` never copies, even to a kind that can read them (M29.45).
 *
 * `whiteboard.file` names a resource the TAB owns, not a preference about
 * drawing. Seeding it into a new tab would aim two tabs at one `.mmd`, so
 * "add a whiteboard" while standing on one would silently create a second
 * door to the same canvas instead of a new canvas. The new tab starts with
 * no pointer and creates its own file on first open.
 *
 * (Duplicate keeps the pointer on purpose — `duplicateView` copies the whole
 * view, and a copy that shows the same canvas is what "duplicate" says.
 * Layout-switching a tab away and back also keeps it: `onChangeLayout` swaps
 * only `type`, so a whiteboard demoted to a table and restored finds its
 * canvas where it left it.)
 */
const NEVER_SEEDED: ReadonlySet<string> = new Set(['whiteboard']);

/**
 * The part of a presentation a NEW view of another kind may inherit (M16.29).
 *
 * "Add a view" seeds from the tab you are standing on, which is what people
 * mean by it — but it used to copy the whole presentation and only swap
 * `type`. A Table born on the Gallery inherited `colorColumns`; one born on
 * the Gantt inherited `dateField`, `zoom` and `dependencyField`. None of those
 * mean anything to a table, nothing on screen ever mentioned them again, and
 * they were written to the user's YAML on the first save — permanently.
 *
 * So a key travels only to a kind that can read it. The query — columns, sort,
 * grouping, limit — travels always.
 *
 * This lives here rather than beside `newView` because the capability catalog
 * is here: `engine/` is the pure domain core and does not import the view
 * layer, and a second copy of the table in the engine is exactly the drift
 * M16.3 spent a commit deleting.
 */
export function carryOver(base: Presentation, type: ViewType): Presentation {
  const kind = viewKind(type);
  const kept = Object.fromEntries(
    Object.entries(base).filter(([key]) => {
      if (NEVER_SEEDED.has(key)) return false;
      const needs = KEY_NEEDS[key as keyof typeof KEY_NEEDS];
      return needs === undefined || kind[needs] === true;
    }),
  ) as Presentation;
  return { ...kept, type };
}
