import { navSeed } from '@/test/navSeed';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Selection } from '@/engine/types';
import { useNavStore } from './navStore';
import { useOpenLogStore } from './openLogStore';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';

function reset() {
  useNavStore.getState().setLiveCheck(null);
  useNavStore.getState().reset();
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [navSeed({ kind: 'home' })],
    historyIndex: 0,
  });
  useUiStore.setState({ detailPath: null, diffView: null });
}

describe('navStore', () => {
  beforeEach(reset);

  it('starts at home with a one-entry history', () => {
    const s = useNavStore.getState();
    expect(s.selection).toEqual({ kind: 'home' });
    expect(s.history.map((slot) => slot.selection)).toEqual([{ kind: 'home' }]);
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
    expect(s.history.map((slot) => slot.selection)).toEqual([
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

    it('a doc selection keeps its tab through a rename (M44.5)', () => {
      const { navigate, replacePath } = useNavStore.getState();
      navigate({ kind: 'doc', path: 'a.md', tab: 'spec' });
      replacePath('a.md', 'b.md');
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'b.md',
        tab: 'spec',
      });
    });

    it('a doc selection keeps its focused comment thread through a rename (M70.2b)', () => {
      const { navigate, replacePath } = useNavStore.getState();
      navigate({ kind: 'doc', path: 'notes/a.md', thread: '0123456789abcdef' });
      replacePath('notes', 'archive');
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'archive/a.md',
        thread: '0123456789abcdef',
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
      expect(s.history[1].selection).toEqual({ kind: 'collection', folder: 'work/shipping' });
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

  // The deepEqual hoist (M45.3) counts an explicitly-undefined key as a key,
  // so `{kind:'doc', path, tab: undefined}` compares UNEQUAL to the
  // spread-free literal and would mint a phantom history step. navigate()
  // strips undefined-valued keys at the door: absent and explicitly
  // undefined spell the same place.
  it('an explicitly-undefined optional key is still the same place — no history step', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'a.md' });
    navigate({ kind: 'doc', path: 'a.md', tab: undefined } as Selection);
    const s = useNavStore.getState();
    expect(s.history).toHaveLength(2);
    expect(s.historyIndex).toBe(1);
    // The stored selection is the stripped shape — no undefined-valued key
    // survives to poison a LATER compare from the other direction.
    expect('tab' in s.selection).toBe(false);
  });

  // M70.2b — a thread is a place the back button returns to: focusing another
  // thread of the same page is a step, and Back lands on the one before.
  it('navigating to another comment thread of the same page is a history step', () => {
    const { navigate, back } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'a.md' });
    navigate({ kind: 'doc', path: 'a.md', thread: '1111111111111111' });
    navigate({ kind: 'doc', path: 'a.md', thread: '2222222222222222' });
    expect(useNavStore.getState().history).toHaveLength(4);
    back();
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'a.md',
      thread: '1111111111111111',
    });
    back();
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
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

  it('a replace writes over the current slot, so Back skips the forwarder (M55.12)', () => {
    const a: Selection = { kind: 'agents' };
    const b: Selection = { kind: 'agents', actor: 'process:release-scout' };
    const c: Selection = { kind: 'doc', path: 'records/agents/release-scout.md' };
    useNavStore.setState({ selection: a, history: [navSeed(a)], historyIndex: 0 });
    useUiStore.setState({ detailPath: 'records/risks/x.md' });
    const { navigate, back } = useNavStore.getState();
    navigate(b);
    navigate(c, { replace: true });
    let s = useNavStore.getState();
    expect(s.history.map((slot) => slot.selection)).toEqual([a, c]);
    expect(s.historyIndex).toBe(1);
    expect(s.selection).toEqual(c);
    // It is still a surface change: what belonged to the last surface goes.
    expect(useUiStore.getState().detailPath).toBeNull();
    back();
    s = useNavStore.getState();
    expect(s.selection).toEqual(a);
    expect(s.historyIndex).toBe(0);
  });
});

/**
 * The open log hears a person's page opens and nothing else (M59.3).
 */
describe('navStore and the open log', () => {
  const logged = (vault = '/v') =>
    (useOpenLogStore.getState().logs[vault] ?? []).map((r) => [r.path, r.count]);

  beforeEach(() => {
    reset();
    useVaultStore.setState({ vaultPath: '/v' });
    useOpenLogStore.setState({ logs: {}, saved: true });
  });

  it('records one open for a page navigate, doc or diagram', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'a.md' });
    navigate({ kind: 'diagram', path: 'd.mmd' });
    expect(logged()).toEqual([
      ['d.mmd', 1],
      ['a.md', 1],
    ]);
  });

  it('records two library pages as two opens', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'library', tab: 'skill', path: 'skills/a.md' });
    navigate({ kind: 'library', tab: 'skill', path: 'skills/b.md' });
    navigate({ kind: 'library', tab: 'skill' });
    expect(logged()).toEqual([
      ['skills/b.md', 1],
      ['skills/a.md', 1],
    ]);
  });

  it('records nothing for a same-place navigate, a tab or thread switch, or a non-page', () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'a.md' });
    navigate({ kind: 'doc', path: 'a.md' });
    navigate({ kind: 'doc', path: 'a.md', tab: 'spec' });
    navigate({ kind: 'doc', path: 'a.md', thread: '1111111111111111' });
    navigate({ kind: 'collection', folder: 'projects' });
    navigate({ kind: 'settings' });
    expect(logged()).toEqual([['a.md', 1]]);
  });

  it('records nothing for an agent move, a replace it starts, or Back and Forward', () => {
    const { navigate, back, forward } = useNavStore.getState();
    navigate({ kind: 'doc', path: 'agent.md' }, { byAgent: true });
    navigate({ kind: 'agents', actor: 'process:x' }, { byAgent: true });
    navigate({ kind: 'doc', path: 'records/agents/x.md' }, { replace: true });
    back();
    forward();
    expect(logged()).toEqual([]);
  });

  it("logs exactly one open when {agents, actor} forwards to the agent's page", () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'agents', actor: 'process:x' });
    navigate({ kind: 'doc', path: 'records/agents/x.md' }, { replace: true });
    expect(logged()).toEqual([['records/agents/x.md', 1]]);
  });

  it("logs one open when a library agent path forwards to the agent's page", () => {
    const { navigate } = useNavStore.getState();
    navigate({ kind: 'library', tab: 'agent', path: 'records/agents/x.md' });
    navigate({ kind: 'doc', path: 'records/agents/x.md' }, { replace: true });
    expect(logged()).toEqual([['records/agents/x.md', 1]]);
  });

  it('records nothing with no vault open', () => {
    useVaultStore.setState({ vaultPath: null });
    useNavStore.getState().navigate({ kind: 'doc', path: 'a.md' });
    expect(useOpenLogStore.getState().logs).toEqual({});
  });

  it('replacePath only changes navigation; the shared hook owns recent pointers', () => {
    const log = useOpenLogStore.getState();
    log.record('/v', 'docs/old.md');
    log.record('/v', 'docs/old/page.md');
    log.record('/w', 'docs/old/page.md');
    useNavStore.getState().replacePath('docs/old', 'docs/new');
    expect(logged().map(([p]) => p)).toEqual(['docs/old/page.md', 'docs/old.md']);
    expect(logged('/w').map(([p]) => p)).toEqual(['docs/old/page.md']);
    useNavStore.getState().replacePath('docs/old.md', 'docs/renamed.md');
    expect(logged().map(([p]) => p)).toEqual(['docs/old/page.md', 'docs/old.md']);
  });
});

it('captures the visit being left and keeps entry-state changes off the navigation sequence', () => {
  reset();
  const nav = useNavStore.getState();
  const seq = nav.navSeq;
  nav.setEntryState('view.search', 'old');
  expect(useNavStore.getState().navSeq).toBe(seq);
  const release = nav.registerEntryCaptor('canvas.scroll', () => ({ top: 300, left: 10 }));
  nav.navigate({ kind: 'settings' });
  expect(useNavStore.getState().history[0].state).toEqual({
    'view.search': 'old',
    'canvas.scroll': { top: 300, left: 10 },
  });
  expect(useNavStore.getState().navSeq).toBe(seq + 1);
  release();
  nav.back();
  expect(nav.readEntryState('view.search')).toBe('old');
  nav.navigate({ kind: 'pulse' }, { replace: true });
  expect(nav.readEntryState('view.search')).toBeUndefined();
  expect(useNavStore.getState().navSeq).toBe(seq + 3);
});
it('only the last captor wins, undefined deletes its key, and rename preserves state', () => {
  reset();
  const nav = useNavStore.getState();
  nav.navigate({ kind: 'doc', path: 'a.md' });
  nav.setEntryState('view.search', 'keep');
  const older = nav.registerEntryCaptor('view.controls', () => true);
  const newer = nav.registerEntryCaptor('view.controls', () => undefined);
  older();
  nav.replacePath('a.md', 'b.md');
  expect(nav.readEntryState('view.search')).toBe('keep');
  nav.navigate({ kind: 'settings' });
  expect(useNavStore.getState().history[1].state).toEqual({ 'view.search': 'keep' });
  newer();
});
it('Back and Forward drop dead slots and reset keeps one Home visit', () => {
  reset();
  const nav = useNavStore.getState();
  for (const path of ['x.md', 'dead.md', 'y.md']) nav.navigate({ kind: 'doc', path });
  nav.setLiveCheck((selection) => selection.kind !== 'doc' || selection.path !== 'dead.md');
  nav.back();
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'x.md' });
  expect(useNavStore.getState().history).toHaveLength(3);
  nav.forward();
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'y.md' });
  nav.reset();
  expect(useNavStore.getState().history).toEqual([navSeed({ kind: 'home' })]);
  nav.setLiveCheck(null);
});
it('restoring a last place is not recorded as a person opening the page', () => {
  reset();
  useVaultStore.setState({ vaultPath: '/history-restore' });
  useOpenLogStore.getState().clear('/history-restore');
  useNavStore.getState().navigate({ kind: 'doc', path: 'a.md' }, { replace: true, restore: true });
  expect(useOpenLogStore.getState().logs['/history-restore'] ?? []).toEqual([]);
});

describe('page panes (M65.8)', () => {
  beforeEach(() => {
    reset();
    useNavStore.getState().setPaneCapacity(4);
  });
  it('opening a held file activates its pane', () => {
    const first = useNavStore.getState().active;
    useNavStore.getState().navigate({ kind: 'doc', path: 'a.md' });
    const second = useNavStore.getState().openPane({ kind: 'doc', path: 'b.md' }).pane;
    useUiStore.setState({ toasts: [] });
    const reuse = useNavStore.getState().navigateIn(first, { kind: 'doc', path: 'b.md' });
    expect(reuse).toEqual({ kind: 'reused', pane: second });
    expect(useNavStore.getState().paneIds).toHaveLength(2);
    expect(useNavStore.getState().active).toBe(second);
    expect(useNavStore.getPaneState(first).selection).toEqual({ kind: 'doc', path: 'a.md' });
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Already open in another pane.');
    useUiStore.setState({ toasts: [] });
    useNavStore.getState().navigateIn(first, { kind: 'doc', path: 'b.md' }, { byAgent: true });
    expect(useUiStore.getState().toasts).toEqual([]);
  });
  it('Work and Inbox reuse and Back skips held visits until they are released', () => {
    const first = useNavStore.getState().active;
    useNavStore.getState().navigate({ kind: 'inbox' });
    useNavStore.getState().navigate({ kind: 'workspace', root: 'first' });
    const second = useNavStore.getState().openPane({ kind: 'inbox' }).pane;
    useNavStore.getState().back(first);
    expect(useNavStore.getPaneState(first).selection).toEqual({ kind: 'home' });
    expect(useNavStore.getPaneState(first).history.map((slot) => slot.selection.kind)).toEqual([
      'home',
      'inbox',
      'workspace',
    ]);
    useNavStore.getState().navigateIn(first, { kind: 'workspace', root: 'second' });
    expect(useNavStore.getState().openPane({ kind: 'workspace', root: 'third' }).pane).toBe(first);
    useNavStore.getState().closePane(second);
    useNavStore.getState().back();
    expect(useNavStore.getState().selection).toEqual({ kind: 'workspace', root: 'second' });
  });
  it('a peek belongs to its pane, a diff survives another holder, and stepping skips held files', () => {
    const first = useNavStore.getState().active;
    useNavStore.getState().navigate({ kind: 'doc', path: 'a.md' });
    const second = useNavStore.getState().openPane({ kind: 'settings' }).pane;
    useUiStore.getState().setDetailSiblings(['one.md', 'a.md', 'two.md'], second);
    useNavStore.getState().openPeek('one.md', { from: second });
    useUiStore.getState().openDiff('a.md');
    useNavStore.getState().navigateIn(first, { kind: 'doc', path: 'a.md', tab: 'details' });
    expect(useUiStore.getState().detailPath).toBe('one.md');
    useNavStore.getState().stepPeek(1);
    expect(useUiStore.getState().detailPath).toBe('two.md');
    useUiStore.getState().openDiff('a.md');
    useNavStore.getState().navigateIn(second, { kind: 'home' });
    expect(useUiStore.getState().detailPath).toBeNull();
    expect(useUiStore.getState().diffView?.path).toBe('a.md');
    useNavStore.getState().openPeek('a.md', { from: second });
    expect(useUiStore.getState().detailPath).toBeNull();
    expect(useNavStore.getState().active).toBe(first);
  });
  it('captors and rename state stay with each pane; a reuse records exactly one person open', () => {
    const first = useNavStore.getState().active;
    useVaultStore.setState({ vaultPath: '/v' });
    useOpenLogStore.setState({ logs: {}, saved: true });
    useNavStore.getState().navigate({ kind: 'doc', path: 'old/a.md' });
    useNavStore
      .getState()
      .registerEntryCaptor('canvas.scroll', () => ({ top: 30, left: 0 }), first);
    const second = useNavStore.getState().openPane({ kind: 'doc', path: 'old/b.md' }).pane;
    useNavStore.getState().setEntryState('view.search', 'b', second);
    useNavStore.getState().navigateIn(second, { kind: 'doc', path: 'old/a.md' });
    expect(
      useOpenLogStore.getState().logs['/v'].find((row) => row.path === 'old/a.md')?.count,
    ).toBe(2);
    useNavStore.getState().replacePath('old', 'new');
    expect(useNavStore.getPaneState(first).selection).toEqual({ kind: 'doc', path: 'new/a.md' });
    expect(useNavStore.getPaneState(second).selection).toEqual({ kind: 'doc', path: 'new/b.md' });
    expect(useNavStore.getPaneState(second).readEntryState('view.search')).toBe('b');
    expect(useNavStore.getPaneState(first).readEntryState('canvas.scroll')).toEqual({
      top: 30,
      left: 0,
    });
  });
  it('the peek never shows a file a pane shows', () => {
    let seed = 43;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let at = 0; at < 2000; at++) {
      const state = useNavStore.getState();
      const path = `${next() % 5}.md`;
      const pane = state.paneIds[next() % state.paneIds.length];
      switch (next() % 5) {
        case 0:
          state.openPeek(path, { from: pane, byAgent: true });
          break;
        case 1:
          state.navigateIn(pane, { kind: 'doc', path }, { byAgent: true });
          break;
        case 2:
          state.openPane({ kind: 'doc', path }, { from: pane, byAgent: true });
          break;
        case 3:
          state.closePane(pane);
          break;
        case 4:
          state.back(pane);
          break;
      }
      const shown = useUiStore.getState().detailPath;
      if (shown !== null)
        for (const id of useNavStore.getState().paneIds) {
          const selection = useNavStore.getPaneState(id).selection;
          expect('path' in selection ? selection.path : null).not.toBe(shown);
        }
    }
  });
});

it('restoreLayout mints fresh ids, restores each cursor, and closes overlays', () => {
  useNavStore.getState().reset();
  const before = useNavStore.getState().seq;
  useUiStore.getState().openDetail('peek.md');
  useNavStore.getState().restoreLayout({
    v: 1,
    active: 1,
    panes: [
      { index: 0, entries: [{ kind: 'doc', path: 'a.md' }, { kind: 'settings' }] },
      { index: 0, entries: [{ kind: 'doc', path: 'b.md' }] },
    ],
  });
  const nav = useNavStore.getState();
  expect(nav.paneIds).toEqual([`p${before + 1}`, `p${before + 2}`]);
  expect(nav.active).toBe(nav.paneIds[1]);
  expect(useNavStore.getPaneState(nav.paneIds[0]).historyIndex).toBe(0);
  expect(useNavStore.getPaneState(nav.paneIds[0]).history).toHaveLength(2);
  expect(useUiStore.getState().detailPath).toBeNull();
  expect(useUiStore.getState().diffView).toBeNull();
});
