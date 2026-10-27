import { PullRequestStrip } from '@/detail/PullRequestStrip';
import { SelectedDocPage } from './SelectedDocPage';
import { DeletedDraftRecovery, useRecoveryHold } from '@/editor/DeletedDraftRecoveryFace';
import './pages.css';
import { PageRunsTab } from '@/detail/PageRunsTab';
import { PageAgentsTab } from '@/detail/PageAgentsTab';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { pageAsides } from '@/app/shellLayout';
import { MoveDialog } from '@/components/MoveDialog';
import { EntryIcon } from '@/components/PageIcon';
import {
  Crumb,
  CrumbSeparator,
  PANEL_HEAD_CHROME,
  PageToolbar,
  PanelButtons,
  SaveState,
} from '@/components/PageToolbar';
import { Button } from '@/components/ui/Button';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { DrawerScrim } from '@/components/ui/DrawerScrim';
import { Presence, usePageTurn } from '@/components/ui/motion';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { FavoriteStar } from '@/app/FavoriteStar';
import { OpenWithMenu } from '@/app/OpenWithMenu';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { DocPagesFloatingButton, DocPagesPanel } from '@/detail/DocPagesPanel';
import { DocSidePanel } from '@/detail/DocSidePanel';
import { usePageComments } from '@/detail/usePageComments';
import { PageCoverBand, PageIconHeader } from '@/detail/PageChrome';
import { DocOutline } from '@/editor/DocOutline';
import type { CerebroEditor, EditorReadyInfo } from '@/editor/MarkdownEditor';
import { spliceTitleIntoBlocks } from '@/editor/markdown';
import { NoteBodyEditor, type SaveState as EditorSaveState } from '@/editor/NoteBodyEditor';
import { PageCommentsContext } from '@/editor/PageCommentsContext';
import { InlineDiff } from '@/git/InlineDiff';
import { RecordPageProperties } from '@/detail/RecordPageProperties';
import { CorrespondenceSection } from '@/detail/CorrespondenceSection';
import { ImportProvenance } from '@/detail/ImportProvenance';
import { RecordTabs, recordTabSet } from '@/detail/RecordTabs';
import { TabSections } from '@/detail/TabSections';
import { addSubPage } from '@/app/pageActions';
import { savePageAsTemplate } from '@/app/templateActions';
import { applyPageTemplate } from '@/app/applyPageTemplate';
import { trashPath } from '@/app/trashActions';
import { setTypeTabs } from '@/app/typeActions';
import { isAgentEntry } from '@/engine/agents';
import { isCollectionPage } from '@/engine/collections';
import { isCommentPage } from '@/engine/comments';
import { TRASH_WORDS } from '@/engine/trash';
import {
  canHaveSubPages,
  crumbTrail,
  descendantPageCount,
  docPagesFor,
  isFolderNote,
  type Crumb as TrailStep,
} from '@/engine/docPages';
import { isKnowledgePath } from '@/engine/okf';
import { pageIconOf } from '@/engine/pageChrome';
import { isRecordEntry } from '@/engine/typeCatalog';
import { resolveViewTab } from '@/engine/viewTab';
import type { Entry, Selection } from '@/engine/types';
import { ViewTabEmbed } from '@/views/ViewTabEmbed';
import { AgentPageBody, agentTabOf } from '@/library/AgentPage';
import { ConceptHeading } from '@/knowledge/ConceptHeading';
import { ConceptReviewBar } from '@/knowledge/ConceptReviewBar';
import { KnowledgeStrip } from '@/knowledge/KnowledgeStrip';
import { ReviewPager } from '@/knowledge/ReviewQueue';
import { useConcept } from '@/knowledge/useConcepts';
import { conceptAskOf, sendAsk } from '@/agent/elements/decisionsAsks';
import { humanizeSlug } from '@/lib/slug';
import { listTemplates, templateDisplayName } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import {
  DOC_COLUMN_MIN_WIDTH,
  DOC_PAGES_MIN_WIDTH,
  DOC_PANEL_MIN_WIDTH,
  DOC_PANEL_WIDTH,
  useUiStore,
  type PagePanel,
} from '@/stores/uiStore';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';
import { Contained } from '@/app/Contained';

export type DocSelection = Extract<Selection, { kind: 'doc' }>;

/**
 * Whether the page at `path` has its side panel open (M52): the shell counts
 * that panel in the main column's floor, so the sidebar gives before the
 * page's reading column does. The rule DocPage opens the panel by — a concept
 * keeps its own flag (M51.3), every other page the doc panel's.
 */
export function usePageAsideOpen(path: string | null): boolean {
  const isConcept = useConcept(path) !== null;
  const entry = useEntry(path);
  const open = useUiStore((s) => (isConcept ? s.conceptPanelOpen : s.docPanelOpen));
  return entry !== null && entry.authority === undefined && open;
}

/**
 * Below this the reading column trims the editor's right-hand gutter (M52).
 * The left one stays: it holds the block handles, and the title, the review
 * bar and the Knowledge strip are all aligned to it.
 */
const DOC_NARROW_COLUMN = 560;

/** True while the doc is effectively empty: at most an H1 plus blank
 * paragraphs — the moment the blank-page template bar should show. */
export function isBlankBody(editor: CerebroEditor): boolean {
  let sawHeading = false;
  for (const block of editor.document) {
    if (block.type === 'heading') {
      if (sawHeading || block.props.level !== 1 || block.children.length > 0) return false;
      sawHeading = true;
      continue;
    }
    if (block.type !== 'paragraph') return false;
    const content = block.content;
    if (Array.isArray(content) && content.length > 0) return false;
  }
  return true;
}

/** Floating action bar on blank pages: start from a template (M2.x feedback:
 * templates need a visible surface, not just the New-page dialog). */
function BlankPageBar({
  templates,
  onPick,
}: {
  templates: Entry[];
  onPick: (template: Entry) => void;
}) {
  return (
    <div
      data-testid="blank-page-bar"
      className="pointer-events-none absolute bottom-6 left-0 right-0 flex justify-center"
    >
      <div className="pointer-events-auto flex max-w-[90%] items-center gap-1.5 overflow-x-auto rounded-full border border-n-200 bg-n-0 px-3 py-1.5 shadow-[0_4px_16px_rgba(22,26,36,0.10)]">
        <Icon name="layout-template" size={14} color="var(--n-500)" />
        {templates.length > 0 ? (
          <>
            <span className="flex-none text-xs text-n-500">Start from a template</span>
            {templates.map((t) => (
              <button
                key={t.path}
                type="button"
                onClick={() => onPick(t)}
                className="flex-none rounded-full border border-n-200 bg-n-0 px-2.5 py-0.5 text-xs text-n-700 hover:border-cortex-500 hover:text-cortex-600"
              >
                {templateDisplayName(t)}
              </button>
            ))}
          </>
        ) : (
          <span className="text-xs text-n-500">
            No templates yet — build this page, then ⋯ → Save as template to reuse it.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Full-page markdown document (M2 Task 10; M2.x docs polish). The title is
 * the doc's H1, edited inside the editor — each save rescans, so the header
 * and every other surface pick the new title up from the scanner.
 */
export function DocPage({ selection }: { selection: DocSelection }) {
  const entry = useEntry(selection.path);
  const status = useVaultStore((state) => state.status);
  const error = useVaultStore((state) => state.error);
  if (status === 'error')
    return (
      <div role="alert" className="section-unavailable">
        Workspace unavailable{error === null ? '' : `: ${error}`}
      </div>
    );
  if (entry?.authority?.kind === 'sqlite_metadata') return <SelectedDocPage entry={entry} />;
  return <LegacyDocPage selection={selection} />;
}

function LegacyDocPage({ selection }: { selection: DocSelection }) {
  const entry = useEntry(selection.path);
  // Each page the column shows fades in as it arrives, the editor kept
  // (`usePageTurn`, pageFrame.css).
  const turn = usePageTurn(selection.path);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const startAction = useVaultActionGuard(JSON.stringify([vaultPath, selection.path]));
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const navigate = useNavStore((s) => s.navigate);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const docPanelOpen = useUiStore((s) => s.docPanelOpen);
  const setDocPanelOpen = useUiStore((s) => s.setDocPanelOpen);
  const conceptPanelOpen = useUiStore((s) => s.conceptPanelOpen);
  const setConceptPanelOpen = useUiStore((s) => s.setConceptPanelOpen);
  const docPanel = useUiStore((s) => s.docPanel);
  const setDocPanel = useUiStore((s) => s.setDocPanel);
  const conceptPanel = useUiStore((s) => s.conceptPanel);
  const setConceptPanel = useUiStore((s) => s.setConceptPanel);
  const pagesOpen = useUiStore((s) => s.docPagesOpen);
  const openLayoutEditor = useUiStore((s) => s.openLayoutEditor);
  const askAgent = useUiStore((s) => s.askAgent);
  // M50.1 — a concept is a page. Same canvas, same editor, same panel; what
  // differs is where its title lives (frontmatter), where its review sits (a
  // bar under the title, M51.3), and which page actions its folder refuses.
  const concept = useConcept(selection.path);
  // The body as the disk last gave it to the editor — what Verify attests.
  const [viewed, setViewed] = useState<{ path: string; body: string } | null>(null);
  // M51.3 — a concept's panel keeps its own open state, closed until asked:
  // its review is the bar under the title, not a column beside it.
  // `usePageAsideOpen` states the same rule for the shell's floor.
  const panelOpen = concept !== null ? conceptPanelOpen : docPanelOpen;
  const setPanelOpen = concept !== null ? setConceptPanelOpen : setDocPanelOpen;
  const panel = concept !== null ? conceptPanel : docPanel;
  const setPanel = concept !== null ? setConceptPanel : setDocPanel;
  // M52: the page frame's width decides how its panels are drawn (shellLayout
  // `pageAsides`), and the column's decides how wide the editor's gutter is.
  // The fold is decided before paint, or a fast resize draws the side panel
  // past the canvas for a frame. The side panel opens under the toolbar's
  // actions, so their width is its floor too.
  const [frameRef, frameWidth] = useMeasuredWidth({ beforePaint: true });
  const [actionsRef, actionsWidth] = useMeasuredWidth({ beforePaint: true, box: 'border' });
  const [columnRef, columnWidth] = useMeasuredWidth();
  // A folded panel opens on request as a drawer over the column. Session
  // state, like the fold it opens over, and held as the PATH it was opened on
  // so it never follows you to the next page.
  const [pagesDrawerFor, setPagesDrawerFor] = useState<string | null>(null);
  const [sideDrawerFor, setSideDrawerFor] = useState<string | null>(null);

  // The outline and the comments need the live editor, and the outline the
  // scroll container (Task 15). The editor is held with the mount it came
  // from, set by onReady below; `editor` is derived further down, once the
  // page knows whether that mount is still on screen.
  const [mounted, setMounted] = useState<{
    path: string;
    editor: CerebroEditor;
  } | null>(null);
  // Explicit title actions flush through the current editor owner.
  const editorControls = useRef<EditorReadyInfo | null>(null);
  const [saveState, setSaveState] = useState<EditorSaveState>('idle');
  // M9.7: reading a diff swaps the editor out for it, in place.
  const diffOpen = useUiStore((s) => s.diffView?.path === selection.path);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // M38.2 — a record is a page too. Same canvas, plus the property surface
  // the panel shows, minus nothing.
  // A concept is never a record page, whatever its `type:` names (M50.1):
  // its frontmatter is provenance, which the review bar and the Details
  // panel read, not a property stack to edit.
  const record = entry !== null && isRecordEntry(entry) && !isKnowledgePath(entry.path);
  // M55.12 — an agent is a page too: its body is its standing instructions,
  // its grants are the properties above the strip, and its tabs are the
  // app's own (Instructions, Runs, Memory), riding the selection like a
  // record's. Not a record (`isRecordEntry` turns agents away), so neither
  // branch above can claim it.
  const agent = entry !== null && isAgentEntry(entry);
  const agentTab = agentTabOf(selection.tab);
  // M44.5 — the record page's tabs come from its TYPE (`typeTabs` synthesizes
  // Overview when none are saved) and the open one rides the selection, so
  // "the Spec tab of DOC-14" is a place the back button returns to. A stale
  // `selection.tab` — a tab deleted while history still names it — falls back
  // to the first tab rather than rendering nothing.
  //
  // M45.2 (spec §3.5): Simple means NO strip — the strip mounts only on SAVED
  // tabs, while the content swap keeps consuming `typeTabs` so the synthesized
  // Overview still drives the canvas. M45.6 hoisted both halves to
  // `recordTabSet` beside the strip, because the PEEK grew the same strip and
  // two hand-rolled gates are how the two surfaces would come to disagree.
  const { tabs, saved: savedTabs } = recordTabSet(entry, schema);
  const activeTab = tabs.find((t) => t.id === selection.tab) ?? tabs[0] ?? null;

  // Related tabs hide body blocks while retaining the title and the one editor owner.
  const showsEditor = agent
    ? agentTab === 'instructions'
    : activeTab === null || activeTab.content === 'overview';

  // The same editor remains live on related tabs so title edits, pending saves
  // and comment anchors retain their owner. A diff or path change replaces it.
  const mountLive = mounted !== null && mounted.path === selection.path && !diffOpen;
  if (mounted !== null && !mountLive) setMounted(null);
  const editor = mountLive ? mounted.editor : null;

  // Blank-page detection drives the floating template bar.
  const [blank, setBlank] = useState(false);
  useEffect(() => {
    if (editor === null) {
      setBlank(false);
      return;
    }
    const sync = () => {
      setBlank(isBlankBody(editor));
    };
    sync();
    const unsubscribe = editor.onChange?.(sync);
    return () => unsubscribe?.();
  }, [editor]);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState(false);
  // The page the Add sub-page dialog adds to (M55.13): this page from its
  // menu, the listed page from the Pages panel.
  const [subPageOf, setSubPageOf] = useState<Entry | null>(null);
  const [pageName, setPageName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionBusy, setBusy] = useState(false);
  const templateScope = JSON.stringify([vaultPath, selection.path]);
  const [templatePending, setTemplatePending] = useState<{ scope: string } | null>(null);
  const busy = actionBusy || templatePending?.scope === templateScope;
  const menuButtonRef = useRef<HTMLDivElement | null>(null);

  // M70.2b — the page's comments, on every .md page this opens: docs,
  // records, agents and concepts alike (CV-08; Q5). A hook, so before the
  // early return; the panel it opens is laid out below it, so it reaches
  // `openSide` through a ref set each render. No editor while a diff stands
  // in for it (`editor` is already null then): its highlights are not on
  // screen to draw or focus.
  const openSideRef = useRef<(panel: PagePanel) => void>(() => undefined);
  const comments = usePageComments(
    entry !== null && isCommentPage(entry.path) ? entry.path : null,
    editor,
    { openPanel: () => openSideRef.current('comments'), deepLink: selection.thread ?? null },
  );

  const recoveryHeld = useRecoveryHold(vaultPath, selection.path);
  if (entry === null || recoveryHeld) {
    return (
      <DeletedDraftRecovery
        vaultId={vaultPath}
        path={selection.path}
        fallback={
          <div className="flex min-w-0 flex-1 items-center justify-center">
            <EmptyState
              icon="file-x"
              title="This page no longer exists"
              description="It may have been renamed or moved to the Trash."
              action={
                <Button variant="secondary" onClick={() => navigate({ kind: 'home' })}>
                  Go home
                </Button>
              }
            />
          </div>
        }
      />
    );
  }

  const docPages = docPagesFor(entry, entries);
  const asides = pageAsides({
    row: frameWidth,
    pages: docPages !== null && pagesOpen,
    side: panelOpen,
    sideFloor:
      actionsWidth === null
        ? DOC_PANEL_MIN_WIDTH
        : Math.max(DOC_PANEL_MIN_WIDTH, actionsWidth + PANEL_HEAD_CHROME),
  });
  // A drawer belongs to the fold it opened over: once the panel fits again,
  // the next fold starts closed.
  if (asides.pages && pagesDrawerFor !== null) setPagesDrawerFor(null);
  if (asides.sideFits && sideDrawerFor !== null) setSideDrawerFor(null);
  const pagesDrawn =
    docPages !== null && pagesOpen && (asides.pages || pagesDrawerFor === entry.path);
  const sideDrawn = panelOpen && (asides.sideFits || sideDrawerFor === entry.path);
  // Drawn as drawers: over the column, closed by Escape or the scrim.
  const pagesDrawer = pagesDrawn && !asides.pages;
  const sideDrawer = sideDrawn && !asides.sideFits;
  // The buttons speak for what is on screen. Closing writes the stored flag —
  // that is the user's word; a fold never does. Showing a panel with no room
  // beside the column opens it as a drawer rather than into a fold nobody
  // can see.
  const showSide = () => {
    if (!panelOpen) setPanelOpen(true);
    if (!asides.sideFits) setSideDrawerFor(entry.path);
  };
  const closeSide = () => {
    setPanelOpen(false);
    setSideDrawerFor(null);
  };
  // Open the slot on `which`, as a drawer when it does not fit (M70.2b) —
  // a comment's highlight asks for its thread this way.
  openSideRef.current = (which) => {
    setPanel(which);
    if (!sideDrawn) showSide();
  };
  // Each panel's button opens it, or closes it when it is the one open.
  const togglePanel = (which: PagePanel) => {
    if (sideDrawn && panel === which) closeSide();
    else openSideRef.current(which);
  };
  const openComments = comments.slot?.kind === 'ready' ? (comments.sections?.openCount ?? 0) : 0;
  const fullWidth = entry.properties.full_width === true;
  // Everything under knowledge/ is written through the ledger. A concept is
  // edited as a concept; the rest of the folder (the derived log, cached
  // sources) is the system's to write and opens read-only.
  const knowledgeFile = isKnowledgePath(entry.path);
  const readOnlyFile = knowledgeFile && concept === null;

  // Breadcrumb (M55.13): the way up the page tree. Each ancestor folder is the
  // page it is when it has a folder note, and a plain label otherwise; a
  // concept's crumbs are its Knowledge sections, and an agent's place is the
  // Agents surface, not the folder its file sits in.
  const trail: (TrailStep | { kind: 'folder'; label: string; section: string })[] = agent
    ? []
    : knowledgeFile
      ? (entry.folder === '' ? [] : entry.folder.split('/').slice(1)).map((seg) => ({
          kind: 'folder' as const,
          label: humanizeSlug(seg),
          section: seg,
        }))
      : crumbTrail(entry, entries);

  // A record's crumb root is its backdrop — the Collection it lives in when
  // it has one, its type screen otherwise: the same rule useOpenPath applies
  // when it picks a canvas to put behind the peek (M38.2).
  const recordFolder =
    entry.project !== null && entry.project.includes('/')
      ? entry.project.slice(0, entry.project.lastIndexOf('/'))
      : null;

  // Move takes the page with its sub-pages: the folder for a folder note, the
  // file alone for any other page (M55.13) — a sub-page used to take the whole
  // doc it sat in along with it.
  const moveSubject: { path: string; label: string } = {
    path: isFolderNote(entry) ? entry.folder : entry.path,
    label: `page "${entry.title}"`,
  };

  // addSubPage never throws: it toasts its own refusal or failure (M55.13).
  const submitSubPage = async () => {
    const trimmed = pageName.trim();
    if (trimmed === '' || subPageOf === null || busy) return;
    setBusy(true);
    try {
      const child = await addSubPage(subPageOf.path, trimmed);
      if (child === null) return;
      setSubPageOf(null);
      setPageName('');
      navigate({ kind: 'doc', path: child });
    } finally {
      setBusy(false);
    }
  };

  // Trash operates on the same subject as Move: trashing a doc's MAIN page
  // used to delete only that file, which removed the folder note and
  // dissolved the doc — its other pages stranded in a plain folder with no
  // header, no Pages panel, and no dialog copy warning about any of it.
  // Every page under it counts, grandchildren included: they all go.
  const isDocMain = docPages !== null && entry.path === docPages.main.path;
  const deleteSubject: { path: string; title: string; extraPages: number } = isDocMain
    ? {
        path: docPages.folder,
        title: docPages.main.title,
        extraPages: descendantPageCount(docPages.folder, entries),
      }
    : { path: entry.path, title: entry.title, extraPages: 0 };

  // M60.8: to the vault's own Trash. trashPath toasts, rescans and never
  // throws; a refusal keeps the dialog open and the page on screen.
  const submitDelete = async () => {
    if (vaultPath === null || busy) return;
    setBusy(true);
    const item = await trashPath(deleteSubject.path, deleteSubject.title);
    setBusy(false);
    if (item === null) return;
    setConfirmDelete(false);
    // Home, since M38.3: the page's surface of origin (Docs) is gone, and
    // after a delete there is no page to stand on.
    navigate({ kind: 'home' });
  };

  // Rename the doc the way the user means it: the visible title (its H1),
  // not the slug on disk. The live editor is spliced too, or its next
  // autosave would write the old title straight back.
  const submitRename = async () => {
    const trimmed = renaming?.trim() ?? '';
    if (vaultPath === null || trimmed === '' || busy) return;
    setBusy(true);
    try {
      if (editor !== null) {
        spliceTitleIntoBlocks(editor, trimmed);
        await editorControls.current?.flushPendingSave();
      } else {
        if (!(await useVaultStore.getState().setTitle(entry.path, trimmed))) return;
      }
      setRenaming(null);
    } catch {
      toast("Couldn't rename page");
    } finally {
      setBusy(false);
    }
  };

  const templates = listTemplates(entries);

  // Applying a template uses one checked batch and the existing owner's
  // outside-write reconciliation, preserving typing during the request.
  const applyTemplate = async (template: Entry) => {
    if (vaultPath === null || busy) return;
    const current = startAction();
    const pending = { scope: templateScope };
    setTemplatePending(pending);
    try {
      await applyPageTemplate(vaultPath, entry.path, template.path, current);
    } finally {
      setTemplatePending((previous) => (previous === pending ? null : previous));
    }
  };

  // Turn this page into a reusable template: copy into templates/ with the
  // H1 swapped for the {{title}} placeholder.
  const saveAsTemplate = async () => {
    if (vaultPath === null || busy) return;
    setBusy(true);
    try {
      await savePageAsTemplate(vaultPath, entry.path);
    } finally {
      setBusy(false);
    }
  };

  // M45.2 — records only: an untyped page has no type whose layout could be
  // customized. A const, so the guard's narrowing survives into the closure.
  const layoutType = record && entry.type !== null ? entry.type : null;

  // Under knowledge/ the file actions refuse (the folder is written through
  // the ledger), so they are not offered; what is left is the concept's own.
  // Its ask is the review bar's, the same Ask (M52.3, M91.14): the menu shows
  // its label and sends its prompt — and, like the bar, a replaced concept
  // offers none.
  const knowledgeMenu: ContextMenuItem[] = [
    ...(concept !== null && concept.supersededBy === null
      ? [
          conceptAskOf({
            path: concept.entry.path,
            title: concept.title,
            stale: concept.stale,
          }),
        ].map((ask) => ({
          icon: 'sparkles',
          label: ask.label,
          onSelect: () => sendAsk(ask, askAgent)(ask.prompt),
        }))
      : []),
    {
      icon: 'brain',
      label: 'Show in Knowledge',
      onSelect: () =>
        navigate(
          concept !== null
            ? { kind: 'knowledge', nav: { tab: 'section', folder: concept.section } }
            : { kind: 'knowledge' },
        ),
    },
  ];

  const menuItems: ContextMenuItem[] = knowledgeFile
    ? knowledgeMenu
    : [
        {
          icon: fullWidth ? 'minimize-2' : 'maximize-2',
          label: fullWidth ? 'Center content' : 'Full width',
          onSelect: () =>
            void patchFrontmatter(entry.path, { full_width: fullWidth ? null : true }),
        },
        ...(layoutType !== null
          ? [
              {
                icon: 'layout',
                label: 'Customize layout…',
                onSelect: () => openLayoutEditor(layoutType),
              },
            ]
          : []),
        { icon: 'pencil', label: 'Rename…', onSelect: () => setRenaming(entry.title) },
        // Not on an agent page (M55.12): growing an agent into a folder of
        // its own moves its file, which changes an un-slugged agent's
        // identity and costs it a catch-up run — canHaveSubPages refuses it —
        // and a template copied from it would carry `type: Agent` and its
        // grants into every page made from it.
        ...(canHaveSubPages(entry)
          ? [{ icon: 'file-plus', label: 'Add sub-page', onSelect: () => setSubPageOf(entry) }]
          : []),
        ...(agent
          ? []
          : [
              {
                icon: 'layout-template',
                label: 'Save as template',
                onSelect: () => void saveAsTemplate(),
              },
            ]),
        {
          icon: 'folder-input',
          label: 'Move to folder…',
          onSelect: () => setMoving(true),
        },
        {
          icon: 'trash-2',
          label: isDocMain && deleteSubject.extraPages > 0 ? 'Move doc to Trash' : 'Move to Trash',
          danger: true,
          onSelect: () => setConfirmDelete(true),
        },
      ];

  // A crumb draws the page's own icon only when it has one; otherwise the
  // lucide icon the crumb always drew.
  const pageGlyph = (page: Entry): ReactNode =>
    pageIconOf(page) === null ? undefined : (
      <EntryIcon entry={page} fallback={{ name: 'file-text' }} size={13} />
    );

  // The body editor: ONE block, shared by the untyped page and a record's
  // Overview tab so an edit to one cannot silently miss the other. The page's
  // history lives in its History panel (M58.4, D18), not here.
  //
  // M70.2b: the selection toolbar's Comment button reads PageCommentsContext,
  // provided here and nowhere else, and not on a read-only page.
  const pageChrome = (
    <>
      {/* M50.2 — what Knowledge holds about this page, where the
                      page is read. Silent when there is nothing, and absent
                      under knowledge/ (a concept's relations are its details). */}
      {!knowledgeFile && <KnowledgeStrip entry={entry} />}
      {concept !== null ? (
        <>
          <ConceptHeading concept={concept} />
          {/* Keyed by the concept (M52.4): the pager's Next swaps
                          the concept under a mounted page, so the bar reads
                          the proposal queue afresh for the concept now shown,
                          and a Verify in flight stays with the one it began
                          on. */}
          <ConceptReviewBar
            key={concept.entry.path}
            concept={concept}
            viewedBody={viewed !== null && viewed.path === entry.path ? viewed.body : null}
            verifyBlocked={
              saveState === 'dirty' || saveState === 'saving'
                ? 'Saving your edit — Verify when it lands.'
                : saveState === 'failed'
                  ? "Your last edit didn't save — Verify would attest the older text."
                  : null
            }
          />
        </>
      ) : null}
      {record && !agent && <RecordPageProperties key={entry.path} entry={entry} schema={schema} />}
      {!knowledgeFile && <PullRequestStrip entry={entry} schema={schema} />}
      {/* M44.5 — the record canvas swaps by the open tab: the
                      body, the tab's free text, or its database. An untyped
                      doc knows nothing of tabs and keeps its document form. */}
      {agent ? (
        <AgentPageBody
          entry={entry}
          tab={agentTab}
          onTab={(tab) => navigate({ kind: 'doc', path: entry.path, tab })}
          editor={null}
        />
      ) : record && activeTab !== null ? (
        <>
          <CorrespondenceSection key={entry.path} entry={entry} schema={schema} />
          <ImportProvenance entry={entry} />
          {/* M44.5, re-placed by M46.1 — the tab strip divides
                          the record's own blocks from the ONE tab's content,
                          so it lives inside the content column now rather
                          than pinned above the scroll container. It scrolls
                          with the record it describes (Notion's order, the
                          peek's order, and the customizer canvas's), and it
                          costs what that placement costs: reading an inline
                          diff swaps it out with the rest of the canvas, so
                          tabs are unavailable until the diff is closed.
                          M45.2
                          gates it on SAVED tabs: the synthesized Overview
                          renders content, never a one-tab strip. */}
          {savedTabs.length > 0 && (
            <div className="cb-record-page-tabs">
              <RecordTabs
                gutter="none"
                tabs={tabs}
                activeId={activeTab.id}
                hostType={entry.type}
                onSelect={(tab) => navigate({ kind: 'doc', path: entry.path, tab })}
                onChange={(next) => {
                  if (entry.type !== null)
                    void setTypeTabs({ name: entry.type, docPath: null }, next);
                }}
              />
            </div>
          )}
          {activeTab.content === 'agents' && (
            <PageAgentsTab entry={entry} entries={entries} schema={schema} />
          )}
          {activeTab.content === 'runs' && (
            <PageRunsTab entry={entry} entries={entries} schema={schema} />
          )}
          {activeTab.content === 'sections' && (
            <TabSections key={`${entry.path}#${activeTab.id}`} entry={entry} tabId={activeTab.id} />
          )}
          {/* M45.4 — the view arm: resolve the tab's pointer
                          (the dashboard ViewBlock path, per render like the
                          dashboard's) and render the embed, or the broken
                          card — never an empty view for a dead pointer. */}
          {activeTab.content === 'view' && (
            <ViewTabEmbed
              resolution={resolveViewTab(activeTab, entry, entries, schema, views)}
              entries={entries}
              schema={schema}
              scope={`viewtab:${activeTab.id}`}
            />
          )}
        </>
      ) : (
        <>
          <ImportProvenance entry={entry} />
        </>
      )}
    </>
  );

  const editorBlock = (
    <PageCommentsContext.Provider
      value={readOnlyFile || comments.path === null ? null : { start: comments.start }}
    >
      <Contained label="This page's editor" resetKey={entry.path}>
        <NoteBodyEditor
          key={entry.path}
          path={entry.path}
          onSaveState={setSaveState}
          onReady={(info) => {
            editorControls.current = info;
            setMounted({ path: entry.path, editor: info.editor });
          }}
          readOnly={readOnlyFile}
          sections={concept !== null}
          pageTitle={knowledgeFile ? undefined : entry.title}
          pageChrome={pageChrome}
          bodyVisible={showsEditor}
          onBodyLoaded={concept !== null ? (path, body) => setViewed({ path, body }) : undefined}
        />
      </Contained>
    </PageCommentsContext.Provider>
  );

  const narrowColumn = columnWidth !== null && columnWidth < DOC_NARROW_COLUMN;

  return (
    <div
      ref={frameRef}
      className="cb-document cb-page-frame flex-1"
      data-testid="doc-page"
      data-panel={sideDrawn ? (sideDrawer ? 'drawer' : 'docked') : undefined}
      style={
        {
          // The reading column's floor, and the Pages panel's beside it.
          '--frame-main-min': `${DOC_COLUMN_MIN_WIDTH + (pagesDrawn && !pagesDrawer ? DOC_PAGES_MIN_WIDTH : 0)}px`,
          '--frame-panel-w': `${DOC_PANEL_WIDTH}px`,
          '--frame-panel-min': `${DOC_PANEL_MIN_WIDTH}px`,
        } as CSSProperties
      }
    >
      <PageToolbar
        crumbs={
          <>
            {knowledgeFile ? (
              <Crumb
                label="Knowledge"
                icon="brain"
                onClick={() => navigate({ kind: 'knowledge' })}
              />
            ) : agent ? (
              <Crumb label="Agents" icon="bot" onClick={() => navigate({ kind: 'agents' })} />
            ) : record ? (
              recordFolder !== null ? (
                <Crumb
                  label={humanizeSlug(recordFolder.split('/').pop() ?? recordFolder)}
                  icon="folder"
                  onClick={() => navigate({ kind: 'collection', folder: recordFolder })}
                />
              ) : (
                <Crumb
                  label={entry.type ?? 'Records'}
                  icon="database"
                  onClick={
                    entry.type === null
                      ? undefined
                      : () => navigate({ kind: 'type', name: entry.type as string })
                  }
                />
              )
            ) : (
              // M38.3: no Docs surface to root at — a doc's crumb is its
              // folder path, and the Pages tree in the nav is the way up.
              <Crumb label="Pages" icon="library" />
            )}
            {trail.map((step, i) => (
              <span key={i} className="flex min-w-0 items-center gap-0.5">
                <CrumbSeparator />
                {step.kind === 'page' ? (
                  // An ancestor page (M55.13): a crumb that opens it, wearing its
                  // icon (M55.11). A Collection page opens as its collection.
                  <Crumb
                    label={step.entry.title}
                    glyph={
                      <EntryIcon entry={step.entry} fallback={{ name: 'file-text' }} size={13} />
                    }
                    onClick={() =>
                      navigate(
                        isCollectionPage(step.entry)
                          ? { kind: 'collection', folder: step.entry.folder }
                          : { kind: 'doc', path: step.entry.path },
                      )
                    }
                  />
                ) : (
                  <Crumb
                    label={step.label}
                    // A concept's folder is a Knowledge section, and a place.
                    onClick={
                      'section' in step && i === 0
                        ? () =>
                            navigate({
                              kind: 'knowledge',
                              nav: { tab: 'section', folder: step.section },
                            })
                        : undefined
                    }
                  />
                )}
              </span>
            ))}
            <span className="flex min-w-0 items-center gap-0.5" data-testid="doc-title">
              <CrumbSeparator />
              <Crumb
                label={entry.title}
                glyph={pageGlyph(entry)}
                icon={concept !== null ? 'lightbulb' : agent ? 'bot' : 'file-text'}
                strong
              />
            </span>
          </>
        }
        status={
          <>
            {/* M51.2 — the review queue, walkable from the page it sends you to. */}
            {/* One line: squeezed beside the assistant it wrapped to "Review 1 of"
              over "3" and doubled the header's height (M52). */}
            {concept !== null && (
              <span className="flex flex-none whitespace-nowrap">
                <ReviewPager path={entry.path} />
              </span>
            )}
            <SaveState state={saveState} />
          </>
        }
        actions={
          <>
            <FavoriteStar path={entry.path} />
            {/* M55.9 — copy as a prompt or a path, reveal, open elsewhere, or
              hand the page to an agent app. */}
            <OpenWithMenu entry={entry} knowledgeFile={knowledgeFile} />
            {/* The toolbar is the star, Open with, the overflow menu and the
              panels' buttons. 'Add sub-page' and 'Move to folder' are BOTH in
              the overflow menu — a labelled toolbar button for either
              duplicated the action users need least. */}
            <div ref={menuButtonRef} className="inline-flex">
              <IconButton
                icon="ellipsis"
                label="Page options"
                size="sm"
                onClick={() => {
                  const rect = menuButtonRef.current?.getBoundingClientRect();
                  setMenu(
                    rect === undefined
                      ? { x: 0, y: 0 }
                      : { x: rect.right - 180, y: rect.bottom + 4 },
                  );
                }}
              />
            </div>
            {/* No tooltips while a drawer they opened is up (M52): the
              pointer that opened it is still resting here, and a tooltip
              over the drawer took the first Escape, so closing it took two. */}
            <PanelButtons
              shown={sideDrawn ? panel : null}
              onToggle={togglePanel}
              comments={comments.path === null ? null : openComments}
              tooltip={!sideDrawer}
            />
          </>
        }
        onClosePanel={sideDrawn ? closeSide : undefined}
        closeTooltip={!sideDrawer}
        actionsRef={actionsRef}
      />
      {/* Next to its buttons in the focus order, as it is under them on screen;
          the frame places it on the right (components/pageFrame.css). Closed,
          it stays to play its exit, as it was drawn. */}
      <Presence<HTMLElement>
        open={sideDrawn}
        render={({ closing, ref }) => (
          <Contained label="This panel" resetKey={panel} compact>
            <DocSidePanel
              ref={ref}
              closing={closing}
              overlay={sideDrawer}
              entry={entry}
              schema={schema}
              panel={panel}
              concept={concept}
              comments={comments}
            />
          </Contained>
        )}
      />
      <div className="cb-page-frame-body">
        {/* A drawer closes on Escape or a press on the column it covers, and
            neither writes the stored open flag — the fold is not the user's
            word, so neither is its drawer's close (M52). */}
        {(pagesDrawer || sideDrawer) && (
          <DrawerScrim
            onDismiss={() => {
              setPagesDrawerFor(null);
              setSideDrawerFor(null);
            }}
            label="Close the panel"
            testId="doc-drawer-scrim"
            className="absolute inset-0 z-10"
          />
        )}
        {pagesDrawn && (
          <DocPagesPanel
            pages={docPages}
            activePath={entry.path}
            onAddSubPage={() => setSubPageOf(docPages.main)}
            onHide={pagesDrawer ? () => setPagesDrawerFor(null) : undefined}
          />
        )}
        {/* The reading column gives first, but only down to its floor — then
            the panels give, then fold (M52). It had `min-w-0`, so
            beside a wide assistant it went to 128px while the side panel
            kept all 272. */}
        <div
          ref={columnRef}
          data-testid="doc-column"
          {...turn}
          className={[
            'relative flex min-h-0 flex-1 flex-col',
            narrowColumn ? 'cb-doc-narrow' : '',
          ].join(' ')}
          style={{ minWidth: DOC_COLUMN_MIN_WIDTH }}
        >
          {docPages !== null && !pagesDrawn && (
            <DocPagesFloatingButton
              onOpen={pagesOpen ? () => setPagesDrawerFor(entry.path) : undefined}
            />
          )}
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            style={{
              paddingBottom: 'max(40px, var(--assistant-scroll-clearance, 0px))',
              scrollPaddingBottom: 'var(--assistant-scroll-clearance, 0px)',
            }}
          >
            {/* M55.11 — the cover, full-bleed above the column; the top
                padding sits below it. */}
            <PageCoverBand entry={entry} editable={!knowledgeFile} />
            <div
              data-testid="doc-content"
              className={
                fullWidth ? 'cb-document-content cb-document-content-wide' : 'cb-document-content'
              }
            >
              {/* M55.11 — the page's icon above its title, and the hover row
                  that adds one; outside the diff lens, so both show there. */}
              <PageIconHeader entry={entry} editable={!knowledgeFile} />
              {diffOpen ? (
                <InlineDiff path={entry.path} />
              ) : knowledgeFile ? (
                <>
                  {pageChrome}
                  {editorBlock}
                </>
              ) : (
                editorBlock
              )}
            </div>
          </div>
          {/* Never on an agent page: a template's frontmatter could retype
              the record it lands on (M55.12). */}
          {blank && !busy && !knowledgeFile && !agent && (
            <BlankPageBar templates={templates} onPick={(t) => void applyTemplate(t)} />
          )}
          {/* The page's outline, on the page (owner, 2026-10-19 — Notion's):
              its headings as marks at the column's edge, a list on hover.
              Only over the body it outlines, not where the column has trimmed
              the gutter it sits in, and not under a drawer, where the keyboard
              would reach a list nobody can see. Under knowledge/ the title is
              the concept's own, so every heading in the body is content. */}
          {editor !== null && showsEditor && !narrowColumn && !sideDrawer && !pagesDrawer && (
            <DocOutline editor={editor} scrollRef={scrollRef} skipTitle={!knowledgeFile} />
          )}
        </div>
      </div>

      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {moving && (
        <MoveDialog
          path={moveSubject.path}
          label={moveSubject.label}
          onClose={() => setMoving(false)}
          onMoved={(dest) => {
            const newPath = isFolderNote(entry) ? `${dest}/${entry.filename}` : dest;
            setMoving(false);
            navigate({ kind: 'doc', path: newPath });
          }}
        />
      )}
      {subPageOf !== null && (
        <Dialog
          open
          onClose={() => setSubPageOf(null)}
          title="Add sub-page"
          width={420}
          primaryAction={{
            label: 'Add',
            onClick: () => void submitSubPage(),
            disabled: pageName.trim() === '' || busy,
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setSubPageOf(null) }}
        >
          <p className="m-0 mb-2 text-sm text-n-500">
            {isFolderNote(subPageOf)
              ? `Adds a page inside "${subPageOf.title}".`
              : `"${subPageOf.title}" moves into a folder of its own. Its text does not change.`}
          </p>
          <Input
            autoFocus
            placeholder="Page name"
            value={pageName}
            onChange={(e) => setPageName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitSubPage();
            }}
            width="100%"
          />
        </Dialog>
      )}
      {renaming !== null && (
        <Dialog
          open
          onClose={() => setRenaming(null)}
          title="Rename page"
          width={420}
          primaryAction={{
            label: 'Rename',
            onClick: () => void submitRename(),
            disabled: renaming.trim() === '' || busy,
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setRenaming(null) }}
        >
          <p className="m-0 mb-2 text-sm text-n-500">
            This rewrites the page's heading — the filename on disk stays as it is.
          </p>
          <Input
            autoFocus
            placeholder="Page name"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRename();
            }}
            width="100%"
          />
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={
            deleteSubject.extraPages > 0
              ? `Move "${deleteSubject.title}" and its ${deleteSubject.extraPages} other ${
                  deleteSubject.extraPages === 1 ? 'page' : 'pages'
                } to Trash?`
              : `Move "${deleteSubject.title}" to Trash?`
          }
          width={420}
          primaryAction={{
            label: 'Move to Trash',
            onClick: () => void submitDelete(),
            disabled: busy,
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(false) }}
          footerNote={TRASH_WORDS.footer}
        >
          <p className="m-0 text-sm text-n-600">{isDocMain ? TRASH_WORDS.doc : TRASH_WORDS.body}</p>
        </Dialog>
      )}
    </div>
  );
}
