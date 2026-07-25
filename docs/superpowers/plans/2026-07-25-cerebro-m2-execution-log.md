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
| 6 | Engine per-project views | ✅ done | 5494d84 |
| 7 | Shell v2 | ✅ done | a0c6106 |
| 8 | Project header tabs + toolbar rework | ✅ done | 6951102 |
| 9 | BlockNote editor component | ✅ done | a4181ac |
| 10 | Doc surface + project file tree | ✅ done | 11ba22d |
| 11 | Docs rail surface | ✅ done | 57b3bdf |
| 12 | DetailPanel body → BlockNote | ✅ done | 90d262a |
| 13 | Smoke v2 + regression sweep | ✅ done | ffa72ca |

## Binding notes

1. PR #1 found already merged at M2 start; `main` in sync with origin. Two tracked files under `docs/cerebro-with-teams/` carry uncommitted local modifications (user/design-tool edits) — left untouched, not staged by any M2 commit.
2. Task 1 scope is the (B) list verbatim from the M1 log line 44. The `.gitignore test-results/playwright-report` item was already done pre-M2 (commit 082892a) — verify, don't redo.

## M2 status: code-complete

All 13 tasks landed. Final sweep (at ffa72ca): 384 vitest / 40 files, 72 cargo, tsc clean, `pnpm build` green, 2/2 Playwright, full `cargo build` zero warnings, zero space references in src/, src-tauri/, demo-vault/ (Rust fixtures modernized to v2 in ffa72ca).

**Remaining DoD item (needs a human at the GUI):** the first real `pnpm tauri dev` shakeout on a non-demo vault. Shakeout checklist from the task notes: BlockNote feel in the detail panel (compact CSS, Escape-closes-panel behavior), delete-to-Trash happy path (deliberately untested in cargo — files would land in the developer's Trash), watcher behavior on external edits, and real-vault scan performance.

**Bundle note:** BlockNote+shiki sit in a lazy chunk (~1.4 MB, loaded on first editor mount; shiki languages split further per-language); the boot bundle stays ~888 KB, dominated by lucide-react — an M3 optimization candidate.

## Deviations

1. **Tasks 4+5+7 landed as one commit (a0c6106)** instead of three: a v2 demo vault breaks the v1 UI (spaces everywhere) and a v2 UI shows nothing on a v1 vault — there is no green midpoint. The plan's sequencing note anticipated 3+4 pairing; the same logic extends to 5+7.
2. **resolveTarget + v2 project files:** every project doc is now named `project.md`, so `[[folder-slug]]` wikilinks no longer stem-match projects — only exact-title links (`[[Flight deck]]`) resolve (resolveTarget's second pass). Relation fields targeting projects should store title links. Flagged for the M3 filter/relation work.
3. **Parse-error entries with no `type:` no longer appear on the project item canvas** (itemsOfProject filters `type === 'Work item'`). Parity with M1 (broken items had no project link either); the Cannot-parse row remains covered at the component level. A vault-wide "broken files" surface is a good M3/M4 candidate.

## Task notes

**Task 2 (2453486):** DS Dropdown primitive (listbox-button, arrows/Enter/Escape/Home/End, aria listbox, backdrop close) + ViewToolbar swap; 8 new tests.

**Task 3 (25d97d2):** Entry gains `folder` + containment `project` on both backends; create_folder/rename_note (notes + folders, no clobber)/delete_note (trash crate); list_folders incl. empty dirs; mock parity + tests. delete_note happy path is deliberately untested (would put files in the developer's Trash) — covered by the tauri-dev shakeout.

**Tasks 4+5+7 (a0c6106):** see Deviations 1-3. Baselines after: 315 vitest / 32 files, 71 cargo, smoke green, tsc clean. The first smoke run after the sweep failed against the long-lived dev server (stale vite state — exactly the M1 log's operational warning); rerun green.

**Task 6 (5494d84):** per-project views: `<project>/views/*.yml` discovered and tagged with the owning project.md (Rust + mock parity); save_view gains a folder scope; ViewFile.project; sidebar/global lookups filter to global; project saves scope + dedupe within scope. Plus smoke hardening (separate commit 63b7…/`test:`): post-drag click retried — dnd-kit suppresses the click after a drag; was 1-in-3 flaky, 4/4 green after.

**Task 8 (6951102):** saved-view tab row on project headers (Items + scoped tabs + New view), tab switch loads the view's presentation, toolbar edits auto-persist to the active view's YAML (plan open-item 3 resolved: immediate write + failure toast, no dirty-dot), ViewToolbar reduced to presentation controls. Baselines: 321 vitest, 72 cargo, smoke green.

**Task 9 (a4181ac):** BlockNote 0.46.2 pinned exactly (core/react/mantine/code-block — Tolaria uses the mantine flavor, resolving plan open item 5; their dist patches NOT vendored — they fix toReversed polyfill/HMR issues we haven't hit). Round-trip findings from exploration: BlockNote parses each hard break into two `\n` while serialize emits 1:1, so multi-line quotes/callouts grew a blank line every open/save cycle — fixed by halving `\n\n` runs post-parse (code blocks exempt; soft breaks parse single and adjacent breaks can't exist in markdown, so runs ≥2 are always parser-made). Lossy-import policy (plan open item 2 resolved): (a) opening a file never writes — emits are suppressed while serialization matches the last saved form; (b) accepted normalization is formatting-only (`-`→`*`, loose lists, table padding, `---`→`***`) and applies on first real edit; (c) raw HTML blocks are DROPPED by BlockNote — `isLossyImport` detects textual-content loss so Tasks 10/12 can warn before an edit overwrites. Obsidian callouts survive as quote blocks with `[!type]` markers intact (visual callout treatment = M3 candidate). Checkbox round trip keeps `[x]`/`[ ]` and `📅 YYYY-MM-DD` verbatim (M4 My Tasks scanner must accept `*` bullets, not just `-`). Consumers must import LazyMarkdownEditor (BlockNote/shiki off the boot path). Baselines: 361 vitest / 37 files, tsc clean, `pnpm build` green, smoke green.

**Task 10 (11ba22d):** Selection gains `doc`; DocPage + NoteBodyEditor (shared load/save/lossy-banner wrapper) + FileTree; ProjectPage page tabs (Overview = project.md inline editor, Pages = tree) after the view tabs per the plan's Task 8 wording — the page-tab half of that row deliberately landed here where DocPage exists. Interpretation note on "H1-synced title": the H1 lives IN the editor (no separate title input — no double-H1, no splice complexity); each save rescans and the scanner's H1-derived title updates every surface. Tree open rule (also applied to QuickOpen): Work items → detail panel, all other markdown files → DocPage. Expand state persists to localStorage (`cerebro.expandedFolders`); Node 22's experimental localStorage stub shadows jsdom's under vitest — Map-backed shim in test/setup.ts. Baselines: 378 vitest / 38 files, tsc clean, smoke green.

**Task 11 (57b3bdf):** Selection gains `docs`; DocsPage = recents (latest-modified documents; work items + project.md excluded) + vault-wide FileTree; Rail Docs item lands (no-dead-chrome rule satisfied — the surface exists now). One open rule everywhere (project tree, QuickOpen, docs tree): project.md → project canvas, Work item → detail panel on its project, anything else → DocPage. Rail actives: Docs owns doc/docs, Home owns home/project/view. Baselines: 384 vitest / 40 files, tsc clean, smoke green.

**Task 12 (90d262a):** textarea → NoteBodyEditor `compact` (28px gutter, scaled headings for the 420px panel). Rename race policy translated to blocks: `spliceTitleIntoBlocks` (markdown.ts) rewrites/inserts the first H1 block in the live editor after a successful rename — fence-aware by construction. String `spliceTitle` deleted with its suite; block-level suite in markdown.test.ts. Two behavior notes: (a) the splice triggers one save that matches what replace_h1 already wrote — harmless identical write; (b) Escape inside the editor closes the panel (same as the M1 textarea) — flag for the tauri-dev shakeout if BlockNote's own Escape handling (menu dismiss) makes this annoying. Bare fences normalize to ```` ```text ```` (pinned). Baselines: 384 vitest, tsc clean, smoke green.

**Task 13 (ffa72ca):** smoke v2 journey: New view from the tab row → auto-persist verified on disk after a toolbar edit → Pages tab → new folder → new page inside it (file asserted byte-exact `# Smoke Notes\n`, no frontmatter) → BlockNote edit → debounced write asserted → Home → Docs rail → recents → content back through the full disk round trip. **Deviation 4:** the plan's "reload persists" step is navigate-away-and-back instead — the mock fs is in-memory per page load, so a browser reload reseeds it; true cross-reload persistence is exactly what the tauri-dev shakeout covers. Rust fixture modernization folded in (spaces → v2 project statuses override / lead relation) to satisfy the zero-space-references DoD line.

**Task 1 (8314898):** all 11 (B) items landed. Baselines: 308 vitest (was 296), 67 cargo (was 66), smoke green, tsc clean. Notes: (a) `.gitignore` item was already done pre-M2 (082892a) — verified, not redone. (b) CreateMenu dialogs already had `submitting` guards from the M1 fix round; the quick-add row was the missing site. (c) stale-body policy chosen: local H1 splice into body/savedBody after successful rename (mirrors `replace_h1`, keeps dirty description edits, no extra IPC round-trip); general refetch-on-external-change remains out of scope. (d) `#[tauri::command(async)]` applied to all 10 sync IO commands; `pick_vault` already `async fn`. (e) @theme stock reset verified safe: only `text-white` used stock palette (5 sites swapped to `var(--n-0)`); `*-transparent` are static utilities in TW4, unaffected.
