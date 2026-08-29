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
import { GroupLabel } from '@/detail/GroupLabel';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { PropertyRow } from '@/detail/PropertyRow';
import { RecordTabs } from '@/detail/RecordTabs';
import { resolveLayout } from '@/engine/layout';
import { moveField, moveGroup } from '@/engine/layoutEdit';
import { foldsWhenUnset, splitByVisibility } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import type { Entry, FieldDef, LayoutConfig, Schema, TypeDef } from '@/engine/types';

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
  const shells = useRef(new Map<string, HTMLDivElement>());
  const anchorRef = useMemo(
    () => ({
      get current() {
        return editing === null ? null : (shells.current.get(editing) ?? null);
      },
    }),
    [editing],
  );
  // A container the draft no longer holds (Delete section) has nothing to
  // edit — heading and rest are structural and always valid.
  const editingValid =
    editing !== null &&
    (editing === 'heading' ||
      editing === 'rest' ||
      draft.layout.groups.some((g) => g.id === editing));

  // BoardView's exact sensors: distance-4 keeps a grip press from eating
  // ordinary clicks; Space picks up and drops, arrows move, Escape cancels.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

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
        <div className="mx-auto flex max-w-2xl flex-col">
          {draft.tabs.length > 0 && (
            <BlockShell container="tabs" label="Tabs">
              <InertContent>
                <RecordTabs
                  tabs={draft.tabs}
                  activeId={draft.tabs[0].id}
                  // No-ops: intent can never leave an inert strip anyway.
                  onSelect={() => undefined}
                  onChange={() => undefined}
                />
              </InertContent>
            </BlockShell>
          )}
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
                component — and in-heading order is the group editor's moves.
                It stands even when the strip is empty, because this is
                §3.4's promote target and the shell persists (Task 6). */}
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
                  <ShellEmptyHint label="Heading" structural={previewLayout.heading.length === 0} />
                )}
              </InertContent>
            </AreaDrop>
          </BlockShell>
          <div className="flex flex-col">
            {previewLayout.groups.map((g, i) => {
              // resolveLayout maps config groups 1:1 in order, so the CONFIG
              // group — whose indexes the slot ids must speak, because a
              // folded row still occupies its config slot — rides the same i.
              const cfg = draft.layout.groups[i];
              const rows = canvasRows(g.fields);
              return (
                <Fragment key={g.id}>
                  {/* Block-reorder targets bracket every group shell. */}
                  <DropSlot id={`groupslot:${i}`} />
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
                          <ShellEmptyHint label={g.name} structural={g.fields.length === 0} />
                        </InertContent>
                        <DropSlot id={`slot:${g.id}:${cfg.fields.length}`} />
                      </>
                    ) : (
                      <div data-testid="property-group" data-group={g.id} className="flex flex-col">
                        <InertContent>
                          <GroupLabel name={g.name} />
                        </InertContent>
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
            <DropSlot id={`groupslot:${previewLayout.groups.length}`} />
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
                    <ShellEmptyHint
                      label="Properties"
                      structural={previewLayout.rest.length === 0}
                    />
                  </InertContent>
                )}
              </AreaDrop>
            </BlockShell>
          </div>
          {draft.display.showBody && (
            <BlockShell container="content" label="Content">
              {/* The body as a placeholder block: the preview stages the page's
                  SHAPE, and a real body would need a real read. */}
              <InertContent>
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
              </InertContent>
            </BlockShell>
          )}
          {draft.display.showFile && previewEntry.path !== '' && (
            // DetailPanel's muted file-path row (M44.1), staged: the draft
            // raises it. The synthetic stand-in has no path, and absent is
            // never faked — no path, no row.
            <div
              data-testid="layout-preview-file"
              className="mt-4 truncate font-mono text-2xs text-n-400"
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

/** The persistent shell's stand-in content when no row renders: the block's
 * quiet caps label plus which KIND of empty this is — structurally empty
 * ("No properties yet") or emptied by folding ("All properties hidden").
 * Two hints because "hidden" and "absent" are different sentences. */
function ShellEmptyHint({ label, structural }: { label: string; structural: boolean }) {
  return (
    <>
      <GroupLabel name={label} />
      <div className="px-1 pb-1.5 text-xs text-n-400">
        {structural ? 'No properties yet' : 'All properties hidden'}
      </div>
    </>
  );
}

/**
 * One inert preview FRAGMENT — where the boundary lives now. Task 4 took
 * `inert` off the whole canvas and onto each block's single content div;
 * Task 6 moved it once more, onto each fragment of preview (the heading
 * strip, a group's label, each field row, an empty hint), because the drag
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
 * insertion line (the repo's inset-line style, no DragOverlay). Its 6px
 * height doubles as the stack's row gap. */
function DropSlot({ id }: { id: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-testid="layout-slot"
      data-slot={id}
      className={[
        'h-1.5 w-full flex-none rounded',
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
 * shell-owns-the-chrome anatomy wearing Notion's block hover grammar in DS
 * tokens: the cortex ring on hover/focus (CalendarView's drag ring) and the
 * quiet name chip top-left (StructureTile's active cortex palette), revealed
 * by the named-group hover the sidebar controls use.
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
 * (Task 5 review ruling): no group editor exists for either, and a
 * role=button that Enter cannot activate is a promise the a11y tree has no
 * way to keep. They keep the hover ring, the name chip and `data-block`, so
 * the canvas grammar — and the tests' addressing — stay uniform.
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
        'group/block relative rounded-md ring-cortex-500 hover:ring-1',
        interactive ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-1' : '',
      ].join(' ')}
    >
      <span className="pointer-events-none absolute -top-2 left-1.5 z-10 rounded border border-cortex-500 bg-cortex-50 px-1 text-2xs font-medium text-cortex-700 opacity-0 group-hover/block:opacity-100 group-focus-visible/block:opacity-100">
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
