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
  `views/`, `pages/`, `app/`, `detail/`, `knowledge/`, `agent/`, `editor/`,
  `git/`, `library/`, `workspace/`, `status/` are surfaces; `stores/` is
  Zustand; `lib/` holds IPC + browser mocks. Lint (`eslint.config.js`) and the
  no-DOM typecheck (`tsconfig.engine.json`) keep `engine/` pure;
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
  quiet mono counts — never a filled pill (M42.1).
  The destination names are asserted in `app/Sidebar.test.tsx`, and every
  destination is one row of `engine/destinations.ts` (M59.1): the sidebar
  rows and doors, ⌘K Go to, the window title, thread labels and navigate's
  `to` read it, and `destinations.test.ts` holds `tools.v1.json`'s navigate
  list to it. Specs scope destination clicks to `nav-surfaces` (nested rows
  live OUTSIDE those containers precisely because they share accessible
  names with destinations). Sections are addressed by `data-section`, never
  by a per-section testid, and the `KnowledgeNav` selection type carries the
  tab (plus `run`, for one fleet detail) so a tab is a place the back button
  returns to.
- **An agent is a page** (M55.12). DocPage renders it: its body is its
  standing instructions, and `library/AgentProperties.tsx`'s rows are its
  grants, each writing its one key on Done. Runs and Memory are fixed tabs
  beside Instructions (`library/AgentPage.tsx`), under the duty bar. The
  Library keeps the shelf and New (born paused). `{kind:'agents', actor}` and
  a library agent path forward to the page with `navigate(…, {replace: true})`,
  so Back never lands on a forwarder; only construct actors keep a page on the
  Agents surface.
- `src-tauri/src/` — Rust: `vault/` (scan/parse/write, and `comments.rs`,
  each page's comment sidecar under `.comments/`; `receipt.rs` is the
  receipt every write carries, minted only by its door's guard, M58.1;
  `corpus.rs` is search's stat-keyed cache, one read per changed file and
  never an index, M17.19 and M59.4; `trash.rs` is the vault's own Trash,
  where a delete waits in `.trash/<stamp>/` until Settings restores it or
  the launch purge hands it to the OS Trash, M60.8),
  `git/`, `mcp.rs`
  (loopback MCP server), `agent/` (CLI spawn; `fold.rs` folds the live
  stream and Claude Code's session file into one event vocabulary, and
  `transcript.rs` finds that file and reads it back; `interaction.rs` is the
  ask seam's book, where a run waits on a call and only a person's answer
  resumes it, and where the Allow of an ask-first agent's page write waits
  for dispatch: an Agent record's `ask-first:` and the tool manifest's
  `confirmable` column, M57.4; `thread_turn.rs` is an @agent turn in a
  comment thread, M70.4), `comment_tools.rs` (the agent comment tools,
  M70.3), `knowledge.rs` (OKF guards),
  `connectors.rs`, `shell/` (the main window, built in setup so its
  navigation guard is attached and its title follows the page's; `open.rs`
  is Open with: Finder, the default app, agent links and the clipboard;
  `quit.rs` owns ⌘Q and the close guard, which flush every pending save
  before exit (M55.10), while Dock Quit, logout and shutdown exit without
  them), `runtime/fleet.rs` (run history,
  read through `runtime::ReadOnly`, a connection SQLite refuses writes on; a
  phase that needs a new fact still goes through the Meter or the governance
  writers).
- `shared/prompt/` — prose the model reads, which Rust compiles in and TS
  imports `?raw` (M54.7). `server-instructions.md` is the MCP `instructions`
  every run hears, whatever it holds; its README holds the rules (CV-19).
  `product-brief.md` is the one description of the product, which the system
  prompt and get_vault_context both carry, and `retired-terms.json` lists the
  words for the retired model that none of it may say (M54.8, CV-20).
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
  TS code is a review-blocking defect — grow the table format instead.
  Parity is the shared artifact plus `shared/policy/goldens/`; see that
  directory's README before editing either artifact (both have regeneration
  steps that are deliberate, `#[ignore]`d tests). Tool facts are data too
  (M54.2): `tools.v1.json` names each cerebro tool and CLI built-in, Rust
  serves and gates from it, and TS derives the picker, the icons and the write
  checks from it, so a tool list typed in either language is the same defect.
  enforced: `src/lib/policy/table.test.ts::hashes to the digest`, `src-tauri/src/policy/table.rs::the_loaded_bytes_match_the_committed_digest`, `src/lib/policy/tools.test.ts::hashes to the digest the Rust core also asserts`, `src-tauri/src/policy/tools.rs::the_loaded_bytes_match_the_committed_digest`
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
  `Collection`, `Skill` and `Agent`.
  enforced: prose
- **CV-09 Wikilink fields** arrive from the scanner bracket-stripped in
  `entry.relationships`, not `properties` — test fixtures must use that shape.
  A target is read whole first, then as the page before its first `#`
  (M55.8); the fragment stays in the file and in `outgoingLinks`.
  `link.rs` and `wikilink.ts` replay `src-tauri/fixtures/wikilink-targets.json`.
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
  enforced: `src-tauri/src/shell/links.rs::replays_the_shared_link_cases`, `src-tauri/src/shell/mod.rs::both_guards_are_attached`, `src-tauri/src/shell/open.rs::replays_the_agent_link_cases`
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
- **CV-23 Agent writes compare; human saves win** (D2, M55.3). An agent's
  note write may carry `expect_hash` (get_note's Hash line) and lands only on
  those exact bytes; otherwise it is refused as `stale_content` (operational)
  and nothing is written. Human saves never compare: the last write wins. The
  ledger's `expected_version` and `stale_target_version` guard a different
  record, and neither is borrowed for the other.
  enforced: `src-tauri/src/mcp.rs::a_stale_expect_hash_is_refused_and_leaves_the_file_alone`
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
  of the CLI's own tools runs, asks the person or is refused is decided only
  by `shared/policy/tool-approval.v1.json`, by tool family (the manifest's
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
  commits exactly the paths its `vault_writes` rows and its own Write and
  Edit calls name, one commit at a time per repository, with `Cerebro-Run`
  and `Cerebro-Actor` trailers. Every other commit leaves a live run's paths
  alone.
  enforced: `src-tauri/src/git/changeset.rs::a_run_commit_takes_only_its_paths`, `src-tauri/src/git/commit.rs::commit_all_leaves_a_live_runs_paths_alone`
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
- **CV-45 The whiteboard scene core stays self-contained** (M68.1).
  `src/engine/scene/` imports only its own files, perfect-freehand (in
  `ink.ts` alone) and fractional-indexing (in `order.ts` alone), reads no
  clock or randomness, and takes every new id from its caller.
  enforced: `src/engine/scene/boundary.test.ts::the scene core imports only itself and its two upstream libraries`, `scripts/lint-rails.test.ts::engine imports admit the two scene libraries and no subpath`

## Verifying UI work

**CV-14 Only `*.mermaid.test.ts` may `import mermaid`.** Those files exist to measure
claims about the bundled renderer — the shape registry, the `style`/arrow syntax
our ops emit — and each pays ~4s of real parse/render for it. Everything else
under `src/` stays pure string code or mocks `../render` with a fixture svg
(`StructuralEditor.test.tsx`); a component test that reaches for real mermaid is
a component test that flakes under load. Lint limits the import to
`mermaid/render.ts` and `*.mermaid.test.ts`, and `src/test/setup.ts` fails any
other test file that reaches the renderer, naming the fix.
enforced: `eslint.config.js::mermaid: {`, `src/test/mermaidGuard.ts::installMermaidGuard`, `scripts/lint-rails.test.ts::only render.ts and *.mermaid.test.ts load mermaid`

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
- `policy-artifact-edit` — edit `shared/policy/` or `shared/runtime/` without breaking the byte anchor.
- `land-stacked-pr` — land a PR stacked on another PR so its commits reach main.
- `dependabot-triage` — sort alerts and PRs into a bump, an override or a proposed dismissal.
- `record-cli` — record Claude Code runs on the pinned CLI and sanitize them into real fixtures.
