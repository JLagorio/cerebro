import { useRef, useState } from 'react';
import { createReactInlineContentSpec } from '@blocknote/react';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { dueBucket, formatDue } from '@/engine/tasks';
import { resolveTarget } from '@/engine/wikilink';
import { todayIso } from '@/lib/templates';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Inline chips (M2.x docs polish). Three custom inline nodes that keep the
 * file plain markdown while rendering rich in the editor:
 *
 *   wikilink  `[[target]]` / `[[target|alias]]`  — doc-to-doc link
 *   assignee  `@[[person]]`                      — task assignee
 *   due       `📅 YYYY-MM-DD`                    — task due date
 *
 * toExternalHTML emits exactly the plain-text form, so markdown export
 * round-trips; markdown.ts re-promotes the text back into chips on load.
 */

export const wikilinkText = (props: { target: string; alias: string }): string =>
  props.alias !== '' ? `[[${props.target}|${props.alias}]]` : `[[${props.target}]]`;

export const assigneeText = (props: { target: string }): string => `@[[${props.target}]]`;

export const dueText = (props: { date: string }): string => `📅 ${props.date}`;

/** Delete the inline node rendered at `dom` (due-chip "Remove"). Best-effort:
 * ProseMirror positions via posAtDOM; on any failure the chip just stays and
 * backspace still works. */
function deleteInlineNodeAt(editor: unknown, dom: HTMLElement | null): void {
  try {
    if (dom === null) return;
    const e = editor as {
      prosemirrorView?: { posAtDOM(n: Node, o: number): number; state: any; dispatch(tr: any): void };
      _tiptapEditor?: { view: { posAtDOM(n: Node, o: number): number; state: any; dispatch(tr: any): void } };
    };
    const view = e.prosemirrorView ?? e._tiptapEditor?.view;
    if (view === undefined) return;
    const pos = view.posAtDOM(dom, 0);
    const state = view.state;
    for (const p of [pos, pos - 1]) {
      const node = p >= 0 ? state.doc.nodeAt(p) : null;
      if (node !== null && node.isInline && !node.isText) {
        view.dispatch(state.tr.delete(p, p + node.nodeSize));
        return;
      }
    }
  } catch {
    // Leave the chip in place; it can still be deleted with backspace.
  }
}

const CHIP_BASE =
  'inline-flex select-none items-center gap-1 rounded-md px-1 py-px align-baseline text-[0.92em] leading-[1.35]';

function WikilinkRender({ target, alias }: { target: string; alias: string }) {
  const entries = useVaultStore((s) => s.entries);
  const open = useOpenPath();
  const resolved = resolveTarget(target, entries);
  const label = alias !== '' ? alias : (resolved?.title ?? target);

  return (
    <button
      type="button"
      data-chip="wikilink"
      tabIndex={-1}
      onClick={() => {
        if (resolved !== null) open(resolved.path);
      }}
      className={
        resolved !== null
          ? `${CHIP_BASE} cursor-pointer border-0 bg-[var(--cortex-50)] font-medium text-[var(--cortex-600)] hover:underline`
          : `${CHIP_BASE} cursor-default border-0 bg-[var(--n-50)] text-[var(--n-500)] [text-decoration:underline] [text-decoration-style:dashed] [text-underline-offset:2px]`
      }
      title={resolved !== null ? resolved.path : `No page named "${target}"`}
    >
      <Icon name="file-text" size={12} />
      {label}
    </button>
  );
}

export const WikilinkChip = createReactInlineContentSpec(
  {
    type: 'wikilink',
    propSchema: { target: { default: '' }, alias: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => (
      <WikilinkRender
        target={props.inlineContent.props.target}
        alias={props.inlineContent.props.alias}
      />
    ),
    toExternalHTML: (props) => <span>{wikilinkText(props.inlineContent.props)}</span>,
  },
);

function AssigneeRender({ target }: { target: string }) {
  const entries = useVaultStore((s) => s.entries);
  const open = useOpenPath();
  const resolved = resolveTarget(target, entries);

  return (
    <button
      type="button"
      data-chip="assignee"
      tabIndex={-1}
      onClick={() => {
        if (resolved !== null) open(resolved.path);
      }}
      className={`${CHIP_BASE} cursor-pointer border border-[var(--n-200)] bg-[var(--n-0)] text-[var(--n-700)] hover:border-[var(--n-300)] hover:bg-[var(--n-50)]`}
      title={resolved !== null ? resolved.path : `No person named "${target}"`}
    >
      <Icon name="circle-user" size={12} color="var(--n-500)" />
      {resolved?.title ?? target}
    </button>
  );
}

export const AssigneeChip = createReactInlineContentSpec(
  {
    type: 'assignee',
    propSchema: { target: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => <AssigneeRender target={props.inlineContent.props.target} />,
    toExternalHTML: (props) => <span>{assigneeText(props.inlineContent.props)}</span>,
  },
);

function DueRender({
  date,
  onChange,
  onRemove,
}: {
  date: string;
  onChange: (date: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(date);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  const bucket = dueBucket(date, todayIso());
  const tone =
    bucket === 'overdue'
      ? 'bg-[var(--danger-50,#fdecec)] text-[var(--danger-600,#c5372c)]'
      : bucket === 'today'
        ? 'bg-[var(--warn-50,#fdf3e2)] text-[var(--warn-700,#8a5a13)]'
        : 'bg-[var(--n-50)] text-[var(--n-600)]';

  return (
    <span ref={rootRef} className="relative inline-flex" data-chip="due" contentEditable={false}>
      <button
        type="button"
        tabIndex={-1}
        onClick={() => {
          setDraft(date);
          setEditing((v) => !v);
        }}
        className={`${CHIP_BASE} cursor-pointer border-0 ${tone} hover:opacity-80`}
        title="Change due date"
      >
        <Icon name="calendar" size={12} />
        {formatDue(date)}
      </button>
      {editing && (
        <span
          className="absolute left-0 top-[calc(100%+4px)] z-30 flex items-center gap-1.5 rounded-lg border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-md)]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            type="date"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft !== '') {
                onChange(draft);
                setEditing(false);
              }
              if (e.key === 'Escape') setEditing(false);
            }}
            className="h-7 rounded-md border border-[var(--n-200)] px-1.5 text-[12px] text-[var(--n-800)]"
          />
          <button
            type="button"
            onClick={() => {
              if (draft !== '') onChange(draft);
              setEditing(false);
            }}
            className="h-7 rounded-md border-0 bg-[var(--cortex-500)] px-2 text-[12px] font-medium text-[var(--n-0)]"
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              onRemove();
            }}
            className="h-7 rounded-md border-0 bg-transparent px-1.5 text-[12px] text-[var(--n-500)] hover:text-[var(--danger-600,#c5372c)]"
          >
            Remove
          </button>
        </span>
      )}
    </span>
  );
}

export const DueChip = createReactInlineContentSpec(
  {
    type: 'due',
    propSchema: { date: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => {
      let dom: HTMLElement | null = null;
      return (
        <span
          ref={(n) => {
            dom = n;
          }}
        >
          <DueRender
            date={props.inlineContent.props.date}
            onChange={(date) => props.updateInlineContent({ type: 'due', props: { date } })}
            onRemove={() => deleteInlineNodeAt(props.editor, dom)}
          />
        </span>
      );
    },
    toExternalHTML: (props) => <span>{dueText(props.inlineContent.props)}</span>,
  },
);
