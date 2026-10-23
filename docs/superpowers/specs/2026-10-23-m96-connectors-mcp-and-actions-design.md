# M96 — Connectors, MCP and actions design

**Milestone:** M96 · **Phases:** M96.1–M96.8 · **Requirements:** ACT-01–ACT-10.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

Status: **DRAFT FOR OWNER REVIEW — 2026-10-23.** This is a proposed product and
engineering contract, not authorization to implement or a compatibility claim.
No application, provider, CLI session or suite was executed for this draft.

## Intent and recommendation

Make a connection, its account and its callable actions visible product objects.
A person should connect GitHub, read a scoped issue, review the account, repository,
title and body of a proposed issue, approve it, and find its actual outcome after
restart. Chat, commands, Agents, workflows and authorized inbound clients use one
Rust action service. React presents the service's answers through the existing AI
elements. The user's Claude Code CLI remains the default execution backend.

Recommend a Rust broker with explicit ownership per connection. Continue supporting
CLI-owned custom MCP as a labeled compatibility mode. A catalog-only enhancement
would improve discovery but leave unknown effects and duplicated authority unsolved.
Forwarding every server through both CLI and Rust would appear convenient but let
a caller bypass the reviewed invocation. Replacing the CLI with a provider SDK
would enlarge the credential and execution contract before the basic journeys work.
Neither alternative is recommended. These are recommendations for owner review.

The first managed-provider beta is **GitHub issue read and reviewed issue creation**.
This is a proposed slice, not a statement of shipped provider support. Keep advanced
custom MCP configuration. Gmail remains drafts-only; send, publish and delete are
separate effect classes and require separate owner decisions before admission.

## Evidence and current boundaries

Read the [expansion recommendation](../plans/2026-10-22-ai-expansion-plan.md),
[connector architecture review](../plans/2026-10-22-ai-expansion-review/connectors-and-workflows.md),
[n8n N1–N5/N9](../plans/2026-10-22-ai-expansion-review/n8n.md),
[AppFlowy AF-06/07](../plans/2026-10-22-ai-expansion-review/appflowy.md),
[Plane PL01/02/06/09/10](../plans/2026-10-22-ai-expansion-review/plane.md),
[Activepieces AP-07/08](../plans/2026-10-22-reference-review/activepieces.md) and
[protocol review](../plans/2026-10-22-ai-expansion-review/protocol-compatibility.md).
References are design evidence from inspected snapshots, not product benchmarks.

Current source inspected for this draft establishes:

- [connectors.rs](../../../src-tauri/src/connectors.rs) reads per-vault server
  configuration, refuses symlinked owned paths, approves exact specs per machine,
  and fingerprints env/header values without putting those values in its approval
  ledger. The vault configuration can contain those values; the module's broad
  “holds no credentials” wording must not become a stronger security claim.
- [agent/mod.rs](../../../src-tauri/src/agent/mod.rs)'s `mcp_config_json` assembles
  CLI configuration. This is distinct from a Rust outbound protocol client.
- [mcp.rs](../../../src-tauri/src/mcp.rs)'s `PROTOCOL_VERSION` remains
  `2025-06-18`; `answer_protocol` handles initialize/ping and tools dispatch, and
  `initialize_result` advertises tools. This does not establish resources/prompts
  or extension support. [client_access.rs](../../../src-tauri/src/client_access.rs)
  is a separate opt-in personal-token loopback listener.
- [interaction.rs](../../../src-tauri/src/agent/interaction.rs) already binds
  one-use page-write approval to precise context and input. Its book is explicitly
  memory-only and settles unanswered deferrals conservatively after quit. Extend
  external-action durability without calling that current behavior data loss.
- [runtime/dispatch.rs](../../../src-tauri/src/runtime/dispatch.rs),
  [wakes.rs](../../../src-tauri/src/runtime/wakes.rs) and guarded vault writers
  already supply transactional admission and receipts. They do not prove
  exactly-once remote effects or that every CLI filesystem write is brokered.

The official [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
reopened on 2026-10-23, describes removal of the initialization handshake and
transport sessions, per-request metadata and discovery. Its changed wire contract
requires an adapter; changing a constant is insufficient. Official
[Tasks](https://modelcontextprotocol.io/extensions/tasks/overview) describe durable
handles and cooperative cancellation, while [Apps](https://modelcontextprotocol.io/extensions/apps/overview)
describe isolated UI resources and host mediation. No installed interoperability,
SDK maturity or packaged Tauri isolation is established by those documents.

## Requirements

1. **ACT-01 — One authority.** Every brokered action resolves in Rust from a
   scoped subject, immutable definition, account binding, local effect policy and
   validated input. Each connection is `cli` or `cerebro` owned. A Cerebro-owned
   provider's raw server/credentials must not also be forwarded to the CLI.
2. **ACT-02 — Accounts and secrets.** Support distinguishable accounts per
   provider, explicit selection, connect/test/reconnect/revoke, and account-scoped
   catalogs. For Cerebro-owned connections, connector secrets resolve only in Rust through an OS-backed secret
   store; portable files, prompts, webview and receipts contain references only.
   Model credentials and inbound client tokens remain separate domains.
3. **ACT-03 — Immutable capability contracts.** Freeze schema and classification
   revisions. Unknown schema features make that action unsupported, never an
   unchecked JSON escape hatch. Server annotations do not grant local permission.
4. **ACT-04 — Approval and dispatch.** Bind a person's decision to one invocation,
   semantic input digest, account identity/revision, definition, target, grant and
   policy. Revalidate immediately before one transactional local dispatch claim per approved
   attempt. A reviewed retry creates a linked attempt and fresh claim; it never
   reuses the spent original approval.
   Bearers and providers can wait for approval; they cannot answer for the person.
5. **ACT-05 — Honest outcomes.** Distinguish confirmed failure from lost response
   after possible submission. Keep `outcome_unknown`; do not automatically repeat
   a consequential effect without adapter-proven idempotency/reconciliation.
6. **ACT-06 — Protocol planes.** Maintain separate inbound legacy/modern adapters,
   Rust outbound adapters and CLI-owned forwarding. Tools, resources and prompts
   require account/scope checks. A modern adapter advertises only tested features.
7. **ACT-07 — Useful surfaces.** Provide account/action selection, supported schema
   forms, effect previews, safe health checks and shared effect details in Settings,
   chat, Runs and workflow inspection. A failed catalog read is unavailable.
8. **ACT-08 — Migration.** Preserve legacy configuration and unknown fields until
   an explicit ownership/secret migration succeeds. No passive scan launches an
   unapproved command. A migrated spec requires fresh machine approval/grant binding.
9. **ACT-09 — Durable minimal evidence.** Retain pending/unknown reconciliation
   receipts independently of conversation cleanup. Keep raw output separately
   bounded and deletable. Operational action history is not knowledge evidence.
10. **ACT-10 — Bounded expansion.** An additional execution backend, remote Tasks
    and one MCP App each have an experimental acceptance gate. None silently
    expands the production capability set or weakens packaged navigation policy.

## Credential bootstrap and broker admission

The proposed GitHub beta imports an existing credential through the person's
installed `gh`, only after an explicit Connect/Replace decision. It supports
`github.com` and one explicitly selected login; multiple stored bindings remain
possible, but an active-account change in `gh` never switches one. Rust obtains
bounded account metadata, then runs `gh auth token --hostname github.com --user
<selected-login>` without a shell, capturing the secret only in private native
memory. Clear `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
`GITHUB_ENTERPRISE_TOKEN`, host overrides and debug output; disable prompts and
bound process time/output. Validate the token's authenticated provider subject
through an HTTPS identity read before installing an app-owned OS-store reference.
Missing `gh`, unavailable account, unsupported CLI flags, denied keychain access
or mismatched identity yields a repairable status and no fallback account.

This command shape was checked against installed `--help` and the official
[token](https://cli.github.com/manual/gh_auth_token) and
[environment](https://cli.github.com/manual/gh_help_environment) manuals; no token
was requested and no sign-in was exercised. Existing
[forge.rs](../../../src-tauri/src/forge.rs#L282) demonstrates bounded native `gh`
process setup, but remains a read-only feature that never reads tokens. The new
credential acquisition module owns a separate, reviewed secret-capture path.
React receives only attempt/status/account metadata; no token, token-bearing
stdout/stderr, config file or debug log crosses IPC. Do not invoke interactive
login, alter `gh`'s active account or import all its accounts. If no usable login
exists, explain external `gh` setup; app OAuth/device-flow registration and
arbitrary-host discovery remain separately designed, disabled capabilities.

`CredentialAcquisition` binds an opaque attempt ID to the attended person,
connection, fixed host/login, expected connection revision and revocation
generation. `begin_gh_import(selection, expected_revision)` returns its safe status;
`credential_acquisition(id)` polls status, and `cancel_credential_acquisition(id)`
retires it. Commit a verified OS-store reference only if that attempt is current;
late completion after cancel, reconnect or revoke deletes its unused app secret.
This bounded import has no OAuth callback. Any later OAuth capability must first
specify registered client/redirect ownership, per-attempt state/PKCE where required,
expiry, one-time callback consumption and cancellation; a URL alone is insufficient.

The imported beta credential is a snapshot: there is no automatic `gh` re-import
or refresh. Expiry/revocation requires explicit reconnect, retaining the same
account revision only when the validated subject/issuer/scopes are unchanged.
Future refresh serializes per binding and CASes the secret revision plus current
connection/revocation generation; a late refresh cannot resurrect a disconnected
binding or overwrite a newer reconnect. The source lessons are Activepieces'
[refresh lock](../../examples/activepieces-main/packages/server/api/src/app/app-connection/app-connection-service/app-connection.handler.ts#L151)
and n8n's [checked token writeback](../../examples/n8n-master/packages/cli/src/credentials-helper.ts#L910).
`revoke` first durably disables Cerebro dispatch and invalidates approvals, then
removes the app-owned secret and account-scoped caches; failed deletion remains
visible/retryable while the binding stays disabled. UI calls this Disconnect:
`remoteRevocation: not_attempted` is explicit. It neither logs out `gh` nor claims
the upstream credential was revoked. Original `gh` authority is independent;
this proposal does not assert a sandbox around the person's other CLI access.

Broker entry tools are declared in `shared/policy/tools.v1.json`, never a second
hard-coded MCP tool list: proposed names are `list_actions`,
`get_action_definition`, `prepare_action`, `get_action_effect` and
`get_action_effect_details`. The first two return bounded, account/grant-scoped
current catalog descriptors and supported schemas; unavailable catalogs never
become empty. They read approved snapshots and cannot launch discovery/sign-in.
Preparation takes the catalog/definition/account
selectors and semantic request only; identity comes from Rust. Read selectors
remain scoped. Attended answer/retry controls are IPC commands, never person
decisions exposed to MCP. Tool facts, renderers, grants, prompt inclusion and
`open_world` annotations must describe brokered external effects honestly. Narrowly
replace the current all-tools-closed-world assertion in
[policy/tools.rs](../../../src-tauri/src/policy/tools.rs#L1671) with fixtures that
allow only the reviewed broker rows; preserve all existing mail-send denials.
Every new refusal code is registered with operational destiny in the shipped
`policy.v3.json`, with shared artifact/golden regeneration and grant/denial replay
under CV-04/CV-06/CV-19/CV-29. External receipts never pretend to be a vault diff.

## Canonical contracts and ownership

This spec is the program's owner of action/account/approval wire semantics. Rust
owns domain types; CORE supplies generated TypeScript transport types. CHAT and
FLOW store opaque references and project the service result, without an alternate
approval or effect ledger. Proposed files named below do not exist yet.

All IDs are opaque stable strings. Every entry point obtains an operational run
identity before preparing an action, including human commands and external clients.
Rust derives `ActionSubject` from an authenticated attended session, inbound token
or stored run/job authority. It validates vault/run/actor/client/child ownership and
current grants as one relationship, never independent caller assertions. The wire
shape below is a projection for inspection; deserializing matching strings cannot
construct the internal subject. Rust fields/constructors are private. Public IPC/
MCP calls accept an invocation/context selector and derive the subject; providers,
frames and model tool arguments cannot choose an actor, child or another client.
`dispatch` is an internal broker method, absent from public IPC/MCP routing.
Wire properties use camelCase; Rust fields use serde camelCase mappings.

```typescript
type InvocationState =
  | 'prepared'
  | 'awaiting_approval'
  | 'ready'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';
type ActionSubject = {
  vaultId: string;
  runId: string;
  actorId: string;
  childJobId: string | null;
  clientId: string | null;
};
type ActionEffectRef = {
  invocationId: string;
  state: InvocationState;
  approvalId: string | null;
  accountLabel: string | null;
  canReconcile: boolean;
  canRetry: boolean;
};
```

`null` means not recorded/unavailable as the accompanying read status explains;
never substitute another account. `canRetry` and `canReconcile` are broker-derived
capabilities, not authorization flags writable by callers. Scoped reads distinguish
not found, denied and unavailable without leaking the denied target.

`ActionEffectRef` stays compact. A scoped `ActionEffectDetails` read supplies the
reviewable state required to render an approval or recovery control:

```typescript
type ActionEffectDetails = {
  effect: ActionEffectRef;
  revision: number;
  account: { accountId: string; label: string; accountRevision: number } | null;
  target: { kind: string; label: string; safeReference: string } | null;
  definitionDigest: string;
  inputDigest: string;
  preview: SafeEffectPreview;
  approval: {
    approvalId: string;
    revision: number;
    expiresAt: string;
    askedInputDigest: string;
    approvedInputDigest: string | null;
    approvedPreview: SafeEffectPreview | null;
  } | null;
  attempts: ActionAttemptSummary[];
};
```

`SafeEffectPreview` is a bounded summary plus schema-ordered labeled redacted
field values and redacted field names. It never contains SecretRef resolution,
headers, environment, tokens or unrestricted raw provider payloads. Target/account
fields are unavailable when denied/not recorded, never substituted. Each
`ActionAttemptSummary` contains attempt ID/ordinal/state, dispatch/observation times,
receipt ID, safe remote-effect reference and safe outcome summary; pagination is
scoped by the same subject. Details distinguish asked versus approved edited
input. Mutation commands compare the returned invocation/approval revisions;
stale controls refresh and retain the user's draft instead of consuming approval.
Scoped details reuse the operational SELECT-only reader and source access checks.

| Object               | Frozen/authoritative content                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Connection`         | `connectionId`, provider/server identity, transport, `executionOwner`, config revision, safe label, account binding and `SecretRef`; health observations have timestamps and error status                                               |
| `AccountBinding`     | `accountId`, validated provider subject and issuer/server identity, `accountRevision`, granted-scope digest; token refresh for the same identity is a separate secret revision                                                          |
| `ActionDefinition`   | namespaced `actionId`, immutable `definitionDigest`, input/output schema digests and bounded schema bytes, adapter revision, effect class, required capabilities, retry/cancel/reconcile contract                                       |
| `CapabilitySnapshot` | connection/account/config revisions, observed protocol, discovery time, catalog digest; discovered/authenticated/granted/callable are separate facts                                                                                    |
| `ActionInvocation`   | invocation and subject IDs, definition/snapshot IDs, account revision, validated canonical input/reference and digest, unresolved-effect conflict key, policy/grant digest, state, approval ID, attempts and observed remote identities |
| `ActionApproval`     | approval ID, invocation ID, asked/approved input digests, approved immutable input, account/target/definition/grant/policy binding, expiry, person decision, consumed dispatch claim                                                    |
| `ActionAttempt`      | attempt ID, invocation ID, ordinal, transport request ID, stable business idempotency key when supported, dispatch claim, remote task/effect ID, receipt and observed outcome                                                           |

Effect classes are proposed as `read`, `local_write`, `external_draft`,
`external_mutation`, `external_send`, `external_publish`, `external_delete`.
Local policy maps definitions to these classes; provider metadata cannot downgrade
one. Shared policy data and replay cases hold any TS/Rust agreement (CV-04).
An action definition change makes a new digest, never edits the historical object.

The first schema subset is a proposal: JSON Schema 2020-12 objects, arrays,
string/number/integer/boolean/null, required/properties/additionalProperties,
enum/const, scalar/array bounds and descriptions. Remote `$ref`, executable
extensions and unimplemented composition keywords are unsupported. Rust validates
both input and bounded output; UI form support never stands in for validation.
An invalid/oversized response after possible submission is not proof the effect
failed: retain any confirmed remote identity, otherwise `outcome_unknown`, and
block dependent mappings until a usable result is reconciled.
Canonical semantic input hashing uses one documented sorted-object-key JSON
encoding over validated finite values, with shared cases for Unicode, numeric
forms, omitted versus null and array order. Secret-bearing input fields become
references before persistence; reject adapters that require embedding secrets.

Proposed service signatures are:

```rust
catalog(subject: ActionSubject, cursor: Option<CatalogCursor>) -> Result<ActionCatalogPage, ActionReadError>
definition(subject: ActionSubject, action_id: ActionId, definition_digest: DefinitionDigest) -> Result<ActionDefinitionView, ActionReadError>
prepare(subject: ActionSubject, request: PrepareAction) -> Result<PreparedAction, ActionError>
answer(person: PersonActionDecision) -> Result<ActionEffectRef, ActionError>
dispatch(invocation_id: InvocationId) -> Result<ActionEffectRef, ActionError>
reconcile(subject: ActionSubject, invocation_id: InvocationId, expected_revision: u64) -> Result<ActionEffectRef, ActionError>
retry(subject: ActionSubject, invocation_id: InvocationId, expected_revision: u64, decision: PersonRetryDecision) -> Result<ActionEffectRef, ActionError>
effect_ref(subject: ActionSubject, invocation_id: InvocationId) -> Result<ActionEffectRef, ActionReadError>
effect_details(subject: ActionSubject, invocation_id: InvocationId) -> Result<ActionEffectDetails, ActionReadError>
request_cancel(subject: ActionSubject, invocation_id: InvocationId, expected_revision: u64) -> Result<ActionEffectRef, ActionError>
```

These are methods of proposed `ActionService`. `ActionCatalogPage` contains bounded
descriptors, callable/unsupported/unavailable status, snapshot identity and opaque
next cursor; `ActionDefinitionView` contains the immutable supported input/output
schema, effect class and required grants without secrets or granted authority.
Both reads revalidate current account/grant scope. `PrepareAction` names action and
definition digest, connection/account IDs, snapshot digest, semantic input and
`requestKey`. Before calling prepare, a workflow durably records requestKey from
its run/step/attempt tuple; other entry points similarly persist a logical request
identity before issuing the command. The broker atomically maps `(trusted subject
scope, requestKey)` uniquely to one invocation/approval and request digest. Retrying
that key with the same validated request returns the original IDs/current state,
after access revalidation; different input/definition/account yields
`request_key_conflict` and writes nothing. This lookup precedes unresolved-effect
fence rejection so recovery can find its original unknown invocation. Never create
a fresh key merely because the caller lost the prepare response. This closes the
crash between ACT prepare and FLOW saving its invocation reference.
`PreparedAction` returns invocation/effect references, validated preview and any
approval ID. `PersonActionDecision` is minted only by the attended command boundary
and carries approval ID, decision, optional edited input,
`expectedInvocationRevision` and `expectedApprovalRevision`. `reconcile`, `retry`
and `request_cancel` compare the invocation revision returned by details; stale
requests return a typed conflict and never widen authority.
Typed errors carry code, retry disposition and safe explanation; UI actions catch
and toast per CV-03 while proposal callers read typed refusals.

## State, recovery and user experience

Preparation writes `prepared`, then `awaiting_approval` or policy-authorized
`ready`. Editing input creates a new preview/revision and invalidates the old
approval. Approval transitions to ready; dispatch atomically consumes one claim
only after rechecking identity, revocation, expiry, grants, target and schema.
A token refresh for the same validated account may proceed; a replaced identity,
expanded scopes or incompatible catalog returns to review. A crash after claim
is never grounds to allocate a second invocation automatically.

`dispatched` means the request may have reached the provider. Confirmed results
become succeeded/failed; ambiguity becomes `outcome_unknown`. A provider idempotency
key is stable across explicitly permitted attempts even if a wire request ID
changes. Disable implicit mutation retries in adapters/SDKs. Reconciliation may
resolve an unknown through a durable handle or status query; otherwise show the
account, target, attempted change and uncertainty. An informed human retry creates
a linked attempt only after the broker checks the adapter contract and obtains
new approval when needed. `PersonRetryDecision` comes from an attended command,
names the prior invocation/revision and acknowledges its recorded uncertainty; it
is not an MCP caller flag. Local one-claim safety is not exactly-once remote delivery.

Persist an unresolved-effect fence derived by the adapter from validated account,
action conflict domain and semantic target. `prepare` rejects an overlapping
consequential request while that fence is unresolved, even with a new run, chat
attempt or business invocation ID. Superficial input/nonces cannot change it. Only
broker reconciliation or the explicit reviewed `retry` path can permit another
attempt; a caller cannot rename a rerun into an independent effect. Conservative
fence granularity (for example, repository-level issue creation when no finer
identity exists) is an owner-reviewed provider contract with shared fixtures;
prefer temporarily blocking independent work over silently duplicating an unknown
mutation. Reads remain available for reconciliation.

Cancellation before submission can become cancelled. After submission it records
intent and stays dispatched/unknown until confirmed; stopping a spinner is not
proof. Compensation is another reviewed action with its own receipt, not local
Undo. Render confirmed writes and unresolved effects when a parent run fails.

Settings shows last verified health, freshness and capabilities separately.
A Check uses an approved harmless handshake/read with timeout and cancellation;
if unsupported, say “A safe connection check is unavailable.” Do not run the first
business tool. Forms label provider account and target before approval, retain
edited drafts after rejection and explain schema/account drift without losing
input. Resource reads carry provenance to CHAT/KNOW; prompts are inspectable,
editable starting instructions and grant nothing. Rich results first use bounded
Cerebro-owned renderers and preserve the original result independently of views.

## Privacy, migration and gates

Proposed retention: verbose successful action output follows the chosen chat/run
policy; pending approvals and unresolved minimal effect records have no automatic
age purge until resolved or explicitly exported and removed with an explained
consequence. Owner must approve quotas, encryption/backup exclusions and how full
storage stops new effects without losing pending records. Minimal evidence includes
identity, target, input digest/safe summary, dispatch time, remote handle and
reconciliation state; avoid retaining full email bodies just to record uncertainty.
Secrets never enter vault exports, logs, model context or transcript fixtures.

The migration inspects legacy fields without executing them, shows where secrets
remain, imports chosen values into the secret store, verifies identity, writes
references, and only then offers removal of old plaintext. Cancellation/failure
keeps the old route explicit; never make a second plaintext backup. A CLI-owned
OAuth session is not transferable merely because its server URL is known.

The separate [workflow spec](2026-10-23-m98-workflows-and-automation-design.md) consumes this
state machine. CHAT consumes `ActionEffectRef`; CORE owns storage/type-generation
facilities. Files remain workspace authority until a separate CORE decision.

Acceptance requires two-window approval races, crash injection around dispatch,
lost-response mutation, account replacement versus token refresh, schema drift,
cross-account cache denial, unapproved stdio launch refusal, secret scanning and
packaged native journeys. Tasks add handle/input/cancel/TTL restart proof. MCP Apps
must prove no Tauri IPC/storage/vault/credential access, mediated calls, navigation
and keyboard escape with structured fallback. A backend experiment declares actual
stream/tool/approval/checkpoint/usage/child/cancel support and refuses unsupported
requests. Each gate can reject expansion while retaining the core broker journey.
