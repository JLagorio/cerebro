import { Icon } from '@/components/ui/Icon';
import { REVIEW_LABELS, type ReviewState } from '@/engine/okf';

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
  unreviewed: { icon: 'circle-question-mark', fg: 'var(--n-600)', bg: 'var(--n-100)' },
  current: { icon: 'shield-check', fg: 'var(--success-700)', bg: 'var(--success-50)' },
  // Amber, not green: somebody looked, and what they looked at has moved.
  predates_current: { icon: 'clock-alert', fg: 'var(--warn-700)', bg: 'var(--warn-50)' },
};

const BY: Record<'human' | 'agent', string> = {
  human: 'by a person',
  agent: 'by an agent',
};

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
  const tone = TONE[status];
  const trailing = [by === null ? null : BY[by], detail ?? null].filter((part) => part !== null);
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
      {REVIEW_LABELS[status]}
      {trailing.length > 0 ? <span style={{ opacity: 0.75 }}>· {trailing.join(' · ')}</span> : null}
    </span>
  );
}

/** Lifecycle and staleness read as warnings, so they get their own chip. */
export function FlagChip({
  icon,
  label,
  tone,
}: {
  icon: string;
  label: string;
  tone: 'warn' | 'muted';
}) {
  const fg = tone === 'warn' ? 'var(--warn-700)' : 'var(--n-600)';
  const bg = tone === 'warn' ? 'var(--warn-50)' : 'var(--n-100)';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-xs font-medium"
      style={{ background: bg, color: fg }}
    >
      <Icon name={icon} size={12} />
      {label}
    </span>
  );
}
