import { useEffect, useMemo, useState } from 'react';
import { deleteView, updateView } from '@/app/viewActions';
import { ViewSettingsDialog } from '@/app/ViewSettingsDialog';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { resolveCollection, sortEntries } from '@/engine/collections';
import type { Presentation, Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
import { SplitView } from '@/views/SplitView';
import { TableView } from '@/views/TableView';
import { TreeView } from '@/views/TreeView';
import { ViewToolbar } from '@/views/ViewToolbar';

export type ViewSelection = Extract<Selection, { kind: 'view' }>;

/**
 * A saved view's canvas (M3.5). Views are now top-level saved collections —
 * a type + filters + a layout — so this one page renders "Cobra launch" the
 * same way it renders "My open bugs". Toolbar edits auto-persist to the
 * view's YAML, matching how project tabs already behaved.
 */
export function CollectionPage({ selection }: { selection: ViewSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);

  const view = useMemo(
    () => views.find((v) => v.id === selection.id && v.project === null) ?? null,
    [views, selection.id],
  );

  const collection = useMemo(
    () => resolveCollection(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setPresentation(collection.presentation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.id]);

  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.orderBy, schema),
    [collection.entries, presentation.orderBy, schema],
  );

  const fields = useMemo(
    () =>
      view?.definition.source.type === null || view === null
        ? []
        : (schema.types.get(view.definition.source.type)?.fields ?? []),
    [schema, view],
  );

  if (view === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="layout-list"
          title="This view no longer exists"
          description="It may have been renamed or deleted."
        />
      </div>
    );
  }

  // Toolbar edits persist immediately — a saved view IS its configuration.
  const changePresentation = (next: Presentation) => {
    setPresentation(next);
    void updateView(view, { ...view.definition, presentation: next });
  };

  const sourceLabel =
    view.definition.source.type === null ? 'Everything' : view.definition.source.type;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="collection-page">
      <div className="flex-none px-5 pb-2 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            name={view.definition.icon ?? 'layout-list'}
            size={16}
            color={view.definition.color ?? 'var(--n-600)'}
          />
          <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
            {view.definition.name}
          </h1>
          <span className="[font-family:var(--font-mono)] text-[11.5px] text-[var(--n-400)]">
            {collection.entries.length}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--n-200)] px-2 py-0.5 text-[11px] text-[var(--n-500)]">
            {sourceLabel}
            {view.definition.filters !== null && ' · filtered'}
          </span>
          <span className="flex-1" />
          <IconButton icon="settings-2" label="View settings" onClick={() => setSettingsOpen(true)} />
          <IconButton icon="trash-2" label="Delete view" onClick={() => setConfirmDelete(true)} />
        </div>
      </div>
      <ViewToolbar
        presentation={presentation}
        onChange={changePresentation}
        fields={fields}
        withSplit
      />
      {presentation.type === 'tree' ? (
        <TreeView
          entries={sortedEntries}
          presentation={presentation}
          schema={schema}
          allEntries={entries}
          fields={fields}
        />
      ) : presentation.type === 'table' ? (
        <TableView
          entries={sortedEntries}
          presentation={presentation}
          schema={schema}
          fields={fields}
          onOrderBy={(field) =>
            changePresentation({
              ...presentation,
              orderBy: {
                field,
                dir:
                  presentation.orderBy.field === field && presentation.orderBy.dir === 'asc'
                    ? 'desc'
                    : 'asc',
              },
            })
          }
        />
      ) : presentation.type === 'split' ? (
        <SplitView entries={sortedEntries} schema={schema} />
      ) : presentation.type === 'board' ? (
        <BoardView entries={sortedEntries} presentation={presentation} schema={schema} />
      ) : (
        <ListView
          entries={sortedEntries}
          presentation={presentation}
          schema={schema}
          project={null}
        />
      )}

      {settingsOpen && (
        <ViewSettingsDialog
          initial={view.definition}
          entries={entries}
          schema={schema}
          title="View settings"
          onCancel={() => setSettingsOpen(false)}
          onSubmit={(definition) => {
            setSettingsOpen(false);
            setPresentation(definition.presentation);
            void updateView(view, definition);
          }}
        />
      )}
      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={`Delete "${view.definition.name}"?`}
          width={420}
          primaryAction={{
            label: 'Delete view',
            onClick: () => {
              setConfirmDelete(false);
              void (async () => {
                if (await deleteView(view)) navigate({ kind: 'home' });
              })();
            },
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(false) }}
        >
          <p className="m-0 text-[13px] text-[var(--n-600)]">
            The view configuration is removed. The records it listed are untouched.
          </p>
        </Dialog>
      )}
    </div>
  );
}
