import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandDef } from '@/app/commands';

const defs = vi.hoisted(() => {
  vi.resetModules();
  return [
    { id: 'go.home', label: 'Home', keys: ['g h'], scope: 'app', group: 'Go to', palette: false },
    { id: 'go.history', label: 'History', keys: ['g y'], scope: 'app', group: 'Go to' },
    { id: 'list.first', label: 'Top of list', keys: ['g g'], scope: 'page', group: 'Lists' },
    { id: 'single', label: 'Single', keys: ['g'], scope: 'page', group: 'Lists' },
  ];
});
vi.mock('@/app/commands', () => ({
  catalog: () => defs,
  commandDef: (id: string) => defs.find((def) => def.id === id)!,
  scopesOf: (def: CommandDef) => [def.scope],
}));

import { APP_SCOPE, bind, resetKeymap } from './registry';
import {
  armChord,
  cancelChord,
  chordOptions,
  finishChord,
  HINT_MS,
  pendingChord,
  RESET_MS,
  subscribeChords,
} from './chords';

const key = (key: string) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});
const CHAIN = ['page:1', 'app'];
const PAGE = { id: 'page:1', name: 'page' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cancelChord();
  resetKeymap();
  vi.useRealTimers();
});

describe('the pending chord', () => {
  it('shows the hint at 200 ms, then clears it at 2 s', () => {
    bind(APP_SCOPE, 'go.home', { run: () => {} });
    const change = vi.fn();
    const stop = subscribeChords(change);
    expect(armChord(key('g'), CHAIN)).toBe(true);
    expect(pendingChord()).toEqual({ leader: 'g', chain: CHAIN, hintShown: false });
    vi.advanceTimersByTime(HINT_MS - 1);
    expect(pendingChord()?.hintShown).toBe(false);
    vi.advanceTimersByTime(1);
    expect(pendingChord()?.hintShown).toBe(true);
    vi.advanceTimersByTime(RESET_MS - HINT_MS);
    expect(pendingChord()).toBeNull();
    expect(change).toHaveBeenCalledTimes(3);
    stop();
  });

  it('consumes a matching second key and hands back the live handler', () => {
    const run = vi.fn();
    bind(APP_SCOPE, 'go.home', { run });
    armChord(key('g'), CHAIN);
    const result = finishChord(key('h'));
    expect(result?.swallow).toBe(true);
    result?.hit?.run();
    expect(run).toHaveBeenCalledOnce();
    expect(pendingChord()).toBeNull();
    expect(finishChord(key('h'))).toBeNull();
  });

  it('passes a fast miss but swallows a miss after showing the hint', () => {
    bind(APP_SCOPE, 'go.home', { run: () => {} });
    armChord(key('g'), CHAIN);
    expect(finishChord(key('x'))).toEqual({ hit: null, swallow: false });
    armChord(key('g'), CHAIN);
    vi.advanceTimersByTime(HINT_MS);
    expect(finishChord(key('x'))).toEqual({ hit: null, swallow: true });
  });

  it('always passes Escape, including after the hint', () => {
    bind(APP_SCOPE, 'go.home', { run: () => {} });
    armChord(key('g'), CHAIN);
    vi.advanceTimersByTime(HINT_MS);
    expect(finishChord(key('Escape'))).toEqual({ hit: null, swallow: false });
    expect(pendingChord()).toBeNull();
  });

  it('never runs a removed, disabled, or newly inadmissible binding', () => {
    const dispose = bind(APP_SCOPE, 'go.home', { run: vi.fn() });
    armChord(key('g'), CHAIN);
    dispose();
    expect(finishChord(key('h'))?.hit).toBeNull();
    let enabled = true;
    bind(APP_SCOPE, 'go.home', { run: vi.fn(), when: () => enabled });
    armChord(key('g'), CHAIN);
    enabled = false;
    expect(finishChord(key('h'))?.hit).toBeNull();
    enabled = true;
    armChord(key('g'), CHAIN);
    expect(finishChord(key('h'), () => false)?.hit).toBeNull();
  });

  it('lists only bound options in this chain, including hidden palette commands', () => {
    bind(APP_SCOPE, 'go.home', { run: () => {} });
    bind(PAGE, 'list.first', { run: () => {} });
    bind(APP_SCOPE, 'go.history', { run: () => {}, when: () => false });
    armChord(key('g'), CHAIN);
    expect(chordOptions(pendingChord()!).map(({ def }) => def.id)).toEqual([
      'go.home',
      'list.first',
    ]);
    expect(
      chordOptions({ leader: 'g', chain: ['app'], hintShown: true }).map(({ def }) => def.id),
    ).toEqual(['go.home']);
    expect(finishChord(key('g'))?.hit?.def.id).toBe('list.first');
  });

  it('requires a plain letter, a live chord, and no live single-key binding', () => {
    expect(armChord(key('g'), CHAIN)).toBe(false);
    bind(APP_SCOPE, 'go.home', { run: () => {} });
    expect(armChord({ ...key('g'), metaKey: true }, CHAIN)).toBe(false);
    expect(armChord(key('1'), CHAIN)).toBe(false);
    expect(armChord(key('g'), CHAIN, () => false)).toBe(false);
    bind(PAGE, 'single', { run: () => {} });
    expect(armChord(key('g'), CHAIN)).toBe(false);
  });

  it('cancelling removes both timers and subscriptions can leave', () => {
    bind(APP_SCOPE, 'go.home', { run: () => {} });
    const change = vi.fn();
    const stop = subscribeChords(change);
    armChord(key('g'), CHAIN);
    cancelChord();
    stop();
    vi.advanceTimersByTime(RESET_MS);
    cancelChord();
    expect(change).toHaveBeenCalledTimes(2);
    expect(pendingChord()).toBeNull();
  });
});
