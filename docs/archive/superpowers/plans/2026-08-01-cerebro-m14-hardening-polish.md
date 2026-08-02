# M14 — Hardening & polish: the app earns its gates

**Branch:** `m14-hardening-polish` (off `main` after M13 merges) · **Date:** 2026-08-01
**Trigger:** "time to harden and polish" — audit Cerebro against `docs/tolaria-main`
(the exemplar) across folders/files, test coverage, agents, and code polish; plan
the gap-closing.

## What the audit found (2026-08-01, three parallel deep-dives + live health run)

### Baseline health — strong, with one red light

- `tsc --noEmit` clean · **990 vitest passing** (2 skipped, 85 files) · **158 cargo
  tests passing** · e2e **26/27**.
- The one e2e failure is real, not flake: `e2e/pipeline.spec.ts:255` (dossier).
  After Escape the app sits on the **Project type page**, not the Collection page
  the M12.5 model promises — quick-open's first result opens the record panel over
  the *type* screen. Product/test drift from the M12 navigation change.
- Working tree holds an uncommitted, finished feature slice (+552/−59, 12 files,
  tests included): the **PR #5 security-review response** — stdio connector
  run-approvals fingerprinted per machine (`uiStore.stdioApprovals`, persisted
  outside the vault so an untrusted vault can't name a command and have it run),
  plus the `unfileForLearning` ledger fix.

### The code is cleaner than the infrastructure

The sweep found **zero** TODO/FIXME/HACK, zero `console.*` in production, zero
`@ts-ignore`, zero skipped tests, zero non-test `unwrap()`/`panic!` in Rust
(all 139 sit inside `#[cfg(test)]`; the 3 prod `expect()`s are defensible
boilerplate). Errors are consistently handled at the store/action layer
(catch → toast → return falsy). This is a disciplined codebase with **no
guardrails** — the discipline is convention, not enforcement.

### The four infrastructure gaps (vs Tolaria)

1. **No linter, no formatter, either language.** No ESLint/Biome/Prettier, no
   `cargo fmt`/`clippy` anywhere. Tolaria: ESLint 9 flat `--max-warnings=0`,
   clippy `-D warnings`, fmt `--check`, all gated.
2. **CI builds but does not gate.** `mac-app.yml` runs vitest + cargo test then
   ships a DMG. It never runs `tsc` (commit `80ca071` proves this already bit),
   never lints, never runs Playwright — the currently-red e2e would sail through.
   Tolaria: 4-job CI + a pre-push that *is* the real CI.
3. **Zero coverage instrumentation.** ~990 tests, no provider, no thresholds.
   Tolaria: 70% frontend / 85% Rust, sharded, merged-then-thresholded, ratcheted.
4. **No agent memory.** No `CLAUDE.md`, `AGENTS.md`, or `.claude/` — in a repo
   whose *product* is an agent host. Every session re-derives that `pnpm test`
   is watch-mode and `docs/` is vendored noise. Tolaria: `AGENTS.md` as single
   source of truth, `CLAUDE.md`/`GEMINI.md` as 7-line shims.

### Code rough edges (the sweep's top findings)

- **Two source files are binary blobs in git.** A raw NUL byte used as a
  composite-key delimiter (instead of the `\0` escape) makes
  `src/app/AdoptSchemaDialog.tsx:11` and `src/engine/links.ts:14` invisible to
  every `grep`/`git grep`, unblameable, and undiffable — 197 LOC merged as
  `Bin 0 -> 8285 bytes` with a zero-line diff. Compiles fine; audits skip it.
- **Dead code:** `createProjectList` (`src/app/listActions.ts:115`, the M12
  straggler) plus the `legacy` branch of `writeList` and `projectDirOf` it keeps
  alive; 5 unused `src/components/ui/` components (~300 LOC: KanbanCard,
  FilterChip, ProgressBar, Badge, Tooltip).
- **Error-handling inconsistencies:** `vaultStore.rescan()` is the one store
  method with no internal try/catch (callers variously toast, swallow, or leak
  rejections); `createItem` is the one store method that throws;
  `CollectionDialog` closes on write failure and **discards the user's input**
  (same shape in `ViewSettingsDialog`, which also never resets `busy`).
- **Rust nit:** `vault/testutil.rs` is not `#[cfg(test)]`-gated — the one module
  that could put a file-IO panic in a release binary.
- **7 `react-hooks/exhaustive-deps` suppressions** clustered in effect-heavy
  pages — each a latent stale-closure bug with no linter to keep them honest.
- **Hotspots:** `TableView.tsx` 1,360 lines (2.7× next view),
  `ViewSettingsPanel.tsx` 1,004. Test-thin layers: `src/views` (6,963 LOC,
  5 test files), `src/components` (3,289 LOC, 5). Untested Rust: `git_commands`,
  `git/{conflict,command,author,provider}`.

### Housekeeping

- `HardwareSoftware Security Engineering Tool/` — 1.8 MB, 40 files, an unrelated
  prototype export **tracked at the repo root** (commit `ef1e520`); its three
  siblings live gitignored in `docs/archive/`.
- `docs/` is half-gitignored: 70 files (69 competitor screenshots + one M13 plan
  doc) were tracked before the ignore rule and ship in every clone.
- `tsconfig include` is `src` only — `scripts/` and `e2e/` are never typechecked.
- No `SECURITY.md` (app spawns subprocesses, binds a loopback port, and now has
  a stdio-approval story worth documenting), no `CONTRIBUTING.md`.
- `src/assets/` is empty. `package.json` has no `lint`/`format`/`typecheck`/
  `test:coverage` scripts; `test` is watch-mode.

## Decisions (right-sizing Tolaria)

**Adopt:** ESLint 9 flat zero-warning + clippy/fmt as hard gates · two-speed
hooks (pre-commit = seconds, pre-push = minutes) · coverage with thresholds set
*from measured reality, then only ratcheted up* · CI that gates before it ships ·
`AGENTS.md` + `CLAUDE.md` shim · `SECURITY.md` · e2e in CI.

**Skip (deliberately):** Codacy/CodeScene SaaS and the differential-security
gate machinery · the Chunk remote-sidecar · 19-locale l10n · calendar-semver
release engineering · VitePress site · the 180-ADR corpus. These fit a funded
multi-agent team, not this repo's stage. Release engineering and public docs are
their own future milestone; a lightweight `docs/adr/` can start whenever a
decision next needs recording.

**Ordering logic:** land the in-flight security work first (it's finished);
de-corrupt the two binary files *before* introducing lint/CI (tools can't see
them until then); lint before CI (or CI is red on arrival); tests before
refactors (M14.9 before M14.10).

## The plan, commit by commit

### M14.0 — land the in-flight PR #5 response
Commit the working-tree slice as its own commit (it already includes tests):
stdio run-approvals + `unfileForLearning`. Nothing else rides along.

### M14.1 — de-corrupt the two binary sources
Replace the raw NUL with the `\0` escape in `AdoptSchemaDialog.tsx` (`keyOf`)
and `links.ts`. Byte-identical behavior; the files become text — diffable,
blameable, greppable. Add `.gitattributes` (`*.ts text`, `*.tsx text`, `*.rs
text`, etc.) so a binary-classified source can never merge silently again.
Verify: `git diff --stat` shows line counts, `git grep keyOf` hits.

### M14.2 — fix the red e2e (dossier drift)
Decide the M12.5 intent: quick-open opening a record should land its panel over
the **Collection page** (the dossier host), not the type page. Preferred fix is
product-side (quick-open routes records to their collection context); fallback
is test-side (navigate via sidebar). Either way: 27/27 green, and the test's
comment updated to say which model holds.

### M14.3 — lint and format, both languages, all findings fixed
- ESLint 9 flat: `js.recommended` + `typescript-eslint` + `react-hooks` +
  `react-refresh`; `--max-warnings=0`. Prettier for format (default config).
- Resolve the 7 `exhaustive-deps` suppressions individually — fix or justify
  with a comment; none survive unexplained.
- `cargo fmt --check` + `cargo clippy -- -D warnings`; fix everything surfaced.
- Typecheck `scripts/` and `e2e/` (project references or a second tsconfig).
- Scripts: `lint`, `format`, `format:check`, `typecheck`, `test:run`,
  `test:coverage`, `e2e`. `pnpm test` stays watch; CI uses `test:run`.

### M14.4 — CI gates before it ships
Restructure `.github/workflows/`: a **quality** job (lint · typecheck · vitest
run · cargo fmt/clippy/test) on every push/PR, an **e2e** job (Playwright,
retries=2 already configured for CI), and the existing mac build now *depends
on* quality. Coverage: `@vitest/coverage-v8`, measure actual, set thresholds a
hair below measured (the Tolaria ratchet rule: never edit downward), report in
CI. Rust `cargo llvm-cov` is stretch, not required.

### M14.5 — two-speed git hooks
Husky: **pre-commit** = ESLint on staged TS/TSX only (seconds). **pre-push** =
typecheck + `vitest run` + cargo lane (fmt/clippy/test) with change detection
so frontend-only pushes skip Rust (minutes, not tens). Policy comment: no
`--no-verify`.

### M14.6 — agent memory
`AGENTS.md` as the single source: commands (and the `pnpm test`-is-watch trap),
`docs/` = vendored reference + archive (not app code), `demo-vault/` = golden
corpus shared by dev and e2e, milestone/commit conventions
(`feat(scope): sentence (M14.n)`), plan-doc location, the store-layer
error-handling invariant ("actions never throw; catch → toast → return falsy"),
the OKF guardrails. `CLAUDE.md` = shim pointing at it. `.claude/settings.json`
= modest permission allowlist.

### M14.7 — housekeeping
- `git rm -r --cached` + move `HardwareSoftware Security Engineering Tool/` →
  `docs/archive/` beside its siblings.
- Resolve the half-tracked `docs/`: untrack the 69 screenshots; `git add -f`
  the full `docs/archive/superpowers/plans/` set so the milestone record ships
  deliberately (today only M13's is tracked).
- Delete empty `src/assets/`.
- `SECURITY.md`: the trust model in writing — subprocess spawning, loopback MCP
  allowlist, stdio fingerprint approvals, no-API-keys stance, how to report.
- `CONTRIBUTING.md`: short — point at `AGENTS.md` for process.

### M14.8 — code polish (the sweep's fix list)
- Delete `createProjectList`, the `legacy` `writeList` branch, `projectDirOf`;
  collapse `writeList`'s signature. Delete the 5 unused ui components.
- `rescan()` gets its internal try/catch + toast (callers drop their ad-hoc
  `.catch(() => undefined)`); `createItem` stops throwing (aligns the
  invariant); `CollectionDialog`/`ViewSettingsDialog` stay open on failure and
  preserve input; `busy` always resets.
- `#[cfg(test)]`-gate `vault::testutil`.

### M14.9 — test depth where it's thin
Behavioral tests for `TableView` and `ViewSettingsPanel` **before** touching
them; add coverage for `src/components` survivors, `AdoptSchemaDialog` +
`adoptActions` (the two files that were binary — nothing covered them), and the
untested Rust `git/*` modules (`conflict`, `command`, `author`, `provider`,
`git_commands`). Coverage thresholds ratchet up after.

### M14.10 — refactor the two giants (stretch)
`TableView.tsx` 1,360 → extract cell renderers / header-menu / keyboard-nav;
`ViewSettingsPanel.tsx` 1,004 → per-section components. Only lands green under
the M14.9 tests; skip if the milestone runs long — the gates (M14.3–.5) matter
more than the file sizes.

## Success criteria

- 27/27 e2e, 990+ vitest, 158+ cargo — all green **in CI**, which now gates.
- Zero ESLint warnings, clippy clean, fmt clean, all sources text in git.
- Coverage measured and thresholded; thresholds documented as ratchet-only.
- A fresh agent session can read `AGENTS.md` and run the right commands first try.
- `git clone` contains no 1.8 MB stranger at the root.
