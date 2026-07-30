import { useRef, useState } from 'react';
import { createReactInlineContentSpec } from '@blocknote/react';
import { DatePicker } from '@/components/ui/DatePicker';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import {
  chipPropsToDateValue,
  dateValueToChipProps,
  formatDateValue,
  serializeDateValue,
  type DateChipProps,
  type DateValue,
} from '@/engine/dates';
import { dueBucket } from '@/engine/tasks';
import { resolveTarget } from '@/engine/wikilink';
import { todayIso } from '@/lib/templates';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

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

export const dueText = (props: Partial<DateChipProps>): string =>
  serializeDateValue(chipPropsToDateValue(props));

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
  const schema = useSchema();
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
      {/* M9.6: the target's own type, so a linked Risk reads as a Risk. */}
      <Icon name={typeStyle(resolved?.type ?? null, schema).icon} size={12} />
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
  chipProps,
  onChange,
  onRemove,
}: {
  chipProps: Partial<DateChipProps>;
  onChange: (v: DateValue) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  const today = todayIso();
  const value = chipPropsToDateValue(chipProps);
  const bucket = dueBucket(value.end ?? value.start, today);
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
        onClick={() => setEditing((v) => !v)}
        className={`${CHIP_BASE} cursor-pointer border-0 ${tone} hover:opacity-80`}
        title="Change date"
      >
        <Icon name="calendar" size={12} />
        {formatDateValue(value, today)}
        {value.remind !== null && <Icon name="bell" size={11} />}
      </button>
      {editing && (
        <span
          className="absolute left-0 top-[calc(100%+4px)] z-30"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
        >
          <DatePicker
            value={value}
            onChange={onChange}
            onClear={() => {
              setEditing(false);
              onRemove();
            }}
          />
        </span>
      )}
    </span>
  );
}

export const DueChip = createReactInlineContentSpec(
  {
    type: 'due',
    propSchema: {
      date: { default: '' },
      end: { default: '' },
      time: { default: '' },
      endTime: { default: '' },
      format: { default: '' },
      timeFormat: { default: '' },
      remind: { default: '' },
    },
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
            chipProps={props.inlineContent.props}
            onChange={(v) =>
              props.updateInlineContent({ type: 'due', props: dateValueToChipProps(v) })
            }
            onRemove={() => deleteInlineNodeAt(props.editor, dom)}
          />
        </span>
      );
    },
    toExternalHTML: (props) => <span>{dueText(props.inlineContent.props)}</span>,
  },
);
