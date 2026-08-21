import { beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from './navStore';
import { useUiStore } from './uiStore';

function reset() {
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [{ kind: 'home' }],
    historyIndex: 0,
  });
  useUiStore.setState({ detailPath: null, diffView: null });
}

describe('navStore', () => {
  beforeEach(reset);

  it('starts at home with a one-entry history', () => {
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'home' });
    expect(s.history).toEqual([{ kind: 'home' }]);
    expect(s.historyIndex).toBe(0);
  });

  it('navigate pushes onto history and moves the index', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'list', id: 'all-items' });
    navigate({ kind: 'collection', folder: 'projects/foundations' });
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'collection', folder: 'projects/foundations' });
    expect(s.history).toHaveLength(3);
    expect(s.historyIndex).toBe(2);
  });

  it('navigate after back truncates the forward stack', () => {
    const { navigate, back, forward } = useNavStore.getState();
    navigate({ kind: 'list', id: 'all-items' });
    navigate({ kind: 'collection', folder: 'projects/foundations' });
    back();
    navigate({ kind: 'settings' });
    const s = useNavStore.getState();
    expect(s.history).toEqual([
      { kind: 'home' },
      { kind: 'list', id: 'all-items' },
      { kind: 'settings' },
    ]);
    expect(s.historyIndex).toBe(2);
    forward(); // nothing ahead — must be a no-op
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  });

  it('back clamps at the start of history', () => {
    const { back } = useNavStore.getState();
    back();
    back();
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'home' });
    expect(s.historyIndex).toBe(0);
  });

  // M15: the record panel is scoped to the surface that opened it. It used to
  // follow the user onto Docs, Inbox, Knowledge, Settings and Pulse, where it
  // was the visually dominant element and read as the page itself.
  describe('surface-scoped panels', () => {
    it('navigate closes the record panel and the inline diff', () => {
      useUiStore.setState({ detailPath: 'records/bets/office-hours.md' });
      useUiStore.getState().openDiff('docs/plan.md');
      useNavStore.getState().navigate({ kind: 'pulse' });
      expect(useUiStore.getState().detailPath).toBeNull();
      expect(useUiStore.getState().diffView).toBeNull();
    });

    it('keepDetail is the opt-out the panel breadcrumb needs', () => {
      useUiStore.setState({ detailPath: 'records/bets/office-hours.md' });
      useNavStore
        .getState()
        .navigate({ kind: 'collection', folder: 'projects/field-app' }, { keepDetail: true });
      expect(useUiStore.getState().detailPath).toBe('records/bets/office-hours.md');
    });

    it('back and forward clear the panel too', () => {
      const { navigate, back, forward } = useNavStore.getState();
      navigate({ kind: 'pulse' });
      useUiStore.setState({ detailPath: 'records/bets/office-hours.md' });
      back();
      expect(useUiStore.getState().detailPath).toBeNull();
      useUiStore.setState({ detailPath: 'records/bets/office-hours.md' });
      forward();
      expect(useUiStore.getState().detailPath).toBeNull();
    });

    it('a no-op back at the start of history leaves the panel alone', () => {
      useUiStore.setState({ detailPath: 'records/bets/office-hours.md' });
      useNavStore.getState().back();
      expect(useUiStore.getState().detailPath).toBe('records/bets/office-hours.md');
    });
  });

  describe('replacePath — following a file that moved (M15)', () => {
    it('rewrites the open selection and the history entry behind it', () => {
      const { navigate, replacePath, back } = useNavStore.getState();
      navigate({ kind: 'doc', path: 'notes/capture.md' });
      navigate({ kind: 'pulse' });
      // "Add page" grows the single file into a folder-note doc.
      replacePath('notes/capture.md', 'notes/capture/capture.md');
      back();
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'notes/capture/capture.md',
      });
    });

    it('carries descendants when a folder moves', () => {
      const { navigate, replacePath } = useNavStore.getState();
      navigate({ kind: 'doc', path: 'notes/trip/day-one.md' });
      replacePath('notes/trip', 'archive/trip');
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'archive/trip/day-one.md',
      });
    });

    it('rewrites collection folders and knowledge deep-links too', () => {
      const { navigate, replacePath } = useNavStore.getState();
      navigate({ kind: 'collection', folder: 'work/delivery' });
      navigate({ kind: 'knowledge', path: 'knowledge/work/delivery/c-1.md' });
      replacePath('work/delivery', 'work/shipping');
      const s = useNavStore.getState();
      expect(s.history[1]).toEqual({ kind: 'collection', folder: 'work/shipping' });
      // The knowledge path is not under the moved folder — untouched.
      expect(s.selection).toEqual({ kind: 'knowledge', path: 'knowledge/work/delivery/c-1.md' });
    });

    it('leaves an unrelated path alone, including a same-prefix sibling', () => {
      const { navigate, replacePath } = useNavStore.getState();
      navigate({ kind: 'doc', path: 'notes/trip-report.md' });
      replacePath('notes/trip', 'archive/trip');
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'notes/trip-report.md',
      });
    });
  });

  // Renames repair history and then re-open the moved page, which would
  // otherwise leave two identical adjacent entries and a Back that does nothing.
  it('navigating to the current selection is not a history step', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'notes/a.md' });
    navigate({ kind: 'doc', path: 'notes/a.md' });
    const s = useNavStore.getState();
    expect(s.history).toHaveLength(2);
    expect(s.historyIndex).toBe(1);
    s.back();
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });

  it('still drops surface state when navigating to where you already are', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'notes/a.md' });
    useUiStore.setState({ detailPath: 'records/bets/office-hours.md' });
    navigate({ kind: 'doc', path: 'notes/a.md' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('back and forward walk the history', () => {
    const { navigate, back, forward } = useNavStore.getState();
    navigate({ kind: 'list', id: 'all-items' });
    back();
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    forward();
    expect(useNavStore.getState().selection).toEqual({ kind: 'list', id: 'all-items' });
    forward(); // at the tip — no-op
    expect(useNavStore.getState().historyIndex).toBe(1);
  });
});
