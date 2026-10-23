# Final M96/M98 source-backed audit

Scope: read-only inspection of the dirty documentation/source snapshot, before documentation corrections. No product, provider, account request, build, test, branch or index operation was executed. Local `gh auth token --help` and `gh auth status --help` inspected command shape only. No Critical findings. Five Important documentation gaps and one Minor clarification follow; these are proposal defects, not demonstrated software failures.

## Important

1. Credential acquisition/refresh ownership is underspecified. M96 spec:82–86 and plan:92–104 name connect/reconnect/revoke without an acquisition protocol. n8n oauth.service.ts:483–506 isolates per-flow state; credentials-helper.ts:910–945 rejects stale token writeback; Activepieces app-connection.handler.ts:151–170 serializes refresh. Repair: bounded native github.com credential import from explicitly selected gh host/login, Rust-only token capture and OS store, checked identity; no silent account selection or broad app OAuth. Explicit reconnect and local revoke generations defeat late writes; remote revocation remains distinct.
2. Broker tool/policy integration has no owner. M96 plan:63–67/127–135 adds action policy and MCP service but omits tools.v1.json, refusal destiny, tool-approval goldens and prompt grant integration. Cerebro policy/tools.rs:1671–1678 asserts every local tool open_world=false. Repair explicit managed broker tool rows, honest open-world annotation, operational refusal registry, scoped grant/gate and renderer behavior, and narrowly amend that invariant while preserving mail-send denials.
3. Completion-before-wait race is not specified. M98 spec:200–208 and plan:110–120 address duplicate resumes without durable early completion/park-and-observe. Activepieces waitpoint-service.ts:19–28/148–155 and resume-service.ts:61–75 handle completion before PAUSED; n8n wait-tracker.ts:318–322 sweeps early-completed children. Repair transactional wait installation/current outcome observation plus startup/periodic reconciliation against ACT/CHAT, never reissuing work.
4. Workflow activation has no lifecycle. M98 spec:130–142/233–238 and plan M98.4/M98.9 provide trigger/publication but no Enable/Pause/Unpublish operation. Activepieces flow.service.ts:506–554 publishes DISABLED and :557–558 separately changes status. Repair mutable revisioned activation binding to selected immutable version, disabled default, explicit Enable/Pause/Unpublish, admission checks and cursor transitions while preserving pinned waits.
5. Gmail managed workflow lacks an adapter task. M98 plan:205–212 expects ACT-backed Gmail draft; M96 plan:151–155 registers GitHub only. shared/starter/vault/records/skills/draft-reply.md:8–14/20–23 uses CLI-owned Gmail tools. Repair first managed workflow uses GitHub; preserve CLI recipe with its label and defer managed Gmail to named drafts-only account/privacy/action adapter gate.

## Minor

6. Branch mapping needs explicit unexecuted-output disposition. M98 spec:163–180 says prior output and typed missing, but not the consuming-step behavior across a skipped branch. n8n workflow-data-proxy.ts:492–505 explicitly rejects unexecuted-node data. Clarify control-flow availability, typed missing propagation, exists=false, invalid required input failure before ACT prepare, and no null/zero/other-branch substitution.

## Eight source lessons

Adopt: (1) Account-bound connection resolution (Activepieces connection-resolver.ts:8–30/55–60), but enforce binding unconditionally; (2) refresh serialization/CAS (Activepieces app-connection.handler.ts:151–170; n8n credentials-helper.ts:910–945); (3) immutable published snapshot/new draft (Activepieces flow.service.ts:1026–1078); (4) publication separate from activation (same:506–558); (5) durable pre-completion and parked-parent sweep (Activepieces waitpoint-service.ts:19–28/148–155; n8n wait-tracker.ts:318–322); (6) explicit missing node-output errors (n8n workflow-data-proxy.ts:492–505).

Reject: (7) generic retry-on-FAILED for consequential effects (Activepieces helper/error-handling.ts:13–23/49–50; this retries without an effect-specific disposition); (8) treating Test as isolated (Activepieces piece-executor.ts:146–148 falls back to real run when no test hook exists). Existing M96 unknown-effect state/fence and M98 rehearsal gate correctly reject these shortcuts.

## Narrow beta and order

M96.1 contracts+manifest/refusal policy → M96.2 explicit native gh import/OS store → M96.3 durable approvals/request identity/claims/fence → M96.4 strict connection ownership and selected transport only → M96.5 GitHub issue read/reviewed creation → M96.6 shared chat/Runs details and recovery. Modern protocol, Tasks, Apps and second backend remain independent gates. Then M98.1 immutable definitions → M98.2 bounded manual runner/mapping → M98.3 durable waits/reconciliation, M98.4 activation/schedules and M98.5 deterministic preview → M98.9 author/save/publish/enable/run/inspect; optional agent/rehearsal/Gmail/persistence gates remain separate. Capture and calendar artifact work can proceed independently through existing guarded writers.

Declined to judge: live provider compatibility, installed MCP interoperability, actual Keychain behavior, packaged native isolation/focus/accessibility, execution quality/performance, license compliance beyond source-use boundaries and the other six example repos. No builds/tests were run. Current MCP web specs were not re-audited. The official GitHub CLI token/environment manuals were consulted only to bound the new credential-bootstrap proposal.

Finding locations above refer to the pre-correction snapshot.

Correction disposition: corrected in the four owned M96/M98 spec/plan documents, preserving milestone, requirement and phase numbering. Added exact acquisition/broker/activation APIs and named regressions; early wait completion and branch missing output have explicit dispositions. Managed Gmail remains gated, with GitHub the first managed workflow. Also clarified post-submission output-validation uncertainty and manual start idempotency. Root owns master roadmap/decision register integration. These edits remain untracked working-tree documentation; no staging, branch or product changes.

Verification: explicit Prettier check with --ignore-path /dev/null passes for all four documents (the repository's normal Prettier ignore excludes docs); local link/file checks and paired-contract review performed. No application test suite/provider trial was executed.
