import { useRef } from 'react';
import { useListCursor } from '@/hooks/useListCursor';
import { useCommands } from '@/lib/keys/useKeys';
import { ListSelectionBar } from '@/components/ListSelectionBar';
import type { HomeRow } from '@/engine/homeLanes';
import { HomeCursorContext } from './homeCursor';
import { useHomeDone } from './useHomeDone';
import { toIsoDate } from '@/engine/dates';
import { bandContext } from '@/engine/dateBuckets';
import { HOME_LANES, type HomeLaneId } from '@/engine/homeLanes';
import { CapturesLane } from './CapturesLane';
import { ComingUpLane } from './ComingUpLane';
import { EditsLane } from './EditsLane';
import { ChangesLane } from './ChangesLane';
import { RemindersLane } from './RemindersLane';
import { RunsLane } from './RunsLane';
import { MyWorkLane } from './MyWorkLane';
import { ProposalsLane } from './ProposalsLane';
import { useHomeClock } from './useHomeClock';

export const HOME_COMPONENTS = {
  mywork: MyWorkLane,
  proposals: ProposalsLane,
  captures: CapturesLane,
  runs: RunsLane,
  reminders: RemindersLane,
  changes: ChangesLane,
  edits: EditsLane,
  comingup: ComingUpLane,
};
export function HomeLanes({ only }: { only?: HomeLaneId }) {
  const container = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<string, HomeRow>());
  const done = useHomeDone();
  const cursor = useListCursor({
    keys: () =>
      [...(container.current?.querySelectorAll<HTMLElement>('[data-cursor-key]') ?? [])].map(
        (row) => row.dataset.cursorKey!,
      ),
    selectable: true,
  });
  const targets = () => {
    const keys = cursor.state.selected.size
      ? [...cursor.state.selected]
      : cursor.state.focus
        ? [cursor.state.focus]
        : [];
    return keys
      .filter((key) => cursor.keys().includes(key) && cursor.action(key)?.done)
      .flatMap((key) => {
        const row = rows.current.get(key);
        return row ? [row] : [];
      });
  };
  useCommands([
    {
      id: 'home.done',
      when: () => done.ready && targets().length > 0,
      run: () => {
        const items = targets();
        if (cursor.state.selected.size) void done.doneMany(items);
        else if (items[0]) void done.done(items[0]);
      },
    },
  ]);
  const now = useHomeClock();
  const ctx = { ...bandContext(), today: toIsoDate(now) };
  return (
    <HomeCursorContext.Provider value={{ cursor, rows: rows.current, done }}>
      <div
        {...cursor.containerProps}
        ref={(element) => {
          container.current = element;
          cursor.containerProps.ref(element);
        }}
        role="listbox"
        aria-label="Home lanes"
        className="cb-home-lanes"
      >
        {HOME_LANES.map(({ id }) => {
          if (only !== undefined && only !== id) return null;
          const Component = HOME_COMPONENTS[id];
          return <Component key={id} now={now} ctx={ctx} />;
        })}
        <ListSelectionBar count={cursor.state.selected.size} doneHint />
      </div>
    </HomeCursorContext.Provider>
  );
}
