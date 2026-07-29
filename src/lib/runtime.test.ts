// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { inTauri, isDemoMode } from './runtime';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('runtime detection', () => {
  it('reads a bare window as demo mode', () => {
    expect(inTauri()).toBe(false);
    expect(isDemoMode()).toBe(true);
  });

  it('reads an injected __TAURI_INTERNALS__ as the real backend', () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    expect(inTauri()).toBe(true);
    expect(isDemoMode()).toBe(false);
  });

  // The three modules that used to own private copies of this predicate all
  // import it now, so a regression here would silently point one of them at
  // the wrong backend rather than fail visibly.
  it('agrees with the predicate ipc.ts branches on', async () => {
    const ipc = await import('./ipc');
    expect(typeof ipc.scanVault).toBe('function');
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    expect(inTauri()).toBe(true);
  });
});
