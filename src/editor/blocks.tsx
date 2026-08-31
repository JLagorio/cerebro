import { useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { Icon } from '@/components/ui/Icon';
import { MermaidBlockView } from '@/mermaid/MermaidBlockView';
import { ConnectedDatabaseBlock } from '@/views/DatabaseBlockView';
import { DATABASE_FENCE, serializeDatabaseRef } from '@/engine/databaseBlock';
import { DEFAULT_COLUMN_WIDTH } from '@/engine/pageColumns';

/**
 * Custom blocks (M2.x docs polish). All of them stay plain markdown on disk:
 *
 *   callout     Obsidian-style `> [!info] …` blockquote
 *   mermaid     ```mermaid fenced code block
 *   database    ```cerebro-database fence holding a POINTER (M47.2)
 *   columnList  `:::columns` directive container (M48.1)
 *   column      `::::column` directive container (M48.1)
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
  onCycleKind,
  contentRef,
}: {
  kind: CalloutKind;
  onCycleKind: () => void;
  contentRef: (node: HTMLElement | null) => void;
}) {
  const style = CALLOUT_STYLE[kind] ?? CALLOUT_STYLE.info;
  return (
    <div
      data-testid="callout-block"
      data-kind={kind}
      className="my-0.5 flex w-full items-start gap-2.5 rounded-lg px-3.5 py-2.5"
      style={{ background: style.bg, borderLeft: `3px solid ${style.border}` }}
    >
      <button
        type="button"
        title={`${kind} — click to change`}
        aria-label={`Callout type: ${kind}`}
        contentEditable={false}
        onClick={onCycleKind}
        className="mt-px flex-none cursor-pointer border-0 bg-transparent p-0"
      >
        <Icon name={style.icon} size={16} color={style.fg} />
      </button>
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
        onCycleKind={() => {
          const current = props.block.props.kind as CalloutKind;
          const next = CALLOUT_KINDS[(CALLOUT_KINDS.indexOf(current) + 1) % CALLOUT_KINDS.length];
          props.editor.updateBlock(props.block, { props: { kind: next } } as never);
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
 * ## Why the content is ordinary markdown
 *
 * `content: 'inline'` — the generated text is editable prose like any other
 * block. Recomputing replaces it, but nothing stops a person fixing a line by
 * hand, and a block that fought that would be a block people delete. The
 * `generated` prop records when it was last answered, so "this was written by
 * the assistant on Tuesday" is visible rather than implied.
 */
function AiBlockView({
  prompt,
  generated,
  running,
  onEditPrompt,
  onRun,
  contentRef,
}: {
  prompt: string;
  generated: string;
  running: boolean;
  onEditPrompt: (prompt: string) => void;
  onRun: () => void;
  contentRef: (node: HTMLElement | null) => void;
}) {
  const [editing, setEditing] = useState(prompt.trim() === '');
  const [draft, setDraft] = useState(prompt);
  return (
    <div
      data-testid="ai-block"
      className="my-1 w-full rounded-lg border border-synapse-200 bg-synapse-25 px-3 py-2"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <Icon name="sparkles" size={12} color="var(--synapse-500)" />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onEditPrompt(draft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onEditPrompt(draft);
                setEditing(false);
                onRun();
              }
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label="What should this block answer?"
            placeholder="The open questions in this document…"
            className="min-w-0 flex-1 rounded border border-synapse-200 bg-n-0 px-1.5 py-0.5 text-xs outline-none"
          />
        ) : (
          <button
            type="button"
            data-testid="ai-block-prompt"
            onClick={() => {
              setDraft(prompt);
              setEditing(true);
            }}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-2xs text-synapse-700"
          >
            {prompt}
          </button>
        )}
        <button
          type="button"
          data-testid="ai-block-run"
          disabled={running || prompt.trim() === ''}
          onClick={onRun}
          className="flex-none rounded border-0 bg-transparent px-1 py-0.5 text-2xs text-synapse-700 hover:bg-synapse-50 disabled:opacity-40"
        >
          {running ? 'Working…' : generated === '' ? 'Answer' : 'Recompute'}
        </button>
      </div>
      {/* Ordinary editable prose. A generated block that refused hand-edits
          would be a block people delete rather than correct. */}
      <div ref={contentRef} className="text-sm leading-[20px] text-n-800" />
      {generated !== '' && (
        <div className="mt-1 text-2xs text-n-400">
          Answered {generated} — edit it, or ask again when the document moves on.
        </div>
      )}
    </div>
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
    content: 'inline',
  },
  {
    render: (props) => (
      <AiBlockView
        prompt={String(props.block.props.prompt ?? '')}
        generated={String(props.block.props.generated ?? '')}
        running={false}
        onEditPrompt={(prompt) =>
          props.editor.updateBlock(props.block, { props: { prompt } } as never)
        }
        onRun={() => {
          // The run itself is wired by the editor, which owns the vault path
          // and the agent IPC; the block owns the question and the answer.
          // Kept apart so this file stays free of app state and can be
          // rendered in a test with no store behind it.
          window.dispatchEvent(
            new CustomEvent('cerebro:ai-block-run', {
              detail: { id: props.block.id, prompt: String(props.block.props.prompt ?? '') },
            }),
          );
        }}
        contentRef={props.contentRef}
      />
    ),
  },
);

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
      <ConnectedDatabaseBlock
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
      const view = String(props.block.props.view ?? '');
      const body = serializeDatabaseRef({
        database: String(props.block.props.database ?? ''),
        view: view === '' ? null : view,
      });
      return (
        <pre>
          <code>{`\`\`\`${DATABASE_FENCE}\n${body}\n\`\`\``}</code>
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
    // Renders nothing, and does not render the ratio either: BlockNote hoists
    // a custom block's props onto the content element as data attributes
    // itself, omitting any that still sit at their default. Getting that value
    // onto the element the browser actually lays out is `syncColumnWidths`'
    // job (columnLayout.ts) — that element is two levels ABOVE anything this
    // render can see, and MEASURED, a `useLayoutEffect` here runs before
    // ProseMirror has attached the node view and never finds it.
    render: () => <div className="cb-column" aria-hidden />,
  },
);
