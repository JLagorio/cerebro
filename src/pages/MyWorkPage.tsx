import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { openWork, type OpenWorkRow } from '@/engine/myWork';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * My work (M43) — every open record across every database, one page.
 *
 * Membership is engine/myWork's capability gate; this page only groups and
 * renders. Grouped by database because "what kind of thing is this" is the
 * axis the vault already navigates by; within a group, status-set order then
 * title, so a board's columns and this list agree about what comes first.
 */
export function MyWorkPage() {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const openPath = useOpenPath();

  const groups = useMemo(() => {
    const rows = openWork(entries, schema);
    const byType = new Map<string, OpenWorkRow[]>();
    for (const row of rows) {
      const key = row.entry.type ?? '';
      const bucket = byType.get(key) ?? [];
      bucket.push(row);
      byType.set(key, bucket);
    }
    return [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, bucket]) => {
        const order = new Map((schema.types.get(type)?.statuses ?? []).map((s, i) => [s.id, i]));
        bucket.sort(
          (a, b) =>
            (order.get(a.status.id) ?? 0) - (order.get(b.status.id) ?? 0) ||
            a.entry.title.localeCompare(b.entry.title),
        );
        return { type, rows: bucket };
      });
  }, [entries, schema]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="mywork-page">
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <h2 className="m-0 text-xl font-semibold text-n-900">My work</h2>
        {groups.length === 0 ? (
          <p className="mt-3 text-sm text-n-500">
            Nothing is in progress — no record's status sits in an active group.
          </p>
        ) : (
          groups.map(({ type, rows }) => (
            <section key={type} className="mt-5">
              <div className="flex items-center gap-1.5 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
                <Icon
                  name={typeStyle(type, schema).icon}
                  size={13}
                  color={typeStyle(type, schema).color ?? 'var(--n-400)'}
                />
                {type}
                <span className="[font-family:var(--font-mono)] font-normal normal-case tracking-normal text-n-400">
                  {rows.length}
                </span>
              </div>
              {rows.map(({ entry, status }) => (
                <button
                  key={entry.path}
                  type="button"
                  data-testid="mywork-row"
                  onClick={() => openPath(entry.path)}
                  className="flex h-[34px] w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-2 text-left text-sm text-n-800 hover:bg-n-50"
                >
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.title}
                  </span>
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
      </div>
    </div>
  );
}
