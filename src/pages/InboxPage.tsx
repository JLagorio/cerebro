import { createPortal } from 'react-dom';
import {
  PageNavigationContent,
  usePageNavigationControls,
  usePageNavigationSlot,
} from '@/app/PageNavigation';
import { DrawerScrim } from '@/components/ui/DrawerScrim';
import {
  inertCopy,
  motionAllowed,
  Presence,
  removeAfterExit,
  useGhostOnUnmount,
  usePageTurn,
  whenPlayed,
} from '@/components/ui/motion';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import './inbox.css';
import './pages.css';
import { ImportInlet } from '@/app/ImportInlet';
import type { ImportInput } from '@/engine/inlets';
import { claimOf } from '@/engine/panes';
import { editorHoldersOf, subscribeEditorHolders } from '@/editor/openPages';
import { useListCursor } from '@/hooks/useListCursor';
import { useOsDropZone } from '@/hooks/useOsDropZone';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { ListSelectionBar } from '@/components/ListSelectionBar';
import { EntryIcon } from '@/components/PageIcon';
import {
  Crumb,
  CrumbSeparator,
  PANEL_HEAD_CHROME,
  PageToolbar,
  PanelButtons,
  SaveState,
} from '@/components/PageToolbar';
import { FavoriteStar } from '@/app/FavoriteStar';
import { OpenWithMenu } from '@/app/OpenWithMenu';
import { copyPageLinks } from '@/app/recordActions';
import { keycapText } from '@/components/ui/Keycaps';
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '@/components/ui/Button';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { DocSidePanel } from '@/detail/DocSidePanel';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { InspectorAction, InspectorActions, InspectorAsk } from '@/detail/InspectorParts';
import { InspectorSection } from '@/detail/InspectorSection';
import { PageCoverBand, PageIconHeader } from '@/detail/PageChrome';
import { PropertyRow } from '@/detail/PropertyRow';
import { RecordProperties } from '@/detail/RecordProperties';
import { TranscriptSpeakers } from '@/detail/TranscriptSpeakers';
import { usePageComments } from '@/detail/usePageComments';
import { DocOutline } from '@/editor/DocOutline';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import { NoteBodyEditor, type SaveState as EditorSaveState } from '@/editor/NoteBodyEditor';
import { PageCommentsContext } from '@/editor/PageCommentsContext';
import { isCommentPage } from '@/engine/comments';
import { InlineDiff } from '@/git/InlineDiff';
import { formatDate, fromIsoDate, localDateOf } from '@/engine/dates';
import { inInbox } from '@/engine/inbox';
import { resolveLayout } from '@/engine/layout';
import { linkLabel } from '@/engine/linkLabels';
import { conceptsFrom, isAgentWritten, listConcepts } from '@/engine/okf';
import { pageIconOf } from '@/engine/pageChrome';
import { typeStyle } from '@/engine/typeCatalog';
import { fetchRefsAsk, organizeAsk, sendAsk } from '@/agent/elements/decisionsAsks';
import { ProposalCard } from '@/agent/ProposalCard';
import type { Entry, Schema } from '@/engine/types';
import { useInboxQueue } from '@/hooks/useInboxQueue';
import { captureNote } from '@/lib/capture';
import { useCommand } from '@/lib/keys/useKeys';
import {
  describeIngest,
  documentCount,
  ingestDropped,
  ingestFiles,
  ingestOne,
  INGESTIBLE_EXTENSIONS,
} from '@/lib/ingest';
import { parseIssuePrefixes, uncachedRefs } from '@/engine/ingest';
import { matchSpeakers, transcriptFacts } from '@/engine/transcripts';
import { todayIso } from '@/lib/templates';
import { useNavStore, usePaneId } from '@/stores/navStore';
import { DOC_PANEL_WIDTH, useUiStore, type PagePanel } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/** Below this the reader trims the editor's right-hand gutter, as a page's
 *  reading column does (DocPage, M52). */
const NARROW_READER = 560;

/** Below this the page has no room for the reader and the inspector side by
 *  side: the inspector folds, and opens as a drawer over the reader. */
const INSPECTOR_FOLD = 760;

/** The queue's own column beside the reader, when no sidebar slot holds it
 *  (an inactive pane). The fold does not count it: it comes and goes with
 *  activation, and the panel must not follow it. */
const QUEUE_FALLBACK_WIDTH = 230;

/**
 * When a capture landed, as the list says it: "Today", "Yesterday", else the
 * short date, "Jul 24" — the year only when it is not this one. Empty when
 * the capture carries no readable date.
 */
function capturedOn(createdAt: string, today: string): string {
  const day = localDateOf(createdAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const near = formatDate(day, 'relative', today);
  if (near === 'Today' || near === 'Yesterday') return near;
  return fromIsoDate(day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  });
}

/** The rows a queue list draws now, by the path each carries. */
function queueRows(list: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>();
  for (const child of list.children) {
    if (child instanceof HTMLElement && child.dataset.path !== undefined) {
      rows.set(child.dataset.path, child);
    }
  }
  return rows;
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

/** Rows arriving together each wait a step behind the one above, up to
 *  this many steps. */
const ARRIVAL_STEPS = 6;

interface QueueMotionProps {
  /** The rows' paths, in the order the list draws them. */
  keys: readonly string[];
  /** The list the rows are drawn in. */
  list: RefObject<HTMLElement | null>;
  /** The vault the rows are from: another vault's queue replaces this one
   *  whole, and nothing in it arrives or leaves. */
  vault: string | null;
  children: ReactNode;
}

/** What a commit that changes the rows takes beforehand: the list, and a
 *  copy of each row it removes with the path of the row still standing after
 *  it, which the copy goes in before (null: the end of the list). */
interface QueueChange {
  list: HTMLElement;
  leaving: { copy: HTMLElement; settle: () => void; before: string | null }[];
}

/**
 * The queue in motion (owner, 2026-10-19: "add more animations … feel like
 * Notion and ChatGPT"). A capture that leaves — filed from its keys, the
 * toolbar, the panel or the options menu — leaves a copy where its row was,
 * which slides off a little, fades and closes its room, so the rows below
 * come up into it instead of jumping; one that arrives — a new capture, a
 * drop, an import, an undo — opens its room and drops into it. Nothing
 * moves when another vault's queue replaces this one, which nobody edited,
 * or where motion does not play (components/ui/motion.ts): there the rows
 * simply change, in the commit that changed them.
 *
 * A class, for `getSnapshotBeforeUpdate`: a leaving row has to be copied
 * while the commit that removes it still has it on screen, and hooks have
 * no way to read the document before a commit. It draws nothing itself.
 */
class QueueMotion extends Component<QueueMotionProps, object, QueueChange | null> {
  getSnapshotBeforeUpdate(prev: Readonly<QueueMotionProps>): QueueChange | null {
    const { keys, list, vault } = this.props;
    if (list.current === null || vault !== prev.vault || sameKeys(prev.keys, keys)) return null;
    if (!motionAllowed()) return null;
    const staying = new Set(keys);
    const rows = queueRows(list.current);
    const leaving: QueueChange['leaving'] = [];
    // From the end, so each copy knows the first row still standing below
    // it; put back in queue order, so copies side by side keep theirs.
    let before: string | null = null;
    for (let i = prev.keys.length - 1; i >= 0; i--) {
      const key = prev.keys[i];
      const row = rows.get(key);
      if (staying.has(key)) before = key;
      else if (row !== undefined) {
        // Inert and nameless, every `data-` attribute gone too (the test
        // id, the cursor's key, the row's own path), as tall as the row was.
        const { copy, settle } = inertCopy(row, { dropData: true });
        copy.style.setProperty('--row-h', `${row.getBoundingClientRect().height}px`);
        leaving.unshift({ copy, settle, before });
      }
    }
    return { list: list.current, leaving };
  }

  componentDidUpdate(
    prev: Readonly<QueueMotionProps>,
    _state: object,
    change?: QueueChange | null,
  ): void {
    if (change == null) return;
    const rows = queueRows(change.list);
    for (const { copy, settle, before } of change.leaving) {
      change.list.insertBefore(copy, before === null ? null : (rows.get(before) ?? null));
      try {
        settle();
        copy.classList.add('m75-row-leave');
      } finally {
        removeAfterExit(copy);
      }
    }
    const known = new Set(prev.keys);
    // The room each opens is the height it rests at: every one measured
    // before any is written, so the list is laid out once, not once a row.
    const arriving = this.props.keys
      .filter((key) => !known.has(key))
      .flatMap((key) => {
        const row = rows.get(key);
        return row === undefined ? [] : [{ row, height: row.getBoundingClientRect().height }];
      });
    arriving.forEach(({ row, height }, step) => {
      row.style.setProperty('--row-h', `${height}px`);
      row.style.setProperty('--arrival-step', String(Math.min(step, ARRIVAL_STEPS)));
      row.setAttribute('data-motion', 'arrive');
    });
    for (const { row } of arriving) {
      whenPlayed(row, () => {
        row.removeAttribute('data-motion');
        row.style.removeProperty('--row-h');
        row.style.removeProperty('--arrival-step');
      });
    }
  }

  render(): ReactNode {
    return this.props.children;
  }
}

/**
 * A notice over the top of the page — a filing's way back, the documents
 * being read — on a line of its own under the toolbar, which opens as it
 * arrives and closes as it leaves (a copy closing where it was), so the
 * page eases down and back up instead of jumping, and nothing on it is
 * covered.
 */
function InboxNotice({
  role,
  testId,
  children,
}: {
  role?: 'status';
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGhostOnUnmount(ref, 'm75-inbox-notice-leave');
  return (
    <div ref={ref} role={role} data-testid={testId} className="m75-inbox-notice">
      {children}
    </div>
  );
}

/**
 * The capture's Organize section: the first section of the inspector's
 * Details, and the capture's property editor — its type, the type's own
 * fields, the filing the agent suggested, and the act that files it.
 */
function OrganizeSection({
  entry,
  schema,
  onFile,
}: {
  entry: Entry;
  schema: Schema;
  /** Files the capture through the page, which owns the undo affordance. */
  onFile: (path: string) => void;
}) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const proposal = useUiStore((s) => s.proposals[entry.path]);
  const askAgent = useUiStore((s) => s.askAgent);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const allEntries = useVaultStore((s) => s.entries);

  // The visible half of the connector inlet (M8.2): what this capture refers
  // to that nobody has a local copy of. Nothing is fetched automatically —
  // reaching another system is a round trip and a decision, so it is offered.
  const unresolved = useMemo(() => {
    if (!connectors) return [];
    const text = `${entry.title}\n${entry.snippet}`;
    return uncachedRefs(text, allEntries, {
      issuePrefixes: parseIssuePrefixes(issuePrefixes),
    });
  }, [allEntries, connectors, entry.snippet, entry.title, issuePrefixes]);

  // Each type by its own glyph in its own colour. A type no Type doc
  // declares is still listed while the capture holds it, so the row names it
  // rather than "No type". Untyped, "No type" is the muted placeholder;
  // typed, it is the first option, the way back.
  const declared = [...schema.types.keys()].filter((t) => t !== 'Type');
  const held = entry.type !== null && !declared.includes(entry.type) ? [entry.type] : [];
  const typeOptions: SelectOption[] = [
    ...(entry.type === null ? [] : [{ value: '', label: 'No type', icon: 'file-text' }]),
    ...[...declared, ...held].sort().map((t) => {
      const { icon, color } = typeStyle(t, schema);
      return { value: t, label: t, icon, color: color ?? undefined };
    }),
  ];

  // M45.1 (spec §3.4) — this section is a RecordProperties HOST, so a laid-out
  // type's heading fields must render in a strip here too: the strip-owning
  // hosts exclude them from the stack, and a host that mounts only the stack
  // renders them NOWHERE (the whole-slice review's finding). Same gate as
  // DocPage/DetailPanel: `stripShows` derived per render with the strip's own
  // fold predicate, stack whenever `!stripShows || detailsShown`, untouched
  // default `!stripShows`, and the lens forgets a capture it left.
  const typeDef = entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  const headingFields =
    typeDef === null ? [] : resolveLayout(typeDef.layout, typeDef.fields).heading;
  const stripShows =
    headingFields.length > 0 && stripCells(entry, schema, headingFields).length > 0;
  const [details, setDetails] = useState<{ path: string; shown: boolean } | null>(null);
  if (details !== null && details.path !== entry.path) setDetails(null);
  const detailsShown = details?.path === entry.path ? details.shown : !stripShows;

  // The asks, each showing its label and sending its prompt (M91.14). The
  // filing ask waits behind a suggestion already made: its card answers it.
  // A transcript gets the meeting ask, with its speakers as matched now
  // (M64.7); any other capture, the plain one.
  const organize = useMemo(() => {
    if (proposal !== undefined) return null;
    const facts = transcriptFacts(entry);
    return organizeAsk(
      entry,
      facts === null
        ? undefined
        : {
            title: entry.title,
            speakers:
              facts.speakers === null ? null : matchSpeakers(facts.speakers, schema, allEntries),
          },
    );
  }, [proposal, entry, schema, allEntries]);
  const fetchRefs = useMemo(
    () =>
      unresolved.length === 0
        ? null
        : fetchRefsAsk(
            entry,
            unresolved.map((r) => r.id),
            // A link's own name as the cache title (M69.2): the title only,
            // since "Linear" alone titles nothing.
            unresolved.map((r) => (r.kind === 'url' ? (linkLabel(r.id)?.title ?? null) : null)),
          ),
    [entry, unresolved],
  );

  return (
    <InspectorSection id="organize" label="Organize">
      <div className="flex flex-col">
        {/* Type leads, and the type's own fields follow it, because assigning
            a type is the whole job here — everything below is either advice
            about that decision or something to do once it is made. It is the
            property row the type's fields below are drawn in, its value a
            select that reads as text until the pointer finds it, and opens
            on a search over the vault's types. */}
        <PropertyRow kind="text" icon="shapes" name="Type" align="center">
          <Select
            variant="ghost"
            ariaLabel="Type"
            searchable
            searchPlaceholder="Search types…"
            options={typeOptions}
            value={entry.type ?? ''}
            placeholder="No type"
            onChange={(type) =>
              void patchFrontmatter(entry.path, { type: type === '' ? null : type })
            }
            className="m75-type-select"
          />
        </PropertyRow>

        {/* M64.7 — a transcript's speakers, matched to people. Read-only until
            its Add act or the filing card's Apply. */}
        <TranscriptSpeakers path={entry.path} />

        {/* Once typed, the type's declared fields are the rest of the form —
            the same strip-and-stack the record surfaces mount, not a second
            form. A laid-out type leads with its heading strip (the triage
            fields), and the full stack rides the same View details expander
            the record page uses (M45.1). */}
        {entry.type !== null && (
          <div className="mt-1">
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
            {(!stripShows || detailsShown) && (
              <RecordProperties key={entry.path} entry={entry} schema={schema} />
            )}
          </div>
        )}

        {proposal !== undefined && (
          <div className="mt-3">
            <ProposalCard proposal={proposal} />
          </div>
        )}

        {/* The acts, as rows: the Assistant's asks, then the one this
            section exists for, carrying its own keys. */}
        <div className="m75-organize-acts">
          <InspectorActions label="File this capture">
            {organize !== null && (
              <InspectorAsk
                icon="sparkles"
                label={organize.label}
                prompt={organize.prompt}
                onAsk={sendAsk(organize, askAgent)}
              />
            )}
            {fetchRefs !== null && (
              <InspectorAsk
                icon="download"
                label={fetchRefs.label}
                prompt={fetchRefs.prompt}
                onAsk={sendAsk(fetchRefs, askAgent)}
              />
            )}
            <InspectorAction
              icon="circle-check"
              label="Mark organized"
              tone="primary"
              command="inbox.file"
              title="Removes it from the Inbox"
              onClick={() => onFile(entry.path)}
            />
          </InspectorActions>
        </div>
      </div>
    </InspectorSection>
  );
}

export function InboxPage() {
  const navigationTarget = usePageNavigationSlot('inbox');
  const navigationControls = usePageNavigationControls('inbox');
  const [frameRef, frameWidth] = useMeasuredWidth({ beforePaint: true });
  const [actionsRef, actionsWidth] = useMeasuredWidth({ beforePaint: true, box: 'border' });
  // The whole page the reader and the inspector share, read the same way in
  // an active pane and an inactive one: activating another pane must never
  // fold, unmount or re-open a panel someone is typing in. The inspector
  // opens under the toolbar's actions and is never narrower than they are,
  // so when they need more than its width, it folds that much sooner: the
  // reader keeps what the fold always left it.
  const inspectorWidth = Math.max(
    DOC_PANEL_WIDTH,
    actionsWidth === null ? 0 : actionsWidth + PANEL_HEAD_CHROME,
  );
  const inspectorFolded =
    frameWidth !== null && frameWidth < INSPECTOR_FOLD - DOC_PANEL_WIDTH + inspectorWidth;
  // The person's word on the panel; null until given, which opens it wherever
  // it fits. Folded, it opens only as a drawer asked for on that capture, and
  // never by itself when the fold comes (DocPage's rule, M52).
  const [inspectorPreference, setInspectorPreference] = useState<boolean | null>(null);
  const [drawerFor, setDrawerFor] = useState<string | null>(null);
  if (!inspectorFolded && drawerFor !== null) setDrawerFor(null);
  const panel = useUiStore((s) => s.inboxPanel);
  const setPanel = useUiStore((s) => s.setInboxPanel);
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const setInboxEnabled = useUiStore((s) => s.setInboxEnabled);
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavStore((s) => s.navigate);
  const queue = useInboxQueue();
  const queueKeys = useMemo(() => queue.entries.map((entry) => entry.path), [queue.entries]);
  // Whose entries the queue holds, for its motion: another vault's replace
  // them whole, and nothing in that arrives or leaves.
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const listRef = useRef<HTMLElement | null>(null);
  // Which captures the bundle has already learned from. Computed once for the
  // whole queue rather than per row: the answer is a scan of every concept's
  // sources, and doing that inside the map is the same work N times over.
  const today = todayIso();
  const concepts = useMemo(() => listConcepts(entries, today), [entries, today]);
  const fileInput = useRef<HTMLInputElement>(null);
  // Browser HTML5 drags count child enter/leave events; native drops use the
  // path router's hover state instead.
  const [dragDepth, setDragDepth] = useState(0);

  // Hoisted to a const so the narrowing survives into the row callbacks.
  const selected = queue.selected;
  const selectedPath = selected?.path ?? null;
  const pane = usePaneId();
  const nav = useNavStore();
  const holders = useSyncExternalStore(subscribeEditorHolders, () =>
    editorHoldersOf(selectedPath ?? ''),
  );
  const heldPane =
    selectedPath === null
      ? undefined
      : nav.paneIds
          .map((id) => ({ id, selection: useNavStore.getPaneState(id).selection }))
          .find(
            (candidate) => candidate.id !== pane && claimOf(candidate.selection) === selectedPath,
          );
  const otherEditor = holders.find((owner) => owner !== pane);
  const heldElsewhere = heldPane !== undefined || otherEditor !== undefined;
  const showHolder = () => {
    if (heldPane) useNavStore.getState().focusPane(heldPane.id);
    else if (otherEditor === 'peek')
      document.querySelector<HTMLElement>('[data-testid="detail-panel"]')?.focus();
    else if (otherEditor?.startsWith('p'))
      useNavStore.getState().focusPane(otherEditor as `p${number}`);
  };
  const index = queue.entries.findIndex((e) => e.path === selectedPath);
  const inspectorDrawer = inspectorFolded && drawerFor !== null && drawerFor === selectedPath;
  const inspectorOpen = inspectorDrawer || (!inspectorFolded && inspectorPreference !== false);
  const showInspector = () => {
    setInspectorPreference(true);
    if (inspectorFolded) setDrawerFor(selectedPath);
  };
  const closeInspector = () => {
    setInspectorPreference(false);
    setDrawerFor(null);
  };

  // An agent's filing proposal is a card the person was told to answer here:
  // bring it into view, whatever panel or fold the inspector was left on.
  const proposal = useUiStore((s) =>
    selectedPath === null ? undefined : s.proposals[selectedPath],
  );
  useEffect(() => {
    if (proposal === undefined) return;
    useUiStore.getState().setInboxPanel('details');
    useUiStore.getState().setInspectorSectionOpen('organize', true);
  }, [proposal]);

  // M58.4 — a version opened from the inspector's History reads in place of
  // the editor, as on a page. Moving to another capture, or leaving the
  // Inbox, closes the lens on the one it was opened for.
  const diffOpen = useUiStore((s) => selectedPath !== null && s.diffView?.path === selectedPath);
  const shownPath = useRef(selectedPath);
  useEffect(() => {
    const left = shownPath.current;
    shownPath.current = selectedPath;
    if (left !== null && left !== selectedPath && useUiStore.getState().diffView?.path === left) {
      useUiStore.getState().closeDiff();
    }
  }, [selectedPath]);
  useEffect(
    () => () => {
      const shown = shownPath.current;
      if (shown !== null && useUiStore.getState().diffView?.path === shown) {
        useUiStore.getState().closeDiff();
      }
    },
    [],
  );

  // The open capture's editor, held with the capture it came from: the
  // outline and the comments need it, and a capture left behind, read as a
  // version, or held by another pane has none here.
  const [mounted, setMounted] = useState<{ path: string; editor: CerebroEditor } | null>(null);
  const editorLive =
    mounted !== null && mounted.path === selectedPath && !heldElsewhere && !diffOpen;
  if (mounted !== null && !editorLive) setMounted(null);
  const editor = editorLive ? mounted.editor : null;
  const [saveState, setSaveState] = useState<EditorSaveState>('idle');

  // Filing is the one action here that removes something from the queue, and
  // the queue is the only place it was visible — so it gets an undo, not a
  // toast that disappears. `toast()` takes a message and nothing else, so the
  // affordance lives on the page where it can hold a button.
  const [lastFiled, setLastFiled] = useState<{ path: string; title: string } | null>(null);
  // Focus follows the file: after ⌘E the row that opened next should be where
  // the keyboard is, or the next Tab restarts at the nav.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const readerRef = useRef<HTMLDivElement>(null);
  const [measureReader, readerWidth] = useMeasuredWidth();
  const setReader = useCallback(
    (element: HTMLDivElement | null) => {
      readerRef.current = element;
      const unmeasure = measureReader(element);
      return () => {
        unmeasure?.();
        readerRef.current = null;
      };
    },
    [measureReader],
  );
  // Each capture the reader opens fades in as it arrives, as a page does in
  // its column (`usePageTurn`, pageFrame.css): it plays again without
  // remounting the reader, its scroll or its focus. Opacity alone, so the
  // editor's fixed menus stay put.
  const turn = usePageTurn(selectedPath ?? '');
  const openedAt = useRef(-Infinity);
  useLayoutEffect(() => {
    const now = performance.now();
    const since = now - openedAt.current;
    openedAt.current = now;
    const reader = readerRef.current;
    if (reader === null) return;
    // Another capture opens at its top, wherever the last one was read to.
    reader.scrollTop = 0;
    if (!motionAllowed()) return;
    // Walking the queue faster than a capture can arrive — a held j — each
    // one lands at once, rather than every one fading up from nothing.
    for (const animation of reader.getAnimations()) {
      const duration = animation.effect?.getComputedTiming().duration;
      if (typeof duration === 'number' && since < duration) animation.finish();
    }
  }, [selectedPath]);
  const refocusRow = useRef(false);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const fileNote = (path: string) => {
    const title = queue.entries.find((e) => e.path === path)?.title ?? 'capture';
    refocusRow.current = true;
    void (async () => {
      // Only a filing that landed offers its way back: a refused write has
      // said so in its own toast (CV-03), and left the capture in the queue.
      if (await queue.organize(path)) setLastFiled({ path, title });
    })();
  };

  useEffect(() => {
    if (!refocusRow.current) return;
    refocusRow.current = false;
    if (selectedPath === null) return;
    const row = rowRefs.current.get(selectedPath);
    const sidebar = row?.closest<HTMLElement>('[data-testid="sidebar"]');
    if (row?.closest('[hidden]') || (sidebar && getComputedStyle(sidebar).display === 'none')) {
      readerRef.current?.focus();
    } else row?.focus();
  }, [selectedPath]);

  // Cmd/Ctrl+E organizes the open capture — the whole loop is meant to run
  // from the keyboard, so this is the one binding that matters here. The
  // keymap holds the latest handler, so the binding outlives every render.
  useCommand(
    'inbox.file',
    () => {
      if (selectedPath !== null) fileNote(selectedPath);
    },
    { when: () => selectedPath !== null },
  );

  // The capture remains open while the shared cursor tracks row selection.
  const cursor = useListCursor({
    keys: queueKeys,
    focus: selectedPath,
    onFocusChange: (path) => {
      if (path !== null) queue.select(path);
    },
    onOpen: (path) => navigate({ kind: 'doc', path }),
    selectable: true,
  });
  const moveSelection = (to: number) => {
    if (queue.entries.length === 0) return;
    cursor.focus(queue.entries[Math.max(0, Math.min(to, queue.entries.length - 1))].path, true);
  };

  // The inspector opens on `which`, as a drawer when the page has no room
  // for it — a comment's highlight asks for its thread this way (M70.2b).
  const showPanel = (which: PagePanel) => {
    setPanel(which);
    if (!inspectorOpen) showInspector();
  };
  // Each panel's button opens it, or closes it when it is the one open.
  const togglePanel = (which: PagePanel) => {
    if (inspectorOpen && panel === which) closeInspector();
    else showPanel(which);
  };
  const comments = usePageComments(
    selectedPath !== null && isCommentPage(selectedPath) ? selectedPath : null,
    editor,
    { openPanel: () => showPanel('comments'), deepLink: null },
  );
  const openComments = comments.slot?.kind === 'ready' ? (comments.sections?.openCount ?? 0) : 0;

  const capture = () => {
    void (async () => {
      try {
        const path = await captureNote();
        queue.select(path);
      } catch (err) {
        toast(`Couldn't capture: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  // Text and kept documents file captures; calendars queue a preview.
  const captureDrop = useVaultActionGuard('inbox');
  const readingJobs = useRef(new Map<symbol, number>());
  const [readingDocuments, setReadingDocuments] = useState(0);
  const beginReading = (sources: readonly { name: string }[]) => {
    const count = documentCount(sources);
    const id = Symbol('document capture');
    if (count > 0) {
      readingJobs.current.set(id, count);
      setReadingDocuments([...readingJobs.current.values()].reduce((a, b) => a + b, 0));
    }
    return () => {
      readingJobs.current.delete(id);
      setReadingDocuments([...readingJobs.current.values()].reduce((a, b) => a + b, 0));
    };
  };
  const nextImport = useRef(0);
  const [imports, setImports] = useState<{ id: number; input: ImportInput }[]>([]);
  useEffect(
    () =>
      useVaultStore.subscribe((next, previous) => {
        if (next.vaultPath !== previous.vaultPath) {
          setImports([]);
          readingJobs.current.clear();
          setReadingDocuments(0);
          // A filing's way back is the vault's it was filed in: Undo here
          // would write to the same path in another one.
          setLastFiled(null);
        }
      }),
    [],
  );
  const pendingImports = useRef(imports);
  pendingImports.current = imports;
  const claimImport = (current: () => boolean) => (input: ImportInput) => {
    if (!current()) return false;
    const id = ++nextImport.current;
    setImports((queue) => [...queue, { id, input }]);
    return true;
  };
  const takeFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    const current = captureDrop();
    const done = beginReading(files);
    void (async () => {
      try {
        const result = await ingestFiles(files, current, claimImport(current));
        if (!current()) return;
        if (result.paths.length > 0) queue.select(result.paths[0]);
        toast(describeIngest(result));
      } catch (err) {
        if (current())
          toast(`Couldn't ingest: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        done();
      }
    })();
  };
  const osDrop = useOsDropZone('inbox', async (paths) => {
    if (!inboxEnabled) return;
    const current = captureDrop();
    const done = beginReading(paths.map((name) => ({ name })));
    try {
      const result = await ingestDropped(paths, current, claimImport(current));
      if (!current()) return;
      if (result.paths.length > 0) queue.select(result.paths[0]);
      toast(describeIngest(result));
    } finally {
      done();
    }
  });
  // The frame is measured for the inspector's fold and is the drop zone.
  const dropZoneRef = osDrop.zoneProps.ref;
  const setFrame = useCallback(
    (element: HTMLDivElement | null) => {
      dropZoneRef(element);
      const unmeasure = frameRef(element);
      return () => {
        unmeasure?.();
        dropZoneRef(null);
      };
    },
    [dropZoneRef, frameRef],
  );

  // A paste big enough to be material rather than a typo becomes a capture.
  // Small pastes are almost certainly meant for a field, so they are left
  // alone — an app that swallows ⌘V is worse than one that ignores it.
  const PASTE_MIN = 200;
  const onPaste = (event: React.ClipboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]') != null) return;
    const text = event.clipboardData.getData('text/plain');
    if (text.trim().length < PASTE_MIN) return;
    event.preventDefault();
    void (async () => {
      try {
        const outcome = await ingestOne('', text);
        if (outcome.kind === 'duplicate') {
          toast(`Already filed as ${outcome.title}`);
          return;
        }
        queue.select(outcome.path);
        toast('Filed the pasted text to the Inbox');
      } catch (err) {
        toast(`Couldn't ingest: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  // The queue, lent to the context sidebar under its own "Inbox" heading: a
  // calm list of captures, one row each, and nothing above the rows.
  const captureNavigation = (
    <PageNavigationContent>
      <div className="m75-capture-navigation">
        <div
          role="listbox"
          aria-label="Captures"
          {...cursor.containerProps}
          ref={(element) => {
            cursor.containerProps.ref(element);
            listRef.current = element;
          }}
          className="m75-capture-list"
        >
          <ListSelectionBar
            count={cursor.state.selected.size}
            onCopy={() =>
              void copyPageLinks(
                queue.entries.filter((entry) => cursor.state.selected.has(entry.path)),
              )
            }
          />
          <QueueMotion keys={queueKeys} list={listRef} vault={entriesVault}>
            {queue.entries.map((e) => {
              const active = e.path === selectedPath;
              const rowProps = cursor.itemProps(e.path);
              // Held in place by the queue while you work on it, but it
              // already satisfies the membership rule — so the badge says 3
              // while 4 rows show. Mark it, or that reads as a bug.
              const ready = !inInbox(e);
              const learned = conceptsFrom(e.path, concepts).length;
              const day = capturedOn(e.createdAt, today);
              return (
                <button
                  key={e.path}
                  type="button"
                  // option inside the listbox above, not `row`: role="row"
                  // overrode the button role in a document with no table
                  // anywhere, so the queue announced as rows of nothing.
                  role="option"
                  {...rowProps}
                  ref={(el) => {
                    rowProps.ref(el);
                    if (el === null) rowRefs.current.delete(e.path);
                    else rowRefs.current.set(e.path, el);
                  }}
                  data-testid="inbox-row"
                  data-page-navigation-item
                  data-path={e.path}
                  onPointerDownCapture={(event) => {
                    // Activating an inactive pane moves this queue into the
                    // shell before pointerup. Keep the intended row selection
                    // in that same pointer task, before its old DOM retires.
                    if (event.button === 0) queue.select(e.path);
                  }}
                  onClick={() => queue.select(e.path)}
                  className={['m75-capture-row', active ? 'is-current' : ''].join(' ')}
                >
                  <span className="m75-capture-row-title">
                    {e.parseError !== null && (
                      <span className="inline-flex flex-none text-warn-500">
                        <Icon name="triangle-alert" size={12} />
                      </span>
                    )}
                    {ready && (
                      <span
                        // ⌘E files whatever is OPEN, never the row under the
                        // cursor — the old wording read as an instruction
                        // about this row and filed a different note.
                        title={
                          active
                            ? `Organized — press ${keycapText('inbox.file')} to file it`
                            : 'Organized — open it to file it'
                        }
                        className="m75-capture-ready inline-flex flex-none text-success-600"
                      >
                        <Icon name="circle-check" size={12} />
                      </span>
                    )}
                    <span
                      // Titles are how you pick the next capture, and at this
                      // width most of them clip mid-word.
                      title={e.title}
                      className={[
                        'truncate',
                        ready ? 'text-(--text-meta)' : active ? 'text-n-900' : 'text-n-800',
                      ].join(' ')}
                    >
                      {e.title}
                    </span>
                  </span>
                  {e.snippet !== '' && <span className="m75-capture-row-snippet">{e.snippet}</span>}
                  <span className="m75-capture-row-meta">
                    {day !== '' && <span>{day}</span>}
                    {e.type !== null && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <Icon
                          name={typeStyle(e.type, schema).icon}
                          size={11}
                          color={typeStyle(e.type, schema).color ?? 'var(--n-400)'}
                        />
                        <span className="truncate">{e.type}</span>
                      </span>
                    )}
                    {/* M7: what the agent wrote is labelled, so the review
                        queue never hides machine output among your own. */}
                    {isAgentWritten(e) && (
                      <span
                        data-testid="from-ai"
                        className="inline-flex items-center gap-1 text-(--text-ai)"
                      >
                        <Icon name="sparkles" size={10} />
                        AI
                      </span>
                    )}
                    {/* M8.5 — the base took something from this one. Shown on
                        the row because "did I already learn from that?" is a
                        question you ask while scanning, not after opening. */}
                    {learned > 0 && (
                      <span
                        data-testid="row-committed"
                        title={`${learned} concept${learned === 1 ? '' : 's'} distilled from this`}
                        className="inline-flex items-center gap-1 text-cortex-600"
                      >
                        <Icon name="brain" size={10} />
                        {learned}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </QueueMotion>
        </div>
        {queue.entries.length === 0 && <p className="m75-queue-empty">Nothing to organize.</p>}
      </div>
    </PageNavigationContent>
  );

  // Reachable through nav history after the workflow is switched off —
  // explain and offer the way back rather than bouncing to another screen.
  if (!inboxEnabled) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="inbox-page">
        <EmptyState
          icon="inbox"
          title="Inbox workflow is off"
          description="Every note reads as organized. Turn the workflow back on to queue untyped captures for review."
          action={
            <Button variant="secondary" onClick={() => setInboxEnabled(true)}>
              Turn on Inbox
            </Button>
          }
        />
      </div>
    );
  }

  const glyph =
    selected === null || pageIconOf(selected) === null ? undefined : (
      <EntryIcon entry={selected} fallback={{ name: 'file-text' }} size={13} />
    );

  // The page's frame (components/pageFrame.css): the toolbar, the reader
  // under it, and the inspector the frame's full height on the right.
  const frameMode =
    selected === null || !inspectorOpen ? undefined : inspectorDrawer ? 'drawer' : 'docked';

  return (
    <div
      ref={setFrame}
      className="m75-inbox cb-page-frame flex-1"
      data-testid="inbox-page"
      data-os-drop={osDrop.zoneProps['data-os-drop']}
      data-panel={frameMode}
      style={{ '--frame-panel-w': `${DOC_PANEL_WIDTH}px` } as CSSProperties}
      onPaste={onPaste}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragDepth(0);
        takeFiles([...e.dataTransfer.files]);
      }}
    >
      {navigationTarget !== null && createPortal(captureNavigation, navigationTarget)}
      {/* The bar every page is worked from (PageToolbar): where you are on the
          left — the Inbox, which shows the captures when the sidebar holds
          them out of sight, then the open capture — and what to do with it
          on the right. */}
      <PageToolbar
        testId="inbox-pane-header"
        crumbs={
          <>
            {/* Never the crumb that gives: the capture's title truncates. */}
            <span className="flex flex-none">
              <Crumb
                label="Inbox"
                icon="inbox"
                title="Show captures"
                onClick={
                  navigationControls === null
                    ? undefined
                    : (event) => navigationControls.show(event.currentTarget)
                }
              />
            </span>
            {selected !== null && (
              <span className="flex min-w-0 items-center gap-0.5">
                <CrumbSeparator />
                {/* The scanner's title, as the page's own title and the
                    queue's row show it — an untitled capture reads as its
                    filename in all three. */}
                <Crumb
                  label={selected.title}
                  title={selected.title}
                  glyph={glyph}
                  icon="file-text"
                  strong
                />
              </span>
            )}
          </>
        }
        status={
          selected !== null && (
            <>
              {/* Where the open capture sits in the queue, and the way along
                  it — "Mark organized" takes it out of the list you would
                  check against. Beside the crumbs, where you are, so the
                  actions keep one width. */}
              <span data-testid="inbox-pager" className="flex flex-none items-center gap-0.5">
                <span className="whitespace-nowrap px-1.5 text-xs tabular-nums text-(--text-meta)">
                  {index + 1} of {queue.entries.length}
                </span>
                <IconButton
                  icon="chevron-up"
                  label="Previous capture"
                  size="sm"
                  disabled={index <= 0}
                  onClick={() => moveSelection(index - 1)}
                />
                <IconButton
                  icon="chevron-down"
                  label="Next capture"
                  size="sm"
                  disabled={index < 0 || index >= queue.entries.length - 1}
                  onClick={() => moveSelection(index + 1)}
                />
              </span>
              {!heldElsewhere && <SaveState state={saveState} />}
            </>
          )
        }
        actions={
          <>
            <IconButton
              icon="file-up"
              label="Add files"
              size="sm"
              onClick={() => fileInput.current?.click()}
            />
            <IconButton icon="plus" label="New capture" size="sm" onClick={capture} />
            {selected !== null && (
              <>
                {/* Filing, where the capture's own marks begin (Tolaria's
                    breadcrumb pattern): the act the page exists for, one
                    press from anywhere on it, its keys in the tooltip. */}
                <Tooltip label="Mark organized" command="inbox.file">
                  <button
                    type="button"
                    aria-label="Mark organized"
                    onClick={() => fileNote(selected.path)}
                    // IconButton's own look, which takes no keys to show.
                    className="cb-ibtn"
                    style={{ width: 24, height: 24 }}
                  >
                    <Icon name="circle-check" size={14} />
                  </button>
                </Tooltip>
                <FavoriteStar path={selected.path} />
                <OpenWithMenu entry={selected} knowledgeFile={false} />
                <IconButton
                  ref={optionsRef}
                  icon="ellipsis"
                  label="Capture options"
                  size="sm"
                  onClick={() => {
                    const rect = optionsRef.current?.getBoundingClientRect();
                    setMenu(
                      rect === undefined
                        ? { x: 0, y: 0 }
                        : { x: rect.right - 180, y: rect.bottom + 4 },
                    );
                  }}
                />
                {/* No tooltips while a drawer they opened is up (M52): the
                    pointer that opened it is still resting here, and a
                    tooltip would come up over the drawer and take the first
                    Escape. */}
                <PanelButtons
                  shown={inspectorOpen ? panel : null}
                  onToggle={togglePanel}
                  comments={comments.path === null ? null : openComments}
                  tooltip={!inspectorDrawer}
                />
              </>
            )}
          </>
        }
        onClosePanel={frameMode === undefined ? undefined : closeInspector}
        closeTooltip={!inspectorDrawer}
        actionsRef={actionsRef}
      />
      {/* The page inspector, the one every page has, next to its buttons in
          the focus order: the Organize section stands in for Properties and
          leads Details. Which panel it shows is the Inbox's own, so a capture
          never moves the panel a page left open. Closed, it stays to play
          its exit, as it was drawn. */}
      <Presence<HTMLElement>
        open={selected !== null && inspectorOpen}
        render={({ closing, ref }) =>
          selected === null ? null : (
            <DocSidePanel
              ref={ref}
              closing={closing}
              entry={selected}
              schema={schema}
              panel={panel}
              comments={comments}
              overlay={inspectorDrawer}
              ariaLabel="Capture panel"
              organize={<OrganizeSection entry={selected} schema={schema} onFile={fileNote} />}
            />
          )
        }
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        accept={INGESTIBLE_EXTENSIONS.map((e) => `.${e}`).join(',')}
        onChange={(e) => {
          takeFiles([...(e.target.files ?? [])]);
          // Cleared so choosing the same file twice fires change twice.
          e.target.value = '';
        }}
      />

      {/* Over the whole page while files are dragged across it: it settles
          in as the drag arrives, and fades as it leaves or drops. */}
      <Presence<HTMLDivElement>
        open={dragDepth > 0 || osDrop.over}
        render={({ closing, ref }) => (
          <div
            ref={ref}
            data-testid="inbox-dropzone"
            data-state={closing ? 'closed' : 'open'}
            className="m75-dropzone pointer-events-none absolute inset-0 z-40 m-3 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-cortex-400 bg-cortex-50"
          >
            <Icon name="file-down" size={22} color="var(--cortex-600)" />
            <span className="text-sm font-medium text-cortex-700">Drop to file in the Inbox</span>
            <span className="text-xs text-(--text-meta)">
              Notes, transcripts, documents and calendars —{' '}
              {INGESTIBLE_EXTENSIONS.map((e) => `.${e}`).join(' ')}
            </span>
          </div>
        )}
      />

      <div className="cb-page-frame-body flex-col">
        {/* What the page has to say for a moment opens a line over it,
            under the toolbar (inbox.css), and closes it again. */}
        <div className="m75-inbox-notices">
          {readingDocuments > 0 && (
            <InboxNotice key="reading" role="status">
              <span className="cb-working-text">
                Reading {readingDocuments} {readingDocuments === 1 ? 'document' : 'documents'}…
              </span>
            </InboxNotice>
          )}
          {/* Filing removes the note from the only list that showed it, so
              the way back stays on screen until it is used or dismissed
              rather than riding a toast that times out. Each filing's own:
              the next one takes its place as it fades. */}
          {lastFiled !== null && (
            <InboxNotice key={`filed:${lastFiled.path}`} testId="inbox-undo">
              <span className="m75-filed-mark inline-flex flex-none text-success-600">
                <Icon name="circle-check" size={13} />
              </span>
              <span className="min-w-0 truncate text-metadata text-n-600">
                Filed “{lastFiled.title}”
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon="undo-2"
                onClick={() => {
                  // The capture comes back as the open one, and its row takes
                  // focus, as the next row's did when it was filed.
                  refocusRow.current = true;
                  void queue.unorganize(lastFiled.path);
                  setLastFiled(null);
                }}
              >
                Undo
              </Button>
              <IconButton icon="x" label="Dismiss" size="sm" onClick={() => setLastFiled(null)} />
            </InboxNotice>
          )}
        </div>
        {selected === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <EmptyState
              className="m75-inbox-zero"
              icon="inbox"
              title="Inbox zero"
              description="Captures land here untyped. Giving a note a type is what takes it out of the Inbox."
              action={
                <Button variant="secondary" icon="plus" onClick={capture}>
                  Capture a note
                </Button>
              }
            />
          </div>
        ) : (
          <div className="m75-inbox-content">
            {navigationTarget === null && (
              <div className="m75-queue-fallback" style={{ width: QUEUE_FALLBACK_WIDTH }}>
                {captureNavigation}
              </div>
            )}

            {/* The capture reads as a page: the document column, its title
                projected from the body's H1, and the scroll a resting assistant
                clears, exactly as DocPage draws one. */}
            <div
              ref={setReader}
              className={[
                'm75-capture-reader',
                readerWidth !== null && readerWidth < NARROW_READER ? 'cb-doc-narrow' : '',
              ].join(' ')}
              tabIndex={-1}
              data-testid="capture-reader"
              {...turn}
              style={{
                paddingBottom: 'max(40px, var(--assistant-scroll-clearance, 0px))',
                scrollPaddingBottom: 'var(--assistant-scroll-clearance, 0px)',
              }}
            >
              <PageCoverBand entry={selected} editable />
              <div className="cb-document-content">
                <PageIconHeader entry={selected} editable />
                {heldElsewhere ? (
                  <div
                    className="flex items-center gap-3 rounded-md border border-n-200 p-4 text-sm text-n-600"
                    data-testid="inbox-held-editor"
                  >
                    Open in another pane
                    <Button variant="secondary" size="sm" onClick={showHolder}>
                      Show
                    </Button>
                  </div>
                ) : diffOpen ? (
                  <InlineDiff path={selected.path} />
                ) : (
                  // M70.2b: the selection toolbar's Comment button reads this.
                  <PageCommentsContext.Provider
                    value={comments.path === null ? null : { start: comments.start }}
                  >
                    <NoteBodyEditor
                      key={selected.path}
                      path={selected.path}
                      pageTitle={selected.title}
                      onSaveState={setSaveState}
                      onReady={(info) => setMounted({ path: selected.path, editor: info.editor })}
                    />
                  </PageCommentsContext.Provider>
                )}
              </div>
            </div>

            {/* The capture's outline, as a page's (DocOutline): over the
                reader, at its edge, where the reader keeps its gutter, and
                not under a drawer. */}
            {editor !== null &&
              !inspectorDrawer &&
              (readerWidth === null || readerWidth >= NARROW_READER) && (
                <DocOutline editor={editor} scrollRef={readerRef} skipTitle />
              )}

            {/* A drawer closes on Escape or a press on the reader it covers,
                and neither is the person's word on the docked panel. */}
            {inspectorDrawer && (
              <DrawerScrim
                label="Close the panel"
                testId="inbox-drawer-scrim"
                onDismiss={() => setDrawerFor(null)}
                className="absolute inset-0 z-10"
              />
            )}
          </div>
        )}
      </div>
      {menu !== null && selected !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              icon: 'circle-check',
              label: 'Mark organized',
              onSelect: () => fileNote(selected.path),
            },
            {
              icon: 'external-link',
              label: 'Open as page',
              onSelect: () => navigate({ kind: 'doc', path: selected.path }),
            },
          ]}
        />
      )}
      {imports[0] && (
        <ImportInlet
          key={imports[0].id}
          input={imports[0].input}
          shouldNavigate={() => pendingImports.current.length === 1}
          onClose={() => setImports((queue) => queue.slice(1))}
        />
      )}
    </div>
  );
}
