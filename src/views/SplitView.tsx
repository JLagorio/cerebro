import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { RecordProperties } from '@/detail/RecordProperties';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import type { Entry, Schema } from '@/engine/types';

/**
 * Split (record browser) layout (M3 feedback): record rows in a narrow
 * column, the selected record's doc in the middle (its H1 is the title —
 * same contract as DocPage), and the property stack on the right. The rows
 * follow the toolbar's Order-by; grouping doesn't apply here.
 */
export function SplitView({ entries, schema }: { entries: Entry[]; schema: Schema }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Deleted/renamed selections fall back to the first row instead of a
  // blank canvas; the explicit find keeps stale paths from sticking.
  const selected = entries.find((e) => e.path === selectedPath) ?? entries[0] ?? null;

  if (selected === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="split-view">
        <EmptyState
          icon="inbox"
          title="No records yet"
          description="Records carrying this type show up here the moment one exists."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="split-view">
      <div className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-[var(--n-200)]">
        {entries.map((e) => {
          const active = e.path === selected.path;
          const key = typeof e.properties.key === 'string' ? e.properties.key : '';
          return (
            <button
              key={e.path}
              type="button"
              role="row"
              aria-selected={active}
              data-testid="split-row"
              onClick={() => setSelectedPath(e.path)}
              className={[
                'flex flex-col gap-0.5 border-0 border-b border-solid border-[var(--n-100)] px-4 py-2.5 text-left',
                active ? 'bg-[var(--cortex-50)]' : 'bg-transparent hover:bg-[var(--n-25)]',
              ].join(' ')}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {e.parseError !== null && (
                  <span className="inline-flex flex-none text-[var(--warn-500)]">
                    <Icon name="triangle-alert" size={12} />
                  </span>
                )}
                <span
                  className={[
                    'truncate text-[13px]',
                    active ? 'font-semibold text-[var(--n-900)]' : 'font-medium text-[var(--n-800)]',
                  ].join(' ')}
                >
                  {e.title}
                </span>
              </span>
              <span className="flex items-center gap-2 text-[11px] text-[var(--n-400)]">
                {key !== '' && <span className="[font-family:var(--font-mono)]">{key}</span>}
                <span>{e.modifiedAt.slice(0, 10)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-10 pt-6">
        <div className="mx-auto w-full max-w-[760px] px-6">
          <NoteBodyEditor key={selected.path} path={selected.path} />
        </div>
      </div>
      <aside
        aria-label="Record properties"
        className="w-[300px] flex-none overflow-y-auto border-l border-[var(--n-200)] px-4 pb-5 pt-3.5"
      >
        <RecordProperties key={selected.path} entry={selected} schema={schema} />
        <div className="flex items-center gap-3 border-t border-[var(--n-100)] pt-2.5 [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
          <span>Created {selected.createdAt.slice(0, 10)}</span>
          <span>Modified {selected.modifiedAt.slice(0, 10)}</span>
        </div>
      </aside>
    </div>
  );
}
