import type { ReactNode } from 'react';
import type { HomeRow } from '@/engine/homeLanes';

export function EventRow({
  row,
  ready,
  done,
  onOpen,
  children,
}: {
  row: HomeRow;
  ready: boolean;
  done: (row: HomeRow) => Promise<boolean>;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="cb-home-event flex items-start gap-2 py-1">
      <button
        type="button"
        disabled={onOpen === undefined}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left enabled:hover:bg-n-50"
      >
        <span className="flex w-full min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-sm text-n-800">{row.title}</span>
          {row.detail && (
            <span
              className={`max-w-[50%] truncate text-xs ${row.danger ? 'text-danger-700' : 'text-n-500'}`}
            >
              {row.detail}
            </span>
          )}
        </span>
        {children}
      </button>
      <button
        type="button"
        data-testid="home-row-done"
        aria-label={`Mark ${row.title} done`}
        disabled={!ready}
        onClick={() => void done(row)}
        className="mt-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs text-n-500 enabled:hover:bg-n-50 enabled:hover:text-cortex-600 disabled:opacity-50"
      >
        Done
      </button>
    </div>
  );
}
