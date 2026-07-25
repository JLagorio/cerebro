import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { swatchColor } from '@/lib/swatch';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

export interface SidebarProps {
  /** Opens CreateMenu prefilled with the space (wired in Task 23). */
  onNewProject: (spacePath: string) => void;
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const spaces = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Space')
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries],
  );

  const projectsBySpace = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const project of entries.filter((e) => e.type === 'Project')) {
      const target = project.relationships.space?.[0];
      const projectSpace = target ? resolveTarget(target, entries) : null;
      if (!projectSpace) continue;
      const list = map.get(projectSpace.path) ?? [];
      list.push(project);
      map.set(projectSpace.path, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return map;
  }, [entries]);

  const sortedViews = useMemo(
    () =>
      [...views].sort(
        (a, b) =>
          (a.definition.order ?? 0) - (b.definition.order ?? 0) ||
          a.definition.name.localeCompare(b.definition.name),
      ),
    [views],
  );

  const toggle = (path: string) => setCollapsed((c) => ({ ...c, [path]: !c[path] }));

  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[264px] flex-none flex-col overflow-hidden border-r border-[var(--n-200)] bg-[var(--surface-sunken)]"
    >
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        <h1 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">Workspace</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div className={SECTION_LABEL}>Spaces</div>
        {spaces.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--n-400)]">No spaces yet</div>
        ) : null}
        {spaces.map((space) => {
          const isCollapsed = collapsed[space.path] ?? false;
          const spaceActive = selection.kind === 'space' && selection.path === space.path;
          const spaceProjects = projectsBySpace.get(space.path) ?? [];
          return (
            <div key={space.path}>
              <button
                type="button"
                data-testid="sidebar-space"
                onClick={() => navigate({ kind: 'space', path: space.path })}
                className={rowClass(spaceActive)}
              >
                <span
                  role="button"
                  aria-label={`Toggle ${space.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(space.path);
                  }}
                  className="inline-flex flex-none text-[var(--n-400)] transition-transform duration-[120ms]"
                  style={{ transform: `rotate(${isCollapsed ? 0 : 90}deg)` }}
                >
                  <Icon name="chevron-right" size={13} />
                </span>
                <span
                  className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] text-[10px] font-bold text-white"
                  style={{ background: swatchColor(space.properties.color) }}
                >
                  {space.title.charAt(0).toUpperCase()}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {space.title}
                </span>
              </button>
              {!isCollapsed
                ? spaceProjects.map((project) => {
                    const projectActive =
                      selection.kind === 'project' && selection.path === project.path;
                    return (
                      <button
                        key={project.path}
                        type="button"
                        data-testid="sidebar-project"
                        onClick={() => navigate({ kind: 'project', path: project.path })}
                        className={`${rowClass(projectActive)} pl-[26px]`}
                      >
                        <Icon name="folder-kanban" size={15} color="var(--n-500)" />
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                          {project.title}
                        </span>
                      </button>
                    );
                  })
                : null}
              {!isCollapsed ? (
                <button
                  type="button"
                  onClick={() => onNewProject(space.path)}
                  className="flex h-[30px] w-full items-center gap-[7px] rounded-md border-0 bg-transparent pl-[26px] pr-2 text-left text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
                >
                  <Icon name="plus" size={13} />
                  New project
                </button>
              ) : null}
            </div>
          );
        })}
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
    </nav>
  );
}
