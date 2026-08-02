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
      useNavStore.getState().navigate({ kind: 'docs' });
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
      navigate({ kind: 'docs' });
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
