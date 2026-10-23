import { Tooltip } from '@/components/ui/Tooltip';
import { Icon } from '@/components/ui/Icon';
import { chevronClass, REVEAL } from '@/app/sidebarChrome';

export interface SectionAction {
  icon: string;
  label: string;
  command?: string;
  onClick: () => void;
  /** e2e reaches for some actions by testid (new-collection). */
  testId?: string;
}

/**
 * One header anatomy for every sidebar section (M43, from the design's
 * `sec()`): rotating chevron + sentence-case label toggle the section; actions
 * live on the right, revealed on header hover (and always for keyboard
 * focus), 24px hit targets. Controlled — open state belongs to the caller,
 * because Databases already persists via `typesOpen` and everything else
 * rides the navClosed set. What the section holds is the caller's too, and
 * arrives under the header in a `FOLD_IN` wrapper (app/sidebarChrome.ts).
 */
export function SectionHeader({
  label,
  open,
  onToggle,
  actions = [],
  variant = 'section',
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: SectionAction[];
  /** A contextual sidebar owns one title; its list needs no second wrapper. */
  variant?: 'section' | 'context';
}) {
  return (
    <div
      className={
        variant === 'context'
          ? 'm71-context-heading m71-context-heading--controls group/sec'
          : 'group/sec flex items-center gap-1 pb-1 pl-1.5 pr-1 pt-3'
      }
    >
      <button
        type="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        className={`motion-hover flex min-h-6 min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left font-medium ${
          variant === 'context'
            ? 'text-ui text-n-900'
            : 'text-xs text-(--text-meta) hover:text-n-800'
        }`}
      >
        {variant === 'context' && <span className="truncate">{label}</span>}
        {/* An open context header shows its chevron only when asked, the way
            Macro's sections do: shut, it stays, saying there is more. */}
        <span
          className={`inline-flex flex-none ${chevronClass(open)} ${variant === 'context' && open ? 'text-n-400 opacity-0 group-hover/sec:opacity-100 group-focus-within/sec:opacity-100' : ''}`}
        >
          <Icon name="chevron-right" size={13} />
        </span>
        {variant === 'section' && label}
      </button>
      {actions.map((a) => (
        <Tooltip key={a.label} label={a.label} command={a.command}>
          <button
            type="button"
            tabIndex={0}
            aria-label={a.label}
            data-testid={a.testId}
            onClick={a.onClick}
            className={`${REVEAL} flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-500 opacity-0 hover:bg-n-100 hover:text-n-800 focus-visible:opacity-100 group-hover/sec:opacity-100`}
          >
            <Icon name={a.icon} size={13} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
