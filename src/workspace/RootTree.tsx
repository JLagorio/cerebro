import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { gitBadgeText } from '@/engine/roots';
import { selectActiveTab, useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { lookFor } from './fileIcons';
import { flattenTree, nodeKey, type TreeRow } from './treeRows';

/**
 * The explorer (M30.24).
 *
 * A real `role="tree"`, not a list of buttons: an explorer you can only reach
 * with a pointer is an explorer half the people using it cannot reach at all.
 * Focus is ROVING — exactly one row is tabbable, and the arrows move it — which
 * is the pattern the ARIA tree spec requires and the one that keeps Tab moving
 * PAST the tree instead of through four hundred files.
 */
export function RootTree() {
  const roots = useRootsStore((s) => s.roots);
  const expanded = useRootsStore((s) => s.expanded);
  const children = useRootsStore((s) => s.children);
  const open = useRootsStore(selectActiveTab);
  const toggle = useRootsStore((s) => s.toggle);
  const openFile = useRootsStore((s) => s.openFile);
  const revealSeq = useRootsStore((s) => s.revealSeq);
  const revealing = useRootsStore((s) => s.revealing);
  const showIgnored = useUiStore((s) => s.workspaceShowIgnored);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);
  const gitStatus = useRootsStore((s) => s.gitStatus);
  const gitDirty = useRootsStore((s) => s.gitDirty);
  const loadGitStatus = useRootsStore((s) => s.loadGitStatus);

  /**
   * key → its row element. A map rather than a query, because a path is not a
   * safe CSS selector — `CSS.escape` exists to make one, and does not exist in
   * jsdom at all. Holding the node is simpler than escaping a name to go and
   * look for it.
   */
  const rowRefs = useRef(new Map<string, HTMLElement>());
  /** The row the roving tabindex currently sits on. */
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const rows = flattenTree(roots, expanded, children, showIgnored);

  // Reveal scrolls the row into view. Keyed on the COUNTER rather than the
  // path, so revealing the same file twice scrolls twice.
  useEffect(() => {
    if (revealSeq === 0 || revealing === null) return;
    rowRefs.current
      .get(nodeKey(revealing.rootId, revealing.path))
      ?.scrollIntoView({ block: 'nearest' });
  }, [revealSeq, revealing]);

  const activate = (row: TreeRow): void => {
    if (row.isDir) void toggle(row.rootId, row.path);
    else openFile(row.rootId, row.path);
  };

  /** Move the roving focus to a row and put the DOM focus there with it. */
  const focusRow = (row: TreeRow | undefined): void => {
    if (row === undefined) return;
    setFocusKey(row.key);
    rowRefs.current.get(row.key)?.focus();
  };

  const onKeyDown = (row: TreeRow, index: number) => (e: React.KeyboardEvent) => {
    const isOpen = expanded[nodeKey(row.rootId, row.path)] === true;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(rows[index + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(rows[index - 1]);
        break;
      case 'ArrowRight':
        e.preventDefault();
        // Closed directory opens; open directory steps into its first child.
        if (row.isDir && !isOpen) void toggle(row.rootId, row.path);
        else if (row.isDir) focusRow(rows[index + 1]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.isDir && isOpen) {
          void toggle(row.rootId, row.path);
        } else {
          // Otherwise climb: the nearest row above that sits one level out.
          for (let i = index - 1; i >= 0; i -= 1) {
            const above = rows[i];
            if (above !== undefined && above.depth < row.depth) {
              focusRow(above);
              break;
            }
          }
        }
        break;
      case 'Home':
        e.preventDefault();
        focusRow(rows[0]);
        break;
      case 'End':
        e.preventDefault();
        focusRow(rows[rows.length - 1]);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(row);
        break;
    }
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

  /**
   * Read git status once per git-capable root (M32.9). A refusal is stored by
   * the store as a value, so a root that turns out not to be a repo simply
   * never gets a badge — it does not retry, and it does not toast.
   */
  useEffect(() => {
    // Read what is already loaded from the store rather than closing over it:
    // this effect WRITES gitStatus, so depending on it would re-run the effect
    // with every status that lands. Reading it fresh here needs no suppression
    // and cannot go stale.
    const loaded = useRootsStore.getState().gitStatus;
    for (const root of roots) {
      if (root.caps.git && loaded[root.id] === undefined) void loadGitStatus(root.id);
    }
  }, [roots, loadGitStatus]);

  /**
   * The badge for a root row, or null when it should stay silent. An
   * unavailable root gets the "unavailable" rendering and never a git badge —
   * the two are mutually exclusive by construction, since `unavailable`
   * requires `!caps.git` and a status only exists for a root that had it.
   */
  const gitBadge = (row: TreeRow): string | null => {
    if (!row.isRoot) return null;
    const status = gitStatus[row.rootId];
    if (status === undefined) return null;
    return gitBadgeText({
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      dirty: gitDirty[row.rootId] ?? 0,
    });
  };

  // Exactly one row is tabbable. The remembered row when it still exists,
  // otherwise the open file, otherwise the first row — so Tab always lands
  // somewhere meaningful rather than on a row that scrolled out of the data.
  const tabbable =
    rows.find((r) => r.key === focusKey)?.key ??
    (open === null
      ? undefined
      : rows.find((r) => r.rootId === open.rootId && r.path === open.path)?.key) ??
    rows[0]?.key;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="root-tree">
      {/* `rows` is already the flat, indexable shape a windowing library
          consumes, so swapping this <ul> for one is a local change if a
          directory ever gets big enough to need it. */}
      <ul
        role="tree"
        aria-label="Mounted folders"
        className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pb-2"
      >
        {rows.map((row, index) => {
          const isOpen = expanded[nodeKey(row.rootId, row.path)] === true;
          const look = lookFor(row.label, row.isDir, { expanded: isOpen, plain: !fileIcons });
          const active =
            !row.isDir && open !== null && open.rootId === row.rootId && open.path === row.path;
          return (
            <li key={row.key} role="none">
              <button
                type="button"
                ref={(el) => {
                  if (el === null) rowRefs.current.delete(row.key);
                  else rowRefs.current.set(row.key, el);
                }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.isDir ? isOpen : undefined}
                aria-selected={active}
                tabIndex={row.key === tabbable ? 0 : -1}
                data-testid="tree-row"
                data-path={row.path}
                data-root={row.rootId}
                data-active={active}
                onClick={() => {
                  setFocusKey(row.key);
                  activate(row);
                }}
                onKeyDown={onKeyDown(row, index)}
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
                {gitBadge(row) !== null && (
                  <span
                    data-testid="root-git-badge"
                    className="ml-auto flex-none rounded-sm bg-n-100 px-1 font-normal text-2xs text-n-500"
                  >
                    {gitBadge(row)}
                  </span>
                )}
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
