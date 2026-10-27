# M91 implementation record

M91 ([plan](2026-10-22-m91-ai-elements-and-subagents.md)): every AI interaction draws with
shadcn's AI Elements, and Claude Code's subagents run as governed workers of their run. Built
2026-10-22/23 in seven waves, each gated green against the baseline, then a five-lens review
with an adversarial verification of every finding, the fixes, and a final full gate. The build
never staged, committed or pushed; the owner committed it on 2026-10-23 in `2e47d0f` ("big
lift"), with M92's first waves.

## Delivered

| Part | Delivered |
| --- | --- |
| M91.1 | The tool manifest admits only the built-ins a run's plan names; an init offering an unknown built-in stops the run. SendMessage and ListAgents are denied everywhere. |
| M91.2a–d | `shared/policy/subagents.v1.json` (env caps: foreground, depth 1, 2 at once, 8 a session, no built-in types) and the `delegate` ceiling. `cerebro-researcher` is the one allowed type; every other type is denied by name (`agent/cli_agents.rs`, fail-closed). One `--settings` file per run. Metering books the whole tree from `modelUsage`. Settings → Subagents switch. |
| M91.3a–b | `fold.rs` folds reasoning, structured results, denials and turn anchors from both formats; a subagent's lines fold apart under their Agent call, live and replayed from `<session>/subagents/`. A subagent's writes commit with its run (CV-34). |
| M91.4 | `transcript.ts` keeps a reply's reasoning, words and calls in order as `parts`, with nested subagent runs. |
| M91.5 | `agent_context_usage` and a memory-only `ContextBook`; the composer's Context pulls it. |
| M91.6 | Branch from here: Rust forks the session at the turn's anchor (`CliSession::Fork`, `check_fork`). |
| M91.7–M91.10 | The elements ported under MIT onto the DS primitives in `src/components/ai/` (presentation only, CV-64); pure parsers in `src/engine/ai/`. |
| M91.12a–c | Composer as Prompt Input, Model Selector, Context, Suggestions and Queue; Confirmation cards and a one-page Questionnaire; the conversation as Chat with Branch from here and the live plan. |
| M91.13 | Every assistant turn draws through `agent/ChatTurn.tsx` in all three presentations. |
| M91.14a–d | Run lists, run transcripts, comments, Ask AI, the AI block, Review and Inbox cards, PR links and Knowledge as Sources, review notes as a Queue. |
| M91.15 | Lab sections `assistant-transcript` and `context-use` (five presets each), and nine `e2e/m91-*.spec.ts` files on a held Playwright clock. |
| M91.16 | AGENTS.md (CV-27/29/34 rewritten, CV-64 added), SECURITY.md, the policy README and THIRD_PARTY_NOTICES. |
| M91.17 | Composer attachments copied in through the CV-56 doors on send; Undo on the send's toast. |

## Final gate (2026-10-23)

- Lint: clean. Typecheck (app, tools, engine): clean. Prettier: all 878 changed and untracked files.
- Unit tests: 15,973 passed. The 11 failures are the pre-M91 baseline:
  - `ConceptTable` planFor ×8
  - `sidebarChrome` rowClass
  - `ListPage` M65.4
  - `TypePage` visit state
- Cargo, with the crash skip list: 3,876 passed, 0 failed. Clippy and fmt: clean.
- E2E, full suite: 769 passed and 42 failed, against a baseline of 756 passed and 42 failed.
  - 41 of the failures are pre-M91 baseline failures.
  - `agent-assignment.spec.ts:5` failed once under load and passed alone 3/3.
  - `state-lab.spec.ts:26` failed in the baseline and now passes.
- verify-ui: 19 light and dark captures with nothing broken. They were kept outside the repo, in the build session's scratchpad.

The final review found 27 issues and confirmed 9; all 9 are fixed:

- A panel reopened mid-turn lost its earlier subagent steps.
- A running run's detail read its subagent as interrupted.
- The plan vanished while a card waited.
- Subagent titles were cut to "Rea…" at 380px.
- The model and effort popover's Tab order was wrong.
- Every token re-rendered every turn.
- A streaming code fence re-highlighted on every token.
- CV-64 was broken through Attachment.
- A docs gap about held-clock e2e.

## Measured on Claude Code 2.1.250

These are live probes with the owner's login, run in scratch folders with SendMessage and ListAgents denied.

- **Subagent tool.** The tool is `Agent` (init lists `Task`). By default it runs in the background; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` makes it foreground.
- **Subagent lines.** `--forward-subagent-text` streams subagent lines with `parent_tool_use_id`. Session files keep subagents in `<session>/subagents/agent-<id>.jsonl`.
- **Flags.** `--agents` JSON (with `background:false`) and the `--settings` hardening keys are accepted. With built-ins disabled, init lists only `cerebro-researcher`.
- **Thinking text** is empty unless `--thinking-display summarized`.
- **Forking.** `--resume <sid> --resume-session-at <uuid> --fork-session` forks a session.
- **SendMessage and ListAgents** need no permission and can reach another Claude Code session on the Mac. M91.1 denies them on every run.
- **Packaged-app keyboard.** Wry 0.57 sets `WKPreferences.tabFocusesLinks = YES`, so in the packaged app Tab reaches links and buttons. Playwright's WebKit does not, so `tabIndex={0}` on element buttons only keeps the WebKit specs honest.
- **Context and argv probes for M92** are summarized in the [M92 plan](2026-10-23-m92-conversation-rail.md) §4. One of them, P10, is a live bug today: a message starting with "-" fails as an unknown option. M92.0 fixes it.

## Commits (CV-02 subjects, one per part)

The parts share files, so one hunk-free commit per part is not possible. Suggested:

- one commit, `feat(ai): AI Elements everywhere, and subagents done properly (M91)`, with these subjects as its body
- or the owner's own split by area

The subjects, by wave:

- **W1:**
  - `fix(policy): admit only the Claude Code built-ins a run's plan names (M91.1)`
  - `feat(ai): build the AI element foundation on Cerebro primitives (M91.7)`
  - `feat(engine): read test runs, stack traces, changed-file trees, sources and todos for the AI elements (M91.10)`
- **W2:**
  - `feat(agent): fold reasoning, structured results, denials and turn anchors from both formats (M91.3a)`
  - `feat(ai): port the conversation elements onto Cerebro's primitives (M91.8)`
  - `feat(ai): draw tool calls, subagents, commands, test runs and stack traces as trace steps (M91.9a)`
  - `feat(agent): fold subagents under their Agent call, live and replayed, and commit their writes with the run (M91.3b)`
  - `feat(ai): draw plans, queues, sources, citations, changed files, branch points and approvals as trace elements (M91.9b)`
- **W3:**
  - `feat(policy): give subagents their own ceiling, pinned agent types and a researcher preset (M91.2a)`
  - `feat(agent): start subagents only as Cerebro's researcher, from one settings file per run, deny every other agent type and keep a loopback worker for the ask gate (M91.2b)`
  - `fix(metering): book a run's whole tree from modelUsage, and a delegated run without it as unknown (M91.2c)`
  - `feat(agent): reduce turns into ordered parts with nested subagent runs (M91.4)`
  - `feat(agent): ask through Confirmation cards and a one-page Questionnaire (M91.12b)`
  - `feat(writing): comment turns, Ask AI, the AI block, sheet asks and citations on the AI elements (M91.14b)`
  - `feat(review): draw decisions as Confirmations, concept sources as Sources and asks as Suggestions (M91.14c)`
- **W4:**
  - `feat(agent): let the composer pull how full a conversation's context is (M91.5)`
  - `feat(agent): branch a conversation from a turn into a forked session (M91.6)`
  - `feat(agent): draw every assistant turn with the AI elements (M91.13)`
  - `feat(agent): the Subagents switch reaches every panel turn, and a page says who may hand reading to a researcher (M91.2d)`
- **W5:**
  - `feat(agent): draw the composer as Prompt Input, Model Selector, Context, Suggestions and Queue (M91.12a)`
  - `feat(agent): the conversation scrolls as a Chat, offers Branch from here between turns, and shows its plan while it works (M91.12c)`
  - `feat(status): draw runs as trace lines, a run's transcript as the panel's turn, and wakes and follow-ups as queues (M91.14a)`
- **W6:**
  - `feat(agent): attach files to a conversation, copied in on send (M91.17)`
  - `feat(agent): draw the panel's pull requests and Knowledge as Sources and its review notes as a Queue (M91.14d)`
  - `docs(agents): the rails name the AI elements and subagents, and CV-64 keeps the element layer presentation only (M91.16)`
- **W7:**
  - `test(assistant): lab sections and e2e for every AI element in use (M91.15)`
  - Final review: `fix(assistant): heal re-attached turns, keep a live run's subagents running, and memoize turns (M91.18)`

## Owner steps

1. Stage and commit M91 (above). The build never touches the index.
2. **M91.R:** record real seated runs with `record-cli`. That covers a research turn with subagents, a summarized-thinking turn and a forked branch, which settle the four unmeasured shapes below.
3. Run `pnpm tauri dev` as a smoke test:
   - a research turn with subagents in each presentation
   - Branch from here
   - an attachment and its Undo
   - Settings → Subagents off
4. Delete the probe sessions: `~/.claude/projects/-private-tmp-claude-501--Users-joseflagorio-Development-cerebro-5a6976a9-*-scratchpad-probe-*`.

## Open owner calls

- **Subagents.**
  - A symlink in the person's agents folder that leads outside it withdraws subagents for the run (stow users).
  - The panel doesn't say when subagents were withdrawn.
  - Organization-managed agents are not enumerated, so init fails closed.
  - The agent-type stop reuses `messages.unknown_tool`.
- **Composer and turns.**
  - Attachment Undo is on the toast only, not ⌘Z.
  - A branch copies changesets.
  - Long threads show many Checkpoints.
  - Message actions (Copy, Retry, Edit, Branch) are not wired in the panel.
  - Several TodoWrite calls show one Plan each.
  - "Thinking…" shows only until the first line.
  - CitationChip shows no visible `[^id]` marker.
  - A stale question card's notice sits below its buttons.
  - Comment @agent turns show no reasoning.
- **Runs and Review.**
  - Run-list ink, nesting and duration changes.
  - `abandoned_usage_unknown` reads as its record word.
  - TestResults says "Showing N of M failures".
  - The PR line reads "Opened N pull requests".
  - AgentProperties has no Subagents row.
- **CV-04 follow-ups.**
  - Which attachments `read_document` opens is typed in TS (`systemPrompt.ts`) and in Rust; it needs a reader column in `kinds.v1.json`.
  - The kind→reader map is typed in TS.
- **Metering.** `total_cost_usd` on CLI ≥ 2.1.277 resumed sessions.
- **Not M91.**
  - `run-options.spec:23`: the icon picker has no visible label.
  - `os-drop.spec` pins `NO_DROP_ZONE` wording.
  - `FileLightbox.test` flakes under load.
  - KnowledgePanel files scope descriptors as "vault".
  - InboxPage's organize memo recomputes on every snapshot.
  - AiActionCard offers "Open <query>" for search rows.

## Known gaps (left for a dedicated change)

- Unmeasured until M91.R:
  - `toolUseResult` in subagent transcripts
  - fork session-file copying
  - the "killed" and "failed" subagent words
  - the "Exit code 1" prefix
  - committed recordings carry `modelUsage {}`
- Text streamed before a re-attach duplicates until Done.
- A busy thread trimmed for quota loses its earlier turns.
- The localStorage trim cascade repeats on every save.
- Sources' title lookup is linear.
- No test reaches `Withdrawn::TooMany`.
- The e2e "no token count" checks are tautological.
- Context's accessible name omits its visible figure when the window is unrecorded (WCAG 2.5.3).
