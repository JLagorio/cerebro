import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import {
  CanvasViewport,
  useCanvasOverlayHost,
  useCanvasTransformRef,
  type CanvasTransform,
} from '@/mermaid/CanvasViewport';
import { addCards } from '@/engine/scene/commands';
import type { BoardNode } from '@/engine/scene/model';
import type { Point } from '@/engine/scene/figure';
import { CARD_SIZES, placeCard, resolveCard, type CardTarget } from '@/engine/boardCards';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { CardContent } from './cards/CardContent';
import { useKeyScope } from '@/lib/keys/useKeys';
import { createBoardState } from './boardState';
import { useStore } from 'zustand';
import type { SceneEditor } from '@/engine/scene/editor';
import type { BoardStore } from './boardState';
import { Toolbar } from './Toolbar';
import { Inspector } from './Inspector';
import { WhiteboardSurface } from './WhiteboardSurface';
import { BoardActions } from './BoardActions';
import { readCamera, writeCamera } from './camera';
import { SceneSvg } from './SceneSvg';
import { isSceneEditor, useScene, type SceneSource } from './useScene';

/** Camera identity belongs to this mount. A changed path remounts the inner
 * host, flushing its old preference before reading the new board's camera. */
export interface BoardCanvasHandle {
  viewportCentre(): Point;
  insertCard(target: CardTarget): boolean;
}
interface Props {
  source: SceneSource;
  name: string;
  cameraKey: string;
  height?: number;
  chrome?: boolean;
  ref?: Ref<BoardCanvasHandle>;
}
const renderNodeContent = (node: BoardNode) =>
  node.type === 'file' || node.type === 'link' ? <CardContent node={node} /> : null;
export function BoardCanvas(props: Props) {
  return <BoardHost key={`${props.cameraKey}:${props.height ?? 'full'}`} {...props} />;
}
function BoardHost({ source, name, cameraKey, height, chrome = true, ref }: Props) {
  const board = useScene(source);
  const editor = isSceneEditor(source) ? source : null;
  const session = useMemo(
    () => (editor ? { editor, state: createBoardState(editor) } : undefined),
    [editor],
  );
  useEffect(() => session?.state.connect(), [session]);
  const scope = useKeyScope('whiteboard');
  const hostRef = useRef<HTMLDivElement>(null);
  const actions = useRef<BoardCanvasHandle | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      viewportCentre: () => actions.current?.viewportCentre() ?? { x: 0, y: 0 },
      insertCard: (target) => actions.current?.insertCard(target) ?? false,
    }),
    [],
  );
  const [initial] = useState(() => (height === undefined ? readCamera(cameraKey) : null));
  const pending = useRef<CanvasTransform | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null) writeCamera(cameraKey, pending.current);
    pending.current = null;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  const changed = (transform: CanvasTransform) => {
    if (height !== undefined) return;
    pending.current = transform;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), 500);
  };
  return (
    <scope.Provider>
      <div
        {...(editor ? scope.props : {})}
        ref={hostRef}
        data-testid="wb-board"
        className="relative flex min-h-0 min-w-0 flex-1 bg-n-0"
        style={height === undefined ? undefined : { height, flex: 'none' }}
      >
        <CanvasViewport
          dots
          controls={chrome}
          initialFit={initial === null}
          initialTransform={initial ?? undefined}
          onTransformChange={changed}
          wheel={height === undefined ? 'pan' : 'pass'}
        >
          {session ? (
            <EditorScene editor={session.editor} state={session.state} name={name} />
          ) : (
            <SceneSvg board={board} name={name} renderNodeContent={renderNodeContent} />
          )}
          {session && <WhiteboardSurface editor={session.editor} state={session.state} />}
          <BoardHandle editor={editor} state={session?.state} ref={actions} />
        </CanvasViewport>
        {chrome && (
          <BoardActions
            hostRef={hostRef}
            name={name}
            session={session}
            insertCard={(target) => actions.current?.insertCard(target) ?? false}
          />
        )}
        {session && (
          <Toolbar
            state={session.state}
            focus={() =>
              hostRef.current
                ?.querySelector<HTMLElement>('[data-testid="wb-input"]')
                ?.focus({ preventScroll: true })
            }
          />
        )}
        {session && <Inspector editor={session.editor} state={session.state} />}
      </div>
    </scope.Provider>
  );
}
function EditorScene({
  editor,
  state,
  name,
}: {
  editor: SceneEditor;
  state: BoardStore;
  name: string;
}) {
  const board = useScene(editor);
  const editing = useStore(state, (s) => s.editing),
    faded = useStore(state, (s) => s.fadedIds);
  return (
    <SceneSvg
      board={board}
      name={name}
      editingId={editing?.kind === 'edge' ? undefined : editing?.id}
      editingEdgeId={editing?.kind === 'edge' ? editing.id : undefined}
      fadedIds={faded}
      renderNodeContent={renderNodeContent}
    />
  );
}
function BoardHandle({
  editor,
  state,
  ref,
}: {
  editor: SceneEditor | null;
  state?: BoardStore;
  ref: Ref<BoardCanvasHandle>;
}) {
  const host = useCanvasOverlayHost(),
    transform = useCanvasTransformRef();
  useImperativeHandle(ref, () => {
    const viewportCentre = () => {
      const rect = host?.getBoundingClientRect(),
        t = transform.current;
      return {
        x: ((rect?.width ?? 0) / 2 - t.offset.x) / t.scale,
        y: ((rect?.height ?? 0) / 2 - t.offset.y) / t.scale,
      };
    };
    return {
      viewportCentre,
      insertCard(target) {
        if (!editor) return false;
        state?.claimGesture(() => {})();
        const node =
          target.kind === 'file'
            ? {
                type: 'file' as const,
                file: target.file,
                ...(target.subpath === undefined ? {} : { subpath: target.subpath }),
              }
            : { type: 'link' as const, url: target.url };
        const index = new Map(useVaultStore.getState().entries.map((entry) => [entry.path, entry]));
        const face = resolveCard(
          { ...node, id: '', z: '', x: 0, y: 0, width: 1, height: 1 },
          index,
        );
        const color = state?.getState().colors.card;
        const result = editor.execute(addCards, {
          cards: [
            {
              ...node,
              ...placeCard(editor.board, viewportCentre(), CARD_SIZES[face.kind]),
              ...(color ? { color } : {}),
            },
          ],
        });
        if (!result.ok) useUiStore.getState().toast(result.refusal.message);
        return result.ok;
      },
    };
  }, [editor, host, state, transform]);
  return null;
}
