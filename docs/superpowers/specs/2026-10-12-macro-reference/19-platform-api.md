# Macro reference — Platform: identity, permissions, sharing, teams, main API, schema, retention, billing

**Date:** 2026-10-12 · **Source:** `docs/examples/macro-main/` (vendored, gitignored). Macro paths are relative to it;
Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12):** Cerebro builds its own version, with Macro's code as the guide, never a 1:1 copy.
Modes: rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive, skip.
**Licences:** `LICENSE.txt` AGPL-3.0 covers every `crates/` and `services/` unit (no per-crate licence or NOTICE).
`apps/web/LICENSE` reads "All rights reserved" (auth, sharing, team-invitations, paywall, billing-lab, `lib/*`).
Cerebro is Apache-2.0. **Read for behaviour only; copy no code, comments or identifiers.** The only upstream option is
`constant_time_eq` 0.3.1 (CC0-1.0 OR MIT-0 OR Apache-2.0), and a hand-rolled fold beats adding it.
**Evidence:** stage 1 read Macro, stage 2 read Cerebro, stage 3 re-derived both (static reading, a git 2.50.0 fsmonitor
repro, node replicas of the mock corpus rules and both scope grammars; no cargo/vitest/live run). Cerebro lines are
HEAD `fb6822a` unless marked **WT** (the uncommitted working tree, which may still change).
**Bottom line:** nearly everything is multi-tenant SaaS and is skipped. What carries over is agent authority:
corpus-bound write doors (**exploitable at HEAD**), vault-bound grants, attributed writes, recorded refusals,
explain-access, in-app Trash.

---

## 1. What it is

- Hosted multi-tenant control plane: FusionAuth identity; two-layer authorization (`macro_authorization` = who is
  calling, `entity_access` = what they may do on one entity); link/team/channel sharing; teams with Stripe seats;
  soft-delete trash; org retention; Stripe + `ai_billing`.
- Two Rust composition roots (`services/authentication_service`, `services/document_storage_service`) over hexagonal
  crates on Postgres (~292 live tables).

## 2. What users get

| Feature | UX details | Paths |
| --- | --- | --- |
| Passwordless + SSO login | Email one-time code; Google/Apple/Microsoft. `202 SsoRequired` when the domain has an IdP. Blocked-email list. Dev signup allowlist via FusionAuth `user.create` webhook. Local stack auto-verifies the code. First login seeds a support channel, a guide doc, 3 sample tasks. Env-prefixed cookies. Desktop hands off to the system browser, returns via `macro:///login`. | `services/authentication_service/src/api/login/passwordless.rs`, `docs/AGENT_GUIDE/login.md`, `apps/web/src/features/auth/EmailAuth.tsx`, `apps/web/src/lib/core/auth/native-auth.ts` |
| Profiles + API tokens | One account (`macro_user`) owns several `User` profiles (`macro|email`). `/jwt/macro_api_token` mints RS256 per profile. User API keys stored as SHA-256 (no scope, no `last_used`, revoke = DELETE). >1 explicit credential → 400 "ambiguous credentials"; explicit beats the ambient cookie. | `services/authentication_service/src/api/jwt/macro_api_token.rs`, `crates/macro_auth/src/macro_api_token.rs`, `crates/macro_authorization/src/outbound/pg_user_api_key_authorization.rs` |
| Channel-reference sharing | Referencing an item in a channel shares it with every active member; leaving (`left_at`) revokes. Level capped by the sharer: docs View, PDFs up to Comment, forms View, agent sessions owner-only + View, calendar events need Edit+. `@mention` in a body is silent, in a comment it notifies. | `apps/docs/permissions.mdx`, `crates/channels/src/domain/reference_sharing.rs` |
| Share menu | `linkShare` PUBLIC/TEAM + level; team share level set only by the real owner (never Owner). Add/remove/replace channel shares. Defaults: markdown PUBLIC/Edit, chats PUBLIC/View, projects off; team `default_link_share` overrides. | `crates/models_permissions/src/share_permission.rs`, `apps/web/src/features/sharing/global-share-modal/GlobalShareModal.tsx` |
| Mention auto-share | `@mention` in a comment on a link-shared doc inserts a grant at link level. `ON CONFLICT DO NOTHING` (never downgrades). | `crates/macro_db_client/src/share_on_mention.rs` |
| Teams | Create, invite by email/link, roles member/admin/owner, domain auto-join, non-admin-invite toggle, per-member seat plan, remove, delete. Tasks and calls auto-shared. Joining creates DMs with every teammate (Kafka `team.member_joined`). | `apps/docs/account/teams.mdx`, `crates/teams/README.md`, `crates/teams/src/domain/team_service.rs` |
| Trash / restore / purge | Delete = soft delete; only the owner opens a trashed item; restore endpoint; Lambda purges after 30 days (Kafka purge events first, then SQS: row, BOM sha counts, mentions, S3). | `crates/entity_mutation/src/capability.rs`, `services/document_storage_service/src/api/documents/revert_delete_document.rs`, `services/deleted_item_poller/src/handler.rs` |
| Org retention | Support-set `retention_days`; hard-deletes docs/chats by last access, **bypassing trash**. | `services/organization_retention_handler/src/service/db/get_violating_items.rs` |
| Account deletion | Settings → Account → Delete. Ordered, fail-closed, retryable: scheduled actions → agent sessions → teams → items → onboarding → profile → Stripe → account. | `services/authentication_service/src/service/user/delete_user.rs` |
| Plans, AI usage, paywall | Guest $0 (hard cap), Premium $40, Max $200 per seat. Allowance at cost, then credits/usage at cost +25%. Status → roles. UI says "Pro" for tier `premium`. | `apps/docs/account/billing.mdx`, `apps/web/src/features/paywall/plans.ts`, `crates/ai_billing/src/lib.rs` |
| Billing Lab | Real Billing UI from 20 presets; time advance, failure injection, scenario links; no backend; excluded from prod. | `apps/web/src/features/billing-lab/README.md` |
| Onboarding | `/setup` row: color, interests, security, Google ×2, tools, team, plan. While active, ticks import gathers from MCP connectors; finishing deletes only unreserved staged candidates. | `crates/onboarding/src/domain/service.rs` |
| Referrals / GTM links | Short-uuid referral codes; staff-minted 48 h links apply a Stripe promo; rate-limited. | `crates/referral/src/domain/ports.rs` |
| Native share sheet | OS share target stages files/text → pick DM/channel → post; text pre-fills the composer. | `apps/web/src/features/sharing/native-share-sheet/NativeShareSheet.tsx` |
| Bots + harness daemons | Bot tokens with `x-macro-bot-scope` user/team; harness (`macrod`) paired by device code; acting user = forwarded mention sender, verified server-side. | `crates/macro_authorization/src/domain/harness_authorizer.rs`, `crates/macro_authorization/src/domain/bot_authorizer.rs`, `crates/harnesses/src/lib.rs` |
| Logout draft guard | Lists unsynced drafts, warns before discard; 3 s time-box; rotates cache scope if a wipe fails. | `apps/web/src/lib/core/auth/logout.ts` |

## 3. How it's built

**Architecture**

- Hexagonal crates: `domain` (models, ports, service), `outbound` (Pg/Stripe/Kafka), `inbound` (axum extractors, AI
  toolsets, GraphQL).
- **Authentication** (`macro_authorization`): `MacroAuthorizationExtractor<Svc, Policy>` resolves exactly one
  credential (internal key | API key | bot | harness | bearer/query JWT | cookie) into an exhaustive
  `MacroAuthorization` enum; a sealed `AuthorizationPolicy` narrows it per endpoint (UserOnly, BotOnly, ActingUser,
  AnyPrincipal…). Extractors authenticate only.
- **Authorization** (`entity_access`): per-type extractors produce `EntityAccessReceipt<T: RequiredPermission>`;
  domain methods demand it. Effective level = max over source ids (user ∪ active channels ∪ teams; 10 s cache)
  across `entity_access` rows, link shares and email/discussion attachment paths. **Receipts are forgeable:**
  `pub fn try_new` and `pub dangerously_assert_*` (`crates/entity_access/src/domain/models.rs:506-521,603-667`). The
  unforgeable precedent is `entity_mutation`'s `Sentinel(())` (`crates/entity_mutation/src/models.rs:51-53`).
- `document_storage_service`: binds ~40 domain services to Pg adapters (`src/api/context.rs`), mounts routers
  (`src/api.rs`), GraphQL at `/soup/graphql`, Kafka consumers, SQS delete worker.
- Ops Lambdas: retention trigger/handler (EventBridge → SQS), `deleted_item_poller`, DLP S3-log scanner.
- Frontend (SolidJS): TanStack Query over orval-generated clients (`apps/web/src/lib/service-clients`).

**Components**

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| macro_authorization | `crates/macro_authorization` | Principal enum, sealed policies, acting-user verification, hashed bot/harness/API-key repos | 7,498 |
| entity_access | `crates/entity_access` | Levels, receipts, extractors, Pg access queries, `explain_access` CLI | 32,530 |
| entity_access_db_utils | `crates/entity_access_db_utils` | Grant writers, project fan-out, team-share advisory-lock guard | 2,342 |
| entity_access_management | `crates/entity_access_management` | Project-inherited grant sync on add/remove/move | 1,524 |
| models_permissions | `crates/models_permissions` | `AccessLevel`, `LinkShare`, double-option PATCH, team-share commands with expected facts | 1,429 |
| share_permission_db_utils | `crates/share_permission_db_utils` | Share SQL; fact recheck under guard | 1,367 |
| graphql_permission | `crates/graphql_permission` | Viewer permission DataLoader; inaccessible = missing = `None` | 332 |
| roles_and_permissions | `crates/roles_and_permissions` | Legacy RBAC: Stripe status → roles → permission ids | 1,451 |
| teams | `crates/teams` | Teams, invites, seats, Kafka events, owned-entity cleanup | 23,542 |
| entity_mutation | `crates/entity_mutation` | Lifecycle capability traits (trash, restore, delete, rename, move…), `Sentinel(())` | — |
| macro_auth | `crates/macro_auth` | HS256 FusionAuth / RS256 api-token validation | 1,026 |
| fusionauth | `crates/fusionauth` | FusionAuth HTTP client | 3,578 |
| authentication_service | `services/authentication_service` | Identity/billing host, webhooks, account deletion | 21,082 |
| document_storage_service | `services/document_storage_service` | Main API root, GraphQL soup, entity-mutation router, delete worker | 14,693 |
| macro_db_client | `crates/macro_db_client` | SQL crate + 502 migrations (13,158 SQL lines) | 41,322 |
| retention/purge/DLP | `services/organization_retention_handler` (+ `services/organization_retention_trigger`, `services/deleted_item_poller`, `services/dataloss_prevention_handler`) | Lambdas | 1,949 |
| readonly_pool | `crates/readonly_pool` | `pub struct ReadOnlyPool(pub PgPool)` + Deref: a signal, not a lock | 16 |
| web auth/sharing/billing | `apps/web/src/features/auth` (+ sharing, team-invitations, paywall, billing-lab) | SolidJS UI | 9,584 |

**Data model** (Postgres unless noted)

| Entity | Path | Key fields |
| --- | --- | --- |
| `entity_access` | `crates/macro_db_client/migrations/20260331152752_add_entity_access_table.sql` | entity_id, entity_type, source_id, source_type channel/team/user(/bot), access_level view<comment<edit<owner, `granted_from_project_id` FK cascade, partial unique indexes direct vs inherited |
| `entity` (owner registry) | `crates/macro_db_client/migrations/20260910144347_add_entity_table.sql` | owner_type user/bot/team, deleted_at; doubles as the team-purge work queue |
| SharePermission + joins | `crates/macro_db_client/migrations/0001_baseline.sql`, `crates/macro_db_client/migrations/20260813165731_add_link_share_columns.sql` | linkShare PUBLIC/TEAM + level, team share level + revision, per-type join tables, ChannelSharePermission |
| User / macro_user | `crates/macro_db_client/migrations/0001_baseline.sql` | profile `macro|email`, account UUID, BlockedEmail |
| UserApiKey | `crates/macro_db_client/migrations/20260831172113_user_api_key_id_name_hash.sql` | id, user_id, name, hash, created_at — nothing else |
| team / team_user / team_invite | `crates/macro_db_client/migrations/0001_baseline.sql` | owner_id, seats, plan, default_link_share, auto_join_domain, role |
| bot/harness tokens | `crates/macro_db_client/migrations/20260527160000_channel_bots.sql` | `token_hash` SHA-256, prefix, `last_used_at`, `revoked_at`, `expires_at` (bots) |
| Org + retention | `crates/macro_db_client/migrations/0001_baseline.sql` | OrganizationRetentionPolicy.retention_days, ItemLastAccessed |
| Soft delete | `crates/macro_db_client/src/document/get_all_documents.rs` | `deletedAt` (legacy), `deleted_at`, `trashed_at` (databases/forms) |
| AI billing | `crates/ai_billing/src/lib.rs` | 23 tables; cost cents vs customer cents |
| Tool approvals (agents domain) | `crates/macro_db_client/migrations/20261005203905_agent_session_tool_approval.sql` | owner-only approve; pending/approved/denied/cancelled/expired; standing approvals (`…203907…`) |
| Auth ephemera (Redis) | `crates/macro_cache_client/src/auth.rs` | login code TTL 630 s, mobile session 300 s, `just_signed_up` GETDEL |

Schema: ~292 live tables (305 created − 13 dropped); largest groups AI chat/agents 36, docs/files 28, email 28, AI
billing 23.

**Key flows**

1. **Login:** `POST /login/passwordless` → IdP lookup (202 if SSO) → BlockedEmail → FusionAuth user under
   SignupPolicy → code → `populate_jwt` webhook adds `macro_user_id`/org → cookies. Expiry → `/jwt/refresh`; client
   single-flights refresh and latches a definitive rejection 60 s (`apps/web/src/lib/core/util/fetchWithToken.ts`).
2. **Entity read:** extractor (one credential else 400; policy else 403) → `DocumentAccessExtractor<T>` (bot path;
   identityless internal → Owner; owner short-circuit; trashed → owner only) → `get_user_source_ids` → UNION of
   grants, link shares (TEAM via `owner_team()`), attachment inheritance → max level → receipt → domain call
   (`crates/entity_access/src/inbound/axum_extractors/document.rs`,
   `crates/entity_access/src/outbound/pg_access_repo/queries.rs`).
3. **Channel share:** message references → sharer's level → `grant_level(item_type, file_type, level)` →
   ChannelSharePermission + `entity_access(source=channel)`; members reach it via source ids
   (`crates/channels/src/domain/reference_sharing.rs`).
4. **Agents and search:** AI tools mint receipts as the requesting user; agent sessions inherit parent access
   (Comment+ → Edit, View → View, never ownership). Search computes accessible ids (minus trash) first, then queries
   OpenSearch for only those (`crates/macro_db_client/src/item_access/get_accessible_items.rs`).
5. **Trash/purge/retention:** `TrashEntity` capability sets `deletedAt` → restore via `revert_delete_document` →
   30-day poller emits purge events, then SQS deletes. Retention enqueues deletes directly. Team deletion:
   `clear_team` purges each registry entity; only a `ClearedTeam` token permits the team row delete
   (`crates/teams/src/domain/owned_entity_cleanup.rs`).

## 4. Ideas worth stealing (ranked)

1. **Domain call takes a resolved target, never a raw path** — the access layer resolves first. Cerebro's
   non-note writers still take whatever `safe_join` admits. `crates/entity_access/src/inbound/axum_extractors/document.rs`
2. **Acting entity vs acting user** — attribute to the authenticating principal, resolve access as a verified user;
   a daemon cannot assert its own authority. Maps to `vault_writes.actor` + `run_id`.
   `crates/macro_authorization/src/inbound/axum.rs`, `crates/macro_authorization/src/domain/harness_authorizer.rs`
3. **Scope resolved server-side, never trusted from the caller** — bot scope and acting user come from the token's
   record. Cerebro's renderer parses grant axes and ceilings itself. `crates/macro_authorization/src/domain/bot_authorizer.rs:36-100`
4. **Unforgeable receipt** — private-field `Sentinel(())`, not `EntityAccessReceipt`'s pub `try_new`.
   `crates/entity_mutation/src/models.rs:51-53`
5. **Explain-access** — every grant path plus the effective level; "no access" is a successful empty answer.
   `crates/entity_access/src/domain/models/access_explanation.rs`, `crates/entity_access/src/bin/explain_access.rs`
6. **Lifecycle as capability traits** — a `Receipt` per kind; exhaustive matches force a decision for every new
   kind; batches ordered, bounded, partial-success. `crates/entity_mutation/src/capability.rs`
7. **Trash semantics** — invisible to lists, search, non-owners; restorable; purge emits events first.
   `services/deleted_item_poller/src/handler.rs`
8. **Token hygiene (bot tokens, not user keys)** — hash + prefix, `revoked_at`, `expires_at`, `last_used_at`,
   constant-time internal-key compare. `crates/macro_authorization/src/outbound/pg_bot_authorization.rs:104-135`,
   `crates/macro_authorization/src/domain/service.rs`
9. **Read-only handle newtype** — Cerebro can enforce it (`query_only`); Macro only signals. `crates/readonly_pool/src/lib.rs`
10. **Registry as cleanup queue + fail-closed ordered deletion** — `crates/teams/src/domain/owned_entity_cleanup.rs`,
    `services/authentication_service/src/service/user/delete_user.rs`
11. **Level-triggered idempotent reconcile** — every read ticks a CAS start; finishing deletes only unreserved
    candidates ("never reviewed is not declined"). `crates/onboarding/src/domain/service.rs:4-8,185-200`
12. **Fixture lab** and **event-contract README** — `apps/web/src/features/billing-lab/README.md`, `crates/teams/README.md`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Resolved target before any mutation | partial | high | **HEAD exploitable**: `tool_append` = read + `save_note` over bare `safe_join`; appended `[core] fsmonitor` in `.git/config` ran on `git status` (`src/git/useGit.ts:108`). **WT** closes 7 note writers (`note_join`/`note_refusal`, `src-tauri/src/vault/write.rs:287,336`; 57 cases in `src-tauri/fixtures/note-targets.json`). Still bare: rename, delete, save_view/list/collection, create_folder (`write.rs:1066-1149`). |
| Authority bound to one vault | partial | high | `RunGrant` has no vault; `call_tool` reads the shared `Running.vault` (`src-tauri/src/mcp.rs:1501-1505`), retargeted by every construct's `ensure()`. Renderer caches `startMcp` with `??=`; `stopAllAgents` has no caller. |
| Grant axes resolved once, server-side | partial | high | Rust `frontmatter_list` (`mcp.rs:2417-2440`) and TS `folderList`/`parseAllowedTools` (`src/engine/agents.ts:142-167`, `src/engine/skills.ts:102-114`) disagree; scalar `scope:` = unrestricted in Rust. Fail-open twin. |
| Acting entity vs acting user on writes | partial | high | `runs.actor`, `parent_run_id` exist. `vault_writes.actor` NULL at all 10 record sites; no `run_id`; read only by `validate_v17`. Human id lives in localStorage. |
| Classified effects per run | partial | high | Knowledge writes from the ledger; pages only in renderer `runLog` (attempted paths, cap 200; `create_note` logs the folder). |
| Typed receipts | absent | medium | Guards are calls each site must remember; `save_view` unguarded on both backends. |
| Explain-access | absent | medium | AgentEditor write sentence (`src/library/AgentEditor.tsx:241`) false with shell on; read sentence (`:269`) false for every non-internal run. |
| Typed, recorded authz refusals | partial | medium | Scope/read/tool refusals record nothing (`mcp.rs:1521-1576`); knowledge guard records `malformed_arguments` without `run_id`; WT "not a note" refusals uncoded. |
| Trash / restore / purge | partial | medium | OS Trash (Finder, Put Back works); trash 5.2.6 cannot list/restore on macOS. |
| Token lifecycle | partial | low | Memory-only; window-evicted, not revoked; `==` compare; unrestricted base token handed to the renderer, used by no run. |
| Capability ceilings server-side | partial | low–medium | Shell ceiling and stdio approvals live in localStorage and ride each request (`src/stores/uiStore.ts:430,435`, `src/agent/agentIpc.ts:196`). |
| ReadOnlyPool | partial | low | `fleet.rs` SELECT-only by convention on a writable connection. |
| ACL-first retrieval | already-better | low | `read_scope` filters before ranking, counts withheld (M34.4). CLI Read/Glob/Grep bypass = MCP-14. |
| Conditional commands | already-better | low | `stale_target_version` CAS, `viewed_body_hash`, `run_actor_mismatch`. |
| Double-option PATCH | equivalent | low | `patched_frontmatter`: null removes, absent leaves (`write.rs:450-456`). |
| Hosted identity, profiles, bots | different-by-design | low | Single user; the CLI owns its own auth. |
| Sharing, ACLs, teams | different-by-design | low | Sharing = git remote; M47 §9 non-goal; agents never lend (M34.3). |
| Billing, paywall, credits | different-by-design | low | Budgets over the user's own subscription (`src-tauri/src/runtime/budget.rs`). |
| Org retention hard-delete, DLP | different-by-design | low | Markdown is never hard-deleted. |
| Ordered account deletion | absent | low | Only `purge_agent_workspace` (`src-tauri/src/lib.rs:1179`). |
| Onboarding reconcile | absent | low–medium | Migration wizard on the roadmap. |

## 6. Port candidates

Ids keep the numbers the earlier spec and the draft roadmap already bind (`docs/superpowers/plans/2026-10-12-macro-port-roadmap.md`).
Stage 2's renumbering is mapped back; see §8.

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PLATFORM-API-1 | Corpus-bound write doors — finish + commit | rebuild | adapt | S | high | `crates/entity_access/src/inbound/axum_extractors/document.rs`, `crates/macro_authorization/src/inbound/axum/policy.rs` | `src-tauri/src/vault/{write,scan}.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/knowledge.rs`, `shared/policy/corpus.v1.json` (new) + README row, `src/lib/mockIpc.ts` | — |
| PLATFORM-API-9 | Vault-bound run grants with a lifecycle | rebuild | adapt | M | high | `crates/macro_authorization/src/domain/service.rs`, `crates/macro_authorization/src/outbound/pg_bot_authorization.rs`, `crates/macro_authorization/src/domain/bot_authorizer.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/{assembly/live,ingest/spawn,maintain/live}.rs`, `src-tauri/src/agent/mod.rs`, `src/agent/{agentIpc,types,useAgentChat,useJobRunner}.ts` | CODING-2 (one owner) |
| PLATFORM-API-2/3 | Attributed writes through door receipts (one writer pass) | rebuild | adapt | L | high | `crates/macro_authorization/src/inbound/axum.rs`, `crates/entity_mutation/src/models.rs`, `crates/entity_mutation/src/capability.rs` | `src-tauri/src/vault/write.rs`, `src-tauri/src/runtime/{schema,mod,vault_writes,fleet}.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/app_config.rs`, `src/status/RunDetailPanel.tsx`, `src/engine/runLog.ts`, `src/lib/mockIpc.ts` | -1, AUTOMATION-4 (one owner), DOMAIN:agents |
| PLATFORM-API-15 | Grant axes resolved once, fail-closed (new) | rebuild | adapt | S | medium–high | `crates/macro_authorization/src/domain/bot_authorizer.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/lib.rs`, `src/engine/{agents,skills}.ts`, `src/agent/{useJobRunner,useAgentChat}.ts` | — |
| PLATFORM-API-6 | Grant refusals typed + recorded per run | rebuild | adapt | S | medium | `crates/entity_access/src/domain/models.rs`, `crates/macro_authorization/src/inbound/axum.rs` | `shared/policy/policy.v3.json` (+ `.sha256`), `src-tauri/src/mcp.rs`, `src-tauri/src/knowledge.rs`, `src-tauri/src/vault/write.rs`, `src-tauri/src/runtime/{schema,fleet}.rs`, `src/lib/policy/table.ts` | -1; overlaps AGENTS-16 |
| PLATFORM-API-5 | Explain agent access per page | rebuild | adapt | M | medium | `crates/entity_access/src/domain/models/access_explanation.rs`, `crates/entity_access/src/bin/explain_access.rs` | `src/engine/agentAccess.ts` (new), `shared/policy/grant-scope.v1.json` (new), `src/detail/DocSidePanel.tsx` (Info tab), `src/library/AgentEditor.tsx` | -1, -15, MCP-14, DOMAIN:agents |
| PLATFORM-API-7 | In-app Trash: list, restore, 30-day purge | rebuild | adapt | M | medium | `crates/entity_mutation/src/capability.rs`, `services/document_storage_service/src/api/documents/revert_delete_document.rs`, `services/deleted_item_poller/src/handler.rs` | `src-tauri/src/vault/write.rs`, `src-tauri/src/lib.rs`, `src/lib/{ipc,mockIpc}.ts`, `src/pages/{SettingsPage,DocPage}.tsx`, `src/components/FileTree.tsx`, `src-tauri/src/mcp.rs` | -1, DOMAIN:shell, owner call (merge with DATA-21; location) |
| PLATFORM-API-8 | Read-only runtime connection for read models | rebuild | adapt | S | low | `crates/readonly_pool/src/lib.rs` | `src-tauri/src/runtime/{mod,fleet}.rs`, `src-tauri/src/lib.rs` (fleet commands, `:238-302`) | — |
| PLATFORM-API-16 | Capability ceilings held in Rust (new) | rebuild | inspire | S | low–medium | `crates/macro_authorization/src/domain/bot_authorizer.rs` | `src-tauri/src/app_config.rs`, `src-tauri/src/lib.rs`, `src/stores/uiStore.ts`, `src/agent/agentIpc.ts` | roadmap D6 (M57) |
| PLATFORM-API-14 | Launch reconcile for staged imports (restored) | rebuild | inspire | M | low–medium | `crates/onboarding/src/domain/service.rs` | `src-tauri/src/runtime/catchup.rs`, `src-tauri/src/runtime/import.rs` | DOMAIN:automation, DOMAIN:integrations |
| PLATFORM-API-17 | Forget this vault (new, optional) | rebuild | inspire | S | low | `services/authentication_service/src/service/user/delete_user.rs` | `src-tauri/src/lib.rs`, `src-tauri/src/runtime/mod.rs`, `src/pages/SettingsPage.tsx` | -9 |
| PLATFORM-API-10 | Hosted identity and accounts | skip | — | — | low | `services/authentication_service/src/api/login/passwordless.rs` | — | — |
| PLATFORM-API-11 | Sharing, ACLs, teams | skip | — | — | low | `crates/entity_access/src/outbound/pg_access_repo/queries.rs`, `crates/channels/src/domain/reference_sharing.rs` | — | revisit only on roadmap D1(c) |
| PLATFORM-API-12 | Billing, plans, paywall, Billing Lab | skip | — | — | low | `crates/ai_billing/src/lib.rs` | — | — |
| PLATFORM-API-13 | Org retention hard-delete, DLP | skip | — | — | low | `services/organization_retention_handler/src/handler.rs` | — | — |

Retired: PLATFORM-API-4 (tool grant registry) → MCP-1. Stage-2 "personal tokens for other MCP clients" → dropped,
duplicate of MCP-5 (fold hash-only storage, redacted Debug, show-once into MCP-5; D17 undecided).

Sequence: 1 (commit now) → 9 (with CODING-2) → 15 → 6 → 8 → 2/3 (with AUTOMATION-4; one schema step) → 5 → 7 →
16, 14, 17 as chartered.

**PLATFORM-API-1 — finish and commit the doors** (HEAD is still exploitable)
- WT already has the note doors (767 insertions; tests `src-tauri/src/mcp.rs:4583`, `src-tauri/src/lib.rs:1742`,
  `src-tauri/src/vault/write.rs:1824,1884,1937`; mock `guardNoteTarget`, `src/lib/mockIpc.ts:254`). Commit first.
- Scanner parity: the door folds case and trims `. `; `scan.rs:9-13` and `mockIpc.ts:180,1118` match exactly, so
  `Attachments/x.md` is listed but unsaveable. Move cases from `src-tauri/fixtures/note-targets.json` into
  `shared/policy/corpus.v1.json` + README row, replayed by `scan.rs`, the doors and mock scan/listFolders
  (staleness.v1.json precedent). Twin count is 4 today; target 0.
- Landing check (`corpus_join`) for rename, delete, save_view/list/collection, create_folder; mirrored in the mock.
  U+212A "Knowledge" passes the ASCII fold at `src-tauri/src/knowledge.rs:139`.
- Agent doors refuse instruction-file basenames (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`) at any depth; human
  doors stay open. Declare a `.canvas` door for roadmap D14(b).
- Acceptance: under `RunGrant::unrestricted`, `.git/config`, `.GIT/config`, `./.git/config`, `.cerebro/*`,
  `.obsidian/plugins/x/main.js`, `.envrc`, `views/x.yml`, `CLAUDE.md` refuse with bytes unchanged; corpus notes,
  vault root and `sources/` still write; shared cases pass in cargo and vitest.

**PLATFORM-API-9 — vault-bound grants with a lifecycle**
- `RunGrant` carries the vault it was minted for; `call_tool` resolves against `grant.vault`, never
  `Running.vault`. A separate "shown vault" setter lets UI tools refuse cross-vault calls with a sentence.
- `run_agent` resolves URL + vault server-side so the renderer caches nothing (`useAgentChat.ts:365`,
  `useJobRunner.ts:479`). Retire the unrestricted base token; `start_mcp` returns the URL only.
- Revoke with a grace window or a draining mark that admits requests accepted before reap — never at reap: tiny_http
  queues requests and the grant resolves at dequeue (`mcp.rs:528-542`). Test must queue a request behind a slow call.
- Constant-time compare by hand-rolled fold or SHA-256 compare (no new crate). Redact `mcp_token` in
  `AgentRequest`'s Debug (`src-tauri/src/agent/mod.rs:81-110`).
- Kill falsified comments: the three "ensure errors if none running" (`assembly/live.rs:52-54`,
  `ingest/spawn.rs:69-71`, `maintain/live.rs:42-45`), `mcp.rs:10-13,110-117,269-272`, `lib.rs:1183-1185,1494-1496`,
  `agentIpc.ts:229-230`. Roadmap M53.10 already binds tokens to vault under CODING-2: name one owner.

**PLATFORM-API-2/3 — attributed writes through door receipts**
- WT `note_join` returns a private-constructor `NoteTarget` (the mint point; `Sentinel(())` shape). Every writer
  takes a door-minted target plus `By {actor, run_id}`; one named `System` constructor for ledger projections and
  reconcile.
- MCP writes stamp the grant's actor + run_id; IPC writes stamp `human:<id>`, the id moved from localStorage to app
  config. `runs` keeps parent and cause.
- One migration: rebuild `vault_writes` (CHECK on `kind`, `schema.rs:1223`) for `vault.create` + -7's trash kinds,
  add `run_id`, `(vault_id, recorded_at)` index, `runs.effects_booked`. `RunDetail.changed`: `None` = not
  recorded, `Some([])` = wrote nothing.
- Counts: 13 IPC writers, ~9 MCP, 2 in `ledger/concepts.rs`, 10 recording sites. Shares sites with AUTOMATION-4;
  roadmap M58.1 cites -2/-3. Coalesce autosave rows per (path, actor) window. Retire `runLog.writtenPath`.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro invariant | Resolution |
| --- | --- | --- |
| Agents mint receipts as the requesting user; sessions inherit parent access | Each agent runs under its own record's axes; calling never lends (M34.3, D4) | Port receipt and explanation shapes, not inheritance. |
| `grant_level` capped by sharer | `hand_to` intersection declined (PR #17) | Not ported. |
| Per-entity-type extractors | No type special-casing; policy is data | Doors keyed by path shape and file role, rules in shared `corpus.v1.json` with replayed cases. |
| Receipts with pub `try_new` / `dangerously_*` | Guards must be unforgeable to mean anything | Private constructor (`Sentinel(())` precedent), minted only by the door. |
| Soft delete via `deleted_at` + DB purge | Vault on disk is the truth; markdown never hard-deleted | Trash is a location; purge ends in the OS Trash. |
| Org retention hard-delete bypassing trash | Never hard-delete markdown | Skip (-13). |
| Persisted hashed tokens for every principal | Run bearers memory-only, CLI-only (M6) | Run tokens stay memory-only, vault-bound, revoked after a grace window. Hash-at-rest only in MCP-5 (owner decision). |
| 403 at the edge, logged by tracing | M31.1b: axes change together; two records, two destinies | -6 records every axis at once, operational destiny, via the policy.v3 ritual (v1/v2 untouched). |
| Caller-supplied capability is trusted per request | Rust enforces against the bearer (M34 D4) | -15 and -16 move axes and ceilings to Rust; request flags may only subtract. |
| No access = successful empty answer | Absent ≠ zero; unavailable ≠ empty | Compatible: "No agent can change this page" when measured; `section-unavailable` on a failed read. |
| ReadOnlyPool pub-field signal | `fleet.rs` writes nothing (M33.2) | Private constructor + `PRAGMA query_only=ON`; enforced. |
| orval codegen keeps clients in sync | Policy is data; mock mirrors every Rust guard | Shared artifacts + goldens + mock parity tests; no codegen. |
| Trash as a top-level destination | Destination names asserted in `app/Sidebar.test.tsx` | Recently deleted lives in Settings. |
| Agents may trash/restore | `no_tool_deletes` (M17.1) | Trash, restore, purge human-only; doors refuse `.cerebro/trash`. |
| AGPL / All-rights-reserved sources | Apache-2.0; D0 no-1:1; M48 declined GPL | Rebuild from behaviour. `macro_uuid` skipped (licence + redundant with `ledger::new_id128`). |

## 8. Verification notes (stage 3)

- **Corrected — corpus doors:** HEAD exploitable (fsmonitor repro'd, git 2.50.0, Cerebro env
  `git/command.rs:79-91`). WT closes 7 note writers but adds 2 more corpus twins held by a fixture `scan.rs` never
  replays; node replica shows `Attachments/notes.md`, `Views/x.md`, `views./x.md` scanned:true and save-refused.
  -1 re-scoped M → S (finish + commit).
- **Corrected — cross-vault:** premises hold statically, but the target is whichever vault was `ensure()`d last
  (constructs retarget), not stably A. Not run live.
- **Confirmed:** `vault_writes.actor` NULL everywhere, no `run_id`, read only by `validate_v17`
  (`runtime/mod.rs:286-292`); grant refusals record nothing, policy.v3 has no grant code; base token unrestricted and
  unused by all 5 spawn sites (so the M6 "nothing else" doc is already false); trash 5.2.6 `os_limited` excludes
  macOS; D1/D17 are recommendations, only D0 decided.
- **Refuted — revoke at reap is safe:** tiny_http queues; grant resolves at dequeue; Cerebro has no wait-based reap
  (`agent/mod.rs:329-360`). Grace window instead.
- **Refuted — receipts minted only by the access service** (pub `try_new`, pub `dangerously_*`). Cite
  `Sentinel(())`.
- **Refuted — `macro_uuid` "lift":** AGPL vs Apache-2.0, and redundant. Skip.
- **Refuted — "Details tab":** page tabs are Outline/Info/Links/Knowledge; Details is concept-only
  (`DocSidePanel.tsx:24-37`). Use Info.
- **Refuted — `ensure()` errors with no server:** it starts one (`mcp.rs:511-524`); comments are falsified.
- **Refuted — candidate ids free:** spec + roadmap bind them. Mapping: stage-2 -2 → -9, -3 → -6, -4 → -2/3, -6 → -7,
  -7 → -8, -8 dropped (MCP-5), -9/-10/-11 → -10..-13. Old -4 → MCP-1. -14 restored.
- **Partial:** connector trust anchor is renderer localStorage, not Rust (→ -16). Read-only WAL risk overstated;
  `ledger/index.rs:269-280` already opens WAL read-only. Double-option PATCH equivalent, not better. Trash: hidden
  from MCP doors only (CLI readers see it); after the sweep, Finder Put Back lands in the hidden trash folder, and a
  launch-time Finder purge may prompt — prefer NsFileManager or say so in copy. -7 drops its -4 dependency (deletes
  are human-only, actor constant). -6 had a hidden -4 dependency (booked flag): give it its own flag or defer the
  None/Some UI; `operational_log` needs a run_id index.
- **Missed, folded in:** grant-axes twin (-15); instruction-file writes, scanner case drift, non-note landing check
  (-1); renderer ceilings (-16); onboarding reconcile (-14); forget this vault (-17).
- **Not observed:** cross-vault effect live, the tiny_http race, Put Back target, APFS U+212A folding.

## 9. Where to read first

1. `crates/entity_access/src/inbound/axum_extractors/document.rs`
2. `crates/entity_mutation/src/models.rs` (`Sentinel`) and `crates/entity_mutation/src/capability.rs`
3. `crates/macro_authorization/src/inbound/axum/policy.rs`
4. `crates/macro_authorization/src/inbound/axum.rs`
5. `crates/macro_authorization/src/domain/bot_authorizer.rs` and `crates/macro_authorization/src/domain/harness_authorizer.rs`
6. `crates/macro_authorization/src/outbound/pg_bot_authorization.rs` and `crates/macro_authorization/src/domain/service.rs`
7. `crates/entity_access/src/domain/models.rs` (read as the counter-example)
8. `crates/entity_access/src/domain/models/access_explanation.rs`
9. `services/document_storage_service/src/service/entity_mutation.rs`
10. `services/deleted_item_poller/src/handler.rs`
11. `crates/readonly_pool/src/lib.rs`
12. `crates/onboarding/src/domain/service.rs`
13. `services/authentication_service/src/service/user/delete_user.rs`
14. `crates/teams/src/domain/owned_entity_cleanup.rs`
