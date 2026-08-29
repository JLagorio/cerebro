import { useEffect, useRef, useState } from 'react';
import { MoveDialog } from '@/components/MoveDialog';
import { Button } from '@/components/ui/Button';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { FavoriteStar } from '@/app/FavoriteStar';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { DocPagesFloatingButton, DocPagesPanel } from '@/detail/DocPagesPanel';
import { DocSidePanel } from '@/detail/DocSidePanel';
import type { CerebroEditor, EditorReadyInfo } from '@/editor/MarkdownEditor';
import { hasTitleBlock, spliceTitleIntoBlocks } from '@/editor/markdown';
import { NoteBodyEditor, type SaveState } from '@/editor/NoteBodyEditor';
import { GitHistoryPanel } from '@/git/GitHistoryPanel';
import { InlineDiff } from '@/git/InlineDiff';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { RecordProperties } from '@/detail/RecordProperties';
import { RecordTabs } from '@/detail/RecordTabs';
import { TabSections } from '@/detail/TabSections';
import { setTypeTabs } from '@/app/typeActions';
import { docFolderPathFor, docPagesFor } from '@/engine/docPages';
import { resolveLayout } from '@/engine/layout';
import { isRecordEntry, typeTabs } from '@/engine/typeCatalog';
import { resolveViewTab } from '@/engine/viewTab';
import type { Entry, Selection } from '@/engine/types';
import { ViewTabEmbed } from '@/views/ViewTabEmbed';
import { createFolder, deleteNote, readNote, renameNote, saveNote, setNoteTitle } from '@/lib/ipc';
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
import { useUiStore } from '@/stores/uiStore';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';

export type DocSelection = Extract<Selection, { kind: 'doc' }>;

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
 * A textarea, not an input: at 42px in an 820px column real titles wrap, and
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
    el.style.height = 'auto';
    // scrollHeight excludes the border, but the box is border-box, so setting
    // height to scrollHeight alone clips the last two pixels of a descender.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
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
      className="mb-1 ml-[45px] block w-[calc(100%-45px)] resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-0 text-4xl font-bold leading-[63px] text-n-900 outline-none hover:border-n-200 focus-visible:border-cortex-500 focus-visible:shadow-[var(--ring)]"
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
  const replacePath = useNavStore((s) => s.replacePath);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const panelOpen = useUiStore((s) => s.docPanelOpen);
  const setPanelOpen = useUiStore((s) => s.setDocPanelOpen);
  const pagesOpen = useUiStore((s) => s.docPagesOpen);
  const openLayoutEditor = useUiStore((s) => s.openLayoutEditor);

  // The outline needs the live editor and the scroll container (Task 15).
  const [editor, setEditor] = useState<CerebroEditor | null>(null);
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
  const record = entry !== null && isRecordEntry(entry);
  // M44.5 — the record page's tabs come from its TYPE (`typeTabs` synthesizes
  // Overview when none are saved) and the open one rides the selection, so
  // "the Spec tab of DOC-14" is a place the back button returns to. A stale
  // `selection.tab` — a tab deleted while history still names it — falls back
  // to the first tab rather than rendering nothing.
  const tabs = record && entry !== null && entry.type !== null ? typeTabs(entry.type, schema) : [];
  // M45.2 (spec §3.5): Simple means NO strip — the strip mounts only on SAVED
  // tabs, while the content swap keeps consuming `typeTabs` so the synthesized
  // Overview still drives the canvas.
  const savedTabs =
    record && entry !== null && entry.type !== null
      ? (schema.types.get(entry.type)?.tabs ?? [])
      : [];
  const activeTab = tabs.find((t) => t.id === selection.tab) ?? tabs[0] ?? null;

  // Whether the canvas is rendering the body editor at all. The reset below
  // tracks the editor's MOUNT, not the tab's identity: two Overview tabs share
  // one mounted editor (one key), so switching between them re-fires no
  // onReady — nulling on the id would strand the outline on its placeholder.
  const showsEditor = activeTab === null || activeTab.content === 'overview';

  useEffect(() => {
    // The keyed editor remounts per doc; wait for onReady. `showsEditor` is a
    // dependency because a sections/properties tab unmounts the editor
    // entirely — holding the stale instance would keep feeding the outline
    // (and the blank-page bar) a body the canvas no longer shows.
    setEditor(null);
  }, [selection.path, reloadGen, showsEditor]);

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

  // M45.1 — whether the Overview tab's full property stack is open under the
  // heading strip. Sticky per record PATH (a new record resets it), and the
  // untouched default is derived per render below rather than stored: it must
  // track whether the strip actually SHOWS, which can change without the path
  // changing (clearing the strip's last hide_when_empty field folds it away).
  const [details, setDetails] = useState<{ path: string; shown: boolean } | null>(null);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [addingPage, setAddingPage] = useState(false);
  const [pageName, setPageName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuButtonRef = useRef<HTMLDivElement | null>(null);

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
  const fullWidth = entry.properties.full_width === true;

  // M45.1 (spec §3.4) — the type's `layout.heading` renders as the key
  // property strip on EVERY tab of the record page. `stripShows` is derived
  // per render with the strip's own fold predicate (amended Task 7 ruling):
  // the strip renders null when every cell folds, and the stack must never
  // stay hidden behind a strip that is not on screen — so the stack renders
  // whenever `!stripShows || detailsShown`, and the untouched default for
  // `detailsShown` is `!stripShows` (per path) rather than a stored false.
  const typeDef = record && entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
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

  // Breadcrumb: Docs root, then folders; a multi-page doc's folder segment
  // becomes the doc crumb (its pages are tabs, not tree entries).
  const folderSegments = entry.folder === '' ? [] : entry.folder.split('/');
  const crumbFolders = docPages !== null ? folderSegments.slice(0, -1) : folderSegments;

  // A record's crumb root is its backdrop — the Collection it lives in when
  // it has one, its type screen otherwise: the same rule useOpenPath applies
  // when it picks a canvas to put behind the peek (M38.2).
  const recordFolder =
    entry.project !== null && entry.project.includes('/')
      ? entry.project.slice(0, entry.project.lastIndexOf('/'))
      : null;

  const moveSubject: { path: string; label: string } =
    docPages !== null
      ? { path: docPages.folder, label: `doc "${docPages.main.title}"` }
      : { path: entry.path, label: `page "${entry.title}"` };

  const submitAddPage = async () => {
    const trimmed = pageName.trim();
    if (trimmed === '' || vaultPath === null || busy) return;
    setBusy(true);
    try {
      let folder: string;
      if (docPages !== null) {
        folder = docPages.folder;
      } else {
        // First extra page: grow the file into a doc folder (folder-note).
        folder = docFolderPathFor(entry);
        await createFolder(vaultPath, folder);
        const moved = `${folder}/${entry.filename}`;
        await renameNote(vaultPath, entry.path, moved);
        // The page you were just reading now lives inside the new folder, and
        // its old path is still sitting in history — Back would land on the
        // "This page no longer exists" empty state for a file nobody deleted.
        replacePath(entry.path, moved);
      }
      const slug = slugify(trimmed) || 'page';
      const path = await createItem({
        folder,
        slug,
        frontmatter: {},
        body: `# ${trimmed}\n`,
      });
      setAddingPage(false);
      setPageName('');
      navigate({ kind: 'doc', path });
    } catch {
      toast("Couldn't add page");
    } finally {
      setBusy(false);
    }
  };

  // Trash operates on the same subject as Move: trashing a doc's MAIN page
  // used to delete only that file, which removed the folder note and
  // dissolved the doc — its other pages stranded in a plain folder with no
  // header, no Pages panel, and no dialog copy warning about any of it.
  const isDocMain = docPages !== null && entry.path === docPages.main.path;
  const deleteSubject: { path: string; title: string; extraPages: number } = isDocMain
    ? {
        path: docPages.folder,
        title: docPages.main.title,
        extraPages: docPages.pages.length - 1,
      }
    : { path: entry.path, title: entry.title, extraPages: 0 };

  const submitDelete = async () => {
    if (vaultPath === null || busy) return;
    setBusy(true);
    try {
      await deleteNote(vaultPath, deleteSubject.path);
      await rescan();
      setConfirmDelete(false);
      // Home, since M38.3: the page's surface of origin (Docs) is gone, and
      // after a delete there is no page to stand on.
      navigate({ kind: 'home' });
    } catch {
      toast("Couldn't move to Trash");
    } finally {
      setBusy(false);
    }
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
      setEditor(null);
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

  const menuItems: ContextMenuItem[] = [
    {
      icon: fullWidth ? 'minimize-2' : 'maximize-2',
      label: fullWidth ? 'Center content' : 'Full width',
      onSelect: () => void patchFrontmatter(entry.path, { full_width: fullWidth ? null : true }),
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
    { icon: 'file-plus', label: 'Add page', onSelect: () => setAddingPage(true) },
    {
      icon: 'layout-template',
      label: 'Save as template',
      onSelect: () => void saveAsTemplate(),
    },
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

  const crumb = (label: string, opts: { icon?: string; onClick?: () => void; strong?: boolean }) =>
    opts.onClick !== undefined ? (
      <button
        type="button"
        onClick={opts.onClick}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-sm text-n-500 hover:bg-n-50 hover:text-n-800"
      >
        {opts.icon !== undefined && <Icon name={opts.icon} size={13} />}
        <span className="truncate">{label}</span>
      </button>
    ) : (
      <span
        className={[
          'inline-flex min-w-0 items-center gap-1.5 px-1 text-sm',
          opts.strong === true ? 'font-medium text-n-900' : 'text-n-500',
        ].join(' ')}
      >
        {opts.icon !== undefined && <Icon name={opts.icon} size={13} color="var(--n-500)" />}
        <span className="truncate">{label}</span>
      </span>
    );

  const separator = <Icon name="chevron-right" size={12} color="var(--n-300)" />;

  // The body editor + this document's history (M9.4 — silent when it has
  // none): ONE block, shared by the untyped page and a record's Overview tab
  // so an edit to one cannot silently miss the other.
  const editorBlock = (
    <>
      <NoteBodyEditor
        key={`${entry.path}#${reloadGen}`}
        path={entry.path}
        onSaveState={setSaveState}
        onReady={(info) => {
          editorControls.current = info;
          setEditor(info.editor);
        }}
      />
      <GitHistoryPanel path={entry.path} />
    </>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="doc-page">
      <div className="flex h-11 flex-none items-center gap-0.5 border-b border-n-200 px-3">
        {record
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
        {crumbFolders.map((seg, i) => (
          <span key={i} className="flex min-w-0 items-center gap-0.5">
            {separator}
            {crumb(humanizeSlug(seg), {})}
          </span>
        ))}
        {docPages !== null && (
          <span className="flex min-w-0 items-center gap-0.5">
            {separator}
            {crumb(docPages.main.title, {
              icon: 'file-stack',
              onClick:
                entry.path === docPages.main.path
                  ? undefined
                  : () => navigate({ kind: 'doc', path: docPages.main.path }),
              strong: entry.path === docPages.main.path,
            })}
          </span>
        )}
        {(docPages === null || entry.path !== docPages.main.path) && (
          <span className="flex min-w-0 items-center gap-0.5" data-testid="doc-title">
            {separator}
            {crumb(entry.title, {
              icon: docPages === null ? 'file-text' : undefined,
              strong: true,
            })}
          </span>
        )}
        <span className="flex-1" />
        {/* Autosave used to be entirely invisible: no dirty marker, no saved
            state, and ⌘S did nothing. This is the trust signal — ⌘S now
            force-flushes the debounce (handled in NoteBodyEditor). */}
        {SAVE_LABEL[saveState] !== null && (
          <span
            data-testid="doc-save-state"
            title={saveState === 'failed' ? undefined : 'Saves automatically — ⌘S to save now'}
            className={[
              'mr-1 flex-none whitespace-nowrap text-xs',
              saveState === 'failed' ? 'font-medium text-danger-600' : 'text-[var(--text-meta)]',
            ].join(' ')}
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
        <FavoriteStar path={entry.path} />
        {/* 'Add page' and 'Move to folder' are BOTH in the overflow menu
            below — the toolbar's only labelled control was a duplicate of the
            action users need least. The toolbar is now menu + panel toggle. */}
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
          icon={panelOpen ? 'panel-right-close' : 'panel-right'}
          label={panelOpen ? 'Hide panel' : 'Show panel'}
          size="sm"
          onClick={() => setPanelOpen(!panelOpen)}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        {docPages !== null && pagesOpen && (
          <DocPagesPanel
            pages={docPages}
            activePath={entry.path}
            onAddPage={() => setAddingPage(true)}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {docPages !== null && !pagesOpen && <DocPagesFloatingButton />}
          {/* M44.5 — the tab strip is a flex-none sibling ABOVE the scroll
              container: it survives the diffOpen canvas swap and stays out of
              the 820px content measure. M45.2 gates it on SAVED tabs: the
              synthesized Overview renders content, never a one-tab strip. */}
          {savedTabs.length > 0 && (
            <RecordTabs
              tabs={tabs}
              activeId={activeTab?.id ?? tabs[0].id}
              hostType={entry.type}
              onSelect={(tab) => navigate({ kind: 'doc', path: entry.path, tab })}
              onChange={(next) => {
                if (entry.type !== null)
                  void setTypeTabs({ name: entry.type, docPath: null }, next);
              }}
            />
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-10 pt-6">
            <div
              data-testid="doc-content"
              className={fullWidth ? 'px-6' : 'mx-auto w-full max-w-[820px] px-6'}
            >
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
                  {!titled && (
                    <UntitledDocHeading
                      title={entry.title}
                      onCommit={(next) => void adoptTitle(next)}
                    />
                  )}
                  {/* M45.1 — the key-property strip, on every tab. Only the
                      Overview tab gets the expander: Properties always shows
                      the stack, and Sections shows no stack at all — a toggle
                      there would expand nothing. */}
                  {headingFields.length > 0 && (
                    <HeadingProperties
                      key={`strip:${entry.path}`}
                      entry={entry}
                      schema={schema}
                      fields={headingFields}
                      detailsShown={detailsShown}
                      onToggleDetails={
                        activeTab !== null && activeTab.content === 'overview'
                          ? () => setDetails({ path: entry.path, shown: !detailsShown })
                          : undefined
                      }
                    />
                  )}
                  {/* M44.5 — the record canvas swaps by the open tab: Overview
                      is today's layout verbatim, Properties is the surface
                      alone, Sections is the tab's free text. An untyped doc
                      knows nothing of tabs and keeps its document form. */}
                  {record && activeTab !== null ? (
                    <>
                      {/* M38.2 — the property surface the peek shows, on the
                          page. The SAME component: one property editor, two
                          geometries, so a field added here is a field added
                          there. M45.4: view tabs skip it too — the embedded
                          database IS the tab's content, and a stack above it
                          would be the Overview leaking through. */}
                      {activeTab.content !== 'sections' &&
                        activeTab.content !== 'view' &&
                        (activeTab.content === 'properties' || !stripShows || detailsShown) && (
                          <div data-testid="page-properties" className="mb-4">
                            <RecordProperties
                              key={`props:${entry.path}`}
                              entry={entry}
                              schema={schema}
                            />
                          </div>
                        )}
                      {activeTab.content === 'overview' && editorBlock}
                      {activeTab.content === 'sections' && (
                        <TabSections
                          key={`${entry.path}#${activeTab.id}`}
                          entry={entry}
                          tabId={activeTab.id}
                        />
                      )}
                      {/* M45.4 — the fourth arm: resolve the tab's pointer
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
                    editorBlock
                  )}
                </>
              )}
            </div>
          </div>
          {blank && !busy && (
            <BlankPageBar templates={templates} onPick={(t) => void applyTemplate(t)} />
          )}
        </div>
        {panelOpen && (
          <DocSidePanel entry={entry} schema={schema} editor={editor} scrollRef={scrollRef} />
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
            const newPath =
              docPages !== null ? `${dest}/${entry.path.slice(docPages.folder.length + 1)}` : dest;
            setMoving(false);
            navigate({ kind: 'doc', path: newPath });
          }}
        />
      )}
      {addingPage && (
        <Dialog
          open
          onClose={() => setAddingPage(false)}
          title="Add page"
          width={420}
          primaryAction={{
            label: 'Add',
            onClick: () => void submitAddPage(),
            disabled: pageName.trim() === '' || busy,
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setAddingPage(false) }}
        >
          <p className="m-0 mb-2 text-sm text-n-500">
            {docPages === null
              ? 'This turns the page into a multi-page doc — its pages show as tabs.'
              : `Adds a page to "${docPages.main.title}".`}
          </p>
          <Input
            autoFocus
            placeholder="Page name"
            value={pageName}
            onChange={(e) => setPageName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitAddPage();
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
        >
          <p className="m-0 text-sm text-n-600">
            {isDocMain
              ? 'The whole doc — every page in it — moves to the system Trash.'
              : 'The page moves to the system Trash.'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
