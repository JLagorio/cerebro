import { useEffect, useState } from 'react';

/**
 * Send focus back where it came from when this surface unmounts (PR #7 review).
 *
 * The element to return to is captured in a `useState` initializer — during
 * the first RENDER, before React has committed a single node of this tree.
 * That timing is the whole point, and reading it from an effect instead gets
 * a provably wrong answer: `autoFocus` focuses during commit, and every child
 * effect runs before its parent's, so any surface holding a focused field
 * (the assistant's composer, QuickOpen's input) reads back its OWN input as
 * the "opener". That node is unmounted by the time the cleanup wants it,
 * `isConnected` is false, the restore is skipped — and focus lands on
 * `<body>`, precisely the thing this exists to prevent.
 */
export function useFocusRestore(): void {
  const [opener] = useState<HTMLElement | null>(() => {
    const active = document.activeElement;
    // `<body>` is where focus sits when nothing holds it, so it is not an
    // opener — recording null says "there was nowhere to go back to".
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });

  useEffect(() => {
    return () => {
      // A node that left the document while the surface was open — a row the
      // surface's own work replaced — cannot take focus back.
      if (opener === null || !opener.isConnected) return;
      // Restore only from nowhere (M16.35). Closing a surface normally leaves
      // focus on `<body>`, because the node holding it was just removed —
      // that is the case this hook exists for. But a surface that hands off,
      // like a context menu item opening a rename field, unmounts in the SAME
      // commit that mounts and autofocuses its successor, and this cleanup
      // runs after that: restoring unconditionally yanked focus out of the
      // field the user was sent to. Anything already holding focus took it
      // deliberately and outranks a going-away surface's memory.
      const now = document.activeElement;
      if (now !== null && now !== document.body) return;
      opener.focus();
    };
  }, [opener]);
}
