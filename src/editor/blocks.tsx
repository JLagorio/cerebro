import { WhiteboardBlock as WhiteboardBlockView } from '@/whiteboard/WhiteboardBlock';
import { WHITEBOARD_FENCE } from '@/engine/whiteboardRef';
import { useEffect, useRef, useState } from 'react';
import { createBlockSpec, defaultBlockSpecs, type BlockNoteEditor } from '@blocknote/core';
import { imageSource } from '@/engine/imageSource';
import {
  allowRemoteImage,
  imageHost,
  remoteImageAllowed,
  subscribeRemoteImages,
} from '@/lib/remoteImages';
import { createReactBlockSpec, useEditorChange } from '@blocknote/react';
import { ColumnGutter } from './ColumnGutter';
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai/PromptInput';
import { aiBlockRun } from '@/agent/elements/writingAsk';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { ConnectedPageCard } from '@/components/PageCard';
import { MermaidBlockView } from '@/mermaid/MermaidBlockView';
import { ConnectedDatabaseBlock } from '@/views/DatabaseBlockView';
import { DATABASE_FENCE, serializeDatabaseRef } from '@/engine/databaseBlock';
import { SUBPAGES_FENCE } from '@/engine/docPages';
import { PAGE_CARD_FENCE, serializePageRef } from '@/engine/pageCard';
import { parseSheetFence, SHEET_FENCE, sheetSourcesOf } from '@/engine/sheet/fence';
import { SheetView } from '@/sheet/SheetView';
import { SheetGrid } from '@/sheet/SheetGrid';
import { commitSheetEdits } from '@/sheet/commitSheets';
import { registerSheetDraft, settleSheetDrafts } from '@/sheet/pendingSheets';
import type { CerebroEditor } from './MarkdownEditor';
import { useSheetWorkbook } from '@/sheet/useSheetWorkbook';
import {
  BASE_MARKER_DEPTH,
  DEFAULT_COLUMN_WIDTH,
  openColumnMarker,
  openListMarker,
} from '@/engine/pageColumns';
import { useAiBlockRunning } from './aiBlockRuns';
import { formatAiMarker } from './markdown';
import { SubPageList } from './SubPageList';

const upstreamImage = defaultBlockSpecs.image;
/** Keep BlockNote's carrier and local renderer. A remote image creates no img
 * until the person grants its exact URL. The gate is native DOM because this
 * node view lives outside React's delegated event root. */
export const GatedImageBlock = createBlockSpec(upstreamImage.config, {
  ...upstreamImage.implementation,
  render(block, editor) {
    const source = block.props.url.trim();
    const kind = imageSource(source);
    if (kind === 'vault' || kind === 'data' || !source)
      return upstreamImage.implementation.render.call(this, block, editor);
    const dom = document.createElement('div');
    dom.className =
      'cb-remote-image inline-flex max-w-full items-center gap-2 rounded-md border border-n-200 px-3 py-2 text-xs text-n-600';
    dom.contentEditable = 'false';
    let opened: ReturnType<typeof upstreamImage.implementation.render> | undefined;
    let dead = false;
    const show = () => {
      if (dead || opened || kind !== 'remote' || !remoteImageAllowed(source)) return;
      // Always resolve asynchronously, so referrerPolicy precedes src even
      // in a standalone editor that supplied no attachment resolver.
      const safeEditor = new Proxy(editor, {
        get(target, key) {
          if (key === 'resolveFileUrl') return async () => source;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      opened = upstreamImage.implementation.render.call(this, block, safeEditor);
      for (const image of opened.dom.querySelectorAll('img')) {
        image.referrerPolicy = 'no-referrer';
        image.loading = 'lazy';
        image.draggable = false;
        image.addEventListener('error', () => {
          if (!dead) dom.textContent = "This image couldn't be loaded.";
        });
      }
      dom.replaceChildren(opened.dom);
    };
    if (kind === 'remote') {
      const host = document.createElement('span');
      host.textContent = imageHost(source);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Load image';
      button.className = 'rounded-sm border border-n-200 px-2 py-1 text-n-800';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        allowRemoteImage(source);
      });
      dom.append(host, button);
    } else
      dom.textContent =
        kind === 'insecure' ? 'HTTP images are not allowed.' : 'This image address is not allowed.';
    const unsubscribe = subscribeRemoteImages(show);
    show();
    return {
      dom,
      destroy() {
        dead = true;
        unsubscribe();
        opened?.destroy?.();
      },
    };
  },
  toExternalHTML(block) {
    // Upstream assigns src immediately. Setting lazy first keeps save/copy/
    // drag serialization inert while retaining the original image carrier.
    if (!block.props.url) {
      const dom = document.createElement('p');
      dom.textContent = 'Add image';
      return { dom };
    }
    let media: HTMLImageElement | HTMLAnchorElement;
    if (block.props.showPreview) {
      media = document.createElement('img');
      media.setAttribute('loading', 'lazy');
      media.setAttribute('referrerpolicy', 'no-referrer');
      media.src = block.props.url;
      media.alt = block.props.name || block.props.caption || 'BlockNote image';
      if (block.props.previewWidth) media.width = block.props.previewWidth;
    } else {
      media = document.createElement('a');
      media.href = block.props.url;
      media.textContent = block.props.name || block.props.url;
    }
    if (!block.props.caption) return { dom: media };
    const dom = document.createElement(block.props.showPreview ? 'figure' : 'div');
    const caption = document.createElement(block.props.showPreview ? 'figcaption' : 'p');
    caption.textContent = block.props.caption;
    dom.append(media, caption);
    return { dom };
  },
});

/**
 * Custom blocks (M2.x docs polish). All of them stay plain markdown on disk:
 *
 *   callout     Obsidian-style `> [!info] …` blockquote
 *   mermaid     ```mermaid fenced code block
 *   whiteboard  ```cerebro-whiteboard fence holding a raw pointer (M68.5c)
 *   sheet       ```cerebro-sheet fence holding CSV source cells (M67.1b)
 *   database    ```cerebro-database fence holding a POINTER (M47.2)
 *   subPages    an EMPTY ```cerebro-subpages fence (M55.13)
 *   pageCard    ```cerebro-page fence holding ONE wikilink (M55.14)
 *   columnList  `:::columns` directive container (M48.1)
 *   column      `::::column` directive container (M48.1)
 *   ai          `:::ai{prompt="…"}` directive container (M53.9)
 *
 * markdown.ts promotes the plain forms into these blocks after parse and
 * demotes them back before serialization, so files never stop being
 * ordinary markdown.
 */

export const CALLOUT_KINDS = ['info', 'note', 'tip', 'success', 'warning', 'danger'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * Every callout colour is a token reference — no literals, so a palette tweak
 * can never desynchronise a callout's fill from its own left border. `tip`
 * uses the teal callout tokens rather than violet: violet is reserved for AI
 * surfaces, and a user-inserted block must not read as the assistant talking.
 * The `--callout-tip-*` trio is defined in editor.css (the teal ramp has no
 * global 50/700 stops).
 */
const CALLOUT_STYLE: Record<CalloutKind, { icon: string; bg: string; border: string; fg: string }> =
  {
    info: {
      icon: 'info',
      bg: 'var(--cortex-50)',
      border: 'var(--cortex-500)',
      fg: 'var(--cortex-600)',
    },
    note: { icon: 'pencil', bg: 'var(--n-50)', border: 'var(--n-400)', fg: 'var(--n-700)' },
    tip: {
      icon: 'lightbulb',
      bg: 'var(--callout-tip-50)',
      border: 'var(--callout-tip-500)',
      fg: 'var(--callout-tip-700)',
    },
    success: {
      icon: 'circle-check',
      bg: 'var(--success-50)',
      border: 'var(--success-500)',
      fg: 'var(--success-700)',
    },
    warning: {
      icon: 'triangle-alert',
      bg: 'var(--warn-50)',
      border: 'var(--warn-500)',
      fg: 'var(--warn-700)',
    },
    danger: {
      icon: 'octagon-alert',
      bg: 'var(--danger-50)',
      border: 'var(--danger-500)',
      fg: 'var(--danger-700)',
    },
  };

function CalloutView({
  kind,
  onPickKind,
  editable,
  contentRef,
}: {
  kind: CalloutKind;
  onPickKind: (kind: CalloutKind) => void;
  editable: boolean;
  contentRef: (node: HTMLElement | null) => void;
}) {
  const style = CALLOUT_STYLE[kind] ?? CALLOUT_STYLE.info;
  const [picking, setPicking] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-testid="callout-block"
      data-kind={kind}
      className="my-0.5 flex w-full items-start gap-2.5 rounded-lg px-3.5 py-2.5"
      style={{ background: style.bg, borderLeft: `3px solid ${style.border}` }}
    >
      <button
        ref={anchor}
        type="button"
        title={`Callout type: ${kind}`}
        aria-label={`Callout type: ${kind}`}
        contentEditable={false}
        onClick={() => setPicking((value) => !value)}
        disabled={!editable}
        aria-haspopup="menu"
        aria-expanded={picking}
        className="mt-px flex-none cursor-pointer border-0 bg-transparent p-0"
      >
        <Icon name={style.icon} size={16} color={style.fg} />
      </button>
      {picking && editable && (
        <Popover
          anchorRef={anchor}
          onClose={() => setPicking(false)}
          role="menu"
          ariaLabel="Callout type"
        >
          <MenuSurface width={180}>
            {CALLOUT_KINDS.map((choice) => (
              <MenuItem
                key={choice}
                icon={CALLOUT_STYLE[choice].icon}
                label={choice.charAt(0).toUpperCase() + choice.slice(1)}
                onSelect={() => {
                  setPicking(false);
                  onPickKind(choice);
                }}
              />
            ))}
          </MenuSurface>
        </Popover>
      )}
      <div className="min-w-0 flex-1 text-md leading-[1.5]" ref={contentRef} />
    </div>
  );
}

export const CalloutBlock = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: { kind: { default: 'info' as string } },
    content: 'inline',
  },
  {
    render: (props) => (
      <CalloutView
        kind={(props.block.props.kind as CalloutKind) ?? 'info'}
        editable={props.editor.isEditable}
        onPickKind={(kind) => {
          props.editor.updateBlock(props.block, { props: { kind } } as never);
        }}
        contentRef={props.contentRef}
      />
    ),
  },
);

export const MermaidBlock = createReactBlockSpec(
  {
    type: 'mermaid',
    propSchema: { code: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => (
      <MermaidBlockView
        code={props.block.props.code as string}
        onChangeCode={(code) => props.editor.updateBlock(props.block, { props: { code } } as never)}
        // The document's own history, handed to the block (M29.53). Every
        // visual op already flows into it through onChangeCode; what the block
        // could not do was REACH it, because its chrome takes DOM focus away
        // from the editor and BlockNote only answers the keystroke while it
        // holds focus.
        onUndo={() => props.editor.undo()}
        onRedo={() => props.editor.redo()}
      />
    ),
    /**
     * What leaves the app when a selection crosses this block (M29.53).
     *
     * BlockNote derives text/plain from this same serializer pass, and with no
     * toExternalHTML it fell back to the block's RENDERED text: MEASURED, a
     * drag-select across the first diagram of Systems map put
     * "FlowchartOpen full screenSave as file…Edit" on the clipboard and the
     * diagram source nowhere in it. The fence is what markdown.ts already
     * demotes this block to for the disk, and the neighbouring inline specs
     * declare their plain-text form the same way (chips.tsx).
     */
    toExternalHTML: (props) => (
      <pre>
        <code>{`\`\`\`mermaid\n${props.block.props.code as string}\n\`\`\``}</code>
      </pre>
    ),
  },
);

/** Copy and save the raw pointer; the embedded board is always a reader. */
export const WhiteboardBlock = createReactBlockSpec(
  { type: 'whiteboard', propSchema: { source: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <WhiteboardBlockView
        source={props.block.props.source as string}
        onChange={
          props.editor.isEditable
            ? (source) => props.editor.updateBlock(props.block, { props: { source } } as never)
            : undefined
        }
      />
    ),
    toExternalHTML: (props) => {
      const source = props.block.props.source as string;
      const runs = [...source.matchAll(/`+/g)].map((match) => match[0].length);
      const marker = '`'.repeat(Math.max(3, ...runs.map((length) => length + 1)));
      return (
        <pre>
          <code>{`${marker}${WHITEBOARD_FENCE}\n${source}${source === '' ? '' : '\n'}${marker}`}</code>
        </pre>
      );
    },
  },
);

/** A reused node view must still observe changes to every peer sheet: its
 * formulas can read those peers, and its ordinal includes nested sheets. */
function LiveSheetBlock({
  editor,
  id,
  source,
}: {
  editor: BlockNoteEditor<any, any, any>;
  id: string;
  source: string;
}) {
  const [document, setDocument] = useState(() => editor.document);
  useEditorChange(() => setDocument(editor.document), editor);
  const sheets = sheetSourcesOf(document);
  const states = useSheetWorkbook(sheets.map((sheet) => sheet.source));
  const index = sheets.findIndex((sheet) => sheet.id === id);
  const parsed = parseSheetFence(source);
  const state = states[index] ?? { status: 'pending' as const, name: 'Sheet' };
  return (
    <div
      className="min-w-0 w-full"
      contentEditable={false}
      data-testid={parsed.ok && state.status !== 'unavailable' ? 'sheet-block' : undefined}
    >
      {parsed.ok && state.status !== 'unavailable' ? (
        <SheetGrid
          id={id}
          sources={sheets}
          computed={state.status === 'ready' ? state.sheet : undefined}
          getSources={() => sheetSourcesOf(editor.document)}
          getPage={async () => {
            settleSheetDrafts(editor);
            const { blocksToMarkdown } = await import('./markdown');
            return blocksToMarkdown(editor as CerebroEditor);
          }}
          registerDraft={(flush) => registerSheetDraft(editor, id, flush)}
          onCommit={
            editor.isEditable
              ? (edits) => {
                  commitSheetEdits(editor as CerebroEditor, edits);
                }
              : undefined
          }
          onUndo={() => editor.undo()}
          onRedo={() => editor.redo()}
          onExit={() => {
            const block = editor.getBlock(id);
            if (!block) return;
            const next = editor.getNextBlock(id);
            if (next) editor.setTextCursorPosition(next, 'start');
            else if (editor.isEditable) {
              const inserted = editor.insertBlocks([{ type: 'paragraph' }], id, 'after');
              if (inserted[0]) editor.setTextCursorPosition(inserted[0], 'start');
            }
            editor.focus();
          }}
        />
      ) : (
        <SheetView state={state} source={source} cells={parsed.ok ? parsed.cells : []} />
      )}
    </div>
  );
}

export const SheetBlock = createReactBlockSpec(
  {
    type: 'sheet',
    propSchema: { source: { default: '' } },
    content: 'none',
  },
  {
    // Chromium measurement: focus, slash, Backspace and paste stay in the
    // grid while the block grip still reorders it. Native pointer/clipboard
    // listeners own the controls; div rows also avoid BlockNote's table plugin.
    meta: { selectable: false },
    render: (props) => (
      <LiveSheetBlock
        editor={props.editor}
        id={props.block.id}
        source={props.block.props.source as string}
      />
    ),
    // Copy the source, never the caption or computed cells (DOM trap 5).
    // A longer delimiter also carries a CSV cell containing a backtick line.
    toExternalHTML: (props) => {
      const source = props.block.props.source as string;
      const runs = [...source.matchAll(/`+/g)].map((match) => match[0].length);
      const marker = '`'.repeat(Math.max(3, ...runs.map((length) => length + 1)));
      return (
        <pre>
          <code>{`${marker}${SHEET_FENCE}\n${source}${source === '' ? '' : '\n'}${marker}`}</code>
        </pre>
      );
    },
  },
);

/**
 * The AI block (M17.18): generated content that stays, and can be recomputed.
 *
 * Distinct from the transient rewrite (M17.16), and the difference is the
 * whole reason it exists. A rewrite is an edit — it happens once, you decide,
 * and afterwards the document is just a document. This is a STANDING
 * question: "the open questions in this doc", "the action items", "a summary".
 * Its answer goes stale when the document around it changes, and the useful
 * thing is to ask again rather than to re-type it.
 *
 * ## Why the prompt is stored in the block
 *
 * Because otherwise "recompute" means "guess what this paragraph was asked
 * for". The block carries its own question, so what it holds can always be
 * re-derived, and a reader can see what produced the text they are reading
 * rather than having to trust it.
 *
 * ## The answer is the block's children
 *
 * `content: 'none'`, and the answer is the blocks nested under it — a list
 * renders as a list, a code fence as code, and a person can fix a line of it
 * by hand like any other block (a generated block that fought that would be a
 * block people delete). Recomputing replaces them. It is the column's shape
 * (M48.1), and for the column's reason: on disk the block is a `:::ai`
 * directive container whose contents are ordinary markdown (markdown.ts). The
 * `generated` prop records when it was last answered, so "this was written by
 * the assistant on Tuesday" is visible rather than implied.
 *
 * ## Its elements (M91.14)
 *
 * The question is a Prompt Input at the block's size, its run button the
 * input's submit: Enter asks, as the button does. A question is one line, as
 * the field it replaced held it, so Shift+Enter adds nothing and a pasted
 * line break is a space. While the editor writes the answer the button says
 * so under the AI light, and neither it nor the question can be changed:
 * the answer lands with the question it was asked. Exported for its test.
 */
export function AiBlockView({
  prompt,
  generated,
  running,
  onEditPrompt,
  onRun,
}: {
  prompt: string;
  generated: string;
  running: boolean;
  onEditPrompt: (prompt: string) => void;
  onRun: () => void;
}) {
  const [editing, setEditing] = useState(prompt.trim() === '');
  const [draft, setDraft] = useState(prompt);
  // The question as it stood when the field opened: what Escape puts back.
  const before = useRef(prompt);
  const field = useRef<HTMLTextAreaElement | null>(null);
  // Set by a click on the question, so the field it opens takes the caret.
  // MEASURED without it, in Chromium: the click opened the field, focus fell
  // to the page body, and what was typed next went nowhere.
  const focusWhenOpen = useRef(false);
  useEffect(() => {
    if (!editing || !focusWhenOpen.current) return;
    focusWhenOpen.current = false;
    const at = field.current?.value.length ?? 0;
    field.current?.focus();
    // At the question's end, where the input it replaced put the caret: a
    // textarea takes it at its start, and inside the editor End does not
    // move it (MEASURED in Chromium, M91.14).
    field.current?.setSelectionRange(at, at);
  }, [editing]);
  const run = aiBlockRun(generated, running);
  const ask = () => {
    if (running) return;
    if (editing) {
      if (draft.trim() === '') return;
      setEditing(false);
    }
    onRun();
  };
  return (
    <div
      data-testid="ai-block"
      aria-busy={running || undefined}
      className="cb-ai-block my-1 w-full rounded-lg border border-synapse-200 bg-synapse-50 px-3 py-2"
    >
      <PromptInput onSubmit={ask} disabled={running}>
        <Icon name="sparkles" size={12} color="var(--synapse-500)" />
        <PromptInputBody>
          {editing ? (
            // No autoFocus: a page that merely LOADS with an unasked block must
            // not take the caret. The `/` insert focuses this field itself, and
            // a click on the question through `focusWhenOpen`.
            <PromptInputTextarea
              ref={field}
              data-testid="ai-block-prompt-input"
              value={draft}
              onChange={(e) => {
                // Into the block as it is typed (M53.9), not when the field
                // closes. Held here until a blur or Enter, the question was lost
                // to any way off the page that did not blur the field first,
                // and the unmount flush saved an empty `:::ai`. The block is
                // re-rendered, not rebuilt, so this field keeps the caret.
                const value = e.target.value.replace(/\r?\n/g, ' ');
                setDraft(value);
                onEditPrompt(value);
              }}
              onBlur={() => {
                // An empty question stays open. Closed, it is a button with no
                // label — nothing on screen to click to ask it.
                if (draft.trim() !== '') setEditing(false);
              }}
              onKeyDown={(e) => {
                // One line: the Enter that asks is the field's own (PromptInput).
                if (e.key === 'Enter' && e.shiftKey) e.preventDefault();
                if (e.key === 'Escape') {
                  // Out of the block too, since typing already put it there.
                  setDraft(before.current);
                  onEditPrompt(before.current);
                  if (before.current.trim() !== '') setEditing(false);
                }
              }}
              aria-label="What should this block answer?"
              placeholder="The open questions in this document…"
            />
          ) : (
            <button
              type="button"
              data-testid="ai-block-prompt"
              disabled={running}
              onClick={() => {
                setDraft(prompt);
                before.current = prompt;
                focusWhenOpen.current = true;
                setEditing(true);
              }}
              className="block w-full truncate border-0 bg-transparent p-0 text-left text-2xs text-synapse-700"
            >
              {prompt}
            </button>
          )}
        </PromptInputBody>
        <PromptInputSubmit
          data-testid="ai-block-run"
          aria-label={run.label}
          status={running ? 'streaming' : 'ready'}
          disabled={running || prompt.trim() === ''}
        >
          <span className={run.working ? 'cb-ai-shimmer' : undefined}>{run.label}</span>
        </PromptInputSubmit>
      </PromptInput>
      {generated !== '' && (
        <div className="mt-1 text-2xs text-n-400">
          Answered {generated} — edit the answer below, or ask again when the document moves on.
        </div>
      )}
    </div>
  );
}

/** The block as the editor renders it: its props, and whether the editor is
 *  writing its answer now (aiBlockRuns.ts). */
function AiBlockRender({
  block,
  editor,
}: {
  block: { id: string; props: { prompt?: unknown; generated?: unknown } };
  // Erased generics, as in markdown.ts: this reads and writes one block.
  editor: BlockNoteEditor<any, any, any>;
}) {
  const running = useAiBlockRunning(editor, block.id);
  return (
    <AiBlockView
      prompt={String(block.props.prompt ?? '')}
      generated={String(block.props.generated ?? '')}
      running={running}
      onEditPrompt={(prompt) => {
        // Only a changed question is written: an unchanged one would still
        // be an edit to the document, and schedule a save for nothing.
        // Compared with the LIVE block, for the reason `onRun` reads it.
        const live = editor.getBlock(block.id);
        if (live === undefined || live.props.prompt === prompt) return;
        editor.updateBlock(live, { props: { prompt } } as never);
      }}
      onRun={() => {
        // The run itself is wired by the editor, which owns the vault path
        // and the agent IPC; the block owns the question and the answer.
        // Kept apart so this file stays free of app state and can be
        // rendered in a test with no store behind it.
        //
        // The question is read off the LIVE block: `block` is the render
        // this closed over, older than the last write to the question until
        // React renders again. MEASURED when Enter wrote the question and
        // ran in one handler: a new block asked "", its old question, which
        // the editor then declined to run.
        const live = editor.getBlock(block.id);
        window.dispatchEvent(
          new CustomEvent('cerebro:ai-block-run', {
            detail: { id: block.id, prompt: String(live?.props.prompt ?? '') },
          }),
        );
      }}
    />
  );
}

export const AiBlock = createReactBlockSpec(
  {
    type: 'ai',
    propSchema: {
      /** The standing question. Stored so "recompute" never has to guess. */
      prompt: { default: '' as string },
      /** When it was last answered, so provenance is visible not implied. */
      generated: { default: '' as string },
    },
    content: 'none',
  },
  {
    render: (props) => <AiBlockRender block={props.block} editor={props.editor} />,
    /**
     * What leaves the app when a selection crosses this block: its opening
     * line, the one markdown.ts writes to disk. Without it BlockNote falls
     * back to the RENDERED text, the way MermaidBlock documents, and a copy
     * would carry the question glued to "Recompute" — the same chrome a save
     * used to write before the block had a carrier. The answer follows as the
     * block's children, which BlockNote exports itself.
     */
    toExternalHTML: (props) => (
      <p>
        {formatAiMarker(BASE_MARKER_DEPTH, {
          prompt: String(props.block.props.prompt ?? ''),
          generated: String(props.block.props.generated ?? ''),
        })}
      </p>
    ),
  },
);

/**
 * Enter at the end of an AI block's answer leaves the block (M53.9). Returns
 * whether it took the key.
 *
 * The answer is the block's children, and BlockNote's Enter makes a sibling of
 * the block it splits — so a paragraph started after the answer landed INSIDE
 * it, was written into the `:::ai` container, and went with the next
 * Recompute, which replaces every child. MEASURED in Chromium: a note typed
 * that way was saved inside the container, and one click on Recompute took it
 * off the page. Enter at the end of the answer's last block now starts a
 * paragraph after the AI block, as it did when the answer was the block's own
 * text — the DEEPEST last block, when the answer ends nested, in a sub-bullet
 * say, which is how a model often ends one. Anywhere else in the answer it
 * edits the answer, and Tab nests a block back into it. An empty last line is
 * left to BlockNote, whose Enter already lifts it out, and so is a code block,
 * where Enter is a new line of code.
 */
export function leaveAiAnswer(
  // Erased generics, as in markdown.ts: this reads the cursor and inserts a paragraph.
  editor: BlockNoteEditor<any, any, any>,
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>,
): boolean {
  if (event.key !== 'Enter' || event.isComposing) return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  const { block, parentBlock } = editor.getTextCursorPosition();
  const hasWords = Array.isArray(block.content) && block.content.length > 0;
  if (!hasWords || block.type === 'codeBlock') return false;
  const ai = aiAnswerEndingIn(editor, block.id, parentBlock);
  if (ai === undefined) return false;
  const { selection } = editor.prosemirrorState;
  if (!selection.empty || selection.$from.parentOffset < selection.$from.parent.content.size) {
    return false;
  }
  const [after] = editor.insertBlocks([{ type: 'paragraph' }], ai, 'after');
  editor.setTextCursorPosition(after, 'start');
  return true;
}

type Nested = { id: string; type: string; children: Nested[] };

/**
 * The AI block whose answer ends in the block `id`, if one does: the nearest
 * AI block above it, when taking the last child at every level down from that
 * block arrives at `id`. An AI block further up can only end there through
 * the nearest one, so the nearest is the one to leave.
 */
function aiAnswerEndingIn(
  editor: BlockNoteEditor<any, any, any>,
  id: string,
  parent: Nested | undefined,
): Nested | undefined {
  let ai = parent;
  while (ai !== undefined && ai.type !== 'ai') {
    ai = editor.getParentBlock(ai.id) as Nested | undefined;
  }
  let last = ai?.children[ai.children.length - 1];
  while (last !== undefined && last.children.length > 0) {
    last = last.children[last.children.length - 1];
  }
  return last?.id === id ? ai : undefined;
}

/**
 * A database block that knows its page (M48.7).
 *
 * A ProseMirror node view whose own node is unchanged is reused without a
 * re-render, so a copy-number computed in `render` went stale the moment a
 * twin was inserted elsewhere on the page — two embeds of one view shared a
 * fold until reload. Holding the document in state, refreshed on every
 * editor change, re-renders each embed with the page as it is now.
 */
function LiveDatabaseBlock({
  editor,
  ...rest
}: Omit<React.ComponentProps<typeof ConnectedDatabaseBlock>, 'document'> & {
  // Erased generics, as in markdown.ts: this reads only `document`/`onChange`.
  editor: BlockNoteEditor<any, any, any>;
}) {
  const [document, setDocument] = useState(() => editor.document);
  useEditorChange(() => setDocument(editor.document), editor);
  return <ConnectedDatabaseBlock {...rest} document={document as never} />;
}

/**
 * An embedded database (M47.2).
 *
 * `content: 'none'` — the block draws a database, it does not hold text. What
 * it holds is a pointer: the name of a database and which of its views to
 * show. The rows are files and stay files (spec D7), so nothing here is a
 * second copy of the vault that could disagree with the vault.
 */
export const DatabaseBlock = createReactBlockSpec(
  {
    type: 'database',
    // '' rather than null on both: BlockNote prop defaults are primitives, so
    // an empty view id is how "this block named no view" survives the round
    // trip. markdown.ts converts at the boundary.
    propSchema: { database: { default: '' }, view: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => (
      <LiveDatabaseBlock
        editor={props.editor}
        blockId={props.block.id}
        database={String(props.block.props.database ?? '')}
        view={String(props.block.props.view ?? '')}
        // The block rewrites its own pointer. Passed rather than assumed so
        // the view keeps a real read-only mood: rendered outside an editor
        // there is no document to write back to, and a picker that silently
        // did nothing would be worse than no picker.
        onChange={(next) => props.editor.updateBlock(props.block, { props: next } as never)}
      />
    ),
    /**
     * What leaves the app when a selection crosses this block. Without it
     * BlockNote falls back to the block's RENDERED text, so copying a page
     * would put "Reading list · Shelf" on the clipboard and the pointer
     * nowhere in it — the same defect `MermaidBlock` documents above. The
     * fence is what markdown.ts already demotes this block to for the disk.
     */
    toExternalHTML: (props) => {
      const database = String(props.block.props.database ?? '');
      const view = String(props.block.props.view ?? '');
      // Unset copies as the empty fence, the same spelling the disk uses.
      const body =
        database === '' ? '' : serializeDatabaseRef({ database, view: view === '' ? null : view });
      return (
        <pre>
          <code>{`\`\`\`${DATABASE_FENCE}\n${body}\n\`\`\``}</code>
        </pre>
      );
    },
  },
);

/**
 * The child-page list (M55.13): the page's sub-pages, listed live.
 *
 * It holds nothing — the list is derived from the vault every render — so on
 * disk it is an empty ```cerebro-subpages fence and on the clipboard the same
 * fence, never the rendered titles (DOM trap 5: with no `toExternalHTML`
 * BlockNote copies the rendered text).
 */
export const SubPagesBlock = createReactBlockSpec(
  { type: 'subPages', propSchema: {}, content: 'none' },
  {
    render: () => <SubPageList />,
    toExternalHTML: () => (
      <pre>
        <code>{`\`\`\`${SUBPAGES_FENCE}\n\`\`\``}</code>
      </pre>
    ),
  },
);

/**
 * The page card (M55.14): one other page, shown live — its icon, title and
 * status — and opened with Open.
 *
 * It holds a pointer and nothing else: on disk a ```cerebro-page fence with
 * one `[[target]]` or `[[target|alias]]`, empty while unset. The pointer is
 * kept exactly as written, so a missing target stays missing until the person
 * picks another page; the card never re-resolves or rewrites it on its own.
 * Only an editable editor hands the card a writer, so a read-only page shows
 * no picker.
 */
export const PageCardBlock = createReactBlockSpec(
  {
    type: 'pageCard',
    // '' rather than null, as on the database block: prop defaults are
    // primitives, and an empty alias is how "the link has none" survives.
    propSchema: { target: { default: '' }, alias: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => (
      <ConnectedPageCard
        target={String(props.block.props.target ?? '')}
        alias={String(props.block.props.alias ?? '')}
        onChange={
          props.editor.isEditable
            ? (ref) => props.editor.updateBlock(props.block, { props: ref } as never)
            : undefined
        }
      />
    ),
    /**
     * The fence, never the rendered face (DOM trap 5): without it a copy
     * would carry "How we scheduleOpen" and the pointer nowhere in it.
     */
    toExternalHTML: (props) => {
      const body = serializePageRef({
        target: String(props.block.props.target ?? ''),
        alias: String(props.block.props.alias ?? ''),
      });
      return (
        <pre>
          <code>{`\`\`\`${PAGE_CARD_FENCE}\n${body === '' ? '' : `${body}\n`}\`\`\``}</code>
        </pre>
      );
    },
  },
);

/**
 * A row of columns, and one column in it (M48.1).
 *
 * Both are `content: 'none'` and both render NOTHING of their own. That is
 * not an oversight, it is the design: BlockNote already renders a block's
 * children as a nested block group underneath it, so a column list is that
 * group turned into a flex row by CSS and a column is that group left
 * stacking the way it already stacks. The layout is CSS over the nesting the
 * editor has always had — not a second document model that could disagree
 * with the first.
 *
 * MEASURED before this was written (`@blocknote/core@0.46.2`): a
 * `content: 'none'` custom block DOES accept children, two levels deep, and
 * `editor.document` round-trips the nest with ids, props and content intact.
 * That observation is what makes this possible without
 * `@blocknote/xl-multi-column`, which is GPL-3.0-or-commercial against this
 * project's Apache-2.0 licence. `blocks.test.tsx` pins the observation so a
 * BlockNote upgrade that withdraws it fails loudly rather than silently
 * flattening somebody's page.
 */
export const ColumnListBlock = createReactBlockSpec(
  { type: 'columnList', propSchema: {}, content: 'none' },
  {
    // The children BlockNote renders below this ARE the block. An empty
    // element rather than nothing at all because the block needs a node to
    // hang its data attributes and, in M48.4, its drop targets on.
    render: () => <div className="cb-column-list" aria-hidden />,
    toExternalHTML: () => <p>{openListMarker(BASE_MARKER_DEPTH)}</p>,
  },
);

export const ColumnBlock = createReactBlockSpec(
  {
    type: 'column',
    // A flex RATIO, not pixels and not a percentage: a page that reflows keeps
    // its proportions, and a column dragged narrower on a desktop does not
    // become an unreadable ribbon on a laptop.
    propSchema: { width: { default: DEFAULT_COLUMN_WIDTH } },
    content: 'none',
  },
  {
    render: (props) => {
      const siblings = (props.editor.getParentBlock?.(props.block)?.children ?? []) as {
        id: string;
      }[];
      const at = siblings.findIndex((c) => c.id === props.block.id);
      return (
        <ColumnView
          id={props.block.id}
          width={Number(props.block.props.width ?? DEFAULT_COLUMN_WIDTH)}
          // The handle belongs to the column on the RIGHT of a gutter, because
          // that is the only column sure there IS one. The first column of a
          // row has nothing to its left, so it renders no handle — a row of N
          // columns gets N-1 gutters, which is how many a row of N columns
          // has. Not rendered rather than hidden: a hidden handle is still in
          // the document, still counted, and still something to explain.
          gutter={at > 0}
          onResize={(left, right) => {
            const before = siblings[at - 1];
            if (before === undefined) return;
            props.editor.updateBlock(before.id as never, { props: { width: left } } as never);
            props.editor.updateBlock(props.block, { props: { width: right } } as never);
          }}
        />
      );
    },
    /**
     * What leaves the app when a selection crosses a column.
     *
     * Without this BlockNote falls back to the block's RENDERED text — and
     * this block renders a stylesheet, so copying a column would put a CSS
     * rule on the clipboard. Same defect the mermaid block documents above,
     * with a sharper edge: there the leak was chrome labels, here it is a
     * selector. The marker line is what markdown.ts already demotes this
     * block to for the disk, so a paste into a text editor is the file.
     */
    toExternalHTML: (props) => (
      <p>
        {openColumnMarker(
          BASE_MARKER_DEPTH + 1,
          Number(props.block.props.width ?? DEFAULT_COLUMN_WIDTH),
        )}
      </p>
    ),
  },
);

/**
 * A column, and the one rule that sizes it.
 *
 * The element the browser lays out is this column's `.bn-block-outer`, two
 * levels ABOVE anything a block can render — and it belongs to ProseMirror,
 * which resets its attributes whenever it re-renders the node view. MEASURED
 * in a browser, not assumed: a pass that wrote `--cb-column-width` onto that
 * element reported moving two columns and left nothing behind, because
 * ProseMirror had already wiped both the inline style and the marker
 * attribute the probe went looking for. A `useLayoutEffect` inside the render
 * fared worse still — it runs before ProseMirror attaches the node view, so
 * it never found the ancestor at all.
 *
 * A stylesheet is how a descendant styles an ancestor. This one is rendered
 * INSIDE the node view, so it lives and dies with the block and ProseMirror
 * never touches it, and it is keyed on the `data-id` BlockNote already stamps
 * on the block outer. Nothing is emitted for a column at the default ratio:
 * the base rule in editor.css already says `flex: 1 1 0`, and a stylesheet
 * per column on a page of ordinary columns is noise.
 */
function ColumnView({
  id,
  width,
  gutter,
  onResize,
}: {
  id: string;
  width: number;
  gutter: boolean;
  onResize: (left: number, right: number) => void;
}) {
  // BlockNote ids are uuids, but this string is interpolated into a
  // stylesheet: anything that is not one does not get a rule.
  const usable = /^[A-Za-z0-9_-]+$/.test(id) && Number.isFinite(width) && width > 0;
  return (
    <>
      {width !== DEFAULT_COLUMN_WIDTH && usable && (
        <style>{`.cerebro-editor .bn-block-outer[data-id="${id}"]{flex-grow:${width};}`}</style>
      )}
      {/* Hidden from assistive tech only when it holds nothing: the gutter is
          a focusable `separator` with arrow keys, and inside `aria-hidden` it
          was neither announced nor valid. */}
      <div className="cb-column" aria-hidden={!gutter}>
        {gutter && <ColumnGutter id={id} onResize={onResize} />}
      </div>
    </>
  );
}
