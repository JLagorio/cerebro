import { useCallback, useLayoutEffect, type RefObject, type SetStateAction } from 'react';
import { useNavStore, usePaneId, type EntryStateKey } from '@/stores/navStore';

/** This visit's state, never the saved view's YAML or a later fresh visit. */
export function useEntryState<T>(
  key: EntryStateKey,
  initial: T,
): [T, (value: SetStateAction<T>) => void] {
  const pane = usePaneId();
  const stored = useNavStore((state) => state.history[state.historyIndex]?.state?.[key]);
  const value = stored === undefined ? initial : (stored as T);
  const set = useCallback(
    (next: SetStateAction<T>) => {
      const nav = useNavStore.getPaneState(pane);
      const saved = nav.readEntryState<T>(key);
      const previous = saved === undefined ? initial : saved;
      nav.setEntryState(
        key,
        typeof next === 'function' ? (next as (value: T) => T)(previous) : next,
      );
    },
    [key, initial, pane],
  );
  return [value, set];
}
interface ScrollState {
  top: number;
  left: number;
}
function readScroll(value: unknown): ScrollState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ScrollState>;
  return typeof raw.top === 'number' &&
    Number.isFinite(raw.top) &&
    raw.top >= 0 &&
    typeof raw.left === 'number' &&
    Number.isFinite(raw.left) &&
    raw.left >= 0
    ? { top: raw.top, left: raw.left }
    : null;
}
export function useEntryScroll(
  ref: RefObject<HTMLElement | null>,
  key: EntryStateKey | null,
): void {
  const pane = usePaneId();
  const seq = useNavStore((state) => state.navSeq);
  useLayoutEffect(() => {
    if (key === null) return;
    const nav = useNavStore.getPaneState(pane);
    const saved = readScroll(nav.readEntryState(key));
    const restore = () => {
      if (!saved || !ref.current || useNavStore.getPaneState(pane).navSeq !== seq) return;
      ref.current.scrollTop = saved.top;
      ref.current.scrollLeft = saved.left;
    };
    restore();
    const frame = saved ? requestAnimationFrame(restore) : null;
    const unregister = nav.registerEntryCaptor(key, () =>
      ref.current ? { top: ref.current.scrollTop, left: ref.current.scrollLeft } : undefined,
    );
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      unregister();
    };
  }, [key, ref, seq, pane]);
}
