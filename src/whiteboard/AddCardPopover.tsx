import { useContext, useEffect, useMemo, useState } from 'react';
import { isLinkablePage } from '@/engine/pageCard';
import { kindFor } from '@/engine/fileKinds';
import { VAULT_ROOT } from '@/engine/fileBytes';
import type { CardTarget } from '@/engine/boardCards';
import type { DirEntry } from '@/engine/roots';
import { listDir } from '@/lib/rootsIpc';
import { rankNames } from '@/lib/nameRank';
import { useRecency } from '@/stores/openLogStore';
import { useVaultStore } from '@/stores/vaultStore';
import { isWebUrl } from '@/mermaid/flowchart/linkTargets';
import { WhiteboardAncestry } from './ancestry';

export function AddCardPopover({ onPick }: { onPick(target: CardTarget): void }) {
  const [tab, setTab] = useState<'Pages' | 'Images' | 'Link'>('Pages'),
    [query, setQuery] = useState('');
  const entries = useVaultStore((s) => s.entries),
    vault = useVaultStore((s) => s.vaultPath);
  const ancestors = useContext(WhiteboardAncestry),
    recency = useRecency();
  const pages = useMemo(
    () =>
      entries
        .filter(
          (entry) =>
            entry.path !== ancestors.at(-1) &&
            (isLinkablePage(entry) || /\.(mmd|canvas)$/i.test(entry.path)),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries, ancestors],
  );
  const [images, setImages] = useState<{
    vault: string | null;
    state: 'loading' | 'failed' | 'ready';
    entries: DirEntry[];
  } | null>(null);
  useEffect(() => {
    if (tab !== 'Images') return;
    let live = true;
    setImages({ vault, state: 'loading', entries: [] });
    void listDir(VAULT_ROOT, 'attachments')
      .then((rows) => {
        if (live)
          setImages({
            vault,
            state: 'ready',
            entries: rows.filter((row) => !row.isDir && kindFor(row.path).kind === 'image'),
          });
      })
      .catch(() => {
        if (live) setImages({ vault, state: 'failed', entries: [] });
      });
    return () => {
      live = false;
    };
  }, [tab, vault]);
  const shown = rankNames({
    query,
    items: pages,
    texts: (entry) => [entry.title, entry.path],
    path: (entry) => entry.path,
    recency,
    limit: 50,
  });
  const imagesNow = images?.vault === vault ? images : null;
  const imageRows =
    imagesNow?.entries.filter((row) =>
      row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  const link = query.trim();
  let validLink = false;
  try {
    validLink = isWebUrl(link) && new URL(link).hostname !== '';
  } catch {
    /* Keep the button disabled for an incomplete URL. */
  }
  return (
    <div
      className="w-80 space-y-2 rounded-lg border border-n-200 bg-n-0 p-3 shadow-[var(--shadow-lg)]"
      data-testid="whiteboard-card-picker"
    >
      <div className="flex gap-2" role="tablist" aria-label="Card kind">
        {(['Pages', 'Images', 'Link'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === tab}
            className="rounded-md border border-n-200 px-2 py-1 text-xs text-n-700"
            onClick={() => {
              setTab(name);
              setQuery('');
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <input
        autoFocus
        aria-label={tab === 'Link' ? 'Web link' : `Find ${tab.toLowerCase()}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="w-full rounded-md border border-n-200 bg-n-0 px-2 py-1.5 text-sm outline-none"
      />
      {tab === 'Pages' ? (
        <>
          <div className="max-h-64 overflow-y-auto">
            {shown.items.map((entry) => (
              <button
                key={entry.path}
                type="button"
                data-testid="whiteboard-card-option"
                className="block w-full rounded-md p-2 text-left hover:bg-n-50"
                onClick={() => onPick({ kind: 'file', file: entry.path })}
              >
                <span className="block truncate text-sm text-n-800">{entry.title}</span>
                <span className="block truncate text-2xs text-n-500">{entry.path}</span>
              </button>
            ))}
          </div>
          {shown.total > shown.items.length ? (
            <p className="text-xs text-n-500">
              {shown.total - shown.items.length} more — keep typing
            </p>
          ) : shown.total === 0 ? (
            <p className="text-xs text-n-500">No matching pages.</p>
          ) : null}
        </>
      ) : tab === 'Images' ? (
        imagesNow?.state === 'ready' ? (
          <div className="max-h-64 overflow-y-auto">
            {imageRows.length === 0 ? (
              <p className="text-xs text-n-500">No images in attachments.</p>
            ) : (
              imageRows.map((row) => (
                <button
                  type="button"
                  key={row.path}
                  className="block w-full truncate rounded-md p-2 text-left text-sm text-n-700 hover:bg-n-50"
                  onClick={() => onPick({ kind: 'file', file: row.path })}
                >
                  {row.name}
                </button>
              ))
            )}
          </div>
        ) : (
          <p role="status" className="text-xs text-n-500">
            {imagesNow?.state === 'failed'
              ? 'Images could not be read. Try again.'
              : 'Reading images…'}
          </p>
        )
      ) : (
        <button
          type="button"
          disabled={!validLink}
          onClick={() => onPick({ kind: 'link', url: link })}
          className="rounded-md border border-n-200 px-2 py-1 text-sm text-n-700 disabled:opacity-50"
        >
          Add link
        </button>
      )}
    </div>
  );
}
