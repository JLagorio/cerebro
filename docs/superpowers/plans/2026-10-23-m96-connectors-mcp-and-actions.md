# M96 — Connectors, MCP and actions

**Milestone:** M96 · **Phases:** M96.1–M96.8 · **Requirements:** ACT-01–ACT-10.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build account-bound, reviewable and recoverable connected actions shared by chat, commands, Agents, workflows and inbound MCP.

**Architecture:** Rust owns immutable action definitions, credential resolution, approval binding and invocation/effect records. CLI-owned custom connections remain explicit compatibility routes; Cerebro-owned connections expose scoped broker tools without forwarding the provider route. React renders generated service types through existing AI elements.

**Tech Stack:** Existing Tauri 2/Rust, React 19/TypeScript, SQLite runtime, shared JSON policy/case artifacts, OS-backed secret storage, approved pinned MCP adapters.

**Spec:** [Connected actions design](../specs/2026-10-23-m96-connectors-mcp-and-actions-design.md).

## Global Constraints

- **DRAFT FOR OWNER REVIEW — not approved for execution.** No commands below have been run for this planning task; test names and new files are proposed.
- The user's Claude Code CLI remains the default execution backend.
- Each connection is `cli` or `cerebro` owned. A Cerebro-owned provider's raw server/credentials must not also be forwarded to the CLI.
- For Cerebro-owned connections, connector secrets resolve only in Rust through an OS-backed secret store; portable files, prompts, webview and receipts contain references only.
- Keep `outcome_unknown`; do not automatically repeat a consequential effect without adapter-proven idempotency/reconciliation.
- Gmail remains drafts-only; send, publish and delete are separate effect classes and require separate owner decisions before admission.
- Preserve guarded vault writers, CV-04 shared policy/parity, human-only knowledge verification, missing/unavailable distinctions and current files-first authority.
- All thresholds, retention choices, provider selections and experimental gates remain proposals until owner approval. Do not infer SDK/CLI support from protocol documentation.
- Implementation commits use `type(scope): sentence (M96.<phase>)`, never bypass hooks. Each task's commit occurs only after its checks pass.

## Review Focus

- Lost response after provider acceptance must remain unknown and make zero implicit repeat submissions — M96.3/M96.4 fault fixtures.
- Account switch during an approval must require review, while same-account token refresh preserves valid authority — M96.2/M96.3 identity fixtures.
- Catalog drift or unsupported schemas must refuse execution without losing entered drafts — M96.1/M96.4/M96.6 fixtures and form tests.
- Multi-window duplicate approval and recovery must consume one local claim — M96.3 transactional race and reopen tests.
- Revoked account scope must not leak through resource/catalog caches, logs, or an Apps/backend bypass — M96.4/M96.7/M96.8 adversarial cases.

---

## File map and execution boundaries

New paths below are **proposed**, not existing modules. `actions/` owns domain and
execution; `connections/` owns account/secret lifecycle; protocol files adapt wire
messages without deciding authority. CORE's Rust type generator supplies transport
DTOs; do not introduce a second ad hoc TS declaration. Existing `connectors.rs`
remains the CLI compatibility configuration boundary while migration is explicit.

| Responsibility        | Proposed or existing files                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain/catalog/policy | new `src-tauri/src/actions/{mod,types,catalog,schema}.rs`; new `shared/actions/{schema-subset.v1,action-cases.v1}.json`; new `shared/policy/actions.v1.json`                                           |
| Accounts/credentials  | new `src-tauri/src/connections/{mod,accounts,secrets,migration,gh_credentials}.rs`; existing `connectors.rs`, `runtime/schema.rs`, `lib.rs`                                                            |
| Durable execution     | new `src-tauri/src/actions/{service,approval,recovery}.rs`; new `runtime/action_invocations.rs`; existing `agent/interaction.rs`                                                                       |
| Protocol adapters     | new `src-tauri/src/connections/mcp/{mod,legacy,modern,cache}.rs`; existing `mcp.rs`, `client_access.rs`, `agent/mod.rs`                                                                                |
| Provider/UI journey   | new `src-tauri/src/connections/providers/github.rs`; new `src/connections/{ActionForm,ConnectionDetail,ActionEffectDetails}.tsx`; existing `app/ConnectorSettings.tsx`, IPC adapters and chat elements |
| Gated experiments     | new `src-tauri/src/connections/mcp/tasks.rs`, new `src/agent/apps/{McpAppFrame,appBridge}.tsx/.ts`, new `src-tauri/src/agent/backends/{mod,experimental}.rs`                                           |

Where a proposed directory does not exist, create its module declarations in
`src-tauri/src/lib.rs` as part of its owning task. Do not relocate unrelated code.
Commands use Rust test filters so unrelated suites are not the initial feedback
loop. Final gates are scheduled only after implementation exists.

### M96.1 — Freeze catalog, schemas and generated service contracts

**Files:** Create `actions/{mod,types,catalog,schema}.rs`, the shared action/schema
artifacts and `shared/policy/actions.v1.json`; modify `src-tauri/src/lib.rs`,
`shared/policy/{README.md,tools.v1.json,policy.v3.json,tool-approval.v1.json}`,
associated manifest digests/goldens and grant/prompt tests, and the CORE-owned type-generator registration; test new
`src/engine/actions/actionContract.test.ts` and Rust module tests. Coordinate
registration instead of editing CORE's generator concurrently.

**Interfaces:** Produces spec-exact `InvocationState`, `ActionSubject`,
`ActionEffectRef`, `ActionDefinition`, `PrepareAction`, `PreparedAction`,
`PersonActionDecision`, `ActionEffectDetails`, `SafeEffectPreview`, `ActionAttemptSummary`, `ActionCatalogPage`, `ActionDefinitionView`, `ActionError`, `ActionReadError` and ID newtypes.
`ActionCatalog::resolve(action_id, definition_digest) -> Result<ActionDefinition,
ActionError>` and `validate_input(definition, input) -> Result<ValidatedInput,
ActionError>` consume bounded JSON and return canonical digest/validated values.
`ActionService` signatures are the spec's canonical methods; later tasks supply
implementation. Initial schema subset and seven effect classes match the spec.

- [ ] Add shared fixtures `canonical_input_distinguishes_null_omission_and_array_order`, `unsupported_ref_is_not_callable`, `provider_annotation_cannot_downgrade_effect`, and `definition_digest_changes_with_schema`. Assert stable Unicode/numeric canonical forms, finite numbers only, immutable historical lookup and explicit unsupported results.
- [ ] Run `cargo test actions::` from `src-tauri` and `pnpm test:run src/engine/actions/actionContract.test.ts`; expect initial failure for missing implementation, then stable shared fixture results after implementation.
- [ ] Implement bounded schema validation, canonical input hashing and immutable catalog lookup. Keep policy in shared data; document replay/digest regeneration under CV-04 rather than inventing twin classification logic.
- [ ] Register spec-exact `list_actions`, `get_action_definition`, `prepare_action`, `get_action_effect` and `get_action_effect_details` manifest rows, renderer/effect semantics and operational refusal destiny. Add `broker_only_reviewed_rows_are_open_world`, `broker_catalog_is_account_scoped`, `broker_catalog_read_launches_nothing`, `broker_denied_grant_cannot_prepare`, `broker_prompt_names_only_held_tools`, `broker_never_mints_person_decision`, `external_receipt_is_not_vault_diff` and `mail_send_denials_remain`. Narrow the existing all-closed-world assertion only for approved broker rows; replay regenerated CV-04 artifacts/goldens and CV-06 refusal registration.
- [ ] Generate DTOs through CORE's contract facility; run `pnpm typecheck` and verify generated unions exactly preserve nullability and `outcome_unknown`. Add the generated-file drift check to the existing contract gate.
- [ ] Review unsupported-schema copy and commit this independently reviewable contract with its numbered M96 phase.

### M96.2 — Account lifecycle, credential broker and explicit legacy migration

**Files:** Create `connections/{mod,accounts,secrets,migration,gh_credentials}.rs`; modify
`connectors.rs`, `runtime/schema.rs`, `lib.rs`, `src/lib/ipc.ts`,
`src/app/ConnectorSettings.tsx`; test new `src/connections/ConnectionMigration.test.tsx`
and Rust connection module tests. Add an OS secret-store dependency only after
owner/platform selection; do not claim encryption from a reference alone.

**Interfaces:** Consumes M96.1 IDs. Produces `ConnectionService::{connect,
verify,reconnect,revoke}` returning `ConnectionStatus`, safe
`begin_gh_import(selection, expected_revision)`, `credential_acquisition(id)` and
`cancel_credential_acquisition(id)` returning spec-bound `CredentialAcquisition`, and
`SecretStore::{put,resolve,delete}(SecretRef)` callable only by Rust adapters.
`AccountBinding` separates account identity/revision/scope digest from secret
revision. `plan_legacy_migration(raw_config) -> MigrationPreview` never executes;
`commit_legacy_migration(preview_id, expected_digest) -> MigrationResult` checks
source bytes and reports remaining plaintext locations without returning values.

- [ ] Write `token_refresh_keeps_account_revision`, `changed_subject_invalidates_binding`, `issuer_change_never_reuses_secret`, `migration_failure_preserves_old_config` and `unapproved_stdio_scan_launches_nothing`. Assert cancellation, symlink refusal and source changes cannot silently replace configuration; preserved unknown fields remain byte/semantic equivalent under the documented serializer.
- [ ] Run `cargo test connections::` and `pnpm test:run src/connections/ConnectionMigration.test.tsx`; expect failures before implementation and PASS after minimal lifecycle/migration behavior exists.
- [ ] Add `gh_import_explicit_user_never_active_fallback`, `gh_env_token_override_is_removed`, `gh_import_identity_mismatch_installs_nothing`, `cancelled_import_cannot_commit`, `revoke_during_import_cannot_resurrect`, `late_refresh_cannot_overwrite_reconnect`, `disconnect_deletion_failure_stays_disabled` and `disconnect_does_not_claim_remote_revocation`. Use fake bounded subprocess and OS-store seams; no real account is needed for these cases.
- [ ] Implement the spec's `github.com`/selected-login native `gh` import without a shell, interactive login, app OAuth registration or React secret fields. Validate identity before OS-store installation; preserve `forge.rs`'s independent no-token contract. Import is a snapshot, not automatic refresh/re-import; reconnect is explicit. CAS attempt/connection/secret/revocation revisions and keep disabled after Disconnect even if secret cleanup fails.
- [ ] Implement issuer/account-bound OS-store references and bounded status metadata. Render distinct sign-in required, unavailable, unsupported and disabled states; no secret is sent to React. Connect/test/revoke are explicit user actions with timestamps.
- [ ] Add serialized payload/log/export negative fixtures containing sentinel env/header/token values; assert none appears outside the intentionally retained legacy input. Verify failed secret import creates no plaintext backup or partial owner switch.
- [ ] Prove reconnect/revoke in a disposable packaged account test, record platform/version and unsupported OS cases; commit only the verified lifecycle slice.

### M96.3 — Durable approval and invocation claim state machine

**Files:** Create `runtime/action_invocations.rs`, `actions/{service,approval,recovery}.rs`;
modify `runtime/{mod,schema}.rs`, `agent/interaction.rs`, `lib.rs`; test Rust modules
and new `src-tauri/fixtures/action-recovery-cases.json`.

**Interfaces:** Implements `ActionService::{catalog,definition,prepare,answer,dispatch,reconcile,
effect_ref,effect_details,request_cancel,retry}` from the spec. Produces transactional operational
`ActionInvocation`, `ActionApproval`, `ActionAttempt` records. `claim_dispatch(id, attempt_id,
expected_revision, checked_authority) -> Claimed | AlreadyClaimed | Stale` consumes
approval once. `effect_ref` is SELECT-only and scopes subject before exposing data.
The internal `ActionSubject` has private Rust constructors; attended IPC/inbound token/stored run resolution validates vault/run/actor/child/client relationships. Wire IDs are selectors/projections, never authority, and `dispatch` has no IPC/MCP entry. No inbound caller can construct `PersonActionDecision` or `PersonRetryDecision` through an MCP method. Persist the adapter-derived account/action-conflict-domain/target fence with the invocation; a fresh business ID cannot bypass it. Atomically bind `(trusted subject scope, requestKey)` to one request digest/invocation/approval; repeated identical prepare returns original IDs, changed requests conflict. Details expose invocation/approval revisions for mutation CAS. `retry` takes prior invocation/revision plus the attended uncertainty acknowledgement and produces a linked attempt only when broker policy permits.

- [ ] Write `two_windows_consume_one_dispatch_claim`, `edited_input_retires_old_approval`, `revocation_after_allow_prevents_dispatch`, `account_replacement_requires_review`, `fresh_run_cannot_bypass_unknown_effect_fence`, `prepare_same_key_returns_original_approval`, `prepare_key_different_input_conflicts`, `spoofed_vault_actor_child_client_ids_are_denied`, `dispatch_has_no_public_route`, and `same_account_refresh_keeps_binding`. Use real SQLite connections and barriers, not one mocked callback.
- [ ] Run `cargo test action_invocations::` and `cargo test actions::approval`; expect failure until transactions and binding exist, then one winning claim and zero stale dispatches.
- [ ] Implement state transitions, expiry and revalidation before dispatch. Preserve legacy page-write ask semantics; add an external-action durable record instead of relabeling the current memory book durable. On claim/restart ambiguity record unknown until the adapter proves disposition.
- [ ] Inject crashes before approval, after approval/before claim, after claim/before response and after response/before receipt commit. Reopen the DB; assert restored waiting state, no duplicate claim, and no unproved “failed” or “cancelled.” Verify chat deletion leaves minimal pending/unknown records readable. Crash immediately after ACT prepare but before FLOW saves its link; recovering with the durable requestKey must return the original invocation/approval and one record. Reject forged subject IDs before any provider call or durable mutation.
- [ ] Run `cargo test actions::recovery` and the legacy `cargo test agent::interaction`; expect all new recovery cases and unchanged page-write guards. Commit the transactional slice.

### M96.4 — Outbound protocol adapters and strict ownership routing

**Files:** Create `connections/mcp/{mod,legacy,modern,cache}.rs`; modify
`connectors.rs`, `agent/mod.rs`, `mcp.rs`, `client_access.rs`; create
`src-tauri/fixtures/mcp-action-cases.json` and proposed adapter tests.

**Interfaces:** `OutboundAdapter::{discover,invoke,reconcile,cancel}` consumes
resolved account/definition/input and returns typed observations, never approval.
`CapabilitySnapshot` binds protocol/catalog to account/config/grant scope.
`build_cli_connections(selection) -> CliConnectionPlan` excludes every
Cerebro-owned raw provider route, including inherited configuration.
Resource reads produce provenance-bearing references; prompts produce inspected
editable templates with zero grant changes.

- [ ] Write adapter fixtures for legacy initialization, modern discovery/per-request metadata, unsupported methods, pagination, malformed/oversized output after mutation without false confirmed failure, auth refresh, account-separated caches and catalog-change rejection. A version constant does not satisfy a compatibility fixture.
- [ ] Run `cargo test connections::mcp` and `cargo test cerebro_owned_route_is_not_forwarded`; initially fail, then assert no raw URL, executable, headers or credentials enter brokered CLI config. Include the absent-config legacy path and personal-token listener mode.
- [ ] Route broker MCP methods through manifest-derived grants and operational refusals from M96.1; add `inbound_broker_uses_stored_subject`, `outbound_result_invalid_keeps_effect_unknown` and `managed_route_has_no_raw_cli_alias`. Never classify a post-submission parse/schema error as proof no remote write occurred.
- [ ] Pin adapters only after reviewing dependency license, transport/version coverage and retry behavior. Disable mutation retry below ActionService. Distinguish a fresh wire request ID from one stable business invocation/key.
- [ ] Simulate provider acceptance followed by dropped response; assert one submission, `outcome_unknown`, no reconnect replay and scoped reconciliation. Denied resources must not appear in list/cache/completion/preview paths for another account.
- [ ] Record an interoperability matrix for the installed CLI and approved local/HTTP fixtures: version, transport, feature, actual result and unsupported reason. Preserve current inbound adapter until its replacement passes the same guards. Commit adapters with evidence, not support claims based on docs.

### M96.5 — Ship the first complete managed provider journey

**Files:** Create `connections/providers/{mod,github}.rs`; modify action policy data,
IPC adapters and `src/lib/mockIpc.ts`; create `src/connections/{ConnectionDetail,
ActionForm}.tsx` and tests; extend `src/app/ConnectorSettings.tsx`.

**Interfaces:** Register immutable `github.issue.read` and `github.issue.create`
definitions through M96.1. Native provider transport or an approved MCP adapter
may implement them, but both use ActionService. Create input fixes repository,
title and body; preview states account and repository, while result retains remote
issue ID/URL with bounded original structured output.

- [ ] Add `read_issue_then_review_create`, `wrong_account_never_falls_back`, `duplicate_allow_creates_one_issue`, and `lost_response_shows_unknown` provider fixtures. Assert read scope and mutation authority are distinct; direct provider calls are absent from React.
- [ ] Run `cargo test github` and `pnpm test:run src/connections/ActionForm.test.tsx`; fail before implementation and pass after schema-backed validation, draft retention and preview are connected.
- [ ] Implement supported controls from schema plus purpose-built Markdown body input. Render account/target before Allow, preserve edits after stale schema rejection and expose explicit revalidation. Show safe Check only when a designated handshake/read exists; unsupported checks execute no business tool.
- [ ] Perform one disposable live GitHub acceptance after owner-approved provider setup: read, approve create, deny create, revoke, restart and reconcile simulated disconnect. Record actual account-free/sanitized evidence; never mutate the user's ordinary project for a demo.
- [ ] Run `pnpm typecheck`, `pnpm lint` and targeted tests; commit the complete beta slice. Register no mail send/publish/delete action.

### M96.6 — Shared effect inspection and three consumer journeys

**Files:** Create `src/connections/ActionEffectDetails.tsx` and test; modify
`src/agent/elements/`, `src/agent/toolRenderers.tsx`, `src/status/` run-detail
components, `src/app/ConnectorSettings.tsx` and corresponding tests; add
`e2e/connected-actions.spec.ts`.

**Interfaces:** All views consume compact `ActionEffectRef` and fetch `ActionEffectDetails` through scoped `effect_details`; the detail DTO supplies safe account/target/asked+approved preview, invocation/approval revisions and attempt receipts. Never render an approval from the compact ref alone. Invoke `reconcile`/`request_cancel` and broker-approved retry commands with details-derived expected revision; `answer` compares both invocation and approval revisions. Stale UI refreshes without clearing the draft.
CHAT retains invocation/approval IDs only. FLOW consumes the same API later.
The three end-to-end entry paths are human command, chat request and saved workflow
step; workflow completion depends on M98.3 and is explicitly blocked until then.

- [ ] Add `unknown_effect_survives_thread_deletion`, `schema_drift_retains_form_draft`, `cancel_after_dispatch_is_intent` and `failed_catalog_is_unavailable`, `stale_details_cannot_approve`, `redacted_details_omit_secrets`, `details_cross_subject_read_denied`, and `edited_approval_renders_approved_preview` component/service tests. Assert the exact “Outcome unknown” label and no enabled retry unless `canRetry` is true.
- [ ] Run targeted `pnpm test:run src/connections/ActionEffectDetails.test.tsx`; implement shared views through existing AI elements, with persistent errors and account-specific permission summaries.
- [ ] Add keyboard acceptance for account selection, preview editing, approve/deny, reopening an effect from Runs, returning to the same chat draft and reading position. Unknown outcome remains visible when the parent answer fails.
- [ ] After M98.3 exists, run `pnpm e2e e2e/connected-actions.spec.ts`; expect identical invocation semantics across command/chat/workflow and no duplicate approval queues. Run browser accessibility checks and packaged native focus acceptance; record limits separately.
- [ ] Commit consumer integration after the three journeys are inspectable; do not claim the workflow path complete before its dependency passes.

### M96.7 — Gate remote Tasks and one isolated MCP App experiment

**Files:** Create `connections/mcp/tasks.rs`, `src/agent/apps/McpAppFrame.tsx`,
`src/agent/apps/appBridge.ts`, tests and `e2e/mcp-apps.spec.ts`; modify packaged
capabilities/navigation configuration only through a narrowly reviewed proposal.

**Interfaces:** `RemoteTaskRef` belongs to one ActionAttempt and records account,
remote handle, TTL and input continuation revision. `AppBridge::requestAction`
returns an ActionService invocation reference and accepts only its allowlisted
message schema/origin/frame instance. Both features default disabled (proposal).

- [ ] Add `task_handle_reopens_without_resubmission`, `expired_handle_stays_unknown`, `duplicate_input_does_not_repeat_effect` and `cancel_is_cooperative` fixtures; run `cargo test connections::mcp::tasks` before/after implementation.
- [ ] Implement Tasks only for negotiated, matrix-tested peers, persisting handles before depending on polling. An expired remote handle does not erase the underlying uncertain effect or grant unsafe retry.
- [ ] Add malicious-frame cases for parent navigation, Tauri IPC, storage, credential access, forged origin, ungranted tool and network-origin escape. Run `pnpm test:run src/agent/apps` and `pnpm e2e e2e/mcp-apps.spec.ts`; expected refusal plus structured fallback, no global navigation relaxation.
- [ ] Prove one packaged Tauri App resource with keyboard enter/exit, dead connection, unavailable restored resource and mediated approval. If native isolation fails, leave Apps disabled and deliver the report/fallback as the independently reviewable result.
- [ ] Commit the gated experiment only; owner decides any production enablement separately.

### M96.8 — Bound a second backend and close operational release gates

**Files:** Create `agent/backends/{mod,experimental}.rs` and tests; add
`docs/superpowers/evidence/connected-actions/compatibility.md` at execution time;
modify action recovery/retention modules and existing release checks as needed.

**Interfaces:** `BackendCapabilities` declares streaming, tools, approval suspension,
checkpoint, measured usage, child scope and cancellation support. The adapter
returns the existing normalized execution events and calls ActionService; model
credentials resolve only through a separate Rust secret namespace. CLI remains
selected by default; backend experiment is opt-in and disabled by default.

- [ ] Write `unsupported_approval_is_refused_before_start`, `backend_has_no_raw_provider_credentials`, `unknown_usage_is_not_zero`, and `backend_restart_cannot_replay_effect`. Run `cargo test agent::backends`; implement only one approved backend prototype, not an unbounded provider framework.
- [ ] Run adversarial cross-entry tests for revoked subject, forged account, unsupported schema and low-level retry defaults. Confirm no alternate adapter can bypass broker approval or mint a person decision.
- [ ] Test full-store/cleanup/backup behavior: purge verbose completed output, retain pending/unknown minimal receipts, and refuse new mutations on durable-write failure. Document proposed quotas and explicit unresolved deletion behavior for owner approval.
- [ ] Run the implementation release gate: `pnpm test:run`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`; in `src-tauri`, `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`. Record failures and actual native/provider evidence separately; never substitute fixture success for interoperability.
- [ ] Commit with its numbered M96 phase and present compatibility/retention/backend/App gate decisions for owner review.

## Self-review and handoff

Research traceability: AX01 action seam → M96.1/M96.3; AX02 → M96.2; AX03 → M96.4/M96.7;
AX04 → M96.3/M96.8; AX06 → M96.5/M96.6; AX11 → M96.7/M96.8. n8n N1–N5/N9 → M96.1–M96.6;
AppFlowy AF-06/07 → M96.4/M96.8; Plane PL01/02/06/09/10 → M96.1–M96.6; Activepieces
AP-07/08 → M96.2–M96.6; protocol review → M96.4/M96.7.

ACT-01/03 map to M96.1/M96.4; ACT-02/08 to M96.2; ACT-04/05/09 to M96.3/M96.8;
ACT-06 to M96.4/M96.7; ACT-07 to M96.5/M96.6; ACT-10 to M96.7/M96.8. Each Review Focus class has
an explicit regression case above. Later tasks consume the canonical service and
wire types; none redefines effects or approval authority. CORE generation and FLOW
integration are dependency gates, not silently completed work. No implementation,
test execution, staging or commit is authorized by this draft. Owner review should
select beta provider/secret-store platform, retention/quotas, supported protocols
and whether either experiment advances beyond disabled proof.
