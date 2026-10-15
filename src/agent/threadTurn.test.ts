// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOpenPages, registerFlush } from '@/editor/openPages';
import type { Entry } from '@/engine/types';
import { resetMockFs, scanVault } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { askAgentInThread } from './threadTurn';

/** What reached the IPC, in order with the held saves. */
const calls: string[] = [];
const startThreadTurn = vi.hoisted(() => vi.fn());
vi.mock('./agentIpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentIpc')>()),
  startThreadTurn,
}));

const PAGE = 'records/decisions/dec-conflict-resolution-is-manual.md';
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

let entries: Entry[] = [];

beforeEach(async () => {
  resetMockFs();
  entries = await scanVault('/demo-vault');
  useUiStore.setState({ toasts: [] });
  calls.length = 0;
  startThreadTurn.mockReset();
  startThreadTurn.mockImplementation(async () => {
    calls.push('invoke');
    return { runId: 'run-1', placeholder: '00000000000000ff' };
  });
});
afterEach(() => __resetOpenPages());

const ask = (text: string) =>
  askAgentInThread({
    vault: '/demo-vault',
    page: PAGE,
    thread: '0000000000000001',
    message: '0000000000000002',
    text,
    entries,
  });

describe('askAgentInThread (M70.4)', () => {
  it('does nothing for a comment that names nobody', async () => {
    await ask('Looks right to me. Mail josef@example.com if not.');
    expect(startThreadTurn).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('toasts an @handle no agent answers to, and calls no IPC', async () => {
    await ask('@nobody-here check this');
    expect(startThreadTurn).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['No agent answers to @nobody-here, so nobody was asked.']);
  });

  it('asks the agent a handle names, once, with the page, thread, comment and handle', async () => {
    await ask('@release-scout check this');
    expect(startThreadTurn).toHaveBeenCalledTimes(1);
    expect(startThreadTurn).toHaveBeenCalledWith('/demo-vault', {
      page: PAGE,
      thread: '0000000000000001',
      message: '0000000000000002',
      handle: 'release-scout',
    });
    expect(toasts()).toEqual([]);
  });

  it('lands a held save before the invoke', async () => {
    registerFlush(async () => {
      await new Promise((done) => setTimeout(done, 5));
      calls.push('save');
    });
    await ask('@release-scout check this');
    expect(calls).toEqual(['save', 'invoke']);
  });

  it('toasts a refusal once and never throws', async () => {
    startThreadTurn.mockRejectedValueOnce(
      new Error('Release scout is already answering that comment.'),
    );
    await expect(ask('@release-scout check this')).resolves.toBeUndefined();
    expect(toasts()).toEqual(['Release scout is already answering that comment.']);
  });
});
