// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActions } from './AgentActions';
import { emitUiAction } from './agentIpc';
import { __resetOpenPages, onExternalWrite } from '@/editor/openPages';
import { useCommentsStore } from '@/stores/commentsStore';
import { useNavStore } from '@/stores/navStore';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/engine/testHelpers';

/**
 * The agent's write tools announce what they changed (M53.6), because the
 * watcher drops the echo of every write the app makes, the agent's included.
 * The bridge is where that announcement becomes a rescan, and where the pages
 * showing a named file hear about it.
 */
describe('AgentActions and vault_changed', () => {
  const calls: string[] = [];
  const rescan = vi.fn(async () => {
    calls.push('rescan');
  });

  beforeEach(() => {
    calls.length = 0;
    rescan.mockClear();
    useVaultStore.setState({ rescan });
    render(<AgentActions />);
    onExternalWrite('a.md', {
      pending: () => calls.push('pending'),
      settled: () => calls.push('settled'),
    });
  });

  afterEach(() => {
    cleanup();
    __resetOpenPages();
  });

  it('tells the page showing a named file, then rescans once, then settles it', async () => {
    await act(async () => {
      emitUiAction({ action: 'vault_changed', paths: ['a.md'] });
    });
    await vi.waitFor(() => expect(calls).toEqual(['pending', 'rescan', 'settled']));
    expect(rescan).toHaveBeenCalledOnce();
  });

  it('only rescans when the write named no file', async () => {
    await act(async () => {
      emitUiAction({ action: 'vault_changed' });
    });
    await vi.waitFor(() => expect(rescan).toHaveBeenCalledOnce());
    expect(calls).toEqual(['rescan']);
  });
});

/**
 * navigate speaks the destination table's ids (M59.1). Rust refuses a word the
 * served enum lacks; the bridge refuses a database the vault lacks, and never
 * sends an unknown word Home.
 */
describe('AgentActions and navigate', () => {
  const START = { kind: 'collection', folder: 'start' } as const;

  beforeEach(() => {
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'types/work-item.md',
          title: 'Work item',
          type: 'Type',
          properties: {
            views: [
              { id: 'board', name: 'Board', presentation: { type: 'board' } },
              { id: 'table', name: 'Table', presentation: { type: 'table' } },
            ],
          },
        }),
      ],
    });
    useNavStore.setState({ selection: START });
    useUiStore.setState({ toasts: [] });
    render(<AgentActions />);
  });

  afterEach(cleanup);

  const send = async (args: { to: string; database?: string; view?: string }) => {
    await act(async () => {
      emitUiAction({ action: 'navigate', ...args });
    });
  };

  it('goes to History on history and My work on my_work', async () => {
    await send({ to: 'history' });
    expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
    await send({ to: 'my_work' });
    expect(useNavStore.getState().selection).toEqual({ kind: 'mywork' });
  });

  it('opens a database on the view it names', async () => {
    await send({ to: 'view', database: 'Work item', view: 'Board' });
    expect(useNavStore.getState().selection).toEqual({
      kind: 'type',
      name: 'Work item',
      view: 'board',
    });
  });

  it('toasts once for an unknown database and stays put', async () => {
    await send({ to: 'view', database: 'Roadmap' });
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      'No database is named "Roadmap".',
    ]);
    expect(useNavStore.getState().selection).toEqual(START);
  });

  it('toasts for a word the table does not hold, and never goes Home', async () => {
    await send({ to: 'list' });
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(useNavStore.getState().selection).toEqual(START);
  });
});

/**
 * The agent's moves never reach the person's open log (M59.3): open_note and
 * navigate move the app, and the log ranks only what the person opened.
 */
describe('AgentActions and the open log', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/v',
      entries: [
        makeEntry({ path: 'notes/plan.md', title: 'Plan', type: null }),
        makeEntry({ path: 'types/risk.md', title: 'Risk', type: 'Type' }),
      ],
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useOpenLogStore.setState({ logs: {}, saved: true });
    render(<AgentActions />);
  });

  afterEach(cleanup);

  it('open_note moves the app and logs nothing', async () => {
    await act(async () => {
      emitUiAction({ action: 'open_note', path: 'notes/plan.md' });
    });
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/plan.md' });
    await act(async () => {
      emitUiAction({ action: 'open_note', path: 'types/risk.md' });
    });
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Risk' });
    expect(useOpenLogStore.getState().logs).toEqual({});
  });

  it('navigate moves the app and logs nothing', async () => {
    await act(async () => {
      emitUiAction({ action: 'navigate', to: 'library' });
    });
    expect(useNavStore.getState().selection.kind).toBe('library');
    expect(useOpenLogStore.getState().logs).toEqual({});
  });
});

/**
 * The comment tools announce the page whose comments they changed (M70.3).
 * The bridge reloads that page's threads through the comments store, when
 * it is showing them, and rescans nothing: no file the vault lists moved.
 */
describe('AgentActions and comments_changed', () => {
  const rescan = vi.fn(async () => undefined);
  const load = vi.fn(async () => undefined);
  const original = useCommentsStore.getState().load;

  beforeEach(() => {
    rescan.mockClear();
    load.mockClear();
    useVaultStore.setState({ rescan });
    useCommentsStore.setState({
      slots: { 'records/a.md': { kind: 'ready', file: { format: 1, threads: [] } } },
      load,
    });
    render(<AgentActions />);
  });

  afterEach(() => {
    cleanup();
    useCommentsStore.setState({ slots: {}, load: original });
  });

  it("reloads the named page's threads, and never rescans", async () => {
    await act(async () => {
      emitUiAction({ action: 'comments_changed', path: 'records/a.md' });
    });
    expect(load).toHaveBeenCalledExactlyOnceWith('records/a.md');
    expect(rescan).not.toHaveBeenCalled();
  });

  it('leaves a page that is not showing its comments alone', async () => {
    await act(async () => {
      emitUiAction({ action: 'comments_changed', path: 'records/b.md' });
    });
    expect(load).not.toHaveBeenCalled();
    expect(rescan).not.toHaveBeenCalled();
  });
});
