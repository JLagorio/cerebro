import { useId, useRef } from 'react';
import { useStore } from 'zustand';
import {
  colorItems,
  common,
  MIXED,
  sectionsFor,
  selectedBoxes,
  selectedItems,
  sizeInk,
} from '@/engine/scene/inspect';
import { alignBoxes, distribute, type PlacedBox } from '@/engine/scene/arrange';
import { reorderItems, resizeItems, updateCards, updateEdges } from '@/engine/scene/commands';
import { getItem } from '@/engine/scene/board';
import type { SceneEditor } from '@/engine/scene/editor';
import type { Board, Box, Command } from '@/engine/scene/model';
import { Select } from '@/components/ui/Select';
import { useUiStore } from '@/stores/uiStore';
import type { BoardStore } from './boardState';
import './canvasChrome.css';
import { NumberField } from './NumberField';
import { ColorField } from './ColorField';
import { useBoardDraft, type BoardDraftOwner } from './pendingText';
import type { Preview } from './gestures/types';

const ROW = 'w-full rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-700';
const ACTION =
  'rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-600 hover:bg-n-50 disabled:opacity-40';
const SHAPES = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'diamond', label: 'Diamond' },
];
const ENDS = [
  { value: 'none', label: 'None' },
  { value: 'arrow', label: 'Arrow' },
];
export function Inspector({ editor, state }: { editor: SceneEditor; state: BoardStore }) {
  useStore(state, (s) => s.revision);
  const shapeId = useId();
  const endId = useId();
  const open = useStore(state, (s) => s.inspectorOpen);
  const toast = useUiStore((s) => s.toast);
  const board = editor.board,
    keys = [...editor.selection],
    chosen = selectedItems(board, keys),
    boxes = selectedBoxes(board, keys);
  const sections = sectionsFor(board, keys);
  const draftOwner = (field: string): BoardDraftOwner => ({
    editor,
    id: JSON.stringify(['inspector', keys, field]),
  });
  const scrub = useRef<{ board: Board; boxes: PlacedBox[]; release(): void; stop(): void } | null>(
    null,
  );
  const apply = <P,>(command: Command<P>, payload: P) => {
    if (keys.some((key) => getItem(editor.board, key) === undefined)) {
      toast('An item in this edit was removed. The draft is still held.');
      return false;
    }
    state.claimGesture(() => {})();
    const result = editor.execute(command, payload);
    if (!result.ok) toast(result.refusal.message);
    return result.ok;
  };
  const setBoxes = (field: keyof Box, value: number) =>
    apply(resizeItems, {
      boxes: selectedBoxes(editor.board, keys).map((item) => ({
        ...item,
        box: { ...item.box, [field]: value },
      })),
    });
  const finishScrub = (commit: boolean) => {
    const current = scrub.current;
    if (!current) return;
    scrub.current = null;
    current.stop();
    current.release();
    if (commit && editor.gesture) {
      const result = editor.commit();
      if (!result.ok) toast(result.refusal.message);
    } else editor.cancel();
  };
  const color = common(chosen.map(({ item }) => item.color ?? null)) ?? null;
  const setColor = (value: string | null) => {
    if (!apply(colorItems, { keys, color: value })) return false;
    const colors = { ...state.getState().colors };
    for (const { item } of chosen) {
      const family =
        'points' in item
          ? 'ink'
          : 'fromNode' in item
            ? 'edge'
            : (state.getState().createdFamilies.get(item.id) ??
              (item.type === 'text' && (item.shape !== 'rectangle' || item.text === '')
                ? 'shape'
                : 'card'));
      colors[family] = value;
    }
    state.setState({ colors });
    return true;
  };
  const cards = chosen.flatMap(({ item }) => ('type' in item ? [item] : []));
  const edges = chosen.flatMap(({ item }) => ('fromNode' in item ? [item] : []));
  const drawings = chosen.flatMap(({ item }) => ('points' in item ? [item] : []));
  if (!open) return null;
  return (
    <aside
      data-testid="wb-inspector"
      data-no-pan="true"
      aria-label="Whiteboard inspector"
      data-empty={sections.count === 0 || undefined}
      className="wb-inspector"
    >
      <h2 className="wb-inspector-heading">Inspector</h2>
      {sections.count === 0 ? (
        <div className="wb-inspector-empty">
          <p>Nothing selected</p>
          <span>Select a card, connection or drawing to adjust it.</span>
        </div>
      ) : (
        <div key={JSON.stringify(keys)} className="space-y-4">
          <section>
            <h3 className="mb-2 mt-0 text-xs font-medium text-n-600">Position</h3>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['x', 'X'],
                  ['y', 'Y'],
                  ['width', 'W'],
                  ['height', 'H'],
                ] as const
              ).map(([field, label]) => (
                <NumberField
                  key={field}
                  label={label}
                  draftOwner={draftOwner(field)}
                  value={common(boxes.map((item) => item.box[field])) ?? MIXED}
                  disabled={!sections.position}
                  onCommit={(value) => setBoxes(field, value)}
                  onScrubStart={(cancel) => {
                    const release = state.claimGesture(cancel);
                    const initial = editor.board;
                    editor.begin(`Adjust ${label}`);
                    const stop = editor.subscribe(({ cause }) => {
                      if (['external', 'cancel', 'undo', 'redo'].includes(cause)) cancel();
                    });
                    scrub.current = {
                      board: initial,
                      boxes: selectedBoxes(initial, editor.selection),
                      release,
                      stop,
                    };
                  }}
                  onScrub={(delta) => {
                    const current = scrub.current;
                    if (!current) return;
                    const changed = resizeItems(
                      current.board,
                      {
                        boxes: current.boxes.map((item) => ({
                          ...item,
                          box: { ...item.box, [field]: item.box[field] + delta },
                        })),
                      },
                      { createId: () => '' },
                    );
                    if (!changed.ok) return;
                    const preview: Preview = new Map();
                    for (const item of current.boxes)
                      preview.set(item.key, getItem(changed.board, item.key)!);
                    editor.preview(preview);
                  }}
                  onScrubEnd={finishScrub}
                />
              ))}
            </div>
          </section>
          <section>
            <h3 className="mb-2 mt-0 text-xs font-medium text-n-600">Colour</h3>
            <ColorField value={color} onCommit={setColor} draftOwner={draftOwner('color')} />
          </section>
          {sections.shape && (
            <section>
              <label className="mb-1 block text-xs text-n-600" htmlFor={shapeId}>
                Shape
              </label>
              <Select
                id={shapeId}
                size="sm"
                width="100%"
                value={shown(
                  common(cards.flatMap((item) => (item.type === 'text' ? [item.shape] : []))),
                )}
                placeholder="Mixed"
                options={SHAPES}
                onChange={(shape) =>
                  apply(updateCards, {
                    updates: cards
                      .filter((item) => item.type === 'text')
                      .map((item) => ({ id: item.id, set: { shape } })),
                  })
                }
              />
            </section>
          )}
          {sections.ink && (
            <section>
              <h3 className="mb-2 mt-0 text-xs font-medium text-n-600">Ink</h3>
              <NumberField
                label="Width"
                draftOwner={draftOwner('inkWidth')}
                value={common(drawings.map((item) => item.size)) ?? MIXED}
                onCommit={(size) => apply(sizeInk, { keys, size })}
              />
            </section>
          )}
          {sections.group && (
            <TextSetting
              label="Group label"
              draftOwner={draftOwner('groupLabel')}
              value={
                common(
                  cards.flatMap((item) => (item.type === 'group' ? [item.label ?? ''] : [])),
                ) ?? ''
              }
              onCommit={(label) =>
                apply(updateCards, {
                  updates: cards
                    .filter((item) => item.type === 'group')
                    .map((item) => ({ id: item.id, set: { label: label || null } })),
                })
              }
            />
          )}
          {sections.connection && (
            <section className="space-y-2">
              <h3 className="mb-2 mt-0 text-xs font-medium text-n-600">Connection</h3>
              {(['fromEnd', 'toEnd'] as const).map((end) => (
                <div key={end}>
                  <label className="block text-xs text-n-600" htmlFor={`${endId}-${end}`}>
                    {end === 'fromEnd' ? 'Start' : 'End'}
                  </label>
                  <Select
                    id={`${endId}-${end}`}
                    size="sm"
                    width="100%"
                    value={shown(
                      common(
                        edges.map((edge) => edge[end] ?? (end === 'toEnd' ? 'arrow' : 'none')),
                      ),
                    )}
                    placeholder="Mixed"
                    options={ENDS}
                    onChange={(value) =>
                      apply(updateEdges, {
                        updates: edges.map((edge) => ({ id: edge.id, set: { [end]: value } })),
                      })
                    }
                  />
                </div>
              ))}
              <TextSetting
                label="Connection label"
                draftOwner={draftOwner('connectionLabel')}
                value={common(edges.map((edge) => edge.label ?? '')) ?? ''}
                onCommit={(label) =>
                  apply(updateEdges, {
                    updates: edges.map((edge) => ({ id: edge.id, set: { label: label || null } })),
                  })
                }
              />
            </section>
          )}
          {sections.pointer && (
            <section>
              <h3 className="mb-2 mt-0 text-xs font-medium text-n-600">Pointer</h3>
              {cards.flatMap((item) =>
                item.type === 'file'
                  ? [
                      <p key={item.id} className="m-0 break-all text-xs text-n-500">
                        {item.file}
                        {item.subpath ?? ''}
                      </p>,
                    ]
                  : item.type === 'link'
                    ? [
                        <p key={item.id} className="m-0 break-all text-xs text-n-500">
                          {item.url}
                        </p>,
                      ]
                    : [],
              )}
            </section>
          )}
          <section>
            <h3 className="mb-2 mt-0 text-xs font-medium text-n-600">Arrange</h3>
            <div className="flex flex-wrap gap-1">
              {(['front', 'back', 'forward', 'backward'] as const).map((to) => (
                <button
                  key={to}
                  type="button"
                  className={ACTION}
                  onClick={() => apply(reorderItems, { keys, to })}
                >
                  {to[0].toUpperCase() + to.slice(1)}
                </button>
              ))}
              {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={ACTION}
                  disabled={!sections.align}
                  onClick={() => apply(resizeItems, { boxes: alignBoxes(boxes, mode) })}
                >
                  Align {mode}
                </button>
              ))}
              {(['horizontal', 'vertical'] as const).map((axis) => (
                <button
                  key={axis}
                  type="button"
                  className={ACTION}
                  disabled={!sections.distribute}
                  onClick={() => apply(resizeItems, { boxes: distribute(boxes, axis) })}
                >
                  Distribute {axis}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
/** What a select shows: no value for a mixed selection, so its placeholder
 * says Mixed and the list offers only real choices. */
function shown(value: string | typeof MIXED | undefined): string {
  return value === MIXED || value === undefined ? '' : value;
}
function TextSetting({
  label,
  value,
  onCommit,
  draftOwner,
}: {
  label: string;
  value: string | typeof MIXED;
  onCommit(value: string): boolean;
  draftOwner: BoardDraftOwner;
}) {
  const {
    draft,
    error,
    prepare: commit,
    change,
    discard,
  } = useBoardDraft(draftOwner, value === MIXED ? '' : value, (text) =>
    text === value || onCommit(text) ? text : false,
  );
  return (
    <label className="block text-xs text-n-600">
      {label}
      <input
        className={ROW}
        value={draft}
        aria-invalid={error}
        placeholder={value === MIXED ? 'Mixed' : undefined}
        onChange={(event) => {
          change(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            discard();
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}
