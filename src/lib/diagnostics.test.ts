// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrontendLogEntry } from './ipc';

const { logFrontend } = vi.hoisted(() => ({
  logFrontend: vi.fn(async (_entry: FrontendLogEntry) => undefined),
}));
vi.mock('./ipc', () => ({ logFrontend }));

import { installErrorReporting } from './diagnostics';

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  logFrontend.mockClear();
  vi.useRealTimers();
});

/** What the window does with an uncaught `throw new Error(message)`. */
function throwFrom(message: string, filename = 'tauri://localhost/assets/index.js'): ErrorEvent {
  const event = new ErrorEvent('error', {
    message: `Uncaught Error: ${message}`,
    filename,
    lineno: 12,
    colno: 34,
    error: new Error(message),
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

/** An unhandled rejection. jsdom has no PromiseRejectionEvent, so the event
 * carries `reason` the way the browser's does. */
function reject(reason: unknown): Event {
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason });
  window.dispatchEvent(event);
  return event;
}

function sent(): FrontendLogEntry[] {
  return logFrontend.mock.calls.map(([entry]) => entry);
}

describe('installErrorReporting (M53.24)', () => {
  it('forwards a window error with its message, file:line:col and stack, as raw text', () => {
    uninstall = installErrorReporting();
    const event = throwFrom('probe Bearer abc');
    expect(sent()).toEqual([
      {
        level: 'error',
        // Raw: Rust holds the only redaction rule, so nothing is masked here.
        message: 'Uncaught Error: probe Bearer abc',
        source: 'tauri://localhost/assets/index.js:12:34',
        stack: expect.stringContaining('probe Bearer abc'),
      },
    ]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('describes a thrown non-Error when the event carries no message', () => {
    uninstall = installErrorReporting();
    window.dispatchEvent(new ErrorEvent('error', { error: 'a thrown string' }));
    expect(sent()).toEqual([
      { level: 'error', message: 'a thrown string', source: undefined, stack: undefined },
    ]);
  });

  it('forwards an unhandled rejection carrying an Error, a string or anything else', () => {
    uninstall = installErrorReporting();
    const error = new TypeError('x is undefined');
    const event = reject(error);
    reject('plain words');
    reject({ code: 7 });
    reject(10n);
    expect(sent().map((entry) => entry.message)).toEqual([
      'Unhandled rejection: TypeError: x is undefined',
      'Unhandled rejection: plain words',
      'Unhandled rejection: {"code":7}',
      'Unhandled rejection: [object BigInt]',
    ]);
    expect(sent()[0].stack).toBe(error.stack);
    expect(sent()[1].stack).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it('installs once however often it is called, and its remover stops it', () => {
    const first = installErrorReporting();
    uninstall = first;
    expect(installErrorReporting()).toBe(first);
    throwFrom('once');
    expect(logFrontend).toHaveBeenCalledTimes(1);

    first();
    // Message only: with no listener left, vitest's jsdom environment would
    // rethrow an event that carries an Error.
    window.dispatchEvent(new ErrorEvent('error', { message: 'after removal' }));
    expect(logFrontend).toHaveBeenCalledTimes(1);

    uninstall = installErrorReporting();
    expect(uninstall).not.toBe(first);
    throwFrom('installed again');
    expect(logFrontend).toHaveBeenCalledTimes(2);
  });

  it('drops a repeat from the same place within 10 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    uninstall = installErrorReporting();
    for (let i = 0; i < 30; i += 1) throwFrom('the same error');
    expect(logFrontend).toHaveBeenCalledTimes(1);

    throwFrom('the same error', 'tauri://localhost/assets/other.js');
    expect(logFrontend).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(9_999);
    throwFrom('the same error');
    expect(logFrontend).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    throwFrom('the same error');
    expect(logFrontend).toHaveBeenCalledTimes(3);
  });

  it('forwards at most 20 distinct errors in any minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    uninstall = installErrorReporting();
    for (let i = 0; i < 30; i += 1) throwFrom(`distinct error ${i}`);
    expect(logFrontend).toHaveBeenCalledTimes(20);

    vi.advanceTimersByTime(59_999);
    throwFrom('still inside the minute');
    expect(logFrontend).toHaveBeenCalledTimes(20);
    vi.advanceTimersByTime(1);
    throwFrom('a new minute');
    expect(logFrontend).toHaveBeenCalledTimes(21);
  });
});
