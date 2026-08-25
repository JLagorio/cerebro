import { Icon } from '@/components/ui/Icon';

export interface SectionAction {
  icon: string;
  label: string;
  onClick: () => void;
  /** e2e reaches for some actions by testid (new-collection). */
  testId?: string;
}

/**
 * One header anatomy for every sidebar section (M43, from the design's
 * `sec()`): rotating chevron + uppercase label toggle the section; actions
 * live on the right, revealed on header hover (and always for keyboard
 * focus), 20px hit targets. Controlled — open state belongs to the caller,
 * because Databases already persists via `typesOpen` and everything else
 * rides the navClosed set.
 */
export function SectionHeader({
  label,
  open,
  onToggle,
  actions = [],
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: SectionAction[];
}) {
  return (
    <div className="group/sec flex items-center gap-0.5 pb-1 pl-1.5 pr-1 pt-3.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 border-0 bg-transparent p-0 text-left text-2xs font-semibold uppercase tracking-[0.06em] text-n-500 hover:text-n-700"
      >
        <span
          className="inline-flex flex-none transition-transform duration-[120ms]"
          style={open ? { transform: 'rotate(90deg)' } : undefined}
        >
          <Icon name="chevron-right" size={13} />
        </span>
        {label}
      </button>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          aria-label={a.label}
          title={a.label}
          data-testid={a.testId}
          onClick={a.onClick}
          className="flex h-5 w-5 flex-none items-center justify-center rounded border-0 bg-transparent text-n-400 opacity-0 hover:bg-n-200 hover:text-n-700 focus-visible:opacity-100 group-hover/sec:opacity-100"
        >
          <Icon name={a.icon} size={13} />
        </button>
      ))}
    </div>
  );
}
