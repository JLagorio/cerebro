# Cerebro M2 — Execution Log

Plan: [2026-07-25-cerebro-m2-markdown-first.md](2026-07-25-cerebro-m2-markdown-first.md). Branch: `m2-markdown-first` off `main` (PR #1 merged). Started 2026-07-25.

## Status

| # | Task | Status | Commits |
|---|---|---|---|
| 1 | M1.x fix pack | ✅ done | 8314898 |
| 2 | Dropdown DS primitive + ViewToolbar swap | ✅ done | 2453486 |
| 3 | Rust vault format v2 | ✅ done | 25d97d2 |
| 4 | Demo vault v2 + migration script | ✅ done | a0c6106 |
| 5 | Engine schema v2 | ✅ done | a0c6106 |
| 6 | Engine per-project views | in progress | |
| 7 | Shell v2 | ✅ done | a0c6106 |
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

1. **Tasks 4+5+7 landed as one commit (a0c6106)** instead of three: a v2 demo vault breaks the v1 UI (spaces everywhere) and a v2 UI shows nothing on a v1 vault — there is no green midpoint. The plan's sequencing note anticipated 3+4 pairing; the same logic extends to 5+7.
2. **resolveTarget + v2 project files:** every project doc is now named `project.md`, so `[[folder-slug]]` wikilinks no longer stem-match projects — only exact-title links (`[[Flight deck]]`) resolve (resolveTarget's second pass). Relation fields targeting projects should store title links. Flagged for the M3 filter/relation work.
3. **Parse-error entries with no `type:` no longer appear on the project item canvas** (itemsOfProject filters `type === 'Work item'`). Parity with M1 (broken items had no project link either); the Cannot-parse row remains covered at the component level. A vault-wide "broken files" surface is a good M3/M4 candidate.

## Task notes

**Task 2 (2453486):** DS Dropdown primitive (listbox-button, arrows/Enter/Escape/Home/End, aria listbox, backdrop close) + ViewToolbar swap; 8 new tests.

**Task 3 (25d97d2):** Entry gains `folder` + containment `project` on both backends; create_folder/rename_note (notes + folders, no clobber)/delete_note (trash crate); list_folders incl. empty dirs; mock parity + tests. delete_note happy path is deliberately untested (would put files in the developer's Trash) — covered by the tauri-dev shakeout.

**Tasks 4+5+7 (a0c6106):** see Deviations 1-3. Baselines after: 315 vitest / 32 files, 71 cargo, smoke green, tsc clean. The first smoke run after the sweep failed against the long-lived dev server (stale vite state — exactly the M1 log's operational warning); rerun green.

**Task 1 (8314898):** all 11 (B) items landed. Baselines: 308 vitest (was 296), 67 cargo (was 66), smoke green, tsc clean. Notes: (a) `.gitignore` item was already done pre-M2 (082892a) — verified, not redone. (b) CreateMenu dialogs already had `submitting` guards from the M1 fix round; the quick-add row was the missing site. (c) stale-body policy chosen: local H1 splice into body/savedBody after successful rename (mirrors `replace_h1`, keeps dirty description edits, no extra IPC round-trip); general refetch-on-external-change remains out of scope. (d) `#[tauri::command(async)]` applied to all 10 sync IO commands; `pick_vault` already `async fn`. (e) @theme stock reset verified safe: only `text-white` used stock palette (5 sites swapped to `var(--n-0)`); `*-transparent` are static utilities in TW4, unaffected.
