import { Icon } from '@/components/ui/Icon';
import { columnUniverse } from '@/engine/columns';
import type { Entry, Schema } from '@/engine/types';
import type { ViewTabResolution } from '@/engine/viewTab';
import { ViewCanvas } from '@/views/ViewCanvas';

/**
 * The record page's `content: 'view'` tab, rendered from Task 2's resolution
 * (M45.4) — a saved database view embedded where the tab's content would be,
 * or the honest card when its pointer is dead.
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
 * dashboard wraps it in a WidgetShell; the record page in the quiet card
 * below. "A blank tile is indistinguishable from a block that is still
 * loading" — the sentence is the point, so it is written once. */
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
  if (resolution.kind === 'broken') {
    return (
      <div data-testid="view-tab-broken" className="rounded-lg border border-n-200 bg-n-0">
        <BrokenNotice icon="unlink" message={resolution.reason} />
      </div>
    );
  }
  const { surface, sourceType, filtered } = resolution;
  // ViewBlock's wiring: the universe from the source type over the RESOLVED
  // rows. The synthetic ListSource is exact — `chainTypes` reads only `type`,
  // and a list's `project` narrowing already happened inside resolveSurface.
  const fields = columnUniverse(
    { type: sourceType, project: null },
    surface.entries,
    schema,
    surface.presentation.group,
  );
  return (
    // No fixed height: unlike a dashboard tile, the embed flows with the
    // record page's own scroll — Notion's linked-database posture.
    <div data-testid="view-tab-embed" className="flex min-h-0 flex-col">
      <ViewCanvas
        embedded
        entries={surface.entries}
        allEntries={entries}
        presentation={surface.presentation}
        schema={schema}
        fields={fields}
        scope={scope}
        createType={sourceType ?? undefined}
        filtered={filtered}
      />
    </div>
  );
}
