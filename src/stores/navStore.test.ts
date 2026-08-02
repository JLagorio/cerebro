import { beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from './navStore';

function reset() {
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [{ kind: 'home' }],
    historyIndex: 0,
  });
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
