# M92 — The conversation rail

Owner request (2026-10-23): "I like this UI can we figure that out too? both claude and chatgpt have that neat siderail style in full screen mode". This followed "Did we build sub agents logic and handling? and the UI to watch sub agents?", whose answer was that subagents show inline only and have no monitor.

Status: BUILT 2026-10-23 in waves W1–W5; final review and gate: see the [implementation record](2026-10-23-m92-implementation-record.md). On 2026-10-23 the owner approved D4 (seated runs take their prompt on stdin, for the context breakdown) and a Plan card in the rail (O1, O2, O8). Probe step P ran the same day (§4): nothing stops M92.13, and P10 found a live argv bug that M92.0 fixes.

References:

- **ChatGPT desktop, full screen.** The right rail is one card: project name and menu, Changes (+3,050 −276), Outputs ("Create a file or site", a create action), Subagents ("3 done"), Background processes and Sources (connected apps: "Playwright", "View all"). The transcript shows "Worked for 9m 44s ›", "Working for …", "Answer question", "Awaiting approval", "Waiting for your answer" and a finished-subagent line. Recents carry "Awaiting approval" chips and a spinner per chat.
- **Claude desktop (Code), full screen.** The rail is separate cards, populated ones only: Environment (repo, branch); Context (38% used, 381.3k / 1M, a segmented bar, a category legend with tokens and %, deferred rows shown as "—", "MCP tools 101" folded, "Last updated 17 hours ago. Send a message to refresh."); Connectors (Gmail "Authenticate"); Changes (the PR). Model, effort and permission mode stay in the composer.

## 0. Decisions taken by default (the owner may overrule)

| # | Decision | Why |
|---|---|---|
| Q1 | **The rail exists in canvas only.** Floating's Conversation options menu gains "Expand with conversation details". The docked panel's header (IconButtons, no menu) gains nothing; it reaches the rail through `assistant.rail`, which opens canvas with the rail open. The name is "Conversation details" everywhere: toggle, catalog row, menu item, region label. | Canvas is the full-screen presentation. The 380px panel has no room. "Details" alone is the page's side panel. |
| Q2 | **The rail is a third grid area inside AiPanel's own `<aside>`.** Header, body and composer keep their DOM parents. | One instance in every presentation, so draft, turn and approvals survive the switch (CV-30). |
| Q3 | **Fixed 300px. It docks when the canvas chat frame is ≥ 960px wide** (600 reading + 300 + 2×30 gutter); below that it opens as a drawer. It is not resizable. When docked, the composer narrows with the transcript. | 1440 and 1280 windows dock. Narrow windows keep their reading column. |
| Q4 | **Toggle**: a canvas header button, the command `assistant.rail` (⌥⌘R), and the `cerebro.chatRailOpen` preference (default on). Opening the drawer at narrow widths is session-only and never writes the preference. | Follows DocPage's `sideDrawerFor` rule and CV-47. ⌥⌘B is dead in the composer: `b` is in `EDITOR_MOD_KEYS` and `claimsKey` ignores alt (claims.ts:23, :86-92). `r` is free in the catalog and not an editor key. |
| Q5 | **Card order**: Waiting on you (only while a card is waiting, or when the read failed), Plan, Subagents, Changes, Handed off, Context, Sources, Connectors, Environment. No Outputs card. | What needs you comes first, then what is planned, then what happened, then the setup. Outputs had no source of its own; created pages are Changes' "Added" group. |
| Q6 | **Every card is read-only.** Ceilings, model and effort stay where they are; the rail links to Settings. | The ceilings are app-global. A rail toggle would quietly change every thread and every scheduled run. |
| Q7 | **Pull-only.** Chips appear only in the conversation list. Nothing new appears in the FAB, the AppRail or Home. An empty card is one heading line with a muted "None"; while the conversation is `welcoming`, the docked rail stays unmounted (the toggle still opens it). | Home's "nothing speaks first" (M64.4); "empty lanes stay silent"; ui-refresh: no dashboard, no wall of advertising. |
| Q8 | **Subagents covers the whole conversation**, with reported duration and tool uses only. There is no ticking timer and no token figures. | CV-05; M91 Q7. |
| Q9 | **Changes is the sum of per-run commits**, labelled "across N turns". It is not a net diff. A branch's copied changes are labelled as copied. PR links are Changes rows, with the read-only `forge.rs` state. | Attribution stays recorded (CV-35). Claude's rail puts the PR under Changes. |
| Q10 | **"Worked for" is the CLI's turn time**: the sum of `result.duration_ms` per reply. A replay with no result lines shows no line. P14 measured that `duration_ms` includes a live ask's wait (12.2 s with an 8 s wait), so the rail never claims it leaves out your waits. A deferral ends its process, so that wait is not counted. Putting `duration_ms` on the journaled `AgentEvent::Result` widens usage.rs's "telemetry does not ride the channel" rule (O4). | Recorded rather than inferred. |
| Q11 | **The Plan is a rail card (`rail-plan`), kept after the turn ends** (owner, O8). It shows the conversation's latest todo list with "n of m done", live while a turn runs. In canvas with the rail docked, the dock's `live-plan` hides so the list shows once. Floating, the docked panel and a closed or drawer rail keep today's dock plan. | The owner chose it. `live-plan` stays the dock's test id; the rail reads the same `latestTodos` (engine/ai/todos.ts), never a second parser. |
| Q12 | **The Context breakdown needs seated runs on stdin input** (§4). Until then, the card shows the single count plus "Breakdown not recorded". The breakdown shows categories, deferred rows, autocompact and per-server MCP totals. Memory-file paths and tool names are dropped. | Measured: only the run's own process can answer, and only over stream-json stdin. Q7 widening stays narrow. |
| Q13 | **Handed off, phase 1 only**: `hand_to` calls plus `fleetRunDetail`. Follow-ups and wakes need saved run ids (owner call O6). | Lists only what is recorded. |
| Q14 | **Connectors has no Authenticate button.** "Sign in…" opens Settings at that connector (a secondary action, §1), which shows the `claude /mcp` step. A run's reach comes from `AgentEvent::Reach`, built from the same values as argv. | Cerebro holds no token. The prompt paragraph and the rail must not drift apart. |
| Q15 | **Sources lists citations, most recent first**: five rows, then "View all (N)". The knowledge the next turn carries stays by the composer. | The citation list stands on its own value; ChatGPT's Sources is connected apps, which is our Connectors card. That knowledge is context, not a source. |

## 1. Anatomy

```
┌──┬──────────────┬─────────────────────────────────────────────────────────┐
│  │ Conversations│ header: switcher · agent · [Conversation details] Float │
│54│ thread …     ├──────────────────────────────────┬──────────────────────┤
│  │  ◌ Working   │ transcript (≤760, centred)       │ Conversation details │
│r │ thread …     │  Worked for 4m 12s ›  (chain)    │  Waiting on you      │
│a │  ● Needs you │  …                               │  Plan · 3 of 5 done  │
│i │              │                                  │  Subagents · 2 done  │
│l │ (portalled   │                                  │  Changes · 4 files   │
│  │  Conversation│ composer (Context ring, model,   │  Handed off · Context│
│  │  Navigation) │  effort, attachments)            │  Sources · 7         │
│  │              │                                  │  Connectors · Env    │
└──┴──────────────┴──────────────────────────────────┴──────────────────────┘
```

- **Grid.** Under `.cb-chat[data-presentation='canvas']`: `grid-template-columns: minmax(0,1fr) var(--chat-rail-width)`, areas `"header header" "body rail"`. In canvas, `.m71-chat-frame` becomes the named container `chat-canvas`, so the aside itself can be styled by `@container chat-canvas (min-width: 960px)`. A container cannot style itself. Every rule is scoped to canvas, so the flex column, MessageScroller's height chain and the jump button in floating and panel do not change.
- **Mount.** `{presentation==='canvas' && railShown && <ConversationRail/>}` is the aside's last child. The false slot keeps sibling positions, so nothing remounts. A hidden rail is unmounted and fetches nothing. `railShown` is false while `welcoming` unless the person opened it this session. `ConversationRail` takes memoized derived props, never `messages` (every TextDelta makes a new message; transcript.ts:361-392).
- **Docked.** Sticky, with its own scroll, a labelled region ("Conversation details", `id` for `aria-controls`). It takes no layer, and Escape in canvas stays unbound. In Tab order the rail comes after the composer.
- **Toggle.** A plain `<button tabIndex={0} aria-expanded aria-controls>` with the constant label "Conversation details" (not IconButton: it has no tabIndex and uses `aria-pressed`).
- **WebKit Tab order.** Every rail control has `tabIndex={0}`. Source, Subagent's open-run button and FileTree rows gain a presentation-only `tabIndex` passthrough (CV-64 safe, Confirmation.tsx:177-204 precedent); rail cards pass 0.
- **Drawer (narrow).** `DrawerScrim` (`modal={false}`), the drawer marked `data-overlay`. Its rules hold: Escape returns focus to the opener, a scrim press does not. Opening moves focus to the rail's heading. The drawer enters on `--motion-enter` and leaves through `Presence`. The drawer flag clears once the rail fits again. React learns docked versus drawer from `useMeasuredWidth` on the aside; that value drives inert, labels and focus, never drawing (M52).
- **Navigation.** Canvas hides the record peek (`.m71-detail-frame` is `display:none`, `inert={chatCanvas}`; shell.css:414-417, App.tsx:430), and `openDetail` flips canvas to floating (uiStore.ts:914-918). So:
  - **Primary action stays in canvas.** A Changes row jumps to its turn's TurnChangeset/FileTree in the transcript. A Subagent or Handed off row jumps to its inline row (or opens RunTranscript in a canvas layer). A Sources row jumps to the reply that cites it. A Waiting row jumps to the card.
  - **Secondary action opens the page**, labelled "Open … (leaves full screen)". It calls `setAiPanelPresentation('floating')` first, then opens, so the destination is visible.
  - **Jump from the drawer.** Close the drawer without restoring focus, then scroll and focus the target. The Waiting jump focuses the card's first answer button.
- **Element.** There is one new presentation-only element: `src/components/ai/Rail.tsx` (`Rail`, `RailSection` with heading, count, fold, `data-state` and `data-testid`) plus `rail.css`. Everything else reuses Item, Collapsible, Badge, Subagent, Sources/Source, FileTree, Context and Trace (CV-64).

## 2. Data contract per card

States follow CV-05/CV-44: **ready, empty, not recorded, partial, unavailable**. Every card sets `data-state`. Empty draws as the one-line heading plus muted "None"; not recorded, partial and unavailable stay fully visible. A section that reads ships five lab presets, owned by the part that builds it. Every browser branch a preset fails goes through `faulted('<command>')`, beside its invoke (mockFaults.test).

| Card (`data-testid`) | Source | Live vs replayed | Absent and failed states |
|---|---|---|---|
| Waiting on you `rail-waiting` | `chat.interaction` (one per thread). When the asking call has a `parent`, the card names the subagent. | Live. After reload, `waitOnCard` re-reads `listInteractions`. | Hidden when there is no card. Unavailable when the read failed: "Couldn't check what's waiting" (never hidden). A stale card reads "No longer waiting". The jump goes to `waiting:<card.id>` and focuses its first answer button. |
| Subagents `rail-subagents`, rows `rail-subagent[data-tool-id][data-state]` | `railSubagents(messages)` over main-chain calls whose renderer is `subagent` (CV-04): type, description, state (denied is kept separate from failed), toolUses and durationMs when reported. | The "now" line (progress, lastTool) is live only. Restored running reads interrupted, never done. | Empty: "None". Not recorded: a branch's rows read "Steps not recorded". Partial: "Some turns could not be read back" (transcript read failed). Header "2 running · 3 done", with zero buckets left out. |
| Changes `rail-changes` | `foldConversationChanges(changesets)`, filled by `conversation_changes` (M92.12) for run ids the messages lack. A live or cached changeset wins per run_id. Groups: Added (net kind added across the conversation) first, then the rest, then PR links with forge state. | Changesets are live or cached. The heal reads runtime.db and git. | Empty: "None". Pending: "Changes land when this turn ends". Not recorded: "Changes not recorded for k turns". Partial: rows without counts (binary, not_a_repo, unavailable). Unavailable: the heal read failed. Never "+0 −0". A healed row's also_by reads "not recorded". |
| Plan `rail-plan` | `railPlan(messages)`: the latest readable todo list across the conversation's replies, using `latestTodos` over todo-renderer calls (CV-04), memoized per reply's `tools` array. | Live while a turn runs, then kept. A restored conversation reads its saved calls. | Empty: "None" (no list in this conversation). Not recorded: the saved call's input was trimmed ("Plan not recorded"). Partial: the latest call's input did not parse, so an earlier list shows with "Showing an earlier list". |
| Handed off `rail-handoffs`, `rail-handoff[data-run-id]` | `hand_to` calls (`handoffRunId`), then `fleetRunDetail` for the 8 newest. Read at mount and at turn end; polled every 15s only while one is unended and the rail is visible. | Read from runtime.db. | Null run id: "Run not recorded". A failed detail makes that row unavailable. |
| Context `rail-context` | The existing `useContextUse` pull (no second pull), plus `breakdown` (wire type from M92.14; values once M92.13 lands). | Memory book only (Q7). | No session: "No turns yet". Not recorded: "Context use not recorded. It's read when a turn ends." Partial: count with no breakdown ("Breakdown not recorded for this turn"), or no window. Unavailable: "Context use unavailable". A deferred row shows "not loaded", never 0 or "—". Freshness: "Read when the last turn ended" (with its time if the ContextBook holds one); while a turn streams, "From the previous turn". |
| Sources `rail-sources`, layer `rail-sources-all` | `mergeSources` over `turnSources` of each finished reply. | Web results heal from the session file. | Empty: "None". Partial: the transcript is unavailable, or a done web call has no result. Vault rows open in the app through `onOpenPath` (CV-16). |
| Connectors `rail-connectors` | `readConnectors` + `connectorStatus` (existing adapters) joined with the thread's `Reach` facts (M92.8). Status words come from `elements/connectorRow.ts`, shared with Settings. | Reach is saved as a small thread fact, like prLinks. | Off in Settings: says so. No list: names the inherited-connector limit (SECURITY.md). Unreadable list: unavailable. Status read failed: partial. A thread with no Reach: not recorded. When a connector was merged, the footnote reads "Mail is drafted, never sent: Cerebro blocks the known send tools by name." |
| Environment `rail-environment` | Vault name, branch and SyncBadge tone from `useGit` (with `readError` and the branch kept). "Answers as" from panelAgents. Reach words: pages, shell, web, subagents, edit mode. | Live plus the saved Reach. | Not a repo: "History off". Read failed: unavailable, never "not a repo". Unknown ahead/behind is never "Up to date". Before the first turn: not recorded. |
| Conversation chips `thread-status[data-status]` | `statusOf()` with this precedence: the active thread's flags; a card whose session_id matches; then `live` plus `runState`. The store learns from an agentIpc listener that writes only on Done, Interaction or start, never per token. | Memory-only status book. | Unknown: no chip. `runState` rejected: `unavailable`, shown as one muted "Status unavailable" under the list heading. A failed card read: the same line, never a quiet list. |

**Chip placement.** On the row's second (place) line or as a leading icon, with short words ("Working", "Needs you"), inside the row's button so its accessible name includes the status. The spinner holds still under reduced motion. Hover actions never cover it.

## 3. Turn lines

- **Worked for.** M92.2 adds `duration_ms` to `AgentEvent::Result`. The reducer sums it per run into `ChatMessage.workedMs`, upserting by run so a deferral resume adds once. If any run reported none, the value is absent. `ChainOfThought` takes `title="Worked for 4m 12s · N steps"`; otherwise it shows today's "N steps".
- **Working for.** A memory-only clock starts at the run's Init event (not at send, so spawn time is out) and drives "Working for 1m 05s" while a turn streams. It is never saved.
  - While `chat.waiting`, the line reads "Waiting for your answer" with no clock. The clock keeps counting under it, because P14 measured that `duration_ms` includes a live ask's wait, so the settled figure is never below the live one.
  - The ticking text is `aria-hidden` and outside any live region; screen readers keep BUSY_WORDS (AiPanel.tsx:1316-1318).
  - With no start (re-attach or reload, CV-30), it reads "Working…" with no figure, never 0s.

## 4. The context transport switch (M92.13)

**Measured (2.1.250, cli-probe notes, "M92 context-breakdown probes").**

- `get_context_usage` is answered only over `--input-format stream-json` with stdin open, by the run's own process. A separate resume process counts its own argv's tools, so it is the wrong measure.
- A turn has four steps: write the user line; on `result`, write the control request; about 0.3s later the `control_response` arrives; close stdin and the process exits 0. This also works with `--resume`.
- If stdin stays open after `result`, the process waits for ever.
- A PreToolUse `defer` (the gate's shape) ends with `result`, answers 0.2s later, and exits 0 on close.
- Session files gain `queue-operation` and `mode` lines. Both kinds are already classified.

**Shape.**

- `RunInput {Argv, Stdin}`. A run uses Stdin only when it takes a seat, `supports_gate(version)` holds and the message is non-empty. Answer-resumes keep argv `-p -- ""` (P5: stdin with no line does nothing; an empty line resumes and then runs an extra turn).
- Argv: `-p --input-format stream-json --output-format stream-json …`, with no message element.
- `cli_command` pipes stdin for Stdin runs only. spawn.rs documents the exception.
- New `agent/turn_input.rs`, a thread named `cerebro-turn-input`, owns `take_stdin()`. Its message type is a **closed enum**: `Prompt` (the user line, serialized with serde), `AskContext` (`ctx-<run>`, subtype the literal `get_context_usage`, then `recv_timeout(CONTEXT_ASK_WAIT)`) and `Close`. Nothing else is ever written: no `set_permission_mode`, `interrupt`, `can_use_tool` or hook answer (CV-28, CV-29, CV-32). A rails test holds that no other control subtype string appears in turn_input.rs and that only turn_input calls `take_stdin` for a CLI run.
- Dropping the channel closes stdin, so EOF, panic, init refusal, Stop and quit all close it. EPIPE is ignored.
- The reader sends AskContext on the first main-chain `result`. It sends Close on the matching response, and also on any CLI `control_request`, failing closed.
- `meter::Tally` parses only the matching response into `ContextUse.breakdown`. It keeps categories `{name, tokens}`, total, max, model, autocompact, MCP totals per server (≤ 256 rows, names ≤ 128 chars) and a memory-file count. It drops color, apiUsage, gridRows and paths.
- Debug for the breakdown is hand-written. The breakdown is never emitted, journaled, logged or stored. No command or key is new: the breakdown rides `agent_context_usage`.
- `kinds.rs`: control_* reasons are rewritten and `STREAM_JSON_ONLY`'s "never sees one" is retired (CV-11, CV-26).
- `tee.rs` writes `<base>.stdin.jsonl`. `sanitize.ts` and `scan.ts` learn that file and refuse memory-file paths. The answer also lands in `.stream.jsonl`, so `ANSWER_DROP` gains `memoryFiles`, `mcpTools`, `gridRows` and `messageBreakdown.toolCallsByType`, each with its reason, plus a sanitize.test case built from the probe's response shape.
- Unchanged: internal, unattended, hand-off, thread-turn, condition and answer-resume runs. Steer stays TERM, then `--resume` with the text on stdin (D4 (a)). Fork keeps its argv and adds stdin.

**Probe step P: DONE 2026-10-23.** Results are in the cli-probe notes, "M92 probe step P", with raw output in scratchpad probe-p/out. They pass:

- TERM exits 143 within 0.5 s, with no orphan.
- An early EOF still completes the turn.
- Fork and steer work on stdin.
- The session-file shape is identical in both modes.
- Bash children get EOF at once (P13).
- Init is equal in both modes, one each.
- A CLI control_request answered by Close fails closed.
- The ask answers in 0.3 s even at 168k tokens, and after errors and subagent turns.

Two findings change the plan:

- P5 keeps answer-resumes on argv.
- P10 found that today's `-p <message>` breaks on a message starting with "-" ("- buy milk" → `unknown option`, exit 1; "-v …" prints the version). M92.0 fixes it. The original checklist follows (pin 2.1.250 with Cerebro-shaped argv: settings file, `--agents`, the prompt tool, cerebro behind ToolSearch, `--forward-subagent-text`, summarized thinking).

1. TERM mid-stream and mid-tool.
2. EOF before `result`.
3. Fork plus stdin.
4. Steer resume on stdin.
5. Deferral resume: no user line, versus an empty one, versus `-p ""`.
6. Prompt line and uuids in the session file (goldens, M91.6 anchors).
7. Full-setup categories and the `mcpTools` shape.
8. Breakdown after a subagent turn.
9. Error results followed by the request.
10. A `-`-leading prompt via argv.
11. An error-shaped response.
12. Latency at 1M, which sets `CONTEXT_ASK_WAIT`, capped at ≤ 2 s (Done, Up next and Steer wait on it).
13. Stdin inheritance: Bash `cat`, `read x` and `git credential fill` under stream-json input each return at once with EOF, as with today's null stdin.
14. `result.duration_ms` across a live prompt-tool ask: does it include the wait?
15. Init under stream-json input: tools and agents equal argv mode for the same `--tools`/`--agents`, with exactly one init per process (the InitGate checks only the first).
16. A CLI `control_request` followed by Close: what happens to the turn and the exit code.

Results go in the cli-probe notes. Any surprise in steps 1–6, 13, 15 or 16 stops M92.13. Step 14 settles Q10's wait claim.

**Rollback.** `run_input()` is the one decision point. Making it return `Argv` restores today's argv byte for byte; the argv-unchanged tests prove it. The card then degrades to "Breakdown not recorded", and no other part depends on the switch.

## 5. Parts

Rust parts run `cargo test` with the crash skip list `-- --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite`. TS verify is always `pnpm typecheck && pnpm lint` plus `pnpm test:run <the part's files>`. `ConversationRail.tsx` is edited only by each wave's closing step, one line per card. **Each wave's closing step** also runs the whole-rail Profiler test: all mounted cards, a 50-delta stream, zero rail and conversation-list commits.

- **M92.0 Dash-safe argv** (Rust chain 0, first in W1: `agent/mod.rs` build_args and every argv-building run kind, plus their tests). Every argv run puts the message LAST, after `--`, so a message starting with "-" (a markdown bullet, a negative number, "-v") is the prompt and never a flag. Measured in P10: "- buy milk" fails today with `unknown option` (exit 1), and "-v …" prints the version with no result. Tests: `a_message_that_starts_with_a_dash_is_the_prompt` (the argv ends `--`, message); answer-resume's empty message after `--`; every pinned argv test updated (mod.rs:4247/4683, tee, spike fixtures). Once M92.13 lands, a seated run's argv carries no message at all. P5b measured that the answer-resume form `-p … --resume <sid> -- ""` resumes the deferred call. The same part classifies `command_lifecycle` in kinds.rs as Ignored (P17: two bookkeeping lines a resumed deferred call streams today, now counted Unclassified with a drift row on every answer-resume), with a fold test.
- **M92.1 Frame** (owns `AiPanel.tsx`, `chat.css`, `shell.css` canvas rules, `uiStore.ts`, `shellLayout.ts`, `app.commands.ts`, `useAppCommands`, the new `src/agent/rail/ConversationRail.tsx`, `components/ai/Rail.tsx` and `rail.css`). Covers the grid, the container, mount, the welcoming rule, the toggle button, the drawer (DrawerScrim), `assistant.rail` (⌥⌘R) and floating's "Expand with conversation details". Tests:
  - `shellLayout.test.ts`: rail width and dock constants; docked at 960, drawer at 959; sidebar widths 180, 240 and 460.
  - `AiPanel.rail.test.tsx`: the same composer and Chat nodes and the same draft across a toggle and presentation switches; rail only in canvas; a fresh conversation in canvas shows no card bodies; a docked toggle writes the preference while the drawer writes nothing; the toggle has `aria-expanded`/`aria-controls` and a constant label; drawer Escape returns focus, a scrim press does not, opening focuses the heading; docked Escape does nothing; a row's primary action leaves `aiPanelPresentation === 'canvas'`; a secondary open leaves the destination visible (peek frame not `display:none`, page not inert).
  - `commands/index.test.ts`: a catalog row, no Escape, fires from the composer, no two rows share a label.
  - `boundary.test.ts`.
  - CV-11: rewrite the one-column comments (chat.css:12).
- **M92.2 Worked for** (Rust chain 1: `fold.rs`; TS twin `types.ts`, `transcript.ts`, `conversations.ts`, `mockAgent.ts`, `ChatTurn.tsx`). Tests: `fold.rs` (a result's `duration_ms` rides Result, an absent one gives None, replayed files give none); the goldens on both sides (CV-27); `transcript.test.ts` (summed across a deferral resume; one missing run leaves it absent); `ChatTurn.test.tsx` (the line appears only when recorded; while waiting it reads "Waiting for your answer" with no clock; no start reads "Working…"; the ticking text is aria-hidden; with both counted from Init, the settled figure is never below the last live one).
- **M92.3 Pure engine** (new `engine/ai/threadStatus.ts`, `conversationChanges.ts`; `mergeSources` in `sources.ts`). Tests: the status precedence table (including `unavailable`); the net kind across runs (added→modified stays added; added→deleted drops the row and notes it; rename chains) and the Added group; counts become null when any run left that file uncounted; nothing versus no changeset; cross-turn dedupe uses the same key.
- **M92.4 Subagents and Waiting** (`elements/railSubagents.ts`, `stepReveal.ts`, `toolRenderers.tsx` SubagentRow, `AiActionCard.tsx` `data-tool-id`, `MessageScroller.tsx` public `scrollToElement` and `useMessageScrollerIfAny`, `Chat.tsx` `scrollerRef`, `rail/SubagentsCard.tsx`, `rail/WaitingCard.tsx`, the `tabIndex` passthrough on Source, Subagent and FileTree, `agentIpc.ts` `readCliTranscript` through `faulted('read_cli_transcript')`, lab `rail-subagents` and `rail-waiting`). A WeakMap is keyed per `tools` array so TextDelta never recomputes. Tests: the same array across 50 TextDeltas; reveal opens, scrolls once (`settling-jump`) and focuses; RunTranscript does not throw; the jump to the waiting card focuses its first answer button; a drawer jump closes without restoring focus; Waiting's unavailable state.
- **M92.17 Plan card** (W2, TS only: `elements/railPlan.ts`, `rail/PlanCard.tsx` on the Plan or Queue element (the dock's TodoQueueItem rows), lab `rail-plan`; the dock-hide rule in canvas with a docked rail lands in the wave's closing step, in AiPanel). Tests: the latest list wins across replies; it is kept after the turn; the same array across 50 TextDeltas; a trimmed input reads "Plan not recorded"; in canvas with the rail docked there is one list on screen (`rail-plan`, no `live-plan`), and with the rail closed the dock's shows as before.
- **M92.5 Changes** (`elements/conversationChanges.ts`, `rail/ChangesCard.tsx` with the Added group and PR rows, and AiPanel's `openDiff` flatMap moved onto the fold in the closing step). Tests: the adapter merge by run_id; no `<a href>`; the primary action jumps to the turn's changeset in canvas; the secondary open floats first; a deleted row opens `viewDiff`; the pending and not-recorded sentences; no "+0 −0".
- **M92.6 Sources** (`elements/railSources.ts`, `rail/SourcesCard.tsx`, the `rail-sources-all` layer). Tests: a streaming turn adds nothing; subagent sources count; partial on a failed transcript read; the primary action jumps to the citing reply; Escape returns focus.
- **M92.7 Thread status** (`agent/threadStatusStore.ts`; `agentIpc.ts` `runState` over the existing `agent_events_since` with `after=Number.MAX_SAFE_INTEGER` so no events are copied, through `faulted('agent_events_since')`, returning `unavailable` on reject, distinct from `unknown`; `listInteractions` through `faulted('list_interactions')`; the Done/Interaction/start listener; `ConversationSwitcher.tsx` chips; lab `conversation-status`, including an unavailable preset). Tests: a detached run's Done clears Working; an Interaction event re-reads cards; a rejected runState shows "Status unavailable"; the row's accessible name includes the status; the ipcContract keys; unknown shows no chip; after a restart nothing infers Working.
- **M92.8 Reach** (Rust chain 2: `agent/mod.rs`, `connector_signals.rs`; TS `types.ts`, `transcript.ts`, `conversations.ts`, `mockAgent.ts`). `AgentEvent::Reach` is built from the same `RunConnectors`/`RunApproval` as argv, and emitted only after the InitGate admits the first init; `ConnectorInit` comes from that init. Tests: `the_reach_event_names_exactly_what_the_prompt_names_missing`, `an_internal_run_emits_no_reach`, `the_reach_permission_mode_matches_argv`, `a_refused_init_emits_no_reach`; the reach fact survives save and load under quota; each event shows once on re-attach (CV-30).
- **M92.10 Unknown sync counts** (Rust chain 3, runs before M92.9: `git/remote.rs` returns Option counts, push's default kept explicit; `roots_git_commands.rs`; TS `GitRemoteStatus`, `rootsStore.ts`, `mockRoots.ts`, `mockGit.ts`, `engine/roots.ts`, `RootTree.tsx`, `StatusBar.tsx`, `SyncBadge.tsx`). Rule: an unknown ahead or behind never pulls, and the sync settles as "couldn't tell". Tests: a rev-list failure reads unknown; `rootsStore.test` holds that unknown never pulls.
- **M92.9 Connectors and Environment** (after M92.10: `elements/connectorRow.ts`, extracted from `ConnectorSettings.tsx`; `railConnectors.ts`; `railEnvironment.ts`; `useGit.ts` `readError` with the branch kept, plus its consumers; `ipc.ts` `readConnectors` through `faulted('read_connectors')`; `gitIpc.ts` `gitWorkspaceInfo`, `isGitRepo`, `gitRemoteStatus` through `faulted()`; `rail/ConnectorsCard.tsx`; `rail/EnvironmentCard.tsx`). The failure snapshot sets `readError` and leaves `isRepo` unchanged/unknown, never false. Tests: the shared derivation matches Settings; reasons are verbatim; the useGit failure is not `isRepo:false`; StatusBar offers no "Start tracking history" and ChangesPage shows unavailable on a failed read; "Sign in…" floats first.
- **M92.11 Handed off** (`ipc.ts` `fleetRunDetail` through `faulted()`, `elements/railHandoffs.ts`, `rail/HandoffsCard.tsx`, lab `conversation-handoffs`). Tests: polling stops when every run has ended or the rail hides; a null id reads "Run not recorded"; the primary action stays in canvas.
- **M92.12 Heal changes** (Rust chain 4: `conversation_changes(vault, session_id)` in `lib.rs` reads through `runtime::ReadOnly` (runs by `cli_session_id` and vault_id, then `run_writes`, then `run_commits`), then makes one bounded `git show -z -M --raw --numstat --format=` per commit, capped at 100 runs with `truncated`. It reuses changeset.rs's `parse_numstat_z`, with any raw parser added beside it, not a second module. It returns `RunChangeset` with `also_by`, `kept_out_of_git` and `shell_unrecorded` as None, drawn as "not recorded". TS: `gitIpc.ts` through `faulted('conversation_changes')`, `mockGit.ts`.) Tests: no `run_commits` row gives not_recorded even with a trailer (CV-35); not_a_repo lists the vault_writes paths; another vault's runs are excluded; the cap says so; the raw+numstat parser cases; one commit's live and healed changesets agree on paths, kind and counts; ipcContract (CV-18).
- **M92.13 Context transport** (Rust chain 5, Rust only, §4; waits on the owner's D4 answer and probe step P). Fake-CLI reader tests: the prompt arrives on stdin and the breakdown is filed; an unanswered ask closes after its wait; a CLI `control_request` closes stdin; a crash or init refusal closes stdin; a deferred turn asks, closes, exits 0, and its card is still announced; Stop within STOP_GRACE; a child holding stdin still lets the run end within CONTEXT_ASK_WAIT + STOP_GRACE after the reader's deadline. Rails: turn_input's closed enum and sole `take_stdin` (§4). Argv: seated stdin; every other run kind is unchanged (update mod.rs:4247/4683, tee, spike fixtures). Meter: a foreign or malformed response is ignored; dropped fields are gone; the caps hold; a newer reading with no breakdown replaces the old one; the journal never holds the line; the serializer replays `src-tauri/fixtures/context-breakdown.json`. sanitize: the `ANSWER_DROP` additions and their test. A real seated recording via record-cli (owner).
- **M92.14 Context card** (`agentIpc.ts` `breakdown?` wire type, `engine/ai/contextBreakdown.ts`, the mock's seeded breakdown, `src-tauri/fixtures/context-breakdown.json` (caps, names ≤ 128, non-finite values dropped), `elements/contextCard.ts`, `Context.tsx` gains `ContextCategories`, `rail/ContextCard.tsx`, lab `rail-context`). It lands before M92.13 and reads "Breakdown not recorded" in Tauri until the transport does. Tests: one figure shared with `contextUsageOf`; the parser replays the shared fixture; deferred rows read "not loaded"; a streaming turn shows "From the previous turn".
- **M92.15 Lab and e2e** (alone): the lab sections no earlier part created, `rail-changes`, `rail-sources`, `rail-connectors` and `rail-environment`, five presets each, over the commands their parts wrapped. The whole-rail Profiler test. Specs:
  - `e2e/m92-rail.spec.ts`: docked at 1440, drawer at 1100, a toggle survives reload, canvas↔floating↔canvas mid-turn keeps the turn, a subagent row jumps in canvas, a Sources or Changes secondary open leaves the destination visible, and (webkit) Tab from the composer through every card's controls and Shift+Tab back.
  - `m92-thread-status.spec.ts`: a detached thread shows Working, then clears. The "Working for" line ticks on a held clock and shows "Waiting for your answer" while a card waits.
  - `m92-rail-changes.spec.ts`
  - `m92-context-card.spec.ts`
  - The existing `chat-canvas.spec.ts` passes with the rail open.
  - Add `m92-rail.spec.ts` to webkit's `testMatch`.
- **M92.16 Docs and rails** (see §7).

## 6. Waves

| Wave | Parts (→ = serial) | Gate |
|---|---|---|
| W1 | M92.1 ∥ M92.3 ∥ M92.0 → M92.2 (Rust 0, 1) | lint, typecheck, unit, cargo (skip list), clippy, fmt |
| W2 | M92.4 ∥ M92.5 ∥ M92.6 ∥ M92.7 ∥ M92.17 ∥ M92.8 (Rust 2) | same + the 43 panel specs + the Profiler test |
| W3 | M92.11 ∥ M92.14 ∥ M92.10 (Rust 3) → M92.9 → M92.12 (Rust 4) | same + targeted e2e |
| P | probe step P: DONE 2026-10-23 (D4 approved) | notes updated |
| W4 | M92.13 (Rust 5) | full cargo + the transcript goldens |
| W5 | M92.15 alone → M92.16 → multi-lens review → fixes → final gate vs the M91 baselines → verify-ui | full gate |

One Rust agent at a time, chain 0→5. Each Rust part's TS twin travels with it, so `types.ts`, `transcript.ts` and `conversations.ts` change in order. TS parts in a wave own disjoint files; M92.9 follows M92.10 because both touch SyncBadge, StatusBar and the git mocks. M92.4 and M92.5 never touch AiPanel; the closing step wires them in.

Verify commands:

- `pnpm test:run <files>`
- `cd src-tauri && cargo test <name> -- <skip list>`
- `cargo clippy --all-targets -- -D warnings`
- `PORT=5273 pnpm e2e e2e/m92-*.spec.ts --project=chromium`, then `--project=webkit` for `m92-rail`

**verify-ui.** Canvas at 1440×900, 1280×800, 1100×800 and 1024×768 (sidebar open and collapsed), in light and dark. Capture: rail docked; drawer open; a fresh conversation (no card bodies); every card ready; Context not recorded; a subagent running then done; a Waiting chip in the list; reduced motion. Screens go in `scratchpad/m92-screens/`.

## 7. Docs, owner steps, open calls

**Docs.**

- AGENTS.md:
  - Shell paragraph: the canvas rail, its width rule, that it lives in canvas only, and that its rows act in canvas and float before opening a page.
  - Repo map: `src/agent/rail/`, `turn_input.rs`, `conversation_changes`.
  - CV-27: the Tally also reads the context control response.
- New **CV-65 A seated run's stdin closes on every exit path, and carries only a prompt or the context ask**, enforced by the M92.13 fake-CLI tests and the turn_input rails test (only if M92.13 lands).
- SECURITY.md: stdin input for seated runs, and that it carries only `Prompt` and `get_context_usage` (no permission, interrupt or approval messages); the breakdown is memory only, and paths and tool names are dropped; the mail footnote's exact-name limit.
- CV-11 rewrites: spawn.rs's "nothing Cerebro starts is interactive", usage.rs's "One count" and "telemetry does not ride the channel" (now `duration_ms` does), meter.rs's matching doc, kinds.rs `STREAM_JSON_ONLY`, and the one-column canvas comments.

**Owner steps.**

1. Commit M91 first, then stage and commit M92 one wave at a time.
2. Use record-cli to record a seated stdin turn, and delete the `~/.claude/projects/*probe-context*` sessions.
3. Check ⌥⌘R in a packaged build (it may collide with a menu accelerator).
4. Smoke test with `pnpm tauri dev`: a research turn with subagents, the rail at full screen, a detached thread's chip, and Context after a turn.

**Open owner calls.**

- O1 **D4**: ANSWERED yes (2026-10-23). Seated runs move to `--input-format stream-json` after probe step P.
- O2 **Q7 widening**: ANSWERED yes with O1. The rail shows the category breakdown and per-server MCP totals; tool names and memory-file names stay hidden.
- O3 **One figure**: TAKEN BY DEFAULT yes. When a breakdown exists, the composer ring uses the CLI's total/max, so the ring and the card agree.
- O4 **Worked for**: CLI working time (default), or wall time from send to end (that needs session-file stamps and includes your waits)? Either way `duration_ms` rides the journaled Result event, a second widening of the "telemetry does not ride the channel" rule after Q7's context count. OK?
- O5 **Chips**: Working and Needs you only (default), or Failed and Stopped too? Sort the list by latest activity instead of creation?
- O6 Save each reply's durable run ids and add a `parent_run_id` filter to `fleet_runs`, so follow-ups and wakes appear under Handed off?
- O7 Rail width: fixed 300 (default), or resizable like `aiPanelWidth`?
- O8 ANSWERED (2026-10-23): a rail Plan card, kept after the turn ends (Q11, M92.17).
- O9 ⌥⌘R (default; ⌥⌘B is claimed by the composer as bold)? A different key, or make `claimsKey` stand down for alt+mod (a global keymap change)?
- O10 Does the mail footnote also need to name the legacy and shell exceptions inline?

## 8. Risks

- M91's review fixers are editing AiPanel.tsx, App.tsx, ConversationSwitcher.tsx, shellLayout.ts and panelPlan.ts. Line numbers here will drift, so M92 starts only after their gate.
- A stored `live` that was never cleared must not read as Working. After a restart the journal answers unknown, which shows no chip.
- A card asked before Init has no sessionId. Match it by the reply's `live.run` as well.
- An open stdin with no elapsed watchdog leaks a child, its slot and its bearer. A tool child inheriting the pipe would deadlock until the watchdog (P13). M92.13 tests every exit path.
- Summed per-run counts include the person's earlier uncommitted edits (`commit --only`). Live rows show `also_by`; healed rows read "not recorded".
- Rail props must be referentially stable, or every token re-renders the rail. Each wave's closing Profiler test holds this.

## Review notes

Critique amendments (2026-10-23) folded in: canvas-safe navigation (primary in canvas, secondary floats first), ⌥⌘R, faulted() wrapping per owning part, Waiting and runState unavailable, unknown sync counts and the git failure snapshot (M92.10 → M92.9), probe P13–P16, the closed turn_input enum, healed changesets on `parse_numstat_z` with None fields, the Profiler test in closing steps, the breakdown contract moved to M92.14 with a shared fixture, `ANSWER_DROP`, `AgentEvent::Reach` after the InitGate, Outputs dropped, quiet empty cards, "Conversation details", the toggle and tabIndex fixes, DrawerScrim, honest Working/Worked lines, chip placement, PRs under Changes, Context freshness, and wider verify-ui sizes. Nothing declined.

- ⌥⌘R over making `claimsKey` stand down for alt+mod: the narrower change; the global one stays open as O9.
- Waiting's "hidden when no card" is kept for the empty state only; a failed read always shows.
