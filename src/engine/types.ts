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
}

export interface ResolvedField {
  def: FieldDef | null; // null → undeclared field (advisory: still shown as text)
  raw: unknown;
  display: string; // '' when empty
  color: string | null;
  ghost: boolean; // value not in the declared option set
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
  | { kind: 'inbox' } // capture queue: unorganized notes (M4)
  // AI knowledge base: OKF bundle, read-only (M5); `nav` defaults to all (M8.1).
  // `path` deep-links one concept, so knowledge surfaced beside your work
  // (M8.3) can actually be opened rather than only named.
  | { kind: 'knowledge'; nav?: KnowledgeNav; path?: string }
  // M12.5: `project` retired — a project is a folder, and a folder with
  // things in it is a Collection. Legacy project.md files open as records.
  | { kind: 'doc'; path: string } // full-page markdown document (M2 Task 10)
  | { kind: 'docs' } // all-docs rail surface (M2 Task 11)
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
 *
 * The array is the source and the union is derived from it (M16.3), so adding
 * a kind is one edit. It used to be the other way round — a hand-written union
 * beside a hand-written `LAYOUTS` set in views.ts, and forgetting the set made
 * `parseViewType` silently downgrade every saved file of the new kind to
 * `list`, losing the layout with no error anywhere.
 */
export const VIEW_TYPES = ['table', 'list', 'board', 'calendar', 'gantt', 'timeline'] as const;

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

export interface Presentation {
  type: ViewType;
  /** Ordered grouping chain; empty = flat. */
  group: GroupSpec[];
  /** Ordered sort chain; never empty in practice (parse supplies a default). */
  sort: SortSpec[];
  columns: ColumnSpec[];
  rowHeight?: 'compact' | 'default' | 'tall';
  /** Width of the sticky name column. Omitted = the layout's default. */
  titleWidth?: number;
  /** False = the name column scrolls with the grid instead of pinning left.
   * Only meaningful while the name column is first (M12.8). */
  titleFrozen?: boolean;
  /** The name column's index among the visible columns. Omitted = first. */
  titlePosition?: number;
  /** Relation/person chip rendering; defaults to 'plain'. */
  chips?: ChipStyle;
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
  { direction: 'forward'; field: string } | { direction: 'reverse'; type: string; field: string };

export type FilterOp =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'any_of'
  | 'none_of'
  | 'is_empty'
  | 'is_not_empty'
  | 'before'
  | 'after';
export interface FilterRule {
  field: string;
  op: FilterOp;
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
  resolveField(e: Entry, field: string): ResolvedField;
}
