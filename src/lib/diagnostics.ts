// The webview's uncaught errors, sent to the diagnostic log (M53.24).
//
// A Finder-launched app has nowhere to show one: its devtools are closed and
// its stderr goes nowhere, so an error the window threw used to vanish. This
// forwards each uncaught error and unhandled rejection through `logFrontend`
// as raw text. Rust redacts and clamps it, and holds the only redaction rule.
//
// It never handles an error: nothing here calls preventDefault, so the console
// still shows each one and Playwright still sees it. A burst is bounded twice:
// a repeat of the same message from the same place within 10 s is dropped, and
// at most 20 reports leave in any minute.
import { logFrontend, type FrontendLogEntry } from './ipc';

/** A repeat of one error from one place inside this window is dropped. */
const REPEAT_MS = 10_000;
/** At most PER_WINDOW reports leave in any WINDOW_MS. */
const WINDOW_MS = 60_000;
const PER_WINDOW = 20;

/** The installed listeners' remover, while they are installed. */
let installed: (() => void) | null = null;

/**
 * Forward the window's uncaught errors and unhandled rejections to the
 * diagnostic log. Idempotent: a second call returns the first one's remover
 * and adds nothing. The returned function removes both listeners.
 */
export function installErrorReporting(): () => void {
  if (installed !== null) return installed;
  const lastSent = new Map<string, number>();
  let sentAt: number[] = [];

  const forward = (entry: FrontendLogEntry): void => {
    const now = Date.now();
    for (const [key, at] of lastSent) {
      if (now - at >= REPEAT_MS) lastSent.delete(key);
    }
    const key = `${entry.message}\n${entry.source ?? ''}`;
    if (lastSent.has(key)) return;
    sentAt = sentAt.filter((at) => now - at < WINDOW_MS);
    if (sentAt.length >= PER_WINDOW) return;
    lastSent.set(key, now);
    sentAt.push(now);
    void logFrontend(entry);
  };
  const onError = (event: ErrorEvent): void => forward(fromError(event));
  const onRejection = (event: PromiseRejectionEvent): void => forward(fromRejection(event));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  const remove = (): void => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    if (installed === remove) installed = null;
  };
  installed = remove;
  return remove;
}

function fromError(event: ErrorEvent): FrontendLogEntry {
  const error: unknown = event.error;
  return {
    level: 'error',
    message: event.message || describe(error),
    source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function fromRejection(event: PromiseRejectionEvent): FrontendLogEntry {
  const reason: unknown = event.reason;
  return {
    level: 'error',
    message: `Unhandled rejection: ${describe(reason)}`,
    stack: reason instanceof Error ? reason.stack : undefined,
  };
}

/** Words for whatever was thrown, which need not be an Error at all. */
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
