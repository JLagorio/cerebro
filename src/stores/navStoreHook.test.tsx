import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PaneContext, useNavStore, usePaneId, type PaneId } from './navStore';
import { useEntryState } from '@/app/useEntryState';
function Page({ label }: { label: string }) {
  const selection = useNavStore((state) => state.selection);
  const navigate = useNavStore((state) => state.navigate);
  const pane = usePaneId();
  const [search, setSearch] = useEntryState('view.search', '');
  return (
    <div>
      <span data-testid={label}>
        {pane}:{selection.kind}
      </span>
      <input
        aria-label={label}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <button onClick={() => navigate({ kind: 'settings' })}>{label} go</button>
    </div>
  );
}
beforeEach(() => {
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
});
afterEach(() => {
  cleanup();
  useNavStore.getState().reset();
});
it('inside p reads and moves p while q is focused; outside reads the focused pane', () => {
  const first = useNavStore.getState().active;
  const second = useNavStore.getState().openPane({ kind: 'mywork' }).pane;
  render(
    <>
      <PaneContext value={first}>
        <Page label="first" />
      </PaneContext>
      <PaneContext value={second}>
        <Page label="second" />
      </PaneContext>
      <Page label="global" />
    </>,
  );
  expect(screen.getByTestId('first').textContent).toBe(`${first}:home`);
  expect(screen.getByTestId('global').textContent).toBe(`${second}:mywork`);
  fireEvent.change(screen.getByLabelText('first'), { target: { value: 'first search' } });
  expect(useNavStore.getPaneState(first).readEntryState('view.search')).toBe('first search');
  expect(useNavStore.getState().readEntryState('view.search')).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'first go' }));
  expect(useNavStore.getState().active).toBe(first);
  expect(screen.getByTestId('second').textContent).toBe(`${second}:mywork`);
  expect(screen.getByTestId('global').textContent).toBe(`${first}:settings`);
  act(() => useNavStore.getState().back(first));
  expect((screen.getByLabelText('first') as HTMLInputElement).value).toBe('first search');
});
it('selector results and pane actions stay equal across focus changes', () => {
  const first = useNavStore.getState().active;
  const second = useNavStore.getState().openPane({ kind: 'settings' }).pane;
  const values: unknown[] = [];
  const actions: unknown[] = [];
  function Probe() {
    values.push(useNavStore((state) => state.history));
    actions.push(useNavStore((state) => state.navigate));
    return null;
  }
  const mounted = render(
    <PaneContext value={first}>
      <Probe />
    </PaneContext>,
  );
  const history = values[0];
  const action = actions[0];
  for (const id of [first, second, first] satisfies PaneId[]) {
    act(() => useNavStore.getState().focusPane(id));
    mounted.rerender(
      <PaneContext value={first}>
        <Probe />
      </PaneContext>,
    );
  }
  expect(values.every((value) => value === history)).toBe(true);
  expect(actions.every((value) => value === action)).toBe(true);
});
