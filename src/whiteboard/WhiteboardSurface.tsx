import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { hasLayers } from '@/components/ui/layers';
import type { SceneEditor } from '@/engine/scene/editor';
import type { Point } from '@/engine/scene/figure';
import type { Board, Box, ItemKey } from '@/engine/scene/model';
import { deleteItems } from '@/engine/scene/commands';
import { getItem } from '@/engine/scene/board';
import { copyFragment, pasteFragment } from '@/engine/scene/fragments';
import {
  appendSamples,
  boxFromDrag,
  defaultBox,
  isTap,
  type DrawSample,
} from '@/engine/scene/draw';
import { betweenPoints, hitAt, selectionBox } from '@/engine/scene/pick';
import { handleAt } from '@/engine/scene/resize';
import { snapMove, snapResize } from '@/engine/scene/snap';
import { freeRoute, portAt, type PortTarget } from '@/engine/scene/ports';
import { useDragGesture } from '@/hooks/useDragGesture';
import {
  DOT_GAP,
  useCanvasOverlayHost,
  useCanvasPan,
  useCanvasTransformRef,
} from '@/mermaid/CanvasViewport';
import { useUiStore } from '@/stores/uiStore';
import type { BoardStore } from './boardState';
import { marqueeSelection } from './gestures/marquee';
import { moveKeys, movePreview } from './gestures/move';
import { panDelta } from './gestures/pan';
import { resizePreview } from './gestures/resize';
import { useBoardKeys } from './keys';
import { SelectionOverlay } from './SelectionOverlay';
import { useScene } from './useScene';
import { draftCard } from './gestures/shape';
import { draftInk } from './gestures/ink';
import { textEditing } from './gestures/text';
import { eraseSweep } from './gestures/erase';
import { newBoardId } from './ids';
import { TextEditor } from './TextEditor';
import type { BoardTool } from './tools';
import { connectCards } from './gestures/connector';
import { endpointAt, reconnectEdge, type Endpoint } from './gestures/endpoint';
import { PortsOverlay } from './PortsOverlay';
import { createBoardClipboard } from './clipboard';
import type { Preview } from './gestures/types';

export function WhiteboardSurface({ editor, state }: { editor: SceneEditor; state: BoardStore }) {
  const host = useCanvasOverlayHost();
  const transform = useCanvasTransformRef();
  const pan = useCanvasPan();
  const gesture = useDragGesture();
  const panHeld = useBoardKeys(editor, state);
  const toast = useUiStore((s) => s.toast);
  const board = useScene(editor);
  const selection = useStore(state, (s) => s.selection);
  const editing = useStore(state, (s) => s.editing);
  const input = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const focus = useCallback(() => input.current?.focus({ preventScroll: true }), []);
  const control = useRef<Element | null>(null);
  useEffect(
    () =>
      editor.subscribe(({ cause }) => {
        if (active.current && ['external', 'cancel', 'undo', 'redo'].includes(cause)) gesture.end();
      }),
    [editor, gesture],
  );
  const world = (client: Point): Point => {
    const rect = host?.getBoundingClientRect();
    const t = transform.current;
    return {
      x: (client.x - (rect?.left ?? 0) - t.offset.x) / t.scale,
      y: (client.y - (rect?.top ?? 0) - t.offset.y) / t.scale,
    };
  };
  const clipboard = createBoardClipboard(
    editor,
    () => {
      const rect = host?.getBoundingClientRect();
      return world({
        x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      });
    },
    toast,
    () => state.getState().colors.card,
    () => state.claimGesture(() => {})(),
  );
  const connectionGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    start: Board,
    from: PortTarget,
    line: boolean,
    releaseInteraction: () => void,
    endpoint?: Endpoint,
  ) => {
    const target = event.currentTarget,
      pointerId = event.pointerId;
    const first = { x: event.clientX, y: event.clientY };
    let crossed = false;
    const preview = (point: Point) => {
      const port = portAt(start, point, transform.current.scale);
      const route = freeRoute(start, from, point, port);
      // A moved start end previews in the original edge direction.
      const shown =
        route && endpoint?.end === 'from'
          ? {
              from: route.to,
              c1: route.c2,
              c2: route.c1,
              to: route.from,
              path: `M ${route.to.x} ${route.to.y} C ${route.c2.x} ${route.c2.y} ${route.c1.x} ${route.c1.y} ${route.from.x} ${route.from.y}`,
            }
          : route;
      state.setState({
        port,
        hover: port ? `n:${port.node}` : null,
        connection: shown ? { route: shown, arrow: !line } : null,
      });
    };
    const moved = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!crossed && !isTap(first, { x: e.clientX, y: e.clientY })) {
        crossed = true;
        target.setPointerCapture?.(pointerId);
      }
      preview(world({ x: e.clientX, y: e.clientY }));
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const point = world({ x: e.clientX, y: e.clientY });
      const to = portAt(editor.board, point, transform.current.scale);
      if (crossed) {
        const result = endpoint
          ? editor.execute(reconnectEdge, { endpoint, target: to })
          : editor.execute(connectCards, {
              from,
              to,
              point,
              line,
              color: state.getState().colors.edge,
              cardColor: state.getState().colors.card,
            });
        if (!result.ok) toast(result.refusal.message);
        else if (!endpoint && to === null) {
          const added = (result.selection ?? []).filter((key) => key.startsWith('n:'));
          state.setState((s) => ({
            createdFamilies: new Map([
              ...s.createdFamilies,
              ...added.map((key) => [key.slice(2), 'card' as const] as const),
            ]),
          }));
        }
      }
      gesture.end();
      state.getState().setTool('select');
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) gesture.end();
    };
    active.current = true;
    state.setState({ interactionActive: true });
    gesture.begin(() => {
      active.current = false;
      releaseInteraction();
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId);
      state.getState().clearTransient();
    });
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    preview(world(first));
  };
  const createGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    tool: BoardTool,
    start: Board,
    startPoint: Point,
    startScreen: Point,
    scale: number,
    releaseInteraction: () => void,
  ) => {
    const id = newBoardId(),
      target = event.currentTarget,
      pointerId = event.pointerId;
    const shape = tool === 'ellipse' ? 'ellipse' : 'rectangle';
    const simulated = event.pointerType !== 'pen';
    const color =
      state.getState().colors[tool === 'pencil' ? 'ink' : tool === 'text' ? 'card' : 'shape'];
    let lastPoint = startPoint,
      lastScreen = startScreen,
      started = false,
      crossed = false;
    let samples: DrawSample[] = [],
      erased = new Set<ItemKey>();
    let box = defaultBox(startPoint, tool === 'text' ? 'text' : 'shape');
    const bypass = event.metaKey || event.ctrlKey;
    const begin = () => {
      if (!started) {
        started = true;
        editor.begin(tool === 'pencil' ? 'Draw ink' : 'Add card');
      }
    };
    const shapeAt = (point: Point, e: { shiftKey: boolean; altKey: boolean }) => {
      const prefs = state.getState().snap;
      const snapped = snapMove(
        { x: point.x, y: point.y, width: 0, height: 0 },
        0,
        0,
        [...start.nodes.values(), ...start.ink.values()],
        {
          scale,
          grid: !bypass && prefs.grid,
          objects: !bypass && prefs.objects,
          gridSize: DOT_GAP,
        },
      );
      state.setState({ guides: snapped.guides });
      box = boxFromDrag(
        startPoint,
        { x: point.x + snapped.dx, y: point.y + snapped.dy },
        { square: e.shiftKey, fromCenter: e.altKey },
      );
      const card = draftCard(start, id, {
        type: 'text',
        shape,
        text: '',
        ...box,
        ...(color ? { color } : {}),
      });
      if (card) {
        begin();
        editor.preview(new Map([[`n:${id}` as const, card]]));
      }
    };
    const inkAt = (events: readonly { clientX: number; clientY: number; pressure?: number }[]) => {
      samples = appendSamples(
        samples,
        events.map((e) => ({
          ...world({ x: e.clientX, y: e.clientY }),
          pressure: simulated ? 0.5 : (e.pressure ?? 0.5),
        })),
      );
      const ink = draftInk(start, id, samples, simulated, color);
      if (ink) {
        begin();
        editor.preview(new Map([[`i:${id}` as const, ink]]));
      }
    };
    const eraseAt = (point: Point) => {
      erased = eraseSweep(start, erased, lastPoint, point, 10 / scale);
      const faded = new Set(erased);
      for (const edge of start.edges.values())
        if (erased.has(`n:${edge.fromNode}`) || erased.has(`n:${edge.toNode}`))
          faded.add(`e:${edge.id}`);
      state.setState((s) => ({ fadedIds: faded, trail: [...s.trail.slice(-199), point] }));
      lastPoint = point;
    };
    const moved = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      lastScreen = { x: e.clientX, y: e.clientY };
      if (!crossed && !isTap(startScreen, lastScreen)) {
        crossed = true;
        target.setPointerCapture?.(pointerId);
      }
      if (tool === 'pencil') {
        const coalesced = e.getCoalescedEvents?.() ?? [];
        inkAt(coalesced.length ? coalesced : [e]);
      } else if (tool === 'eraser') eraseAt(world(lastScreen));
      else if (crossed) shapeAt(world(lastScreen), e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (tool === 'eraser') {
        eraseAt(world({ x: e.clientX, y: e.clientY }));
        if (erased.size) {
          const result = editor.execute(deleteItems, { keys: [...erased] });
          if (!result.ok) toast(result.refusal.message);
        }
      } else if (tool === 'text') {
        if (!crossed) box = defaultBox(startPoint, 'text');
        gesture.end();
        state.getState().select([]);
        state.setState({
          tool: 'select',
          editing: {
            kind: 'draft',
            id,
            card: {
              type: 'text',
              shape: 'rectangle',
              text: '',
              ...box,
              ...(color ? { color } : {}),
            },
          },
        });
        return;
      } else {
        if (tool !== 'pencil' && !crossed) {
          const card = draftCard(start, id, {
            type: 'text',
            shape,
            text: '',
            ...defaultBox(startPoint, 'shape'),
            ...(color ? { color } : {}),
          });
          if (card) {
            begin();
            editor.preview(new Map([[`n:${id}` as const, card]]));
          }
        }
        if (started && editor.gesture) {
          const result = editor.commit();
          if (!result.ok) toast(result.refusal.message);
          else state.getState().select([`${tool === 'pencil' ? 'i' : 'n'}:${id}`]);
          if (result.ok && tool !== 'pencil')
            state.setState((s) => ({
              createdFamilies: new Map(s.createdFamilies).set(id, 'shape'),
            }));
        }
      }
      gesture.end();
      if (tool !== 'pencil' && tool !== 'eraser') state.getState().setTool('select');
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) gesture.end();
    };
    active.current = true;
    state.setState({ interactionActive: true });
    gesture.begin(() => {
      active.current = false;
      releaseInteraction();
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId);
      if (started) editor.cancel();
      state.getState().clearTransient();
    });
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    if (tool === 'pencil') inkAt([event]);
    else if (tool === 'eraser') eraseAt(startPoint);
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const underneath = document.elementsFromPoint?.(event.clientX, event.clientY) ?? [];
    control.current =
      underneath
        .map((el) => el.closest('[data-board-control]'))
        .find((el) => el !== null && host?.contains(el)) ?? null;
    if (control.current !== null) return;
    event.preventDefault();
    event.stopPropagation();
    input.current?.focus({ preventScroll: true });
    gesture.end();
    const releaseInteraction = state.claimGesture(gesture.end);
    const startScreen = { x: event.clientX, y: event.clientY };
    const startPoint = world(startScreen);
    const start = editor.board;
    const baseSelection = new Set(editor.selection);
    const initialBox = selectionBox(start, baseSelection);
    const scale = transform.current.scale;
    const tool = state.getState().tool;
    const panning = event.button === 1 || panHeld.current || tool === 'hand';
    if (!panning && ['select', 'connector', 'line'].includes(tool)) {
      const endpoint =
        tool === 'select' ? endpointAt(start, baseSelection, startPoint, scale) : null;
      if (endpoint) {
        const edge = start.edges.get(endpoint.edge)!;
        const from: PortTarget =
          endpoint.end === 'from'
            ? { node: edge.toNode, side: edge.toSide }
            : { node: edge.fromNode, side: edge.fromSide };
        connectionGesture(event, start, from, edge.toEnd === 'none', releaseInteraction, endpoint);
        return;
      }
      const port = portAt(start, startPoint, scale);
      if (port && (port.side || tool !== 'select')) {
        connectionGesture(event, start, port, tool === 'line', releaseInteraction);
        return;
      }
      if (tool === 'connector' || tool === 'line') {
        releaseInteraction();
        return;
      }
    }
    if (!panning && tool !== 'select') {
      createGesture(event, tool, start, startPoint, startScreen, scale, releaseInteraction);
      return;
    }
    const handle = !panning && initialBox ? handleAt(initialBox, startPoint, scale) : null;
    const hit = panning || handle ? null : hitAt(start, startPoint, scale);
    const kind = panning ? 'pan' : handle ? 'resize' : hit ? 'move' : 'marquee';
    const additive = event.shiftKey;
    const bypassSnap = event.metaKey || event.ctrlKey;
    let crossed = false,
      started = false,
      last = startScreen;
    let keys: ItemKey[] = [];
    let box: Box | null = null;
    let moveBoard = start,
      copies: Preview | null = null;
    const duplicate = event.altKey && kind === 'move';
    if (hit && !additive && !baseSelection.has(hit)) state.getState().select([hit]);
    if (kind === 'marquee' && !additive) state.getState().select([]);
    active.current = true;
    state.setState({ interactionActive: true });
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const targets = (moving: readonly ItemKey[]): readonly Box[] => [
      ...[...start.nodes.values()].filter((n) => !moving.includes(`n:${n.id}`)),
      ...[...start.ink.values()].filter((n) => !moving.includes(`i:${n.id}`)),
    ];
    const moved = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const screen = { x: e.clientX, y: e.clientY };
      if (!crossed) {
        if (Math.hypot(screen.x - startScreen.x, screen.y - startScreen.y) < 3) return;
        crossed = true;
        target.setPointerCapture?.(pointerId);
        if (hit && additive && !baseSelection.has(hit))
          state.getState().select([...baseSelection, hit]);
        keys = kind === 'move' ? moveKeys(start, editor.selection) : [...editor.selection];
        if (duplicate) {
          const result = pasteFragment(start, copyFragment(start, keys).fragment, {
            createId: newBoardId,
            offset: 0,
          });
          if (!result.ok) {
            toast(result.refusal.message);
            gesture.end();
            return;
          }
          moveBoard = result.board;
          keys = [...(result.selection ?? [])];
          copies = new Map(keys.map((key) => [key, getItem(moveBoard, key)!]));
        }
        box = selectionBox(moveBoard, keys);
        if ((kind === 'move' || kind === 'resize') && box) {
          editor.begin(kind === 'move' ? 'Move' : 'Resize');
          started = true;
        }
      }
      if (kind === 'pan') {
        const delta = panDelta(last, screen);
        pan(delta.x, delta.y);
        last = screen;
        return;
      }
      const point = world(screen);
      if (kind === 'marquee') {
        const marquee = betweenPoints(startPoint, point);
        state.setState({ marquee });
        state.getState().select(marqueeSelection(start, marquee, baseSelection, additive));
        return;
      }
      if (!box || !started) return;
      let dx = point.x - startPoint.x,
        dy = point.y - startPoint.y;
      const prefs = state.getState().snap;
      const options = {
        scale,
        grid: !bypassSnap && prefs.grid,
        objects: !bypassSnap && prefs.objects,
        gridSize: DOT_GAP,
      };
      if (kind === 'move') {
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const snapped = snapMove(box, dx, dy, targets(keys), options);
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) {
            snapped.dy = 0;
            snapped.guides = snapped.guides.filter((g) => g.axis === 'x');
          } else {
            snapped.dx = 0;
            snapped.guides = snapped.guides.filter((g) => g.axis === 'y');
          }
        }
        state.setState({ guides: snapped.guides });
        editor.preview(
          new Map([...(copies ?? []), ...movePreview(moveBoard, keys, snapped.dx, snapped.dy)]),
        );
      } else if (handle && initialBox) {
        const snapped = snapResize(initialBox, handle, dx, dy, targets(keys), {
          ...options,
          keepRatio: e.shiftKey,
          fromCenter: e.altKey,
        });
        state.setState({ guides: snapped.guides });
        editor.preview(resizePreview(start, keys, initialBox, snapped.box));
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!crossed && hit && additive) {
        const next = new Set(baseSelection);
        if (next.has(hit)) next.delete(hit);
        else next.add(hit);
        state.getState().select(next);
      }
      if (started && editor.gesture !== null) {
        const result = editor.commit();
        if (!result.ok) toast(result.refusal.message);
        else if (copies) state.getState().select(keys);
      }
      gesture.end();
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) gesture.end();
    };
    gesture.begin(() => {
      active.current = false;
      releaseInteraction();
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId);
      if (started) editor.cancel();
      state.getState().clearTransient();
    });
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  if (host === null) return null;
  return createPortal(
    <>
      <div
        ref={input}
        data-testid="wb-input"
        data-no-pan="true"
        tabIndex={0}
        role="application"
        aria-label="Whiteboard"
        aria-roledescription="whiteboard"
        className="absolute inset-0 outline-none"
        onPointerDown={down}
        onCopy={clipboard.copy}
        onCut={clipboard.cut}
        onPaste={clipboard.paste}
        onPointerMove={(event) => {
          if (!active.current) {
            const point = world({ x: event.clientX, y: event.clientY });
            const port = ['select', 'connector', 'line'].includes(state.getState().tool)
              ? portAt(editor.board, point, transform.current.scale)
              : null;
            state.setState({
              hover: port ? `n:${port.node}` : hitAt(editor.board, point, transform.current.scale),
              port,
            });
          }
        }}
        onPointerLeave={() => {
          if (!active.current) state.setState({ hover: null, port: null });
        }}
        onClick={(event) => {
          const node = control.current;
          control.current = null;
          if (node)
            node.dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
              }),
            );
        }}
        onDoubleClick={(event) => {
          if (state.getState().tool !== 'select' || editing !== null) return;
          gesture.end();
          const point = world({ x: event.clientX, y: event.clientY });
          const hit = hitAt(editor.board, point, transform.current.scale);
          if (hit?.startsWith('n:') || hit?.startsWith('e:')) {
            const next = textEditing(editor.board, hit.slice(2), hit.startsWith('e:'));
            if (next) state.setState({ editing: next });
          } else if (hit === null) {
            state.setState({
              editing: {
                kind: 'draft',
                id: newBoardId(),
                card: {
                  type: 'text',
                  shape: 'rectangle',
                  text: '',
                  ...defaultBox(point, 'text'),
                  ...(state.getState().colors.card ? { color: state.getState().colors.card! } : {}),
                },
              },
            });
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !active.current &&
            editor.gesture === null &&
            !hasLayers()
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (state.getState().tool !== 'select') state.getState().setTool('select');
            else state.getState().select([]);
          }
        }}
      />
      <SelectionOverlay board={board} state={state} />
      <PortsOverlay board={board} state={state} />
      {editing && (
        <TextEditor
          key={editing.id}
          editor={editor}
          state={state}
          editing={editing}
          focus={focus}
        />
      )}
      <span data-testid="wb-selection-count" className="sr-only" role="status" aria-live="polite">
        {selection.size === 0
          ? 'Selection cleared'
          : `${selection.size} item${selection.size === 1 ? '' : 's'} selected`}
      </span>
    </>,
    host,
  );
}
