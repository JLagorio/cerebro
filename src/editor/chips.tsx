import { useContext, useMemo, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { createReactInlineContentSpec, useEditorState } from '@blocknote/react';
import { DatePicker } from '@/components/ui/DatePicker';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import {
  chipPropsToDateValue,
  dateValueToChipProps,
  formatDateValue,
  type DateChipProps,
  type DateValue,
} from '@/engine/dates';
import { parseSources } from '@/engine/okf';
import { dueBucket } from '@/engine/tasks';
import { resolveTarget } from '@/engine/wikilink';
import { todayIso } from '@/lib/templates';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { citationIndexOf, citationName, citationNumber, sourceTarget } from './citations';
import { assigneeText, citationText, dueText, wikilinkText } from './markdown';
import { NotePathContext } from './notePath';

/**
 * Inline chips (M2.x docs polish). Custom inline nodes that keep the file
 * plain markdown while rendering rich in the editor:
 *
 *   wikilink  `[[target]]` / `[[target|alias]]`  — doc-to-doc link
 *   assignee  `@[[person]]`                      — task assignee
 *   due       `📅 YYYY-MM-DD`                    — task due date
 *   citation  `[^id]` / `[^id]:`                 — footnote reference / definition (M51.5)
 *
 * Each chip's plain-text form lives in markdown.ts, beside the parser that
 * reads it back: that module writes chips to disk as that text, and
 * toExternalHTML here emits the same text for the clipboard.
 */

/** Delete the inline node rendered at `dom` (due-chip "Remove"). Best-effort:
 * ProseMirror positions via posAtDOM; on any failure the chip just stays and
 * backspace still works. */
function deleteInlineNodeAt(editor: unknown, dom: HTMLElement | null): void {
  try {
    if (dom === null) return;
    const e = editor as {
      prosemirrorView?: {
        posAtDOM(n: Node, o: number): number;
        state: any;
        dispatch(tr: any): void;
      };
      _tiptapEditor?: {
        view: { posAtDOM(n: Node, o: number): number; state: any; dispatch(tr: any): void };
      };
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
          ? `${CHIP_BASE} cursor-pointer border-0 bg-cortex-50 font-medium text-cortex-600 hover:underline`
          : `${CHIP_BASE} cursor-default border-0 bg-n-50 text-n-500 [text-decoration:underline] [text-decoration-style:dashed] [text-underline-offset:2px]`
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
      className={`${CHIP_BASE} cursor-pointer border border-n-200 bg-n-0 text-n-700 hover:border-n-300 hover:bg-n-50`}
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
      ? 'bg-danger-50 text-danger-600'
      : bucket === 'today'
        ? 'bg-warn-50 text-warn-700'
        : 'bg-n-50 text-n-600';

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

// The number badge the concept's Sources list draws (KnowledgePanel's
// SourceRow), a step smaller: the same source should look like the same thing
// in the text and in the list beside it.
const CITATION_PILL =
  'inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-2xs font-semibold no-underline [font-family:var(--font-mono)]';

function CitationRender({
  id,
  definition,
  editor,
}: {
  id: string;
  definition: boolean;
  editor: BlockNoteEditor<any, any, any>;
}) {
  const path = useContext(NotePathContext);
  const entries = useVaultStore((s) => s.entries);
  const open = useOpenPath();
  const entry = path === null ? undefined : entries.find((e) => e.path === path);
  const sources = useMemo(() => (entry === undefined ? [] : parseSources(entry)), [entry]);
  // Read again on every edit, re-rendered only when THIS chip's answer
  // changes: deleting a definition renumbers the citations after it and
  // leaves every other chip alone.
  const cite = useEditorState({
    editor,
    on: 'change',
    selector: ({ editor: current }) => {
      const index = citationIndexOf(current);
      return {
        number: citationNumber(id, sources, index),
        defined: index.defined.includes(id),
        name: citationName(id, sources, index, entries),
      };
    },
  });

  const source = sources.find((s) => s.id === id) ?? null;
  const target = source === null ? null : sourceTarget(source.resource, entries);
  const page =
    target !== null && 'internal' in target
      ? entries.find((e) => e.path === target.internal)
      : undefined;
  // What the Sources list calls it, then what the page's own definition says:
  // `citationName`, the rule the `[^` menu names a source by too (M52.1).
  const { name } = cite;
  // Cited but neither listed nor defined: muted, never hidden — a claim that
  // cites nothing is what a reviewer most needs to see.
  const tone =
    source !== null || cite.defined ? 'bg-cortex-50 text-cortex-600' : 'bg-n-100 text-n-500';
  // A hook, not a style: editor.css reads a paragraph that OPENS with one as
  // the sources list (M52.1). A class rather than the `data-citation` below,
  // because jsdom cannot evaluate an attribute selector inside `:has()`, and
  // a rule nothing can test is a rule nothing stops from rotting.
  const pillClass = `${CITATION_PILL} ${tone}${definition ? ' cb-citation-def' : ''}`;
  const label = cite.number === null ? id : String(cite.number);
  const common = {
    // The marker the number stands in for, under the name: it is still in the
    // file, and it is what anyone citing the same source again has to type.
    title: `${name}\n${citationText({ id, def: definition ? '1' : '' })}`,
    'aria-label': `Source ${label}: ${name}`,
    'data-citation': definition ? 'def' : 'ref',
    'data-id': id,
  };

  const pill =
    target !== null && 'external' in target ? (
      <a
        {...common}
        href={target.external}
        target="_blank"
        rel="noreferrer noopener"
        tabIndex={-1}
        className={`${pillClass} hover:bg-cortex-100`}
      >
        {label}
      </a>
    ) : page !== undefined ? (
      <button
        {...common}
        type="button"
        tabIndex={-1}
        onClick={() => open(page.path)}
        className={`${pillClass} cursor-pointer border-0 hover:bg-cortex-100`}
      >
        {label}
      </button>
    ) : (
      <span {...common} className={`${pillClass} cursor-default`}>
        {label}
      </span>
    );

  // A reference rides above the line it cites from; a definition's badge
  // opens its own line, level with the words it introduces. Preflight already
  // takes a `<sup>` out of the line-height sum (`line-height: 0`, raised by
  // `top` rather than `vertical-align`), so a cited line is exactly as tall as
  // an uncited one — measured in the app, both paragraphs 48px.
  return definition ? pill : <sup>{pill}</sup>;
}

/**
 * A footnote citation (M51.5): `[^id]` cites a source and `[^id]:` opens its
 * definition. Both show the source's NUMBER in place of the raw marker — the
 * marker is what a file needs, and the number is what a reader does.
 */
export const CitationChip = createReactInlineContentSpec(
  {
    type: 'citation',
    propSchema: { id: { default: '' }, def: { default: '' } },
    content: 'none',
  },
  {
    render: (props) => (
      <CitationRender
        id={props.inlineContent.props.id}
        definition={props.inlineContent.props.def === '1'}
        editor={props.editor}
      />
    ),
    toExternalHTML: (props) => <span>{citationText(props.inlineContent.props)}</span>,
  },
);
