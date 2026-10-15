import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SCOPE,
  availableCommands,
  bind,
  findBinding,
  keymapVersion,
  resetKeymap,
  runCommand,
  subscribe,
} from './registry';

const PAGE = { id: 'page:1', name: 'page' };
const BLOCK = { id: 'block:1', name: 'block' };
const CHAIN = [BLOCK.id, PAGE.id, 'app'];

const byId = (id: string) => (def: { id: string }) => def.id === id;

afterEach(() => {
  resetKeymap();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('the eclipse', () => {
  it('the newest binding of an id answers, and disposing it hands back the older', () => {
    const older = vi.fn();
    const newer = vi.fn();
    bind(PAGE, 'work.split', { run: older });
    const dispose = bind(PAGE, 'work.split', { run: newer });
    runCommand('work.split', CHAIN);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    dispose();
    runCommand('work.split', CHAIN);
    expect(older).toHaveBeenCalledOnce();
  });

  it('disposing the older while the newer is live changes nothing', () => {
    const older = vi.fn();
    const newer = vi.fn();
    const disposeOlder = bind(PAGE, 'work.split', { run: older });
    bind(PAGE, 'work.split', { run: newer });
    disposeOlder();
    disposeOlder();
    runCommand('work.split', CHAIN);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });

  it('a newest binding whose when is false never falls back to the one it eclipsed', () => {
    const older = vi.fn();
    bind(PAGE, 'work.split', { run: older });
    bind(PAGE, 'work.split', { run: vi.fn(), when: () => false });
    expect(runCommand('work.split', CHAIN)).toBe(false);
    expect(older).not.toHaveBeenCalled();
  });
});

describe('the walk', () => {
  it('an inner scope answers before app', () => {
    const app = vi.fn();
    const block = vi.fn();
    bind(APP_SCOPE, 'undo', { run: app });
    bind(BLOCK, 'diagram.undo', { run: block });
    const hit = findBinding(CHAIN, (def) => def.keys.includes('mod+z'));
    hit?.run();
    expect(block).toHaveBeenCalledOnce();
    expect(app).not.toHaveBeenCalled();
  });

  it('a false when passes the key to the parent scope', () => {
    const page = vi.fn();
    bind(PAGE, 'diagram.undo', { run: page });
    bind(BLOCK, 'diagram.undo', { run: vi.fn(), when: () => false });
    runCommand('diagram.undo', CHAIN);
    expect(page).toHaveBeenCalledOnce();
  });

  it('a binding outside the chain is never reached', () => {
    const other = vi.fn();
    bind({ id: 'page:2', name: 'page' }, 'work.split', { run: other });
    expect(runCommand('work.split', CHAIN)).toBe(false);
    expect(other).not.toHaveBeenCalled();
  });
});

describe('binding', () => {
  it('throws on an unknown id', () => {
    expect(() => bind(APP_SCOPE, 'no.such.command', { run: () => {} })).toThrow(/unknown/);
    expect(() => runCommand('no.such.command', CHAIN)).toThrow(/unknown/);
  });

  it('throws on a scope the command does not list', () => {
    expect(() => bind(APP_SCOPE, 'work.split', { run: () => {} })).toThrow(/not in scope "app"/);
    expect(() => bind(PAGE, 'undo', { run: () => {} })).toThrow(/not in scope "page"/);
  });

  it('bumps the version and tells subscribers on every bind and dispose', () => {
    const listener = vi.fn();
    const stop = subscribe(listener);
    const before = keymapVersion();
    const dispose = bind(APP_SCOPE, 'undo', { run: () => {} });
    dispose();
    expect(keymapVersion()).toBe(before + 2);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('availableCommands and runCommand', () => {
  it('lists what is bound, live and allowed in the palette, innermost first', () => {
    bind(APP_SCOPE, 'undo', { run: () => {} });
    bind(APP_SCOPE, 'redo', { run: () => {}, when: () => false });
    bind(APP_SCOPE, 'palette.open', { run: () => {} });
    bind(PAGE, 'work.split', { run: () => {} });
    bind(PAGE, 'work.closeTab', { run: () => {} });
    expect(availableCommands(CHAIN).map((d) => d.id)).toEqual(['work.split', 'undo']);
  });

  it('a desktopOnly command is available and runs only in the desktop app', () => {
    const close = vi.fn();
    bind(PAGE, 'work.closeTab', { run: close });
    expect(runCommand('work.closeTab', CHAIN)).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(availableCommands(CHAIN).map((d) => d.id)).toContain('work.closeTab');
    expect(runCommand('work.closeTab', CHAIN)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('runCommand re-checks when', () => {
    let open = true;
    const run = vi.fn();
    bind(PAGE, 'work.split', { run, when: () => open });
    expect(runCommand('work.split', CHAIN)).toBe(true);
    open = false;
    expect(runCommand('work.split', CHAIN)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('resetKeymap', () => {
  it('drops every binding, and an old disposer stays harmless', () => {
    const run = vi.fn();
    const dispose = bind(APP_SCOPE, 'undo', { run });
    resetKeymap();
    expect(runCommand('undo', CHAIN)).toBe(false);
    dispose();
    expect(findBinding(CHAIN, byId('undo'))).toBeNull();
  });
});
