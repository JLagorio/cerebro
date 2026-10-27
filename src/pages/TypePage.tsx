import { selectedViewIssue } from '@/engine/selectedEntryProjection';
import { DatabaseActions } from '@/views/DatabaseActions';
import { PageHeader } from '@/components/PageHeader';
import { UnfiledCorrespondents } from '@/views/UnfiledCorrespondents';
import { Button } from '@/components/ui/Button';
import { IcsImportDialog } from '@/app/IcsImportDialog';
import { icsTargets } from '@/engine/icsImport';
import { useEntryState } from '@/app/useEntryState';
import type { TimeSlot } from '@/engine/timeGrid';
import { useEffect, useMemo, useState } from 'react';
import { DeleteTypeDialog, RenameTypeDialog, TypeStyleDialog } from '@/app/TypeDialogs';
import { exportViewCsv } from '@/app/csvActions';
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
import { useCreateOnDay, useNewRecord, useQuickAdd } from '@/views/QuickAdd';
import { ViewSettingsPanel } from '@/views/ViewSettingsPanel';
import { ViewCanvas } from '@/views/ViewCanvas';
import { ViewControlIcons } from '@/views/ViewControlIcons';
import { ViewTabs } from '@/views/ViewTabs';
import { ViewToolbar } from '@/views/ViewToolbar';
import { ViewLimitNotice } from '@/views/ViewLimitNotice';
import { limitEntries, searchEntries } from '@/engine/viewFilters';
import { checkView } from '@/engine/viewCheck';
import { ViewProblems } from '@/views/ViewProblems';

export type TypeSelection = Extract<Selection, { kind: 'type' }>;

type TypeDialog = 'rename' | 'style' | 'delete' | 'calendar';

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

  const scope = `type:${listing.name}`;
  // M9.6: the type screen could only list; now it can create.
  const quickAdd = useQuickAdd(listing.name, null);
  // M53.16: a calendar day's "+", writing the date in the shape its field
  // declares.
  const createOnDay = useCreateOnDay(listing.name);
  // M12.8: the tab row's New button — creates untitled, opens the panel.
  const newRecord = useNewRecord(listing.name);

  // M12.3: a type keeps saved views like a List does — the tabs live on the
  // Type doc under `views:`, and the open one rides on the selection.
  const savedViews = useMemo(() => typeViews(listing.name, schema), [listing.name, schema]);
  const activeView =
    (selection.view != null ? savedViews.find((v) => v.id === selection.view) : undefined) ??
    savedViews[0];
  const activeId = activeView.id;

  const vault = useVaultStore((s) => s.vaultPath);
  const [unfiled, setUnfiled] = useState(false);
  useEffect(() => setUnfiled(false), [selection.name, vault]);
  const [dialog, setDialog] = useState<TypeDialog | null>(null);
  // M12.8: the chip bar below the tabs, engaged from the tab-row icons.
  const [controlsOpen, setControlsOpen] = useEntryState('view.controls', false);
  // M12.8: the view-settings menu, floating from the tab row's sliders icon.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  // Search never reaches the Type doc; it rides this Back entry.
  const [search, setSearch] = useEntryState('view.search', '');
  // Re-seed when the TYPE or the TAB changes — a tab carries its own
  // configuration, so switching tabs must not inherit the last one's.
  useEffect(() => {
    setPresentation(clonePresentation(collection.presentation));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.name, activeId]);
  // Re-seed, keeping search, when the STORED view changes under the open tab
  // (M60.2): a field rename rewrites every saved view in one batch, and a
  // stale local copy would write the old name back on the next toolbar edit.
  const storedPresentation = JSON.stringify(activeView.presentation);
  useEffect(() => {
    setPresentation(clonePresentation(activeView.presentation));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stored JSON, so a re-parse with the same content does not reset an edit in flight
  }, [storedPresentation]);

  // M9.2: one resolution path shared with every other surface.
  // M20.2: reads the CHAIN, so a tab whose grouping descends a relation gets
  // the nested types' columns too — which is why it lives below the
  // presentation state rather than beside the surface it came from.
  const typeFields = useMemo(
    () =>
      columnUniverse(
        { type: listing.name, project: null },
        collection.entries,
        schema,
        presentation.group,
      ),
    [schema, listing.name, collection.entries, presentation.group],
  );
  const problems = useMemo(
    () => checkView({ ...activeView, presentation }, listing.name, schema, entries),
    [activeView, presentation, listing.name, schema, entries],
  );

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
        // M20.3: `person` too. A person field IS a relation with an avatar
        // renderer (M16.13b), and the picker that declares one offers a target
        // — which this dropped on the floor, silently, because only `relation`
        // reached `addRelationProperty`. The new field arrived pointing at
        // nothing and there was no sign anything had been discarded. The
        // table's own header "+" already got this right.
        (kind === 'relation' || kind === 'person') && relation !== undefined
          ? await addRelationProperty(listing.name, name, relation, kind)
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

  const selectedUnavailable =
    collection.unavailable ??
    selectedViewIssue(
      collection.entries,
      schema,
      presentation,
      activeView?.filters,
      listing.name,
      search,
    );
  const sortedEntries = useMemo(
    () =>
      selectedUnavailable
        ? []
        : searchEntries(sortEntries(collection.entries, presentation.sort, schema), search),
    [collection.entries, presentation.sort, schema, search, selectedUnavailable],
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
      : (title: string, day: string, slot?: TimeSlot) =>
          slot === undefined
            ? createOnDay(title, day, dateField)
            : createOnDay(title, day, dateField, slot);

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="type-page">
      <div className="cb-data-page flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader
          icon={
            <button
              type="button"
              data-testid="type-icon-edit"
              title="Change icon & color"
              onClick={() => setDialog('style')}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-n-100"
            >
              <Icon
                name={listing.icon}
                size={18}
                color={listing.color ?? 'var(--text-secondary)'}
              />
            </button>
          }
          title={
            <button
              type="button"
              data-testid="type-title-edit"
              title={listing.system ? 'Change icon & color' : 'Change display name'}
              onClick={() => setDialog(listing.system ? 'style' : 'rename')}
              className="max-w-full rounded-md px-1 text-left hover:bg-n-50 [overflow-wrap:anywhere]"
            >
              {listing.name}
            </button>
          }
          metadata={
            <span data-testid="view-count">
              {selectedUnavailable ? 'Unavailable' : sortedEntries.length}
            </span>
          }
          actions={
            <>
              <DatabaseActions
                kind="database"
                onStyle={() => setDialog('style')}
                onRename={listing.system ? undefined : () => setDialog('rename')}
                onDelete={
                  !listing.system && listing.docPath !== null
                    ? () => setDialog('delete')
                    : undefined
                }
              />
              {listing.system && (
                <span className="inline-flex items-center gap-1 rounded-full border border-n-200 px-2 py-0.5 text-2xs text-n-500">
                  <Icon name="lock" size={10} />
                  System type
                </span>
              )}
              {schema.types.get(listing.name)?.fields.some((field) => field.kind === 'email') && (
                <Button
                  testId="unfiled-open"
                  variant="ghost"
                  size="sm"
                  onClick={() => setUnfiled(true)}
                >
                  Unfiled correspondents
                </Button>
              )}
            </>
          }
        />
        {unfiled && (
          <UnfiledCorrespondents
            key={`${vault}:${listing.name}`}
            typeName={listing.name}
            onClose={() => setUnfiled(false)}
          />
        )}
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
          onExport={(view) => void exportViewCsv({ ...selection, view }, views)}
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
                  onImportCalendar={
                    icsTargets(schema).some((type) => type.name === listing.name)
                      ? () => {
                          setSettingsOpen(false);
                          setDialog('calendar');
                        }
                      : undefined
                  }
                  onAddProperty={addProperty}
                  onClose={() => setSettingsOpen(false)}
                  onDeleteView={savedViews.length > 1 ? () => removeView(activeId) : undefined}
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
            problems={problems}
            onFiltersChange={(filters) => changeView({ ...activeView, filters })}
          />
        )}
        <ViewProblems problems={problems} source={listing.name} />
        <ViewCanvas
          unavailable={selectedUnavailable}
          entryScrollKey="canvas.scroll"
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
          // M44.3: the chart drilldown's Save-as-view. The view arrives fully
          // seeded (the same seedView chain createView uses, band rule already
          // merged into these filters); only the id is re-keyed here, against
          // the roster it actually joins — mirroring addView's re-key on the
          // List side.
          viewFilters={activeView.filters}
          onSaveView={(view) => {
            const seeded = {
              ...view,
              id: nextViewId(
                view.name,
                savedViews.map((v) => v.id),
              ),
            };
            void (async () => {
              if (await setTypeViews(listing, [...savedViews, seeded])) openTab(seeded.id);
            })();
          }}
          // M29.48: where a whiteboard tab keeps its canvas. A Type screen's
          // saved views are real views (M12.3), so its whiteboards land beside
          // the Type doc that owns them. A GHOST type — a name only records
          // carry, with no doc of its own (`docPath: null`) — has no folder to
          // be beside, and its canvases go to a top-level whiteboards/ rather
          // than beside a `types/` doc that does not exist.
          whiteboardHost={{
            folder:
              listing.docPath !== null && listing.docPath.includes('/')
                ? listing.docPath.slice(0, listing.docPath.lastIndexOf('/'))
                : '',
            // The OPEN TAB names the canvas: two whiteboard tabs are two
            // drawings.
            viewName: activeView.name,
          }}
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
        {!selectedUnavailable && (
          <ViewLimitNotice
            shown={shownEntries.length}
            total={sortedEntries.length}
            onShowAll={() => changePresentation({ ...presentation, limit: undefined })}
          />
        )}
      </div>
      {dialog === 'calendar' && (
        <IcsImportDialog initialType={listing.name} onClose={() => setDialog(null)} />
      )}
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
