import { Icon } from '@/components/ui/Icon';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { lookFor } from './fileIcons';
import { flattenTree, nodeKey, type TreeRow } from './treeRows';

export function RootTree() {
  const roots = useRootsStore((s) => s.roots);
  const expanded = useRootsStore((s) => s.expanded);
  const children = useRootsStore((s) => s.children);
  const open = useRootsStore((s) => s.open);
  const toggle = useRootsStore((s) => s.toggle);
  const openFile = useRootsStore((s) => s.openFile);
  const showIgnored = useUiStore((s) => s.workspaceShowIgnored);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);

  const rows = flattenTree(roots, expanded, children, showIgnored);

  const activate = (row: TreeRow): void => {
    if (row.isDir) void toggle(row.rootId, row.path);
    else openFile(row.rootId, row.path);
  };

  /**
   * A root whose directory has vanished probes to no capabilities at all (see
   * `roots::probe` — a missing path yields the default). Rendering it as a
   * persistent node is the deliberate exception to the toast invariant: a repo
   * that silently disappears from the list is worse than an error.
   */
  const unavailable = (row: TreeRow): boolean => {
    if (!row.isRoot) return false;
    const root = roots.find((r) => r.id === row.rootId);
    return root !== undefined && !root.caps.writable && !root.caps.git;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="root-tree">
      {/* `rows` is already the flat, indexable shape a windowing library
          consumes, so swapping this <ul> for one is a local change if a
          directory ever gets big enough to need it. */}
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pb-2">
        {rows.map((row) => {
          const isOpen = expanded[nodeKey(row.rootId, row.path)] === true;
          const look = lookFor(row.label, row.isDir, { expanded: isOpen, plain: !fileIcons });
          const active =
            !row.isDir && open !== null && open.rootId === row.rootId && open.path === row.path;
          return (
            <li key={row.key}>
              <button
                type="button"
                data-testid="tree-row"
                data-path={row.path}
                data-root={row.rootId}
                data-active={active}
                onClick={() => activate(row)}
                style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
                className={`flex w-full min-w-0 items-center gap-1 border-0 py-[3px] pr-2 text-left text-[13px] ${
                  active ? 'bg-n-100 text-n-900' : 'bg-transparent hover:bg-n-50'
                } ${row.ignored ? 'opacity-50' : ''} ${row.isRoot ? 'font-semibold' : ''}`}
              >
                {/* Directories keep a caret AS WELL as their glyph: the caret
                    says "this opens", the glyph says "this is a scripts
                    folder". Collapsing them into one loses the affordance. */}
                <span className="flex-none">
                  {row.isDir ? (
                    <Icon
                      name={isOpen ? 'chevron-down' : 'chevron-right'}
                      size={12}
                      color="var(--n-400)"
                    />
                  ) : (
                    <span className="inline-block w-3" />
                  )}
                </span>
                <Icon name={look.icon} size={14} color={look.color ?? 'var(--n-500)'} />
                <span className="min-w-0 truncate text-n-700">{row.label}</span>
                {unavailable(row) && (
                  <span
                    data-testid="root-unavailable"
                    className="ml-auto flex-none rounded-sm bg-n-100 px-1 text-2xs text-n-500"
                  >
                    unavailable
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
