import { useArrival } from '@/components/ui/motion';

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
  /** The read that failed lands after the thread is on screen: the notice
   *  comes in (components/ui/motion.ts). */
  arrive?: boolean;
}

function words(
  reason: string,
  retentionDays: number | null,
  detail: string | undefined,
): { title: string; body: string | null } {
  switch (reason) {
    case 'archive_partial':
      return {
        title: 'Partial archived conversation',
        body: 'Some content expired, was not retained or is outside this page. Settings’ Conversation archive shows older messages and each retained message’s status.',
      };
    case 'archive_unavailable':
      return {
        title: 'Conversation archive unavailable',
        body: 'The archive could not be read. No turn was resent.',
      };
    case 'archive_elsewhere':
      return {
        title: 'Archived in another vault',
        body: 'Open the original vault to read this conversation’s archive.',
      };
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
    case 'cache_trimmed':
      return {
        title: 'Earlier messages unavailable',
        body: 'Some messages were removed from this copy to fit browser storage. The messages shown may be incomplete.',
      };
    case 'not_recorded':
      return { title: 'No transcript recorded', body: null };
    case 'unreadable':
      return { title: "Couldn't read the transcript", body: detail ?? null };
    default:
      return { title: 'Transcript unavailable', body: null };
  }
}

export function TranscriptNotice({
  reason,
  retentionDays,
  detail,
  cached,
  arrive = false,
}: TranscriptNoticeProps) {
  const arrival = useArrival(arrive);
  const { title, body } = words(reason, retentionDays, detail);
  return (
    <div
      data-testid="transcript-unavailable"
      data-reason={reason}
      role="status"
      className="flex flex-col gap-0.5 rounded-lg border border-n-200 bg-n-25 px-3 py-2 text-xs leading-[17px] text-n-600"
      {...arrival}
    >
      <span className="font-medium text-n-800">{title}</span>
      {body !== null && <span>{body}</span>}
      {cached && <span>What you see is Cerebro&apos;s copy.</span>}
    </div>
  );
}
