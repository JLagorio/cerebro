import { useEffect, useRef, useState } from 'react';
import { MoveDialog } from '@/components/MoveDialog';
import { Button } from '@/components/ui/Button';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { DocPagesFloatingButton, DocPagesPanel } from '@/detail/DocPagesPanel';
import { DocSidePanel } from '@/detail/DocSidePanel';
import type { CerebroEditor, EditorReadyInfo } from '@/editor/MarkdownEditor';
import { spliceTitleIntoBlocks } from '@/editor/markdown';
import { NoteBodyEditor, type SaveState } from '@/editor/NoteBodyEditor';
import { GitHistoryPanel } from '@/git/GitHistoryPanel';
import { InlineDiff } from '@/git/InlineDiff';
import { docFolderPathFor, docPagesFor } from '@/engine/docPages';
import type { Entry, Selection } from '@/engine/types';
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
      <div className="pointer-events-auto flex max-w-[90%] items-center gap-1.5 overflow-x-auto rounded-full border border-[var(--n-200)] bg-[var(--n-0)] px-3 py-1.5 shadow-[0_4px_16px_rgba(22,26,36,0.10)]">
        <Icon name="layout-template" size={14} color="var(--n-500)" />
        {templates.length > 0 ? (
          <>
            <span className="flex-none text-[12px] text-[var(--n-500)]">Start from a template</span>
            {templates.map((t) => (
              <button
                key={t.path}
                type="button"
                onClick={() => onPick(t)}
                className="flex-none rounded-full border border-[var(--n-200)] bg-[var(--n-0)] px-2.5 py-0.5 text-[12px] text-[var(--n-700)] hover:border-[var(--cortex-500)] hover:text-[var(--cortex-600)]"
              >
                {templateDisplayName(t)}
              </button>
            ))}
          </>
        ) : (
          <span className="text-[12px] text-[var(--n-500)]">
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
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const createItem = useVaultStore((s) => s.createItem);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const navigate = useNavStore((s) => s.navigate);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const panelOpen = useUiStore((s) => s.docPanelOpen);
  const setPanelOpen = useUiStore((s) => s.setDocPanelOpen);
  const pagesOpen = useUiStore((s) => s.docPagesOpen);

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
  useEffect(() => {
    setEditor(null); // the keyed editor remounts per doc; wait for onReady
  }, [selection.path, reloadGen]);

  // Blank-page detection drives the floating template bar.
  const [blank, setBlank] = useState(false);
  useEffect(() => {
    if (editor === null) {
      setBlank(false);
      return;
    }
    setBlank(isBlankBody(editor));
    const unsubscribe = editor.onChange?.(() => setBlank(isBlankBody(editor)));
    return () => unsubscribe?.();
  }, [editor]);

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

  // Breadcrumb: Docs root, then folders; a multi-page doc's folder segment
  // becomes the doc crumb (its pages are tabs, not tree entries).
  const folderSegments = entry.folder === '' ? [] : entry.folder.split('/');
  const crumbFolders = docPages !== null ? folderSegments.slice(0, -1) : folderSegments;

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
        await renameNote(vaultPath, entry.path, `${folder}/${entry.filename}`);
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
      navigate({ kind: 'docs' });
    } catch {
      toast("Couldn't move to Trash");
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

  const menuItems: ContextMenuItem[] = [
    {
      icon: fullWidth ? 'minimize-2' : 'maximize-2',
      label: fullWidth ? 'Center content' : 'Full width',
      onSelect: () => void patchFrontmatter(entry.path, { full_width: fullWidth ? null : true }),
    },
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
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[13px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
      >
        {opts.icon !== undefined && <Icon name={opts.icon} size={13} />}
        <span className="truncate">{label}</span>
      </button>
    ) : (
      <span
        className={[
          'inline-flex min-w-0 items-center gap-1.5 px-1 text-[13px]',
          opts.strong === true ? 'font-medium text-[var(--n-900)]' : 'text-[var(--n-500)]',
        ].join(' ')}
      >
        {opts.icon !== undefined && <Icon name={opts.icon} size={13} color="var(--n-500)" />}
        <span className="truncate">{label}</span>
      </span>
    );

  const separator = <Icon name="chevron-right" size={12} color="var(--n-300)" />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="doc-page">
      <div className="flex h-11 flex-none items-center gap-0.5 border-b border-[var(--n-200)] px-3">
        {crumb('Docs', { icon: 'library', onClick: () => navigate({ kind: 'docs' }) })}
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
              'mr-1 flex-none whitespace-nowrap text-[11.5px]',
              saveState === 'failed'
                ? 'font-medium text-[var(--danger-600)]'
                : 'text-[var(--text-meta)]',
            ].join(' ')}
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
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
        <div className="relative min-h-0 min-w-0 flex-1">
          {docPages !== null && !pagesOpen && <DocPagesFloatingButton />}
          <div ref={scrollRef} className="h-full overflow-y-auto pb-10 pt-6">
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
                  <NoteBodyEditor
                    key={`${entry.path}#${reloadGen}`}
                    path={entry.path}
                    onSaveState={setSaveState}
                    onReady={(info) => {
                      editorControls.current = info;
                      setEditor(info.editor);
                    }}
                  />
                  {/* M9.4 — this document's history, silent when it has none. */}
                  <GitHistoryPanel path={entry.path} />
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
          <p className="m-0 mb-2 text-[12.5px] text-[var(--n-500)]">
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
          <p className="m-0 mb-2 text-[12.5px] text-[var(--n-500)]">
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
          <p className="m-0 text-[13px] text-[var(--n-600)]">
            {isDocMain
              ? 'The whole doc — every page in it — moves to the system Trash.'
              : 'The page moves to the system Trash.'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
