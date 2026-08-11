import { Icon } from '@/components/ui/Icon';
import type { OpenTab } from '@/engine/editorGroups';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { lookFor } from './fileIcons';

/**
 * Where the open file lives (M30.24).
 *
 * A tab shows a basename, which is all a tab has room for and not enough to
 * tell two `mod.rs` apart. The breadcrumb is where the rest of the answer goes,
 * and each directory in it is a way back into the tree — clicking one expands
 * it and scrolls the explorer there, which is the only navigation a viewer can
 * honestly offer for a folder it cannot open in a pane.
 */
export function Breadcrumb({ tab }: { tab: OpenTab }) {
  const roots = useRootsStore((s) => s.roots);
  const reveal = useRootsStore((s) => s.reveal);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);

  const rootLabel = roots.find((r) => r.id === tab.rootId)?.label ?? tab.rootId;
  const segments = tab.path.split('/');
  const filename = segments[segments.length - 1] ?? tab.path;
  const dirs = segments.slice(0, -1);
  const look = lookFor(filename, false, { plain: !fileIcons });

  /** The path of the nth directory segment, root-relative. */
  const dirPath = (n: number): string => dirs.slice(0, n + 1).join('/');

  return (
    <nav
      data-testid="breadcrumb"
      data-path={tab.path}
      aria-label="File location"
      className="flex flex-none items-center gap-1 overflow-x-auto border-b border-n-100 px-3 py-1 text-2xs text-n-500"
    >
      <button
        type="button"
        data-testid="crumb-root"
        onClick={() => void reveal(tab.rootId, '')}
        className="flex-none border-0 bg-transparent p-0 text-2xs text-n-500 hover:text-n-800"
      >
        {rootLabel}
      </button>
      {dirs.map((segment, i) => (
        <span key={dirPath(i)} className="flex flex-none items-center gap-1">
          <Icon name="chevron-right" size={11} color="var(--n-300)" />
          <button
            type="button"
            data-testid="crumb-dir"
            // Reveal takes a FILE path and expands everything above it, so a
            // directory is revealed by naming something notional inside it.
            onClick={() => void reveal(tab.rootId, `${dirPath(i)}/.`)}
            className="border-0 bg-transparent p-0 text-2xs text-n-500 hover:text-n-800"
          >
            {segment}
          </button>
        </span>
      ))}
      <Icon name="chevron-right" size={11} color="var(--n-300)" />
      <span className="flex flex-none items-center gap-1 text-n-700">
        <Icon name={look.icon} size={12} color={look.color ?? 'var(--n-500)'} />
        {filename}
      </span>
    </nav>
  );
}
