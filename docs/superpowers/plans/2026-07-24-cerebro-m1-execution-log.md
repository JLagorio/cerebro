# Cerebro M1 — Execution Log

Companion to [2026-07-24-cerebro-m1-foundation.md](2026-07-24-cerebro-m1-foundation.md) (the 24-task plan). Updated as tasks complete. A fresh session resumes from this file alone.

## Process

Subagent-driven development (superpowers:subagent-driven-development): per task — fresh implementer subagent → spec-compliance reviewer subagent → code-quality reviewer subagent; next task only when both reviews pass. Implementer prompts point at the plan's line ranges (below) plus lines 1–284 (conventions/contracts/coordination — binding). Branch: `m1-foundation` (never commit to main). After Task 24: final whole-implementation review, then superpowers:finishing-a-development-branch.

## Status

| Task | Lines in plan | Status | Commit |
|---|---|---|---|
| 1 Scaffold | 285–631 | ✅ done, spec ✓, quality ✓ | 56cb283 |
| 2 Tokens/fonts/@theme | 632–828 | ✅ done, spec ✓, quality ✓ | 2e72d31 |
| 3 DS primitives (17) | 829–1580 | ✅ done, spec ✓, quality ✓ | 5d36fe0 |
| — vitest glob infra fix | — | ✅ | 3901f1e |
| 4 Rust parser | 1581–2202 | ✅ done, spec ✓, quality ✓ (review found 2 Important + 6 Minor; 7 fixed, 1 deferred; fixes re-verified) | da50e24 + 8db3664 |
| 5 Rust scanner | 2203–2467 | ✅ done, combined review ✓ (all findings minor, deferred) | 2ef3226 |
| 6 Rust writes | 2468–2938 | ✅ done, combined review ✓ (2 Important fixed: fence-aware replace_h1 shared with parser; safe_join/safe_component path containment; fixes re-verified) | 02c59d4 + 9bc09c4 |
| 7 Config + command wiring | 2939–3214 | ✅ done, combined review ✓ (3 minors deferred) | 2608d1f |
| 8 Watcher | 3215–3557 | ⬜ next | |
| 9 Demo vault generator | 3558–4057 | ⬜ | |
| 10 ipc/mockParse/mockIpc | 4058–4763 | ⬜ | |
| 11 vaultStore | 4764–5079 | ⬜ | |
| 12 wikilink/normalize | 5080–5429 | ⬜ | |
| 13 schema | 5430–6008 | ⬜ | |
| 14 grouping | 6009–6311 | ⬜ | |
| 15 views/viewFilters | 6312–6805 | ⬜ | |
| 16 itemKeys/quickOpenScore | 6806–7026 | ⬜ | |
| 17 stores + shell | 7027–7599 | ⬜ | |
| 18 Sidebar + HomePage | 7600–8365 | ⬜ | |
| 19 Space/Project/ViewToolbar | 8366–9059 | ⬜ | |
| 20 ListView | 9060–9554 | ⬜ | |
| 21 BoardView | 9555–9838 | ⬜ | |
| 22 DetailPanel | 9839–10363 | ⬜ | |
| 23 QuickOpen/CreateMenu/Settings/Toasts | 10364–11111 | ⬜ | |
| 24 Playwright smoke | 11112–end | ⬜ | |

## Binding notes discovered during execution (feed to affected implementers)

1. **Task 6:** its planned test asserts `create_note` writes `"# Empty Note\n"` — must be `"# Empty note\n"`. Task 4 resolved a plan contradiction in favor of **sentence-case** `humanize_stem` (validated by spec review: coordination notes + parity fixtures + DS rules win over Task 4/6 literal text).
2. **Task 24:** `vite.config.ts` already has `exclude: [...configDefaults.exclude, '**/tolaria-main/**']` — Task 24's planned `exclude: ['e2e/**']` must be **merged into** that array, not replace it.
3. The vendored Tolaria reference now lives at `docs/tolaria-main/` (user moved it from repo root). It is gitignored by the `tolaria-main/` pattern at any depth.
4. Rust parity fixtures live in `src-tauri/src/vault/entry.rs` (not parse.rs); Task 10's mockParse.test.ts comment should point there.
5. Working tree has an uncommitted user edit appending `docs/` to `.gitignore` — leave it alone; flagged to user (it hides new files under docs/ from git, including future specs/plans).
6. Tauri icon `src-tauri/icons/icon.png` is required by `generate_context!` (plan gap, added in Task 1).
7. **Task 6:** `split_frontmatter`'s byte-reproduction round-trip invariant holds ONLY for LF-only, BOM-free files with a bare `---` closing fence (see doc comment at parse.rs:9-15). `update_frontmatter` must handle CRLF/BOM/trailing-whitespace-fence files deliberately (commit 8db3664 hardened the parser to accept them on read).
8. **Tasks 7/8:** vault writes are contained via `write.rs` `safe_join`/`safe_component` (rejects `..`/absolute/multi-segment); containment is LEXICAL — no canonicalization, so a user symlink inside the vault writes through to its target (accepted, standard for vault tools). The IPC command layer need not re-validate paths but must route ALL fs access through write.rs/scan.rs. `read_note` already exists in write.rs.
9. **Task 10:** `mockParse.ts` must mirror parser behaviors added in 8db3664: fence-aware H1 extraction (skip ``` fenced regions and ≥4-space-indented lines), fence-aware snippet with post-strip-empty lines dropped (no double spaces), leading-BOM strip, CRLF tolerance (incl. empty frontmatter `---\r\n---\r\n`), trailing spaces/tabs allowed on the closing fence, and a 64 KB frontmatter cap → parse error. The 3 shared parity fixtures are unchanged.

## Deferred polish (end of M1, after Task 24)

- `@theme` stock-palette reset (`--color-*: initial; --radius-*: initial;`) to block off-DS utilities — apply only after all UI tasks land
- Dialog: Escape-to-close/focus-management ownership decision (consumers own it per plan-verbatim code for now)
- SegmentedControl ARIA (`role="tab"` + `aria-selected`); FilterChip remove-× keyboard access
- `bundle.icon` entry in tauri.conf.json; CSP hardening (`"csp": null` currently) before anything ships
- Consider @testing-library/jest-dom for later tests; App.test.tsx tautological assertion note
- Parser: non-string `type` frontmatter value (e.g. `type: 123`) is silently dropped from both entry_type and properties (plan-verbatim; Task 4 quality finding 6, deferred) — consider keeping it in properties
- Parser: within-cap YAML flow-nesting bombs (~40 KB) can still take ~3 s before erroring (bounded, acceptable)
- Scanner (spec-verbatim, Task 5 review): one unreadable/non-UTF8 .md aborts the whole scan (consider degrading to per-file parse_error); `.MD` uppercase skipped; symlinked notes skipped; `views/`/`attachments/` skipped at any depth; testutil temp dirs leak on failed asserts
- IPC layer (spec-verbatim, Task 7 review): sync commands (scan_vault etc.) run on main thread — stalls UI on large vaults, consider `#[tauri::command(async)]`; pick_vault discards picked folder if config persist fails; `to_string_lossy` on picked path
