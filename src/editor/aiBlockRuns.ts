import { useSyncExternalStore } from 'react';

/**
 * The AI blocks whose answer is being written (M91.14), per editor. The
 * editor runs a block's question (MarkdownEditor's `cerebro:ai-block-run`
 * handler) and marks it here; the block reads it to draw its run as working,
 * so blocks.tsx stays free of the agent and the vault. Memory only: a run
 * belongs to the editor that started it, and goes with it.
 */

const runs = new WeakMap<object, Set<string>>();
const listeners = new Set<() => void>();

/** Marks a block's answer as being written, or as no longer. */
export function setAiBlockRunning(editor: object, id: string, running: boolean): void {
  let ids = runs.get(editor);
  if (running) {
    if (ids === undefined) runs.set(editor, (ids = new Set()));
    if (ids.has(id)) return;
    ids.add(id);
  } else if (ids === undefined || !ids.delete(id)) {
    return;
  }
  for (const listener of listeners) listener();
}

/** Whether a block's answer is being written. */
export function isAiBlockRunning(editor: object, id: string): boolean {
  return runs.get(editor)?.has(id) ?? false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The same, for a block's render: it draws again when its run starts or ends. */
export function useAiBlockRunning(editor: object, id: string): boolean {
  return useSyncExternalStore(subscribe, () => isAiBlockRunning(editor, id));
}
