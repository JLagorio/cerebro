import { KeyboardBlockMenu } from './KeyboardBlockMenu';
import { Popover } from '@/components/ui/Popover';
import { moveWithSelection } from './blockActions';
import { settleSheetDrafts } from '@/sheet/pendingSheets';
import { nextSheetName, newSheetSource } from '@/engine/sheet/gridEdit';
import { parseSheetFence, sheetNames, sheetSourcesOf } from '@/engine/sheet/fence';
import '@blocknote/mantine/style.css';
import './editor.css';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PageTitleProjection } from './pageTitleProjection';
import { HeldSelection } from './heldSelection';
import { TableSizePicker } from './TableSizePicker';
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  inlineContentToNodes,
  trackPosition,
  type PartialBlock,
} from '@blocknote/core';
import {
  insertOrUpdateBlockForSlashMenu,
  SideMenuExtension,
  SuggestionMenu,
  type DefaultSuggestionItem,
} from '@blocknote/core/extensions';
import { BlockGrip } from './BlockDragLayer';
import { AttachmentFilePanel, AttachmentUploadContext } from './AttachmentFilePanel';
import {
  addAttachments,
  anchorAt,
  pastedFiles,
  resolveAttachmentUrl,
  type AttachmentAnchor,
  type AttachmentSource,
} from './attachments';
import { useOsDropZone } from '@/hooks/useOsDropZone';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { CommentHighlights } from './commentHighlights';
import { FindBar } from './FindBar';
import { FindHighlights } from './findHighlights';
import { canInsertColumnsAt, COLUMN_COUNTS, newColumnList } from './columnCommands';
import { codeBlockSpec } from './codeBlock';
import { onAgentEvent, runAgent, startedOrThrow } from '@/agent/agentIpc';
import { createLinkedPage } from '@/app/listActions';
import { AskAiPopover, type SelectionApplyResult } from '@/editor/AskAiPopover';
import { isAiBlockRunning, setAiBlockRunning } from '@/editor/aiBlockRuns';
import { AiFormattingToolbar, CarriedBlockMenu, type Preset } from '@/editor/SelectionToolbar';
import { PromoteDialog } from './PromoteDialog';
import { linkPromotedLines, promotable, readChecklistLine } from './promoteLines';
import type { ChecklistLine } from '@/engine/promote';
import type { PromotionResult } from '@/app/promoteActions';
import { BlockNoteView } from '@blocknote/mantine';
import {
  AddBlockButton,
  FilePanelController,
  DragHandleButton,
  getDefaultReactSlashMenuItems,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  useBlockNoteEditor,
  useCreateBlockNote,
  useExtensionState,
  type DefaultReactSuggestionItem,
} from '@blocknote/react';
import { Dropdown } from '@/components/ui/Dropdown';
import { Icon } from '@/components/ui/Icon';
import { parseSources } from '@/engine/okf';
import { isLinkablePage } from '@/engine/pageCard';
import { peopleTypes } from '@/engine/properties';
import type { Entry } from '@/engine/types';
import { linkTargetOfPath, linkTargetsFor, resolveTarget } from '@/engine/wikilink';
import { readNote } from '@/lib/ipc';
import { listTemplates, templateDisplayName, todayIso } from '@/lib/templates';
import { useRecency } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import {
  AiBlock,
  GatedImageBlock,
  CalloutBlock,
  ColumnBlock,
  ColumnListBlock,
  DatabaseBlock,
  leaveAiAnswer,
  MermaidBlock,
  PageCardBlock,
  SheetBlock,
  WhiteboardBlock,
  SubPagesBlock,
} from './blocks';
import { AssigneeChip, CitationChip, DueChip, WikilinkChip } from './chips';
import { citationTextInput, insertCitation } from './citationInput';
import { citationChoices, citationIndexOf } from './citations';
import { buildOutline } from './DocOutline';
import { distinctTitles, rankSuggestionItems } from './menuRank';
import {
  charBeforeTrigger,
  creatableTitle,
  mentionAtWordStart,
  mentionNamesPage,
  readLinkQuery,
  type SectionQuery,
} from './linkMenu';
import {
  blocksToMarkdown,
  blocksToMarkdownNow,
  escapeMarkerLines,
  lossyImportCause,
  markdownToBlocks,
  markdownToBlocksNow,
  type LossyCause,
  unwrapReplyFence,
} from './markdown';
import { NotePathContext } from './notePath';
import { pageLinkPasteHandler } from './pageCardInput';
import { SectionFlash } from './SectionFlash';
import {
  findSectionBlock,
  revealBlock,
  watchSections,
  type SectionSourceBlock,
} from './sectionLinks';
import { applySteps, inPlace, planExternal, settleChoice, type OpenChoice } from './reconcile';

/**
 * The table controls a markdown table cannot carry, switched off (M55.15):
 * split and merged cells (a cell spans one column), cell colours, and the
 * header toggles (a markdown table always has a header row and never a header
 * column). BlockNote's defaults already say so; they are spelled out because
 * turning one on would offer an action a save drops (`UNCARRIED_ACTIONS`).
 */
export const TABLE_SETTINGS = {
  splitCells: false,
  cellBackgroundColor: false,
  cellTextColor: false,
  headers: false,
} as const;

// Default schema with our code block swapped in (codeBlock.tsx), plus the Cerebro custom
// blocks (AI block, callout, columns, database, mermaid, sheet, whiteboard, the child-page list,
// the page card) and inline chips: wikilinks, assignees, dates, and footnote
// citations (M2.x, M47.2, M48.1, M51.5, M55.13, M55.14).
export const cerebroSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    image: GatedImageBlock(),
    codeBlock: codeBlockSpec,
    ai: AiBlock(),
    callout: CalloutBlock(),
    column: ColumnBlock(),
    columnList: ColumnListBlock(),
    database: DatabaseBlock(),
    mermaid: MermaidBlock(),
    pageCard: PageCardBlock(),
    sheet: SheetBlock(),
    whiteboard: WhiteboardBlock(),
    subPages: SubPagesBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: WikilinkChip,
    assignee: AssigneeChip,
    due: DueChip,
    citation: CitationChip,
  },
});

export type CerebroEditor = typeof cerebroSchema.BlockNoteEditor;

type SlashKey = DefaultSuggestionItem['key'];

/**
 * BlockNote's `/` entries the menu leaves out, by key (M53.31).
 *
 * Every block the editor offers has a disk carrier, or it is not offered: a
 * key goes here when a save would not keep its block. Empty since M55.4 gave
 * toggles, toggle headings, audio and file their carriers. `markdown.test.ts`
 * holds this set to its KNOWN_LOSSY, which can only stay empty.
 */
export const DROPPED_SLASH_KEYS: ReadonlySet<SlashKey> = new Set<SlashKey>();

/** A `/` menu row. BlockNote's own carry the key they were made from. */
type SlashMenuItem = DefaultReactSuggestionItem & { key?: SlashKey };

/**
 * BlockNote's table, with the header row a markdown table must have (M55.4).
 * Without one the first save wrote an empty header row above the cells.
 */
const insertTable = (editor: CerebroEditor, rows = 2, columns = 3): void => {
  insertOrUpdateBlockForSlashMenu(editor, {
    type: 'table',
    content: {
      type: 'tableContent',
      headerRows: 1,
      rows: Array.from({ length: rows }, () => ({
        cells: Array.from({ length: columns }, () => ''),
      })),
    },
  });
};

/** The `/` menu: BlockNote's entries less DROPPED_SLASH_KEYS, then `ours`. */
export function slashMenuItems(
  editor: CerebroEditor,
  ours: DefaultReactSuggestionItem[] = [],
  onTable?: () => void,
): SlashMenuItem[] {
  // The React list spreads each core entry, key and all; only its declared
  // type leaves the key off.
  const blockNote = getDefaultReactSlashMenuItems(editor) as (DefaultReactSuggestionItem & {
    key: SlashKey;
  })[];
  return [
    ...blockNote
      .filter((item) => !DROPPED_SLASH_KEYS.has(item.key))
      .map((item) =>
        item.key === 'table'
          ? {
              ...item,
              title: 'Table',
              subtext: 'Simple Markdown cells with a header row',
              onItemClick: onTable ?? (() => insertTable(editor)),
            }
          : item,
      ),
    ...ours,
  ];
}

// M12.1: anything that is content can be linked — docs AND records. Only the
// schema itself and stationery stay out of the `[[` picker, which offers what
// the page card's picker offers (`isLinkablePage`, M55.14) and links each page
// by the name that reaches it (`linkTargetsFor`): its stem, unless another
// page answers to that stem first.
const isLinkableDoc = isLinkablePage;

/**
 * The page each page row links, so the menus rank it by the person's own
 * opens (M59.3). Keyed by the row object `docItems`, `sectionItems` and
 * `personItems` build.
 */
const rowPaths = new WeakMap<DefaultReactSuggestionItem, string>();
const pageRow = (item: DefaultReactSuggestionItem, path: string): DefaultReactSuggestionItem => {
  rowPaths.set(item, path);
  return item;
};
const rowPathOf = (item: DefaultReactSuggestionItem) => rowPaths.get(item);

/** Case-insensitive title/subtext/alias filter, in the given order, for the
 * `/` and `[^` menus, whose order is designed or numbered. The `@` menu and
 * the `[` page rows rank instead (`menuRank.ts`, M59.3). */
function filterItems(
  items: DefaultReactSuggestionItem[],
  query: string,
): DefaultReactSuggestionItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return distinctTitles(items);
  return distinctTitles(
    items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (typeof i.subtext === 'string' && i.subtext.toLowerCase().includes(q)) ||
        (Array.isArray(i.aliases) && i.aliases.some((a) => a.toLowerCase().includes(q))),
    ),
  );
}

/** Inline items of a checklist block, split into existing chips and the rest. */
function splitTaskContent(content: unknown): {
  rest: unknown[];
  assignees: string[];
} {
  const rest: unknown[] = [];
  const assignees: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      const node = item as { type?: string; props?: { target?: string } };
      if (node.type === 'due') continue; // replaced by the dialog's date
      if (node.type === 'assignee' && typeof node.props?.target === 'string') {
        assignees.push(node.props.target);
      }
      rest.push(item);
    }
  }
  return { rest, assignees };
}

/** Side-menu button on hovered checklist rows: assign an owner + due date
 * (M2.x feedback). Reads the hovered block from the side-menu extension —
 * SideMenuProps no longer carries it in 0.46. */
function AssignTaskButton({ onOpen }: { onOpen: (blockId: string) => void }) {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });
  if (block === undefined || block.type !== 'checkListItem') return null;
  return (
    <button
      type="button"
      title="Assign & set due date"
      aria-label="Assign task"
      className="cerebro-assign-task"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onOpen(block.id)}
    >
      <Icon name="user-round-plus" size={16} />
    </button>
  );
}

/**
 * The drag grip on the hovered block (M48.4).
 *
 * Replaces BlockNote's `DragHandleButton`. That one uses the browser's HTML5
 * drag-and-drop, which MEASURED cannot be driven from our test harness at all
 * — so every behaviour built on it shipped unverified, and it could not drop a
 * block into a column. This one is a pointer drag on `useDragGesture`, the
 * same loop the canvas, board, table and dashboard already run.
 *
 * Reads the hovered block from the side-menu extension, as `AssignTaskButton`
 * does: `SideMenuProps` stopped carrying it in 0.46.
 */
function BlockGripButton({
  hostRef,
  sideMenu,
}: {
  hostRef: { current: HTMLElement | null };
  sideMenu: React.ReactNode;
}) {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });
  if (block === undefined) return null;
  return (
    <BlockGrip
      blockId={block.id}
      hostRef={hostRef}
      onDrop={(spot) => {
        const moving = editor.getBlock(block.id);
        const target = editor.getBlock(spot.blockId);
        if (moving === undefined || target === undefined) return;
        // Remove FIRST, then insert. The other order leaves the document
        // briefly holding two blocks with the same id, and BlockNote resolves
        // `getBlock` by id.
        moveWithSelection(editor as CerebroEditor, () => {
          editor.removeBlocks([moving]);
          editor.insertBlocks([moving as never], target, spot.placement);
        });
      }}
    >
      {sideMenu}
    </BlockGrip>
  );
}

function isoAfterDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface MarkdownEditorProps {
  /**
   * Initial markdown BODY — never frontmatter. Uncontrolled after mount:
   * remount with a `key` to load a different document. A later version of
   * the same document lands in place through `applyExternal` (M55.6).
   */
  markdown: string;
  /**
   * Called with the serialized markdown, debounced after user edits.
   * Suppressed when serialization matches the last saved form, so opening a
   * document never rewrites it. A returned promise is the save: the editor's
   * flush waits for it.
   */
  onChange: (markdown: string) => void | Promise<void>;
  /**
   * Fires once the document is loaded and its save listener is attached.
   * `lossyCause` says how the parse
   * round trip changed the file's text (raw HTML dropped, other text dropped,
   * text added or reordered), or is null when it kept it; consumers open such
   * a page read-only and name the cause before edits overwrite the file.
   *
   * `flushPendingSave` / `cancelPendingSave` let the owner take control of the
   * debounce. Flush before a deliberate save (⌘S) or before an agent turn
   * starts (M53.6): it emits a pending edit, and its promise settles once
   * `onChange`'s has, including a save the debounce had already started. It
   * refuses preparation while a sheet has an unresolved cell draft. Cancel before the file is written out of band (template
   * apply), so the stale in-editor body can't be written back over it.
   *
   * `applyExternal` takes an outside write in place (M55.6), as its own undo
   * step, and never calls `onChange` or `onDirty` for it: the owner decides
   * what to save, with `serialize` and `markSaved`.
   */
  onReady?: (info: EditorReadyInfo) => void;
  debounceMs?: number;
  autoFocus?: boolean;
  /**
   * Mount the document as a read-only view: no typing, and no save can be
   * scheduled. Used for lossy imports, where a single keystroke would strip
   * content the editor cannot represent.
   */
  readOnly?: boolean;
  /** A user edit was made and a save is now pending (fires per keystroke). */
  onDirty?: () => void;
  /** Capture exact text before a debounce or presentation unmount. */
  onDraft?: (markdown: string) => void;
  /** Synchronous lease over preparation, serialization and its owning save. */
  onBeginSave?: () => () => void;
  /** Source shares this debounce, never a second writer or timer. */
  getSaveDraft?: () => string | null;
  /** Page metadata is presentation inside the same editor, never document content. */
  pageChromeHost?: HTMLElement;
  pageTitle?: string;
  bodyVisible?: boolean;
}

/** One place an outside write and the page's unsaved typing disagree. */
export interface ChoiceView {
  id: string;
  /** Mine and theirs as markdown; empty for a side that deleted the span. */
  mine: string;
  theirs: string;
  /** The block to show it at, or null when neither side has one on the page. */
  firstBlockId: string | null;
}

/** What `applyExternal` did with an outside write. */
export type ExternalResult =
  /** It reads as the base: nothing changed. */
  | { kind: 'same' }
  /** It landed. `after` is the page's text now; it equals `next`, the write's
   *  canonical text, unless unsaved typing was merged in. `dirty`: the page
   *  held unsaved typing, so a clean page whose `after` differs is a page
   *  the apply got wrong. */
  | { kind: 'applied'; next: string; after: string; dirty: boolean }
  /** It landed except where the page's typing overlaps it; mine stays there. */
  | { kind: 'choices'; next: string; choices: ChoiceView[] }
  /** The editor cannot show it without changing its text; nothing changed. */
  | { kind: 'unrepresentable'; dirty: boolean };

export interface EditorReadyInfo {
  editor: CerebroEditor;
  lossyCause: LossyCause | null;
  /** The loaded markdown's round trip: the canonical text the page opened as. */
  loadedAs: string;
  flushPendingSave: () => Promise<void>;
  cancelPendingSave: () => void;
  schedulePendingSave: () => void;
  presentMarkdown: (
    raw: string,
    allowLoss?: boolean,
  ) => Promise<{ lossy: LossyCause | null; canonical: string }>;
  /** The page as markdown, now. */
  serialize: () => string;
  /** Match retained sheet source through the same recursive parser as the page. */
  sheetSources: (markdown?: string) => ReturnType<typeof sheetSourcesOf>;
  /** Record `md` as saved, so an emit of the same text writes nothing. */
  markSaved: (md: string) => void;
  /** Apply `next`, the file's body as read, against `base`, the canonical text
   *  the page last read or saved (M55.6). */
  applyExternal: (next: string, base: string, opts?: { allowLoss?: boolean }) => ExternalResult;
  /** Settle an open choice; the choices still open. */
  choose: (id: string, pick: 'mine' | 'theirs') => ChoiceView[];
}

export function MarkdownEditor({
  markdown,
  onChange,
  onReady,
  debounceMs = 500,
  autoFocus = false,
  readOnly = false,
  onDirty,
  onDraft,
  onBeginSave,
  getSaveDraft,
  pageChromeHost,
  pageTitle,
  bodyVisible = true,
}: MarkdownEditorProps) {
  // Filled in below, once the editor exists: the typed-citation rule needs the
  // editor to close the link menu a marker's `[` opened, and it is handed to
  // TipTap before there is an editor to close anything on.
  const closeLinkMenu = useRef(() => {});
  // The same, for the Enter that leaves an AI block's answer (M53.9).
  const leaveAnswer = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const attachmentDoor = useRef<
    (
      sources: readonly AttachmentSource[],
      point?: { x: number; y: number },
      anchor?: AttachmentAnchor,
    ) => Promise<void>
  >(async () => {});
  const attachmentPath = useRef<string | null>(null);
  const editor = useCreateBlockNote({
    schema: cerebroSchema,
    tables: TABLE_SETTINGS,
    resolveFileUrl: (url) => resolveAttachmentUrl(url, attachmentPath.current),
    _tiptapOptions: {
      editorProps: {
        // M52.1: a hand-typed `[^id]` becomes a chip as its `]` lands.
        handleTextInput: citationTextInput(() => closeLinkMenu.current()),
        handleDOMEvents: {
          drop: (_view, event) => {
            if (!event.dataTransfer?.types.includes('Files')) return false;
            event.preventDefault();
            void attachmentDoor.current(Array.from(event.dataTransfer.files), {
              x: event.clientX,
              y: event.clientY,
            });
            return true;
          },
        },
        // M53.9: Enter at the end of an AI block's answer starts a paragraph
        // after the block (`leaveAiAnswer`). A view prop runs before every
        // keymap, and an open suggestion menu takes its Enter before the view
        // sees it at all; only a key typed into the page itself is ours, not
        // one typed into a field inside a block.
        handleKeyDown: (view, event) => event.target === view.dom && leaveAnswer.current(event),
      },
    },
    // M55.14: a lone page link pasted on an empty line becomes a page card;
    // every other paste goes on to the citation half (M52.4).
    pasteHandler: (ctx) => {
      const files = pastedFiles(ctx.event.clipboardData);
      if (files.length === 0) return pageLinkPasteHandler(ctx);
      void attachmentDoor.current(files);
      return true;
    },
    // M70.1: comment highlights, and M59.6: find highlights, each drawn as
    // decorations outside the document.
    extensions: [CommentHighlights(), FindHighlights(), PageTitleProjection(), HeldSelection()],
  });
  closeLinkMenu.current = () => editor.getExtension(SuggestionMenu)?.closeMenu();
  leaveAnswer.current = (event) => leaveAiAnswer(editor, event);
  useEffect(() => {
    editor
      .getExtension(PageTitleProjection)
      ?.configure(pageTitle === undefined ? null : (pageChromeHost ?? null), bodyVisible);
  }, [editor, pageChromeHost, pageTitle, bodyVisible]);
  // M48.4 — what the block drag measures against. The editor's own host
  // element, so a drop can be resolved against every rendered block including
  // the ones inside columns.
  const host = useRef<HTMLDivElement | null>(null);
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  // The person's own opens rank the `@` and `[` page rows (M59.3).
  const recency = useRecency();
  // Who the @ menu offers. This was `e.type === 'Person'` in three places
  // (M16.13b) — the type-name routing AGENTS.md forbids, and the reason a
  // vault whose people are `Teammate`s had an @ menu with no people in it.
  // There is no FieldDef here to read a target off, so the schema answers:
  // the types every person field points at.
  const peopleSet = useMemo(() => peopleTypes(schema, entries), [schema, entries]);
  const isPerson = useCallback((e: Entry) => e.type !== null && peopleSet.has(e.type), [peopleSet]);
  // The name each page is linked by; a page no name reaches gets no row.
  const targetOf = useMemo(() => linkTargetsFor(entries), [entries]);
  const toast = useUiStore((s) => s.toast);
  // The note this body belongs to, for the sources its frontmatter lists — what
  // the `[^` menu offers first (M52.1). Null outside a NoteBodyEditor, where
  // the page's own footnotes are all there is to cite.
  const notePath = useContext(NotePathContext);
  attachmentPath.current = notePath;
  const captureAttachmentOwner = useVaultActionGuard(JSON.stringify([vaultPath, notePath]));
  const noteEntry = notePath === null ? undefined : entries.find((e) => e.path === notePath);
  const [promoting, setPromoting] = useState<ChecklistLine[] | null>(null);
  const [selectionPromotable, setSelectionPromotable] = useState(false);
  const promotionDoor = useRef<{ enabled: boolean; open: (id: string) => void }>({
    enabled: false,
    open: () => {},
  });
  promotionDoor.current = {
    enabled: !readOnly && notePath !== null,
    open: (id) => {
      if (readOnly || notePath === null) return;
      const block = editor.getBlock(id);
      const line = block === undefined ? null : readChecklistLine(block, entries, notePath);
      if (line !== null) setPromoting([line]);
    },
  };
  // Stable component identity: changing selection must not remount the open
  // grip menu. The ref supplies the current page and read-only verdict.
  const dragHandleMenu = useMemo(
    () =>
      function PromotionBlockMenu() {
        const door = promotionDoor.current;
        return <CarriedBlockMenu onPromote={door.enabled ? door.open : undefined} />;
      },
    [],
  );
  useEffect(
    () =>
      editor.onSelectionChange(() => {
        setSelectionPromotable(
          promotable(editor.getSelection()?.blocks ?? [], entries, notePath).length > 0,
        );
      }),
    [editor, entries, notePath],
  );
  const sources = useMemo(
    () => (noteEntry === undefined ? [] : parseSources(noteEntry)),
    [noteEntry],
  );
  const [loaded, setLoaded] = useState<EditorReadyInfo | null>(null);
  /**
   * Ask AI on the selection (M17.16), opened with Cmd/Ctrl-K.
   *
   * The selected TEXT is captured when the popover opens, not read when it
   * closes: the user is about to type into an input, which collapses the
   * editor selection the moment focus leaves. Holding the string is also what
   * lets the rewrite be diffed against exactly what was shown.
   */
  const [asking, setAsking] = useState<{
    text: string;
    x: number;
    y: number;
    preset?: string;
  } | null>(null);
  // A rewrite owns a model range and version, never a live DOM Range. Focus
  // and HeldSelection's paint may change while its input owns the keyboard.
  const selectionVersion = useRef(0);
  useEffect(
    () =>
      editor.onChange(() => {
        selectionVersion.current += 1;
      }),
    [editor],
  );
  const target = useRef<{
    text: string;
    from: number;
    to: number;
    doc: CerebroEditor['prosemirrorState']['doc'];
    version: number;
    current: () => boolean;
  } | null>(null);
  // Assign-task popover (M2.x feedback): opened from the checklist row's
  // side-menu button, floats NEXT TO the task line (not a modal); writes
  // assignee/due chips into that block.
  const [assign, setAssign] = useState<{ blockId: string; x: number; y: number } | null>(null);
  const [tablePicker, setTablePicker] = useState<HTMLElement | null>(null);
  const [keyboardBlock, setKeyboardBlock] = useState<{ id: string; anchor: HTMLElement } | null>(
    null,
  );
  const exclusiveTool =
    asking !== null || assign !== null || tablePicker !== null || keyboardBlock !== null;
  useEffect(() => {
    if (exclusiveTool) closeLinkMenu.current();
    if (asking === null) editor.getExtension(HeldSelection)?.clear();
  }, [editor, exclusiveTool, asking]);
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const lastEmitted = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  // Up while an outside write is applied (M55.6): its change events are not
  // the person's edits, so they neither mark the page dirty nor save.
  const applying = useRef(false);
  // The choices an outside write left open, by id.
  const openChoices = useRef(new Map<string, OpenChoice>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const getSaveDraftRef = useRef(getSaveDraft);
  getSaveDraftRef.current = getSaveDraft;
  const schedulePendingRef = useRef<() => void>(() => {});
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const onBeginSaveRef = useRef(onBeginSave);
  onBeginSaveRef.current = onBeginSave;
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  // Read-only is checked through a ref so unlocking a lossy import takes
  // effect without rebuilding the debounce plumbing.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // False once unmounted: a page made from the link menu lands after a write
  // and a rescan, and by then its chip may have no editor to go into (M55.7).
  // Set in the effect rather than at creation, so StrictMode's second mount
  // turns it back on.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Every emit so far, serialized then saved, as one promise that never
   * rejects (M53.6). A flush returns it, so it waits for a save the debounce
   * already started as well as the one it starts itself.
   */
  const lastEmit = useRef<Promise<void>>(Promise.resolve());
  const emitRef = useRef(() => {});
  emitRef.current = () => {
    try {
      settleSheetDrafts(editor);
    } catch {
      // Keep the body generation and the exact cell draft unresolved. The
      // mounted participant reports preparation failure; autosave must not
      // publish an older sheet source behind that visible draft.
      return;
    }
    const write = onChangeRef.current;
    const finish = onBeginSaveRef.current?.();
    const emitted = (async () => {
      try {
        const override = getSaveDraftRef.current?.();
        const md = await (override == null ? blocksToMarkdown(editor) : Promise.resolve(override));
        if (md === lastEmitted.current) return;
        lastEmitted.current = md;
        await write(md);
      } finally {
        finish?.();
      }
    })();
    lastEmit.current = Promise.allSettled([lastEmit.current, emitted]).then(() => undefined);
  };

  const prepareAttachment = (anchor: AttachmentAnchor | null) => {
    const current = captureAttachmentOwner();
    const captured = anchor?.replace
      ? { ...anchor, expected: JSON.stringify(editor.getBlock(anchor.id)) }
      : anchor;
    return (sources: readonly AttachmentSource[]) =>
      addAttachments({
        editor,
        sources,
        anchor: captured,
        current,
        readOnly: () => readOnlyRef.current,
      });
  };
  attachmentDoor.current = (sources, point, anchor) =>
    prepareAttachment(anchor ?? anchorAt(editor, host.current, point))(sources);
  const attachmentZone = useOsDropZone('editor', (paths, point) =>
    attachmentDoor.current(paths, point),
  );
  const setAttachmentZone = attachmentZone.zoneProps.ref;
  const setEditorHost = useCallback(
    (element: HTMLDivElement | null) => {
      host.current = element;
      setAttachmentZone(element);
    },
    [setAttachmentZone],
  );

  // Handed to the owner via onReady and kept for the editor's lifetime, so
  // they must be identity-stable — they close over refs only, never props.
  const cancelPendingSave = useRef(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }).current;
  const flushPendingSave = useRef(() => {
    settleSheetDrafts(editor);
    const wasPending = timer.current !== null;
    cancelPendingSave();
    if (wasPending && (!readOnlyRef.current || getSaveDraftRef.current?.() != null))
      emitRef.current();
    return lastEmit.current;
  }).current;

  /** `fn`, with its change events kept from the save path. */
  const quietly = (fn: () => void) => {
    applying.current = true;
    try {
      fn();
    } finally {
      applying.current = false;
    }
  };

  const viewOf = (choice: OpenChoice): ChoiceView => ({
    id: choice.id,
    mine: choice.minePreview,
    theirs: choice.theirsPreview,
    firstBlockId:
      choice.mine.find((id) => editor.getBlock(id) !== undefined) ??
      (choice.after !== null && editor.getBlock(choice.after) !== undefined
        ? choice.after
        : choice.parent),
  });
  const openViews = () => [...openChoices.current.values()].map(viewOf);

  const applyExternal: EditorReadyInfo['applyExternal'] = (next, base, opts = {}) => {
    const plan = planExternal(editor, {
      next,
      base,
      open: [...openChoices.current.values()],
      allowLoss: opts.allowLoss ?? false,
    });
    if (plan.kind !== 'plan') return plan;
    quietly(() => inPlace(editor, () => applySteps(editor, plan.steps)));
    // The page now stands on the write: undoing it differs from this, so the
    // undo is saved like any edit.
    lastEmitted.current = plan.next;
    openChoices.current = new Map(plan.choices.map((choice) => [choice.id, choice]));
    if (plan.choices.length > 0) return { kind: 'choices', next: plan.next, choices: openViews() };
    return {
      kind: 'applied',
      next: plan.next,
      after: blocksToMarkdownNow(editor),
      dirty: plan.dirty,
    };
  };

  const choose: EditorReadyInfo['choose'] = (id, pick) => {
    const choice = openChoices.current.get(id);
    if (choice !== undefined) {
      openChoices.current.delete(id);
      quietly(() => settleChoice(editor, choice, pick));
    }
    return openViews();
  };

  // Identity-stable for the owner, like the save controls: they read the
  // latest closures through this ref.
  const external = useRef({ applyExternal, choose });
  external.current = { applyExternal, choose };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const blocks = await markdownToBlocks(editor, markdown);
      if (cancelled) return;
      if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
      // Serialized baseline: change events only emit when they diverge from
      // it, so mounting (and the trailing-block plugin) never writes back.
      const roundTripped = await blocksToMarkdown(editor);
      if (cancelled) return;
      lastEmitted.current = roundTripped;
      setLoaded({
        editor,
        lossyCause: lossyImportCause(markdown, roundTripped),
        loadedAs: roundTripped,
        flushPendingSave,
        cancelPendingSave,
        schedulePendingSave: () => schedulePendingRef.current(),
        presentMarkdown: async (raw, allowLoss = false) => {
          const blocks = await markdownToBlocks(editor, raw);
          const canonical = blocksToMarkdownNow(editor, blocks);
          const lossy = lossyImportCause(raw, canonical);
          if (lossy !== null && !allowLoss) return { lossy, canonical };
          quietly(() => {
            editor.replaceBlocks(editor.document, blocks);
          });
          lastEmitted.current = canonical;
          return { lossy, canonical };
        },
        serialize: () => blocksToMarkdownNow(editor),
        sheetSources: (source) =>
          sheetSourcesOf(
            source === undefined ? editor.document : markdownToBlocksNow(editor, source),
          ),
        markSaved: (md) => {
          lastEmitted.current = md;
        },
        applyExternal: (next, base, opts) => external.current.applyExternal(next, base, opts),
        choose: (id, pick) => external.current.choose(id, pick),
      });
    })();
    return () => {
      cancelled = true;
    };
    // `markdown` is the initial value by contract; the editor instance is
    // stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // BlockNoteView attaches its change listener in a child effect. Announce
  // readiness after that commit so an immediate edit cannot precede the
  // listener and disappear from the save path.
  useEffect(() => {
    if (loaded !== null) onReadyRef.current?.(loaded);
  }, [loaded]);

  const scheduleEmit = () => {
    // An outside write being applied is not an edit (M55.6).
    if (applying.current) return;
    // A read-only document must not be able to schedule a write at all — the
    // editable flag alone would still let a programmatic change through.
    if (readOnlyRef.current) return;
    onDraftRef.current?.(blocksToMarkdownNow(editor));
    onDirtyRef.current?.();
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      emitRef.current();
    }, debounceMs);
  };

  schedulePendingRef.current = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      emitRef.current();
    }, debounceMs);
  };

  // Flush a pending debounce on unmount so the last edit isn't lost.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        if (!readOnlyRef.current || getSaveDraftRef.current?.() != null) emitRef.current();
      }
    },
    [],
  );

  useEffect(() => {
    if (loaded && autoFocus) editor.focus();
  }, [loaded, autoFocus, editor]);

  // --- Section links (M55.8) ------------------------------------------------
  // A `[[page#Heading]]` click asks the page for its heading (sectionLinks.ts).
  // Once the blocks are in, this editor takes the requests for its note: one
  // made before it mounted, then each as it is made. A heading it holds is
  // scrolled to and lit; one it does not is said, and the page stays put.
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!loaded || notePath === null) return;
    return watchSections(notePath, (section) => {
      const id = findSectionBlock(editor.document as SectionSourceBlock[], section);
      if (id === null) {
        toast(`No heading named "${section}" on this page`);
        return;
      }
      if (host.current !== null) revealBlock(host.current, id);
      setFlash((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
    });
  }, [loaded, notePath, editor, toast]);

  // --- Mention menus (M2.x docs polish) -----------------------------------
  // `[[` links a page (Obsidian habit); `@` links pages/people and sets due
  // dates on task lines. A pick replaces the trigger text with a chip. When
  // no page answers to the name typed, both menus end on a Create row that
  // makes the page and links it (M55.7); `@` offers it only where a word
  // starts, and only for a short name, not a sentence.

  const insertChip = (content: {
    type: 'wikilink' | 'assignee' | 'due';
    props: Record<string, string>;
  }) => {
    editor.insertInlineContent([content as never, ' ']);
    editor.focus();
  };

  // The `[[` flow: the menu triggers on the SECOND bracket (linkMenu.test.tsx
  // measures it), so its cleanup leaves the first `[` behind as text. Remove
  // it before inserting.
  const stripDanglingBracket = () => {
    try {
      const e = editor as unknown as {
        prosemirrorView?: { state: any; dispatch: (tr: any) => void };
        _tiptapEditor?: { view: { state: any; dispatch: (tr: any) => void } };
      };
      const view = e.prosemirrorView ?? e._tiptapEditor?.view;
      if (view === undefined) return;
      const { from } = view.state.selection;
      if (from > 0 && view.state.doc.textBetween(from - 1, from) === '[') {
        view.dispatch(view.state.tr.delete(from - 1, from));
      }
    } catch {
      // Leave the stray bracket; the chip still inserts correctly.
    }
  };

  const docItems = (opts?: { excludePeople?: boolean }): DefaultReactSuggestionItem[] =>
    entries
      .filter(isLinkableDoc)
      // The @ menu already lists people under "People" — repeating them in
      // "Link page" would render duplicate titles (and duplicate React keys).
      .filter((e) => !(opts?.excludePeople === true && isPerson(e)))
      .flatMap((e) => {
        const target = targetOf(e);
        if (target === null) return [];
        return [
          pageRow(
            {
              title: e.title,
              subtext: e.path,
              group: 'Link page',
              icon: <Icon name="file-text" size={14} />,
              onItemClick: () => insertChip({ type: 'wikilink', props: { target, alias: '' } }),
            },
            e.path,
          ),
        ];
      });

  /**
   * The `[` menu's rows for a section query (M55.8). With a page half, every
   * page it matches, each linking `<name>#<heading>` by `targetOf`'s name. With none, after `[[`,
   * one row for this note's own heading, linking `#<heading>`. No Create row:
   * a name with a `#` cannot be a page title (`creatableTitle`).
   */
  const sectionItems = ({ page, heading }: SectionQuery, double: boolean) => {
    const fragment = heading === null ? '' : `#${heading}`;
    if (page === '') {
      if (!double || heading === null || notePath === null) return [];
      const title = noteEntry?.title ?? linkTargetOfPath(notePath);
      return [
        {
          title: `${title} \u203A ${heading}`,
          subtext: `${notePath}${fragment}`,
          group: 'Link section',
          icon: <Icon name="hash" size={14} />,
          onItemClick: () =>
            insertChip({ type: 'wikilink', props: { target: fragment, alias: '' } }),
        },
      ];
    }
    const pages = entries.filter(isLinkableDoc).flatMap((e): DefaultReactSuggestionItem[] => {
      const target = targetOf(e, heading);
      if (target === null) return [];
      return [
        pageRow(
          {
            title: e.title,
            subtext: e.path,
            group: 'Link page',
            icon: <Icon name="file-text" size={14} />,
            onItemClick: () => insertChip({ type: 'wikilink', props: { target, alias: '' } }),
          },
          e.path,
        ),
      ];
    });
    // Ranked on the page half alone, then shown with the heading it links.
    return rankSuggestionItems(pages, page, { recency, pathOf: rowPathOf }).map((item) => ({
      ...item,
      subtext: `${item.subtext}${fragment}`,
    }));
  };

  /**
   * The `[^` menu (M52.1): cite one of the note's sources, or an id the page
   * already uses, numbered as the chip will be. Rides the `[` menu rather than
   * a trigger of its own — BlockNote reads a trigger one typed character at a
   * time, so `[^` could never open a menu that `[` had not already opened.
   */
  const citeItems = (): DefaultReactSuggestionItem[] =>
    citationChoices(sources, citationIndexOf(editor), entries).map(({ id, number, name }) => ({
      title: `${number} · ${name}`,
      subtext: id,
      group: 'Cite a source',
      icon: <Icon name="quote" size={14} />,
      onItemClick: () => {
        insertCitation(editor.prosemirrorView, id);
        editor.focus();
      },
    }));

  const personItems = (): DefaultReactSuggestionItem[] =>
    entries.filter(isPerson).flatMap((e) => {
      const target = targetOf(e);
      if (target === null) return [];
      return [
        pageRow(
          {
            title: e.title,
            subtext: 'Assign',
            group: 'People',
            icon: <Icon name="circle-user" size={14} />,
            onItemClick: () => insertChip({ type: 'assignee', props: { target } }),
          },
          e.path,
        ),
      ];
    });

  const dueItems = (): DefaultReactSuggestionItem[] =>
    [
      { title: 'Due today', days: 0 },
      { title: 'Due tomorrow', days: 1 },
      { title: 'Due next week', days: 7 },
    ].map(({ title, days }) => ({
      title,
      subtext: isoAfterDays(days),
      group: 'Due date',
      icon: <Icon name="calendar" size={14} />,
      onItemClick: () => insertChip({ type: 'due', props: { date: isoAfterDays(days) } }),
    }));

  /**
   * Make the page a Create row names, then link it where the caret was
   * (M55.7). `typed` is the trigger and query the menu cleared, put back if
   * the page cannot be made.
   *
   * The caret is tracked, not read when the write lands: the create awaits a
   * write and a rescan, and the author may move or keep typing meanwhile. The
   * chip goes in only after the write, so it carries the stem the backend
   * actually wrote. The editor is not focused afterwards: ProseMirror maps
   * the caret, past the chip when it sat where the chip goes, and along with
   * its text when the author has moved on.
   */
  const createAndLink = (title: string, typed: string) => {
    const at = trackPosition(editor, editor.prosemirrorState.selection.from);
    void createLinkedPage(title).then((path) => {
      if (!alive.current || readOnlyRef.current) return;
      try {
        editor.transact((tr) => {
          const pos = at();
          if (path === null) {
            tr.insertText(typed, pos);
            return;
          }
          tr.insert(
            pos,
            inlineContentToNodes<
              typeof cerebroSchema.inlineContentSchema,
              typeof cerebroSchema.styleSchema
            >(
              [{ type: 'wikilink', props: { target: linkTargetOfPath(path), alias: '' } }, ' '],
              editor.pmSchema,
            ),
          );
        });
      } catch {
        toast(`Couldn't link "${title}"`);
      }
    });
  };

  /**
   * A menu's last row: make a page by the name typed and link it (M55.7).
   * None when the text cannot be a page title, no vault is open, or a page
   * already answers to the name, since its own row links that page.
   */
  const createRow = (text: string, trigger: '[' | '@'): DefaultReactSuggestionItem | null => {
    const title = creatableTitle(text);
    if (title === null || vaultPath === null || resolveTarget(title, entries) !== null) return null;
    return {
      title: `Create "${title}"`,
      subtext: 'New page',
      group: 'New page',
      icon: <Icon name="file-plus" size={14} />,
      onItemClick: () => createAndLink(title, trigger === '[' ? `[[${text}` : `@${text}`),
    };
  };

  /** `rows`, then the Create row when there is one; one title per row still. */
  const withCreate = (
    rows: DefaultReactSuggestionItem[],
    create: DefaultReactSuggestionItem | null,
  ): DefaultReactSuggestionItem[] => (create === null ? rows : distinctTitles([...rows, create]));

  // Slash command for dates (M2.x feedback): inserts today as a rich date
  // chip — clicking the chip opens the full picker (range, format, time,
  // reminders).
  const dateSlashItem = (): DefaultReactSuggestionItem => ({
    title: 'Date',
    subtext: 'Insert a date — click it for range, time & reminders',
    group: 'Inline',
    aliases: ['date', 'due', 'calendar', 'today', 'reminder', 'remind'],
    icon: <Icon name="calendar" size={14} />,
    onItemClick: () => insertChip({ type: 'due', props: { date: isoAfterDays(0) } }),
  });

  /**
   * Focus a just-inserted block's own field: an AI block's question (M53.9),
   * a page card's "Find a page" (M55.14).
   *
   * The block asks first, so the field takes the caret rather than the
   * editor — `editor.focus()` here used to blur the AI block's field the
   * moment it had focus, and the blur closed it, leaving nothing to type into.
   * The node view mounts through a React portal, so the field may not exist on
   * the first try; it is looked for again on the next few frames.
   *
   * The field is the one in the block's OWN content, not one in a block nested
   * under it — and both depths are named because the browser wraps a React
   * block in an extra element that jsdom does not (DOM trap 1).
   */
  const focusBlockField = (id: string, type: string, tries = 10) => {
    const escape = (s: string) =>
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s;
    // An input, or the AI block's question, a Prompt Input's textarea (M91.14).
    const fields = ['input', 'textarea']
      .flatMap((tag) => {
        const content = `[data-content-type="${escape(type)}"] ${tag}`;
        return [`:scope > ${content}`, `:scope > * > ${content}`];
      })
      .join(', ');
    const field = host.current
      ?.querySelector(`.bn-block[data-id="${escape(id)}"]`)
      ?.querySelector<HTMLElement>(fields);
    if (field != null) {
      field.focus();
      return;
    }
    if (tries > 0) window.requestAnimationFrame(() => focusBlockField(id, type, tries - 1));
  };

  // Custom blocks (M2.x): AI block, callout, mermaid diagram, database, the
  // child-page list (M55.13), page card (M55.14) sheet (M67.3), and whiteboard (M68.5c).
  const insertBlockAtCursor = (block: { type: string; props?: Record<string, string> }) => {
    const cursor = editor.getTextCursorPosition().block;
    const inserted = editor.insertBlocks([block as never], cursor, 'after');
    const target = inserted[0];
    // BlockNote closes the menu and clears its `/query` BEFORE this callback
    // (SuggestionMenuWrapper: closeMenu, clearQuery, onItemClick). The cursor
    // is still placed on the next tick, once that close has finished handing
    // focus back, or typing continues in the old block.
    window.setTimeout(() => {
      if (
        target !== undefined &&
        (block.type === 'ai' || block.type === 'pageCard' || block.type === 'whiteboard')
      ) {
        focusBlockField(target.id, block.type);
        return;
      }
      if (target !== undefined && block.type === 'sheet') {
        const focus = (tries = 10) => {
          const block = host.current?.querySelector(`[data-id="${target.id}"]`);
          const grid = block?.querySelector<HTMLElement>('[data-testid="sheet-grid"]');
          if (grid) grid.focus();
          else if (tries > 0) requestAnimationFrame(() => focus(tries - 1));
        };
        requestAnimationFrame(() => focus());
        return;
      }
      if (target !== undefined && block.type === 'callout') {
        editor.setTextCursorPosition(target, 'start');
      }
      editor.focus();
    }, 0);
  };

  const blockSlashItems = (): DefaultReactSuggestionItem[] => [
    {
      title: 'Whiteboard',
      subtext: 'Show a whiteboard with Open',
      group: 'Advanced blocks',
      aliases: ['whiteboard', 'canvas', 'board', 'sketch'],
      icon: <Icon name="presentation" size={14} />,
      onItemClick: () => insertBlockAtCursor({ type: 'whiteboard', props: { source: '' } }),
    },

    {
      title: 'Sheet',
      subtext: 'A grid with formulas, saved on this page',
      group: 'Advanced blocks',
      aliases: ['sheet', 'spreadsheet', 'grid', 'cells', 'formula', 'excel'],
      icon: <Icon name="sheet" size={14} />,
      onItemClick: () => {
        const names = sheetNames(
          sheetSourcesOf(editor.document).map((sheet) => parseSheetFence(sheet.source)),
        );
        insertBlockAtCursor({
          type: 'sheet',
          props: { source: newSheetSource(nextSheetName(names)) },
        });
      },
    },
    {
      title: 'AI block',
      subtext: 'A standing question — a summary, the open questions — you can ask again',
      group: 'Advanced blocks',
      aliases: ['ai', 'summary', 'summarise', 'summarize', 'questions', 'actions'],
      icon: <Icon name="sparkles" size={14} />,
      onItemClick: () => insertBlockAtCursor({ type: 'ai', props: { prompt: '', generated: '' } }),
    },
    {
      title: 'Callout',
      subtext: 'Highlighted note — info, tip, warning…',
      group: 'Advanced blocks',
      aliases: ['callout', 'info', 'note', 'tip', 'warning', 'danger', 'aside'],
      icon: <Icon name="megaphone" size={14} />,
      onItemClick: () => insertBlockAtCursor({ type: 'callout', props: { kind: 'info' } }),
    },
    {
      title: 'Mermaid diagram',
      subtext: 'Flowcharts, sequences, gantt — rendered from text',
      group: 'Advanced blocks',
      aliases: ['mermaid', 'diagram', 'flowchart', 'chart', 'graph', 'sequence'],
      icon: <Icon name="waypoints" size={14} />,
      onItemClick: () => insertBlockAtCursor({ type: 'mermaid', props: { code: '' } }),
    },
    {
      // M47.3, Door 1 of the spec's two: show a database that already exists.
      // Inserted UNSET and asks in place, the way Notion does — a modal that
      // demanded the answer before the block existed would be the New-list
      // dialog again, which is the ceremony this milestone is deleting.
      title: 'Database',
      subtext: 'Show a database here — open it full page from the block',
      group: 'Advanced blocks',
      aliases: ['database', 'table', 'list', 'records', 'view', 'embed', 'inline'],
      icon: <Icon name="table-2" size={14} />,
      onItemClick: () =>
        insertBlockAtCursor({ type: 'database', props: { database: '', view: '' } }),
    },
    {
      // M55.13 — the page's sub-pages, listed live. It lists; it never
      // creates one, which is the page menu's "Add sub-page".
      title: 'Sub-pages',
      subtext: 'List the pages inside this one',
      group: 'Advanced blocks',
      aliases: ['subpages', 'children', 'child pages', 'contents'],
      icon: <Icon name="list-tree" size={14} />,
      onItemClick: () => insertBlockAtCursor({ type: 'subPages' }),
    },
    {
      // M55.14 — a card for a page that already exists. It links; it never
      // creates one (Q28), which is the page menu's "Add sub-page".
      title: 'Page',
      subtext: 'Show another page here, live — open it from the card',
      group: 'Advanced blocks',
      aliases: ['page', 'link to page', 'embed page', 'card'],
      icon: <Icon name="file-symlink" size={14} />,
      onItemClick: () =>
        insertBlockAtCursor({ type: 'pageCard', props: { target: '', alias: '' } }),
    },
  ];

  /**
   * Columns in the `/` menu (M48.3), the way Notion spells them: N columns to
   * make an empty layout, and "Turn into" to move the block you are standing
   * in INTO one.
   *
   * The pair matters. Making an empty layout and then dragging a paragraph
   * into it is two operations for the thing people actually want, which is
   * "put this beside that". Turn-into is the one-step version, and it is the
   * one the screenshot that started this milestone was open on.
   *
   * Nothing is offered at all inside a column (spec D6). A menu entry that
   * does nothing is worse than one that is not there.
   */
  const columnSlashItems = (): DefaultReactSuggestionItem[] => {
    const cursor = editor.getTextCursorPosition().block;
    if (!canInsertColumnsAt(editor.document as PartialBlock[], cursor.id)) return [];
    const insert = (count: number, turnInto: boolean) => () => {
      const at = editor.getTextCursorPosition().block;
      const moved = turnInto ? (JSON.parse(JSON.stringify(at)) as PartialBlock) : undefined;
      const list = newColumnList(count, moved);
      const inserted = editor.insertBlocks([list as never], at, 'after');
      // The block moved INTO the layout is still sitting above it — remove the
      // original, or turn-into silently duplicates what it moved.
      if (turnInto) editor.removeBlocks([at]);
      // The `/2 columns` query is already gone — BlockNote clears it before
      // this callback — so the copy above holds only the block's own text.
      // Finish placement after the menu closes, before the browser can
      // dispatch the next key. A timer left the first typed character in the
      // preceding block under load.
      queueMicrotask(() => {
        const firstColumn = (inserted[0] as { children?: { children?: unknown[] }[] })
          ?.children?.[0];
        const landing = firstColumn?.children?.[0];
        if (landing !== undefined) {
          editor.setTextCursorPosition(landing as never, turnInto ? 'end' : 'start');
        }
        editor.focus();
      });
    };
    return COLUMN_COUNTS.flatMap((count) => [
      {
        title: `${count} columns`,
        subtext: 'An empty side-by-side layout',
        group: 'Layout',
        aliases: ['columns', 'column', 'col', `${count}col`, `${count}columns`, 'side by side'],
        // lucide has a shape per count up to 4; 5 borrows the 4-column glyph
        // rather than showing a generic one, because the icons in this menu
        // are how you pick without reading.
        icon: <Icon name={`columns-${Math.min(count, 4)}`} size={14} />,
        onItemClick: insert(count, false),
      },
      {
        title: `${count} columns · Turn into`,
        subtext: 'Move this block into the first column',
        group: 'Layout',
        aliases: ['columns', 'column', 'col', 'turn into', 'wrap'],
        icon: <Icon name={`columns-${Math.min(count, 4)}`} size={14} />,
        onItemClick: insert(count, true),
      },
    ]);
  };

  // --- Templates in the slash menu (M2.x feedback) ------------------------

  const templates = listTemplates(entries);

  const insertTemplateAtCursor = async (template: Entry) => {
    if (vaultPath === null) return;
    try {
      const raw = await readNote(vaultPath, template.path);
      const docTitle =
        buildOutline(editor.document).find((i) => i.level === 1)?.text ??
        templateDisplayName(template);
      const substituted = raw.replaceAll('{{title}}', docTitle).replaceAll('{{date}}', todayIso());
      // Drop the template's own H1 — a second H1 mid-document is noise.
      const lines = substituted.split('\n');
      const h1 = lines.findIndex((l) => l.trim().startsWith('# '));
      if (h1 >= 0) lines.splice(h1, 1);
      const blocks = await markdownToBlocks(editor, `${lines.join('\n').trim()}\n`);
      if (blocks.length === 0) return;
      editor.insertBlocks(blocks as never[], editor.getTextCursorPosition().block, 'after');
    } catch {
      toast("Couldn't insert template");
    }
  };

  const templateSlashItems = (): DefaultReactSuggestionItem[] =>
    templates.map((t) => ({
      title: `Template: ${templateDisplayName(t)}`,
      subtext: t.path,
      group: 'Advanced blocks',
      aliases: ['template', templateDisplayName(t).toLowerCase()],
      icon: <Icon name="layout-template" size={14} />,
      onItemClick: () => void insertTemplateAtCursor(t),
    }));

  // --- Assign-task dialog (M2.x feedback) ---------------------------------

  const people = entries.filter(isPerson);

  const openAssignDialog = (blockId: string) => {
    const block = editor.getBlock(blockId);
    if (!block) return;
    const { assignees } = splitTaskContent(block.content);
    const existingDue = Array.isArray(block.content)
      ? (block.content.find((c) => (c as { type?: string }).type === 'due') as
          { props?: { date?: string } } | undefined)
      : undefined;
    setAssignee(assignees[0] ?? '');
    setDueDate(existingDue?.props?.date ?? '');
    // Anchor the popover to the task line itself.
    const escape =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(blockId)
        : blockId.replace(/["\\]/g, '\\$&');
    const rect = document.querySelector(`[data-id="${escape}"]`)?.getBoundingClientRect();
    const width = 300;
    const height = 190;
    const x = Math.max(8, Math.min(rect?.left ?? 80, window.innerWidth - width - 12));
    const y = Math.max(8, Math.min((rect?.bottom ?? 80) + 6, window.innerHeight - height - 12));
    setAssign({ blockId, x, y });
  };

  const submitAssign = () => {
    if (assign === null) return;
    const block = editor.getBlock(assign.blockId);
    setAssign(null);
    if (!block) return;
    const { rest } = splitTaskContent(block.content);
    // Drop trailing whitespace-only text nodes, then re-add chips at the end.
    while (rest.length > 0) {
      const last = rest[rest.length - 1] as { type?: string; text?: string };
      if (last.type === 'text' && typeof last.text === 'string' && last.text.trim() === '') {
        rest.pop();
      } else break;
    }
    const additions: unknown[] = [];
    const already = rest.some(
      (c) =>
        (c as { type?: string; props?: { target?: string } }).type === 'assignee' &&
        (c as { props?: { target?: string } }).props?.target === assignee,
    );
    if (assignee !== '' && !already) {
      additions.push({ type: 'assignee', props: { target: assignee } });
    }
    if (dueDate !== '') additions.push({ type: 'due', props: { date: dueDate } });
    const spaced = additions.flatMap((a) => [' ', a]);
    editor.updateBlock(block, { content: [...rest, ...spaced] as never });
  };

  /**
   * Answer an AI block (M17.18).
   *
   * The block dispatches an event rather than calling the agent itself, so
   * blocks.tsx stays free of app state and can be rendered in a test with no
   * store behind it. The run is granted no tools for the same reason a rewrite
   * is (M17.16): it transforms text that is already in the prompt, and a run
   * that could call open_note would navigate the reader away from the block
   * they are watching.
   *
   * While the answer is written the block is marked running (aiBlockRuns.ts,
   * M91.14), which it draws as working, from the ask until the answer lands
   * or the run ends without one; a second ask meanwhile is refused, since
   * two answers would race for the same children.
   */
  useEffect(() => {
    const onRun = (event: Event) => {
      const { id, prompt } = (event as CustomEvent<{ id: string; prompt: string }>).detail;
      if (vaultPath === null || prompt.trim() === '') return;
      const block = editor.getBlock(id);
      if (block === undefined || isAiBlockRunning(editor, id)) return;
      setAiBlockRunning(editor, id, true);
      const settled = () => setAiBlockRunning(editor, id, false);
      void (async () => {
        try {
          const document = await blocksToMarkdown(editor);
          // Attended, no lane: never gated — startedOrThrow makes a contract
          // break visible instead of a silent no-run.
          const { run: runId } = startedOrThrow(
            await runAgent(vaultPath, {
              message: [
                `Answer this about the document below: ${prompt.trim()}`,
                '',
                'Return only the answer, as markdown, with no preamble and no code fence.',
                'If the document does not support an answer, say that in one line rather than inventing one.',
                '',
                document,
              ].join('\n'),
              systemPrompt:
                'You answer a standing question about a document the user is writing. Return only the answer.',
              sessionId: null,
              model: null,
              shell: 'off',
              connectors: false,
              attended: true,
              allowedTools: [],
            }),
          );
          let text = '';
          const stop = onAgentEvent((e) => {
            if (e.kind === 'TextDelta') text += e.text;
            if (e.kind === 'Result' && e.text.trim() !== '') text = e.text;
            if (e.kind === 'Error') {
              toast(e.message);
              stop();
              settled();
            }
            if (e.kind === 'Done') {
              stop();
              const clean = unwrapReplyFence(text);
              if (editor.getBlock(id) === undefined || clean === '') {
                settled();
                return;
              }
              // The answer is markdown, and it becomes the block's children
              // read the way the file will read it back (M53.9) — a list is a
              // list, a [[link]] a chip — so what is on screen now is what
              // the next open shows. A line in it that would read as a
              // container marker is escaped first: the reply is the answer's
              // text, never the page's structure, and the prompt above hands
              // the run the page's own carrier lines to echo.
              markdownToBlocks(editor, escapeMarkerLines(clean))
                .then((answer) => {
                  const current = editor.getBlock(id);
                  if (current === undefined) return;
                  // One edit, so it is one undo step and one save — the same
                  // reason the rewrite is not streamed in. An answer the
                  // parser made nothing of is kept as the text it was:
                  // `children: []` would leave the OLD answer under a new date.
                  editor.updateBlock(current, {
                    props: { prompt, generated: todayIso() },
                    children: answer.length > 0 ? answer : [{ type: 'paragraph', content: clean }],
                  } as never);
                  scheduleEmit();
                })
                .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err)))
                .finally(settled);
            }
          }, runId);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
          settled();
        }
      })();
    };
    window.addEventListener('cerebro:ai-block-run', onRun);
    return () => window.removeEventListener('cerebro:ai-block-run', onRun);
    // `scheduleEmit` is deliberately not a dep: it is redefined every render
    // (it closes over the debounce timer), and listing it would tear down and
    // re-add the listener on every keystroke. The handler only calls it, and
    // the version it captures debounces onto the same ref either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, vaultPath, toast]);

  // Cmd/Ctrl-K over a selection. Bound on the container rather than the
  // window so it only fires for the editor that has focus — two editors are on
  // screen at once whenever the record panel is open beside a doc.
  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    if (readOnly) return;
    // The find bar sits inside this host, and the browser reports text
    // selected in its <input> through window.getSelection(): without this,
    // ⌘K on a selected query would ask AI to rewrite the query, and Apply
    // would insert into the bar's React-owned DOM (M59.6).
    if (
      e.target instanceof Element &&
      e.target.closest('[data-testid="find-bar"], .cb-page-editor-chrome') !== null
    ) {
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      // Portalled controls still bubble through this React host. Only the
      // native editor, never its active contextual tool, owns block actions.
      if (
        exclusiveTool ||
        !(e.target instanceof Element) ||
        e.target.closest('.bn-editor') !== editor.domElement ||
        e.target.closest('input, textarea, select, [contenteditable="false"]') !== null
      )
        return;
      const block = editor.getTextCursorPosition().block;
      const anchor = host.current?.querySelector<HTMLElement>(
        `[data-id="${block.id}"] .bn-block-content`,
      );
      if (anchor !== undefined && anchor !== null) {
        e.preventDefault();
        e.stopPropagation();
        setKeyboardBlock({ id: block.id, anchor });
      }
      return;
    }
    if (e.key !== 'k' || !(e.metaKey || e.ctrlKey)) return;
    if (
      exclusiveTool ||
      !(e.target instanceof Element) ||
      e.target.closest('.bn-editor') !== editor.domElement ||
      editor.prosemirrorState.selection.empty
    )
      return;
    e.preventDefault();
    askFromToolbar();
  };

  /**
   * Open the rewrite surface from the toolbar.
   *
   * Capture the editor's selection before the contextual input takes focus.
   * WebKit may collapse its DOM range when a toolbar button receives the
   * pointer, while ProseMirror still owns the person's exact text selection.
   */
  const askFromToolbar = (preset?: Preset) => {
    if (readOnlyRef.current) return;
    const {
      doc,
      selection: { from, to },
    } = editor.prosemirrorState;
    if (from === to) return;
    const text = editor.getSelectedText();
    if (text.trim() === '') return;
    const start = editor.prosemirrorView.domAtPos(from);
    const end = editor.prosemirrorView.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    target.current = {
      text,
      from,
      to,
      doc,
      version: selectionVersion.current,
      current: captureAttachmentOwner(),
    };
    // Read geometry before decorating: holding the selection can replace the
    // text nodes and detach the temporary DOM range used only for positioning.
    const rect = range.getBoundingClientRect();
    editor.getExtension(HeldSelection)?.hold();
    setAsking({
      text,
      x: rect.left,
      y: rect.bottom + 8,
      preset: preset?.instruction,
    });
  };

  const selectionIsCurrent = () => {
    const captured = target.current;
    if (captured === null || !captured.current() || readOnlyRef.current) return false;
    const { doc } = editor.prosemirrorState;
    return (
      doc === captured.doc &&
      selectionVersion.current === captured.version &&
      captured.from < captured.to &&
      captured.to <= doc.content.size &&
      doc.textBetween(captured.from, captured.to) === captured.text
    );
  };

  /** One editor transaction, through the existing guarded save and Undo path. */
  const replaceSelection = (text: string): SelectionApplyResult => {
    if (!selectionIsCurrent()) return { kind: 'conflict' };
    const captured = target.current!;
    target.current = null;
    if (text === captured.text) return { kind: 'unchanged' };
    inPlace(editor, () => {
      editor.transact((tr) => tr.insertText(text, captured.from, captured.to));
    });
    return { kind: 'applied' };
  };

  const finishPromotion = (results: PromotionResult[]): PromotionResult[] => {
    const created = results.filter(
      (result): result is Extract<PromotionResult, { outcome: 'created' }> =>
        result.outcome === 'created',
    );
    let linked = new Set<string>();
    if (alive.current && !readOnlyRef.current && notePath !== null) {
      try {
        linked = linkPromotedLines(editor, created);
        if (linked.size > 0) scheduleEmit();
      } catch {
        // The records exist. Report that their source could not be linked,
        // rather than pretending the creates failed or retrying them.
      }
    }
    return results.map((result) =>
      result.outcome === 'created' && !linked.has(result.line.blockId)
        ? {
            ...result,
            notes: [
              ...result.notes,
              "The record exists, but the line changed, so it wasn't linked.",
            ],
          }
        : result,
    );
  };

  return (
    <div
      ref={setEditorHost}
      data-os-drop="editor"
      data-os-drag-over={attachmentZone.over || undefined}
      data-testid="markdown-editor"
      className={`cerebro-editor min-h-0 flex-1${pageTitle === undefined ? '' : ' cb-page-editor'}`}
      onKeyDown={onEditorKeyDown}
    >
      {loaded && <FindBar editor={editor} host={host} readOnly={readOnly} />}
      {loaded && (
        <AttachmentUploadContext.Provider value={prepareAttachment}>
          <BlockNoteView
            editor={editor}
            theme="light"
            editable={!readOnly}
            onChange={scheduleEmit}
            sideMenu={false}
            slashMenu={false}
            filePanel={false}
            // M18: ours replaces it (AI first, then everything it would have
            // rendered). Left on, BlockNote mounts a SECOND controller and two
            // toolbars stack on the same selection.
            formattingToolbar={false}
            linkToolbar={!exclusiveTool}
            tableHandles={!exclusiveTool}
          >
            <FilePanelController filePanel={AttachmentFilePanel} />
            <SuggestionMenuController
              triggerCharacter="@"
              getItems={async (query) => {
                // Ranked within each group — People, Link page, Due date — and
                // the groups stay contiguous in that order (M59.3).
                const rows = rankSuggestionItems(
                  [...personItems(), ...docItems({ excludePeople: true }), ...dueItems()],
                  query,
                  { recency, pathOf: rowPathOf },
                );
                // Create only where a mention starts: `ana@example.com` is an
                // address, and the `@` in `meet @ 5pm` names nothing. And only
                // while the query could be a name: past that the row goes, so
                // the menu closes and Enter ends the line (`mentionNamesPage`).
                const starts =
                  !/^\s/.test(query) &&
                  mentionNamesPage(query) &&
                  mentionAtWordStart(charBeforeTrigger(editor.prosemirrorState, query, '@'));
                return withCreate(rows, starts ? createRow(query, '@') : null);
              }}
            />
            <SuggestionMenuController
              triggerCharacter="["
              getItems={async (query) => {
                const asked = readLinkQuery(
                  query,
                  charBeforeTrigger(editor.prosemirrorState, query, '['),
                );
                if (asked.kind === 'cite') {
                  const cites = filterItems(citeItems(), asked.text);
                  // Nothing to cite — a page with no sources and no footnotes,
                  // or an id nobody has used yet. Closed rather than shown empty:
                  // an open menu swallows Enter, and the author is typing a
                  // marker that its `]` will turn into a chip.
                  if (cites.length === 0) closeLinkMenu.current();
                  return cites;
                }
                // A `]` ends the link being typed. Closed for the same reason: an
                // open menu would swallow the Enter that starts the next line.
                if (asked.kind === 'closed') {
                  closeLinkMenu.current();
                  return [];
                }
                // Create only after `[[`; a lone `[` is a bracket. Every row,
                // Create included, strips the first bracket before it inserts, so
                // Create tracks the caret with the bracket already gone. A `#`
                // asks for a section, which offers no Create row (M55.8).
                const create =
                  asked.double && asked.section === null ? createRow(asked.text, '[') : null;
                const rows =
                  asked.section === null
                    ? rankSuggestionItems(docItems(), asked.text, { recency, pathOf: rowPathOf })
                    : sectionItems(asked.section, asked.double);
                return withCreate(rows, create).map((item) => ({
                  ...item,
                  onItemClick: () => {
                    stripDanglingBracket();
                    item.onItemClick?.();
                  },
                }));
              }}
            />
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) =>
                // BlockNote's entries less DROPPED_SLASH_KEYS, then ours: the
                // date, columns, Cerebro's blocks and per-template inserts.
                filterItems(
                  slashMenuItems(
                    editor,
                    [
                      dateSlashItem(),
                      ...columnSlashItems(),
                      ...blockSlashItems(),
                      ...templateSlashItems(),
                    ],
                    () => {
                      const id = editor.getTextCursorPosition().block.id;
                      const anchor = host.current?.querySelector<HTMLElement>(
                        `[data-id="${id}"] .bn-block-content`,
                      );
                      // The slash command's Enter must finish before the picker
                      // can own its next Enter.
                      if (anchor) window.setTimeout(() => setTablePicker(anchor), 0);
                    },
                  ),
                  query,
                )
              }
            />
            {/* M86: formatting leads the editor's own selection toolbar. A
              second floating bar beside BlockNote's fought it for the same few
              pixels on every selection. */}
            {!readOnly && !exclusiveTool && (
              <AiFormattingToolbar
                onAsk={askFromToolbar}
                onPromote={
                  notePath !== null && selectionPromotable
                    ? () => {
                        const lines = promotable(
                          editor.getSelection()?.blocks ?? [],
                          entries,
                          notePath,
                        );
                        if (lines.length > 0) setPromoting(lines);
                      }
                    : undefined
                }
              />
            )}
            <SideMenuController
              sideMenu={(props) => (
                <SideMenu {...props}>
                  <AssignTaskButton onOpen={openAssignDialog} />
                  <AddBlockButton />
                  {/* M48.4: ours, not BlockNote's `DragHandleButton`. Same
                    position, same click-opens-the-menu behaviour; a drag that
                    a test can drive and a drop that can land in a column. The
                    menu it opens holds only what a save keeps (M55.15), plus
                    Promote on a checklist line (M61.7). */}
                  <BlockGripButton
                    hostRef={host}
                    sideMenu={<DragHandleButton {...props} dragHandleMenu={dragHandleMenu} />}
                  />
                </SideMenu>
              )}
            />
          </BlockNoteView>
        </AttachmentUploadContext.Provider>
      )}
      {promoting !== null && !readOnly && notePath !== null && (
        <PromoteDialog
          lines={promoting}
          source={noteEntry ?? null}
          onClose={() => setPromoting(null)}
          onCreated={finishPromotion}
        />
      )}
      {keyboardBlock !== null && !readOnly && (
        <KeyboardBlockMenu
          editor={editor}
          blockId={keyboardBlock.id}
          anchor={keyboardBlock.anchor}
          onClose={() => {
            setKeyboardBlock(null);
            editor.focus();
          }}
          onAssign={
            editor.getBlock(keyboardBlock.id)?.type === 'checkListItem'
              ? () => {
                  openAssignDialog(keyboardBlock.id);
                  setKeyboardBlock(null);
                }
              : undefined
          }
          onPromote={
            notePath !== null && editor.getBlock(keyboardBlock.id)?.type === 'checkListItem'
              ? () => {
                  const block = editor.getBlock(keyboardBlock.id);
                  if (block !== undefined) setPromoting(promotable([block], entries, notePath));
                  setKeyboardBlock(null);
                }
              : undefined
          }
        />
      )}
      {tablePicker !== null && !readOnly && (
        <TableSizePicker
          anchor={tablePicker}
          onInsert={(rows, columns) => {
            setTablePicker(null);
            inPlace(editor, () => insertTable(editor, rows, columns));
            editor.focus();
          }}
          onContinueTyping={(text) => {
            setTablePicker(null);
            editor.insertInlineContent(text);
            editor.focus();
          }}
          onClose={() => {
            setTablePicker(null);
            editor.focus();
          }}
        />
      )}
      {flash !== null && (
        <SectionFlash
          key={flash.n}
          hostRef={host}
          blockId={flash.id}
          onDone={() => setFlash(null)}
        />
      )}
      {asking !== null && (
        <span className="fixed" style={{ left: asking.x, top: asking.y }}>
          <Popover
            role="group"
            ariaLabel="Selection actions"
            trapFocus
            onClose={() => {
              setAsking(null);
              editor.focus();
            }}
          >
            <AskAiPopover
              selection={asking.text}
              preset={asking.preset}
              onReplace={replaceSelection}
              isCurrent={selectionIsCurrent}
              onClose={() => {
                setAsking(null);
                editor.focus();
              }}
            />
          </Popover>
        </span>
      )}
      {assign !== null && (
        // Anchored popover, not a modal — it floats beside the task line
        // (Google-Docs-style). The transparent backdrop only catches
        // click-outside; nothing dims.
        <div
          className="fixed inset-0 z-40"
          onMouseDown={() => setAssign(null)}
          onWheel={(e) => {
            if (e.target === e.currentTarget) setAssign(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAssign(null);
          }}
        >
          <div
            role="dialog"
            aria-label="Assign task"
            data-testid="assign-task-popover"
            className="absolute flex w-[300px] flex-col gap-2 rounded-xl border border-n-200 bg-n-0 p-3 shadow-[0_8px_28px_rgba(22,26,36,0.16)]"
            style={{ left: assign.x, top: assign.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Icon name="user-round-plus" size={14} color="var(--n-500)" />
              <span className="text-sm font-semibold text-n-800">Assign task</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-none text-xs text-n-500">Assignee</span>
              <Dropdown
                size="sm"
                label="Assignee"
                width="100%"
                options={[
                  { value: '', label: 'Nobody' },
                  ...people.flatMap((p) => {
                    const value = targetOf(p);
                    return value === null ? [] : [{ value, label: p.title }];
                  }),
                ]}
                value={assignee}
                onChange={setAssignee}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-none text-xs text-n-500">Due</span>
              <input
                type="date"
                autoFocus
                aria-label="Due date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAssign();
                }}
                className="h-7 flex-1 rounded-md border border-n-200 px-2 text-sm text-n-800"
              />
            </div>
            <div className="mt-0.5 flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setAssign(null)}
                className="h-7 rounded-md border-0 bg-transparent px-2 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAssign}
                className="h-7 rounded-md border-0 bg-action-primary px-2.5 text-xs font-medium text-on-action-primary hover:bg-action-primary-hover active:bg-action-primary-press"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
