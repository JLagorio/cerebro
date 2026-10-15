# Working on Cerebro

Shared instructions for AI coding agents. `CLAUDE.md` is a shim pointing here —
keep everything agent-facing in this file, or in a dev skill it lists under Dev
skills.

Cerebro is a files-first markdown workspace: a Tauri 2 (Rust) + React 19 app
where the vault on disk is the source of truth. The assistant is the user's own
Claude Code CLI, spawned as a subprocess against an in-process loopback MCP
server — no API key ever enters the app.

## Commands

| What       | Command                             | Notes                                                                                          |
| ---------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Dev server | `pnpm dev`                          | Port 5173 strict; `PORT=5273 pnpm dev` for a second checkout                                   |
| Unit tests | `pnpm test:run`                     | **`pnpm test` is watch mode — it never exits.**                                                |
| Coverage   | `pnpm test:coverage`                | Thresholds in `vite.config.ts` ratchet UP only                                                 |
| E2E        | `pnpm e2e`                          | Playwright; starts its own server. `CEREBRO_E2E_REUSE=1` to reuse yours; `PORT=...` to isolate |
| Lint       | `pnpm lint`                         | Zero-warning policy (`--max-warnings=0`)                                                       |
| Format     | `pnpm format` / `pnpm format:check` | Prettier, 100 cols, single quotes                                                              |
| Typecheck  | `pnpm typecheck`                    | App, tools (`tsconfig.tools.json`: scripts/, e2e/), no-DOM engine (`tsconfig.engine.json`)     |
| Rust       | `cd src-tauri && cargo test`        | Also `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`                          |
| Toolchain  | `rust-toolchain.toml`               | Pins Rust; `package.json` `engines` + `packageManager` pin Node, pnpm. CI installs all three   |
| Mac build  | `./scripts/mac-build.sh`            | Local build + install                                                                          |
| State lab  | `pnpm dev`                          | Then `/state-lab.html?section=<id>&state=<state>`: one section in one of five states (CV-44)   |

Hooks (husky): pre-commit lints; pre-push runs the full gate. **CV-01 Never
`--no-verify`** — if a hook is wrong, fix the hook. The pre-push hook also
warns, and never blocks, when rustc, node or pnpm differs from the pins;
Homebrew's cargo ignores `rust-toolchain.toml`, so that warning is all it gets.
enforced: `.github/workflows/mac-app.yml`

## Repo map — what is real and what is vendored

- `src/` — React app. `engine/` is the pure domain core (best-tested layer),
  and `engine/scene/` the whiteboard scene core (M68.1, CV-45);
  `scene/jsonCanvas.ts` reads/writes JSON Canvas without losing unknown values,
  replaying the shared format and cases against Rust `canvas/read.rs` and
  `canvas/write.rs` (M68.2, M68.7); `canvas/answer.rs` bounds the agent read,
  using `shared/canvas/agent-limits.v1.json` through the two checked loaders;
  `views/`, `pages/`, `app/`, `detail/`, `knowledge/`, `agent/`, `editor/`,
  `git/`, `library/`, `workspace/`, `status/`, `history/`, `sheet/` are surfaces; `stores/` is
  Zustand; `lib/` holds IPC + browser mocks, and `lib/keys/` the keymap (one
  capture-phase listener, scopes, editor claims) that dispatches the command
  rows in `app/commands/` (M65.1, CV-47). Lint (`eslint.config.js`) and the
  no-DOM typecheck (`tsconfig.engine.json`) keep `engine/` pure;
  Navigation history (`stores/navStore.ts`) holds visit slots, including the
  search, filter bar and table scroll retained by `app/useEntryState.ts`.
  `app/LastPlaceHost.tsx` restores a valid last place per vault after readiness,
  and `engine/placeResolves.ts` prunes dead Back/Forward destinations (M65.4).
  `@tauri-apps/*` loads only in the four IPC adapters (`lib/ipc.ts`,
  `lib/gitIpc.ts`, `lib/rootsIpc.ts`, `agent/agentIpc.ts`), and only
  `lib/mockIpc.ts` reads `lib/mockParse.ts` (M53.20). `lab/` is the dev-only
  state lab (`state-lab.html`, M64.1), which Vite never builds.
- **Knowledge is three tabs, and a concept is a page** (M50–M51). The page
  (`pages/KnowledgePage.tsx`) is Concepts (every concept, filed by folder),
  Review (the queue — `engine/okf.ts` `reviewQueue` orders it and names each
  row's reason — then "Waiting on you": the ledger's proposal cards and the
  page writes ask-first agents queued while nobody watched, which are
  operational and live in runtime.db, M57.4c) and Activity
  (what changed, the attention lanes, the update log, and the machinery
  folded under System). `knowledge/BaseItself.tsx` supplies those status
  sections from `src/status/`, each owning its own read and its own failure.
  A concept opens in `DocPage` like any page: its review is the bar under its
  title (`knowledge/ConceptReviewBar.tsx`, which alone may Verify), and its
  evidence is the side panel's Details tab, closed until asked.
  `ReviewPage`, `PipelinePage` and `EpistemicStatusPage` are all gone.
  **The shell is ONE nav column that
  IS the chrome** (M37.3 flattened the rail and per-surface sidebar into
  `app/Sidebar.tsx`; M43 dissolved the Topbar into it): header (vault tile ·
  wordmark · Assistant zap · search · collapse), the New button, then the
  STANDALONE destinations (Inbox, Home, My work, Studio, History, Library —
  M37.2 spent the locked names, M38.3 retired Docs for the standing **Pages**
  tree, M40 added Studio, M43 added My work and moved Library up; the
  selection KINDS stay `knowledge`/`workspace`, labels only, plus M43's
  `mywork`), then the sections — Collections, Pages, **Work** (M43.10: each
  mounted repo is a row; ↗ opens the surface; empty says "No repositories
  mounted"), **Knowledge** (M50.5 renamed Base; M51: `KnowledgeNav`'s rows
  are the bundle's folders, then Review; ↗ opens Concepts), Agents (M43 turned M41's destination into a roster
  section whose ↗ opens the fleet; each row opens that agent's page), **Databases** (M39 — the label; `type:`
  and every internal identifier keep the old word), and Favorites (pinned
  paths, `cerebro.favorites`, pruned when a pointer dies) — all wearing
  `app/SectionHeader.tsx`'s one anatomy, then the footer (SyncBadge · Theme ·
  Settings). No destination owns nested rows anymore — M42.2's group chevrons
  retired with M43.10; section fold state rides the closed set
  (`cerebro.navClosed`; Databases keeps `typesOpen`). The chrome is the DS's:
  sunken sidebar, `--surface-selected` + cortex ink for the current row,
  quiet mono counts — never a filled pill (M42.1). The main canvas holds up
  to four page panes (M65.9), each with its own history and editor. Modified
  clicks and Shift+Enter open beside; a narrow row parks the least recently
  focused panes behind tabs while keeping them mounted.
  The destination names are asserted in `app/Sidebar.test.tsx`, and every
  destination is one row of `engine/destinations.ts` (M59.1): the sidebar
  rows and doors, each destination's `g` chord, ⌘K Go to, the window title,
  thread labels and navigate's `to` read it, and `destinations.test.ts` holds `tools.v1.json`'s navigate
  list to it. Specs scope destination clicks to `nav-surfaces` (nested rows
  live OUTSIDE those containers precisely because they share accessible
  names with destinations). Sections are addressed by `data-section`, never
  by a per-section testid, and the `KnowledgeNav` selection type carries the
  tab (plus `run`, for one fleet detail) so a tab is a place the back button
  returns to.
- **Home is pull-only** (M64.4). Quiet lanes follow the order in
  `engine/homeLanes.ts` (`HOME_LANES`). Empty lanes stay silent, each failed
  read says so on its own, and Home carries no sidebar count.
- **An agent is a page** (M55.12). DocPage renders it: its body is its
  standing instructions, and `library/AgentProperties.tsx`'s rows are its
  grants, each writing its one key on Done. Runs and Memory are fixed tabs
  beside Instructions (`library/AgentPage.tsx`), under the duty bar. The
  Library keeps the shelf and New (born paused). `{kind:'agents', actor}` and
  a library agent path forward to the page with `navigate(…, {replace: true})`,
  so Back never lands on a forwarder; only construct actors keep a page on the
  Agents surface.
- **A project is a page** (M61.11). Its Type doc declares Tasks and Docs tabs
  over related records, plus Agents (M63.4) and Runs (M63.4b) tabs. Runs lists
  recorded causes about the page and its filed work, including their hops. Newly filed work inherits
  listed agents through its single Agent relation in the same human write;
  existing work keeps its agents. Membership is the record's stored `project:` relation,
  and a related tab files new records under its host. New records live in the
  database's home folder; a task-like type under a host with a key prefix takes
  its next item key. Cycles are saved views over the work's date range.
- `src-tauri/src/` — Rust: `vault/` (scan/parse/write, and `comments.rs`,
  each page's comment sidecar under `.comments/`; `receipt.rs` is the
  receipt every write carries, minted only by its door's guard, M58.1;
  `corpus.rs` is search's stat-keyed cache, one read per changed file and
  never an index, M17.19 and M59.4; `trash.rs` is the vault's own Trash,
  where a delete waits in `.trash/<stamp>/` until Settings restores it or
  the launch purge hands it to the OS Trash, M60.8; `schema.rs` reads Type
  docs and checks values by `shared/schema/field-kinds.v1.json`, and
  `dates.rs` reads dates by `shared/calendar/dates.v1.json`, the tables TS
  reads too, M60.3; `query.rs` evaluates database queries over the readable
  corpus, held to the view evaluator by shared filter cases (M62.2);
  `agenda.rs` reads dated records in the readable scope, using shared agenda
  cases and making no availability judgment (M62.3); `views.rs` checks view
  suggestions against the shared vocabulary without writing (M62.4);
  `batch.rs` is the batch writer, a database-wide change
  checked whole, journaled, staged and renamed, and put back at the next
  start if it stopped, M60.6),
  `sheet/` computes page `cerebro-sheet` source fences on upstream IronCalc
  through a capped engine thread and writes nothing itself (M67.1); its
  `fence.rs` reads source blocks and `ai.rs` reads cells or calculates
  hypothetical inputs on a private copy (M67.2). `edit.rs` plans a checked
  source batch; `vault/write.rs::edit_sheet_page` holds the lock through
  planning, calculation and one receipted write (M67.2b). `grid.rs` rewrites
  row/column references and fills selections on a paused private workbook;
  shared grid cases hold the browser twin. Partial-formula completion reads
  the same upstream parser, and `FormulaInput.tsx` uses its character offsets
  with the pinned MIT function catalog (M67.3b). `src/sheet/SheetGrid.tsx` keeps selection/drafts local,
  `commitSheets.ts` gives each source change one page undo step, and
  `pendingSheets.ts` settles open drafts before page flush/quit (M67.3).
  `sheet/xlsx.rs` imports Excel through upstream `ironcalc`, after the shared
  Office package reader checks every part and bounds array/string expansion
  before upstream parsing. It returns source fences and a bounded loss/value
  report; calamine extracts text independently (M67.4). The same module exports
  live page fences through IronCalc's byte writer. `SheetExportMenu` settles
  drafts before workbook export; CSV carries shown values and guards text
  formula prefixes. Both save outside the vault through a native dialog (M67.4b).
  CSV uses `readCsvText` and the existing raw-record reader. Choosing a file
  writes nothing; Import creates one root page in one undoable human batch,
  `git/`, `mcp.rs`
  (the runs' loopback MCP server), `client_access.rs` (the optional second
  loopback listener for other apps, authenticated by personal tokens; token
  metadata and SHA-256 fingerprints live in `runtime/client_tokens.rs`,
  and each client session has its own run, M62.5–.5c), `agent/` (CLI spawn; `fold.rs` folds the live
  stream and Claude Code's session file into one event vocabulary, and
  `transcript.rs` finds that file and reads it back; `interaction.rs` is the
  ask seam's book, where a run waits on a call and only a person's answer
  resumes it, and where the Allow of an ask-first agent's page write waits
  for dispatch: an Agent record's `ask-first:` and the tool manifest's
  `confirmable` column, M57.4; `thread_turn.rs` is an @agent turn in a
  comment thread, M70.4), `comment_tools.rs` (the agent comment tools,
  M70.3), `knowledge.rs` (OKF guards),
  `files/` (`kinds.rs` reads `shared/files/kinds.v1.json`, and its
  `open_policy` is the one verdict on whether a file may open outside the
  app, M66.1; `extract/` owns bounded Office parsing, `read.rs` selects
  scoped document text and pictures, and `images.rs` alone decodes them),
  `connectors.rs`, `shell/` (`notify.rs` is the one door to Notification Center: bundle-guarded
  permission and reminder posts, with no Dock badge; the main window, built in setup so its
  navigation guard is attached and its title follows the page's; `open.rs`
  is Open with: Finder, the default app, agent links and the clipboard;
  `file_actions.rs` guards contained root files by the kinds table, pins Open
  to the original file identity, and supplies Reveal, Quick Look and Save a copy;
  `deep_link.rs` buffers incoming `cerebro:` links until the webview and vault
  are ready, then only navigates inside registered vaults;
  `quit.rs` owns ⌘Q and the close guard, which flush every pending save
  before exit (M55.10), while Dock Quit, logout and shutdown exit without
  them), `runtime/fleet.rs` (run history, and the `agent_wakes` the Agents
  lobby lists as waiting, skipped or expired, M63.1b) and `runtime/activity.rs`
  (History's read: write rows, runs and app sessions, folded in
  `src/engine/activity.ts`, M64.2), both SELECT-only,
  read through `runtime::ReadOnly`, a connection SQLite refuses writes on; a
  phase that needs a new fact still goes through the Meter or the governance
  writers. `runtime/wakes.rs` holds durable wakes (M63.1): each trigger match
  is admitted once, claimed inside the dispatch transaction with its run's
  lease, and ends in a closed outcome. `agent/condition.rs` books and meters
  a trigger's bounded pre-run check with its own held answer tool (M63.7).
  `runtime/followups.rs` holds self-only later runs with an atomic booking
  cap and one conditional claim before firing (M63.8).
  `runtime/batch_journal.rs` holds a
  batch's row while it runs (M60.6): its pages' pre-images, deleted at the
  commit.
- `shared/policy/mail.v1.json` — mail folders excluded from git and the scoped,
  default-closed Gmail admission gate; Rust and TS replay its shared cases.
- `shared/prompt/` — prose the model reads, which Rust compiles in and TS
  imports `?raw` (M54.7). `server-instructions.md` is the MCP `instructions`
  every run hears, whatever it holds; its README holds the rules (CV-19).
  `product-brief.md` is the one description of the product, which the system
  prompt and get_vault_context both carry, and `retired-terms.json` lists the
  words for the retired model that none of it may say (M54.8, CV-20).
- `shared/starter/` — the explicitly offered kit for an empty vault (M64.8):
  byte-identical markdown installed create-only in one batch. Its two agents
  start paused; its two read-only recipes remain editable Skill pages (M64.9).
  `.cerebro/starter.json` records an added or declined offer.
- `shared/files/` — what a file is (M66.1): `kinds.v1.json` gives each
  extension its kind, MIME, viewer, extractor, ingest rule, Shiki language,
  icon, bytes door and open policy. Rust (`src-tauri/src/files/kinds.rs`)
  and TS (`src/engine/fileKinds.ts`) read the same bytes; its README holds
  the columns and the regen command.
- `shared/import/` — source identity and writer-owned provenance (M69.3):
  Rust `import/` and TS `engine/importSources.ts` read `sources.v1.json`.
  The import planner finds copies by stamped identity wherever they moved;
  `vault/batch.rs` serializes imports before its path locks, then journals
  their creates and checked replacements as one undoable change. Edited
  copies stay as they are, and every request gets an explicit outcome.
- `src/engine/csv.ts` is the frontend RFC 4180 reader and writer (M61.5).
  CSV import, export and migrations reuse it; Rust `sheet/fence.rs` is its
  sheet-fence twin, held by `src-tauri/fixtures/sheet-fence-cases.json` (M67.2).
  `csvImport.ts` plans one
  undoable create batch for the database and its records.
- `shared/schema/views.v1.json` is the view suggestion vocabulary (M62.4):
  `engine/viewVocabulary.ts` and Rust `vault/views.rs` read the same layouts,
  slots and limits; `engine/viewSuggestion.ts` and its Rust twin check the
  readable database before a suggestion can become a card. They replay
  `src-tauri/fixtures/view-suggestion-cases.json`; the tool writes nothing.
- `demo-vault/` — the golden corpus. Dev, vitest, and Playwright all run
  against it; editing it churns e2e assertions, so treat changes as test
  changes.
- **`docs/archive/` and `docs/examples/` are gitignored vendored reference,
  NOT documentation** — third-party repos and material kept for study. Never
  lint, test, or grep them as project code. Milestone plan and spec docs live
  in `docs/superpowers/plans/` and `docs/superpowers/specs/` and are tracked
  normally (the old `docs/archive/superpowers/` path and its `git add -f`
  ritual are gone).
- `scripts/` — seeders, mac packaging and repo-level guard tests. Typechecked
  via `tsconfig.tools.json`. `scripts/cli-record/` is the CLI recording kit
  (M56.1): it records Claude Code in an isolated config outside the repo
  (`spike.ts`, against the toy `probe.ts`), reduces each run to a fixture
  (`reduce.ts`), sanitizes whole runs into `cli-stream/real/` (`sanitize.ts`,
  M56.2) and refuses any leak through one pattern list (`scan.ts`).

## Conventions that will bite you

Rules carry a permanent id, `CV-NN`. An id is never renumbered or reused: a
retired rule leaves a gap, and a new rule takes the next free number. A rule's
last line, `enforced:`, names what fails when the rule breaks, or says `prose`
when only review holds it. `scripts/conventions.test.ts` resolves every pointer.

- **CV-02 Commits**: `type(scope): sentence (M<milestone>.<n>)` — see `git log`.
  One milestone phase per commit where possible.
  enforced: prose
- **CV-03 Store-layer error invariant — human-UI actions only** (re-scoped M24.2):
  actions behind a human action never throw. They catch, `toast()`, and
  return `null`/`false`; call sites may fire-and-forget with `void`. Anything
  that breaks this needs a written reason at the call site.
  **Proposal channels are exempt, and must be.** They return a typed
  `applied | queued | rejected { code, rule, expected, actual }` result that
  the caller is expected to READ and act on — a queued HIGH-risk mutation is
  not an error to toast away, and a `stale_target_version` rejection is a
  card the user has to see. Collapsing those into `null` would throw away
  the whole point of typing them.
  enforced: prose
- **CV-04 Policy is data**: `shared/policy/` is loaded by Rust (`include_str!`) and
  TS (vite) from the SAME files. A policy rule implemented as twin Rust and
  TS code is a review-blocking defect — grow the table format instead
  (a vault semantic may twin only under D3, below).
  Parity is the shared artifact plus `shared/policy/goldens/`; see that
  directory's README before editing either artifact (both have regeneration
  steps that are deliberate, `#[ignore]`d tests). Tool facts are data too
  (M54.2): `tools.v1.json` names each cerebro tool and CLI built-in, Rust
  serves and gates from it, and TS derives the picker, the icons and the write
  checks from it, so a tool list typed in either language is the same defect.
  Where Rust and TS must agree on a vault rule (D3), one shared artifact or
  case file holds both, replayed by cargo and vitest; `shared/policy/README.md`
  lists every twin, and an unlisted twin is the same defect. Field kinds and
  dates are such artifacts (M60.3): `shared/schema/` and `shared/calendar/`.
  JSON Canvas format and reader rules live in `shared/canvas/` (M68.2),
  replayed by both readers; the scanner includes boards without ingesting them.
  Whiteboard agent caps are data too (M68.7): `shared/canvas/agent-limits.v1.json`
  bounds an agent read; Rust and TS load it and assert the same digest.
  Import source identity, stamps and URL grammar are data too (M69.3),
  read from `shared/import/sources.v1.json`.
  File kinds are data too (M66.1): `shared/files/kinds.v1.json` names each
  extension's kind, MIME, viewer, extractor, ingest, Shiki language, icon,
  bytes door and open policy; Rust alone enforces open and the doors, and TS
  derives icons, languages and ingest from it.
  enforced: `src/engine/scene/canvasLimits.test.ts::hashes to the digest the Rust loader also asserts`, `src-tauri/src/canvas/agent_limits.rs::the_loaded_bytes_match_the_committed_digest`, `src/engine/scene/format.test.ts::hashes to the digest the Rust reader also asserts`, `src-tauri/src/canvas/format.rs::the_loaded_bytes_match_the_committed_digest`, `src/lib/policy/table.test.ts::hashes to the digest`, `src-tauri/src/policy/table.rs::the_loaded_bytes_match_the_committed_digest`, `src/lib/policy/tools.test.ts::hashes to the digest the Rust core also asserts`, `src-tauri/src/policy/tools.rs::the_loaded_bytes_match_the_committed_digest`, `src/engine/fieldKindTable.test.ts::hashes to the digest the Rust reader also asserts`, `src-tauri/src/vault/schema.rs::the_loaded_bytes_match_the_committed_digest`, `src/engine/dateGrammar.test.ts::hashes to the digest the Rust reader also asserts`, `src-tauri/src/vault/dates.rs::the_loaded_bytes_match_the_committed_digest`, `src/engine/viewVocabulary.test.ts::hashes to the digest the Rust reader also asserts`, `src-tauri/src/vault/views.rs::the_loaded_bytes_match_the_committed_digest`, `src/engine/fileKinds.test.ts::hashes to the digest the Rust reader also asserts`, `src-tauri/src/files/kinds.rs::the_loaded_bytes_match_the_committed_digest`, `src/engine/importSources.test.ts::hashes to the digest the Rust reader also asserts`, `src-tauri/src/import/mod.rs::the_compiled_sources_match_the_digest`, `scripts/twins.test.ts::every listed twin replays its cases in both suites`
- **CV-05 Absent is never zero, and unavailable is never empty.** A number nobody
  recorded renders as words ("not recorded", "unknown", "unattributed"), never
  as `0` or `$0`; a total that had to skip unmetered rows says how many it
  skipped rather than absorbing them. A read that FAILED renders
  `section-unavailable`, never the empty state — "nothing is waiting" and "we
  could not tell you what is waiting" are opposite sentences, and a surface
  that says the first when it means the second is worse than one that says
  nothing. M33 retired two `catch → empty` collapses (`ReviewPage`,
  `PipelinePage`) for exactly this; do not reintroduce one. `Option`/`null`
  from Rust means NOT RECORDED and an empty collection means measured-at-zero,
  so never map one to the other on the way through.
  enforced: prose
- **CV-06 Two records, two destinies**: every refusal names a code whose
  ledger-or-operational destiny is declared in the shipped policy table —
  `shared/policy/policy.v3.json` since M27.4; v1 and v2 are frozen negative
  controls, never edited. Epistemic
  history goes in the vault ledger; schema mistakes, malformed arguments,
  and capability gaps go in `<app-data>/runtime.db`. When in doubt:
  operational. Promoting a code into the ledger needs a
  coverage-materiality argument in review. The diagnostic log
  (`<app-data>/logs/cerebro.jsonl`, 1 MiB plus one rotation, redacted) is
  neither record: product logic never reads it, no refusal lands there,
  nothing exports it, and Rust prints nowhere else unless an `#[expect]`
  says why.
  enforced: `src/lib/policy/table.test.ts::declares a destiny for every code`, `src-tauri/src/policy/table.rs::destiny_is_declared_for_every_code_an_op_can_produce`, `src-tauri/src/rails.rs::the_log_has_no_reader`, `src-tauri/src/rails.rs::nothing_prints`
- **CV-07 Knowledge is guarded**: `knowledge/` is agent-written, human-VERIFIED.
  Writes go through `write_concept`/`recheck_concept`/`verify_concept`
  only; the mock backend (`src/lib/mockIpc.ts`) must mirror every Rust-side
  guard, and that parity is itself tested.
  enforced: `src/lib/mockIpc.test.ts::knowledge/ read-only boundary`, `src-tauri/fixtures/note-targets.json`
- **CV-08 No type special-casing**: behavior is capability-gated (a record with a
  status field is task-like; a record the base holds concepts about gets a
  dossier). Do not route on type names. The only exceptions are the reserved
  names `isReservedTypeName` lists in `src/engine/typeCatalog.ts`: `Type`,
  `Collection`, `Skill` and `Agent`. A relation reaches Agent only through a
  declared `target: Agent`; no inference and no person field ever yields a
  reserved type (M63.3).
  enforced: prose
- **CV-09 Wikilink fields** arrive from the scanner bracket-stripped in
  `entry.relationships`, not `properties` — test fixtures must use that shape.
  A target is read whole first, then as the page before its first `#`
  (M55.8); the fragment stays in the file and in `outgoingLinks`.
  A target resolves by filename stem, then a project.md's folder, then an
  item key (`key: PREFIX-N`), then title, case-insensitively; the first entry
  in path order wins (M60.9). Rust's `TargetIndex` and TS's `targetIndexFor`
  replay one case file, `src-tauri/fixtures/wikilink-targets.json`.
  enforced: `src-tauri/src/vault/entry.rs::wikilink_arrays_become_relationships`, `src/lib/scanGolden.test.ts`, `src-tauri/src/vault/link.rs::replays_the_shared_target_cases`, `src/engine/wikilink.test.ts::replays the shared target cases`
- **CV-16 The webview never leaves its entry document** (M53.12).
  `src-tauri/src/shell/links.rs` routes every navigation and every
  `window.open` by `shared/policy/links.v1.json`: the entry document loads,
  `http(s)` goes to the system browser, everything else is refused. A web link
  needs no code — a plain `href` or `target="_blank"` reaches the guard.
  `pnpm dev` has no guard (Chromium follows links itself), so surfaces keep
  routing vault paths in-app, never through an `href`. Only a packaged build
  proves it. Agent links (M55.9) are a command, not a navigation:
  `shell/open.rs` opens only `shared/policy/agent-links.v1.json`'s bases.
  A file leaves the app only through `open_file_outside`, which reads the
  kinds table's open verdict (allow; confirm, asked by a native dialog;
  deny) and never opens an executable-like file. Reveal, Quick Look and
  Save a copy never run a file.
  enforced: `src-tauri/src/shell/links.rs::replays_the_shared_link_cases`, `src-tauri/src/shell/mod.rs::both_guards_are_attached`, `src-tauri/src/shell/open.rs::replays_the_agent_link_cases`, `src-tauri/src/shell/file_actions.rs::deny_never_reaches_the_desktop`
- **CV-10 Suppressions carry reasons**: every `eslint-disable` states why, in place.
  The compiler-era react-hooks rules are off by documented choice
  (`eslint.config.js`) — candidates to ratchet on, not free to violate.
  Rust suppressions are `#[expect(lint, reason = "...")]` (M53.21): clippy
  refuses an `#[allow]` and an expectation without a reason, and an
  expectation that stops firing fails the gate. `src-tauri/clippy.toml` bans a
  raw `Command::new` (children start in `src-tauri/src/spawn.rs`) and
  `set_var`/`remove_var`. Only review holds the `eslint-disable` half so far.
  enforced: `src-tauri/Cargo.toml`, `src-tauri/clippy.toml`, `src-tauri/src/rails.rs::suppressions_are_reasoned_expectations`, `src-tauri/src/rails.rs::spawns_and_env_mutation_are_banned_with_reasons`
- **CV-11 A retired workaround needs its original comment killed.** When a
  constraint stops being true, the fix includes deleting the comment that
  explained the old shape. M31 planned to kill five in our own tree — the
  assembly prompt's "no tools" claim, the three "Not narrowed here"
  rationales (counted once), the assembly capability-absence comment, the
  run_cost_components "no producer" note, and this file's own policy.v1
  reference — and review found five more the same commits had falsified
  (ambient's ledger-appender count, schema.rs's "nothing reads them yet",
  and the trigger module's three "fourteen" claims). Budget for that: the
  comment a change falsifies is rarely the comment the change is about.
  enforced: prose
- **CV-12 Ratchets only tighten**: coverage thresholds in `vite.config.ts` never go
  down.
  enforced: prose
- **CV-13 Sources stay text**: `.gitattributes` pins sources to text after two
  files went binary from embedded control bytes (raw NUL, literal BOM). Write
  escapes (`\0`, `\uFEFF`), never raw control characters.
  enforced: `src/lib/sourceIsText.test.ts`, `.gitattributes`
- **CV-18 Only the four adapters talk to Rust** (M54.3). `src/lib/ipc.ts`,
  `gitIpc.ts`, `rootsIpc.ts` and `src/agent/agentIpc.ts` alone invoke or
  listen, each call behind `inTauri()` beside its browser branch. Command
  names and payload keys are literals: each name is in `generate_handler!`,
  and each key is a parameter as Tauri spells it. Tauri drops a key a command
  does not declare and reads a missing `Option` as `None`, so a misspelt key
  widens a run without a word. A command no app file reaches stays, flagged
  in `UNCALLED` with a reason. An adapter export nothing calls goes, unless
  every command it invokes is flagged.
  enforced: `src/lib/ipcContract.test.ts::the webview and Rust agree on every command`
- **CV-19 A prompt names only the tools its run holds** (M54.7). Prompt
  lines are typed fragments that declare the tools they name, composed
  against the run's grant (`src/engine/toolGrant.ts`, held to Rust's `narrow`
  by `src-tauri/fixtures/tool-grants.json`). Prohibitions name none. The
  rules that hold for every grant are `shared/prompt/server-instructions.md`,
  served as the MCP `instructions`: it names no tool and stays at most 2048
  characters.
  The M9.5 propose_organize sentence is fixed text.
  enforced: `src/agent/promptGrant.test.ts`, `src-tauri/src/mcp.rs::the_server_instructions_name_no_tool`
- **CV-20 One product brief, and no retired term** (M54.8). The brief is the
  only description of the product the model reads: the system prompt opens
  with `shared/prompt/product-brief.md` for every grant, and get_vault_context
  ends with it. It names no tool and never mentions the knowledge bundle,
  which only runs that declare `knowledge` hear about (M34.1.3). A term from
  `shared/prompt/retired-terms.json` in the brief, the server instructions, a
  prompt, the tool manifest, get_vault_context or the welcome screen fails the
  build. A term that retires joins the list; copy that trips on one is
  reworded, never let through by trimming the list.
  enforced: `src/lib/productBrief.test.ts`, `src-tauri/src/mcp.rs::get_vault_context_speaks_the_current_model`, `src/App.test.tsx::welcomes a new user with no retired term`
- **CV-21 One writer per file** (M55.1). A write that reads its file first
  holds that file's path lock from the read to the rename (`rewrite_note`, or
  `lock_paths` for a create, copy or move). A check judges the bytes the lock
  holds, never an earlier read.
  enforced: `src-tauri/src/vault/write.rs::two_writes_to_one_note_take_turns`
- **CV-22 Imported text is never the owner's word** (D15 (i), M66.7b). A note
  whose frontmatter names a `source_system` registers in the ledger under
  `vault-import-v1`, content-only, never as `human:owner`. Only knowledge/
  outranks it, and nothing re-keys an item already recorded. M69's import
  writer keeps the key.
  enforced: `src-tauri/src/ingest/source.rs::an_import_never_carries_human_authority`, `src-tauri/src/ingest/deterministic.rs::an_imported_capture_registers_as_imported_content`
- **CV-23 Agent writes compare; editor saves win** (D2, M55.3, M65.7). An agent's
  note write may carry `expect_hash` (get_note's Hash line) and lands only on
  those exact bytes; otherwise it is refused as `stale_content` (operational)
  and nothing is written. Editor saves never compare: the last write wins.
  Human writers outside the editor (task ticks and Library drafts) compare the
  version they read; a conflict refreshes the task list or asks the person
  whether to load the new version or save their draft anyway. The
  ledger's `expected_version` and `stale_target_version` guard a different
  record, and neither is borrowed for the other.
  enforced: `src-tauri/src/mcp.rs::a_stale_expect_hash_is_refused_and_leaves_the_file_alone`, `src-tauri/src/vault/write.rs::a_stale_save_from_outside_the_editor_writes_nothing`
- **CV-24 Every block the editor offers has a disk carrier, or it is not
  offered** (M55.4). A block a `/` entry inserts saves as markdown that
  reopens as the same block and saves the same bytes again: plain markdown, or
  a carrier (`:::toggle`, `:::toggle-heading`, `:::indent`, a
  `![name](url "caption")` line, the `:::columns` and `:::ai` containers). An
  entry that cannot leaves the menu (`DROPPED_SLASH_KEYS`), and a toolbar or
  block-menu action whose effect a save drops leaves its menu
  (`UNCARRIED_ACTIONS`, M55.15: underline, colour, alignment, merged cells,
  the table header toggles). The tests walk the editor's own `/` builder,
  whose `KNOWN_LOSSY` can only stay empty, and class every toolbar key.
  enforced: `src/editor/markdown.test.ts::every / item survives a save or is not offered`, `src/editor/markdown.test.ts::every toolbar and block-menu action survives a save or is not offered`
- **CV-25 Agent grants write on Done, never per keystroke** (M55.12). A
  half-built grant is live to the background runner: a bare
  `{event: changed}` trigger is valid and fires on every change. So each of an
  agent page's grant rows edits a draft seeded when it opens, and Done writes
  only that row's key(s) through `agentPatch`; Cancel and Escape write nothing,
  and no surface edits an agent's grants through the generic property editor.
  enforced: `src/library/AgentProperties.test.tsx`
- **CV-26 Recorded CLI output is sanitized, and every kind it shows is
  classified** (M56.2). Real recordings reach
  `src-tauri/fixtures/cli-stream/real/` only through
  `scripts/cli-record/sanitize.ts`, and no fixture under `cli-stream/` holds a
  user path, an email, a host name, a token or a real id. Every stream kind a
  real recording shows is translated or listed as ignored, with its reason, in
  `src-tauri/src/agent/kinds.rs`.
  enforced: `scripts/fixtures.test.ts`, `src-tauri/src/agent/recordings.rs::every_real_recording_shows_only_classified_kinds`
- **CV-27 One fold, one reducer** (M56.3). Claude Code's live stream and its
  session file fold through `src-tauri/src/agent/fold.rs` into one event
  vocabulary, and `src/agent/transcript.ts` is the one reducer from events to
  messages, live and restored. A third reader of either format is a defect;
  the meter's Tally reads raw lines for accounting only, and
  `transcript::pending_deferral` reads the session file's tail only for an
  open deferral marker (M57.1).
  enforced: `src-tauri/src/agent/fold.rs::every_recorded_line_is_classified`, `src/agent/transcript.test.ts::replays the transcript goldens`
- **CV-28 A run waits; only a person answers** (M57.1). A run asks through
  its own loopback connection and can only wait: no MCP tool, hook or bearer
  records an answer; answers enter through `answer_interaction`, a Tauri
  command. A tool the gate may defer is never pre-approved in argv, so a hook
  that fails or never runs leaves the call refused.
  enforced: `src-tauri/src/agent/interaction.rs::only_the_answer_command_mints_a_person_answer`, `src-tauri/src/agent/mod.rs::a_tool_the_gate_may_defer_is_never_pre_approved`
- **CV-29 One table decides what Claude Code may run** (M57.2). Whether one
  of the CLI's own tools runs, asks the person or is refused, and which vault
  folders its readers may not open (M60.8b, the Trash), is decided only by
  `shared/policy/tool-approval.v1.json`, by tool family (the manifest's
  `family` column), run kind and ceiling. Allow and deny ride argv; ask and
  refuse meet the gate on a seated run and are never pre-approved, and
  refuse rides `--disallowedTools` where no gate sits, so a hook outage fails
  closed. A writer or the shell that an agent's record narrows out is denied
  in argv, so acceptEdits can't approve it. A run nobody watches never asks:
  its asks become denials, recorded as one `capability_unavailable` row.
  enforced: `src-tauri/src/policy/tool_approval.rs::replays_the_tool_approval_goldens`, `src/lib/policy/toolApproval.test.ts::replays the tool-approval goldens`
- **CV-30 A turn outlives its panel** (M57.6). Closing the assistant,
  switching threads or starting a new one detaches a running turn and never
  stops it; only Stop, Steer, deleting its thread, a vault switch and quit
  end a run. Every live event carries a run-local seq, and the panel
  re-attaches through `agent_events_since`, so each event shows once.
  enforced: `src/agent/useAgentChat.test.tsx::closing the panel mid-turn detaches and never stops the run`, `e2e/agent-detach.spec.ts`
- **CV-31 Comments live beside the page, never in it** (M70.2). A page's
  threads are `<vault>/.comments/<page path>.json`. Only `vault/comments.rs`
  and its mock twin write them, under the page's path lock, and a rename or
  delete carries them. No comment action writes the page. The scan, search,
  vault-changed and every note writer leave `.comments/` alone. A sidecar
  that does not parse reads as unavailable and is never overwritten.
  enforced: `src-tauri/src/vault/comments.rs::a_comment_never_touches_the_page_bytes`, `src-tauri/src/vault/comments.rs::replays_the_shared_comment_cases`, `src/engine/comments.test.ts::replays the shared comment cases`
- **CV-32 An ask-first write lands only on a person's Allow** (M57.4). On an
  agent whose record says `ask-first: true`, a write the tool manifest marks
  `confirmable` reaches disk only through an Allow the person gave in the
  app, in an attended card or in Review (M57.4c: a run nobody watches queues
  it there). Rust reads ask-first from the agent's own record, so the
  renderer can only tighten it. Rust's dispatch is the boundary: argv, hooks
  and the user's own allow rules can only ask sooner, never approve, and
  only the webview's answer commands mint an approval or apply a queued
  write.
  enforced: `src-tauri/src/mcp.rs::an_ask_first_write_never_lands_without_a_persons_allow`, `src-tauri/src/mcp.rs::a_renderer_cannot_drop_ask_first`, `src-tauri/src/mcp.rs::an_unattended_ask_first_write_waits_in_review_and_nowhere_on_disk`, `src/lib/policy/toolApproval.test.ts::replays the tool-approval goldens`
- **CV-33 Every vault write carries a receipt** (M58.1). A writer in
  `vault::write`, the ledger's concept writers and git's discard take a
  `WriteReceipt<Door>` (Human, Agent, ConceptDoor, System) that only its
  door's guard can mint, and record actor and run_id in `vault_writes` under
  the path the scan lists, or are listed in `UNRECORDED` with their reason.
  IPC doors stamp `human:me`; MCP doors stamp the run's grant, and a write a
  person allowed names them as approver; the mock stamps the same doors.
  enforced: `src-tauri/src/vault/receipt.rs::receipts_are_minted_only_at_their_doors`, `src/lib/mockIpc.test.ts::replays the shared write doors`
- **CV-34 A run commits only what it wrote** (M58.3). When a run ends, Rust
  commits exactly the paths its `vault_writes` rows and its own completed
  Write and Edit calls name (a deferred call's commits with the run that
  resumes it), one commit at a time per repository, with `Cerebro-Run` and
  `Cerebro-Actor` trailers. Every other commit leaves a live run's paths
  alone.
  enforced: `src-tauri/src/git/changeset.rs::a_run_commit_takes_only_its_paths`, `src-tauri/src/git/commit.rs::commit_all_leaves_a_live_runs_paths_alone`, `src-tauri/src/agent/mod.rs::a_deferred_write_commits_with_the_run_that_resumes_it`
- **CV-35 Attribution is recorded, never inferred** (M58.4). History names
  an agent for a commit only when runtime.db's `run_commits` record says
  that agent's run made it; a run's commit writes that row and nothing else
  does. A trailer, a message, a git author or a `vault_writes` row never
  names one; on a recorded commit, `vault_writes` rows only add who else
  edited it. Everything else reads "unattributed", and a record that could
  not be read reads "attribution unknown".
  enforced: `src-tauri/src/runtime/fleet.rs::a_commit_names_a_run_only_from_its_record`
- **CV-36 Only a person asks an agent in a thread** (M70.4). A comment
  thread starts an agent's turn only from a person's own comment that names
  it with `@handle`, through `start_thread_turn`. An agent's comment, reply
  or answer never starts one, and a reply without a mention infers nothing.
  The turn runs under the agent's own record with no shell, web or
  connectors, and Cerebro, not the agent, posts the answer in place of the
  placeholder bound to the run's id; a deleted placeholder drops the answer.
  enforced: `src-tauri/src/agent/thread_turn.rs::an_agents_comment_never_starts_a_turn`, `src-tauri/src/agent/thread_turn.rs::only_the_command_starts_a_thread_turn`
- **CV-37 Nothing is hard-deleted** (M60.8). Deleting moves a page and its
  comments to `.trash/<stamp>/<path>`, outside scan, search and Cerebro's
  agent tools. Restore refuses to overwrite. The launch purge moves items
  past 30 days to the OS Trash. No code under `vault/` unlinks a page.
  enforced: `src-tauri/src/vault/trash.rs::no_vault_writer_unlinks_a_page`, `src/lib/mockIpc.test.ts::replays the shared trash cases`
- **CV-38 A database-wide rewrite is one batch** (M60.6). A human action
  that rewrites a database's records — a property rename, kind change or
  copy, a bulk delete — sends them with the Type doc as one `applyBatch`:
  validated, journaled in runtime.db, staged, renamed, and rolled back on the
  next start if it stopped partway. It refuses knowledge/, its caps and a
  missing journal.
  enforced: `src-tauri/src/vault/batch.rs::a_batch_stopped_between_its_temps_and_renames_rolls_back_on_the_next_start`, `src/app/typeActions.test.ts::database-wide rewrites send one batch`
- **CV-39 Undo puts back only what still stands** (M60.7). Undo and redo act
  on the person's own batches and Trash moves from this session, never on
  knowledge/ or proposal decisions. A file nothing touched since returns byte
  for byte; otherwise each key reverts only while it holds what the change
  wrote, and the rest is kept, its writer named only from a recorded write.
  enforced: `src-tauri/src/vault/batch.rs::revert_skips_keys_changed_since_and_keeps_the_rest`, `src/stores/undoStore.test.ts::never applies to knowledge/ or proposal decisions`
- **CV-40 References follow renames** (M60.2). Every stored view, layout,
  tab, field-spec and list key is classified in `src/engine/fieldRefs.ts`,
  and a field is renamed only through `renameFieldOnType`, and a database
  only through `renameDatabase`, each as one batch.
  List files, agent triggers and knowledge/ pages that name the field are
  flagged, never rewritten.
  enforced: `src/engine/fieldRefs.test.ts::every classified key is walked`
- **CV-41 Renames keep links, and links are stems** (M60.10). Every move
  and rename the webview makes goes through `src/app/renameActions.ts`: each
  wikilink whose target it would change is re-pointed at the page's filename
  stem in the same batch, alias and section kept; knowledge/ `about:` anchors
  go through the capture valve; what can't change is listed before anything
  moves. Cerebro writes links with `linkTargetOf` (the filename stem, or a
  project.md's folder), never by title.
  enforced: `src/app/renameActions.test.ts::only renameActions renames a file`, `src/app/renameActions.test.ts::no module writes a title link`, `src/engine/linkRewrite.test.ts::a rename leaves every link pointing where it pointed`
- **CV-45 The whiteboard scene core stays self-contained** (M68.1).
  `src/engine/scene/` imports only its own files, perfect-freehand (in
  `ink.ts` alone) and fractional-indexing (in `order.ts` alone), reads no
  clock or randomness, and takes every new id from its caller.
  Only `format.ts` reads `shared/canvas/format.v1.json`, and only
  `canvasLimits.ts` reads `shared/canvas/agent-limits.v1.json`.
  enforced: `src/engine/scene/boundary.test.ts::the scene core imports only itself and its two upstream libraries`, `scripts/lint-rails.test.ts::engine imports admit the two scene libraries and no subpath`
- **CV-46 An agent's reach is derived, never restated** (M58.6). What an
  agent may read or change on a page comes from `src/engine/agentAccess.ts`
  over the tool manifest, `tool-approval.v1.json` and the record's own axes.
  Its folder grammar twins Rust's `folder_list` (hand-offs and thread turns
  alike) and `scope_admits`, held by `src-tauri/fixtures/grant-scope.json`,
  and a scope that names no folder scopes to nothing in both.
  enforced: `src-tauri/src/mcp.rs::replays_the_shared_scope_cases`, `src/engine/agentAccess.test.ts::replays the shared scope cases`
- **CV-47 App shortcuts go through the keymap** (M65.1). A shortcut is a row
  in `src/app/commands/*.commands.ts`, bound with `useCommand` and dispatched
  by the one capture-phase listener in `src/lib/keys/root.ts`; Settings →
  Keyboard shortcuts and keycap hints render the catalog (M65.1b). Every other keydown listener is
  listed with its reason. Escape belongs to `layers.ts`, and letters stand
  down in editors, claimed elements and modal layers. A chord hints after
  200 ms and expires after 2 seconds; an unrecognized second key passes
  before the hint and is consumed after it.
  enforced: `src/lib/keys/keydownRail.test.ts::every keydown listener outside the keymap is listed with a reason`, `src/app/commands/index.test.ts::no command binds Escape`

- **CV-48 Wakes an agent caused are chain hops** (M63.2). Admission reads the
  writer from `vault_writes`. A recorded run's write makes the wake a hop of
  that run: two hops, no cycles, the root's chain allowance. A person's write,
  or one Cerebro did not record, wakes a root, and an unrecorded author is never
  labelled a person.
  enforced: `src-tauri/src/runtime/wakes.rs::an_agent_write_that_would_wake_its_author_is_skipped_as_a_cycle`, `src-tauri/src/runtime/wakes.rs::an_unrecorded_author_wakes_a_root_never_a_person`, `src-tauri/src/runtime/dispatch.rs::a_woken_hop_claim_books_its_parent_on_the_run_row`

- **CV-49 Other apps reach a vault only through a personal token** (M62.5b).
  The run port keeps its private per-run bearer and never answers 401. The
  client port is off by default, binds loopback only, stores each token as
  its SHA-256 alone, and dispatches through the normal tool guards under one
  runs row per client session. A client connection never enters a Cerebro
  run's MCP configuration.
  enforced: `src-tauri/src/runtime/client_tokens.rs::a_minted_token_is_stored_as_its_hash_alone`, `src-tauri/src/client_access/listener.rs::every_answered_call_carries_its_session_run`, `src-tauri/src/client_access/listener.rs::nothing_listens_until_turned_on`, `src-tauri/src/mcp.rs::a_cbr_token_on_the_run_port_is_an_unknown_bearer`, `src-tauri/src/agent/mod.rs::client_access_keeps_every_run_on_its_per_run_mcp_config`

- **CV-51 File bytes stay inside their open root** (M66.2). The media scheme
  and raw-byte IPC read through `files/bytes.rs`, using one contained open
  handle from check to read. Root `0` resolves the current vault on every
  request; a mounted root resolves by ID. No URL names a vault path. The
  scheme serves only media rows to the main webview, with bounded ranges,
  and never becomes a navigation door. Refusals are UI values, never logs.
  The browser twin replays `shared/files/bytes.v1.json`.
  enforced: `src-tauri/src/files/bytes.rs::replays_the_shared_bytes_cases`, `src/lib/mockBytes.test.ts::replays the shared bytes cases`, `src-tauri/src/files/scheme.rs::only_the_main_webview_is_served`
- **CV-52 One live editor per file** (M65.8). A file shows in one pane at
  most, or in the record peek. `claimOf` in `src/engine/panes.ts` keys every
  Selection kind by its edited file path, and Work and Inbox are single.
  Opening a held file focuses its holder, silently for the agent, and Back
  skips entries another pane holds. Inside a pane `useNavStore` reads and
  moves that pane; `useNavStore.getState()` is the focused pane.
  enforced: `src/engine/panes.test.ts::invariants hold over random sequences`, `src/stores/navStore.test.ts::opening a held file activates its pane`

- **CV-50 A `cerebro://` link only navigates** (M65.6). It arrives as
  `RunEvent::Opened`, waits in `shell/deep_link.rs` until the webview takes
  it once, names a vault only by its registered id, asks before switching
  vaults, and never writes or runs anything.
  enforced: `src-tauri/src/shell/deep_link.rs::the_take_hands_over_once`, `src/app/DeepLinkHost.test.tsx::a delivered link writes nothing`

- **CV-53 Pointers follow a rename together** (M65.10). Panes and their
  history, favorites, recents and last place change on a rename only through
  `followRename` and `followTypeRename` in `src/app/pointers.ts`; a new pointer
  store joins them. The pane layout is per vault in `cerebro.panes`, pruned on
  load, and restores places only.
  enforced: `src/app/pointers.test.ts::only the rename hook remaps pointer stores`

- **CV-54 Only `src/lib/mockSheet.ts` and `*.ironcalc.test.ts` load
  `@ironcalc/wasm`** (M67.1). Sheets compute in Rust on upstream
  `ironcalc_base`; the browser mock computes them with the npm wasm at the
  same release. Lint keeps the import to those files, test setup refuses
  any other test that reaches the wasm and names the fix (mock
  `calculateSheets` from `@/lib/ipc`), and a pin test refuses diverging
  releases. The packaging patch adds only the upstream timezone shim that
  npm 0.8.3 omitted; engine and wasm bytes stay upstream. Every Rust workbook
  preparation or evaluation takes the engine-thread token, including agent
  scratch calculations (M67.2) and structural grid edits, fill and partial-formula completion (M67.3–.3b). The mock's exact report values come from
  `scripts/sheet-values/`'s project-owned reader of the cached upstream
  workbook carrier: the same unchanged engine release, no evaluation or
  source rewriting. Its generated wasm has a reproducible build and hashed
  source/lock/artifact provenance; only the mock and its real-engine tests
  load it (M67.2b).
  enforced: `eslint.config.js::ironcalc: {`, `src/test/ironcalcGuard.ts::installIronCalcGuard`, `scripts/lint-rails.test.ts::only mockSheet.ts and *.ironcalc.test.ts load the sheet wasm`, `scripts/ironcalc.test.ts::both engines pin one release`, `scripts/ironcalc.test.ts::the cached-value facade pins the same engine and its generated artifact has exact source provenance`, `src-tauri/src/rails.rs::ironcalc_evaluates_only_on_the_engine_thread`

- **CV-55 A board saves only after an edit, over readable bytes** (M68.2b).
  Opening, reloading and applying a clean outside update write nothing.
  Dirty outside merges retain the person's edit and may save. The canvas
  save door refuses a missing or unreadable file and new content its own
  reader refuses. `src/whiteboard/` owns the page and serial save lifecycle
  over the pure scene core; path locks and human receipts hold every save.
  enforced: `src-tauri/src/vault/write.rs::save_canvas_refuses_to_write_over_an_unreadable_board`, `src-tauri/src/vault/write.rs::save_canvas_refuses_content_it_cannot_read_back`, `src/whiteboard/useCanvasFile.test.tsx::opening and reloading a board write nothing`

- **CV-56 Page attachments copy through the human doors** (M66.6). Paste,
  OS drop, browser drop and Upload use `import_attachment` or
  `import_attachment_bytes`, bounded by the shared file-kind cap. Placement
  holds the attachments directory lock, reuses identical bytes only in the
  NFC/case-insensitive name family, and records a hash only for a new copy.
  It never follows the destination directory or a candidate symlink, never
  grants execute bits, and retains macOS quarantine protection. Editor URLs
  stay root-anchored markdown paths; one undo removes a placement batch.
  enforced: `src-tauri/src/vault/write.rs::replays_the_shared_attachment_names`, `src-tauri/src/vault/write.rs::attachment_candidates_and_the_folder_never_follow_symlinks`, `src-tauri/src/vault/write.rs::importing_and_pasting_the_same_bytes_reuses_without_changing_the_file`, `src/editor/attachments.test.ts::places a batch after its captured block in one undo step, with root-anchored durable media lines`

- **CV-57 Outside bytes are parsed only behind limits** (M66.7). Office
  archives open only in `src-tauri/src/files/extract/`: `package.rs` caps the
  file, its entry count and each inflated part before XML or workbook parsing.
  A DOCTYPE is refused, workbook reads remain sparse, and allocation-driving
  shared-string counts and formula indices are checked before calamine opens.
  Repeated references consume a materialized-data budget before strings are
  copied, and repeated inflation has a separate work cap. Outcomes are typed,
  never a panic or a silent empty result. Pictures decode only in
  `src-tauri/src/files/images.rs`, under `image::Limits`.
  enforced: `src-tauri/src/rails.rs::outside_bytes_are_parsed_only_behind_limits`, `src-tauri/src/files/extract/package.rs::a_part_past_its_cap_is_too_large_however_its_header_lies`

- **CV-58 Agent note writes preserve writer-owned provenance** (M69.3b).
  `shared/import/sources.v1.json` names the guarded keys. Every agent note
  door compares their presence and YAML value under the file's write lock,
  after the governed-type checks, including queued or approved writes.
  `cache_source` and `write_concept` stamp their own output; ordinary note
  tools cannot add, change or remove those stamps. Human edits remain free.
  enforced: `src-tauri/src/import/stamps.rs::replays_the_stamp_guard_cases`, `src/engine/importSources.test.ts::replays the stamp guard cases`, `src-tauri/src/import/door_tests.rs::no_agent_write_door_changes_a_stamped_key`, `src-tauri/src/import/door_tests.rs::every_note_door_is_covered_by_the_stamp_guard`

- **CV-59 Mail and its comments stay out of git** (M69.7).
  `shared/policy/mail.v1.json` names the kept-out paths and the default-closed
  admission gate. Checkpoints untrack previously tracked copies without
  deleting them; run commits withhold and count those paths. A gate opens
  only for its listed kinds in the one accepted vault-store scope; tests
  require its dated, fired evidence pack and R14 registration. Older commits
  retain material they already contained. Unattended runs and token clients
  cannot read mail through Cerebro; ambient ingestion skips it, unattended
  CLI readers and the declared connector readers are denied, and mail URLs
  never enter the web cache (M69.7b).
  enforced: `src-tauri/src/git/commit.rs::gitignore_keeps_mail_and_its_comments_out`, `src-tauri/src/git/commit.rs::a_tracked_digest_is_untracked_even_when_ignore_rows_exist`, `src-tauri/src/git/changeset.rs::a_run_that_wrote_only_digests_commits_nothing_and_counts_them`, `src-tauri/src/policy/mail.rs::the_gate_opens_only_after_the_pack_is_accepted`, `src/engine/mailPolicy.test.ts::the Gmail pack names its gate and kinds, and an open gate requires owner acceptance`, `src-tauri/src/mcp.rs::an_unattended_run_and_a_token_client_cannot_read_a_digest`, `src-tauri/src/mcp.rs::cache_source_refuses_mail_as_a_web_page`, `src-tauri/src/runtime/catchup.rs::ambient_ingest_never_reads_mail`, `src-tauri/src/agent/mod.rs::an_unattended_run_is_denied_mail_reading_connector_tools`

## Verifying UI work

OS file-drop specs use `window.__cerebroMockDrop({at, files, hold?})` and
`__cerebroMockDragLeave()`. Synthetic HTML5 drops exercise the browser route
only; Tauri consumes native drags and delivers paths through the shared
`lib/osDrop.ts` router. The editor, Inbox and Files properties register zones
on their React wrappers.

Whiteboard gesture proofs use a real pointer down, two moves past 3 px, then
up; a single event is a click. Plane controls are tested with `page.mouse`
at their measured bounds because the canvas input plane receives the gesture.

**CV-14 Only `*.mermaid.test.ts` may `import mermaid`.** Those files exist to measure
claims about the bundled renderer — the shape registry, the `style`/arrow syntax
our ops emit — and each pays ~4s of real parse/render for it. Everything else
under `src/` stays pure string code or mocks `../render` with a fixture svg
(`StructuralEditor.test.tsx`); a component test that reaches for real mermaid is
a component test that flakes under load. Lint limits the import to
`mermaid/render.ts` and `*.mermaid.test.ts`, and `src/test/setup.ts` fails any
other test file that reaches the renderer, naming the fix.
pdf.js follows the same import boundary (M66.5): only
`src/workspace/viewers/pdf/pdfjs.ts` and `*.pdf.test.ts` load pdfjs-dist.
The loader uses upstream's compatible legacy build, opens bytes with XFA
and wasm off, and never loads a scripting manager or sandbox. Upstream has
removed document eval rather than retaining an `isEvalSupported` switch.
Every other test mocks the loader; `pdfGuard` also fails swallowed imports.
enforced: `eslint.config.js::mermaid: {`, `src/test/mermaidGuard.ts::installMermaidGuard`, `scripts/lint-rails.test.ts::only render.ts and *.mermaid.test.ts load mermaid`, `eslint.config.js::pdfjs: {`, `src/test/pdfGuard.ts::installPdfGuard`, `scripts/lint-rails.test.ts::only the pdf loader and *.pdf.test.ts load pdfjs-dist`, `src/workspace/viewers/pdf/pdfjs.test.ts::opens inert bytes and filters annotations before any non-link widget can render`

Address a page pane by `data-pane-index`; `data-active` marks the focused
pane and `data-parked` marks one kept mounted at zero width (M65.9).

Playwright specs use `getByTestId`/`getByRole` against the mock backend
(`window.__cerebroMockFs` exposes the fake disk). **CV-15 Import `boot` from
`e2e/boot.ts`; never write your own.** It disables the background distiller,
pins the theme, and pins the CLOCK to `VAULT_TODAY` — the day the demo vault
was written to be read on. That last one is not optional: the corpus has
absolute dates and the app has relative-time logic, so an unpinned spec has a
shelf life. One expired in M26 and failed on every tree for days. The
browser timezone is fixed to UTC in `playwright.config.ts` for the same
reason. For live checks, follow the `verify-ui` dev skill; synthetic `blur`
events don't fire React `onBlur` (call `el.blur()`).
enforced: prose

**CV-44 A section that reads ships five lab presets** (M64.1). A file in
`src/lab/sections/` exports `section` or `sections`, each with a preset for
ready, empty, not recorded, partial and unavailable, built from the mock's
seeds and `failNext` (`src/lib/mockFaults.ts`); a browser branch reaches a
fault only through `faulted(command, …)`. The state lab (`pnpm dev`, then
`/state-lab.html?section=<id>&state=<state>`) mounts the real section over the
mock with the clock pinned to `VAULT_TODAY`, and vitest and e2e replay every
preset. Every section in `src/lab/sections/` carries all five states:
`labSections()` refuses one that does not. That a new section registers at all
is review's to hold. To see a section's states, open the lab rather than
staging data by hand (`e2e/boot.ts` `openStateLab` for a spec).
enforced: `src/lab/presets.ts::has no preset for`, `src/lab/presets.test.tsx::every preset renders the state it names`, `e2e/state-lab.spec.ts::every preset renders the state it names`

**A scattered e2e failure is usually the machine, not the branch.** The suite
runs in about a minute (124 tests, parallel — `workers` is Playwright's default
locally and `1` only in CI). A run that takes ten times that and fails a
handful of unrelated specs is a run that lost to something else on the box:
MEASURED once at 49 minutes and six failures across five untouched surfaces,
with Spotlight, iCloud and WindowServer holding the load average at 24, and
clean at 2.8 minutes the moment that settled. Read `uptime` before you believe
it, and re-run before you debug it.

**Reuse is opt-in since M32.7, and a busy port now fails loudly.** Playwright
starts its own dev server; a port already held fails with "… is already used"
instead of silently attaching. That noise is the feature — a port held by
another worktree used to be reused without a word, running the suite against
a different branch's app and producing confident, wrong failures. Set
`CEREBRO_E2E_REUSE=1` only when the running server is yours, or
`PORT=<free> pnpm e2e` to isolate. CI is unaffected (`CI=true` already
disabled reuse there).

## Dev skills

**CV-17 Dev skills are tracked and listed.** Each lives at
`.claude/skills/<name>/SKILL.md` with a `name` and a `description`, and the
list below names exactly the skills on disk. Claude Code loads them as skills;
any other agent reads the file as a runbook. They are tools for working on
this repo; product Skills are vault records (`type: Skill`).
enforced: `scripts/dev-skills.test.ts::the list names exactly the skills on disk`

- `verify-ui` — launch the app on a free port and prove a UI change in a real browser.
- `policy-artifact-edit` — edit an artifact under `shared/` without breaking the byte anchor.
- `land-stacked-pr` — land a PR stacked on another PR so its commits reach main.
- `dependabot-triage` — sort alerts and PRs into a bump, an override or a proposed dismissal.
- `record-cli` — record Claude Code runs on the pinned CLI and sanitize them into real fixtures.
