/**
 * Why a thread's transcript could not be read back (M56.3).
 *
 * Rust types the reason (`transcript::Unavailable`); this only words it. A
 * reason this build does not name still says something true rather than
 * nothing. With a cached copy on screen, the notice says that is what the
 * person is reading.
 */

export interface TranscriptNoticeProps {
  reason: string;
  /** Claude Code's retention in days; null when it never sweeps. */
  retentionDays: number | null;
  detail?: string;
  /** The thread still shows Cerebro's cached copy. */
  cached: boolean;
}

function words(
  reason: string,
  retentionDays: number | null,
  detail: string | undefined,
): { title: string; body: string | null } {
  switch (reason) {
    case 'expired':
      return {
        title: 'Cleared by Claude Code',
        body:
          retentionDays === null
            ? null
            : `Claude Code keeps a conversation's transcript for ${retentionDays} days after its last turn.`,
      };
    case 'cleared':
      return {
        title: "No longer in Claude Code's folder",
        body: "This conversation's transcript is gone from Claude Code's folder for this vault, emptied from Settings or removed by hand.",
      };
    case 'not_recorded':
      return { title: 'No transcript recorded', body: null };
    case 'unreadable':
      return { title: "Couldn't read the transcript", body: detail ?? null };
    default:
      return { title: 'Transcript unavailable', body: null };
  }
}

export function TranscriptNotice({ reason, retentionDays, detail, cached }: TranscriptNoticeProps) {
  const { title, body } = words(reason, retentionDays, detail);
  return (
    <div
      data-testid="transcript-unavailable"
      data-reason={reason}
      role="status"
      className="flex flex-col gap-0.5 rounded-lg border border-n-200 bg-n-25 px-3 py-2 text-xs leading-[17px] text-n-600"
    >
      <span className="font-medium text-n-800">{title}</span>
      {body !== null && <span>{body}</span>}
      {cached && <span>What you see is Cerebro&apos;s copy.</span>}
    </div>
  );
}
