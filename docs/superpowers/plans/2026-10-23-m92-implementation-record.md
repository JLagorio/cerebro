# M92 implementation record

M92 ([plan](2026-10-23-m92-conversation-rail.md)): the canvas conversation gets a "Conversation
details" rail, the conversation list marks threads that are working or waiting, each turn says
how long Claude Code worked on it, and a conversation you watch takes its prompt on stdin so Claude
Code can say how full its context is. Built 2026-10-23 in five waves after probe step P. Each wave
was gated against the M91 baselines; every failure outside them was traced to other milestones'
work in progress or to load. The build never staged, committed or pushed. The owner's checkpoint
commits `2e47d0f` and `6c92709` hold W1–W3 in part; the rest is unstaged on `m53-macro-port` (see
Commits).

## Delivered

| Part | Delivered |
| --- | --- |
| M92.0 | Every argv run puts its message last, after `--`, so a message that starts with "-" is the prompt and never a flag (P10, a live bug). An answer's resume ends `--resume <id> -- ""` (P5b). kinds.rs and the fold ignore `command_lifecycle` (P17), so an answer's resume no longer writes a drift row. |
| M92.1 | The canvas frame. The aside is a grid of header, transcript and rail, so nothing remounts. The rail docks at 300px where the `chat-canvas` container is at least 960px wide, folds away below that (mounted, inert, reading nothing) and opens there as a non-modal drawer for the session. The header toggle "Conversation details", `assistant.rail` (⌥⌘R) and floating's "Expand with conversation details" reach it; only the docked toggle writes `cerebro.chatRailOpen` (on by default). It stays unmounted while a new conversation welcomes, unless opened. `openOutside` floats before a secondary open. New presentation-only `Rail` and `RailSection` elements. |
| M92.2 | "Worked for 4m 12s · N steps" in a settled reply's chain header: the sum of its runs' `result.duration_ms`, which rides Result and ToolDeferred, counted once per run, and null once any run counted none. A live, aria-hidden "Working for …" line from the run's start; "Waiting for your answer" while a card waits; "Working…" when the start is unknown. |
| M92.3 | Pure engine. `threadStatus.ts` ranks the open thread's own flags, then a waiting card by session or attach key, then the journal, and keeps idle, unknown and unavailable apart. `conversationChanges.ts` sums each run's commit file by file into a net kind across turns, with the Added group first and null counts, never "+0 −0". `mergeSources` and `sourceKey` in `sources.ts`. |
| M92.4 | The Subagents and Waiting cards over `railSubagents` and `railWaiting`, which return the same object while nothing they show changes. `stepReveal`: a row opens its transcript line, scrolls once and focuses it. MessageScroller's public `scrollToElement`, `data-tool-id` on transcript rows, `tabIndex` passthroughs on Source, SubagentHandoff and FileTree, and `readCliTranscript` through `faulted()`. Lab `rail-subagents` and `rail-waiting`. |
| M92.5 | The Changes card over `railChanges`: a live or cached changeset wins per run id; Added first, then the rest, then pull requests with their forge.rs state. "across N turns", copied rows labelled, and pending, not recorded, uncommitted and unavailable each said. A row jumps to its turn's changeset in the canvas, its Open floats first, and a deleted file opens its diff. No href. |
| M92.6 | The Sources card: each finished reply's sources, newest reply first, five lines then "View all (N)" in the `rail-sources-all` layer. A line jumps to the reply that cites it; a vault page opens after the conversation floats. Partial when the transcript could not be read back, a done web call holds no result, or a subagent's steps were not kept. |
| M92.7 | Working and Needs you chips in the conversation list, inside each row's button. A memory-only store learns from one listener (a run's start, its Interaction and its Done, never a token) and from `listInteractions` and `runState`, both through `faulted()`. Unknown draws nothing, so nothing infers Working after a restart; a failed read says "Status unavailable" once. Lab `conversation-status`. |
| M92.8 | `AgentEvent::Reach`: what a run reaches, built beside `build_args` from the same values and sent once after the first init the gate admits, never for an internal run or a refused init. The reply keeps it in memory; a conversation saves the newest as its own fact (`threadReach`). |
| M92.9 | The Connectors and Environment cards on `connectorRow.ts`, now shared with Settings. "Sign in…" floats the conversation, then opens Settings at that connector. The mail footnote and the inherited-connector note. Environment names the vault, its branch and sync tone, who answers and the run's reach. `useGit` keeps the branch and reports `readError`: a failed read never sets `isRepo` false. Lab `rail-connectors` and `rail-environment`. |
| M92.10 | `remote_status` returns Option counts: no upstream, a failed count or an unreadable answer reads unknown ("Sync unknown", "↑? ↓?"), never Up to date. A mounted root with an unknown count never pulls; its sync settles as "couldn't tell". |
| M92.11 | The Handed off card: the 8 newest `hand_to` runs, each read through `fleetRunDetail` (through `faulted()`), polled every 15 s only while one runs and the rail can be seen. A null run id reads "Run not recorded". Lab `conversation-handoffs`. |
| M92.12 | `conversation_changes` (`git/conversation.rs`): a conversation's ended runs read back through `ReadOnly`, the commits `run_commits` records for them and one bounded `git show` each, capped at 100 runs. Healed changesets carry `also_by`, `kept_out_of_git` and `shell_unrecorded` as None, read as not recorded. `useChangesHeal` asks only while the rail shows. |
| M92.13 | Seated runs take their prompt on stdin, decided only by `run_input()`. `turn_input.rs` writes the prompt, one `get_context_usage` ask and the close, and nothing else, and stdin closes on every exit path (CV-65). The meter reads only the matching `control_response` into a memory-only `ContextBreakdown` with a hand-written Debug, paths and tool names dropped, replaying `context-breakdown.json`. kinds.rs control rows rewritten; the debug recorder keeps `<base>.stdin.jsonl`. |
| M92.14 | The Context card on the composer's own pull, one figure with the ring (O3): categories on a bar and a legend, deferred rows "not loaded", MCP servers folded, model, autocompact, memory files and when it was read. Without a breakdown it shows the count and "Breakdown not recorded". `contextBreakdown.ts` and the shared fixture `src-tauri/fixtures/context-breakdown.json`. Lab `rail-context`. |
| M92.15 | Lab `rail-changes` and `rail-sources`, five presets each. Sources gains not recorded and unavailable: with no line to show, a failed transcript read is unavailable and lost steps or results are not recorded. The transcript's hand-off line floats before it opens a run; RootTree's "↑? ↓?" reason is hidden text; `window.__cerebroMockContextBook`. `m92-rail.spec.ts` also runs on WebKit, with a Tab walk through all nine cards; new `m92-thread-status`, `m92-rail-changes` and `m92-context-card` specs. |
| M92.16 | AGENTS.md (the canvas rail in the shell paragraph, the repo map, CV-27, new CV-65), SECURITY.md (the message after `--`, stdin input, the memory-only context reading, Reach, the mail footnote), CV-11 rewrites of usage.rs's module doc and the stream reader's tally comment (M92.2 and M92.13 had already rewritten spawn.rs, meter.rs and kinds.rs), the plan's status line, the M91 record's commit line and this record. |
| M92.17 | The Plan card: the conversation's latest todo list across replies (`railPlan` over `latestTodos`), "n of m done", kept after the turn. A cut input reads "Plan not recorded"; a latest list that does not read shows the one before it. Lab `rail-plan`. |
| W2 closing step | Waiting, Plan, Subagents, Changes and Sources wired into the rail in Q5's order, from memoized views. The conversation lists sit behind a memo boundary and take the open thread's own flags. The whole-rail Profiler test. |
| W3 closing step | Handed off, Context, Connectors and Environment wired in. The dock's plan hides by CSS alone, only where the rail docks. A Reach after a journal gap applies. The Profiler test mounts all nine cards: zero rail and list commits over a 50-word stream. |

W1 and W4 had no closing step: W1 had no card to wire, and W4 was Rust only.

## Final gate (2026-10-23)

Five reviewers, one per lens (contracts, security, UI and accessibility, rules and docs, tests
and performance), read all of M92, and a skeptic tried to refute each finding. Of 17 findings, 7
were confirmed and all 7 are fixed; one became an owner call.

- **High: a message sent while a card waited was cut off.** A new message over an open deferral
  (sent while a card waited, or after Stop or a relaunch left one) went on stdin. Claude Code
  first finishes the held call, with a result of its own, so the context ask and close that
  result set off ended the person's turn about 2 s in. `run_input` now keeps such a resume on
  argv (`resumes_a_deferral`).
- **A line the reader could not parse left stdin open, and the run hung.** The reader now closes
  stdin on any unparseable line; the turn ends on EOF and loses only its breakdown.
- **A CV-65 test never ran on a Mac.** It was named `a_crashed_…`, which `--skip crash` drops.
  It is renamed `a_dead_runs_stdin_closes_with_its_stream`. A guard in
  `scripts/toolchain.test.ts` now fails when a rule's enforced test matches a skip.
- **A rail that folds read every card once on its first canvas frame**, before its width was
  measured (two findings, one fix). Cards now read only once the rail docks or a drawer opens.
- **An unparseable connector list read as an empty Connectors card.** It now reads unavailable,
  in Rust's words. Settings still draws it empty (see owner calls).
- **The Connectors card said Cerebro never learns your own servers' names.** That became false
  when a seated turn's breakdown started naming them, so the note is reworded.
- **Also fixed:**
  - a branch no longer inherits its source's Reach
  - Environment's reasons are text, not a title alone
  - a long source host no longer squeezes its title
  - the Profiler test counts after the rail's arrival settles
  - the record-cli skill names the `.stdin.jsonl` file
  - the Context lab note names why a breakdown is missing

The gate ran while other milestones (M93, M96, M99) were editing the same checkout:

- **Lint, typecheck:** clean.
- **Unit:** 17,394 passed, 2 failed. Both failures are in M93's new `RenameIdentity.test.tsx`. The
  11 baseline failures now pass.
- **Cargo,** with the crash skip list:
  - Every M92 test passes. `agent::` gives 574 passed and 9 failed; all 9 are in another agent's
    new `agent/readiness.rs` and pass when run serially (28 of 28).
  - The full suite, its doctests and clippy fail only in M96 and M99 work in progress
    (`workspace_service`, `workspace_migration`, `actions/recovery.rs`). Re-run them once that
    work settles.
  - `cargo fmt --check`: clean.
- **E2E, full suite:** 819 passed, 70 failed and 1 skipped, in 24.9 minutes at a load average of
  15–85.
  - 41 failures are the baseline.
  - Every other failure passed when run alone, or is in another agent's work: the run-history
    rewrite (3), M93's drafts (8), CreateMenu (1), WhiteboardView mid-edit (7), M93's editor (2),
    and surface-states' dark home-mywork preset under constant hot reloads.
  - Every M92 spec passed. On WebKit, `m92-rail` and `chat-canvas` gave 16 passed, including the
    nine-card Tab walk.
- **verify-ui:**
  - Light and dark at 1440, 1280, 1100 and 1024 wide, with the sidebar open and collapsed, plus
    reduced motion.
  - Covered: the rail docked and as a drawer, a fresh conversation, every card, the chips, and
    Worked for.
  - No horizontal overflow.
  - Two fixes: a card's name was cut short by its summary at 300px, and the dark rail's
    agent-type badge lost its pill.
  - Not checked: a packaged build.

## Measured on Claude Code 2.1.250

Live probes on 2026-10-23, with the owner's login, in scratch folders, with SendMessage and
ListAgents denied. Probe step P used Cerebro-shaped argv: a settings file, `--agents`, the prompt
tool, `--forward-subagent-text` and summarized thinking.

- **The context ask.** `get_context_usage` is answered only over `--input-format stream-json`
  with stdin open, by the run's own process; a separate resume process counts its own argv's
  tools. A turn is: write the user line; on `result`, write the request; the answer comes about
  0.3 s later; close stdin, and the process exits 0. Stdin left open after `result` waits for
  ever. A PreToolUse `defer` ends the turn with `result`, and the ask still answers. The
  `queue-operation` and `mode` lines this adds were already classified.
- **P1.** TERM mid-stream or mid-tool exits 143 within about 0.5 s, with no orphan. Stop's grace
  rests on it.
- **P2.** Closing stdin before `result` never aborts the turn, so closing on a CLI request is
  safe.
- **P3, P4.** A fork and a steer's resume both work with the prompt on stdin.
- **P5, P5b.** An answer's resume stays on argv: `-p … --resume <sid> -- ""` resumes the held
  call. On stdin, no line does nothing, and an empty line resumes and then runs an extra turn.
- **P6.** Argv and stdin turns write the same session-file shape, so replay and the transcript
  goldens are unchanged.
- **P7.** A full setup's categories, `mcpTools[{name, serverName, tokens, isLoaded}]`,
  `agents` and `memoryFiles[{path, …}]`: the shape the breakdown keeps and drops.
- **P8, P9, P12.** The ask answers within 0.4 s of `result`: after a subagent turn, after an
  error result, and at 168k of a 200k window as at 8k. `CONTEXT_ASK_WAIT` is 2 s.
- **P10.** `-p <message>` failed on a message starting with "-": "- buy milk" as an unknown
  option, "-v …" printing the version. M92.0 fixed it.
- **P11.** An unknown control request gets an error answer, and the next request still answers.
- **P13.** Under stream-json input, Bash children get EOF at once (`cat`, `read`,
  `git credential fill`): no tool child holds the run's stdin.
- **P14.** `duration_ms` includes a live ask's wait (12,213 ms with an 8 s wait), so "Worked
  for" includes your waits on live asks. A deferral ends its process, so that wait is not
  counted.
- **P15.** Init lists the same tools, agents and servers in both modes, once per process, so
  the init gate holds both.
- **P16.** A CLI `control_request` answered by closing stdin refuses the call, and the turn
  completes with exit 0.
- **P17.** Only an answer's resume streams two `command_lifecycle` lines.

## Commits (CV-02 subjects, one per part)

The owner's checkpoints already hold most of M92: `2e47d0f` ("big lift", 10:36) holds M91, W1
and most of W2, and `6c92709` ("pre M93 rollback", 14:39) holds the rest of W2 and W3's M92.9,
M92.10, M92.11, M92.14 and most of M92.12. Unstaged after `6c92709`: M92.12's last mock comment,
W3's closing step, W4, W5 and the final review's fixes. The checkpoints cut across parts, so these
subjects fit best as the body of the commit that takes the rest, or the owner's own split.

- **W1:**
  - `fix(agent): put a run's message last, after --, so a dash-led message is the prompt (M92.0)`
  - `feat(agent): frame the canvas conversation's details rail (M92.1)`
  - `feat(agent): say how long Claude Code worked on a reply, and how long it has been working (M92.2)`
  - `feat(agent): fold thread status, conversation changes and merged sources (M92.3)`
- **W2:**
  - `feat(agent): rail Subagents and Waiting cards that jump into the transcript (M92.4)`
  - `feat(agent): the rail's Changes card, its added files and pull requests (M92.5)`
  - `feat(agent): list the conversation's sources in the rail, with View all (M92.6)`
  - `feat(agent): mark working and waiting threads in the conversation list (M92.7)`
  - `feat(agent): say what a run reaches, from the values its argv is built from (M92.8)`
  - `feat(agent): keep the conversation's plan in the rail (M92.17)`
  - Closing step: `feat(agent): wire Waiting, Plan, Subagents, Changes and Sources into the rail (M92.1)`
- **W3:**
  - `fix(git): read an uncounted ahead or behind as unknown, never Up to date (M92.10)`
  - `feat(agent): the rail's Handed off card follows the runs a conversation handed off (M92.11)`
  - `feat(agent): rail Context card with Claude Code's category breakdown (M92.14)`
  - `feat(agent): give the rail its Connectors and Environment cards (M92.9)`
  - `feat(rail): read a conversation's changes back from runtime.db and git (M92.12)`
  - Closing step: `feat(agent): the rail holds every card, its dock plan hides only where it docks, and a Reach lands after a gap (M92.9, M92.11, M92.14)`
- **W4:**
  - `feat(agent): seated runs take their prompt on stdin and answer the context ask (M92.13)`
- **W5:**
  - `test(agent): lab sections and e2e for the rail, Sources' last two states, and the hand-off line floated first (M92.15)` (its report carried no subject; this one is the record's)
  - `docs(agents): the rails name the conversation rail and the seated run's stdin, and CV-65 closes it on every exit (M92.16)`
- **Final review:**
  - `fix(agent): keep a message sent over a waiting card on argv, close stdin on a line the reader cannot parse, and read nothing while the rail measures (M92.18)`

## Owner steps

1. Stage and commit what is unstaged (above), after the final review. The build never touches
   the index.
2. **M92.R.** `scripts/cli-record/` is the owner's:
   - Record a real seated stdin turn with `record-cli`.
   - Teach `sanitize.ts` and `scan.ts` the `<base>.stdin.jsonl` file. Its prompt line is your own
     words, to sanitize like a session file's prompts; the ask line holds only `ctx-<run>`. Both
     should refuse memory-file paths there and in `.stream.jsonl`.
   - Add to `ANSWER_DROP`, each with its reason: `memoryFiles` (paths), `mcpTools` (tool and
     server names), `gridRows` (the terminal grid) and `messageBreakdown.toolCallsByType` (tool
     names). Consider `agents` too, which can hold your own agent names. Add a sanitize test from
     the probe's answer shape; `context-breakdown.json`'s first case is a model.
   - Check whether `sanitize.ts` or `reduce.ts` take the prompt from the argv element after
     `-p`. Since M92.0 the message is the last element, after a lone `--`, and a seated run's
     argv carries none.
3. Check ⌥⌘R in a packaged build: it may collide with a menu accelerator.
4. Smoke test with `pnpm tauri dev`:
   - a research turn with subagents at full screen, with the rail docked and as a drawer
   - a detached thread's Working chip, and Needs you while a card waits
   - Context after a turn, with its breakdown
   - a message that starts with "- "
   - Stop mid-turn, and an ask answered and resumed
5. Delete the probe sessions under `~/.claude/projects/` whose names contain `scratchpad-probe`.

## Open owner calls

- **From the plan.**
  - **O4, Worked for.** Built as Claude Code's working time. `duration_ms` now rides the
    journaled Result and ToolDeferred events, a second widening of usage.rs's channel rule
    after Q7's context reading. It includes your waits on live asks (P14). OK, or wall time from
    send to end?
  - **O5, chips.** Built: Working and Needs you only, and the list keeps its order. Add Failed
    and Stopped? Sort by latest activity?
  - **O6, Handed off phase 2.** Save each reply's durable run ids and filter `fleet_runs` by
    `parent_run_id`, so follow-ups and wakes appear under Handed off?
  - **O7, rail width.** Built fixed at 300px. Make it resizable like `aiPanelWidth`?
  - **O9, the key.** Built as ⌥⌘R, since the composer claims ⌥⌘B as bold. Another key, or make
    `claimsKey` stand down for alt+mod (a global keymap change)?
  - **O10, the mail footnote.** It names only the exact-name limit; SECURITY.md states the
    exceptions. Should the line name the legacy and shell exceptions too?
- **Decided by default, for the owner to confirm.**
  - A folded rail (canvas under 960px, setting on, no drawer) stays mounted and inert and reads
    nothing, so crossing 960px never remounts it.
  - Folding the docked Plan card by its heading keeps the dock's plan hidden; the card's count
    still shows.
- **Raised by the waves.**
  - Two catalog commands share the label "New capture" (`capture.new` and `create.capture`), so
    a catalog-wide unique-label test waits on a rename.
  - The vault status bar's Sync pulls whatever the counts say: "unknown never pulls" covers
    mounted roots only.
  - A new conversation's rail, once opened, shows Environment's "not recorded" body, and
    Connectors' when its switch is on, which M92.1's "no card bodies" did not foresee.
  - Healed changesets could say `shell_unrecorded` exactly (`writes_booked = 2`); they say not
    recorded.
  - A recorded commit git cannot show makes the whole Changes card unavailable for good, for
    example after history is rewritten outside the app. The alternative is a per-run degrade.
  - An invalid `connectors.json`: the rail now says the list cannot be read, in Rust's words.
    Settings still draws it as an empty list, since it parses the list itself. Make Settings say
    so too?
  - `gitIpc` wraps `git_workspace_info` and `git_remote_status` in `faulted()`, though no preset
    fails them. Drop the two wraps, or reword the "wraps exactly what its presets fail" headers
    in `ipc.ts` and `mockFaults.ts`.
  - The dark theme's option colours sit above the dataviz lightness band.
  - A slow SessionEnd hook in your own Claude Code settings now gets 2 s after stdin closes
    before TERM; an argv run has no such bound.
  - Done waits for the context ask: about 0.3 s, at most 2 s plus the exit wait.
  - A message of only blanks stays on argv.
  - The stdin driver reads raw stream lines (`result` and `control_request`) to pace stdin. Name
    it in CV-27 beside the Tally, or route it through the Tally?
  - The Changes heal reads every run's commits again at each turn end and each time the rail
    shows, with no cancellation. It is cheap, so it was kept.
  - At 300px, Changes' pending words wrap ("land when this turn ends"). Shorter words? A
    source's host truncates under a 45% cap.
  - Another agent changed `ChatTurn.tsx`, `transcript.ts`, `types.ts` and `conversations.ts`
    (its childAvailability work) while the final gate ran. M92's suites pass on that tree, but
    those changes were not reviewed here.
  - Changes draws its unavailable sentence as a plain line, while Sources, Context, Connectors
    and Environment use StateMessage with an icon.
  - The new words are the builders' and yours to change: "Sync unknown", "↑? ↓?", "couldn't
    tell" and `UNCOUNTED_WORDS` (M92.10); `RAIL_CHANGES_WORDS`, among them "Added", "Changed",
    "no line changes" and "not committed" (M92.5); Handed off's heading by state and its rows'
    outcome word and duration (M92.11); `RAIL_CONNECTORS_WORDS` and `RAIL_ENVIRONMENT_WORDS`
    (M92.9); "Plan not recorded" and "Couldn't read the plan" (M92.17); "Sources not recorded",
    "Sources unavailable" and RootTree's hidden reason (M92.15). "Working for 1m 5s" uses the
    shared `formatDuration`, not the plan's "1m 05s".

## Known gaps (left for a dedicated change)

- Unmeasured until M92.R:
  - a real Cerebro seated stdin run, end to end (the transport rests on probe step P and the
    fake-CLI tests)
  - whether a background task's continuation reports a cumulative `duration_ms` (unlikely:
    background tasks are off on every run but internal ones)
- A turn resumed after an answer runs on argv (P5), so its reading carries no breakdown, and
  Context reads "Breakdown not recorded for this turn" until the next turn on stdin. A Claude
  Code older than the gate never gives one.
- "Worked for" shows only in a reply's chain header, so a reply with no chain shows none. A run
  whose result failed folds to an Error with no count, so its reply shows none. The mock's held
  calls carry no count.
- Healed changes: Rust cannot name each run's reply (a run records only its session), so healed
  runs account for the oldest replies first and "not recorded for k turns" is a lower bound.
  `run_commits` has no index on `run_id`. A no-history run whose writes were all mail reads not
  recorded with an imprecise wire reason. The fold does not sum `kept_out_of_git`; each turn's
  own footer still shows it.
- The browser heal returns nothing unless a spec seeds `__cerebroSeedFleet` and
  `__cerebroSeedGitHistory`.
- A connector's status on the rail is Settings' newest observation, not the run's own start, so
  a new connector's first turn reads "not observed yet" until the turn ends.
- The drawer's ghost exit has no e2e, since specs run with reduced motion.
- React rounds the aside's measured width, so between 959.5 and 960px React and CSS could
  disagree about docking. Widths are whole pixels with no zoom, so it has not been seen.
- A Sources jump focuses the reply's Sources fold; it does not open the fold to the cited row.
- A reveal ask that no line takes waits until a newer one replaces it. A subagent line whose run
  did not survive a reload scrolls and takes focus, but does not unfold.
- A reply whose rebuild after a journal gap failed may lack later todo calls, so Plan could show
  an older list as ready.
- The status listener binds when a conversation list first mounts; runs started while the
  assistant was closed at launch are recovered by the list's `runState` reads. A card cancelled
  with no event and no change to the thread keeps its chip until the next change.
- A transport failure in `loadGitStatus` keeps the stale status, and a root's sync decides on it
  (older than M92.10).
- The Context card draws nothing while its pull loads, so the cards below it shift once per
  thread switch. A row with no recorded count takes no share of the bar; its legend says so.
- The plan's §2 Sources row lists "transcript unavailable" under partial. As built, with no line
  to show it is unavailable, or not recorded when a reply lost its steps or results; partial is
  kept for a list that has lines.
- `e2e/state-lab.spec.ts` timed out in `page.goto` on other milestones' presets at load averages
  of 47–68, and passed alone.
- A Stop pressed during the context ask, in the 0.3 s after a reply's result, marks the finished
  reply Cancelled. The one-line fix could leave a stopped deferral waiting, so it needs its own
  analysis.
- A turn that never started counts as "Changes not recorded".
- No test drives a seated resume over an open deferral end to end; the `run_input` cases hold
  the decision.
- The permission card prints its tool name twice (M91, seen in both gates' screenshots).
