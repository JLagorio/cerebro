import { Icon } from '@/components/ui/Icon';
import { humanize } from '@/engine/frontmatter';
import type { Selection } from '@/engine/types';
import { SAVE_LABEL } from '@/mermaid/useDiagramFile';
import { useNavStore } from '@/stores/navStore';
import { useEntry, useVaultStore } from '@/stores/vaultStore';
import { BoardCanvas } from '@/whiteboard/BoardCanvas';
import {
  CanvasHeldFace,
  CanvasLoading,
  CanvasMissing,
  CanvasReadOnly,
  CanvasUnavailable,
} from '@/whiteboard/CanvasFaces';
import { useCanvasFile } from '@/whiteboard/useCanvasFile';
import { WhiteboardAncestry } from '@/whiteboard/ancestry';
import '@/whiteboard/canvasChrome.css';

/** The file page owns persistence; its renderer consumes the same editor.
 * Hosts key the page on its path. */
export function CanvasPage({ selection }: { selection: Extract<Selection, { kind: 'diagram' }> }) {
  const file = useCanvasFile(selection.path);
  const vault = useVaultStore((s) => s.vaultPath);
  const entry = useEntry(selection.path);
  const navigate = useNavStore((s) => s.navigate);
  const title =
    entry?.title ??
    humanize((selection.path.split('/').pop() ?? selection.path).replace(/\.canvas$/, ''));
  const ready = file.state === 'ready' ? file : null;
  const board = ready?.editor.board;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary = board
    ? [
        count(board.nodes.size, 'card'),
        count(board.edges.size, 'connection'),
        ...(board.ink.size ? [count(board.ink.size, 'drawing')] : []),
      ].join(' · ')
    : null;
  return (
    <div className="canvas-page flex min-h-0 min-w-0 flex-1 flex-col" data-testid="canvas-page">
      <header className="canvas-page-heading">
        <span className="canvas-page-icon">
          <Icon name="presentation" size={18} />
        </span>
        <h1 className="canvas-page-title" data-testid="canvas-title">
          {title}
        </h1>
        <span className="canvas-page-kind">Whiteboard</span>
        {summary && (
          <span data-testid="canvas-summary" className="canvas-page-summary">
            {summary}
          </span>
        )}

        {ready && SAVE_LABEL[ready.saveState] !== null && (
          <span
            data-testid="canvas-save-state"
            className="canvas-page-save"
            data-failed={ready.saveState === 'failed' || undefined}
          >
            {SAVE_LABEL[ready.saveState]}
          </span>
        )}
      </header>
      {file.state === 'loading' && <CanvasLoading />}
      {file.state === 'missing' && <CanvasMissing onHome={() => navigate({ kind: 'home' })} />}
      {file.state === 'unavailable' && (
        <CanvasUnavailable reason={file.reason} preview={file.preview} />
      )}
      {ready && board && (
        <>
          {ready.readOnly && <CanvasReadOnly />}
          {ready.held && <CanvasHeldFace held={ready.held} reload={ready.reload} />}
          <div data-testid="canvas-board" className="relative flex min-h-0 flex-1 flex-col">
            <WhiteboardAncestry.Provider value={[selection.path]}>
              <BoardCanvas
                source={ready.readOnly ? board : ready.editor}
                name={title}
                cameraKey={JSON.stringify([vault, selection.path])}
              />
            </WhiteboardAncestry.Provider>
            {ready.problems.length > 0 && (
              <ul
                data-testid="canvas-problems"
                className="absolute left-4 top-3 max-w-[70%] space-y-1 rounded-md border border-n-200 bg-n-0 px-3 py-2 text-sm text-n-600"
              >
                {ready.problems.map((problem) => (
                  <li key={`${problem.kind}:${problem.key}`}>
                    {problem.kind === 'dangling-edge'
                      ? `Connection ${problem.key.slice(2)} points at a missing card.`
                      : `Item ${problem.key.slice(2)} keeps a colour Cerebro cannot draw.`}
                  </li>
                ))}
              </ul>
            )}
            {board.nodes.size === 0 && board.edges.size === 0 && board.ink.size === 0 && (
              <p
                data-testid="canvas-empty"
                className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-(--text-meta)"
              >
                This whiteboard is empty.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
