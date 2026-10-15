import { useContext, useState, type ReactNode } from 'react';
import { HomeCursorContext } from './homeCursor';
import { useOpenPath } from '@/app/useOpenPath';
import {
  HOME_LANES,
  laneView,
  ROW_CAP,
  type HomeLaneId,
  type HomeRow,
  type LaneData,
  type LaneState,
} from '@/engine/homeLanes';
import type { HomeSection } from '@/engine/homeSections';
import { useNavStore } from '@/stores/navStore';

export function Lane({
  id,
  state,
  data,
  sections,
  door,
  onDoor,
  controls,
  renderRow,
  onOpenRow,
}: {
  id: HomeLaneId;
  state: LaneState;
  data: LaneData;
  sections: HomeSection<HomeRow>[];
  door: string;
  onDoor: () => void;
  controls?: ReactNode;
  renderRow?: (row: HomeRow) => ReactNode;
  onOpenRow?: (row: HomeRow) => void;
}) {
  const home = useContext(HomeCursorContext);
  const [all, setAll] = useState(false);
  const open = useOpenPath();
  const view = laneView(state, data);
  if (view === null) return null;
  const definition = HOME_LANES.find((lane) => lane.id === id)!;
  const unavailable = state === 'unavailable';
  const visible = new Set(
    sections
      .flatMap((section) => section.rows)
      .slice(0, all ? Infinity : ROW_CAP)
      .map((row) => row.subject),
  );
  return (
    <section data-testid="home-lane" data-lane={id} data-state={state} className="mb-7 min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 text-lg font-semibold tracking-[-0.005em]">{definition.label}</h2>
        {!unavailable && (
          <span
            data-testid="home-lane-line"
            className="text-xs text-n-500 [font-family:var(--font-mono)]"
          >
            {data.line}
          </span>
        )}
        <button
          type="button"
          onClick={onDoor}
          className="ml-auto border-0 bg-transparent p-0 text-xs text-n-500 hover:text-cortex-600"
        >
          {door}
        </button>
      </div>
      {unavailable ? (
        <p data-testid="section-unavailable" className="m-0 text-sm text-n-500">
          {definition.label} could not be read, so nothing here is a statement about this vault.
        </p>
      ) : (
        <>
          {controls}
          {data.notes.map((note) => (
            <p key={note} data-testid="home-lane-note" className="mb-2 text-xs text-n-500">
              {note}
            </p>
          ))}
          {sections.map((section) => {
            const rows = section.rows.filter((row) => visible.has(row.subject));
            if (rows.length === 0) return null;
            return (
              <div
                key={section.key}
                data-testid="home-section"
                data-section={section.key}
                className="mb-2"
              >
                <h3 className="mb-1 mt-3 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
                  {section.label}
                </h3>
                {rows.map((row) => {
                  const key = `${id}:${row.subject}`;
                  const openRow = () => {
                    if (onOpenRow) onOpenRow(row);
                    else if (row.review || row.path === null)
                      useNavStore
                        .getState()
                        .navigate({ kind: 'knowledge', nav: { tab: 'review' } });
                    else open(row.path);
                  };
                  home?.rows.set(key, row);
                  const props = home?.cursor.itemProps(key, {
                    open: onOpenRow || row.path !== null || row.review ? openRow : undefined,
                    done: row.done && home.done.ready ? () => void home.done.done(row) : undefined,
                  });
                  return (
                    <div
                      key={row.subject}
                      data-testid="home-row"
                      data-subject={row.subject}
                      data-kind={definition.kind}
                      {...props}
                      role={home ? 'option' : undefined}
                      className="rounded-md outline-none data-[focused=true]:bg-cortex-50 data-[focused=true]:shadow-[inset_2px_0_0_var(--cortex-500)] aria-selected:bg-cortex-50"
                      onClick={(event) => {
                        if (event.target === event.currentTarget) props?.onClick();
                      }}
                    >
                      {renderRow?.(row) ?? (
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-baseline gap-3 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left hover:bg-n-50"
                          onClick={openRow}
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-n-800">
                            {row.title}
                          </span>
                          {row.detail && (
                            <span className="max-w-[45%] truncate text-xs text-n-500">
                              {row.detail}
                            </span>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!all && data.rows.length > ROW_CAP && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="mt-1 border-0 bg-transparent p-1.5 text-xs text-n-500 hover:text-cortex-600"
            >
              Show all {data.rows.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
