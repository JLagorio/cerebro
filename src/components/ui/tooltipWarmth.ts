/**
 * A warm toolbar (owner, 2026-10-19: "feel like Notion and ChatGPT"; after
 * thought-desk's tooltips and Radix's `skipDelayDuration`): once a tooltip
 * has been read, the next one a pointer brings up within this long opens at
 * once, so running the pointer along a row of buttons reads each without
 * waiting again. Only a pointer: a tooltip that comes with keyboard focus
 * still waits, or tabbing across a toolbar would raise one at every stop,
 * each holding the next Escape (layers.ts).
 *
 * Its own module, so the test setup can cool it between cases without
 * loading the tooltip.
 */
const WARM_MS = 700;

let warmUntil = -Infinity;

/** Whether a tooltip brought up by the pointer now opens at once. */
export function tooltipsWarm(): boolean {
  return performance.now() < warmUntil;
}

/** A tooltip that was showing has just gone: the next one is warm. */
export function warmTooltips(): void {
  warmUntil = performance.now() + WARM_MS;
}

/** Cools them: every tooltip waits its own delay again. */
export function resetTooltipWarmth(): void {
  warmUntil = -Infinity;
}
