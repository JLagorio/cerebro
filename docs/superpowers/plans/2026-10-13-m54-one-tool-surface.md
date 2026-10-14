# M54 — One tool surface

**Goal.** One shared manifest says what each Cerebro tool is, and Rust and TS both derive from it. Tools load early, listing follows the grant, prompts name only granted tools, and connectors become callable and report their status with a fix.

Roadmap: `2026-10-12-macro-port-roadmap.md`, § M54. House style and rails: `2026-10-12-m53-safe-core-and-rails.md`.

**Read first (Macro), by part:** .1 `crates/ai_toolset/src/annotations.rs`, `crates/ai_toolset/TOOL_DESIGN.md` · .4 `services/mcp_service/src/tool_service.rs` (+ `tool_service/test.rs`), `crates/ai_tools/src/lib.rs` (`tools_for`) · .5 the same file (`EAGER_TOOLS`) · .6 `services/mcp_service/src/main.rs` (Host checks) · .7 `crates/prompt/src/lib.rs`, `crates/prompt/tests/compose.rs`, `crates/ai_tools/src/test.rs` · .8 `crates/ai_tools/src/self_knowledge.rs`, `crates/prompt/src/about_macro.rs` · .9 `crates/mcp_toolset/src/mangle.rs` · .11 `apps/web/src/features/settings/connections/model.ts`, `apps/web/src/lib/core/component/AI/component/mcpConstants.ts`.

## Status

- **Precondition:** M53 is closed, meaning its gate is green and the roadmap's M53 status is updated. Today M53 is in progress on `m53-macro-port`: M53.4, .7, .8 and .9 are committed, and the rest are uncommitted drafts.
- **Built:** nothing yet. All 11 roadmap parts were scouted on today's tree (fc510e6 plus M53's drafts), and all 11 stay.
- **Effort:** 3 S + 6 M + 2 L ≈ 5.8 L; the roadmap said ≈3.8 L. Re-measured: .1 from M to L; .2, .5, .6, .7, .8 and .9 from S to M.
- **Crash risk:** .5 (process termination) and .11 (schema step).
- **Packaged or live checks:** .1, .4, .5, .6, .7 (dev only), .9 and .11.

## Decisions

- **Owner decisions** (roadmap, 2026-10-12), as they bind M54:
  - D0: Macro is the guide. No copied code, prompt text or fixtures.
  - D1: recorded refusals (.10) and connector observations (.11) carry their run_id.
  - D3: where Rust and TS twin a rule, shared data holds them together. `tool-cases.json` and one refusal list bind the two manifest loaders (.1, .2); `tool-grants.json` binds the TS grant mirror (.7).
  - D4 (a): text that depends on the grant rides `--append-system-prompt`. Text that holds for every grant rides `initialize.instructions` (.7). claude.ai connectors wait for D4 (b) (Q9).
  - D7: fixing the `recent` memory line is M56's job.
  - D18: the brief (.8) describes how pages open today; M55 rewrites that line.
  - **M54.7 keeps the M9.5 propose_organize sentence** byte for byte, pinned by a test.
- **Rules:**
  - One part, one commit: `type(scope): sentence (M54.n)`. Each commit deletes the comments it falsifies.
  - Parts start on M53's closed tip. M53 moves every line, so edits anchor by function name or text, never line number.
  - The waves are fixed, and parts in a wave share no file.
  - Waves 1, 2 and 8 build in parallel worktrees, each with its own e2e `PORT`. cargo runs one at a time with a shared `CARGO_TARGET_DIR`. Parts cherry-pick in part order, then the wave tip is re-gated. The milestone branch stays in the main checkout.
  - `tools.v1.json` is the one tool inventory. No hand-typed tool list in Rust or TS survives.
  - Every edit to `tools.v1.json` (.1, .5, .8) or policy.v3 (.10) regenerates its digest by the README's ignored test. Never run prettier over `shared/`.
  - New refusal codes: only .10's four. Schema steps: only v19, in .11.
  - CLI behaviour is pinned at version 2.1.250. Every live check runs on it, and every recording names it.
  - **Recorded fixtures** (.5, .9, .11) are hand-reduced before commit, because the repo is public (M53.23):
    - only the fields the code reads, such as type, subtype, `mcp_servers` names and statuses, tool names and `permission_denials`, plus the CLI version;
    - synthetic ids (`00000000-0000-4000-8000-…`, as result-success.json uses) and toy-server names only, never an owner connector's payload;
    - a stream is a prettier-formatted JSON array, since `src-tauri/fixtures/` is not prettier-ignored.

    .5's `scripts/fixtures.test.ts` guards this.
  - With the owner's OK, push after waves 3 and 8, so CI's crash suite runs on .5 and .11.
- **Contracts between parts.** Whichever part lands second does the shared work:
  - .1 serves `always_load` false on every row; .5 turns six rows on.
  - .1 deletes the `base_tools` doc comment, which the roadmap gave to .2. .2 rewrites tools.ts's scrape clauses.
  - .4 filters tools/list on the tool grant alone, through `narrow`'s one name test, so .7's TS filter names the same set, generated proposal names aside.
  - .5's `server_init` serves .11, and .5's `CEREBRO_TOOL_TIMEOUT_MS` bounds .6's concurrency test.
  - .6 owns the `initialize` reply; .7 adds `instructions` to it.
  - .7 creates `shared/prompt/`; .8 adds the brief and the retired terms.
  - .9's `disallowed-tools` binds only connector tools, so .7's grant mirror and its fixture stand.
  - .9's `RunConnectors` feeds .11. .11's prompt paragraph names connectors, never cerebro tools.
  - .9's new request key and .11's new command each land with their adapter call, so .3's test keeps passing.
  - .10 keeps `ungranted_tool_refusal`'s signature, so .4's test stands.
  - CV ids go in wave order: .3, .7 and .8 each take the next free one, and .2 extends CV-04.

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M54.1, M54.3 | the tool manifest in Rust · IPC contract test |
| 2 | M54.2, M54.4 | TS reads the manifest · tools/list shaped by the grant |
| 3 | M54.5 | tools load early; a failed init stops the run; fixture guard (`scripts/fixtures.test.ts`, added by review) |
| 4 | M54.6 | loopback pool, Host and Origin checks, protocol answers |
| 5 | M54.7 | prompts match the grant |
| 6 | M54.8 | one product brief |
| 7 | M54.9 | connectors become callable |
| 8 | M54.10, M54.11 | typed grant refusals · connector status |

**Review changes:** only .5 gained a file (above). No part changed wave.

**Before wave 1.** Commit this plan on M53's closed tip. If the roadmap's day-5 recordings exist (CLI 2.1.250: a connector tool in `-p`, per-tool alwaysLoad, the per-server timeout), .5 and .9 start from them, hand-reduced per the fixture rule. The raw recordings never enter the repo.

## Parts

### M54.1 tools.v1.json serves tools/list and derives the grant, the targets and the CLI lists

- **What:** no manifest exists. `base_tools()` holds 17 hand-written `json!` tool definitions, and eight hand-kept lists sit beside them:
  - in mcp.rs: `write_target`, call_tool's read targets, the writer list in `announced_change`, and the tool-name pair in `unreadable_replacement`;
  - in agent/mod.rs: `INTERNAL_DISALLOWED`, `UNGRANTED_WRITERS`, `SCOPED_READERS`, and the shell grant in `tool_policy`.

  tools/list serves no annotations.
- **Files:** `shared/policy/{tools.v1.json, tools.v1.sha256}` (new), `shared/policy/README.md`, `.prettierignore`, `src-tauri/fixtures/tool-cases.json` (new), `src-tauri/src/{policy/tools.rs (new), policy/mod.rs, mcp.rs, agent/mod.rs}`, `src/engine/tools{,.test}.ts`. Also `.claude/skills/policy-artifact-edit/SKILL.md`, if it lists regen commands.
- **Approach:**
  - **Seed the manifest from what is served.** A throwaway `#[ignore]` test dumps `tool_catalog(true)` at M53's tip, and jq turns the dump into rows. Then write_concept gets its `{{concept_types}}` token back. Contents are in Appendix A. Format: two-space JSON, LF, one trailing newline, no BOM.
  - **`policy/tools.rs`**, beside table.rs:
    - it compiles the manifest in with `include_str!` and parses it strictly (`deny_unknown_fields`);
    - `validate()` names the row and field it refuses (Appendix B);
    - no runtime digest check (the policy.v3 precedent) and no `#[allow]`;
    - accessors: `row`, `rows`, `generated`, `generated_op`, `writes_disk` and `cli_names`.
  - **Serve from the rows.** `base_tools()` and `commit_proposals` are built from the rows. Each tool gets `annotations` (a title and four hints) and `_meta`: `anthropic/searchHint` always, `anthropic/alwaysLoad` only when true. Generated `propose_*` tools get annotations from `generated`; their names, descriptions and schemas stay policy.v3's.
  - **Derive every list.** `write_target`, a new `read_target`, `unreadable_replacement`, `announced_change` and agent/mod.rs's CLI lists all read the manifest. The no-shell deny string stays `Write,Edit,MultiEdit,NotebookEdit,Bash` byte for byte.
  - **README:** add a files row and the regen line, `cargo test --lib policy::tools::tests::write_tools_digest -- --ignored`. Record the judgment calls:
    - order is meaning, so nothing is sorted;
    - read_only only on door none, because readOnlyHint lets the CLI call tools in parallel;
    - a picker copy edit is now an artifact edit;
    - the `_meta` keys come from CLI 2.1.250.

    `tools.test.ts` reads tool names from the manifest instead of scraping mcp.rs.
  - **Prove nothing else changed.** After regenerating the digest, dump again. `jq 'map(del(.annotations, ._meta))'` of the new dump must equal the first dump byte for byte. Then delete the throwaway test.
- **Comments to delete:**
  - the scrape notes on `base_tools` (the roadmap's mcp.rs:734-739, moved here from .2), submit_answer, `REPORT_TOOL` and `rustToolNames`;
  - every stale "twelve tools" count;
  - the tool-list docs on `write_target` and `announced_change`, and `SCOPED_READERS`' tripwire line;
  - policy/mod.rs's policy.v2 line and its `mcp.rs:1362` reference;
  - `.prettierignore`'s policy.v1 line.

  tools.ts's scrape clauses get an interim fix, and `tool_policy`'s doc comment moves back off `MCP_PREFIX`.
- **Tests:**
  - policy/tools.rs: the digest matches, the compiled bytes match the file on disk, and the shipped manifest validates. One negative control per refusal. `no_tool_reaches_outside_the_app`.
  - mcp.rs: `every_served_tool_is_valid_api_input`, `every_served_tool_carries_its_annotations`, `the_served_catalog_is_the_manifest_in_order`, `the_manifest_spells_the_names_the_code_does`, `hand_written_and_generated_names_never_collide`, `replays_the_shared_tool_cases` (about 16 cases). The scope and announce tripwires now read the manifest, and the existing tests pass unchanged.
  - agent/mod.rs: `the_cli_lists_are_the_manifests`. The argv tests pass unchanged.
- **Acceptance:**
  - tools/list serves every tool with a title and hints. Names, descriptions and schemas are otherwise byte-identical, propose_organize's included.
  - `tool_policy`, `write_target` and `read_target` derive from the manifest. No hand-kept tool list remains in `base_tools`, the target and announce functions, `unreadable_replacement` or agent/mod.rs; dispatch stays a function table.
  - A cargo test checks every served input schema against the API rules, and cargo pins the digest.
  - A hand-written `propose_` name other than propose_organize fails the manifest load.
  - A run with no shell and no scope gets a byte-identical argv.
- **Live check:**
  - A panel turn that searches and reads two notes completes, which proves parallel read-only calls work.
  - An agent append lands on the open page.
  - A read-scoped agent run still lacks Read, Glob and Grep.
- **Wave** 1 · **Depends** M53 (.2, .5, .6, .10–.12, .17, .21, .23, .24) · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(mcp): one tool manifest serves tools/list and derives the grant (M54.1)`. The body records the dump diff.

### M54.2 TS reads the manifest: picker, icons, write checks and run-log paths

- **What:** five TS tool lists disagree:
  - `WRITE_TOOLS` misses MultiEdit, commit_proposals and `propose_*`;
  - `TOOL_ICONS` gives every tool added since M18 the wrench fallback;
  - `isWriteTool` is a regex that misses MultiEdit, NotebookEdit, commit_proposals and `propose_*`, so those turns skip the M9.5 checkpoint;
  - tools.ts's toolsets and runLog's `writtenPath` are kept by hand.
- **Files:** `src/lib/policy/tools{,.test}.ts` (new), `src/engine/{tools,tools.test,runLog}.ts`, `src/agent/{AiActionCard.tsx, AiActionCard.test.ts, useAgentChat.ts, useAgentChat.test.tsx, RunList.test.tsx}`, `shared/policy/README.md`, `AGENTS.md`. Also `eslint.config.js` and `scripts/lint-rails.test.ts`, if M53.20's engine allowlist names modules one by one.
- **Approach:**
  - `src/lib/policy/tools.ts` is the TS twin of `policy/tools.rs`, following the `table.ts` precedent: same refusals, same messages. `toolFacts(name)` gives a tool's origin, writes flag, renderer, icon and target. No DOM.
  - `engine/tools.ts` builds `TOOLSETS` and `UNPICKABLE_TOOLS` from the manifest, and every export keeps its shape. It adds `isWriteTool`, `showsAsChange` and `toolIconName`, which falls back to `wrench`.
  - `writtenPath` reads the row's target argument. AiActionCard drops `TOOL_ICONS` and `WRITE_TOOLS`, and useAgentChat imports `isWriteTool`.
  - The README names the TS reader and what it derives. In AGENTS.md, CV-04 gains a sentence: tool facts are data, and a tool list typed in either language is the same defect. Both digest tests become its `enforced:` pointers.
- **Comments to delete:**
  - in tools.ts: the MIRROR header, "or in the UI" on `ToolSpec.writes`, the UNPICKABLE parity sentence, and "PUSHED INTO TOOLSETS";
  - tools.test.ts's M18.4 block;
  - AiActionCard.tsx:56-59 and its icon-map comments;
  - `isWriteTool`'s doc and `writtenPath`'s case comments.
- **Tests:**
  - lib `tools.test`: digest, validation, one negative control per Rust refusal, `toolFacts`.
  - engine `tools.test`: picker order, members and flags. `isWriteTool` replays `tool-cases.json`, and RunList.test replays it for `writtenPath`.
  - AiActionCard.test: every manifest icon resolves. MultiEdit counts as a write; Bash and `propose_create_belief` don't.
  - useAgentChat.test: a commit-only turn and a MultiEdit turn each call `onWrote` at Done.
  - `e2e/agent.spec.ts` passes unchanged.
- **Acceptance:**
  - vitest pins the digest too, and no hand-kept tool list remains in TS.
  - The picker's toolsets keep today's order, members, labels and flags.
  - Proposal and commit turns now rescan and checkpoint. MultiEdit and NotebookEdit count as writes; Bash doesn't.
  - Every tool shows its own icon, never the wrench.
- **Wave** 2 · **Depends** M54.1; M53.6, .10, .19, .20 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** no
- **Commit:** `refactor(agent): the picker, transcript and run log read the tool manifest (M54.2)`.

### M54.3 IPC contract test: every adapter call is held to generate_handler!

- **What:** nothing checks the webview's invoke calls against Rust's `generate_handler!`, which registers 103 commands.
  - Tauri ignores keys a command doesn't declare and reads a missing optional key as None. So a misspelt `read_scope` in `run_agent` silently runs unrestricted.
  - A prototype scan found three problems: `ambient_ingest_enabled` and `set_ambient_ingest` have no caller, and `stopAllAgents` has no production caller.
  - After M53.2, three root-git reads will also have no caller.
- **Files:** `src/lib/ipcContract.test.ts` (new), `src/lib/{ipc,mockIpc,mockIpc.test}.ts`, `src/agent/agentIpc.ts`, `src-tauri/src/lib.rs`, `AGENTS.md`.
- **Approach:**
  - It is a scan test, not code generation: tauri-specta would add a crate and rewrite every adapter. The test's header lists what it can't check: payloads passed as variables, return shapes, ui-action values and plugin calls.
  - **Rust side**, a text scan. It reads `generate_handler!`, each command's parameters (skipping arguments Tauri injects), one level of serde struct fields, and the emitted events. Its key rules:
    - top-level command args are camelCased, as Tauri does (`unmount_root(root_id)` takes `{ rootId }`); fields inside a param struct keep their serde names;
    - a param struct's `rename_all` is applied;
    - `skip` and `skip_deserializing` fields are dropped (`AgentRequest.internal`, and `mcp_url` and `mcp_token` after M53.10);
    - `default` changes no key, so it is ignored;
    - any other shape fails loudly: `rename`, a bare `#[command]`, `flatten`, `emit_to`.
  - **TS side**, through the TypeScript compiler API:
    - it finds every invoke and listen in the four adapters and follows forwarders such as `invokeRootGit`;
    - each call needs a literal command name, an object-literal payload, and an `inTauri()` guard;
    - a caller counts only if it imports the export, since the mocks reuse the same names.
  - `audit()` returns one fixed message per problem. `UNCALLED` lists commands allowed to have no caller, each with a reason: the two ambient commands (Q1) and whatever M53.2 leaves uncalled (Q2). `EVENTS` lists the three event names.
  - If `stopAllAgents` still has no production caller after M53.10, delete it along with `stop_all_agents`. AGENTS.md gets a CV bullet: only the four adapters invoke or listen. Its pointer is `enforced: src/lib/ipcContract.test.ts::the webview and Rust agree on every command`.
- **Comments to delete:** ipc.ts's "Signatures follow the plan's IPC table."; the docs on both stop-all functions; stop_agent's stale "Returns the killed run's id".
- **Tests:**
  - The real tree audits clean, and every adapter has call sites.
  - `UNCALLED` and the event sets match exactly.
  - `run_agent`'s request keys are exactly `AgentRequest`'s deserializable fields, so `internal`, `mcp_url` and `mcp_token` are not among them.
  - One negative control per message and per scanner rule.
  - By hand: misspell `read_scope` in runAgent, see the test name the fix, revert. Note it in the commit body.
- **Acceptance:**
  - Every invoke name, argument key and event is checked against Rust. A misspelt run_agent field fails `pnpm test:run`.
  - Commands with no caller carry reasons, and a stale `UNCALLED` entry fails.
  - Every call sits behind `inTauri()`, and `stopAllAgents` is gone.
  - The test reads files only and runs in under 3 s, so CI's quality job runs it.
- **Wave** 1 · **Depends** M53.2, .10, .19, .20, .23, .24 · **Size** S · **Crash risk** no · **Packaged check** no
- **Commit:** `test(ipc): every adapter call is held to generate_handler! (M54.3)`.

### M54.4 tools/list shaped by the grant

- **What:** tools/list serves the whole catalog to every bearer.
  - A narrowed run sees every tool.
  - The panel sees the window and answer tools, which it can never use.
  - The CLI may reuse a cached list across runs.

  Dispatch already refuses tools the run wasn't granted.
- **Files:** `src-tauri/src/{mcp.rs, agent/mod.rs}`.
- **Approach:**
  - `listed_tools(grant, proposals)` keeps the catalog's order and drops any tool that `ungranted_tool_refusal` would refuse.
  - **One matcher.** Today `narrow` trims and lowercases, but `ungranted_tool_refusal` compares exactly, so `allowed-tools: [Get_Note]` puts get_note in argv while dispatch refuses it. Both now call one shared name test: trim, ignore ASCII case, with or without `mcp__cerebro__`.
  - `report_window_outcome` is listed only while the run holds an open ingest window, and `submit_answer` only while it holds an open question.
  - No other axis is filtered: scope and read scope stay dispatch checks, so .7's TS filter names the same set.
  - `holds_window` and `lists_question` read a poisoned lock as false.
  - The cerebro entry in the run's mcp-config sets `"discoveryCache": false`, because the list depends on the bearer.
  - Tests mint real bearers, one run id each, because the window and question registries are process-global.
- **Comments to delete:** `tool_catalog`'s "What `tools/list` serves."; `ungranted_tool_refusal`'s "Equal names strip to equal names" note.
- **Tests:**
  - `a_scoped_agent_lists_only_its_granted_tools_each_titled_and_hinted`.
  - `every_listed_tool_passes_the_dispatch_check`, for every grant shape, with proposals on and off.
  - `a_case_variant_grant_reaches_argv_dispatch_and_the_list` (`Get_Note`).
  - The window and answer tools are listed only while held, and the panel lists everything else.
  - `the_cerebro_entry_never_reuses_a_cached_tool_list`.
- **Acceptance:**
  - A scoped bearer lists only its granted tools, each with a title and hints.
  - Every listed tool passes dispatch.
  - argv, dispatch and the list agree on a case-variant grant.
  - The window and answer tools are listed only while held.
  - `discoveryCache` is false, and tools/call is otherwise unchanged.
- **Live check:** a scoped agent run and a panel turn each call a granted cerebro tool.
- **Wave** 2 · **Depends** M54.1; M53.10, .11 · **Size** S · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(mcp): each run lists only the tools its grant holds (M54.4)`.

### M54.5 Tools ready early, and no run answers without them

- **What:**
  - CLI 2.1.250 defers every MCP tool behind ToolSearch, so each run spends a turn finding its tools.
  - A run whose cerebro server failed at init answers without tools.
  - The run's mcp-config sets no per-server timeout, so the user's `MCP_TOOL_TIMEOUT` or a remote setting decides.
- **Files:** `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`, `src-tauri/src/agent/{mod,meter}.rs`, `src-tauri/fixtures/cli-stream/{init-connected,init-pending,init-failed,first-turn-read-core}.json` (new), `scripts/fixtures.test.ts` (new, added by review).
- **Approach:**
  - **Load six tools early.** `always_load` goes on the read core (get_vault_context, search_notes, get_note, knowledge_about) and on the two held tools, `report_window_outcome` and `submit_answer`. The held tools go past the roadmap on purpose: after .4, only the run holding the window or question lists them. Regenerate the digest, and add a README line on why only six.
  - **Pin a timeout.** The cerebro entry gets `timeout: 60_000` ms (`CEREBRO_TOOL_TIMEOUT_MS`). That is the CLI's own default, now pinned. Connector entries keep the CLI default.
  - **Read init's status.** `server_init` reads each server's status from the init event; it is `pub(crate)` so .11 can reuse it:
    - connected → ready;
    - pending, absent, unreported or an unknown word → unsettled, with one log line. That line is the measurement that decides server-level alwaysLoad;
    - failed, needs-auth or disabled → refused.
  - **Stop a refused run.** `InitGate` emits one error event (Appendix C) and stops the run without booking it cancelled. The meter books it failed with usage unknown. A run that holds no cerebro tool is never gated. No TS change.
  - **Live check:**
    - (a) Ask "What is in this vault?" before and after this part. Record `num_turns` and any ToolSearch hop.
    - (b) Run `claude -p` against a closed port, a silent socket and a toy server. Record the status words, and prove `timeout` is in ms.
    - (c) Run ten panel turns and check the log for "pending". Add server-level alwaysLoad only if (c) shows pending.

    The fixtures name the CLI version and follow the fixture rule (Rules).
  - **Fixture guard.** `scripts/fixtures.test.ts` fails on `/Users/`, `/home/`, an `@` or a non-synthetic UUID under `src-tauri/fixtures/cli-stream/`. .9's and .11's stream fixtures land under it.
- **Comment to fix:** M53.10's comment about stderr on a run with no result is false for a run refused at init.
- **Tests:**
  - The entry carries its timeout, and only the six rows load early.
  - `init_names_each_servers_status`, plus the readiness mapping.
  - A failed init gives [Init, Error] and nothing after. A pending init lets the run answer.
  - The recorded first turn reaches get_vault_context with no ToolSearch hop.
  - `ending_a_run_at_init_kills_it_without_booking_cancelled`.
  - The meter books a refused run failed with usage None, and an abort outranks the refusal.
  - The fixture guard passes on the real tree, with one negative control per pattern.
- **Acceptance:**
  - A recorded first turn calls get_vault_context with no ToolSearch hop.
  - A failed cerebro init ends the run with an error event, never a tool-less answer.
  - A pending status or an unknown word never ends a run.
  - The cerebro entry carries a 60000 ms timeout.
  - A refused run books failed with usage unknown.
  - The commit body records `num_turns` before and after.
- **Wave** 3 · **Depends** M54.1, .4; M53.10, .21, .24 · **Size** M (roadmap S) · **Crash risk** yes (process termination) · **Packaged check** yes
- **Commit:** `feat(agents): the read core loads early, and a run whose tools failed to load stops (M54.5)`.

### M54.6 Loopback hygiene: bounded pool, Host and Origin checks, protocol answers

- **What:**
  - One thread answers every run, so one slow call blocks four runs and one panic kills the server.
  - No Host or Origin check stops DNS rebinding.
  - Unknown methods answer −32000, `ping` is unknown, and `serverInfo` has no title. The Cargo.toml comment says the server has three methods.
  - The single thread was also the only thing keeping writes in order.
- **Files:** `src-tauri/src/mcp.rs`, `src-tauri/Cargo.toml`, `SECURITY.md`.
- **Approach:**
  - **`loopback_refusal`.** Host must be `127.0.0.1:<port>` or `localhost:<port>`: a missing Host gets 400, any other gets 403. An Origin, if sent, must be `http://` plus one of those; anything else gets 403, `null` and `tauri://localhost` included. rmcp 1.7's `validate_dns_rebinding_headers` is the guide; the code is our own.
  - **`serve_loopback`** runs `LOOPBACK_WORKERS` (2 × `MAX_CONCURRENT_RUNS`) threads. Each request goes through, in order:
    - the address check;
    - a size cap: over `MAX_BODY_BYTES` (16 MiB) gets 413;
    - the bearer, resolved when the request is dequeued;
    - dispatch inside `catch_unwind`, so a panic answers −32603 and the worker lives.

    A request with no valid bearer still gets −32001 at HTTP 200, never 401.
  - **`answer_protocol`:** `ping` returns `{}`, `initialize` gains `title: "Cerebro"`, an unknown method gets −32601, and a non-request body −32600. The dead `notifications/initialized` arm goes.
  - **Writes stay in single file.** A `WRITE_SERIAL` lock covers every tool the catalog doesn't mark read-only. It stays until M55.1 and M55.3 add per-path locks and hash checks. It guards `()`, so a lock poisoned by a panicking write is recovered with `unwrap_or_else(PoisonError::into_inner)`; otherwise every later write would panic or be refused until restart.
  - **Docs:** mcp.rs's Security paragraph, Cargo.toml's tiny_http comment, and SECURITY.md's loopback bullet. Transport refusals record nothing.
- **Comments to delete:** handle_rpc's notification note; Cargo.toml's "three JSON-RPC methods"; "a bearer token minted at startup", if M53.11 left it.
- **Tests:**
  - The allowed and refused address tables, and the protocol answers.
  - `four_concurrent_runs_each_finish_search_notes_inside_the_timeout`: a rendezvous proves the four calls overlap. A one-worker control must fail the same check.
  - Writes take turns and reads don't.
  - A panic leaves its worker serving, and an oversized body is refused unread.
  - `a_panic_inside_a_write_leaves_the_next_write_working`.
  - A foreign Origin never reaches the bearer check.
- **Acceptance:**
  - Four concurrent fake runs each finish `search_notes` inside the timeout.
  - A foreign Host or Origin gets 403 before the body is read.
  - `ping`, −32601, −32600 and the title answer as specified.
  - Writes never overlap. A panic keeps the pool at full size, and the next write still works.
  - Cargo.toml no longer says three methods.
- **Live check:**
  - A real attended turn calls a tool, which proves the CLI's Host header passes.
  - A panel turn, two scheduled agents and the distiller all finish while running together.
  - `curl` with a foreign Origin or Host gets 403.
- **Wave** 4 · **Depends** M54.1, .4, .5; M53.10, .11, .24 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** yes
- **Commit:** `fix(mcp): the loopback serves from a pool, answers only its own address, and speaks the protocol (M54.6)`.

### M54.7 Prompts match the grant

- **What:** every run gets the same prompt, whatever its grant.
  - Narrowed runs are told to use tools they lack.
  - Background runs are told to call open_note, which moves the person's screen.
  - `initialize` sends no instructions, so hand-off callees and internal runs never hear the vault's rules.
- **Files:** `shared/prompt/{README.md, server-instructions.md}` (new), `.prettierignore`, `src-tauri/fixtures/tool-grants.json` (new), `src-tauri/src/{mcp.rs, agent/mod.rs}`, `src/engine/{toolGrant.ts (new), toolGrant.test.ts (new), skills.ts, skills.test.ts, agents.ts}`, `src/agent/{systemPrompt.ts, systemPrompt.test.ts, promptGrant.test.ts (new), AiPanel.tsx, useAgentChat.ts, useAgentChat.test.tsx, useJobRunner.ts, useJobRunner.test.tsx}`, `src/lib/prompts{,.test}.ts`, `AGENTS.md`.
- **Approach:**
  - **Server instructions.** `shared/prompt/server-instructions.md` (Appendix C) holds the two rules that apply to every run, moved verbatim from `buildSystemPrompt` (Q4).
    - They name no tool and stay within the CLI's 2048-unit cap.
    - `initialize` serves them to every bearer. It takes no grant, so it cannot vary by grant.
    - They go here because instructions survive `--resume`. Text that depends on the grant stays in `--append-system-prompt`.
  - **`src/engine/toolGrant.ts`** is the TS half of Rust's `narrow` and .4's one name test (D3), held to them by `tool-grants.json`. It holds `grantedTools`, `holds` and `mentionedTools`. TS counts generated proposal tools as not held, since it can't read the proposal switch, so the fixture's expected sets exclude generated `propose_*` names. The fixture carries a case-variant row (`Get_Note`).
  - **Typed prompt fragments.** Each prompt line declares the tools it names.
    - A line that names a tool the run lacks is dropped or reworded (Appendix C).
    - The M9.5 sentence appears exactly when propose_organize is held. Otherwise a run that can edit notes hears "Do not edit captures directly." (Q5).
    - open_note is offered only to runs the person is watching.
    - A full grant, attended, reads as M53's tip minus the two moved lines, pinned as a golden. The fallback below, which keeps both lines, has its own golden.
  - **Wiring.** Panel and addressed turns build their grant from the narrowed tool list; a read scope turns the shell off. Jobs build theirs as unattended. A scheduled skill runs under its own `allowed-tools:` (Q3).
  - **AGENTS.md** puts `shared/prompt/` in the repo map and adds a CV bullet: a prompt names only the tools its run holds. Its pointers: `enforced: src/agent/promptGrant.test.ts, src-tauri/src/mcp.rs::the_server_instructions_name_no_tool`.
  - **Live check:** a panel turn quotes its server instructions, and a resumed turn still can. If the resumed turn can't, the two rules also stay in the TS prompt, and the fallback golden pins it.
- **Comments to delete:** prompts.ts's orphaned M13.4 docblock (memory is `recent`, asked only of runs that hold update_frontmatter); agents.ts's `memory:` sentence; the prompt comments in useJobRunner and useAgentChat.
- **Tests:**
  - `promptGrant.test.ts` tries every subset of the tools any prompt names, with every combination of attended, shell, connectors and capabilities, on every prompt builder. It fails if a prompt names a tool its run lacks.
  - Rust and TS both replay `tool-grants.json`, its case-variant row included; Rust drops generated proposal names before comparing.
  - The server instructions fit the cap, name no tool, and are the same for every bearer.
  - The M9.5 sentence is pinned, and no unattended run hears open_note.
  - The full-grant prompt equals its golden, M53's tip minus the two moved lines. The fallback branch has its own golden.
- **Acceptance:**
  - An exhaustive test shows that no narrowed run's prompt names a tool the run lacks.
  - The M9.5 sentence is unchanged and reaches exactly the runs that hold propose_organize.
  - Every bearer gets the same `instructions`.
  - No unattended run is told to call open_note.
  - TS and Rust agree on every grant case.
  - (Q3) Scheduled skills honour their own `allowed-tools:`.
- **Wave** 5 · **Depends** M54.1, .2, .4, .6; M53.5, .10, .19, .20 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** no (dev live check)
- **Commit:** `feat(agents): each prompt names only the tools its run holds (M54.7)`.

### M54.8 One current product brief

- **What:** the model is still taught the retired model: project.md folders, `<folder>/items/`, `collection.yml`, `*.list.yml`, "the Types screen" and "work items". get_vault_context lists `types/project.md` as a container and tells every run the knowledge bundle is "yours to maintain". Nothing stops the next drift.
- **Files:** `shared/prompt/{product-brief.md, retired-terms.json}` (new), `shared/prompt/{README.md, server-instructions.md}`, `shared/policy/{tools.v1.json, tools.v1.sha256}`, `src/lib/productBrief{,.test}.ts` (new), `src/agent/{systemPrompt.ts, systemPrompt.test.ts, mockAgent.ts}`, `src/App{,.test}.tsx`, `src-tauri/src/mcp.rs`, `AGENTS.md`.
- **Approach:**
  - **The brief.** `shared/prompt/product-brief.md` (Appendix C, about 1 KB) is the one current description. It names no tool, no retired term and not `knowledge/` (Q6). `retired-terms.json` lists the five retired terms.
  - **System prompt.** For every grant it opens with "You are the assistant inside cerebro." followed by the brief.
  - **get_vault_context:**
    - it lists Collections by their folder page, `<folder>/<folder>.md` with `type: Collection`, the same rule as `declared_by_page` and `isCollectionPage`;
    - it ends with "About this app:" and the brief;
    - read-scope filtering stays.
  - **Copy** (Appendix C):
    - get_vault_context's description, with a digest regen;
    - the mock reply, keeping its prefix and its single line;
    - the welcome card;
    - "Types screen" in the server instructions.
  - **AGENTS.md** gets a CV bullet: the brief is the only product description the model reads, and a retired term in any model-facing or welcome text fails the build. Its pointers: `enforced: src/lib/productBrief.test.ts, src-tauri/src/mcp.rs::get_vault_context_speaks_the_current_model`.
- **Comments to delete:** the five stale copy sites, and the read-scope test's `hidden/project.md` fixture.
- **Tests:**
  - `productBrief.test.ts`: the brief is at most 1500 chars and names no tool and no `knowledge/`. No retired term appears in the brief, the instructions, any prompt, the mock reply or the manifest.
  - mcp.rs: a temp vault lists its Collection, carries the brief, and has no retired term.
  - demo-vault lists exactly `delivery/delivery.md` and `strategy/strategy.md`.
  - The read-scope test moves to a real hidden Collection.
- **Acceptance:**
  - One brief is shared by systemPrompt and get_vault_context.
  - A test fails on any of the five retired terms.
  - `types/project.md` no longer shows as a container, and the "yours to maintain" line is gone.
  - A hidden Collection's title stays withheld from a read-scoped run.
- **Wave** 6 · **Depends** M54.1, .5, .7; M53.19 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** no
- **Commit:** `fix(agents): one product brief describes the app the model works in (M54.8)`.

### M54.9 Connectors become callable: granted by their CLI name, narrowed by the record, denials recorded by name

- **What:** runs are granted only cerebro tools and the CLI's own tools, so a connector's tool is denied in `-p`.
  - `connectors:` decides which servers load, but nothing grants their tools.
  - `allowed-tools:` can't name them.
  - Denials are only counted.

  So no connector can be made callable, or limited to its read-only tools.
- **Files:** `src-tauri/src/{connectors.rs, agent/mod.rs, agent/usage.rs, agent/meter.rs, runtime/dispatch.rs, mcp.rs, lib.rs, assembly/live.rs, ingest/spawn.rs, maintain/live.rs}`, `src-tauri/fixtures/{cli-stream/result-connector-denials.json, cli-names.json}` (new), `src/engine/{agents,connectors,libraryDraft}{,.test}.ts`, `src/agent/{agentIpc.ts, useAgentChat.ts, useAgentChat.test.tsx, useJobRunner.ts, useJobRunner.test.tsx}`, `src/app/ConnectorSettings{,.test}.tsx`, `src/stores/uiStore.ts`, `src/library/{AgentEditor.tsx, LibraryPage.test.tsx}`, `SECURITY.md`.
- **Approach:**
  - **Live check first,** on toy servers. If T1 fails, stop and re-plan.
    - T1: a server allow works in `-p`.
    - T2: without it, the call is denied by name.
    - T3: a tool deny beats a server allow.
    - T4: how the CLI spells odd server names.
    - T5: a tool-level allow works.
    - T6: `acceptEdits` approves no MCP tool.
    - T7: a comma or a space splits one entry in two.
    - T8: the user's own allow rules widen a tool-level allowlist, but a deny still wins.

    The two fixtures come from these toy-server runs, reduced per the fixture rule (Rules).
  - **Names.**
    - `cli_name` matches the CLI's spelling, and T4's fixture rules.
    - `grantable` refuses names that are empty, over 40 chars, contain `__`, start or end with `_`, or spell `cerebro` in any case.
    - Two names the CLI would hear alike are both dropped.
    - (Q7) An http entry needs a per-machine approval, as stdio entries already do.
    - A record that names connectors never inherits the user's global config.
  - **Grant.**
    - Each enabled, approved server is allowed as `mcp__<cli name>`.
    - `run_connectors` lets a record narrow by server or by tool, and deny tools with the new `disallowed-tools:`, which binds connector tools only.
    - A tool part must match `^[A-Za-z0-9_-]{1,64}$` or is ignored, so nothing unvalidated reaches argv.
    - Servers the record never names leave the run's config.
    - (Q8) Fail closed. An unattended run gets `mcp__` grants only from a record that names `connectors:`, and absent `attended` reads as unattended. Attended turns keep M18.4's meaning: every enabled, approved server. Internal runs get no connector.
  - **Denials by name.** Each run writes one `agent.permission` row, with its run_id, naming up to 20 denied tools. No new column.
  - **TS.**
    - `disallowed-tools` parses and rides `runAgent`.
    - Settings shows an unapproved http entry with Approve.
    - The agent editor offers "Every <name> tool", warns that connector tools can change things outside the vault, and shows a read-only "Never calls:" line.
  - **Security.** SECURITY.md describes the grant. Before merge, run the `security-review` skill on the diff and answer in the commit body:
    - every argv input and its gate, and argv injection;
    - name aliasing;
    - unattended runs, naming the case of an unattended record with no `connectors:` (Q8);
    - exfiltration, prompt injection and hand-offs;
    - secrets.

    Fix every finding, or record the owner's written sign-off.
- **Comments to delete:** the docs saying only the shell is left to decide; "two boundaries"; "fall back to their global MCP config"; the approval docs that mention stdio only; "read from the outside world"; `route_denials`' count-only doc; the M18.4 note that an absent `connector_names` leaves the run with everything enabled, now true of attended runs only.
- **Tests:**
  - connectors.rs: the CLI-name fixture, alias and collision refusals, and http approval and its invalidation.
  - agent/mod.rs:
    - a connector is granted by its CLI name, and a record can narrow it by tool;
    - an unattended record with no `connectors:` is granted no `mcp__` entry, with `attended` false or absent;
    - an unnamed server isn't loaded;
    - no entry can smuggle a second one (`mcp__gmail__a,Bash`);
    - a run carries one disallowed flag at most;
    - a run without connectors gets byte-identical argv;
    - neither internal runs nor the cerebro server are granted as connectors.
  - usage, meter and dispatch: denials are named, sorted, and carry the run_id.
  - TS: parsing, the approval UI and the editor's options.
- **Acceptance:**
  - An enabled connector's tool works in `-p`. A narrowed-out one is refused and recorded by name.
  - Records only subtract.
  - (Q8) An unattended record with no `connectors:` is granted no connector tool.
  - Aliasing or colliding names never merge, and legacy mode grants no connector.
  - (Q7) Unapproved http entries stay off.
  - A run with no connectors gets byte-identical argv.
  - The security review is recorded.
- **Live check,** with the owner's connectors:
  - O1: an OAuth connector before sign-in.
  - O2: after `claude mcp add` and `/mcp`, a strict run reuses the token.
  - O3: a `disallowed-tools` entry is refused and named in `operational_log`, under `surface = 'agent.permission'`.
  - O4: whether claude.ai connectors load under `--strict-mcp-config`.
  - O5: token reuse when the entry has headers.
- **Wave** 7 · **Depends** M54.1, .5; M53.5, .10, .11 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(agents): connectors are granted by the name the CLI hears, narrowed by the record (M54.9)`. The body carries T1–T8 and the security review.

### M54.10 Grant refusals are typed and recorded per run, on every axis at once

- **What:**
  - Write, tool and read refusals return a plain error and record nothing.
  - M53.4's corpus doors refuse with no code.
  - policy.v3 has no code for a grant refusal.
- **Files:** `shared/policy/{policy.v3.json, policy.v3.sha256, README.md}`, `src-tauri/src/{mcp.rs, vault/write.rs, policy/table.rs, runtime/operational.rs}`, `src/lib/policy/table.test.ts`.
- **Approach:**
  - **policy.v3** gains four operational transport codes: `read_outside_scope`, `target_outside_corpus`, `tool_outside_grant` and `write_outside_scope`.
    - `artifact_version` goes from 7 to 8. Regenerate with `cd src-tauri && cargo test --lib policy::table::tests::write_policy_digest -- --ignored`. v1 and v2 stay untouched.
    - The README says why: these codes fail at the door before any proposal exists, they bound one run rather than claim anything, and `Rejection::new` keeps them out of the ledger.
  - **write.rs** splits `note_target_refusal` out of `note_join`, with the same message, and adds `planned_note_path` for create_note.
  - **call_tool** checks the grant (write, tool, read), then preferences, then the corpus, then runs the body.
    - Each refusal records one operational row per run, code, tool and target, carrying the run_id.
    - Bundle paths keep their own guard first.
    - Messages stay byte-identical. Refused calls still count and announce nothing.
- **Comments to delete:** call_tool's M31.1b note that a refusal deliberately writes no operational_log row; operational.rs's `policy.v1.json` reference and its "what lands here" list.
- **Tests:**
  - A read-scope refusal writes one row with its run_id, and a repeat adds none.
  - Every axis records its own code, with `.git/config`, `.cerebro/connectors.json` and `.git/hooks` among the targets and the bytes unchanged.
  - Messages are byte-identical, and the bundle guard still speaks first.
  - With no sink armed, the call is still refused.
  - The dispatch check replays `note-targets.json`.
  - Rust and TS both find the four codes declared as operational transport codes.
- **Acceptance:**
  - A read-scope refusal writes one operational row carrying its run_id.
  - All four axes record in this one commit, each under its own code.
  - Refusal messages are unchanged.
  - The codes go through the README's regeneration steps.
  - A repeated refusal writes one row.
- **Wave** 8 · **Depends** M54.1, .4; M53.4, .10 · **Size** S · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(mcp): grant refusals are typed and recorded against their run (M54.10)`.

### M54.11 Connector status with the fix: observed per vault, shown in Settings, missing connectors named in the prompt

- **What:** init's server statuses are dropped and denials are only counted, so a connector that needs sign-in fails silently.
  - No table holds connector status, and Settings shows none.
  - A connector an agent asked for, but the vault lacks, vanishes without a word.
- **Files:** `src-tauri/src/{runtime/schema.rs, runtime/mod.rs, runtime/connector_status.rs (new), agent/connector_signals.rs (new), agent/mod.rs, agent/meter.rs, connectors.rs, lib.rs}`, `src-tauri/fixtures/cli-stream/{init-connectors,connector-run}.json` (new), `src/engine/{connectors,connectors.test,agents}.ts`, `src/agent/agentIpc.ts`, `src/lib/{ipc,mockIpc,mockIpc.test}.ts`, `src/app/ConnectorSettings{,.test}.tsx`, `e2e/connectors.spec.ts` (new).
- **Approach:**
  - **Live check first.** Use toy servers that report needs-auth, failed and pending at init, plus a success, an error and a denial. Then use the owner's connectors: O1 and O2, O6 (do remote servers mostly report pending?) and O7 (do `authenticate` calls or `mcp_server_errors` appear in `-p`?). Only recorded signals get built. The fixtures replay the toy servers only, reduced per the fixture rule; the owner's runs go in the commit body as findings, never as fixtures.
  - **Schema v19:** `connector_status`, one row per vault and connector, with:
    - the state: working, needs_sign_in, failed or not_approved;
    - the signal that set it: init, tool_result, tool_errors, permission_denial, authenticate or server_error;
    - when it was seen, and by which run.

    No row means not observed yet. A newer observation wins, and no credential is stored.
  - **`agent/connector_signals.rs`** (pure) reads each run's stream. It gives at most one observation per connector, the first rule that matches:
    - a successful call → working;
    - needs-auth → needs sign-in;
    - failed, or every call errored with no denial → failed;
    - a denial inside the grant → not approved;
    - connected → working;
    - pending or silence → nothing.

    The meter records the observation after the run, and a failed write never fails the run.
  - **Missing connectors**, computed in Rust. Each connector an agent asked for but didn't get has a reason, and one paragraph (Appendix C) joins the run's prompt. With nothing missing, argv stays byte-identical.
  - **Command and data.** `connector_status(vault)` serves every listed connector with its refusal reason and last state. TS adds `signInCommand`, which builds `claude mcp add --transport http <name> <url>` plus the entry's headers, and the mock gains seeded rows.
  - **Settings** reads status on mount and whenever the window regains focus.
    - Each row shows `<name> — <state>` and when it was seen.
    - Needs sign-in shows the command with a Copy button.
    - A failed read shows `section-unavailable`.
    - The page never says "nothing connected", and never "registered".
- **Comments to update:** the "dropped rather than conjured" docs now add that the prompt names the dropped connector; `USER_VERSION`'s doc gains v19; ConnectorSettings' header.
- **Tests:**
  - v19 migrates from every prior version. A newer observation wins in any order, and rows are kept per vault.
  - The signal rules hold over the recorded fixture.
  - Every missing-connector reason; a hostile name is quoted and cut; argv stays byte-identical.
  - `signInCommand` quotes correctly.
  - ConnectorSettings: each state, Copy, a refetch on focus, `section-unavailable`.
  - `e2e/connectors.spec.ts` with a seeded Gmail row.
- **Acceptance:**
  - Settings shows "Gmail — needs sign-in" with the fix to copy, never "nothing connected" (Q9).
  - Status comes from init, denials, successes and grouped errors, with when and which run.
  - A failed read never says "not observed yet".
  - Missing connectors are named in the prompt with reasons, computed in Rust.
  - v19 keeps every existing row, and R14's copy is unchanged.
- **Live check:** a real connector reads needs sign-in, then working after the copied command and `/mcp`.
- **Wave** 8 · **Depends** M54.5, .7, .9 · **Size** L · **Crash risk** yes (schema step) · **Packaged check** yes
- **Commit:** `feat(connectors): last-seen connector status with the fix, and missing connectors named in the prompt (M54.11)`.

## Done or dropped

- **Done:** none. **Dropped:** none.
- **Moved:** the `base_tools` doc comment, which the roadmap gave to .2, dies in .1 along with the code it describes.
- **Beyond the roadmap, on purpose:**
  - .3 also flags M53.2's uncalled root-git reads, and deletes `stopAllAgents`.
  - .5 also loads the two held tools early.
  - .7 fixes scheduled skills' `allowed-tools:` (Q3).
  - .9 adds per-machine approval for http connectors (Q7).
- **Not built unless measured:**
  - server-level alwaysLoad (.5);
  - `authenticate` and server-error signals (.11);
  - GET → 405 (.6). How the CLI probes for SSE is unmeasured, so it belongs on the client port in MCP-5.

## Owner questions

Each default applies if unanswered.

| # | Part | Question | Default |
| --- | --- | --- | --- |
| Q1 | M54.3 | `ambient_ingest_enabled` and `set_ambient_ingest` have no caller, so nothing can turn on ambient ingest's spending. Keep, wire a toggle later, or delete? | Keep, flagged in `UNCALLED`. |
| Q2 | M54.3 | After M53.2, three root-git reads have adapters but no caller. Keep, wire into Work later, or delete with their mocks? | Keep, flagged. |
| Q3 | M54.7 | Scheduled skills ignore their own `allowed-tools:`. Fix it while building the job's grant? | Yes. |
| Q4 | M54.7 | The note-link and schema rules move into the server instructions, so they also reach hand-off callees, internal runs and the two editor runs. OK? | Yes. |
| Q5 | M54.7 | A run without propose_organize that can still edit notes hears only "Do not edit captures directly." OK? | Yes. |
| Q6 | M54.8 | The brief leaves out the knowledge bundle (M34.1.3). Only the runs that declare `knowledge` hear about it. OK? | Yes. |
| Q7 | M54.9 | Must a person approve each http connector's name, URL and headers on this machine before it is callable, as stdio entries already require? | Yes. Settings approves what it adds; each existing http entry needs one Approve after the upgrade. |
| Q8 | M54.9 | Should a scheduled agent whose record names no `connectors:` reach every approved, enabled connector? | No. Fail closed: an unattended run gets connector tools only when its record names `connectors:`, so a missing field never widens access. Attended turns keep M18.4's meaning. |
| Q9 | M54.11 | If claude.ai connectors don't load under `--strict-mcp-config`, does an http Gmail entry, signed in with `/mcp`, meet the acceptance? | Yes. claude.ai connectors wait for D4 (b). |

## Risks

- **CLI behaviour, pinned at 2.1.250:** the `_meta` keys, the per-server `timeout`, `discoveryCache`, init status words, instructions across `--resume`, and server-name mangling. Each is recorded first and replayed from fixtures that name the CLI version. A wrong `_meta` key is ignored, and an unknown status word never kills a run.
- **Parallel reads.**
  - From .1, the read-only hint lets the CLI run reads in parallel. Until .6 the loopback is one thread, so they queue.
  - After .6, a read that spans several files can see a half-landed write; each file stays whole.
  - Writes stay one at a time until M55.1 and M55.3.
- **Connector grants widen what agents can call** (.9). Defences:
  - per-machine approval (Q7);
  - records can only subtract;
  - an unattended run must name its connectors (Q8);
  - names that alias cerebro are refused;
  - legacy mode grants none;
  - the security review runs before merge.

  The user's own Claude Code allow rules can widen a tool-level allowlist (T8). Only a deny binds against them, and SECURITY.md says so.
- **Crash wedge:** .5 changes process termination and .11 adds a schema step. Mac cargo keeps the skip list, and CI's Linux job runs the full crash suite.
- **Hot files** (the waves serialize them):

  | File | Parts |
  | --- | --- |
  | mcp.rs | .1, .4, .6–.10 |
  | agent/mod.rs | .1, .4, .5, .7, .9, .11 |
  | AGENTS.md | .2, .3, .7, .8 |
  | `shared/policy/README.md` | .1, .2, .5, .10 |
  | `tools.v1.json` | .1, .5, .8 |
  | lib.rs, agentIpc.ts | .3, .9, .11 |
  | meter.rs | .5, .9, .11 |
  | useAgentChat.ts | .2, .7, .9 |
- **Two loaders** (.1 in Rust, .2 in TS) share one refusal list, one case file and one digest.
- **.3 is a text scan.** Shapes it can't parse fail loudly, and payloads passed as variables stay unchecked.
- **Live checks spend the owner's tokens** (.5, .7, .9, .11). .9 and .11 also need the owner's own connectors.
- **Changes the owner will see:**
  - proposal and commit turns checkpoint, MultiEdit gets write cards, and the wrench icons go (.2);
  - narrowed runs list fewer tools (.4);
  - a failed cerebro init stops the run, booked failed with usage unknown, which pauses ambient work until the budget window resets (.5);
  - narrowed and background runs get shorter prompts, and scheduled skills honour `allowed-tools:` (.7);
  - get_vault_context shows Collections and the brief, and the welcome copy changes (.8);
  - each http connector needs one Approve; attended turns, and unattended agents that name `connectors:`, can call connector tools (.9);
  - Settings shows connector status (.11).
- **Left open on purpose:**
  - write tools stay listed to a record with `scope: []` (.4);
  - tiny_http stops accepting after one accept error (.6); .5's init check makes the failure visible;
  - the prompt's connector line follows the Settings switch, not the run's grant (.7);
  - manifest descriptions still mention other tools by name;
  - the `recent` memory line (D7, M56);
  - refusal dedupe lives in memory, and there is no `operational_log(run_id)` index until M56 (.10);
  - `mcp__gmail` and `mcp__gmail__x` narrow to nothing, failing closed (.9);
  - servers that load only from the user's global config (legacy mode) are neither observed nor shown (.11).

## Gate

- **Each part**, before its commit:
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test:run`;
  - Rust parts add `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the skip-listed `cargo test`;
  - .2 adds `PORT=<free> pnpm e2e e2e/agent.spec.ts` and .11 adds `e2e/connectors.spec.ts`, each once `lsof -iTCP:<port> -sTCP:LISTEN` shows the port free.
- **Each wave tip:** the same gate on the branch, with the full e2e suite.
- **M54 closes when:**
  - the full gate passes on the tip, with every coverage floor held or raised;
  - CI is green on the push, the Linux crash suite included;
  - every roadmap M54 acceptance bullet holds;
  - the owner has run the live checks (.1, .4, .5, .6, .7, .9, .11) on CLI 2.1.250 and looked at the built app;
  - .9's security review is in its commit body;
  - the roadmap's M54 status is updated.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

## Appendix A — the manifest rows (M54.1's acceptance)

**Top-level keys, in order:** `format` 1, `artifact_version` 1, `rule_version` `tools/<commit date>`, `server` `cerebro`, `tokens`, `doors`, `toolsets`, `prefix_exceptions`, `tools`, `generated`, `cli_tools`.

**Row fields, in order:**

- `name` and `surface` (base or proposals);
- `title`, served as `annotations.title`;
- `summary`, the tools.ts picker line, verbatim;
- `toolset`; null means never offered in a picker;
- `kind` and `idempotent`; `open_world` is always false;
- `door`, `axis` and `target`;
- `exempt`, set exactly when the axis is none. The reasons move verbatim from today's scope tripwire;
- `renderer` and `icon`;
- `always_load`, false on every row until .5 turns on six;
- `search_hint`, at most 80 chars;
- `description` and `input_schema`, moved byte for byte from M53's tip.

**Token:** `concept_types`, rendered from `concept-types.v1.json` by `knowledge::concept_type_menu`. write_concept's type description reads: "OKF concept type. Pick the closest of: {{concept_types}}. Use the vault's own type name instead when one fits better."

**Doors:**

| Door | Writes | Kinds | Axes |
| --- | --- | --- | --- |
| none | no | read_only | read |
| note | yes | additive, destructive | write |
| concept | yes | destructive | none |
| source | yes | additive, destructive | none |
| ledger | yes | additive, destructive | none |
| ui | no | additive | none |
| run | no | additive | none |
| memory | no | additive | none |

**Toolsets:** read, write, knowledge, propose, agents, ui and proposals. Ids, labels and hints are copied verbatim from tools.ts (`TOOLSETS`, `PROPOSAL_TOOLSET`).

**Rows**, in `base_tools`' served order, with `commit_proposals` last (its surface is proposals). The Target column reads argument → kind.

| Tool | Set | Kind | Idem. | Door | Axis | Target | Renderer | Icon | Title | Search hint |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| get_vault_context | read | read_only | yes | none | read | — | step | compass | Get vault context | vault overview types counts inbox |
| search_notes | read | read_only | yes | none | read | — | step | search | Search notes | find notes by text |
| get_note | read | read_only | yes | none | read | path → note | step | file-text | Read a note | read one note in full |
| knowledge_about | read | read_only | yes | none | read | — → bundle | step | library | Read what Knowledge holds | what knowledge says about an entity |
| report_window_outcome | — | additive | yes¹ | memory | none | — | step | flag | Report window outcome | report an ingest window verdict |
| submit_answer | — | additive | yes¹ | memory | none | — | step | send | Submit the answer | submit a synthesis answer |
| list_inbox | read | read_only | yes | none | read | — | step | inbox | List Inbox captures | inbox captures waiting to be filed |
| hand_to | agents | additive | no | run | none | — | step | forward | Hand work to an agent | start another agent with a task |
| create_note | write | additive | no | note | write | folder → folder | change | file-plus | Create a note | create a new note |
| update_frontmatter | write | destructive | yes | note | write | path → note | change | list | Update note properties | set or remove note properties |
| append_to_note | write | additive | no | note | write | path → note | change | file-pen | Append to a note | add text to the end of a note |
| write_concept | knowledge | destructive | no | concept | none | path → concept | change | brain | Write a concept | record a knowledge concept |
| recheck_concept | knowledge | destructive | no | concept | none | path → concept | change | calendar-check | Recheck a concept | mark a concept still true |
| cache_source | knowledge | destructive | no | source | none | id → source_id | change | download | Cache a fetched source | save fetched external material |
| propose_organize² | propose | additive | no | ui | none | path → note | step | wand-sparkles | Propose a filing | suggest how to file a capture |
| open_note | ui | additive | yes | ui | none | path → note | step | eye | Open a note | show a note to the user |
| navigate | ui | additive | yes | ui | none | — | step | compass | Move the app | move the app to a surface |
| commit_proposals³ | proposals | destructive | no | ledger | none | — | step | check-check | Commit proposals | apply this run's proposals |

¹ A repeat call is refused. ² Description and schema stay byte-identical (M9.5). ³ Exempt from the folder checks because it decides this run's own proposals through the policy table, not by path. Its description and schema move over from `proposal_tools()`.

**Generated tools** (`propose_<op>`). Names, descriptions and schemas stay generated from policy.v3:

- prefix `propose_`, title `Propose` plus the op in words, toolset proposals;
- additive, not idempotent;
- door ledger, axis none;
- exempt from the folder checks, because proposals write through the ledger and the policy table governs them per op and per risk;
- renderer step, icon `git-pull-request-arrow`, search hint "propose a knowledge change".

**Prefix exceptions:** only `propose_organize`. It predates the generated tools (M9.5), and `proposal_op_of` checks the policy table, so it never reaches the proposal path.

**CLI built-ins**, in argv order. Internal runs are denied every one.

| Tool | Writes | Denied without shell | Denied when read-scoped | With shell | Renderer | Icon |
| --- | --- | --- | --- | --- | --- | --- |
| Write | yes | yes | no | yes | change | pencil |
| Edit | yes | yes | no | yes | change | file-pen |
| MultiEdit | yes | yes | no | no | change | file-pen |
| NotebookEdit | yes | yes | no | no | change | notebook-pen |
| Bash | no | yes | no | yes | step | terminal |
| Read | no | no | yes | yes | step | file-text |
| Glob | no | no | yes | yes | step | folder-open |
| Grep | no | no | yes | yes | step | search |
| WebFetch | no | no | no | no | step | globe |
| WebSearch | no | no | no | no | step | globe |
| Task | no | no | no | no | step | bot |

## Appendix B — what the loaders refuse (Rust in M54.1, TS in M54.2)

Each refusal names the row and the field, and each has one negative control in each language.

- **Manifest:**
  - a `format` other than 1, an `artifact_version` of 0, an empty `rule_version` or a bad `server`;
  - a duplicate door, toolset, row or CLI name;
  - a door that writes yet allows `read_only`;
  - a toolset no row uses.
- **Row:**
  - a name outside `[a-z][a-z_]*`, or a full `mcp__<server>__<name>` over 64 chars;
  - an empty title, or one over 64 chars;
  - a summary of 10 chars or fewer, or one equal to the name;
  - an undeclared toolset;
  - a kind or axis the door doesn't allow;
  - a read_only row that isn't idempotent.
- **Target:**
  - axis write without a note or folder argument;
  - axis read with a target other than note or bundle;
  - a target argument missing from the schema's properties or `required`;
  - bundle with an argument, or any other kind without one;
  - `exempt` missing on axis none, or present on any other axis.
- **Content:**
  - renderer change on a door that writes nothing, or on a row with no target;
  - an icon name that isn't kebab-case;
  - an empty search hint, or one over 80 chars;
  - a description outside 21–2048 chars;
  - a schema whose root isn't an object type with properties, or whose `required` names a missing property;
  - an unknown or unused `{{token}}`;
  - a hand-written `propose_` name that `prefix_exceptions` doesn't list, or an exception that names no row.
- **CLI:**
  - a name outside `[A-Z][A-Za-z]*`;
  - a with-shell row that neither shell mode nor read scope withdraws;
  - a row denied both without shell and when read-scoped;
  - a writing row that isn't denied without shell;
  - renderer change on a row that writes nothing.

## Appendix C — text the model or the owner reads

These are the exact strings. Review them before each part lands.

**M54.5, the init refusal:**

> Cerebro's tools did not load for this run (Claude Code reported them as <word>), so the run was stopped before it could answer without them. Try again; if it repeats, restart Cerebro.

**M54.7, `shared/prompt/server-instructions.md`.** In M54.8 the parenthetical becomes "(a database's own page and the adoption wizard are the human path)".

```md
How to work in this cerebro vault. These hold on every run, whatever tools it was granted.

- When you mention a note, write it as [[note-name]] so it is clickable.
- Never create or modify `type: Type` docs on your own — schema is the user's to change. When a vault clearly needs a new type or field, describe the change and why, and let them make it (the Types screen and the adoption wizard are the human path).
```

**M54.7, narrowed prompts:**

- The M9.5 sentence, unchanged: "To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly." A run without propose_organize that can still edit notes hears only its last sentence (Q5).
- The tools line keeps only the clauses whose tools the run holds, joined as "a", "a and b" or "a, b, and c".
- Every other clause that names a missing tool is dropped or reworded. With every tool held, the text is M53's tip minus the two moved lines (the full-grant golden).
- New wording, in `agentReadScopeLines`, for a read-scoped run with no note reader: ". Work from what this message hands you."
- No addressed-turn wording. Finished M53.5 deletes today's interim "read it with get_note…" request: the addressed turn gets its record body in the system prompt through `readNote`, and a failed read spawns nothing. So after M53, `agentReadScopeLines` is the only grant-dependent read text, and any narrowed wording is re-derived from the post-M53.5 `addressedAgentPrompt`.

**M54.8, `shared/prompt/product-brief.md`:**

```md
cerebro is the user's local, files-first markdown workspace. The vault is a folder on disk and its files are the truth: each note is a markdown file, optionally with YAML frontmatter, and the app shows it as a page.

- A note with `type: <Name>` is a record in the <Name> database. The database's schema is its `type: Type` doc (`fields:`, `statuses:`, `folder:`, `views:`), and the database opens as a page with those views. New records go to the Type's `folder:`, else `records/<plural>/`. A record opens in the side panel or as a full page.
- A note with no type is a doc. Docs and records can sit anywhere in the folder tree.
- A Collection is a folder whose own note (`<folder>/<folder>.md`) has `type: Collection`. That page holds what the folder holds.
- The Inbox holds captures: untyped notes waiting to be filed.
- An agent is a record with `type: Agent`. Its body is its standing instructions, and it runs on its schedule or its triggers. A skill is a record with `type: Skill`, run by typing /name.
- A frontmatter field whose values are [[wikilinks]] is a relation between pages.
```

**M54.8, other copy:**

- get_vault_context's description: "Orient yourself: what this app is, the vault's types and collections, note counts, and how many captures are waiting in the Inbox. Call this first."
- The mock reply: "This vault tracks work as typed markdown: every note is a page, typed notes are records in their databases, and a knowledge bundle I maintain waits for you to verify. Ask me to find something, file an Inbox capture, or write up what I have learned."
- The welcome card: "A vault is a folder of markdown files — pages, databases and their records live there as plain text."

**M54.9, the UI:**

- The agent editor: "Every <name> tool", "Never calls: …" and "Connector tools can change things outside your vault."
- Settings: "not approved on this machine".

**M54.11, missing connectors**, appended to the run's prompt (the names are examples):

> Connectors your instructions rely on that this run does not have: "linear" (not in this vault's connector list); "gmail" (not approved on this machine). Their tools are not available. If the work needs one, say which connector is missing and why; never guess what it would have returned.

**M54.11, Settings:**

- States: working, needs sign-in, failed, not approved, not observed yet. While loading: "Reading status…".
- The sign-in hint: "Then run claude, type /mcp, and sign in to <name>. The sign-in stays in Claude Code; Cerebro never holds the token."
