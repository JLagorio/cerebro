import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { resolveCollection, sortEntries } from '@/engine/collections';
import type { Presentation, Selection } from '@/engine/types';
import { serializeView } from '@/engine/views';
import { saveView } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
import { slugifyViewId, ViewToolbar } from '@/views/ViewToolbar';

export type ProjectSelection = Extract<Selection, { kind: 'project' | 'view' }>;

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

  // Local presentation state, re-initialized when the selection target changes.
  const selectionKey = selection.kind === 'project' ? selection.path : selection.id;
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  useEffect(() => {
    setPresentation(collection.presentation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  // Deviation from the plan's verbatim body (reported): re-sort by the LIVE
  // orderBy so the toolbar's order select works — resolveCollection sorts by
  // the initial presentation only, and the views never re-sort.
  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.orderBy, schema),
    [collection.entries, presentation.orderBy, schema],
  );

  const project =
    selection.kind === 'project'
      ? entries.find((e) => e.path === selection.path) ?? null
      : null;

  const handleSaveView = async (name: string) => {
    if (!vaultPath) return;
    // Dedupe against existing view ids (M1.x): a name that slugifies to a
    // taken id must not silently overwrite that view's file.
    const base = slugifyViewId(name) || 'view';
    const taken = new Set(views.map((v) => v.id));
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
      await saveView(vaultPath, id, yaml);
      await rescan(); // the watcher rescan also picks the new view up for the sidebar
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
      </div>
      <ViewToolbar
        presentation={presentation}
        onChange={setPresentation}
        onSaveView={handleSaveView}
      />
      {presentation.type === 'board' ? (
        <BoardView entries={sortedEntries} presentation={presentation} schema={schema} />
      ) : (
        <ListView entries={sortedEntries} presentation={presentation} schema={schema} project={project} />
      )}
    </div>
  );
}
