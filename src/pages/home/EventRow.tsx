import type { ReactNode } from 'react';
import type { RunStatusView } from '@/agent/elements/runs';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceLine, TraceTitle } from '@/components/ai/Trace';
import type { HomeRow } from '@/engine/homeLanes';
import '@/status/runs.css';

/** A row drawn as a trace line (M91.14): its state's icon and ink, and its
 *  state in a word a screen reader hears before its title. */
export type EventLine = Pick<RunStatusView, 'state' | 'trace' | 'statusText' | 'icon'>;

export function EventRow({
  row,
  ready,
  done,
  onOpen,
  line,
  children,
}: {
  row: HomeRow;
  ready: boolean;
  done: (row: HomeRow) => Promise<boolean>;
  onOpen?: () => void;
  /** Draws the title as a trace line in this state: Agents' runs. */
  line?: EventLine;
  children?: ReactNode;
}) {
  const detail = row.detail && (
    <span
      className={`max-w-[50%] truncate text-metadata ${row.danger ? 'text-danger-700' : 'text-(--text-meta)'}`}
    >
      {row.detail}
    </span>
  );
  return (
    <div className="cb-home-event flex items-start gap-2 py-1">
      <button
        type="button"
        disabled={onOpen === undefined}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left enabled:hover:bg-n-50"
      >
        {line === undefined ? (
          <span className="flex w-full min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-ui text-n-800">{row.title}</span>
            {detail}
          </span>
        ) : (
          <TraceLine status={line.trace} statusText={line.statusText} className="cb-run-line">
            <StepIcon state={line.state} icon={line.icon} />
            <TraceTitle className="flex-1 text-ui text-n-800">{row.title}</TraceTitle>
            {detail}
          </TraceLine>
        )}
        {children}
      </button>
      <button
        type="button"
        data-testid="home-row-done"
        aria-label={`Mark ${row.title} done`}
        disabled={!ready}
        onClick={() => void done(row)}
        className="mt-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs text-(--text-meta) enabled:hover:bg-n-50 enabled:hover:text-cortex-600 disabled:opacity-50"
      >
        Done
      </button>
    </div>
  );
}
