import type { Entry, Presentation, Schema, Selection, ViewFile } from './types';
import { typePresentation } from './typeCatalog';
import { evaluateFilters } from './viewFilters';
import { DEFAULT_PRESENTATION } from './views';

export interface Collection {
  title: string;
  entries: Entry[];
  presentation: Presentation;
}

function defaultPresentation(): Presentation {
  return {
    ...DEFAULT_PRESENTATION,
    orderBy: { ...DEFAULT_PRESENTATION.orderBy },
    visibleFields: [...DEFAULT_PRESENTATION.visibleFields],
  };
}

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '');

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** The value an entry sorts by for a field: entry metadata first, then
 * relationships (first target), then properties (first element). */
function sortValue(entry: Entry, field: string): unknown {
  if (field === 'modifiedAt') return entry.modifiedAt;
  if (field === 'createdAt') return entry.createdAt;
  if (field === 'title') return entry.title;
  const rel = entry.relationships[field];
  if (rel !== undefined) return rel[0] ?? null;
  const raw = entry.properties[field];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

/** Declared option/status order for the field, from the first entry that
 * declares it (mirrors groupEntries' column derivation); null when the
 * field has no declared option set. */
function optionOrder(entries: Entry[], field: string, schema: Schema): string[] | null {
  for (const e of entries) {
    const def = schema.resolveField(e, field).def;
    if (def === null) continue;
    if (def.kind === 'status') {
      return schema.statusSetForProject(e.project).map((s) => s.id);
    }
    if (def.options !== undefined && def.options.length > 0) {
      return def.options.map((o) => o.id);
    }
    return null;
  }
  return null;
}

/**
 * Stable sort by the presentation's orderBy. Declared option sets
 * (status/select) sort in declared order; otherwise numbers compare
 * numerically and everything else as strings (ISO dates sort correctly).
 * Entries without a value always sort last, regardless of direction.
 */
export function sortEntries(
  entries: Entry[],
  orderBy: Presentation['orderBy'],
  schema: Schema,
): Entry[] {
  const ranks = optionOrder(entries, orderBy.field, schema);
  const dir = orderBy.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const va = sortValue(a, orderBy.field);
    const vb = sortValue(b, orderBy.field);
    const emptyA = isEmptyValue(va);
    const emptyB = isEmptyValue(vb);
    if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
    if (ranks !== null) {
      const ra = ranks.indexOf(String(va));
      const rb = ranks.indexOf(String(vb));
      if (ra !== -1 || rb !== -1) {
        if (ra === -1 || rb === -1) return ra === -1 ? 1 : -1; // undeclared after declared
        return (ra - rb) * dir;
      }
    }
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

/** Vault format v2: project membership is containment — Entry.project points
 * at the owning project.md. The item canvas shows the project's Work items
 * only; docs inside the folder belong to the Pages surface, not the board. */
function itemsOfProject(project: Entry, entries: Entry[]): Entry[] {
  return entries.filter((e) => e.project === project.path && e.type === 'Work item');
}

/** Map a sidebar selection to what the canvas renders: a titled, filtered,
 * sorted entry list plus the presentation the views draw it with. */
export function resolveCollection(
  sel: Selection,
  entries: Entry[],
  schema: Schema,
  views: ViewFile[],
): Collection {
  switch (sel.kind) {
    case 'project': {
      const project = entries.find((e) => e.path === sel.path) ?? null;
      const presentation = defaultPresentation();
      if (project === null) return { title: stem(sel.path), entries: [], presentation };
      return {
        title: project.title,
        entries: sortEntries(itemsOfProject(project, entries), presentation.orderBy, schema),
        presentation,
      };
    }
    case 'view': {
      // Sidebar view selections are vault-global; project-scoped views are
      // rendered by their project's tabs, not by id lookup here (ids are only
      // unique within a scope).
      const view = views.find((v) => v.id === sel.id && v.project === null) ?? null;
      if (view === null) return { title: sel.id, entries: [], presentation: defaultPresentation() };
      const { name, filters, presentation } = view.definition;
      const matched =
        filters === null ? entries : entries.filter((e) => evaluateFilters(e, filters, schema));
      return {
        title: name,
        entries: sortEntries(matched, presentation.orderBy, schema),
        presentation,
      };
    }
    case 'type': {
      // M3 type screen: every record carrying `type: <name>`, presented with
      // the type's own declared fields.
      const presentation = typePresentation(sel.name, schema);
      return {
        title: sel.name,
        entries: sortEntries(
          entries.filter((e) => e.type === sel.name),
          presentation.orderBy,
          schema,
        ),
        presentation,
      };
    }
    case 'home':
      return { title: 'Home', entries: [], presentation: defaultPresentation() };
    case 'doc':
      // Docs render in the editor surface (DocPage); they have no item canvas.
      return { title: stem(sel.path), entries: [], presentation: defaultPresentation() };
    case 'docs':
      return { title: 'Docs', entries: [], presentation: defaultPresentation() };
    case 'settings':
      return { title: 'Settings', entries: [], presentation: defaultPresentation() };
  }
}
