// @vitest-environment jsdom
// Frontend unit boundary only: Tauri transport is controlled; no native timing,
// epoch authority, real command dispatch, or deadline acceptance is claimed here.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { __resetQuit, isQuitting, quitDeps } from '../../src/app/quit';
import { __resetOpenPages, retainedDocumentOwner } from '../../src/editor/openPages';
import { mountQuitFixture } from './quit';

const transport = vi.hoisted(() => ({
  roots: [] as Root[],
  listener: null as null | ((event: { payload: { deadlineMs: number } }) => void),
  invoke: null as null | ((command: string, args?: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args);
      transport.roots.push(root);
      return root;
    },
  };
});

// Only the native transport is replaced. prepareQuit, useQuitHost, the owner,
// participant registry, both write drains, beginLeaving and QuitScreen stay real.
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: NonNullable<typeof transport.listener>) => {
    if (name !== 'cerebro://quit-requested') throw new Error('unexpected event');
    transport.listener = handler;
    return () => {
      transport.listener = null;
    };
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    if (transport.invoke === null) throw new Error('transport not installed');
    return transport.invoke(command, args);
  },
}));

const KEY = {
  vaultId: 'm93-controlled-vault',
  path: 'controlled.md',
  ownerId: 'm93-native-quit',
};
const CLEAN = 'M93 controlled clean source\n';
const DRAFT = 'M93 controlled retained draft\n';
const BINDING = 'unit-transport-binding';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Eight 1 ms virtual event-loop turns allow blur/drain/React effects to run.
// This is a unit scheduler driver, not a native window or acceptance threshold.
// It never advances into the fixture's old 2490/740 ms injected sleeps.
async function drainImmediateWork() {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

function installTransport(holdTelemetry: boolean) {
  const telemetry = deferred<unknown>();
  const release = deferred<unknown>();
  const commands: string[] = [];
  const probes: Record<string, unknown>[] = [];
  transport.invoke = async (command, args) => {
    commands.push(command);
    if (command === 'cancel_quit' || command === 'finish_quit') return undefined;
    if (command !== 'capture_native_reads') throw new Error('unexpected command');
    const probe = args?.probe;
    if (probe === null || typeof probe !== 'object') throw new Error('probe required');
    const value = probe as Record<string, unknown>;
    probes.push(value);
    if (value.kind === 'ready') return null;
    // This is protocol input for frontend unit behavior, not a native authority
    // substitute. Real binding/wait/cancel behavior needs the staged Rust seam.
    if (value.kind === 'bind-attempt') return { binding: BINDING };
    if (value.kind === 'wait-late-window') return release.promise;
    if (value.kind === 'stage' || value.kind === 'phase-batch' || value.kind === 'stayed') {
      return holdTelemetry ? telemetry.promise : null;
    }
    throw new Error('unexpected fixture probe kind');
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: transport.invoke },
  });
  return { commands, probes, telemetry, release };
}

function observeRealPhases() {
  const calls: string[] = [];
  const flush = quitDeps.flushOpenPages;
  const settle = quitDeps.settlePageWrites;
  const leave = quitDeps.beginLeaving;
  vi.spyOn(quitDeps, 'flushOpenPages').mockImplementation((budget) => {
    calls.push('flush:' + budget);
    return flush(budget);
  });
  vi.spyOn(quitDeps, 'settlePageWrites').mockImplementation((budget) => {
    calls.push('settle:' + budget);
    return settle(budget);
  });
  vi.spyOn(quitDeps, 'beginLeaving').mockImplementation((budget) => {
    calls.push('leave:' + budget);
    return leave(budget);
  });
  return calls;
}

async function mountAndRequest(scenario: 'late-ipc-150' | 'late-ipc-350') {
  await act(async () => {
    await mountQuitFixture({ profile: 'quit-timing', case: scenario, nativePid: 401 });
  });
  const owner = retainedDocumentOwner(KEY);
  expect(owner).toBeDefined();
  expect(owner!.snapshot()).toMatchObject({ latestDraft: CLEAN, generation: 0 });
  expect(transport.listener).not.toBeNull();
  await act(async () => {
    transport.listener!({ payload: { deadlineMs: 5000 } });
  });
  return owner!;
}

beforeEach(() => {
  __resetQuit();
  __resetOpenPages();
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => {
    for (const root of transport.roots.splice(0)) root.unmount();
  });
  __resetQuit();
  __resetOpenPages();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  transport.listener = null;
  transport.invoke = null;
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  document.body.replaceChildren();
});

describe('late IPC fixture real dependency path', () => {
  it.each(['late-ipc-150', 'late-ipc-350'] as const)(
    '%s restores the actual cleanup draft before waiting for native release',
    async (scenario) => {
      const wire = installTransport(false);
      const phases = observeRealPhases();
      const owner = await mountAndRequest(scenario);
      await drainImmediateWork();

      expect(owner.snapshot()).toMatchObject({
        latestDraft: DRAFT,
        generation: 1,
        acknowledgedGeneration: 0,
        inFlightGeneration: null,
      });
      expect(retainedDocumentOwner(KEY)).toBe(owner);
      expect(document.querySelector('pre')?.textContent).toBe(DRAFT);
      expect(isQuitting()).toBe(false);
      expect(phases).toEqual(['flush:2500', 'settle:750', 'leave:750', 'settle:750']);
      expect(wire.probes.filter((probe) => probe.kind === 'wait-late-window')).toHaveLength(1);
      expect(wire.commands).not.toContain('cancel_quit');
      expect(wire.commands).not.toContain('finish_quit');

      await act(async () => {
        wire.release.resolve({ binding: BINDING });
      });
      await drainImmediateWork();
      expect(wire.commands.filter((name) => name === 'cancel_quit')).toHaveLength(1);
      expect(wire.commands).not.toContain('finish_quit');
      expect(owner.snapshot()).toMatchObject({
        latestDraft: DRAFT,
        generation: 1,
        acknowledgedGeneration: 0,
      });
    },
  );

  it('blocked telemetry acknowledgement cannot consume a real phase budget', async () => {
    const wire = installTransport(true);
    const phases = observeRealPhases();
    const owner = await mountAndRequest('late-ipc-150');
    await drainImmediateWork();

    expect(owner.snapshot()).toMatchObject({
      latestDraft: DRAFT,
      generation: 1,
      acknowledgedGeneration: 0,
    });
    expect(document.querySelector('pre')?.textContent).toBe(DRAFT);
    expect(isQuitting()).toBe(false);
    expect(phases).toEqual(['flush:2500', 'settle:750', 'leave:750', 'settle:750']);
    expect(wire.probes.some((probe) => probe.kind === 'wait-late-window')).toBe(false);
    expect(wire.commands).not.toContain('cancel_quit');

    await act(async () => {
      wire.telemetry.resolve(null);
    });
    await drainImmediateWork();
    expect(wire.probes.filter((probe) => probe.kind === 'wait-late-window')).toHaveLength(1);
    expect(retainedDocumentOwner(KEY)).toBe(owner);
    expect(wire.commands).not.toContain('cancel_quit');
  });
});
