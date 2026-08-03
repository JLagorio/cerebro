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
      <div className="min-w-0 flex-1 text-[14px] leading-[1.5]" ref={contentRef} />
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
        <span className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-n-500">
          Mermaid
        </span>
        {error !== null && (
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-danger-600">{error}</span>
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
          className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[11.5px] text-n-500 hover:bg-n-50 hover:text-n-800"
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
          className="w-full resize-y border-0 bg-n-25 px-3 py-2 [font-family:var(--font-mono)] text-[12.5px] leading-[1.5] text-n-800 outline-none"
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
          className="w-full border-0 bg-transparent px-3 py-3 text-left text-[12.5px] text-n-400"
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
