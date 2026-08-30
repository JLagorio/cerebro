import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import type { TypeLayoutDraft } from '@/app/typeActions';
import { Icon } from '@/components/ui/Icon';
import { FieldEditor } from '@/detail/FieldEditor';
import { GroupEditorPopover } from '@/detail/GroupEditorPopover';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { PropertyRow } from '@/detail/PropertyRow';
import { RecordTabs } from '@/detail/RecordTabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { resolveLayout } from '@/engine/layout';
import { addGroup, moveField, moveGroup } from '@/engine/layoutEdit';
import { foldsWhenUnset, splitByVisibility } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { layoutTabScope, tabBearsProperties } from '@/engine/typeCatalog';
import type { Entry, FieldDef, LayoutConfig, Schema, TabDef, TypeDef } from '@/engine/types';

/**
 * The layout editor's preview canvas (M45.3), split out of LayoutEditorDialog
 * before the group editor lands: Tasks 5 and 6 both grow HERE, and the
 * GroupEditorPopover imports from this module — never from the dialog — so
 * the popover can be composed into the canvas without an import cycle.
 * Draft-state helpers (seedDraft/updateDraft/draftDirty) stay with the
 * dialog; this module owns rendering the staged draft.
 */

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

/**
 * Add section's ONE staging, shared by the canvas's + button and the group
 * editor's footer entry (M45.5 Task 3 — two doors, one editor, so the doors
 * cannot drift): mint against EVERY draft group id (mintGroupId's contract),
 * append, and hand the minted id to whoever opens editors. Exported here
 * rather than beside `addGroup` because the door it feeds is a UI door: the
 * engine editor stays roster-blind and draft-blind.
 */
export function stageNewSection(
  draft: TypeLayoutDraft,
  update: (patch: Partial<TypeLayoutDraft>) => void,
  openEditor: (id: string) => void,
  /** The tab the new section belongs to (M45.6) — the canvas's ACTIVE tab, so
   * the + adds to the tab you are looking at. Null (simple structure, or a
   * caller with no tab in hand) mints it untabbed, which means the default
   * tab. Both doors pass it, or "Add section" would mean two different things
   * depending on which one you walked through. */
  tab?: string | null,
): void {
  const minted = addGroup(
    draft.layout,
    draft.layout.groups.map((g) => g.id),
    tab,
  );
  update({ layout: minted.layout });
  openEditor(minted.id);
}

/**
 * Drop resolution, pure and exported for direct testing — DashboardView's
 * `handleWidgetDragEnd` pattern. Two id grammars, matched by prefix so a
 * field can never land on a group target or vice versa:
 *
 * - field drags: active `field:<name>` over `slot:<container>:<index>`, the
 *   container greedy to the LAST colon (moveToSlot's regex lesson — an id
 *   may itself carry one). ed07f13's parse-door guarantee keeps `heading`
 *   and `rest` from ever naming a group, so the sentinels are
 *   collision-proof targets.
 * - group drags: active `group:<id>` over `groupslot:<index>`.
 *
 * The pure editors take POST-removal indexes, but a slot is a gap the user
 * saw with the dragged thing still in place — so a same-container drop past
 * the source is one slot ahead, and the conversion lives HERE, per
 * container (moveToSlot's M44.4 lesson: `if (from < slot) slot -= 1`).
 * The editors return the same reference on a no-op; an identity drop
 * commits nothing.
 */
export function handleLayoutDragEnd(
  event: DragEndEvent,
  args: { layout: LayoutConfig; commit: (next: LayoutConfig) => void },
): void {
  const over = event.over === null ? null : String(event.over.id);
  if (over === null) return;
  const active = String(event.active.id);

  if (active.startsWith('group:')) {
    const m = over.match(/^groupslot:(\d+)$/);
    if (m === null) return;
    const id = active.slice('group:'.length);
    let slot = Number(m[1]);
    const from = args.layout.groups.findIndex((g) => g.id === id);
    if (from !== -1 && from < slot) slot -= 1;
    const next = moveGroup(args.layout, id, slot);
    if (next !== args.layout) args.commit(next);
    return;
  }

  if (!active.startsWith('field:')) return;
  const m = over.match(/^slot:(.+):(\d+)$/);
  if (m === null) return;
  const name = active.slice('field:'.length);
  const container = m[1];
  let slot = Number(m[2]);
  // `rest` matches no group (the sentinel guarantee) and its index is
  // ignored by moveField anyway — `from` stays -1 there by construction.
  const target =
    container === 'heading'
      ? args.layout.heading
      : args.layout.groups.find((g) => g.id === container)?.fields;
  const from = target === undefined ? -1 : target.indexOf(name);
  if (from !== -1 && from < slot) slot -= 1;
  const next = moveField(args.layout, name, { container, index: slot });
  if (next !== args.layout) args.commit(next);
}

/**
 * The canvas renders from the DRAFT — not RecordProperties, which resolves
 * the LIVE typeDef's `layout:`/`display` and would keep previewing the
 * vault while the user edits the stage. Same visual grammar, draft-driven —
 * over the STAGED roster, so a Task-5 added field previews before Apply.
 */
export function LayoutCanvas({
  typeDef,
  draft,
  previewEntry,
  schema,
  update,
}: {
  typeDef: TypeDef;
  draft: TypeLayoutDraft;
  previewEntry: Entry;
  schema: Schema;
  /** The draft's one door — handed through to the group editor (M45.3). */
  update: (patch: Partial<TypeLayoutDraft>) => void;
}) {
  // Which container's group editor is open. The shells register their DOM
  // nodes in a map read LAZILY by the popover's anchor, so an editor opened
  // on a container whose shell mounts in the same commit (Add section)
  // still measures against the real node.
  const [editing, setEditing] = useState<string | null>(null);
  // Which tab the canvas is standing on (M45.5 Task 2). An id, not a def, so
  // an edit to the tab set flows straight through it — and the derivation
  // below falls back to the first tab when the id names none, because a
  // deleted (or reseeded) tab must never strand the canvas on nothing.
  //
  // Seeded with the first tab's id rather than null, because the strip only
  // reports a press that CHANGES the tab (pressing the active one opens its
  // menu): a `null` standing for "nothing chosen yet" would be resolved by
  // the same fallback that serves a dead id, so reordering the tab you are
  // standing on — Move right, or a grip drag into slot 0 — would silently
  // move the canvas onto whatever tab took first place. The id is the
  // answer; the fallback is for when it stops being one.
  const [selectedTab, setSelectedTab] = useState<string | null>(() => draft.tabs[0]?.id ?? null);
  const shells = useRef(new Map<string, HTMLDivElement>());
  const anchorRef = useMemo(
    () => ({
      get current() {
        return editing === null ? null : (shells.current.get(editing) ?? null);
      },
    }),
    [editing],
  );
  // BoardView's exact sensors: distance-4 keeps a grip press from eating
  // ordinary clicks; Space picks up and drops, arrows move, Escape cancels.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  // Simple structure (`tabs: []`) has no tab to stand on, and no strip.
  const activeTab =
    draft.tabs.length === 0
      ? null
      : (draft.tabs.find((t) => t.id === selectedTab) ?? draft.tabs[0]);
  // Does the active tab render a property stack at all? A `sections` or
  // `view` tab IS its content, and the record surfaces show no groups on
  // either — so neither does the canvas (M45.6 Task 4, closing the M45.5 gap
  // where the Overview's zones stacked under such a tab's placeholder).
  const bearsProperties = activeTab === null || tabBearsProperties(activeTab);

  // The preview is the ACTIVE TAB'S (M45.6): the group blocks shown are the
  // ones that tab holds. `layoutTabScope` is the one place "which tab is
  // default" is decided, and no tab at all resolves tab-blind — pre-M45.6
  // behavior verbatim, every group on the one canvas.
  const previewLayout = resolveLayout(
    draft.layout,
    draftRoster(typeDef.fields, draft.added),
    activeTab === null ? undefined : layoutTabScope(draft.tabs, activeTab.id),
  );
  // A container whose SHELL is not on screen has nothing for the editor to
  // anchor to, and `Popover.measure` bails on a null anchor — an unpositioned
  // floating editor over a canvas with no shell under it. Delete section is
  // one way to lose the shell; since M45.6 so is standing on another tab. The
  // heading is the one container that renders on every tab, so it is always
  // valid.
  //
  // The shell can leave with no press to hang a `setEditing(null)` on: a tab
  // REORDER changes which tab is default, and an untabbed section moves with
  // it while the selection stands still (the case the suite drives). The
  // `bearsProperties` arm is the defensive half — today's strip offers no way
  // to change a tab's content KIND, so it guards a state only a future
  // affordance (or a vault edit under an open dialog) can reach. Kept because
  // rest's shell stands down with the group stack, and the alternative to a
  // cheap predicate is an anchorless popover.
  const editingValid =
    editing !== null &&
    (editing === 'heading' ||
      (bearsProperties &&
        (editing === 'rest' || previewLayout.groups.some((g) => g.id === editing))));
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
  // The strip's OWN fold predicate decides whether cells render (stripCells
  // is exported for exactly this), but it no longer gates the SHELL — see the
  // persistent-shell rule at the render below.
  const headingFields = overlayVisibility(previewLayout.heading, draft.visibility);
  const headingShown =
    stripCells(previewEntry, schema, headingFields, draft.display.showEmpty).length > 0;
  const previewRow = (f: FieldDef) => (
    <PropertyRow kind={f.kind} name={f.name} align={f.kind === 'checkbox' ? 'center' : 'start'}>
      <FieldEditor entry={previewEntry} def={f} schema={schema} />
    </PropertyRow>
  );

  const openEditor = (container: string) => () => setEditing(container);
  const registerShell = (container: string) => (el: HTMLDivElement | null) => {
    if (el === null) shells.current.delete(container);
    else shells.current.set(container, el);
  };

  return (
    // The DndContext stands UNCONDITIONALLY (DashboardView's lesson: a
    // conditional wrapper remounts every shell — and here every open
    // popover — the moment it appears).
    <DndContext
      sensors={sensors}
      onDragEnd={(e) =>
        handleLayoutDragEnd(e, {
          layout: draft.layout,
          commit: (next) => update({ layout: next }),
        })
      }
    >
      {/* The canvas container is LIVE (M45.3): interactivity belongs to the
          BlockShells inside it, and the `inert` that used to sit here moved
          inward — see InertContent for the boundary's rationale. */}
      <div data-testid="layout-preview" className="min-w-0 flex-1 overflow-auto p-6">
        {/* gap-3 spaces the OUTER column's bordered shells (M45.5) — heading,
            tabs, the group stack, content — so borders never fuse and the
            overhanging -top-2 label chips keep headroom; INSIDE the group
            stack the block-size DropSlots do that same job. */}
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {/* Every property container keeps its shell even when folding empties
              it (Task 4 review ruling: "the editor is where hidden things stay
              visible") — a fold-emptied container must stay clickable, or the
              only door to un-hiding its fields would fold away with them. The
              heading's shell is unconditional for the same reason: it is
              "Move to heading"'s target even while nothing shows there. */}
          <BlockShell
            container="heading"
            label="Heading"
            onOpen={openEditor('heading')}
            shellRef={registerShell('heading')}
          >
            {/* The heading's one droppable APPENDS (config-end index): its
                cells render inside HeadingProperties' own strip markup — no
                seam for per-index slots without restructuring a shared
                component — so a drop ONTO the strip lands at its end. What
                the canvas cannot offer, the panel now does: M45.5 Task 4 put
                a drag grip on every group-editor row, heading rows included,
                so in-heading order is arranged THERE and is no longer
                arrival order. The droppable stands even when the strip is
                empty, because this is §3.4's promote target and the shell
                persists (Task 6). */}
            <AreaDrop id={`slot:heading:${draft.layout.heading.length}`}>
              <InertContent>
                {headingShown ? (
                  <HeadingProperties
                    entry={previewEntry}
                    schema={schema}
                    // The strip folds by the DRAFT too — staged visibility
                    // overlaid on its cells, staged show-empty for the fold.
                    fields={headingFields}
                    showEmpty={draft.display.showEmpty}
                  />
                ) : (
                  <ShellEmptyHint structural={previewLayout.heading.length === 0} />
                )}
              </InertContent>
            </AreaDrop>
          </BlockShell>
          {/* Notion's canvas order (M45.5): heading first, THEN the tab strip,
              then the groups. Simple structure (no tabs) renders no strip. */}
          {activeTab !== null && (
            <BlockShell container="tabs" label="Tabs">
              {/* LIVE, and so OUTSIDE every inert fragment (M45.5 Task 2, the
                  2026-08-29 user directive reversing M45.4's one-surface
                  ruling): the strip's own rename, delete, reorder, duplicate,
                  "+ Tab" and "Change source…" all report the whole next tab
                  set, and it stages through the draft's one door — landing
                  with everything else on Apply. The record surfaces' strips
                  stay the VAULT's editing surface — the page's and, since
                  92e5dc5, the peek's, both firing `setTypeTabs` — while this
                  one is the DRAFT's; they stage into different stores and
                  never race. `hostType` is the type being edited,
                  which is what a new view tab's related-scope toggle gates on. */}
              <RecordTabs
                tabs={draft.tabs}
                activeId={activeTab.id}
                onSelect={(id) => {
                  // The open group editor is anchored to a shell this switch
                  // may unmount (M45.6): the canvas now shows ONE tab's
                  // sections, so an editor left open on another tab's group
                  // would hang off a node that is gone. Put it down with the
                  // tab it belonged to.
                  setEditing(null);
                  setSelectedTab(id);
                }}
                onChange={(next) => update({ tabs: next })}
                hostType={typeDef.name}
              />
              {/* The tab's OWN content, for the two kinds that ARE their
                  content (M45.6 Task 4). M45.4's ruling holds for the view
                  arm — the canvas does not live-embed a view tab (weight
                  without fidelity), so it names the source instead — and the
                  `sections` arm is the same bargain: free text is written per
                  RECORD, and the canvas edits a TYPE. Both follow the
                  SELECTION since the strip went live, and both are preview,
                  so they keep their inert fragment while the strip above does
                  not. The property zones below stand down for these two — see
                  `bearsProperties`. */}
              {!bearsProperties && (
                <InertContent>
                  <div
                    data-testid={
                      activeTab.content === 'view'
                        ? 'layout-preview-viewtab'
                        : 'layout-preview-sectionstab'
                    }
                    className="px-1 pb-1.5 pt-2 text-xs text-n-400"
                  >
                    {activeTab.content === 'view'
                      ? viewTabPlaceholder(activeTab)
                      : 'Free text, written on each record — shown on the record'}
                  </div>
                </InertContent>
              )}
            </BlockShell>
          )}
          {bearsProperties && (
            <div className="flex flex-col">
              {previewLayout.groups.map((g) => {
                // The preview is FILTERED to the active tab (M45.6), so a render
                // position is NOT a config position — and every id below speaks
                // to an editor that operates on the whole config, across every
                // tab. `cfg` is addressed by ID (a folded row still occupies its
                // config slot, so the field slots need the real field list) and
                // the block slots by CONFIG index, because moveGroup reorders
                // the global list. Reading either off the render index moves the
                // wrong section, or lands a field in another group's slot.
                const at = draft.layout.groups.findIndex((c) => c.id === g.id);
                const cfg = draft.layout.groups[at];
                const rows = canvasRows(g.fields);
                return (
                  <Fragment key={g.id}>
                    {/* Block-reorder targets bracket every group shell. The id
                      names the gap BEFORE this group's config slot, so a drop
                      lands the dragged section immediately before it — with
                      any other tab's sections in between left where they
                      are. */}
                    <DropSlot id={`groupslot:${at}`} size="block" />
                    <BlockShell
                      container={g.id}
                      label={g.name}
                      onOpen={openEditor(g.id)}
                      shellRef={registerShell(g.id)}
                      dragId={`group:${g.id}`}
                    >
                      {rows.length === 0 ? (
                        // Structurally empty (the editor's drop target) and
                        // emptied by FOLDING both keep the shell; the hint tells
                        // them apart, because "hidden" and "absent" are
                        // different sentences. Either way the group keeps ONE
                        // slot at its config end — the shell persists, so its
                        // drop target must too.
                        <>
                          <InertContent>
                            <ShellEmptyHint structural={g.fields.length === 0} />
                          </InertContent>
                          <DropSlot id={`slot:${g.id}:${cfg.fields.length}`} />
                        </>
                      ) : (
                        // No inner GroupLabel here (M45.5): the shell's
                        // always-visible header IS the zone's one label. The
                        // real record page keeps its GroupLabel — canvas only.
                        <div
                          data-testid="property-group"
                          data-group={g.id}
                          className="flex flex-col"
                        >
                          {rows.map((f) => (
                            <Fragment key={f.name}>
                              <DropSlot id={`slot:${g.id}:${cfg.fields.indexOf(f.name)}`} />
                              <FieldRow name={f.name}>{previewRow(f)}</FieldRow>
                            </Fragment>
                          ))}
                          <DropSlot id={`slot:${g.id}:${cfg.fields.length}`} />
                        </div>
                      )}
                    </BlockShell>
                  </Fragment>
                );
              })}
              {/* The trailing gap is the CONFIG end, never the preview's: a
                section dropped past this tab's last one goes last overall. */}
              <DropSlot id={`groupslot:${draft.layout.groups.length}`} size="block" />
              {/* Notion's circular + below the last block (M45.5 Task 3), the
                canvas door onto the same staging the group editor's footer
                entry walks — two doors, one editor, one `stageNewSection`.
                A real <button>, so Tab reaches it and Enter fires it, and
                tooltipped because IconButton's rule is label AND tooltip for
                anything icon-only.

                The glyph is `text-inverse` (#ffffff in both themes), NOT
                `text-n-0`: the neutral ramp inverts, so on this cortex-600
                fill a dark-theme n-0 measured 2.4:1 — at rest the button read
                as a dark disc with a plus-shaped hole, on the one control
                whose whole job is being found. Hover (cortex-700, a light
                tint in dark) was never the problem; the resting state was. */}
              <div className="flex justify-center pb-3">
                <Tooltip label="Add section">
                  <button
                    type="button"
                    aria-label="Add section"
                    data-testid="layout-add-section"
                    onClick={() =>
                      stageNewSection(draft, update, setEditing, activeTab?.id ?? null)
                    }
                    className="flex h-7 w-7 items-center justify-center rounded-full border-0 bg-cortex-600 p-0 text-inverse hover:bg-cortex-700 focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                  >
                    <Icon name="plus" size={16} />
                  </button>
                </Tooltip>
              </div>
              {/* Rest LAST and headerless, RecordProperties' own order.
                Its shell says "Properties" — the block's Notion name,
                since headerless content has no label of its own. */}
              <BlockShell
                container="rest"
                label="Properties"
                onOpen={openEditor('rest')}
                shellRef={registerShell('rest')}
              >
                {/* rest is DERIVED — roster-ordered, its index ignored by
                  moveField — so an insertion LINE would promise a position
                  it cannot deliver; the whole area is the honest target. */}
                <AreaDrop id="slot:rest:0">
                  {restRows.length > 0 ? (
                    <div className="flex flex-col gap-[7px]">
                      {restRows.map((f) => (
                        <FieldRow key={f.name} name={f.name}>
                          {previewRow(f)}
                        </FieldRow>
                      ))}
                    </div>
                  ) : (
                    <InertContent>
                      <ShellEmptyHint structural={previewLayout.rest.length === 0} />
                    </InertContent>
                  )}
                </AreaDrop>
              </BlockShell>
            </div>
          )}
          {/* OVERVIEW is the one kind that renders the body, and the canvas
              says so because both hosts do (M45.6): DocPage gates its editor
              block on `activeTab.content === 'overview'` and DetailPanel
              spells this predicate verbatim. Anywhere else — a `properties`
              tab as much as a `sections` or `view` one — a Content block
              would be the Overview leaking through, the same leak the
              property zones above stand down to stop. */}
          {draft.display.showBody && (activeTab === null || activeTab.content === 'overview') && (
            <BlockShell container="content" label="Content">
              {/* The body as a placeholder block: the preview stages the page's
                  SHAPE, and a real body would need a real read. */}
              <InertContent>
                {/* No top margin of its own since M45.5 — the bordered shell's
                    padding and the column gap own the spacing now. */}
                <div data-testid="layout-preview-body">
                  <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                    Description
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="h-2.5 w-11/12 rounded-sm bg-n-100" />
                    <div className="h-2.5 w-4/5 rounded-sm bg-n-100" />
                    <div className="h-2.5 w-3/5 rounded-sm bg-n-100" />
                  </div>
                </div>
              </InertContent>
            </BlockShell>
          )}
          {draft.display.showFile && previewEntry.path !== '' && (
            // DetailPanel's muted file-path row (M44.1), staged: the draft
            // raises it. The synthetic stand-in has no path, and absent is
            // never faked — no path, no row.
            <div
              data-testid="layout-preview-file"
              className="truncate font-mono text-2xs text-n-400"
              title={previewEntry.path}
            >
              {previewEntry.path}
            </div>
          )}
        </div>
        {editing !== null && editingValid && (
          // Keyed by container: retargeting the editor (Add section opens the
          // fresh group's) must reseed its steps and name draft, the same
          // remount rule the dialog applies per type.
          <GroupEditorPopover
            key={editing}
            container={editing}
            typeDef={typeDef}
            draft={draft}
            activeTab={activeTab?.id ?? null}
            update={update}
            anchorRef={anchorRef}
            onClose={() => setEditing(null)}
            onOpenGroup={setEditing}
          />
        )}
      </div>
    </DndContext>
  );
}

/** The view-tab placeholder's one line (M45.4): the source named straight off
 * the POINTER — type name or list id. Not resolved, for two real reasons:
 * the canvas takes a draft and a type def, not the entries and list files a
 * resolution would read (M45.5 note — the live strip's own "View of"
 * drill-in DOES subscribe to the vault for its roster, but that read is
 * RecordTabs', inside the strip, and the canvas still has none of it) — and a
 * dead list pointer has no title to offer, so the id fallback is needed
 * regardless. A sourceless tab says what the record's surfaces will show: the
 * broken card, never an empty view.
 *
 * "on the record", not "on the record page" (M45.6): the peek renders these
 * same four arms since 92e5dc5, so a line promising the PAGE would name one
 * of the two places the tab appears. */
function viewTabPlaceholder(tab: TabDef): string {
  const source = tab.source ?? null;
  if (source === null) return 'View of a missing source — shown broken on the record';
  const name = 'type' in source ? source.type : source.list;
  return `View of ${name} — shown on the record`;
}

/** The persistent shell's stand-in content when no row renders: which KIND
 * of empty this is — structurally empty ("No properties yet") or emptied by
 * folding ("All properties hidden"). Two hints because "hidden" and "absent"
 * are different sentences. Just the sentence, no label of its own (M45.5):
 * the shell's always-visible header already names the zone. */
function ShellEmptyHint({ structural }: { structural: boolean }) {
  return (
    <div className="px-1 pb-1.5 text-xs text-n-400">
      {structural ? 'No properties yet' : 'All properties hidden'}
    </div>
  );
}

/**
 * One inert preview FRAGMENT — where the boundary lives now. Task 4 took
 * `inert` off the whole canvas and onto each block's single content div;
 * Task 6 moved it once more, onto each fragment of preview (the heading
 * strip, each field row, an empty hint), because the drag
 * layer's slots and grips must interleave WITH the rows, and a droppable or
 * draggable inside an inert subtree renders but can never fire — inert
 * blanks every pointer, key and focus path beneath it. The claim is
 * unchanged in spirit: everything PREVIEW is inert (live editors render
 * inside but the draft — not the vault — stays on stage; React 19 forwards
 * the attribute), everything INTERACTIVE stands between the fragments. No
 * aria-hidden alongside it: inert already removes the subtree from the
 * a11y tree, and a second claim could only drift from the first.
 */
function InertContent({ children }: { children: ReactNode }) {
  return (
    <div data-testid="layout-preview-content" inert>
      {children}
    </div>
  );
}

/** A droppable insertion point between rows or group shells — WidgetSlot's
 * idiom: invisible until a drag hovers it, then it paints itself as the
 * insertion line (the repo's inset-line style, no DragOverlay). Two sizes:
 * the `row` default's 6px doubles as a group's row gap, while `block` slots
 * between bordered shells stand 12px — a shell's label chip overhangs its
 * border by 8px (M45.5), and the slot's height is what keeps that chip off
 * the block above. Hover paint is identical for both. */
function DropSlot({ id, size = 'row' }: { id: string; size?: 'row' | 'block' }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-testid="layout-slot"
      data-slot={id}
      className={[
        size === 'block' ? 'h-3' : 'h-1.5',
        'w-full flex-none rounded',
        isOver ? 'bg-cortex-500' : 'bg-transparent',
      ].join(' ')}
    />
  );
}

/** A whole-container drop target for the containers where an insertion line
 * would lie — heading (appends at config end) and rest (index ignored). It
 * wears the cortex ring while a drag hovers, the drag-hover grammar the
 * shells already speak. */
function AreaDrop({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-testid="layout-droparea"
      data-slot={id}
      className={['rounded-md', isOver ? 'ring-1 ring-cortex-500' : ''].join(' ')}
    >
      {children}
    </div>
  );
}

/** One draggable field row: a gutter grip (the draggable NODE — its small
 * rect tracks the pointer into the thin slots, and the inert row keeps its
 * geometry; DashboardView's grip pattern) beside the row's inert preview.
 * The grip stops click propagation so a press that never became a drag does
 * not double as the shell's click-to-edit. */
function FieldRow({ name, children }: { name: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `field:${name}` });
  return (
    <div className="group/row relative" style={{ opacity: isDragging ? 0.6 : undefined }}>
      <span
        ref={setNodeRef}
        data-testid="layout-grip"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${humanize(name)}`}
        onClick={(e) => e.stopPropagation()}
        className="absolute -left-5 top-0.5 z-10 flex h-6 w-4 cursor-grab touch-none items-center justify-center rounded text-n-400 opacity-0 hover:bg-n-100 hover:text-n-700 focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <Icon name="grip-vertical" size={12} />
      </span>
      <InertContent>{children}</InertContent>
    </div>
  );
}

/**
 * One canvas block: an interactive SHELL around inert content (M45.3, plan
 * Decision "block chrome is the shell's"). The chrome idiom is WidgetShell's
 * shell-owns-the-chrome anatomy wearing Notion's titled-panel grammar in DS
 * tokens (M45.5): a PERSISTENT quiet border with padding so content never
 * touches it, the name chip top-left (StructureTile's active cortex palette)
 * always visible and overlapping the border, and the cortex ring on
 * hover/focus (CalendarView's drag ring) kept as the upgrade.
 *
 * The shell no longer wraps its children in the inert content div — Task 6
 * interleaves live drag controls (slots, grips) with inert preview inside
 * it, so each call site owns its fragments via InertContent, where the
 * boundary's rationale now lives. An `interactive` shell stays live: a
 * focusable role'd div (a real <button> cannot legally contain the block's
 * form controls), labeled for the a11y tree its inert content left, and
 * activating only on its OWN keys — a grip inside is a focusable child
 * whose Space belongs to the KeyboardSensor, not to opening the editor.
 *
 * `tabs` and `content` pass no `interactive` and are DEMOTED to plain chrome
 * (Task 5 review ruling): neither has a group editor for a press to open,
 * and a role=button that Enter cannot activate is a promise the a11y tree
 * has no way to keep. That is a claim about the SHELL, not its content —
 * since M45.5 Task 2 the tabs shell frames a LIVE strip that edits the draft
 * through its own controls. They keep the hover ring, the name chip and
 * `data-block`, so the canvas grammar — and the tests' addressing — stay
 * uniform.
 */
function BlockShell({
  container,
  label,
  onOpen,
  shellRef,
  dragId,
  children,
}: {
  /** 'heading' | groupId | 'rest' | 'content' | 'tabs' — Task 5/6's address. */
  container: string;
  label: string;
  /** Opens this container's group editor; absent on the demoted chrome. */
  onOpen?: () => void;
  /** Registers the shell node as the group editor's popover anchor. */
  shellRef?: (el: HTMLDivElement | null) => void;
  /** Makes the whole block draggable by a shell grip (`group:<id>`, block
   * reorder). Only group shells pass one. */
  dragId?: string;
  children: ReactNode;
}) {
  const interactive = onOpen !== undefined;
  // Registered even without a dragId (a hook cannot be conditional) but
  // disabled then — and the grip never renders, so setNodeRef stays
  // unattached and the registration costs nothing (DashboardView's idiom).
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId ?? `nodrag:${container}`,
    disabled: dragId === undefined,
  });
  return (
    <div
      ref={shellRef}
      {...(interactive ? { role: 'button', tabIndex: 0, 'aria-label': label } : {})}
      data-testid="layout-block"
      data-block={container}
      onClick={onOpen}
      // The source dims in place while its grip drags; no DragOverlay
      // (BoardView precedent).
      style={{ opacity: isDragging ? 0.6 : undefined }}
      // Enter AND Space on keydown — role=button's activation contract, the
      // same editor the click opens. Own target only: a grip's Space must
      // start a drag, not open the editor over it (M45.3 Task 6).
      onKeyDown={
        onOpen === undefined
          ? undefined
          : (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onOpen();
            }
      }
      className={[
        'group/block relative rounded-md border border-n-200 px-3 py-2 ring-cortex-500 hover:ring-1',
        interactive ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-1' : '',
      ].join(' ')}
    >
      <span
        data-testid="layout-block-label"
        className="pointer-events-none absolute -top-2 left-1.5 z-10 rounded border border-cortex-500 bg-cortex-50 px-1 text-2xs font-medium text-cortex-700"
      >
        {label}
      </span>
      {dragId !== undefined && (
        <span
          ref={setNodeRef}
          data-testid="layout-group-grip"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${label}`}
          onClick={(e) => e.stopPropagation()}
          className="absolute -left-5 top-1 z-10 flex h-6 w-4 cursor-grab touch-none items-center justify-center rounded text-n-400 opacity-0 hover:bg-n-100 hover:text-n-700 focus-visible:opacity-100 group-hover/block:opacity-100"
        >
          <Icon name="grip-vertical" size={12} />
        </span>
      )}
      {children}
    </div>
  );
}
