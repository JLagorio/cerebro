import { useEffect, useMemo, useState } from 'react';
import { deleteView, updateView } from '@/app/viewActions';
import { ViewSettingsPanel } from '@/views/ViewSettingsPanel';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { resolveCollection, sortEntries } from '@/engine/collections';
import { columnUniverse } from '@/engine/columns';
import type { FieldDef, Presentation, Selection } from '@/engine/types';
import { addFieldToType, normalizeFieldName } from '@/app/typeActions';
import { clonePresentation, toggleSort } from '@/engine/views';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
import { SplitView } from '@/views/SplitView';
import { TableView } from '@/views/TableView';
import { TreeView } from '@/views/TreeView';
import { useQuickAdd } from '@/views/QuickAdd';
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
  // M9.7: the whole view configuration is a place, not a row of popovers.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setPresentation(clonePresentation(collection.presentation));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.id]);

  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.sort, schema),
    [collection.entries, presentation.sort, schema],
  );

  // M9.2: one resolution for every surface. A typeless view used to get [],
  // so an "Everything" view had no columns at all; columnUniverse unions the
  // properties its records actually carry.
  const fields = useMemo(
    () =>
      view === null ? [] : columnUniverse(view.definition.source, collection.entries, schema),
    [schema, view, collection.entries],
  );

  const sourceType = view?.definition.source.type ?? null;
  // M9.6: a typeless view has no single type to create into, so the
  // affordance is simply absent there rather than guessing one.
  const quickAdd = useQuickAdd(sourceType ?? '', null);
  const onCreate =
    sourceType === null
      ? undefined
      : (title: string, band: { groupBy: string; groupValue: string }) => quickAdd(title, band);
  // Collapse state is namespaced per surface so two views don't share bands.
  const scope = `view:${selection.id}`;

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

  // M9.2: a column IS a property, so adding one writes the type doc and then
  // shows the column here. Guarded to typed views by the toolbar.
  const addProperty = (name: string, kind: FieldDef['kind']) => {
    if (sourceType === null) return;
    void (async () => {
      if (await addFieldToType(sourceType, name, kind)) {
        changePresentation({
          ...presentation,
          columns: [...presentation.columns, { field: normalizeFieldName(name) }],
        });
      }
    })();
  };

  const sourceLabel =
    view.definition.source.type === null ? 'Everything' : view.definition.source.type;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="collection-page">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          onCreate={onCreate}
          filtered={view.definition.filters !== null}
          onColumnsChange={(columns) => changePresentation({ ...presentation, columns })}
          onOrderBy={(field) => changePresentation(toggleSort(presentation, field))}
        />
      ) : presentation.type === 'split' ? (
        <SplitView entries={sortedEntries} schema={schema} />
      ) : presentation.type === 'board' ? (
        <BoardView
          entries={sortedEntries}
          presentation={presentation}
          schema={schema}
          scope={scope}
          onCreate={onCreate}
        />
      ) : (
        <ListView
          entries={sortedEntries}
          presentation={presentation}
          schema={schema}
          project={null}
          scope={scope}
          createType={sourceType ?? undefined}
        />
      )}

      </div>
      {settingsOpen && (
        <ViewSettingsPanel
          definition={{ ...view.definition, presentation }}
          fields={fields}
          schema={schema}
          onClose={() => setSettingsOpen(false)}
          onDelete={() => {
            setSettingsOpen(false);
            setConfirmDelete(true);
          }}
          onChange={(definition) => {
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
