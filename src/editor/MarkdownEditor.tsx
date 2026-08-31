import '@blocknote/mantine/style.css';
import './editor.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';
import { codeBlockOptions } from '@blocknote/code-block';
import { onAgentEvent, runAgent, startMcp, startedOrThrow } from '@/agent/agentIpc';
import { AskAiPopover } from '@/editor/AskAiPopover';
import { AiFormattingToolbar, type Preset } from '@/editor/SelectionToolbar';
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
import { peopleTypes } from '@/engine/properties';
import type { Entry } from '@/engine/types';
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
  MermaidBlock,
} from './blocks';
import { AssigneeChip, DueChip, WikilinkChip } from './chips';
import { buildOutline } from './DocOutline';
import { blocksToMarkdown, isLossyImport, markdownToBlocks } from './markdown';

// Default schema with the fully-featured code block (shiki highlighting,
// full language list) swapped in, plus the Cerebro custom blocks (callout,
// mermaid, database) and inline chips: wikilinks, assignees, and dates
// (M2.x, M47.2).
export const cerebroSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
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
  },
});

export type CerebroEditor = typeof cerebroSchema.BlockNoteEditor;

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
  if (q === '') return items;
  return items.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      (typeof i.subtext === 'string' && i.subtext.toLowerCase().includes(q)) ||
      (Array.isArray(i.aliases) && i.aliases.some((a) => a.toLowerCase().includes(q))),
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
   * document never rewrites it.
   */
  onChange: (markdown: string) => void;
  /**
   * Fires once the document is loaded. `lossyImport` is true when the parse
   * round trip lost textual content (e.g. raw HTML blocks) — consumers
   * should warn before edits overwrite the file.
   *
   * `flushPendingSave` / `cancelPendingSave` let the owner take control of the
   * debounce: flush before a deliberate save (⌘S), cancel before writing the
   * file out of band (template apply) so the stale in-editor body can't be
   * written back over it.
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
  lossyImport: boolean;
  flushPendingSave: () => void;
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
  const editor = useCreateBlockNote({ schema: cerebroSchema });
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

  const emitRef = useRef(() => {});
  emitRef.current = () => {
    void blocksToMarkdown(editor).then((md) => {
      if (md === lastSaved.current) return;
      lastSaved.current = md;
      onChangeRef.current(md);
    });
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
        lossyImport: isLossyImport(markdown, roundTripped),
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
  // dates on task lines. Insertion replaces the trigger text with a chip.

  const insertChip = (content: {
    type: 'wikilink' | 'assignee' | 'due';
    props: Record<string, string>;
  }) => {
    editor.insertInlineContent([content as never, ' ']);
    editor.focus();
  };

  // The `[[` flow: the menu triggers on the SECOND bracket, so its cleanup
  // leaves the first `[` behind as text. Remove it before inserting.
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

  // Custom blocks (M2.x): callout + mermaid diagram.
  const insertBlockAtCursor = (block: { type: string; props?: Record<string, string> }) => {
    const cursor = editor.getTextCursorPosition().block;
    const inserted = editor.insertBlocks([block as never], cursor, 'after');
    const target = inserted[0];
    // The suggestion menu deletes its trigger text AFTER this callback and
    // restores the selection while doing so — place the cursor once that
    // cleanup has run, or typing continues in the old block.
    window.setTimeout(() => {
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
          const mcp = await startMcp(vaultPath);
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
              mcp,
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
              const clean = text.trim().replace(/^```[a-z]*\n?|\n?```$/g, '');
              const current = editor.getBlock(id);
              if (current === undefined || clean === '') return;
              // One edit, so it is one undo step and one save — the same
              // reason the rewrite is not streamed in.
              editor.updateBlock(current, {
                props: { prompt, generated: todayIso() },
                content: clean,
              } as never);
              scheduleEmit();
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
            getItems={async (query) =>
              filterItems(
                [...personItems(), ...docItems({ excludePeople: true }), ...dueItems()],
                query,
              )
            }
          />
          <SuggestionMenuController
            triggerCharacter="["
            getItems={async (query) =>
              // The user is mid-`[[`: the second bracket lands in the query.
              filterItems(
                docItems().map((item) => ({
                  ...item,
                  onItemClick: () => {
                    stripDanglingBracket();
                    item.onItemClick?.();
                  },
                })),
                query.replace(/^\[/, ''),
              )
            }
          />
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              // Defaults plus per-template inserts under "Advanced blocks".
              filterItems(
                [
                  ...(getDefaultReactSlashMenuItems(editor) as DefaultReactSuggestionItem[]),
                  dateSlashItem(),
                  ...blockSlashItems(),
                  ...templateSlashItems(),
                ],
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
                <DragHandleButton {...props} />
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
