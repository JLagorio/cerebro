# M53 — Safe core and rails

**Goal.** Close the holes that let an agent leave its grant, lose data or burn budget; re-land M32; put lint and parity rails under everything after.

The owner, 2026-10-13: "okay lets crank all of this out on m53." Branch `m53-macro-port`. Roadmap: `2026-10-12-macro-port-roadmap.md`, § M53.

## Status

- **Done.** Committed on `m53-macro-port`; CI green, including the full crash suite on Linux:
  - M53.4 (0c1e199): note writers refuse dot-paths, non-notes, `views/` and `attachments/`.
  - M53.7 + M53.8 (6ee7ecc): event runs keep their own ledger slot; a vault switch starts a fresh baseline.
  - M53.9 (fc510e6), the AI-block half only: the block saves as a `:::ai` directive, inside the unmount flush too. The `/` menu half is M53.31.
- **Precondition met:** M49–M52 merged to main (PR #21).
- **How the rest was built.** The owner, 2026-10-12: "just build all of M53 so I can verify when youre done … keep it all unstaged." Every other part is an unstaged edit in the main checkout on `m53-macro-port`. Nothing was stashed, cherry-picked or committed, and no part touched the index (the owner staged files of their own meanwhile). The owner reviews and commits; each part's proposed commit message is in the build report.
- **Parts:** 21 from the roadmap, counting M53.9's `/` menu half (M53.31), plus 7 follow-ups: M53.25–.30, found while building .4/.7/.9, and M53.32, three rail gaps the plan critic found. None dropped.
- **Effort:** 19 S + 9 M ≈ 9.5 L. The roadmap put all of M53 at ≈6.5 L. Re-measured S → M: .2, .6, .12, .22, .24. New M: .28, .29.

## Decisions

- **Owner defaults, applied, pending confirmation:**
  - Branch pushes keep CI → M53.1.
  - Dotfile notes are hidden from the scan, Obsidian-style → M53.25.
  - The `.mmd` exemption under `views/whiteboards/` stays → no part.
  - A trigger-only agent's clock ticks → M53.26.
- **Rules:**
  - One part, one commit: `type(scope): sentence (M53.n)`. It deletes the comments it falsifies. Only .5 lands twice: argv in wave 1, the addressed turn in wave 9.
  - Parts in a wave share no file. A wave starts once the previous wave's gate is green.
  - The parts of a wave build in parallel in the main checkout, each confined to its declared files: no worktrees and no cherry-picks. .1 and .2 re-landed their M32 commits as working-tree patches (`git diff <a>^ <b> -- <paths> | git apply`), never through the index. Each part is reviewed for correctness and conventions (security too where it widens reach), repaired and rechecked; then the full gate runs on the shared tree, e2e on a free port.
  - Line numbers are at fc510e6. Earlier waves move them, so anchor edits by text.
  - Every Mac cargo run carries the pre-push crash skip list. CI's Linux job runs the full crash suite; it first meets the crash-risk parts when the owner pushes.
  - No new refusal code. M53.29 reuses `schema_invalid`; root-git refusals stay UI values (the `MountRefusal` precedent).
  - No new twin rule. Shared cases are data: `links.v1.json` (.12), `source-slugs.json` (.17), the scan golden (.22), `bundle-paths.json` (.28), `projection-claims.json` (.29).
- **Contracts between parts.** Whichever part lands second does the work:
  - `/usr/bin/open` (.12) starts through `spawn::command` (.10). A raw call fails .21's clippy ban.
  - The webview convention bullet (.12) takes the next free CV id and an `enforced:` line once .19 exists. The Dev skills rule (.23) takes the id after it.
  - CV-09 points at `src/lib/scanGolden.test.ts` (.22). A part that adds an enforcer moves its CV off `prose` in the same commit: .20 → CV-14, .21 → CV-10.
  - lib.rs keeps one `.setup()`, .12's window builder. .24 arms its log on `RunEvent::Ready`.
  - After .20, Tauri calls live only in the four IPC adapters, so .24's `logFrontend` goes in `lib/ipc.ts`. The engine allowlist skips engine tests (.28's `okf.test.ts` imports a fixture). `@/lib/sha256` is on it already (`connectors.ts`, `jobs.ts`), so .17's import needs nothing.
  - .6 announces `cache_source` as a rescan with no paths, so .17's new paths need no event change.

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M53.5 (argv), M53.6, M53.12, M53.14, M53.15, M53.16, M53.18 | read scope · agent writes on the open page · links · thread anchors · history reads · create-on-day · organize card |
| 2 | M53.1, M53.13, M53.17, M53.22, M53.26, M53.29 | CI re-land · hidden windows · source slugs · scan golden · trigger clock · belief claims |
| 3 | M53.2, M53.3, M53.27, M53.30 | roots git · toolchain · deferred runs · edits during a vault open |
| 4 | M53.10, M53.19 | spawn helper and run lifecycle · convention ids |
| 5 | M53.11, M53.20 | token hygiene · lint rails |
| 6 | M53.21, M53.25 | Rust rails · dotfiles |
| 7 | M53.23, M53.28 | dev skills · bundle folding |
| 8 | M53.24 | diagnostics |
| 9 | M53.31, M53.5 (addressed turn), M53.32 | `/` menu · addressed turns · rail follow-ups |

This is the order the parts were built. .13 went early, so its "before" timing comes from the app installed before M53, not from a wave build.

## Parts

### M53.1 Re-land M32.1–M32.7: CI hardening, branch pushes keeping their gates

- **What:** none of 478afd3..2f229bb reached main, because PR #15 merged into `m31-claims-and-records`. The rulesets already run on GitHub (protect-main, protect-release-tags), and `.github/SETUP.md` becomes their record in the repo.
- **Files:** `.github/{workflows/mac-app.yml, workflows/scanners.yml, workflows/cargo-deny.yml, dependabot.yml, SETUP.md, ISSUE_TEMPLATE/bug.yml}`, `deny.toml`, `src-tauri/Cargo.toml`, `.gitignore`, `AGENTS.md`, `playwright.config.ts`, the M32 plan doc, `scripts/workflows.test.ts` (new).
- **Approach:**
  - Cherry-pick 478afd3 8525dce 4b997a9 0170607 6df51b1 312a7b6 dab2fff 2f229bb, then squash. The body lists the eight SHAs and the trigger change. Seven apply clean (simulated at fc510e6).
  - 2f229bb conflicts in two files. `.gitignore` keeps both blocks. AGENTS.md keeps HEAD's machine-load paragraph, drops "Check the e2e port is FREE" and keeps M32.7's "Reuse is opt-in".
  - Triggers (owner default): push on `'**'` and `v*` tags, plus `workflow_dispatch`, and no `pull_request`. PR #21 merged on a push run under the strict ruleset, so push runs satisfy the required checks.
  - `build` holds contents, id-token and attestations write, so it runs only on main, `v*` tags and dispatch; the header says so. The rest stays as built: read-only default token, no `pull_request_target`, `persist-credentials: false`, 10 SHA pins, zizmor ignores with causes, tag-only attestation.
  - SETUP.md: the fork-approval gate now covers only scanners and cargo-deny. Re-run each ticked box's command. The M32 plan doc gains "Re-landed (M53.1, M53.2)" and marks M32.1's premise ("required checks need PR-attached runs") refuted.
- **Tests:** `scripts/workflows.test.ts`: every non-local `uses:` is `owner/repo@<40-hex>`; no `pull_request_target`; top-level `permissions: {contents: read}`; every checkout sets `persist-credentials: false`; `quality` and `e2e` exist; `on.push.branches` has `'**'`; `build.if` names main, `v*` and dispatch. CI: a branch push runs quality and e2e and skips build; `gh workflow run mac-app.yml --ref <branch>` builds; the PR's scanners and cargo-deny pass. The full e2e suite passes on a free port, and a plain `pnpm e2e` with 5173 held and `CEREBRO_E2E_REUSE` unset fails loudly.
- **Acceptance:** CI runs the M32 lanes: SHA-pinned actions, zizmor, actionlint, advisory cargo-deny (roadmap). Only `build` gets write scopes. `quality` and `e2e` keep their ruleset names and run on every branch push. AGENTS.md has no port-FREE paragraph, and reuse needs `CEREBRO_E2E_REUSE=1`. `.env` and `.env.*` are ignored. Once this is on main, CodeQL alerts #1 and #2 close.
- **Wave** 2 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.2 Re-land M32.8–M32.12: mounted-repo git, protocol pins, trust model

- **What:** none of 490b38a..777615c is on HEAD, and no root-git symbol exists. Re-land it, plus the fixes the re-land exposes.
- **Files:** `src-tauri/src/{lib.rs, roots/mod.rs, roots_git_commands.rs, app_config.rs, git/{command,credentials,upstream,remote,mod}.rs, vault/write.rs, mcp.rs}`, `src/engine/roots.ts`, `src/lib/{mockRoots,rootsIpc}.ts`, `src/stores/rootsStore.ts`, `src/workspace/RootTree.tsx` (+ tests), `e2e/workspace.spec.ts`, `SECURITY.md`, `.github/SETUP.md`, the M32 plan doc.
- **Approach:**
  - First in wave 2, cherry-pick 490b38a 83bcf59 dd43120 8500007 de44e4b 777615c and squash. The text applies clean on fc510e6 + M53.1, and lib.rs and `workspace.spec.ts` merge on their own. Mock parity lives in `mockRoots.ts`.
  - The crate won't build on wave 1 as picked: .15 made `vault_pulse` return `Result<VaultPulse, String>`, with `changes: Option<PulseChanges>`. `root_git_pulse` returns `VaultPulse` too. `rootGitPulse` in `rootsIpc.ts` and `mockRoots.ts`, and `mockRoots.test.ts`'s `Array.isArray` check, follow.
  - `roots_git_commands.rs`: both `app_config_dir()` reads become one helper over `app_config::app_dir`, refusing with `config_unavailable`. Without it, a dev build reads the bundle's `roots.json` and every root refuses with `no_such_root`. Rewrite the "READ-ONLY by design" module doc.
  - Fixes: `web_base` drops userinfo and the ssh user and port. `invokeRootGit` returns only refusal-shaped rejections and rethrows the rest, so the store toasts them. `RootGitRefusal` gains `parent_repo`.
  - SECURITY.md: the M8.1 model replaces the retired modes: one Settings ceiling; the CLI's writers in `--disallowedTools`; MCP enforces write scope, read scope, the knowledge guard and the corpus doors; `allowed-tools:` only narrows. M53.5 is in by then, so it also says a read-scoped run loses Read, Glob, Grep and the shell (Q3). Add `recheck_concept`. Out of scope gains cloud coding agents, GitHub App webhooks and server-side execution.
  - Comments: `git/command.rs:68` ("the whole of `credentials.rs`"); `write.rs:256-258` and `mcp.rs:4577-4579` (Cerebro's own git now turns fsmonitor and hooks off; auto-commit and sync still execute `.git/config`).
- **Tests:** re-landed cargo (roots ×5, protocol pins, credentials ×3, upstream, remote ×3) and vitest (roots, mockRoots, rootsStore, RootTree). New: an `app_config.rs` tripwire (no `app_config_dir(` anywhere else), `web_base` cases, `rootsIpc.test.ts`. e2e: "workspace git" ×2 and "workspace git sync" ×3.
- **Acceptance:** root git reads return typed refusals, and SECURITY.md describes mounted roots (roadmap) and names no retired mode. Every git Cerebro spawns carries `protocol.ext.allow=never`, `protocol.file.allow=user`, `core.fsmonitor=false`, `core.hooksPath=/var/empty` and `core.quotepath=false`. Sync is fetch plus a fast-forward-only pull: a diverged root is never pulled, a nested one refuses with `parent_repo`, and no refusal toasts.
- **Packaged:** in `pnpm tauri dev`, a root mounted there shows its badge (before the fix it refused). In the packaged app, a real repo shows its badge and syncs; a plain folder shows no badge and no toast.
- **Wave** 3 · **Depends** M53.1, M53.15 · **Size** M (roadmap S) · **Crash risk** yes: new spawn sites (credential probe, network fetch and pull) · **Packaged check** yes

### M53.3 One toolchain: pins in the repo, CI reads them, pre-push warns

- **What:** nothing pins a toolchain. CI floats (rustc 1.99.0, node 22.23.3, pnpm 10.34.7), while the owner runs rustc 1.95.0, node 26.3.1 and pnpm 9.15.9.
- **Files:** `rust-toolchain.toml` (new), `package.json`, `pnpm-lock.yaml` (only if it changes), `.github/workflows/mac-app.yml`, `.husky/pre-push`, `scripts/toolchain.test.ts` (new), `README.md`, `scripts/mac-build.sh`, `AGENTS.md`.
- **Approach:**
  - `rust-toolchain.toml`: channel `1.95.0`, rustfmt and clippy, minimal profile. It is the owner's compiler and the one the ledger's fsync and flock claims were checked on (`ledger/mod.rs:13-19`, `writer.rs:974-980`). No `rust-version` in Cargo.toml yet.
  - `package.json`: `"packageManager": "pnpm@10.34.7"` and `"engines": {"node": "26.x"}` (Q2).
  - mac-app.yml: pnpm/action-setup reads `packageManager` (drop `version: 10`); setup-node uses `node-version-file: package.json`; Rust installs with `rustup toolchain install "$channel"`, read from the toml, and build adds both Mac targets. quality and e2e pin `ubuntu-24.04`, because ubuntu-latest moves to 26 on 2026-10-19.
  - pre-push: warn-only rustc, node and pnpm probes. The Rust lane runs on `^(src-tauri|shared|conformance|demo-vault)/` or `rust-toolchain.toml`, since the Rust tests read all three folders. The Darwin skip list stays byte for byte.
  - README.md and `mac-build.sh` name the pins (no "Node 20+", no corepack). AGENTS.md Commands gains a Toolchain row: Homebrew cargo ignores the toml, and the hook warns.
- **Tests:** `scripts/toolchain.test.ts` checks the exact channel and components, the `packageManager` and `engines` shapes, no version literal or dtolnay step in mac-app.yml, both Rust installs reading the toml, and the hook's detector, three probes and full skip list. Manual: a `shared/`-only push runs the Rust lane, and a `src/`-only push skips it. The CI log shows rustc 1.95.0, node 26 and pnpm 10.34.7.
- **Acceptance:** the pins exist and CI reads them. pre-push warns on a mismatch and runs the Rust lane on `src-tauri/`, `shared/` or `conformance/` (roadmap), plus `demo-vault/` and the toml. mac-app.yml holds no toolchain version.
- **Wave** 3 · **Depends** M53.1 · **Size** S · **Crash risk** no · **Packaged check** no · Owner: `npm i -g pnpm@10.34.7`, or every push warns.

### M53.5 Read scope closes the CLI bypass

- **What:** `build_args` (`agent/mod.rs:677-749`) never reads `read_scope`, and the CLI's Read, Glob and Grep need no approval inside the vault. So read scope binds only Cerebro's own tools, and `prompts.ts:390` ("This is enforced") is false. Taking the readers away breaks addressed turns: `addressedAgentPrompt` tells the turn to read its own record, and `get_note` holds that record to the agent's read scope like any note.
- **Files:** `src-tauri/src/agent/mod.rs`, `src/lib/prompts.ts` (+ test), `src/library/AgentEditor.tsx`, `src/pages/AgentsPage.tsx`, `src/engine/{agents,libraryDraft}.ts` (doc lines only). Wave 2: `src/agent/useAgentChat.ts` (+ test), and `src/lib/prompts.ts` (+ test) again.
- **Approach:**
  - `SCOPED_READERS = ["Read", "Glob", "Grep"]` beside `UNGRANTED_WRITERS`, with its reason.
  - A read limit withdraws the shell (Q3): `shell = req.shell.unwrap_or(false) && req.read_scope.is_none()`, passed to `tool_policy`.
  - Non-internal runs push one `--disallowedTools`: the writers when the shell is off, plus the readers when read-scoped, and nothing when both are empty. Internal runs don't change; `INTERNAL_DISALLOWED` already holds both sets.
  - The prompt line names the withdrawn readers; notes come through `get_note` and `search_notes`. The AgentEditor hints and AgentsPage's Shell row say a read limit withdraws the shell. They are static text, not a TS twin of the rule.
  - Rewrite the doc comments at `agent/mod.rs` 86-88, 126-132, 641-650 and 706-710.
  - Wave 1 keeps the draft's interim addressed-turn line: if `get_note` refuses the record, say so rather than guess.
  - Wave 2 (`useAgentChat.ts` is .6's in wave 1): an addressed turn reads its record's body (`readNote`, as useJobRunner does) and appends the M34.1.4 block, `Your standing instructions, from <path>:`, to its system prompt, where `hand_to` already puts it. `addressedAgentPrompt` stops asking for a read, and its docblock's "NOT folded in" reasoning is rewritten. An empty body adds no block. A failed read ends the turn naming the path and spawns nothing. `useJobRunner.ts` stays .26's.
- **Tests:** `a_read_scoped_run_denies_the_builtin_readers` covers read scope × shell × attended, plus the `hand_to` shape: one `--disallowedTools` holding the three readers and the five writers (Bash among them), and an `--allowedTools` holding none. Also `an_unscoped_run_keeps_its_shipped_argv`, the tripwire `every_host_tool_is_a_denied_writer_or_a_scoped_reader`, and `prompts.test.ts` expecting the withdrawn-readers clause. Wave 2, `useAgentChat.test.tsx`: an addressed turn's system prompt ends with its record's body, also for a read-scoped agent whose record sits outside its scope; the message asks for no read; an unreadable record spawns nothing. `prompts.test.ts` follows.
- **Acceptance:** a read-scoped run's argv denies Read, Glob and Grep (roadmap). It never holds Bash, Write or Edit, even with `tools: shell`. An unscoped argv is byte-identical to today's. At most one `--disallowedTools`. An unclassified host tool fails the tripwire. An addressed turn carries its record's body in the system prompt, so a read-scoped agent keeps its instructions.
- **Wave** 1 (argv) and 9 (addressed turn) · **Depends** none; the wave-2 commit follows .6 · **Size** S · **Crash risk** no (argv only) · **Packaged check** no

### M53.6 Agent writes reach the open page; pending saves flush before a turn

- **What:** nothing calls `notify_vault_changed` or `vault_changed`. The watcher drops the agent's echo as an app write, and the panel rescans only at Done. Rust also stamps `modifiedAt` to the second, so the M17.4 reconciler misses a same-second write even after a rescan. The page needs a per-path signal.
- **Files:** `src-tauri/src/{mcp.rs, vault/write.rs}`, `src/editor/{openPages.ts (new), NoteBodyEditor.tsx, MarkdownEditor.tsx}`, `src/agent/{types.ts, AgentActions.tsx, useAgentChat.ts, mockAgent.ts, agentIpc.ts}`, `src/lib/mockIpc.ts` (+ tests), `e2e/agent-writes.spec.ts` (new).
- **Approach:**
  - `write.rs` `landing_path` gives the path as the scan lists it. The pure `mcp.rs` `announced_change`: `append_to_note` names its landing; `write_concept` names the concept and `knowledge/log.md`; the other writers (`update_frontmatter`, `recheck_concept`, `create_note`, `cache_source`, commit, the policy `propose_*` ops) ask for a rescan with no `paths`; tools that write nothing (reads, `open_note`, `navigate`, `propose_organize`, `hand_to`, …) and failures announce nothing. `call_tool` emits it; the dead pair goes.
  - `openPages.ts`: `registerFlush` and `flushOpenPages` (5 s budget, never rejects); `onExternalWrite` and `announceExternalWrites` (pending at once, one coalesced rescan with at most one running and one queued, then settled). `AgentActions` passes `paths ?? []`: an absent list means "rescan", never "nothing".
  - `flushPendingSave` returns a promise that also awaits a save already in flight. `NoteBodyEditor.saveFor` resolves when its save lands.
  - An announced write reloads a clean page. A dirty page gets the banner, and autosave holds until Load (discards, writes nothing back) or Keep (writes the held text). Leaving the page writes yours (Q5). `useAgentChat` awaits `flushOpenPages()`, then the cancel check, first thing in a send.
  - Mock: `agentAppend` mirrors `tool_append`'s guards (no `.mmd`, the note-target guard, no `knowledge/`), but not the governed-type rule. `mockAgent` gains an `append "<text>" to <path>.md` script.
- **Tests:** an `announced_change` table and the tripwire `every_write_tool_tells_the_open_pages`; `landing_path`; `openPages.test.ts`. NoteBodyEditor: a clean reload with `modifiedAt` unchanged; banner and held save; Keep; Load writes nothing; a pending edit lands on flush. MarkdownEditor flush order; useAgentChat waits on a slow flush; `AgentActions.test.tsx`; mockAgent; `agentAppend`. e2e: type, then append inside the 500 ms debounce; both texts reach disk with no banner, and a second append survives the next save with the clock pinned.
- **Acceptance:** an agent append during a turn shows on the open page and survives the next save (roadmap). Every successful MCP write announces itself; a refused one announces nothing. A page's pending save lands before the turn's child starts. A burst keeps one rescan running and one queued.
- **Packaged:** ask the agent to append to the open page. Idle, the line appears. Typing, the banner shows and the save waits. The next save keeps both.
- **Wave** 1 · **Depends** none · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** yes

### M53.10 One spawn helper and a run lifecycle

- **What:** Stop SIGKILLs the CLI's pid alone and never waits, and no child leads its own group. stderr is read only after stdout EOF, so a flood blocks the run. `stop_all` has no production caller. Tool calls read a shared vault pointer that `ensure` retargets, and the job runner never re-checks the vault after an await. New finding: `hand_to` can never start a run, because its request carries no `mcp_url`.
- **Files:** `src-tauri/{Cargo.toml, Cargo.lock}`, `src-tauri/src/{spawn.rs (new), lib.rs, agent/mod.rs, agent/meter.rs, mcp.rs, git/command.rs, git/provider.rs, assembly/live.rs, ingest/spawn.rs, maintain/live.rs}`, `src/App.tsx`, `src/agent/{agentIpc.ts, types.ts, runs.ts, useAgentChat.ts, useJobRunner.ts}`, `src/editor/{MarkdownEditor,AskAiPopover}.tsx`, tests (`App`, `useAgentChat`, `useJobRunner`, `AskAiPopover`, `mockIpc`), `SECURITY.md`.
- **Approach:**
  - `spawn.rs`. `command()` scrubs the repo-selecting env and nulls stdin; it is the only production `Command::new`. It keeps the child in our group, because a background group is stopped by SIGTTIN on `zsh -lic` or an ssh prompt. `supervise()` adds `process_group(0)`, piped output and a drain thread that keeps a 64 KiB stderr tail. `terminate(grace)` sends TERM to the group, polls, then KILLs. One `unsafe killpg` carries a SAFETY comment and refuses pgid ≤ 1 and our own group (Q6).
  - git, `which`, the login-shell probe and status use `command()`; the CLI starts under `supervise()`.
  - `AgentState`: each slot holds a handle, a vault and a cancelled flag. Stop sends TERM, waits 2 s, then KILLs, off-thread. `stop_other_vaults` and `stop_all` (≈3 s at most); `shut_down` and `admit` refuse new runs. The reader thread reaps, keeps the tail, reports the last 2000 stderr chars when a run fails with no result, and books stopped runs `cancelled` (`Tally::ended`; the schema CHECK already admits it).
  - Grants own their vault. It is set at mint; `Running` loses its `vault`; `call_tool` refuses a bearer bound to none; `ensure` only starts the endpoint. `mcp_url` and `mcp_token` can't come off the wire. `start_mcp` goes; `run_agent` and `start_handoff_run` set the URL themselves, which fixes `hand_to`.
  - Hooks: `start_watcher` first stops other vaults' runs; `RunEvent::Exit` calls `shut_down`; `<AiPanel key={vaultPath}>`; TS drops `startMcp`, `McpInfo` and the `mcp` option; `useJobRunner` checks the vault after every await, unclaims, and stops a run that spawned mid-switch.
  - SECURITY.md: Stop, a vault switch and quit end the run's group (TERM, 2 s, KILL). A `setsid` process escapes, and Cerebro trusts the CLI to end its shells on TERM.
- **Tests:** `spawn.rs`: tail cap and drop count; env scrubbed; the child leads its group; TERM comes before KILL; KILL after the grace; a grandchild dies with the group; a `setsid` child survives (the stated limit); no signal reaches pid 1 or our group. `agent/mod.rs`: a 1 MiB stderr flood completes; a failed exit reports its stderr end; a stopped run reports none; a switch stops only the other vault's runs; `stop_all` meets its deadline with TERM ignored; nothing spawns after `shut_down`; the wire can't set the endpoint or bearer. `meter.rs`: the `cancelled` outcome, an abort outranking it, a result beating a late cancel. `mcp.rs`: a grant carries its vault; `hand_to` works; a vault-less bearer is refused. vitest: job-runner switch cases, no endpoint sent, App remounts the assistant.
- **Acceptance:** Stop, a switch and quit leave no CLI child, and a 1 MB stderr flood no longer hangs an attended run (roadmap; automated with a fake CLI). No tool call reads a shared vault pointer. Quit books rows within about 3 s, and stopped runs book `cancelled`. `hand_to` starts its callee. No production `Command::new` sits outside `spawn.rs`.
- **Packaged:** give a shell-granted run `sleep 300` in Bash. After Stop, a vault switch and ⌘Q, `ps -axo pid,pgid,sess,command` shows nothing left, and Fleet shows `cancelled`.
- **Wave** 4 · **Depends** M53.2, M53.3, M53.5, M53.6 · **Size** M · **Crash risk** yes (spawn code) · **Packaged check** yes

### M53.11 Token and secret hygiene

- **What:** tokens compare with `==`. A run token lives until 16 newer mints evict it. `ensure` mints an unrestricted endpoint token. `connectors.json` is written 0644 with headers and env tokens in it. `AgentRequest`'s Debug prints the bearer.
- **Files:** `src-tauri/src/{mcp.rs, agent/mod.rs, lib.rs, connectors.rs}`, `SECURITY.md`.
- **Approach:**
  - No endpoint token: `McpInfo` holds the URL only, and `info()` and `resolve_grant`'s base branch go. `RunGrant::unrestricted` and `run_id_of` become test-only.
  - `tokens_match` folds every byte and the length difference. `resolve_grant` checks every slot with no early exit.
  - Revocation is keyed by run id, with `REVOKE_GRACE = 10 s`: requests resolve at dequeue, so a write sent before exit still lands, attributed. The reader thread revokes once the child is reaped; a spawn failure revokes at once; the list is pruned to the window.
  - A manual `Debug` for `AgentRequest` prints the bearer as `<redacted>` and leaves out the message and system prompt.
  - `connectors.json` gets an atomic owner-only write (`create_new` 0600 temp, `sync_all`, rename; never follows a symlink). `tighten()` on vault open fixes an old 0644 file through `O_NOFOLLOW`.
  - SECURITY.md: each run's bearer is bound to its vault and grant, compared in constant time, and revoked 10 s after exit; the window holds none. connectors.json is 0600 but plaintext at rest.
- **Tests:** `mcp.rs`: `tokens_match` reads every byte and the length; `tok-1` never resolves `tok-10`'s slot; a revoked bearer answers at +5 s and not at +11 s (explicit clock); a never-spawned child's bearer dies at once; revoking one leaves the others; the list stays bounded; `base` resolves to nothing. `agent/mod.rs`: Debug never prints the bearer. `connectors.rs`: saves 0600; a re-save tightens an old file; `tighten` never follows a symlink.
- **Acceptance:** a bearer stops resolving 10 s after its child exits, or at once if none spawned, and a request queued before the exit still lands. Tokens compare in constant time. No endpoint-wide token exists, and the renderer holds nothing, which is stricter than the roadmap's URL-only. connectors.json is written 0600, atomically. Debug never prints the bearer.
- **Wave** 5 · **Depends** M53.10, M53.2 · **Size** S · **Crash risk** yes (the reader thread's tail, the spawn error path) · **Packaged check** no

### M53.12 Links leave the webview

- **What:** tauri's own window path attaches no navigation or new-window handler. In the packaged app every `target="_blank"`, BlockNote's Open, tiptap's link click and the link badges are dead clicks, and nothing guards navigation.
- **Files:** `shared/policy/{links.v1.json (new), README.md}`, `src-tauri/src/shell/{mod,links}.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src/mermaid/{svgLinks.ts, flowchart/linkTargets.ts, flowchart/svgBinding.ts, flowchart/views.ts}` (+ tests: `linkTargets`, `svgLinks.mermaid`, `MermaidDiagram`, `svgBinding`), `AGENTS.md`.
- **Approach:**
  - `links.v1.json` holds the rule, the entry document (`tauri://localhost` at `""`, `/` and `/index.html`), `external_schemes: [http, https]`, and allow, external and deny cases, dev-root ones included. Rust and TS replay the cases. No digest, as with `staleness.v1.json`.
  - `shell::links::classify` allows only the entry document of the tauri origin or the dev root: no userinfo, no query, fragment ignored, origin fields compared by hand (`Url::origin()` is opaque for `tauri:`). Every other same-origin path is denied, because the asset fallback serves index.html and the reload drops unsaved work. http(s) goes External; the rest is denied.
  - `route_navigation` allows, or opens and stops. `route_new_window` opens External links and always denies the window. `open_in_browser` runs `/usr/bin/open` on a thread through `spawn::command` and reaps it.
  - `shell::build_main_window` builds `main` from config with `.on_navigation` and `.on_new_window`, taking the dev root only under `tauri::is_dev()`. lib.rs adds `.setup(...)`; tauri.conf.json gets `"label": "main", "create": false`.
  - `linkTargets.ts` reads `external_schemes` from the artifact, case-insensitive, so badge, popover and guard agree. No other TS link site changes, and the mock doesn't change.
  - AGENTS.md: `shell/` joins the repo map. The webview convention bullet gets its CV id and `enforced: src-tauri/src/shell/links.rs::replays_the_shared_link_cases`.
- **Tests:** `links.rs`: replays the cases; the rule is closed and canonical; navigation proceeds only on the entry document (a recording opener; the real one never runs); a new window is never created. `shell/mod.rs`: one window, `main`, `create: false`, capability windows `[main]`; both guards attached and no other `WebviewWindowBuilder`. `linkTargets.test.ts` replays the artifact. No e2e: Chromium on the mock has no guard.
- **Acceptance:** the main window is built with `create: false`. The entry document loads, http(s) leaves for the system browser, and the rest is denied, BlockNote's link toolbar included (roadmap).
- **Packaged:** with `./scripts/mac-build.sh`, the app boots into its vault. One https click each from the toolbar's Open, link text, a chat link, a URL property and a mermaid badge opens exactly one browser tab and no window. `mailto:` and a chat link to `/notes/a.md` do nothing, and an unsaved edit survives. In dev, `pnpm tauri dev` boots and a Vite full reload still works.
- **Wave** 1 · **Depends** none · **Size** M (roadmap S) · **Crash risk** yes (a new spawn; tests inject the opener) · **Packaged check** yes

### M53.13 Hidden windows keep working

- **What:** no `backgroundThrottling` is set, so WebKit's inactive scheduling applies to a hidden window on macOS 14+. The 60 s job tick is a plain `setInterval`. Suspension is documented, not measured, hence the before/after.
- **Files:** `src-tauri/tauri.conf.json`, `src-tauri/src/shell/mod.rs`, `src/git/useGit.ts` (+ test).
- **Approach:**
  - Owner, before: run the protocol below on any packaged build without .13 (the installed app, or any wave tip), any time before wave 9. Note `min_after_due`.
  - Set `"backgroundThrottling": "disabled"` on the main window. wry sets `inactiveSchedulingPolicy` to none on macOS 14+; below that it is a no-op.
  - A `shell/mod.rs` test reads the value through `tauri::Config`. Its comment gives the reason (the 60 s job tick, the 30 s reminder check), the macOS floor and the protocol.
  - `useGit.ts:138`: the 20 s poll sleeps while `visibilityState === 'hidden'`. Test for `'hidden'`, not `!== 'visible'`, because jsdom reports `prerender`. Coming back re-reads. Rescans and the auto-checkpoint stay ungated.
  - Owner, after: rebuild and re-run. Both numbers go in the commit body and the M53 status.
- **Protocol:** in a scratch vault, turn on Settings → Knowledge → "Learn on its own". Add `records/agents/tick-probe.md` with `type: Agent`, `slug: tick-probe`, `tools: safe`, `scope: [scratch]`, `schedule: daily HH:MM` (now + 12 min) and the body "Reply ok. Call no tools." Let its catch-up run finish. At HH:MM − 10 min press ⌘M and touch nothing; restore the window at HH:MM + 3. Read:

  ```sh
  sqlite3 "$HOME/Library/Application Support/com.cerebro.app/runtime.db" "SELECT run_key, recorded_at, round((julianday(recorded_at) - julianday(run_key, 'utc')) * 1440, 1) AS min_after_due FROM job_ledger WHERE ledger = 'skillRuns' AND key = 'slug:tick-probe';"
  ```

  A run the budget gate deferred surrendered its claim. Read `SELECT attempted_at, decision FROM ambient_gate_decisions ORDER BY attempted_at DESC LIMIT 1` instead.
- **Tests:** the config parses as `Disabled`. Hidden, 20 s of fake time probes nothing; visible plus a `visibilitychange` probes once.
- **Acceptance:** `backgroundThrottling` is disabled, proven by a packaged before/after, and a 60 s tick fires in a window hidden for 10 minutes (roadmap): on the new build, the probe's claim lands within 1.5 min of its due time while the window is still hidden.
- **Wave** 2 · **Depends** M53.12 · **Size** S · **Crash risk** no · **Packaged check** yes (CI can't drive the UI)

### M53.14 `isPlace` round-trips every Selection kind

- **What:** `isPlace` (`place.ts:236-244`) has no `mywork` or `workspace` case, so those threads lose their anchor on reload. It still accepts `review`, retired in M33.3.
- **Files:** `src/engine/place.ts`, `src/agent/conversations.ts` (+ tests).
- **Approach:**
  - Switch on `p.kind as Selection['kind']`. The bare kinds gain `mywork` and `workspace` and lose `review`.
  - `default`: `const unhandled: never = kind; void unhandled; return false;`. Never return the string, which is truthy. A new kind or a retired literal then fails typecheck.
  - Rewrite the docblock (exhaustive over kinds, structural over fields), the retired-kinds note (docs M38.3, review M33.3) and `healPlace`'s history comment. Labels stay as they are (M59.1).
- **Tests:** a `ONE_OF_EACH` table typed over every kind, so a missing kind fails typecheck. Each `placeOf` output survives a JSON round trip, with `placeKey === selectionKey`. The retired kinds review, docs, pipeline, status, project and view are rejected. conversations keeps My work and Work anchors and loads a `review` thread unanchored with its title.
- **Acceptance:** My work and Work anchors survive a reload. A `review` thread loads unanchored with its transcript intact. A future kind breaks typecheck until it is handled.
- **Wave** 1 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.15 History reads tell unavailable, untracked and empty apart

- **What:** a failed history read becomes `[]` and a failed diff `''`, so the page says "No history yet" and the dialog "No changes.". Rust returns a non-repo as `Ok([])` and an unread file list as zero files. An unborn HEAD makes `git log` exit 128, so dropping the TS catch alone would mark every new vault unavailable.
- **Files:** `src-tauri/src/{git/history.rs, git/pulse.rs, git/commit.rs, git_commands.rs}`, `src/engine/git.ts`, `src/lib/{gitIpc,mockGit}.ts`, `src/git/{useGit.ts, GitHistoryPanel.tsx}`, `src/pages/PulsePage.tsx` (+ tests; `mockGit.test.ts` and `GitHistoryPanel.test.tsx` are new).
- **Approach:**
  - `history.rs`: `head_is_born` runs `rev-parse --verify --quiet HEAD`, where exit 1 means unborn. `log_or_unborn` returns empty for an unborn HEAD and keeps any other error. `file_history` uses it.
  - `pulse.rs`: `VaultPulse {tracked, commits}`; `changes: Option<PulseChanges>`, where None means not read, never zero; a pure `tally()`; a non-repo is `tracked: false`. `commit.rs`'s test helpers become `pub(crate)`.
  - TS: `GitRead<T>` is loading, unavailable or ready. `useFileHistory`, `useVaultPulse` (with reload) and a new `useCommitDiff` are keyed by their input, so a stale answer never renders. The mock matches Rust.
  - PulsePage: unavailable shows `section-unavailable` and Try again; untracked shows "History is off"; tracked and empty shows "No history yet"; `changes: null` shows "files unknown". GitHistoryPanel says when its read failed, and `[]` still renders nothing.
- **Tests:** an unborn repo gives `Ok(vec![])`; a HEAD at a missing object gives Err; `tally`; a non-repo is untracked; an unborn repo is tracked and empty. useGit: rejected becomes unavailable; reload; a late answer for an old path is ignored. PulsePage: unavailable plus retry, untracked, tracked-empty, no "No history yet" flash, files unknown, diff unavailable. GitHistoryPanel and mockGit.
- **Acceptance:** PulsePage renders `section-unavailable` when `git log` fails, never "No history yet" (roadmap). A non-repo reads "History is off" and an unborn repo "No history yet". The dialog never says "No changes." while loading or after a failure. An unread file list says "files unknown".
- **Wave** 1 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.16 Create-on-day writes by field kind

- **What:** TypePage and ListPage write `{[dateField]: day}`. On demo-vault's Work item "This month", keyed to `window: daterange`, the new record then fails validation ("window must be a start/end range").
- **Files:** `src/engine/schedule.ts`, `src/views/{QuickAdd,DatabaseBlockView}.tsx`, `src/pages/{TypePage,ListPage}.tsx` (+ tests for schedule, TypePage and DatabaseBlockView), `e2e/collections.spec.ts`.
- **Approach:**
  - `createOnDayValue(type, field, day, schema)`: a declared daterange gets `{start: day, end: null}`, the DatePicker's open range. Anything else gets the bare day.
  - `useCreateOnDay(type)` lives in QuickAdd.tsx, and TypePage and ListPage use it.
  - New affordance (CALENDAR-1): a calendar embedded in a page offers the day +, through `DatabaseBlockView.onCreateOn`, wired in `ConnectedDatabaseBlock`.
  - CalendarView, ViewCanvas, Rust and the mock don't change; both writers keep a nested `end: null`.
- **Tests:** a range validates, and date, undeclared and unknown fields get a scalar. TypePage: daterange vs date. DatabaseBlockView: the field is passed; no button without `onCreateOn`; the connected block files into `records/sprints`. e2e: Work item "This month" and the Delivery page's embedded calendar each write `window` as `start: <day>` and `end: null`, and the record shows on that day.
- **Acceptance:** a daterange gets a range, and a date or undeclared field gets the bare day, on a type screen, a List and an embedded database. The value passes `validateValue`. Drag and resize don't change.
- **Wave** 1 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.17 Source cache paths stop colliding

- **What:** both slug twins cut at 80 characters, so two long Notion URLs share a file and the second overwrites the first. The twins also disagree on `+-+` (TS gives `release---q3-plan`, Rust `release-q3-plan`), so the Inbox never finds the copy.
- **Files:** `src/engine/ingest.ts` (+ test), `src/pages/InboxPage.tsx`, `src-tauri/src/mcp.rs`, `src-tauri/fixtures/source-slugs.json` (new).
- **Approach:**
  - One rule in both twins. The canonical id is trimmed. An issue id is lowercased. A web URL drops one `http(s)://`, lowercases the host and strips a trailing `/`; path case, query and fragment stay part of the identity.
  - Issue paths don't change (`sources/issues/phx-421.md`). A web copy lands at `sources/web/<readable, ≤64>-<first 12 hex of sha256("cerebro-source-cache-v1\0web\0" + canonical)>.md`. For example, `https://wiki.test/x/Rollback` → `wiki.test-x-rollback-16990b2f5ec5.md`.
  - `source-slugs.json` holds the 18 computed cases, prettier-formatted with non-ASCII as `\u` escapes. cargo and vitest both replay it, plus a distinctness check.
  - TS: `canonicalSourceId` and `sourceCachePath` give one ref per canonical source. `uncachedRefs` counts a copy found by frontmatter `source_id` under `sources/` at any path, when its kind is absent or equal. InboxPage passes `allEntries`.
  - Rust: `source_target` reuses an existing copy found by `source_id`, refuses a canonical path held by another note, and refuses an empty id. `cache_source` writes there, so legacy copies refresh in place.
- **Tests:** both replays; `a_long_shared_prefix_gets_two_copies`, `a_refetch_rewrites_the_copy_where_it_already_lives`, `a_copy_outside_sources_or_of_another_kind_is_not_reused`, `a_path_held_by_another_note_is_never_overwritten`, `an_id_with_nothing_left_is_refused`. vitest: a copy at a legacy path is found by `source_id`, and a source spelled several ways makes one ref.
- **Acceptance:** two URLs sharing an 80-character prefix get two files, and the first stays intact. A `+-+` URL gets one path in both twins. An existing copy is found by its `source_id` (roadmap). Issue paths don't change, so demo-vault and e2e don't churn.
- **Wave** 2 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.18 The organize card applies its title and stays put on failure

- **What:** `accept()` never applies `proposal.title`, though the card lists it, and it ignores `patchFrontmatter`'s `false`, so a failed write still dismisses the card.
- **Files:** `src/agent/ProposalCard.tsx`, `src/agent/ProposalCard.test.tsx` (new).
- **Approach:**
  - Patch first, skipped when the patch is empty; stop on `false`. Then call `setTitle` only for a non-blank title that differs from the entry's (setTitle answers `false` for those too); stop on `false`. Dismiss only when both writes landed.
  - No second toast: the store toasts every false path. Delete the dead try/catch.
  - Apply is disabled while a write is in flight.
  - The title is the H1, through `set_note_title`, which adds one when it's missing in both backends. Rust and the mock don't change.
- **Tests:** type, properties and title are applied and the proposal is removed. A failed patch keeps the card, skips `setTitle` and adds no toast. A failed title keeps the card. An unchanged title skips `setTitle` and dismisses. A title-only proposal makes no patch. A double click in flight makes one write. On the real store over the mock fs, Apply writes `type: Work item` and the new H1.
- **Acceptance:** Apply writes the proposed H1. On any failed write the card stays, and the store's toast is the only message. An unchanged or blank title is no failure. A title-only proposal makes no empty frontmatter write.
- **Wave** 1 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.19 Convention ids in AGENTS.md, each with an `enforced:` pointer

- **What:** no `CV-NN` exists, and no test reads AGENTS.md. Every rule is prose, and nothing names its enforcer.
- **Files:** `AGENTS.md`, `scripts/conventions.test.ts` (new), `docs/superpowers/specs/2026-08-30-cerebro-m48-page-layout-design.md`.
- **Approach:**
  - A paragraph under "Conventions that will bite you": ids are permanent, never renumbered or reused. A rule's last line, `enforced:`, names what fails when the rule breaks, or says `prose`.
  - CV-01..15 in document order, edited by anchor text. Enforced: 01 never `--no-verify` (`mac-app.yml`); 04 policy is data and 06 two records (their digest and destiny tests, Rust and TS); 07 knowledge is guarded (the mock's boundary test, `note-targets.json`); 09 wikilink fields (`scanGolden.test.ts`, entry.rs's relationship test); 13 sources stay text (`sourceIsText.test.ts`, `.gitattributes`). Prose: 02, 03, 05, 08, 10, 11, 12, 14, 15. CV-08 names its exceptions: `isReservedTypeName`'s Type, Collection, Skill and Agent.
  - `scripts/conventions.test.ts`: a pure `audit()` with one fixed message per problem: a duplicate or retired id; a missing, extra or misplaced `enforced:`; two rules in one block; an orphan line; a malformed value; prose mixed with pointers; a path outside the repo; a self-pointer; a missing path or needle; an undeclared citation; a Conventions bullet without an id; an empty section. `RETIRED = []`. Citations come from AGENTS.md and any `.claude/skills/*/SKILL.md`.
  - The repo map says `scripts/` holds guard tests. The M48 spec's `promoteColumns`/`demoteColumns` become `promoteContainers`/`demoteContainers`, renamed in M53.9.
- **Tests:** the real tree audits clean and declares at least one id. 18 negative controls, one per message.
- **Acceptance:** 15 rules carry CV-01..15, each ending in exactly one `enforced:`. Renaming a pointed test fails the suite, and so does a Conventions bullet without an id.
- **Wave** 4 · **Depends** M53.1 · **Size** S · **Crash risk** no · **Packaged check** no

### M53.20 Lint rails

- **What:** no boundary rule and no no-DOM engine typecheck exist. `engine/runLog.ts` reads `window.localStorage`. Two dynamic `@tauri-apps` imports sit outside the adapters (`vaultStore.ts:180`, `RootMountDialog.tsx:8`). Five production files import `mockParse`. Three engine files import app layers: `runLog.ts` (agent) and `skills.ts` (mockParse) move off them, and `viewTab.ts`'s `@/views/viewKinds` edge is deliberate (its comment says why) and stays.
- **Files:** `eslint.config.js`, `tsconfig.engine.json` (new), `package.json`, `AGENTS.md`, `scripts/lint-rails.test.ts` (new), `src/test/{setup.ts, mermaidGuard.ts, mermaidGuard.test.ts}`, `src/engine/{frontmatter.ts (new), runLog.ts, skills.ts, wikilink.ts}`, `src/agent/{runs.ts, RunList.tsx, useJobRunner.ts}` (+ tests), `src/stores/{runLogStore.ts (new, + test), vaultStore.ts}`, `src/lib/{ipc,rootsIpc,sha256,mockParse,mockIpc}.ts`, `src/lib/{mockParse,scanGolden}.test.ts`, `src/workspace/RootMountDialog.tsx`, `src/library/LibraryPage.tsx`, `src/pages/DiagramPage.tsx`, `src/editor/markdown.test.ts`, `src-tauri/src/vault/{parse,write}.rs` (comments).
- **Approach:**
  - `splitFrontmatter`, `closingFenceBody` and `humanize` move to `engine/frontmatter.ts`, with no imports and no re-export, and importers repoint. `vaultStore` uses `parseWikilinks`. `RunOwner` moves into `engine/runLog.ts`.
  - The run log's storage moves to `stores/runLogStore.ts` (hydrate, capped append, clear, all in try/catch). The engine keeps `parseRunLog` and `capRunLog`. RunList subscribes and updates live.
  - Two new adapter calls: `ipc.listenVaultChanged` (the watcher listener) and `rootsIpc.pickDirectory` (the browser resolves `null` instead of throwing).
  - `tsconfig.engine.json` (ES2022, no DOM, `resolveJsonModule` for the `shared/policy` JSON, engine non-test files) joins `pnpm typecheck`. `sha256.ts` declares a module-local `TextEncoder`.
  - ESLint: named rails (tauri, mermaid, mockParse, an engine allowlist), composed into one full set per file class, because flat config replaces options instead of merging them. Each covers static imports, `import()` and `import type`. The classes: all of `src`; the four adapters; `render.ts` and `*.mermaid.test.ts`; `mockIpc.ts` and its two tests; engine non-test files.
  - The engine allowlist: `@/engine/*`; `@/lib/templates` (7 files), `@/lib/slug` (5), `@/lib/sha256` (2) and `@/lib/policy/table` (`tools.ts`); `@/views/viewKinds` (`viewTab.ts`), its reason beside the entry; and `shared/policy` JSON (`okf.ts`).
  - Mermaid guard: setup `vi.doMock`s mermaid and layout-elk to record and throw, and an `afterEach` fails the file and names the fix, since render.ts swallows loader errors. AGENTS.md updates the typecheck row, the repo map and the mermaid paragraph; CV-14's `enforced:` names the lint, the guard and `scripts/lint-rails.test.ts`.
- **Tests:** `scripts/lint-rails.test.ts` runs the ESLint API on virtual paths. An engine→store import, `import type` from agent, a dynamic `@tauri-apps` import outside the adapters, mermaid in a plain test and mockParse outside mockIpc all fail; each allowlisted import passes. Also `mermaidGuard.test.ts`, `runLogStore.test.ts`, RunList updating while open, and useJobRunner using the store.
- **Acceptance:** `pnpm lint` fails on an engine→stores import and on a dynamic `@tauri-apps` import outside the adapters (roadmap). The engine typechecks without the DOM. A test that reaches real mermaid fails with the fix named. No new `eslint-disable`; floors hold.
- **Packaged:** an external edit triggers a rescan through `listenVaultChanged`, and Workspace → Mount opens the native folder picker.
- **Wave** 5 · **Depends** M53.19, M53.22 · **Size** M · **Crash risk** no · **Packaged check** yes

### M53.21 Rust rails

- **What:** no `[lints]` table and no `clippy.toml`. 19 `#[allow]`, 0 `#[expect]`, and 11 raw spawn or env-mutation sites.
- **Files:** `src-tauri/{Cargo.toml, clippy.toml (new)}`, `src-tauri/src/{rails.rs (new), lib.rs, spawn.rs, knowledge.rs, attention/lanes.rs, ledger/{reduce,concepts,capture}.rs, ledger/schema/coverage.rs, trigger/{evaluate,mod}.rs, ingest/ambient.rs, runtime/{dispatch,budget,catchup,governance}.rs, policy/commit.rs, git/{command,provider}.rs, agent/mod.rs, vault/testutil.rs}`, `AGENTS.md`.
- **Approach:**
  - Re-grep after M53.10. `clippy.toml` bans `Command::new`, `set_var` and `remove_var`, each with a reason. `[lints.clippy]` denies `allow_attributes`, `allow_attributes_without_reason` and `disallowed_methods`.
  - The 19 allows. Delete 3 stale ones: two functions have only 7 parameters, and `concepts.rs:607` sits on `struct Door` (move `route`'s doc back and put the expect on `route`). 14 `too_many_arguments` become reasoned `#[expect]`, with no `Utc::now` or `SystemTime` in a reason, because evaluate.rs scans its own source. knowledge.rs's dead_code becomes an expect, its cfg decided by running clippy on `--lib` and `--all-targets`. coverage.rs's unused `as_str` goes.
  - Spawns: the helper's one raw call carries a reasoned expect, and every other site uses `spawn::command`. `run_crash_scenario` keeps its body under a test-only expect, beside a new `run_test_child`.
  - GIT_DIR guard: no env mutation. The parent re-runs an `#[ignore]`d child with a decoy `GIT_DIR` and asserts `--absolute-git-dir`; today's `--show-toplevel` check cannot fail. Prove it once by hand with the scrub removed.
  - `trigger/mod.rs`'s forbidden list adds the helper module. AGENTS.md's CV-10: Rust suppressions are reasoned `#[expect]`, clippy bans raw spawns and env mutation, and `enforced:` adds `src-tauri/Cargo.toml`.
- **Tests:** `rails.rs`: `suppressions_are_reasoned_expectations`, `spawns_and_env_mutation_are_banned_with_reasons`, `no_inner_allow_slips_past`. The rewritten GIT_DIR test. Agent tests stay green with helper-built children.
- **Acceptance:** clippy fails on a raw `Command::new` and on a new `#[allow]` (roadmap), hand-checked and recorded in the commit body. No `#[allow]` or `#![allow]` is left. `Command::new` appears only in `spawn.rs` and `testutil.rs`; no `set_var` or `remove_var`. Crash children spawn exactly as before, and CI's crash suite stays green.
- **Wave** 6 · **Depends** M53.10 · **Size** S · **Crash risk** yes · **Packaged check** no

### M53.22 Parity rail: a scan golden

- **What:** parser parity rests on three hand-copied strings (`entry.rs:337-391`, `mockParse.test.ts:4-83`). `conformance/` holds only ledger vectors.
- **Files:** `src-tauri/src/vault/{scan,entry,parse}.rs`, `conformance/{scan/entries.json (new), README.md}`, `src/lib/{scanGolden.test.ts (new), mockParse.test.ts, mockParse.ts}`.
- **Approach:**
  - The golden sits in a subfolder, because `epistemic/conformance.test.ts` replays every top-level `conformance/*.json` as a ledger vector.
  - `scan_golden_is_committed_and_current` covers the demo-vault scan plus three `GOLDEN_FIXTURES` through `build_entry`, with timestamps removed (`shift_remove`, since `preserve_order` is on). `UPDATE_CONFORMANCE=1` writes the file; otherwise it byte-compares, and a missing file panics with the regen command.
  - Delete the hand-synced fixtures on both sides, keeping the OKF title test. Generate once: `UPDATE_CONFORMANCE=1 cargo test --lib vault::scan::tests::scan_golden`.
  - `scanGolden.test.ts`: the mock scan equals the golden per path and in order; fixtures pass through `parseNote`; `engine/wikilink` matches Rust's relationships and outgoing links; corpus sanity (≥ 130 entries, a `.mmd`, a concept, a project). `parseError` compares by presence.
  - On a divergence, TS moves to match Rust; a Rust bug gets its own part. Prove the golden bites (a snippet cap of 159; one H1 edit), then revert.
- **Tests:** the cargo golden test, scanGolden's cases A–D, and the ledger conformance replay staying green.
- **Acceptance:** a scan golden holds mockParse to parse.rs over demo-vault (roadmap). Only Rust writes it, and cargo fails when it is stale or missing. No hand-synced parity strings remain.
- **Wave** 2 · **Depends** none · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** no

### M53.23 Tracked dev skills

- **What:** `.gitignore` ignores all of `.claude/`, so the working procedures live only in private memory, and the repo is public.
- **Files:** `.gitignore`, `.vscode/settings.json`, `AGENTS.md`, `.claude/skills/{verify-ui,policy-artifact-edit,land-stacked-pr,dependabot-triage}/SKILL.md` (new), `scripts/dev-skills.test.ts` (new).
- **Approach:**
  - `.gitignore`: `**/.claude/*`, then `!/.claude/skills/`, because git can't re-include a file under an excluded folder. Check both ways with `git check-ignore`.
  - Four SKILL.md files. Each has `name` equal to its folder and a 1–2 sentence `description`, runs at most 80 lines in Cerebro's words, holds no machine paths, emails or private memory, and points at sources of truth:
    - `verify-ui`: real-browser proof. The jsdom traps, a free port (never 5173), Playwright from a scratch script, boot like `e2e/boot.ts`, lock it in with a spec, and name what only a packaged build proves.
    - `policy-artifact-edit`: the `shared/policy` checklist. READMEs first, CV-04 and CV-06, v1 and v2 frozen, digest regen with the skip list, never prettier over `shared/`.
    - `land-stacked-pr`: retarget children (`deleteBranchOnMerge` is off; PR #15's fate), rebase onto main, prove it with `merge-base --is-ancestor`. The owner merges.
    - `dependabot-triage`: a bump, an override or a proposed dismissal, each with a reason. It never dismisses or merges by itself.
  - AGENTS.md: the CV-15 paragraph sends live checks to `verify-ui`. A new `## Dev skills` rule takes the next free id, with `enforced: scripts/dev-skills.test.ts`, and lists the four skills.
  - `.vscode/settings.json` hides only `.claude/worktrees`.
- **Tests:** `dev-skills.test.ts`: the list equals the folders, the frontmatter is valid, no `/Users/` or `/home/`, every cited repo path exists; plus negative controls. conventions.test.ts also checks the new id and every CV the skills cite.
- **Acceptance:** four skills are tracked, while `.claude/worktrees` and `settings.local.json` stay ignored. A new Claude Code session lists them. The list and the folders must match, or `pnpm test:run` fails.
- **Wave** 7 · **Depends** M53.1, M53.19 · **Size** S · **Crash risk** no · **Packaged check** no

### M53.24 Local diagnostics

- **What:** no logger, panic hook, file sink or webview error listener exists. There are 34 `eprintln!` in 9 files and 2 `println!`. A Finder-launched app sends stderr to `/dev/null`.
- **Files:** `src-tauri/{Cargo.toml, Cargo.lock}`, `src-tauri/src/{diagnostics.rs (new), lib.rs, rails.rs, ingest/ambient.rs, assembly/ask.rs, runtime/{operational,sink,mod}.rs, conflict/resolve.rs, agent/meter.rs, policy/{qualification,authority,table}.rs}`, `src/lib/{diagnostics.ts (new), ipc.ts, mockIpc.ts}` (+ tests), `src/main.tsx`, `AGENTS.md`.
- **Approach:**
  - Add `log = "0.4"`, already in the lock through tauri, with our own appender: no tracing-subscriber, no plugin-log. Lines buffer (≤ 256) until `arm` opens `app_dir()/logs/cerebro.jsonl` (0600, append) with a session line. Info and up for ours, `webview` and `panic`; Warn and up for dependencies.
  - Caps: rotate at 1 MiB to `cerebro.1.jsonl`, two files at most; a message is cut at 2 KiB with a marker. Redaction lives in Rust only: Bearer values, secret-named keys, the 32-lowercase-letter MCP token shape, and known key prefixes (`sk-`, `ghp_`, `xoxb-`, `AKIA`, …).
  - The panic hook chains the previous one and uses `try_lock`. Dev builds mirror lines to stderr under one reasoned expect.
  - `log_frontend` is lenient, forces the level to error or warn, clamps and redacts. In lib.rs, `init()` runs first in `run()`, and `arm` runs on `RunEvent::Ready`, never in a second `.setup()`. The 34 `eprintln!` become `log::` macros; the two digest writers keep `println!` under reasoned expects; `print_stdout` and `print_stderr` are denied.
  - TS: `ipc.logFrontend` swallows its own failure, so it can't loop through `unhandledrejection`; the mock is a no-op. `installErrorReporting()` runs in `main.tsx`: dedupe within 10 s, at most 20 a minute, never `preventDefault`.
  - AGENTS.md's CV-06 says the diagnostic log is neither record: nothing reads it, no refusal lands there, nothing exports it. Its `enforced:` line stays last.
- **Tests:** `diagnostics.rs`: one JSON object per line; rotation keeps one previous file; pending lines flush in order with a dropped count; redaction masks bearers, secret keys, the token shape and the prefixes, and leaves paths, 32-hex ids and `input_tokens` alone; webview entries are clamped and levelled; panic records; the level filter. `rails.rs`: `nothing_prints`, `the_log_has_no_reader`. vitest: error forwarding, dedupe and the rate cap; `logFrontend` never rejects.
- **Acceptance:** a Finder-launched app writes the log, starting with a session line. Never more than two 1 MiB files. A webview error and a panic each land as one line. Secrets never reach the file. clippy denies prints. No exporter.
- **Packaged:** launch from Finder and see the session line under `~/Library/Application Support/com.cerebro.app/logs/`. In dev, `setTimeout(() => { throw new Error('probe Bearer abc') })` lands redacted under `dev/<checkout>/logs`.
- **Wave** 8 · **Depends** M53.10, M53.21 · **Size** M (roadmap S) · **Crash risk** no (two log lines near `runtime/mod.rs`'s crash points) · **Packaged check** yes

### M53.25 Dotfile notes are hidden from the scan

- **What:** the scan filters only folders, so `records/.x.md` is listed while every writer refuses it, which leaves a read-only page. Owner default: hide it.
- **Files:** `src-tauri/src/vault/{scan,write}.rs`, `src-tauri/fixtures/note-targets.json`, `src/lib/mockIpc.ts` (+ test).
- **Approach:**
  - scan.rs: `hfs_ignorable(c)` covers the code points `disk_folded` drops today; `is_hidden(name)` is true when the first character HFS+ hears is `.`. Folders and files both use it, and `list_folders` inherits it.
  - write.rs: the dot rule calls `is_hidden`, and `disk_folded` filters with `hfs_ignorable`, so one table remains. The doc says the scan hides exactly what the writers refuse.
  - `note-targets.json`: the `records/.hidden.md` case records the decision.
  - mockIpc.ts: `isHidden` runs in `isSkippedDir`, `scanVault` and `noteRefusal`; `listFolders` checks each segment.
- **Tests:** the scan fixture gains `items/.draft.md` and `\u{200c}.notes/x.md` (fails at HEAD). Both scanner-agrees tests, Rust and mock, lose their exception. `listFolders` skips `‌.notes`.
- **Acceptance:** neither scan lists a dotfile or a name whose first heard character is `.`. Both scanner-agrees tests pass without an exception. M53.4's refusals don't change.
- **Wave** 6 · **Depends** M53.6 · **Size** S · **Crash risk** no · **Packaged check** no

### M53.26 A trigger-only agent's clock ticks

- **What:** the one-minute tick starts only when something has a `schedule:`. Without one, `now` freezes at mount, and an event cooldown never ends that session.
- **Files:** `src/agent/useJobRunner.ts` (+ test).
- **Approach:**
  - `hasSchedules` becomes `needsClock`: a parseable `schedule:`, as today, or an Agent `when:` that parses to at least one trigger. Paused records count.
  - The interval keys on `needsClock`.
  - Rewrite the tick and `TICK_MS` comments: the clock notices due schedules and lets cooldowns run out.
- **Tests:** in a trigger-only vault, an edit fires run 1. At +5 min another edit; 9 min later, still 1 run; 2 min after that, run 2 fires (at HEAD it stays at 1). A vault with neither field has no timer; one with `when:` has one.
- **Acceptance:** trigger-only agents get their designed 4 runs an hour. An event run never re-fires its schedule's period (roadmap), now in a vault with no `schedule:` too. A vault with neither field keeps no interval.
- **Wave** 2 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.27 A deferred run leaves no record, so the next launch asks again

- **What:** a budget-deferred job unclaims its durable row but keeps its local record. The next launch merges that record back, so a deferred stale recheck stays suppressed forever, and the one-time import writes deferred schedule fires back as answered.
- **Files:** `src/agent/useJobRunner.ts`, `src/stores/uiStore.ts` (+ tests).
- **Approach:**
  - `uiStore.forgetJobRecord(vault, ledger, key, runKey)` removes a record only while it still holds that run key, and rewrites the localStorage mirror.
  - `failedReads` becomes `held`: unreadable records and gate deferrals, for this session only.
  - On a deferral, hold first, so no render offers the job again; then forget, unclaim, log and finish. Rewrite the deferral comment.
- **Tests:** a deferred stale recheck leaves no local record, asks the gate once over an hour of settles, and runs after a relaunch (fails at HEAD). In a vault with an empty table, a deferred schedule isn't imported back and is retried. The existing deferral tests keep their assertions. `forgetJobRecord` with a matching and a different run key.
- **Acceptance:** deferred refresh, stale and schema jobs retry on the next launch. A deferred schedule isn't imported back as answered. Within a session, each lane asks the gate once.
- **Wave** 3 · **Depends** M53.26 · **Size** S · **Crash risk** no · **Packaged check** no

### M53.28 The bundle guards hear `knowledge/` the way the disk does

- **What:** both bundle guards fold ASCII only, but APFS also folds U+212A (the Kelvin sign) to `k`. So `rename_note`, `delete_note` (which can trash a concept), `create_folder`, `save_collection` and `save_list` let `Knowledge/…` through, and the mock's `saveCollection` and `saveList` have no bundle guard at all.
- **Files:** `src-tauri/src/{knowledge.rs, vault/write.rs, lib.rs}`, `src-tauri/fixtures/{bundle-paths.json (new), note-targets.json}`, `src/engine/okf.ts`, `src/lib/mockIpc.ts` (+ tests).
- **Approach:**
  - `disk_folded` moves to knowledge.rs and uses M53.25's `hfs_ignorable`; add `folds_to_bundle`. `canonical_path` matches a folded head and returns the canonical `knowledge/…`.
  - `note_join` reaches the bundle only by its exact name.
  - okf.ts exports `hfsHeard` and `diskFolded` (uppercase, then lowercase, as Rust does), and `canonicalKnowledgePath` and `sectionOfPath` use them.
  - mockIpc reuses them. `guardNoteTarget` refuses a folded head that isn't exact. `createNote` runs it before `guardHumanWrite`, in Rust's order. `saveCollection` and `saveList` guard first.
  - `bundle-paths.json` replaces both inline case tables, adding the `Knowledge/`, ZWNJ and BOM spellings and mapping `Knowledge-archive/x.md` to null. In `note-targets.json`, the whys are rewritten, `Knowledge/flow.mmd` now refuses with "read-only", and `save_note Knowledge/x.md` is a new case.
- **Tests:** knowledge.rs and okf.test.ts replay `bundle-paths.json`. U+212A joins the human-write and move refusals. lib.rs: the five doors refuse U+212A, and the vault stays byte-identical. The mock's five doors refuse `Knowledge/…`.
- **Acceptance:** every human bundle door refuses the U+212A spelling, in Rust and in the mock (parity). One shared table. Note doors reach the bundle only by its exact name.
- **Wave** 7 · **Depends** M53.25, M53.12 · **Size** M · **Crash risk** no · **Packaged check** no

### M53.29 A created Belief may claim only a writable projection path

- **What:** `apply_belief_created` takes the first `.md` alias unchecked, and no validator looks at it. A governed apply appends the batch; then the projection refuses `knowledge/../x.md` after the set is already durable, and every reconciliation exit fails from then on. `.md`, `./x.md`, `/x.md` and `a//b.md` misbehave too. So do well-shaped claims the writer cannot create (review round 1): a NUL, a leaf of 244+ bytes (its `<leaf>.cerebro-tmp` passes NAME_MAX), a folder name over 255 bytes, and `a.md/b.md` beside `a.md`.
- **Files:** `src-tauri/src/ledger/{schema/projection.rs, schema/belief.rs, schema/ops.rs, reduce.rs, conformance.rs}`, `src-tauri/src/policy/submit.rs`, `conformance/projection-claims.json` (new), `src/lib/epistemic/{schema.ts, reduce.ts, schema.test.ts}`.
- **Approach:**
  - `validate_projection_path` also refuses a `.` segment and a bare `.md` leaf. `projection_claim(aliases)` returns the first `.md` alias.
  - `validate_claimable_path`, for a claim only, also refuses control characters (C0, DEL, C1), a folder name over 255 bytes and a leaf over 243. Other event paths keep the shape rule alone: they name files a person already filed, and refusing their event would stop the launch scan (`adopt_moves` appends with `?`).
  - `BeliefCreated::validate`, `CreateBelief` and `SplitOutput::validate` check the claim. The writer refuses before writing a byte, and submit returns the existing `schema_invalid`, so the policy table doesn't change.
  - Both reducers refuse a claim inside another claim's file, or one another claim sits inside, before the entity registers, so a refused claim leaves no trace.
  - A `projection_claims` conformance scenario: shape, writer-limit and nesting refusals (a nesting set included); the edges are accepted. Regenerate with `UPDATE_CONFORMANCE=1 cargo test --lib ledger::conformance`.
  - Before landing, grep the live vault's `.cerebro/ledger` for an alias that starts with `../`, `./` or `/`, equals `.md`, holds a control character or a segment over 243 bytes, or sits inside another claim. Replay now refuses each.
- **Tests:** projection.rs's bad list adds `./x.md`, `a/./b.md`, `.md` and `a/.md`, while `.archive/x.md` and `.hidden.md` stay valid; the claimable list covers C0/DEL/C1, NBSP, ASCII and CJK leaves at 243/244 bytes and folders at 255/256. reduce.rs pins 243 against the projection writer itself, and nesting both ways. belief, ops and submit refusals. Both conformance replays see the same refusals and claims. `schema.test.ts`.
- **Acceptance:** a create or split whose claim escapes the bundle, names no file the writer can create or spells a path two ways is refused at submission, and nothing is appended. The writer and both reducers refuse it alike, and both reducers refuse a claim nested in another. Migrated dot claims stay valid.
- **Follow-ups:** a claim within PATH_MAX of the vault's own path (no pure rule sees the vault prefix); claims that differ only by case or Unicode normalization land on one APFS file; the expansion checks neither a duplicate nor a nested claim, so such a set is appended and folds as a refused batch.
- **Wave** 2 · **Depends** none · **Size** M · **Crash risk** yes (the ledger writer accepts fewer shapes) · **Packaged check** no

### M53.30 No inline edit lands in another vault during an open

- **What:** `patchFrontmatter` and `setTitle` write to the new `vaultPath` with paths from the old vault's entries, which stay on screen until the new scan lands, up to a minute. A same-path file in the new vault takes the edit.
- **Files:** `src/stores/vaultStore.ts` (+ test).
- **Approach:**
  - Read `vaultPath` and `entriesVault` together. When `entriesVault` is set and differs, toast that the vault is still opening and return `false`, before validation, the optimistic update and the IPC call.
  - `null` passes: no scan has landed yet, and 69 test files seed entries without it.
  - The `entriesVault` doc says every writer that names a path from `entries` checks it.
- **Tests:** with `/second`'s watcher held, both return `false`, call no IPC, leave entries alone and toast once each (fails at HEAD). After release, the patch writes to `/second`.
- **Acceptance:** while a vault opens, both write nothing, toast and return `false`. Afterwards they write to the new vault.
- **Wave** 3 · **Depends** none · **Size** S · **Crash risk** no · **Packaged check** no

### M53.31 The `/` menu offers only blocks that survive a save

- **What:** roadmap M53.9's second half, which fc510e6 did not do. `MarkdownEditor.tsx` passes `getDefaultReactSlashMenuItems(editor)` through unfiltered, and `markdown.test.ts` still asserts the menu offers toggle list, the three toggle headings, audio and file (KNOWN_LOSSY). Audio reopens as an empty paragraph; the others lose their toggle or become a link.
- **Files:** `src/editor/{MarkdownEditor.tsx, MarkdownEditor.test.tsx, markdown.test.ts}`.
- **Approach:**
  - One exported builder makes the `/` list. It drops `toggle_list`, `toggle_heading`, `toggle_heading_2`, `toggle_heading_3`, `audio` and `file` by key until M55.4 gives them carriers, and its comment says so.
  - Table and image stay (Q12): their cells and URL survive, and a save only adds an empty header row or an alt text.
  - KNOWN_LOSSY keeps all eight and is still checked against BlockNote's own list: it measures the serializer, not the menu.
- **Tests:** `markdown.test.ts`: the editor's list leaves out exactly KNOWN_LOSSY minus table and image. `MarkdownEditor.test.tsx`: the six are gone; table, image and Cerebro's blocks remain.
- **Acceptance:** the `/` menu offers none of the six until M55.4 (roadmap). A key that starts surviving must leave KNOWN_LOSSY and the dropped set together.
- **Wave** 9 · **Depends** M53.6 (same files) · **Size** S · **Crash risk** no · **Packaged check** no

### M53.32 Rail follow-ups: a `*.list.yml` note target, the mock's governed-type refusal, the ASCII-folding comments

- **What:** three low plan-critic findings no part owned. The roadmap's M53.4 acceptance names `*.list.yml`, but no case covers it. The mock's `agentAppend` left out the governed-type refusal, against CV-07. M53.28 made the ASCII-only folding texts in `okf.ts` and `note-targets.json` untrue.
- **Files:** `src-tauri/fixtures/note-targets.json`, `src-tauri/src/mcp.rs`, `src/lib/mockIpc{,.test}.ts`, `src/engine/okf.ts`.
- **Approach:** a `delivery/smoke.list.yml` case for `save_note` and `update_frontmatter`, replayed by both backends and seeded in the MCP refusal test. `agentAppend` mirrors `governed_note_refusal` and `governed_append_refusal`, in Rust's order and words. The two texts say what M53.28 made true.
- **Wave** 9 · **Depends** M53.4, M53.6, M53.25, M53.28 · **Size** S · **Crash risk** no · **Packaged check** no

## Done or dropped

- M53.4, 0c1e199: note writers refuse dot-paths (as HFS+ hears them), non-notes, `views/` and `attachments/`.
- M53.7 + M53.8, 6ee7ecc: the `<identity>#event` slot; only event runs start the cooldown; a per-vault baseline.
- M53.9, fc510e6, the AI-block half: the AI block saves as `:::ai`, the unmount flush included. The `/` menu half is M53.31.
- Dropped: none. The remaining parts were re-measured live at fc510e6. Review found M53.9's `/` menu half unplanned; it is now M53.31.

## Owner questions

Each default applies if unanswered.

| # | Part | Question | Default |
| --- | --- | --- | --- |
| Q0 | all | The main checkout holds ungated drafts: staged, unstaged on top, and untracked. What happens to them? | **The owner, 2026-10-12:** build everything unstaged in the main checkout. No stash, no commits; the owner commits. |
| Q1 | M53.1 | Should branch pushes also build the DMG? | No. `build` holds write scopes, so it runs on main, `v*` tags and dispatch. Yes means a tag-only release job for the write scopes, plus one new pinned action. |
| Q2 | M53.3 | Pin Node 26.x or 22.x? | 26.x: your v26.3.1, and `@types/node` is already ^26. With 22.x, pnpm refuses `install` on your Node. |
| Q3 | M53.5 | A read limit plus `tools: shell`: withdraw the shell, or keep it and deny only Read, Glob and Grep while Bash still reads everything? | Withdraw it (fail closed). |
| Q4 | M53.5 | Fold in AI-16, so no-shell runs that narrow `allowed-tools` (Ask AI, the AI block, `allowed-tools: []` skills) also lose Read, Glob and Grep? | No; a later part. |
| Q5 | M53.6 | While the external-change banner is up, autosave waits for Load or Keep, and leaving the page writes yours. Acceptable until M55.6 replaces the banner with a merge? | Yes. |
| Q6 | M53.10 | Add `libc` (unix-only, already in Cargo.lock) for `killpg`? It brings the first `unsafe` block: one line with a SAFETY comment. | Yes. Fallback: `/bin/kill -s TERM -- -<pgid>`, with no `unsafe`. |
| Q7 | M53.13 | If the "before" build already fires on time while hidden, ship `disabled` anyway? | Ship: no measured cost, and Tauri and wry document suspension after about 5 hidden minutes. |
| Q8 | M53.19 | Build PRACTICES-2's coverage-ratchet guard, comparing the floors with origin/main in pre-push and CI? | No; CV-12 stays prose. If yes, a later part beside the hook. |
| Q9 | M53.21 | Fold in PRACTICES-4's TS half: a test that fails any `eslint-disable` without `-- reason` (15 of 17 lack one)? | No. |
| Q10 | M53.23 | Add a project `.mcp.json` that pins chrome-devtools-mcp with `--isolated`? It would load in every Claude session in this repo. | No; `verify-ui` drives Playwright. |
| Q11 | M53.30 | Route every human writer, the editor's save included, through the same vault-open guard? | Yes, as a part after M53. |
| Q12 | M53.31 | Table and image also change on a save (an empty header row; an invented alt text). Take them off the `/` menu too? | No: their cells and URL survive, and the roadmap names only the four. |

## Risks

- **The owner's index.** The owner staged files while waves ran. No part touched the index; the re-lands applied as working-tree patches.
- **Crash wedge.** .2, .10, .11, .12, .21 and .29 touch spawn or ledger code. On the Mac, cargo runs only with the skip list; CI's Linux job is the crash run. With no push during the build, it first meets all six when the owner pushes.
- **setsid escapes the group.** Bash-tool shells start their own session, so "no Bash grandchild" rests on the CLI ending its shells on TERM within 2 s. Only the packaged check proves it. If it fails, a `ps`-based sweep of descendants follows; it is not built here.
- **Hot files.** lib.rs (.2, .10, .11, .12, .21, .24, .28), mcp.rs (.2, .6, .10, .11, .17), agent/mod.rs (.5, .10, .11, .21), AGENTS.md (.1, .3, .12, .19, .20, .21, .23, .24), mockIpc.ts (.6, .20, .25, .28), useAgentChat.ts (.5, .6, .10) and useJobRunner.ts (.10, .20, .26, .27). The waves serialize them; re-read each file before editing.
- **Packaged-only proof.** .2, .6, .10, .12, .13, .20 and .24 can't be proven by jsdom or CI.
- **Changes the owner will see.** Read-scoped records lose the shell (.5). Stopped runs book `cancelled` (.10). A link click in an editable page opens the browser (.12). New web copies gain a hash suffix, so `sources/web/` mixes two name shapes (.17). Dotfile notes leave lists (.25). Trigger-only agents may run 4 times an hour again, and spend with it (.26). Embedded calendars gain a day + (.16). Edits during a vault open are refused, not queued (.30). The `/` menu loses toggle list, the three toggle headings, audio and file until M55.4 (.31).
- **CI drift.** ubuntu-latest moves to 26 on 2026-10-19 (.3 pins 24.04). Dependabot opens a burst once `dependabot.yml` reaches main. The August action pins are Node 20 and already run forced onto Node 24. Open Dependabot PR #20 (vitest 4) would void .20's guard assumptions: hold it, or recheck `mermaidGuard.test.ts`.
- **Toolchain drop.** CI moves from rustc 1.99 to 1.95.0 (.3), so clippy lints newer than 1.95 stop firing.
- **Known flakes.** The ledger writer's reopen test and `NoteBodyEditor.test.tsx` may need one re-run.
- **Left open on purpose:**
  - Other human writers still race a vault open (.30, Q11).
  - AI-16 (.5).
  - Human saves stay last-write-wins until M55 (.6).
  - .6's announcement names no vault, so a run bound to vault A could refresh a same-path page in B during the stop grace.
  - A thread resumed in another vault passes the old CLI session id (.10).
  - `rootsStore` load and toggle still throw (.2; PRACTICES-19).
  - Secrets stay plaintext at rest (.11).

## Gate

- **Each part**, in the main checkout: its targeted tests, `pnpm lint`, `pnpm typecheck` and prettier on its files; Rust parts add module-filtered, skip-listed cargo tests. Reviewers re-run them.
- **Each wave**: the full gate on the shared tree before the next wave starts: format, lint, typecheck, `pnpm test:coverage`, cargo fmt, clippy and the skip-listed test, then `PORT=<free> pnpm e2e` once `lsof` shows the port free.
- **M53 closes when:**
  - the full gate passes on the branch tip: format, lint, typecheck (now including `tsconfig.engine.json`), `pnpm test:coverage` with every floor held or raised, the full e2e suite, and cargo fmt, clippy and test;
  - CI is green on the push to `m53-macro-port`: quality, with the full crash suite on Linux, and e2e; on the PR, scanners and cargo-deny too;
  - every roadmap M53 acceptance bullet holds;
  - the owner runs the packaged checks on a `./scripts/mac-build.sh` build (.2, .6, .10, .12, .13 with before and after recorded, .20, .24) and looks at the built app;
  - the roadmap's M53 status is updated.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```
