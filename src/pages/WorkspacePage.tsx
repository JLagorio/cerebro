import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { Selection } from '@/engine/types';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { DocsTab } from '@/workspace/DocsTab';
import { FileViewer } from '@/workspace/FileViewer';
import { RootMountDialog } from '@/workspace/RootMountDialog';
import { RootTree } from '@/workspace/RootTree';
import { TabBar } from '@/workspace/TabBar';
import '@/workspace/workspace.css';

const TABS = ['files', 'docs'] as const;
type Tab = (typeof TABS)[number];

/** One switch in the explorer's settings popover. */
function ToggleRow({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-xs text-n-700 hover:bg-n-50"
    >
      <Icon name={checked ? 'square-check' : 'square'} size={13} color="var(--n-500)" />
      {label}
    </button>
  );
}

/**
 * The multi-root workspace (M30): mounted repositories, their file tree, and a
 * reading surface. Nothing on this surface writes to a mounted folder.
 *
 * The vault sidebar is suppressed here (see `SIDEBARLESS` in Sidebar.tsx) —
 * this surface brings its own tree, and Collections + Types say nothing about
 * a mounted repository.
 */
export function WorkspacePage({ selection }: { selection: Selection }) {
  const roots = useRootsStore((s) => s.roots);
  const loadRoots = useRootsStore((s) => s.loadRoots);
  const open = useRootsStore((s) => s.open);
  const openFile = useRootsStore((s) => s.openFile);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);
  const setFileIcons = useUiStore((s) => s.setWorkspaceFileIcons);
  const showIgnored = useUiStore((s) => s.workspaceShowIgnored);
  const setShowIgnored = useUiStore((s) => s.setWorkspaceShowIgnored);
  const [mounting, setMounting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      <aside className="flex w-60 flex-none flex-col border-r border-n-100 bg-n-25">
        <div className="flex flex-none items-center gap-1.5 px-3 pb-1.5 pt-3">
          <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            Explorer
          </span>
          <button
            type="button"
            data-testid="workspace-settings"
            onClick={() => setSettingsOpen((v) => !v)}
            className="ml-auto border-0 bg-transparent p-0.5 text-n-500 hover:text-n-800"
            aria-label="Explorer settings"
          >
            <Icon name="ellipsis" size={14} />
          </button>
          <button
            type="button"
            data-testid="mount-root"
            onClick={() => setMounting(true)}
            className="border-0 bg-transparent p-0.5 text-n-500 hover:text-n-800"
            aria-label="Mount a folder"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {settingsOpen && (
          <div
            data-testid="workspace-settings-menu"
            className="mx-2 mb-1 rounded-md border border-n-200 bg-n-0 py-1 shadow-sm"
          >
            <ToggleRow
              testId="toggle-file-icons"
              label="File type icons"
              checked={fileIcons}
              onChange={setFileIcons}
            />
            <ToggleRow
              testId="toggle-ignored"
              label="Show ignored files"
              checked={showIgnored}
              onChange={setShowIgnored}
            />
          </div>
        )}
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
        ) : (
          <>
            <TabBar />
            {open === null ? (
              <EmptyState
                icon="file-text"
                title="Nothing open"
                description="Pick a file from the tree."
              />
            ) : (
              <FileViewer rootId={open.rootId} path={open.path} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
