import { useMemo } from 'react';
import { unwrapToolError } from '@/agent/errorText';
import { UnfoldDetails } from '@/agent/Unfold';
import { StackTrace } from '@/components/ai/StackTrace';
import { useArrival } from '@/components/ui/motion';
import { parseStackTrace } from '@/engine/ai/stackFrames';
import type { FailureNotice } from '@/agent/types';

/**
 * A failed turn, typed (M56.4).
 *
 * Rust's classifier (src-tauri/src/agent/failure.rs) reads Claude Code's typed
 * fields and words the failure: what happened, what to do, and which fix to
 * offer. This card shows those words as they came. It never switches on
 * `kind` (D3): a kind this build has never heard of still reads right,
 * because its title and body arrive with it. What Claude Code itself said
 * stays one click away, so the card never hides the evidence it summarizes;
 * when that printed a stack, it is the AI elements' Stack Trace too
 * (M91.13), its frames in this vault opening their page.
 */

/** The words on each action's button. An action the card has no handler for
 * draws no button: a fix that does nothing is worse than none. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  open_settings: 'Open Settings',
  new_conversation: 'Start a new conversation',
  choose_model: 'Choose another model',
};

/**
 * When a limit resets, as a person reads it: weekday, month, day and time
 * ("Thu, Jan 1, 12:00 AM" in en-US). `locale` and `timeZone` default to the
 * viewer's own; tests pin both. A value that is not a date comes back as it
 * was.
 */
export function formatResetTime(iso: string, locale?: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return (
    new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    })
      .format(at)
      // Newer ICU puts a narrow no-break space before AM/PM; a plain one
      // reads the same and matches what a person would type.
      .replace(/[\u202f\u00a0]/g, ' ')
  );
}

export function FailureNoticeCard({
  notice,
  raw,
  actions = {},
  onReviewRecovery,
  onOpenPath,
  arrive = false,
}: {
  notice: FailureNotice;
  /** What Claude Code said, word for word: the message's error. */
  raw?: string;
  /** A handler per action this panel can carry out. */
  actions?: Partial<Record<string, () => void>>;
  /** Inspect this reply without sending its question again. */
  onReviewRecovery?: (opener: HTMLButtonElement) => void;
  /** Opens a page a stack frame names. */
  onOpenPath?: (path: string) => void;
  /** The turn failed while the conversation watched (components/ui/motion.ts). */
  arrive?: boolean;
}) {
  const arrival = useArrival(arrive);
  const said = raw === undefined ? '' : unwrapToolError(raw).trim();
  const stack = useMemo(() => said !== '' && parseStackTrace(said) !== null, [said]);
  const handler = notice.action === null ? undefined : actions[notice.action];
  const label = notice.action === null ? undefined : ACTION_LABELS[notice.action];
  // Only a limit names a window; one that named no reset says so rather
  // than leaving the person to guess.
  const reset =
    notice.resets_at !== null
      ? `Resets ${formatResetTime(notice.resets_at)}`
      : notice.window !== null
        ? 'Reset time not reported'
        : null;
  return (
    <div
      data-testid="failure-notice"
      role="group"
      aria-label={notice.title}
      className="flex flex-col items-start gap-1.5 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs leading-[17px]"
      {...arrival}
    >
      <span className="font-semibold text-danger-700">{notice.title}</span>
      <span className="text-n-700">{notice.body}</span>
      {reset !== null && (
        <span data-testid="failure-notice-reset" className="text-n-700">
          {reset}
        </span>
      )}
      {notice.cli_version !== null && (
        <span className="text-2xs text-n-500">Reported by Claude Code {notice.cli_version}</span>
      )}
      {raw !== undefined && raw !== '' && (
        <UnfoldDetails
          data-testid="failure-notice-raw"
          className="text-2xs text-n-500"
          summary={<summary className="cursor-pointer">What Claude Code said</summary>}
        >
          <p className="cb-chat-reveal m-0 mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
            {said}
          </p>
        </UnfoldDetails>
      )}
      {stack && (
        <StackTrace
          trace={said}
          title="Stack trace"
          onOpenPath={onOpenPath === undefined ? undefined : (path) => onOpenPath(path)}
        />
      )}
      {((handler !== undefined && label !== undefined) || onReviewRecovery !== undefined) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {handler !== undefined && label !== undefined && (
            <button
              type="button"
              data-testid="failure-notice-action"
              onClick={handler}
              className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-n-800 hover:border-n-400"
            >
              {label}
            </button>
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
      )}
    </div>
  );
}
