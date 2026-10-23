import { useEffect, useRef, useState } from 'react';
import type { ChangesHeal } from '@/agent/elements/conversationChanges';
import { conversationChanges } from '@/lib/gitIpc';

const UNAVAILABLE: ChangesHeal = { state: 'unavailable' };

/**
 * The Changes card's heal (M92.12): `conversation_changes`, which reads the
 * runs of the conversation's session back from Cerebro's records and git,
 * for `railChanges` to fold in where no reply holds a run's changeset. Asked
 * only while the rail can be seen, docked or as a drawer, never while it is
 * folded away, turned off or unmounted (M92.1): as it shows, when the vault
 * or the session changes under it, and when a turn ends. Never polled; a
 * turn that ended while it was hidden is read when it shows again.
 *
 * Null until this vault and session's first answer lands; a later read keeps
 * the last answer until its own lands, and only the newest read's answer
 * lands. A read that fails is unavailable, never no runs (CV-05), and
 * nothing is toasted: the read is passive, and the card says it.
 */
export function useChangesHeal(
  vault: string | null,
  sessionId: string | null,
  { visible, streaming }: { visible: boolean; streaming: boolean },
): ChangesHeal | null {
  const key = vault === null || sessionId === null ? null : `${vault}\n${sessionId}`;
  const [held, setHeld] = useState<{ key: string; heal: ChangesHeal } | null>(null);
  /** The newest read: only its answer lands. */
  const newest = useRef(0);
  /** What the last effect saw, which says whether the rail showed, the
   * session changed or a turn ended since. A ref, so StrictMode's second run
   * asks nothing. */
  const seen = useRef<{ key: string | null; visible: boolean; streaming: boolean } | null>(null);

  useEffect(() => {
    const last = seen.current;
    seen.current = { key, visible, streaming };
    if (key === null || vault === null || sessionId === null || !visible) return;
    const shown = last === null || !last.visible || last.key !== key;
    const ended = last !== null && last.streaming && !streaming;
    if (!shown && !ended) return;
    newest.current += 1;
    const read = newest.current;
    const land = (heal: ChangesHeal) => {
      if (read === newest.current) setHeld({ key, heal });
    };
    conversationChanges(vault, sessionId).then(
      ({ changesets, truncated }) => land({ state: 'read', changesets, truncated }),
      () => land(UNAVAILABLE),
    );
  }, [key, vault, sessionId, visible, streaming]);

  return held !== null && held.key === key ? held.heal : null;
}
