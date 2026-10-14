import '@blocknote/mantine/style.css';
import './editor.css';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  BlockNoteSchema,
  createCodeBlockSpec,
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
import { canInsertColumnsAt, COLUMN_COUNTS, newColumnList } from './columnCommands';
import { codeBlockOptions } from '@blocknote/code-block';
import { onAgentEvent, runAgent, startedOrThrow } from '@/agent/agentIpc';
import { createLinkedPage } from '@/app/listActions';
import { AskAiPopover } from '@/editor/AskAiPopover';
import { AiFormattingToolbar, CarriedBlockMenu, type Preset } from '@/editor/SelectionToolbar';
import { BlockNoteView } from '@blocknote/mantine';
import {
  AddBlockButton,
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
import { peopleTypes } from '@/engine/properties';
import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { readNote } from '@/lib/ipc';
import { isTemplate, listTemplates, templateDisplayName, todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import {
  AiBlock,
  CalloutBlock,
  ColumnBlock,
  ColumnListBlock,
  DatabaseBlock,
  leaveAiAnswer,
  MermaidBlock,
} from './blocks';
import { AssigneeChip, CitationChip, DueChip, WikilinkChip } from './chips';
import { citationPasteHandler, citationTextInput, insertCitation } from './citationInput';
import { citationChoices, citationIndexOf } from './citations';
import { buildOutline } from './DocOutline';
import {
  charBeforeTrigger,
  creatableTitle,
  mentionAtWordStart,
  readLinkQuery,
  stemOfPath,
} from './linkMenu';
import {
  blocksToMarkdown,
  escapeMarkerLines,
  lossyImportCause,
  markdownToBlocks,
  type LossyCause,
  unwrapReplyFence,
} from './markdown';
import { NotePathContext } from './notePath';

/**
 * The fully-featured code block (shiki highlighting, the full language list),
 * whose language is empty until someone picks one (M55.15). The package's
 * default is `javascript`, so a bare fence reopened as a JavaScript fence:
 * the save wrote a word the file never had, and the lossy-import check locked
 * the page for it. Empty is what a bare fence means, and the serializer writes
 * it back bare; the picker shows it as Plain Text.
 */
const codeBlockSpec = createCodeBlockSpec({ ...codeBlockOptions, defaultLanguage: '' });

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

// Default schema with that code block swapped in, plus the Cerebro custom
// blocks (AI block, callout, columns, database, mermaid) and inline chips:
// wikilinks, assignees, dates, and footnote citations (M2.x, M47.2, M48.1,
// M51.5).
export const cerebroSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: codeBlockSpec,
    ai: AiBlock(),
    callout: CalloutBlock(),
    column: ColumnBlock(),
    columnList: ColumnListBlock(),
    database: DatabaseBlock(),
    mermaid: MermaidBlock(),
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
const insertTable = (editor: CerebroEditor): void => {
  insertOrUpdateBlockForSlashMenu(editor, {
    type: 'table',
    content: {
      type: 'tableContent',
      headerRows: 1,
      rows: [{ cells: ['', '', ''] }, { cells: ['', '', ''] }],
    },
  });
};

/** The `/` menu: BlockNote's entries less DROPPED_SLASH_KEYS, then `ours`. */
export function slashMenuItems(
  editor: CerebroEditor,
  ours: DefaultReactSuggestionItem[] = [],
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
        item.key === 'table' ? { ...item, onItemClick: () => insertTable(editor) } : item,
      ),
    ...ours,
  ];
}

const stem = (e: Entry): string => e.filename.replace(/\.md$/, '');

// M12.1: anything that is content can be linked — docs AND records. Only the
// schema itself and stationery stay out of the `[[` picker.
const isLinkableDoc = (e: Entry): boolean => e.type !== 'Type' && !isTemplate(e);

/** Case-insensitive title/subtext/alias filter (filterSuggestionItems isn't
 * exported by @blocknote/core 0.46). */
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

/**
 * One title per menu row (M52.1).
 *
 * BlockNote keys a suggestion row by its TITLE, so two pages with one title —
 * the demo vault's knowledge index and its Knowledge agent — were two rows
 * with one key, and React, reconciling the list as it changed, left one
 * behind. MEASURED: typing `[^` on a concept showed a stale "Knowledge" link
 * row above the sources it offered, and clicking it would have linked a page.
 * A repeat takes an invisible suffix: the rows read the same, and their
 * subtext already tells them apart.
 */
function distinctTitles(items: DefaultReactSuggestionItem[]): DefaultReactSuggestionItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const repeats = seen.get(item.title) ?? 0;
    seen.set(item.title, repeats + 1);
    return repeats === 0 ? item : { ...item, title: item.title + '\u200B'.repeat(repeats) };
  });
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
        editor.removeBlocks([moving]);
        editor.insertBlocks([moving as never], target, spot.placement);
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
   * remount with a `key` to load a different document.
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
   * Fires once the document is loaded. `lossyCause` says how the parse
   * round trip changed the file's text (raw HTML dropped, other text dropped,
   * text added or reordered), or is null when it kept it; consumers open such
   * a page read-only and name the cause before edits overwrite the file.
   *
   * `flushPendingSave` / `cancelPendingSave` let the owner take control of the
   * debounce. Flush before a deliberate save (⌘S) or before an agent turn
   * starts (M53.6): it emits a pending edit, and its promise settles once
   * `onChange`'s has, including a save the debounce had already started. It
   * never rejects. Cancel before the file is written out of band (template
   * apply) or the buffer is discarded for the disk's version, so the stale
   * in-editor body can't be written back over it.
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
}

export interface EditorReadyInfo {
  editor: CerebroEditor;
  lossyCause: LossyCause | null;
  flushPendingSave: () => Promise<void>;
  cancelPendingSave: () => void;
}

export function MarkdownEditor({
  markdown,
  onChange,
  onReady,
  debounceMs = 500,
  autoFocus = false,
  readOnly = false,
  onDirty,
}: MarkdownEditorProps) {
  // Filled in below, once the editor exists: the typed-citation rule needs the
  // editor to close the link menu a marker's `[` opened, and it is handed to
  // TipTap before there is an editor to close anything on.
  const closeLinkMenu = useRef(() => {});
  // The same, for the Enter that leaves an AI block's answer (M53.9).
  const leaveAnswer = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const editor = useCreateBlockNote({
    schema: cerebroSchema,
    tables: TABLE_SETTINGS,
    _tiptapOptions: {
      editorProps: {
        // M52.1: a hand-typed `[^id]` becomes a chip as its `]` lands.
        handleTextInput: citationTextInput(() => closeLinkMenu.current()),
        // M53.9: Enter at the end of an AI block's answer starts a paragraph
        // after the block (`leaveAiAnswer`). A view prop runs before every
        // keymap, and an open suggestion menu takes its Enter before the view
        // sees it at all; only a key typed into the page itself is ours, not
        // one typed into a field inside a block.
        handleKeyDown: (view, event) => event.target === view.dom && leaveAnswer.current(event),
      },
    },
    // M52.4: pasted markdown keeps its footnotes as the markers they are.
    pasteHandler: citationPasteHandler,
  });
  closeLinkMenu.current = () => editor.getExtension(SuggestionMenu)?.closeMenu();
  leaveAnswer.current = (event) => leaveAiAnswer(editor, event);
  // M48.4 — what the block drag measures against. The editor's own host
  // element, so a drop can be resolved against every rendered block including
  // the ones inside columns.
  const host = useRef<HTMLDivElement | null>(null);
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  // Who the @ menu offers. This was `e.type === 'Person'` in three places
  // (M16.13b) — the type-name routing AGENTS.md forbids, and the reason a
  // vault whose people are `Teammate`s had an @ menu with no people in it.
  // There is no FieldDef here to read a target off, so the schema answers:
  // the types every person field points at.
  const peopleSet = useMemo(() => peopleTypes(schema, entries), [schema, entries]);
  const isPerson = useCallback((e: Entry) => e.type !== null && peopleSet.has(e.type), [peopleSet]);
  const toast = useUiStore((s) => s.toast);
  // The note this body belongs to, for the sources its frontmatter lists — what
  // the `[^` menu offers first (M52.1). Null outside a NoteBodyEditor, where
  // the page's own footnotes are all there is to cite.
  const notePath = useContext(NotePathContext);
  const noteEntry = notePath === null ? undefined : entries.find((e) => e.path === notePath);
  const sources = useMemo(
    () => (noteEntry === undefined ? [] : parseSources(noteEntry)),
    [noteEntry],
  );
  const [loaded, setLoaded] = useState(false);
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
  /**
   * The range the rewrite will replace, cloned when the popover OPENS.
   *
   * Not read back at apply time. Opening the popover moves focus into its
   * input, which collapses the document selection — so by the time there is a
   * decision to apply, `window.getSelection()` describes the text box the user
   * typed the instruction into, not the passage they picked. A cloned Range
   * keeps live node references, so it survives the editor re-rendering around
   * an untouched passage.
   */
  const target = useRef<Range | null>(null);
  // Assign-task popover (M2.x feedback): opened from the checklist row's
  // side-menu button, floats NEXT TO the task line (not a modal); writes
  // assignee/due chips into that block.
  const [assign, setAssign] = useState<{ blockId: string; x: number; y: number } | null>(null);
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const lastSaved = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
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
    const emitted = blocksToMarkdown(editor).then((md) => {
      if (md === lastSaved.current) return;
      lastSaved.current = md;
      return onChangeRef.current(md);
    });
    lastEmit.current = Promise.allSettled([lastEmit.current, emitted]).then(() => undefined);
  };

  // Handed to the owner via onReady and kept for the editor's lifetime, so
  // they must be identity-stable — they close over refs only, never props.
  const cancelPendingSave = useRef(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }).current;
  const flushPendingSave = useRef(() => {
    const wasPending = timer.current !== null;
    cancelPendingSave();
    if (wasPending && !readOnlyRef.current) emitRef.current();
    return lastEmit.current;
  }).current;

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
      lastSaved.current = roundTripped;
      setLoaded(true);
      onReadyRef.current?.({
        editor,
        lossyCause: lossyImportCause(markdown, roundTripped),
        flushPendingSave,
        cancelPendingSave,
      });
    })();
    return () => {
      cancelled = true;
    };
    // `markdown` is the initial value by contract; the editor instance is
    // stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const scheduleEmit = () => {
    // A read-only document must not be able to schedule a write at all — the
    // editable flag alone would still let a programmatic change through.
    if (readOnlyRef.current) return;
    onDirtyRef.current?.();
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
        if (!readOnlyRef.current) emitRef.current();
      }
    },
    [],
  );

  useEffect(() => {
    if (loaded && autoFocus) editor.focus();
  }, [loaded, autoFocus, editor]);

  // --- Mention menus (M2.x docs polish) -----------------------------------
  // `[[` links a page (Obsidian habit); `@` links pages/people and sets due
  // dates on task lines. A pick replaces the trigger text with a chip. When
  // no page answers to the name typed, both menus end on a Create row that
  // makes the page and links it (M55.7); `@` offers it only where a word
  // starts.

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
      .map((e) => ({
        title: e.title,
        subtext: e.path,
        group: 'Link page',
        icon: <Icon name="file-text" size={14} />,
        onItemClick: () => insertChip({ type: 'wikilink', props: { target: stem(e), alias: '' } }),
      }));

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
    entries.filter(isPerson).map((e) => ({
      title: e.title,
      subtext: 'Assign',
      group: 'People',
      icon: <Icon name="circle-user" size={14} />,
      onItemClick: () => insertChip({ type: 'assignee', props: { target: stem(e) } }),
    }));

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
              [{ type: 'wikilink', props: { target: stemOfPath(path), alias: '' } }, ' '],
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
   * Focus a just-inserted AI block's question field (M53.9).
   *
   * The block asks its question first, so the field takes the caret rather
   * than the editor — `editor.focus()` here used to blur the field the moment
   * it had focus, and the blur closed it, leaving nothing to type into. The
   * node view mounts through a React portal, so the field may not exist on the
   * first try; it is looked for again on the next few frames.
   *
   * The field is the one in the block's OWN content, not one in an answer
   * nested under it — and both depths are named because the browser wraps a
   * React block in an extra element that jsdom does not.
   */
  const focusAiPrompt = (id: string, tries = 10) => {
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
    const field = host.current
      ?.querySelector(`.bn-block[data-id="${escaped}"]`)
      ?.querySelector<HTMLInputElement>(
        ':scope > [data-content-type="ai"] input, :scope > * > [data-content-type="ai"] input',
      );
    if (field != null) {
      field.focus();
      return;
    }
    if (tries > 0) window.requestAnimationFrame(() => focusAiPrompt(id, tries - 1));
  };

  // Custom blocks (M2.x): AI block, callout, mermaid diagram, database.
  const insertBlockAtCursor = (block: { type: string; props?: Record<string, string> }) => {
    const cursor = editor.getTextCursorPosition().block;
    const inserted = editor.insertBlocks([block as never], cursor, 'after');
    const target = inserted[0];
    // BlockNote closes the menu and clears its `/query` BEFORE this callback
    // (SuggestionMenuWrapper: closeMenu, clearQuery, onItemClick). The cursor
    // is still placed on the next tick, once that close has finished handing
    // focus back, or typing continues in the old block.
    window.setTimeout(() => {
      if (target !== undefined && block.type === 'ai') {
        focusAiPrompt(target.id);
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
      // The cursor is placed on the next tick, once the menu's close has
      // finished, or typing continues in the block we just left.
      window.setTimeout(() => {
        const firstColumn = (inserted[0] as { children?: { children?: unknown[] }[] })
          ?.children?.[0];
        const landing = firstColumn?.children?.[0];
        if (landing !== undefined) {
          editor.setTextCursorPosition(landing as never, turnInto ? 'end' : 'start');
        }
        editor.focus();
      }, 0);
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
   */
  useEffect(() => {
    const onRun = (event: Event) => {
      const { id, prompt } = (event as CustomEvent<{ id: string; prompt: string }>).detail;
      if (vaultPath === null || prompt.trim() === '') return;
      const block = editor.getBlock(id);
      if (block === undefined) return;
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
              shell: false,
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
            }
            if (e.kind === 'Done') {
              stop();
              const clean = unwrapReplyFence(text);
              if (editor.getBlock(id) === undefined || clean === '') return;
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
                .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err)));
            }
          }, runId);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
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
    if (e.key !== 'k' || !(e.metaKey || e.ctrlKey) || readOnly) return;
    const text = window.getSelection()?.toString() ?? '';
    // Nothing selected is not an error — it is the other feature (a slash
    // menu), and stealing the keystroke to show an empty rewrite would be
    // worse than not binding it.
    if (text.trim() === '') return;
    e.preventDefault();
    const live = window.getSelection()?.getRangeAt(0);
    target.current = live?.cloneRange() ?? null;
    const rect = live?.getBoundingClientRect();
    setAsking({
      text,
      x: Math.min(rect?.left ?? 80, window.innerWidth - 440),
      y: (rect?.bottom ?? 80) + 6,
    });
  };

  /**
   * Open the rewrite surface from the toolbar.
   *
   * The DOM range is saved into `asking` here, while it still exists: clicking
   * the bar moves focus, and by the time the popover mounts the selection the
   * user made is gone. Same reason Cmd-K captures the string rather than
   * reading it back later.
   */
  const askFromToolbar = (preset?: Preset) => {
    const live = window.getSelection();
    if (live === null || live.rangeCount === 0 || live.isCollapsed) return;
    const text = live.toString();
    if (text.trim() === '') return;
    const range = live.getRangeAt(0);
    target.current = range.cloneRange();
    const rect = range.getBoundingClientRect();
    setAsking({
      text,
      x: Math.min(rect.left, window.innerWidth - 440),
      y: rect.bottom + 8,
      preset: preset?.instruction,
    });
  };

  /**
   * Replace the selected text with the decided passage.
   *
   * Through the DOM selection rather than by block id, because the selection
   * may span several blocks and part of one — "rewrite this sentence" is the
   * common case, and a block-granular replace would take the paragraph. One
   * edit, so it is one undo step and one debounce, which is the whole reason
   * the rewrite is not streamed in.
   */
  const replaceSelection = (text: string) => {
    const range = target.current;
    if (range === null) return;
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    // The range now describes the text just inserted; dropping it stops a
    // second Apply — from a stale popover — writing into it again.
    target.current = null;
    scheduleEmit();
  };

  return (
    <div
      ref={host}
      data-testid="markdown-editor"
      className="cerebro-editor min-h-0 flex-1"
      onKeyDown={onEditorKeyDown}
    >
      {loaded && (
        <BlockNoteView
          editor={editor}
          theme="light"
          editable={!readOnly}
          onChange={scheduleEmit}
          sideMenu={false}
          slashMenu={false}
          // M18: ours replaces it (AI first, then everything it would have
          // rendered). Left on, BlockNote mounts a SECOND controller and two
          // toolbars stack on the same selection.
          formattingToolbar={false}
        >
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={async (query) => {
              const rows = filterItems(
                [...personItems(), ...docItems({ excludePeople: true }), ...dueItems()],
                query,
              );
              // Create only where a mention starts: `ana@example.com` is an
              // address, and the `@` in `meet @ 5pm` names nothing.
              const starts =
                !/^\s/.test(query) &&
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
              // Create tracks the caret with the bracket already gone.
              const create = asked.double ? createRow(asked.text, '[') : null;
              return withCreate(filterItems(docItems(), asked.text), create).map((item) => ({
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
                slashMenuItems(editor, [
                  dateSlashItem(),
                  ...columnSlashItems(),
                  ...blockSlashItems(),
                  ...templateSlashItems(),
                ]),
                query,
              )
            }
          />
          {/* M18: AI at the head of the editor's OWN formatting toolbar. A
              second floating bar beside BlockNote's fought it for the same few
              pixels on every selection. */}
          {!readOnly && <AiFormattingToolbar onAsk={askFromToolbar} />}
          <SideMenuController
            sideMenu={(props) => (
              <SideMenu {...props}>
                <AssignTaskButton onOpen={openAssignDialog} />
                <AddBlockButton />
                {/* M48.4: ours, not BlockNote's `DragHandleButton`. Same
                    position, same click-opens-the-menu behaviour; a drag that
                    a test can drive and a drop that can land in a column. The
                    menu it opens holds only what a save keeps (M55.15). */}
                <BlockGripButton
                  hostRef={host}
                  sideMenu={<DragHandleButton {...props} dragHandleMenu={CarriedBlockMenu} />}
                />
              </SideMenu>
            )}
          />
        </BlockNoteView>
      )}
      {asking !== null && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={() => setAsking(null)}
          onWheel={(e) => {
            if (e.target === e.currentTarget) setAsking(null);
          }}
        >
          <div
            className="absolute"
            style={{ left: asking.x, top: asking.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <AskAiPopover
              selection={asking.text}
              preset={asking.preset}
              onReplace={replaceSelection}
              onClose={() => setAsking(null)}
            />
          </div>
        </div>
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
                  ...people.map((p) => ({ value: stem(p), label: p.title })),
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
                className="h-7 rounded-md border-0 bg-cortex-500 px-2.5 text-xs font-medium text-n-0 hover:bg-cortex-600"
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
