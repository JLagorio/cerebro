import { useMemo, useState } from 'react';
import { FileTree } from '@/components/FileTree';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Icon } from '@/components/ui/Icon';
import {
  DeleteTypeDialog,
  NewTypeDialog,
  RenameTypeDialog,
  TypeStyleDialog,
} from '@/app/TypeDialogs';
import { useOpenPath } from '@/app/useOpenPath';
import { listTypes, typeStyle, type TypeListing } from '@/engine/typeCatalog';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

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
  ].join(' ')
}

type TypeDialog =
  | { mode: 'new' }
  | { mode: 'rename' | 'style' | 'delete'; listing: TypeListing };

export function Sidebar({ onNewProject }: SidebarProps) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const typesOpen = useUiStore((s) => s.typesOpen);
  const setTypesOpen = useUiStore((s) => s.setTypesOpen);
  const openPath = useOpenPath();

  const [typeDialog, setTypeDialog] = useState<TypeDialog | null>(null);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; listing: TypeListing } | null>(
    null,
  );

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

  // M3: every type the vault knows about — system, declared, and ghost.
  const types = useMemo(() => listTypes(entries, schema), [entries, schema]);

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

  const typeMenuItems = (listing: TypeListing): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // System types are locked at the system level (Salesforce-style):
    // restyle is fine, rename/delete are not.
    if (!listing.system) {
      items.push({
        icon: 'pencil',
        label: 'Change display name…',
        onSelect: () => setTypeDialog({ mode: 'rename', listing }),
      });
    }
    items.push({
      icon: 'palette',
      label: 'Customize icon & color…',
      onSelect: () => setTypeDialog({ mode: 'style', listing }),
    });
    if (!listing.system && listing.docPath !== null) {
      items.push({
        icon: 'trash-2',
        label: 'Delete type',
        danger: true,
        onSelect: () => setTypeDialog({ mode: 'delete', listing }),
      });
    }
    return items;
  };

  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[264px] flex-none flex-col overflow-hidden border-r border-[var(--n-200)] bg-[var(--n-0)]"
    >
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        <h1 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">
          {docsMode ? 'Docs' : 'Workspace'}
        </h1>
      </div>
      {docsMode ? (
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <div className={SECTION_LABEL}>Files</div>
          <FileTree
            root=""
            activePath={selection.kind === 'doc' ? selection.path : null}
            onOpen={openPath}
          />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div className={SECTION_LABEL}>Projects</div>
        {projects.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--n-400)]">No projects yet</div>
        ) : null}
        {projects.map((project) => {
          const projectActive = selection.kind === 'project' && selection.path === project.path;
          const style = typeStyle('Project', schema);
          return (
            <button
              key={project.path}
              type="button"
              data-testid="sidebar-project"
              onClick={() => navigate({ kind: 'project', path: project.path })}
              className={rowClass(projectActive)}
            >
              <Icon name={style.icon} size={15} color={style.color ?? 'var(--n-500)'} />
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
        {/* M3: collapsible Types section — sits above Views. */}
        <div className="flex items-center justify-between pr-1">
          <button
            type="button"
            aria-expanded={typesOpen}
            onClick={() => setTypesOpen(!typesOpen)}
            className={`${SECTION_LABEL} flex items-center gap-1 border-0 bg-transparent hover:text-[var(--n-700)]`}
          >
            <Icon name={typesOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            Types
          </button>
          <button
            type="button"
            aria-label="New type"
            onClick={() => setTypeDialog({ mode: 'new' })}
            className="mt-2 flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        {typesOpen &&
          types.map((t) => {
            const typeActive = selection.kind === 'type' && selection.name === t.name;
            return (
              <button
                key={t.name}
                type="button"
                data-testid="sidebar-type"
                onClick={() => navigate({ kind: 'type', name: t.name })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTypeMenu({ x: e.clientX, y: e.clientY, listing: t });
                }}
                className={rowClass(typeActive)}
              >
                <Icon name={t.icon} size={15} color={t.color ?? 'var(--n-500)'} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.name}</span>
                <span className="ml-auto [font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
                  {t.count}
                </span>
              </button>
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
      )}
      {typeMenu !== null && (
        <ContextMenu
          x={typeMenu.x}
          y={typeMenu.y}
          items={typeMenuItems(typeMenu.listing)}
          onClose={() => setTypeMenu(null)}
        />
      )}
      {typeDialog?.mode === 'new' && <NewTypeDialog onClose={() => setTypeDialog(null)} />}
      {typeDialog?.mode === 'rename' && (
        <RenameTypeDialog listing={typeDialog.listing} onClose={() => setTypeDialog(null)} />
      )}
      {typeDialog?.mode === 'style' && (
        <TypeStyleDialog listing={typeDialog.listing} onClose={() => setTypeDialog(null)} />
      )}
      {typeDialog?.mode === 'delete' && (
        <DeleteTypeDialog listing={typeDialog.listing} onClose={() => setTypeDialog(null)} />
      )}
    </nav>
  );
}
