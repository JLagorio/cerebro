// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { Fragment, type ReactNode } from 'react';
import { HoverCard } from '@/components/ui/HoverCard';
import './conversation.css';

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

/** What the toolbar shows beside the ring, or nothing for an absent
 *  reading: its words are the name and the card's. */
function figure(usage: ContextUsage): string | null {
  if (usage.state !== 'recorded') return null;
  const share = contextShare(usage);
  if (share === null) return compact.format(usage.used);
  const whole = wholePercent(share);
  return whole === null ? '<1%' : `${whole}%`;
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
  const limit = windowOf(usage);
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
      <p className="cb-ai-context-title">
        {limit === null
          ? `${counts.format(usage.used)} tokens used`
          : `${counts.format(usage.used)} of ${counts.format(limit)} tokens`}
      </p>
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
  const shown = figure(usage);
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
