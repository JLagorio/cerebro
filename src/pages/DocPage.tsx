import { PullRequestStrip } from '@/detail/PullRequestStrip';
import './pages.css';
import { PageRunsTab } from '@/detail/PageRunsTab';
import { PageAgentsTab } from '@/detail/PageAgentsTab';
import { keycapText } from '@/components/ui/Keycaps';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pageAsides } from '@/app/shellLayout';
import { MoveDialog } from '@/components/MoveDialog';
import { EntryIcon } from '@/components/PageIcon';
import { Button } from '@/components/ui/Button';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { DrawerScrim } from '@/components/ui/DrawerScrim';
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
import type { CerebroEditor, EditorReadyInfo } from '@/editor/MarkdownEditor';
import { hasTitleBlock, spliceTitleIntoBlocks } from '@/editor/markdown';
import { NoteBodyEditor, type SaveState } from '@/editor/NoteBodyEditor';
import { PageCommentsContext } from '@/editor/PageCommentsContext';
import { InlineDiff } from '@/git/InlineDiff';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { RecordProperties } from '@/detail/RecordProperties';
import { CorrespondenceSection } from '@/detail/CorrespondenceSection';
import { ImportProvenance } from '@/detail/ImportProvenance';
import { RecordTabs, recordTabSet } from '@/detail/RecordTabs';
import { TabSections } from '@/detail/TabSections';
import { addSubPage } from '@/app/pageActions';
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
  type Crumb,
} from '@/engine/docPages';
import { resolveLayout } from '@/engine/layout';
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
import { askedAbout, conceptAsk } from '@/lib/prompts';
import { createFolder, readNote, saveNote, setNoteTitle } from '@/lib/ipc';
import { humanizeSlug, slugify } from '@/lib/slug';
import {
  applyTemplateBody,
  applyTemplateFrontmatter,
  listTemplates,
  templateDisplayName,
  TEMPLATES_DIR,
  todayIso,
} from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { DOC_COLUMN_MIN_WIDTH, useUiStore } from '@/stores/uiStore';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';

export type DocSelection = Extract<Selection, { kind: 'doc' }>;

/**
 * Whether the page at `path` has its side panel open (M52): the shell counts
 * that panel in the main column's floor, so the sidebar gives before the
 * page's reading column does. The rule DocPage opens the panel by — a concept
 * keeps its own flag (M51.3), every other page the doc panel's.
 */
export function usePageAsideOpen(path: string | null): boolean {
  const isConcept = useConcept(path) !== null;
  const exists = useEntry(path) !== null;
  const open = useUiStore((s) => (isConcept ? s.conceptPanelOpen : s.docPanelOpen));
  return exists && open;
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
      if (sawHeading) return false;
      sawHeading = true;
      continue;
    }
    if (block.type !== 'paragraph') return false;
    const content = block.content;
    if (Array.isArray(content) && content.length > 0) return false;
  }
  return true;
}

/**
 * The title of a doc whose body carries no H1 (M15).
 *
 * A note's title IS its first H1; with none, the scanner falls back to the
 * filename. So the app knew this doc's title — it showed it in the sidebar,
 * in Quick Open, in recents and in the breadcrumb — and the document was the
 * single place it never appeared. This renders it where a title belongs, in
 * the editor's own H1 metrics so it reads as the document's first line rather
 * than as page chrome, and committing it writes a real H1 into the body.
 *
 * A textarea, not an input: at 32px in a reading column real titles wrap, and
 * an input would clip its own text with no way to read the rest.
 */
function UntitledDocHeading({
  title,
  onCommit,
}: {
  title: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(title);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setDraft(title), [title]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const fit = () => {
      el.style.height = 'auto';
      // scrollHeight excludes the border, but the box is border-box, so setting
      // height to scrollHeight alone clips the last two pixels of a descender.
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    // A narrower column rewraps the title onto lines the old height does not
    // show (M52). Width only: the fit itself changes the height, and refitting
    // on that would chase its own tail.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);
  return (
    <textarea
      ref={ref}
      data-testid="doc-title-heading"
      aria-label="Document title"
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        // Enter commits rather than opening a second line: this is one title,
        // and the body below is where prose goes.
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(title);
        }
      }}
      // 45 + 1px border + 8px padding = the editor's 54px block gutter, so the
      // heading and the first paragraph share one left edge.
      className="mb-1 ml-[45px] block w-[calc(100%-45px)] resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-0 text-3xl font-semibold leading-[43px] text-n-900 outline-none hover:border-n-200 focus-visible:border-cortex-500 focus-visible:shadow-[var(--ring)]"
    />
  );
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

/** What the header says about the body's relationship to disk. `idle` is the
 * quiet default — nothing typed yet, so there is nothing to reassure about. */
const SAVE_LABEL: Record<SaveState, string | null> = {
  idle: null,
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  failed: "Couldn't save",
};

/**
 * Full-page markdown document (M2 Task 10; M2.x docs polish). The title is
 * the doc's H1, edited inside the editor — each save rescans, so the header
 * and every other surface pick the new title up from the scanner.
 */
export function DocPage({ selection }: { selection: DocSelection }) {
  const entry = useEntry(selection.path);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const createItem = useVaultStore((s) => s.createItem);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const navigate = useNavStore((s) => s.navigate);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const docPanelOpen = useUiStore((s) => s.docPanelOpen);
  const setDocPanelOpen = useUiStore((s) => s.setDocPanelOpen);
  const conceptPanelOpen = useUiStore((s) => s.conceptPanelOpen);
  const setConceptPanelOpen = useUiStore((s) => s.setConceptPanelOpen);
  const setDocPanelTab = useUiStore((s) => s.setDocPanelTab);
  const setConceptPanelTab = useUiStore((s) => s.setConceptPanelTab);
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
  // M52: the page body's width decides how its panels are drawn (shellLayout
  // `pageAsides`), and the column's decides how wide the editor's gutter is.
  // The fold is decided before paint, or a fast resize draws the side panel
  // past the canvas for a frame.
  const [bodyRef, bodyWidth] = useMeasuredWidth({ beforePaint: true });
  const [columnRef, columnWidth] = useMeasuredWidth();
  // A folded panel opens on request as a drawer over the column. Session
  // state, like the fold it opens over, and held as the PATH it was opened on
  // so it never follows you to the next page.
  const [pagesDrawerFor, setPagesDrawerFor] = useState<string | null>(null);
  const [sideDrawerFor, setSideDrawerFor] = useState<string | null>(null);

  // The outline and the comments need the live editor and the scroll
  // container (Task 15). The editor is held with the mount it came from, set
  // by onReady below; `editor` is derived further down, once the page knows
  // whether that mount is still on screen.
  const [mounted, setMounted] = useState<{
    path: string;
    gen: number;
    editor: CerebroEditor;
  } | null>(null);
  // Debounce controls, so out-of-editor writes can stop a stale in-editor
  // body from being flushed back over them.
  const editorControls = useRef<EditorReadyInfo | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // M9.7: reading a diff swaps the editor out for it, in place.
  const diffOpen = useUiStore((s) => s.diffView?.path === selection.path);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Bumped to force a reload after out-of-editor writes (template apply).
  const [reloadGen, setReloadGen] = useState(0);

  // M38.2 — a record is a page too. Same canvas, plus the property surface
  // the panel shows, minus nothing.
  // A concept is never a record page, whatever its `type:` names (M50.1):
  // its frontmatter is provenance, which the review bar and the Details tab
  // read, not a property stack to edit.
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

  // Whether the canvas is rendering the body editor at all. The reset below
  // tracks the editor's MOUNT, not the tab's identity: two Overview tabs share
  // one mounted editor (one key), so switching between them re-fires no
  // onReady — nulling on the id would strand the outline on its placeholder.
  const showsEditor = agent
    ? agentTab === 'instructions'
    : activeTab === null || activeTab.content === 'overview';

  // The editor is the one on screen, or none. The keyed editor remounts per
  // doc and per reload, a sections or view tab unmounts it, and a diff stands
  // in for it (and destroys it); in each case the held instance is dead, so
  // this render already sees null and the slot is cleared before the next
  // (the React-sanctioned render-time reset) until the new mount's onReady.
  // An effect would hand the dead editor on for one more render, and a
  // comment deep link handled in it would reveal on a detached view and take
  // the app down (M70.2b review).
  const mountLive =
    mounted !== null &&
    mounted.path === selection.path &&
    mounted.gen === reloadGen &&
    showsEditor &&
    !diffOpen;
  if (mounted !== null && !mountLive) setMounted(null);
  const editor = mountLive ? mounted.editor : null;

  // Blank-page detection drives the floating template bar. Title detection
  // drives the heading below: a doc whose body has no H1 has its title only in
  // the breadcrumb, so the document itself is untitled (M15).
  const [blank, setBlank] = useState(false);
  const [titled, setTitled] = useState(true);
  useEffect(() => {
    if (editor === null) {
      setBlank(false);
      setTitled(true);
      return;
    }
    const sync = () => {
      setBlank(isBlankBody(editor));
      setTitled(hasTitleBlock(editor));
    };
    sync();
    const unsubscribe = editor.onChange?.(sync);
    return () => unsubscribe?.();
  }, [editor]);

  // M45.1 — whether the record's full property stack is open under the
  // heading strip. Sticky per record PATH (a new record resets it), and the
  // untouched default is derived per render below rather than stored: it must
  // track whether the strip actually SHOWS, which can change without the path
  // changing (clearing the strip's last hide_when_empty field folds it away).
  const [details, setDetails] = useState<{ path: string; shown: boolean } | null>(null);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState(false);
  // The page the Add sub-page dialog adds to (M55.13): this page from its
  // menu, the listed page from the Pages panel.
  const [subPageOf, setSubPageOf] = useState<Entry | null>(null);
  const [pageName, setPageName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuButtonRef = useRef<HTMLDivElement | null>(null);

  // M70.2b — the page's comments, on every .md page this opens: docs,
  // records, agents and concepts alike (CV-08; Q5). A hook, so before the
  // early return; the panel it opens is laid out below it, so it reaches
  // `openSide` through a ref set each render. No editor while a diff stands
  // in for it (`editor` is already null then): its highlights are not on
  // screen to draw or focus.
  const openSideRef = useRef<(tab: 'comments') => void>(() => undefined);
  const comments = usePageComments(
    entry !== null && isCommentPage(entry.path) ? entry.path : null,
    editor,
    { openPanel: () => openSideRef.current('comments'), deepLink: selection.thread ?? null },
  );

  if (entry === null) {
    return (
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
    );
  }

  const docPages = docPagesFor(entry, entries);
  const asides = pageAsides({
    row: bodyWidth,
    pages: docPages !== null && pagesOpen,
    side: panelOpen,
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
  // The toggle speaks for what is on screen. Hiding writes the stored flag —
  // that is the user's word; a fold never does. Showing a panel with no room
  // beside the column opens it as a drawer rather than into a fold nobody
  // can see.
  const showSide = () => {
    if (!panelOpen) setPanelOpen(true);
    if (!asides.sideFits) setSideDrawerFor(entry.path);
  };
  const toggleSide = () => {
    if (sideDrawn) {
      setPanelOpen(false);
      setSideDrawerFor(null);
      return;
    }
    showSide();
  };
  // Open the panel on `tab`, as a drawer when it does not fit (M70.2b).
  openSideRef.current = (tab) => {
    if (concept !== null) setConceptPanelTab(tab);
    else setDocPanelTab(tab);
    if (!sideDrawn) showSide();
  };
  const fullWidth = entry.properties.full_width === true;
  // Everything under knowledge/ is written through the ledger. A concept is
  // edited as a concept; the rest of the folder (the derived log, cached
  // sources) is the system's to write and opens read-only.
  const knowledgeFile = isKnowledgePath(entry.path);
  const readOnlyFile = knowledgeFile && concept === null;

  // M45.1 (spec §3.4) — the type's `layout.heading` renders as the key
  // property strip on EVERY tab of the record page. `stripShows` is derived
  // per render with the strip's own fold predicate (amended Task 7 ruling):
  // the strip renders null when every cell folds, and the stack must never
  // stay hidden behind a strip that is not on screen — so the stack renders
  // whenever `!stripShows || detailsShown`, and the untouched default for
  // `detailsShown` is `!stripShows` (per path) rather than a stored false.
  const typeDef = record && entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  // M46.1 — one resolution for the whole record, rendered above the tab strip
  // on every tab. No tab narrows it, so this page, the peek and the
  // customizer's canvas cannot disagree about what a record shows — and the
  // canvas, which is a PREVIEW of this page, has nothing left to preview
  // wrongly.
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

  // Breadcrumb (M55.13): the way up the page tree. Each ancestor folder is the
  // page it is when it has a folder note, and a plain label otherwise; a
  // concept's crumbs are its Knowledge sections, and an agent's place is the
  // Agents surface, not the folder its file sits in.
  const trail: (Crumb | { kind: 'folder'; label: string; section: string })[] = agent
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

  /**
   * Give an untitled doc a real title (M15).
   *
   * The scanner derives a title from the filename when the body has no H1, so
   * the app knew the title all along and the document was the one place it did
   * not appear. Committing the heading writes it as an actual H1 — through the
   * same path as Rename, so from then on this doc is an ordinary titled doc
   * and the heading below unmounts because the editor now shows the real one.
   */
  const adoptTitle = async (next: string) => {
    const trimmed = next.trim();
    if (vaultPath === null || trimmed === '' || busy) return;
    if (trimmed === entry.title && editor !== null && hasTitleBlock(editor)) return;
    setBusy(true);
    try {
      await setNoteTitle(vaultPath, entry.path, trimmed);
      if (editor !== null) spliceTitleIntoBlocks(editor, trimmed);
      await rescan();
    } catch {
      toast("Couldn't set the title");
    } finally {
      setBusy(false);
    }
  };

  // Rename the doc the way the user means it: the visible title (its H1),
  // not the slug on disk. The live editor is spliced too, or its next
  // autosave would write the old title straight back.
  const submitRename = async () => {
    const trimmed = renaming?.trim() ?? '';
    if (vaultPath === null || trimmed === '' || busy) return;
    setBusy(true);
    try {
      await setNoteTitle(vaultPath, entry.path, trimmed);
      if (editor !== null) spliceTitleIntoBlocks(editor, trimmed);
      await rescan();
      setRenaming(null);
    } catch {
      toast("Couldn't rename page");
    } finally {
      setBusy(false);
    }
  };

  const templates = listTemplates(entries);

  // Fill this (blank) page from a template: body below the H1 + frontmatter,
  // then force the editor to reload from disk.
  const applyTemplate = async (template: Entry) => {
    if (vaultPath === null || busy) return;
    // Drop any pending debounce FIRST. Otherwise the reload below remounts
    // the editor, its unmount flush serializes the pre-template body, and the
    // template the user just picked is overwritten half a second later
    // ("I clicked the template and nothing happened").
    editorControls.current?.cancelPendingSave();
    setBusy(true);
    try {
      const vars = { title: entry.title, date: todayIso() };
      const body = applyTemplateBody(await readNote(vaultPath, template.path), vars);
      await saveNote(vaultPath, entry.path, body);
      const frontmatter = applyTemplateFrontmatter(template, vars);
      if (Object.keys(frontmatter).length > 0) {
        await patchFrontmatter(entry.path, frontmatter);
      }
      await rescan();
      // Cancel again: the awaits above gave the editor time to reschedule.
      editorControls.current?.cancelPendingSave();
      editorControls.current = null;
      setMounted(null);
      setSaveState('idle');
      setReloadGen((g) => g + 1);
    } catch {
      toast("Couldn't apply template");
    } finally {
      setBusy(false);
    }
  };

  // Turn this page into a reusable template: copy into templates/ with the
  // H1 swapped for the {{title}} placeholder.
  const saveAsTemplate = async () => {
    if (vaultPath === null || busy) return;
    setBusy(true);
    try {
      const body = await readNote(vaultPath, entry.path);
      const lines = body.split('\n');
      const h1 = lines.findIndex((l) => l.trim().startsWith('# '));
      if (h1 >= 0) lines[h1] = '# {{title}}';
      const frontmatter: Record<string, unknown> = {};
      if (entry.type !== null) frontmatter.type = entry.type;
      for (const [key, value] of Object.entries(entry.properties)) {
        if (key !== 'full_width') frontmatter[key] = value;
      }
      for (const [key, targets] of Object.entries(entry.relationships)) {
        frontmatter[key] = targets.map((t) => `[[${t}]]`);
      }
      await createFolder(vaultPath, TEMPLATES_DIR);
      await createItem({
        folder: TEMPLATES_DIR,
        slug: slugify(entry.title) || 'template',
        frontmatter,
        body: lines.join('\n'),
      });
      toast(`Saved as template — find it under ${TEMPLATES_DIR}/`);
    } catch {
      toast("Couldn't save template");
    } finally {
      setBusy(false);
    }
  };

  // M45.2 — records only: an untyped page has no type whose layout could be
  // customized. A const, so the guard's narrowing survives into the closure.
  const layoutType = record && entry.type !== null ? entry.type : null;

  // Under knowledge/ the file actions refuse (the folder is written through
  // the ledger), so they are not offered; what is left is the concept's own.
  // Its ask is the review bar's, chosen the same way (M52.3) — and, like the
  // bar, a replaced concept offers none.
  const knowledgeMenu: ContextMenuItem[] = [
    ...(concept !== null && concept.supersededBy === null
      ? [conceptAsk({ path: concept.entry.path, title: concept.title, stale: concept.stale })].map(
          (act) => ({
            icon: 'sparkles',
            label: act.label,
            onSelect: () =>
              askAgent(act.text, concept.entry.path, askedAbout(act.label, concept.title)),
          }),
        )
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

  // `glyph` is a page's own icon (M55.11), drawn in place of the lucide one.
  const crumb = (
    label: string,
    opts: { icon?: string; glyph?: ReactNode; onClick?: () => void; strong?: boolean },
  ) =>
    opts.onClick !== undefined ? (
      <button
        type="button"
        onClick={opts.onClick}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-sm text-n-500 hover:bg-n-50 hover:text-n-800"
      >
        {opts.glyph ?? (opts.icon !== undefined && <Icon name={opts.icon} size={13} />)}
        <span className="truncate">{label}</span>
      </button>
    ) : (
      <span
        className={[
          'inline-flex min-w-0 items-center gap-1.5 px-1 text-sm',
          opts.strong === true ? 'font-medium text-n-900' : 'text-n-500',
        ].join(' ')}
      >
        {opts.glyph ??
          (opts.icon !== undefined && <Icon name={opts.icon} size={13} color="var(--n-500)" />)}
        <span className="truncate">{label}</span>
      </span>
    );
  // A crumb draws the page's own icon only when it has one; otherwise the
  // lucide icon the crumb always drew.
  const pageGlyph = (page: Entry): ReactNode =>
    pageIconOf(page) === null ? undefined : (
      <EntryIcon entry={page} fallback={{ name: 'file-text' }} size={13} />
    );

  const separator = <Icon name="chevron-right" size={12} color="var(--n-300)" />;

  // The body editor: ONE block, shared by the untyped page and a record's
  // Overview tab so an edit to one cannot silently miss the other. The page's
  // history lives in the side panel's History tab (M58.4, D18), not here.
  //
  // M70.2b: the selection toolbar's Comment button reads PageCommentsContext,
  // provided here and nowhere else, and not on a read-only page.
  const editorBlock = (
    <PageCommentsContext.Provider
      value={readOnlyFile || comments.path === null ? null : { start: comments.start }}
    >
      <NoteBodyEditor
        key={`${entry.path}#${reloadGen}`}
        path={entry.path}
        onSaveState={setSaveState}
        onReady={(info) => {
          editorControls.current = info;
          setMounted({ path: entry.path, gen: reloadGen, editor: info.editor });
        }}
        readOnly={readOnlyFile}
        sections={concept !== null}
        onBodyLoaded={concept !== null ? (path, body) => setViewed({ path, body }) : undefined}
      />
    </PageCommentsContext.Provider>
  );

  return (
    <div className="cb-document flex min-h-0 min-w-0 flex-1 flex-col" data-testid="doc-page">
      <div className="cb-document-toolbar flex flex-none items-center gap-0.5 px-3">
        {knowledgeFile
          ? crumb('Knowledge', {
              icon: 'brain',
              onClick: () => navigate({ kind: 'knowledge' }),
            })
          : agent
            ? crumb('Agents', { icon: 'bot', onClick: () => navigate({ kind: 'agents' }) })
            : record
              ? recordFolder !== null
                ? crumb(humanizeSlug(recordFolder.split('/').pop() ?? recordFolder), {
                    icon: 'folder',
                    onClick: () => navigate({ kind: 'collection', folder: recordFolder }),
                  })
                : crumb(entry.type ?? 'Records', {
                    icon: 'database',
                    onClick:
                      entry.type === null
                        ? undefined
                        : () => navigate({ kind: 'type', name: entry.type as string }),
                  })
              : // M38.3: no Docs surface to root at — a doc's crumb is its
                // folder path, and the Pages tree in the nav is the way up.
                crumb('Pages', { icon: 'library' })}
        {trail.map((step, i) => (
          <span key={i} className="flex min-w-0 items-center gap-0.5">
            {separator}
            {step.kind === 'page'
              ? // An ancestor page (M55.13): a crumb that opens it, wearing its
                // icon (M55.11). A Collection page opens as its collection.
                crumb(step.entry.title, {
                  glyph: (
                    <EntryIcon entry={step.entry} fallback={{ name: 'file-text' }} size={13} />
                  ),
                  onClick: () =>
                    navigate(
                      isCollectionPage(step.entry)
                        ? { kind: 'collection', folder: step.entry.folder }
                        : { kind: 'doc', path: step.entry.path },
                    ),
                })
              : crumb(
                  step.label,
                  // A concept's folder is a Knowledge section, and a place.
                  'section' in step && i === 0
                    ? {
                        onClick: () =>
                          navigate({
                            kind: 'knowledge',
                            nav: { tab: 'section', folder: step.section },
                          }),
                      }
                    : {},
                )}
          </span>
        ))}
        <span className="flex min-w-0 items-center gap-0.5" data-testid="doc-title">
          {separator}
          {crumb(entry.title, {
            glyph: pageGlyph(entry),
            icon: concept !== null ? 'lightbulb' : agent ? 'bot' : 'file-text',
            strong: true,
          })}
        </span>
        <span className="flex-1" />
        {/* Autosave used to be entirely invisible: no dirty marker, no saved
            state, and ⌘S did nothing. This is the trust signal — ⌘S now
            force-flushes the debounce (handled in NoteBodyEditor). */}
        {SAVE_LABEL[saveState] !== null && (
          <span
            data-testid="doc-save-state"
            title={
              saveState === 'failed'
                ? undefined
                : `Saves automatically — ${keycapText('page.save')} to save now`
            }
            className={[
              'mr-1 flex-none whitespace-nowrap text-xs',
              saveState === 'failed' ? 'font-medium text-danger-600' : 'text-[var(--text-meta)]',
            ].join(' ')}
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
        {/* M51.2 — the review queue, walkable from the page it sends you to. */}
        {/* One line: squeezed beside the assistant it wrapped to "Review 1 of"
            over "3" and doubled the header's height (M52). */}
        {concept !== null && (
          <span className="flex flex-none whitespace-nowrap">
            <ReviewPager path={entry.path} />
          </span>
        )}
        <FavoriteStar path={entry.path} />
        {/* M55.9 — copy as a prompt or a path, reveal, open elsewhere, or
            hand the page to an agent app. */}
        <OpenWithMenu entry={entry} knowledgeFile={knowledgeFile} />
        {/* The toolbar is the star, Open with, the overflow menu and the
            panel toggle. 'Add sub-page' and 'Move to folder' are BOTH in the
            overflow menu — a labelled toolbar button for either duplicated
            the action users need least. */}
        <div ref={menuButtonRef} className="inline-flex">
          <IconButton
            icon="ellipsis"
            label="Page options"
            size="sm"
            onClick={() => {
              const rect = menuButtonRef.current?.getBoundingClientRect();
              setMenu(
                rect === undefined ? { x: 0, y: 0 } : { x: rect.right - 180, y: rect.bottom + 4 },
              );
            }}
          />
        </div>
        <IconButton
          icon={sideDrawn ? 'panel-right-close' : 'panel-right'}
          label={sideDrawn ? 'Hide panel' : 'Show panel'}
          size="sm"
          // Not while its drawer is open (M52): the pointer that opened it is
          // still resting here, and the tooltip came up over the drawer and
          // took the first Escape, so closing it took two.
          tooltip={!sideDrawer}
          onClick={toggleSide}
        />
      </div>
      {/* `relative` hosts a folded panel's drawer (M52). */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
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
          className={[
            'relative flex min-h-0 flex-1 flex-col',
            columnWidth !== null && columnWidth < DOC_NARROW_COLUMN ? 'cb-doc-narrow' : '',
          ].join(' ')}
          style={{ minWidth: DOC_COLUMN_MIN_WIDTH }}
        >
          {docPages !== null && !pagesDrawn && (
            <DocPagesFloatingButton
              onOpen={pagesOpen ? () => setPagesDrawerFor(entry.path) : undefined}
            />
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-10">
            {/* M55.11 — the cover, full-bleed above the column; the top
                padding sits below it. */}
            <PageCoverBand entry={entry} editable={!knowledgeFile} />
            <div
              data-testid="doc-content"
              className={
                fullWidth
                  ? 'cb-document-content px-6'
                  : 'cb-document-content mx-auto w-full max-w-[900px] px-6'
              }
            >
              {/* M55.11 — the page's icon above its title, and the hover row
                  that adds one; outside the diff lens, so both show there. */}
              <PageIconHeader entry={entry} editable={!knowledgeFile} />
              {/* M9.7: reading a diff replaces the editor here rather than
                  opening over it — same page, different lens. */}
              {diffOpen ? (
                <InlineDiff path={entry.path} />
              ) : (
                <>
                  {/* Only when the body has no H1 of its own. A doc whose body
                      starts with one already shows its title as the first line
                      of the editor — rendering a second heading above it would
                      show the same string twice, which is the bug this fixes,
                      not a second copy of it. */}
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
                        viewedBody={
                          viewed !== null && viewed.path === entry.path ? viewed.body : null
                        }
                        verifyBlocked={
                          saveState === 'dirty' || saveState === 'saving'
                            ? 'Saving your edit — Verify when it lands.'
                            : saveState === 'failed'
                              ? "Your last edit didn't save — Verify would attest the older text."
                              : null
                        }
                      />
                    </>
                  ) : (
                    !titled &&
                    !knowledgeFile && (
                      <UntitledDocHeading
                        title={entry.title}
                        onCommit={(next) => void adoptTitle(next)}
                      />
                    )
                  )}
                  {/* M45.1 — the key-property strip, on every tab. M46.1: so
                      is its expander, because the stack it opens is the same
                      stack on every tab — gating the toggle by tab kind would
                      strand the record's sections behind a strip that has no
                      way to open. */}
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
                  {!knowledgeFile && <PullRequestStrip entry={entry} schema={schema} />}
                  {/* M44.5 — the record canvas swaps by the open tab: the
                      body, the tab's free text, or its database. An untyped
                      doc knows nothing of tabs and keeps its document form. */}
                  {agent ? (
                    <AgentPageBody
                      entry={entry}
                      tab={agentTab}
                      onTab={(tab) => navigate({ kind: 'doc', path: entry.path, tab })}
                      editor={editorBlock}
                    />
                  ) : record && activeTab !== null ? (
                    <>
                      {/* M38.2 — the property surface the peek shows, on the
                          page. The SAME component: one property editor, two
                          geometries, so a field added here is a field added
                          there. M45.6 widened that from the surface to the
                          whole anatomy — the peek grew this strip and these
                          arms too, so the geometry is the only thing that
                          differs now; the gate below has a twin in
                          `DetailPanel`, and a change to one is a change owed
                          to the other.

                          M46.1 — the stack stands here, ABOVE the tab strip,
                          on every tab: a section belongs to the record, and
                          the tabs are for the body and for related data
                          sources (the user's ruling, 2026-08-29). The strip's
                          own fold is all that is left of the old gate.

                          Keyed by PATH alone, not by tab: the state this
                          component owns — the reveal expander, the
                          add-property flyout, a drag in flight — is about the
                          record's stack, and it is the same stack on every
                          tab. A tab-keyed remount would discard a flyout the
                          user opened and a reveal they asked for on every
                          press, and discard no stale state, because there is
                          none. */}
                      {(!stripShows || detailsShown) && (
                        <div data-testid="page-properties" className="mb-4">
                          <RecordProperties
                            key={`props:${entry.path}`}
                            entry={entry}
                            schema={schema}
                          />
                        </div>
                      )}
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
                          `-mx-6` lets the underline reach both edges of the
                          820px measure while the tabs keep its inset. M45.2
                          gates it on SAVED tabs: the synthesized Overview
                          renders content, never a one-tab strip. */}
                      {savedTabs.length > 0 && (
                        <div className="-mx-6 mb-4">
                          <RecordTabs
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
                      {activeTab.content === 'overview' && editorBlock}
                      {activeTab.content === 'agents' && (
                        <PageAgentsTab entry={entry} entries={entries} schema={schema} />
                      )}
                      {activeTab.content === 'runs' && (
                        <PageRunsTab entry={entry} entries={entries} schema={schema} />
                      )}
                      {activeTab.content === 'sections' && (
                        <TabSections
                          key={`${entry.path}#${activeTab.id}`}
                          entry={entry}
                          tabId={activeTab.id}
                        />
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
                      {editorBlock}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          {/* Never on an agent page: a template's frontmatter could retype
              the record it lands on (M55.12). */}
          {blank && !busy && !knowledgeFile && !agent && (
            <BlankPageBar templates={templates} onPick={(t) => void applyTemplate(t)} />
          )}
        </div>
        {sideDrawn && (
          <DocSidePanel
            overlay={sideDrawer}
            entry={entry}
            schema={schema}
            editor={editor}
            scrollRef={scrollRef}
            concept={concept}
            comments={comments}
          />
        )}
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
