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
  | 'select' | 'multiselect' | 'status' | 'person' | 'relation';

export interface FieldOption { id: string; label: string; color: string | null; hollow?: boolean }
export interface StatusDef extends FieldOption { group: 'active' | 'done' | 'closed' }
export interface FieldDef { name: string; kind: FieldKind; options?: FieldOption[]; target?: string }
export interface TypeDef { name: string; icon: string | null; color: string | null; fields: FieldDef[] }

export interface ResolvedField {
  def: FieldDef | null;         // null → undeclared field (advisory: still shown as text)
  raw: unknown;
  display: string;              // '' when empty
  color: string | null;
  ghost: boolean;               // value not in the declared option set
}

export type Selection =
  | { kind: 'home' }
  | { kind: 'space'; path: string }
  | { kind: 'project'; path: string }
  | { kind: 'view'; id: string }       // id = filename stem in views/
  | { kind: 'settings' };

export interface Presentation {
  type: 'list' | 'board';
  groupBy: string | null;              // field name; null = flat list
  orderBy: { field: string; dir: 'asc' | 'desc' };
  visibleFields: string[];
}

export type FilterOp =
  | 'equals' | 'not_equals' | 'contains' | 'any_of' | 'none_of'
  | 'is_empty' | 'is_not_empty' | 'before' | 'after';
export interface FilterRule { field: string; op: FilterOp; value?: Scalar | Scalar[] }
export type FilterGroup = { all: (FilterRule | FilterGroup)[] } | { any: (FilterRule | FilterGroup)[] };

export interface ViewDefinition {
  name: string; icon: string | null; color: string | null; order: number | null;
  filters: FilterGroup | null; presentation: Presentation;
}
export interface ViewFile { id: string; definition: ViewDefinition }

export interface Group { key: string; label: string; color: string | null; ghost: boolean; entries: Entry[] }
// groupEntries emits empty declared option/status groups (boards need the columns) and a trailing
// no-value group with key '__none__' (label 'No <field>') — pinned; BoardView/ListView rely on it.

export interface Schema {
  types: Map<string, TypeDef>;
  spaceForEntry(e: Entry): Entry | null;                    // item → project → space (via relationships)
  statusSetForSpace(spacePath: string | null): StatusDef[]; // null/space w/o statuses → DEFAULT_STATUSES
  resolveField(e: Entry, field: string): ResolvedField;
}
