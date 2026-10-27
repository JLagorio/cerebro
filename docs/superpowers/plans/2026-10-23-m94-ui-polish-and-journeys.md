# M94 — UI polish and journeys

**Milestone:** M94 · **Phases:** M94.1–M94.9 · **Requirements:** UX-01–UX-10.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose Cerebro's existing surfaces consistently and finish creation,
return and recovery journeys without changing their authority or ownership.

**Architecture:** Retain existing React surfaces and primitives; establish three
composition roles and prove four surfaces before wider adoption. A memory-only,
context-scoped creation draft store adds session recovery. Existing navigation,
writers and AI adapters retain ownership; REL/CHAT/ACT/KNOW supply their own
behavioral contracts.

**Tech Stack:** React 19, TypeScript, Zustand, CSS container queries, existing
design-system controls/AI Elements, Vitest, Playwright and packaged Tauri 2/WKWebView.

**Spec:** [Cerebro UI design](../specs/2026-10-23-m94-ui-polish-and-journeys-design.md).

**Status:** Implementation authorized by the owner on 2026-10-23, on the existing
branch alongside Claude's M92 work. The [implementation record](2026-10-23-m93-m99-implementation-record.md)
distinguishes verified slices from open work. The owner accepted the refined treatment on 2026-10-25; see the
[composition decision](../specs/2026-10-25-m94-refined-composition-decision.md).
Phase checklists remain requirements, not test results. M94 is not complete.
Program sequencing and owner gates live in the
[program design](../specs/2026-10-23-m93-m99-program-design.md) and
[program plan](2026-10-23-m93-m99-master-roadmap.md).

## Global Constraints

- Retain Instrument Sans/IBM Plex Mono, cortex/synapse roles and both themes.
- Keep 54px rail, 240px default context sidebar, 64px document toolbar and native minimum 900×600.
- Preserve first-H1/body editor ownership, stable metadata portal, full-height single side-panel slot, up to four panes and one assistant instance.
- Preserve Button 28/32/36px, IconButton 24/28/32px, navigation 36px; table rows 32/44/56px and header 36px.
- Propose collection/utility pane insets 16px below 600px, 24px at 600–959px, 32px at 960px and above; collection top 40px, utility top 32px. Owner comparison precedes adoption.
- Preserve all destinations, saved widths/folds/page-tree mode, density, visible fields and full-width preference; no automatic persisted visual migration.
- Keep failed/unavailable/not-recorded distinct from empty/zero and retain `AnchoredFieldStatus` and CV-44's five presets.
- Creation drafts are memory-only; restart/crash archives require a separate owner retention gate.
- No new provider, runtime, save queue, passage locator or conversation archive is owned here; `outcome_unknown` remains canonical.
- Use existing `e2e/boot.ts`; inspect actual app through the repo `verify-ui` runbook during execution. Do not edit vendored references or bypass hooks.
- No dummy tests asserting CSS text or class names; use actual geometry, task completion, state ownership and human comparison.

## Review Focus

1. A draft opened in another vault/database/host must never receive the first draft's text; M94.4 tests vault, destination and simultaneous opener boundaries.
2. IME Enter and same-tick submit events must not create twice; M94.4 tests composing Enter and Enter/click before a render, including a failed request.
3. Narrow panes with a panel and assistant must keep decisions reachable; M94.3/M94.7 test actual host widths, 200% zoom and presentation changes without state loss.
4. A stale opener or removed record during Back/close must preserve origin and choose safe focus; M94.5 tests deleted/moved targets, nested Escape and intentional pointer focus.
5. A mixed successful/failed read or unknown effect must never appear as empty/success; M94.7/M94.8 test streamed uncertain decisions, partial sections and not-recorded values.

---

## File map and delivery boundaries

Existing composition owners: `src/components/PageHeader.tsx`,
`src/components/pageHeader.css`, `src/components/pageFrame.css`,
`src/styles/surface-system.css`, `src/styles/tokens/{spacing,typography,colors}.css`.
Use their existing APIs; extend `PageHeader` with optional
`composition?: 'collection' | 'utility'` while retaining `variant` compatibility.
Absent `composition` keeps current behavior. Document titles remain in the editor.

First-slice consumers: `src/pages/{DocPage.tsx,PagesPage.tsx,pages.css,pagesBrowser.css}`,
`src/editor/editor.css`, `src/app/shell.css`, `src/detail/inspector.css`,
`src/views/TableView.tsx` and `src/styles/table-chrome.css`.
Behavior owners: `src/app/{CreateMenu.tsx,CreateLauncher.tsx,RecordComposer.tsx}`,
`src/stores/launcherStore.ts`, `src/engine/createRecord.ts`,
`src/app/useOpenPath.ts`, `src/stores/navStore.ts` and existing field editors.

Proposed new focused modules: `src/engine/creationDestination.ts` owns pure
context/key types; `src/stores/creationDraftStore.ts` owns memory drafts and
claims; `src/app/CreationDestinationField.tsx` draws a validated destination
choice; `src/app/CreationDraftRecovery.tsx` draws Resume/Discard. Tests colocate.
Proposed future review artifacts: directory
`docs/superpowers/specs/2026-10-23-m94-ui-implementation/` containing `README.md`,
`composition-sheet.md`, `capture-manifest.json`, `interaction-results.md` and
`native-results.md`, plus named image files. It is created during implementation,
not by this authoring task. Captures never contain private vault/provider data.

Later consumers are explicit in M94.6–M94.8. Each task uses its own reviewed
diff; if an unexpected source owner is needed, amend its file map before coding.
Do not propagate comparison values until the owner accepts the first slice.
Task commits follow `type(scope): sentence (M94.<phase>)` using the phase headings below; do not commit this drafting session.

## M94.1 — Reconcile baseline and evidence ownership (UI00)

**Files:** Read current `AGENTS.md`, `.claude/skills/verify-ui/SKILL.md`,
`shared/policy/subagents.v1.json`, `src/lib/policy/{subagents,toolApproval}.ts`,
`src-tauri/src/policy/{subagents,tool_approval}.rs`, `src/agent/transcript.ts`,
`src/agent/useContextUse.ts`, `src/agent/ChatTurn.tsx`, the
[M91 implementation record](2026-10-23-m91-implementation-record.md) and M92 record.
Create the review artifact README/manifest above; no source edits by default.

**Interfaces:** Consumes current source/build identity and CHAT's M91/M92 handoff;
produces a baseline record classifying source-confirmed, browser-observed,
native-observed and unverified evidence. No product API changes.

- [ ] Record commit, dirty-tree content identity, dependency/tool versions, chosen server/port, build mode, corpus identity, browser/webview and machine/load. Protect existing contributor work.
- [ ] Reconcile existing reducer, branching, context, AI adapters and M92 rail with CHAT; retire the historical flat-reducer/absent-feature premise. If startup fails now, capture its actual error and owning package; do not repeat yesterday's failure as current or patch unrelated active files.
- [ ] Disposition the implementation record's reported baseline failures and open UI/knowledge/context issues by owner and gate. Do not read green-against-baseline as all-green, certify historical captures anew, or take over M91/M92. Keep shared-file work gated by the accepted handoff; name deferred follow-ups explicitly.
- [ ] After a coherent handoff, execute the verify-ui runbook and capture the current four first-slice surfaces. Record viewport, scale, zoom, pane widths, theme and content for each frame.
- [ ] Record `pnpm typecheck` and relevant existing M91 checks supplied by CHAT with exact source identity. Missing evidence remains unverified; the README contains no blanket startup/native pass.
- [ ] Review/commit only the evidence artifact with its numbered M94 phase. Deliverable: actual baseline suitable for paired comparisons.

## M94.2 — Composition and role sheet (UI01)

**Files:** Modify `src/components/{PageHeader.tsx,pageHeader.css}`,
`src/styles/surface-system.css` and, only where the accepted role requires it,
`src/styles/tokens/{spacing,typography,colors}.css`. Add
`composition-sheet.md` under the review directory; extend
`e2e/surface-system.spec.ts` for rendered role geometry.

Execution amendment (2026-10-23): the dev-only `src/lab/CompositionLab.tsx`
and a conditional entry in `src/lab/main.tsx` provide exact-width comparisons
of the real shared primitives without changing production consumers. The
focused geometry cases live in `e2e/m94-composition.spec.ts`; existing surface
checks remain regression coverage. This fixture has no runtime reader and
does not fabricate CV-44 reading states. It is excluded from production by the
existing state-lab entry/build boundary. Owner comparison still precedes wider
adoption; unchanged surfaces remain the baseline.

**Interfaces:** Produces optional `PageHeader.composition` defined in the file
map and CSS composition classes scoped to owning containers. Existing `variant`,
title, actions and metadata props remain compatible. No new state/store.

- [ ] Draw the three concrete anatomies from UX-02 in the composition sheet with exact content-edge, heading, control, density, corner and exception roles. Show a utility repair form as well as document/collection; do not substitute a token swatch gallery.
- [ ] Implement opt-in collection/utility roles with 600/960px container thresholds and 16/24/32px insets. Keep existing unconverted consumers stable and document each intentional exception.
- [ ] Compare rendered title/control/content edges at host widths 599, 600, 959 and 960px. Assert matching edges within a proposed 2 CSS px measurement tolerance, no outer horizontal scroll and correctly wrapped actions. The tolerance is geometry evidence, not aesthetic approval.
- [ ] Run `pnpm e2e -- e2e/surface-system.spec.ts` and `pnpm format:check`; expect selected checks to pass. Inspect both-theme screenshots for actual readable ink, selection, hover, focus and nested corners; use existing contrast checks for token changes.
- [ ] Record owner disposition of proposed spacing, radii and typography exceptions. Commit the scoped contract and evidence under the assigned phase; no repository-wide CSS replacement.

## M94.3 — Four-surface first slice (UI02)

Execution amendment (2026-10-23): after the independently reviewed M93.8
source-read repair, the new presentation controls in
`src/editor/NoteBodyEditor.tsx` adopt existing 28px Buttons and the editor's
measured 54px page / 28px peek content gutter. This changes presentation only;
the retained document owner, mode transitions and writer remain M93's.
`e2e/m94-source-presentation.spec.ts` measures alignment, selected appearance,
keyboard focus and zero-write switching in both themes and page/peek hosts.

**Files:** Modify first-slice consumers in the file map plus
`src/detail/AnchoredFieldStatus.tsx` only if demonstrated placement defects need
repair. Extend existing `e2e/{page-title-polish,record-page-composition,pages-browser,grouped-table-polish,shell-layout}.spec.ts`.

**Interfaces:** Consumes M94.2 opt-in composition roles, existing editor/title
portal and field status APIs. Produces accepted before/after compositions; REL
continues to own acknowledged-save behavior and performance mechanisms.

- [ ] Capture the same long rich document, twenty-property record, twelve-item Pages list/grid and populated table before editing. Include long/empty previews, filename fallback, nonleading H1, relations and one refused field.
- [ ] Apply document alignment after measuring actual editor gutters. Compare a 700–760px resolved prose measure against baseline; preserve 880px outer token until evidence justifies a change and preserve full-width embeds. Keep 64px frame/full-height panel and metadata mounts.
- [ ] Compare 48px one-line Pages rows against current 56px; retain enough height for real second lines. Apply accepted control/type/corner roles and sidebar text/gap rhythm without losing trees, modes, route controls or saved widths.
- [ ] Assert opening a page writes no Markdown; title projection does not reorder source; properties stay mounted/focused while editor loads; Details/Comments/History use one slot. Test four-pane parking, drawer and floating/docked assistant coexistence at actual widths.
- [ ] Run the named Playwright files. Exercise 1440×900, 1024×768, 360px content host and actual 200% zoom, both themes; native 900×600 remains M94.9. Expect reachable primary actions, no outer horizontal overflow, accurate target labels and exact refused text while scrolling.
- [ ] Obtain owner paired-image disposition before wider adoption. Commit accepted first-slice changes/evidence with documented exceptions; rejected comparisons revert without rewriting saved preferences.

## M94.4 — Visible destinations and session draft recovery (UI03)

**Files:** Create the four proposed modules in the file map;
`src/engine/creationDestination.test.ts`, `src/stores/creationDraftStore.test.ts`,
`src/app/{CreationDestinationField,CreationDraftRecovery}.test.tsx`. Modify
`src/app/{CreateMenu,CreateLauncher,RecordComposer}.tsx`,
`src/stores/launcherStore.ts`; extend `src/app/RecordComposer.test.tsx` and
`e2e/{create-launcher,record-composer}.spec.ts`. Reuse `src/engine/createRecord.ts`.
Also create `src/app/creationSubmission.ts` and its colocated
`creationSubmission.test.ts`; submission completion belongs here and the draft
store, outside dialog component lifetime.

**Interfaces:** Export spec's `PageCreationRecipe`, `CreationDestination`, `CreationContext`,
`creationDraftKey(context): string`, `CreationDraft` and read/save/discard/clear
functions unchanged. Export `claimCreationDraft(context, ownerId: string): boolean`,
`releaseCreationDraft(context, ownerId: string): void` and
`moveCreationDraft(from: CreationContext, to: CreationContext, revision: number): boolean`;
claims are in-memory and release only by matching owner. Extend
`startCreate(id: string, destination?: CreationDestination): void` and
`CreateFlow` with `context: CreationContext`; retain existing `id/vault/page`
through consumer migration. Dialog props gain optional `context`; root/default
callers derive the same explicit context once at opening.
Export spec's `CreationSubmission`, `CreationSubmitStart`,
`readCreationSubmission`, `beginCreationSubmission`, `settleCreationSubmission`
unchanged; `submitCreationDraft(context: CreationContext, revision: number): CreationSubmitStart`
in `creationSubmission.ts` owns the async writer promise. Only a `started`
result calls the guarded writer; `pending` returns the original ID and `stale`
does nothing. A delayed acknowledgment settles that ID, never the currently
rendered dialog. M98.7's later owner-gated persistence adapter consumes these
same identities and Resume/Discard owner; this task adds no persistence.

- [ ] Write failing behavioral unit cases: canonical key excludes pane but distinguishes vault/page folder/immutable recipe/type/host/group; exact whitespace/values/errors survive close; stale-revision discard fails; second owner cannot claim; explicit vault clear removes its drafts only; move refuses an occupied target without erasing either draft. Run `pnpm test:run -- src/engine/creationDestination.test.ts src/stores/creationDraftStore.test.ts`; expect these cases to fail before implementing new modules.
- [ ] Implement immutable memory snapshots and claims; zero browser/disk persistence. Freeze origin context at opening. Re-resolve current schema/host before Create; show missing destination as a repair, retaining text. Folder selection uses existing path guards; records still call `createTarget` with home/host/group rules.
- [ ] Freeze the spec's plain-page/sheet recipe in context before opening `NewDocDialog`; submit its immutable seed, never the current `sheet` prop. Cover `plain_page_draft_never_resumes_as_sheet`, `sheet_draft_never_resumes_as_plain_page`, `pending_recipe_isolation` and `create_more_preserves_recipe`. Assert correct resulting Markdown/fence and separate submission IDs across variants. Other launcher flows retain their owners and have no session-recovery promise; future templates require pinned recipe identity/version/payload first.
- [ ] Implement atomic store-owned pending submission allocation before calling the writer; retain ID, frozen context/input/revision and completion handler across close/unmount/vault switch. Resume displays Creating and disables resubmit until acknowledgment/reconciliation; elapsed time alone does not permit retry. Settle idempotently by ID; clear/error only matching draft revision, retain newer drafts and suppress navigation from an unmounted/different-vault composer. Discard/move refuse pending keys; explicit vault clearing retains the pending snapshot until settlement without restoring its draft afterward.
- [ ] Add “In …”/database/home/host presentation, Resume/Discard and explicit destination-transfer choice. Wire Escape/Cancel to retain meaningful input; successful Create clears only submitted revision; Create more resets its successful record while keeping intended destination/field defaults. Opening a similar record retains the unfinished composer draft.
- [ ] Add interaction cases for page folder destination, related-record membership/group/key precedence, switching database with Resume back, and switching vault without leakage. Exercise same-tick Enter+click, modifier Enter and composing Enter; one acknowledged create, zero IME creates, failed input unchanged. Simulate schema/host removal and rejection after close; retain the correct original scoped draft without navigating another vault.
- [ ] Add deferred-writer unit/component regressions: Create→close→Resume before acknowledgment returns the same submission ID and calls writer once; success after unmount settles the original revision; failure after vault switch leaves exact original input/error available only in its vault; newer revision survives both delayed success and failure; pending move/discard cannot erase the snapshot; same-tick submit calls share one operation. Resolve and reject the held promise explicitly and assert no unintended navigation or second create. Run `pnpm test:run -- src/stores/creationDraftStore.test.ts src/app/creationSubmission.test.ts src/app/RecordComposer.test.tsx`; expect all ownership cases to pass.
- [ ] Run new unit/component tests, existing `src/engine/createRecord.test.ts`, and named e2e files; expect all assertions to pass. Inspect Resume/Discard/destination controls in both themes/narrow host. Document session-only promise visibly; no restart recovery claim.
- [ ] Commit session recovery separately from visual-only work with assigned phase. Deliverable is recoverable same-process capture, not a crash-draft archive.

## M94.5 — Properties, commands and return paths (UI03 continued)

**Files:** Modify `src/detail/{HeadingProperties,RecordPageProperties,RecordProperties,RecordTabs,DetailPanel}.tsx`,
`src/detail/inspector.css`, `src/app/useOpenPath.ts`, `src/app/QuickOpen.tsx`,
`src/app/commands/{page,peek,panes,create}.commands.ts`.
Extend `e2e/{record-peek-polish,history-state,panes,palette-commands,inspector}.spec.ts`.
Do not create a new navigation service.

**Interfaces:** Keep spec's `navigate`/`navigateIn`/`openPane` signatures and
`useOpenPath(mode?, {byAgent?,replace?,fullPage?}?)` returning
`(path: string, options?: {newPane?: boolean}) => NavOutcome`. Consume visit
state through existing `useEntryState`; no invented source-location options.

- [ ] Align metadata disclosure copy to Properties, Show all properties/Hide properties; retain Details toolbar meaning and existing field writer/validation semantics. Audit Rename/Move/Open beside/Properties/New names against the registry, preserving disabled blockers at every entry point.
- [ ] Add a filtered-database journey: peek, reject a property, promote to page, follow relation, Back to exact filter/row/scroll; repeat Pages and Quick Open. Assert exact invalid text and one editor owner, rather than only checking route labels.
- [ ] After M97.2, consume its `openSource`/`returnToSourceOrigin` contract and Quick Open snapshot; test explicit Return to results restores query/category/level/expansion/active-row/scroll, including held editor, peek promotion and deleted origin. Ordinary Back retains visit semantics; no global dialog-reopen behavior is invented. Preserve M92's primary jump in canvas and float-before-secondary-open rule.
- [ ] Test target deletion/move, stale opener, nested menus over drawer, intentional pointer focus before close and parked-pane return. One Escape closes only foremost real layer; exit ghosts cannot focus; focus falls to a surviving owning control if opener vanished.
- [ ] Run named Playwright files and affected field component tests. Expect origin state preserved, persistent accessible correction status and no raised editing cells over frozen columns. Record any REL save-retention dependency as open until that package passes its own tests.
- [ ] Commit vocabulary/navigation refinements and interaction evidence with assigned phase.

## M94.6 — Data and embedded view adoption (UI04)

**Files:** Modify `src/views/{ViewTabs,ViewSettingsPanel,ViewControlIcons,DatabaseBlockView,TableView,BoardView,GalleryView,CalendarView,TimelineView,GanttView,DashboardView}.tsx`,
`src/views/displayGeometry.ts`, `src/sheet/SheetView.tsx` and shared surface CSS
only for accepted roles. Extend `e2e/{data-display-polish,data-reading-polish,view-tabs,project-pages,sheets-grid}.spec.ts`.

**Interfaces:** Consume existing saved presentation, scope and `createTarget`
contracts; no density/view persistence changes. Embedded source/saved-view/related
scope presentation uses the existing view resolver and RecordTabs configuration.

- [ ] Adopt accepted collection controls, card hierarchy and meaningful labels using the same twelve records across list/table/grid/board. Keep 32/44/56px rows, 36px headers, content-dependent wrapping and saved overrides.
- [ ] Exercise inserting a saved view, changing layout, creating under related host and opening full-page. Assert source/view/scope remain intelligible, membership correct, missing source repair writes no body, and Escape restores editor selection.
- [ ] Exercise keyboard End/find, variable-height/frozen-column refused draft, board horizontal scroll and time/sheet selection at narrow host; page actions remain reachable. Run named e2e files; expect stable active field, no inaccessible offscreen records and independent scrollports.
- [ ] Attach REL's same-method production scale disposition to the review record. Preserve raw failures/timeouts and source identity; no screenshot or lower median closes p95. Commit visual adoption independently if scale remains explicitly unclosed.

## M94.7 — Conversation and Agent adoption (UI05)

**Prerequisite:** Accepted M91→M92 handoff for shared assistant files. Preserve M92's canvas rail, drawer/focus/navigation, card producers and single context pull; run its owning regressions alongside the checks below.

**Files:** Modify `src/agent/{AiPanel,ChatTurn,ChatInput}.tsx`,
`src/agent/{chat,chat-turn,chat-input}.css`, existing
`src/agent/elements/{turn,cards,decisions}.ts` only where adapter mapping changes,
`src/library/AgentPage.tsx`, `src/status/{runs,review}.css`. Extend
`e2e/{floating-assistant,m91-subagents,m91-sources,agent-transcript}.spec.ts`.

**Interfaces:** Consume CHAT's reviewed transcript/context/artifact/recovery
models and ACT effect/approval facts. Existing M91 producer/reducer remains;
AI primitives take plain props only. No duplicate archive/reducer or UI-defined
effect transition is introduced.

- [ ] Reconcile current CHAT contract before styling. Build the real long-answer/six-source/three-child/pending-decision scene through existing model fixtures; do not add functioning-looking controls for unavailable producers.
- [ ] Apply reading-first hierarchy and aligned composer/source/artifact edges. Keep consequential failure, Stop, approval account/target and `outcome_unknown` directly visible; secondary tools/child detail use meaningful disclosure.
- [ ] Test floating→docked→canvas→minimized→open while streaming: same thread/draft/pending decision, preserved earlier-reading position, no focus theft. Test failed child with successful parent answer, unknown usage as words, interrupted action and unknown effect without misleading Retry/success. At 200% narrow layout reach approval and Stop by keyboard.
- [ ] Run named e2e files plus `pnpm test:run -- src/components/ai/boundary.test.ts`. Expect unchanged assistant ownership and CV-64 boundary. Attach CHAT real-CLI live/restored evidence separately; synthetic scenes do not close it. Commit adoption with assigned phase.

## M94.8 — Utilities, states and repair journeys (UI06)

**Files:** Modify `src/pages/{KnowledgePage,HomePage,AgentsPage,MyWorkPage,SettingsPage,SettingsNavigation}.tsx`,
`src/pages/{settings,workspacePages}.css`, `src/library/LibraryIndex.tsx`,
`src/app/{ConnectorSettings,QuickOpen}.tsx`, `src/library/AgentProperties.tsx`,
`src/knowledge/ConceptReviewBar.tsx`,
existing sections in `src/lab/sections/` and new section presets only when a new
reading section is introduced. Extend `e2e/{surface-states,state-lab,knowledge,settings-redesign,connectors,quick-open-content}.spec.ts`.

**Interfaces:** Consume M94.2 roles, existing lab section presets, ACT account
readiness and KNOW source location. If KNOW's navigation contract is not accepted,
keep current page opening and mark passage acceptance unverified; do not infer a
locator from snippet text. Connection repair retains an origin reference owned
by its invoking draft, not credentials in a navigation parameter.

`AgentProperties` uses `ConnectorInventory = Loading | Ready {specs} |
Unavailable {reason}` with vault/request identity and an explicit Retry. Keep
the last valid inventory labeled stale if shown; never replace an error with
`Ready {specs:[]}`. Its existing grant-row Done writer remains the only writer.
KNOW supplies evidence descriptor classification through its adapter; M94 does
not assign `vault` semantics to unresolved prose.

- [ ] Apply collection/utility roles while preserving quiet Home, three Knowledge tabs, review reasons, human-only Verify and separate proposal approval. Keep state failure local to its section.
- [ ] Render CV-44 ready/empty/not-recorded/partial/unavailable presets plus journey loading/dirty/failed/waiting cases. Assert no false empty/zero, usable neighboring sections and context-preserving Retry.
- [ ] Exercise dirty Settings→failed validation→repair→return; preserve exact inputs and conceal secrets. Distinguish account sign-in, transport and callable action; ACT absence cannot display green readiness. Exercise Knowledge evidence failure/return/decision and search query→open beside→Back, adding changed-passage fallback only with KNOW producer.
- [ ] Add `agent_connector_read_failure_is_unavailable`, `agent_connector_retry_preserves_grant_draft` and `agent_connector_response_cannot_cross_vault`: fail/retry the actual read, preserve open Tools/Connectors draft and stored unknown tool identifiers, and suppress false no-enabled-connectors copy. Register the five inventory lab states where this new reading section is introduced. Execution remains fail-closed independently of UI read state.
- [ ] Run named e2e files and preset tests. Expect correct reason/state copy, guarded Verify and stable origin/focus. Capture both themes and narrow repair overlay; commit with explicit unresolved producer gates.

## M94.9 — Release evidence and owner disposition (UI07)

**Files:** Complete review directory manifest/README/interaction/native results;
update tests only for demonstrated regressions, not wholesale snapshot approval.
Link [program evidence](../specs/2026-10-23-m93-m99-research/evidence.md) and the
owner decision register to each slice's source identity.

**Interfaces:** Consumes all accepted slices and REL/CHAT/ACT/KNOW evidence;
produces separate accepted/failed/unverified visual, browser, native,
performance and dependency dispositions. No app behavior change by this task.

- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, affected Vitest tests and the approved journey Playwright set after final changes; expand only for cross-surface risk. Record commands/results, exact identity and any failures. Use rust checks only if Rust changed in its owning package.
- [ ] Review six scenes: rich document; record/inspector; populated table/board; long chat/decision; Knowledge review; Settings repair/creation/search. Record 1440×900, 1024×768, native 900×600, 360px host, actual 200% zoom, both themes and reduced-motion transitions. Measure rendered contrast/target sizes separately from image appearance.
- [ ] In packaged WKWebView exercise Japanese/Chinese IME, dead keys, undo/title-crossing selection, VoiceOver/focus order, clipboard/Finder drop, native dialogs, link policy, activation, scrollports and REL failed-save Retry/close/keyboard quit. Include failures settled before quit and during teardown. Dock Quit/logout/shutdown protections remain limited to documented mechanisms.
- [ ] Obtain owner paired-composition judgment; record accepted values, rejected choices and exceptions. Native unavailable environments and unresolved scale/producer failures remain unverified/failed; no blanket polished-release claim.
- [ ] Commit review artifacts using assigned phase only after honest evidence classification. Release any exposed journey only when its correctness blockers and relevant owner gates close.

## Self-review and handoff

Spec coverage checked: UX-01–04 → M94.1–M94.3; UX-05 → M94.4; UX-06 →
M94.5; UX-07 → M94.6; UX-08 → M94.7; UX-09 → M94.8;
UX-10 → M94.1/M94.3/M94.5/M94.7–M94.9. Every VS01–13/PJ01–12/AC01–06 and UI00–07
has a disposition in the spec. Review Focus's five classes have explicit task
assertions. New draft and composition interfaces are defined before consumers;
navigation remains existing API. Styling uses visual/geometry/interaction proof,
not implementation-mirroring unit tests. REL/CHAT/ACT/KNOW dependencies are
single-owner work, and restart archives remain outside this plan.

Plan authoring created only this plan and its spec. No application/tests were
changed, checks run, screenshots captured or commits made. Owner review must
approve the proposed direction and gates before implementation execution is
chosen through the program handoff.

## M91–M92 integration boundary

[M92 — The conversation rail](2026-10-23-m92-conversation-rail.md) remains the owner of the canvas-only Conversation details rail, its read-only cards, shared Context pull, Plan/Subagents/Changes/Sources/Handed off adapters, reach/thread-status facts and canvas-safe navigation. Reconcile the accepted M91→M92 handoff at its recorded revision before this milestone changes those shared files; preserve the single assistant instance and live state. Unfinished or unverified M91/M92 work stays assigned to its existing milestone, with dependent work waiting on that gate.

M95 source-context receipts record source delivery and evidence provenance; they do not persist context-token readings or add a second context poll. The read-only rail may link to the owning inspection/settings surface. New managed account/action controls need M96 ownership and must not silently replace M92 rail behavior.
