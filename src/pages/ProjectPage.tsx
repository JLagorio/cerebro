import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { resolveCollection, sortEntries } from '@/engine/collections';
import type { Presentation, Selection, ViewFile } from '@/engine/types';
import { serializeView } from '@/engine/views';
import { saveView } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
import { slugifyViewId, ViewToolbar } from '@/views/ViewToolbar';

export type ProjectSelection = Extract<Selection, { kind: 'project' | 'view' }>;

const projectDir = (projectPath: string) => projectPath.replace(/\/project\.md$/, '');

const clonePresentation = (p: Presentation): Presentation => ({
  ...p,
  orderBy: { ...p.orderBy },
  visibleFields: [...p.visibleFields],
});

/** Underline tab from the design mock's saved-view tab row. */
function ViewTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 border-0 border-b-2 bg-transparent px-2 pb-2 pt-1 text-[13px]',
        active
          ? 'border-[var(--cortex-500)] font-semibold text-[var(--n-900)]'
          : 'border-transparent font-normal text-[var(--n-500)] hover:text-[var(--n-800)]',
      ].join(' ')}
      style={{ borderBottomStyle: 'solid' }}
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  );
}

export function ProjectPage({ selection }: { selection: ProjectSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);

  const collection = useMemo(
    () => resolveCollection(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  const project =
    selection.kind === 'project'
      ? entries.find((e) => e.path === selection.path) ?? null
      : null;

  // Task 8: saved-view tabs. null = the built-in "Items" tab (ephemeral
  // presentation); an id = that project-scoped view, whose edits auto-persist.
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const projectViews = useMemo<ViewFile[]>(
    () =>
      project === null
        ? []
        : views
            .filter((v) => v.project === project.path)
            .sort(
              (a, b) =>
                (a.definition.order ?? 0) - (b.definition.order ?? 0) ||
                a.definition.name.localeCompare(b.definition.name),
            ),
    [views, project],
  );

  // The view file behind the current canvas: a scoped tab on a project page,
  // or the global view file for a sidebar view selection. Null on Items.
  const activeView =
    selection.kind === 'view'
      ? views.find((v) => v.id === selection.id && v.project === null) ?? null
      : projectViews.find((v) => v.id === activeViewId) ?? null;

  // Local presentation state, re-initialized when the selection or tab changes.
  const selectionKey = selection.kind === 'project' ? selection.path : selection.id;
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  useEffect(() => {
    setActiveViewId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  useEffect(() => {
    setPresentation(
      activeView !== null && selection.kind === 'project'
        ? clonePresentation(activeView.definition.presentation)
        : collection.presentation,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, activeViewId]);

  // Deviation from the plan's verbatim body (reported): re-sort by the LIVE
  // orderBy so the toolbar's order select works — resolveCollection sorts by
  // the initial presentation only, and the views never re-sort.
  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.orderBy, schema),
    [collection.entries, presentation.orderBy, schema],
  );

  // Task 8: toolbar edits auto-persist to the active saved view's file
  // (project-scoped tab or global view). The Items tab stays ephemeral.
  const handlePresentationChange = (next: Presentation) => {
    setPresentation(next);
    if (activeView === null || vaultPath === null) return;
    const folder = activeView.project === null ? null : projectDir(activeView.project);
    const yaml = serializeView({ ...activeView.definition, presentation: next });
    void (async () => {
      try {
        await saveView(vaultPath, activeView.id, yaml, folder);
        await rescan();
      } catch {
        toast(`Couldn't update view "${activeView.definition.name}"`);
      }
    })();
  };

  // "New view" tab affordance: saves the current presentation as a
  // project-scoped view and switches to its tab.
  const [newViewOpen, setNewViewOpen] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const createView = async () => {
    const name = newViewName.trim();
    if (name === '' || project === null || vaultPath === null) return;
    // Dedupe within the project scope (M1.x): a name that slugifies to a
    // taken id must not silently overwrite that view's file.
    const base = slugifyViewId(name) || 'view';
    const taken = new Set(projectViews.map((v) => v.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const yaml = serializeView({
      name,
      icon: null,
      color: null,
      order: null,
      filters: null,
      presentation,
    });
    try {
      await saveView(vaultPath, id, yaml, projectDir(project.path));
      await rescan();
      setNewViewOpen(false);
      setNewViewName('');
      setActiveViewId(id);
      toast(`View "${name}" saved`);
    } catch {
      // Surface the failed write instead of an unhandled rejection (M1.x).
      toast(`Couldn't save view "${name}"`);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none px-5 pt-3.5">
        <div className="mb-2.5 flex min-w-0 items-center gap-2">
          {project ? (
            <>
              <Icon name="folder-kanban" size={16} color="var(--n-600)" />
              <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
                {project.title}
              </h1>
            </>
          ) : (
            <>
              <Icon name="layout-list" size={16} color="var(--n-600)" />
              <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
                {collection.title}
              </h1>
            </>
          )}
        </div>
        {project !== null && (
          <div
            role="tablist"
            aria-label="Project views"
            className="flex items-end gap-1 border-b border-[var(--n-200)]"
          >
            <ViewTab
              active={activeViewId === null}
              icon="list"
              label="Items"
              onClick={() => setActiveViewId(null)}
            />
            {projectViews.map((v) => (
              <ViewTab
                key={v.id}
                active={activeViewId === v.id}
                icon={v.definition.icon ?? 'layout-list'}
                label={v.definition.name}
                onClick={() => setActiveViewId(v.id)}
              />
            ))}
            <button
              type="button"
              onClick={() => setNewViewOpen(true)}
              className="mb-1 ml-1 inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
            >
              <Icon name="plus" size={13} />
              New view
            </button>
          </div>
        )}
      </div>
      <ViewToolbar presentation={presentation} onChange={handlePresentationChange} />
      {presentation.type === 'board' ? (
        <BoardView entries={sortedEntries} presentation={presentation} schema={schema} />
      ) : (
        <ListView entries={sortedEntries} presentation={presentation} schema={schema} project={project} />
      )}
      <Dialog
        open={newViewOpen}
        onClose={() => setNewViewOpen(false)}
        title="New view"
        width={420}
        primaryAction={{
          label: 'Save',
          onClick: () => void createView(),
          disabled: newViewName.trim() === '',
        }}
        secondaryAction={{ label: 'Cancel', onClick: () => setNewViewOpen(false) }}
      >
        <Input
          autoFocus
          placeholder="View name"
          value={newViewName}
          onChange={(e) => setNewViewName(e.target.value)}
          width="100%"
        />
      </Dialog>
    </div>
  );
}
