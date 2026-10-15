import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { NotePathContext } from '@/editor/notePath';
import { parseWhiteboardRef, serializeWhiteboardRef } from '@/engine/whiteboardRef';
import { rankNames } from '@/lib/nameRank';
import { useRecency } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { WhiteboardAncestry } from './ancestry';
import { useFileText } from './cards/useFileText';
import { newBoardFile } from './newBoardFile';
import { WhiteboardEmbed } from './WhiteboardEmbed';

interface Props {
  source: string;
  onChange?: (source: string) => void;
}
/** The page owns only a pointer. A new page, vault or pointer retires its picker. */
export function WhiteboardBlock(props: Props) {
  const vault = useVaultStore((state) => state.vaultPath);
  const page = useContext(NotePathContext);
  return (
    <Block key={JSON.stringify([vault, page, props.source])} {...props} vault={vault} page={page} />
  );
}
function Block({
  source,
  onChange,
  vault,
  page,
}: Props & { vault: string | null; page: string | null }) {
  const capture = useVaultActionGuard(JSON.stringify([page, source]));
  const ref = useMemo(() => parseWhiteboardRef(source), [source]);
  const entries = useVaultStore((state) => state.entries);
  const entry = entries.find((entry) => entry.path === ref?.board);
  const read = useFileText(ref?.board ?? '', entry?.hash, ref !== null);
  const recency = useRecency();
  const [choosing, setChoosing] = useState(false),
    [query, setQuery] = useState(''),
    [creating, setCreating] = useState(false);
  const busy = useRef(false),
    live = useRef(true);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const state = ref === null ? 'unset' : read.state === 'missing' ? 'missing' : 'set';
  const shown = rankNames({
    items: entries.filter((entry) => entry.path.endsWith('.canvas')),
    query,
    texts: (entry) => [entry.title, entry.path],
    path: (entry) => entry.path,
    recency,
    limit: 50,
  });
  const choose = (board: string) => latest.current?.(serializeWhiteboardRef({ board }));
  const create = async () => {
    if (!vault || !page || !latest.current || busy.current) return;
    const current = capture();
    busy.current = true;
    setCreating(true);
    const parts = page.split('/'),
      stem = parts.pop()!.replace(/\.md$/i, '');
    const path = [...parts, 'whiteboards', `${stem || 'whiteboard'}.canvas`].join('/');
    try {
      const actual = await newBoardFile(vault, path);
      if (current()) choose(actual);
    } catch (error) {
      if (current())
        useUiStore
          .getState()
          .toast(
            `Couldn't create whiteboard: ${error instanceof Error ? error.message : String(error)}`,
          );
    } finally {
      busy.current = false;
      if (live.current) setCreating(false);
    }
  };
  return (
    <div
      data-testid="whiteboard-block"
      data-state={state}
      contentEditable={false}
      className="my-1 w-full"
    >
      {state === 'set' && ref !== null ? (
        <WhiteboardAncestry.Provider value={[]}>
          <WhiteboardEmbed board={ref.board} height={ref.height ?? 360} />
        </WhiteboardAncestry.Provider>
      ) : state === 'missing' && !choosing ? (
        <div className="flex items-center gap-2 rounded-lg border border-n-200 p-3 text-sm text-n-500">
          <span className="min-w-0 flex-1 break-words">No whiteboard at {ref!.board}</span>
          {onChange && (
            <Button size="sm" variant="ghost" onClick={() => setChoosing(true)}>
              Choose a whiteboard
            </Button>
          )}
        </div>
      ) : onChange ? (
        <div className="rounded-lg border border-n-200 bg-n-0 p-3">
          <input
            aria-label="Find a whiteboard"
            placeholder="Find a whiteboard…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-md border border-n-200 bg-n-0 px-2 py-1.5 text-sm outline-none"
          />
          <div className="mt-2 max-h-60 overflow-y-auto">
            {shown.items.map((entry) => (
              <button
                key={entry.path}
                type="button"
                data-testid="whiteboard-block-option"
                onClick={() => choose(entry.path)}
                className="block w-full rounded-md p-2 text-left hover:bg-n-50"
              >
                <span className="block text-sm text-n-800">{entry.title}</span>
                <span className="block truncate text-2xs text-n-500">{entry.path}</span>
              </button>
            ))}
          </div>
          {shown.total > shown.items.length ? (
            <p className="text-xs text-n-500">
              {shown.total - shown.items.length} more — keep typing
            </p>
          ) : shown.total === 0 ? (
            <p className="my-2 text-xs text-n-500">No matching whiteboards.</p>
          ) : null}
          {page && vault && (
            <Button size="sm" variant="ghost" disabled={creating} onClick={() => void create()}>
              New whiteboard
            </Button>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-n-200 p-3 text-sm text-n-500">
          No whiteboard chosen.
        </p>
      )}
    </div>
  );
}
