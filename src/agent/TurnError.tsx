import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readErrorText } from '@/agent/errorText';
import { UnfoldDetails } from '@/agent/Unfold';
import { StackTrace } from '@/components/ai/StackTrace';
import { Arrival } from '@/components/ui/motion';
import { parseStackTrace } from '@/engine/ai/stackFrames';

/**
 * A failed turn Rust could not type (M56.4): the red box, in Claude Code's
 * own words. A long failure shows its first lines (errorText.ts), clamped to
 * three on screen whatever the width, and the whole of it one click away in
 * a scrolling fold, so a tool catalogue never fills the conversation. The
 * fold is offered whenever something is out of sight: lines errorText cut,
 * or a short failure that wraps past the clamp in a narrow panel. A failure
 * that printed a stack also shows it as the AI elements' Stack Trace
 * (M91.13), its frames in this vault opening their page; its words stay the
 * box's.
 */
export function TurnError({
  error,
  onReviewRecovery,
  onOpenPath,
  arrive = false,
}: {
  /** What Claude Code said: the message's error. */
  error: string;
  /** Inspect this reply without sending its question again. */
  onReviewRecovery?: (opener: HTMLButtonElement) => void;
  /** Opens a page a stack frame names. */
  onOpenPath?: (path: string) => void;
  /** The turn failed while the conversation watched (components/ui/motion.ts). */
  arrive?: boolean;
}) {
  const { full, summary, cut } = readErrorText(error);
  const stack = useMemo(() => parseStackTrace(full) !== null, [full]);
  // Whether the clamp hides the end of the summary at the panel's width.
  const summaryRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (el === null) return;
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary]);
  return (
    <Arrival when={arrive}>
      <div
        data-testid="turn-error"
        className="flex max-w-full flex-col items-start gap-1.5 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs leading-[17px] text-danger-700"
      >
        <span
          ref={summaryRef}
          data-testid="turn-error-summary"
          className="line-clamp-3 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {summary}
        </span>
        {stack && (
          <StackTrace
            trace={full}
            title="Stack trace"
            onOpenPath={onOpenPath === undefined ? undefined : (path) => onOpenPath(path)}
          />
        )}
        {(cut || clipped) && (
          <UnfoldDetails
            data-testid="turn-error-full"
            className="w-full text-2xs text-n-500"
            summary={<summary className="cursor-pointer">Show the full error</summary>}
          >
            <pre className="cb-chat-reveal m-0 mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-700">
              {full}
            </pre>
          </UnfoldDetails>
        )}
        {onReviewRecovery !== undefined && (
          <button
            type="button"
            data-testid="review-recovery"
            tabIndex={0}
            onClick={(event) => onReviewRecovery(event.currentTarget)}
            className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-danger-700 hover:border-danger-500"
          >
            Review what happened
          </button>
        )}
      </div>
    </Arrival>
  );
}
