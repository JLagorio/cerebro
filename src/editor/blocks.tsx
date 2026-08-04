import { useEffect, useRef, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { Icon } from '@/components/ui/Icon';

/**
 * Custom blocks (M2.x docs polish). Both stay plain markdown on disk:
 *
 *   callout  Obsidian-style `> [!info] …` blockquote
 *   mermaid  ```mermaid fenced code block
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

let mermaidId = 0;

function MermaidView({
  code,
  onChangeCode,
}: {
  code: string;
  onChangeCode: (code: string) => void;
}) {
  const [editing, setEditing] = useState(code.trim() === '');
  const [draft, setDraft] = useState(code);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef(`cerebro-mermaid-${++mermaidId}`);

  useEffect(() => {
    let cancelled = false;
    if (code.trim() === '') {
      setSvg(null);
      return;
    }
    void (async () => {
      try {
        // Lazy import: mermaid is heavy and only needed when a diagram is
        // actually on screen.
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        const { svg: rendered } = await mermaid.render(idRef.current, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message.split('\n')[0] : 'Invalid diagram');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const commit = () => {
    setEditing(false);
    if (draft !== code) onChangeCode(draft);
  };

  return (
    <div
      data-testid="mermaid-block"
      contentEditable={false}
      className="my-1 w-full rounded-lg border border-n-200 bg-n-0"
    >
      <div className="flex items-center gap-1.5 border-b border-n-100 px-2.5 py-1">
        <Icon name="waypoints" size={13} color="var(--n-500)" />
        <span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">Mermaid</span>
        {error !== null && (
          <span className="min-w-0 flex-1 truncate text-xs text-danger-600">{error}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          // Without this the textarea blurs FIRST, commit() flips `editing`
          // false, and the click then lands on the (now) "Edit" branch —
          // reopening the source box the button just closed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (editing) commit();
            else {
              setDraft(code);
              setEditing(true);
            }
          }}
          className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      {editing && (
        <textarea
          autoFocus
          aria-label="Mermaid source"
          value={draft}
          placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.stopPropagation()}
          rows={Math.max(4, draft.split('\n').length + 1)}
          className="w-full resize-y border-0 bg-n-25 px-3 py-2 [font-family:var(--font-mono)] text-sm leading-[1.5] text-n-800 outline-none"
        />
      )}
      {!editing && svg !== null && (
        <div
          className="overflow-x-auto px-3 py-2 [&_svg]:max-w-full"
          // dangerouslySetInnerHTML is safe here: mermaid sanitizes its own SVG output.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {!editing && svg === null && (
        <button
          type="button"
          onClick={() => {
            setDraft(code);
            setEditing(true);
          }}
          className="w-full border-0 bg-transparent px-3 py-3 text-left text-sm text-n-400"
        >
          {error !== null
            ? 'Fix the diagram source…'
            : 'Empty diagram — click to add mermaid source'}
        </button>
      )}
    </div>
  );
}

export const MermaidBlock = createReactBlockSpec(
  {
    type: 'mermaid',
    propSchema: { code: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => (
      <MermaidView
        code={props.block.props.code as string}
        onChangeCode={(code) => props.editor.updateBlock(props.block, { props: { code } } as never)}
      />
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
