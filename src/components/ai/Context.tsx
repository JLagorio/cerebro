// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { Fragment, type ReactNode } from 'react';
import { HoverCard } from '@/components/ui/HoverCard';
import type { ContextCategoryKind } from '@/engine/ai/contextBreakdown';
import './conversation.css';
import './context-categories.css';

/**
 * How much of the model's context window the conversation has used (M91.8,
 * shadcn's Context): a ring and its figure in the composer's toolbar, and
 * the detail in a hover card — used of the window, the model, and the
 * input, cache and output counts when they are given.
 *
 * Its name is the reading itself ("62% of context used", "Context use not
 * recorded", "Context use unavailable"), never a "Context:" prefix, and the
 * ring is decoration. A count nobody recorded is words, never 0 (CV-05):
 * not recorded draws an empty dashed ring, and unavailable — a read that
 * failed — says so, never "not recorded".
 *
 * `ContextCategories` (M92.14) draws what the context holds, row by row,
 * as Claude's own Context card does: a segmented bar of the window and a
 * legend of its rows with their tokens and share.
 */

/** Token counts behind the total, each as recorded. */
export interface ContextBreakdown {
  input?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
}

/** One reading of the conversation's context use. */
export type ContextUsage =
  | {
      state: 'recorded';
      /** Tokens in the context. */
      used: number;
      /** The model's context window; null when it was not reported. */
      window?: number | null;
      /** The model that reported it; null when not reported. */
      model?: string | null;
      breakdown?: ContextBreakdown;
    }
  | { state: 'not_recorded' }
  | { state: 'unavailable' };

/** The words for what could not be read. */
export const CONTEXT_WORDS = {
  notRecorded: 'Context use not recorded',
  unavailable: 'Context use unavailable',
  notRecordedDetail: 'It is read when a turn ends.',
  unavailableDetail: 'Cerebro could not read it.',
  windowNotRecorded: 'Context window not recorded',
  valueNotRecorded: 'not recorded',
  /** A deferred row's value: held outside the window, it takes none of it. */
  notLoaded: 'not loaded',
  /** Rows past what was kept, counted. */
  moreRows: (count: number) => `${count} more ${count === 1 ? 'row' : 'rows'} not shown`,
} as const;

/** From this share the ring warns, and from the next it is full. */
const HIGH = 0.8;
const FULL = 0.95;

const counts = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** The reading as drawn: a count that is not a count (NaN, negative,
 *  infinite) was not recorded, never a figure (CV-05). */
function readingOf(usage: ContextUsage): ContextUsage {
  return usage.state === 'recorded' && !(Number.isFinite(usage.used) && usage.used >= 0)
    ? { state: 'not_recorded' }
    : usage;
}

/** A recorded window to divide by: a positive number. */
function windowOf(usage: ContextUsage): number | null {
  if (usage.state !== 'recorded') return null;
  const limit = usage.window;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** The used share of the window, as a fraction, or null when it is not
 *  known. */
export function contextShare(reading: ContextUsage): number | null {
  const usage = readingOf(reading);
  const limit = windowOf(usage);
  return usage.state === 'recorded' && limit !== null ? usage.used / limit : null;
}

/** A share in whole percent, or null for a sliver above nothing, which is
 *  under one percent and never "0%". */
function wholePercent(share: number): number | null {
  const rounded = Math.round(share * 100);
  return rounded === 0 && share > 0 ? null : rounded;
}

function percent(share: number): string {
  const whole = wholePercent(share);
  return whole === null ? 'Less than 1%' : `${whole}%`;
}

/** The control's name: the reading in words. */
export function contextName(reading: ContextUsage): string {
  const usage = readingOf(reading);
  if (usage.state === 'not_recorded') return CONTEXT_WORDS.notRecorded;
  if (usage.state === 'unavailable') return CONTEXT_WORDS.unavailable;
  const share = contextShare(usage);
  return share === null
    ? `${counts.format(usage.used)} tokens of context used`
    : `${percent(share)} of context used`;
}

/** What the toolbar shows beside the ring ("62%", "<1%", or "41.2K" with no
 *  window), or nothing for an absent reading: its words are the name and
 *  the card's. A rail that heads with the reading shows this same figure. */
export function contextFigure(reading: ContextUsage): string | null {
  const usage = readingOf(reading);
  if (usage.state !== 'recorded') return null;
  const share = contextShare(usage);
  if (share === null) return compact.format(usage.used);
  const whole = wholePercent(share);
  return whole === null ? '<1%' : `${whole}%`;
}

/** The reading's tokens, the detail's first line: "124,000 of 200,000
 *  tokens", or "41,200 tokens used" with no window; nothing for an absent
 *  reading. */
export function contextTokens(reading: ContextUsage): string | null {
  const usage = readingOf(reading);
  if (usage.state !== 'recorded') return null;
  const limit = windowOf(usage);
  return limit === null
    ? `${counts.format(usage.used)} tokens used`
    : `${counts.format(usage.used)} of ${counts.format(limit)} tokens`;
}

function levelOf(share: number | null): 'high' | 'full' | undefined {
  if (share === null) return undefined;
  return share >= FULL ? 'full' : share >= HIGH ? 'high' : undefined;
}

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The ring: a track, and an arc for the used share when it is known. A
 *  failed read's ring carries the mark every failed read carries
 *  (`section-unavailable`, CV-05), so the state lab finds it as it finds the
 *  others'. */
function Ring({ share, failed }: { share: number | null; failed: boolean }) {
  const drawn = share === null ? null : Math.min(1, Math.max(0, share));
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-slot="context-ring"
      data-testid={failed ? 'section-unavailable' : undefined}
      className="cb-ai-context-ring"
    >
      <circle cx="12" cy="12" r={RADIUS} className="cb-ai-context-track" />
      {drawn !== null && (
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          transform="rotate(-90 12 12)"
          strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          strokeDashoffset={CIRCUMFERENCE * (1 - drawn)}
          className="cb-ai-context-arc"
        />
      )}
    </svg>
  );
}

function count(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? counts.format(value)
    : CONTEXT_WORDS.valueNotRecorded;
}

/** The card's body for a reading. */
function ContextDetail({ usage }: { usage: ContextUsage }) {
  if (usage.state !== 'recorded') {
    const missing = usage.state === 'not_recorded';
    return (
      <div className="cb-ai-context-card" data-state={usage.state}>
        <p className="cb-ai-context-title">
          {missing ? CONTEXT_WORDS.notRecorded : CONTEXT_WORDS.unavailable}
        </p>
        <p className="cb-ai-context-detail">
          {missing ? CONTEXT_WORDS.notRecordedDetail : CONTEXT_WORDS.unavailableDetail}
        </p>
      </div>
    );
  }
  const share = contextShare(usage);
  const rows: [string, ReactNode][] = [];
  if (usage.model !== undefined) {
    rows.push([
      'Model',
      usage.model === null ? (
        CONTEXT_WORDS.valueNotRecorded
      ) : (
        <span className="cb-ai-context-model" title={usage.model}>
          {usage.model}
        </span>
      ),
    ]);
  }
  const { breakdown } = usage;
  if (breakdown !== undefined) {
    rows.push(
      ['Input', count(breakdown.input)],
      ['Cache read', count(breakdown.cacheRead)],
      ['Cache write', count(breakdown.cacheWrite)],
      ['Output', count(breakdown.output)],
    );
  }
  return (
    <div className="cb-ai-context-card" data-state="recorded" data-level={levelOf(share)}>
      <p className="cb-ai-context-title">{contextTokens(usage)}</p>
      {share === null ? (
        <p className="cb-ai-context-detail">{CONTEXT_WORDS.windowNotRecorded}</p>
      ) : (
        <>
          <div className="cb-ai-context-meter" aria-hidden="true">
            <span
              className="cb-ai-context-fill"
              style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
            />
          </div>
          <p className="cb-ai-context-detail">{percent(share)} used</p>
        </>
      )}
      {rows.length > 0 && (
        <dl className="cb-ai-context-rows">
          {rows.map(([term, value]) => (
            <Fragment key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

export interface ContextProps {
  usage: ContextUsage;
  testId?: string;
  className?: string;
  /** An explicit tab stop: WebKit leaves a native button without one out of
   *  the Tab order, so a caller that wants the reading reached says so. */
  tabIndex?: number;
}

/**
 * The reading in the toolbar. Hovering it, or focusing it from the
 * keyboard, opens the detail; the card is the trigger's description while
 * it is open.
 */
export function Context({ usage: reading, testId, className, tabIndex }: ContextProps) {
  const usage = readingOf(reading);
  const share = contextShare(usage);
  const shown = contextFigure(usage);
  return (
    <HoverCard label="Context use" content={() => <ContextDetail usage={usage} />}>
      {({ ref, describedBy }) => (
        <button
          ref={ref}
          type="button"
          data-slot="context"
          data-testid={testId}
          data-state={usage.state}
          data-level={levelOf(share)}
          aria-label={contextName(usage)}
          aria-describedby={describedBy}
          tabIndex={tabIndex}
          className={['cb-ai-context', className].filter(Boolean).join(' ')}
        >
          <Ring share={share} failed={usage.state === 'unavailable'} />
          {shown !== null && <span className="cb-ai-context-value">{shown}</span>}
        </button>
      )}
    </HoverCard>
  );
}

/** One row of what the context holds. */
export interface ContextCategoryItem {
  /** Unique among the rows. */
  key: string;
  name: string;
  /**
   * What the row is, which says how it draws: content in the window
   * (`used`), a share of the bar in its own hue; the room left (`free`),
   * the bar's track; the reserve compaction keeps (`buffer`), a hatched
   * share at the bar's end; or tool schemas held outside the window
   * (`deferred`), listed under it and taking none of it.
   */
  kind: ContextCategoryKind;
  /** Its tokens, or null when none were recorded (CV-05). */
  tokens: number | null;
}

export interface ContextCategoriesProps {
  categories: readonly ContextCategoryItem[];
  /** The window the rows share. Null when it was not reported: the legend
   *  lists tokens alone, and no bar is drawn. */
  window: number | null;
  /** Rows past what was kept, counted. */
  more?: number;
  testId?: string;
  className?: string;
}

/**
 * The hues `used` rows take, in this order and never cycled: the app's
 * option palette, checked for neighbours a colour-blind reader can tell
 * apart. A row past them shares the neutral `other`, and its name in the
 * legend still says which it is.
 */
const TONES = 7;

/** A `used` row's hue by its place among the used rows. */
function toneOf(index: number): string {
  return index < TONES ? String(index) : 'other';
}

/** A share in tenths of a percent, or "<0.1%" for a sliver above nothing,
 *  never "0.0%" for a row that holds tokens. */
function tenths(share: number): string {
  const rounded = Math.round(share * 1000) / 10;
  return rounded === 0 && share > 0 ? '<0.1%' : `${rounded.toFixed(1)}%`;
}

/** A row's value: its tokens and, with a window, its share; a deferred
 *  row's is that it is not loaded, never 0 or a dash. */
function categoryValue(row: ContextCategoryItem, window: number | null): string {
  if (row.kind === 'deferred') return CONTEXT_WORDS.notLoaded;
  if (row.tokens === null) return CONTEXT_WORDS.valueNotRecorded;
  const tokens = compact.format(row.tokens);
  return window === null ? tokens : `${tokens} · ${tenths(row.tokens / window)}`;
}

/** The bar's share of a row: its tokens, when it holds some. */
const held = (row: ContextCategoryItem): number =>
  row.tokens !== null && Number.isFinite(row.tokens) && row.tokens > 0 ? row.tokens : 0;

/**
 * What the context holds, row by row (M92.14), as Claude's Context card
 * draws it: a bar of the window, each used row a share of it in its own
 * hue, the reserve compaction keeps hatched at its end and the room left as
 * its track; then a legend of every row with its tokens and its share of
 * the window. The bar is decoration, a 2px gap between its shares; the
 * legend carries every number in words. A row nobody counted reads "not
 * recorded", and a deferred row "not loaded", never 0 (CV-05).
 */
export function ContextCategories({
  categories,
  window,
  more = 0,
  testId,
  className,
}: ContextCategoriesProps) {
  const limit = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
  // Each used row's hue by its place among them; the window each kind takes.
  const tones: (string | undefined)[] = [];
  let places = 0;
  let used = 0;
  let buffer = 0;
  for (const row of categories) {
    if (row.kind === 'used') {
      tones.push(toneOf(places));
      places += 1;
      used += held(row);
    } else {
      tones.push(undefined);
      if (row.kind === 'buffer') buffer += held(row);
    }
  }
  const free = limit === null ? 0 : Math.max(0, limit - used - buffer);
  return (
    <div
      data-slot="context-categories"
      data-testid={testId}
      className={['cb-ai-context-categories', className].filter(Boolean).join(' ')}
    >
      {limit !== null && (
        <div data-slot="context-bar" aria-hidden="true" className="cb-ai-context-bar">
          {categories.map((row, index) =>
            row.kind === 'used' && held(row) > 0 ? (
              <span
                key={row.key}
                data-tone={tones[index]}
                className="cb-ai-context-segment"
                style={{ flexGrow: held(row) }}
              />
            ) : null,
          )}
          {free > 0 && (
            <span data-kind="free" className="cb-ai-context-segment" style={{ flexGrow: free }} />
          )}
          {buffer > 0 && (
            <span
              data-kind="buffer"
              className="cb-ai-context-segment"
              style={{ flexGrow: buffer }}
            />
          )}
        </div>
      )}
      <dl className="cb-ai-context-legend">
        {categories.map((row, index) => (
          <div
            key={row.key}
            data-kind={row.kind}
            data-tone={tones[index]}
            className="cb-ai-context-legend-row"
          >
            <dt>
              <span aria-hidden="true" className="cb-ai-context-swatch" />
              <span className="cb-ai-context-legend-name">{row.name}</span>
            </dt>
            <dd>{categoryValue(row, limit)}</dd>
          </div>
        ))}
      </dl>
      {more > 0 && <p className="cb-ai-context-more">{CONTEXT_WORDS.moreRows(more)}</p>}
    </div>
  );
}
