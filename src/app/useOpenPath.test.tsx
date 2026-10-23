import { withOpenBesideIntent } from './openIntent';
import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { useOpenPath } from './useOpenPath';

describe('useOpenPath .mmd routing (M29.21)', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useVaultStore.setState({ entries: [] });
  });

  it('routes an unscanned .canvas to the board page selection', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('boards/plan.canvas'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'diagram',
      path: 'boards/plan.canvas',
    });
  });

  it('routes a .mmd to the diagram page', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('diagrams/pipeline.mmd'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'diagram',
      path: 'diagrams/pipeline.mmd',
    });
  });

  // The extension decides BEFORE the entry lookup: a just-created .mmd the
  // scanner has not adopted yet must never fall into the doc canvas, which
  // would edit raw mermaid as markdown.
  it('routes an unscanned .mmd to the diagram page too, never the doc canvas', () => {
    useVaultStore.setState({ entries: [] });
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('diagrams/brand-new.mmd'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'diagram',
      path: 'diagrams/brand-new.mmd',
    });
  });

  it('still routes an unknown .md to the doc canvas', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('notes/loose.md'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/loose.md' });
  });
  it.each(['attachments/brief.pdf', 'attachments/poster.png', 'attachments/notes.txt'])(
    'opens %s as a file page without a scanned entry',
    (path) => {
      const { result } = renderHook(() => useOpenPath());
      act(() => result.current(path));
      expect(useNavStore.getState().selection).toEqual({ kind: 'file', path });
    },
  );
});

/*
 * A container's page IS its collection (M47.5). Routed as a record it opened a
 * `Collection` type screen that exists nowhere else, listing the container as
 * a row, with a detail peek on top.
 */
describe('useOpenPath collection pages (M48.7)', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
  });

  it('opens a folder note that declares a Collection as that collection', () => {
    useVaultStore.setState({
      entries: [makeEntry({ path: 'delivery/delivery.md', title: 'Delivery', type: 'Collection' })],
    });
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('delivery/delivery.md'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'collection', folder: 'delivery' });
  });
});

/*
 * An agent opens as a page (M55.12): its body is its instructions and its
 * grants are that page's property rows. Skills and templates keep the
 * Library editor.
 */
describe('useOpenPath library records (M55.12)', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({ detailPath: null });
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'records/agents/release-scout.md',
          folder: 'records/agents',
          title: 'Release scout',
          type: 'Agent',
        }),
        makeEntry({
          path: 'records/skills/risk-sweep.md',
          folder: 'records/skills',
          title: 'Risk sweep',
          type: 'Skill',
        }),
      ],
    });
  });

  it('opens an agent as its page, with no detail panel', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('records/agents/release-scout.md'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'records/agents/release-scout.md',
    });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('still opens a skill in the Library editor', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('records/skills/risk-sweep.md'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'library',
      tab: 'skill',
      path: 'records/skills/risk-sweep.md',
    });
  });
});

// M70.2b — Changes' Open passes a sidecar's path: it opens the page the
// comments are on, full, with its Comments panel, even when the page is a
// record (comments are not in the peek, Q6).
describe('useOpenPath comment sidecars (M70.2b)', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({
      detailPath: null,
      docPanelOpen: false,
      docPanel: 'history',
      conceptPanelOpen: false,
      conceptPanel: 'details',
    });
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'records/decisions/dec.md',
          type: 'Decision',
          project: 'records/decisions/dec.md',
        }),
      ],
    });
  });

  it("opens a record's sidecar as its full page on Comments", () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('.comments/records/decisions/dec.md.json'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'records/decisions/dec.md',
    });
    const ui = useUiStore.getState();
    expect(ui.detailPath).toBeNull();
    expect(ui.docPanelOpen).toBe(true);
    expect(ui.docPanel).toBe('comments');
  });

  it("opens a concept's sidecar on its own panel's Comments", () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('.comments/knowledge/concepts/a.md.json'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'knowledge/concepts/a.md',
    });
    expect(useUiStore.getState().conceptPanelOpen).toBe(true);
    expect(useUiStore.getState().conceptPanel).toBe('comments');
  });

  it('leaves a path that is no sidecar to the usual rules', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('.comments/notes.txt'));
    expect(useUiStore.getState().docPanel).toBe('history');
  });
});

// M59.3 — the person's opens land in the open log once each; the backdrop a
// record opens over is never one of them, and an agent's opens never count.
describe('useOpenPath and the open log (M59.3)', () => {
  const logged = () => (useOpenLogStore.getState().logs['/v'] ?? []).map((r) => r.path);

  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({ detailPath: null });
    useOpenLogStore.setState({ logs: {}, saved: true });
    useVaultStore.setState({
      vaultPath: '/v',
      entries: [
        makeEntry({
          path: 'projects/onboarding/items/fld-2.md',
          title: 'Wire the flags',
          type: 'Work item',
          project: 'projects/onboarding/project.md',
        }),
        makeEntry({ path: 'types/risk.md', title: 'Risk', type: 'Type' }),
        makeEntry({ path: 'notes/loose.md', title: 'Loose', type: null }),
      ],
    });
  });

  it('logs a record once, and never the Collection it opens over', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('projects/onboarding/items/fld-2.md'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/onboarding',
    });
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-2.md');
    expect(useOpenLogStore.getState().logs['/v']).toEqual([
      expect.objectContaining({ path: 'projects/onboarding/items/fld-2.md', count: 1 }),
    ]);
  });

  it('logs a record opened in place once', () => {
    const { result } = renderHook(() => useOpenPath('in-place'));
    act(() => result.current('projects/onboarding/items/fld-2.md'));
    expect(logged()).toEqual(['projects/onboarding/items/fld-2.md']);
  });

  it('logs a Type doc by its path', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('types/risk.md'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Risk' });
    expect(logged()).toEqual(['types/risk.md']);
  });

  it('logs a page once, through the navigation itself', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('notes/loose.md'));
    expect(useOpenLogStore.getState().logs['/v']?.[0]?.count).toBe(1);
  });

  it('logs nothing when the record is already in the panel', () => {
    const { result } = renderHook(() => useOpenPath('in-place'));
    act(() => result.current('projects/onboarding/items/fld-2.md'));
    act(() => result.current('projects/onboarding/items/fld-2.md'));
    expect(useOpenLogStore.getState().logs['/v']).toEqual([
      expect.objectContaining({ path: 'projects/onboarding/items/fld-2.md', count: 1 }),
    ]);
  });

  it('logs nothing when a Type doc is opened on its own type screen', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('types/risk.md'));
    act(() => result.current('types/risk.md'));
    expect(useNavStore.getState().history).toHaveLength(2);
    expect(useOpenLogStore.getState().logs['/v']).toEqual([
      expect.objectContaining({ path: 'types/risk.md', count: 1 }),
    ]);
  });

  it('logs nothing when a Collection page is opened on its own collection', () => {
    useVaultStore.setState({
      entries: [
        ...useVaultStore.getState().entries,
        makeEntry({ path: 'reading/reading.md', title: 'Reading', type: 'Collection' }),
      ],
    });
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('reading/reading.md'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'collection', folder: 'reading' });
    act(() => result.current('reading/reading.md'));
    expect(useOpenLogStore.getState().logs['/v']).toEqual([
      expect.objectContaining({ path: 'reading/reading.md', count: 1 }),
    ]);
  });

  it('logs nothing for an agent', () => {
    const { result } = renderHook(() => useOpenPath('navigate', { byAgent: true }));
    act(() => result.current('projects/onboarding/items/fld-2.md'));
    act(() => result.current('types/risk.md'));
    act(() => result.current('notes/loose.md'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/loose.md' });
    expect(useOpenLogStore.getState().logs).toEqual({});
  });
});

describe('pane-aware routing (M65.8)', () => {
  beforeEach(() => {
    useNavStore.getState().reset();
    useNavStore.getState().setPaneCapacity(4);
    useUiStore.setState({ toasts: [], detailPath: null, detailPane: null });
  });
  it('reuses a held record before routing its backdrop and leaves the source untouched', () => {
    useVaultStore.setState({ entries: [makeEntry({ path: 'record.md', type: 'Work' })] });
    const first = useNavStore.getState().active;
    useNavStore.getState().navigate({ kind: 'list', id: 'all' });
    const second = useNavStore.getState().openPane({ kind: 'doc', path: 'record.md' }).pane;
    const { result } = renderHook(() => useOpenPath(), {
      wrapper: ({ children }) => <PaneContext value={first}>{children}</PaneContext>,
    });
    act(() => {
      expect(result.current('record.md')).toEqual({ kind: 'reused', pane: second });
    });
    expect(useNavStore.getPaneState(first).selection).toEqual({ kind: 'list', id: 'all' });
    expect(useUiStore.getState().detailPath).toBeNull();
    expect(useNavStore.getState().active).toBe(second);
  });
  it('a call in an inactive pane opens there, and agent reuse stays silent without focusing the DOM', () => {
    useVaultStore.setState({ entries: [] });
    const first = useNavStore.getState().active;
    const second = useNavStore.getState().openPane({ kind: 'doc', path: 'other.md' }).pane;
    const { result } = renderHook(() => useOpenPath('navigate', { byAgent: true }), {
      wrapper: ({ children }) => <PaneContext value={first}>{children}</PaneContext>,
    });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => {
      result.current('new.md');
    });
    expect(useNavStore.getPaneState(first).selection).toEqual({ kind: 'doc', path: 'new.md' });
    act(() => {
      result.current('other.md');
    });
    expect(useNavStore.getState().active).toBe(second);
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe('opening beside', () => {
  beforeEach(() => {
    useNavStore.getState().reset();
    useNavStore.getState().setPaneCapacity(2);
    useUiStore.getState().closeDetail();
    useVaultStore.setState({
      entries: [makeEntry({ path: 'tasks/one.md', title: 'One', type: 'Work item' })],
    });
  });
  it('opens a record as a full page in a second pane, without a backdrop or peek', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('tasks/one.md', { newPane: true }));
    expect(useNavStore.getState().paneIds).toHaveLength(2);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'tasks/one.md' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });
  it('falls back to a full page in place when the row is full', () => {
    useNavStore.getState().setPaneCapacity(1);
    const { result } = renderHook(() => useOpenPath());
    let kind: string | undefined;
    act(() => {
      kind = result.current('tasks/one.md', { newPane: true }).kind;
    });
    expect(kind).toBe('full');
    expect(useNavStore.getState().paneIds).toHaveLength(1);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'tasks/one.md' });
  });
  it('consumes captured intent for a human, but an agent never opens a pane', () => {
    const { result } = renderHook(() => useOpenPath('navigate', { byAgent: true }));
    act(() => withOpenBesideIntent(true, () => result.current('untyped.md', { newPane: true })));
    expect(useNavStore.getState().paneIds).toHaveLength(1);
    const human = renderHook(() => useOpenPath());
    act(() => withOpenBesideIntent(true, () => human.result.current('another.md')));
    expect(useNavStore.getState().paneIds).toHaveLength(2);
  });
});
