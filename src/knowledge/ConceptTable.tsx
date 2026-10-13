import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { actorLabel, isAssistantActor } from '@/engine/authors';
import {
  folderLabel,
  recheckLine,
  REVIEW_LABELS,
  sourceCount,
  updatedAt,
  type Concept,
  type QueuedConcept,
} from '@/engine/okf';
import { kindMeta } from '@/engine/properties';
import type { Entry } from '@/engine/types';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { REASON, reasonText, startWholeQueueWalk } from '@/knowledge/ReviewQueue';
import type { ReviewCard } from '@/lib/ipc';
import { resolveOptionColor, type OptionColorName } from '@/lib/swatch';
import { todayIso } from '@/lib/templates';
import { linkLine, linkOf, reasonSentence, waitingLine } from '@/status/proposalText';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import {
  GroupBand,
  GUTTER,
  ROW_HEIGHT,
  ROW_MIN_HEIGHT,
  SelectValue,
  TABLE_ANATOMY,
  TITLE_INSET,
} from '@/views/tableAnatomy';
import { FADE_RIGHT, useOverflowRight } from '@/views/useOverflowRight';

/**
 * Knowledge's concepts as a table (M52.5): the Concepts tab, filed under the
 * bundle's folders, and the Review tab's queue, in the order it is worked.
 *
 * It was a centred 820px column of three-line entries — title, grey
 * description, grey type — with a status on few of them, so fifteen concepts
 * needed a scroll and nothing said which ones needed you. The owner,
 * 2026-09-29, of that page: "UI is still trash … wtf is that", and then the
 * brief: a table, like collections. So this is a view's table in everything
 * but its behaviour — the gutter, the header row, the row, the cell, the
 * select value, the group band and the row's Open pill are
 * `views/tableAnatomy`'s, the same pieces `TableView` draws with, so a title
 * starts where a view's does — and it is read-only: a row opens its concept,
 * which is a page (M50.1).
 *
 * The status is a view's select: a dot and a word, no pill. The rows that
 * need you say so in the dot's colour and a heavier word; what is settled —
 * reviewed, replaced, retired — is the same word in the plain weight. A
 * change an agent proposed is a mark beside the status, never in its place.
 * There is no type column: the type contradicted the folder it was filed in
 * as often as it repeated it.
 */

type Column = 'concept' | 'summary' | 'status' | 'folder' | 'sources' | 'author' | 'updated';

/** Each column's header, in `kindMeta`'s glyphs where a kind fits. */
const HEAD: Record<Column, { label: string; icon: string }> = {
  concept: { label: 'Concept', icon: 'type' },
  summary: { label: 'Summary', icon: 'align-left' },
  status: { label: 'Status', icon: kindMeta('status').icon },
  folder: { label: 'Folder', icon: 'folder' },
  sources: { label: 'Sources', icon: kindMeta('number').icon },
  author: { label: 'Written by', icon: kindMeta('person').icon },
  updated: { label: 'Updated', icon: kindMeta('last_edited_time').icon },
};

export type Layout = 'filed' | 'queue';

const COLUMNS: Record<Layout, readonly Column[]> = {
  filed: ['concept', 'summary', 'status', 'sources', 'author', 'updated'],
  queue: ['concept', 'summary', 'status', 'folder', 'sources', 'author', 'updated'],
};

/** The columns whose width is their own. The concept's is its titles', the
 * status's its widest word, and the summary — or, once it is gone, the
 * concept — takes what is left. */
const FIXED: Partial<Record<Column, number>> = {
  folder: 130,
  sources: 104,
  author: 170,
  updated: 104,
};

/**
 * The concept column is as wide as its longest title needs, and never
 * narrower than this. It has no ceiling while anything else can give way: it
 * was capped at `TableView`'s fit-to-content 520px, and a 68-character title
 * wrapped to two lines beside a Summary with 380px of blank room — one tall
 * row among one-line ones, which a view's table never draws.
 */
const CONCEPT_MIN = 320;
/**
 * Titles are the one thing in a row never cut ("Churn …", "Onboa…" beside a
 * full-width Status was the table giving up the word you were scanning for).
 * Once Summary and Updated have both stepped aside, a column narrower than
 * its longest title wraps them — the view's Wrap content, a row as tall as its
 * lines — down to this, and below it the table scrolls sideways in its own
 * box. It is low enough that the status, the reason a row is here, stays on
 * screen beside a wrapped title.
 */
const CONCEPT_WRAP_MIN = 200;
/** A summary narrower than this is a word and an ellipsis; it steps aside. */
const SUMMARY_MIN = 200;
/** The status column before its words are measured (jsdom never measures),
 * and the least it gets after. */
const STATUS_DEFAULT = 180;
const STATUS_MIN = 110;

/**
 * What steps aside so the summary keeps `SUMMARY_MIN` beside titles at their
 * whole width, in order — the columns a status already implies, then (in the
 * queue) the folder. Only when none of them is left does the summary go;
 * then Updated goes before the concept column would fall under its titles'
 * width (never under `CONCEPT_MIN`), and only then do the titles wrap, before
 * the table scrolls. Wrapping beside Summary or Updated gave rows of one, two
 * and three lines where a view's rows are one height. A view keeps its
 * columns and squeezes them: the width a column frees goes to the one column
 * that can squeeze — the summary while it is drawn, the concept after — and
 * never to an empty strip at the row's end.
 */
const MAKE_ROOM: Record<Layout, readonly Column[]> = {
  filed: ['sources', 'author'],
  queue: ['sources', 'author', 'folder'],
};

export interface Plan {
  columns: readonly Column[];
  /** Every drawn column's width at this room. The `fill` column's is what it
   * gets once the others have theirs; before layout it has none. */
  widths: Partial<Record<Column, number>>;
  /** The column that takes whatever the others leave: the summary while it
   * is drawn, else the concept — so the row always reaches its end. */
  fill: 'summary' | 'concept';
  /** Whether the concept column is narrower than its longest title, so the
   * titles wrap rather than truncate. */
  wrap: boolean;
  /** The least the table can be before its box scrolls sideways — the
   * gutter, the columns of their own width, and the concept at its width,
   * or at its wrapping floor once it is the one that fills. Null before
   * layout. */
  minWidth: number | null;
}

/**
 * Which columns this width holds (M52.5). Worked from the widths rather
 * than from container-query breakpoints, because the concept column's width
 * is the titles' and the status's is its words', and both move with them.
 * `width` is null before anything has been laid out (jsdom never is), and
 * then every column is drawn.
 */
export function planFor(
  layout: Layout,
  width: number | null,
  titleNeed: number,
  statusNeed: number = STATUS_DEFAULT,
): Plan {
  const own: Partial<Record<Column, number>> = {
    ...FIXED,
    status: Math.max(STATUS_MIN, statusNeed),
  };
  let columns = [...COLUMNS[layout]];
  const without = (column: Column) => columns.filter((c) => c !== column);
  // The gutter and every drawn column but the two that share the rest.
  const set = () =>
    columns.reduce(
      (sum, c) => (c === 'summary' || c === 'concept' ? sum : sum + (own[c] ?? 0)),
      GUTTER,
    );
  // The titles' whole width: while the summary is drawn, the column is this.
  const need = Math.max(CONCEPT_MIN, titleNeed);
  let concept = need;
  if (width !== null) {
    // What the summary would get beside it.
    const room = () => width - set() - need;
    for (const column of MAKE_ROOM[layout]) {
      if (room() >= SUMMARY_MIN) break;
      columns = without(column);
    }
    if (room() < SUMMARY_MIN) {
      columns = without('summary');
      // The concept takes the rest. Updated goes before the column would
      // fall under the titles' width — never under `CONCEPT_MIN` — and once
      // it is gone they wrap, down to the floor.
      if (width - set() < need) columns = without('updated');
      concept = Math.max(CONCEPT_WRAP_MIN, width - set());
    }
  }
  const fill = columns.includes('summary') ? 'summary' : 'concept';
  const widths: Partial<Record<Column, number>> = {};
  for (const column of columns) {
    if (column === 'concept') widths.concept = concept;
    else if (column !== 'summary') widths[column] = own[column];
    else if (width !== null) widths.summary = width - set() - concept;
  }
  return {
    columns,
    widths,
    fill,
    wrap: concept < titleNeed,
    minWidth: width === null ? null : set() + (fill === 'concept' ? CONCEPT_WRAP_MIN : concept),
  };
}

function cellStyle(plan: Plan, column: Column): React.CSSProperties {
  // The filling column's width is whatever is left, so it is laid out by
  // flex rather than set: a width the plan computed would lag the box by a
  // frame on every resize. The table's own floor keeps it from going under.
  const style: React.CSSProperties =
    column === plan.fill ? { flex: '1 1 0', minWidth: 0 } : { width: plan.widths[column] };
  // The last column reaches the table's edge, and draws no rule there — a
  // frame half drawn.
  return column === plan.columns[plan.columns.length - 1]
    ? { ...style, borderRightWidth: 0 }
    : style;
}

/** Where the bands' fold state is kept — `uiStore.collapsed`, as a view's is. */
const SCOPE = 'knowledge:concepts';
const REVIEW_SCOPE = 'knowledge:review';

const NO_PROPOSALS: readonly ReviewCard[] = [];

/**
 * A status dot's colour, by what it asks of the reader — named from the
 * option palette a view's select cells and group bands draw from
 * (`resolveOptionColor`), so this table's blue is Epic's blue in either
 * theme. The row dots were the brand's `--cortex-500`, which the dark theme
 * never re-tunes, beside a band dot in the palette's themed blue: two blues
 * for one state.
 */
const TONE_COLOR = {
  /** Nobody has read it. */
  accent: 'blue',
  /** It moved, or fell due. */
  warn: 'orange',
  /** Reviewed. */
  done: 'green',
  /** Replaced or retired. */
  muted: 'gray',
} as const satisfies Record<string, OptionColorName>;

type Tone = keyof typeof TONE_COLOR;

const dotColor = (tone: Tone) => resolveOptionColor(TONE_COLOR[tone]).solid;

/** One row's status: the word, its dot, whether it asks for the reader. */
interface RowStatus {
  label: string;
  dot: Tone;
  /** Something here waits on the reader: the word is set heavier. */
  strong: boolean;
  title: string;
  testId?: string;
  data?: Record<string, string>;
}

/**
 * The one status a row wears — the word its concept's page leads with
 * (M52.5): the review bar puts the chip for this same state first
 * (`ConceptReviewBar`), and a reason that is a review state is said in the
 * review chip's word (`REASON`), so a row and the page it opens never name
 * one state twice.
 *
 * 1. Replaced (M8.7) — resolved; nothing about it waits on anyone.
 * 2. The queue's reason (M51.2), whatever else is true.
 * 3. Past its recheck date but read by a person since (M52.3): the recheck
 *    is an agent's to make, so the plain weight.
 * 4. Retired, then reviewed.
 *
 * A change an agent proposed is never the status: it is the "+1 change" or
 * "+1 link" beside it (`StatusCell`). "Change proposed" in the status's place hid that
 * the concept was retired, or reviewed, while its page said so.
 */
function statusOf(
  layout: Layout,
  concept: Concept,
  queued: QueuedConcept | undefined,
  entries: Entry[],
  today: string,
): RowStatus {
  const inQueue = layout === 'queue';
  if (concept.supersededBy !== null) {
    return {
      label: 'Replaced',
      dot: 'muted',
      strong: false,
      title: 'Replaced by a newer concept',
      testId: 'replaced-tag',
    };
  }
  if (queued !== undefined) {
    const reason = REASON[queued.reason];
    return {
      label: reason.label,
      dot: reason.tone,
      strong: true,
      title: reasonText(queued, entries, today),
      testId: inQueue ? 'queue-reason' : queued.reason === 'stale' ? 'concept-row-due' : undefined,
    };
  }
  if (concept.stale) {
    return {
      label: REASON.stale.label,
      dot: 'warn',
      strong: false,
      title: `${recheckLine(concept, today)} — a person has read it since; the recheck is an agent's to make`,
      testId: 'concept-row-due',
    };
  }
  if (concept.lifecycle === 'deprecated') {
    return {
      label: REASON.deprecated.label,
      dot: 'muted',
      strong: false,
      title: 'Marked deprecated, and a person has reviewed it',
    };
  }
  // Out of the queue, not replaced, not retired: a current review. Who
  // reviewed it and when is the hover.
  const who =
    concept.reviewedBy === 'human'
      ? 'by a person'
      : concept.reviewedBy === 'agent'
        ? 'by an agent'
        : null;
  const when = relativeDay(concept.lastVerified, today);
  return {
    label: REVIEW_LABELS[concept.review],
    dot: concept.review === 'current' ? 'done' : 'accent',
    strong: false,
    title: [REVIEW_LABELS[concept.review], who, when].filter((p) => p !== null).join(' · '),
    testId: 'review-chip',
    data: { 'data-review': concept.review, 'data-by': concept.reviewedBy ?? 'nobody' },
  };
}

/**
 * What the mark beside a status says: how many changes agents proposed to the
 * concept, and — counted apart — how many links (M52.5). A link card marks
 * both concepts it connects, so four rows said "+1 change" under a header
 * counting three proposals; "+1 link" on each end reads as the one card.
 */
function markOf(proposals: readonly ReviewCard[]): {
  text: string;
  changes: ReviewCard[];
  links: ReviewCard[];
} {
  const links = proposals.filter((card) => linkOf(card) !== null);
  const changes = proposals.filter((card) => linkOf(card) === null);
  const count = (n: number, one: string, many: string) =>
    n === 0 ? null : `+${n} ${n === 1 ? one : many}`;
  const text = [count(changes.length, 'change', 'changes'), count(links.length, 'link', 'links')]
    .filter((part) => part !== null)
    .join(', ');
  return { text, changes, links };
}

/**
 * The status cell: the status as a view's select value, then — when agents
 * proposed changes to the concept — how many, as a small mark beside it
 * rather than in its place (M52.5). The mark is the AI's ink
 * (`--text-ai`), which flips for the dark theme: the light theme's violet
 * read at 2.6:1 on a dark row. Its hover is each card in a line: a change's
 * waiting line and reason, a link's headline naming the other end.
 */
function StatusCell({
  layout,
  status,
  proposals,
  here,
  titleOf,
}: {
  layout: Layout;
  status: RowStatus;
  proposals: readonly ReviewCard[];
  /** The concept this row is, so a link names its other end. */
  here: string;
  titleOf: (path: string) => string;
}) {
  const n = proposals.length;
  const mark = markOf(proposals);
  const hover = [
    ...(mark.changes.length === 0
      ? []
      : [waitingLine(mark.changes), ...mark.changes.map((card) => reasonSentence(card.reason))]),
    ...mark.links.flatMap((card) => {
      const link = linkOf(card);
      return link === null ? [] : [linkLine(link, titleOf, here), reasonSentence(card.reason)];
    }),
  ].filter((line) => line !== '');
  return (
    // Inline and unshrinking, so its box is its words' width even where the
    // cell clips it — what the column measures to fit.
    <span data-status-fit className="inline-flex flex-none items-center">
      <SelectValue
        color={dotColor(status.dot)}
        label={status.label}
        strong={status.strong}
        title={status.title}
        testId={status.testId}
        data={{ ...status.data, 'data-status-value': '' }}
      />
      {n > 0 && (
        <span
          data-testid={layout === 'queue' ? 'queue-proposal' : 'concept-proposal'}
          data-count={n}
          data-links={mark.links.length}
          className="flex-none text-xs font-medium"
          style={{ color: 'var(--text-ai)' }}
        >
          <span title={hover.join('\n')}>{mark.text}</span>
        </span>
      )}
    </span>
  );
}

/** A value nobody recorded, said in words (AGENTS.md: absent is never zero). */
function NotRecorded() {
  return <span className={`${TABLE_ANATOMY.oneLine} text-sm text-n-400`}>not recorded</span>;
}

/** Who wrote it, in the app's nouns (M50.3) — or that nobody recorded it. */
function WrittenBy({ concept, entries }: { concept: Concept; entries: Entry[] }) {
  if (concept.generated === null) {
    return <NotRecorded />;
  }
  const raw = concept.generated.by.raw;
  const who = actorLabel(raw, entries);
  const icon =
    who.actor !== undefined
      ? 'bot'
      : isAssistantActor(raw)
        ? 'sparkles'
        : concept.generated.by.kind === 'human'
          ? kindMeta('person').icon
          : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={raw}>
      {icon !== null && (
        <Icon
          name={icon}
          size={13}
          color={icon === kindMeta('person').icon ? 'var(--n-400)' : 'var(--synapse-500)'}
          className="flex-none"
        />
      )}
      <span className={`${TABLE_ANATOMY.value} ${TABLE_ANATOMY.oneLine}`}>{who.text}</span>
    </span>
  );
}

/** How many sources — never 0 for a list nobody wrote (AGENTS.md: absent is
 * never zero). An empty list is measured, and warns as the review bar does. */
function Sources({ concept }: { concept: Concept }) {
  const count = sourceCount(concept.entry);
  if (count === null) return <NotRecorded />;
  return (
    <span
      title={count === 0 ? 'Cites no source' : undefined}
      className={`text-sm [font-variant-numeric:tabular-nums] ${count === 0 ? 'text-warn-700' : 'text-n-600'}`}
    >
      {count}
    </span>
  );
}

/** The gutter a view's row keeps for its insert, checkbox and grip. Nothing
 * here edits, so it holds nothing — and is kept so a title starts where a
 * view's does. */
function Gutter() {
  return <div aria-hidden className="flex-none" style={{ width: GUTTER }} />;
}

function HeaderRow({ plan }: { plan: Plan }) {
  return (
    <div role="row" className={TABLE_ANATOMY.headerRow}>
      <Gutter />
      {plan.columns.map((column) => (
        <div
          key={column}
          role="columnheader"
          data-column={column}
          className={`${column === 'concept' ? TABLE_ANATOMY.titleHeader : TABLE_ANATOMY.header} items-center`}
          style={cellStyle(plan, column)}
        >
          <Icon name={HEAD[column].icon} size={12} color="var(--n-400)" className="flex-none" />
          <span className="min-w-0 truncate">{HEAD[column].label}</span>
        </div>
      ))}
    </div>
  );
}

function ConceptRow({
  layout,
  plan,
  concept,
  queued,
  proposals,
  entries,
  today,
}: {
  layout: Layout;
  plan: Plan;
  concept: Concept;
  queued: QueuedConcept | undefined;
  proposals: readonly ReviewCard[];
  entries: Entry[];
  today: string;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const replaced = concept.supersededBy !== null;
  const inQueue = layout === 'queue';
  const updated = updatedAt(concept);

  const cell = (column: Column): React.ReactNode => {
    switch (column) {
      case 'concept': {
        // The row's Open pill, as a view's row has it: laid out always, shown
        // on hover and focus, and the row's keyboard stop. Its click is the
        // row's.
        const open = (
          <button
            type="button"
            data-testid="concept-open"
            aria-label={`Open ${concept.title}`}
            className={
              plan.wrap
                ? // Beside wrapping titles it floats at the end of the first
                  // line, so the words flow around it rather than under it:
                  // centred over the cell, it covered the title it opens. The
                  // margins centre its 26px on the first 20px line, and leave
                  // its margin box reaching a pixel into the second line's —
                  // so the second line flows around it too, rather than
                  // under its lower edge — while a one-line title's row is
                  // no taller for it.
                  `${TABLE_ANATOMY.openPill} float-right -mb-[2px] -mt-[3px] ml-1.5`
                : TABLE_ANATOMY.openPill
            }
          >
            Open
          </button>
        );
        return (
          <>
            {/* The nesting slot a view's name cell keeps, so a title sits
                under its band's name as it does there. */}
            <span className="h-4 w-4 flex-none" />
            <Icon name="file-text" size={13} color="var(--n-400)" className="flex-none" />
            <span
              data-concept-title-box
              className={[
                // Wrapped rather than cut when the column is narrower than
                // the title: the view's Wrap content, on the one column that
                // is never given up.
                plan.wrap
                  ? `min-w-0 flex-1 text-left text-sm text-n-900 ${TABLE_ANATOMY.wrap}`
                  : TABLE_ANATOMY.title,
                replaced ? 'line-through' : '',
              ].join(' ')}
              // M8.7 — struck through, not hidden: what was believed before
              // stays readable.
              style={replaced ? { color: 'var(--n-400)' } : undefined}
            >
              {/* A float leads what flows around it. */}
              {plan.wrap && open}
              {/* Inline, so its box is the text's own width even where the
                  cell clips it — what the column measures to fit. */}
              <span data-concept-title>{concept.title}</span>
            </span>
            {!plan.wrap && open}
          </>
        );
      }
      case 'summary':
        // No description is the table's "none", as a view's empty cell says
        // it — a blank 700px strip read as a row that failed to load.
        return concept.description === null ? (
          <span className="text-sm text-n-300">—</span>
        ) : (
          <span
            className={`${TABLE_ANATOMY.oneLine} text-sm text-n-500`}
            title={concept.description}
          >
            {concept.description}
          </span>
        );
      case 'status':
        return (
          <span data-testid="concept-status" className="flex min-w-0">
            <StatusCell
              layout={layout}
              status={statusOf(layout, concept, queued, entries, today)}
              proposals={proposals}
              here={concept.entry.path}
              titleOf={(path) => entries.find((e) => e.path === path)?.title ?? path}
            />
          </span>
        );
      case 'folder':
        return (
          <span className={`${TABLE_ANATOMY.value} ${TABLE_ANATOMY.oneLine}`}>
            {folderLabel(concept.section)}
          </span>
        );
      case 'sources':
        return <Sources concept={concept} />;
      case 'author':
        return <WrittenBy concept={concept} entries={entries} />;
      case 'updated':
        return (
          <span className={`${TABLE_ANATOMY.value} ${TABLE_ANATOMY.oneLine}`} title={updated}>
            {relativeDay(updated, today) ?? 'unknown'}
          </span>
        );
    }
  };

  return (
    <div
      role="row"
      data-testid={inQueue ? 'queue-row' : 'concept-row'}
      data-path={concept.entry.path}
      data-reason={inQueue ? queued?.reason : undefined}
      onClick={() => {
        // A Review-tab row starts a walk of the whole queue, whose pager
        // ends at Review once nothing in it waits.
        if (inQueue) startWholeQueueWalk();
        navigate({ kind: 'doc', path: concept.entry.path });
      }}
      className={[
        TABLE_ANATOMY.row,
        // A row as tall as its title's lines, where they wrap (M12.4b).
        plan.wrap ? ROW_MIN_HEIGHT.default : ROW_HEIGHT.default,
        TABLE_ANATOMY.rowHover,
        // The keyboard cursor, drawn as a view's table draws its own.
        'cursor-pointer has-[:focus-visible]:bg-cortex-50 has-[:focus-visible]:shadow-[inset_2px_0_0_var(--cortex-500)]',
      ].join(' ')}
    >
      <Gutter />
      {plan.columns.map((column) => (
        <div
          key={column}
          role="cell"
          data-column={column}
          className={[
            column === 'concept' ? TABLE_ANATOMY.titleCell : TABLE_ANATOMY.cell,
            // Centred, wrapped or not: a two-line title's row keeps its
            // status level with the middle of it rather than its first line.
            'items-center',
            column === 'concept' && plan.wrap ? 'py-1.5' : '',
          ].join(' ')}
          style={
            column === 'concept'
              ? { ...cellStyle(plan, column), paddingLeft: TITLE_INSET }
              : cellStyle(plan, column)
          }
        >
          {cell(column)}
        </div>
      ))}
    </div>
  );
}

/**
 * What a column needs for its widest content, measured off the laid-out
 * table: the concept column's longest title (the chrome before it, the
 * title on one line, the Open pill and the cell's padding after it), and the
 * status column's widest word and mark. Null when nothing measured — an
 * unlaid-out table is no reason to squeeze.
 *
 * A title is measured unwrapped whatever the column is doing: set to one
 * line for the read and put back before anything paints, so a table already
 * wrapping its titles still knows how wide they are. The pill is counted at
 * its own width either way: beside one-line titles it follows the title
 * box, and beside wrapped ones it floats at the end of their first line.
 */
function titleNeed(table: HTMLElement): number | null {
  let widest = 0;
  for (const text of table.querySelectorAll<HTMLElement>('[data-concept-title]')) {
    const box = text.parentElement;
    const cell = text.closest<HTMLElement>('[role="cell"]');
    if (box === null || cell === null) continue;
    text.style.whiteSpace = 'nowrap';
    const line = text.getBoundingClientRect().width;
    text.style.whiteSpace = '';
    const style = getComputedStyle(cell);
    const pill = cell.querySelector<HTMLElement>('[data-testid="concept-open"]')?.offsetWidth ?? 0;
    const before = box.getBoundingClientRect().left - cell.getBoundingClientRect().left;
    const after =
      // `gap-1.5` before the pill, then the cell's padding and its rule.
      6 + pill + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
    widest = Math.max(widest, before + line + after);
  }
  return widest > 0 ? Math.ceil(widest) + 2 : null;
}

function statusNeed(table: HTMLElement): number | null {
  let widest = 0;
  for (const fit of table.querySelectorAll<HTMLElement>('[data-status-fit]')) {
    widest = Math.max(widest, fit.getBoundingClientRect().width);
  }
  // The cell's own padding (px-2 each side) and its rule.
  return widest > 0 ? Math.ceil(widest) + 16 + 1 + 2 : null;
}

/**
 * The table's measure and its plan. `content` is whatever changes what the
 * columns must fit: the titles and statuses drawn, and which bands are open.
 */
function useTable(layout: Layout, content: string) {
  const [measureRef, width] = useMeasuredWidth();
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [need, setNeed] = useState<{ title: number | null; status: number | null }>({
    title: null,
    status: null,
  });
  // Nothing is measured before the table has a width: jsdom lays nothing
  // out, and the plan draws every column until it knows better. A width
  // change moves no title's need, so only the first one counts.
  const laidOut = width !== null;
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!laidOut || table === null) return;
    let live = true;
    const measure = () => {
      if (!live) return;
      const title = titleNeed(table);
      const status = statusNeed(table);
      setNeed((prev) =>
        (title ?? prev.title) === prev.title && (status ?? prev.status) === prev.status
          ? prev
          : { title: title ?? prev.title, status: status ?? prev.status },
      );
    };
    measure();
    // A title measured in the fallback font is the wrong width once the
    // real one arrives.
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, [content, laidOut]);
  const plan = useMemo(
    () => planFor(layout, width, need.title ?? CONCEPT_MIN, need.status ?? STATUS_DEFAULT),
    [layout, width, need],
  );
  return { measureRef, tableRef, plan, width };
}

/**
 * The table's frame: its own scroll box, as a view's table has (M52.5). The
 * box measures the room — the plan answers to its width — and the table in
 * it never gets narrower than the plan's floor: below that the BOX scrolls
 * sideways, and fades at its right edge while there is more, so what scrolls
 * is the table alone. It was the page's scroller, which took the cards and
 * the headings under the table sideways with it, and faded them at rest.
 *
 * `fill` makes the box the page's scroller both ways, a view's table's
 * frame, so the header row stays pinned while the rows scroll under it —
 * Concepts, where the table is the page. Review's queue has the cards under
 * it in the page's own scroll, so its box scrolls only sideways, and only
 * while the table is wider than it: a box that scrolls one way clips the
 * other, which would take the header's pin with it for nothing.
 */
function Table({
  label,
  testId,
  plan,
  width,
  measureRef,
  tableRef,
  fill,
  children,
}: {
  label: string;
  testId: string;
  plan: Plan;
  width: number | null;
  measureRef: (el: HTMLElement | null) => (() => void) | undefined;
  tableRef: React.RefObject<HTMLDivElement | null>;
  fill: boolean;
  children: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const box = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      return measureRef(el);
    },
    [measureRef],
  );
  const overflows = width !== null && plan.minWidth !== null && plan.minWidth > width;
  const moreRight = useOverflowRight(boxRef, plan.minWidth);
  return (
    <div
      ref={box}
      data-testid={`${testId}-scroll`}
      className={
        fill
          ? 'min-h-0 min-w-0 flex-1 overflow-auto'
          : `min-w-0 ${overflows ? 'overflow-x-auto' : ''}`
      }
      style={moreRight ? FADE_RIGHT : undefined}
    >
      <div
        ref={tableRef}
        role="table"
        aria-label={label}
        data-testid={testId}
        style={{ minWidth: plan.minWidth ?? undefined }}
      >
        <HeaderRow plan={plan} />
        {children}
      </div>
    </div>
  );
}

export interface FiledSection {
  folder: string;
  label: string;
  concepts: Concept[];
}

/** What changes the columns' fit: each row's title and status words. */
function contentKey(
  layout: Layout,
  rows: readonly { concept: Concept; queued: QueuedConcept | undefined }[],
  proposals: ReadonlyMap<string, readonly ReviewCard[]> | undefined,
  entries: Entry[],
  today: string,
): string {
  return rows
    .map(({ concept, queued }) => {
      const cards = proposals?.get(concept.entry.path) ?? NO_PROPOSALS;
      const status = statusOf(layout, concept, queued, entries, today);
      return `${concept.title}\t${status.label}\t${markOf(cards).text}`;
    })
    .join('\n');
}

/**
 * Every concept, filed under its folder — the Concepts tab, and a folder's
 * own view (one section, drawn without a band: the crumb above already says
 * which folder this is). A band folds; its name opens the folder, where
 * `onOpenFolder` is given. The table runs edge to edge under the tab strip,
 * as a view's does.
 */
export function ConceptTable({
  sections,
  queue,
  proposals,
  onOpenFolder,
}: {
  sections: FiledSection[];
  /** The review queue, so a row can say what it waits on. */
  queue: readonly QueuedConcept[];
  /** Queued cards by concept path; undefined when the queue could not be read,
   * which marks no row. */
  proposals?: ReadonlyMap<string, readonly ReviewCard[]>;
  onOpenFolder?: (folder: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const collapsed = useUiStore((s) => s.collapsed[SCOPE]);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const today = todayIso();
  const queued = new Map(queue.map((q) => [q.concept.entry.path, q]));
  const banded = sections.length > 1;
  const shut = (folder: string) => banded && collapsed?.[folder] === true;
  const drawn = sections.flatMap((s) =>
    shut(s.folder)
      ? []
      : s.concepts.map((concept) => ({ concept, queued: queued.get(concept.entry.path) })),
  );
  const { measureRef, tableRef, plan, width } = useTable(
    'filed',
    contentKey('filed', drawn, proposals, entries, today),
  );
  return (
    <Table
      label="Concepts"
      testId="concept-list"
      plan={plan}
      width={width}
      measureRef={measureRef}
      tableRef={tableRef}
      fill
    >
      {sections.map((section) => (
        <div
          key={section.folder}
          role="rowgroup"
          data-testid="concept-section"
          data-folder={section.folder}
        >
          {banded && (
            <GroupBand
              label={section.label}
              count={section.concepts.length}
              // A filled dot, as a view's real groups have: the hollow one
              // is a view's "no value" group, and read as an empty radio.
              color="gray"
              inset={GUTTER}
              collapsed={shut(section.folder)}
              onToggle={() => toggleCollapsed(SCOPE, section.folder)}
              onOpen={onOpenFolder === undefined ? undefined : () => onOpenFolder(section.folder)}
              testId="concept-group"
            />
          )}
          {!shut(section.folder) &&
            section.concepts.map((concept) => (
              <ConceptRow
                key={concept.entry.path}
                layout="filed"
                plan={plan}
                concept={concept}
                queued={queued.get(concept.entry.path)}
                proposals={proposals?.get(concept.entry.path) ?? NO_PROPOSALS}
                entries={entries}
                today={today}
              />
            ))}
        </div>
      ))}
    </Table>
  );
}

/**
 * The review queue (M51.2), in the order it is worked — so not filed by
 * folder: the folder is a column. It runs edge to edge like Concepts, under
 * one band that names it (M52.5), so the Review tab is one measure from the
 * table down to the cards beneath it.
 *
 * Every row wears its queue reason: the proposals are the cards below, so a
 * row with one waiting keeps saying why it is queued and marks the card
 * beside it.
 */
export function ReviewQueueList({
  queue,
  proposals,
}: {
  queue: QueuedConcept[];
  /** Queued cards by the concept path they target (`proposalsByPath`). */
  proposals?: ReadonlyMap<string, readonly ReviewCard[]>;
}) {
  const entries = useVaultStore((s) => s.entries);
  const shut = useUiStore((s) => s.collapsed[REVIEW_SCOPE]?.queue === true);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const today = todayIso();
  const { measureRef, tableRef, plan, width } = useTable(
    'queue',
    shut
      ? ''
      : contentKey(
          'queue',
          queue.map((item) => ({ concept: item.concept, queued: item })),
          proposals,
          entries,
          today,
        ),
  );
  return (
    <Table
      label="Review queue"
      testId="review-queue"
      plan={plan}
      width={width}
      measureRef={measureRef}
      tableRef={tableRef}
      fill={false}
    >
      <div role="rowgroup">
        <GroupBand
          label="To verify"
          count={queue.length}
          // The accent a waiting row's dot wears, from the same palette.
          color={TONE_COLOR.accent}
          inset={GUTTER}
          collapsed={shut}
          onToggle={() => toggleCollapsed(REVIEW_SCOPE, 'queue')}
          // One clause (M52.5): the sentence it was cut mid-word at 1440.
          note="Waiting for a person to confirm"
          testId="review-group"
        />
        {!shut &&
          queue.map((item) => (
            <ConceptRow
              key={item.concept.entry.path}
              layout="queue"
              plan={plan}
              concept={item.concept}
              queued={item}
              proposals={proposals?.get(item.concept.entry.path) ?? NO_PROPOSALS}
              entries={entries}
              today={today}
            />
          ))}
      </div>
    </Table>
  );
}
