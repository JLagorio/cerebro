import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  TRASH_WORDS,
  deletedWhen,
  purgeWhen,
  unavailableWords,
  type TrashedItem,
} from '@/engine/trash';
import { useVaultStore } from '@/stores/vaultStore';
import { loadTrash, restoreItem, type TrashRead } from './trashActions';

/** A moment as its local calendar date, YYYY-MM-DD. */
function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The line under a row's title: where it came from, when it went, when it
 * leaves for the macOS Trash. */
function detail(item: TrashedItem): string {
  const parts: string[] = [];
  const went = deletedWhen(item);
  if (went !== null) parts.push(`deleted ${localDate(went)}`);
  if (item.kind === 'folder') {
    parts.push(
      item.pages === null
        ? 'pages not counted'
        : `${item.pages} ${item.pages === 1 ? 'page' : 'pages'}`,
    );
  }
  const leaves = purgeWhen(item);
  if (leaves !== null) parts.push(`leaves after ${localDate(leaves)}`);
  return parts.join(' · ');
}

/**
 * Settings' Recently deleted section (M60.8): what waits in the vault's own
 * Trash, newest first, each with Restore. A read that fails says so, never
 * "Nothing in the Trash" (CV-05). An item whose record can't be read lists
 * with no Restore. No new destination: the Trash lives here (D18).
 */
export function TrashSettings() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const [read, setRead] = useState<TrashRead | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (vaultPath === null) return;
    const next = await loadTrash(vaultPath);
    setRead(next);
  }, [vaultPath]);

  // Every rescan may follow a delete or a restore made elsewhere.
  useEffect(() => {
    void reload();
  }, [reload, entries]);

  const restore = async (item: TrashedItem) => {
    setBusy(item.stamp);
    await restoreItem(item);
    setBusy(null);
    await reload();
  };

  return (
    <section className="mb-6 rounded-xl border border-n-200 p-5" data-testid="settings-trash">
      <h2 className="mb-1 text-md font-semibold text-n-900">{TRASH_WORDS.section}</h2>
      <p className="mb-4 text-sm leading-[18px] text-n-500">{TRASH_WORDS.hint}</p>
      {read === null ? null : read.kind === 'unavailable' ? (
        <p className="m-0 text-sm text-warn-600" data-testid="section-unavailable">
          {unavailableWords(read.reason)}
        </p>
      ) : read.items.length === 0 ? (
        <p className="m-0 text-sm text-n-500" data-testid="trash-empty">
          {TRASH_WORDS.empty}
        </p>
      ) : (
        <ul className="m-0 p-0">
          {read.items.map((item) => (
            <li
              key={item.stamp}
              data-testid="trash-item"
              data-stamp={item.stamp}
              className="flex list-none items-center gap-3 border-b border-n-100 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-n-800">
                  {item.kind === 'unreadable' ? "Can't be read" : item.title || item.path}
                </div>
                <div className="mt-0.5 truncate text-xs text-n-500">
                  <span className="[font-family:var(--font-mono)]">{item.path}</span>
                  {' · '}
                  {detail(item)}
                </div>
              </div>
              {item.kind !== 'unreadable' && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="rotate-ccw"
                  testId="trash-restore"
                  disabled={busy !== null}
                  onClick={() => void restore(item)}
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
