# Macro port — roadmap (M53+)

The owner, 2026-10-12: "This app has achieved a large part of what we are trying to do here with agents, spaces, docs, like literally everything. ... build a plan to start to port over some of if not all of this app's code into our app." Then: "I didn't mean copy their code 1:1 but we can build our app to be like theirs and use theirs to guide ours." And: "single user please and I want things to become page first experience like notion, macro, plane.so." The thesis: build Cerebro into the single-user, local-first, page-first version of Macro, in which every object a person works with opens as a page (D18). That means agents that explain themselves, ask before acting and edit pages in place; pages people and agents share; databases that never lose data; one place to find anything; routines that wake once; projects as spaces; and a Home that catches you up. It is built in Cerebro's own stack, with Macro's code as the behaviour spec. Live defects and rails ship first. After that, each foundation lands with the first surface that needs it, so every milestone ends in something the owner can use. Team and cloud features become local versions or stay out.

## Execution update — 2026-10-15

The original commits were synchronized on `m53-macro-port` at `fc06664700dda3335e428ce54e1122b5a363bea1`; their GitHub Actions run passed. The agents do not stage or commit the subsequent implementation work. An externally populated index was later committed by Cerebro's automatic checkpoint at 16:32 as local `9196fe3` (`Update 54 notes`), including 1,256 files. Investigation found a nested-vault bug: plain `git commit` included the parent repository's staged files. The repair uses a private index containing only the vault's changes over HEAD, preserves outside staged and unstaged versions, and compares HEAD atomically before publishing. Passing regressions cover privacy untracking, unusual filenames, parent operations and concurrent commits. The isolated test app was stopped. The owner chose on 2026-10-15 to keep unpublished commit `9196fe3` intact. No history rewrite or new push was performed; subsequent edits remain unstaged and uncommitted.

The owner excluded only M69.4's Linear importer, and explicitly retained the other planned service features. The milestone audits found the remaining planned implementations present through M70, including M69's mail, correspondence, people/company pack, dismissals and PR status. The integrated automated results and remaining native/live acceptance are recorded below; this is not milestone closure. Each plan records its focused implementation evidence and the native or live acceptance still owed.

Integrated browser verification completed with 531 passes and 12 failures. All failed scenarios then passed in focused reruns (12 quick-open/record/mail checks and nine starter/whiteboard checks), including an additional restored mail-result check. The browser run exposed and repaired a real StrictMode whiteboard creation bug; unit checks cover same-instance replay, real unmount and vault transitions. Earlier integrated checks also repaired Mermaid SVG namespace handling, attachment names and escaped editor markers. Final frontend coverage passes: 722 test files, 14,196 passing tests and 15 intentional skips; lines/statements 92.36%, branches 89.21%, functions 88.19%. Generated Cargo target directories are excluded and thresholds unchanged. Lint, formatting and all three TypeScript configurations pass. A final starter-offer wording correction also passed eight focused unit tests and the browser install journey; its screenshot was inspected. The final native library run passes 3,741 tests, with 30 intentional ignores and 60 macOS-excluded crash cases; all six documentation tests pass after updating stale examples. Session catch-up now distinguishes app and vault windows by recorded session identity, including starts within the same millisecond. Cargo formatting and all-target Clippy pass. The production frontend and isolated debug app build successfully; package inspection is recorded below.

Packaging review found that recursively bundling the working demo vault could include local runtime and private mail files. Cargo now stages a fresh sanitized snapshot before Tauri copies resources; the production mapping names only that snapshot. Runtime/VCS/macOS junk is excluded, private mail roots come from the shared policy, and included symlinks or special files refuse the build. Ordinary untracked corpus content and authored hidden files are preserved; this is not a tracked-files-only snapshot. Nine focused packaging tests, independent review, all-target Clippy and the frontend static checks pass. The source demo vault is unchanged. The final isolated `Cerebro Media Spike.app` uses the normal frontend build and production resource mapping: all 141 demo file paths and bytes match source, stage and actual bundle, with no private/transient paths or symlinks. Its identifier is `com.cerebro.media-spike`, minimum macOS version is 14.0, and URL registrations are empty. Whole-bundle ad hoc signing and `codesign --verify --deep --strict` pass; this local debug artifact is not Developer ID signed or notarized. The isolated profile points at the scratch vault outside the repository with agents and client access disabled. The final app was not installed or launched, and the main app profile was untouched.

The owner chose on 2026-10-15 to leave live CLI verification pending. Those checks remain unverified; the isolated toy-vault recording profile was last observed unsigned, and no sign-in or live run is being pursued. Live Notion, Gmail and GitHub checks need the owner's accounts. Interactive packaged checks are also unresolved because native app automation repeatedly hangs or reports `cgWindowNotFound`, including after the owner opened the test app. Actual Obsidian and Excel/Numbers round-trips remain unverified. These limitations do not count as passing checks. Linux-only crash cases retain the documented macOS exclusions and still need execution on the final work. The Gmail evidence pack remains unaccepted and the mail gate closed. M67 retains its documented computed-array memory risk: the deadline releases a waiting caller, but cannot stop upstream evaluation or bound a computed result's allocation.

## Decisions

| Id | Question | Options | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| D0 | How may Macro's code be used? | Copy or transliterate it; or rebuild guided by it | **Decided by the owner, 2026-10-12: guided rebuild, no license gate.** Macro is the behaviour guide; Cerebro writes its own code. Reuse is limited to permissive islands (with attribution) and the upstream libraries Macro uses. | — |
| D1 | Single user or team? | (a) single user, local, files-first; (b) (a) plus team-shaped seams: an actor and a cause on every write and run; (c) Macro's team model: accounts, sharing, presence, channels | **Decided by the owner, 2026-10-12: single user**, built as (b): the actor and cause seams stay, because agents need them. Teammates become agents, channels become page threads (D10), team memory is the verified knowledge bundle, and sharing stays a git remote. No accounts, ACLs or presence. | — |
| D2 | May agent writes carry a content-hash precondition? Convergent D5 keeps vault files last-write-wins. | (a) no; (b) advisory hash only; (c) narrow amendment: agent tools, batch writes and undo inverses may carry `expect_hash`, and a mismatch is refused with a new operational code; human saves stay last-write-wins with reconcile; the ledger's `expected_version` is untouched | **Decided by the owner, 2026-10-12: (c).** Without it, `edit_note`, `set_fields`, the batch writer and undo can each overwrite a concurrent write without a word. | M55, M60 |
| D3 | May Rust twin TS vault semantics (filters, field kinds, dates, fences, canvas)? | (a) twin interpreters framed as vault semantics (the `link.rs` precedent), held together by shared artifacts and goldens; (b) MCP tools answered by the renderer (unavailable when no window is open); (c) one Rust engine compiled to WASM (this Mac has no wasm32 toolchain; the policy README defers it) | **Decided by the owner, 2026-10-12: (a)**, with the reviewer ruling recorded once in `shared/policy/README.md`. Each grammar starts narrow and grows only with goldens. | M60, M62, M67, M68 |
| D4 | Agent transport for attended turns | (a) per-turn `claude -p` plus loopback MCP and the CLI's own seams (`--session-id`, PreToolUse defer + `--resume`, `--permission-prompt-tool`, `--model`, `--effort`); (b) one long-lived `--input-format stream-json` child per attended conversation (can_use_tool, interrupt, set_model, mcp_status); (c) ACP through `claude-agent-acp` (Node, a pinned npm adapter) | **Decided by the owner, 2026-10-12: (a) now.** M56.1 spikes (b) with recorded fixtures; switch only if steer or re-attach need it. (c) only if a second harness becomes a goal, and then through the upstream SDK. | M57 |
| D5 | May run detail show a run's transcript? M17.15 calls the run log "not a transcript"; M40 forbids a second transcript surface. | (a) no; (b) a read-only, collapsed fold of Claude Code's own session file, stored nowhere | **Decided by the owner, 2026-10-12: (b).** Nothing enters the vault; after Claude Code's 30-day sweep the run reads "cleared by Claude Code". | M56 |
| D6 | Should "ask" join the shell ceiling? M8.1 made shell one Settings ceiling. | (a) off and on only; (b) off, ask, on, decided by a shared policy table; unattended runs never prompt | **Decided by the owner, 2026-10-12: (b).** | M57 |
| D7 | Where does an agent's `recent` memory live? Since PR #17 every run is told to patch it, and every patch is refused. | (a) Rust allows exactly `recent`, size-capped, on the run's own Agent record; (b) move it to `runtime.db`; (c) stop asking runs to keep memory | **Decided by the owner, 2026-10-12: (a)**: memory stays a file the owner can read and edit. | M56 |
| D8 | Answer a trigger's `ask:` before the run? Reverses M17.12. | (a) keep it inside the run; (b) a tool-less pre-run check that answers through `submit_condition`, metered and budget-gated; a "no" records a skip | (b): a "no" costs one cheap run instead of a full one, and the skip is recorded with its question. | M63 |
| D9 | How far may Home speak first? M8, M43 ("no feed"), the owner's "Home = My Work/Tasks". | (a) as today; (b) pull-only lanes under My work: silent when empty; no nav count, bell or push; Done only on event rows; proposals decided on their own cards; OS banners only for reminders the user set; (c) Macro's feed with unread state and badges | (b), recorded as an amendment to M43. | M64 |
| D10 | Comments and discussions on pages? M47 §9 lists them as a non-goal; M33b D8 keeps one chat surface. | (a) none; (b) threads in a sidecar outside scan and search, anchored by quote and occurrence, `.md` bytes untouched, explicit @agent replies; (c) anchor markers written into the markdown | (b), behind a spike that proves the anchors and byte stability. D18 moves it up: M70 builds right after M57 (see Build order). Notion, Macro and Plane all comment on pages. Amends M47 §9 and M33b D8. | M70 |
| D11 | Keyboard model and panes. M16 assumed Notion-style ⌘ shortcuts. | (a) ⌘ shortcuts and one canvas; (b) a scoped keymap with g/c chords and list keys, plus page panes with per-pane history and claims keyed by file path; (c) panes without chords | (b). Escape stays with `layers.ts`; ⌘-click opens a pane, because Shift-click already extends selection. | M65 |
| D12 | macOS floor and Tauri version. Floor 10.15; Tauri 2.11.5; current Tauri plugins need ^2.12. | (a) keep both: plugin-free routes, the legacy pdf.js build, HEIC converted first; (b) raise the floor to macOS 14 and bump Tauri to 2.12 in one gated part | (b), as M64.5 (the owner runs macOS 15). Plugin-free routes stay the default either way. | M64, M66 |
| D13 | Sheets: storage, engine, formula dialects | Storage: (a) a `cerebro-sheet` fence in a page (CSV sources + YAML header); (b) a whole-note sheet. Engine: (i) upstream `ironcalc_base` in Rust over IPC, with npm `@ironcalc/wasm` only in the browser mock, same release; (ii) wasm in the webview (CSP `wasm-unsafe-eval`, a higher floor). Dialects: field arithmetic in databases vs Excel A1 in sheets | (a) + (i), with two scoped dialects. | M61, M67 |
| D14 | Whiteboard format. M29 D8 rejected a second format. | (a) `.mmd` boards only; (b) JSON-Canvas-native `.canvas` files (axis-aligned; extras in one versioned `cerebro` key; Obsidian opens them); (c) a native affine scene file plus a JSON Canvas bridge | (b). `.mmd` boards keep working and conversion is opt-in. The page block is read-only with Open unless M29.48 is reversed. | M68 |
| D15 | Outside material: route and authority | Route: (a) skip; (b) the user's own MCP connectors, plus cached digests (mail in a gitignored `sources/mail/`), plus connector-free inlets (CSV, `.ics`); (c) in-app OAuth. Authority: (i) imports register `content_only`, with no re-keying of existing items; (ii) `human:owner` as today; (iii) an R14 connector registration per source | (b) + (i). Drafts only, never send. One R14 evidence pack per cached source kind, Gmail first. | M69 |
| D16 | GitHub and coding sessions. M30 D3/D4, M32.12, M33b D1. | (a) none; (b) a read-only PR chip through the user's own `gh` (lifts M30 D3 for reads only); (c) Cerebro-owned worktrees and push proposals | (b). Scape and Claude Code's own worktrees already cover (c). | M69 |
| D17 | May the user's other MCP clients use the vault through Cerebro's guarded tools? Reverses M6. | (a) per-run bearer only; (b) opt-in loopback personal tokens: hash-only, one grant per token, the read toolset by default, a runs row per client session | (b), off by default, built after the manifest settles. | M62 |
| D18 | What is the core experience? | (a) surfaces and panels per feature; (b) page-first, like Notion, Macro and Plane: every object opens as a page with one anatomy | **Decided by the owner, 2026-10-12: (b) page-first.** See "Page-first rules". It extends M47 (everything is a page) and M50–M51 (concepts are pages) to agents, projects, meetings, imports and whiteboards. | M55, M61, M63, M70 |

## How we use Macro's code

- **Read the part's guide paths first.** Each milestone lists them under "Read first". The Macro root is `docs/examples/macro-main/` (vendored, gitignored).
- **Write the behaviour down as the part's acceptance** in the milestone's plan doc, before any code. Where Cerebro differs on purpose, the plan says so and why.
- **Build Cerebro-native and test against that written behaviour.** The stack is React 19, Zustand, BlockNote, Tauri Rust, files on disk, `runtime.db`, policy as data and the user's Claude Code CLI. Tests are vitest, cargo and e2e through `e2e/boot.ts`, with the mock mirroring every Rust guard.
- **No copied code, comments, identifiers, prompt text or fixtures.** Name things in Cerebro's words. Macro's eval fixtures hold real identities, so we record our own.
- **Reuse permissive islands only with attribution**: `packages/loro-mirror` (MIT), `apps/web/src/lib/filesystem` (MIT), `crates/opensearch_query_builder` (MIT).
- **Adopt the upstream libraries Macro uses**, pinned to upstream releases and never to Macro's forks: IronCalc (not `vendor/ironcalc` with its 59 `MACRO:` patches), pdfjs-dist (not Macro's pdf.js fork), uFuzzy, perfect-freehand, fractional-indexing, calamine, rrule and the Tauri plugins.

## Page-first rules (D18)

The model is Notion's pages, Macro's "everything is a doc", and Plane's work items and project pages, all on Cerebro's files.

- **Every object a person works with opens as a page** in the one page shell: docs, records and work items, databases, projects, agents, meetings, concepts (already, M50–M51), imported material and whiteboards. A non-markdown file (a `.canvas`) still opens in the page frame.
- **One anatomy everywhere**: icon and optional cover, title, properties, body, then tabs where the type has them. The side panel holds Backlinks, History, Comments and Details.
- **Databases are pages with views** (M47). **Projects are pages** with Tasks, Docs, Agents and Runs tabs: Plane's project page, Macro's initiative. **A work item is a page** with status, priority, assignee and dates: Plane's work item, Macro's "tasks are docs".
- **Sub-pages are the page tree.** Any page can add a sub-page and list its children.
- **No new standalone screen when a page plus a view will do.** Home, Inbox and My work are views over pages, and every row opens a page.
- **Every new feature's acceptance includes:** it opens as a page, and it round-trips as files on disk.

## What transfers and what doesn't

- **The stacks don't match.** Macro is SolidJS + Lexical + Loro over Postgres, OpenSearch, Redis, Kafka/SQS, S3 and Lambda. Cerebro is React + BlockNote + files + SQLite in one Rust process. Little code would lift even if the license allowed it.
- **Designs transfer**: data models, tool catalogs and their wording, protocols, UX rules and edge cases. The best are the transcript fold and turn state, typed interactions, tool annotations per host, op batches with compare-and-set and inverse journals, view checks and cast rules, durable event runs and TriggerContext, the work-feed rules, fuzzy + recency ranking, scoped keymaps and pane claims.
- **Adopted directly**: the upstream libraries above, and Claude Code's own seams (`--session-id`, `--resume`, PreToolUse defer, `--permission-prompt-tool`, AskUserQuestion, `--model`, `--effort`, `alwaysLoad`).
- **Cloud-only, no fit**: Kafka/SQS/EventBridge/Lambda, OpenSearch indices, the connection gateway and presence, multi-tenant access, sharing, teams and billing, FusionAuth and the OAuth broker, Pipedream, the `macrod` daemon, cloud coding agents, OTA bundles, mobile shells.
- **Translated, not ported**: Macro's agent loop runs on Macro's API keys, while Cerebro's agent is the user's own CLI. ACP becomes CLI flags plus loopback MCP. The frame log becomes Claude Code's own session JSONL, folded on read.
- **Files-first changes the shape**: CRDT sync becomes bytes on disk plus an in-place merge; UUID identity becomes paths plus rename ripples; EAV becomes frontmatter and Type docs; a Postgres journal becomes a `runtime.db` recovery journal plus in-memory undo.
- **Single user changes the shape**: teammates become agents, channels become page threads, team memory is the verified knowledge bundle, and the notification feed becomes pull-only lanes.
- **Macro's own gaps are not copied**: frecency that never decays, missing timestamps sorted as epoch, failed PDF pages dropped without a word, and a copy-availability that treats missing data as free. Cerebro's rules (absent is never zero; unavailable is never empty) fix them on the way in.

## Translation rules

| Macro | Cerebro | Note |
| --- | --- | --- |
| Entity rows keyed by UUID (document, task, project, database row) | A markdown page; frontmatter holds properties; identity is the vault path plus `store_uuid` | Renames ripple (M60) instead of minting ids |
| EAV property store; system properties with well-known UUIDs | Fields declared in the database's Type doc; behaviour gated on capability (a status field, a declared `deadline:`, an email-kind field), never on type or field names | No shared catalog (M47 D3) |
| Databases, columns, rows; views stored as typed JSON | Type doc + `folder:` + `views:` (M47); a database block in a page is a pointer fence | |
| DatabaseOp batches, baseVersions answering 409, a journal of inverse ops | A Rust batch writer (validate everything, write temps, rename, recovery journal in `runtime.db`), `expect_hash` (D2), in-memory undo of the person's own batches | The journal is operational, never the ledger |
| Loro doc, sync-service, presence, WAL | Bytes on disk; external writes merged into the open editor; git is the history | No CRDT, no presence |
| Lexical's internal `<m-*>{json}` dialect | Legible markdown; custom blocks as `cerebro-*` fences or `:::` directives; every block has a disk carrier | |
| `agent_session_log` frame log, one fold in Rust and WASM | Claude Code's own session JSONL, folded in Rust on read; TS reduces the events; golden event files replayed by cargo and vitest | No stored copy, no WASM (M17) |
| ACP client, harnesses, `macrod` | The user's Claude Code CLI plus loopback MCP | D4 |
| request_permission, elicitation, PendingUserExecution | The CLI's permission host, answered by a card that dies with its turn; anything that must outlive the turn goes to the Review queue | One queue, two doors |
| `ai_toolset` typed tools, ToolKind, `tools_for(host)`, EAGER_TOOLS | `shared/policy/tools.v1.json`, read by Rust (`include_str!`) and TS; tools/list shaped by the RunGrant; `_meta` alwaysLoad on a small read core | Policy is data; no codegen |
| Hand-written tools in any namespace | Never the `propose_` prefix, which belongs to policy-generated ops (`PROPOSAL_PREFIX` in `mcp.rs`) | `suggest_view`, not `propose_view` |
| EntityAccessReceipt, sealed principal policies | RunGrant axes enforced in Rust at dispatch; corpus-bound write doors; a `WriteReceipt<Door>` minted only by the guard | No ACL, no sharing |
| TriggerContext | `runs.cause`: a closed vocabulary written with the run row, by the runtime only; the preamble renders it with subject text framed as data | |
| Routines, fenced claims, `event_runs` | Agent records (`schedule:`, `when:`, `ask:`, `paused:`); claims and wakes in `runtime.db`; TS derives, Rust admits | Runs only while the app is open; catch-up on launch |
| Assigning a task opens an agent session | A relation targeting Agent gains a link, which admits one durable wake with a replay-stable key | |
| Projects (initiatives) with agent assignees | A project page with Tasks, Docs, Agents and Runs tabs; records filed under it inherit its agents | Macro has no "spaces"; projects are the nearest thing |
| `work_feed`, `notification_state` | Pull-only Home lanes; Done receipts tied to the revision seen, stored in `runtime.db` | No badge, bell or push (D9) |
| `activity_events` | `vault_writes` (actor, run_id) + runs + git + ledger, folded on read by a SELECT-only module and shown as History | Operational, never epistemic |
| OpenSearch, server-side frecency | Scan BM25 (`search.rs`) over a cached scan; a per-vault open log decayed at read time, viewable and clearable | No index (M17.19) |
| Soup filter AST, `database_sql` | Saved-view FilterGroup JSON as agent input; a Rust evaluator held to TS by goldens (D3) | No SQL |
| Split router with panes in the URL | navStore panes with per-pane history; claims keyed by the edited file path; layout saved per vault in localStorage | No URL |
| Hotkey scope tree, command registry | A keymap plus one registry feeding palette rows, keycaps and a generated Shortcuts list | Escape stays with `layers.ts` |
| S3, CDN resizing, file blocks | `attachments/` plus a custom URI scheme over `resolve_within`; thumbnails in app-data | No HTTP client in the core |
| DOCX/PPTX/PSD/FIG engines, pdfium, LibreOfficeKit | Upstream readers (pdfjs-dist, calamine, zip, quick-xml) plus Quick Look; extracted text lands as Inbox captures | Markdown-first |
| Gmail and Calendar mirrors, OAuth grants, CRM built from mail | The user's own connectors; header digests cached as Sources; correspondence derived on records; drafts only | Zero credentials (D15) |
| Graphics scene; IronCalc sheet in a Loro doc | `.canvas` JSON Canvas files; `cerebro-sheet` fences computed by upstream IronCalc | D13, D14 |
| `deleted_at` columns and a 30-day purge | A `.trash/` folder in the vault, purged to the OS Trash | Markdown is never hard-deleted |
| System skills in code; bots and @Macro; a memory profile gated by a judge | Skill files installed only if absent; Agent records (born paused) addressed by @handle; the verified knowledge bundle plus human-only preferences | |
| Postgres migrations per crate | One `runtime.db` `user_version` step per part that needs one, in build order | v19 is next once M49–M52 is on main |
| STYLE_GUIDE ids, ast-grep, OTLP | Convention ids in AGENTS.md, ESLint and clippy at zero warnings, a local JSONL log | No third rules engine |

## Milestones

**Before M53.**

- **Land M49–M52.** The four commits on `m49-knowledge-integrity` (the 2026-09-25 audit doc through "prep ush") are not on `origin/main`: main is at `runtime.db` schema v16, the branch at v18. Merge them, then resync local `main` (e067ce0, behind `origin/main` at 263e7de). M53 starts from that main.
- **D0–D7 and D18 are decided** (D2–D7 on 2026-10-12, each as recommended). Ask the rest before their milestone starts.

**Rules for every part.**

- One part is one commit: `type(scope): sentence (M53.n)`. No part is bigger than L; an XL candidate is split.
- Sizes follow the reference. **S**: one area and its test. **M**: Rust + TS + mock across a few areas. **L**: cross-cutting, with e2e, a shared artifact or a schema step. A milestone's effort sums its parts (4 S ≈ 2 M ≈ 1 L); more than 3 L is XL. The whole roadmap is about 89 L, M70 and the D18 page-first parts included.
- Each milestone starts with its own plan doc. It ends with the full gate, coverage floors held or raised, and the owner looking at the built app.
- A schema change takes the next free `user_version` step, one step per commit. `fleet.rs` stays SELECT-only.
- A new refusal code either gets a declared destiny in `policy.v3.json` through the README's regeneration ritual, or reuses an existing code.
- A part deletes the comments it falsifies; the reference files name most of them.
- Hand-written MCP tools never use the `propose_` prefix.

| Id | Title | Goal | Depends | Effort |
| --- | --- | --- | --- | --- |
| M53 | Safe core and rails | Close live security, data-loss and budget defects; re-land M32; lint and parity rails | M49–M52 on main | XL: 22 S, 2 M (≈6.5 L) |
| M54 | One tool surface | One manifest drives listing, grants, prompts and UI; tools load early; connectors are callable and honest | M53 | XL: 9 S, 1 M, 1 L (≈3.8 L) |
| M55 | Pages first | One page anatomy (icon, cover, sub-pages, page cards); agents open as pages; quote-anchored agent edits merged into the open editor; every block survives save | M54; D2, D18 | XL: 8 S, 5 M, 1 L (≈5.5 L) |
| M56 | Runs you can read | One transcript fold; typed failures; model and effort; run cause; run detail | M54; D5, D7 | XL: 7 S, 4 M, 1 L (≈4.8 L) |
| M57 | Ask, answer, steer | Permission and question cards, ask-first writes, Up next, detached turns | M56; D4, D6 | XL: 2 S, 3 M, 2 L (≈4 L) |
| M58 | Writes you can trace | Attribution and receipts, per-turn changesets, prose history, review notes, who can change a page | M56, M57; D1 | XL: 1 S, 3 M, 2 L (≈3.8 L) |
| M59 | Find everything | ⌘K over names and page text with recency; truthful agent search; previews; ⌘F | M55 | XL: 1 S, 6 M (≈3.3 L) |
| M60 | Databases that keep their word | Computed values, rename ripples, safe kind change, batch writer, undo, Trash, link-keeping renames, `set_fields` | M55, M58; D2, D3 | XL: 3 S, 6 M, 2 L (≈5.8 L) |
| M61 | Work and time views | Project pages, multi-value bands, deadlines, formulas, CSV, composer, checklist promotion, calendar hours and recurrence | M59, M60; D13, D18 | XL: 8 M, 3 L (≈7 L) |
| M62 | Agents query your data | `describe_database`, `query_records`, `list_agenda`, `suggest_view`; other local clients (gated) | M60; D3, D17 | XL: 3 M, 2 L (≈3.5 L) |
| M63 | Routines that wake once | Durable wakes, chain hops, assignment, projects as spaces, Run now, schedules, pre-run ask, follow-ups | M58, M60; D1, D8 | XL: 6 M, 2 L (≈5 L) |
| M64 | Home and History | Activity History, pull-only Home, durable reminders, Notification Center, meetings, starter kit, recipes | M58, M61; D9, D12 | XL: 2 S, 5 M, 2 L (≈5 L) |
| M65 | Keyboard and panes | One command registry, chords and list keys, view-state history, launcher, deep links, page panes | M59, M64; D11 | XL: 1 S, 6 M, 3 L (≈6.3 L) |
| M66 | Files | Bytes in the webview, viewers, PDF, paste and drop, extraction, `read_document`, thumbnails | M55; D12 (if (b), M64.5 lands first) | XL: 2 S, 5 M, 2 L (≈5 L) |
| M67 | Sheets | Sheet fences on upstream IronCalc, agent tools, grid, XLSX | M60, M61; D3, D13 | L: 2 M, 2 L (≈3 L) |
| M68 | Whiteboards | JSON Canvas files, scene engine, editor, linked cards, agent tools | M66; D3, D14 | XL: 2 M, 5 L (≈6 L) |
| M69 | Outside material | Presets, link labels, import provenance, Linear CSV, Notion pages, `.ics`, mail digests, correspondence, CRM, drafts, PR chip | M54, M58, M61; D15, D16 | XL: 3 S, 4 M, 4 L (≈6.8 L) |
| M70 | Page comments (moved up by D18) | Quote-anchored threads beside pages; agent comment tools; @agent in a thread | M55, M57; D10 | L: 1 S, 2 M, 1 L (≈2.3 L) |

**Build order** follows dependencies, not numbers: M53 → M54 → M55 → M56 → M57 → **M70** → M58 → M59 → M60 → M61 → M62 → M63 → M64 → M65 → M66 → M67 → M68 → M69.

### M53 — Safe core and rails

**Goal.** Close the holes that let an agent leave its grant, lose data or burn budget. Re-land the stranded M32 work. Put lint and parity rails under everything that follows.

**Read first (Macro).** `crates/entity_access/src/domain/models.rs` (no domain call without a resolved entity) · `crates/coding_agent_worker/src/outbound/acp_process.rs` (process groups, stderr tail; read for behaviour, then the upstream ACP SDK file it ports) · `apps/web/tauri/navigation_plugin/src/lib.rs` · `services/scheduled_action/src/domain/event_runs.rs` (event runs keyed apart from cron) · `packages/lexical-core/transformers/index.ts` (every node ships a transformer) · `crates/macro_authorization/src/domain/service.rs` (revocation) · `docs/STYLE_GUIDE.md`, `clippy.toml`, `deny.toml`, `rust-toolchain.toml` · `packages/graphics/tests/boundary.test.ts` + `packages/graphics/tsconfig.core.json` · `crates/macro_entrypoint/src/lib.rs`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M53.1 | Re-land M32.1–M32.7 (478afd3..2f229bb): PR gating, read-only token, SHA-pinned actions, Dependabot, rulesets, zizmor + actionlint, advisory cargo-deny, provenance. Resolve `.gitignore` and `AGENTS.md`; retire the "check the e2e port is FREE" paragraph, since M32.7 makes server reuse opt-in. | PRACTICES-1 | re-land own work · S |
| M53.2 | Re-land M32.8–M32.12 (490b38a..777615c): typed root-git reads, credential probe, protocol pins, fetch + fast-forward pull, the SECURITY.md mounted-roots model. Switch `roots_git_commands` to `app_config::app_dir`, fix SECURITY.md's retired modes, delete the stale `git/command.rs:68` comment. | CODING-1 (1a) | re-land own work · S |
| M53.3 | One toolchain: `rust-toolchain.toml`, `packageManager` + `engines`; CI reads them. Pre-push warns on a rustc/node/pnpm mismatch and runs the Rust lane on any `src-tauri/`, `shared/` or `conformance/` change. | PRACTICES-15, PRACTICES-11 (hook fix) | rebuild · adapt · S |
| M53.4 | Corpus-bound write doors: MCP and IPC writers refuse dot-dirs (`.git`, `.cerebro`, `.obsidian`), `views/`, `attachments/`, and non-`.md` targets for note tools (`.mmd` append only if chosen). This closes the `.git/config` fsmonitor path. The mock mirrors the IPC refusals. | PLATFORM-API-1, CANVAS-1 | rebuild · adapt · S |
| M53.5 | Read scope closes the CLI bypass: runs with a `read_scope` get Read, Glob and Grep in `--disallowedTools`, with a tripwire next to `UNGRANTED_WRITERS`. | MCP-14 | rebuild · inspire · S |
| M53.6 | Agent writes reach the open page: MCP write tools emit a per-path change, and a page's pending save flushes before a turn starts. Today a save can overwrite an `append_to_note` made mid-turn. | EDITOR-11 | rebuild · inspire · S |
| M53.7 | Event runs get their own ledger key (`<identity>#event`), with the cooldown key kept consistent. This ends the 15-minute schedule/event ping-pong. | AUTOMATION-2 | rebuild · inspire · S |
| M53.8 | A vault switch resets the event-diff baseline, so the new vault's first scan is eventless. | AUTOMATION-2b | rebuild · inspire · S |
| M53.9 | The AI block survives save: a demotion pass runs before serialization, including inside the unmount flush. Toggle list, toggleable heading, audio and file leave the `/` menu until M55.4 gives them carriers. | EDITOR-1 (AI-block half) | rebuild · inspire · S |
| M53.10 | One spawn helper for git and the CLI: `process_group(0)`; TERM, wait, then KILL on the group; a continuous 64 KiB stderr tail; reaping in the reader thread; repo-selecting env scrubbed. `stop_all` runs on vault retarget and `RunEvent::Exit` and closes meter rows; run tokens are bound to their vault. | AGENTS-11, CODING-2, CLIENT-DESKTOP-4 (exit half), 10-coding missed (run lifecycle) | rebuild · adapt · M |
| M53.11 | Token and secret hygiene: a run's bearer is revoked when its child exits; tokens compare in constant time; the renderer gets the URL only. `connectors.json` is written 0600. | PLATFORM-API-9, CODING-12 | rebuild · adapt · S |
| M53.12 | Links leave the webview. The main window is built with `create: false`; `on_navigation` and `on_new_window` allow the entry document, send http(s) to the system browser and deny the rest. Covers BlockNote's link toolbar. | CLIENT-DESKTOP-1 | rebuild · adapt · S |
| M53.13 | Hidden windows keep working: `backgroundThrottling: disabled`, proven by a packaged before/after measurement. | CLIENT-DESKTOP-2 | rebuild · mirror · S |
| M53.14 | `isPlace` round-trips every Selection kind: My work and Work anchors kept, the dead `review` kind rejected. | SHELL-0 | rebuild · adapt · S |
| M53.15 | History reads stop collapsing failure into empty: `useFileHistory`, `useVaultPulse` and the commit-diff read render `section-unavailable`. | COMMS-9 | rebuild · adapt · S |
| M53.16 | Create-on-day writes by field kind, so a daterange gets a range. | CALENDAR-0 | rebuild · adapt · S |
| M53.17 | Source cache paths stop colliding: a canonical-id suffix in both slug twins (parity test), and existing copies found by their frontmatter ids. | INTEGRATIONS-2a | rebuild · adapt · S |
| M53.18 | The organize proposal card applies its title and stays put when the patch fails. | 14-comms missed (ProposalCard) | rebuild · adapt · S |
| M53.19 | Convention ids (CV-NN) inline in AGENTS.md, each with an `enforced:` pointer; a test resolves every pointer. | PRACTICES-2 | rebuild · adapt · S |
| M53.20 | Lint rails: engine purity (static and dynamic imports), `@tauri-apps` only in the IPC adapters, mermaid only in `*.mermaid.test.ts` (plus a vitest setup guard), `mockParse` only from `mockIpc`. `tsconfig.engine.json` (no DOM) joins `pnpm typecheck`. `runLog`'s storage moves to a store. | PRACTICES-3 | rebuild · adapt · M |
| M53.21 | Rust rails: `allow_attributes` and `allow_attributes_without_reason`; the 19 `#[allow]` become reasoned `#[expect]` (2 stale ones deleted). Clippy bans raw `Command::new` and `set_var` outside the M53.10 helper. | PRACTICES-4 | rebuild · adapt · S |
| M53.22 | Parity rail: a scan golden holds `mockParse` to `parse.rs` over demo-vault. | PRACTICES-16 | rebuild · adapt · S |
| M53.23 | Tracked dev skills in `.claude/skills` (verify-ui, policy-artifact-edit, land-stacked-pr, dependabot-triage), listed in AGENTS.md. | PRACTICES-7 | rebuild · adapt · S |
| M53.24 | Local diagnostics: a size-capped JSONL log in `app_dir()/logs`, a panic hook, webview errors through one command, redaction; then deny `print_stdout` and `print_stderr`. No exporter. | PRACTICES-6, CLIENT-DESKTOP-5 | rebuild · inspire · S |

**Status, 2026-10-12.** M53.4, M53.7, M53.8 and M53.9 were built ahead of this plan as hotfixes. They are committed on `m53-macro-port` (0c1e199, 6ee7ecc, fc510e6), and CI passes, including the full crash suite on Linux. The remaining parts are planned in `2026-10-12-m53-safe-core-and-rails.md`.

- **M53.4:** every note writer, the agent's and the human's, refuses:
  - dot-paths, as HFS+ hears them too;
  - non-notes;
  - notes under `views/` or `attachments/`.

  It judges the path as asked and where it lands. The projection writer only keeps a concept inside `knowledge/`; the agent's concept doors refuse folders the scan cannot list.
- **M53.7 and M53.8:**
  - event runs get their own `<identity>#event` slot;
  - only event runs start the cooldown;
  - the scan baseline is kept per vault;
  - scans land newer over older.
- **M53.9:** the AI block saves as a `:::ai` directive. Marker lines are read from plain text only, the question is saved as it is typed, and Enter at the end of the answer leaves the block.
- **Owner calls, decided 2026-10-12:**
  - dotfile notes are hidden from the scan, Obsidian-style;
  - the `.mmd` exemption for `views/whiteboards/` stays;
  - a trigger-only agent's clock ticks, which restores the designed limit of 4 runs an hour.

**Status, 2026-10-13: built, not committed.**

- Every other part (M53.1–.3, .5, .6, .10–.32) sits in the main checkout as uncommitted edits, which is how the owner asked for it. The owner commits.
- Gates: each of the plan's nine waves passed lint, typecheck, format and coverage, with every floor held. Each also passed cargo fmt, clippy and the skip-listed cargo test, and the full e2e suite. Wave 9's gate was the full milestone close.
- The acceptance audit counts 33 of 39 items met. The other six:
  - the packaged checks: links, the hidden-window tick, the grandchild sweep and the log file;
  - CI and the Linux crash suite, which run on the owner's push.
- Still open:
  - the TS half of PRACTICES-4 (Q9);
  - the coverage-ratchet guard (Q8);
  - routing the editor's save through the vault-open guard (Q11);
  - the formatting toolbar and ⌘⇧6 can still make toggles until M55.4 gives them a carrier;
  - Dependabot PR #20 gets no CI run now that CI triggers only on pushes.

**Acceptance.**

- CI on main runs the M32 lanes (SHA-pinned actions, zizmor, actionlint, advisory cargo-deny). Root git reads return typed refusals, and SECURITY.md describes mounted roots.
- `append_to_note` and `update_frontmatter` on `.git/config`, `.cerebro/connectors.json`, a ledger segment, a `.canvas` file and a `*.list.yml` are refused, with the bytes unchanged. The IPC equivalents are refused in Rust and in the mock (parity test).
- A read-scoped run's argv denies Read, Glob and Grep.
- e2e (boot.ts, with a write seam that bumps `modifiedAt`): an agent append during a turn shows on the open page and survives the next save.
- vitest: an event run never re-fires its schedule's period, and the cooldown still suppresses.
- An AI block survives save, including a save inside the unmount flush.
- Stop, a vault switch and quit leave no CLI or Bash grandchild. A 1 MB stderr flood no longer hangs an attended run.
- Packaged checks: an https link opens the system browser, and a 60 s tick still fires in a window hidden for 10 minutes.
- PulsePage renders `section-unavailable` when `git log` fails, never "No history yet".
- `pnpm lint` fails on an engine→stores import and on a dynamic `@tauri-apps` import outside the adapters. Clippy fails on a raw `Command::new` and on a new `#[allow]`.

**Risks.**

- M32.1 ran CI only on PRs and on pushes to main. **The owner decided 2026-10-12: branch pushes keep CI.** The Mac pre-push hook skips the crash tests, so CI on push is where they run.
- Crash-test children can wedge macOS while spawn code changes; keep the cargo skip list on.
- Processes that call `setsid` escape the group kill. Say so; don't promise otherwise.
- New lint and clippy rules surface legacy sites. Fix them, or suppress them in place with a reason, in the same part.
- The `/` menu visibly loses four items until M55.4.

### M54 — One tool surface

**Goal.** One shared manifest says what each Cerebro tool is, and Rust and TS both derive from it. Tools load early, listing follows the grant, prompts name only granted tools, and connectors become callable and report their status with a fix.

**Read first (Macro).** `crates/ai_toolset/src/annotations.rs` · `crates/ai_toolset/TOOL_DESIGN.md` · `crates/ai_tools/src/lib.rs` (`tools_for`, EAGER_TOOLS) + `crates/ai_tools/src/test.rs` · `services/mcp_service/src/tool_service.rs` + `tool_service/test.rs` · `services/mcp_service/src/main.rs` (Host checks) · `crates/prompt/src/lib.rs` + `crates/prompt/tests/compose.rs` · `crates/mcp_toolset/src/mangle.rs` · `apps/web/src/features/settings/connections/model.ts` · `apps/web/src/lib/core/component/AI/component/mcpConstants.ts`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M54.1 | `shared/policy/tools.v1.json` (+ sha256, README steps, `.prettierignore`). Per tool: title (inside annotations), kind read_only / additive / destructive, idempotent, openWorld false, target argument and path kind, door, grant axis, renderer, icon, `_meta` alwaysLoad and searchHint, a description of at most 2048 chars. Also one list of the CLI's built-in writers (MultiEdit and NotebookEdit included). Rust serves tools/list with annotations and derives `tool_policy`, `write_target` and `read_target`; a test checks every inputSchema against the API. Proposal tools stay generated from policy.v3. | AI-1, MCP-1, PLATFORM-API-4 | rebuild · adapt · M |
| M54.2 | TS derives `tools.ts`, `WRITE_TOOLS`, `TOOL_ICONS`, `isWriteTool` and `writtenPath` from the manifest. The regex scrape goes, and so do the falsified comments (the `tools.ts` MIRROR header, `AiActionCard.tsx:56-59`, `mcp.rs:734-739`). | AI-1, MCP-1 | rebuild · adapt · S |
| M54.3 | IPC contract test: every TS invoke name and argument key is checked against `generate_handler!`, plus the three event names. The two commands with no caller are flagged. | PRACTICES-9 | rebuild · inspire · S |
| M54.4 | Grant-shaped tools/list: the manifest intersected with the RunGrant. Window and answer tools are listed only while held; `discoveryCache: false`. A test checks that every listed tool passes `ungranted_tool_refusal`. | MCP-2 | rebuild · adapt · S |
| M54.5 | Tools ready early: per-tool `_meta` alwaysLoad on the read core (`get_vault_context`, `search_notes`, `get_note`, `knowledge_about`), and a per-server `timeout` in the run's mcp-config. Init check: cerebro `failed` ends the run with an error, and `pending` counts as unsettled. Server-level alwaysLoad only if measured init still reads pending. | AI-11, MCP-3, AGENTS-17 | rebuild · adapt · S |
| M54.6 | Loopback hygiene: a bounded thread-per-request pool, Host and Origin checks, `ping` returning `{}`, −32601 for unknown methods, `serverInfo.title`. Fix the Cargo.toml comment that says the server has three methods. | AI-12, MCP-3 | rebuild · inspire · S |
| M54.7 | Prompts match the grant: typed fragments filtered by the run's effective tools; a grant-invariant contract of at most 2048 chars in `initialize.instructions`. The M9.5 propose_organize sentence changes only with owner sign-off. | AI-2 | rebuild · adapt · S |
| M54.8 | One current product brief, shared by `systemPrompt` and `get_vault_context`. A test fails on retired terms: `project.md`, `collection.yml`, `.list.yml`, Types screen, work item. | PRODUCT-10 | rebuild · inspire · S |
| M54.9 | Connectors become callable. Each enabled, narrowed connector is granted as `mcp__<name>`, named exactly as the CLI mangles it; Agent records get tool-level allow and deny; denials are recorded by tool name. Live check first; security review before merge. | MCP-13, EMAIL-12 | rebuild · adapt · S |
| M54.10 | Grant refusals are typed and recorded per run, on every axis at once (write, read, tools, non-corpus), as operational codes through the policy.v3 ritual. | PLATFORM-API-6 | rebuild · adapt · S |
| M54.11 | Connector status with the fix (schema step). The last observed status per vault and connector comes from init, permission denials and grouped `mcp__<server>__` errors. States: working, needs sign-in, failed, not approved, not observed yet, each with when it was seen. The fix is a copyable `claude mcp add` with the exact name and URL. Connectors an agent asked for but the vault lacks are named in its prompt, computed in Rust. | INTEGRATIONS-1, MCP-4 | rebuild · adapt · L |

**Acceptance.**

- The `tools.v1.json` digest is pinned in cargo and in vitest, and no hand-kept write list remains.
- A scoped Agent bearer's tools/list holds only granted tools, each with a title and read-only or destructive hints.
- A recorded first turn calls `get_vault_context` with no ToolSearch hop. A run whose init reports cerebro failed ends with an error event, never a tool-less answer.
- Four concurrent fake runs each finish `search_notes` inside the timeout.
- An exhaustive test shows that no narrowed run's prompt names a tool the run lacks.
- An enabled connector's tool works in `-p`; a narrowed-out one is refused and recorded by name.
- A read-scope refusal writes one operational row carrying its run_id.
- Settings shows "Gmail — needs sign-in" with the fix to copy, never "nothing connected".

**Risks.**

- Connector grants widen what agents can call. Unattended runs stay strict, and the security review comes before merge.
- `_meta` keys and per-server timeouts are CLI behaviour; pin the CLI version in fixtures.
- Init is a snapshot taken at turn start, so remote servers often read pending; denials and tool errors carry the rest.
- policy.v3 edits follow the README's regeneration ritual; v1 and v2 stay frozen.

### M55 — Pages first

**Goal.** Every page has one anatomy (D18): icon, cover, sub-pages and page cards, with agents opening as pages too. An agent revises a page in place by quoting it, and the open editor shows the change without losing the caret, undo or unsaved typing. Every block survives a save.

**Read first (Macro).** `apps/docs/AI/mcp/tools/edit-document.mdx` · `services/ai-editing-worker/src/comment-mark/anchor.ts` + `anchor.test.ts` (quote and occurrence; refuse, never guess) · `services/ai-editing-worker/AI_EDITING.md` · `apps/web/src/lib/core/component/LexicalMarkdown/collaboration/reconcile.ts` and `undo.ts` (behaviour only) · `apps/web/src/features/block-md/ai-edit/applyAiOps.ts` (behaviour only) · `packages/lexical-core/transformers/index.ts` · `services/sync-service/README.md` (ack after a durable write; compare-and-set) · `apps/web/src/lib/core/component/LexicalMarkdown/plugins/actions/actions.ts` (create-and-link) · `apps/web/src/lib/tauri/native-update-preparation.ts` (a bounded save flush; Macro runs it only before an update restart, never on ⌘Q).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M55.1 | A per-path write lock inside `vault::write`. | DATA-18 | rebuild · adapt · S |
| M55.2 | Every Entry carries a content hash (Rust scan, TS type, `mockParse` parity), and `get_note` returns it. The event diff emits `changed` only when content changed, so in-app patches stop minting phantom events. | AUTOMATION-16, DATA-5 (prerequisite) | rebuild · inspire · S |
| M55.3 | Write precondition (D2): agent writes may carry `expect_hash`. A mismatch is refused with a new operational code (`stale_content`), never the ledger's `stale_target_version`. Human saves stay last-write-wins. | DATA-9 (part), EDITOR-2 (part) | rebuild · adapt · S |
| M55.4 | Every `/` block has a disk carrier or leaves the menu: toggles as directives (M48 D1), nested children, audio, file, image captions, and video/audio links mapped back by extension. Empty alt and titles are kept. An enumerating test covers the menu, and M48 D5 is corrected. | EDITOR-1, FILES-13 | rebuild · inspire · M |
| M55.5 | `edit_note {path, edits[{old, new, occurrence?}], expect_hash?}`. One shared quote resolver works over page text. Each edit must match uniquely, or the call is refused with every occurrence and its context. Read scope is checked before the body is touched. The edit set is atomic, untouched bytes stay identical, knowledge/, governed types and write scope stay guarded, and an effect report comes back. | EDITOR-2 | rebuild · adapt · M |
| M55.6 | External writes apply in place. Blocks pair by content (export the LCS in `hunks.ts`); `closeHistory` runs first, so the change is its own ⌘Z step. "Dirty" means the serialization differs from the base. When dirty, a 3-way merge runs, with per-hunk choices only where edits overlap. The M17.4 banner copy and its comments retire. | EDITOR-3 | rebuild · adapt · L |
| M55.7 | Create and link from `[[` and `@`: a "Create 'X'" row makes the page and inserts the chip. | EDITOR-7 | rebuild · adapt · S |
| M55.8 | Section links: `[[page#Heading]]` resolves the page, keeps the fragment on disk, and scrolls to and flashes the heading. | EDITOR-13 | rebuild · inspire · S |
| M55.9 | Open with: Copy as prompt, Copy path (docs), Reveal in Finder, Open in default editor, and hand-off links to Claude Code on the web, Codex, Cursor and Zed (copy fallback when too long). "Copied" shows only after the clipboard write resolves. | PRODUCT-8, CODING-8 | rebuild · inspire · S |
| M55.10 | Quit and close flush pending saves: a custom ⌘Q and `CloseRequested` run a bounded prepare before exit. Dock Quit and logout cannot be intercepted; that is written down. | CLIENT-DESKTOP-4 (save half) | rebuild · adapt · M |
| M55.11 | Page icon and cover. Frontmatter `icon:` holds an emoji or an attachment, and `cover:` an attachment or a colour. Both show on the page and in the tree, tabs, breadcrumbs, ⌘K and page cards. Absent means none, and a placeholder is never written back. Guide: `apps/web/src/lib/core/component/EntityIcon.tsx`. | D18 | rebuild · adapt · S |
| M55.12 | Agents open as pages. An Agent record opens in DocPage: its instructions are the body; schedule, triggers, scope and model are properties; Runs and Memory are tabs. The Library keeps the list and the create flow, and AgentEditor's fields move into the page. Governed-type rules don't change: agents still may not write Agent pages. | D18, AI-8 | rebuild · adapt · M |
| M55.13 | Sub-pages: "Add sub-page" on any page, a child-page list block, and drag-to-nest in the Pages tree. A page with children becomes its doc folder (`docPages.ts`) and stays byte-stable on disk. | D18 | rebuild · adapt · S |
| M55.14 | Page cards. A `/page` block or a pasted page link renders a live, read-only card (icon, title, and a status chip when the schema has one) with an Open button. A missing target keeps its pointer, and M29.48's read-only embed rule holds. | D18, 01-product (References) | rebuild · adapt · M |

**Acceptance.**

- cargo: a unique quote is replaced and untouched bytes stay identical. An ambiguous quote is refused, listing both occurrences. An unreadable path is refused before any match. A stale `expect_hash` returns `stale_content` and leaves the file alone.
- e2e (boot.ts, mock agent): `edit_note` on the open page changes the paragraph without a remount, the caret stays, and ⌘Z undoes only the agent's change. With unsaved typing in another block, both edits survive; an overlapping edit shows per-hunk choices.
- vitest: every `/` item round-trips byte-stable or is not offered, `![](attachments/a.png)` is stable, and a page with an image no longer opens read-only.
- e2e: typing `[[Launch notes`, then Create, inserts the chip; `[[page#Heading]]` lands on the heading.
- ⌘Q 300 ms after typing keeps the edit.
- A page with `icon: 🚀` shows the icon in the tree, its tab, the breadcrumb and ⌘K, and its bytes round-trip.
- An Agent record opens as a page. Editing its schedule property updates the record, and its Runs tab lists its runs.
- "Add sub-page" creates a child, the parent lists it, and both survive a reload. A `/page` card shows its target's icon and title.

**Risks.**

- D2 must be decided before M55.3.
- BlockNote passes in jsdom and breaks in WebKit (the recorded DOM traps). Check merge and carriers in a real browser.
- ProseMirror merges edits made within 500 ms into one undo step; call `closeHistory` before every external apply.
- Non-git vaults have no revert for agent edits, and the UI says so.

### M56 — Runs you can read

**Goal.** One fold turns the live stream and Claude Code's own session file into the same events. Every run says why it started, which model it used and how it failed, and transcripts come back after a reload.

**Read first (Macro).** `crates/folds/claude_fold/src/lib.rs` · `crates/folds/agent_fold/src/domain/fold.rs`, `transcript.rs`, `model/metadata.rs` · `crates/folds/agent_fold/src/domain/test/real_recordings.rs` + `crates/folds/agent_fold/scripts/sanitize_recording.py` · `crates/agent_runtime_protocol/src/domain/turn.rs` (FailureNotice, StopReason) · `crates/trigger_context/src/lib.rs` · `services/scheduled_action/src/domain/target_runner.rs` · `docs/AGENT_EFFORT.md` + `crates/folds/agent_fold/src/domain/model_selection.rs` · `apps/web/src/features/block-agent/state/tool-groups.ts` and `live-turn.ts` (behaviour only) · `crates/agent_session/src/domain/session/session.rs` (for the spike).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M56.1 | Transport spike on CLI 2.1.250. Record fixtures for PreToolUse defer + `--resume`; `--permission-prompt-tool`, including the fact that it turns AskUserQuestion on; can_use_tool; interrupt; set_model; per-turn result and usage; and tool pairing after kill-then-resume. Write the D4 record. | AGENTS-14 | spike · S |
| M56.2 | Real recordings: a debug-only stdout tee, an isolated `CLAUDE_CONFIG_DIR`, a structural allowlist for system/init, a regex sanitizer and a post-scan. A sweep fails on any event kind that is neither translated nor listed as ignored. | PRACTICES-5 | rebuild · adapt · M |
| M56.3 | One transcript fold in Rust over stream-json and `~/.claude/projects/<slug>/<session>.jsonl`:<br>• groups by `message.id`, dedupes by uuid, skips meta lines;<br>• maps API-error and synthetic lines to Error and emits ModelChanged and TurnEnded;<br>• reads pr-link records.<br>New threads mint `--session-id`, and `read_cli_transcript(vault, uuid)` re-derives the path. Unavailable is typed: cleared, expired, not recorded, unreadable. One TS reducer serves live and restore, and golden events are replayed by cargo and vitest. The false AiActionCard comment goes. | AGENTS-1, CODING-11 | rebuild · adapt · L |
| M56.4 | Typed failure notices: one Rust classifier reads typed fields (the assistant error enum, `api_retry`, `rate_limit_event`, init `mcp_servers`, `claude_code_version`, JSONL error lines) into {kind, title, body, action}. The meter's quota outcome uses it; unknown failures keep their raw text. Includes a real quota fixture. | AGENTS-10, AI-10 (failures) | rebuild · adapt · S |
| M56.5 | Model and effort on Agent records and per conversation. Unset reads "Claude Code default" and passes no flag. Rust validates effort from one vocabulary, and the turn names the model init reported. | AGENTS-7, AUTOMATION-15 | rebuild · adapt · S |
| M56.6 | App config can bind the panel assistant to an Agent record: standing instructions, human-only preferences first, and that record's actor. | AI-8 | rebuild · adapt · S |
| M56.7 | Run cause (schema step: `runs.cause`, `runs.cli_session_id`):<br>• closed vocabulary under a Rust CHECK: schedule, event, assigned, handoff, manual, followup, attended, ingest, maintenance, assembly;<br>• written by every writer of runs, the meter fallback included;<br>• the preamble renders it with subject text framed as data;<br>• Fleet and Agents say why in words, and NULL reads "why not recorded". | AUTOMATION-1 | rebuild · adapt · M |
| M56.8 | Typed transcript rows: renderers keyed by the manifest. Consecutive reads fold into one "Read N notes" row (a Cerebro choice). `commit_proposals`, `hand_to` and concept writes stand alone. Payloads ride a side event instead of the 160/2000-char cuts. Unfinished rows read "interrupted, may have completed". | AI-3 | rebuild · adapt · M |
| M56.9 | Run detail explains itself (D5): cause, model, a collapsed transcript from the fold, a Refused section, and copy naming Claude Code's 30-day retention. Fleet reads go through a read-only connection newtype (`query_only`). | AGENTS-2, AGENTS-16, PLATFORM-API-8 | rebuild · adapt · M |
| M56.10 | Agent memory works again (D7): Rust allows exactly `recent`, size-capped, on the run's own Agent record. | AUTOMATION-14 | rebuild · inspire · S |
| M56.11 | The CLI workspace count and purge cover the per-session `subagents/` and `tool-results/` directories. | AGENTS-15 | rebuild · inspire · S |
| M56.12 | Measure cache writes on resumed turns. Move volatile context from `--append-system-prompt` into the user message only if the meter shows it pays. | AGENTS-18 | measure · inspire · S |

**Acceptance.**

- Every sanitized recording folds with no unclassified event, and the stream and JSONL folds of one turn give equal message content.
- After localStorage is cleared, a conversation rebuilds from its JSONL. An expired session reads "cleared by Claude Code", never an empty thread.
- A not-signed-in fixture shows a card whose action opens Settings; the quota fixture shows the reset time.
- Picking a model passes `--model` (argv test), and the footer names the model init reported.
- A seeded scheduled run of release-scout states its cause and lateness in words, opens a grouped transcript, and lists what it was refused.
- Five consecutive `get_note` calls render as one row.

**Risks.**

- The CLI's formats drift. The sweep turns that drift into a failing test.
- Transcripts live outside the vault, which is a disclosed leak; purge must reach every session directory.
- The cause vocabulary lives once, in Rust. TS renders unknown kinds in words, never a parallel enum.
- Construct runs need their own cause kinds, or they read "why not recorded".

### M57 — Ask, answer, steer

**Goal.** During an attended run, the agent can stop and ask through the CLI's own permission host: for permission, for an answer, or for approval of a write. Follow-ups queue and can steer. Unattended runs never prompt.

**Read first (Macro).** `crates/agent_session/src/domain/control.rs` (a principal never answers its own request) · `crates/agent_session/src/domain/session/session.rs`, `types.rs`, `actors.rs` · `docs/ACP_ELICITATION.md` · `crates/agent_harness/src/domain/model.rs` and `queue.rs` · `apps/web/src/features/block-agent/primitives/create-interaction-controller.ts`, `context/steer.ts`, `context/create-queue-controller.ts` (behaviour only) · `crates/ai_toolset/src/toolset/tool_object/user_tool.rs` + `crates/ai_tools/src/user_tool_review.rs`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M57.1 | Ask seam, per the D4 record: PreToolUse `defer`, the run ends `tool_deferred`, a card shows, a Tauri command records the answer, then `-p --resume` runs on the same permission host (or can_use_tool under D4 (b)). Rules:<br>• a bearer can wait but never answer;<br>• a Deferred outcome keeps ambient finalize from consuming the item;<br>• a stale answer gets `no_longer_waiting`;<br>• allow and deny stay in argv, so a hook outage fails closed. | AGENTS-3 | rebuild · adapt · M |
| M57.2 | Ask before shell (D6):<br>• the shell ceiling becomes off, ask, on; unknown stored values read off;<br>• `shared/policy/tool-approval.v1.json` + goldens decide allow, ask or deny by tool family, run kind and ceiling;<br>• the card names the exact command or path: Allow once, This conversation, Deny;<br>• an unattended ask becomes a deny plus a `capability_unavailable` row;<br>• AskUserQuestion is denied with a message until M57.3 lands;<br>• user allow rules and hooks are disclosed beside the setting. | AGENTS-4 | rebuild · adapt · L |
| M57.3 | Questions mid-turn: AskUserQuestion's real schema (1–4 questions, 2–4 options, multiSelect, Other) shows as a card, and the answer returns through updatedInput. Unattended runs are told nobody is watching. | AGENTS-5 | rebuild · adapt · S |
| M57.4 | Ask-first writes: tools the manifest flags as confirmable, on an ask-first grant.<br>• Attended: a form projected from inputSchema (flat fields plus a whole-draft JSON field); edits return as updatedInput, and Rust re-checks guards and scope.<br>• Unattended: a card in the one Review queue, with pending rows stored as operational data (schema step).<br>• The agent's next run reads applied, or rejected with a reason. | AI-4 | rebuild · adapt · L |
| M57.5 | Up next, one queue per conversation: the text, skill and TurnContext are frozen at enqueue. Entries can be edited, removed or used to steer (moved to the front; TERM, KILL, `--resume`; or interrupt under D4 (b)). The cap is stated. `agentPendingPrompt` and the mid-turn no-op comment retire. | AGENTS-6 | rebuild · adapt · M |
| M57.6 | Detached turns: closing the panel detaches instead of killing. A bounded per-run journal lets the panel re-attach without duplicates, and the composer draft survives. | AI-6 | rebuild · adapt · M |
| M57.7 | Web as a ceiling: WebSearch and WebFetch become a Settings ceiling plus a per-agent declaration, never granted to internal constructs. The `cache_source` duty is stated only when granted. | AI-10 (web) | rebuild · adapt · S |

**Acceptance (e2e, scripted mock agent).**

- With shell set to Ask, `git status` shows a card naming it. Allow once runs it and asks again next time; This conversation does not ask again; Deny returns the message.
- Stop with a card open answers Cancelled and removes the card.
- Before M57.3, AskUserQuestion returns the denial message; after it, a card returns the chosen labels.
- A scheduled run under Ask records one denial and shows no card.
- An ask-first `create_note` card lets the person edit the title before Allow. An unattended one appears once in Review and nowhere on disk.
- Text sent mid-turn shows under Up next; Steer runs it next, and the running turn ends Cancelled.
- Closing the panel mid-turn and reopening it re-attaches without duplicate rows.
- The tool-approval goldens replay in cargo and in vitest.

**Risks.**

- User allow rules and hooks act before the prompt (201 rules and 7 hook events on this machine), so the copy never promises that every command asks.
- The `default` permission mode is a hidden alias; gate on the version init reports.
- The three-state setting breaks the boolean e2e switch; migrate it explicitly.
- Steer by kill + resume relies on the CLI repairing tool pairing. Ship without Steer if the spike says no.

### M58 — Writes you can trace

**Goal.** Every vault write records who made it and in which run. Each turn commits and shows only what it wrote, page history reads as prose, review notes go back as the next instruction, and a page says which agents can change it.

**Read first (Macro).** `crates/entity_access/src/domain/models.rs` + `inbound/axum_extractors/document.rs` (receipts) · `crates/entity_access/src/domain/models/access_explanation.rs` · `crates/entity_mutation/src/capability.rs` · `crates/activity/src/domain/events.rs` (actor vs on_behalf_of) · `crates/agent_changes/src/domain/service.rs` · `apps/web/src/features/changes/core/changeset.ts` and `review-notes.ts` (behaviour only) · `crates/git_patch/src/patch.rs` and `model.rs` · `packages/lexical-core/utils/diffStates.ts` · `apps/web/src/lib/queries/trailing-refetch.ts`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M58.1 | One writer-signature pass (schema step):<br>• every vault writer (8 `shadow_write` sites plus rename and delete) takes a `WriteReceipt<Door>` (Human, Agent, ConceptDoor, System), minted only by its guard and carrying {actor, run_id};<br>• `vault_writes.run_id`, a `vault.create` kind, a (vault_id, recorded_at) index, and autosave rows coalesced per (path, actor);<br>• `.mmd` saves, imports and folder creates are recorded or declared not recorded;<br>• IPC writes are stamped `human:me`, and NULL renders "not recorded".<br>• the comment sidecar writer (`vault/comments.rs` `rewrite`, M70.2) joins the pass: it records `vault.write` rows for `.comments/<page>.json` under the comment's author today, and takes a receipt like every other writer.<br>The mock mirrors each door. | PLATFORM-API-2, PLATFORM-API-3, PRODUCT-2, AI-13, DATA-19 | rebuild · adapt · L |
| M58.2 | Coalesced, ordered rescans: one pending plus one trailing scan. Optimistic writers bump a write generation, so a stale snapshot never lands. Rescans never throw and are never gated on visibility, because triggers ride on them. | CLIENT-DESKTOP-3 | rebuild · adapt · S |
| M58.3 | Per-turn changeset:<br>• the path set is the run's `vault_writes` rows plus the fold's Write/Edit paths, and only those are committed, single-flight per vault;<br>• auto-checkpoint skips run-owned paths, and unattended runs checkpoint too;<br>• the footer reads "Changed N files · +a −b" from numstat, binary files read "binary", and patches load lazily;<br>• network git gets a timeout, and a missing run_id reads "not recorded". | AGENTS-8, CODING-1 (1b) | rebuild · adapt · L |
| M58.4 | Page history as prose: the file at a commit plus a rendered block diff, with preview and restore. "Agent X" appears only on commits a run provably wrote; everything else reads "unattributed". | EDITOR-6 | rebuild · adapt · M |
| M58.5 | Review notes on a turn's diff: notes anchored to path, side and line range go through Up next as one numbered prompt in Cerebro's wording. Each note gets a sentAt stamp, and notes are kept per viewer. | AGENTS-9 | rebuild · adapt · M |
| M58.6 | Who can change this page: the Info tab lists each agent's read and write reach, whether unattended, and why (scope, shell, grant), derived from the manifest and the shell ceiling. Scope matching is proven against Rust by shared cases. | PLATFORM-API-5 | rebuild · adapt · M |

**Acceptance.**

- A write without a receipt does not compile, and the mock refuses the same IPC doors.
- A scheduled agent's append records its actor and run_id; an editor save records `human:me`; an external edit reads "unattributed".
- A panel turn that writes 2 files while the person edits a third commits exactly 2, and View diff is not blank after the commit.
- History names an agent only for commits its run wrote.
- Two review notes on two files reach the agent as one numbered prompt.
- A page inside release-scout's scope lists release-scout as able to write it, and the reason.

**Risks.**

- The signature pass touches every writer. Do it once, not twice.
- Auto and agent checkpoints race on `index.lock`, so commits must be single-flight.
- Writes a run makes with shell granted bypass `vault_writes`; the changeset says "not recorded" for them.
- `vault_writes` grows with autosave. Coalescing is part of M58.1; retention comes later.

### M59 — Find everything

**Goal.** ⌘K reaches any page, record, concept or place, ranked by fuzzy match and recency. Page-text matches stream in below the names. The agent's own search reports its results accurately. Hover previews and in-page find complete the set.

**Read first (Macro).** `crates/opensearch_client/src/search/model.rs` (highlight windowing) · `crates/ai_tools/src/search/search_service/content.rs`, `name.rs`, `types.rs` · `apps/docs/AI/mcp/tools/content-search.mdx`, `name-search.mdx`, `list-entities.mdx` · `crates/soup/src/inbound/toolset/list_entities.rs` · `crates/client/cache-core/src/search/ranking.rs` · `crates/frecency/src/domain/models.rs` · `apps/web/src/lib/core/util/freshSort.ts` + `apps/web/src/features/command/rank-command-search-items.ts` (behaviour only) · `apps/web/src/features/soup/search/create-search-state.ts` · `apps/web/src/components/app/sidebar-next/nav-items.ts` · `apps/web/src/lib/core/component/HoverCard.tsx` · `apps/web/src/lib/core/component/LexicalMarkdown/plugins/find-and-replace/findAndReplacePlugin.ts`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M59.1 | One destination table feeds sidebar rows, ⌘K "Go to", the window title and the navigate tool, with a parity test against the Rust literal. It fixes the Pulse/History and Note/Page drift, and navigate `view` lands on the Type's view. | SHELL-1 | rebuild · adapt · S |
| M59.2 | `search_notes` reports what it found and missed:<br>• frontmatter scalars and relationship targets become searchable;<br>• excerpts are windowed with match ranges, from an offset tokenizer tested equal to `tokenize()`;<br>• trust labels, and the quoted-phrase bonus fixed;<br>• the 50 × 80 caps are stated, with "N more not shown";<br>• the description says keyword, not semantic;<br>• `[object Object]` is fixed in `searchEntries`. | SEARCH-1 | rebuild · adapt · M |
| M59.3 | One name ranker for ⌘K and every picker: quickOpenScore tiers, then uFuzzy (unicode mode) multi-term, then a per-vault open log decayed at read time. The log records only the person's own opens and can be viewed and cleared in Settings. Results are a bounded top-k; an empty ⌘K shows Recent; renames remap the log. | SEARCH-4, SHELL-3, WORK-13 | adopt-upstream (uFuzzy, MIT) + rebuild · adapt · M |
| M59.4 | ⌘K content tier:<br>• each file is read once, the scan is cached, and the body is capped per note;<br>• a `search_vault` IPC uses the same Rust ranker, debounced 250 ms at 3+ chars, with a sequence guard;<br>• "In pages" rows show marked ranges, ending in an "All N matches" hand-off;<br>• a failure renders `section-unavailable`;<br>• the mock does containment only. | SEARCH-3 | rebuild · adapt · M |
| M59.5 | Browse and modes: a read-only `list_notes(type, folder, modified_since, sort, limit ≤ 200)` that states what it withheld and "N more"; `search_notes` gains `in: name / content / all`. | MCP-7, SEARCH-2 | rebuild · adapt · M |
| M59.6 | Find and replace in a page (⌘F): literal, case-insensitive, overlay highlights, Replace all in one transaction. | EDITOR-5 | rebuild · mirror · M |
| M59.7 | Hover previews for page and concept links: open delays, one open card per group, ancestors held open, Escape through layers. Cards show title, status chip, snippet and review state; an unresolved link says so. | SHELL-8 | rebuild · adapt · M |

**Acceptance.**

- `search_notes` finds a Skill by its `description:` and says how many more matches exist; a quoted phrase ranks first.
- Within one tier, a page opened twice today outranks one opened 20 times 60 days ago. "ab" still does not match "A Better World"; "a world" does.
- An empty ⌘K lists Recent. Typing shows names at once, then "In pages". A forced `search_vault` failure renders `section-unavailable`, never "No matches".
- ⌘F finds every hit, and Replace all is one undo step.
- Hovering a wikilink opens a card, and Escape closes only that card.

**Risks.**

- Large vaults need one read per file and a cached scan, never an index (M17.19).
- The open log is a learned preference, so it must stay inspectable and clearable (§81).
- BlockNote keys menu rows by title (M52.1); the pickers keep that.

### M60 — Databases that keep their word

**Goal.** Computed values behave like stored ones, and renames ripple. A kind change never destroys data. Multi-file edits are all-or-nothing and can be undone. Deletes can be restored, renames keep links, and agent writes are checked against the schema.

**Read first (Macro).** `crates/databases/README.md` · `docs/AGENT_GUIDE/databases.md` · `crates/models_databases/src/views.rs`, `views/check.rs`, `cast.rs`, `ops.rs` · `crates/databases/src/domain/service/casts.rs` · `crates/databases/src/domain/journal/guard.rs` and `invert.rs` · `apps/web/src/features/database/core/undo-stack.ts` and `apps/web/src/lib/queries/undo.ts` (behaviour only) · `crates/models_properties/src/service/property_value.rs` · `crates/properties/src/inbound/toolset/set_entity_property.rs` · `crates/database_sql/src/fold.rs` · `services/document_storage_service/src/api/documents/revert_delete_document.rs` · `services/deleted_item_poller/src/handler.rs`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M60.1 | Computed values (created and edited time, rollups, derived relations) resolve before filter, sort, group, chart and dashboard. Numeric rollups are coerced, and `value = n ?? 0` in `chart.ts` is dropped. | DATA-3 | rebuild · adapt · S |
| M60.2 | Field references follow renames:<br>• one walker covers views, filters, layout, tabs, gallery cover, group specs and rollups, and a rename ripples through all of them;<br>• `checkView` reports unknown fields and options instead of showing an empty view;<br>• delete is blocked while a board or chart groups by the field;<br>• references in typeless `*.list.yml` files are flagged, not rewritten. | DATA-1 | rebuild · adapt · M |
| M60.3 | Shared vocabularies (D3):<br>• `shared/schema/field-kinds.v1.json`: kinds, value shapes, single/multi, groupable, filter families, default statuses;<br>• `shared/calendar/dates.v1.json`: the date grammar, including the Z/offset instants Cerebro's Rust writes;<br>• each has a sha256, a README and cases replayed by cargo and vitest;<br>• TS `validateValue` and `parseDateProperty` read them, and the first Rust schema reader lands (field defs, project status override);<br>• the reviewer ruling goes in `shared/policy/README.md`. | DATA-9, DATA-8 (part), CALENDAR-3 (grammar) | rebuild · adapt · M |
| M60.4 | `set_fields {path, set, add, remove, expect_hash}`:<br>• the shape is checked against the record's Type doc;<br>• labels map to ids, and person and relation values are wrapped as wikilinks;<br>• deltas apply to a fresh read;<br>• unknown options are kept as ghosts and named;<br>• computed keys are refused with `schema_invalid`.<br>`update_frontmatter` stays permissive (M1). | DATA-9, WORK-3 | rebuild · adapt · M |
| M60.5 | Safe kind change: a Safe / Checked / Never table over the 17 kinds, and a dry run with counts and examples. A lossy change becomes "Convert into a new property". The retyped field's filter tests are stripped or flagged in the same write. | DATA-2 | rebuild · adapt · M |
| M60.6 | Vault batch writer (schema step: recovery journal):<br>• `[{path, op, expect_hash?}]`, with ops patch, create, body replace, delete and restore;<br>• everything is validated first; temps are written, then renamed;<br>• pre-images are journaled and rolled back on next start;<br>• it refuses without a journal, over a size cap, or under knowledge/, and holds per-path locks.<br>The mock mirrors it, and store actions never throw. | DATA-5 | rebuild · adapt · L |
| M60.7 | Undo and redo of the person's own batches: per-(file, key) before/after values. A guarded inverse skips keys changed since and names who changed them only when that was recorded. Toasts gain an Undo action. Never applies to knowledge/ or proposal decisions. The "cannot be undone" copy retires. | DATA-6, CLIENT-DESKTOP-8 | rebuild · adapt · M |
| M60.8 | In-app Trash: delete moves files to `.trash/<stamp>/<path>`, outside scan, search and agents. Restore refuses to overwrite. A purge at launch moves old items on to the OS Trash; nothing is hard-deleted. The Trash carries `.comments/` too (M70.2): a page's sidecar, or a folder's mirrored sidecar folder, moves with it and comes back on restore. | PLATFORM-API-7 | rebuild · adapt · M |
| M60.9 | A TS link index mirrors Rust's TargetIndex, so relation and backlink indexes build in O(links). PREFIX-N keys resolve as link targets in both resolvers, behind one shared golden. | DATA-7 (index half), WORK-15 | rebuild · inspire · S |
| M60.10 | Renames keep links: inbound wikilinks, aliased ones included, are rewritten in one batch after the prompt "Updates N links in M pages". knowledge/ `about:` anchors go through the capture valve, or are listed and refused. From now on Cerebro writes filename-stem links. | DATA-7 (rewrite half), DATA-20 | rebuild · inspire · L |
| M60.11 | Renaming a database follows through: retags, view references and block pointers change in one batch. | DATA-17 | rebuild · adapt · S |

**Acceptance.**

- "Last edited within 7 days" returns rows on demo-vault.
- Renaming `assignee` on Work item rewrites every stored reference in one batch, `checkView` reports nothing, and one Undo restores byte-identical files.
- Retyping a text field that holds three non-numbers as number reports "3 won't convert" and offers a new property; nothing is cleared.
- A batch killed between temp write and rename rolls back on the next start (tested with a re-exec child, not the crash harness).
- Delete, then Restore, returns identical bytes.
- Renaming a page updates every page that cites it.
- `set_fields` with "In Progress" stores the option id. A wrong relation target is refused with the expected type named.
- The field-kind and date cases pass in cargo and in vitest.

**Risks.**

- D3 must be ruled before M60.3, and collation and virtual-field precedence must be pinned.
- Hand-edited YAML escapes the ripple; `checkView` has to catch it.
- The recovery journal adds a crash path. Test it without the crash harness that wedges macOS.
- demo-vault edits are test changes.

### M61 — Work and time views

**Goal.** Boards, deadlines and calendars handle real work: every assignee in its band, deadlines in relative buckets, formulas, CSV, a better composer, checklist lines that become records, and calendar hours with recurrence.

**Read first (Macro).** `apps/web/src/features/tasks-view/core/task-board.ts` and `task-board-optimism.ts` · `crates/models_grouping/src/date_buckets.rs` · `apps/web/src/features/home/queries/home-date-buckets.ts` · `crates/database_sql/src/formula.rs` (grammar only) · `crates/databases/src/domain/service/transfer.rs` · `apps/web/src/lib/core/util/csv.ts` (behaviour only) · `apps/web/src/features/block-md/component/ComposeTask.tsx` · `apps/web/src/lib/core/component/LexicalMarkdown/plugins/checkbox-to-task/checkboxToTaskPlugin.ts` · `apps/web/src/features/projects/core/assignment.ts` · `apps/web/src/features/calendar/utils/calendar-date.ts`, `event-interaction.ts`, `recurrence.ts` + `components/CalendarGrid.tsx`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M61.1 | Multi-value bands: a record sits in every band of its values, and a move replaces only the source value (order kept, deduped). `limit: 1` stays scalar. The "first value" comments go. | WORK-1 | rebuild · adapt · M |
| M61.2 | Bulk Set reports per record and keeps failures selected; Delete and Duplicate do too. Related tabs gain "Add existing". | WORK-7 | rebuild · adapt · M |
| M61.3 | Declared deadlines and buckets:<br>• a Type-doc `deadline:` key;<br>• `dateBucket` relative, day, week, month or year, looking forward for deadlines and back for created/edited, extending `dueBucket`;<br>• date and daterange become groupable, with create-in-band answered;<br>• relative date filters run on an injected clock;<br>• My work shows deadlines. | WORK-5, WORK-14 | rebuild · adapt · L |
| M61.4 | Formula kind (D13): arithmetic over number, date and formula fields, computed on read. An absent input gives an absent result, and footers say "N skipped". | DATA-4 | rebuild · adapt · M |
| M61.5 | CSV import into a new database as one batch (preview, limits, kind inference), and CSV export of a view, through one RFC 4180 module. | DATA-11 | rebuild · adapt · M |
| M61.6 | Record composer: heading fields, Create more, ⌘Enter, and "Similar records" through `search_vault`, with nothing stored. `create_note` gains `if_exists: refuse` and returns advisory similar records. | WORK-8, WORK-12, DATA-21 | rebuild · adapt · M |
| M61.7 | Promote a checklist line to a record in any status-bearing database. 📅 maps to its deadline field and @person to its person field, and the line becomes a link through BlockNote's block API. A subtask relation is set when the source is task-like. Results are reported per line. | WORK-6, EDITOR-8 | rebuild · mirror · M |
| M61.8 | Calendar hours, read-only: Day and Week timed spans with overlap columns, point chips for records with no end, a now line, scroll to 07:00. Midnight ends stay on their day, and instants convert to local time. | CALENDAR-1 (1a) | rebuild · adapt · M |
| M61.9 | Calendar editing: minute-axis move, resize and drag-to-create on `useTimeDrag`, with 30-minute snaps, keyboard snaps, and Escape to abandon. | CALENDAR-1 (1b) | rebuild · adapt · L |
| M61.10 | Recurring records: an RRULE subset behind Cerebro's own parse and describe, on upstream `rrule` (BSD-3). Occurrences are read-only in the grid, with This event / All in the editor. Unknown rule parts render once with "repeat rule not understood". | CALENDAR-2 | adopt-upstream + rebuild · adapt · L |
| M61.11 | Project pages (D18; build this part first in M61). Work item gains a `project` relation. A Project page shows Tasks and Docs tabs, which are views over the pages filed under it, plus create-in-project and a progress rollup. Cycles are a saved view over a date-range field, not a new type. The Agents and Runs tabs, and agent inheritance, follow in M63.4. | D18, 05-work missed (project relation), AUTOMATION-5 (page half) | rebuild · adapt · M |

**Acceptance.**

- Dragging a Decision card from one decider's band to another person keeps the other decider.
- Bulk Set on 20 rows reports per row, and failures stay selected.
- A work item past its due date shows under Overdue in My work and in a board grouped by due.
- A formula over an absent input renders blank, and its footer says "1 skipped".
- A CSV with quoted newlines imports as one batch, and one ⌘Z removes it.
- Promoting `- [ ] Ship docs 📅 2026-10-20 @[[person]]` creates a work item with due and assignee set, and rewrites the line as a link.
- A 10:00–11:00 record is a block in Week, a date-only record sits in the all-day lane, and a resize writes HH:MM.
- A Project page lists its work items and docs, and a work item created from it is filed under the project.

**Risks.**

- M20.5 removed date grouping for lack of buckets, so create-in-band needs an answer.
- Meeting declares a scalar `date`, so meetings stay point chips until a daterange is recommended.
- Two formula dialects (D13).
- Multi-value bands change counts that existing tests assert.

### M62 — Agents query your data

**Goal.** The agent describes a database and queries records with the same filter JSON views store. It lists an agenda across dated records, and suggests views and live answers as cards.

**Read first (Macro).** `crates/databases/src/inbound/toolset/describe_database.rs` · `crates/databases_sql/src/toolset/query_database.rs` + `crates/databases_sql/src/view_only.rs` · `apps/docs/AI/mcp/tools/query-database.mdx` and `describe-database.mdx` · `apps/web/src/lib/core/database-sql/driver.ts` and `answer.ts` (truncation, tables read) · `crates/calendar_events/src/inbound/toolset/list_calendar_events.rs` · `crates/calendar_events/src/domain/team_availability.rs` (never infer free time) · `crates/user_api_key/src/domain/models.rs` + `service.rs` · `services/mcp_service/src/main.rs` (Host checks).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M62.1 | Filter oracle matrix: an oracle written without evaluator internals, run over op × kind × boundary values, with exact ids asserted. A registry guard fails on any op or kind not classified. | PRACTICES-8 | rebuild · adapt · M |
| M62.2 | `describe_database` and `query_records`:<br>• FilterGroup JSON plus sort, fields and `limit ≤ 100`, evaluated in Rust over the scan through the M60.3 reader;<br>• unknown names are refused with the closest name;<br>• read scope applies first, with withheld counts;<br>• answers name truncated types, types read and column field defs;<br>• shared filter goldens replay in cargo and vitest. | DATA-8, WORK-2 | rebuild · adapt · L |
| M62.3 | `list_agenda`: dated records in [start, end), found by capability, soonest first, at most 200 rows with truncated and total flags. Undated, unparseable and withheld records are counted. It never infers free time. | CALENDAR-3 | rebuild · adapt · M |
| M62.4 | `suggest_view` (outside the `propose_` namespace): the agent suggests a ViewDefinition, chart and number included. Rust validates it through the reader before any card appears. The panel previews it live, and Accept appends it to `views:` and can insert a database block. | DATA-10, AI-7 | rebuild · adapt · M |
| M62.5 | Other local MCP clients (D17), off by default:<br>• a second loopback listener for personal tokens: `cbr_` prefix, SHA-256 only, shown once, revocable, at most 20, each with a scoped grant and the read toolset by default;<br>• 401 and 405 responses, Host and Origin checks;<br>• a runs row per client session;<br>• Settings gives copyable snippets. | MCP-5 | rebuild · adapt · L |

**Acceptance.**

- The filter goldens pass in both suites, and the oracle matrix asserts exact ids.
- `query_records` for "Work item where status group is active, sorted by due" returns the same paths as the TS view; an unknown field is refused with the closest name.
- `list_agenda` for one week returns due dates and decisions, counts undated records, and says when it truncated.
- Asking for overdue work items as a board yields a card whose Accept adds a tab. A suggestion that names an unknown field never reaches a card.

**Risks.**

- The twin evaluator needs the D3 ruling; today sort and filter disagree on virtual-field precedence.
- Every accepted suggestion adds a tab. Decide on hiding before shipping.
- M62.5 reverses M6's private-bearer rule (D17).

### M63 — Routines that wake once

**Goal.** Events that should wake an agent are admitted durably and run once. Wakes an agent caused are bounded chain hops. Assigning work to an agent starts it, and projects become spaces that hold their work, docs, agents and runs.

**Read first (Macro).** `services/scheduled_action/src/domain/event_runs.rs` + `event_runs/admission.rs`, `dispatch.rs`, `condition.rs` · `services/scheduled_action/src/domain/event_trigger.rs` and `execution.rs` (a manual run consumes a due firing; 409 while running) · `crates/macro_db_client/migrations/20260922182949_add_scheduled_action_event_runs.sql` · `services/scheduled_action/src/outbound/pg_event_run_repo.rs` · `crates/agent_trigger/src/domain/task_assignment.rs` and `project_assignment.rs` · `crates/routines/src/inbound.rs` and `domain.rs` · `apps/web/src/features/routines/core/schedule-language.ts` · `docs/AGENT_GUIDE/tasks.md` (projects) · `crates/initiative`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M63.1 | Durable wakes (schema step `agent_wakes`):<br>• admitted per vault, agent and content-hash wake key with INSERT OR IGNORE, unpaused agents only, and claimed inside `dispatch::claim`;<br>• closed outcomes: succeeded, failed, skipped, cancelled (superseded or expired), interrupted, coalesced;<br>• a budget deferral returns the wake to pending; the cooldown delays instead of dropping; pausing cancels;<br>• AgentsPage names pending, skipped and expired wakes. | AUTOMATION-3 | rebuild · adapt · L |
| M63.2 | Wakes an agent caused are chain hops. Admission finds the writer in `vault_writes` and books `parent_run_id`, so the 2-hop limit, cycle refusal and root ceiling apply. An unknown author wakes as a root and is never labelled human. The "Root by construction" comment goes. | AUTOMATION-4 | rebuild · adapt · L |
| M63.3 | Assignment: a relation can target Agent, explicitly and never through person inference. `when: {event: assigned, field}` fires when that field gains a link to the agent, on create or on change, never on removal, with a replay-stable key. Cerebro writes its own assignment brief, and AgentEditor gets "is assigned via <field>". | AUTOMATION-5, WORK-4 | rebuild · adapt · M |
| M63.4 | Projects get agents. Project gains an agents relation, plus Agents and Runs tabs. M61.11 already built the page, the project relation, and the Tasks and Docs tabs. A record created in or moved into a project gains the project's agents through that same human action, which then wakes them. | AUTOMATION-5 (inheritance) | rebuild · adapt · M |
| M63.5 | Run now through one start path shared with `useJobRunner`. It consumes a due fire, refuses a paused or already-running agent by name, and reports a budget deferral as a typed toast. | AUTOMATION-6 | rebuild · mirror · M |
| M63.6 | The schedule grammar grows by closed shapes: once, monthly (1–28 or last), day sets, YAML lists, and a phrase box. Resume and edit stamp an activation boundary, and the UI states that times use the machine clock. | AUTOMATION-7 | rebuild · inspire · M |
| M63.7 | Pre-run ask (D8): a tool-less internal run answers through `submit_condition`, metered and budget-gated. A "no" records skipped with the question; a check still unavailable after 10 minutes records skipped-unavailable. | AUTOMATION-9 | rebuild · adapt · M |
| M63.8 | Self follow-ups (schema step): `schedule_followup {at, note}` targets only the caller. Limits: at most 3 pending, at most 30 days out, a note of at most 500 chars, framed as data. AgentsPage lists and cancels them. | AUTOMATION-10 | rebuild · adapt · M |

**Acceptance.**

- Linking release-scout through a relation targeting Agent on three work items admits three wakes, drained one at a time, each run reading "Assigned via agent". A record created already assigned wakes once; removing and re-adding the link wakes again.
- An agent write that would wake its own author is refused as a cycle and listed as skipped.
- A budget-deferred wake runs later, and pausing cancels pending wakes.
- Run now during a due schedule consumes that fire.
- A schedule resumed mid-period waits for its next slot.
- An `ask:` "no" costs one cheap metered run and records a skip.
- A Project page lists its work items, docs, agents and runs.

**Risks.**

- A relation targeting Agent can retype people through `inferTarget` (the M20.1 hazard), so targets must be explicit.
- Coalescing wakes departs from Macro's one run per event; the copy says so.
- Hops book under the root's attended ceiling, not the ambient day gate.
- demo-vault relation changes churn e2e.

### M64 — Home and History

**Goal.** History shows who did what, folded by session. Home pulls together what needs you. Reminders the person sets fire once, even after the app was closed.

**Read first (Macro).** `crates/work_feed/src/domain/models.rs`, `policy.rs`, `stacking.rs`, `service.rs` · `apps/web/src/features/home/queries/home-date-buckets.ts` and `home-admission.ts` · `docs/AGENT_GUIDE/surfaces.md` (Home) · `crates/notification_state/src/lib.rs` · `crates/activity/src/domain/timeline.rs` · `apps/web/src/features/activity/core/collapse-runs.ts` and `contribution-grid.ts` · `apps/docs/AI/mcp/tools/read-activity.mdx` · `crates/reminders/src/domain/service/dispatch.rs` · `crates/calendar_events/src/domain/reminder_dispatch.rs` · `apps/web/tauri/src-tauri/src/macos_notification_permission.rs` (design only) · `crates/call/src/outbound/ai_call_summarizer.rs` · `crates/system_skills/src/lib.rs` and `catch_me_up.rs` (behaviour only) · `apps/web/src/features/billing-lab` (the lab pattern).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M64.1 | State lab: a dev-only page mounts real sections over mockIpc with the clock pinned. URL presets cover ready, empty, not recorded, partial and unavailable, through seeds and a one-shot `failNext(command)`. vitest and e2e reuse the presets. | README sweep (billing-lab) | rebuild · inspire · S |
| M64.2 | History becomes activity:<br>• a SELECT-only read merges `vault_writes`, runs, git and the ledger (for knowledge pages);<br>• edits group into sessions (a gap of 5 minutes or more starts a new one), then fold per day;<br>• a page's History merges GitHistoryPanel;<br>• a year heatmap reads "not recorded" for days with no app session;<br>• `read_activity` for agents.<br>Local-day buckets are tested at a non-UTC offset. The name stays History. | PRODUCT-3, COMMS-1 | rebuild · adapt · L |
| M64.3 | Durable reminders and item state (schema step):<br>• fired-reminder claims and Done receipts move to `runtime.db`, with localStorage imported once;<br>• identity is path + chip-text hash + ordinal + fire time;<br>• reminders missed while closed are reported once;<br>• date fields get a type-level default reminder;<br>• the "(9:00 AM)" labels are fixed, and reminder caches are scoped to the vault. | AUTOMATION-8, CALENDAR-4, COMMS-5 | rebuild · adapt · M |
| M64.4 | Home catches you up (D9). One line per non-empty lane, under My work:<br>• deadlines and my tasks;<br>• proposals waiting, decided on their own cards;<br>• runs ended since you looked, with cause;<br>• captures;<br>• reminders due or missed;<br>• what changed since the last convergence run;<br>• your recent edits;<br>• coming up.<br>One row per subject, in relative-time sections. Done with Undo applies only to event rows and is tied to the revision you saw. Each lane fails alone as `section-unavailable`. No nav count, bell or push. | PRODUCT-1, WORK-9, CALENDAR-11 | rebuild · adapt · L |
| M64.5 | Platform step (D12): raise `minimumSystemVersion` to 14 and bump Tauri to 2.12 in one gated commit, with the full gate and a packaged smoke test of navigation, IPC and drag. | CLIENT-DESKTOP-15 | adopt-upstream · S |
| M64.6 | Reminders reach Notification Center. The real macOS permission is read through objc2 behind a bundle-id guard, and shows "unknown", never a false "granted". Delivery goes through UN or tauri-plugin-notification, the burst at launch is coalesced, the toast always fires, and agent runs never notify. | CLIENT-DESKTOP-6, COMMS-6 | rebuild · adapt · M |
| M64.7 | Meetings become records. VTT/SRT speakers are matched to people deterministically. A CLI proposal suggests title, summary and attendees and is never applied automatically. Re-ingesting the same transcript says "already filed as X". | COMMS-4 | rebuild · adapt · M |
| M64.8 | Starter kit, offered once per empty vault: Getting started, a Tasks database with views and three records, and agents born paused. Create-only, with a marker in `.cerebro/`; never touches knowledge/. | PRODUCT-5 | rebuild · adapt · M |
| M64.9 | Recipes as editable skill files: "Catch me up" and "What I did", with read-only tools, each naming the lanes it cannot see. | PRODUCT-6 | rebuild · adapt · M |

**Acceptance.**

- Each new section has state-lab presets for all five states.
- History folds five saves into one session. Failed reads render `section-unavailable`, and days before the first app session read "not recorded".
- Home shows "2 proposals waiting" and "3 runs ended since you looked" in relative-time sections. Empty lanes render nothing, and the sidebar shows no count.
- Done on a run row hides it until a newer run of that agent ends, and Undo restores it.
- A reminder due while the app was closed yields one "passed while Cerebro was closed" notice and never re-fires after a webview data wipe.
- An unbundled dev build reads notification permission as "unknown".
- Dropping the same VTT twice says "already filed as X".

**Risks.**

- D9: Home opens at launch, so its lanes are seen without being asked for. Record the M43 amendment.
- Writes made outside the app are unattributed, and the page says so.
- Ad-hoc rebuilds reset notification grants; test on a packaged build.
- Recipes are files, not a catalogue (M17).

### M65 — Keyboard and panes

**Goal.** Every command is defined once. g/c chords and list keys work, Back restores view state, and pages open side by side with one live editor per file.

**Read first (Macro).** `apps/web/src/lib/core/hotkey/types.ts`, `hotkeys.ts`, `state.ts` + `eclipse-override.test.ts` + `scope-activation.test.ts` · `apps/web/src/features/command/CommandMenu.tsx`, `state.ts`, `Launcher.tsx`, `core/create-menu-details.ts`, `core/launcher-history.ts` · `apps/web/src/components/list/create-list-controller.ts` · `apps/web/src/lib/split-router/router/claims.ts`, `panes/history.ts`, `panes/memory-store.ts`, `tests/panes.test.ts` · `apps/web/src/components/app/split-layout/split-router/app-pane-policy.ts` · `apps/web/src/components/navigation-stack/NavigationStack.tsx` · `apps/web/tauri/src-tauri/src/lib.rs` + `apps/web/src/lib/tauri/navigation.ts` (deep links buffered, then delivered once) · `docs/AGENT_GUIDE/navigation.md`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M65.1 | Keymap and command registry (D11):<br>• DOM scopes activate on focusin, and a later binding eclipses earlier ones until disposed;<br>• a capture-phase listener honours host-editor claims;<br>• letter keys stand down in modal layers and editors (isComposing guarded), and Escape stays with `layers.ts`;<br>• g and c chords, with keycaps in tooltips;<br>• Settings → Keyboard shortcuts is generated from the registry.<br>App.tsx, `useWorkspaceKeys` and Inbox ⌘E migrate first. | SHELL-2 | rebuild · adapt · L |
| M65.2 | Palette commands: registry rows with keycaps, category chips cycled with Tab, and nested choosers (theme preview, favorites, agents). Esc and Backspace step back a level. Combobox ARIA, and the Ask row is never the default highlight. | SHELL-4 | rebuild · adapt · M |
| M65.3 | A keyed list cursor extracted from TableView's selection: j/k, Shift-extend, x, ⌘A, gg/G, Enter and Esc on My work, Home, ConceptTable and Inbox. j/k steps the record peek, and e marks a Home row Done. | SHELL-5 | rebuild · adapt · M |
| M65.4 | History entries keep scroll and filter. The last place per vault returns after relaunch if it still resolves. Overlays are never restored, and dead entries are dropped. | SHELL-6 | rebuild · adapt · M |
| M65.5 | One New launcher: a grouped catalog of everything creatable, three recents, a details pane saying where the new item lands, and c chords. Every row calls the existing creator, and databases are created through `createDatabase`. | PRODUCT-4, SHELL-9 | rebuild · adapt · M |
| M65.6 | `cerebro://` links through Info.plist URL types and `RunEvent::Opened`: buffered until the frontend and vault are ready, delivered once, and UI-only. Opening a different vault asks first. | CLIENT-DESKTOP-7 | rebuild · adapt · M |
| M65.7 | `save_note` gains an expected-version guard for writers outside the editor (Home task ticks, Library), so two views of one file cannot overwrite each other silently. | 02-shell corrected (save_note) | rebuild · adapt · S |
| M65.8 | Pane model: navStore becomes panes, each with its own history. Claims are keyed by the edited file path, and opening a held file activates its pane (silently for the agent's `open_note`). Work and Inbox stay single. vitest checks the invariants. | SHELL-7 (model) | rebuild · adapt · L |
| M65.9 | Pane row: ⌘-click and Shift+Enter open a pane. Capacity comes from a minimum canvas width, which reformulates the M52 bands. Focus, close and per-pane Back are registry commands. | SHELL-7 (surface) | rebuild · adapt · L |
| M65.10 | The layout is saved per vault in localStorage and pruned on load. One rename hook updates panes, favorites, recents and last place together. | SHELL-7 (persistence), 02-shell missed (pointer hygiene) | rebuild · adapt · M |

**Acceptance.**

- g h opens Home, letters typed in the editor still type, and Settings lists exactly the registered bindings.
- On Home, j/k move and e marks Done; j/k steps the peek from My work.
- Back returns a table to its scroll position and filter, and relaunch lands on the last place.
- ⌘-clicking a link opens a second pane. Opening the same file from the first pane focuses the second. Reload restores both, and closing the last pane goes Home.
- `open "cerebro://open?…"` from a terminal opens the page exactly once on a cold start.

**Risks.**

- 96 `stopPropagation` sites: the capture phase and explicit editor claims are required.
- M52's viewport bands assume one canvas.
- Global uiStore state (detail, diff, doc panel) must become per-pane or stay single.
- Chords leave M16's Notion premise (D11).

### M66 — Files

**Goal.** Attachments and repo files open in the app, and images paste into pages. PDFs read like documents. Office and PDF text becomes Inbox captures and an agent read tool.

**Read first (Macro).** `crates/model_file_type/src/lib.rs` · `apps/web/src/features/block-image/component/ImageContent.tsx` · `apps/web/src/features/block-unknown/component/UnknownContent.tsx` and `legacy-office.ts` · `apps/web/src/features/block-pdf/definition.ts` (behaviour; code shape from upstream pdf.js `web/`) · `services/image_optimizer/src/transform.rs` · `apps/web/src/lib/core/fig-engine/thumbnail.ts` · `crates/psd_engine/src/resources.rs` · `apps/docs/AI/mcp/tools/read-word-document.mdx`, `read-presentation.mdx`, `read-spreadsheet.mdx` · `crates/pptx_engine/src/inspect.rs` · `services/search_processing_service/src/parsers/pdf.rs` · `crates/attachment/src/image/base_64_image.rs` · `services/image_proxy_service/src/api/proxy.rs` (what we do not build).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M66.1 | File kinds as data: `shared/files/kinds.v1.json` lists ext, mime, kind, viewer, extractor, ingest, shiki language, icon, and open (allow, confirm or deny; unknown kinds get confirm, enforced in Rust only). It replaces four TS maps. | FILES-8 | rebuild · adapt · S |
| M66.2 | Bytes into the webview:<br>• a custom URI scheme over `roots::tree::resolve_within`, addressed as (root, rel), with the vault as root #0 and single-range 206;<br>• the CSP adds the scheme to img-src and media-src only;<br>• a typed `probe_file`, and size-capped raw IPC for PDFs;<br>• a mock bytes lane with the same refusals. | FILES-1 | rebuild · adapt · M |
| M66.3 | OS file drop: `onDragDropEvent` paths are hit-tested for Inbox, editor and FilesField, with a mock seam. | FILES-14 | rebuild · adapt · S |
| M66.4 | Viewers: image (fit or 100%), audio and video (native controls), a CSV/TSV table, and unknown kinds (why in words, Open per the allowlist, Reveal, Save a copy, Quick Look). Also: relative images in DocViewer, gallery covers, and a FilesField lightbox. | FILES-2, FILES-15, FILES-16 | rebuild · adapt · M |
| M66.5 | PDF viewer on upstream pdfjs-dist: virtualized pages, text layer, find, outline, page input, zoom, print. The build follows D12; only `*.pdf.test.ts` imports it. | FILES-3 | adopt-upstream · adapt · M |
| M66.6 | Images and files in pages: paste, drop and `/image` copy into `attachments/`. Byte-identical files are reused by sha256, dotfiles are skipped, the size cap is stated, and each batch gets one summary toast. | FILES-4 | rebuild · adapt · L |
| M66.7 | Documents become text: PDF pages, DOCX (styles and numbering), PPTX slides and notes, and XLSX through calamine. Outcomes are typed: no text layer, encrypted, too large, corrupt. A dropped file becomes an Inbox capture, and the original is kept. | FILES-5, SEARCH-6 | adopt-upstream (calamine, zip, quick-xml) + rebuild · adapt · L |
| M66.8 | `read_document` for DOCX, PPTX and XLSX: selectors, paging, images at most 1080 px, read scope per file, output fenced as data. `get_note` attaches vault images for read-scoped runs (at most 8, with counts stated). | FILES-6, MCP-6 | rebuild · adapt · M |
| M66.9 | Thumbnails in app-data from the image crate (with Limits), the PNG embedded in `.fig` files, the PSD preview resource and Quick Look, cached with typed negatives. Remote images load on click, https only, with no proxy. | FILES-7, FILES-10 | rebuild · adapt · M |

**Acceptance.**

- A pasted image lands in `attachments/`, renders after reload in the packaged app under the strict CSP, and round-trips byte-stable. Dropping it twice reuses one file.
- A 40-page PDF opens with find and outline.
- An executable-like unknown file offers Reveal and Quick Look, not Open.
- A dropped `.docx` becomes a capture with headings and a link to the original; a scanned PDF says "no text layer".
- `read_document` returns slide 3 of a `.pptx`. The scheme refuses `..` and out-of-root symlinks, in Rust and in the mock.

**Risks.**

- The scheme and the CSP can only be proven in the packaged app; spike first.
- D12 decides the pdf.js build and the HEIC path.
- Extracted third-party text registers as owner provenance until D15 rules.
- Decompression bombs: Limits and size caps.

### M67 — Sheets

**Goal.** Spreadsheets live in pages as legible fences of source text, computed by upstream IronCalc. A real grid edits them, agents read, calculate and edit them, and `.xlsx` comes in and goes out.

**Read first (Macro).** `packages/spreadsheet/src/spreadsheet-schema.ts`, `calculation.ts`, `ai-workbook.ts`, `ai-types.ts`, `scratch-formula.ts` · `crates/documents/src/inbound/toolset/spreadsheet.rs` · `apps/web/src/features/block-spreadsheet/README.md` + `workers/calculation.worker.ts` · `vendor/ironcalc/README.md` (then upstream IronCalc, never the fork).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M67.1 | Sheet fence and engine (D13):<br>• a `cerebro-sheet` fence with a format version, an optional YAML header, and RFC 4180 CSV of source values only;<br>• a page's fences form one workbook;<br>• upstream `ironcalc_base` runs in Rust over IPC, npm `@ironcalc/wasm` only in the browser mock, and a test asserts both pin the same release;<br>• a bad fence renders sheet-unavailable with its source.<br>Read-only rendering in DocPage, ConceptBody and Studio comes first. | CANVAS-8 | adopt-upstream (IronCalc) + rebuild · L |
| M67.2 | Agent sheet tools:<br>• `read_sheet`: at most 500 cells or 100 KB, with a truncated flag;<br>• `calculate_sheet`: at most 20 scratch formulas with overrides, never writes;<br>• `edit_sheet`: at most 25 ops or 2,000 cells on a copy, recalculated, validated, then one page write that returns changed cells and #REF!/#NAME? warnings.<br>Read scope applies, and `get_note` elides large fences. | CANVAS-9 | rebuild · mirror · M |
| M67.3 | Grid editor over the upstream Model API: completion, autofill, CSV/TSV paste, row and column insert and delete, navigation, undo. Each commit is one block update and one page undo step. DS tokens, New → Sheet, and "Ask about selection". | CANVAS-10 | adopt-upstream + rebuild · adapt · L |
| M67.4 | XLSX and CSV in and out through upstream IronCalc's xlsx crate. The import report names dropped charts, images and pivots, and the M61.5 CSV module is reused. | CANVAS-11 | adopt-upstream · M |

**Acceptance.**

- Typing `=SUM(A1:A3)` shows the total; the fence holds the formula, never the value.
- A page with two fences computes `=Budget!B2` across them.
- Pasting a 3×3 block fills the grid as one undo step.
- `edit_sheet` with 26 ops is refused. A valid batch writes the page once, and `calculate_sheet` never changes bytes.
- A real `.xlsx` imports with a report and keeps its formulas.

**Risks.**

- IronCalc releases lag its main branch, and pinning a git revision needs a wasm32 toolchain this Mac lacks.
- In Excel, `=A1` on a blank cell is 0. "Absent is never zero" governs how blank cells render, not formula semantics.
- Large fences bloat agent reads, so `get_note` elides them.

### M68 — Whiteboards

**Goal.** Free-form boards are `.canvas` files Obsidian can open, edited over a pure scene engine. They hold live cards for pages, records, diagrams and images, and agents edit them through validated ops.

**Read first (Macro).** `docs/GRAPHICS_SCENE_FOUNDATION.md` · `docs/GRAPHICS_PARITY.md` · `packages/graphics/src/core/model.ts`, `scene.ts`, `editor.ts`, `history.ts`, `commands.ts`, `connectors.ts`, `shapes/embedded.ts` · `packages/graphics/tests/boundary.test.ts` · `apps/web/src/features/block-canvas/canvas-next/core/document-format.ts`, `load-document.ts`, `migrate-legacy.ts` · `.../canvas-next/primitives/create-document-persistence.ts` · `.../canvas-next/context/canvas-ancestry.ts`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M68.1 | Scene engine in `src/engine/scene` (D14):<br>• JSON Canvas nodes and edges, axis-aligned; pure commands with injected ids;<br>• a gesture previews, then commits once, with per-item delta history (100 steps);<br>• fragments with id remap; dangling bindings degrade and are reported;<br>• durable colours (presets or hex), never CSS variables;<br>• a boundary test and a no-DOM tsconfig;<br>• upstream perfect-freehand and fractional-indexing. | CANVAS-2 | adopt-upstream + rebuild · adapt · L |
| M68.2 | `.canvas` file kind: JSON Canvas 1.0 plus one versioned `cerebro` key.<br>• Unknown keys are kept, and unknown versions open as whiteboard-unavailable.<br>• Viewing never writes; saves are serialized at 500 ms, with M17.4 reconcile.<br>• The scanner indexes text nodes and file links.<br>• A row in the files table, `.gitattributes` marks it as text, and shared canvas goldens. | CANVAS-3 | rebuild · adapt · L |
| M68.3 | Editor, part 1: an SVG-first renderer (so export keeps working); select, move, resize, marquee and snapping; one undo step per gesture; a read-only mode for ConceptBody and Studio. | CANVAS-4 (part) | rebuild · adapt · L |
| M68.4 | Editor, part 2: tools (shapes, text, ink, connectors with ports and labels, eraser), the inspector, align and distribute, markdown text edited in place, and an internal clipboard. | CANVAS-4 (part) | rebuild · adapt · L |
| M68.5 | Linked cards through one resolver:<br>• page; record (a status chip only when its schema has one); rendered `.mmd`; image through the M66 scheme; link;<br>• a missing target keeps its pointer;<br>• whiteboard tabs seed a `.canvas`;<br>• a `cerebro-whiteboard` page block, read-only with Open, with an ancestry guard of at most 8 levels. | CANVAS-5 | rebuild · adapt · L |
| M68.6 | Convert a manual-layout `.mmd` board into a new `.canvas` with an import report; the `.mmd` stays. | CANVAS-6 (mermaid half) | rebuild · adapt · M |
| M68.7 | Agent whiteboard tools: `read_canvas` (at most 500 nodes or 100 KB, read scope), `edit_canvas` (at most 25 ops, validated in Rust, written once), and `create_canvas`. Caps live in shared JSON. | CANVAS-7 | rebuild · inspire · M |

**Acceptance.**

- A `.canvas` made in Obsidian opens, edits and saves with unknown keys kept, and Obsidian reopens it.
- An invalid file shows whiteboard-unavailable and is never overwritten.
- One drag is one undo step. Deleting a node detaches its edges in the same commit.
- A card for a missing page keeps its pointer.
- `edit_canvas` with a dangling edge refuses the whole batch.
- SVG export still works.

**Risks.**

- JSON Canvas trades rotation for interop (D14).
- The Rust validator twins the TS scene rules, held together by shared goldens (D3).
- An interactive page embed would reverse M29.48; read-only plus Open is the default.

### M69 — Outside material

**Goal.** External work arrives through the person's own connectors and files and lands as legible pages with stamped provenance. People and companies are derived from cached correspondence. No credentials, no sync daemon, no sending.

**Read first (Macro).** `crates/mcp_client/src/domain/provider_registry.rs` (provider facts only) · `crates/import/src/domain/models.rs` and `service.rs` · `crates/import/src/inbound/toolset.rs` · `apps/web/src/lib/core/util/linearImport.ts` (behaviour only) · `crates/unfurl/src/domain/url_parsers.rs` · `crates/email/src/inbound/toolset/get_thread.rs` and `send_email.rs` · `crates/email_utils/src/body_replyless/plaintext_parser.rs` and `normalize_contact.rs` · `crates/crm/src/domain/service.rs` and `companies_repo.rs` · `crates/email/src/domain/calendar_invitation_parser.rs` · `apps/web/src/features/block-pr/primitives/pull-request-ready-to-merge.ts` and `data/pr-origin.ts` (behaviour only).

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M69.1 | Connector presets for servers that support dynamic client registration: canonical name and URL, OAuth scopes passed through, and a note on removal that the CLI's keychain token remains. | MCP-8 | rebuild · mirror · S |
| M69.2 | Link labels from URLs, with no network: Notion, Figma, Linear and GitHub, matched by exact host suffix, used in chips, citations and cache titles. | INTEGRATIONS-7 | rebuild · adapt · S |
| M69.3 | One import writer (D15):<br>• `shared/import/sources.v1.json` holds the vocabulary, id canonicalizers and goldens;<br>• Rust stamps source_system, source_record_id, source_url, imported_at, imported_by and import_hash;<br>• the same id keeps its path, and a file is replaced only if unchanged since import;<br>• agents cannot strip import keys;<br>• authority follows D15. | INTEGRATIONS-2 | rebuild · adapt · L |
| M69.4 | Linear CSV onto any status-bearing database: keyed on the Linear UUID, categories mapped to status groups, unmapped labels kept in a footer, with preview and counts. | INTEGRATIONS-4 | rebuild · adapt · M |
| M69.5 | Notion page import:<br>• bytes are captured by tool_use_id, never retyped by the model;<br>• a deterministic normalizer handles callouts and `:::columns`, with typed refusals for truncated, database-first or narrated pages;<br>• links to pages imported later are reconciled;<br>• a fallback is marked `agent_composed`. | INTEGRATIONS-5 | rebuild · adapt · L |
| M69.6 | `.ics` files become pages in a database picked by capability, with point events and time zones kept. | CALENDAR-10 | rebuild · adapt · M |
| M69.7 | Mail as cached Sources (D15 + R14):<br>• `cache_source` kind thread writes flat header digests (participants, sent_to, dates, needs_reply; no bcc, no volatile labels) into a gitignored `sources/mail/`;<br>• bodies are fetched only on an attended request;<br>• an attended @handle sweep uses Gmail category operators;<br>• retention prunes only on a human action. | EMAIL-0, EMAIL-1, EMAIL-2, EMAIL-13 | rebuild · adapt · L |
| M69.8 | Correspondence on records:<br>• addresses resolve only through declared email fields, and only on exactly one match;<br>• owner addresses come from SENT;<br>• consumer domains come from free-email-domains (MIT), and role lists are written here;<br>• any record with an email gets a Correspondence section. | EMAIL-3 | adopt-upstream + rebuild · adapt · M |
| M69.9 | People and companies: a Company/Person pack with a stage board and a derived "Last interaction" rollup. An on-demand lane of unfiled correspondents (people you sent to only) offers one-click Create page or Create company, with "not a person" dismissals. | EMAIL-4, EMAIL-5 | rebuild · adapt · L |
| M69.10 | Drafts, never sends: foreign tools are labelled with their server. A `/draft-reply` skill writes a plain-text Gmail draft with a signature stored in the vault and returns its link. | EMAIL-6 | rebuild · inspire · S |
| M69.11 | PR chip (D16): a PR URL in a property or body renders live state through the person's own `gh`. Readiness is unknown, no checks, not ready or ready; origin comes from the strongest signal; a status-group suggestion applies on click. | CODING-3 | rebuild · adapt · M |

**Acceptance.**

- Importing one Notion page twice keeps one file, and pages imported later become wikilinks.
- A Linear CSV lands on a status-bearing database, unmapped labels stay in a footer, and a re-import reports duplicates.
- A dropped `.ics` becomes pages with time zones kept.
- After an attended sweep, digests sit under the gitignored `sources/mail/`. A Person with a matching email shows Correspondence, and the unfiled lane lists an address the person wrote to.
- No tool path sends mail.
- A PR chip reads "checks unknown" when `gh` fails, never "ready".

**Risks.**

- Each cached source kind needs an R14 evidence pack, and connector grants need a security review.
- Correspondent and attendee emails must not reach git.
- Tool names must match the CLI's mangling exactly.
- `gh` reports checks in two shapes (CheckRun and StatusContext).

### M70 — Page comments (moved up by D18; builds right after M57)

**Goal.** Select text and comment. Threads live beside the page and survive edits. An @agent in a thread runs once and answers there.

**Read first (Macro).** `docs/design/entity-messages.md` · `crates/messages/src/domain/models.rs`, `effects.rs`, `service/timeline.rs` · `services/ai-editing-worker/src/comment-mark/anchor.ts` + `anchor.test.ts` · `apps/web/src/features/block-write/core/comment-marks.ts` + `primitives/create-docx-comments.ts` (behaviour only) · `apps/docs/AI/mcp/tools/comment-on-document.mdx` · `crates/channel_bots/src/domain/service.rs` and `trigger_detector.rs`.

| Part | What | Candidates | Mode |
| --- | --- | --- | --- |
| M70.1 | Spike: quote-plus-occurrence anchors over BlockNote's MPL comments extension, with a ThreadStore that does not use Yjs. Prove that marks stay out of dirty state and undo, and that commenting never changes `.md` bytes. Settle where the sidecar lives. | EDITOR-4, COMMS-2 | spike · adopt-upstream (@blocknote comments, MPL-2.0) · S |
| M70.2 | Human comments:<br>• a Rust sidecar store (mirrored in the mock), keyed by page, carried along on rename and delete, with a watcher event;<br>• a Comments tab plus a page-level Discussion;<br>• resolve and reopen, and tombstones;<br>• deep links as a Place;<br>• failures render `section-unavailable`. | EDITOR-4 (4a), COMMS-2 | rebuild · adapt · L |
| M70.3 | Agent comment tools: `comment_on_note`, `reply_to_comment` and `resolve_comment`, addressed by exact quote and occurrence. Ambiguity is refused with the occurrences listed. `get_note` lists open threads, and read scope is checked first. | EDITOR-4 (4b) | rebuild · adapt · M |
| M70.4 | @agent in a thread: an explicit @handle runs one attended turn, bound to (page, thread) by its run id. A placeholder is posted, then replaced by the answer. Agents never trigger agents, and there are no inferred follow-ups. If the placeholder is deleted, the answer is dropped. | COMMS-3 | rebuild · adapt · M |

**Acceptance.**

- Selecting a sentence on a decision page and commenting shows a thread. After reload it is still there, and the `.md` bytes are unchanged.
- Deleting the quoted sentence moves the thread to Discussion with its original text.
- "@release-scout check this" posts a placeholder, then the answer, in the same thread.
- `comment_on_note` with an ambiguous quote returns both occurrences.

**Risks.**

- Quote anchors break on repeated phrases; the Discussion fallback says so.
- BlockNote's comments bundle yjs and y-prosemirror.
- Sidecars can conflict when git merges them.
- This amends M47 §9 and M33b D8.

## Out of scope

| What | Why |
| --- | --- |
| Accounts, teams, invites, seats, link/team/channel sharing, ACLs, presence, hosted identity, billing, org retention, DLP (PLATFORM-API-10 to 13, DATA-16, PRODUCT-9) | D1: one person. Sharing is a git remote, RunGrant is the only access boundary, and spend is the user's own CLI subscription, already metered. |
| Channels, DMs, calls, push, email digests, a notification feed or bell, tours (COMMS-8, SHELL-12) | M8 "nothing speaks first", M33b, M43 "no bell"; D9 keeps Home pull-only. |
| Kafka/SQS/EventBridge/Lambda, OpenSearch, Redis, the connection gateway, the GraphQL client cache, OTA bundles, mobile shells, webhooks and bots (SEARCH-7, WORK-11, CLIENT-DESKTOP-12, CLIENT-DESKTOP-13, INTEGRATIONS-11, AUTOMATION-11) | One local process. The vault on disk is the truth, and watcher + rescan is the event bus. |
| Loro co-editing and Lexical's `<m-*>{json}` dialect (EDITOR-9, EDITOR-10, CANVAS-12) | Single user, and BlockNote is the locked editor base. M55 merges agent writes in place. |
| ACP transport, multiple harnesses, the `macrod` daemon, cloud coding agents, server-side code execution (AGENTS-12, AGENTS-13, CODING-9, CODING-10) | D4. No daemon or cloud (agent-platform D3), and reusing first-party client ids is a terms-of-service risk. Revisit ACP only for a second harness, through the upstream SDK. |
| In-app OAuth and token stores, Pipedream, a remote MCP endpoint with an OAuth broker, SDK/OpenAPI/GraphQL, adopting rmcp, in-app Gmail or Calendar sync, undo and scheduled send, booking links, team availability, FullCalendar (INTEGRATIONS-8 to 10, MCP-9 to 12, EMAIL-9 to 11, CALENDAR-7 to 9) | Zero credentials in the app, the CLI owns OAuth, the core has no HTTP client, and Cerebro never sends. The calendar grid is built on the shared drag primitive. |
| Coding worktrees, push and PR proposals, a Reviews inbox, per-root session lists (CODING-4 to 7) | D16: Scape and Claude Code's own worktrees already do this (M30 D4, M32.12, M33b D1). |
| DOCX/PPTX/PSD/FIG engines and editors, LibreOffice previews, legacy Office upgrade, a Drive view, orphan reports (FILES-9, FILES-11, FILES-12, FILES-17) | AGPL engines of 28k–94k LOC each, plus 15k–50k-LOC editors, in a markdown-first app. M66 covers viewing (Quick Look) and reading (extraction). |
| Embedding Excalidraw or tldraw instead of our own scene engine (CANVAS-13) | Their own editor stack, no record cards, no shared command layer for agents; tldraw's SDK licence is not permissive. |
| Block-addressed agent edit ops (AI-5) | `edit_note` (M55.5) covers in-place edits without a second, Rust-side markdown segmenter. |
| Embeddings, semantic search, a persistent index, block-level search hits (SEARCH-5, SEARCH-7, SEARCH-8, AI-S4) | M17.19 and M26.2; R1 and R6 gate embeddings. Block-level hits wait for a measured need. |
| AI projections, an LLM-written memory profile with a judge, a code-defined skill catalog, in-server tool search, telemetry (AI-9, AI-S1, AI-S2, AI-S3) | Nothing speaks first, knowledge is human-verified, recipes ship as files (M64.9), and the CLI owns tool search. |
| Always-on execution and an @mention judge (AUTOMATION-12, AUTOMATION-13) | Execution only while the app is open, with catch-up on launch (agent-platform D3); R10 gates a companion service. |
| Themes, the icon rail, an overlay title bar, a URL router, a single-instance guard, an auto-updater, incremental rescans (SHELL-10, SHELL-11, SHELL-13, CLIENT-DESKTOP-9, 10, 11, 14) | Low value. M37.3 and M42 settled the chrome, the per-vault flock guards a second instance, and the updater waits on key custody. |
| ast-grep, a crate split, OTLP/LGTM, a CLA, CodeRabbit, CODEOWNERS, path-filtered lanes, `pnpm check`, port hashing (PRACTICES-10 to 14, PRACTICES-17) | ESLint, clippy and the tripwires carry the rules; this is a solo repo. |
| A shared property catalog and a SQL engine (DATA-14, DATA-15) | M47 D3 gives each database one schema, and FilterGroup JSON is the query language. |
| Next wave, each waiting on a ruling or a measured need: staged import queue (INTEGRATIONS-3), Slack archive (INTEGRATIONS-6), Notion databases (INTEGRATIONS-13), host-side connector calls and in-app sign-in (INTEGRATIONS-12, MCP-15; need D4 (b)), calendar overlay and copy availability (CALENDAR-5, CALENDAR-6; R14), reply-aware follow-ups and the `.eml` inlet (EMAIL-7, EMAIL-8), local meeting capture with on-device speech-to-text (COMMS-7), Filter with AI (WORK-10), forms and manual order (DATA-12, DATA-13; M46.2 sign-off), Excalidraw import (CANVAS-6, Excalidraw half) | Their value, or their gate, does not justify them yet. Revisit after M69 ships. |

## First two weeks

- **Day 1.** Push `m49-knowledge-integrity` and open its PR to main. Run the full gate (cargo with the crash skip list; e2e on a free port), merge, then resync local `main`. Nothing below starts on the old base.
- **Day 1.** Send the owner the decision sheet. D1 and D18 are decided; D2–D7 come first, because they gate M55–M58.
- **Day 2.** M53.1–M53.2: cherry-pick 478afd3..777615c onto the new main; resolve `.gitignore` and `AGENTS.md`; apply the `app_dir` fix and the SECURITY.md modes; run the full gate. The owner decides whether branch pushes keep a CI trigger.
- **Day 3.** M53.3 toolchain pin. M53.4 corpus-bound doors are already built (hotfix, uncommitted): review them and commit as `fix(mcp): agent writes stay in the note corpus (M53.4)`.
- **Day 4.** M53.5 read-scope reader withdrawal; M53.6 agent writes reach the open page. M53.7–M53.8 are already built (hotfix): review, then commit as two parts.
- **Day 5.** M53.9 is already built (hotfix): review it and check it in a real browser, then commit. Then, in a scratch vault on CLI 2.1.250, the live checks M54 and M56.1 need: a connector tool in `-p`, per-tool alwaysLoad and the per-server timeout, PreToolUse defer + `--resume`, and `--permission-prompt-tool` turning AskUserQuestion on. Keep the runs as the first recordings, to be sanitized in M56.2.
- **Days 6–7.** M53.10 spawn helper, with the crash-test skip list on; M53.11 tokens and the 0600 file.
- **Day 8.** M53.12 navigation guard; M53.13 keep-awake, with a packaged before/after; M53.14–M53.18, one commit each.
- **Days 9–10.** M53.19–M53.24 rails. If the week slips, the rails move to week 3; the safety parts never do. Close with an owner look at M53 in the packaged app (links, AI block, agent appends, Stop), gates green and coverage floors held. Then write the M54 plan doc: read `crates/ai_toolset/src/annotations.rs` and `TOOL_DESIGN.md`, and write each tool's manifest row as its acceptance.

## Sources

- `docs/superpowers/specs/2026-10-12-macro-reference/README.md`: entry point, stack comparison, license notes, top twenty ideas, coverage.
- Per-domain files, each with ideas, gaps, conflicts, prior decisions, candidates and verification notes:
  - `01-product.md` (PRODUCT-*), `02-shell.md` (SHELL-*), `03-editor.md` (EDITOR-*), `04-data.md` (DATA-*), `05-work.md` (WORK-*)
  - `06-agents.md` (AGENTS-*), `07-ai.md` (AI-*), `08-automation.md` (AUTOMATION-*), `09-mcp.md` (MCP-*), `10-coding.md` (CODING-*)
  - `11-integrations.md` (INTEGRATIONS-*), `12-search.md` (SEARCH-*), `13-email.md` (EMAIL-*), `14-comms.md` (COMMS-*), `15-calendar.md` (CALENDAR-*)
  - `16-canvas.md` (CANVAS-*), `17-files.md` (FILES-*), `18-client-desktop.md` (CLIENT-DESKTOP-*), `19-platform-api.md` (PLATFORM-API-*), `20-practices.md` (PRACTICES-*)
- House context: `AGENTS.md`; `docs/superpowers/plans/convergent-intelligence-overhaul.md` (D5, two records and two destinies); `docs/superpowers/plans/2026-09-29-m52-build-it-all.md`.
