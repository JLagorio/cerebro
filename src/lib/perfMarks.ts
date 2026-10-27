/**
 * Performance-timeline probes the M93.6 runner reads (`scripts/performance/`).
 *
 * The product never reads them back: they are written to the browser's own
 * performance timeline and nowhere else. A serializer measure is cleared as
 * soon as it is made, so a long session buffers nothing; the runner collects
 * it with a `PerformanceObserver`, which receives an entry even after the
 * timeline buffer drops it. Every call is guarded: a webview or test DOM
 * without User Timing makes it a no-op, never a throw.
 */
export type Milestone = 'frontend_ready' | 'editor_ready';
export const SERIALIZE_MEASURE = 'editor_serialize';

let frontendMarked = false;

/** `frontend_ready` once per load; `editor_ready` each time an editor is
 *  ready, keeping only the latest so the timeline never grows with use. */
export function markMilestone(name: Milestone): void {
  if (name === 'frontend_ready') {
    if (frontendMarked) return;
    frontendMarked = true;
  }
  try {
    if (typeof performance.mark !== 'function') return;
    if (name === 'editor_ready' && typeof performance.clearMarks === 'function')
      performance.clearMarks(name);
    performance.mark(name);
  } catch {
    // An unsupported timeline is not a fault of the page being opened.
  }
}

/** One serializer pass that began at `start` (a `performance.now()` reading). */
export function measureSerialize(start: number): void {
  try {
    if (typeof performance.measure !== 'function') return;
    performance.measure(SERIALIZE_MEASURE, { start, end: performance.now() });
    if (typeof performance.clearMeasures === 'function')
      performance.clearMeasures(SERIALIZE_MEASURE);
  } catch {
    // As above: the probe never changes what the serializer returns.
  }
}
