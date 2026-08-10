import { isTemplate } from '@/lib/templates';
import { columnUniverse, defaultColumnsFor } from './columns';
import { inboxEntries } from './inbox';
import { isKnowledgePath } from './okf';
import type {
  Entry,
  Presentation,
  Schema,
  Selection,
  SortSpec,
  ListFile,
  ListSource,
} from './types';
import { typeViews } from './typeCatalog';
import { evaluateFilters } from './viewFilters';
import { clonePresentation, DEFAULT_PRESENTATION, resolveView } from './views';

/**
 * What the canvas renders for a selection: a titled, filtered, sorted entry
 * list plus the presentation to draw it with.
 *
 * Named Surface rather than Collection since M10 — `Collection` is now the
 * user-facing container (a folder holding collection.yml), and having the same
 * word mean both that and "whatever is on screen" made every signature in this
 * file ambiguous.
 */
export interface Surface {
  title: string;
  entries: Entry[];
  presentation: Presentation;
}

function defaultPresentation(): Presentation {
  return clonePresentation(DEFAULT_PRESENTATION);
}

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.(md|mmd)$/, '');

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
      return schema.statusSetFor(e).map((s) => s.id);
    }
    if (def.options !== undefined && def.options.length > 0) {
      return def.options.map((o) => o.id);
    }
    return null;
  }
  return null;
}

/**
 * Comparator for one sort key. Declared option sets (status/select) sort in
 * declared order; otherwise numbers compare numerically and everything else
 * as strings (ISO dates sort correctly). Entries without a value always sort
 * last, regardless of direction.
 */
function compareBy(
  spec: SortSpec,
  entries: Entry[],
  schema: Schema,
): (a: Entry, b: Entry) => number {
  const ranks = optionOrder(entries, spec.field, schema);
  const dir = spec.dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const va = sortValue(a, spec.field);
    const vb = sortValue(b, spec.field);
    const emptyA = isEmptyValue(va);
    const emptyB = isEmptyValue(vb);
    // Empty-last is evaluated PER KEY (M9.1). Returning 0 when both are empty
    // is what lets the next key decide — a global empty-last check would
    // strand every record missing the primary field in input order.
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
  };
}

/**
 * Stable multi-key sort (M9.1). First non-zero comparison wins; Array.sort is
 * stable in every engine we target, so equal-on-every-key entries keep their
 * input order.
 */
export function sortEntries(entries: Entry[], sort: SortSpec[], schema: Schema): Entry[] {
  if (sort.length === 0) return [...entries];
  const comparators = sort.map((spec) => compareBy(spec, entries, schema));
  return [...entries].sort((a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}

/**
 * The records a view's source selects, before its filters run (M3.5): every
 * record of a type, optionally narrowed to one project by containment. This
 * is what makes "a project" just a saved view — the project page's hardcoded
 * `type: Work item` + containment query, expressed as data.
 */
export function selectSource(entries: Entry[], source: ListSource): Entry[] {
  return entries.filter((e) => {
    if (isTemplate(e)) return false;
    // The knowledge bundle (M5) is the agent's corpus with its own surface;
    // a typeless "everything" view would otherwise sweep all of it in.
    // Path-keyed so index.md/log.md are excluded too.
    if (isKnowledgePath(e.path)) return false;
    if (source.type !== null) return e.type === source.type && matchesProject(e, source);
    // A typeless view means "everything I wrote": untyped pages included,
    // Type docs excluded — those are the schema, not content.
    return e.type !== 'Type' && matchesProject(e, source);
  });
}

const matchesProject = (e: Entry, source: ListSource) =>
  source.project === null || e.project === source.project;

/** Map a sidebar selection to what the canvas renders: a titled, filtered,
 * sorted entry list plus the presentation the views draw it with. */
export function resolveSurface(
  sel: Selection,
  entries: Entry[],
  schema: Schema,
  views: ListFile[],
): Surface {
  switch (sel.kind) {
    case 'list': {
      // Ids are unique per FOLDER, not per vault — two Collections may each
      // hold a "roadmap" — so the selection's collection is part of the key.
      // Project-scoped legacy views are rendered by their project's tabs.
      // M12.5: project-scoped legacy Lists resolve like any other — their
      // project field is history, not an address.
      const view =
        views.find((v) => v.id === sel.id && v.collection === (sel.collection ?? null)) ?? null;
      if (view === null) return { title: sel.id, entries: [], presentation: defaultPresentation() };
      const { name, source } = view.definition;
      // M11: filters and presentation belong to the VIEW, so which tab is open
      // decides both what the surface holds and how it draws.
      const active = resolveView(view.definition, sel.view);
      const { filters, presentation } = active;
      const inSource = selectSource(entries, source);
      return {
        title: name,
        entries: sortEntries(
          inSource.filter((e) => filters === null || evaluateFilters(e, filters, schema)),
          presentation.sort,
          schema,
        ),
        // "No columns stated" means this source's properties, never "no
        // properties" (M19.1). A `.list.yml` with no `columns:` key parses to
        // `[]`, and this is the only place that holds both the source and the
        // schema needed to say what it should show. Nothing is written to
        // disk: the derived columns only materialise into YAML if the user
        // then edits the view.
        //
        // Safe to key on emptiness because no UI can produce an empty array —
        // hiding a column writes `hidden: true` and `toggleColumn` never
        // removes a spec — so `[]` can only mean "the file never said".
        //
        // Derived against the UNFILTERED source: a default that changed as
        // you filtered the view would drop columns out from under you.
        presentation:
          presentation.columns.length === 0
            ? {
                ...presentation,
                columns: defaultColumnsFor(
                  columnUniverse(source, inSource, schema, presentation.group),
                ),
              }
            : presentation,
      };
    }
    case 'type': {
      // M12.3: a type keeps saved views exactly like a List — the selection's
      // `view` names the open tab, and filters belong to the view.
      const tabs = typeViews(sel.name, schema);
      const active =
        (sel.view != null ? tabs.find((v) => v.id === sel.view) : undefined) ?? tabs[0];
      const { filters, presentation } = active;
      return {
        title: sel.name,
        entries: sortEntries(
          // Templates declare a type so new pages inherit it; they are not
          // records of it (M3.1).
          entries.filter(
            (e) =>
              e.type === sel.name &&
              !isTemplate(e) &&
              (filters === null || evaluateFilters(e, filters, schema)),
          ),
          presentation.sort,
          schema,
        ),
        presentation,
      };
    }
    case 'collection':
      // A Collection contains; it does not query. Its page lists the Lists,
      // Folders and Docs inside it, which is not an entry set — so reporting
      // one here would invent a query the container deliberately lacks.
      return { title: stem(sel.folder), entries: [], presentation: defaultPresentation() };
    case 'home':
      return { title: 'Home', entries: [], presentation: defaultPresentation() };
    case 'knowledge':
      // The bundle has its own read-only surface; it is deliberately not a
      // collection of records, so nothing else can list or filter it.
      return { title: 'Knowledge', entries: [], presentation: defaultPresentation() };
    case 'inbox':
      // InboxPage draws its own queue/reading/organize layout, but the
      // collection still reports the real contents so the topbar and any
      // other consumer see the truth rather than an empty stand-in.
      return {
        title: 'Inbox',
        entries: inboxEntries(entries),
        presentation: defaultPresentation(),
      };
    case 'doc':
      // Docs render in the editor surface (DocPage); they have no item canvas.
      return { title: stem(sel.path), entries: [], presentation: defaultPresentation() };
    case 'diagram':
      // A standalone .mmd renders in DiagramPage (M29.21); no item canvas.
      return { title: stem(sel.path), entries: [], presentation: defaultPresentation() };
    case 'docs':
      return { title: 'Docs', entries: [], presentation: defaultPresentation() };
    case 'changes':
      // The git surfaces draw their own layouts; they are not collections of
      // records and deliberately cannot be filtered or grouped.
      return { title: 'Changes', entries: [], presentation: defaultPresentation() };
    case 'review':
      // Same: review cards are proposals, not records, and nothing in the
      // vault's filter vocabulary applies to them.
      return { title: 'Needs review', entries: [], presentation: defaultPresentation() };
    case 'pulse':
      return { title: 'Pulse', entries: [], presentation: defaultPresentation() };
    // Neither holds records. Listed rather than defaulted so that the next
    // surface added to Selection breaks the compiler here instead of silently
    // rendering an empty table.
    case 'library':
      return { title: 'Library', entries: [], presentation: defaultPresentation() };
    // M30 — mounted repositories hold FILES, not records. Repo markdown is
    // indexed as `IndexedDoc` and never enters `vaultStore`, so there is no
    // entry set to report here and reporting one would invent a query the
    // surface deliberately lacks.
    case 'workspace':
      return { title: 'Workspace', entries: [], presentation: defaultPresentation() };
    case 'settings':
      return { title: 'Settings', entries: [], presentation: defaultPresentation() };
  }
}
