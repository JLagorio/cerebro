import { useEffect, useMemo, useState } from 'react';
import { DeleteTypeDialog, RenameTypeDialog, TypeStyleDialog } from '@/app/TypeDialogs';
import {
  addFieldToType,
  addRelationProperty,
  normalizeFieldName,
  setTypeViews,
} from '@/app/typeActions';
import { Icon } from '@/components/ui/Icon';
import { resolveSurface, sortEntries } from '@/engine/surface';
import { columnUniverse } from '@/engine/columns';
import { clonePresentation, layoutLabel, moveView, nextViewId, toggleSort } from '@/engine/views';
import { seedView } from '@/app/viewActions';
import { listTypes, typeViews, type TypeListing } from '@/engine/typeCatalog';
import type { FieldDef, Presentation, Selection, ViewDefinition, ViewType } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { resolveDateField } from '@/engine/schedule';
import { useNewRecord, useQuickAdd } from '@/views/QuickAdd';
import { ViewSettingsPanel } from '@/views/ViewSettingsPanel';
import { ViewCanvas } from '@/views/ViewCanvas';
import { ViewControlIcons } from '@/views/ViewControlIcons';
import { ViewTabs } from '@/views/ViewTabs';
import { ViewToolbar } from '@/views/ViewToolbar';
import { ViewLimitNotice } from '@/views/ViewLimitNotice';
import { limitEntries, searchEntries } from '@/engine/viewFilters';

export type TypeSelection = Extract<Selection, { kind: 'type' }>;

type TypeDialog = 'rename' | 'style' | 'delete';

/**
 * M3 type screen: the record list for one type (rows open in the right-hand
 * detail panel) plus the Properties configuration tab.
 */
export function TypePage({ selection }: { selection: TypeSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);

  const listing = useMemo<TypeListing>(
    () =>
      listTypes(entries, schema).find((t) => t.name === selection.name) ?? {
        name: selection.name,
        icon: 'file-text',
        color: null,
        count: 0,
        system: false,
        docPath: null,
      },
    [entries, schema, selection.name],
  );

  const collection = useMemo(
    () => resolveSurface(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  // M9.2: one resolution path shared with every other surface.
  const typeFields = useMemo(
    () => columnUniverse({ type: listing.name, project: null }, collection.entries, schema),
    [schema, listing.name, collection.entries],
  );
  const scope = `type:${listing.name}`;
  // M9.6: the type screen could only list; now it can create.
  const quickAdd = useQuickAdd(listing.name, null);
  // M12.8: the tab row's New button — creates untitled, opens the panel.
  const newRecord = useNewRecord(listing.name);

  // M12.3: a type keeps saved views like a List does — the tabs live on the
  // Type doc under `views:`, and the open one rides on the selection.
  const savedViews = useMemo(() => typeViews(listing.name, schema), [listing.name, schema]);
  const activeView =
    (selection.view != null ? savedViews.find((v) => v.id === selection.view) : undefined) ??
    savedViews[0];
  const activeId = activeView.id;

  const [dialog, setDialog] = useState<TypeDialog | null>(null);
  // M12.8: the chip bar below the tabs, engaged from the tab-row icons.
  const [controlsOpen, setControlsOpen] = useState(false);
  // M12.8: the view-settings menu, floating from the tab row's sliders icon.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  // M16.26: ephemeral, unlike a filter — it is where you are looking right
  // now, so it never reaches the Type doc and clears with the tab.
  const [search, setSearch] = useState('');
  // Re-seed when the TYPE or the TAB changes — a tab carries its own
  // configuration, so switching tabs must not inherit the last one's.
  useEffect(() => {
    setPresentation(clonePresentation(collection.presentation));
    setSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.name, activeId]);

  const openTab = (id: string) => navigate({ kind: 'type', name: selection.name, view: id });

  /**
   * Persist the whole views array to the Type doc. Also re-seeds the local
   * presentation from the OPEN tab — a change coming from the tab menu (like
   * switching this view's layout) must show now, not after a navigation.
   */
  const changeViews = (next: ViewDefinition[]) => {
    const active = next.find((v) => v.id === activeId);
    if (active !== undefined) setPresentation(active.presentation);
    void setTypeViews(listing, next);
  };

  /** Persist a change to the OPEN tab only. */
  const changeView = (next: ViewDefinition) =>
    changeViews(savedViews.map((v) => (v.id === activeId ? next : v)));

  // Toolbar edits persist immediately — a saved view IS its configuration.
  const changePresentation = (next: Presentation) => {
    setPresentation(next);
    changeView({ ...activeView, presentation: next });
  };

  // M9.2: a column IS a property — shared by the settings panel's "+ New
  // property" and anything else that declares one from here.
  const addProperty = (
    name: string,
    kind: FieldDef['kind'],
    relation?: { target: string; limit?: 1; reciprocalName?: string },
  ) => {
    void (async () => {
      const ok =
        kind === 'relation' && relation !== undefined
          ? await addRelationProperty(listing.name, name, relation)
          : await addFieldToType(listing.name, name, kind);
      if (ok) {
        changePresentation({
          ...presentation,
          columns: [...presentation.columns, { field: normalizeFieldName(name) }],
        });
      }
    })();
  };

  const createView = (name: string, type: ViewType) => {
    // Seeded from the tab you are on, and written together with the current
    // tabs — which also materializes the default view the first time.
    // `seedView` decides what may travel: this handed the whole presentation
    // over and swapped `type`, so a table born on the gantt kept the gantt's
    // axis keys in the Type doc forever (M16.29).
    const seeded = seedView(
      name,
      type,
      savedViews.map((v) => v.id),
      presentation,
      activeView.filters,
    );
    void (async () => {
      if (await setTypeViews(listing, [...savedViews, seeded])) openTab(seeded.id);
    })();
  };

  const removeView = (id: string) => {
    if (savedViews.length <= 1) return;
    const remaining = savedViews.filter((v) => v.id !== id);
    void (async () => {
      if (!(await setTypeViews(listing, remaining))) return;
      if (id === activeId) openTab(remaining[0].id);
    })();
  };

  const duplicateTab = (id: string) => {
    const source = savedViews.find((v) => v.id === id);
    if (source === undefined) return;
    const name = `${source.name} copy`;
    const copy: ViewDefinition = {
      ...source,
      id: nextViewId(
        name,
        savedViews.map((v) => v.id),
      ),
      name,
      filters:
        source.filters === null
          ? null
          : (JSON.parse(JSON.stringify(source.filters)) as typeof source.filters),
      presentation: clonePresentation(source.presentation),
    };
    void (async () => {
      if (await setTypeViews(listing, [...savedViews, copy])) openTab(copy.id);
    })();
  };

  const sortedEntries = useMemo(
    () => searchEntries(sortEntries(collection.entries, presentation.sort, schema), search),
    [collection.entries, presentation.sort, schema, search],
  );
  // After the sort: "the first 25" has to mean the first 25 of the order on
  // screen, not 25 arbitrary records that are then sorted among themselves.
  const shownEntries = limitEntries(sortedEntries, presentation.limit);

  // The calendar creates WITH a date, which the band mechanism cannot carry:
  // a band sets a grouping value, not an arbitrary property.
  const dateField = resolveDateField(presentation, typeFields);
  const onCreateOn =
    dateField === null
      ? undefined
      : (title: string, day: string) => quickAdd(title, {}, { [dateField]: day });

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="type-page">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-none px-5 pt-3.5">
          <div className="mb-2.5 flex min-w-0 items-center gap-2">
            {/* M12.8: the icon and the name ARE the edit affordance (Notion's
                header) — the pencil and palette buttons this replaces sat in
                the corner pretending to be about something else. */}
            <button
              type="button"
              data-testid="type-icon-edit"
              title="Change icon & color"
              onClick={() => setDialog('style')}
              className="flex h-7 w-7 flex-none items-center justify-center rounded-md border-0 bg-transparent hover:bg-n-50"
            >
              <Icon name={listing.icon} size={16} color={listing.color ?? 'var(--n-600)'} />
            </button>
            <button
              type="button"
              data-testid="type-title-edit"
              title={listing.system ? 'Change icon & color' : 'Change display name'}
              onClick={() => setDialog(listing.system ? 'style' : 'rename')}
              className="min-w-0 rounded-md border-0 bg-transparent px-1 py-0.5 hover:bg-n-50"
            >
              <h1 className="m-0 truncate text-lg font-semibold leading-6 tracking-[-0.005em]">
                {listing.name}
              </h1>
            </button>
            {/* M16.31: the records this view is showing, not `listing.count`
                — the number of records of this type in the vault. Those are
                the same number until you filter or search, and then the
                header goes on reporting the vault while the canvas reports
                the view. The List page had the milder form of this (it
                followed filters but not search) and both now read the same
                thing: what is on screen. */}
            <span
              data-testid="view-count"
              className="[font-family:var(--font-mono)] text-xs text-n-400"
            >
              {sortedEntries.length}
            </span>
            {listing.system && (
              <span className="inline-flex items-center gap-1 rounded-full border border-n-200 px-2 py-0.5 text-2xs text-n-500">
                <Icon name="lock" size={10} />
                System type
              </span>
            )}
            <span className="flex-1" />
            {/* M12.8: no config buttons up here — properties and Delete type
                live in the view-settings menu on the tab row. */}
          </div>
        </div>
        {/* M12.3: the same saved-views strip a List has. The tab row owns
            layout; the toolbar below carries no pills. */}
        <ViewTabs
          views={savedViews}
          activeId={activeId}
          onSelect={openTab}
          onCreate={createView}
          onRename={(id, name) =>
            changeViews(savedViews.map((v) => (v.id === id ? { ...v, name } : v)))
          }
          onChangeLayout={(id, type) =>
            changeViews(
              savedViews.map((v) =>
                v.id === id
                  ? {
                      ...v,
                      name:
                        v.name === layoutLabel(v.presentation.type) ? layoutLabel(type) : v.name,
                      presentation: { ...v.presentation, type },
                    }
                  : v,
              ),
            )
          }
          onDuplicate={duplicateTab}
          onDelete={removeView}
          onReorder={(id, to) => changeViews(moveView(savedViews, id, to))}
          onChangeIcon={(id, icon) =>
            changeViews(savedViews.map((v) => (v.id === id ? { ...v, icon } : v)))
          }
          // M12.8: the view controls live in the tab row (Notion's toolbar).
          trailing={
            <ViewControlIcons
              presentation={presentation}
              filters={activeView.filters}
              fields={typeFields}
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
                  // A type's saved views configure through the same menu a
                  // List uses; this wrapper is the menu's ListDefinition
                  // shape, not a real List — surface="type" hides "This list".
                  list={{
                    name: listing.name,
                    icon: listing.icon,
                    color: listing.color,
                    order: null,
                    source: { type: listing.name, project: null },
                    views: savedViews.map((v) => (v.id === activeId ? { ...v, presentation } : v)),
                  }}
                  viewId={activeId}
                  fields={typeFields}
                  schema={schema}
                  surface="type"
                  onAddProperty={addProperty}
                  onClose={() => setSettingsOpen(false)}
                  onDeleteView={savedViews.length > 1 ? () => removeView(activeId) : undefined}
                  onDeleteList={
                    !listing.system && listing.docPath !== null
                      ? () => {
                          setSettingsOpen(false);
                          setDialog('delete');
                        }
                      : undefined
                  }
                  onChange={(next) => changeViews(next.views)}
                />
              }
              onNew={() => void newRecord()}
            />
          }
        />
        {controlsOpen && (
          <ViewToolbar
            presentation={presentation}
            onChange={changePresentation}
            fields={typeFields}
            sourceType={listing.name}
            schema={schema}
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
          fields={typeFields}
          scope={scope}
          createType={listing.name}
          // Search narrows too, so an empty canvas must read as "nothing
          // matches" rather than as "this type has no records".
          filtered={activeView.filters !== null || search !== ''}
          onCreate={quickAdd}
          onCreateOn={onCreateOn}
          onColumnsChange={(columns) => changePresentation({ ...presentation, columns })}
          onPresentationChange={changePresentation}
          onOrderBy={(field) => changePresentation(toggleSort(presentation, field))}
          onZoomChange={(zoom) => changePresentation({ ...presentation, zoom })}
          // M12.4b: the header menu's Filter seeds a rule on the open tab.
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
      {dialog === 'style' && <TypeStyleDialog listing={listing} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && (
        <RenameTypeDialog listing={listing} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && (
        <DeleteTypeDialog listing={listing} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
