import type { AggregateCalc } from './aggregate';
import type { DateDisplayFormat, TimeDisplayFormat } from './dates';
import type { RelationIndex } from './relations';

export type Scalar = string | number | boolean | null;

export interface Entry {
  path: string; // vault-relative, e.g. "items/fld-7.md"
  filename: string; // "fld-7.md"
  folder: string; // vault-relative parent dir ('' at the root) — vault format v2
  project: string | null; // owning project.md path via containment (nearest ancestor
  // directory holding a project.md), null outside any project
  title: string; // first H1, else humanized filename stem
  type: string | null; // frontmatter `type`
  properties: Record<string, Scalar | Scalar[]>; // scalar frontmatter (non-wikilink); nested YAML
  // (type-note `fields:`, space `statuses:`) passes
  // through as raw nested values — consumers cast
  relationships: Record<string, string[]>; // wikilink-valued fields → raw targets
  outgoingLinks: string[]; // wikilink targets found in the body
  snippet: string; // first ~160 chars of body text, markdown-stripped
  createdAt: string; // ISO 8601
  modifiedAt: string; // ISO 8601
  parseError: string | null; // YAML error message, or null
}

/**
 * Every property kind, as an array with the union derived from it (M16.4).
 *
 * There were three hand-maintained copies of this list — here, `FIELD_KINDS`
 * in schema.ts, and `PROPERTY_KINDS` in properties.ts — and only the union was
 * compiler-enforced. Omitting the schema.ts entry made `asFieldKind` silently
 * resolve the kind to `text`, so a declared Select rendered as a text box and
 * the YAML that said otherwise was ignored.
 *
 * Order here is irrelevant; the "+ Add property" catalog order is declaration
 * order in properties.ts.
 */
export const FIELD_KINDS = [
  'text',
  'number',
  'checkbox',
  'date',
  'daterange',
  'select',
  'multiselect',
  'status',
  'person',
  'relation',
  'url',
  'email',
  'phone',
  'files',
  'rollup',
  'created_time',
  'last_edited_time',
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

export type RollupCalc = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'earliest' | 'latest' | 'show';

export interface FieldOption {
  id: string;
  label: string;
  color: string | null;
  hollow?: boolean;
}
export interface StatusDef extends FieldOption {
  group: 'active' | 'done' | 'closed';
}
/** How a numeric value is displayed. Stored value never changes — a percent
 * is still `76` on disk (M3.4: the Notion "Progress · 0% Complete" bar). */
export type FieldFormat = 'plain' | 'percent' | 'progress' | 'currency';

export interface FieldDef {
  name: string;
  kind: FieldKind;
  options?: FieldOption[];
  /** Relation: the TYPE this field may point at (M12.4: enforced — the
   * picker only offers records of it). Absent means any record (legacy). */
  target?: string;
  /** Relation: at most one linked record when 1 (M12.4); absent = no limit. */
  limit?: 1;
  /** rollup config: aggregate `property` across the `relation` field's targets. */
  relation?: string;
  /** Reverse source, two uses: on a rollup (M3.5), aggregate the records of
   * `type` whose `field` points back at this one; on a RELATION (M12.4), this
   * field is the derived reciprocal of a two-way pair — it stores nothing,
   * shows the records of `type` linking here through `field`, and edits write
   * through to that owning side. */
  from?: { type: string; field: string };
  property?: string;
  calculate?: RollupCalc;
  /** display format for number/rollup values; defaults to 'plain'. */
  format?: FieldFormat;
  /** decimal places for numeric formats; defaults to 2 (trailing zeros trimmed). */
  precision?: number;
  /**
   * How a date/daterange renders (M16.14). A SEPARATE key from `format`,
   * which numbers already own — one key holding two unrelated enums would
   * make `changeFieldKind` between number and date silently carry a value
   * neither side understands.
   *
   * Absent means 'short', which is what every date rendered as before this
   * was persistable at all.
   */
  dateFormat?: DateDisplayFormat;
  /** 12h / 24h / hidden for the time half of a date value; absent = '12'. */
  timeFormat?: TimeDisplayFormat;
  /**
   * Whether the detail panel shows this property (M16.10). PER-PROPERTY, on
   * the type — not per view. `ColumnSpec.hidden` answers a different
   * question ("does THIS view show this column"), and a record panel has no
   * view to read it from.
   *
   * Absent means `show`, so every vault that predates this reads unchanged.
   */
  visibility?: FieldVisibility;
}

/**
 * Notion's three states, verbatim: Always show / Hide when empty / Always
 * hide. `hide_when_empty` is the one that earns the model — a type with
 * twenty optional properties shows a wall of "Empty" on every record
 * otherwise, and per-view column toggles cannot fix a panel.
 */
export const FIELD_VISIBILITIES = ['show', 'hide_when_empty', 'hide'] as const;
export type FieldVisibility = (typeof FIELD_VISIBILITIES)[number];

/** The record panel's per-type presentation (M44.1). Defaults are the
 * pre-M44.1 behaviour: empty properties fold, no file row, body shown. */
export interface DisplayConfig {
  /** Empty declared properties render unfolded instead of behind the count. */
  showEmpty: boolean;
  /** A muted file-path row above the timestamps. */
  showFile: boolean;
  /** The Description section and its editor. */
  showBody: boolean;
}

export const DISPLAY_DEFAULTS: DisplayConfig = {
  showEmpty: false,
  showFile: false,
  showBody: true,
};

/** One named panel of properties on the record page (M45.1). Ids mint like
 * tab ids and matter to the layout editor's drag model, not to any
 * per-record data. */
export interface LayoutGroup {
  id: string;
  name: string;
  fields: string[];
  /** Which tab of the type's `tabs:` this section belongs to (M45.6). ABSENT
   * is the DEFAULT tab — the first property-bearing one (`typeCatalog`'s
   * `layoutTabScope` decides which that is) — and absent is what every group
   * wore before this key existed, so no vault migrates and a hand-written
   * `layout:` with no tabs still renders exactly as it did. A DEAD pointer
   * (a tab the type no longer declares) resolves onto the default tab,
   * visible: a section the user cannot see is a section they cannot
   * recover. */
  tab?: string;
}

/** Where the record page PLACES properties (M45.1) and, since M45.6, on WHICH
 * TAB. `fields:` declares and orders; `visibility` discloses; `layout`
 * arranges. Absent = the flat stack every type rendered before M45. The
 * heading strip stays global — it renders above the tab strip, on every tab
 * — while a GROUP may name its tab. A field name appears at most once
 * across `heading` + all `groups` — parse drops later claims, so
 * downstream code never dedups. */
export interface LayoutConfig {
  heading: string[];
  groups: LayoutGroup[];
}

export const LAYOUT_DEFAULTS: LayoutConfig = { heading: [], groups: [] };

/** What a record tab renders (M44.5). A closed vocabulary on purpose: an
 * unrecognised kind from hand-edited YAML must not reach the renderer.
 * `'view'` (M45.4) embeds a database view by reference. */
export const TAB_CONTENTS = ['overview', 'properties', 'sections', 'view'] as const;
export type TabContent = (typeof TAB_CONTENTS)[number];

/** Where a `content: 'view'` tab's rows come from (M45.4) — a reference,
 * never a copy, the same doctrine the dashboard `view` widget's comment
 * states on DashboardWidget below: the tab carries the pointer and editing
 * the source updates every record page showing it. A type IS a database
 * (M39); a list id is unique per FOLDER, so `collection` rides along
 * (the surface.ts location doctrine). */
export type ViewTabSource = { type: string } | { list: string; collection?: string | null };

/** One tab of a type's record page (M44.5) — the same contract a view tab
 * has: a stable id the selection addresses, a name, an optional icon. */
export interface TabDef {
  id: string;
  name: string;
  icon: string | null;
  content: TabContent;
  /** `content: 'view'` only. Always present on a parsed view tab; `null`
   * means the tab declared no readable source — the tab is KEPT (its id may
   * key per-record `_sections` content) and the renderer shows the broken
   * state, because unavailable is never empty. */
  source?: ViewTabSource | null;
  /** `content: 'view'` only: a saved view id on the source. Absent = the
   * source's first view. */
  view?: string;
  /** `content: 'view'` only: scope rows to those related to THIS record via
   * a relation field on the source type targeting the host's type (M45.4).
   * Absent = all rows. */
  scope?: 'related';
}

export interface TypeDef {
  name: string;
  icon: string | null;
  color: string | null;
  fields: FieldDef[];
  /** `statuses:` declared on this Type doc; [] when it declares none. */
  statuses: StatusDef[];
  /** `folder:` on the Type doc — where new records land (M12.2). Null means
   * the records/<plural-slug> convention. */
  folder: string | null;
  /** Saved views of the type screen (M12.3), stored under `views:` on the
   * Type doc — the same shape a List keeps. [] means none saved yet. */
  views: ViewDefinition[];
  /** `display:` on the Type doc (M44.1) — how the record panel presents this
   * type. Always resolved: absent frontmatter yields the defaults, so no
   * consumer null-checks. */
  display: DisplayConfig;
  /** `layout:` on the Type doc (M45.1) — where the record page places this
   * type's properties. Always resolved: absent frontmatter yields the
   * defaults (the flat stack), so no consumer null-checks. */
  layout: LayoutConfig;
  /** `tabs:` on the Type doc (M44.5) — the tab set every surface that shows
   * a record of this type renders (the page and the peek since M45.6). []
   * means none saved yet; `typeTabs` synthesizes the Overview default. */
  tabs: TabDef[];
}

export interface ResolvedField {
  def: FieldDef | null; // null → undeclared field (advisory: still shown as text)
  raw: unknown;
  display: string; // '' when empty
  color: string | null;
  ghost: boolean; // value not in the declared option set
}

/**
 * Where you are inside the Knowledge tab.
 *
 * M33a.2 folded the Status hub in here. The first five arms are what the base
 * HOLDS; the last six are what it knows about ITSELF and what its agents have
 * done. One destination, because they were always one subject — a bundle that
 * cannot say what it is unsure of is not a knowledge base, it is a folder.
 */
export type KnowledgeNav =
  | { tab: 'all' }
  | { tab: 'review' }
  | { tab: 'log' }
  | { tab: 'section'; folder: string }
  | { tab: 'entity'; key: string }
  | { tab: 'changed' }
  | { tab: 'contested' }
  | { tab: 'waiting' }
  | { tab: 'background' }
  // `run` deep-links one run open, the way `entity` deep-links one subject.
  | { tab: 'runs'; run?: string }
  | { tab: 'gates' };

/**
 * Which shelf of the library is open (M18).
 *
 * Declared here rather than in engine/library so the Selection union stays
 * dependency-free — every module in the app reads this file, and few of them
 * have any business knowing what a skill is.
 */
export type LibraryTab = 'skill' | 'agent' | 'template';

export type Selection =
  | { kind: 'home' }
  | { kind: 'inbox' } // capture queue: unorganized notes (M4)
  // M43 — open work across every database. Capability-gated membership
  // (engine/myWork); no per-entry state rides on the selection.
  | { kind: 'mywork' }
  // AI knowledge base: OKF bundle, read-only (M5). An absent `nav` means "no
  // view was asked for", which `defaultKnowledgeNav` answers with the heaviest
  // thread (M33a.3) — it was a plain `all` from M8.1 until then.
  // `path` deep-links one concept, so knowledge surfaced beside your work
  // (M8.3) can actually be opened rather than only named.
  // M33a.2 — and what the base knows about ITSELF: the epistemic tabs `nav`
  // now carries were their own `status` kind until this milestone. One kind,
  // because "what it holds" and "what it is unsure of" were never two
  // subjects. Deep links that used to be `{kind:'status', section, run}` are
  // `{kind:'knowledge', nav:{tab, run}}` — one vocabulary, not a mapping
  // table between two.
  | { kind: 'knowledge'; nav?: KnowledgeNav; path?: string }
  // M12.5: `project` retired — a project is a folder, and a folder with
  // things in it is a Collection. Legacy project.md files open as records.
  | {
      kind: 'doc';
      path: string; // full-page markdown document (M2 Task 10)
      /** Which record tab is open (M44.5). Rides on the selection rather than
       * in component state so "the Spec tab of DOC-14" is a place the back
       * button returns to — the same contract `list.view` follows. Absent =
       * the type's first tab. */
      tab?: string;
    }
  // M29.21 — a standalone .mmd file. Raw diagram source has no frontmatter
  // and no record shape, so it gets its own full-page editor surface rather
  // than being forced through the doc canvas.
  | { kind: 'diagram'; path: string }
  // M10 — a Collection is a container (a folder holding collection.yml); a List
  // is a database inside one. These were a single `view` kind that was both.
  | { kind: 'collection'; folder: string }
  // `view` names which of the List's view tabs is open (M11); omitted means
  // the first one. It rides on the selection rather than in component state so
  // that "the board tab of Delivery" is a place you can navigate back to.
  | { kind: 'list'; id: string; collection?: string | null; view?: string }
  // `view` names which of the type's saved view tabs is open (M12.3), same
  // contract as a List's; omitted means the first one.
  | { kind: 'type'; name: string; view?: string }
  // M9.4 — git surfaces. `changes` is the uncommitted working tree (with
  // conflict resolution when there is one); `pulse` is the committed history.
  | { kind: 'changes' }
  | { kind: 'pulse' }
  // M17.9/M17.11 — skills and agents, which were reachable only by knowing
  // which folder they lived in. A capability nobody can find is one nobody has.
  // M18 — `tab` names which shelf is open and `path` the item being edited, so
  // "the release scout's triggers" is a place the back button can return to
  // rather than component state that a re-render forgets.
  | { kind: 'library'; tab?: LibraryTab; path?: string }
  // M30 — mounted roots. `root` and `path` ride on the selection rather than in
  // component state so "the README of cerebro" is a place Back returns to, the
  // same contract `list.view` and `library.tab` already follow.
  | { kind: 'workspace'; root?: string; path?: string }
  // M40 — the prototype surface, the third locked name (Base/Work/Studio).
  // `project` is the open prototype's folder slug: a SUBJECT the back button
  // returns to. The previewed page within it is a lens and stays local.
  | { kind: 'studio'; project?: string }
  // M41 — the agents' front door. `actor` is the ACTOR string
  // (`process:<slug>`, or an internal construct's name), not the record
  // path: constructs have pages too, and the actor is the one identity a
  // run, a write, and an @-mention already share.
  | { kind: 'agents'; actor?: string }
  | { kind: 'settings' };

/**
 * One level of a view's grouping chain (M9.1, unified M9.7).
 *
 * A level names EITHER a property — records band by its value — or a
 * relation, in which case records NEST under the ones they link to.
 *
 * These were two separate axes, `group` and `hierarchy`, which is one
 * concept wearing two hats: both answer "what is the next level down?".
 * Splitting them meant a table could not nest, a hierarchy could not band,
 * and the user had to learn two controls to say one thing.
 */
export interface GroupSpec {
  /** Property to band by, or the name of the relation to descend. */
  field: string;
  /**
   * Present ⇒ this level descends a relation instead of banding a value.
   * `field` is that relation's name either way, so a chain reads the same
   * whichever kind of level it is.
   */
  descend?: ChildrenSpec;
  /** Order of the GROUPS themselves; declared option order when omitted. */
  dir?: 'asc' | 'desc';
  /** Drop groups with no entries. Boards want them (they are the columns). */
  hideEmpty?: boolean;
}

/** Levels that band by a property value. */
export function bandLevels(group: GroupSpec[]): GroupSpec[] {
  return group.filter((g) => g.descend === undefined);
}

/** Levels that nest by following a relation, in descent order. */
export function nestLevels(group: GroupSpec[]): ChildrenSpec[] {
  return group.flatMap((g) => (g.descend === undefined ? [] : [g.descend]));
}

/** One key of a multi-key sort (M9.1). First non-zero comparison wins. */
export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

/**
 * One column (M9.1). Replaces the bare field name in `visibleFields` so a
 * view can carry width and hidden-ness. `hidden` rather than removal from
 * the array: re-showing a column returns it to its position instead of
 * appending it to the end.
 */
export interface ColumnSpec {
  field: string;
  width?: number;
  hidden?: boolean;
  wrap?: boolean;
  /** The footer calculation for this column (M16.15). Absent = no footer
   * cell, which is Notion's resting state and stays the default: a table that
   * volunteers nine numbers nobody asked for is noise. */
  calc?: AggregateCalc;
}

/**
 * The view kinds (M10, extended M16.22/.27/.28, M29.45). Mutually exclusive —
 * a collection shows one at a time, chosen from the open tab's layout picker.
 *
 * The kinds that draw RECORDS — the same rows, drawn differently:
 *
 * - `table`     — spreadsheet grid with inline-editable cells (M3.4)
 * - `list`      — banded rows
 * - `board`     — kanban columns from the first band level
 * - `calendar`  — month grid, records on their date
 * - `timeline`  — records as bars on a horizontal date axis
 * - `gantt`     — timeline plus scheduling: nested WBS rows, dependency arrows
 * - `gallery`   — a card grid, cards optionally covered by a files property
 * - `chart`     — bar/line/donut over an aggregation of the same rows
 * - `dashboard` — a grid of blocks: saved views and single numbers
 *
 * And the kind that draws a FILE — `canvas: true` in viewKinds.ts, which is
 * what gates it everywhere rather than its name:
 *
 * - `whiteboard` — a `.mmd` the tab owns, edited through the shared diagram
 *   editor. Its records are not laid out FOR the user; they appear where the
 *   user puts them, as nodes bound by a mermaid `click` line (M29.45, D8).
 *
 * The roster is deliberately grouped rather than counted: this docstring said
 * "the six views" in three other files for four milestones while the catalog
 * grew to ten, so prose here names the split, never the number.
 *
 * Two kinds were REMOVED here, and both for the same reason — they were views
 * whose only job was something another axis already does:
 *
 * - `tree` was "the view that can nest", but nesting is a property of the
 *   grouping chain (see GroupSpec.descend), so every view can nest and none of
 *   them needs to be the hierarchy one.
 * - `split` was a master-detail browser, which M9.3's open-in-place detail
 *   panel does from any view.
 *
 * Saved files naming either one migrate to `table` on read (engine/views.ts).
 *
 * The array is the source and the union is derived from it (M16.3), so adding
 * a kind is one edit. It used to be the other way round — a hand-written union
 * beside a hand-written `LAYOUTS` set in views.ts, and forgetting the set made
 * `parseViewType` silently downgrade every saved file of the new kind to
 * `list`, losing the layout with no error anywhere.
 */
export const VIEW_TYPES = [
  'table',
  'list',
  'board',
  'calendar',
  'gantt',
  'timeline',
  'gallery',
  'chart',
  'dashboard',
  'whiteboard',
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

/**
 * How a relation value draws in this view (M11).
 *
 * A related record is a CHIP — a thing you can read and click — not a line of
 * text with an arrow glyph in front of it, which is what it was. The remaining
 * choice is per view, because it is a question about this table's density
 * rather than about the data: `plain` is the chip alone, `type-icon` prefixes
 * each chip with the icon of the type it points at, which earns its pixels only
 * when a field can point at more than one type.
 */
export type ChipStyle = 'plain' | 'type-icon';

/** How wide a gallery card is — a named step, not a pixel count, so the grid
 * stays responsive and two vaults agree on what "medium" looks like. */
/**
 * How tall a table row is. Derived rather than an inline union on
 * `Presentation`, so the settings page offering the choices and the table
 * mapping them to heights cannot list different ones (M16.29).
 */
export const ROW_HEIGHTS = ['compact', 'default', 'tall'] as const;
export type RowHeight = (typeof ROW_HEIGHTS)[number];

/**
 * How big a board card is (M16.20) — Notion's Small / Medium / Large.
 *
 * It sets the column width and the card's density together, because those
 * are one decision: a 240px column with roomy cards shows two of them.
 * Absent means `medium`, which is the size every board rendered at before
 * this was expressible, so no saved view changes appearance.
 */
export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export type CardSize = (typeof CARD_SIZES)[number];

/**
 * The gallery's card settings (M16.22).
 *
 * Which PROPERTIES a card shows is not here: that is `columns`, the same list
 * every other layout reads and the same Properties page configures. A second
 * per-card visibility list would be a second answer to one question, and
 * switching a view from Table to Gallery would lose the columns you chose.
 */
export interface GallerySpec {
  /**
   * Files property whose first value covers the card. Absent = no cover, which
   * is the default: a cover is a choice, and guessing one would silently
   * promote whatever attachment happened to be first.
   */
  cover?: string;
  /* Card SIZE is deliberately not here. It lived here as `size` while the
   * board kept the same setting as a top-level `cardSize`, so one control
   * appeared twice in the settings panel writing two different keys — and
   * whichever one you found, only one of the two layouts read it (M16.29). */
  /** True = the cover is fitted whole inside the tile; absent/false = cropped
   * to fill it. Notion's "Fit media", same default (off). */
  fit?: boolean;
}

export const CHART_KINDS = ['bar', 'line', 'donut', 'number'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/**
 * What a chart's Y axis measures. A SUBSET of RollupCalc, not a new
 * vocabulary: the rollup column and the chart run the same arithmetic
 * (`aggregateNumbers`), so they must not disagree about what "average" means.
 */
export const CHART_AGGS = ['count', 'sum', 'avg'] as const;
export type ChartAgg = Extract<RollupCalc, (typeof CHART_AGGS)[number]>;

/** Band order on the X axis. Absent = the grouping's own declared order. */
export const CHART_SORTS = ['value-desc', 'value-asc', 'label'] as const;
export type ChartSort = (typeof CHART_SORTS)[number];

/** Plot height preset. Absent = 'm', today's 320px. */
export const CHART_HEIGHTS = ['s', 'm', 'l', 'xl'] as const;
export type ChartHeight = (typeof CHART_HEIGHTS)[number];

/**
 * The chart's own settings (M16.27; the axis decoupled in M44.3).
 *
 * The X axis lives here when `xField` names it. Absent, the axis is `group`'s
 * first band level — the same grouping chain every other layout reads — so a
 * saved board re-opened as a chart still charts what the board was banded by,
 * and every chart saved before `xField` existed renders unchanged.
 */
export interface ChartSpec {
  /** Absent = 'bar'. */
  kind?: ChartKind;
  /** Absent = 'count' — the one measure that needs no property configured. */
  agg?: ChartAgg;
  /** The property summed or averaged. Unread when the measure is count. */
  value?: string;
  /** Drop bands that measure zero. Notion's "Omit zero values". */
  omitZero?: boolean;
  /** Bar kind only: bands run down the page and bars extend right. */
  horizontal?: boolean;
  /** Band order. Absent = the grouping's declared order carries over. */
  sort?: ChartSort;
  /** Bar/line only: each band adds every band before it (running total). */
  cumulative?: boolean;
  /** Absent = 'm'. */
  height?: ChartHeight;
  /** One hue for every band (an option-colour word). Absent = per-option. */
  palette?: string;
  /** With `palette`: deeper shade = bigger value. */
  colorByValue?: boolean;
  /** Style switches, stored only when true — true is always the off-default. */
  hideGrid?: boolean;
  hideAxis?: boolean;
  hideLabels?: boolean;
  /** Line kind: curve through the points instead of straight segments. */
  smooth?: boolean;
  /** Line kind: wash the region under the line. */
  area?: boolean;
  /** Donut kind: drop the centre total. */
  hideDonutCenter?: boolean;
  /** Absent = the kind's own default: a donut shows one, the rest don't. */
  legend?: boolean;
  /** The X axis property (M44.3). Absent = the view's grouping chain's first
   * band — the M16.27 default, kept so every saved chart renders unchanged. */
  xField?: string;
  /** Second dimension: splits each band into stacked/series parts (M44.3).
   * Unread by donut and number. */
  groupBy?: string;
  /** Band keys the legend has hidden. Totals and the ring reflect the rest. */
  hidden?: string[];
  /** Series keys the legend has hidden. */
  hiddenG?: string[];
}

/**
 * One widget of a dashboard (M44.4; blocks[] was M16.28's shape).
 *
 * Two data flows, on purpose:
 *
 * - `view` embeds a SAVED VIEW from the vault by reference — a List and one
 *   of its tabs, addressed the way a selection addresses one. Widgets
 *   spanning several sources is what makes a dashboard worth having, and it
 *   carries the reference, never a copy of the view's configuration; editing
 *   the List updates every dashboard showing it.
 * - every other kind reads the DASHBOARD'S OWN rows, so the view's filters,
 *   the Global filter, and the widget's own filter all scope it.
 */
export type DashboardWidget =
  | (DashboardWidgetBase & {
      kind: 'view';
      /** List id. Ids are unique per folder, hence `collection` beside it. */
      list: string;
      collection?: string | null;
      /** Which of the List's tabs; absent = its first. */
      view?: string;
    })
  | (DashboardWidgetBase & {
      kind: 'number';
      agg: ChartAgg;
      /** Property summed or averaged. Unread when the measure is count. */
      value?: string;
    })
  | (DashboardWidgetBase & { kind: 'table' })
  | (DashboardWidgetBase & {
      kind: 'board';
      /** Property to band by. Absent = the source's status field. */
      group?: string;
    })
  | (DashboardWidgetBase & { kind: 'timeline' })
  | (DashboardWidgetBase & {
      kind: 'chart';
      /** The X axis property. Absent = the chart draws its no-group refusal. */
      group?: string;
      chart?: ChartSpec;
    });

export interface DashboardWidgetBase {
  /** Unique within the dashboard; what a move, a resize and a delete address. */
  id: string;
  /** Overrides the computed name in the widget header. */
  title?: string;
  /** Width weight within the row, >= 1. Absent = 1 — equal shares. */
  w?: number;
  /** This widget's own filter, ANDed under the Global filter. */
  filter?: FilterGroup;
}

export interface DashboardRow {
  id: string;
  /** Row height in px. Absent = 300, the M16.28 tile height. */
  h?: number;
  /** Left to right. 1..MAX_ROW_WIDGETS. */
  widgets: DashboardWidget[];
}

export interface DashboardSpec {
  /** Top to bottom. Never absent — an emptied dashboard is `rows: []` and
   * says so, rather than being indistinguishable from an unparsed one. */
  rows: DashboardRow[];
  /** ANDed onto every own-scope widget, under the view's own filters. */
  global?: FilterGroup;
}

export const MAX_ROW_WIDGETS = 4;
export const MAX_DASHBOARD_WIDGETS = 12;
export const ROW_HEIGHT_DEFAULT = 300;
export const ROW_HEIGHT_MIN = 200;
export const ROW_HEIGHT_MAX = 640;
/**
 * What a board card previews above its properties (M16.20).
 *
 * Notion offers None / Page cover / Page content. **Page cover is
 * deliberately absent**: a record has no cover — `Entry` carries a per-TYPE
 * icon and nothing per record — so the option would be a menu row that
 * changes nothing on screen, which is the exact class of control this
 * milestone exists to delete. It becomes offerable the day records carry
 * one (M16.22's gallery needs the same thing).
 *
 * `content` renders `Entry.snippet` — the first ~160 characters of the body,
 * which the scanner has produced since v1 and which, outside the Inbox
 * queue's rows, no surface has shown.
 */
export const CARD_PREVIEWS = ['none', 'content'] as const;
export type CardPreview = (typeof CARD_PREVIEWS)[number];

export interface Presentation {
  type: ViewType;
  /** Ordered grouping chain; empty = flat. */
  group: GroupSpec[];
  /** Ordered sort chain; never empty in practice (parse supplies a default). */
  sort: SortSpec[];
  columns: ColumnSpec[];
  rowHeight?: RowHeight;
  /** Width of the sticky name column. Omitted = the layout's default. */
  titleWidth?: number;
  /**
   * How many columns pin to the left edge, counted in DISPLAY slots (M16.18).
   *
   * Replaces `titleFrozen`, which could only ever answer for the name column
   * and only while it was first — Notion freezes UP TO a column, and a table
   * whose first three columns are identity ought to be able to say so. A
   * saved `titleFrozen: false` migrates to 0 on read.
   *
   * Omitted means "the name column, if it leads": the M12.8 default, stated
   * once rather than recomputed at each reader.
   */
  frozenColumns?: number;
  /** The name column's index among the visible columns. Omitted = first. */
  titlePosition?: number;
  /** The name column's footer calculation (M16.15). It is a column like any
   * other since M12.8, but it has no ColumnSpec to carry this on. */
  titleCalc?: AggregateCalc;
  /** Relation/person chip rendering; defaults to 'plain'. */
  chips?: ChipStyle;
  /** Card density for every layout that draws cards; omitted = 'medium'. A
   * pre-M16.29 gallery stored this as `gallery.size` and is migrated on read. */
  cardSize?: CardSize;
  /** Board card preview block; omitted = 'none'. */
  cardPreview?: CardPreview;
  /**
   * Paint each board column in its own option colour (Notion's "Color
   * columns"). Off unless asked for: the colour is already carried by the
   * dot in the header, and ten tinted columns is a lot of paint to acquire
   * by accident.
   */
  colorColumns?: boolean;
  /**
   * Date property placing records on the calendar/timeline/gantt axis. Omitted
   * means "infer it" — engine/schedule.ts picks the type's first daterange, or
   * failing that its first date field, so a calendar works before anyone has
   * configured one.
   */
  dateField?: string;
  /** Axis granularity for timeline and gantt. */
  zoom?: 'day' | 'week' | 'month' | 'quarter';
  /**
   * Relation field naming the records this one waits on — the arrows a gantt
   * draws. Omitted means no dependency layer, not "guess a relation": a wrong
   * guess here draws a schedule that isn't the one the data states.
   */
  dependencyField?: string;
  /** Gallery card settings (M16.22). Absent = every default. */
  gallery?: GallerySpec;
  /** Chart settings (M16.27). Absent = a bar chart counting records. */
  chart?: ChartSpec;
  /** Dashboard rows of widgets (M44.4). Absent = an empty dashboard. */
  dashboard?: DashboardSpec;
  /**
   * The whiteboard's canvas (M29.45): a vault-relative `.mmd` path, created
   * on first open (spec D8). `file: null` is representable in memory — the
   * "not created yet" state the view acts on — but never written: the
   * serializer drops it, so a fresh tab's YAML carries no key about a file
   * that does not exist, the same stored-only-off-default rule every other
   * layout block follows.
   */
  whiteboard?: { file: string | null };
  /** How much of the calendar one screen holds. Omitted = a month (M16.23). */
  calendarSpan?: 'month' | 'week';
  /** False drops Saturday and Sunday from the grid. Stored only when false. */
  showWeekends?: boolean;
  /**
   * The weekday a grid row begins on. A name, not an index: a vault is edited
   * by hand, and `weekStart: 1` is a number you have to know the convention for.
   */
  weekStart?: 'sunday' | 'monday';
  /**
   * Whether a timeline/gantt draws its rows as a table beside the axis
   * (M16.24). Omitted takes the layout's own default — a work breakdown is the
   * point of a gantt, and optional chrome on a timeline.
   */
  showTable?: boolean;
  /**
   * How many records the view draws before it stops (M16.26). Omitted means
   * all of them, which is what every view did — Notion's default is 25.
   *
   * Truncation is never silent: the surfaces that apply this render a footer
   * saying how many of how many are shown, because a view that hides records
   * without saying so is indistinguishable from a filter that is wrong.
   */
  limit?: number;
}

/**
 * How a tree finds a row's children (M3.5). `forward` follows a relation the
 * PARENT holds; `reverse` inverts a relation the CHILD holds, so a hierarchy
 * works whichever side of the link the data lives on.
 */
export type ChildrenSpec =
  { direction: 'forward'; field: string } | { direction: 'reverse'; type: string; field: string };

/**
 * Every filter operator, as an array with the union derived from it (M16.25).
 *
 * The union was hand-written here and `views.ts` kept a hand-written
 * `FILTER_OPS: FilterOp[]` beside it — and that array is the READ-SIDE
 * allowlist: `parseFilterNode` returns null for any op not in it. An operator
 * added to the union and forgotten there therefore parsed as a malformed node
 * and was DROPPED on load, so a saved view came back missing a condition and
 * quietly showed records it had been configured to hide. Same shape as
 * `FIELD_KINDS` and `VIEW_TYPES`, for the same reason.
 *
 * Order here is menu order.
 */
export const FILTER_OPS = [
  'equals',
  'not_equals',
  'contains',
  'does_not_contain',
  'starts_with',
  'ends_with',
  'any_of',
  'none_of',
  'gt',
  'gte',
  'lt',
  'lte',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'is_between',
  'is_empty',
  'is_not_empty',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * Which comparisons a property kind admits (M16.25).
 *
 * A date wants before/after, a number wants >/</between, prose wants
 * starts-with — and offering all nineteen operators on every kind, which is
 * what the builder did, meant "Status is before High" was one click away and
 * evaluated to a string comparison nobody asked for.
 *
 * The kind→family answer is a flag on `KIND_META` (properties.ts) so
 * `satisfies Record<FieldKind, …>` forces every new kind to answer it; the
 * family→operators answer lives in `viewFilters.ts` beside the evaluator that
 * implements them. `any` is the rollup's honest answer: what a rollup holds
 * depends on its `calculate`, which is not knowable from the kind alone.
 */
export const FILTER_FAMILIES = [
  'text',
  'number',
  'date',
  'choice',
  'multi',
  'boolean',
  'any',
] as const;
export type FilterFamily = (typeof FILTER_FAMILIES)[number];

export interface FilterRule {
  field: string;
  op: FilterOp;
  /** `is_between` stores its two bounds as a two-element list. */
  value?: Scalar | Scalar[];
}
export type FilterGroup =
  { all: (FilterRule | FilterGroup)[] } | { any: (FilterRule | FilterGroup)[] };

/**
 * What a List looks at (M3.5). A List is rooted in a type — the Notion model:
 * a type is a database, a List is a saved query over it. `project` narrows to
 * one project's records, which is how a "project" becomes a List rather than a
 * hardcoded surface.
 */
export interface ListSource {
  /** Type name whose records this List holds; null = every record. */
  type: string | null;
  /** Path of a project.md to scope to via containment; null = whole vault. */
  project: string | null;
}

/**
 * One saved view of a List (M11): a tab.
 *
 * A List used to carry exactly one `presentation` and one `filters`, which
 * meant "show me this board AND that calendar over the same records" was two
 * Lists holding two copies of the same query — and editing the query meant
 * editing it twice. Notion and ClickUp both resolve this the same way and it is
 * the right resolution: the LIST is the database, a VIEW is a way of looking at
 * it, and a database has as many as you make.
 *
 * Filters live here rather than on the List for the same reason: "only the ones
 * at risk" is a way of looking, not a different set of records.
 */
export interface ViewDefinition {
  /** Stable slug, unique within the List. What a tab is addressed by. */
  id: string;
  name: string;
  icon: string | null;
  filters: FilterGroup | null;
  presentation: Presentation;
}

export interface ListDefinition {
  name: string;
  icon: string | null;
  color: string | null;
  order: number | null;
  source: ListSource;
  /**
   * The List's views, in tab order. NEVER empty — the parser synthesizes one
   * from a pre-M11 file's `presentation`/`filters`, so "a List with no way to
   * look at it" is not representable and no caller has to handle it.
   */
  views: ViewDefinition[];
}

/**
 * A List: a database of typed records with one active view (M10).
 *
 * This is what a saved view was. The rename is not cosmetic — a view was both
 * the container and the query, and M10 splits those: a Collection contains, a
 * List queries.
 */
export interface ListFile {
  /** Filename stem — unique within its folder. */
  id: string;
  definition: ListDefinition;
  /** Owning project.md path for a legacy project-scoped view; else null. */
  project: string | null;
  /**
   * Folder of the owning Collection, or null for a top-level List — which is
   * how a pre-M10 `views/*.yml` surfaces, so no vault has to be migrated.
   */
  collection: string | null;
  /** Vault-relative file path — what rename and delete operate on. */
  path: string;
}

/**
 * A Collection: a container, and nothing else (M10).
 *
 * It holds Lists, Folders, and Docs, and deliberately carries no query of its
 * own — that is what its Lists are for. On disk it is a FOLDER holding a
 * `collection.yml`, the same shape a project uses, because in a markdown app a
 * container on screen should be a container on disk.
 */
export interface CollectionDefinition {
  name: string;
  icon: string | null;
  color: string | null;
  order: number | null;
  /**
   * What this container is for, in the owner's words (M11). Shown on the
   * Collection's home page and nowhere else — a sidebar row has no space for
   * prose, and a container that has to explain itself in a tooltip is one
   * nobody reads.
   */
  description: string | null;
}

export interface CollectionFile {
  /** Vault-relative folder path, e.g. "product". Its identity. */
  folder: string;
  definition: CollectionDefinition;
  /**
   * True when a `collection.yml` exists on disk.
   *
   * False for a folder that is a Collection purely because it holds Lists — the
   * rule that makes a Collection-less List unrepresentable. Such a folder has
   * nothing stored about it, so there is nothing to remove and its name is its
   * folder; it becomes declared the first time someone renames or restyles it.
   */
  declared: boolean;
}

/**
 * One node of the sidebar's Collections tree (M10). A Collection contains
 * Lists, Folders, and Docs; a Folder contains the same three, recursively.
 */
export type CollectionNodeKind = 'collection' | 'folder' | 'list' | 'doc';

export interface CollectionNode {
  kind: CollectionNodeKind;
  /** Folder path for a collection/folder, file path for a doc, id for a list. */
  id: string;
  label: string;
  icon: string;
  color: string | null;
  children: CollectionNode[];
  /** Set on `list` nodes — the file this node navigates to. */
  list?: ListFile;
  /** Set on `doc` nodes — the markdown path this node opens. */
  path?: string;
}

export interface Group {
  key: string;
  label: string;
  color: string | null;
  ghost: boolean;
  entries: Entry[];
}
// groupEntries emits empty declared option/status groups (boards need the columns) and a trailing
// no-value group with key '__none__' (label 'No <field>') — pinned; BoardView/ListView rely on it.

/**
 * A node in a nested grouping (M9.1). `entries` is populated on LEAF nodes
 * only; interior nodes carry `children`. `count` is the recursive total, so a
 * collapsed parent still reports how much is inside it rather than zero.
 *
 * `path` is the chain of group keys from the root, joined — the stable
 * identity a collapse-state map keys on.
 */
export interface GroupNode extends Group {
  depth: number;
  field: string;
  path: string;
  children: GroupNode[];
  count: number;
}

export interface Schema {
  types: Map<string, TypeDef>;
  /** Reverse link index (M3.5) — see engine/relations.ts. */
  relations: RelationIndex;
  projectForEntry(e: Entry): Entry | null; // containment: Entry.project → project.md entry
  // Status resolution chain (v2, locked decision 4): project.md `statuses:`
  // override → Work item Type doc `statuses:` → DEFAULT_STATUSES.
  statusSetForProject(projectPath: string | null): StatusDef[];
  // M3.1: the same chain with the entry's OWN type consulted before the
  // Work item fallback, so every type can carry its own status set.
  statusSetFor(entry: Entry): StatusDef[];
  /** Which link in that chain answered — the inline status creator needs to
   * know, because writing to the type is a silent no-op under a project
   * override (M16.12). */
  statusSourceFor(entry: Entry): 'project' | 'type' | 'default';
  resolveField(e: Entry, field: string): ResolvedField;
}
