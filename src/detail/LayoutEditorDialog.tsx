import { useEffect, useState } from 'react';
import { applyTypeLayout, type TypeLayoutDraft } from '@/app/typeActions';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { resolveLayout } from '@/engine/layout';
import { typeStyle } from '@/engine/typeCatalog';
import type { TypeDef } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useSchema } from '@/stores/vaultStore';

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

/** The one door every draft edit walks through — the rail's controls call
 * this (M45.2 Task 3). Exported pure so tests can stage an edited draft
 * before any control exists to click. */
export function updateDraft(
  draft: TypeLayoutDraft,
  patch: Partial<TypeLayoutDraft>,
): TypeLayoutDraft {
  return { ...draft, ...patch };
}

/**
 * Does the draft differ from its seed? Recursive structural compare, the
 * navStore `sameSelection` shape: a stringify compare would make the answer
 * depend on key order, and these two objects were built by different code
 * paths. Arrays compare positionally through their index keys, so a reorder
 * counts as an edit — which for a layout it is.
 */
export function draftDirty(draft: TypeLayoutDraft, seed: TypeLayoutDraft): boolean {
  const equal = (x: unknown, y: unknown): boolean => {
    if (x === y) return true;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    const xr = x as Record<string, unknown>;
    const yr = y as Record<string, unknown>;
    const keys = new Set([...Object.keys(xr), ...Object.keys(yr)]);
    return [...keys].every((k) => equal(xr[k], yr[k]));
  };
  return !equal(draft, seed);
}

/**
 * The Customize-layout screen (M45.2, spec §3.2): one fullscreen Dialog
 * mounted once at App level, raised by `uiStore.layoutEditor`. Everything
 * edits a staged `TypeLayoutDraft`; `applyTypeLayout` is the only write and
 * the dialog closes only on `true` (M14.8).
 *
 * `initialDraft` is a test seam until the rail lands (Task 3): dirty state
 * has no UI door yet, so tests mount an already-edited draft built with
 * `updateDraft`. App passes nothing.
 */
export function LayoutEditorDialog({ initialDraft }: { initialDraft?: TypeLayoutDraft } = {}) {
  const signal = useUiStore((s) => s.layoutEditor);
  if (signal === null) return null;
  // Keyed so a retargeted signal reseeds the draft instead of editing one
  // type's layout under another's name.
  return <LayoutEditorCard key={signal.type} type={signal.type} initialDraft={initialDraft} />;
}

function LayoutEditorCard({
  type,
  initialDraft,
}: {
  type: string;
  initialDraft?: TypeLayoutDraft;
}) {
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
  return <LayoutEditorBody typeDef={typeDef} initialDraft={initialDraft} />;
}

function LayoutEditorBody({
  typeDef,
  initialDraft,
}: {
  typeDef: TypeDef;
  initialDraft?: TypeLayoutDraft;
}) {
  const schema = useSchema();
  const closeLayoutEditor = useUiStore((s) => s.closeLayoutEditor);
  // The seed is captured at mount: dirty means "differs from what the editor
  // opened on", not from wherever the schema has drifted since.
  const [seed] = useState(() => seedDraft(typeDef));
  const [draft] = useState(initialDraft ?? seed);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  const style = typeStyle(typeDef.name, schema);
  return (
    <>
      <Dialog open fullscreen onClose={maybeClose} title={`Customize ${typeDef.name} layout`}>
        <div data-testid="layout-editor" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-n-100 px-4 py-2">
            <span
              className="flex items-center gap-1.5 text-sm font-medium text-n-800"
              style={{ color: style.color ?? undefined }}
            >
              <Icon name={style.icon} size={14} />
            </span>
            <span className="text-sm font-medium text-n-800">{typeDef.name}</span>
            {/* Preview: <record> picker mounts here (Task 4). */}
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
            {/* The inert preview canvas renders here (Task 4). */}
            <div data-testid="layout-preview" className="min-w-0 flex-1 overflow-auto" />
            {/* The Page settings rail renders here (Task 3). */}
            <div
              data-testid="layout-rail"
              className="w-72 flex-none overflow-auto border-l border-n-100"
            />
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
