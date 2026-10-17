import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PageNavigationContent,
  usePageNavigationControls,
  usePageNavigationSlot,
} from '@/app/PageNavigation';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { Selection } from '@/engine/types';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { EditorGroups } from '@/workspace/EditorGroups';
import { RootMountDialog } from '@/workspace/RootMountDialog';
import { RootTree } from '@/workspace/RootTree';
import { useWorkspaceKeys } from '@/workspace/useWorkspaceKeys';
import '@/workspace/workspace.css';

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
      role="menuitemcheckbox"
      aria-checked={checked}
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
 * reading surface split into as many panes as you ask for. Nothing on this
 * surface writes to a mounted folder.
 *
 * The active pane lends this same Explorer to the contextual sidebar (M79).
 * Standalone and inactive panes retain their local tree; the root store and
 * keyboard owner remain this page in either presentation.
 */
export function WorkspacePage({ selection }: { selection: Selection }) {
  const navigationTarget = usePageNavigationSlot('workspace');
  const navigation = usePageNavigationControls('workspace');
  const roots = useRootsStore((s) => s.roots);
  const rootsLoaded = useRootsStore((s) => s.rootsLoaded);
  const loadRoots = useRootsStore((s) => s.loadRoots);
  const openFile = useRootsStore((s) => s.openFile);
  const fileIcons = useUiStore((s) => s.workspaceFileIcons);
  const setFileIcons = useUiStore((s) => s.setWorkspaceFileIcons);
  const showIgnored = useUiStore((s) => s.workspaceShowIgnored);
  const setShowIgnored = useUiStore((s) => s.setWorkspaceShowIgnored);
  const lineNumbers = useUiStore((s) => s.workspaceLineNumbers);
  const setLineNumbers = useUiStore((s) => s.setWorkspaceLineNumbers);
  const wordWrap = useUiStore((s) => s.workspaceWordWrap);
  const setWordWrap = useUiStore((s) => s.setWorkspaceWordWrap);
  const [mounting, setMounting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The shortcuts belong to this surface, so they are bound while it is on
  // screen and released when it is not — a global binding would close a
  // workspace tab from inside the vault editor.
  useWorkspaceKeys(true);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  // The selection is the source of truth for what is open, so Back works.
  useEffect(() => {
    if (selection.kind !== 'workspace') return;
    const { root, path } = selection;
    if (root !== undefined && path !== undefined) openFile(root, path);
  }, [selection, openFile]);

  const explorer = (
    <aside
      className={`workspace-explorer${navigationTarget ? ' workspace-explorer-context' : ''}`}
      aria-label="File explorer"
    >
      <div className="workspace-explorer-heading">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
          Explorer
        </span>
        <button
          type="button"
          data-testid="workspace-settings"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          className="ml-auto border-0 bg-transparent p-0.5 text-n-500 hover:text-n-800"
          aria-label="Explorer settings"
        >
          <Icon name="ellipsis" size={14} />
        </button>
        <button
          type="button"
          data-testid="mount-root"
          onClick={() => {
            navigation?.hide();
            setMounting(true);
          }}
          className="border-0 bg-transparent p-0.5 text-n-500 hover:text-n-800"
          aria-label="Mount a folder"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {settingsOpen && (
        <div
          data-testid="workspace-settings-menu"
          role="menu"
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
          <ToggleRow
            testId="toggle-line-numbers"
            label="Line numbers"
            checked={lineNumbers}
            onChange={setLineNumbers}
          />
          <ToggleRow
            testId="toggle-word-wrap"
            label="Wrap long lines"
            checked={wordWrap}
            onChange={setWordWrap}
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
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="workspace-page">
      {navigationTarget
        ? createPortal(<PageNavigationContent>{explorer}</PageNavigationContent>, navigationTarget)
        : explorer}
      {mounting && <RootMountDialog onClose={() => setMounting(false)} />}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {navigation && (
          <div className="workspace-heading">
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => navigation.show(event.currentTarget)}
            >
              <Icon name="panel-left" size={14} />
              Files
            </Button>
            <span className="workspace-heading-divider" />
            <h1>Work</h1>
            {rootsLoaded && (
              <span className="workspace-heading-meta">
                {roots.length} {roots.length === 1 ? 'folder' : 'folders'}
              </span>
            )}
          </div>
        )}
        <EditorGroups />
      </main>
    </div>
  );
}
