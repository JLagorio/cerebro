import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { TypeLayoutDraft } from '@/app/typeActions';
import { FieldEditor } from '@/detail/FieldEditor';
import { GroupEditorPopover } from '@/detail/GroupEditorPopover';
import { GroupLabel } from '@/detail/GroupLabel';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { PropertyRow } from '@/detail/PropertyRow';
import { RecordTabs } from '@/detail/RecordTabs';
import { resolveLayout } from '@/engine/layout';
import { foldsWhenUnset, splitByVisibility } from '@/engine/properties';
import type { Entry, FieldDef, Schema, TypeDef } from '@/engine/types';

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
    <PropertyRow
      key={f.name}
      kind={f.kind}
      name={f.name}
      align={f.kind === 'checkbox' ? 'center' : 'start'}
    >
      <FieldEditor entry={previewEntry} def={f} schema={schema} />
    </PropertyRow>
  );

  const openEditor = (container: string) => () => setEditing(container);
  const registerShell = (container: string) => (el: HTMLDivElement | null) => {
    if (el === null) shells.current.delete(container);
    else shells.current.set(container, el);
  };

  return (
    /* The canvas container is LIVE (M45.3): interactivity belongs to the
       BlockShells inside it, and the `inert` that used to sit here moved
       inward onto each shell's content div — see BlockShell for the
       boundary's rationale. */
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
        </BlockShell>
        <div className="flex flex-col gap-[7px]">
          {previewLayout.groups.map((g) => {
            const rows = canvasRows(g.fields);
            return (
              <BlockShell
                key={g.id}
                container={g.id}
                label={g.name}
                onOpen={openEditor(g.id)}
                shellRef={registerShell(g.id)}
              >
                {rows.length === 0 ? (
                  // Structurally empty (the editor's drop target) and emptied
                  // by FOLDING both keep the shell; the hint tells them
                  // apart, because "hidden" and "absent" are different
                  // sentences.
                  <ShellEmptyHint label={g.name} structural={g.fields.length === 0} />
                ) : (
                  <div
                    data-testid="property-group"
                    data-group={g.id}
                    className="flex flex-col gap-[7px]"
                  >
                    <GroupLabel name={g.name} />
                    {rows.map(previewRow)}
                  </div>
                )}
              </BlockShell>
            );
          })}
          {/* Rest LAST and headerless, RecordProperties' own order.
              Its shell says "Properties" — the block's Notion name,
              since headerless content has no label of its own. */}
          <BlockShell
            container="rest"
            label="Properties"
            onOpen={openEditor('rest')}
            shellRef={registerShell('rest')}
          >
            {restRows.length > 0 ? (
              <div className="flex flex-col gap-[7px]">{restRows.map(previewRow)}</div>
            ) : (
              <ShellEmptyHint label="Properties" structural={previewLayout.rest.length === 0} />
            )}
          </BlockShell>
        </div>
        {draft.display.showBody && (
          <BlockShell container="content" label="Content">
            {/* The body as a placeholder block: the preview stages the page's
                SHAPE, and a real body would need a real read. */}
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
        />
      )}
    </div>
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
 * claim could only drift from the first. An `interactive` shell stays live: a
 * focusable role'd div (a real <button> cannot legally contain the block's
 * form controls), labeled for the a11y tree its inert content left.
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
  children,
}: {
  /** 'heading' | groupId | 'rest' | 'content' | 'tabs' — Task 5/6's address. */
  container: string;
  label: string;
  /** Opens this container's group editor; absent on the demoted chrome. */
  onOpen?: () => void;
  /** Registers the shell node as the group editor's popover anchor. */
  shellRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const interactive = onOpen !== undefined;
  return (
    <div
      ref={shellRef}
      {...(interactive ? { role: 'button', tabIndex: 0, 'aria-label': label } : {})}
      data-testid="layout-block"
      data-block={container}
      onClick={onOpen}
      // Enter AND Space on keydown — role=button's activation contract, the
      // same editor the click opens.
      onKeyDown={
        onOpen === undefined
          ? undefined
          : (e) => {
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
      <div data-testid="layout-preview-content" inert>
        {children}
      </div>
    </div>
  );
}
