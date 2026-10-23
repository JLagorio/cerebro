# Plane: make work actionable without mistaking work management for an agent runtime

Reviewed the local `docs/examples/plane-preview` snapshot on 2026-10-22, with key
source fingerprints captured at 14:02 America/Los_Angeles. This is a source review,
not a running-product evaluation. No application code changed; no reference was
installed and no application tests, browser checks or native acceptance were run.
The Cerebro tree is actively changing during M91. Reconcile its final handoff with
the [M91 current-state audit](m91-current-state.md) before implementation.

Plane contributes most strongly to Cerebro's **work surface and action model**:
contextual commands, persisted drafts and intake, semantic relationships, explicit
versions, integration identities and inspectable webhook deliveries. Its SQL
models also make the cost of abandoning YAML clearer. This snapshot does not
establish an advanced agent runtime, MCP implementation or subagent architecture.
Its AI labels should not be used as evidence that those capabilities exist.

The root [LICENSE.txt](../../../examples/plane-preview/LICENSE.txt), lines 1–2,
contains GNU AGPL version 3; [COPYRIGHT.txt](../../../examples/plane-preview/COPYRIGHT.txt),
lines 1–3, identifies Plane Software and contributors and `AGPL-3.0-only`.
The inspected Python/TypeScript files carry the same SPDX identifier. These are
local provenance facts, not a legal determination about a proposed port. This
review recommends product patterns and original Cerebro implementations.

## Ranked findings

Effort means rough engineering size after the prerequisite design decisions:
**S** is a contained slice, **M** crosses several surfaces, **L** adds a durable
subsystem or migration. These are comparisons, not delivery-date promises.

| Rank | Opportunity                                                         | Cerebro classification                                              | Priority / effort  |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| PL01 | Versioned actions shared by commands, chat and workflows            | Existing command foundation; proposed execution layer               | P1 / L             |
| PL02 | Observable external delivery and effect records                     | True gap for app-owned outbound actions                             | P1 / L             |
| PL03 | Preserve unfinished capture and give intake explicit outcomes       | Existing capture; narrower persistence gap                          | P1 / M             |
| PL04 | Stable identity and typed persistence before removing YAML          | Architectural decision, not a formatting fix                        | Decision first / L |
| PL05 | Define selected-text AI as a complete, reviewable journey           | Proposed chat/editor integration; weak reference execution evidence | P1 / M             |
| PL06 | Model connection, credential, capability and observation separately | Partial parity; expansion proposal                                  | P1 / L             |
| PL07 | Make relationships meaningful to work and agent plans               | Existing relations; proposed semantic affordances                   | P2 / M             |
| PL08 | Connect saved views to repeatable actions                           | Strong query parity; proposed workflow affordance                   | P2 / M             |
| PL09 | Join work history to external effects without conflating versions   | Strong history parity; effect-history gap                           | P1 / M–L           |
| PL10 | Preserve scope through API, history and asynchronous work           | Existing boundary; extension acceptance requirement                 | P1 / M             |

### PL01 — Extend the existing command system into an explicit action contract

Plane's [Power K command types](../../../examples/plane-preview/apps/web/components/power-k/core/types.ts),
lines 66–107, describe identity, shortcuts, keywords, visibility, enablement and
either an action or a parameter-selection page. Its
[registry](../../../examples/plane-preview/apps/web/components/power-k/core/registry.ts),
lines 77–130 and 146–162, derives commands and shortcuts from context. This is
useful evidence for contextual interaction, not permission enforcement.

Cerebro already has this foundation: [registry.ts](../../../../src/lib/keys/registry.ts),
lines 7–16 and 113–135, resolves scoped handlers and rechecks availability;
[create.commands.ts](../../../../src/app/commands/create.commands.ts), lines 4–19,
derives creation commands from the existing catalog. Replacing it with another
palette would add duplication. The gap is a durable, typed action description
that chat and workflows can invoke without relying on a mounted UI handler.

Propose a Rust-owned action definition with version, input/output schema,
read/write classification, required connection, target identity and retry policy.
The frontend command remains a UI entry point. Its invocation resolves to a
validated action request where appropriate; navigation and editor-only commands
can remain presentation actions. An AI-suggested action must use the same
validation and permission decision as a person selecting it.

**Journey and acceptance:** from a project page, select “Create follow-up” in the
palette, review a chat-suggested equivalent, then save the operation as a workflow
step. All three show the same target and fields, reject the same stale target and
produce one attributable result. A disabled UI command cannot grant authority;
rerunning a saved definition uses its recorded version or an explicit migration.
Build this after M91 integration and the external-action policy decision.

### PL02 — Record deliveries and effects before exposing broad external actions

Plane has a concrete delivery subsystem. [Webhook and WebhookLog](../../../examples/plane-preview/apps/api/plane/db/models/webhook.py),
lines 34–88, separate subscriptions from request/response observations.
[webhook_send_task](../../../examples/plane-preview/apps/api/plane/bgtasks/webhook_task.py),
lines 235–383, signs payloads, sends through a validated/pinned URL helper, records
results and retries request exceptions with backoff and a five-retry ceiling.
This is stronger evidence than an integration logo or a tool-call animation.

Do not copy its reliability semantics blindly. `X-Plane-Delivery` is generated
inside each invocation at line 270, so it is not a stable logical-event identity
across retries. The inspected send block logs HTTP responses without an explicit
`raise_for_status`; it does not establish the desired policy for every HTTP 4xx/5xx.
The model stores request/response bodies and headers; Cerebro needs a deliberately
bounded and redacted retention contract, not wholesale payload logging.

Cerebro's [connectors.rs](../../../../src-tauri/src/connectors.rs), lines 16–37,
assembles approved connector configurations for Claude Code; it is not an
app-owned webhook delivery queue. Its [durable wakes](../../../../src-tauri/src/runtime/wakes.rs)
are useful local dispatch infrastructure, not proof of remote effect delivery.

**Journey and acceptance:** an approved workflow creates an external work item;
the response times out. The run displays “outcome unknown,” the stable operation
identity and the reconciliation action. Restarting the app does not silently send
a second request. Tests must cover accepted-but-timed-out requests, duplicate
events, retries after restart, revocation and expired credentials. Define
adapter-specific idempotency or reconciliation; do not promise universal
exactly-once delivery. This is a prerequisite for reliable workflow actions.

### PL03 — Persist unfinished capture and distinguish intake decisions

Plane's [DraftIssueLayout](../../../examples/plane-preview/apps/web/components/issues/issue-modal/draft-issue-layout.tsx),
lines 59–105 and 128–138, distinguishes discard from creating a saved draft.
Its [intake model](../../../examples/plane-preview/apps/api/plane/db/models/intake.py),
lines 46–92, records pending, rejected, snoozed, accepted and duplicate outcomes,
including the duplicate target and external identity. The useful pattern is
recoverable unfinished work plus explicit disposition, not another universal inbox.

Cerebro already has an [Inbox](../../../../src/pages/InboxPage.tsx), imports,
typed creation and duplicate suggestions. However,
[RecordComposer](../../../../src/app/RecordComposer.tsx), lines 23–24, explicitly
discards its local draft on close; lines 39–45 store choices in component state,
and lines 148–158 route close/cancel directly to the supplied callback. This is a
specific capture gap, separate from the previous plan's editor-save recovery.

Persist a recoverable capture draft by vault identity, with an explicit “Discard”
action and a small “Continue draft” affordance. Keep this separate from an actual
page until creation succeeds. External connector intake can record source/event
identity and a human disposition without pretending a duplicate suggestion is
already a duplicate. Cerebro's existing [import source contract](../../../../src/engine/importSources.ts),
lines 24–44, already distinguishes created, replaced, unchanged, kept and
duplicate; retain those semantics rather than introducing a competing importer.

**Acceptance:** type a title and several fields, close the composer, restart and
resume the same draft; changing vaults never exposes the other vault's content.
An incoming request can be accepted once, deferred, rejected or linked to an
existing record with a visible reason. Failed persistence leaves the current
draft available. Plane's `handleDraftAndClose` at lines 118–123 itself closes
without awaiting completion; use the pattern, not that failure behavior.

### PL04 — Removing YAML means choosing new authority and identity

Plane's [BaseModel](../../../examples/plane-preview/apps/api/plane/db/models/base.py),
lines 17–18, supplies UUID identity. Its [Issue](../../../examples/plane-preview/apps/api/plane/db/models/issue.py),
lines 114–169, uses typed relations, state, dates, labels, external identity and
structured document fields. Lines 184–214 allocate a project sequence inside a
PostgreSQL transaction/advisory lock. Its [Page](../../../examples/plane-preview/apps/api/plane/db/models/page.py),
lines 23–58, stores JSON, binary, HTML and stripped text alongside metadata;
lines 158–167 store page versions. That is a database-authoritative application,
not Markdown with nicer metadata syntax.

Cerebro's [parse.rs](../../../../src-tauri/src/vault/parse.rs), lines 54–93,
parses bounded YAML and reads declared type before guarded writes. The
[record draft planner](../../../../src/engine/recordDraft.ts), lines 67–81,
validates and constructs frontmatter. Replacing delimiters or changing YAML to
JSON does not eliminate identity, migration, schema, export or external-edit
reconciliation responsibilities.

Plane supports considering a Rust-owned transactional metadata store with stable
record IDs and Markdown bodies, especially for workflows and external identities.
It does not prove that moving all documents into a database is necessary. Decide
independently whether Markdown is canonical, a synchronized body, or an export.
If SQL becomes authoritative, backup and restore must include metadata, relations,
schema, workflows and body revisions; Git cannot continue to be described as a
complete record merely because `.md` exports remain available.

**Acceptance for a migration spike:** map a representative vault into the proposed
model and back, retaining unknown fields, typed relations, dates, agent grants,
knowledge provenance and source identities. Rename/move records without breaking
saved workflows. Interrupt migration and recover without dual authoritative
copies. Keep a read-only legacy importer until parity is established. Plane is
Python/Django plus TypeScript here, so it supplies no evidence for a full-Rust UI
rewrite; storage authority and implementation language are different decisions.

### PL05 — Selected-text AI should be a finished editing journey

Plane's [EditorAIMenu](../../../examples/plane-preview/apps/web/components/pages/editor/ai/menu.tsx),
lines 80–95, reads the selected text and requests an editor operation. Its
[AskPiMenu](../../../examples/plane-preview/apps/web/components/pages/editor/ai/ask-pi-menu.tsx),
lines 60–94, presents replace-selection, insert-next-line and regenerate actions.
These are useful affordances for keeping a result beside its source.

The evidence has limits. The Ask Pi query input at lines 106–115 has local state
and an arrow icon but no submit handler in this component. The
[AI service](../../../examples/plane-preview/apps/web/services/ai.service.ts), lines
29–47, calls HTTP endpoints; [external/base.py](../../../examples/plane-preview/apps/api/plane/app/views/external/base.py),
lines 123–135, requests a synchronous completion from an OpenAI client. Provider
names and model lists are not proof of successful provider routing. These files
do not demonstrate streaming tool use, durable chat, MCP, citations, delegation
or an agent workflow. No such behavior was verified in a running Plane instance.

Cerebro already has a substantial [AiPanel](../../../../src/agent/AiPanel.tsx) and
CLI-backed execution. The [M91 audit](m91-current-state.md) identifies incomplete
production adoption of its richer presentation layer. Add a specific scoped
journey after that integration: send selected text with page/version/range
identity, show the proposed replacement and allow review before applying it.

**Acceptance:** the person edits the source while the AI works. Applying the
answer detects the changed selection, presents an intelligible conflict and
offers reselect/retry; it does not replace whichever text happens to be selected
now. Cancel preserves the original. A successful apply is one undoable edit and
appears in history. The same result can be saved as a page without losing source
links. This improves chat usefulness without depending on additional decorative
components or an API-provider rewrite.

### PL06 — Separate a connector's identity from its connection and actions

Plane's [Integration model](../../../examples/plane-preview/apps/api/plane/db/models/integration/base.py),
lines 16–28, describes a provider; lines 41–49 describe a workspace installation
with actor, API token and configuration. Its
[IntegrationService](../../../examples/plane-preview/apps/web/services/integrations/integration.service.ts),
lines 18–47, separately calls catalog, workspace-installation and importer APIs.
This separation is useful, but those client methods and model classes alone do
not prove an operational integration marketplace. Corresponding integration URL
implementations were not located in the inspected API route tree.

Cerebro has real partial parity. [ConnectorSettings](../../../../src/app/ConnectorSettings.tsx),
lines 36–59 and 75–93, distinguishes unreadable status, not-observed, last-run
failure and sign-in. Its fingerprints cover exact connector configuration and
machine approval. Do not erase this by reducing connection state to a green
“Connected” badge. Configuration existence, authentication, discovered capability,
granted capability and recent successful use are different facts.

**Proposal and acceptance:** build a connection detail page with named account,
transport, allowed tools/resources, last observation, credential expiry where
actually known, and affected workflows. Disconnecting one installation pauses or
fails only its dependent steps with a repair action. Reconnecting does not silently
grant newly discovered tools. A “Test connection” operation must describe what it
actually exercised. Secret references and redacted diagnostic retention need an
explicit design if Cerebro starts owning credentials; the existing Claude-owned
sign-in path does not already supply that architecture.

### PL07 — Add semantic relationship affordances without hardcoding task types

Plane's [IssueRelationChoices](../../../examples/plane-preview/apps/api/plane/db/models/issue.py),
lines 272–313, defines duplicate, relates-to, blocked-by and other relation kinds,
including forward/reverse pairs and uniqueness. This gives work relationships a
meaning that an agent can explain and a person can inspect.

Cerebro is not missing relationships. [relations.ts](../../../../src/engine/relations.ts),
lines 1–9 and 22–67, builds an index and resolves forward/reverse links; lines
92–105 support related rollups. Its schema is more general than Plane's issue
domain. Preserve capability-based behavior and relation ownership rather than
checking for a `Task` type name.

Offer optional relation semantics in Type definitions: a blocking relation,
duplicate relation and perhaps a hierarchy relation with explicit inverse label.
Keep editorial links separate from dependency claims. The agent can propose a
relation with evidence, but a link must not automatically verify a knowledge
claim or establish that the dependency is finished.

**Acceptance:** a user asks why work is blocked, follows each dependency to its
record and sees the same explanation in a saved view and an agent plan. Rename,
delete, cycles and unresolved targets have defined states. Completion of a linked
record triggers reevaluation only under an explicitly configured workflow. This
is a schema/UX extension, not a reason to import Plane's project-specific model.

### PL08 — Build workflow affordances on existing saved views

Plane's [IssueView](../../../examples/plane-preview/apps/api/plane/db/models/view.py),
lines 58–71, stores query, filters, display properties, ownership and lifecycle
state. Its field defaults make layout and grouping part of the saved experience.
Cerebro already has recursive all/any filters in
[types.ts](../../../../src/engine/types.ts), lines 890–902, evaluated in
[viewFilters.ts](../../../../src/engine/viewFilters.ts), lines 501 onward, plus
shared [view vocabulary](../../../../shared/schema/views.v1.json). Nested filters
and saved views should be marked parity, not rediscovered as missing features.

The expansion opportunity is “Run an action on this view” and “Use this view as
workflow input.” Resolve a saved view into a bounded selection with a timestamp,
schema version and visible record count before approval. Specify whether a
scheduled execution re-evaluates the query or uses a fixed snapshot; both can be
useful, but they are different contracts.

**Acceptance:** preview ten matching records, change the filter or one record,
then approve. The system explains changed membership instead of silently applying
the operation to an unexpected set. An empty result differs from a failed read.
Apply per-item outcomes and resumable pagination without sending the entire vault
to the model. Reuse Cerebro's evaluator and batch writer; do not create a second
workflow-only filter language merely to resemble Plane's UI.

### PL09 — Show effects beside history while keeping versions distinct

Plane's [IssueActivity](../../../examples/plane-preview/apps/api/plane/db/models/issue.py),
lines 415–444, stores actor, field and old/new values. Its
[PageVersionEndpoint](../../../examples/plane-preview/apps/api/plane/app/views/page/version.py),
lines 19–52, separately reads scoped versions. These are different product records.

Cerebro already makes this distinction well.
[PageHistory](../../../../src/history/PageHistory.tsx), lines 20–52, separates
versions, recorded edits, runs and knowledge changes, with individual unavailable
states. The previous review's run-history defects remain relevant; Plane is not
evidence that Cerebro needs an entirely new timeline.

Extend history with external action attempts and confirmed effects linked to
their originating run, record and connection. Record an external object's ID/URL,
operation identity, result state and known affected fields. A recorded attempt is
not proof of a remote effect; a local Git restore is not an undo of a remote API
call. Offer a compensating action only when that adapter defines one.

**Acceptance:** answer “what did this agent change?” across local pages and remote
work, even after restart and a vault switch. The person can inspect unknown remote
outcomes and retry reconciliation. History failure retains the selected item and
provides retry. This connects CP02/CP07/CP09 to the connector roadmap rather than
adding an independent activity feed that disagrees with existing records.

### PL10 — Carry original scope into every asynchronous read and write

Plane's version endpoint filters by workspace, active project-page membership,
page and version identity. Its comments explicitly document why checking a page
identifier alone is insufficient. Its
[public issue API](../../../examples/plane-preview/apps/api/plane/api/views/issue.py),
lines 63–68 and 96–100, connects permission classes, webhook activity and OpenAPI
documentation. These are useful architecture boundaries, not proof that every
endpoint is correct.

Cerebro already exposes [personal client access](../../../../src-tauri/src/client_access.rs)
and scoped MCP tools. It should not add an unauthenticated HTTP CRUD API merely
to gain “integrations.” Separate inbound clients, outgoing connectors and workflow
executors. Each needs a stable originating vault, actor, target version and grant;
the currently visible vault is presentation state, not execution authority.

**Acceptance:** start an action in vault A, switch to B and open a delayed result.
Its details and links remain in A. Revoke the connection or token while a run is
waiting and verify the next dispatch rechecks authority. Test saved views,
historical versions and imported attachments under the same origin rules. For a
desktop app, remote callbacks additionally require a product decision about app
sleep/offline behavior and a possible relay; a Django/Celery deployment does not
solve that availability problem for Tauri.

## What to carry into the expansion plan

Prioritize PL01/PL02/PL06 together as one action-and-connection foundation, after
finishing the M91 producer/reducer/UI contract. PL03 and PL05 are smaller product
slices that make the existing assistant immediately more useful. PL04 is a
separate architecture decision with a migration spike; it should not block fixing
capture loss or adopting completed M91 components. Preserve the existing query,
relationship and history foundations while extending them with workflow semantics.

Plane does not justify rebuilding Cerebro as a multiuser project-management SaaS,
adopting its entire deployment stack, replacing React with Rust, or claiming
advanced agent orchestration from editor AI controls. Its most useful lesson is
that actions become usable when their inputs, targets, lifecycle and consequences
are first-class product concepts.

## Evidence fingerprints

SHA-256 prefixes below identify the inspected bytes; line references above refer
to this checkpoint. The reference is a vendored directory; no upstream release or
commit was inferred from its directory name.

| Source                                                      | SHA-256 prefix     |
| ----------------------------------------------------------- | ------------------ |
| Plane `LICENSE.txt`                                         | `0a4acb10f33c9384` |
| Plane `apps/api/plane/db/models/page.py`                    | `53cf3566f26b7491` |
| Plane `apps/api/plane/db/models/issue.py`                   | `ae65e270f1e7e1ed` |
| Plane `apps/api/plane/bgtasks/webhook_task.py`              | `96f328e5b6116b24` |
| Plane `apps/web/components/power-k/core/types.ts`           | `706407869937cc56` |
| Plane `apps/web/components/pages/editor/ai/ask-pi-menu.tsx` | `c1b70ae1bc49a09d` |
| Plane `apps/api/plane/app/views/external/base.py`           | `e1d24a2da7d608c0` |
| Cerebro `src/app/RecordComposer.tsx`                        | `115fc019f17ae904` |
| Cerebro `src/app/ConnectorSettings.tsx`                     | `5b30e194dcce847f` |
| Cerebro `src/lib/keys/registry.ts`                          | `e2b8943fcf3d507e` |
| Cerebro `src-tauri/src/vault/parse.rs`                      | `aacc41994b69386a` |
| Cerebro `src/engine/relations.ts`                           | `cbd508deb5b12815` |
| Cerebro `src/engine/viewFilters.ts`                         | `ed760c1d504ead17` |
