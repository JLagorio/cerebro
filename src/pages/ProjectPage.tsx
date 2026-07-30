import { useEffect, useMemo, useState } from 'react';
import { FileTree } from '@/components/FileTree';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import { resolveCollection, sortEntries } from '@/engine/collections';
import { columnUniverse } from '@/engine/columns';
import { typeStyle } from '@/engine/typeCatalog';
import type { FieldDef, Presentation, Selection, ViewFile } from '@/engine/types';
import { clonePresentation, serializeView, toggleSort } from '@/engine/views';
import { addFieldToType, normalizeFieldName } from '@/app/typeActions';
import { TreeView } from '@/views/TreeView';
import { EntityDossier } from '@/knowledge/EntityDossier';
import { KnowledgeCommit } from '@/knowledge/KnowledgeCommit';
import { saveView } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
import { TableView } from '@/views/TableView';
import { slugifyViewId, ViewToolbar } from '@/views/ViewToolbar';

// Task 10: the project header carries two tab groups — saved views (Items +
// per-project views) and page tabs (Overview = project.md body, Pages = the
// project folder's file tree).
type ProjectTab =
  | { kind: 'items' }
  | { kind: 'view'; id: string }
  | { kind: 'overview' }
  | { kind: 'pages' };

export type ProjectSelection = Extract<Selection, { kind: 'project' | 'view' }>;

const projectDir = (projectPath: string) => projectPath.replace(/\/project\.md$/, '');

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
  const openDetail = useUiStore((s) => s.openDetail);
  const navigate = useNavStore((s) => s.navigate);

  // Work items open in their canonical editor (the detail panel); every
  // other markdown file is a document and opens full-page.
  const openFromTree = (path: string) => {
    const opened = entries.find((e) => e.path === path);
    if (opened !== undefined && opened.type === 'Work item') openDetail(path);
    else navigate({ kind: 'doc', path });
  };

  const collection = useMemo(
    () => resolveCollection(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  const project =
    selection.kind === 'project'
      ? entries.find((e) => e.path === selection.path) ?? null
      : null;

  // Task 8: saved-view tabs — "Items" is ephemeral, scoped-view tab edits
  // auto-persist. Task 10 adds the Overview and Pages tabs.
  const [tab, setTab] = useState<ProjectTab>({ kind: 'items' });
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
      : tab.kind === 'view'
        ? projectViews.find((v) => v.id === tab.id) ?? null
        : null;

  // Local presentation state, re-initialized when the selection or tab changes.
  const selectionKey = selection.kind === 'project' ? selection.path : selection.id;
  const tabKey = tab.kind === 'view' ? `view:${tab.id}` : tab.kind;
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  useEffect(() => {
    setTab({ kind: 'items' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  useEffect(() => {
    setPresentation(
      activeView !== null && selection.kind === 'project'
        ? clonePresentation(activeView.definition.presentation)
        : collection.presentation,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, tabKey]);

  // Deviation from the plan's verbatim body (reported): re-sort by the LIVE
  // orderBy so the toolbar's order select works — resolveCollection sorts by
  // the initial presentation only, and the views never re-sort.
  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.sort, schema),
    [collection.entries, presentation.sort, schema],
  );

  // M9.2: the canvas is no longer Work-item-only — a scoped view tab lists
  // whatever type its source names. Hardcoding `Work item` here showed the
  // wrong type's properties the moment a view tab was active.
  const activeSource = activeView?.definition.source ?? {
    type: 'Work item',
    project: project?.path ?? null,
  };
  const fields = useMemo(
    () => columnUniverse(activeSource, collection.entries, schema),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSource.type, activeSource.project, collection.entries, schema],
  );
  const sourceType = activeSource.type;
  const scope = selection.kind === 'project' ? `project:${selection.path}:${tabKey}` : `view:${selection.id}`;

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

  // M9.2: a column IS a property — adding one writes the type doc, then
  // shows the column on this canvas.
  const addProperty = (name: string, kind: FieldDef['kind']) => {
    if (sourceType === null) return;
    void (async () => {
      if (await addFieldToType(sourceType, name, kind)) {
        handlePresentationChange({
          ...presentation,
          columns: [...presentation.columns, { field: normalizeFieldName(name) }],
        });
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
      // A project tab is a view over this project's work items (M3.5) — the
      // same shape any saved view uses, no longer a special case.
      source: { type: 'Work item', project: project.path },
      filters: null,
      presentation,
    });
    try {
      await saveView(vaultPath, id, yaml, projectDir(project.path));
      await rescan();
      setNewViewOpen(false);
      setNewViewName('');
      setTab({ kind: 'view', id });
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
              <Icon
                name={typeStyle('Project', schema).icon}
                size={16}
                color={typeStyle('Project', schema).color ?? 'var(--n-600)'}
              />
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
            data-testid="project-tabs"
            className="flex items-end gap-1 border-b border-[var(--n-200)]"
          >
            <ViewTab
              active={tab.kind === 'items'}
              icon="list"
              label="Items"
              onClick={() => setTab({ kind: 'items' })}
            />
            {projectViews.map((v) => (
              <ViewTab
                key={v.id}
                active={tab.kind === 'view' && tab.id === v.id}
                icon={v.definition.icon ?? 'layout-list'}
                label={v.definition.name}
                onClick={() => setTab({ kind: 'view', id: v.id })}
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
            {/* Task 10: page tabs — the project folder's document surfaces. */}
            <span aria-hidden className="mx-1.5 mb-1.5 h-4 w-px bg-[var(--n-200)]" />
            <ViewTab
              active={tab.kind === 'overview'}
              icon="file-text"
              label="Overview"
              onClick={() => setTab({ kind: 'overview' })}
            />
            <ViewTab
              active={tab.kind === 'pages'}
              icon="folder-tree"
              label="Pages"
              onClick={() => setTab({ kind: 'pages' })}
            />
          </div>
        )}
      </div>
      {tab.kind === 'overview' && project !== null && selection.kind === 'project' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
          <NoteBodyEditor path={project.path} />
          {/* M8.3 — passive by design: it sits under the overview and waits
              to be scrolled to. Nothing about this project's knowledge is
              worth interrupting the page for. */}
          {/* M8.9 — the dossier, not a list. A count of related concepts
              tells you the base has been busy; what it currently believes,
              what disagrees, and what it read to get there tells you whether
              to trust it. */}
          <EntityDossier entry={project} />
          {/* The overview is a note like any other, so it can be committed
              like any other (M8.5) — and the button that does it lives with
              the record of what the last commit produced. */}
          <div className="mt-6">
            <KnowledgeCommit entry={project} variant="section" />
          </div>
        </div>
      ) : tab.kind === 'pages' && project !== null && selection.kind === 'project' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
          <FileTree
            root={projectDir(project.path)}
            hide={(p) => p === project.path}
            onOpen={openFromTree}
          />
        </div>
      ) : (
        <>
          <ViewToolbar
            presentation={presentation}
            onChange={handlePresentationChange}
            fields={fields}
            sourceType={sourceType}
            schema={schema}
            onAddProperty={addProperty}
          />
          {presentation.type === 'tree' ? (
            <TreeView
              entries={sortedEntries}
              presentation={presentation}
              schema={schema}
              allEntries={entries}
              fields={fields}
              scope={scope}
            />
          ) : presentation.type === 'table' ? (
            <TableView
              entries={sortedEntries}
              presentation={presentation}
              schema={schema}
              fields={fields}
              scope={scope}
              onColumnsChange={(columns) =>
                handlePresentationChange({ ...presentation, columns })
              }
              onOrderBy={(field) => handlePresentationChange(toggleSort(presentation, field))}
            />
          ) : presentation.type === 'board' ? (
            <BoardView
              entries={sortedEntries}
              presentation={presentation}
              schema={schema}
              scope={scope}
            />
          ) : (
            <ListView
              entries={sortedEntries}
              presentation={presentation}
              schema={schema}
              project={project}
              scope={scope}
            />
          )}
        </>
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
