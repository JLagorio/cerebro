import type {
  DisplayConfig,
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  FieldVisibility,
  LayoutConfig,
  ResolvedField,
  Schema,
  StatusDef,
  TypeDef,
} from './types';
import { DISPLAY_DEFAULTS, FIELD_KINDS, FIELD_VISIBILITIES, LAYOUT_DEFAULTS } from './types';
import {
  DATE_DISPLAY_FORMATS,
  DEFAULT_TIME_FORMAT,
  TIME_DISPLAY_FORMATS,
  formatDateValue,
  parseDateProperty,
  toIsoDate,
} from './dates';
import { applyFormat, computeRollup, formatNumber, formatTimestamp } from './properties';
import { buildRelationIndex, childrenOf } from './relations';
import { parseTabList, parseViewList } from './views';
import { resolveTarget } from './wikilink';

/** Spec "simple" status template — fallback when no type/project declares statuses. */
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
  { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', hollow: true, group: 'closed' },
];

const ROLLUP_CALCS = ['count', 'sum', 'avg', 'min', 'max', 'earliest', 'latest', 'show'];

const FIELD_FORMATS = ['plain', 'percent', 'progress', 'currency'];

const STATUS_GROUPS = ['active', 'done', 'closed'] as const;

/** 'in-progress' → 'In progress' (sentence case, DS rule). */
export function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  if (words === '') return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * M16.4: the allowlist is FIELD_KINDS from types.ts now. It used to be a
 * second hand-written copy here, and a kind missing from it fell through to
 * `text` — silently, so a declared Select rendered as a text box.
 */
function asFieldKind(value: unknown): FieldKind {
  return (FIELD_KINDS as readonly string[]).includes(value as string)
    ? (value as FieldKind)
    : 'text';
}

function parseOption(raw: unknown): FieldOption | null {
  if (typeof raw === 'string') {
    return { id: raw, label: humanize(raw), color: null };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' && typeof o.id !== 'number') return null;
  const id = String(o.id);
  const option: FieldOption = {
    id,
    label: typeof o.label === 'string' ? o.label : humanize(id),
    color: typeof o.color === 'string' ? o.color : null,
  };
  if (o.hollow === true) option.hollow = true;
  return option;
}

function parseFieldDef(name: string, spec: unknown): FieldDef {
  if (typeof spec === 'string') return { name, kind: asFieldKind(spec) };
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { name, kind: 'text' };
  }
  const s = spec as Record<string, unknown>;
  const def: FieldDef = { name, kind: asFieldKind(s.kind) };
  if (Array.isArray(s.options)) {
    def.options = s.options.map(parseOption).filter((o): o is FieldOption => o !== null);
  }
  if (typeof s.target === 'string') def.target = s.target;
  // Relation cardinality (M12.4): `limit: 1` means a single linked record.
  if (s.limit === 1 || s.limit === '1') def.limit = 1;
  // Rollup config: which relation to follow, what to read, how to fold it.
  if (typeof s.relation === 'string') def.relation = s.relation;
  if (typeof s.property === 'string') def.property = s.property;
  if (typeof s.calculate === 'string' && ROLLUP_CALCS.includes(s.calculate)) {
    def.calculate = s.calculate as FieldDef['calculate'];
  }
  // Reverse rollup source (M3.5): `from: { type, field }`.
  const from = s.from;
  if (from !== null && typeof from === 'object' && !Array.isArray(from)) {
    const f = from as Record<string, unknown>;
    if (typeof f.type === 'string' && typeof f.field === 'string') {
      def.from = { type: f.type, field: f.field };
    }
  }
  if (typeof s.format === 'string' && FIELD_FORMATS.includes(s.format)) {
    def.format = s.format as FieldDef['format'];
  }
  if (typeof s.precision === 'number' && Number.isFinite(s.precision)) {
    def.precision = Math.max(0, Math.min(6, Math.trunc(s.precision)));
  }
  // M16.14. `dateFormat`, not `format` — numbers already own that key, and a
  // single key holding two unrelated enums would survive a kind change into a
  // field that cannot read it.
  if (
    typeof s.dateFormat === 'string' &&
    (DATE_DISPLAY_FORMATS as readonly string[]).includes(s.dateFormat)
  ) {
    def.dateFormat = s.dateFormat as FieldDef['dateFormat'];
  }
  if (
    typeof s.timeFormat === 'string' &&
    (TIME_DISPLAY_FORMATS as readonly string[]).includes(s.timeFormat)
  ) {
    def.timeFormat = s.timeFormat as FieldDef['timeFormat'];
  }
  // M16.10. An unrecognised value is dropped rather than guessed at: a
  // property nobody can find is worse than one shown when it need not be.
  if (
    typeof s.visibility === 'string' &&
    (FIELD_VISIBILITIES as readonly string[]).includes(s.visibility)
  ) {
    def.visibility = s.visibility as FieldVisibility;
  }
  return def;
}

function parseFields(raw: unknown): FieldDef[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, spec]) =>
    parseFieldDef(name, spec),
  );
}

function parseStatuses(raw: unknown): StatusDef[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusDef[] = [];
  for (const item of raw) {
    const option = parseOption(item);
    if (option === null) continue;
    const groupRaw =
      item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>).group
        : undefined;
    const group: StatusDef['group'] =
      typeof groupRaw === 'string' && (STATUS_GROUPS as readonly string[]).includes(groupRaw)
        ? (groupRaw as StatusDef['group'])
        : 'active';
    out.push({ ...option, group });
  }
  return out;
}

/** `display:` is advisory, like every Type-doc block: malformed → defaults. */
function parseDisplayConfig(raw: unknown): DisplayConfig {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    showEmpty: obj.show_empty === true,
    showFile: obj.show_file === true,
    showBody: obj.show_body !== false,
  };
}

/** DisplayConfig → the `display:` frontmatter value. Deviations only; all
 * defaults = null, which patchFrontmatter spells "delete the key". */
export function serializeDisplayConfig(d: DisplayConfig): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (d.showEmpty !== DISPLAY_DEFAULTS.showEmpty) out.show_empty = d.showEmpty;
  if (d.showFile !== DISPLAY_DEFAULTS.showFile) out.show_file = d.showFile;
  if (d.showBody !== DISPLAY_DEFAULTS.showBody) out.show_body = d.showBody;
  return Object.keys(out).length === 0 ? null : out;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** A minted `group-N` id, checked against a `taken` set that already holds
 * every id ANY group in the list legitimately declares — earlier or later —
 * so a blind `group-${i + 1}` guess can never steal a declared id (the
 * parseTabList two-pass shape; ids matter to the layout editor's drag
 * model). */
function mintGroupId(i: number, taken: Set<string>): string {
  let n = i + 1;
  while (taken.has(`group-${n}`)) n += 1;
  return `group-${n}`;
}

/** Field names claimed into `into`, honoring the cross-container claim set:
 * a name appears at most once across heading + all groups, first claim
 * wins, so no consumer ever dedups. Non-strings and blanks are dropped —
 * `layout:` is advisory, like every Type-doc block. */
function claimFieldNames(raw: unknown, claimed: Set<string>): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '' || claimed.has(name)) continue;
    claimed.add(name);
    out.push(name);
  }
  return out;
}

/** `layout:` is advisory, like every Type-doc block: malformed → defaults.
 * Exported — unlike parseDisplayConfig — for the M45.2 layout editor's
 * draft seeding: this parser has a consumer beyond buildSchema coming. */
export function parseLayoutConfig(raw: unknown): LayoutConfig {
  const obj = asRecord(raw);
  const claimed = new Set<string>();
  const heading = claimFieldNames(obj.heading, claimed);

  const items = Array.isArray(obj.groups) ? obj.groups.map((g) => asRecord(g)) : [];
  const declaredIds = items.map((g) =>
    typeof g.id === 'string' && g.id.trim() !== '' ? g.id.trim() : '',
  );
  const taken = new Set<string>();
  const owns = declaredIds.map((id) => {
    // 'heading' and 'rest' are container ADDRESSES, not ids a group may wear:
    // layoutEdit's grammar is 'heading' | 'rest' | groupId, and the editor's
    // droppable ids extend it — a group declaring a sentinel would swallow
    // drops meant for the real container (id: rest = silent deletion). A
    // hand-written sentinel re-mints, exactly like a duplicate.
    if (id === '' || id === 'heading' || id === 'rest' || taken.has(id)) return false;
    taken.add(id);
    return true;
  });

  const groups = items.map((g, i) => {
    const id = owns[i] ? declaredIds[i] : mintGroupId(i, taken);
    taken.add(id);
    return {
      id,
      name: typeof g.name === 'string' && g.name.trim() !== '' ? g.name.trim() : `Group ${i + 1}`,
      fields: claimFieldNames(g.fields, claimed),
    };
  });

  return { heading, groups };
}

/** LayoutConfig → the `layout:` frontmatter value. Deviations only: the
 * defaults = null (patchFrontmatter deletes the key), an empty heading is
 * omitted, groups always serialize whole — an empty group is a real drop
 * target the editor keeps. */
export function serializeLayoutConfig(l: LayoutConfig): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (l.heading.length !== LAYOUT_DEFAULTS.heading.length) out.heading = [...l.heading];
  if (l.groups.length !== LAYOUT_DEFAULTS.groups.length) {
    out.groups = l.groups.map((g) => ({ id: g.id, name: g.name, fields: [...g.fields] }));
  }
  return Object.keys(out).length === 0 ? null : out;
}

function isEmptyValue(raw: unknown): boolean {
  return (
    raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)
  );
}

export function buildSchema(entries: Entry[]): Schema {
  const types = new Map<string, TypeDef>();
  for (const e of entries) {
    if (e.type !== 'Type') continue;
    types.set(e.title, {
      name: e.title,
      icon: typeof e.properties.icon === 'string' ? e.properties.icon : null,
      color: typeof e.properties.color === 'string' ? e.properties.color : null,
      fields: parseFields((e.properties as Record<string, unknown>).fields),
      statuses: parseStatuses((e.properties as Record<string, unknown>).statuses),
      folder:
        typeof e.properties.folder === 'string' && e.properties.folder.trim() !== ''
          ? e.properties.folder.trim().replace(/^\/+|\/+$/g, '')
          : null,
      views: parseViewList((e.properties as Record<string, unknown>).views),
      display: parseDisplayConfig((e.properties as Record<string, unknown>).display),
      layout: parseLayoutConfig((e.properties as Record<string, unknown>).layout),
      tabs: parseTabList((e.properties as Record<string, unknown>).tabs),
    });
  }

  const byPath = new Map(entries.map((e) => [e.path, e]));
  // Built once per schema so reverse rollups/trees are O(1) lookups instead
  // of a full scan per row (M3.5).
  const relations = buildRelationIndex(entries);

  function projectForEntry(e: Entry): Entry | null {
    if (e.project === null) return null;
    return byPath.get(e.project) ?? null;
  }

  function statusSetForProject(projectPath: string | null): StatusDef[] {
    if (projectPath !== null) {
      const project = byPath.get(projectPath);
      if (project !== undefined) {
        const override = parseStatuses((project.properties as Record<string, unknown>).statuses);
        if (override.length > 0) return override;
      }
    }
    return DEFAULT_STATUSES;
  }

  /** Project override → the entry's own type's `statuses:` → app defaults.
   * M12.2: no type inherits from another — Work item used to be the vault's
   * status source, which meant one type name the app could never let go of. */
  function statusSetFor(e: Entry): StatusDef[] {
    if (e.project !== null) {
      const project = byPath.get(e.project);
      if (project !== undefined) {
        const override = parseStatuses((project.properties as Record<string, unknown>).statuses);
        if (override.length > 0) return override;
      }
    }
    const own = e.type !== null ? types.get(e.type)?.statuses : undefined;
    if (own !== undefined && own.length > 0) return own;
    return DEFAULT_STATUSES;
  }

  /**
   * WHICH link in that chain answered (M16.12).
   *
   * The inline status creator needs it: writing a new status to the TYPE is a
   * silent no-op for a record whose statuses come from a project override,
   * because the override wins on the very next read. Rather than write
   * something the user will not see, the picker says where the statuses
   * actually live.
   */
  function statusSourceFor(e: Entry): 'project' | 'type' | 'default' {
    if (e.project !== null) {
      const project = byPath.get(e.project);
      if (project !== undefined) {
        const override = parseStatuses((project.properties as Record<string, unknown>).statuses);
        if (override.length > 0) return 'project';
      }
    }
    const own = e.type !== null ? types.get(e.type)?.statuses : undefined;
    return own !== undefined && own.length > 0 ? 'type' : 'default';
  }

  function resolveField(e: Entry, field: string): ResolvedField {
    const typeDef = e.type !== null ? types.get(e.type) : undefined;
    const def = typeDef?.fields.find((f) => f.name === field) ?? null;
    const relTargets = e.relationships[field];
    const raw: unknown = relTargets !== undefined ? relTargets : e.properties[field];

    // Computed kinds ignore stored frontmatter entirely.
    if (def?.kind === 'created_time') {
      return {
        def,
        raw: e.createdAt,
        display: formatTimestamp(e.createdAt),
        color: null,
        ghost: false,
      };
    }
    if (def?.kind === 'last_edited_time') {
      return {
        def,
        raw: e.modifiedAt,
        display: formatTimestamp(e.modifiedAt),
        color: null,
        ghost: false,
      };
    }
    if (def?.kind === 'rollup') {
      const computed = computeRollup(e, def, entries, relations);
      return {
        def,
        raw: computed,
        display: applyFormat(computed, def),
        color: null,
        ghost: false,
      };
    }

    // A two-way relation's reciprocal side stores nothing (M12.4): its value
    // is derived — the records of `from.type` whose `from.field` links here.
    // Edits write through to that owning side, never to this frontmatter.
    // `person` counts (M16.13b): it is a relation that renders avatars, and
    // gating on the kind NAME left a derived person field reading its own
    // empty frontmatter and rendering blank.
    if ((def?.kind === 'relation' || def?.kind === 'person') && def.from !== undefined) {
      const sources = childrenOf(
        e,
        { direction: 'reverse', type: def.from.type, field: def.from.field },
        entries,
        relations,
      );
      const stems = sources.map((s) => (s.path.split('/').pop() ?? s.path).replace(/\.md$/, ''));
      return {
        def,
        raw: stems,
        display: sources.map((s) => s.title).join(', '),
        color: null,
        ghost: false,
      };
    }

    if (isEmptyValue(raw)) {
      return { def, raw, display: '', color: null, ghost: false };
    }

    const kind: FieldKind = def?.kind ?? (relTargets !== undefined ? 'relation' : 'text');

    if (kind === 'person' || kind === 'relation') {
      const targets = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const display = targets.map((t) => resolveTarget(t, entries)?.title ?? t).join(', ');
      return { def, raw, display, color: null, ghost: false };
    }

    if (kind === 'status') {
      const statuses = statusSetFor(e);
      const id = String(Array.isArray(raw) ? raw[0] : raw);
      const match = statuses.find((s) => s.id === id);
      if (match !== undefined) {
        return { def, raw, display: match.label, color: match.color, ghost: false };
      }
      return { def, raw, display: id, color: null, ghost: true };
    }

    if (kind === 'select' || kind === 'multiselect') {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const options = def?.options ?? [];
      let ghost = false;
      let color: string | null = null;
      const labels = values.map((v) => {
        const match = options.find((o) => o.id === v);
        if (match === undefined) {
          ghost = true;
          return v; // ghost values keep their raw form (advisory schema)
        }
        if (color === null) color = match.color;
        return match.label;
      });
      return { def, raw, display: labels.join(', '), color, ghost };
    }

    if (kind === 'checkbox') {
      return { def, raw, display: raw === true ? 'Yes' : 'No', color: null, ghost: false };
    }

    // Declared numbers carry their field's format (percent, progress, money).
    if (kind === 'number' && def !== null && typeof raw === 'number') {
      return { def, raw, display: formatNumber(raw, def), color: null, ghost: false };
    }

    // A declared date renders in the format its property carries (M16.14).
    // Before this, every date everywhere printed its raw ISO string and the
    // picker's format menu was thrown away the moment the popover closed —
    // and `String(raw)` on a daterange printed "[object Object]".
    if (kind === 'date' || kind === 'daterange') {
      const value = parseDateProperty(raw);
      if (value !== null) {
        return {
          def,
          raw,
          display: formatDateValue(
            {
              ...value,
              format: def?.dateFormat ?? 'short',
              timeFormat: def?.timeFormat ?? DEFAULT_TIME_FORMAT,
            },
            toIsoDate(new Date()),
          ),
          color: null,
          ghost: false,
        };
      }
      // Not a date at all: an undeclared key or a value the schema doctor has
      // yet to adopt. Fall through to the raw reading rather than blanking it.
    }

    // text and undeclared fields
    const display = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
    return { def, raw, display, color: null, ghost: false };
  }

  return {
    types,
    relations,
    projectForEntry,
    statusSetForProject,
    statusSetFor,
    statusSourceFor,
    resolveField,
  };
}
