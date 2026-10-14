# M56 D4 transport record — Claude Code 2.1.250

Written by M56.1 on 2026-10-14. It states what the spike measured and what it derived from Claude Code
2.1.250's own code, fact by fact, and what each later part does with it. Every fact is one case in
`scripts/cli-record/facts.test.ts`, read from `src-tauri/fixtures/cli-stream/spike/`.

**Status: one live recording, the rest owed.** The not-signed-in run is measured (2026-10-14, this
Mac). The other seven scenarios need the owner's login and are owed: their fixtures are **derived**
(`"source": "derived"`, with `derived_from`), written in the recorded shape through the same reducer,
so each derived fact is pinned and a live run confirms it or fails its case. What the code does
not fix (token counts, reply text, the sonnet model id) is illustrative in a derived fixture: no
case reads those values, only relations between them. The record test fails while a row says
`measured` without a recorded fixture, or keeps `owed` after the last derived fixture is replaced.

## Owner step (once)

1. `pnpm tsx scripts/cli-record/spike.ts setup` — the record folder: `$CEREBRO_RECORD_DIR`, else
   `<tmpdir>/cerebro-cli-record` (outside the repo and `~/.claude`; the driver refuses both).
2. `CLAUDE_CONFIG_DIR=<record>/claude-config claude`, then `/login` with your own account, then exit.
   Never an API key: the driver drops every `ANTHROPIC_*` and `CLAUDE*` variable from the child, and
   the reducer refuses any init whose `apiKeySource` is not `none`.
3. `pnpm tsx scripts/cli-record/spike.ts run all` — about 25 short haiku turns, one 2-minute held
   permission and two sonnet turns; roughly five minutes of a small slice of your quota.
4. `pnpm tsx scripts/cli-record/spike.ts reduce all`, then `pnpm vitest run scripts/cli-record/`.
   A failing fact changed: update its row here (claim and status) and its case together. A row
   whose fixtures are all recorded drops `owed` from its status.

## Setup

- **CLI:** `claude --version` reads `2.1.250 (Claude Code)` (M54's pin); the driver refuses any other
  version, and every fixture and init names it. macOS 15.7.9 on arm64, Node 26.3.1.
- **Config:** an isolated `CLAUDE_CONFIG_DIR` inside the record folder, signed in once (step 2). The
  not-signed-in scenario runs in a fresh `unsigned-config/`, made empty for each run, so it
  re-records after the login.
- **Child environment:** inherited, minus the three credentials (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) and every other `ANTHROPIC_*` and `CLAUDE*`
  variable, so a driver started inside a Claude Code session does not record that session's
  entrypoint or settings; minus spawn.rs's repo-selecting git variables; plus `CLAUDE_CONFIG_DIR`.
  The cwd is a two-note toy vault. Children lead their own process group; a stop is TERM to the group,
  then KILL after 2 s (M53.10's grace), never to group 1 or below or the driver's own.
- **Toy server:** `scripts/cli-record/probe.ts`, an MCP server named `probe` run by plain node: tool
  `slow_echo {text, seconds ≤ 60}` and the permission prompt tool `approve`, both with M54.1's
  `anthropic/alwaysLoad`. Its `hook` mode answers PreToolUse. Both log what they were asked.
- **Argv:** build_args' shared flags at M55's tip, on haiku, then each scenario's own (`--settings`,
  `--permission-prompt-tool mcp__probe__approve`, `--effort`) and `--session-id` (minted) or
  `--resume`. The stream-json child takes `-p --input-format stream-json --permission-prompt-tool
  stdio` and no prompt. Each fixture keeps its argv, with paths as `/RECORD/…`.

  ```text
  -p <prompt> --output-format stream-json --verbose --include-partial-messages
  --mcp-config <probe> --permission-mode <mode> --allowedTools <list>
  --setting-sources user --strict-mcp-config --model haiku
  ```

## Facts

Status: `measured` (a recorded fixture), or `derived (source); live run owed`. A row's claim is its
case's title.

| Fact | Claim | Status | Fixtures | Feeds |
| --- | --- | --- | --- | --- |
| F0 | a fresh config not signed in still starts, then ends in one synthetic authentication_failed reply, a success result with is_error true and terminal_reason api_error, exit 1 and an empty stderr | measured | `spike/not-signed-in.json` | M56.4 |
| F1 | --session-id names the session: init reports the minted id and the session file is named for it | measured (not signed in); signed-in run owed | `spike/not-signed-in.json`, `spike/resume-usage.json` | M56.3, M56.7 |
| F2 | -p --resume keeps the session id and appends to the same session file | derived (--help on --fork-session; the resume loader keeps the id); live run owed | `spike/resume-usage.json` | M56.3 |
| F3 | each -p turn reports only its own calls: num_turns counts them and result.usage sums their prompt tokens | derived (the result and usage schema text); live run owed, with the cache TTL bucket | `spike/resume-usage.json` | M56.12 |
| F4 | a PreToolUse defer ends the run as success with stop_reason and terminal_reason tool_deferred, names the call in deferred_tool_use, exits 0 and leaves the tool_use unanswered in the session file | derived (the result builder and the SDK output filter); live run owed | `spike/defer-resume.json` | M57.1 |
| F5 | --resume after a defer runs the hook again on the same call: allow runs it under the original tool_use id, and deny returns the hook's reason as an error result | derived (the deferred-tool resume handler); live run owed | `spike/defer-resume.json` | M57.1 |
| F6 | with two calls in one message, the defer names one; on resume that call runs and the other gets no result | derived (deferred_tool_use is one object; the resume loader drops unanswered calls); live run owed | `spike/defer-resume.json` | M57.1 |
| F7 | a PreToolUse hook from --settings runs under --setting-sources user | derived (--help: --setting-sources picks user, project, local; --settings is its own source); live run owed | `spike/defer-resume.json` | M57.1, M57.2 |
| F8 | the prompt tool is asked with tool_name, input and tool_use_id, its allow applies updatedInput and its deny message reaches the model; without it an ungranted Write is a permission denial | derived (the 06-agents study's bundle reading); live run owed | `spike/prompt-tool.json` | M57.2 |
| F9 | AskUserQuestion is in init's tools only with a prompt tool, and its answer returns in updatedInput's answers, keyed by question | measured (absent without a prompt tool); with one, owed | `spike/not-signed-in.json`, `spike/ask-question.json` | M57.3 |
| F10 | an allow rule skips the prompt tool, and a PreToolUse hook still runs before it | derived (the 06-agents study: hooks, then rules, then the prompt tool); live run owed | `spike/allow-rule.json` | M57.2 |
| F11 | initialize answers with commands, models and the current model, and every effort level it lists is low, medium, high, xhigh or max | derived (the SDK's initialize and model schemas); live run owed | `spike/stream-json.json` | M56.5 |
| F12 | a can_use_tool request waits while unanswered and the turn goes on after allow | derived (the 06-agents study: stdio canUseTool waits indefinitely); live run owed | `spike/stream-json.json` | D4 (b) |
| F13 | interrupt answers success with still_queued, ends the turn as error_during_execution, and the child takes the next message | derived (the interrupt schema and the result builder); live run owed | `spike/stream-json.json` | M57.5 |
| F14 | set_model answers success and the next reply comes from the new model | derived (the set_model schema); live run owed | `spike/stream-json.json` | D4 (b) |
| F15 | a message sent mid-turn waits: the running turn's result counts it in queued_turn_count, and its own result follows | derived (queued_turn_count's schema text); live run owed | `spike/stream-json.json` | M57.5 |
| F16 | stream-json gives one result per message, and total_cost_usd only grows across them | derived (the usage, modelUsage and total_cost_usd schema text); live run owed | `spike/stream-json.json` | D4 (b) |
| F17 | a stop mid-tool leaves the tool_use unanswered in the session file, and --resume succeeds without writing a result for it | derived (the resume loader's transcript repair); live run owed | `spike/kill-resume.json` | M56.3, M57.5, Q2 |
| F18 | a stop mid-text keeps none of the partial reply, and --resume answers anew | derived (assistant lines are written whole); live run owed | `spike/kill-resume.json` | M56.3, M57.5 |
| F19 | --effort takes low, medium, high, xhigh or max, and a resumed turn on sonnet with --effort low records effort low on its reply | derived (--help on --effort; the 06-agents study saw effort on session lines); live run owed | `spike/resume-usage.json`, `spike/stream-json.json` | M56.5 |
| F20 | start cost, spawn to init and to first delta, per transport | measured (not signed in only); per-transport costs owed | none: written here, never pinned | the record |

### What was measured (not-signed-in, 2026-10-14)

- Init: model `claude-haiku-4-5-20251001` for `--model haiku`, `permissionMode` as passed,
  `apiKeySource: "none"`, `probe` connected, and `mcp__probe__approve` among the tools (no prompt
  tool, so it stays a tool). No `AskUserQuestion`, no `ExitPlanMode`.
- One assistant line: `message.model: "<synthetic>"`, `error: "authentication_failed"`,
  `is_api_error_message: true` (the session file spells it `isApiErrorMessage`), text
  `Not logged in · Please run /login`, and a message id that is a UUID, not `msg_…`.
- Result: `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`,
  `api_error_status: null`, `num_turns: 1`, the same text. Exit 1, stderr empty.
- A session file is written even so, named for the minted id, every content line carrying
  `entrypoint: "sdk-cli"` and `version: "2.1.250"`: two `queue-operation` lines, the user prompt, four
  `attachment` lines (`deferred_tools_delta`, `agent_listing_delta`, `skill_listing`,
  `total_tokens_reminder`), an `atis-latch` line, the synthetic assistant line (with its usage, all
  zero) and `last-prompt`. Per-call usage on every assistant line holds here; real calls are owed.
- With `--include-partial-messages`, a `system/status` line (`status: "requesting"`) precedes the reply.

### Measured cost (F20, never pinned)

| Transport | Spawn to init | Spawn to first delta | Spawn to exit |
| --- | --- | --- | --- |
| (a) `-p`, not signed in | 930 ms | none (no model call) | 1250 ms |
| (a) `-p`, signed in | owed | owed | owed |
| (b) stream-json | owed | owed | owed |

### Where the derived facts come from

All from the 2.1.250 binary's bundled code and its shipped `sdk-tools.d.ts`, read on 2026-10-14, or
from the 06-agents study's earlier bundle reading.

- **Result shapes (F3, F4, F13, F16):** the SDK schema describes `usage` as main-loop only and
  per-turn in streaming-input sessions, and `modelUsage` and `total_cost_usd` as cumulative across
  turns with resumed sessions starting fresh. The result builder sets `stop_reason: "tool_deferred"`
  and `deferred_tool_use {id, name, input}` on a deferred run, and the SDK output filter forces
  `is_error: false` and `result: ""` on it. An aborted turn (`aborted_streaming`, `aborted_tools`)
  becomes `error_during_execution`. `terminal_reason` has nineteen values, among them
  `tool_deferred`, `api_error`, `aborted_streaming`, `completed` and `max_turns`.
- **Resume after a defer (F5, F6):** on `--resume`, the loader keeps the deferred call and drops any
  other assistant line whose calls all lack a result. Before the new prompt, the deferred call is
  re-emitted through PreToolUse (the CLI logs "Deferred tool resume: re-emitting … through
  PreToolUse"); a second defer ends the run deferred again. If the tool is gone, the run ends
  `tool_deferred_unavailable` with `is_error: true`. `--resume` does not restore the permission mode,
  and the CLI warns to pass `--permission-mode` again.
- **Kill, then resume (F17, F18):** the same loader drops unanswered calls, so the resumed request is
  well formed and the model never sees the stopped call. When the last line left is the user's, it
  can insert a `<synthetic>` "No response requested." reply before the new prompt. Whether TERM gives
  the CLI time to write a shutdown result for the running tool (lines marked
  `interruptedByShutdown`) is what the live run decides.
- **Control protocol (F11–F15):** `initialize` answers `commands`, `agents`, `output_style`, `models`
  (`value`, `displayName`, `supportsEffort`, `supportedEffortLevels` from `low`, `medium`, `high`,
  `xhigh`, `max`), `account` (dropped by the reducer) and `current_model`. `interrupt` answers
  `still_queued`; `set_model` takes `model` (null or `default` resets); `queued_turn_count` counts
  sends still waiting when a result is produced.
- **The rest:** `--help` (`--session-id` must be a UUID; `--fork-session` makes a new id "instead of
  reusing the original"; `--effort` takes the five levels; `--setting-sources` picks user, project,
  local). The 06-agents study (prompt tool payload and answer, AskUserQuestion turned on by a prompt
  tool, hooks before rules before the prompt tool, `--effort bogus` warned and ignored).
  `sdk-tools.d.ts` (AskUserQuestion's `answers`, keyed by question text, multi-select joined by commas).

## Recommendation

**D4 (a) stands.** The rule: (a) stands unless F17 shows a stopped turn cannot resume with its calls
paired, or F5/F6 show the ask seam cannot work per turn.

- **Steer (F17, F18), derived:** a stop then `--resume` cannot corrupt pairing, because the loader
  drops the unanswered call; it loses that call's result and any partial reply. The call may still
  have run, so the transcript reads "Interrupted, may have completed" (M56.8). That is a limit M57.5
  states, not a reason to switch.
- **Ask (F4–F6), derived:** a defer ends the run cleanly with the call named, and `--resume` re-runs
  the hook on the same call id, so an answer recorded before the resume decides it. Two calls in one
  message defer one at a time.
- **Re-attach** never needs (b): the child outlives the panel under either transport.

The live run may change F5, F6 or F17, and this rule is applied again then. A switch is the owner's
call (Q2: default no).

## What each part does with it

- **M56.3:** mint a v4 `--session-id` for every new run and pass `--resume` alone after (F1, F2; never
  `--fork-session`). The session file is `<config home>/projects/<key>/<id>.jsonl` from the first
  line, even for a run that never reached the API. Read a trailing unanswered `tool_use`, or a prompt
  with no reply, as interrupted (F17, F18). Classify the session-file kinds the not-signed-in file
  shows (`queue-operation`, `attachment`, `atis-latch`, `last-prompt`). A `<synthetic>` reply
  (message id a UUID) is never a ModelChanged. If TERM turns out to write a result marked
  `interruptedByShutdown`, the fold reads it as interrupted too.
- **M56.4:** `spike/not-signed-in.json` is the real not-signed-in recording: the typed
  `error: "authentication_failed"` on the assistant line, so no text rule is needed; the result says
  `success` with `is_error: true` and `terminal_reason: "api_error"`; exit 1, stderr empty.
- **M56.5:** effort is one of `low`, `medium`, `high`, `xhigh`, `max` (F19). Which models take which
  levels comes from initialize's `supportedEffortLevels` (F11), owed; Claude Code ignores an unknown
  `--effort` with a warning, so Rust refuses it (Q12). `--model haiku` resolved to
  `claude-haiku-4-5-20251001` here; the footer names the model init or the reply reports.
- **M56.7:** the minted id equals init's `session_id` (F1), so `record_cli_session` can write it at
  spawn; the stream's id still wins at finish (resumes keep it, F2).
- **M56.12:** under (a), `result.usage` is that process's own calls (F3), and every session-file
  assistant line carries its call's usage. Which TTL bucket (`ephemeral_5m_input_tokens` or
  `ephemeral_1h_input_tokens`) the writes land in is owed: `cache.ts` reads both buckets, and
  the A/B records them when it runs. What .12 found is the next section.
- **M57.1:** a defer is an outcome, not a failure: `success`, `is_error: false`, `tool_deferred` and
  the call in `deferred_tool_use` (F4). The answer must be readable by the hook before `--resume`,
  which needs a prompt (`Continue.` here) and the same `--permission-mode` (F5). Ask one call at a time
  (F6). The hook may ride `--settings` (F7). A vanished tool ends `tool_deferred_unavailable`.
- **M57.2:** the prompt tool gets `{tool_name, input, tool_use_id}` and answers one text block of JSON:
  `{"behavior": "allow", "updatedInput": …}`, which replaces the input, or
  `{"behavior": "deny", "message": …}` (F8). Allow rules skip it and hooks run first (F10), so the
  owner's own rules and hooks pre-empt an ask; the copy never promises that every command asks.
- **M57.3:** AskUserQuestion exists only with a prompt tool (F9, absence measured). Answer with
  `updatedInput: {questions, answers: {<question text>: <label>}}`.
- **M57.5:** under (a), steer is TERM, then `--resume` with the queued text; it drops the in-flight
  call and the partial reply (F17, F18). Under (b) it would be `interrupt` (F13) and a queued send
  (F15).
- **M57.6:** re-attach is a journal question, not a transport one; the child outlives the panel either
  way.

## Resumed-turn cache (M56.12)

Each attended turn's `--append-system-prompt` carries where the person stands and the context
snapshot, and both change as they move, so a resumed turn may write its whole cached prefix again.
Two gates decide whether that context moves into a leading block of the user message
(`scripts/cli-record/cache.ts`; thresholds Q28):

- **Gate 1, the field** (`cache-report.ts`, no model calls): at least 20 warm resumed turns (the gap
  since the last call is under the TTL that call's entries were written with), and a median warm
  first-call write share (creation over creation plus read) above 0.5.
- **Gate 2, the A/B** (`cache-ab.ts`, about twelve haiku turns, with the owner's OK): B, the move,
  costs at most 0.8 of A, today's shape, summed over turns 2 to 6, with a final prompt at most 1.5
  times A's. It writes `spike/cache-ab.json` through the spike's reducer.

**Measured 2026-10-14**, CLI 2.1.250, read-only over the owner's four Cerebro vaults (two under
Documents, the last one opened, and the repo's demo-vault). No Cerebro session file is left on this
Mac: the 2026-09-29 session the plan cites (three turns, each first call writing the whole prefix
into 1-hour entries: 33,657, 35,672 and 53,595 tokens, hours apart) is gone with its project
folder's contents, and no other file says `entrypoint: sdk-cli`. The field summary:

```json
{
  "sessions": 0,
  "turns": 0,
  "resumed": 0,
  "unmetered": 0,
  "untimed": 0,
  "uncached": 0,
  "warm": 0,
  "cold": 0,
  "warmShare": { "median": null, "p90": null },
  "coldShare": { "median": null }
}
```

- **Decision:** keep. Gate 1 failed: not enough warm resumed turns (0 of 20). The A/B did not run,
  and `spike/cache-ab.json` does not exist.
- **What stays:** the system prompt is unchanged. The looking-at line and the snapshot still ride
  `--append-system-prompt`; `contextBlock.ts` is not written.
- **Why keep is safe to hold:** only a warm turn can pay (a resume past the TTL rewrites the prefix
  whatever the prompt holds), and the only Cerebro turns ever seen here were cold.
- **To decide again** (owner): use the panel with follow-ups inside the hour until 20 or more warm
  resumed turns exist, then `pnpm tsx scripts/cli-record/cache-report.ts <vault>...`. If it passes,
  `pnpm tsx scripts/cli-record/cache-ab.ts run` (add `--git` when the vault is a git repo) after
  the login above, then `cache-ab.ts reduce`, and update this section; `cache.test.ts` fails while
  its decision disagrees with the numbers.

## How to re-record

The owner step above, any time. A CLI bump changes `CLI_VERSION` in `scripts/cli-record/reduce.ts`
(M54's pin) first, then re-records all eight scenarios. `reduce` writes nothing on a scan hit, a
server other than `probe` or `cerebro`, an `apiKeySource` other than `none`, or another CLI version.
Raw runs stay in the record folder; delete it, or keep it for M56.2's tee, which reuses its login.
