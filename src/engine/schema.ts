import type {
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  ResolvedField,
  Schema,
  StatusDef,
  TypeDef,
} from './types';
import { applyFormat, computeRollup, formatNumber, formatTimestamp } from './properties';
import { buildRelationIndex } from './relations';
import { resolveTarget } from './wikilink';

/** Spec "simple" status template — fallback when no type/project declares statuses. */
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
  { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', hollow: true, group: 'closed' },
];

const FIELD_KINDS: FieldKind[] = [
  'text', 'number', 'checkbox', 'date', 'daterange',
  'select', 'multiselect', 'status', 'person', 'relation',
  'url', 'files', 'rollup', 'created_time', 'last_edited_time',
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

function asFieldKind(value: unknown): FieldKind {
  return FIELD_KINDS.includes(value as FieldKind) ? (value as FieldKind) : 'text';
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
    def.options = s.options
      .map(parseOption)
      .filter((o): o is FieldOption => o !== null);
  }
  if (typeof s.target === 'string') def.target = s.target;
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

function isEmptyValue(raw: unknown): boolean {
  return (
    raw === undefined ||
    raw === null ||
    raw === '' ||
    (Array.isArray(raw) && raw.length === 0)
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
    });
  }

  const byPath = new Map(entries.map((e) => [e.path, e]));
  // Built once per schema so reverse rollups/trees are O(1) lookups instead
  // of a full scan per row (M3.5).
  const relations = buildRelationIndex(entries);

  // Vault-level default statuses live on the Work item Type doc (locked
  // decision 4); parsed once per schema build.
  const workItemTypeEntry = entries.find((e) => e.type === 'Type' && e.title === 'Work item');
  const vaultStatuses =
    workItemTypeEntry !== undefined
      ? parseStatuses((workItemTypeEntry.properties as Record<string, unknown>).statuses)
      : [];

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
    return vaultStatuses.length > 0 ? vaultStatuses : DEFAULT_STATUSES;
  }

  /** Project override → the entry's own type's `statuses:` → Work item's →
   * defaults. Lets a Bug type carry a status set Work items never see. */
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
    return vaultStatuses.length > 0 ? vaultStatuses : DEFAULT_STATUSES;
  }

  function resolveField(e: Entry, field: string): ResolvedField {
    const typeDef = e.type !== null ? types.get(e.type) : undefined;
    const def = typeDef?.fields.find((f) => f.name === field) ?? null;
    const relTargets = e.relationships[field];
    const raw: unknown = relTargets !== undefined ? relTargets : e.properties[field];

    // Computed kinds ignore stored frontmatter entirely.
    if (def?.kind === 'created_time') {
      return { def, raw: e.createdAt, display: formatTimestamp(e.createdAt), color: null, ghost: false };
    }
    if (def?.kind === 'last_edited_time') {
      return { def, raw: e.modifiedAt, display: formatTimestamp(e.modifiedAt), color: null, ghost: false };
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

    if (isEmptyValue(raw)) {
      return { def, raw, display: '', color: null, ghost: false };
    }

    const kind: FieldKind = def?.kind ?? (relTargets !== undefined ? 'relation' : 'text');

    if (kind === 'person' || kind === 'relation') {
      const targets = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const display = targets
        .map((t) => resolveTarget(t, entries)?.title ?? t)
        .join(', ');
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

    // text / date / daterange and undeclared fields
    const display = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
    return { def, raw, display, color: null, ghost: false };
  }

  return { types, relations, projectForEntry, statusSetForProject, statusSetFor, resolveField };
}
