import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SceneEditor } from '@/engine/scene/editor';

interface BoardDraft {
  prepare: () => boolean;
  snapshot: () => string | null;
}
export interface BoardDraftOwner {
  editor: SceneEditor;
  id: string;
}
interface Registration extends BoardDraft {
  mounted: boolean;
}
/** Scene serialization follows synchronous preparation of every text/inspector
 * buffer. Invalid or refused values stay retained against their original target. */
const pending = new WeakMap<SceneEditor, Map<string, Registration>>();
const retired = new WeakSet<SceneEditor>();
const observers = new WeakMap<SceneEditor, Set<() => void>>();
const changed = (editor: SceneEditor) => {
  for (const notify of observers.get(editor) ?? []) notify();
};
export function subscribeBoardDrafts(editor: SceneEditor, notify: () => void): () => void {
  const listeners = observers.get(editor) ?? new Set<() => void>();
  observers.set(editor, listeners);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
export function discardBoardDrafts(editor: SceneEditor): void {
  retired.add(editor);
  pending.delete(editor);
  changed(editor);
}
export function registerBoardDraft({ editor, id }: BoardDraftOwner, draft: BoardDraft): () => void {
  if (retired.has(editor)) return () => {};
  const book = pending.get(editor) ?? new Map<string, Registration>();
  pending.set(editor, book);
  const entry = { ...draft, mounted: true };
  book.set(id, entry);
  return () => {
    entry.mounted = false;
    if (book.get(id) === entry && entry.snapshot() === null) book.delete(id);
    if (!book.size) pending.delete(editor);
  };
}
export function pendingBoardDrafts(editor: SceneEditor): { id: string; text: string }[] {
  return [...(pending.get(editor) ?? [])].flatMap(([id, entry]) => {
    const text = entry.snapshot();
    return text === null ? [] : [{ id, text }];
  });
}
export function settleBoardText(editor: SceneEditor): boolean {
  if (retired.has(editor)) return true;
  let settled = true;
  const book = pending.get(editor);
  for (const [id, entry] of [...(book ?? [])]) {
    if (!entry.prepare()) settled = false;
    if (!entry.mounted && entry.snapshot() === null && book?.get(id) === entry) book.delete(id);
  }
  return settled;
}

/** Inspector controls share exact draft retention, but their command remains
 * the scene's existing checked writer. False never clears the typed value. */
export function useBoardDraft(
  owner: BoardDraftOwner | undefined,
  initial: string,
  commit: (text: string) => string | false,
) {
  const restored = owner ? (pending.get(owner.editor)?.get(owner.id)?.snapshot() ?? null) : null;
  const [draft, setDraft] = useState(restored ?? initial);
  const [error, setError] = useState(false);
  const value = useRef(restored ?? initial);
  const dirty = useRef(restored !== null);
  const mounted = useRef(true);
  const latestCommit = useRef(commit);
  latestCommit.current = commit;
  const latestPrepare = useRef<() => boolean>(() => true);
  const prepare = () => {
    if (owner && retired.has(owner.editor)) return false;
    if (!dirty.current) return true;
    const accepted = latestCommit.current(value.current);
    if (accepted === false) {
      if (mounted.current) setError(true);
      return false;
    }
    dirty.current = false;
    value.current = accepted;
    if (mounted.current) {
      setDraft(accepted);
      setError(false);
    }
    if (owner) changed(owner.editor);
    return true;
  };
  latestPrepare.current = prepare;
  useEffect(() => {
    if (dirty.current) return;
    value.current = initial;
    setDraft(initial);
    setError(false);
  }, [initial]);
  const ownerEditor = owner?.editor;
  const ownerId = owner?.id;
  useLayoutEffect(() => {
    mounted.current = true;
    const release =
      ownerEditor !== undefined && ownerId !== undefined
        ? registerBoardDraft(
            { editor: ownerEditor, id: ownerId },
            {
              prepare: () => latestPrepare.current(),
              snapshot: () => (dirty.current ? value.current : null),
            },
          )
        : undefined;
    return () => {
      mounted.current = false;
      release?.();
    };
  }, [ownerEditor, ownerId]);
  return {
    draft,
    error,
    prepare,
    change(text: string) {
      if (owner && retired.has(owner.editor)) return;
      dirty.current = true;
      value.current = text;
      setDraft(text);
      setError(false);
      if (owner) changed(owner.editor);
    },
    discard() {
      dirty.current = false;
      value.current = initial;
      setDraft(initial);
      setError(false);
      if (owner) changed(owner.editor);
    },
  };
}
