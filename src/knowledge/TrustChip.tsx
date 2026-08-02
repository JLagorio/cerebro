import { Icon } from '@/components/ui/Icon';
import { TRUST_LABELS, type TrustTier } from '@/engine/okf';

/**
 * Trust is DERIVED and advisory (OKF §5.3) — never access control, never
 * stored. The chip says how a concept earned its tier, because "unverified"
 * is a state to act on, not an error to hide.
 */
const TONE: Record<TrustTier, { icon: string; fg: string; bg: string }> = {
  unverified: { icon: 'circle-help', fg: 'var(--n-600)', bg: 'var(--n-100)' },
  'machine-confirmed': { icon: 'bot', fg: 'var(--cortex-600)', bg: 'var(--cortex-50)' },
  'human-reviewed': { icon: 'shield-check', fg: 'var(--success-700)', bg: 'var(--success-50)' },
};

export function TrustChip({
  tier,
  detail,
  size = 'md',
}: {
  tier: TrustTier;
  /** Freshness or actor line appended after a separator. */
  detail?: string | null;
  size?: 'sm' | 'md';
}) {
  const tone = TONE[tier];
  return (
    <span
      data-testid="trust-chip"
      data-tier={tier}
      className={`inline-flex items-center gap-1.5 rounded-full ${
        size === 'sm' ? 'px-1.5 py-[1px] text-[10.5px]' : 'px-2 py-[3px] text-[11.5px]'
      } font-medium`}
      style={{ background: tone.bg, color: tone.fg }}
    >
      <Icon name={tone.icon} size={size === 'sm' ? 10 : 12} />
      {TRUST_LABELS[tier]}
      {detail ? <span style={{ opacity: 0.75 }}>· {detail}</span> : null}
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
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11.5px] font-medium"
      style={{ background: bg, color: fg }}
    >
      <Icon name={icon} size={12} />
      {label}
    </span>
  );
}
