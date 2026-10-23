# Chat and agent experience: one conversation, inspectable work, useful results

Proposed design, 2026-10-22. This is a source-derived interaction plan, not rendered
visual validation. No application code or tests were changed or executed. It
extends the [expansion plan](../2026-10-22-ai-expansion-plan.md), using the moving
M91 working tree and the AppFlowy, n8n and Plane snapshots. Reconcile the
[M91 audit](m91-current-state.md) with Claude's next handoff before scheduling its
unfinished work again.

The main investment should make one complete task understandable: choose material
and capabilities, ask, follow delegated work, decide on proposed effects, use the
answer, and recover it later. More standalone AI components will not establish
that journey. Keep Cerebro's existing assistant, editor, page frames, agent pages
and run details; improve the information and transitions between them.

## What already exists, and what actually needs work

| Experience                            | Current evidence                                                                                                                                                                                           | Ownership of the next step                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| One conversation across presentations | [AiPanel](../../../../src/agent/AiPanel.tsx) retains the assistant across floating, docked and canvas presentations; conversation drafts and context have existing ownership                               | Preserve this during M91 adoption; do not mount a second chat for an artifact or workflow                               |
| Explicit scope and composition        | [ChatInput](../../../../src/agent/ChatInput.tsx) supports page mentions, Skill invocation, Agent recipients and context attachment; [context](../../../../src/agent/context.ts) builds bounded snapshots   | Existing parity; add an explanation of what was actually read                                                           |
| Waiting and changes                   | [PermissionCard](../../../../src/agent/PermissionCard.tsx), write/proposal cards and [TurnChangeset](../../../../src/agent/TurnChangeset.tsx) already expose decisions and recorded file changes           | Extend their contracts for account-bound external actions; do not replace them with generic success toasts              |
| Rich transcript and child work        | M91 adds [Subagent](../../../../src/components/ai/Subagent.tsx), sources, context and other presentation primitives                                                                                        | M91 owns reducer/persistence/production adoption; the audit records a parent-event mismatch in inspected consumers      |
| History                               | [ConversationSwitcher](../../../../src/agent/ConversationSwitcher.tsx) groups threads by place and supports rename/delete; [useConversations](../../../../src/agent/useConversations.ts) restores sessions | New work: durable identity, search, branch ancestry and explicit retention; finish M91 quota/recovery integration first |
| Workflow authoring                    | Existing Agent records, triggers, Skills, views and guarded writers supply useful primitives                                                                                                               | New work: typed actions and versioned execution; a graph editor is not the first dependency                             |

AppFlowy's [source selector][af-sources] makes scope visible and disables
unsupported source kinds. Its [answer-to-document service][af-save] shortens the
route from answer to owned content. n8n's [composer][n8n-prompt] exposes tool
selection per session or Agent, while its [artifact viewer][n8n-artifact] provides
selection and download. Plane's [selected-text AI menu][plane-ai] keeps proposed
edits near the selection. These are specific patterns to adapt; none proves that
Cerebro lacks chat, editing, context or approvals today.

## A clear control hierarchy

The default view should prioritize the current answer and next decision. Put
rarely changed configuration behind labeled controls; reveal technical details
when they help diagnose or verify work.

```text
Project review                       Conversation ▾   Presentation ▾

You  Review these sources and draft the project update.
     Context: Project + 3 sources                  Inspect

Assistant  I am checking the sources and the open work.
  Researcher · Checking release notes              Running ▾
  Researcher · Checked the project decisions       Done ▾

  Proposed update                                 Review changes
  Draft external follow-up · Work account          Review action

  Answer… [1] [2]
  Sources 2  ·  Effects 1 completed, 1 waiting
  Copy    Save answer…    More ▾

[Project ×] [Release notes · Ready ×] [PDF · Needs attention]
Ask a follow-up…
Add ▾   Capabilities 3 ▾   Claude / effort ▾         Send
```

This is a text wireframe, not a requirement for a new dashboard. In the floating
assistant, collapse secondary controls into labeled menus and a context summary.
In canvas, use its existing contextual navigation for conversations. An artifact
opens in the existing page/pane system; use a temporary inspector only for a
preview that is not yet a page. Keep page Details/Comments/History ownership
unchanged and avoid another permanently open sidebar.

| Surface              | Primary question                                      | Controls and destination                                                          |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| Composer             | What am I asking, with which material and capability? | Draft, attachments, context, capabilities/account selection, Send/Stop            |
| Turn                 | What did it conclude, and what needs me?              | Answer, source links, pending decisions, effects, expandable work                 |
| Run detail           | What happened and why did it stop?                    | Ordered steps, child identities, inputs, decisions, recorded outputs and recovery |
| Agent page           | What work may this Agent do?                          | Existing instructions/grants; assigned actions/accounts, runs and memory          |
| Workflow page        | What will this saved process do?                      | Step list, selected-step inspector, published version and runs                    |
| Settings connections | Why can this action not run?                          | Named account, capability health, repair, revoke and advanced MCP settings        |

## Journey 1: discover capabilities without learning tool names

A person asks to review an issue and prepare a reply. The Capabilities picker
groups useful actions by provider and connection: “Work account — Read issues”
and “Personal account — Read issues” remain distinguishable. Search uses human
verbs, provider names and action descriptions. Each row shows available,
sign-in-needed, unavailable or not permitted; selection is intent, never a grant.
Show the account beside an action wherever it can cause an effect.

Keep the existing distinction between a Skill, an Agent recipient and context.
A Skill is reusable instructions; an action is an executable capability; an Agent
is an identity with standing instructions and grants. Do not overload slash
completion into an unlabelled mixture. Its menus may link to these destinations
without erasing their different meanings. n8n's per-session/per-Agent toggle in
[ChatPrompt][n8n-prompt] supports this placement, but a UI toggle alone cannot
implement authority or account binding.

When no connection exists, offer “Connect account” or the advanced “Add MCP
server” flow with a return destination. After repair, restore the draft and
selection; require a fresh decision if the account or approved inputs changed.
Reuse [ConnectorSettings](../../../../src/app/ConnectorSettings.tsx), growing it
from configuration into connection lifecycle. Show last health observation and
what it checked; a successful transport handshake does not prove every action
works. Keep advanced headers/environment values out of previews and exports.

For the first release, offer a small named set of supported actions and explain
unsupported capabilities before Send. Broad marketplace browsing can wait until
the Rust catalog, credential references and invocation contracts exist. Follow
the [connector architecture](connectors-and-workflows.md) for those contracts.

## Journey 2: attachment readiness and an honest context receipt

Attach a page, a PDF and an image, then navigate to another page. The queued or
sent turn retains its original scope. Before Send, every attachment has a textual
state: preparing, ready, partly readable, unsupported or failed. Stored and ready
for this execution backend are separate facts. A failure preserves the file chip
and draft with Retry/Remove; it never silently removes the attachment. If sending
only ready files is permitted, make that a deliberate labeled choice.

M91 owns file chips/import-on-send and guarded file reading. Extend that work
with readiness; do not build a competing uploader. AppFlowy's source restrictions
and file states are useful precedents, described in [AF-01/AF-05](appflowy.md),
but upload completion alone does not establish that a model read the content.

“Inspect context” opens a per-turn receipt with three sections: selected material,
material included at start, and later reads. Record source identity/version,
snapshot time, any bounded excerpt, omissions/truncation and read outcome. Show
“not read” separately from “could not read.” Do not expose raw confidential prompt
assembly merely to populate an attractive token meter. M91's measured context
pull must distinguish recorded, not recorded and unavailable; a component ring
without that producer must not estimate precision it does not have.

Source links need exact passage anchors and stale-location fallback. The current
[source helpers](../../../../src/engine/ai/sources.ts) collect encountered URLs
and paths; a URL mentioned by the model is not proof of a supporting read. Label
encountered links separately until the read boundary produces evidence IDs. A
source opening preserves the draft, transcript position and selected turn.
Knowledge verification remains the existing explicit human action.

## Journey 3: watch work without losing the answer

Distinguish four visible things: brief assistant narration, the final answer,
tool/action status, and child contributions. Use ordered transcript parts so a
late child cannot replace the parent's answer. The [M91 audit](m91-current-state.md)
identifies this exact producer/consumer completion dependency. The same projection
must drive live, replay and restored conversations.

Each child row names its task, worker identity/type, state and last meaningful
activity. Expand for steps and its returned summary; the parent answer explains
what it used. One child failing should leave other successful contributions
visible. Display recorded timing and tool counts, with unknown where missing.
Whole-tree budget facts require M91 metering; do not invent per-child costs.
Show brief exposed reasoning summaries only when available, not an implied view
of private model reasoning.

The existing [Subagent component](../../../../src/components/ai/Subagent.tsx)
already differentiates a child worker from a handoff: a handoff opens a separate
run and does not mean that run completed. Preserve that distinction. A workflow
step is another distinct lifecycle. First release should finish M91's bounded
foreground researcher model; independently authorized Agents and background
children require the later runtime work, not additional rows in a picker.

Stop means “request cancellation” while work settles. Keep completed effects
visible and identify children still stopping. Do not call a timed-out external
mutation cancelled merely because the parent stopped. Avoid changing focus or
scroll position for every token; new activity should offer Jump to latest when
the person is reading an older answer.

## Journey 4: decide on effects, then use the result

A consequential action card should state the verb, target, selected account,
material inputs, expected effect and relevant scope. Its buttons name the action
where possible: “Create draft,” “Apply changes,” “Deny.” The runtime binds that
decision to the frozen invocation; changing account, inputs or grant invalidates
the prior approval. Approvals must stay reachable after minimizing chat and, for
the later durable workflow release, after restart. Link existing review/run
surfaces to the same pending record rather than creating a second inbox database.

After dispatch, keep a compact effects summary beneath the answer. Distinguish
local file changes from remote effects. A remote timeout after dispatch displays
“Outcome unknown” and an Inspect/Check status route; do not offer a generic
one-click repeat until reconciliation or provider idempotency establishes it.
Local Undo cannot imply remote rollback. [TurnChangeset](../../../../src/agent/TurnChangeset.tsx)
already makes committed versus unavailable file history explicit; extend the
experience with typed remote outcomes rather than replacing this record.

Useful answers deserve Copy, Save answer and Add selected parts to page. Preview
the destination and exact selected content, retain source links/turn provenance,
then use the existing guarded human write and Undo. n8n's [artifact viewer][n8n-artifact]
supports selection/download; AppFlowy's [document service][af-save] shows the
answer-to-page bridge. Cerebro should reuse its editor instead of creating a
parallel rich-text editor inside chat. Preserve code/table structure and speaker
boundaries when saving multiple messages.

For selected-text editing, capture page/version/range with the request. Compare
the proposed replacement before applying it. Plane's [Ask Pi menu][plane-ai]
offers replace/insert/regenerate affordances, but its inspected component does
not prove a complete agent pipeline. Cerebro's acceptance must cover a person
editing that range while the answer streams: show a conflict or reselect route,
never overwrite the current selection blindly. Export and Compare use the saved
artifact/version and existing native file/diff surfaces.

## Journey 5: recover history and turn a task into a workflow

History search should find a thread by title, answer text, associated page and
recorded action/account, within its originating vault scope. Display restore
status when only metadata remains. [n8n's message identities][n8n-message] record
retry/revision ancestry; [AppFlowy's message store][af-messages] demonstrates
cursor-based durable records. These are design evidence for Rust-owned thread
identity and retrieval, not a reason to introduce a second incompatible fold.
Permanent answers require an explicit retention change beyond CLI references.

Use precise action names: “Try another answer” creates a new generation attempt;
“Branch conversation” creates ancestry from a validated checkpoint and says
“Files stay as they are”; “Resume workflow” continues eligible pending steps;
“Repeat action” follows that invocation's retry policy. The current
[AiPanel retry](../../../../src/agent/AiPanel.tsx) resends the prior question, so
its behavior cannot silently become effect-aware retry.

A successful repeated task may become a workflow draft. Show a numbered step
list and selected-step inspector: trigger, inputs, action/account, output mapping,
conditions, approval and failure route. Provide a sample input and visible
validation errors. Separate draft, published version and a run of that version.
Introduce a graph when branching/joins make the list hard to understand; retain
an equivalent keyboard-readable list. A rehearsal label needs actual isolation
and clear limits; a conversation branch is not a sandbox.

## Acceptance and bounded delivery

| State                  | Required experience                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Cold/empty             | Explain CLI availability and context; offer relevant starters without implying connections exist                       |
| Readiness error        | Retry the check; distinguish unavailable from absent installation; preserve draft                                      |
| Offline                | Show which actions need a connection; retain readable history; never claim a mutation was queued durably unless it was |
| Partial completion     | Answer and successful children remain available; failed evidence/action has its own next step                          |
| Cancelled              | Name work that stopped and effects already completed; settling children stay visible                                   |
| Unknown remote outcome | Preserve invocation/account/input identity; offer reconciliation before repetition                                     |
| Restored/unavailable   | Retain thread metadata and explain missing transcript or source; never render an empty success                         |
| Narrow/minimized       | All decisions remain reachable; expansion restores draft, focus and reading position                                   |

Keyboard and native input are release criteria across floating, docked and canvas
presentations. Enter must respect IME composition, Shift+Enter inserts a newline,
completion menus own their keys, and Escape dismisses the innermost surface.
The inspected [ChatInput](../../../../src/agent/ChatInput.tsx) Enter handler lacks
the composition guard now present in M91's [PromptInput](../../../../src/components/ai/PromptInput.tsx).
Adopting the latter must preserve the former's completion behavior. This is a
source finding, not a reproduced native-input failure.

VoiceOver must announce meaningful completed additions/status changes without
reading every streamed token. Use the [MessageScroller](../../../../src/components/ai/MessageScroller.tsx)
log/scroll contracts, meaningful child labels and explicit focus return from
drawers/popovers. Test zoom, reduced motion, high-contrast focus/selection,
long action names and large code blocks; keep Instrument Sans/IBM Plex Mono and
existing light/dark tokens. A narrow layout may scroll within a code block, but
must not require horizontal scrolling to approve or send.

Ship in three bounded slices. **First**, finish M91 integration plus truthful
readiness/history, attachment states and the complete foreground research
journey using existing primitives. **Second**, add context receipts, exact
evidence navigation, Save answer and selected-text compare/apply. **Third**, once
Rust invocation and credential contracts exist, ship one connector's read and
one reviewed external action (work-item creation in the main beta), visible account selection, durable effects
and connection repair; then one list-authored workflow with restart recovery.

These are UX increments, not additional mandatory gates before the main plan's
one-provider beta. Context receipts, passage navigation and richer retention can
progress alongside that beta once their shared contracts are stable.

Evaluate task completion, recovery success, evidence landing and time to produce
a useful saved result. Keep synthetic component/stream tests, browser journeys
and installed-CLI/native acceptance as separate evidence. This proposal makes no
claim that those checks have already passed.

[af-sources]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/ai/widgets/prompt_input/select_sources_menu.dart
[af-save]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/application/chat_edit_document_service.dart
[af-messages]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai-pub/src/persistence/chat_message_sql.rs
[n8n-prompt]: ../../../examples/n8n-master/packages/frontend/editor-ui/src/features/ai/chatHub/components/ChatPrompt.vue
[n8n-artifact]: ../../../examples/n8n-master/packages/frontend/editor-ui/src/features/ai/chatHub/components/ChatArtifactViewer.vue
[n8n-message]: ../../../examples/n8n-master/packages/cli/src/modules/chat-hub/chat-hub-message.entity.ts
[plane-ai]: ../../../examples/plane-preview/apps/web/components/pages/editor/ai/ask-pi-menu.tsx
