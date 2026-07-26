import { useMemo } from 'react';
import { FileTree } from '@/components/FileTree';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

export interface SidebarProps {
  /** Opens the New-project dialog (v2: projects are the top level). */
  onNewProject: () => void;
}

const SECTION_LABEL =
  'px-2 pb-1 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]';

function rowClass(active: boolean): string {
  return [
    'flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 px-2 text-left text-[13px]',
    active
      ? 'bg-[var(--n-100)] font-medium text-[var(--n-900)]'
      : 'bg-transparent font-normal text-[var(--n-700)] hover:bg-[var(--n-100)]',
  ].join(' ');
}

export function Sidebar({ onNewProject }: SidebarProps) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();

  // Task 14: on the Docs surfaces the sidebar is a Drive-style file
  // navigator — folders and files, click to open, right-click to manage.
  const docsMode = selection.kind === 'docs' || selection.kind === 'doc';

  // Vault format v2: projects are the top-level group — no spaces.
  const projects = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Project')
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries],
  );

  const sortedViews = useMemo(
    () =>
      views
        // Project-scoped views render as tabs on their project page (Task 8),
        // not in the sidebar — only vault-global views list here.
        .filter((v) => v.project === null)
        .sort(
          (a, b) =>
            (a.definition.order ?? 0) - (b.definition.order ?? 0) ||
            a.definition.name.localeCompare(b.definition.name),
        ),
    [views],
  );

  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[264px] flex-none flex-col overflow-hidden border-r border-[var(--n-200)] bg-[var(--surface-sunken)]"
    >
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        <h1 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">
          {docsMode ? 'Docs' : 'Workspace'}
        </h1>
      </div>
      {docsMode ? (
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <div className={SECTION_LABEL}>Files</div>
          <FileTree root="" onOpen={openPath} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div className={SECTION_LABEL}>Projects</div>
        {projects.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--n-400)]">No projects yet</div>
        ) : null}
        {projects.map((project) => {
          const projectActive = selection.kind === 'project' && selection.path === project.path;
          return (
            <button
              key={project.path}
              type="button"
              data-testid="sidebar-project"
              onClick={() => navigate({ kind: 'project', path: project.path })}
              className={rowClass(projectActive)}
            >
              <Icon name="folder-kanban" size={15} color="var(--n-500)" />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {project.title}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onNewProject}
          className="flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 bg-transparent px-2 text-left text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
        >
          <Icon name="plus" size={13} />
          New project
        </button>
        <div className={SECTION_LABEL}>Views</div>
        {sortedViews.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--n-400)]">No saved views</div>
        ) : null}
        {sortedViews.map((view) => {
          const viewActive = selection.kind === 'view' && selection.id === view.id;
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => navigate({ kind: 'view', id: view.id })}
              className={rowClass(viewActive)}
            >
              <Icon name={view.definition.icon ?? 'layout-list'} size={15} color="var(--n-500)" />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {view.definition.name}
              </span>
            </button>
          );
        })}
      </div>
      )}
    </nav>
  );
}
