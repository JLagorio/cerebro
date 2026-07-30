import type { RelationIndex } from './relations';

export type Scalar = string | number | boolean | null;

export interface Entry {
  path: string;                 // vault-relative, e.g. "items/fld-7.md"
  filename: string;             // "fld-7.md"
  folder: string;               // vault-relative parent dir ('' at the root) — vault format v2
  project: string | null;       // owning project.md path via containment (nearest ancestor
                                // directory holding a project.md), null outside any project
  title: string;                // first H1, else humanized filename stem
  type: string | null;          // frontmatter `type`
  properties: Record<string, Scalar | Scalar[]>;   // scalar frontmatter (non-wikilink); nested YAML
                                                   // (type-note `fields:`, space `statuses:`) passes
                                                   // through as raw nested values — consumers cast
  relationships: Record<string, string[]>;         // wikilink-valued fields → raw targets
  outgoingLinks: string[];      // wikilink targets found in the body
  snippet: string;              // first ~160 chars of body text, markdown-stripped
  createdAt: string;            // ISO 8601
  modifiedAt: string;           // ISO 8601
  parseError: string | null;    // YAML error message, or null
}

export type FieldKind =
  | 'text' | 'number' | 'checkbox' | 'date' | 'daterange'
  | 'select' | 'multiselect' | 'status' | 'person' | 'relation'
  | 'url' | 'files' | 'rollup' | 'created_time' | 'last_edited_time';

export type RollupCalc =
  | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'earliest' | 'latest' | 'show';

export interface FieldOption { id: string; label: string; color: string | null; hollow?: boolean }
export interface StatusDef extends FieldOption { group: 'active' | 'done' | 'closed' }
/** How a numeric value is displayed. Stored value never changes — a percent
 * is still `76` on disk (M3.4: the Notion "Progress · 0% Complete" bar). */
export type FieldFormat = 'plain' | 'percent' | 'progress' | 'currency';

export interface FieldDef {
  name: string;
  kind: FieldKind;
  options?: FieldOption[];
  target?: string;
  /** rollup config: aggregate `property` across the `relation` field's targets. */
  relation?: string;
  /** Reverse rollup source (M3.5): aggregate the records of `type` whose
   * `field` points back at this one — no duplicate link on the parent. */
  from?: { type: string; field: string };
  property?: string;
  calculate?: RollupCalc;
  /** display format for number/rollup values; defaults to 'plain'. */
  format?: FieldFormat;
  /** decimal places for numeric formats; defaults to 2 (trailing zeros trimmed). */
  precision?: number;
}

export interface TypeDef {
  name: string;
  icon: string | null;
  color: string | null;
  fields: FieldDef[];
  /** Where the type's notes live in the UI: 'record' (its type screen only —
   * the default) or 'doc' (also browsable in the Docs file tree). Declared as
   * `display:` on the Type doc; keeps one surface per shape (M3.1). */
  display: 'doc' | 'record';
  /** `statuses:` declared on this Type doc; [] when it declares none. */
  statuses: StatusDef[];
}

export interface ResolvedField {
  def: FieldDef | null;         // null → undeclared field (advisory: still shown as text)
  raw: unknown;
  display: string;              // '' when empty
  color: string | null;
  ghost: boolean;               // value not in the declared option set
}

/**
 * Which slice of the knowledge bundle is on screen (M8.1). Knowledge navigates
 * by its own axes — the bundle's sections, the entities concepts are about,
 * and the update log — rather than borrowing Home's Views and Types, which
 * describe a different corpus with a different author.
 */
export type KnowledgeNav =
  | { tab: 'all' }
  | { tab: 'review' }
  | { tab: 'log' }
  | { tab: 'section'; folder: string }
  | { tab: 'entity'; key: string };

export type Selection =
  | { kind: 'home' }
  | { kind: 'inbox' }                  // capture queue: unorganized notes (M4)
  // AI knowledge base: OKF bundle, read-only (M5); `nav` defaults to all (M8.1).
  // `path` deep-links one concept, so knowledge surfaced beside your work
  // (M8.3) can actually be opened rather than only named.
  | { kind: 'knowledge'; nav?: KnowledgeNav; path?: string }
  | { kind: 'project'; path: string }  // path of the project.md (vault format v2)
  | { kind: 'doc'; path: string }      // full-page markdown document (M2 Task 10)
  | { kind: 'docs' }                   // all-docs rail surface (M2 Task 11)
  | { kind: 'view'; id: string }       // id = filename stem in views/
  | { kind: 'type'; name: string }     // type screen: records + configuration (M3)
  // M9.4 — git surfaces. `changes` is the uncommitted working tree (with
  // conflict resolution when there is one); `pulse` is the committed history.
  | { kind: 'changes' }
  | { kind: 'pulse' }
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
}

/**
 * The six record views (M10). Mutually exclusive — a collection shows one at a
 * time, chosen from the toolbar.
 *
 * - `table`    — spreadsheet grid with inline-editable cells (M3.4)
 * - `list`     — banded rows
 * - `board`    — kanban columns from the first band level
 * - `calendar` — month grid, records on their date
 * - `timeline` — records as bars on a horizontal date axis
 * - `gantt`    — timeline plus scheduling: nested WBS rows, dependency arrows
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
 */
export type ViewType = 'table' | 'list' | 'board' | 'calendar' | 'gantt' | 'timeline';

export interface Presentation {
  type: ViewType;
  /** Ordered grouping chain; empty = flat. */
  group: GroupSpec[];
  /** Ordered sort chain; never empty in practice (parse supplies a default). */
  sort: SortSpec[];
  columns: ColumnSpec[];
  rowHeight?: 'compact' | 'default' | 'tall';
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
}

/**
 * How a tree finds a row's children (M3.5). `forward` follows a relation the
 * PARENT holds; `reverse` inverts a relation the CHILD holds, so a hierarchy
 * works whichever side of the link the data lives on.
 */
export type ChildrenSpec =
  | { direction: 'forward'; field: string }
  | { direction: 'reverse'; type: string; field: string };

export type FilterOp =
  | 'equals' | 'not_equals' | 'contains' | 'any_of' | 'none_of'
  | 'is_empty' | 'is_not_empty' | 'before' | 'after';
export interface FilterRule { field: string; op: FilterOp; value?: Scalar | Scalar[] }
export type FilterGroup = { all: (FilterRule | FilterGroup)[] } | { any: (FilterRule | FilterGroup)[] };

/**
 * What a view looks at (M3.5). A view is rooted in a type — the Notion model:
 * a type is a database, a view is a saved query over it. `project` narrows to
 * one project's records, which is how a "project" becomes a saved view rather
 * than a hardcoded surface.
 */
export interface ViewSource {
  /** Type name whose records this view lists; null = every record. */
  type: string | null;
  /** Path of a project.md to scope to via containment; null = whole vault. */
  project: string | null;
}

export interface ViewDefinition {
  name: string; icon: string | null; color: string | null; order: number | null;
  source: ViewSource;
  filters: FilterGroup | null; presentation: Presentation;
}
export interface ViewFile {
  id: string;                          // filename stem; unique within its scope's views/ dir
  definition: ViewDefinition;
  project: string | null;              // owning project.md path (projects/x/views/*.yml), null = vault-global
}

export interface Group { key: string; label: string; color: string | null; ghost: boolean; entries: Entry[] }
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
  projectForEntry(e: Entry): Entry | null;                      // containment: Entry.project → project.md entry
  // Status resolution chain (v2, locked decision 4): project.md `statuses:`
  // override → Work item Type doc `statuses:` → DEFAULT_STATUSES.
  statusSetForProject(projectPath: string | null): StatusDef[];
  // M3.1: the same chain with the entry's OWN type consulted before the
  // Work item fallback, so every type can carry its own status set.
  statusSetFor(entry: Entry): StatusDef[];
  resolveField(e: Entry, field: string): ResolvedField;
}
