import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { CreateMenu } from '@/app/CreateMenu';
import { DemoBadge } from '@/app/DemoBadge';
import { useUiStore } from '@/stores/uiStore';

export function Topbar() {
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);

  return (
    <div className="relative z-[5] flex h-16 flex-none items-center gap-3 border-b border-[var(--n-200)] bg-[var(--n-0)] px-4">
      <span className="text-[16px] font-bold tracking-[-0.02em]">
        cerebro<span className="text-[var(--synapse-500)]">.</span>
      </span>
      <DemoBadge />
      <div className="flex flex-1 justify-center">
        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          className="flex h-9 w-[480px] items-center gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-25)] px-3 text-[13px] text-[var(--n-400)] hover:border-[var(--n-300)]"
        >
          <Icon name="search" size={15} />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="rounded-[5px] border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 text-[11px] text-[var(--n-500)] [font-family:var(--font-mono)]">
            ⌘K
          </kbd>
        </button>
      </div>
      <CreateMenu />
      <Avatar name="You" size={28} />
    </div>
  );
}
