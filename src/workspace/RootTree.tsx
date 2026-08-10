import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useRootsStore } from '@/stores/rootsStore';
import { flattenTree, nodeKey, type TreeRow } from './treeRows';

export function RootTree() {
  const roots = useRootsStore((s) => s.roots);
  const expanded = useRootsStore((s) => s.expanded);
  const children = useRootsStore((s) => s.children);
  const toggle = useRootsStore((s) => s.toggle);
  const openFile = useRootsStore((s) => s.openFile);
  const [showIgnored, setShowIgnored] = useState(false);

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
      <button
        type="button"
        data-testid="toggle-ignored"
        onClick={() => setShowIgnored((v) => !v)}
        className="flex-none border-0 bg-transparent px-3 py-1 text-left text-2xs text-n-500 hover:text-n-800"
      >
        {showIgnored ? 'Hide ignored' : 'Show ignored'}
      </button>
      {/* A plain list today. `rows` is already the flat, indexable shape a
          windowing library consumes, so swapping this <ul> for one is a local
          change if a directory ever gets big enough to need it (M30.14). */}
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              data-testid="tree-row"
              data-path={row.path}
              data-root={row.rootId}
              onClick={() => activate(row)}
              style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
              className={`flex w-full min-w-0 items-center gap-1.5 border-0 bg-transparent py-1 pr-2 text-left text-sm hover:bg-n-50 ${
                row.ignored ? 'text-n-400' : 'text-n-800'
              }`}
            >
              <Icon
                name={
                  row.isDir
                    ? expanded[nodeKey(row.rootId, row.path)] === true
                      ? 'chevron-down'
                      : 'chevron-right'
                    : 'file-text'
                }
                size={13}
                color="var(--n-500)"
              />
              <span className={`min-w-0 truncate ${row.isRoot ? 'font-semibold' : ''}`}>
                {row.label}
              </span>
              {unavailable(row) && (
                <span
                  data-testid="root-unavailable"
                  className="ml-auto flex-none rounded-sm bg-n-50 px-1 text-2xs text-n-500"
                >
                  unavailable
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
