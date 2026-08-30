import { configDefaults, coverageConfigDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  // PORT lets a second checkout (worktree, CI lane) run its own dev server
  // beside an interactive one; strictPort keeps a taken port an error instead
  // of a silent drift onto a server built from different sources.
  server: { port: Number(process.env.PORT ?? 5173), strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // docs/ holds vendored reference repos (gitignored) with test suites of
    // their own — never run them. tolaria-main kept by name because it has
    // lived at the repo root too. e2e/ holds Playwright specs
    // (@playwright/test crashes under vitest).
    //
    // .claude/ holds git worktrees for parallel branches (M15): a worktree is
    // a full checkout, so `pnpm test:run` from the repo root was collecting
    // another branch's 24 test files and running them against THIS tree —
    // hundreds of failures owned by nobody, and a pre-push hook that could
    // only be satisfied by deleting the worktree or bypassing the hook.
    exclude: [...configDefaults.exclude, 'docs/**', '**/tolaria-main/**', 'e2e/**', '.claude/**'],
    // setup.ts grants waitFor 5s for shared CI runners, but vitest's default
    // testTimeout is ALSO 5s — so a slow-but-passing waitFor loses the race to
    // the test-level clock (MarkdownEditor's debounce test died exactly this
    // way on a cold ubuntu runner). Like asyncUtilTimeout, this only bounds
    // hung tests; passing tests still finish the moment their condition holds.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Coverage does NOT inherit the exclusions above: those decide only
      // which files are COLLECTED AS TESTS, while coverage measures every
      // source file it can reach. So the vendored reference repos in docs/
      // and the full branch checkouts under .claude/worktrees were being
      // scored as untested project code — 207k statements of somebody
      // else's, which read as 9% against a 48% floor and made pre-push
      // unsatisfiable for as long as a worktree existed. The same blind spot
      // as M15.13, one config block further down.
      exclude: [
        ...coverageConfigDefaults.exclude,
        'docs/**',
        '**/tolaria-main/**',
        'e2e/**',
        '.claude/**',
      ],
      // RATCHET floors (M14.4): set a hair under measured reality
      // (49.45 / 59.15 / 81.8 on 2026-08-01) so they can only move UP.
      // Never edit downward — raise them as coverage grows.
      // Ratchets only tighten. Raised in M33.9 from 48/48/58/80, which was a
      // floor set while coverage was still scoring vendored docs/ and
      // worktrees (fixed in M15.19) and never re-set once the measurement was
      // honest. Measured at M33.9: 79.42 statements / 83.38 branches / 74.74
      // functions / 79.42 lines — these sit ~1.5 points under that, which is
      // room for ordinary churn and not room for a surface to go untested.
      // Raised again at the end of M33b, measured 80.33 statements / 83.61
      // branches / 75.52 functions / 80.33 lines. Same ~1.5-point gap kept, on
      // the same reasoning; M33a and M33b together added the Knowledge tab,
      // the thread view, the agent roster and two governance gates, and a
      // floor left where M33.9 set it would have let all of that rot untested
      // while still reporting green.
      // M34.1 measured 80.34 / 80.34 / 75.52 / 83.61 — the grant, capability,
      // and prompt work arrived tested, so the floor follows it up. Ratchets
      // only tighten.
      // M45.5 measured 82.24 statements / 84.56 branches / 76.65 functions /
      // 82.24 lines: M44's dashboards and views and M45's layout editor all
      // arrived with their own suites, and two points of headroom is a floor
      // that would let the next surface rot while still reporting green.
      // Branches gets the wider margin on purpose — statements, lines and
      // functions reported the same denominator on two consecutive runs while
      // the branch total moved (19864 → 19861, 84.56 → 84.55), and a ratchet
      // that trips on its own measurement noise is a broken gate, not a floor.
      // M45.6 measured 82.31 statements / 84.66 branches / 76.77 functions /
      // 82.31 lines on two consecutive runs — the tab seam, the peek's strip
      // and the customizer's tab-scoped canvas all arrived with their suites.
      // The margins are thinner than M45.5's because the noise is now
      // measured rather than guessed at: statements, lines and functions
      // reported the SAME numerator and denominator both times (53987/65587,
      // 3071/4000), so a 0.01 gap is real headroom there; branches moved its
      // denominator again (19999 → 20001) at an unchanged 84.66, and keeps
      // the wider margin for it.
      // M46.2 measured 82.63 statements / 84.87 branches / 77.26 functions /
      // 82.63 lines. The drag rebuild added four tested primitives that did
      // not exist (`useDragGesture`, `sortableGeometry`, `dropPartition`,
      // `BlockDrag`) plus `Grip`, `ResizeHandle` and the motion tokens, and a
      // slice that adds that much tested code and leaves the floor where it
      // was is licensing the NEXT one to add none. Same two-run protocol:
      // statements, lines and functions reported the same numerator and
      // denominator both times (54608/66086, 3126/4046), so the small gap
      // there is real headroom; branches moved both (17153/20209 →
      // 17159/20213, 84.87 → 84.89) and keeps the wider margin, because a
      // ratchet that trips on its own measurement noise is a broken gate.
      thresholds: {
        lines: 82.6,
        statements: 82.6,
        functions: 77.2,
        branches: 84.8,
      },
    },
  },
});
