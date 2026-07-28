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

export type Selection =
  | { kind: 'home' }
  | { kind: 'project'; path: string }  // path of the project.md (vault format v2)
  | { kind: 'doc'; path: string }      // full-page markdown document (M2 Task 10)
  | { kind: 'docs' }                   // all-docs rail surface (M2 Task 11)
  | { kind: 'view'; id: string }       // id = filename stem in views/
  | { kind: 'type'; name: string }     // type screen: records + configuration (M3)
  | { kind: 'settings' };

export interface Presentation {
  // 'split' = master-detail record browser (M3): rows | doc editor | properties
  // 'table' = spreadsheet grid with inline-editable cells (M3.4)
  // 'tree'  = hierarchy outline following a relation (M3.5)
  type: 'list' | 'board' | 'split' | 'table' | 'tree';
  groupBy: string | null;              // field name; null = flat list
  orderBy: { field: string; dir: 'asc' | 'desc' };
  visibleFields: string[];
  /** Tree layout only: which relation to descend for child rows. */
  childrenVia?: ChildrenSpec | null;
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
