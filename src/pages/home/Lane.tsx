import { StateMessage } from '@/components/ui/StateMessage';
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
import './home.css';

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
    <section
      data-testid="home-lane"
      data-lane={id}
      data-state={state}
      className="cb-home-lane min-w-0"
    >
      <div className="cb-home-lane-heading">
        <h2 className="m-0 text-lg font-semibold tracking-[-0.005em]">{definition.label}</h2>
        {!unavailable && (
          <span data-testid="home-lane-line" className="cb-home-lane-meta">
            {data.line}
          </span>
        )}
        <button type="button" onClick={onDoor} className="cb-home-lane-door">
          {door}
        </button>
      </div>
      {unavailable ? (
        <StateMessage state="unavailable" title={`${definition.label} could not be read`}>
          Nothing here is a statement about this vault.
        </StateMessage>
      ) : (
        <>
          {controls}
          {data.notes.map((note) => (
            <p key={note} data-testid="home-lane-note" className="mb-2 text-xs text-(--text-meta)">
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
                <h3 className="cb-home-section-heading">{section.label}</h3>
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
                      className="cb-home-row rounded-md outline-none"
                      onClick={(event) => {
                        if (event.target === event.currentTarget) props?.onClick();
                      }}
                    >
                      {renderRow?.(row) ?? (
                        <button
                          type="button"
                          className="cb-home-row-link flex w-full min-w-0 items-center gap-3 rounded-md border-0 bg-transparent text-left hover:bg-n-50"
                          onClick={openRow}
                        >
                          <span className="min-w-0 flex-1 truncate text-ui text-n-800">
                            {row.title}
                          </span>
                          {row.detail && (
                            <span className="max-w-[45%] truncate text-metadata text-(--text-meta)">
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
              className="mt-1 border-0 bg-transparent p-1.5 text-xs text-(--text-meta) hover:text-cortex-600"
            >
              Show all {data.rows.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
