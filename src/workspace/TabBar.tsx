import { Icon } from '@/components/ui/Icon';
import { useRootsStore, sameTab, type OpenTab } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { lookFor } from './fileIcons';

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * Open files as tabs (M30.23).
 *
 * Tabs are keyed by root AND path: two repositories may both hold a README.md,
 * and they are not the same document. The strip shows the basename, because
 * that is what a tab is for — the full path stays on the title attribute for
 * when two basenames collide.
 */
export function TabBar() {
  const tabs = useRootsStore((s) => s.tabs);
  const open = useRootsStore((s) => s.open);
  const roots = useRootsStore((s) => s.roots);
  const openFile = useRootsStore((s) => s.openFile);
  const closeTab = useRootsStore((s) => s.closeTab);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);

  if (tabs.length === 0) return null;

  const rootLabel = (id: string): string => roots.find((r) => r.id === id)?.label ?? id;

  return (
    <div
      data-testid="tab-bar"
      role="tablist"
      className="flex flex-none items-stretch overflow-x-auto border-b border-n-100 bg-n-25"
    >
      {tabs.map((tab: OpenTab) => {
        const active = open !== null && sameTab(open, tab);
        const look = lookFor(basename(tab.path), false, { plain: !fileIcons });
        return (
          <div
            key={`${tab.rootId}/${tab.path}`}
            data-testid="tab"
            data-path={tab.path}
            data-active={active}
            className={`group flex min-w-0 max-w-[220px] flex-none items-center gap-1.5 border-r border-n-100 pl-2.5 pr-1 ${
              active ? 'bg-n-0 text-n-900' : 'text-n-500 hover:bg-n-50'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={`${rootLabel(tab.rootId)} · ${tab.path}`}
              onClick={() => openFile(tab.rootId, tab.path)}
              className="flex min-w-0 items-center gap-1.5 border-0 bg-transparent py-1.5 text-left text-xs"
            >
              <Icon name={look.icon} size={13} color={look.color ?? 'var(--n-500)'} />
              <span className="min-w-0 truncate">{basename(tab.path)}</span>
            </button>
            <button
              type="button"
              data-testid="tab-close"
              aria-label={`Close ${basename(tab.path)}`}
              onClick={() => closeTab(tab)}
              // Always present for the focused tab; on hover for the rest, so a
              // full strip is not a row of close buttons competing with names.
              className={`flex-none rounded-sm p-0.5 text-n-400 hover:bg-n-100 hover:text-n-800 ${
                active ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
