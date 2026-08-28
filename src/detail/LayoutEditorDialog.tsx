import { useEffect, useState, type ReactNode } from 'react';
import { applyTypeLayout, type TypeLayoutDraft } from '@/app/typeActions';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { FieldEditor } from '@/detail/FieldEditor';
import { GroupLabel } from '@/detail/GroupLabel';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { PropertyRow } from '@/detail/PropertyRow';
import { RecordTabs } from '@/detail/RecordTabs';
import { resolveLayout } from '@/engine/layout';
import { foldsWhenUnset, splitByVisibility } from '@/engine/properties';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, FieldDef, TypeDef } from '@/engine/types';
import { deepEqual } from '@/lib/deepEqual';
import { isTemplate } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * Seed the editor's staged draft from a TypeDef (M45.2).
 *
 * `display`/`tabs` copy verbatim — copies, not references, so draft edits
 * never alias the schema's objects. `layout` is rebuilt from the RESOLVED
 * layout: survivor names only, group ids/names verbatim, empty groups kept
 * (they are the editor's drop targets). Dead pointers thus vanish from the
 * draft at seed and from the vault on the next Apply — spec §4's pointer
 * hygiene without a special pass.
 */
export function seedDraft(typeDef: TypeDef): TypeLayoutDraft {
  const resolved = resolveLayout(typeDef.layout, typeDef.fields);
  return {
    display: { ...typeDef.display },
    layout: {
      heading: resolved.heading.map((d) => d.name),
      groups: resolved.groups.map((g) => ({
        id: g.id,
        name: g.name,
        fields: g.fields.map((d) => d.name),
      })),
    },
    tabs: typeDef.tabs.map((t) => ({ ...t })),
    visibility: {},
    added: [],
  };
}

/**
 * Overlay the draft's staged per-field visibility onto resolved FieldDefs so
 * the canvas folds what the page WILL fold after Apply (M45.3). A staged
 * `null` clears back to show — the key deletes on Apply, so the overlay drops
 * the def's own visibility the same way. Untouched defs pass through by
 * reference and an empty stage returns the same array. Exported for the group
 * editor (M45.3 later tasks), which resolves the same overlaid roster.
 */
export function overlayVisibility(
  fields: FieldDef[],
  visibility: TypeLayoutDraft['visibility'],
): FieldDef[] {
  if (Object.keys(visibility).length === 0) return fields;
  return fields.map((f) => {
    if (!(f.name in visibility)) return f;
    const v = visibility[f.name];
    if (v === null) {
      const { visibility: _cleared, ...rest } = f;
      return rest;
    }
    return { ...f, visibility: v };
  });
}

/**
 * The canvas roster: the type's declared fields plus the draft's STAGED
 * additions, each mapped to a FieldDef the way Apply builds its defs (the
 * typeActions `{...config, name, kind}` spread with FieldDef-shaped config) —
 * so a staged field previews exactly as it will land. `added` stays empty
 * until Task 5 wires AddPropertyPanel; the seam lands with the shells so the
 * roster has ONE definition when it does. Empty additions return the same
 * array (overlayVisibility's identity idiom).
 */
export function draftRoster(fields: FieldDef[], added: TypeLayoutDraft['added']): FieldDef[] {
  if (added.length === 0) return fields;
  return [
    ...fields,
    ...added.map((a) => ({ ...a.config, name: a.name, kind: a.kind }) as FieldDef),
  ];
}

/** The one door every draft edit walks through — the rail's controls all
 * funnel here via `update` (M45.2). Exported pure for the dirty tests. */
export function updateDraft(
  draft: TypeLayoutDraft,
  patch: Partial<TypeLayoutDraft>,
): TypeLayoutDraft {
  return { ...draft, ...patch };
}

/**
 * Does the draft differ from its seed? Structural, because these two objects
 * were built by different code paths and a stringify compare would depend on
 * key order. Arrays compare positionally, so a reorder counts as an edit —
 * which for a layout it is.
 */
export function draftDirty(draft: TypeLayoutDraft, seed: TypeLayoutDraft): boolean {
  return !deepEqual(draft, seed);
}

/**
 * The stand-in when the type has zero records (locked Decision): a synthetic
 * in-memory Entry the canvas can render — NEVER written, never in the store.
 * Empty properties mean every cell previews as blank, which is exactly what
 * a fresh record of the type would show.
 */
function syntheticEntry(type: string): Entry {
  return {
    path: '',
    filename: '',
    folder: '',
    project: null,
    title: `New ${type}`,
    type,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '',
    modifiedAt: '',
    parseError: null,
  };
}

/**
 * The Customize-layout screen (M45.2, spec §3.2): one fullscreen Dialog
 * mounted once at App level, raised by `uiStore.layoutEditor`. Everything
 * edits a staged `TypeLayoutDraft`; `applyTypeLayout` is the only write and
 * the dialog closes only on `true` (M14.8).
 */
export function LayoutEditorDialog() {
  const signal = useUiStore((s) => s.layoutEditor);
  if (signal === null) return null;
  // Keyed so a retargeted signal reseeds the draft instead of editing one
  // type's layout under another's name.
  return <LayoutEditorCard key={signal.type} type={signal.type} />;
}

function LayoutEditorCard({ type }: { type: string }) {
  const schema = useSchema();
  const closeLayoutEditor = useUiStore((s) => s.closeLayoutEditor);
  const typeDef = schema.types.get(type) ?? null;

  // Unavailable is never a crash: the type can vanish mid-session (its Type
  // doc deleted or retitled under the open editor). Render nothing and put
  // the signal down — an editor for a type that no longer exists has nothing
  // true to show, and a signal left up would re-raise it every render.
  useEffect(() => {
    if (typeDef === null) closeLayoutEditor();
  }, [typeDef, closeLayoutEditor]);
  if (typeDef === null) return null;
  return <LayoutEditorBody typeDef={typeDef} />;
}

function LayoutEditorBody({ typeDef }: { typeDef: TypeDef }) {
  const schema = useSchema();
  const entries = useVaultStore((s) => s.entries);
  const closeLayoutEditor = useUiStore((s) => s.closeLayoutEditor);
  // The seed is captured at mount: dirty means "differs from what the editor
  // opened on", not from wherever the schema has drifted since.
  const [seed] = useState(() => seedDraft(typeDef));
  const [draft, setDraft] = useState(seed);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The preview roster: the type's records, surface.ts's own membership test
  // (templates declare a type so new pages inherit it; they are not records
  // of it — M3.1), sorted by title. `picked` resets when the signal retargets
  // because LayoutEditorCard keys this component by type; a picked record
  // deleted mid-session falls back to the first, and an empty roster to the
  // synthetic stand-in.
  const [picked, setPicked] = useState<string | null>(null);
  const roster = entries
    .filter((e) => e.type === typeDef.name && !isTemplate(e))
    .sort((a, b) => a.title.localeCompare(b.title));
  const previewEntry =
    roster.find((e) => e.path === picked) ?? roster[0] ?? syntheticEntry(typeDef.name);
  /** The ONE door for every rail control — nothing else touches the draft. */
  const update = (patch: Partial<TypeLayoutDraft>) => setDraft((d) => updateDraft(d, patch));

  const dirty = draftDirty(draft, seed);
  const maybeClose = () => {
    // Dirty means a confirm, not a block: an untouched draft closes clean.
    if (dirty) setConfirming(true);
    else closeLayoutEditor();
  };

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await applyTypeLayout({ name: typeDef.name, docPath: null }, draft);
      // Close only on true (M14.8): a failed Apply already toasted, and the
      // editor keeps everything the user built.
      if (ok) closeLayoutEditor();
    } finally {
      setBusy(false);
    }
  };

  // Structure is derived, both ways (spec §4): Tabbed ⟺ the draft has tabs.
  // No structure flag anywhere — switching writes `tabs`, and the active
  // tile is a no-op so Tabbed can never reseed saved tabs to Overview.
  const tabbed = draft.tabs.length > 0;
  const setStructure = (toTabbed: boolean) => {
    if (toTabbed === tabbed) return;
    update({
      tabs: toTabbed
        ? // The synthesized default made explicit — the one tab every
          // tabless record already renders as.
          [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }]
        : [],
    });
  };

  const style = typeStyle(typeDef.name, schema);

  // The canvas renders from the DRAFT — not RecordProperties, which resolves
  // the LIVE typeDef's `layout:`/`display` and would keep previewing the
  // vault while the user edits the stage. Same visual grammar, draft-driven —
  // over the STAGED roster, so a Task-5 added field previews before Apply.
  const previewLayout = resolveLayout(draft.layout, draftRoster(typeDef.fields, draft.added));
  // The canvas folds what the page folds (M45.3): the panels' predicate with
  // the DRAFT overlaid — staged visibility on each def, staged showEmpty into
  // `foldsWhenUnset`. Folded rows render NOTHING (the page's collapsed
  // default; the canvas has no expander) — the group EDITOR is where hidden
  // things stay visible.
  const canvasRows = (fields: FieldDef[]) =>
    splitByVisibility(
      overlayVisibility(fields, draft.visibility),
      foldsWhenUnset(previewEntry, schema, draft.display.showEmpty),
    ).shown;
  const restRows = canvasRows(previewLayout.rest);
  // The heading shell gates on the strip's OWN fold predicate (stripCells is
  // exported for exactly this — hosts gate on the strip actually showing), so
  // a fully folded strip leaves no empty shell behind, and the gate can never
  // drift from the fold.
  const headingFields = overlayVisibility(previewLayout.heading, draft.visibility);
  const headingShown =
    stripCells(previewEntry, schema, headingFields, draft.display.showEmpty).length > 0;
  const previewRow = (f: FieldDef) => (
    <PropertyRow
      key={f.name}
      kind={f.kind}
      name={f.name}
      align={f.kind === 'checkbox' ? 'center' : 'start'}
    >
      <FieldEditor entry={previewEntry} def={f} schema={schema} />
    </PropertyRow>
  );

  return (
    <>
      <Dialog open fullscreen onClose={maybeClose} title={`Customize ${typeDef.name} layout`}>
        <div data-testid="layout-editor" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-n-100 px-4 py-2">
            {/* The icon alone: the fullscreen Dialog's title bar already
                names the type — one-header anatomy (spec §3.2). CreateMenu's
                direct-color idiom, n-800 when the type declares none. */}
            <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-800)'} />
            {roster.length > 0 && (
              <span className="ml-3 flex items-center gap-1.5 text-xs text-n-400">
                Preview:
                <Select
                  testId="layout-preview-picker"
                  ariaLabel="Preview record"
                  size="sm"
                  options={roster.map((e) => ({ value: e.path, label: e.title }))}
                  value={previewEntry.path}
                  onChange={(e) => setPicked(e.target.value)}
                />
              </span>
            )}
            <span className="flex-1" />
            <Button testId="layout-cancel" onClick={maybeClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              testId="layout-apply"
              disabled={busy}
              onClick={() => void apply()}
            >
              Apply to all pages
            </Button>
          </div>
          <div className="flex min-h-0 flex-1">
            {/* The canvas container is LIVE (M45.3): interactivity belongs to
                the BlockShells inside it, and the `inert` that used to sit
                here moved inward onto each shell's content div — see
                BlockShell for the boundary's rationale. */}
            <div data-testid="layout-preview" className="min-w-0 flex-1 overflow-auto p-6">
              <div className="mx-auto flex max-w-2xl flex-col">
                {draft.tabs.length > 0 && (
                  <BlockShell container="tabs" label="Tabs">
                    <RecordTabs
                      tabs={draft.tabs}
                      activeId={draft.tabs[0].id}
                      // No-ops: intent can never leave an inert strip anyway.
                      onSelect={() => undefined}
                      onChange={() => undefined}
                    />
                  </BlockShell>
                )}
                {headingShown && (
                  <BlockShell container="heading" label="Heading">
                    <HeadingProperties
                      entry={previewEntry}
                      schema={schema}
                      // The strip folds by the DRAFT too — staged visibility
                      // overlaid on its cells, staged show-empty for the fold.
                      fields={headingFields}
                      showEmpty={draft.display.showEmpty}
                    />
                  </BlockShell>
                )}
                <div className="flex flex-col gap-[7px]">
                  {previewLayout.groups.map((g) => {
                    // A STRUCTURALLY empty group keeps its shell (plan
                    // Decision): it is the editor's drop target, and erasing
                    // it would strand a fresh Add-section group off screen.
                    if (g.fields.length === 0) {
                      return (
                        <BlockShell key={g.id} container={g.id} label={g.name}>
                          <GroupLabel name={g.name} />
                          <div className="px-1 pb-1.5 text-xs text-n-400">No properties yet</div>
                        </BlockShell>
                      );
                    }
                    const rows = canvasRows(g.fields);
                    // Empty after FOLDING renders nothing — the panels' own
                    // rule: a header over no rows would claim the group holds
                    // something it does not.
                    if (rows.length === 0) return null;
                    return (
                      <BlockShell key={g.id} container={g.id} label={g.name}>
                        <div
                          data-testid="property-group"
                          data-group={g.id}
                          className="flex flex-col gap-[7px]"
                        >
                          <GroupLabel name={g.name} />
                          {rows.map(previewRow)}
                        </div>
                      </BlockShell>
                    );
                  })}
                  {/* Rest LAST and headerless, RecordProperties' own order.
                      Its shell says "Properties" — the block's Notion name,
                      since headerless content has no label of its own. */}
                  {restRows.length > 0 && (
                    <BlockShell container="rest" label="Properties">
                      <div className="flex flex-col gap-[7px]">{restRows.map(previewRow)}</div>
                    </BlockShell>
                  )}
                </div>
                {draft.display.showBody && (
                  <BlockShell container="content" label="Content">
                    {/* The body as a placeholder block: the preview stages
                        the page's SHAPE, and a real body would need a real
                        read. */}
                    <div data-testid="layout-preview-body" className="mt-5">
                      <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                        Description
                      </div>
                      <div className="mt-2 flex flex-col gap-2">
                        <div className="h-2.5 w-11/12 rounded-sm bg-n-100" />
                        <div className="h-2.5 w-4/5 rounded-sm bg-n-100" />
                        <div className="h-2.5 w-3/5 rounded-sm bg-n-100" />
                      </div>
                    </div>
                  </BlockShell>
                )}
                {draft.display.showFile && previewEntry.path !== '' && (
                  // DetailPanel's muted file-path row (M44.1), staged: the
                  // draft raises it. The synthetic stand-in has no path, and
                  // absent is never faked — no path, no row.
                  <div
                    data-testid="layout-preview-file"
                    className="mt-4 truncate font-mono text-2xs text-n-400"
                    title={previewEntry.path}
                  >
                    {previewEntry.path}
                  </div>
                )}
              </div>
            </div>
            <div
              data-testid="layout-rail"
              className="w-72 flex-none overflow-auto border-l border-n-100 p-3"
            >
              <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                Structure
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                <StructureTile
                  label="Simple"
                  icon="file-text"
                  active={!tabbed}
                  onSelect={() => setStructure(false)}
                />
                <StructureTile
                  label="Tabbed"
                  icon="panel-top"
                  active={tabbed}
                  onSelect={() => setStructure(true)}
                />
              </div>
              <div className="mt-4 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                Options
              </div>
              {/* The M44.1 drill-in's switches — same storage, new home
                  (spec §3.2), except these stage into the draft and land on
                  Apply instead of writing per toggle. Labels per the spec:
                  its "Show body" replaces the drill-in's "Show description",
                  the other two carry over verbatim. */}
              <div className="mt-1.5 flex flex-col gap-2">
                <Switch
                  checked={draft.display.showEmpty}
                  onChange={(on) => update({ display: { ...draft.display, showEmpty: on } })}
                  label="Show empty properties"
                />
                <Switch
                  checked={draft.display.showFile}
                  onChange={(on) => update({ display: { ...draft.display, showFile: on } })}
                  label="Show file path"
                />
                <Switch
                  checked={draft.display.showBody}
                  onChange={(on) => update({ display: { ...draft.display, showBody: on } })}
                  label="Show body"
                />
              </div>
            </div>
          </div>
        </div>
      </Dialog>
      {confirming && (
        // A SIBLING of the fullscreen Dialog, not a child (PropertyMenu's
        // sibling rationale, adapted): nested inside the card it would sit in
        // the fullscreen dialog's DOM and focus trap; as a sibling it
        // registers its own layer ABOVE, so the stack — not DOM nesting —
        // hands it Escape and Tab, and one Escape dismisses one surface.
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title="Discard layout changes?"
          width={420}
          secondaryAction={{ label: 'Keep editing', onClick: () => setConfirming(false) }}
          primaryAction={{
            label: 'Discard',
            onClick: () => {
              setConfirming(false);
              closeLayoutEditor();
            },
          }}
        >
          <p className="m-0 text-sm leading-relaxed text-n-600">
            The staged changes leave with the editor. Nothing has been written.
          </p>
        </Dialog>
      )}
    </>
  );
}

/**
 * One canvas block: an interactive SHELL around inert content (M45.3, plan
 * Decision "block chrome is the shell's"). The chrome idiom is WidgetShell's
 * shell-owns-the-chrome anatomy wearing Notion's block hover grammar in DS
 * tokens: the cortex ring on hover/focus (CalendarView's drag ring) and the
 * quiet name chip top-left (StructureTile's active cortex palette), revealed
 * by the named-group hover the sidebar controls use.
 *
 * The CONTENT div carries the `inert` that used to sit on the whole canvas:
 * live editors render inside but can never FIRE — React 19 forwards the
 * attribute, and it blanks every pointer, key and focus path in the subtree,
 * so the draft — not the vault — stays on stage. No aria-hidden alongside
 * it: inert already removes the subtree from the a11y tree, and a second
 * claim could only drift from the first. The shell itself stays live: a
 * focusable role'd div (a real <button> cannot legally contain the block's
 * form controls), labeled for the a11y tree its inert content left.
 */
function BlockShell({
  container,
  label,
  children,
}: {
  /** 'heading' | groupId | 'rest' | 'content' | 'tabs' — Task 5/6's address. */
  container: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      data-testid="layout-block"
      data-block={container}
      // TODO(M45.3 Task 5): onClick opens this container's group editor. The
      // attributes land here so tests and e2e can address blocks; the handler
      // lands with the popover so no dead no-op ships in between.
      className="group/block relative rounded-md ring-cortex-500 hover:ring-1 focus-visible:outline-none focus-visible:ring-1"
    >
      <span className="pointer-events-none absolute -top-2 left-1.5 z-10 rounded border border-cortex-500 bg-cortex-50 px-1 text-2xs font-medium text-cortex-700 opacity-0 group-hover/block:opacity-100 group-focus-visible/block:opacity-100">
        {label}
      </span>
      <div data-testid="layout-preview-content" inert>
        {children}
      </div>
    </div>
  );
}

/** One Structure tile — NewTabForm's aria-pressed button idiom, NOT
 * SegmentedControl (which renders role=tab, the M44.2 learning). */
function StructureTile({
  label,
  icon,
  active,
  onSelect,
}: {
  label: string;
  icon: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={`layout-structure-${label.toLowerCase()}`}
      onClick={onSelect}
      className={[
        'flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-2xs',
        active
          ? 'border-cortex-500 bg-cortex-50 text-cortex-700'
          : 'border-n-200 bg-transparent text-n-600 hover:bg-n-50',
      ].join(' ')}
    >
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}
