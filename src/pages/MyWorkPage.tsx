import { useListCursor } from '@/hooks/useListCursor';
import { ListSelectionBar } from '@/components/ListSelectionBar';
import { copyPageLinks } from '@/app/recordActions';
import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { workSections } from '@/engine/myWork';
import { bandContext } from '@/engine/dateBuckets';
import { formatDue } from '@/engine/tasks';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * My work (M43) — every open record across every database, one page.
 *
 * Membership is engine/myWork's capability gate; this page only groups and
 * renders. Declared deadline sections come first; remaining work groups by
 * database, ordered through each record's statusSetFor, then its title.
 * Records open in place, and j/k step the peek through the drawn list.
 */
export function MyWorkPage() {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const openPath = useOpenPath('in-place');

  const { today, weekStart } = bandContext();
  const groups = useMemo(
    () => workSections(entries, schema, { today, weekStart }),
    [entries, schema, today, weekStart],
  );

  const rows = groups.flatMap((group) => group.rows.map((row) => row.entry));
  const cursor = useListCursor({
    keys: rows.map((entry) => entry.path),
    onOpen: openPath,
    selectable: true,
    peek: true,
  });
  return (
    <div
      {...cursor.containerProps}
      role="listbox"
      aria-label="My work"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      data-testid="mywork-page"
    >
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <h2 className="m-0 text-xl font-semibold text-n-900">My work</h2>
        {groups.length === 0 ? (
          <p className="mt-3 text-sm text-n-500">
            Nothing is in progress — no record's status sits in an active group.
          </p>
        ) : (
          groups.map(({ bucket, label, type, rows }) => (
            <section
              key={`${type === null ? 'date' : 'type'}:${bucket}`}
              data-testid="mywork-section"
              data-bucket={bucket}
              className="mt-5"
            >
              <div className="flex items-center gap-1.5 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
                <Icon
                  name={type === null ? 'calendar' : typeStyle(type, schema).icon}
                  size={13}
                  color={
                    type === null
                      ? 'var(--n-400)'
                      : (typeStyle(type, schema).color ?? 'var(--n-400)')
                  }
                />
                {label}
                <span className="[font-family:var(--font-mono)] font-normal normal-case tracking-normal text-n-400">
                  {rows.length}
                </span>
              </div>
              {rows.map(({ entry, status, deadline, unreadable }) => (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  {...cursor.itemProps(entry.path)}
                  data-testid="mywork-row"
                  className="flex h-[34px] w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-2 text-left text-sm text-n-800 hover:bg-n-50 data-[focused=true]:bg-cortex-50 aria-selected:bg-cortex-50"
                >
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.title}
                  </span>
                  {(deadline !== null || unreadable) && (
                    <span
                      data-testid="mywork-deadline"
                      className={`flex-none rounded-sm px-1.5 py-px text-2xs ${bucket === 'overdue' ? 'bg-danger-50 text-danger-600' : bucket === 'today' ? 'bg-warn-50 text-warn-600' : 'bg-n-50 text-n-600'}`}
                    >
                      {deadline === null
                        ? 'Not a date'
                        : `${formatDue(deadline.date)}${deadline.time === null ? '' : ` · ${deadline.time}`}`}
                    </span>
                  )}
                  <span className="flex flex-none items-center gap-1.5 text-xs text-n-600">
                    {status.color !== null && (
                      <span className="h-2 w-2 rounded-full" style={{ background: status.color }} />
                    )}
                    {status.label}
                  </span>
                </button>
              ))}
            </section>
          ))
        )}
        <ListSelectionBar
          count={cursor.state.selected.size}
          onCopy={() =>
            void copyPageLinks(rows.filter((entry) => cursor.state.selected.has(entry.path)))
          }
        />
      </div>
    </div>
  );
}
