import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { pruneOpenLogToSnapshot, useOpenLogStore } from '@/stores/openLogStore';
import { useVaultStore } from '@/stores/vaultStore';

/** The local calendar date of an epoch ms, as YYYY-MM-DD. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Settings' Recently opened section (M59.3): the open log that ranks ⌘K and
 * the pickers, shown so it can be read, forgotten a page at a time, or
 * cleared. It is this vault's, on this Mac; nothing here writes the vault.
 */
export function RecentlyOpenedSettings() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const log = useOpenLogStore((s) => (vaultPath === null ? undefined : s.logs[vaultPath]));
  const saved = useOpenLogStore((s) => s.saved);
  const forget = useOpenLogStore((s) => s.forget);
  const clear = useOpenLogStore((s) => s.clear);
  const titles = useMemo(() => new Map(entries.map((e) => [e.path, e.title])), [entries]);

  // A deleted page leaves the log here too, under ⌘K's guard: only a ready
  // snapshot of this vault says what exists.
  useEffect(() => {
    pruneOpenLogToSnapshot();
  }, []);

  const rows = log ?? [];
  return (
    <section
      className="mb-6 rounded-xl border border-n-200 p-5"
      data-testid="settings-recently-opened"
    >
      <h2 className="mb-1 text-md font-semibold text-n-900">Recently opened</h2>
      <p className="mb-4 text-sm leading-[18px] text-n-500">
        Pages you open yourself, kept for this vault on this Mac to rank ⌘K and the pickers. An
        agent&apos;s opens never count, and nothing is written to the vault.
      </p>
      {!saved && (
        <p className="mb-3 text-xs text-warn-700" data-testid="open-log-unsaved">
          Not saved on this Mac — storage is unavailable.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-n-500" data-testid="open-log-empty">
          Nothing opened yet.
        </p>
      ) : (
        <>
          <ul className="m-0 mb-3 p-0">
            {rows.map((record) => (
              <li
                key={record.path}
                data-testid="open-log-row"
                className="flex list-none items-center gap-3 border-b border-n-100 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-n-800">
                    {titles.get(record.path) ?? record.path}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-n-500">
                    <span className="[font-family:var(--font-mono)]">{record.path}</span>
                    {' · '}
                    opened {record.count} {record.count === 1 ? 'time' : 'times'} · last{' '}
                    {localDate(record.opens[0])}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (vaultPath !== null) forget(vaultPath, record.path);
                  }}
                >
                  Forget
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            size="sm"
            testId="open-log-clear"
            onClick={() => {
              if (vaultPath !== null) clear(vaultPath);
            }}
          >
            Clear
          </Button>
        </>
      )}
    </section>
  );
}
