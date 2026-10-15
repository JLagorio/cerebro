import { useMemo, type CSSProperties } from 'react';
import { Button } from '@/components/ui/Button';
import {
  cellWords,
  dayKeyOf,
  dayWords,
  heatmapOf,
  type HeatCell,
  type VaultActivity,
} from '@/engine/activity';
import type { ActivityRead } from './vaultActivityStore';
import { useVaultActivity } from './vaultActivityStore';

/**
 * The year as a grid (M64.2): one cell a day, Sunday-first weeks, shaded by
 * how many editing sessions began that day — agents' included, commits never.
 *
 * Three kinds of day, never confused (CV-05): recorded (shaded, or "no
 * edits"), not recorded (Cerebro wasn't open, or the day came before it began
 * recording edits), and not read (older than a capped lane could return).
 * The seam line says when recording began. A failed read says so, and a lane
 * the grid needs that failed says which.
 */

const LEVEL_FILL = [
  'var(--n-100)',
  'var(--cortex-200)',
  'var(--cortex-300)',
  'var(--cortex-500)',
  'var(--cortex-700)',
] as const;

/** What each lane the grid needs says when it could not be read. */
const LANE_WORDS = {
  writes: 'Who changed what could not be read, so the year cannot be drawn.',
  app_sessions: 'When Cerebro was open could not be read, so no day here is a statement about it.',
  recording_since:
    'When Cerebro began recording edits could not be read, so no day here is a statement about it.',
} as const;

function cellStyle(cell: HeatCell): CSSProperties {
  switch (cell.state) {
    case 'recorded':
      return { background: LEVEL_FILL[cell.level] };
    case 'not-recorded':
      return { background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--n-200)' };
    case 'not-read':
      return { background: 'var(--n-50)', boxShadow: 'inset 0 0 0 1px var(--n-100)' };
  }
}

function Cell({ cell }: { cell: HeatCell }) {
  const words = cellWords(cell);
  return (
    <span
      data-testid="heatmap-day"
      data-day={cell.day}
      data-state={cell.state}
      data-sessions={cell.sessions ?? ''}
      role="img"
      aria-label={words}
      title={words}
      className="block size-[10px] rounded-[2px]"
      style={cellStyle(cell)}
    />
  );
}

function Swatch({ style, label }: { style: CSSProperties; label?: string }) {
  return (
    <span
      aria-hidden={label === undefined}
      aria-label={label}
      className="block size-[10px] rounded-[2px]"
      style={style}
    />
  );
}

export function ActivityHeatmap({ read, reload }: { read: ActivityRead; reload: () => void }) {
  const data: VaultActivity | null = read.kind === 'ready' ? read.data : null;
  const today = read.kind === 'ready' ? read.today : null;
  const map = useMemo(
    () => (data === null || today === null ? null : heatmapOf(data, today)),
    [data, today],
  );

  if (read.kind === 'loading') return null;

  if (read.kind === 'unavailable' || data === null) {
    return (
      <section data-testid="history-heatmap" className="flex flex-col items-start gap-2">
        <p data-testid="section-unavailable" data-lane="all" className="m-0 text-xs text-n-500">
          What happened in this vault could not be read, so no day here is a statement about it.
        </p>
        <Button size="sm" testId="activity-retry" onClick={reload}>
          Try again
        </Button>
      </section>
    );
  }

  if (map === null) {
    const failed = (['writes', 'app_sessions', 'recording_since'] as const).filter(
      (lane) => data[lane].state === 'unavailable',
    );
    return (
      <section data-testid="history-heatmap" className="flex flex-col items-start gap-2">
        {failed.map((lane) => (
          <p
            key={lane}
            data-testid="section-unavailable"
            data-lane={lane}
            className="m-0 text-xs text-n-500"
          >
            {LANE_WORDS[lane]}
          </p>
        ))}
        <Button size="sm" testId="activity-retry" onClick={reload}>
          Try again
        </Button>
      </section>
    );
  }

  const since = map.recordingSince;
  return (
    <section data-testid="history-heatmap" className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0 overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1">
          <div className="relative h-3 text-2xs leading-3 text-n-400" aria-hidden>
            {map.months.map((m) => (
              <span key={`${m.week}-${m.label}`} className="absolute" style={{ left: m.week * 12 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="flex gap-[2px]" role="group" aria-label="Editing sessions by day">
            {map.weeks.map((week, w) => (
              <div key={w} className="flex flex-col gap-[2px]">
                {week.map((cell, d) =>
                  cell === null ? (
                    <span key={d} className="block size-[10px]" aria-hidden />
                  ) : (
                    <Cell key={cell.day} cell={cell} />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-2xs text-n-500">
        <p data-testid="heatmap-seam" className="m-0">
          {since === null
            ? "Cerebro hasn't recorded an edit in this vault yet."
            : `Cerebro began recording edits here on ${dayWords(dayKeyOf(Date.parse(since)))}.`}
        </p>
        <div data-testid="heatmap-legend" className="flex items-center gap-1">
          <span>Fewer</span>
          {LEVEL_FILL.map((fill) => (
            <Swatch key={fill} style={{ background: fill }} />
          ))}
          <span>More</span>
          <span className="ml-2 flex items-center gap-1">
            <Swatch
              style={{ background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--n-200)' }}
            />
            Not recorded
          </span>
        </div>
      </div>
    </section>
  );
}

/** The heatmap over History's shared read. */
export function HistoryHeatmapSection() {
  const { read, reload } = useVaultActivity();
  return <ActivityHeatmap read={read} reload={reload} />;
}
