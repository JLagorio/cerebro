import { useMemo, type Ref, type RefCallback } from 'react';

/**
 * A part's own ref and the caller's as one ref callback (React 19: a ref is
 * an ordinary prop, and a callback may return its own cleanup). Each ref is
 * cleared, or its cleanup run, when the element goes.
 */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    const cleanups = refs.map((ref) => attach(ref, node));
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  };
}

/** Two refs merged, kept stable while they are, so React does not detach
 *  and attach the element on every render. */
export function useMergedRefs<T>(
  own: Ref<T> | undefined,
  theirs: Ref<T> | undefined,
): RefCallback<T> {
  return useMemo(() => mergeRefs(own, theirs), [own, theirs]);
}

function attach<T>(ref: Ref<T> | undefined, node: T | null): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(node);
    return typeof cleanup === 'function' ? cleanup : () => ref(null);
  }
  if (ref === null || ref === undefined) return () => undefined;
  ref.current = node;
  return () => {
    ref.current = null;
  };
}
