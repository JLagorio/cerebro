import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { Selection } from '@/engine/types';
import { useRootsStore } from '@/stores/rootsStore';
import { DocsTab } from '@/workspace/DocsTab';
import { FileViewer } from '@/workspace/FileViewer';
import { RootMountDialog } from '@/workspace/RootMountDialog';
import { RootTree } from '@/workspace/RootTree';

const TABS = ['files', 'docs'] as const;
type Tab = (typeof TABS)[number];

/**
 * The multi-root workspace (M30): mounted repositories, their file tree, and a
 * reading surface. Nothing on this surface writes to a mounted folder.
 */
export function WorkspacePage({ selection }: { selection: Selection }) {
  const roots = useRootsStore((s) => s.roots);
  const loadRoots = useRootsStore((s) => s.loadRoots);
  const open = useRootsStore((s) => s.open);
  const openFile = useRootsStore((s) => s.openFile);
  const [mounting, setMounting] = useState(false);
  const [tab, setTab] = useState<Tab>('files');

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  // The selection is the source of truth for what is open, so Back works.
  useEffect(() => {
    if (selection.kind !== 'workspace') return;
    const { root, path } = selection;
    if (root !== undefined && path !== undefined) openFile(root, path);
  }, [selection, openFile]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="workspace-page">
      <aside className="flex w-64 flex-none flex-col border-r border-n-100">
        <div className="flex flex-none items-center gap-2 px-3 pb-2 pt-3.5">
          <Icon name="folder-tree" size={16} color="var(--n-600)" />
          <h1 className="m-0 text-sm font-semibold">Workspace</h1>
          <button
            type="button"
            data-testid="mount-root"
            onClick={() => setMounting(true)}
            className="ml-auto border-0 bg-transparent p-0.5 text-n-500 hover:text-n-800"
            aria-label="Mount a folder"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {roots.length === 0 ? (
            <div data-testid="workspace-empty" className="px-3 py-4">
              <EmptyState
                compact
                icon="folder-plus"
                title="No folders yet"
                description="Mount a repository to browse its files and docs."
              />
            </div>
          ) : (
            <RootTree />
          )}
        </div>
      </aside>
      {mounting && <RootMountDialog onClose={() => setMounting(false)} />}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-none gap-1 border-b border-n-100 px-4 pt-2">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              data-testid={`workspace-tab-${name}`}
              onClick={() => setTab(name)}
              className={`border-0 border-b-2 bg-transparent px-2 pb-1.5 text-sm capitalize ${
                tab === name ? 'border-n-800 text-n-900' : 'border-transparent text-n-500'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        {tab === 'docs' ? (
          <DocsTab />
        ) : open === null ? (
          <EmptyState
            icon="file-text"
            title="Nothing open"
            description="Pick a file from the tree."
          />
        ) : (
          <FileViewer rootId={open.rootId} path={open.path} />
        )}
      </main>
    </div>
  );
}
