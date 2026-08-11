import { useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Icon } from '@/components/ui/Icon';
import { MAX_GROUPS, sameTab, tabKey, type EditorGroup, type OpenTab } from '@/engine/editorGroups';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { lookFor } from './fileIcons';
import { beginTabDrag, currentTabDrag, dropSlot, endTabDrag } from './tabDrag';

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * One group's tab strip (M30.24).
 *
 * Tabs are keyed by root AND path: two repositories may both hold a README.md,
 * and they are not the same document. The strip shows the basename, because
 * that is what a tab is for — the full path lives on the title attribute and
 * in the breadcrumb underneath.
 *
 * Every affordance an editor's strip is expected to have is here, because a
 * strip that only clicks is one people stop trusting: middle-click closes,
 * right-click opens the close/split menu, and a tab can be dragged to a new
 * position or into another pane.
 */
export function TabBar({ group, focused }: { group: EditorGroup; focused: boolean }) {
  const roots = useRootsStore((s) => s.roots);
  const groupCount = useRootsStore((s) => s.layout.groups.length);
  const openFile = useRootsStore((s) => s.openFile);
  const closeTab = useRootsStore((s) => s.closeTab);
  const closeOtherTabs = useRootsStore((s) => s.closeOtherTabs);
  const closeGroup = useRootsStore((s) => s.closeGroup);
  const splitEditor = useRootsStore((s) => s.splitEditor);
  const moveTab = useRootsStore((s) => s.moveTab);
  const reveal = useRootsStore((s) => s.reveal);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);
  const toast = useUiStore((s) => s.toast);

  const [menu, setMenu] = useState<{ x: number; y: number; tab: OpenTab } | null>(null);
  /** The slot an in-flight drop would land in, for the insertion line. */
  const [slot, setSlot] = useState<number | null>(null);

  const rootLabel = (id: string): string => roots.find((r) => r.id === id)?.label ?? id;

  const accept = (at: number): void => {
    const drag = currentTabDrag();
    setSlot(null);
    if (drag === null) return;
    // A slot past the tab's own position counts that tab, which is about to be
    // removed, so the destination index is one less.
    const from = group.tabs.findIndex((t) => sameTab(t, drag.tab));
    const index = drag.fromGroupId === group.id && from !== -1 && at > from ? at - 1 : at;
    moveTab(drag.tab, drag.fromGroupId, group.id, index);
    endTabDrag();
  };

  const menuItems = (tab: OpenTab): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { icon: 'x', label: 'Close', onSelect: () => closeTab(tab, group.id) },
      { icon: 'list-x', label: 'Close others', onSelect: () => closeOtherTabs(tab, group.id) },
    ];
    if (groupCount < MAX_GROUPS) {
      items.push({
        icon: 'columns-2',
        label: 'Split right',
        onSelect: () => splitEditor(tab, group.id),
      });
    }
    items.push(
      {
        icon: 'crosshair',
        label: 'Reveal in explorer',
        onSelect: () => void reveal(tab.rootId, tab.path),
      },
      {
        icon: 'copy',
        label: 'Copy path',
        onSelect: () => {
          // Fire and forget: a clipboard the OS refused is worth a toast, not
          // a thrown error in a menu handler.
          void navigator.clipboard
            ?.writeText(tab.path)
            .then(() => toast('Path copied'))
            .catch(() => toast('Could not copy the path'));
        },
      },
    );
    if (groupCount > 1) {
      items.push({
        icon: 'panel-right-close',
        label: 'Close this pane',
        danger: true,
        onSelect: () => closeGroup(group.id),
      });
    }
    return items;
  };

  return (
    <div
      data-testid="tab-bar"
      data-group={group.id}
      role="tablist"
      aria-label={`Open files${focused ? ' (focused pane)' : ''}`}
      className="flex flex-none items-stretch border-b border-n-100 bg-n-25"
      onDragOver={(e) => {
        // The strip's own dead space drops at the end. Stopped here rather
        // than left to bubble: over a tab strip the answer is "insert into
        // this strip", never "split the pane below it".
        if (currentTabDrag() === null) return;
        e.preventDefault();
        e.stopPropagation();
        setSlot(group.tabs.length);
      }}
      onDragLeave={() => setSlot(null)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        accept(group.tabs.length);
      }}
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {group.tabs.map((tab, index) => {
          const active = group.active !== null && sameTab(group.active, tab);
          const look = lookFor(basename(tab.path), false, { plain: !fileIcons });
          return (
            <div
              key={tabKey(tab)}
              data-testid="tab"
              data-path={tab.path}
              data-active={active}
              draggable
              onDragStart={(e) => {
                beginTabDrag({ tab, fromGroupId: group.id });
                e.dataTransfer.effectAllowed = 'move';
                // So a tab dragged OUT of the app yields something useful.
                e.dataTransfer.setData('text/plain', tab.path);
              }}
              onDragEnd={endTabDrag}
              onDragOver={(e) => {
                if (currentTabDrag() === null) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                setSlot(dropSlot(index, e.clientX, e.currentTarget.getBoundingClientRect()));
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                accept(dropSlot(index, e.clientX, e.currentTarget.getBoundingClientRect()));
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, tab });
              }}
              onAuxClick={(e) => {
                // Middle-click closes, as in every browser and editor.
                if (e.button !== 1) return;
                e.preventDefault();
                closeTab(tab, group.id);
              }}
              style={
                slot === index
                  ? { boxShadow: 'inset 2px 0 0 var(--cortex-500)' }
                  : slot === group.tabs.length && index === group.tabs.length - 1
                    ? { boxShadow: 'inset -2px 0 0 var(--cortex-500)' }
                    : undefined
              }
              className={`group relative flex min-w-0 max-w-[220px] flex-none items-center gap-1.5 border-r border-n-100 pl-2.5 pr-1 ${
                active ? 'bg-n-0 text-n-900' : 'text-n-500 hover:bg-n-50'
              }`}
            >
              {/* The focused pane's active tab carries a top rule. With four
                  panes on screen the background tint alone does not say which
                  one the keyboard is pointed at. */}
              {active && focused && (
                <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-cortex-500" />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={`${rootLabel(tab.rootId)} · ${tab.path}`}
                onClick={() => openFile(tab.rootId, tab.path, group.id)}
                onDoubleClick={() => void reveal(tab.rootId, tab.path)}
                className="flex min-w-0 items-center gap-1.5 border-0 bg-transparent py-1.5 text-left text-xs"
              >
                <Icon name={look.icon} size={13} color={look.color ?? 'var(--n-500)'} />
                <span className="min-w-0 truncate">{basename(tab.path)}</span>
              </button>
              <button
                type="button"
                data-testid="tab-close"
                aria-label={`Close ${basename(tab.path)}`}
                onClick={() => closeTab(tab, group.id)}
                // Always present for the focused tab; on hover for the rest, so
                // a full strip is not a row of close buttons competing with
                // names.
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
      {group.active !== null && groupCount < MAX_GROUPS && (
        <button
          type="button"
          data-testid="split-editor"
          aria-label="Split editor right"
          title="Split editor right"
          onClick={() => splitEditor(group.active ?? undefined, group.id)}
          className="flex-none border-0 border-l border-n-100 bg-transparent px-2 text-n-400 hover:text-n-800"
        >
          <Icon name="columns-2" size={14} />
        </button>
      )}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.tab)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
