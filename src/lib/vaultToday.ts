/**
 * The day the demo vault was written to be read on.
 *
 * The corpus is a story with absolute dates in it: knowledge stamps run from
 * 2026-07-19 to 2026-07-28, and the work it describes is dated 2026-07-29
 * onward. Read on any other day the story drifts — and read far enough after
 * it, parts of it expire. That is not hypothetical: `recentlyLearned` offers
 * concepts written in the last fortnight, so on 2026-08-11 the Home card the
 * augment spec asserts on stopped rendering at all, and the spec had been
 * failing on every tree including a clean one.
 *
 * So the clock is pinned rather than the fixtures bumped. Bumping the stamps
 * moves the expiry by a fortnight and leaves the class of failure in place;
 * pinning removes it. Midday so that no plausible offset can roll the local
 * date either way, and the browser timezone is fixed to UTC in
 * `playwright.config.ts` so `todayIso()` — which reads LOCAL date parts —
 * cannot disagree with it.
 *
 * It lives here, importing nothing, because two clocks pin it (M64.1): the
 * e2e specs through `e2e/boot.ts`, which re-exports it, and the state lab
 * through `src/lab/clock.ts`. Playwright's loader and the tools typecheck
 * take this file without DOM or Vite types, so it must stay import-free.
 */
export const VAULT_TODAY = '2026-07-28T12:00:00Z';
