import { useContext, useMemo } from 'react';
import './WhiteboardEmbed.css';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { humanize } from '@/engine/frontmatter';
import { readCanvas } from '@/engine/scene/jsonCanvas';
import { useEntry, useVaultStore } from '@/stores/vaultStore';
import { BoardCanvas } from './BoardCanvas';
import { nestingRefusal, WhiteboardAncestry } from './ancestry';
import { useFileText } from './cards/useFileText';

type Props = { board: string; height?: number; chrome?: boolean };

/** Reader only: no editor, pending-save registration, or write adapter. A new
 * vault/path owns a fresh lifetime so stale promises cannot paint its scene. */
export function WhiteboardEmbed(props: Props) {
  const vault = useVaultStore((s) => s.vaultPath);
  return <EmbedRead key={JSON.stringify([vault, props.board])} {...props} vault={vault} />;
}
function EmbedRead({
  board,
  height = 360,
  chrome = true,
  vault,
}: Props & { vault: string | null }) {
  const entry = useEntry(board);
  const hash = entry?.hash;
  const title =
    entry?.title ?? humanize((board.split('/').at(-1) ?? board).replace(/\.canvas$/, ''));
  const open = useOpenPath('navigate');
  const ancestors = useContext(WhiteboardAncestry);
  const guard = nestingRefusal(ancestors, board);
  const read = useFileText(board, hash, guard === null);
  const state = useMemo(() => {
    if (read.state !== 'ready') return read;
    const parsed = readCanvas(read.text);
    return parsed.ok
      ? { state: 'ready' as const, scene: parsed.board }
      : { state: 'unavailable' as const, reason: parsed.message };
  }, [read]);
  if (guard)
    return (
      <section data-testid="whiteboard-embed" data-state="guard" className="p-3 text-xs text-n-500">
        <p>
          {guard === 'self'
            ? 'This whiteboard is already shown here.'
            : 'Open this whiteboard to see more nested boards.'}
        </p>
        <p className="break-words font-mono">{board}</p>
        <button
          type="button"
          data-board-control="true"
          className="rounded-md border border-n-200 px-2 py-1 text-xs text-n-700"
          onClick={(event) => open(board, { newPane: event.metaKey || event.ctrlKey })}
        >
          Open
        </button>
      </section>
    );
  return (
    <section
      data-testid="whiteboard-embed"
      data-state={state.state}
      className={`cb-whiteboard-embed ${chrome ? 'my-3 overflow-hidden rounded-lg border border-n-200' : ''}`}
    >
      {state.state === 'ready' ? (
        <>
          {chrome && (
            <div className="flex items-center gap-2 border-b border-n-200 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-n-800">
                {title}
              </span>
              <Button variant="ghost" size="sm" onClick={() => open(board)}>
                Open
              </Button>
            </div>
          )}
          <WhiteboardAncestry.Provider value={[...ancestors, board]}>
            <BoardCanvas
              source={state.scene}
              name={title}
              cameraKey={JSON.stringify([vault, board])}
              height={height}
              chrome={chrome}
            />
          </WhiteboardAncestry.Provider>
        </>
      ) : (
        <div className="p-4 text-sm text-n-500" role="status">
          {state.state === 'loading' ? (
            'Opening whiteboard…'
          ) : state.state === 'missing' ? (
            `No whiteboard at ${board}`
          ) : (
            <>
              <p>{state.reason}</p>
              <p className="mt-1 break-words text-xs">{board}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
