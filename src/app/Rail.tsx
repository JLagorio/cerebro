import { Icon } from '@/components/ui/Icon';
import { useNavStore } from '@/stores/navStore';

function RailButton({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const tone = active
    ? 'bg-[var(--cortex-50)] text-[var(--cortex-600)]'
    : 'text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-11 flex-col items-center gap-[3px] rounded-lg border-0 bg-transparent pb-[5px] pt-1.5 text-[10px] font-medium ${tone}`}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  );
}

export function Rail() {
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const settingsActive = selection.kind === 'settings';

  return (
    <div className="flex w-14 flex-none flex-col items-center gap-1 border-r border-[var(--n-100)] bg-[var(--n-0)] py-3">
      <div className="mb-3 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-[var(--cortex-500)] text-[17px] font-bold tracking-[-0.02em] text-[var(--n-0)]">
        c.
      </div>
      <RailButton
        icon="house"
        label="Home"
        active={!settingsActive}
        onClick={() => navigate({ kind: 'home' })}
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
