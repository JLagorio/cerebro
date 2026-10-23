# M91 — AI Elements everywhere, and subagents done properly

Owner request (2026-10-22): bring **all** of shadcn's new AI Elements into the
app and use them for every AI interaction; make sure Cerebro is properly
architected for subagents; learn from the example repos and current harness
practice.

Status: BUILT AND GATED 2026-10-23 (M91.1–M91.17), as unstaged working-tree
changes on `m53-macro-port`. All seven waves and the multi-lens review's fixes
passed the final gate against the baselines, and verify-ui found nothing broken.
What landed, the gate's numbers, the commit subjects, the open owner calls and
the known gaps are in the
[implementation record](2026-10-23-m91-implementation-record.md). Owner steps
pending (§6): staging and committing, M91.R's live recordings, and the
`pnpm tauri dev` smoke. Planned 2026-10-22 and revised the same day after a
five-lens review (26 amendments, all folded in below).

## 0. Decisions taken by default (owner may overrule)

| # | Decision | Why |
|---|---|---|
| Q1 | **Port, don't install.** The 21 patterns and their building blocks (Trace, Message Scroller, Code Block, Attachment, Questionnaire, shimmer) are rebuilt in `src/components/ai/` on Cerebro's primitives (Popover, HoverCard, Menu, Tooltip, Presence, Icon, Keycaps, tokens). shadcn's export names, anatomy and props are kept so its docs apply; the deviations in §3.3 are deliberate. No Base UI, cva, `cn`, tw-animate or `@shadcn/react`. | Base UI popups add document-level Escape/pointer listeners (CV-47, `layers.ts` owns Escape); Cerebro resets Tailwind's palette so shadcn token classes compile to nothing; CV-63/CV-61/Keycaps rails. MIT: notice in `THIRD_PARTY_NOTICES.md` and each ported file's header. |
| Q2 | **Subagents are workers of their run (option A).** They share the run's bearer, grant and attribution. Cerebro makes them visible, committed, metered, prompted, capped and allow-listed. Agent records as subagents with their own bearer (option C) waits for a CLI pin ≥ 2.1.281 (M92 candidate). | The bearer is the identity (CV-33/35/46); option C needs the `--agents` file form to keep a bearer out of argv. |
| Q3 | **Subagents only where the gate sits**: attended, seated runs, behind a new `delegate` ceiling (Settings › Assistant "Subagents", default on). Unattended, hand-off, thread-turn and internal runs deny `Agent` in argv. No unattended switch in M91. | Unseated runs have no hook; enforcement must not depend on one. |
| Q4 | **Foreground only, depth 1, ≤ 2 at once, ≤ 8 per session** via env on every non-internal spawn, set both through `Command::env` and the run's one `--settings` file (flag settings outrank the person's user-level `env`). | Background agents end a `-p` process twice (measured); settled decisions say series and bounded hops; `LOOPBACK_WORKERS = 8`. |
| Q5 | **One Cerebro preset, `cerebro-researcher`** (read-only: vault reads; web only where the run holds web). Built-in types are switched off (`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, measured: `agents: []`); the person's user-level and plugin agents are argv-denied by name; a type the init lists that is neither allowed nor denied ends the run (fail closed). Subagents gather; the main thread, where a person can approve, acts. | Orchestrator–worker with isolated contexts, without lending any grant or opening an unapprovable write path. |
| Q6 | **Reasoning is shown**: seated runs pass `--thinking-display summarized`; replay restores it from the session file (measured: the text is written there). | Default 2.1.250 thinking text is empty. |
| Q7 | **Context use reaches the renderer on demand only** — an owner-call narrowing of M25.2: `agent_context_usage` is pulled at turn end, thread open and fork; it is displayed, never stored, journaled or logged. Tokens never ride the event channel: the fold strips the Agent result's `agentId …/<usage>` trailer; subagent rows show tool uses and time. | The Context element needs the number; D5 keeps telemetry operational. |
| Q8 | **Checkpoint = "Branch from here"**: a new conversation with the thread up to that turn, run with `--resume <from> --resume-session-at <uuid> --fork-session --session-id <minted>` (measured). Files are not rolled back; later turns' changes stay listed with their diffs and per-file restore. | A whole-turn vault revert is a new guarded door (CV-33/39), out of scope. |
| Q9 | **Plan/Queue come from TodoWrite**, enabled on seated runs with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` + `CLAUDE_CODE_ENABLE_TASKS=0` (measured: TodoWrite appears on sonnet-5); `TaskCreate/Get/List/Update` are argv-denied (they honour a shared task-list id). CLI plan mode stays refused. | `-p` disables ExitPlanMode and writes plans to `~/.claude/plans` (measured). |
| Q10 | **Fail closed on built-ins first (M91.1)**: every run passes `--tools` with exactly the built-ins its plan admits (measured: honoured; MCP tools unaffected); outward and cross-session built-ins get rows and argv denies; an init listing an unknown built-in ends the run. | Measured: `SendMessage` posted into another Claude Code session on this Mac; Artifact, Monitor, PushNotification, RemoteTrigger, … are unlisted today. |
| Q11 | **Test Results / Stack Trace are parsed, never invented**: pure parsers over a Bash result's tail and error text; unparsed output renders as Terminal / plain error (CV-05: never "0 failed"). | No structured test data exists. |
| Q12 | **CV-64**: `src/components/ai/` is presentation only, enforced by an AST boundary test (no stores, `useTheme`, IPC adapters, `@/agent/*`, `@tauri-apps/*`). | Keeps the element layer reusable by every AI surface. |
| Q13 | **`Skill` (the person's Claude Code skills) is denied in Cerebro runs.** Product Skills are vault records. | A CLI skill's `allowed-tools` adds allow rules. |
| Q14 | **Composer file attachments ship (M91.17)**: attaching imports through the CV-56 human door on send, the run is told the file's vault path and kind, and one Undo removes it. | Prompt Input's half is attachments. |

## 1. Measured CLI facts (Claude Code 2.1.250, live haiku/sonnet probes 2026-10-22)

These are probe facts, not recordings (CV-26 wants `record-cli` recordings: owner part M91.R).

- Subagent tool: `tool_use.name` **`Agent`** (init lists its alias `Task`; `--disallowedTools Task` removes it; `--tools "…,Agent,…"` accepts the name). Input `{description, subagent_type, prompt, run_in_background?}`.
- `--forward-subagent-text`: a subagent's thinking/text/tool_use/tool_result arrive as `assistant`/`user` lines with `parent_tool_use_id` = the Agent tool id (+ `subagent_type`, `task_description`). Without the flag, its tool_use/tool_result lines still arrive. No subagent `stream_event` partials were seen.
- `system/task_started {task_id, tool_use_id, description, subagent_type, is_backgrounded, spawn_depth, task_type:'local_agent', prompt}`, `task_progress {…, description:"Reading hello.txt", usage{total_tokens,tool_uses,duration_ms}, last_tool_name}`, `task_updated {task_id, patch{status,end_time}}`, `task_notification {task_id, tool_use_id, status, output_file, summary, usage}`; `background_tasks_changed {tasks[]}`; `permission_denied {tool_name, tool_use_id, message…}`. These are stream-only (not in session files).
- Agent `tool_use_result {status, prompt, agentId, agentType, content[], resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage}`; its text content ends with `agentId: … (use SendMessage …)` and `<usage>subagent_tokens: N …</usage>`.
- Default: Agent runs in the **background** → the main turn's `result`, more subagent lines, then a second `init` + `result` (`origin.kind:'task-notification'`) in the same process. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` → foreground, one init, one result.
- Session file: `<session>/subagents/agent-<agentId>.jsonl` (`isSidechain`, `agentId`) + `agent-<agentId>.meta.json {agentType, description, toolUseId, spawnDepth}`; the main file holds no sidechain lines. Stream `uuid`s equal session-file `uuid`s.
- Hooks: PreToolUse/PostToolUse fire for subagent calls with `agent_id` + `agent_type`.
- `--disallowedTools "Agent(<type>)"` refuses that type ("…denied by permission rule 'Agent(reader)' from cliArg"). `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` → init `agents: []`.
- `--append-subagent-system-prompt "<text>"` reaches subagents.
- Thinking: default `thinking:""` + signature and `system/thinking_tokens`; `--thinking-display summarized` streams text (subagents too) and writes it to the session file.
- TodoWrite input `{todos:[{content, status: pending|in_progress|completed, activeForm}]}`, result `{oldTodos, newTodos}`. Sonnet-5 default has neither TodoWrite nor Task*; `ENABLE_TODO_TOOLS=1` (± `ENABLE_TASKS=0`) → TodoWrite.
- Usage: every assistant line carries `message.usage`; context used = `input + cache_creation_input + cache_read_input` of the latest main-chain line; `result.modelUsage[model] {…, contextWindow, maxOutputTokens}` (includes subagents; `result.usage` does not); `result.subagent_stats`.
- WebFetch result `{bytes, code, codeText, result, durationMs, url}`; WebSearch `{query, results:[{tool_use_id, content:[{title,url}]} | string], durationSeconds, searchCount}`.
- Fork: `--resume <from> --resume-session-at <assistant uuid> --fork-session --session-id <new>` → runs as `<new>` (init and result), later turns absent, file `<new>.jsonl`.
- `--tools ""` removes built-ins only; MCP tools stay callable. ToolSearch must stay where MCP tools may be deferred.
- `-p --permission-mode plan`: plan written to `~/.claude/plans/<slug>.md`; ExitPlanMode "disabled for this session".
- **`SendMessage`/`ListAgents` need no permission and reach the person's other Claude Code sessions**; with them in `--disallowedTools` the model cannot reach them, even through ToolSearch.
- Env in the binary: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`.

## 2. Architecture

```
CLI argv/env/settings (M91.1, M91.2, M91.6)   policy: tools.v1.json, tool-approval.v1.json, subagents.v1.json
  └─ fold.rs: one fold — live stream, session file, subagents/ (M91.3)           CV-26, CV-27
       └─ AgentEvent (+ parent, at, uuid; Thinking, ToolResult, Subagent*, ToolDenied)
            └─ transcript.ts: one reducer → ChatMessage.parts + nested SubagentRun (M91.4)
                 └─ view models (src/agent/elements/*, engine/ai parsers M91.10)
                      └─ src/components/ai/* — presentation only (CV-64, M91.7–M91.9)
                           └─ every AI surface (§3.5; M91.12–M91.14, M91.17)
Meter Tally → ContextBook (memory) → agent_context_usage (pull only, M91.5)
```

## 3. Contracts

### 3.1 Event vocabulary (Rust `AgentEvent` in `src-tauri/src/agent/mod.rs`; TS `AgentStreamEvent` in `src/agent/types.ts`)

New fields are optional and skipped when absent. The six committed transcript goldens **will change on purpose** (session fixtures carry uuid/timestamp, session-records holds thinking): M91.3 regenerates them with `UPDATE_CONFORMANCE=1` and the review checks the diff is only `at`/`uuid`/`last_uuid`/`Thinking`/ignored counts. Stream fixtures that share a line with their session file are re-derived so the shared line carries the same `uuid` and `timestamp` (2.1.250 writes them identically).

Changed kinds:
- `UserPrompt { text, uuid? }`
- `Text { message_id, text, parent?, at? }`
- `ThinkingDelta { text }` — only when non-empty; never for subagent lines.
- `ToolStart { tool_name, tool_id, input?, parent?, at? }`
- `ToolDone { tool_id, output?, is_error, parent?, at? }` — for `Agent`/`Task`, output and payload drop the `agentId: …` block and any `<usage>…</usage>` span (both formats).
- `ToolPayload { tool_id, part, text, bytes, truncated, parent? }` — parented calls keep their **input** payload (CliWrites needs it) and emit **no output** payload (journal budget).
- `Error { message, code?, notice?, parent? }` — a sub-fold's error is routed to its SubagentRun as failed, never to the main turn.
- `TurnEnded { stop_reason?, last_uuid? }` — `last_uuid` = the turn's last main-chain assistant line's uuid (checkpoint anchor), live and replay.

New kinds:
- `Thinking { message_id, text, redacted?: true, parent?, at? }` — one per thinking/redacted_thinking block, both formats; empty text allowed.
- `ToolResult { tool_id, parent?, data }`, `data` tagged by `type` (shapes owned by `src/engine/ai/types.ts`, mirrored in Rust):
  - `shell { stdout, stderr, interrupted, truncated }` — each the **last** 2000 chars (summaries print last).
  - `todos { todos: [{content, status, active_form?}] }` (TodoWrite `newTodos`; ≤ 100 items, ≤ 500 chars each).
  - `agent { agent_id?, agent_type?, status?, tool_uses?, duration_ms?, model?, summary? }` (no tokens; `summary` from the cleaned result text, ≤ 500 chars).
  - `web_fetch { url, code?, bytes?, duration_ms? }`; `web_search { query, results: [{title, url}] }` (≤ 20, http(s) only).
- Live-only (like `Cancelled`/`Changeset`; never in replay or the mock's REPLAYED set): `SubagentStarted { tool_id, agent_id, subagent_type, description, background, depth? }`, `SubagentProgress { tool_id, description, last_tool?, tool_uses?, duration_ms? }`, `SubagentDone { tool_id, status, tool_uses?, duration_ms? }`, `ToolDenied { tool_id, tool_name, message }`.

`parent` = the Agent tool_use id that spawned the line's subagent (nested agents name their own spawning call). `at` = the CLI line's RFC 3339 `timestamp`, when present. Replay: transcript.rs finds `<id>/subagents/agent-*.{jsonl,meta.json}` and hands them to `TranscriptFold` (no other reader, CV-27); main and subagent lines are merged by `timestamp` before folding (file order breaks ties). A subagent transcript's `.meta.json` only names the Agent call its lines belong to and emits no event (W2 amendment): a replayed SubagentRun takes its type and description from the Agent `ToolStart` input, and its agent id, status, summary, tool uses and duration from the Agent `ToolResult{agent}`; `depth` is live-only. A `result` with `origin.kind = task-notification` continues the turn.

### 3.2 Shapes

`src/engine/ai/types.ts` (pure, no DOM, CV engine rail) owns the data shapes: `ToolResultData`, `TodoItem`, `SubagentSummary`, `SourceRef`, `StepInput`. `src/agent/types.ts` re-exports them and adds:

```ts
export type MessagePart =
  | { kind: 'reasoning'; id: string; text: string; redacted?: true; streaming?: true; at?: string; durationMs?: number }
  | { kind: 'text'; id: string; text: string }   // every message's text in order; the last is the answer
  | { kind: 'tool'; toolId: string };
export interface SubagentRun extends SubagentSummary {   // agentId?, type, description, status, toolUses?, durationMs?, summary?, model?
  background?: boolean; depth?: number; progress?: string; lastTool?: string;
  parts: MessagePart[]; tools: ToolCall[];
}
// ToolCall += parent?, startedAt?, endedAt?, result?: ToolResultData, denied?: string, subagent?: SubagentRun
// ChatMessage += parts?: MessagePart[], anchor?: { sessionId: string; uuid: string }
```

Reducer rules: `message.text` keeps the text rule (the answer); `parts` keep narration in order, so a continuation never erases an earlier answer. Events with `parent` route to that call's `subagent` (searched recursively); top-level `tools` hold main-chain calls only. A SubagentRun still `running` on a message that no longer streams reads interrupted. Durations come from `at` differences; no `at` → no duration words (CV-05). `replaceLastTurn` also takes `parts` and `anchor`; heals recurse into `tool.subagent.tools`. Live vs replay equality is defined on per-parent projections that leave out live-only kinds and `at`/`startedAt`/`endedAt`.

Persistence (`conversations.ts`): save main-chain text parts that differ from `message.text`, the anchor, and each SubagentRun as a summary (agentId, type, description, status, toolUses, durationMs, summary ≤ 500 chars). Reasoning text and subagent internals stay memory-only and heal from the session file and `subagents/`; an unreadable subagent transcript reads "steps not recorded". `loadConversations` gains healers for the new fields and drops malformed ones. On `QuotaExceededError`, trim the oldest threads' bodies and retry — never save nothing (CV-30 needs `live`).

### 3.3 Component layer (`src/components/ai/`, CV-64)

Files are PascalCase; each element group's components import their own stylesheet (so parallel parts never share one).

- Foundation (M91.7): `Collapsible` (Presence exit; `keepMounted` → `hidden`), `Trace` family (`Trace, TraceLine{status?: 'running'|'error'|'pending'}, TraceIcon, TraceTitle, TraceDescription, TraceContent, TraceCollapsible{open?, defaultOpen?, onOpenChange?}, TraceCollapsibleTrigger, TraceCollapsibleContent{keepMounted?}`), shimmer (`.cb-ai-shimmer`, stilled under reduced motion), `CodeBlock` family (Shiki via `workspace/highlighter.tsx`; **`theme` is a prop**; copy button with an aria-live status; `variant: 'default'|'destructive'`), `Badge`, `Item`.
- Conversation set (M91.8): `MessageScroller` (anchors user turns near the top with a peek, follows the live edge, jump to latest; `role=log`, `aria-busy` while streaming), `Chat`, `Message` (+ actions), `PromptInput`, `Attachment`, `Suggestion`/`Suggestions`, `ModelSelector`, `Context`, `Questionnaire`.
- Trace set (M91.9): `ChainOfThought, Reasoning, Tool, Task, Subagent, Terminal, TestResults, StackTrace` (a) and `Plan, Queue, Sources, InlineCitation, FileTree, Checkpoint, Confirmation` (b).

All take plain props (view models), never `ChatMessage`.

**Status words** (TraceIcon is `aria-hidden`; every status is also words in the title or an sr-only span; unit test: every TraceLine with a status has a status word in its accessible name):

| Status | Words |
|---|---|
| running | manifest `fold.running` / `phrases.running` ("Reading 5 notes", "Running git status") |
| done | manifest past tense ("Read 5 notes", "Ran git status") |
| failed | "Failed to …" |
| denied | "Denied …" |
| interrupted | existing `INTERRUPTED` text (AiActionCard) |
| waiting | existing `DEFERRED`/waiting text ("Waiting for your OK") |
| cancelled / not_run / paused | existing words, unchanged |
| todo | `activeForm` while in progress; sr-only "to do" / "done" |
| tests | "Passed:", "Failed:", "Skipped" |
| file tree | change kind in words ("added", "modified", "deleted", "renamed") |

A unit left unfinished when a turn stops keeps Cerebro's "interrupted, may have completed" wording, not shadcn's "Failed to run".

**Deliberate deviations from shadcn** (pinned by e2e or by rules):
- Suggestions stay borderless rows below the composer (`ai-suggestion`, border 0).
- ModelSelector is one trigger and one popover holding Model and Effort radio groups that don't close on pick, plus the free-text Other model and caller-owned open state; keeps `run-options`, `run-model-*`, `run-effort-*`, the "Model and effort: …" name.
- Questionnaire puts every question on one page (Rust refuses partial answer sets): fieldset/legend, choice rows with descriptions, Other input, error line; no Skip/Previous/Next; no letter or number shortcuts; keeps `question-*` ids.
- Checkpoint reads **"Branch from here"** (accessible name "Branch from here, after <turn>" — its visible words first, WCAG 2.5.3 — marker text "Files stay as they are"), no `role=separator`; shown only when the message has an anchor, the thread isn't blocked, its transcript is readable, and later messages exist.
- Message actions: Copy, Retry, Edit, Branch. No feedback toggles (nowhere to record them).
- PromptInput ignores Enter while `isComposing` (or keyCode 229) and is not a `<form>` that could catch a portaled submit.
- Context sits in the composer toolbar beside run-options in every presentation, within the dock's 60px; its accessible name carries the value ("62% of context used" / "Context use not recorded" / "Context use unavailable") and never starts with "Context:"; the ring is `aria-hidden`.
- ChainOfThought wraps only what `transcriptRows` already folds (consecutive done reads) plus reasoning lines. Change, concept, handoff, commit and view rows, and every failed, interrupted, waiting, cancelled, not_run or paused row, stay top-level lines. The latest turn's chain is open; a chain holding a failure is `defaultOpen`; empty thinking draws no line.
- `hand_to` stays "Handed to X" plus a link to the child run (it returns at once).

**Links (CV-16)**: elements take `href` only for validated http(s) URLs (target=_blank, sr-only "(opens in a new tab)"); vault paths go through an `onOpenPath(path)` callback; a stack frame is a button only for a vault-relative path, else plain text; InlineCitation keeps the existing inline link or wikilink button as its focusable trigger (names and roles unchanged) and adds the hover card. Unit test: no rendered `<a>` has a non-http(s) href.

**Keys (CV-47)**: no AI element adds a window or document keydown listener; element-level handlers only, and any shortcut hint uses Keycaps.

### 3.4 Policy

- `tools.v1.json` `cli_tools` (M91.1): rows for every built-in in the union of the recorded init and the probe inits (signed-in), plus known outward ones: `Agent` (alias `Task` as manifest data the shared name test reads, family `delegate`, renderer `subagent`), `TodoWrite` (family `todo`, renderer `todo`), `TaskCreate/TaskGet/TaskList/TaskUpdate` (`task_list`, deny), `TaskOutput/TaskStop` (`background`, deny), `SendMessage/ListAgents` (`cross_session`, deny), `CronCreate/CronDelete/CronList/ScheduleWakeup/RemoteTrigger` (`schedule`, deny), `Artifact/PushNotification/DesignSync/ReportFindings/Workflow/EnterWorktree/ExitWorktree/SendUserMessage/REPL/ListMcpResourcesTool/ReadMcpResourceTool/ReadMcpResourceDirTool/LSP/Monitor` (`outside`, deny), `Skill` (`skill`, deny — Q13), `ToolSearch` (`meta`, cli), `EnterPlanMode` (`plan`). Renderers gain `subagent` and `todo` (Rust `Renderer` enum, TS union and `RENDERERS` map); tools gain optional `phrases {running, done, failed}` and `fold.running {one, many}`.
- `tool-approval.v1.json`: families above; `delegate` gets ceiling `delegate` (off → deny; on → cli) and a family field `needs_gate: true` (no gate → deny), plus `narrowed_out: "deny"` so a record narrowing that does not name `Agent`/`Task` denies it (no `family == "delegate"` branch in code, CV-04); the pinned built-in agent types (`agent_types.builtin`) and `agent_types.allowed: ["cerebro-researcher"]` live here with goldens per run kind × delegate ceiling, replayed by both suites.
- Every run passes `--tools` = the built-ins whose plan decision is allow, ask or cli (always including ToolSearch); `deny`/`refuse` rows also ride `--disallowedTools`. InitGate ends a run whose init lists a non-`mcp__` built-in without a manifest row, or (delegate on) an agent type neither allowed nor argv-denied.
- `shared/policy/subagents.v1.json` (M91.1 creates `env`; M91.2 extends; Rust + TS load the same bytes, digest-anchored, twin row in `shared/policy/README.md`): `env` {DISABLE_BACKGROUND_TASKS=1, MAX_SUBAGENT_SPAWN_DEPTH=1, MAX_CONCURRENT_SUBAGENTS=2, MAX_SUBAGENTS_PER_SESSION=8, AGENT_SDK_DISABLE_BUILTIN_AGENTS=1}, `seated_env` {ENABLE_TODO_TOOLS=1, ENABLE_TASKS=0}, `presets` [{name, description, toolsets, web_when_held}], `settings` {`permissions.disableBypassPermissionsMode: "disable"`, `disableAutoMode: "disable"`}.
- Subagent prose: `--append-subagent-system-prompt` text is **composed in code** from `shared/prompt/product-brief.md` + `shared/prompt/server-instructions.md` (include_str!/`?raw`) plus one subagent-only line file registered in `shared/prompt/README.md` ("You can't ask the person anything or continue later; report what you found."). Preset prompts name no tool or are composed from typed fragments against the definition's final tools; preset descriptions and prompts join the retired-term and tool-name scans (CV-19/20).
- One `--settings` file per non-internal run: seated runs merge hardening + env into the file `interaction::hook_settings` writes; unseated runs get hardening + env, no hooks. Exactly one `--settings` per argv.

### 3.5 Surface matrix (cerebro-ui notes §4)

| Surface | Elements | Data | Notes / kept pins |
|---|---|---|---|
| Assistant (floating/panel/canvas) | Chat, MessageScroller, Message, Reasoning, ChainOfThought, Tool, Task, Subagent, Terminal, TestResults, StackTrace, Plan, Queue (todos + Up next), Confirmation, Questionnaire, Sources, InlineCitation, FileTree, Checkpoint, PromptInput, Attachment, Suggestion, ModelSelector, Context, CodeBlock | parts, tools, results, changesets, anchors, context pull | every id/role in UI notes §12; DOM identity across presentations; 43 specs |
| Run detail / transcript (fleet, Agent Runs tab, project Runs) | Message, Reasoning, Tool, Task, Subagent, Terminal, StackTrace, FileTree | replayTranscript | `run-transcript-*`, `run-detail*` |
| AgentRunHistory hops, PageRunsTab, FleetSection, Home runs lane, History runs | Subagent/Task lines nested by `parent_run_id` | fleet rows | `agent-run(-hop)`, `page-run-row`, `fleet-row` |
| Comment @agent turns | Message, Reasoning (when present), InlineCitation, shimmer placeholder | thread turn answer | `comment-pending`, `comment[data-state]` |
| CommentComposer with @handle | PromptInput anatomy | — | keeps composer ids |
| RunList (status bar) | Trace lines (running shimmer / done / failed) | runs, run log | `run-row`, `run-stop`, `run-log-row` |
| Editor Ask AI, AI block | PromptInput, Confirmation (hunks), shimmer while working | existing | `ask-ai*`, `ai-block-*` |
| SheetAsk | PromptInput anatomy only (it hands off) | — | `sheet-ask*` |
| PendingWriteCard, Review cards, Inbox/concept proposal cards | Confirmation | existing | `pending-write-*`, `review-card`, `proposal-card` |
| ConceptBody / editor CitationChip `[^id]` | InlineCitation | OKF citations | existing names |
| KnowledgePanel concept sources, chat context-knowledge, PrLinks | Sources | concept sources, PR links | `thread-pr-links`, `context-knowledge` |
| Wakes, Followups, ReviewNotesDock | Queue | wakes, follow-ups, notes | `agent-wake*`, `followup-row`, `review-notes-*` |
| ConceptReviewBar, PageKnowledge, Inbox/QuickOpen/Home asks | Suggestion | labelled asks | `concept-review-bar`, ask ids |
| Settings › Assistant | unchanged layout + new Subagents switch | — | form controls, not an AI interaction |
| AgentProperties grants (CV-25) | unchanged | — | grant drafts are forms |
| Open with, InlineDiff restore | unchanged | — | not AI output |

## 4. Parts

Rust parts run `cargo test` only with the crash skip list
`-- --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite`.
Comments these parts falsify and must rewrite (CV-11): fold.rs:31 and :71 (sidechain skipped), kinds.rs:60-63 (thinking never shown), cli_writes.rs:17-19, usage.rs:9-16, mod.rs:2617-2620, SECURITY.md:146 (Task).

- **M91.1 Fail closed on built-ins** (Rust + policy + TS twin; owns `toolRenderers.tsx` RENDERERS, Rust `Renderer`, `phrases`/`fold.running` in both loaders): manifest rows and families; `--tools` per plan; `--disallowedTools` for deny/refuse; `subagents.v1.json` `env` on every non-internal spawn (`Command::env`); delegate denied where no gate sits (`needs_gate`); InitGate built-in tripwire; SECURITY.md; goldens/digests via `policy-artifact-edit`. Tests: per run kind, `--tools` equals the admitted rows and deny rows ride argv; outward/cross-session built-ins absent everywhere; an init with an unknown built-in ends the run; a signed-in init fixture (synthetic, built from the probe tool names) has a row for every built-in. Commit `fix(policy): admit only the Claude Code built-ins a run's plan names (M91.1)`.
- **M91.2a Subagent policy data**: `delegate` ceiling + `needs_gate` + `narrowed_out` + pinned types + `agent_types.allowed` in tool-approval; `subagents.v1.json` `seated_env`/`presets`/`settings` + loaders (Rust `policy/subagents.rs`, TS `src/lib/policy/subagents.ts`), digests, goldens, README twin row.
- **M91.2b Subagent argv**: one settings file per run (merge with hook settings); env in settings + `Command::env`; `--append-subagent-system-prompt` (composed); `--agents` with `cerebro-researcher` narrowed to the grant (omitted when its tools aren't held); agent enumeration by the CLI's rules (user scope recursive, `name` required; plugin ids `<plugin>:<subdir>:<name|stem>`; symlinks read-only; unreadable definition or a name outside `[A-Za-z0-9:_.-]` → deny `Agent` for the run) → `Agent(<name>)` denies; InitGate agent tripwire; gate hook keeps MAIN_ONLY and answers NoOpinion (never Allow) for allowed types; reserve one loopback worker for `ask_gate`/`ask_host`; seated runs add `--forward-subagent-text`, `--thinking-display summarized`, `seated_env`.
- **M91.2c Meter**: whole-tree tokens from `modelUsage` only when it is a non-empty object with numeric counts, else `result.usage`; an Agent ran and modelUsage unusable → subagent share not recorded/partial (never a zero sum); `unknown_fields` learns the camelCase keys; `RunFacts::from_assistant` ignores parented lines.
- **M91.2d Settings and docs**: Settings › Assistant "Subagents" switch (attended ceiling, persisted like `agentShell`), the TS wire key `RunOptions.delegate` in `agentIpc.ts` (CV-18 contract; Rust's `AgentRequest.delegate` from M91.2a defaults to on for attended runs until it arrives), `agentAccess` words.
- **M91.3a Fold fields**: `at`/`uuid`/`last_uuid`, `Thinking` (+ empty-delta suppression), `ToolResult` (shell tail, todos, agent, web), Agent trailer stripping, `ToolDenied`, parented `stream_event` ignored, continuation turns, kinds rows, golden regeneration + re-derived stream fixtures, synthetic hand-shaped fixtures at the cli-stream root (`transcript-thinking-summarized.*`, `transcript-todos.*`, `transcript-web.*`, `transcript-denied.*`, synthetic ids only). Test: no event or saved thread contains `subagent_tokens`.
- **M91.3b Sub-folds**: per-parent sub-folds (own open message and dedupe; never end/open the main turn; never feed capture, CV-60), `Subagent*` live-only events, Error parent routing, replay of `subagents/` merged by timestamp, CliWrites sees subagent Write/Edit (CV-34), `usage.rs` ignores parented lines, synthetic `transcript-subagent.{stream,session}.json` + `transcript-subagent.agents/agent-a0000000000000001.{jsonl,meta.json}`. Tests: a subagent's write commits with its run; sidechain results never reach capture; replay equals live (projection); continuation keeps the first answer as a part; a derived 8-subagent stream stays under the journal's RUN_BYTES.
- **M91.4 Reducer parts** (after M91.3): types, transcript.ts, conversations.ts (persistence rules + quota), useAgentChat pass-through, mockAgent scripts ("research … with subagents", "think it through", "make a todo list", "run the tests", "fail with a stack trace", "search the web") emitting only kinds Rust emits, mock REPLAYED excludes live-only kinds; golden-name list updated. Tests: goldens replay; live vs replay projections equal; gap mid-subagent rebuilds the same parts and anchor; 30 threads × 8-subagent turns save under a byte budget.
- **M91.5 Context pull**: Tally keeps `ContextUse {used, window?, model?, at}` per session in a bounded memory book; command `agent_context_usage { sessionId }` → `{state:'recorded', used, window, model, at} | {state:'not_recorded'}`; TS adapter with a browser branch through `faulted('agent_context_usage', …)`; IPC failure renders unavailable; usage.rs/mod.rs comments rewritten.
- **M91.6 Branches** (before M91.12): `CliSession::Fork{from, at, id}` (Rust mints `id`; argv as Q8; `id()` keys seat, journal, meter row, `Spawned.session_id`; never reads pending_deferral or opens a seat on `from`; `at` validated as a main-chain assistant uuid in `from`'s session file via transcript.rs); TS branch = `sessionId: null` + `fork {from, at}` re-applied on every send until Spawned/Init names the minted id; mock mints an id and copies the transcript to the anchor. Tests: a hook call on a forked seated run gets Defer/Deny (not NoOpinion); a disallowed Agent type is denied on a branch; the source thread's waiting card survives a branch; argv golden.
- **M91.7 Element foundation**, **M91.8 Conversation set**, **M91.9a/b Trace sets** (§3.3) + THIRD_PARTY_NOTICES + CV-64 AST boundary test (`src/components/ai/boundary.test.ts`).
- **M91.10 Engine** `src/engine/ai/` (owns `types.ts` shapes; lint-rails case): `testReport.ts` (vitest, jest, cargo test, pytest, go test, playwright; totals only from a final summary line, else null; a cut failure list says "first N of M"; test: a 300-test vitest log cut at the head), `stackFrames.ts`, `fileTree.ts`, `sources.ts` (web results, fetches, vault reads, URLs in reply text; dedupe), `todos.ts`, `steps.ts`.
- **M91.12a Composer**: PromptInput (ChatInput keeps `[[`, `/`, `@`), ModelSelector, Context, Suggestion, Queue for Up next. **M91.12b Cards**: Confirmation (Permission/Interaction/WriteApproval), Questionnaire (QuestionCard). **M91.12c Panel body**: Chat/MessageScroller, Checkpoint, todo Plan row in the turn and live Queue in the dock while working.
- **M91.13 Turn rows**: first extract `Message`, `UserMessage`, `WorkingDots` and the MessageText host into `src/agent/ChatTurn.tsx` (+ `chat-turn.css`) and own them; then Tool (AiActionCard), Task (ToolGroupRow), ChainOfThought + Reasoning, Subagent renderer (+ hand-offs), Terminal + TestResults, StackTrace (TurnError/FailureNoticeCard keep their words), FileTree (TurnChangeset), CodeBlock fences, InlineCitation, task lists, Sources. Keeps `action-card` data-*, `action-group[data-count]`, `turn-changeset-*`, the "Thinking…" line. Test: after TurnEnded a write row and a failed row are visible; `action-view-diff` and `view-suggestion-card` are clickable.
- **M91.14 Other surfaces** per §3.5 (keeps `run-transcript-*`, `run-row`/`run-stop`, `ask-ai*`, `comment-pending`, `pending-write-*`, `review-card`).
- **M91.15 Lab and e2e** (alone, after M91.14): lab sections `assistant-transcript` and `context-use`, five presets each (ready; empty; not-recorded; partial; unavailable via `failNext`); e2e specs: subagent research, reasoning, todos/plan/queue, context, branch, terminal + test results, stack trace, sources/citations, model selector, attachments (`__cerebroMockDrop`); verify-ui screenshots light/dark.
- **M91.16 Docs and rails**: AGENTS.md (repo map, CV-27/29/34 wording, CV-64), SECURITY.md, `shared/policy/README.md`, this plan's status.
- **M91.17 Composer attachments**: chip kind `{kind:'file', path, label, fileKind}` (`file:<path>`); snapshot lists attached files by vault path and kind; a CV-19 fragment names the reader only when the grant holds it, else tells the run it can't open the file; import on send through `importAttachment`/`importAttachmentBytes` (one Undo); an osDrop zone on the composer; failures toast and return null (CV-03). Tests: an attached PDF reaches the system prompt; a run without a reader is told so; context-chip pins kept.
- **M91.R (owner)**: record-cli kit — `spike.ts` scenarios and a per-turn env allow-list for the M91 variables; `sanitize.ts` carries `subagents/agent-*.{jsonl,meta.json}` through the one IdMap (agentId, toolUseId, file names, the `agentId:` text, output_file's temp root); `scan.ts`/`fixtures.test.ts` learn the 17-hex agent-id class; `recordings.rs` Meta and sweep read subagent files; then live recordings replace the synthetic fixtures.

## 5. Waves

| Wave | Parts (→ = serial) | Gate |
|---|---|---|
| W1 | M91.1 ∥ M91.7 ∥ M91.10 | lint, typecheck, unit, cargo (skip list), clippy, fmt |
| W2 | M91.3a → M91.3b ∥ M91.8 ∥ M91.9a | same + goldens both sides |
| W3 | M91.4 ∥ M91.2a → M91.2b → M91.2c ∥ M91.9b | same |
| W4 | M91.5 → M91.6 ∥ M91.2d ∥ M91.13 | same + targeted e2e |
| W5 | M91.12a → M91.12c ∥ M91.12b | same + the 43 panel specs |
| W6 | M91.14 ∥ M91.17 ∥ M91.16 | full gate |
| W7 | M91.15 alone → multi-lens review → fixes → final gate incl. e2e vs baseline → verify-ui | |

One Rust-touching agent at a time. TS agents own disjoint files and run targeted tests; each wave's gate runs the full suites against the baselines (unit: 11 known failures; cargo: clean; e2e: recorded before W1).

## 6. Owner steps

1. Commit the staged index (so M91 diffs stand alone), then stage/commit M91 one wave at a time.
2. M91.R live recordings; flip the synthetic fixtures to recordings.
3. A real-app smoke test (`pnpm tauri dev`): research with subagents, the Subagents switch, Context, Branch from here, an attached file.

## 7. Risks

- Hidden flags (`--thinking-display`, `--resume-session-at`) and env names can change on a pin move; M91.R and the InitGate tripwires catch drift.
- The person's user-settings `env` could try to override caps; the run's `--settings` env outranks it (flag settings), and `Command::env` backs it.
- AiPanel e2e pins are dense; M91.12/13 keep ids and DOM identity, and the W5 gate runs the panel specs.
