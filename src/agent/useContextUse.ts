import { useEffect, useRef, useState } from 'react';
import { agentContextUsage, type ContextUseAnswer } from './agentIpc';

/** What `useContextUse` reads: the session's latest reading, not recorded,
 * unavailable when the read failed, or loading before the first answer. */
export type ContextUseState = { state: 'loading' } | ContextUseAnswer | { state: 'unavailable' };

const LOADING: ContextUseState = { state: 'loading' };
const NOT_RECORDED: ContextUseState = { state: 'not_recorded' };
const UNAVAILABLE: ContextUseState = { state: 'unavailable' };

/** An answer as the composer may show it: one that is neither a reading nor
 * not recorded could not be read, so it is unavailable, never a figure. */
function shown(answer: ContextUseAnswer): ContextUseState {
  if (answer.state === 'not_recorded') return NOT_RECORDED;
  if (
    answer.state === 'recorded' &&
    Number.isFinite(answer.used) &&
    answer.used >= 0 &&
    typeof answer.at === 'string'
  ) {
    return answer;
  }
  return UNAVAILABLE;
}

/**
 * How full a conversation's context is (M91.5), for the composer's Context
 * element: `agent_context_usage`, pulled when the hook mounts, when the
 * session changes and when a turn ends (`streaming` going false). Never
 * polled, and never pushed: no event carries a token count (Q7).
 *
 * `loading` until the session's first answer lands; a later pull keeps the
 * last answer until its own lands. A conversation with no session yet has
 * nothing recorded and asks nothing. A read that fails is `unavailable`,
 * never `not_recorded` (CV-05), and nothing is toasted: the read is
 * passive, and the element says it in its own words.
 */
export function useContextUse(
  sessionId: string | null,
  { streaming }: { streaming: boolean },
): ContextUseState {
  const [held, setHeld] = useState<{ sessionId: string; value: ContextUseState } | null>(null);
  /** The newest pull: only its answer lands, so a late one for another
   * session or an earlier turn never paints over it. */
  const newest = useRef(0);
  /** What the last effect saw, which says whether a session opened or a
   * turn ended since. A ref, so StrictMode's second run asks nothing. */
  const seen = useRef<{ sessionId: string | null; streaming: boolean } | null>(null);

  useEffect(() => {
    const last = seen.current;
    seen.current = { sessionId, streaming };
    const opened = last === null || last.sessionId !== sessionId;
    const ended = last !== null && last.streaming && !streaming;
    if (sessionId === null || !(opened || ended)) return;
    newest.current += 1;
    const pull = newest.current;
    const land = (value: ContextUseState) => {
      if (pull === newest.current) setHeld({ sessionId, value });
    };
    agentContextUsage(sessionId).then(
      (answer) => land(shown(answer)),
      () => land(UNAVAILABLE),
    );
  }, [sessionId, streaming]);

  if (sessionId === null) return NOT_RECORDED;
  return held?.sessionId === sessionId ? held.value : LOADING;
}
