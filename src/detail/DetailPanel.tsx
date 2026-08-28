import { useEffect, useRef, useState } from 'react';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { DetailHeaderActions } from '@/detail/DetailHeaderActions';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { RecordProperties } from '@/detail/RecordProperties';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import { GitHistoryPanel } from '@/git/GitHistoryPanel';
import { InlineDiff } from '@/git/InlineDiff';
import { spliceTitleIntoBlocks } from '@/editor/markdown';
import { sourceFreshness } from '@/engine/ingest';
import { resolveLayout } from '@/engine/layout';
import { typeStyle } from '@/engine/typeCatalog';
import { DISPLAY_DEFAULTS, type Entry } from '@/engine/types';
import { KnowledgeCommit } from '@/knowledge/KnowledgeCommit';
import { RelatedKnowledge } from '@/knowledge/RelatedKnowledge';
import { EntityDossier } from '@/knowledge/EntityDossier';
import { conceptsAbout, listConcepts } from '@/engine/okf';
import { setNoteTitle } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { augmentDocPrompt } from '@/lib/prompts';
import { useNavStore } from '@/stores/navStore';
import { ownsEscape, useLayer } from '@/components/ui/layers';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';
import { DETAIL_WIDTH_MAX, DETAIL_WIDTH_MIN, useUiStore } from '@/stores/uiStore';

/**
 * Knowledge beside a RECORD (M12): what this note gave the base, and what
 * the base can give it back. The doc side panel carried this as a tab;
 * records open here instead now, so the loop follows them. Collapsed until
 * asked — opening it IS the ask (M8.3: nothing speaks first).
 *
 * Which surface answers is capability-gated, not type-gated (M14.2): when the
 * base holds concepts ABOUT this entry itself, the entry is a subject and gets
 * its full dossier — believed, unsettled, read-from, retired. Otherwise the
 * wide-net related list, which is the right shape for a record the base only
 * knows *around* (via its project or links). Projects became ordinary records
 * (M12.5 aftermath), so the dossier that lived on the project page rides the
 * record panel now — no type name routes specially.
 */
/**
 * One sentence a cached copy owes its reader (M34.5.3): whether it is past
 * its refresh date, and when it was last fetched. The vault has held both
 * facts since `cache_source` first stamped them; this is the first surface
 * that says them. Renders nothing without the fetch bookkeeping — gated on
 * the PROPERTIES, never on `type: Source`, so it follows the record
 * wherever it lives (the no-type-routing rule).
 */
function SourceFreshnessLine({ entry }: { entry: Entry }) {
  const freshness = sourceFreshness(entry, todayIso());
  if (freshness === null) return null;
  const state =
    freshness.state === 'stale'
      ? `stale since ${freshness.staleAfter}`
      : freshness.state === 'fresh'
        ? `fresh until ${freshness.staleAfter}`
        : // Nobody said this copy expires — which is different from fresh,
          // and the Source Monitor refuses to invent a default schedule.
          'no refresh date set';
  const fetched =
    // NOT RECORDED, said out loud — never an epoch, never omitted into
    // looking fine.
    freshness.fetchedAt === null
      ? 'fetch not recorded'
      : `fetched ${freshness.fetchedAt.slice(0, 10)}`;
  return (
    <div
      data-testid="detail-source-freshness"
      className={`mb-3.5 [font-family:var(--font-mono)] text-2xs ${
        freshness.state === 'stale' ? 'text-warn-600' : 'text-n-400'
      }`}
    >
      Cached copy · {state} · {fetched}
    </div>
  );
}

function KnowledgeSection({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  const entries = useVaultStore((s) => s.entries);
  const isSubject =
    open && conceptsAbout(entry.path, listConcepts(entries, todayIso()), entries).length > 0;
  return (
    <section data-testid="detail-knowledge" className="mb-3.5 border-t border-n-100 pt-2">
      <button
        type="button"
        data-testid="detail-knowledge-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500 hover:text-n-800"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        Knowledge
      </button>
      {open && (
        <div className="flex flex-col gap-4 pb-1 pt-2">
          <KnowledgeCommit entry={entry} variant="panel" />
          <div className="border-t border-n-100 pt-3.5">
            {isSubject ? (
              <EntityDossier entry={entry} variant="panel" />
            ) : (
              <RelatedKnowledge
                entry={entry}
                variant="panel"
                askPrompt={augmentDocPrompt(entry.path, entry.title)}
                askSubject={entry.path}
                askLabel="What am I missing?"
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The record panel's own place in the layer stack (M16.29).
 *
 * The handler used to live in `DetailPanel` and ask `hasLayers()` — "is
 * anything dismissable open anywhere" — which made the panel a bystander to
 * its own keystroke rather than a participant in the stack. It got the answer
 * wrong in both directions. False negatives: the pre-M16.1 popovers register
 * nothing, so with the View settings panel open over a record, `hasLayers()`
 * said false, this handler ran, and Escape closed the RECORD and left the
 * popover floating over an empty canvas. And it could never say "the panel is
 * the innermost thing", only "nothing else is open".
 *
 * It lives in a child so the layer mounts and unmounts with the OPEN panel —
 * `DetailPanel`'s hooks run whether or not there is a record to show, and
 * `useLayer` up there would park a permanent entry on the stack for a
 * component rendering null. `Dialog` splits itself the same way and for the
 * same reason. Rendered first inside the panel so it registers before
 * anything the panel contains, since child effects run before their parent's.
 */
function DetailEscapeLayer({ onClose }: { onClose: () => void }) {
  const id = useLayer();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Anything registered above this owns the keystroke — a tooltip
      // included (M16.35). `isTopLayer` skips tooltips on purpose, so asking
      // it here let one Escape dismiss a header tooltip AND this whole panel.
      if (!ownsEscape(id)) return;
      // Two surfaces that are not layers yet and would otherwise lose their
      // Escape to this one: QuickOpen sits over the whole window, and the
      // inline diff renders INSIDE this panel, so the stack cannot tell it
      // apart from the panel it is in.
      const ui = useUiStore.getState();
      if (ui.quickOpenVisible || ui.diffView !== null) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);
  return null;
}

export function DetailPanel() {
  const detailPath = useUiStore((s) => s.detailPath);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const toast = useUiStore((s) => s.toast);
  const width = useUiStore((s) => s.detailWidth);
  const setWidth = useUiStore((s) => s.setDetailWidth);
  const entry = useEntry(detailPath);
  const schema = useSchema();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const entries = useVaultStore((s) => s.entries);
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);

  const [title, setTitle] = useState('');
  // Task 12: the body lives in the BlockNote editor (NoteBodyEditor owns
  // load/save). The handle is only needed for the rename splice below.
  const editorRef = useRef<CerebroEditor | null>(null);
  // M45.1 — whether the full property stack is open under the heading strip.
  // Sticky per record PATH (switching records resets it), and the untouched
  // default is derived per render below rather than stored: it must track
  // whether the strip actually SHOWS, which can change without the path
  // changing (clearing the strip's last hide_when_empty field folds it away).
  const [details, setDetails] = useState<{ path: string; shown: boolean } | null>(null);

  // M44.1: per-type presentation. Untyped records and types the schema
  // doesn't know about fall back to the pre-M44.1 defaults. Computed ahead
  // of the early return below (tolerating a null entry) so the effect right
  // after it can react to show_body toggling.
  const display =
    (entry && entry.type !== null ? schema.types.get(entry.type)?.display : undefined) ??
    DISPLAY_DEFAULTS;

  useEffect(() => {
    setTitle(entry?.title ?? '');
    // The keyed NoteBodyEditor remounts on path change; drop the stale
    // handle until the new editor reports ready. M44.1 follow-up: also drop
    // it when show_body flips off — NoteBodyEditor unmounts then too, and
    // nothing else nulled this ref, so a later commitTitle's splice could
    // hit a detached editor.
    editorRef.current = null;
  }, [entry?.path, entry?.title, display.showBody]);

  if (!detailPath || !entry) return null;

  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  // M45.1 (spec §3.4) — the type's `layout.heading` renders as the key
  // property strip between the title and the stack. `stripShows` is derived
  // per render with the strip's own fold predicate (amended Task 7 ruling):
  // the strip renders null when every cell folds, and the stack must never
  // stay hidden behind a strip that is not on screen — it renders whenever
  // `!stripShows || detailsShown`, and the untouched default for
  // `detailsShown` is `!stripShows` (per path) rather than a stored false.
  const typeDef = entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  const headingFields =
    typeDef === null ? [] : resolveLayout(typeDef.layout, typeDef.fields).heading;
  const stripShows =
    headingFields.length > 0 && stripCells(entry, schema, headingFields).length > 0;
  // Render-time derived-state reset (the React-sanctioned pattern): the lens
  // FORGETS a record it left. A one-slot {path, shown} cache gave a one-deep
  // memory — A(toggled) → B → A resurrected A's choice while A → B(toggled)
  // → A reset it — and RecordProperties' keyed `revealed` resets on every
  // switch, so remembering here was an accident, not a feature.
  if (details !== null && details.path !== entry.path) setDetails(null);
  const detailsShown = details?.path === entry.path ? details.shown : !stripShows;

  // The containing Collection (M12.5: the folder a legacy project.md marks),
  // unless you are already looking at it — a crumb back to the page you are
  // standing on is noise, not navigation.
  const containerFolder =
    entry.project === null
      ? null
      : entry.project.slice(0, Math.max(entry.project.lastIndexOf('/'), 0));
  const onItsCollection = selection.kind === 'collection' && selection.folder === containerFolder;
  const container =
    containerFolder !== null && !onItsCollection
      ? (entries.find((e) => e.path === entry.project) ?? null)
      : null;

  const commitTitle = async () => {
    const trimmed = title.trim();
    if (!vaultPath || trimmed === '' || trimmed === entry.title) {
      setTitle(entry.title);
      return;
    }
    // Failed rename: toast and revert the input to disk truth (16a guard
    // discipline). The rescan is caught separately — after a successful
    // rename the disk already holds the new name, so a refresh failure must
    // not claim the rename failed.
    try {
      await setNoteTitle(vaultPath, entry.path, trimmed);
    } catch {
      toast("Couldn't rename item");
      setTitle(entry.title);
      return;
    }
    // M1.x stale-body-after-rename, block edition: splice the new H1 into
    // the LIVE editor so its next debounced save writes the renamed title
    // (and keeps any dirty description edits).
    if (editorRef.current !== null) spliceTitleIntoBlocks(editorRef.current, trimmed);
    try {
      await rescan();
    } catch {
      toast("Couldn't refresh vault");
    }
  };

  return (
    // M11: a COLUMN of the layout, not an overlay pinned to the viewport.
    //
    // As `fixed right-0` it sat on top of the canvas, so the right-hand columns
    // of a table — and the table's own horizontal scrollbar — were underneath
    // it and could not be reached. Notion shrinks the content instead, which is
    // the only arrangement where "open a record" and "read the rest of the row"
    // are not mutually exclusive. `relative` hosts the drag handle.
    <aside
      data-testid="detail-panel"
      aria-label="Detail panel"
      className="cb-panel-in relative z-30 flex h-full min-w-0 flex-none flex-col border-l border-n-200 bg-n-0"
      // 100%, not 50%: the parent is now the right-panel SLOT, which is itself
      // sized from this width and already capped at `100% - CANVAS_MIN_WIDTH`.
      // A 50% cap here resolved against that slot, so the panel rendered at
      // half the width the slot had reserved for it and the other half was
      // blank — the canvas paid for space nothing drew in. AiPanel, added
      // against the slot, always used 100%; this was the pre-slot value left
      // behind. Shrinking still works: the slot's cap wins, and 100% follows.
      style={{ width, maxWidth: '100%' }}
    >
      {/* First, so the panel is on the stack before anything it contains. */}
      <DetailEscapeLayer onClose={closeDetail} />
      <ResizeHandle
        label="Resize detail panel"
        side="left"
        width={width}
        min={DETAIL_WIDTH_MIN}
        max={DETAIL_WIDTH_MAX}
        onResize={setWidth}
      />
      <header className="flex items-center gap-2 border-b border-n-100 px-4 py-3">
        {/* M9.6: one resolver everywhere — a Risk looks like a Risk in the
            panel, the table, QuickOpen, and the assistant's transcript. */}
        <span
          className="inline-flex"
          style={{ color: typeStyle(entry.type, schema).color ?? 'var(--n-500)' }}
        >
          <Icon name={typeStyle(entry.type, schema).icon} size={14} />
        </span>
        <span className="text-xs font-medium text-n-700">{entry.type ?? 'Note'}</span>
        {key !== '' && (
          <span className="[font-family:var(--font-mono)] text-2xs text-n-500">{key}</span>
        )}
        {/* M9.3/M12.5: opening a record no longer drags you to its container,
            so the container becomes something you press rather than something
            that happens to you. Hidden when you are already standing on it. */}
        {container !== null && containerFolder !== null && (
          <>
            <span aria-hidden className="text-2xs text-n-300">
              /
            </span>
            <button
              type="button"
              data-testid="detail-collection-crumb"
              onClick={() => navigate({ kind: 'collection', folder: containerFolder })}
              className="inline-flex min-w-0 items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
            >
              <Icon name="folder-open" size={11} />
              <span className="truncate">{container.title}</span>
            </button>
          </>
        )}
        <span className="flex-1" />
        {/* M16.11: everything Notion's peek header offers that means anything
            in a files-first app — see the docblock for the three that do
            not. */}
        <DetailHeaderActions entry={entry} />
        <IconButton icon="x" label="Close" size="sm" onClick={closeDetail} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3.5">
        <input
          data-testid="detail-title"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setTitle(entry.title);
            }
          }}
          // focus-visible + the shared --ring token: every other control in
          // the app uses that halo and suppresses it on plain mouse clicks.
          className="-ml-2 mb-3.5 w-full rounded-lg border border-transparent px-2 py-1 text-lg font-semibold leading-[22px] tracking-[-0.01em] text-n-900 outline-none hover:border-n-200 focus-visible:border-cortex-500 focus-visible:shadow-[var(--ring)]"
        />
        {/* M45.1 — the key-property strip, with the expander that opens the
            full stack. Keyed per record like the stack below, so field
            popovers close on switch. */}
        {headingFields.length > 0 && (
          <HeadingProperties
            key={`strip:${entry.path}`}
            entry={entry}
            schema={schema}
            fields={headingFields}
            detailsShown={detailsShown}
            onToggleDetails={() => setDetails({ path: entry.path, shown: !detailsShown })}
          />
        )}
        {/* M3: extracted to RecordProperties — shared with the split view.
            Keyed per record (prefixed: the sibling NoteBodyEditor also keys
            on the path) so the add-property flyout closes on switch. */}
        {(!stripShows || detailsShown) && (
          <RecordProperties key={`props:${entry.path}`} entry={entry} schema={schema} />
        )}
        {/* M34.5.3 — a cached copy says its own freshness. Null for every
            record without fetch bookkeeping. */}
        <SourceFreshnessLine entry={entry} />
        {/* M12: records lost the doc side panel when display:doc died, and
            the knowledge loop must not die with it — the same commit state
            and related-concepts view, collapsed until asked (M8.3's rule:
            the assistant never speaks first). */}
        <KnowledgeSection key={`knowledge:${entry.path}`} entry={entry} />
        {/* M44.1 — the type's display config gates the body. DocPage's body
            IS the page and is out of scope; this is the peek panel only. */}
        {display.showBody && (
          <>
            <div
              data-testid="detail-body-heading"
              className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500"
            >
              Description
            </div>
            {/* Task 12: rich markdown editor replaces the raw textarea. Keyed by
                path so switching items reloads cleanly. */}
            <NoteBodyEditor
              key={entry.path}
              path={entry.path}
              compact
              onReady={({ editor }) => {
                editorRef.current = editor;
              }}
            />
          </>
        )}
        {/* M9.4 — every version of this note, and what each one changed.
            Renders nothing when there is no history, so a note you just
            created does not get a heading over an empty list. */}
        <GitHistoryPanel path={entry.path} />
        {/* M9.7 — the diff appears under the body, not over the panel. */}
        <InlineDiff path={entry.path} />
      </div>
      {/* M44.1 — opt-in muted file-path row, a quiet sibling above the
          timestamps. Net-new: no such row existed before this task. */}
      {display.showFile && (
        <div
          data-testid="detail-file"
          className="truncate px-4 pt-1 font-mono text-2xs text-n-400"
          title={entry.path}
        >
          {entry.path}
        </div>
      )}
      <footer className="flex items-center gap-3 border-t border-n-100 px-4 py-2.5 [font-family:var(--font-mono)] text-2xs text-n-400">
        <span>Created {entry.createdAt.slice(0, 10)}</span>
        <span>Modified {entry.modifiedAt.slice(0, 10)}</span>
      </footer>
    </aside>
  );
}
