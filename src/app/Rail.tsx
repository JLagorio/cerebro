import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { inboxCount } from '@/engine/inbox';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

function RailButton({
  icon,
  label,
  active = false,
  count,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  /** Queue size shown as a corner badge; omitted or 0 renders nothing. */
  count?: number;
  onClick?: () => void;
}) {
  const tone = active
    ? 'bg-[var(--cortex-50)] text-[var(--cortex-600)]'
    : 'text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count !== undefined && count > 0 ? `${label} (${count})` : label}
      className={`relative flex w-11 flex-col items-center gap-[3px] rounded-lg border-0 bg-transparent pb-[5px] pt-1.5 text-[10px] font-medium ${tone}`}
    >
      <Icon name={icon} size={18} />
      {count !== undefined && count > 0 && (
        <span
          data-testid="rail-badge"
          className="absolute right-1.5 top-0.5 min-w-[15px] rounded-full bg-[var(--cortex-500)] px-1 text-center text-[9px] font-semibold leading-[15px] text-[var(--n-0)] tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
      {label}
    </button>
  );
}

export function Rail() {
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const entries = useVaultStore((s) => s.entries);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  // Task 11: Docs owns the document surfaces; Home keeps the item world.
  const docsActive = selection.kind === 'docs' || selection.kind === 'doc';
  const settingsActive = selection.kind === 'settings';
  const inboxActive = selection.kind === 'inbox';
  const queued = useMemo(
    () => (inboxEnabled ? inboxCount(entries) : 0),
    [entries, inboxEnabled],
  );

  return (
    <div className="flex w-14 flex-none flex-col items-center gap-1 border-r border-[var(--n-100)] bg-[var(--n-0)] py-3">
      <div className="mb-3 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-[var(--cortex-500)] text-[17px] font-bold tracking-[-0.02em] text-[var(--n-0)]">
        c.
      </div>
      <RailButton
        icon="house"
        label="Home"
        active={!settingsActive && !docsActive && !inboxActive}
        onClick={() => navigate({ kind: 'home' })}
      />
      {inboxEnabled && (
        <RailButton
          icon="inbox"
          label="Inbox"
          active={inboxActive}
          count={queued}
          onClick={() => navigate({ kind: 'inbox' })}
        />
      )}
      <RailButton
        icon="library"
        label="Docs"
        active={docsActive}
        onClick={() => navigate({ kind: 'docs' })}
      />
      <div className="flex-1" />
      <RailButton
        icon="settings"
        label="Settings"
        active={settingsActive}
        onClick={() => navigate({ kind: 'settings' })}
      />
    </div>
  );
}
