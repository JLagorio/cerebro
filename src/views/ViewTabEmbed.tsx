import { SearchBox } from '@/views/ViewControlIcons';
import { searchEntries } from '@/engine/viewFilters';
import { Icon } from '@/components/ui/Icon';
import { useEffect, useState } from 'react';
import { addExistingToHost } from '@/app/relatedActions';
import { RelationPicker } from '@/detail/RelationPicker';
import { pointsAt } from '@/engine/linkDelta';
import { useVaultStore } from '@/stores/vaultStore';
import { resolveDateField } from '@/engine/schedule';
import { useQuickAdd, useCreateOnDay, QuickAddInline } from '@/views/QuickAdd';
import { columnUniverse } from '@/engine/columns';
import type { Entry, Schema } from '@/engine/types';
import type { ViewTabResolution } from '@/engine/viewTab';
import { ViewCanvas } from '@/views/ViewCanvas';

/**
 * A record's `content: 'view'` tab, rendered from Task 2's resolution
 * (M45.4) — a saved database view embedded where the tab's content would be,
 * or the honest card when its pointer is dead. Both record surfaces mount it
 * since M45.6: the page and the peek, the second in a column that starts at
 * 360px, which is why the embed flows with its host's scroll and claims no
 * height of its own. A tab can create in its database, and a related tab
 * files new records under the page that holds it.
 *
 * THE SEAM, decided against the plan's "extract ViewBlock's resolvable core"
 * (amended 2026-08-28): DashboardView's ViewBlock does NOT route through this
 * component, because its seams genuinely differ — WidgetShell chrome with
 * rename/menu/filter, the Global+widget `widgetEntries` filter layering, and
 * widget-addressed broken tiles. What the two surfaces MUST share, they do
 * share, each in exactly one place:
 *
 * - the RESOLUTION lives in the engine (`resolveViewTab` mirrors ViewBlock's
 *   path by construction — its module doc owns that claim), so a tab and a
 *   dashboard widget can never disagree about what a saved view means;
 * - the BROKEN-sentence rendering is `BrokenNotice` below, which ViewBlock's
 *   `BrokenBlock` composes inside its WidgetShell — a second copy of either
 *   is the review-blocking defect the plan names.
 *
 * Taking the RESOLUTION (not the tab) keeps the broken arm inseparable from
 * the ok arm: a consumer cannot render rows and forget the card.
 */

/** The one broken-pointer sentence body: icon + words, no chrome. The
 * dashboard wraps it in a WidgetShell; the record page and the record peek
 * in the quiet card below. "A blank tile is indistinguishable from a block
 * that is still loading" — the sentence is the point, so it is written
 * once. */
export function BrokenNotice({ icon, message }: { icon: string; message: string }) {
  return (
    <p className="m-0 flex items-start gap-2 px-3 py-4 text-xs leading-[17px] text-n-500">
      <Icon name={icon} size={14} color="var(--n-400)" />
      {message}
    </p>
  );
}

export function ViewTabEmbed({
  resolution,
  entries,
  schema,
  scope,
}: {
  resolution: ViewTabResolution;
  /** The whole vault — ViewCanvas resolves nested children outside the query. */
  entries: Entry[];
  schema: Schema;
  /** Collapse-state namespace, `viewtab:<tab id>` from the record page. */
  scope: string;
}) {
  const sourceType = resolution.kind === 'ok' ? resolution.sourceType : null;
  const host = resolution.kind === 'ok' ? resolution.filedUnder : null;
  const vault = useVaultStore((state) => state.vaultPath);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => {
    setAdding(false);
    setSearch('');
  }, [vault, scope, host?.host.path, host?.field, sourceType]);
  const quickAdd = useQuickAdd(sourceType ?? '', host);
  const createOnDay = useCreateOnDay(sourceType ?? '', host);
  if (resolution.kind === 'broken') {
    return (
      <div data-testid="view-tab-broken" className="rounded-lg border border-n-200 bg-n-0">
        <BrokenNotice icon="unlink" message={resolution.reason} />
      </div>
    );
  }
  const { surface, filtered } = resolution;
  // ViewBlock's wiring: the universe from the source type over the RESOLVED
  // rows. The synthetic ListSource is exact — `chainTypes` reads only `type`,
  // and a list's `project` narrowing already happened inside resolveSurface.
  const fields = columnUniverse(
    { type: sourceType, project: null },
    surface.entries,
    schema,
    surface.presentation.group,
  );
  const dateField = resolveDateField(surface.presentation, fields);
  return (
    // No fixed height: unlike a dashboard tile, the embed flows with the
    // record page's own scroll — Notion's linked-database posture.
    <div data-testid="view-tab-embed" className="flex min-h-0 min-w-0 flex-col">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-n-100 py-2">
        <span className="min-w-0 flex-1 text-metadata text-n-600">
          {resolution.sourceLabel}
          {host !== null && <> · Related to {host.host.title}</>}
        </span>
        <SearchBox query={search} onChange={setSearch} />
        {sourceType !== null && (
          <span className="min-w-0 max-w-full">
            <QuickAddInline compact ariaLabel="New related record" onCreate={quickAdd} />
          </span>
        )}
        {host !== null && sourceType !== null && (
          <div className="relative flex">
            <button
              type="button"
              data-testid="view-tab-add-existing"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 rounded-md border border-n-200 bg-transparent px-2 py-1 text-xs text-n-600 hover:bg-n-50"
            >
              <Icon name="plus" size={13} />
              Add existing
            </button>
          </div>
        )}
      </div>
      {adding && host !== null && sourceType !== null && (
        <RelationPicker
          fieldName="Add existing"
          targetType={sourceType}
          value={[]}
          entries={entries}
          schema={schema}
          onChange={() => {
            /* Confirm mode stages without a live write. */
          }}
          onClose={() => setAdding(false)}
          confirm={{
            label: (count) => `Add ${count} records`,
            exclude: new Set(
              entries
                .filter((entry) => pointsAt(entry, host.field, host.host, entries))
                .map((entry) => entry.path),
            ),
            onConfirm: (selected) => addExistingToHost(host, selected, schema),
          }}
        />
      )}
      <ViewCanvas
        embedded
        entries={searchEntries(surface.entries, search)}
        allEntries={entries}
        presentation={surface.presentation}
        schema={schema}
        fields={fields}
        scope={scope}
        createType={sourceType ?? undefined}
        filtered={filtered || search.trim() !== ''}
        onCreate={sourceType === null ? undefined : quickAdd}
        onCreateOn={
          sourceType === null || dateField === null
            ? undefined
            : (title, day, slot) =>
                slot === undefined
                  ? createOnDay(title, day, dateField)
                  : createOnDay(title, day, dateField, slot)
        }
      />
    </div>
  );
}
