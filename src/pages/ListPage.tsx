import { useEffect, useMemo, useState } from 'react';
import { addView, deleteList, deleteView, duplicateView, updateList } from '@/app/listActions';
import { ViewSettingsPanel } from '@/views/ViewSettingsPanel';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { resolveSurface, sortEntries } from '@/engine/surface';
import { columnUniverse } from '@/engine/columns';
import type {
  FieldDef,
  ListDefinition,
  Presentation,
  Selection,
  ViewDefinition,
  ViewType,
} from '@/engine/types';
import { addFieldToType, addRelationProperty, normalizeFieldName } from '@/app/typeActions';
import { clonePresentation, layoutLabel, moveView, resolveView, toggleSort } from '@/engine/views';
import { seedView } from '@/app/viewActions';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { resolveDateField } from '@/engine/schedule';
import { useNewRecord, useQuickAdd } from '@/views/QuickAdd';
import { ViewCanvas } from '@/views/ViewCanvas';
import { ViewControlIcons } from '@/views/ViewControlIcons';
import { ViewTabs } from '@/views/ViewTabs';
import { ViewToolbar } from '@/views/ViewToolbar';
import { ViewLimitNotice } from '@/views/ViewLimitNotice';
import { limitEntries, searchEntries } from '@/engine/viewFilters';

export type ListSelection = Extract<Selection, { kind: 'list' }>;

/**
 * A List's canvas (M10, multi-view since M11): a type, and as many saved views
 * of it as you make.
 *
 * The List is the database — its source type and where it lives. Each TAB is a
 * way of looking at it, owning its own layout, filters, sorting, grouping and
 * columns. Switching tabs therefore changes what you see without destroying how
 * you had the last one set up, which is exactly what the old layout pills could
 * not do.
 */
export function ListPage({ selection }: { selection: ListSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);

  const list = useMemo(
    // Ids are unique per FOLDER, so the collection is part of the key — two
    // Collections may each hold a "roadmap".
    () =>
      views.find((v) => v.id === selection.id && v.collection === (selection.collection ?? null)) ??
      null,
    [views, selection.id, selection.collection],
  );

  // The open tab. A selection naming a view that no longer exists (deleted in
  // another window, or renamed on disk) falls back to the first rather than
  // rendering nothing.
  const activeView: ViewDefinition | null =
    list === null ? null : resolveView(list.definition, selection.view);
  const activeId = activeView?.id ?? '';

  const surface = useMemo(
    () => resolveSurface(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  const [presentation, setPresentation] = useState<Presentation>(surface.presentation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // M12.8: the chip bar below the tabs. Hidden until an icon engages it —
  // the icons tint when an axis is active, so nothing is silently filtered.
  const [controlsOpen, setControlsOpen] = useState(false);
  // M16.26: search is where you are looking RIGHT NOW, not part of what the
  // saved view is — so it lives here and never reaches the YAML, and it
  // clears with the tab for the same reason the presentation re-seeds.
  const [search, setSearch] = useState('');
  // Re-seed when the LIST or the TAB changes — a tab carries its own
  // configuration, so switching tabs must not inherit the last one's.
  useEffect(() => {
    setPresentation(clonePresentation(surface.presentation));
    setSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.id, selection.collection, activeId]);

  const sortedEntries = useMemo(
    () => searchEntries(sortEntries(surface.entries, presentation.sort, schema), search),
    [surface.entries, presentation.sort, schema, search],
  );
  // Applied AFTER the sort, so "the first 25" means the first 25 of the order
  // on screen rather than 25 arbitrary records that then get sorted.
  const shownEntries = limitEntries(sortedEntries, presentation.limit);

  // M9.2: one resolution for every surface. A typeless view used to get [],
  // so an "Everything" view had no columns at all; columnUniverse unions the
  // properties its records actually carry.
  const fields = useMemo(
    () => (list === null ? [] : columnUniverse(list.definition.source, surface.entries, schema)),
    [schema, list, surface.entries],
  );

  const sourceType = list?.definition.source.type ?? null;
  // M9.6: a typeless view has no single type to create into, so the
  // affordance is simply absent there rather than guessing one.
  const quickAdd = useQuickAdd(sourceType ?? '', null);
  // M12.8: the tab row's New button — creates untitled, opens the panel.
  const newRecord = useNewRecord(sourceType ?? '');
  const onCreate =
    sourceType === null
      ? undefined
      : (title: string, band: { groupBy: string; groupValue: string }) => quickAdd(title, band);
  // Creating on a calendar day means creating WITH that date — the band
  // mechanism carries a grouping value, not an arbitrary property, so the date
  // goes through quickAdd's `extra` frontmatter instead.
  const dateField = resolveDateField(presentation, fields);
  const onCreateOn =
    sourceType === null || dateField === null
      ? undefined
      : (title: string, day: string) => quickAdd(title, {}, { [dateField]: day });
  // Collapse state is namespaced per TAB: two views of one List group
  // differently, so a band collapsed in the board is not the same band.
  const scope = `list:${selection.collection ?? ''}:${selection.id}:${activeId}`;

  if (list === null || activeView === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="layout-list"
          title="This list no longer exists"
          description="It may have been renamed or deleted."
        />
      </div>
    );
  }

  const openTab = (id: string) =>
    navigate({
      kind: 'list',
      id: selection.id,
      collection: selection.collection ?? null,
      view: id,
    });

  /**
   * Persist a change to the whole List (source, name, the views array).
   *
   * Also re-seeds the local presentation from whatever the OPEN tab looks like
   * afterwards. The local copy exists so toolbar edits feel instant, but it
   * only re-seeds on a tab or list change — so a change that came from
   * somewhere else, like the tab menu switching this view's layout, would
   * otherwise be written to disk and not shown until you navigated away and
   * back.
   */
  const changeList = (next: ListDefinition) => {
    const active = next.views.find((v) => v.id === activeId);
    if (active !== undefined) setPresentation(active.presentation);
    void updateList(list, next);
  };

  /** Persist a change to the OPEN tab only. */
  const changeView = (next: ViewDefinition) =>
    changeList({
      ...list.definition,
      views: list.definition.views.map((v) => (v.id === activeId ? next : v)),
    });

  // Toolbar edits persist immediately — a saved view IS its configuration.
  const changePresentation = (next: Presentation) => {
    setPresentation(next);
    changeList({
      ...list.definition,
      views: list.definition.views.map((v) =>
        v.id === activeId ? { ...v, presentation: next } : v,
      ),
    });
  };

  // M9.2: a column IS a property, so adding one writes the type doc and then
  // shows the column here. Guarded to typed views by the toolbar.
  const addProperty = (
    name: string,
    kind: FieldDef['kind'],
    relation?: { target: string; limit?: 1; reciprocalName?: string },
  ) => {
    if (sourceType === null) return;
    void (async () => {
      const ok =
        kind === 'relation' && relation !== undefined
          ? await addRelationProperty(sourceType, name, relation)
          : await addFieldToType(sourceType, name, kind);
      if (ok) {
        changePresentation({
          ...presentation,
          columns: [...presentation.columns, { field: normalizeFieldName(name) }],
        });
      }
    })();
  };

  const createView = (name: string, type: ViewType) => {
    void (async () => {
      // Seeded from the tab you are on: "same columns, drawn as a board" is
      // what people mean by adding a view, and starting blank throws away the
      // configuration they just did. `seedView` decides what may travel —
      // this used to hand the whole presentation over and swap `type`, so a
      // table born on the gantt kept `zoom` forever (M16.29).
      const seeded = seedView(
        name,
        type,
        list.definition.views.map((v) => v.id),
        presentation,
      );
      const id = await addView(list, seeded);
      if (id !== null) openTab(id);
    })();
  };

  const removeView = (id: string) => {
    void (async () => {
      if (!(await deleteView(list, id))) return;
      if (id === activeId) {
        const next = list.definition.views.find((v) => v.id !== id);
        if (next !== undefined) openTab(next.id);
      }
    })();
  };

  const sourceLabel = list.definition.source.type ?? 'Everything';
  // Search narrows too, so the empty state must say "nothing matches" rather
  // than "this list is empty" — which would be a lie about the vault.
  const filtered = activeView.filters !== null || search !== '';

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="collection-page">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-none px-5 pb-2 pt-3.5">
          <div className="flex min-w-0 items-center gap-2">
            {/* M12.8: the icon and the name ARE the edit affordance (Notion's
                header). Both open view settings, where "This list" renames. */}
            <button
              type="button"
              data-testid="list-title-edit"
              title="Edit list name & settings"
              onClick={() => setSettingsOpen(true)}
              className="flex min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-1 py-0.5 hover:bg-[var(--n-50)]"
            >
              <Icon
                name={list.definition.icon ?? 'layout-list'}
                size={16}
                color={list.definition.color ?? 'var(--n-600)'}
              />
              <h1 className="m-0 min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[-0.005em]">
                {list.definition.name}
              </h1>
            </button>
            {/* M16.31: `sortedEntries`, which is filtered AND searched — not
                `surface.entries`, which is only filtered. Typing in "Search
                this view" narrowed the canvas and flipped the chip to
                "· filtered" while this number stayed where it was, so one
                header told two different stories about one screen depending
                on which control you had narrowed with. NOT `shownEntries`: a
                load limit is truncation, and how much of how much is showing
                is what ViewLimitNotice says under the records. */}
            <span
              data-testid="view-count"
              className="flex-none [font-family:var(--font-mono)] text-[11.5px] text-[var(--n-400)]"
            >
              {sortedEntries.length}
            </span>
            <span className="hidden flex-none items-center gap-1 rounded-full border border-[var(--n-200)] px-2 py-0.5 text-[11px] text-[var(--n-500)] sm:inline-flex">
              {sourceLabel}
              {filtered && ' · filtered'}
            </span>
            <span className="flex-1" />
            {/* M15: Delete list no longer sits here. It was the ONLY control in
                this gutter — a 24px unlabelled glyph roughly 55px above the
                toolbar's "+ New" and directly below the topbar's, so the corner
                read New / Delete-list / New with the destructive one in the
                middle and no visual distinction. It lives where the rest of the
                list's configuration lives: view settings, which this title
                button opens, alongside "This list". */}
          </div>
        </div>
        {/* M11: the tab row IS the layout control. There is no pill strip in
            the toolbar below, because pressing one used to overwrite the view
            you had configured rather than open a different one. */}
        <ViewTabs
          views={list.definition.views}
          activeId={activeId}
          onSelect={openTab}
          onCreate={createView}
          onRename={(id, name) =>
            changeList({
              ...list.definition,
              views: list.definition.views.map((v) => (v.id === id ? { ...v, name } : v)),
            })
          }
          onChangeLayout={(id, type) =>
            changeList({
              ...list.definition,
              views: list.definition.views.map((v) =>
                v.id === id
                  ? {
                      ...v,
                      // A view still called "Table" that now draws a board is a
                      // lie in the tab row; rename only the ones that never got
                      // a name of their own.
                      name:
                        v.name === layoutLabel(v.presentation.type) ? layoutLabel(type) : v.name,
                      presentation: { ...v.presentation, type },
                    }
                  : v,
              ),
            })
          }
          onDuplicate={(id) => {
            void (async () => {
              const created = await duplicateView(list, id);
              if (created !== null) openTab(created);
            })();
          }}
          onDelete={removeView}
          onReorder={(id, to) =>
            changeList({ ...list.definition, views: moveView(list.definition.views, id, to) })
          }
          onChangeIcon={(id, icon) =>
            changeList({
              ...list.definition,
              views: list.definition.views.map((v) => (v.id === id ? { ...v, icon } : v)),
            })
          }
          onConfigure={(id) => {
            if (id !== activeId) openTab(id);
            setSettingsOpen(true);
          }}
          // M12.8: the view controls live in the tab row (Notion's toolbar).
          trailing={
            <ViewControlIcons
              presentation={presentation}
              filters={activeView.filters}
              fields={fields}
              onChange={changePresentation}
              onFiltersChange={(filters) => changeView({ ...activeView, filters })}
              barOpen={controlsOpen}
              onBarOpenChange={setControlsOpen}
              search={search}
              onSearchChange={setSearch}
              settingsOpen={settingsOpen}
              onSettingsOpenChange={setSettingsOpen}
              settingsPanel={
                <ViewSettingsPanel
                  list={{
                    ...list.definition,
                    views: list.definition.views.map((v) =>
                      v.id === activeId ? { ...v, presentation } : v,
                    ),
                  }}
                  viewId={activeId}
                  fields={fields}
                  schema={schema}
                  onAddProperty={addProperty}
                  onClose={() => setSettingsOpen(false)}
                  onDeleteList={() => {
                    setSettingsOpen(false);
                    setConfirmDelete(true);
                  }}
                  onDeleteView={
                    list.definition.views.length > 1 ? () => removeView(activeId) : undefined
                  }
                  onChange={(next) => {
                    const active = next.views.find((v) => v.id === activeId);
                    if (active !== undefined) setPresentation(active.presentation);
                    changeList(next);
                  }}
                />
              }
              onNew={sourceType === null ? undefined : () => void newRecord()}
            />
          }
        />
        {controlsOpen && (
          <ViewToolbar
            presentation={presentation}
            onChange={changePresentation}
            fields={fields}
            sourceType={sourceType}
            schema={schema}
            // M11: no layout pills here. The tab row above owns layout, and a
            // pill that changed it in place would rewrite the open tab rather
            // than take you to another one.
            showLayout={false}
            filters={activeView.filters}
            onFiltersChange={(filters) => changeView({ ...activeView, filters })}
          />
        )}
        <ViewCanvas
          entries={shownEntries}
          allEntries={entries}
          presentation={presentation}
          schema={schema}
          fields={fields}
          scope={scope}
          createType={sourceType ?? undefined}
          filtered={filtered}
          onCreate={onCreate}
          onCreateOn={onCreateOn}
          onColumnsChange={(columns) => changePresentation({ ...presentation, columns })}
          onPresentationChange={changePresentation}
          onOrderBy={(field) => changePresentation(toggleSort(presentation, field))}
          onZoomChange={(zoom) => changePresentation({ ...presentation, zoom })}
          // M12.4b: the header menu's Filter seeds a rule; the toolbar's
          // filter pill is where it gets refined.
          onFilterField={(field) =>
            changeView({
              ...activeView,
              filters: {
                all: [
                  ...(activeView.filters !== null && 'all' in activeView.filters
                    ? activeView.filters.all
                    : activeView.filters !== null
                      ? [activeView.filters]
                      : []),
                  { field, op: 'is_not_empty', value: '' },
                ],
              },
            })
          }
        />
        <ViewLimitNotice
          shown={shownEntries.length}
          total={sortedEntries.length}
          onShowAll={() => changePresentation({ ...presentation, limit: undefined })}
        />
      </div>
      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={`Delete "${list.definition.name}"?`}
          width={420}
          primaryAction={{
            label: 'Delete list',
            onClick: () => {
              setConfirmDelete(false);
              void (async () => {
                if (await deleteList(list)) navigate({ kind: 'home' });
              })();
            },
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(false) }}
        >
          <p className="m-0 text-[13px] text-[var(--n-600)]">
            The list's configuration is removed, including its{' '}
            {list.definition.views.length === 1 ? 'view' : `${list.definition.views.length} views`}.
            The records it held are untouched — a list is a saved query, not the notes themselves.
          </p>
        </Dialog>
      )}
    </div>
  );
}
