/**
 * Resolution for a record page's `content: 'view'` tab (M45.4).
 *
 * A view tab carries a POINTER — `source: { type } | { list, collection? }`,
 * an optional saved-view id, an optional `scope: 'related'` — and this module
 * turns the pointer into a renderable Surface or an honest sentence about
 * what died. It mirrors the dashboard ViewBlock's path (DashboardView.tsx):
 * look the source up, `resolveView`, refuse block-composed layouts, then
 * `resolveSurface` with a synthetic selection — so a tab and a dashboard
 * widget can never disagree about what a saved view means.
 *
 * Every broken arm returns a reason, never an empty surface: "nothing here"
 * and "this pointer is dead" are opposite sentences, and `resolveSurface`'s
 * own missing-list fallback (title, zero rows) is exactly the collapse this
 * resolver exists to replace.
 */

// The one engine import from the views layer, deliberate: `hasBlocks` is the
// capability registry's answer to "is this layout composed of blocks", and
// its own doc forbids the alternative — a second `type === 'dashboard'`
// comparison here. viewKinds is pure capability data over engine types (no
// React), so the edge carries no UI into the engine.
import { hasBlocks } from '@/views/viewKinds';
import type {
  Entry,
  FieldDef,
  FilterGroup,
  ListFile,
  Schema,
  TabDef,
  ViewDefinition,
} from './types';
import { resolveSurface, type Surface } from './surface';
import { listTypes, typeViews } from './typeCatalog';
import { evaluateFilters } from './viewFilters';
import { resolveView } from './views';
import { resolveTarget } from './wikilink';

export type ViewTabResolution =
  { kind: 'ok'; surface: Surface; sourceLabel: string } | { kind: 'broken'; reason: string };

const broken = (reason: string): ViewTabResolution => ({ kind: 'broken', reason });

/**
 * The first field on `sourceType` through which its records can point at a
 * record of `hostType` — the capability that gates `scope: 'related'`. The
 * gate reads field EXISTENCE, never a type name (AGENTS.md): any vault whose
 * Task-alike declares a relation at its Project-alike qualifies, whatever
 * either is called.
 *
 * Three deliberate narrowings:
 * - relation-family kinds only (`relation`/`person` — a person field IS a
 *   relation with an avatar renderer, properties.ts doctrine);
 * - DECLARED targets only, compared strictly, the way types compare
 *   everywhere (`schema.types.get`, `e.type === sel.name`) — a person field
 *   inferring its target from held values needs entries this signature
 *   deliberately does not take, and an undeclared relation target is the
 *   user's explicit "any record" choice, not a match;
 * - the derived side of a two-way pair (`from:` set) is skipped: it STORES
 *   nothing, so a filter reading `entry.relationships[field]` off the source
 *   rows would match no one — offering it would be a toggle that lies.
 */
export function relationFieldTargeting(
  sourceType: string,
  hostType: string,
  schema: Schema,
): FieldDef | null {
  const fields = schema.types.get(sourceType)?.fields ?? [];
  return (
    fields.find(
      (f) =>
        (f.kind === 'relation' || f.kind === 'person') &&
        f.from === undefined &&
        f.target === hostType,
    ) ?? null
  );
}

/**
 * The rows of `surface` whose `field` points at `host`.
 *
 * The injected rule is the M44.3 drilldown family — module-scope `bandRule`
 * in ChartView.tsx emits `{ field, op: 'any_of', value: [...] }` for the
 * relation/person kinds, and it is private to that module, so the literal is
 * built here rather than imported. What differs is where the VALUES come from:
 * `evaluateFilters` intersects strictly (case-sensitively) against the
 * scanner's bracket-stripped AUTHORED wikilink targets in
 * `entry.relationships[field]` — not paths, not necessarily the host's
 * title — while authors may legally spell the host as its filename stem,
 * its project folder, or its title, in any case (`resolveTarget`). So the
 * value set is every authored spelling among the rows that RESOLVES to the
 * host, which makes the strict filter exactly equivalent to the relation
 * engine's reverse resolution: no spelling is missed, and a spelling that
 * resolves to a different record (stem shadowing) is never swept in.
 */
function relatedEntries(
  surface: Surface,
  field: string,
  host: Entry,
  entries: Entry[],
  schema: Schema,
): Entry[] {
  const spellings = new Set<string>();
  for (const e of surface.entries) {
    for (const raw of e.relationships[field] ?? []) spellings.add(raw);
  }
  const values = [...spellings].filter((raw) => resolveTarget(raw, entries)?.path === host.path);
  // Nothing points at the host: measured-at-zero, an EMPTY result on purpose.
  // It must not reach evaluateFilters — a value-less `any_of` is "not ready"
  // there (M16.29) and would be SKIPPED, silently meaning every row.
  if (values.length === 0) return [];
  const group: FilterGroup = { all: [{ field, op: 'any_of', value: values }] };
  return surface.entries.filter((e) => evaluateFilters(e, group, schema));
}

/**
 * Resolve a `content: 'view'` tab against the vault: the dashboard ViewBlock
 * path for BOTH source kinds, then the related scope layered onto the
 * resolved surface's ENTRIES — the widgetEntries idiom: filters compose onto
 * rows, and the presentation is never touched.
 */
export function resolveViewTab(
  tab: TabDef,
  host: Entry,
  entries: Entry[],
  schema: Schema,
  views: ListFile[],
): ViewTabResolution {
  const source = tab.source ?? null;
  if (source === null) {
    return broken('This tab declares a view but does not say what it is a view of.');
  }

  // Both arms produce the same three facts; everything after is shared.
  let active: ViewDefinition;
  let sourceName: string;
  let sourceType: string | null;
  let surface: Surface;

  if ('type' in source) {
    // Alive = the catalog lists it: declared types, system types, and ghost
    // types records still reference — the same membership the picker offers.
    if (!listTypes(entries, schema).some((t) => t.name === source.type)) {
      return broken(
        `This tab points at a type called “${source.type}” that is no longer in the vault.`,
      );
    }
    const tabs = typeViews(source.type, schema);
    active = (tab.view != null ? tabs.find((v) => v.id === tab.view) : undefined) ?? tabs[0];
    sourceName = source.type;
    sourceType = source.type;
    if (hasBlocks(active.presentation.type)) {
      return broken('A record tab cannot show a dashboard — pick one of its own views instead.');
    }
    surface = resolveSurface(
      { kind: 'type', name: source.type, ...(tab.view !== undefined ? { view: tab.view } : {}) },
      entries,
      schema,
      views,
    );
  } else {
    // Ids are unique per FOLDER, not per vault, so the collection is part of
    // the key — the same rule the dashboard ViewBlock and resolveSurface use.
    const collection = source.collection ?? null;
    const list = views.find((l) => l.id === source.list && l.collection === collection) ?? null;
    if (list === null) {
      return broken(
        `This tab points at a list called “${source.list}” that is no longer in the vault.`,
      );
    }
    active = resolveView(list.definition, tab.view);
    sourceName = list.definition.name;
    sourceType = list.definition.source.type;
    if (hasBlocks(active.presentation.type)) {
      return broken('A record tab cannot show a dashboard — pick one of its own views instead.');
    }
    surface = resolveSurface(
      {
        kind: 'list',
        id: source.list,
        collection,
        ...(tab.view !== undefined ? { view: tab.view } : {}),
      },
      entries,
      schema,
      views,
    );
  }

  const sourceLabel = `${sourceName} · ${active.name}`;

  if (tab.scope === 'related') {
    if (host.type === null || host.type === '') {
      return broken(
        'This tab scopes to related records, but this record has no type for a relation to target.',
      );
    }
    if (sourceType === null) {
      // A typeless ("everything") list has no type to declare fields on, so
      // the capability gate has nothing to read — related cannot mean
      // anything here, and silently-all is the one answer forbidden.
      return broken(
        `This tab scopes to related records, but “${sourceName}” shows records of no single type, so no relation can point at “${host.type}”.`,
      );
    }
    const field = relationFieldTargeting(sourceType, host.type, schema);
    if (field === null) {
      // "STORED relation": the derived side of a two-way pair renders as a
      // relation but never gates (it holds no values to filter) — to a user
      // looking at that column, plain "no relation" would read as false.
      return broken(
        `This tab scopes to related records, but “${sourceType}” has no stored relation pointing at “${host.type}”.`,
      );
    }
    return {
      kind: 'ok',
      surface: { ...surface, entries: relatedEntries(surface, field.name, host, entries, schema) },
      sourceLabel,
    };
  }

  return { kind: 'ok', surface, sourceLabel };
}
