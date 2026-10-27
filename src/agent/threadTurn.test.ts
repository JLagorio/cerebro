// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as leaveGuard from '@/app/leaveGuard';
import { __resetOpenPages, registerFlush } from '@/editor/openPages';
import type { Entry } from '@/engine/types';
import { resetMockFs, scanVault } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
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
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entriesVault: '/demo-vault',
    entries,
    status: 'ready',
  });
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
  it('rechecks the opening after the save barrier resolves before dispatch', async () => {
    const realSaveBeforeAction = leaveGuard.saveBeforeAction;
    const barrier = vi
      .spyOn(leaveGuard, 'saveBeforeAction')
      .mockImplementationOnce(async (...args) => {
        const saved = await realSaveBeforeAction(...args);
        expect(saved).toBe(true);
        queueMicrotask(() => {
          useVaultStore.setState({ vaultPath: '/other-vault', entriesVault: '/other-vault' });
        });
        return saved;
      });
    try {
      await ask('@release-scout check this');
      expect(startThreadTurn).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    } finally {
      barrier.mockRestore();
    }
  });

  it.each(['away', 'away and back'] as const)(
    'does not launch after the original opening changes %s while saves are pending',
    async (change) => {
      let release!: () => void;
      let started!: () => void;
      const saving = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      registerFlush(async () => {
        started();
        await held;
      });
      const pending = ask('@release-scout check this');
      await saving;
      useVaultStore.setState({ vaultPath: '/other-vault', entriesVault: '/other-vault' });
      if (change === 'away and back') {
        useVaultStore.setState({ vaultPath: '/demo-vault', entriesVault: '/demo-vault' });
      }
      release();
      await pending;
      expect(startThreadTurn).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    },
  );

  it.each(['different vault', 'unavailable', 'stale snapshot'] as const)(
    'refuses an already retired or unreadable origin: %s',
    async (state) => {
      if (state === 'different vault') useVaultStore.setState({ vaultPath: '/other-vault' });
      if (state === 'unavailable') useVaultStore.setState({ status: 'error' });
      if (state === 'stale snapshot') useVaultStore.setState({ entriesVault: '/other-vault' });
      await ask('@release-scout check this');
      expect(startThreadTurn).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    },
  );

  it('does not toast a late launch refusal into a replacement opening', async () => {
    let reject!: (error: Error) => void;
    let invoked!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      invoked = resolve;
    });
    startThreadTurn.mockImplementationOnce(() => {
      invoked();
      return new Promise((_resolve, rejectCall) => {
        reject = rejectCall;
      });
    });
    const pending = ask('@release-scout check this');
    await dispatched;
    useVaultStore.setState({ vaultPath: '/other-vault', entriesVault: '/other-vault' });
    reject(new Error('old opening launch refused'));
    await pending;
    expect(startThreadTurn).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([]);
  });

  it('does not launch an agent while an exact draft could not save', async () => {
    registerFlush(async () => {
      throw new Error('disk full');
    });
    await ask('@release-scout check this');
    expect(startThreadTurn).not.toHaveBeenCalled();
    expect(toasts().some((message) => message.includes('saved'))).toBe(true);
  });

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
