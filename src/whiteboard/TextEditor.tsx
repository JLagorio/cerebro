import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useLayer } from '@/components/ui/layers';
import { addCards, updateCards, updateEdges } from '@/engine/scene/commands';
import type { SceneEditor } from '@/engine/scene/editor';
import type { CommandResult } from '@/engine/scene/model';
import { edgeRoute, groupLabelBox, labelAnchor } from '@/engine/scene/figure';
import { useCanvasTransform } from '@/mermaid/CanvasViewport';
import { useUiStore } from '@/stores/uiStore';
import type { BoardStore } from './boardState';
import type { BoardEditing } from './gestures/text';
import { pendingBoardDrafts, registerBoardDraft } from './pendingText';

/** One raw markdown draft, committed once when editing ends. Geometry and
 * opaque file members are read from the current scene at that moment. */
export function TextEditor({
  editor,
  state,
  editing,
  focus,
}: {
  editor: SceneEditor;
  state: BoardStore;
  editing: BoardEditing;
  focus: () => void;
}) {
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  useLayer({ kind: 'gesture', contains: (node) => input.current?.contains(node) ?? false });
  useStore(state, (s) => s.revision);
  const initial = editing.kind === 'draft' ? editing.card.text : editing.initial;
  const draftId = JSON.stringify([
    'text',
    editing.kind,
    editing.kind === 'draft' ? editing.card : editing.id,
  ]);
  const [text, setText] = useState(
    () => pendingBoardDrafts(editor).find((draft) => draft.id === draftId)?.text ?? initial,
  );
  const textRef = useRef(text);
  textRef.current = text;
  const completed = useRef(false);
  const lifetime = useRef({ generation: 0 });
  const toast = useUiStore((s) => s.toast);
  const transform = useCanvasTransform();
  const item = editing.kind === 'draft' ? editing.card : editor.board.nodes.get(editing.id);
  const label = editing.kind !== 'draft' && editing.label;
  let box = item?.type === 'group' ? groupLabelBox(item) : item;
  if (editing.kind === 'edge') {
    const edge = editor.board.edges.get(editing.id);
    const from = edge && editor.board.nodes.get(edge.fromNode),
      to = edge && editor.board.nodes.get(edge.toNode);
    if (edge && from && to) {
      const anchor = labelAnchor(edgeRoute(edge, from, to));
      box = { x: anchor.x - 100, y: anchor.y - 15, width: 200, height: 30 };
    } else box = undefined;
  }
  const commit = () => {
    if (completed.current) return true;
    const value = textRef.current;
    let result: CommandResult | undefined;
    if (
      editing.kind !== 'draft' &&
      value !== initial &&
      !(editing.kind === 'edge' ? editor.board.edges : editor.board.nodes).has(editing.id)
    )
      return false;
    if (editing.kind === 'draft') {
      if (value.trim() !== '')
        result = editor.execute(addCards, { cards: [{ ...editing.card, text: value }] });
    } else if (editing.kind === 'edge') {
      if (value !== initial && editor.board.edges.has(editing.id))
        result = editor.execute(updateEdges, {
          updates: [{ id: editing.id, set: { label: value === '' ? null : value } }],
        });
    } else if (value !== initial && editor.board.nodes.has(editing.id)) {
      result = editor.execute(updateCards, {
        updates: [
          { id: editing.id, set: label ? { label: value === '' ? null : value } : { text: value } },
        ],
      });
    }
    if (result && !result.ok) {
      toast(result.refusal.message);
      return false;
    }
    completed.current = true;
    const created = result?.ok ? (result.selection ?? []) : [];
    if (result?.ok && editing.kind === 'draft')
      state.setState((s) => ({
        createdFamilies: new Map([
          ...s.createdFamilies,
          ...created
            .filter((key) => key.startsWith('n:'))
            .map((key) => [key.slice(2), 'card' as const] as const),
        ]),
      }));
    state.setState({ editing: null, tool: 'select' });
    focus();
    return true;
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useLayoutEffect(() => {
    const life = lifetime.current;
    const generation = ++life.generation;
    input.current?.focus();
    if (editing.kind !== 'draft') input.current?.select();
    const release = state.claimGesture(() => commitRef.current());
    const unregister = registerBoardDraft(
      { editor, id: draftId },
      {
        prepare: () => commitRef.current(),
        snapshot: () =>
          completed.current ||
          (editing.kind === 'draft' ? textRef.current.trim() === '' : textRef.current === initial)
            ? null
            : textRef.current,
      },
    );
    return () => {
      release();
      // StrictMode's replay is not an ended edit. Keep the pending draft
      // reachable by the parent file's retiring flush until this microtask.
      queueMicrotask(() => {
        if (life.generation !== generation) return;
        commitRef.current();
        unregister();
      });
    };
  }, [editor, state, editing, draftId, initial]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!input.current?.contains(event.target as Node)) commitRef.current();
    };
    const stop = editor.subscribe(({ cause, board }) => {
      if (
        cause === 'external' &&
        editing.kind !== 'draft' &&
        !(editing.kind === 'edge' ? board.edges : board.nodes).has(editing.id)
      ) {
        // Close its absent geometry, while the original text stays retained
        // against that target until the person resolves it.
        state.setState({ editing: null });
        toast(
          `This ${editing.kind === 'edge' ? 'connection' : 'card'} was removed outside the whiteboard. Its text draft is still held and has not been saved.`,
        );
        focus();
      }
    });
    window.addEventListener('pointerdown', outside, true);
    return () => {
      stop();
      window.removeEventListener('pointerdown', outside, true);
    };
  }, [editor, editing, state, toast, focus]);
  if (!box) return null;
  const props = {
    'data-testid': 'wb-text-editor',
    'data-key-claim': 'editor',
    'data-no-pan': 'true',
    'aria-label':
      editing.kind === 'edge' ? 'Connection label' : label ? 'Group label' : 'Card markdown',
    value: text,
    className: `absolute z-20 resize-none rounded-md border border-cortex-500 bg-n-0 text-n-800 shadow-sm outline-none ${label ? 'px-2 py-1' : 'p-2'}`,
    style: {
      left: transform.offset.x + box.x * transform.scale,
      top: transform.offset.y + box.y * transform.scale,
      width: box.width * transform.scale,
      height: (label ? Math.max(32, box.height) : box.height) * transform.scale,
      fontSize: 14 * transform.scale,
      lineHeight: 1.4,
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      textRef.current = event.target.value;
      setText(event.target.value);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229) return;
      if (
        event.key === 'Escape' ||
        (event.key === 'Enter' && (label || event.metaKey || event.ctrlKey))
      ) {
        event.preventDefault();
        event.stopPropagation();
        commitRef.current();
      }
    },
  };
  return label ? (
    <input
      {...props}
      ref={(element) => {
        input.current = element;
      }}
    />
  ) : (
    <textarea
      {...props}
      ref={(element) => {
        input.current = element;
      }}
    />
  );
}
