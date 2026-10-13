import { Icon } from '@/components/ui/Icon';
import { AGENT_ONLY_LABEL, REVIEW_LABELS, type ReviewState } from '@/engine/okf';

/**
 * Did a review cover what this says now — D8 channel 1 (M27.5c).
 *
 * This replaces the three-rung trust chip, which answered two questions on
 * one ladder: whether anybody reviewed, and who. M27 makes the first one an
 * axis of its own, so the chip renders the STATUS and names the actor beside
 * it rather than ranking a person above a process.
 *
 * It is not one of the three axes and never stands in for one. In particular
 * it is never Support: a concept can be reviewed and rest on nothing, which
 * is exactly what a migrated verified concept is.
 *
 * Advisory, derived, never stored, never access control (OKF §5.3).
 */
const TONE: Record<ReviewState, { icon: string; fg: string; bg: string }> = {
  // The accent (M52.5), as the Review queue and the Concepts table colour
  // it: nobody has read it, so it waits on the reader. The grey pill it wore
  // dressed it as settled, beside a blue "Needs a person" one step further
  // along — the emphasis upside down.
  unreviewed: {
    icon: 'circle-question-mark',
    fg: 'var(--cortex-700)',
    bg: 'var(--cortex-50)',
  },
  current: { icon: 'shield-check', fg: 'var(--success-700)', bg: 'var(--success-50)' },
  // Amber, not green: somebody looked, and what they looked at has moved.
  predates_current: { icon: 'clock-alert', fg: 'var(--warn-700)', bg: 'var(--warn-50)' },
  // M49.8: the file claims a review its recorded history does not hold.
  disputed: { icon: 'shield-alert', fg: 'var(--warn-700)', bg: 'var(--warn-50)' },
};

const BY: Record<'human' | 'agent', string> = {
  human: 'by a person',
  agent: 'by an agent',
};

/** A review only an agent gave (M52.5): current, and still waiting on a
 * person — the Review queue's `agent-only`, in its accent. Green said
 * "settled" on the page while the table said "waiting". */
const NEEDS_PERSON = { icon: 'user-check', fg: 'var(--cortex-700)', bg: 'var(--cortex-50)' };

export function ReviewChip({
  status,
  by = null,
  detail,
  size = 'md',
}: {
  status: ReviewState;
  /** Who attested. Rendered as words, never as a rung. */
  by?: 'human' | 'agent' | null;
  /** Freshness or actor line appended after a separator. */
  detail?: string | null;
  size?: 'sm' | 'md';
}) {
  const agentOnly = status === 'current' && by === 'agent';
  const tone = agentOnly ? NEEDS_PERSON : TONE[status];
  const trailing = [
    by === null ? null : agentOnly ? 'confirmed by an agent' : BY[by],
    detail ?? null,
  ].filter((part) => part !== null);
  return (
    <span
      data-testid="review-chip"
      data-review={status}
      data-by={by ?? 'nobody'}
      className={`inline-flex items-center gap-1.5 rounded-full ${
        size === 'sm' ? 'px-1.5 py-[1px] text-2xs' : 'px-2 py-[3px] text-xs'
      } font-medium`}
      style={{ background: tone.bg, color: tone.fg }}
    >
      <Icon name={tone.icon} size={size === 'sm' ? 10 : 12} />
      {agentOnly ? AGENT_ONLY_LABEL : REVIEW_LABELS[status]}
      {trailing.length > 0 ? <span style={{ opacity: 0.75 }}>· {trailing.join(' · ')}</span> : null}
    </span>
  );
}

/** A flag's colours. `accent` is what waits on the reader (M52.5): the
 * cortex pair a selected row uses, so the rows that need you are the ones
 * that stand out — the muted grey pill used to dress a concept waiting for
 * review exactly as it dressed one already retired. */
const FLAG_TONE: Record<'warn' | 'muted' | 'accent', { fg: string; bg: string }> = {
  warn: { fg: 'var(--warn-700)', bg: 'var(--warn-50)' },
  muted: { fg: 'var(--n-600)', bg: 'var(--n-100)' },
  accent: { fg: 'var(--cortex-700)', bg: 'var(--cortex-50)' },
};

/** Lifecycle and staleness read as warnings, so they get their own chip. */
export function FlagChip({
  icon,
  label,
  tone,
  title,
  testId,
}: {
  icon: string;
  label: string;
  tone: 'warn' | 'muted' | 'accent';
  /** The longer sentence behind a short label, on hover. */
  title?: string;
  testId?: string;
}) {
  const { fg, bg } = FLAG_TONE[tone];
  return (
    <span
      data-testid={testId}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-xs font-medium"
      style={{ background: bg, color: fg }}
    >
      <Icon name={icon} size={12} />
      {label}
    </span>
  );
}
