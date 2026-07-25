# Cerebro M2 — Execution Log

Plan: [2026-07-25-cerebro-m2-markdown-first.md](2026-07-25-cerebro-m2-markdown-first.md). Branch: `m2-markdown-first` off `main` (PR #1 merged). Started 2026-07-25.

## Status

| # | Task | Status | Commits |
|---|---|---|---|
| 1 | M1.x fix pack | ✅ done | 8314898 |
| 2 | Dropdown DS primitive + ViewToolbar swap | in progress | |
| 3 | Rust vault format v2 | pending | |
| 4 | Demo vault v2 + migration script | pending | |
| 5 | Engine schema v2 | pending | |
| 6 | Engine per-project views | pending | |
| 7 | Shell v2 | pending | |
| 8 | Project header tabs + toolbar rework | pending | |
| 9 | BlockNote editor component | pending | |
| 10 | Doc surface + project file tree | pending | |
| 11 | Docs rail surface | pending | |
| 12 | DetailPanel body → BlockNote | pending | |
| 13 | Smoke v2 + regression sweep | pending | |

## Binding notes

1. PR #1 found already merged at M2 start; `main` in sync with origin. Two tracked files under `docs/cerebro-with-teams/` carry uncommitted local modifications (user/design-tool edits) — left untouched, not staged by any M2 commit.
2. Task 1 scope is the (B) list verbatim from the M1 log line 44. The `.gitignore test-results/playwright-report` item was already done pre-M2 (commit 082892a) — verify, don't redo.

## Deviations

(none yet)

## Task notes

**Task 1 (8314898):** all 11 (B) items landed. Baselines: 308 vitest (was 296), 67 cargo (was 66), smoke green, tsc clean. Notes: (a) `.gitignore` item was already done pre-M2 (082892a) — verified, not redone. (b) CreateMenu dialogs already had `submitting` guards from the M1 fix round; the quick-add row was the missing site. (c) stale-body policy chosen: local H1 splice into body/savedBody after successful rename (mirrors `replace_h1`, keeps dirty description edits, no extra IPC round-trip); general refetch-on-external-change remains out of scope. (d) `#[tauri::command(async)]` applied to all 10 sync IO commands; `pick_vault` already `async fn`. (e) @theme stock reset verified safe: only `text-white` used stock palette (5 sites swapped to `var(--n-0)`); `*-transparent` are static utilities in TW4, unaffected.
