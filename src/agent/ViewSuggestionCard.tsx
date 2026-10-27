import { useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { acceptViewSuggestion } from '@/app/viewSuggestionActions';
import { findTypeDoc } from '@/app/typeActions';
import { columnUniverse } from '@/engine/columns';
import { canHoldDatabaseBlock } from '@/engine/databaseBlock';
import { humanize } from '@/engine/schema';
import { resolveTypeView } from '@/engine/surface';
import { typeViews } from '@/engine/typeCatalog';
import { checkView, describeViewProblem } from '@/engine/viewCheck';
import { completeSuggestion, parseSuggestionResult, sameView } from '@/engine/viewSuggestion';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { isTemplate } from '@/lib/templates';
import { ViewCanvas } from '@/views/ViewCanvas';
import type { ToolCall } from './types';

const stop = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};
const BUTTON =
  'rounded-md border border-n-200 px-2 py-1 text-2xs text-n-700 hover:bg-n-50 disabled:opacity-50';

/** A tool answer remains a suggestion until the person presses Add. Its
 * preview uses the page's resolver and canvas, with no interactive surface. */
export function ViewSuggestionCard({
  tool,
  readOnly = false,
}: {
  tool: ToolCall;
  readOnly?: boolean;
}) {
  const entries = useVaultStore((state) => state.entries);
  const status = useVaultStore((state) => state.status);
  const vault = useVaultStore((state) => state.vaultPath);
  const entriesVault = useVaultStore((state) => state.entriesVault);
  const schema = useSchema();
  const selection = useNavStore((state) => state.selection);
  const suggestion = useMemo(
    () => parseSuggestionResult(tool.payload?.output ?? tool.output),
    [tool.payload?.output, tool.output],
  );
  const view = useMemo(
    () => (suggestion === null ? null : completeSuggestion(suggestion)),
    [suggestion],
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const unavailable =
    suggestion === null ||
    view === null ||
    vault === null ||
    status !== 'ready' ||
    entriesVault !== vault;
  const database = suggestion?.database ?? '';
  const doc = findTypeDoc(entries, database);
  const saved =
    view === null ? undefined : typeViews(database, schema).find((item) => sameView(item, view));
  const problems = view === null ? [] : checkView(view, database, schema, entries);
  const problem = (doc !== null && doc.parseError !== null) || problems.length > 0;
  const surface = useMemo(
    () => (view === null ? null : resolveTypeView(database, view, entries, schema)),
    [view, database, entries, schema],
  );
  const state = unavailable || surface?.unavailable !== undefined
    ? 'unavailable'
    : doc === null
      ? 'gone'
      : problem
        ? 'problems'
        : saved !== undefined
          ? 'added'
          : 'ready';
  const fields = useMemo(
    () =>
      surface === null
        ? []
        : columnUniverse(
            { type: database, project: null },
            surface.entries,
            schema,
            surface.presentation.group,
          ),
    [surface, database, schema],
  );
  const openPage =
    !readOnly && selection.kind === 'doc'
      ? entries.find((entry) => entry.path === selection.path && canHoldDatabaseBlock(entry))
      : undefined;
  const all = entries.filter((entry) => entry.type === database && !isTemplate(entry)).length;
  async function add(placeOn?: string) {
    if (inFlight.current || view === null || state !== 'ready') return;
    inFlight.current = true;
    setBusy(true);
    try {
      await acceptViewSuggestion({ database, view, placeOn });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      data-testid="action-card"
      data-tool={tool.name}
      data-renderer="view"
      data-status="done"
      data-write="false"
      className="my-1 overflow-hidden rounded-lg border border-n-200 bg-n-0"
    >
      <section data-testid="view-suggestion-card" data-state={state} className="space-y-2 p-3">
        <div className="text-xs font-medium text-n-800">Suggested view</div>
        {suggestion !== null && (
          <div className="text-2xs text-n-500">
            {humanize(suggestion.view.presentation.type)} · {database}
          </div>
        )}
        {suggestion?.reasoning !== undefined && (
          <p className="line-clamp-3 text-xs text-n-600">{suggestion.reasoning}</p>
        )}
        {state === 'unavailable' ? (
          <p className="text-xs text-n-500">
            {surface?.unavailable?.message ?? "This suggestion can't be shown any more. Ask again if you still want it."}
          </p>
        ) : state === 'gone' ? (
          <p className="text-xs text-n-500">{database} is gone, so this view has nowhere to go.</p>
        ) : state === 'problems' ? (
          <div className="text-xs text-n-600">
            <p>This view no longer fits {database}.</p>
            {problems.map((problem, index) => (
              <p key={index}>{describeViewProblem(problem, database)}</p>
            ))}
          </div>
        ) : (
          <>
            {state === 'added' && <p className="text-xs text-n-700">Added as “{saved!.name}”</p>}
            <div className="text-2xs text-n-500">
              Live preview · {surface?.entries.length ?? 0} of {all} records
            </div>
            <div
              data-testid="view-suggestion-preview"
              className="h-[260px] overflow-auto rounded-md border border-n-200"
              onPointerDownCapture={stop}
              onClickCapture={stop}
              onKeyDownCapture={stop}
              onDragStartCapture={stop}
            >
              {/* The frame owns scrolling. Nested canvas scrollers cannot receive
                  a wheel through an inert subtree, so their overflow expands
                  into this one scrollable preview instead. */}
              <div
                inert
                className="pointer-events-none min-h-full [&_.overflow-auto]:overflow-visible [&_.overflow-x-auto]:overflow-visible [&_.overflow-y-auto]:overflow-visible [&_[data-testid=board-view]]:w-max"
              >
                {surface !== null && (
                  <ViewCanvas
                    unavailable={surface.unavailable}
                    entries={surface.entries}
                    allEntries={entries}
                    presentation={surface.presentation}
                    schema={schema}
                    fields={fields}
                    scope={`suggestion:${tool.id}`}
                    filtered={view?.filters !== null}
                    embedded
                  />
                )}
              </div>
            </div>
          </>
        )}
        {state !== 'unavailable' && state !== 'gone' && (
          <div className="flex flex-wrap gap-2">
            {state !== 'added' && (
              <>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy || state !== 'ready'}
                  onClick={() => void add()}
                >
                  Add as a tab
                </button>
                {openPage !== undefined && (
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy || state !== 'ready'}
                    onClick={() => void add(openPage.path)}
                  >
                    Add and place on “{openPage.title}”
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className={BUTTON}
              onClick={() =>
                useNavStore.getState().navigate({
                  kind: 'type',
                  name: database,
                  ...(saved === undefined ? {} : { view: saved.id }),
                })
              }
            >
              Open {database}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
