import { useEffect, useState } from 'react';
import { applyTypeLayout, type TypeLayoutDraft } from '@/app/typeActions';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { LayoutCanvas } from '@/detail/LayoutCanvas';
import { resolveLayout } from '@/engine/layout';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, TypeDef } from '@/engine/types';
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
            <LayoutCanvas
              typeDef={typeDef}
              draft={draft}
              previewEntry={previewEntry}
              schema={schema}
              update={update}
            />
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
