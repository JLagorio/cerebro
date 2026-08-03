import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { CreateMenu } from '@/app/CreateMenu';
import { SyncBadge } from '@/git/SyncBadge';
import { useUiStore } from '@/stores/uiStore';

export function Topbar() {
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);

  return (
    <div className="relative z-[5] flex h-16 flex-none items-center gap-3 border-b border-n-200 bg-n-0 px-4">
      <span className="text-lg font-bold tracking-[-0.02em]">
        cerebro<span className="text-synapse-500">.</span>
      </span>
      <div className="flex flex-1 justify-center">
        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          className="flex h-9 w-[480px] items-center gap-2 rounded-lg border border-n-200 bg-n-25 px-3 text-sm text-n-400 hover:border-n-300"
        >
          <Icon name="search" size={15} />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="rounded-[5px] border border-n-200 bg-n-0 px-1.5 text-2xs text-n-500 [font-family:var(--font-mono)]">
            ⌘K
          </kbd>
        </button>
      </div>
      {/* M9.4: silent on a clean, remoteless vault — it appears only when
          it has something you can act on. */}
      <SyncBadge />
      <CreateMenu />
      <Avatar name="You" size={28} />
    </div>
  );
}
