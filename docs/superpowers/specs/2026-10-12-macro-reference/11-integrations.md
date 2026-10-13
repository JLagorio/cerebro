# Macro reference — Integrations: connection gateway, OAuth, Google, Microsoft, Slack, imports, unfurl

**Date:** 2026-10-12 · **Source:** `docs/examples/macro-main/` (vendored, gitignored). Every Macro path below is relative to it; `src/`, `src-tauri/`, `shared/`, `demo-vault/` paths are Cerebro's.
**Owner's rule (2026-10-12):** Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy. Modes: rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive, skip.
**Licences:** `LICENSE.txt` (AGPL-3.0) covers every owned crate, service and infra stack. `apps/web/LICENSE` reads "All rights reserved" and covers `apps/web/src/features/{integrations,slack-import,gtm-invite}`, `apps/web/src/lib/queries/*` and `apps/web/src/lib/workers/slack-import`. Cerebro is Apache-2.0 (M48 precedent), so every port is design-level. Permissive upstreams: `zip` crate (MIT), `scraper` 0.18.1 (**ISC**), `reqwest` 0.13.4 (MIT OR Apache-2.0, **not compiled into desktop builds**), `fflate` (MIT), `emojibase-data` 17.0.0 + `unicode-emoji-json` 0.8.0 (MIT; Macro's generated map credits them in `crates/slack_integration/data/README.md`).
**Evidence:** stages 1–2 read code and docs. Stage 3 re-read both trees statically, and read CLI behaviour from strings in the Claude Code 2.1.250 binary. Nothing was run and no network was used. **live-check** marks items that need a real run before planning. Stage 3 overrides stages 1–2.
**Overlap:** INTEGRATIONS-1 and -12 overlap `09-mcp.md` MCP-4 and MCP-15. Plan them together, with one status store and one control-channel worker.
**Baseline:** working tree on `m49-knowledge-integrity`, with uncommitted PLATFORM-API-1 changes to `src-tauri/src/vault/write.rs`. They change no verdict.

---

## 1. What it is

- **Five unrelated subsystems share this label.** (1) The **connection gateway** is the realtime WebSocket push fabric (`services/connection_gateway`). It is not OAuth. (2) **OAuth grants** live in `services/authentication_service`: Google refresh tokens on FusionAuth IdP links, Microsoft refresh tokens KMS-encrypted in Postgres. (3) **Third-party apps** (Linear, Notion, Slack, GitHub) are MCP connectors on two stacks, native and Pipedream (`crates/mcp_select/src/lib.rs`). There is no Slack OAuth app or bot.
- **Imports:** `crates/import` is a generic ledger of staged candidates fed by connector reads. `crates/slack_integration` is a separate, heavily engineered pipeline for Slack export ZIPs. **Unfurl:** `crates/unfurl` is a hexagonal OpenGraph fetcher with SSRF guards.
- Growth and telemetry code (`loops_client`, `analytics_client`, `gtm_invite`, `services/analytics-proxy`) shares the label and is out of scope.

## 2. What users get

| Feature | UX details / shortcuts | Read |
| --- | --- | --- |
| Connect apps as AI connectors | Settings → Connections lists curated providers (github, linear, notion, slack). Status `connected \| off \| action-required \| not-connected`; scope personal/shared; mechanism pipedream/native-mcp. The OAuth popup opens as `about:blank` during the click and gets its URL later; under Tauri it opens in the external browser. If the user has any Pipedream connector, only Pipedream tools load. Agents can suggest connecting via `DiscoverConnectors`. Imports ride these connectors, with no separate integration auth. | `apps/web/src/features/settings/connections/model.ts`, `apps/web/src/features/settings/connections/mcp-oauth.ts`, `crates/mcp_select/src/lib.rs`, `apps/docs/AI/mcp/tools/discover-connectors.mdx` |
| Onboarding import ("bring your work over") | Each connected Linear/Notion/Slack connector gets one gather run that stages 8–15 candidates. A per-source shimmer runs while gathering (90 s cap, Slack 180 s); rows land incrementally; failed runs can be retried or dismissed. Runs started by onboarding auto-import when gathering finishes. Completion **deletes** unacted rows (not discards) so they can be staged again later. Push `import_updated`, plus polling every 3 s while in flight and 15 s when idle. | `crates/onboarding/src/domain/service.rs`, `crates/import/src/domain/service.rs`, `apps/web/src/lib/queries/import.ts`, `apps/web/src/features/onboarding/onboarding.tsx` |
| Live Slack channel import | Settings → Connections → Slack → Import channels → Find channels. Search by name/purpose/id; show-archived toggle; "Checking members…" / "Members not checked yet"; rows already imported cannot be selected and carry an "imported by teammate" flag. Enrichment covers ≤100 channels (largest first) and ≤100 participants. Public channels only. Creates the channel shape plus matched members, **no messages**. The importer owns the new channel. | `docs/SLACK_LIVE_CHANNEL_IMPORT.md`, `crates/import/src/domain/service/slack_discovery.rs`, `apps/web/src/features/settings/connections/slack-channel-import/model.ts` |
| Agent-driven imports from chat | Tools `CreateImportEntity` (staged\|imported), `ListImportEntities`, `DeleteImportEntity` (decline, remembered), `ImportNotionPage`. Responses say when an item was already imported by the user or a teammate. The source fixes the entity type: linear→task, notion→md, slack→channel. Notion databases are deliberately not imported. | `crates/import/src/inbound/toolset.rs`, `apps/docs/AI/mcp/tools/create-import-entity.mdx`, `apps/docs/AI/mcp/tools/import-notion-page.mdx`, `apps/docs/switch-to-macro.mdx` |
| Slack export ZIP import | Admin + flag `enable-slack-archive-import`. A browser worker discovers metadata locally; **nothing is written to the server until "Import selected channels (N)"**. Grouped, searchable checkboxes keyed by Slack ID (the ID shows beside duplicate names); filtering keeps hidden selections; unknown sources need explicit confirmation; message history is on by default. Phases: idle→discovering→selecting→preparing→uploading→interrupted→finalizing→cancelling→monitoring→terminal. Per-conversation counters processed/imported/duplicates/skipped/reactions. Skip reasons `unsupported_dm \| target_unavailable \| uploads_incomplete \| skipped`. Cancel is not rollback. Job history survives a reload; local uploads do not. | `docs/SLACK_ARCHIVE_IMPORT_CONTRACT.md`, `apps/web/src/features/slack-import/primitives/import-controller.ts`, `apps/web/src/features/slack-import/components/conversation-picker.tsx` |
| Linear CSV import | Action in the Tasks view: upload a CSV, map assignees (exact email or name), preview the first 20 rows plus every row with a warning, create sequentially with done/total progress, then report created / skipped (no title) / failed. **No foreign-id dedupe**, so a re-import duplicates. | `apps/web/src/features/integrations/import-linear/ImportLinear.tsx`, `apps/web/src/lib/core/util/linearImport.ts` |
| Link previews | Hover-debounced card (title, description, image, favicon), disabled on touch devices. A plain click calls `openExternalUrl` (in-app under Tauri); modified clicks keep native behaviour. Client cache 10 min. Notion/Figma/Linear titles come from URL slugs. The CRM resolves company names and icons by unfurling `https://{domain}`. | `apps/web/src/lib/core/signal/unfurl.ts`, `apps/web/src/lib/core/component/LexicalMarkdown/component/core/LinkWithPreview.tsx`, `crates/unfurl/src/domain/url_parsers.rs`, `crates/crm/src/outbound/unfurl_resolver.rs` |
| Gmail / Calendar / Outlook linking | Multiple inboxes. Scope variants gmail \| gmail_and_calendar \| calendar, behind the `CALENDAR_SCOPE_ENABLED` kill switch; inbox paywall check. Revoked access shows up as a 403 and needs re-linking. | `services/authentication_service/src/api/link/gmail.rs`, `services/authentication_service/src/api/link/outlook.rs` |
| Realtime updates + presence | Pushes `refresh_email`, `refresh_calendar`, `import_updated`, `slack_import_updated` and stream events. Clients report open/ping/close per entity. The acting user is excluded from their own invalidations. Best effort; polling is the backstop. | `services/connection_gateway/src/api/connection.rs`, `crates/connection/src/domain/service.rs` |
| Macro as MCP server (setup modal) | Copyable `claude mcp add --transport http macro https://mcp-server.macro.com/mcp`, `codex mcp add …`, and a JSON `mcpServers` block. Opened from the Dispatch Agent menu and a global hotkey. | `apps/web/src/features/integrations/mcp-setup/MacroMcpSetupModal.tsx`, `apps/web/src/lib/core/component/AI/component/mcpConstants.ts:16-27` |
| GTM invites, marketing/analytics | Staff signup links with a promotional month; Loops, GA4, Meta CAPI, PostHog; a Cloudflare proxy. Invisible to users. | `crates/gtm_invite/src/lib.rs`, `crates/analytics_client/src/lib.rs`, `services/analytics-proxy/src/index.ts` |

## 3. How it's built

**Architecture.** Generic code is split from provider-specific code. Crates are hexagonal (domain + ports, outbound adapters, inbound Axum/AI-tool surfaces), and cargo features gate the adapters (`crates/slack_integration/Cargo.toml`).

- **Generic:** `crates/import` holds a closed `ImportSource` enum (Linear\|Notion\|Slack, not a plugin registry), the ledger state machine, the CAS repo port `ImportRepo`, the `EntityCreator` port, a server-side `ToolPolicy`, the heartbeat/reaper and `ImportNotify`. Also generic: `crates/mcp_select` `ConnectorRef {pipedream_app_slugs, native_server_url}`, `crates/foreign_entity`, `crates/unfurl`, and `crates/connection` with the gateway.
- **Provider-specific:**
  - Linear: `LinearIssueMeta`, `map_linear_status/priority`, `linear_task_content` in `crates/import/src/domain/service.rs`.
  - Notion: `NotionDocMeta`, direct `notion-fetch`, the enhanced-markdown normalizer and the `FinalizeImport` agent fallback in the same file; `crates/import/src/outbound/document_properties.rs`.
  - Slack live: `slack_discovery.rs`, `crates/import/src/outbound/mcp_slack_source.rs`.
  - Slack archive: all of `crates/slack_integration`, plus `services/slack_import_worker`.
  - Google: `crates/google_token`.
  - Microsoft: `crates/microsoft_oauth_grant_db_utils`, `services/authentication_service/src/microsoft_token_cipher.rs`.
- **Hosting:** the import router mounts in `services/document_cognition_service/src/api.rs:130` (wired at `src/server.rs:646` with `McpSlackSource`). The Slack archive admin router mounts under `/slack` in `services/document_storage_service/src/api.rs:266`. The worker is its own Fargate service.

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| Import ledger + orchestrator | `crates/import` | `import_entity` ledger; `import_run` gathers (typed Slack discovery, or an LLM gather with a locked staging tool); batches (deterministic Linear/Slack; Notion fetch + normalizer with agent fallback); AI tools; HTTP `/import/*`; MCP Slack adapter; canonical target reservations | 12,933 |
| Slack archive domain + adapters | `crates/slack_integration` | Pure parsing in `domain/slack/*` (export, users, threads, reactions, mrkdwn, references: 1,904 non-test + 1,607 test LOC; `mrkdwn.rs:8-9` and `references.rs:6-7` import `macro_user_id`/`mention_utils`; `SlackTimestamp` sits in `domain/models.rs`, FromStr ~214-237); `ConversationImporter`; admin service; outbox/DLQ; Postgres, S3, SQS, search and gateway adapters | 18,263 (9.3k tests) |
| Slack import worker | `services/slack_import_worker` | Composition root. `ChannelImportSink` commits one tx per batch across the channels/messages/ledger crates; claim/publish/maintenance loops; graceful drain | 3,695 |
| Foreign entity refs | `crates/foreign_entity` | Live external references (GitHub PRs): source, foreign id, JSON metadata, stored_for user\|team | 4,007 |
| Unfurl core | `crates/unfurl` | `UnfurlFetcher` port; reqwest+scraper adapter; manual redirect loop with a private-IP check per hop; DNS resolver that filters private IPs; 1 MB cap; HTML only; 8 s/3 s timeouts. Title precedence: custom parser > og:title > og:site_name > `<title>` > URL. Optimistic `/favicon.ico` | 1,299 |
| Unfurl service | `services/unfurl_service` | GET `/unfurl` (the crate); POST `/unfurl/bulk` (the path the web calls), using its own duplicate `src/unfurl.rs` + `src/http_safety.rs` at concurrency 16; GET `/proxy` (2 MB, header allowlists, CORP + nosniff). No authz in code | 1,869 |
| Connection gateway | `services/connection_gateway` | One Axum WS per user; DashMap + mpsc (cap 100; saturated consumers ejected); DynamoDB registry; Redis pub/sub relay (resubscribe backoff 1 s→30 s); send/batch_send with receipts; `/track/{type}/{id}` returns viewers (60 s); feeds frecency (`src/service/tracker.rs:10-47`) and last-online | 3,619 |
| Invalidation service | `crates/connection` | `send_invalidation_event`: users with access, minus the actor, sent to the gateway | 301 |
| Gateway client | `crates/connection_gateway_client` | reqwest, internal key, 15 s timeout | 257 |
| Google token cache | `crates/google_token` | Redis read-through (TTL 3000 s) over the auth service's `/internal/google_access_token`; a no-cache variant for retries | 92 |
| Microsoft grant store | `crates/microsoft_oauth_grant_db_utils` | Encrypted refresh-token envelopes keyed by (user, lowercased mailbox); a schema test asserts no plaintext columns. **No non-test reader.** | 475 |
| OAuth link flows (context) | `services/authentication_service/src/api/oauth2.rs` | HMAC-signed state (1 h, provider-bound). Google → FusionAuth IdP link. Microsoft → KMS envelope (AES-256-GCM, AAD = purpose+version+owner+mailbox) with compensation | 4,040 |
| Connector selection (context) | `crates/mcp_select/src/lib.rs` | Pipedream if the user has any Pipedream connector, else native | — |
| Onboarding trigger (context) | `crates/onboarding/src/domain/service.rs` | Level-triggered `start_due_gathers` / `reconcile` / `complete` | — |
| Slack archive UI | `apps/web/src/features/slack-import` | SolidJS dialog, worker-backed archive source, controller state machine | 5,752 |
| Browser ZIP worker | `apps/web/src/lib/workers/slack-import` | fflate streaming inflate in 1 KiB pushes (ZIP-bomb bound); two-pass reader; IndexedDB sort/dedupe by exact ts; NDJSON parts with backpressure | 2,148 |
| Import queries | `apps/web/src/lib/queries/import.ts` | Push only invalidates; polling at 3 s/15 s is authoritative; stable placeholderData | 130 |
| Integrations UI | `apps/web/src/features/integrations` | Linear CSV importer + MCP setup modal | 406 |
| GTM / analytics / infra | `crates/gtm_invite`, `crates/analytics_client`, `crates/loops_client`, `services/analytics-proxy`, `infra/stacks/{connection-gateway,unfurl-service}` | Growth, telemetry, Pulumi | 3,178 / 480 / 229 / 215 / 1,051 |

**Data model.**

| Entity | Store | Key fields | Path |
| --- | --- | --- | --- |
| `import_entity` | Postgres | id; user_id; team_id (set when shared, which gives team-wide dedupe on imported rows); source; foreign_id (normalized); status `staged\|importing\|imported\|discarded`; initiator `onboarding\|chat\|archive\|manual`; metadata JSONB (capped); entity_id/type; last_error; UNIQUE(user_id, source, foreign_id); CHECK imported ⇒ entity_id | `crates/macro_db_client/migrations/20260720221050_import_entities.sql`, `…/20261005141244_import_entity_initiator_manual.sql` |
| `import_run` | Postgres | PK (user_id, source); status `running\|ready\|importing\|completed\|failed\|dismissed`; auto_import; error | `crates/macro_db_client/migrations/20260723150434_support_auto_import_runs.sql` |
| `import_source_binding` | Postgres | team_id PK; slack_workspace_id; confirmed_unknown_at; a trigger makes known bindings immutable | `crates/macro_db_client/migrations/20260930171728_slack_archive_import.sql`, `crates/import/src/source_binding.rs:11-45` |
| `import_target_reservation` | Postgres | PK (team, source, foreign_id); candidate_channel_id reserved **before** create; state `pending\|ready\|conflict`; immutable once ready; shared by the live and archive paths | same migration |
| `slack_import_job` / `_conversation` / `_upload` / `_outbox` | Postgres | Job idempotency token. Conversation: seal, counters, checkpoint part/record, lease owner/token/generation, search generations, warnings. Upload: (job, channel, part) + verified etag. Outbox: (job, channel, kind, generation) | same migration |
| `slack_import_message_map` | Postgres | PK (team, slack_channel_id, slack_ts µs bigint) → message_id. No job FK, so dedupe survives cleanup. **First commit wins** | same migration |
| `slack_import_message_reference` | Postgres | (job, message) → template JSONB (≤4 MiB, 1–256 refs) until reconciled | `crates/macro_db_client/migrations/20261001163358_slack_import_message_references.sql` |
| `foreign_entity` | Postgres | foreign id + source; metadata JSONB; stored_for user\|team | `crates/macro_db_client/migrations/20260526175912_create_foreign_entity_table.sql` |
| `microsoft_oauth_grants` | Postgres | UNIQUE (user, lower(email)); ciphertext, encrypted_data_key, nonce, version, kms_key_id | `crates/macro_db_client/migrations/20260819123655_add_microsoft_oauth_grants.sql` |
| Google refresh token | FusionAuth IdP link | One `google_gmail` link per linked email; access tokens cached 3000 s | `services/authentication_service/src/api/internal/google_access_token.rs` |
| `pipedream_mcp_connections` | Postgres | PK (user, app_slug); account_id (Pipedream owns the tokens); enabled | `crates/macro_db_client/migrations/20260811160239_create_pipedream_mcp_connections.sql` |
| Gateway registry | DynamoDB + DashMap + Redis | PK `#{type}#{id}`, SK connection_id, GSI; last_ping | `services/connection_gateway/src/model/connection.rs` |
| Staged archive objects | S3 | `slack-import/{team}/{job}/{channel}/{part}.ndjson`; create-only, SHA-256, 14-day lifecycle | `docs/SLACK_ARCHIVE_IMPORT_CONTRACT.md` |

**Key flows.**

*Onboarding import run* (`crates/onboarding/src/domain/service.rs`, `crates/import/src/domain/service.rs`)
1. An onboarding read or the MCP post-auth hook calls `start_due_gathers`, which runs `start_gather(auto_import=true)` for each source with a connected connector.
2. AI admission (Linear/Notion only), then the `start_run` CAS (wins only if no run ever existed), then spawn the gather.
3. Slack: typed discovery (≤10 pages) picks the top 15 public, non-archived channels by member count and stages them, then enriches them against the roster (one 429 retry honouring Retry-After ≤30 s). Linear/Notion: an agent on `cerebras/gpt-oss-120b` (fallback `openai/gpt-5.4-nano`), ≤24 turns. Its toolset is `CreateImportEntity` only, and `ToolPolicy::gather` locks source + initiator.
4. `finish_run` sets Ready\|Failed (90 s; Slack 180 s). The `begin_auto_import` CAS claims the onboarding rows; the batch heartbeats every 30 s.
5. Linear: `linear_task_content` builds the task **from staged metadata alone** (`service.rs:742-753, 2514-2553`), then `create_task`. Slack: `reserve_target → create_channel → complete_target`. Notion: ≤4 concurrent; a server-side `try_tool_call` runs notion-fetch **with no model** (`service.rs:592-646`), then parse → `prepare_notion_markdown` → finalize. The fallback is a single-page agent with `FinalizeImport` (120 s).
6. CAS `mark_imported` / `mark_import_failed`, then push `import_updated`.
7. Every `state()` read reaps `importing` rows idle >180 s back to staged and reconciles interrupted runs. A failed reap never fails the read.
8. `complete()` deletes the unacted onboarding rows.

*Accept/decline* (`crates/import/src/inbound/axum_router.rs`): POST `/import/run {import_ids, discard_ids}` → discard CAS staged→discarded (re-staging is then blocked forever) → `mark_importing` CAS → batch → rows imported with team_id set, so teammates dedupe against them.

*Slack ZIP import* (`docs/SLACK_ARCHIVE_IMPORT_CONTRACT.md`, `crates/slack_integration/src/domain/importer.rs`)
1. Browser worker pass 1 discovers metadata → picker → confirm freezes the snapshot + idempotency token → POST `/slack/imports`.
2. Pass 2 emits normalized NDJSON parts, sorted and deduped by exact ts in IndexedDB → presigned create-only PUTs (412 means the object exists; verify it) → complete with the `ConversationSeal` digest.
3. Readiness and the outbox event commit in one tx → SQS → the worker claims a fenced lease, revalidates the admin and reserves the canonical target.
4. Per batch (≤500 messages / 4 MiB), **one tx** commits messages, reactions, mentions, message_map, checkpoint and the search-dirty marker. The DB lease and SQS visibility heartbeat every 60 s.
5. Reference reconciliation patches bodies by CAS, skipping messages edited live → search backfill → `slack_import_updated`.

*Unfurl* (`apps/web/src/lib/core/signal/unfurl.ts`, `services/unfurl_service/src/api/unfurl/get_unfurl.rs`): `useUnfurl(url)` queues the URL → 50 ms debounce → POST `/unfurl/bulk` → SSRF-safe fetch per URL → `GetUnfurlResponse` → per-URL state with a 10-min cache → hover card. Favicons load via `/proxy?url=`.

*Google/Microsoft grant lifecycle* (`services/authentication_service/src/api/oauth2/microsoft.rs`, `crates/google_token/src/lib.rs`): signed state → consent (`access_type=offline`, `prompt=consent`) → callback.
- Google: the IdP link holds the refresh token. Consumers hit Redis, else refresh at `oauth2.googleapis.com/token`. `invalid_grant` → 403 → re-link. Disconnect deletes the link, with **no provider revoke** (`crates/fusionauth/src/google/oauth.rs`).
- Microsoft: exchange → link → encrypt → upsert. Any failure compensates the link.

*Realtime push* (`crates/connection/src/domain/service.rs`, `services/connection_gateway/src/service/sender.rs`): `InvalidationEvent {entity_id, entity_type, reason deleted\|metadata\|content, invalidated_by}` → users with access, minus the actor → batch send → local mpsc, or Redis to the owning instance → WS frame → receipts.

## 4. Ideas worth stealing (ranked)

1. **The tool is the output channel.** Gather agents stage candidates only by calling `CreateImportEntity`. The server-side `ToolPolicy` (initiator, forced_source, allow_imported) means the model cannot spoof the user, source or provenance. Maps onto Cerebro's `RunGrant`. Read `crates/import/src/inbound/toolset.rs`.
2. **Deterministic first, and page bytes never pass through a model on the happy path.** Notion pages are fetched server-side by `try_tool_call` and normalized by code; only failures go to a bounded agent. Macro's own comment says re-emitting a page as output tokens is "an order of magnitude slower" (`crates/import/src/domain/service.rs:585-646`).
3. **A ledger that separates "said no" from "never looked".** `discarded` is remembered forever; unacted rows are deleted when a flow ends. Read `crates/import/src/domain/models.rs`, `crates/onboarding/src/domain/service.rs`.
4. **Tolerant but strict MCP result parsing.** Accept JSON text or structured content and known wrapper keys only. `ok:false`, truncated, malformed or prose results are errors, never empty lists; a missing tool is an unsupported capability. Same rule as Cerebro's "unavailable is never empty". Read `crates/import/src/outbound/mcp_slack_source/parse.rs`.
5. **Normalize foreign ids before keying.** Notion URL → undashed 32-hex id; Slack C-ids kept, names → `#name`; an imported upsert keeps the first mapping. Read `crates/import/src/domain/models.rs`, `crates/import/src/outbound/pg_import_repo.rs`.
6. **Exact Slack identity.** Decimal ts → integer µs (1–6 fraction digits, no floats, ≤ year 9999). Threads come from `thread_ts` only, never `replies[]`; edits use the inner message's ts; tombstones are skipped. First commit wins on (team, channel, µs ts). Read `crates/slack_integration/src/domain/models.rs`, `crates/slack_integration/src/domain/slack/threads.rs`.
7. **Code-aware mrkdwn converter with budgets** (1 MiB, 256 refs). Code is preserved byte for byte, entities are decoded once, broadcasts stay inert, the scheme allowlist is http/https/mailto, and mentions are emitted as evidence. Read `crates/slack_integration/src/domain/slack/mrkdwn.rs`, `crates/slack_integration/src/domain/slack/references.rs`.
8. **Honest residue when vocabularies differ.** An unmappable Linear status or priority stays visible in a body footer ("Status: X · Imported from [Linear](url)"), never dropped. The CSV path keeps an "Imported from Linear" list too. Read `crates/import/src/domain/service.rs:2514-2553`, `apps/web/src/lib/core/util/linearImport.ts:170-198`.
9. **Archive import UX contract.** Discover before any write; freeze the snapshot and token on confirm; filters never drop hidden selections; unsupported kinds are unavailable choices, not silent skips; cancel is not rollback. Read `docs/SLACK_ARCHIVE_IMPORT_CONTRACT.md`.
10. **Source binding.** A team is bound to one Slack workspace, and an unknown source needs explicit confirmation. Without this, ts-keyed dedupe is ambiguous across workspaces. Read `crates/import/src/source_binding.rs:11-45`.
11. **Reserve the target before creating it**, shared by every import path under an advisory lock. Cerebro analog: reserve the path, then write idempotently. Read `crates/import/src/outbound/pg_import_repo/targets.rs`.
12. **Deferred reference reconciliation.** Store fallback text plus byte-ranged typed intents, then patch by CAS once every target exists, skipping edited messages. Cerebro analog: rewrite permalinks to wikilinks after the batch. Read `crates/slack_integration/src/domain/reference_reconciliation.rs`.
13. **URL-slug titles for SPA tools** (Notion, Figma, Linear) whose HTML titles are generic. Read `crates/unfurl/src/domain/url_parsers.rs`, `services/unfurl_service/CUSTOM_PARSERS.md`.
14. **Heartbeat + read-path reaper** instead of a job queue. Read `crates/import/src/domain/service.rs`.
15. **Metadata-only staging with byte caps** (title 300, description 4000, summary 600, ≤100 participants). Read `crates/import/src/domain/models.rs`.
16. **Bounded pagination with one Retry-After retry; the enrichment deadline is reserved inside the outer timeout.** Read `crates/import/src/domain/service/slack_discovery.rs`.
17. **SSRF-safe fetcher**: manual redirects checked per hop, a rebinding-safe resolver, a content-type gate, a streaming cap. Relevant only if a fetcher is ever approved. Read `crates/unfurl/src/outbound/http_safety.rs`, `crates/unfurl/src/outbound/resolver.rs`.
18. **OAuth hygiene templates:** signed, provider-bound state; an AAD-bound envelope; a no-plaintext schema test; compensating rollback. Read `services/authentication_service/src/account_link_state.rs`, `crates/microsoft_oauth_grant_db_utils/src/test.rs`.

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Connector status connected/action-required/… | absent | high | `translate()` keeps only session_id from init (`src-tauri/src/agent/mod.rs:1026-1037`); `permission_denials[]` is reduced to a count (`agent/usage.rs:131-134`). A connector that needs sign-in fails silently inside the run. |
| Connector tools reachable in headless runs | unknown (**live-check**) | high | `--allowedTools` carries only `mcp__cerebro__*` plus shell built-ins (`agent/mod.rs:560-587, 717-718`). The CLI auto-denies other tools in headless runs, and no Cerebro test asserts that connector tools are allowed (`agent/mod.rs:1607-1643`). |
| Connectors as capabilities, presets, OAuth popup | partial | medium | Per-vault `connectors.json` (http\|stdio only, `connectors.rs:228-298`), per-agent narrowing; no presets; OAuth belongs to the CLI by design. |
| Import ledger + (source, foreign_id) dedupe | absent | high | No import table in runtime.db (at user_version 18). `create_note` adds -2, -3 suffixes (`vault/write.rs:573-591, 739-757`), so re-imports duplicate. |
| Policy-locked staging tool | partial | high | `RunGrant` locks actor/scope/tools; there is no staging tool and no source lock. |
| Server-stamped provenance | partial (unenforced) | high | `cache_source` claims to stamp `generated` (comment `mcp.rs:2925-2927`), but `create_note`/`update_frontmatter` refuse only `knowledge/` and governed types (`mcp.rs:2629-2671`, `knowledge.rs:334-339`). Shell runs keep Write/Edit/Bash. |
| Foreign-id normalization | partial + **live defects** | high | `source_slug` covers issue/web only. It truncates at 80 chars (collisions, then silent overwrite) and differs between TS and Rust on `+-+` URLs (§8). |
| Onboarding gather | absent | low | No onboarding flow. The nearest door is the Inbox plus a gather Skill/Agent record. |
| Linear → tasks with vocabulary mapping | absent | medium | No CSV parsing; `src/lib/ingest.ts:16-19` accepts md/markdown/txt/text/vtt/srt only, with a 4 MiB cap. |
| Notion page import + normalizer | absent | high | `adopt.ts` infers kinds only for entries that already have a `type:` (`adopt.ts:56-58, 108-116`), so untyped imported pages get no inference. |
| Notion databases | absent (Macro drops them) | medium | Cerebro has a database model (M47); Macro does not. |
| Slack export ZIP import | absent | low | No zip/fflate dependency. |
| Slack live channel import | different by design | low | No channel model. |
| URL-slug link titles | absent | medium | A consumer exists: `src/editor/citations.ts:184-190` falls back to the raw URL. |
| Network unfurl + favicon proxy | absent | low | Desktop builds compile **no HTTP/TLS stack** (reqwest is pulled in only for Android/iOS by tauri 2.11.5); CSP `img-src 'self' data:` (`tauri.conf.json:24`). |
| Cached external copies + freshness | already better | medium | `cache_source` + Source Monitor + `sourceFreshness`; Macro has none. One tension: the Monitor routes on `type: Source` while TS `sourceFreshness` gates on properties. |
| Connector scoping + execution safety | already better | medium | Per-agent narrowing, stdio approval digests, fail-closed config, unattended runs never inherit the global MCP config. |
| Actor-excluded invalidation | already better | low | The watcher suppresses its own writes by content hash (`vault/watcher.rs:1-11`). Only typed payloads are missing (the payload at `watcher.rs:266` is unit). |
| Gmail/Calendar/Outlook OAuth, token caches | different by design | low | Zero credentials (M13, M34.5, `connectors.rs:18-22`). |
| Realtime gateway, presence | different by design | low | Tauri events. Frecency from open/ping/close goes to DOMAIN:search. |
| Macro as MCP server | different by design | low | See `09-mcp.md` MCP-5. |
| foreign_entity | partial | low | `sources/` cached copies + mounted repos (Work). |
| GTM, Loops/GA4/Meta/PostHog | absent | low | Skip. |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INTEGRATIONS-2a | Source-cache slug defects: 80-char collisions + TS/Rust `+-+` parity break (bugfix) | rebuild | inspire | S | high | `crates/import/src/domain/models.rs` (id normalization) | `src/engine/ingest.ts`, `src/engine/ingest.test.ts`, `src-tauri/src/mcp.rs`, `src-tauri/src/vault/write.rs` | — |
| INTEGRATIONS-15 | Headless connector permission (allow rules or prompt-tool card) | rebuild | adapt | S | high | `crates/mcp_select/src/lib.rs` (which tools load) | `src-tauri/src/agent/mod.rs`, `src-tauri/src/agent/usage.rs`, `src-tauri/src/connectors.rs` | live-check |
| INTEGRATIONS-1 | Connector status from the CLI's own reports, with a copyable fix | rebuild | adapt | **L** | high | `apps/web/src/features/settings/connections/model.ts`, `apps/web/src/features/settings/connections/capability-row.ts`, `apps/web/src/lib/core/component/AI/component/mcpConstants.ts:16-27`, `apps/docs/AI/mcp/tools/discover-connectors.mdx` | `src-tauri/src/agent/mod.rs`, `src-tauri/src/agent/usage.rs`, `src-tauri/src/connectors.rs`, `src-tauri/src/runtime/schema.rs` (next user_version), `src/agent/types.ts`, `src/agent/mockAgent.ts`, `src/engine/connectors.ts`, `src/app/ConnectorSettings.tsx` | INTEGRATIONS-15, DOMAIN:agents; plan with `09-mcp` MCP-4 |
| INTEGRATIONS-16 | Refuse agent writes of stamp keys outside the stamping tools | rebuild | inspire | S | high | `crates/import/src/inbound/toolset.rs` (`ToolPolicy`) | `src-tauri/src/mcp.rs`, `src-tauri/src/knowledge.rs`, `src/lib/mockIpc.ts` | — |
| INTEGRATIONS-12 | Host-side connector calls via the CLI control channel (`mcp_status`, `mcp_call`, `mcp_authenticate`, `mcp_reconnect`) | rebuild | adapt | L | high | `crates/import/src/domain/service.rs:585-646` (`try_tool_call`) | `src-tauri/src/agent/mod.rs`, `src-tauri/src/agent/control.rs` (new) | DOMAIN:agents; live-check; owner call against `monitor/sources.rs:3-9` |
| INTEGRATIONS-7 | URL-derived link labels (zero network) | rebuild | **adapt** | S | medium | `crates/unfurl/src/domain/url_parsers.rs`, `services/unfurl_service/CUSTOM_PARSERS.md` | `src/engine/linkLabels.ts` (new), `src/editor/citations.ts`, `src/editor/chips.tsx`, `src/engine/ingest.ts` | DOMAIN:editor |
| INTEGRATIONS-14 | Authority of imported/third-party text | owner decision | — | M | high | `crates/import/src/domain/models.rs` (initiator provenance) | `src-tauri/src/ingest/source.rs`, `src-tauri/src/ledger/schema/source.rs`, `src-tauri/src/ledger/migrate.rs` | before any importer ships |
| INTEGRATIONS-2 | Imported material: server-stamped provenance, normalized identity, one writer | rebuild | adapt | **L** | high | `crates/import/src/domain/models.rs`, `crates/import/src/inbound/toolset.rs`, `crates/import/src/outbound/pg_import_repo.rs` | `shared/import/sources.v1.json` (new) + `goldens/`, `src-tauri/src/vault/write.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/monitor/sources.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/engine/ingest.ts`, `demo-vault/sources/issues/phx-421.md` | INTEGRATIONS-2a, -16, -14 |
| INTEGRATIONS-4 | Linear import: CSV + vocabulary mapping onto any status-bearing database | rebuild | adapt | M | medium | `apps/web/src/lib/core/util/linearImport.ts`, `crates/import/src/domain/service.rs:2514-2553`, `apps/web/src/features/integrations/import-linear/ImportLinear.tsx` | `src/engine/importLinear.ts`, `src/engine/csv.ts` (shared with DATA-11), `src/app/ImportDialog.tsx`, `src/pages/InboxPage.tsx`, `src/lib/ingest.ts` | INTEGRATIONS-2, DOMAIN:data |
| INTEGRATIONS-5 | Notion page import: host-side byte capture + deterministic normalizer | rebuild | adapt | L | high | `crates/import/src/domain/service.rs:1540-2464`, `crates/import/src/domain/service/test.rs:99-454`, `crates/import/src/outbound/document_properties.rs`, `apps/docs/AI/mcp/tools/import-notion-page.mdx` | `src-tauri/src/import/mod.rs`, `src-tauri/src/import/notion.rs`, `src-tauri/src/agent/mod.rs` (capture), `src-tauri/src/mcp.rs`, `src-tauri/Cargo.toml`, `src-tauri/tests/fixtures/notion/` | INTEGRATIONS-2, -1, -12 or run-stream capture, -15, DOMAIN:mcp |
| INTEGRATIONS-3 | Staged import queue fed by a policy-locked loopback tool | rebuild | adapt | L | medium | `crates/import/src/inbound/toolset.rs`, `crates/import/src/domain/service.rs`, `apps/web/src/lib/queries/import.ts`, `apps/docs/AI/mcp/tools/create-import-entity.mdx` | `src-tauri/src/runtime/schema.rs` (next user_version), `src-tauri/src/runtime/imports.rs` (new), `src-tauri/src/mcp.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/pages/InboxPage.tsx` | INTEGRATIONS-2, -1, -15, DOMAIN:agents, DOMAIN:mcp; R14 owner call |
| INTEGRATIONS-13 | Notion database → Type doc + rows | rebuild | adapt | L | medium | none (Macro drops databases, `service.rs:617-626, 2114-2130`) | `src-tauri/src/import/notion.rs`, `types/` docs per M47, `src/engine/adopt.ts` | INTEGRATIONS-5 |
| INTEGRATIONS-6 | Slack export ZIP → markdown archive (offline) | rebuild | adapt | L | low | `crates/slack_integration/src/domain/slack/{export,mrkdwn,threads,users,reactions,references}.rs`, `crates/slack_integration/src/domain/models.rs`, `crates/import/src/source_binding.rs`, `docs/SLACK_ARCHIVE_IMPORT_CONTRACT.md`, `apps/web/src/features/slack-import/components/conversation-picker.tsx` | `src/engine/slackExport.ts`, `src/engine/mrkdwn.ts`, `src/app/SlackImportDialog.tsx`, `src/pages/InboxPage.tsx`, `package.json` | INTEGRATIONS-2, -14, DOMAIN:files, DOMAIN:comms |
| INTEGRATIONS-17 | Notion workspace export ZIP (no connector) | rebuild | inspire | M | medium (low priority) | none in Macro | `src/engine/ingest.ts`, reuses the -6 ZIP reader, the -4 CSV module and the -5 normalizer | INTEGRATIONS-4, -5, -6 |
| INTEGRATIONS-8 | Network unfurl, bulk endpoint, SSRF proxy | skip (adopt-upstream if reversed) | — | M | low | `crates/unfurl/src/outbound/http_safety.rs`, `crates/unfurl/src/outbound/resolver.rs` | — | owner reversal of M26.7d |
| INTEGRATIONS-9 | OAuth linking + token stores (Gmail/Calendar/Outlook, Pipedream) | skip | — | L | low | `crates/google_token/src/lib.rs`, `services/authentication_service/src/microsoft_token_cipher.rs` | — | — |
| INTEGRATIONS-10 | Cerebro as MCP server for external agents | skip (reuse the copyable-command pattern in -1) | — | M | low | `apps/web/src/features/integrations/mcp-setup/MacroMcpSetupModal.tsx` | — | see `09-mcp` MCP-5 |
| INTEGRATIONS-11 | Gateway/presence, foreign_entity, GTM, analytics | skip | — | L | low | `services/connection_gateway/src/service/tracker.rs` (frecency → DOMAIN:search) | — | — |

**INTEGRATIONS-1: connector status (top 1).**
- Four signal sources:
  - init `mcp_servers[{name,status}]`. CLI enum `connected|failed|needs-auth|pending|disabled`. Connect is **non-blocking**, so vault connectors mostly read `pending` and no later MCP event is streamed. Fix: `alwaysLoad: true` on the entries (schema accepts it), or `MCP_CONNECTION_NONBLOCKING=false`.
  - `system/permission_denied` and result `permission_denials[]` tool names (`mcp__<server>__…`).
  - optional `mcp_server_errors[{name,type,message}]`.
  - tool_result errors. Live status via `mcp_status` comes with -12.
- States: connected · needs sign-in · failed · not permitted (-15) · off · unapproved (stdio) · connecting / not checked yet. A connector never observed is "not checked yet", never connected.
- Persist in Rust at the next user_version, because Rust's run loop sees every run, attended or not. Never uiStore/localStorage. Store names, status, as-of time and run id, nothing credential-bearing. Expose status to the agent too (analog of `DiscoverConnectors`).
- Fix text: a copyable `claude mcp add --transport http <exact name> <exact url>`, then `/mcp`. The CLI keys tokens on `name|sha256({type,url,headers})[0..16]`, so name, url and headers must match the vault entry. sse and claude.ai (`claudeai-proxy`) connectors cannot be expressed in `connectors.json` (**live-check**).

**INTEGRATIONS-2a + -2: one identity for fetched and imported material (top 2).**
- -2a ships first, alone. Two defects. `slugForUrl` (`src/engine/ingest.ts:389-395`) and `source_slug` (`mcp.rs:2872-2876`) both cut at 80 chars, so long same-prefix Notion URLs collide and `write_source` silently overwrites. TS also keeps `---` where Rust collapses dashes: on a Confluence `+-+` URL TS gives `release---q3-plan` and Rust `release-q3-plan`, so `uncachedRefs` (`ingest.ts:427-434`) never finds the copy and refetches forever. Fix: one canonical slug with an id suffix, parity goldens including `+-+` and >80-char Notion URLs, and find existing copies by frontmatter id.
- -2 then: put slug and id canonicalization in a shared data artifact (or drop the TS twin), with digest + regeneration test (precedent `shared/runtime/budget-defaults.v1.json`). **Reuse** `cache_source`'s `source_id/source_kind/source_url`, which the Monitor keys on (`monitor/sources.rs:97-112`); do not add a second vocabulary. Stamp `imported_at`, `imported_by`, `import_hash` server-side. Return `already_imported{path}` for the same id; replace only when the body hash equals `import_hash`. Add a per-(source, id) write lock.
- Dedupe must tolerate missing keys: shell and human edits can strip them even once -16 guards the agent tools. Choose one rule for "is a cached or imported copy" (`type: Source` vs properties). Delete the falsified comments `ingest.ts:1-13` and `mcp.rs:2925-2926`. Budget e2e churn from `demo-vault/sources/issues/phx-421.md`.

**INTEGRATIONS-5: Notion page import (top 3).**
- Capture page bytes **host-side**, never through the model. Rust already reads full tool_result blocks by `tool_use_id` before cutting them to 2,000 chars for the UI (`agent/mod.rs:991-1023, 1086-1100`); control-channel `mcp_call` (-12) is the other route. Refuse the CLI's 25k-token truncation and its "Output has been saved to" spill notice.
- Normalize in Rust (Macro's version is ~925 lines at `service.rs:1540-2464`; `regex` is already compiled via tauri-utils). Drop `<database>` blocks; `<page>`/`<mention-page>` → `[[wikilink]]` if the page is already imported, else an external link; date and user mentions → text; media → links; ragged tables → rectangular. Map `<callout>` → `> [!kind]` and `<columns>` → `:::columns` (`src/editor/markdown.ts:337-344, 451`) instead of Macro's flattening (`service.rs:2240-2281`).
- Typed refusals: empty, tool narration, database-first pages (<200 alphanumerics after DB removal), unhandled markup outside fences, `knowledge/` destinations. Properties → frontmatter (strip `userDefined:`, `date:<n>:start` → date, `__YES__/__NO__` → bool). Stamp `type:` only when adopt should infer kinds.
- An agent-composed fallback is stamped `import_method: agent_composed`. Reconciliation after a batch skips files edited since import. One-shot copy, not sync. Capture fresh vendor fixtures first: Macro's tests are synthetic strings. Record the deviation from M13's "fetched → `sources/`".

**Other candidates: notes after stage 3.**
- **INTEGRATIONS-15 (live-check first):** add `mcp__<server>` allow rules for merged connectors, narrowed by `connector_names`, or route approvals through `--permission-prompt-tool` to a Cerebro card. Report per-connector denials into -1.
- **INTEGRATIONS-16:** a pre-existing hole. Refuse agent writes of `generated`, `source_id/kind/url`, `fetched_at` and the import keys outside the stamping tools, with mock parity.
- **INTEGRATIONS-12:** Cerebro spawns `-p <text>` (`agent/mod.rs:681-688`). A short-lived `--input-format stream-json` worker unlocks `mcp_status`, `mcp_call` (the analog of `try_tool_call`), `mcp_authenticate` (in-app sign-in, tokens stay in the CLI) and `mcp_reconnect`. The protocol is undocumented, so pin the CLI with fixtures. Whether these work in local `-p` is a live-check.
- **INTEGRATIONS-7:** pure `url → {service, title|null}`. Notion slug-uuid (percent-decode non-ASCII; `notion.so`, `*.notion.so`, `*.notion.site`), Figma `/design|file|board|proto/<id>/<title>`, Linear `/<team>/issue/<ID>/<slug>` → `ENG-142 Fix login`, GitHub pull/issue numbers. A recognized host with no title gives the service name; an unknown host gives null. Match host suffixes exactly (Macro's `contains('notion.so')` matches `notion.so.evil.test`). "ID Title" and sentence case are Cerebro's rules; Macro Title-Cases slugs and matches Figma `/design` only. Label as derived from the link.
- **INTEGRATIONS-14 (owner decision):** authority is derived from WHO, split by path because that is where the write guard lives (`ingest/source.rs:24-36`). Gating on editable frontmatter is not capability-gating. Options: (a) a path-guarded import root; (b) a content-only `legacy_reference`-style registration (`ledger/schema/source.rs`, `ledger/migrate.rs`); (c) an R14 connector registration. Decide before any importer ships, because registration is irreversible: `derive_item_id`/`derive_receipt_id` bake in source_id (`ledger/schema/ingest.rs:475-515`).
- **INTEGRATIONS-4:**
  - Key on the Linear **UUID** column, with the identifier as an alias (identifiers change when issues move teams). Gather paths must capture the uuid; Macro's MCP metadata has none (`models.rs:432-452`).
  - Check Completed **before** Archived, and do not treat Archived alone as Canceled. Macro checks Archived/Canceled first (`linearImport.ts:81`), and Linear auto-archives closed issues.
  - Priority: numeric 0–4 or a label. Status groups are only `active|done|closed` (`src/engine/types.ts:69`), so not-started vs in-progress goes to option matching or the residue footer.
  - Branch `.csv` around `isIngestible` and the 4 MiB cap. One RFC-4180 module shared with DATA-11. Fixtures: BOM as a `﻿` escape; assignee wikilinks in `entry.relationships`.
  - Acceptance: re-running the same CSV creates 0 files. Record the M13 and M8.2 deviations.
- **INTEGRATIONS-3:**
  - Accept **fetches** the item, Linear included; never compose from LLM-staged metadata capped at 4,000 bytes.
  - Table `import_candidates` at the next user_version (not "V19": the draft roadmap's M54.11 and M58.1 also add schema steps). UNIQUE(vault, source, foreign_id). `staged | already_imported{path} | previously_declined` are outcomes, not refusals.
  - Refusals need a new policy category (format bump, digest/goldens, both loaders) or reuse of `malformed_arguments`/`capability_unavailable`/`schema_invalid`; `rejected{rule}` needs a registered RuleCode (`policy/table.rs:328-345, 461-472`).
  - Reuse `job_ledger` claims and the `agent` lane. A quarantined runtime.db makes declines read "unknown"; a failed list read renders `section-unavailable`. Write Cerebro's own gather prompts (`prompts.rs` is AGPL text).
- **INTEGRATIONS-6:**
  - Drop S3/SQS/leases/outbox and read the ZIP directly, streaming; never buffer it whole.
  - Dedupe on (workspace, channel, µs ts) with a vault↔workspace binding and explicit unknown-source confirmation.
  - **Do not reuse the transcript turn format as-is.** Its parser merges same-speaker lines (`src/engine/ingest.ts:169`), and `turnsToMarkdown` keeps only HH:MM:SS plus the speaker on one line (`195-203`). That loses per-message identity and breaks code fences after `**Name:** `. Add per-message ts anchors.
  - Mentions → wikilinks by exact email. Build the emoji map from the MIT upstreams and write our own fixtures. Default to public channels; attachments are dropped in v1.
- **INTEGRATIONS-13 / -17:** -13 lifts Notion databases into M47 Type docs + rows, which also gives adopt typed rows to infer from. -17 imports a Notion workspace export ZIP with no connector auth or status dependency. It fits files-first and reuses -4/-5/-6.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro invariant | Resolution |
| --- | --- | --- |
| Server holds OAuth grants (FusionAuth links, KMS-encrypted refresh tokens, Pipedream accounts) | Zero credentials; headers/env edited in the file (M13, M34.5) | No token store, no in-app OAuth. Status + copyable fix (-1); sign-in only via CLI `mcp_authenticate` (-12). Skip -9. |
| Server-side HTTP fetchers (unfurl, `/proxy`, server MCP fetch) | No HTTP client in the core (M26.7d; desktop compiles no HTTP/TLS stack); internal runs may not WebFetch; CSP `img-src 'self' data:` | Zero-network labels (-7). Connector bytes captured from the CLI run (-5, -12). OG unfurl skipped. |
| Background jobs reach connectors freely | Headless runs auto-deny tools not on `--allowedTools`; unattended runs never inherit the global MCP config | -15 adds explicit allow rules per merged connector. Imports run attended; background fetch needs an explicit `connectors.json` entry. |
| Postgres `import_entity` is the authority on what was imported | The vault is the source of truth; operational state lives in runtime.db; the ledger is epistemic only | Imported provenance lives in frontmatter (rebuildable by scan); staged/importing/discarded live in runtime.db; nothing goes in the epistemic ledger. |
| Closed `ImportSource` enum, fixed entity types, hard-coded status labels | No type special-casing; policy is data shared by Rust + TS | Target = a user-chosen Type (capability-gated on a status field); vocabulary + canonicalizers in one shared artifact with goldens. The Monitor's `type: Source` routing gets resolved in -2. |
| Imports owned by the importing user; Slack authors re-attributed via the roster | Authority is provenance (D11; `ingest/source.rs`) | Owner decision (-14), taken before any importer ships. Keep per-author attribution in the body. |
| Accepted candidates materialize as tasks/docs | M13: everything fetched lands in `sources/` via `cache_source`. M8.2 (untyped `inbox/`) governs file ingest; its fetched-ticket comment in `ingest.ts:1-13` is stale | Preview + per-row/batch accept counts as the review. Record the M13 deviation (and M8.2 for file imports) in each plan. |
| `FinalizeImport` agent writes LLM-normalized pages | Provenance is server-stamped, though today this is enforced only in `knowledge/` | -16 enforces it everywhere. The loopback stamps source/actor/run/method; fallbacks are marked `agent_composed`. |
| Gather AI cost admitted per org | Every CLI run is metered; ambient runs pass `budget::gate` on a closed lane | User-initiated imports run attended. Background work reuses the `agent` lane, or adds a lane by migration. |
| New refusal codes as ad hoc strings | Every refusal's destiny is declared in `policy.v3.json`; registries are checked at load | Grow the table format or reuse existing codes; outcomes are not refusals. |
| A change leaves its old comments | A retired workaround kills its comment | -2 deletes `ingest.ts:1-13` and `mcp.rs:2925-2926`. |
| R14 live connectors, one per evidence pack | R14 scopes **live** connectors (M28 spec:257); one-shot imports via the user's CLI are closer to D5's `cache_source` | Owner call before -3/-5. Default: one source per milestone. |
| AGPL / all-rights-reserved code | Apache-2.0 (M48 precedent) | Behaviour only; re-derive rules from our own fixtures; emoji map from MIT upstreams. |

## 8. Verification notes (stage 3)

- **Refuted: "the agent passes the raw notion-fetch result to `import_page`, which is Macro's deterministic path".** Macro's direct path is a server-side `try_tool_call` with no model (`service.rs:592-646`); stage 2 had copied Macro's fallback. The CLI also caps MCP output at 25k tokens and spills larger results to a file. → host-side capture by `tool_use_id`, or -12.
- **Refuted: "Macro stages metadata and fetches content only after Accept".** Only Notion works that way. Linear tasks are composed from staged metadata (`service.rs:742-753, 2514-2553`) with a 4,000-byte LLM-written description and no UUID (`models.rs:403-409, 432-452`).
- **Refuted: "gating ingest authority on import/fetch properties is capability-gating".** Authority comes from WHO, split by path (`source.rs:24-36`); anyone can edit frontmatter. → INTEGRATIONS-14.
- **Refuted: "server-stamped provenance cannot be authored by the agent".** It is enforced only in `knowledge/` (`mcp.rs:2629-2671`, `knowledge.rs:334-339`). → INTEGRATIONS-16.
- **Refuted: an earlier draft of this file said `sources/` register as owner assertions "switch on or off".** Registration runs only inside `driver::tick` (`ingest/driver.rs:101-136`), called only at `ambient.rs:280` after `if !enabled return` (`256-258`); the default is false. Ambient's always-on phases register nothing (`ambient.rs:333-380`).
- **Confirmed:** with ingest on, every non-`knowledge/` path (`sources/` included) resolves to HumanActor + HumanAssertion (`source.rs:67-73`, `capture.rs:292-303`). Changing provenance re-keys `derive_item_id` (`ledger/schema/ingest.rs:475-515`); spend happens only where ingest is on. Old items stay in the append-only ledger.
- **Corrected: CLI init status.** The field exists, but connect is non-blocking, so init mostly reports `pending` and no later event follows. Signals added: `alwaysLoad`, `permission_denied`, `permission_denials[]`, `mcp_server_errors`. -1 effort M → **L**.
- **Corrected: token reuse.** It works only when name+type+url+headers match exactly. There is no authenticate pseudo-tool; `mcp_authenticate` exists only on the stream-json control loop.
- **Corrected: refusal codes.** Declaring them is not enough: they need a new category (as M26.2's `mint_rejections`) or reuse of existing codes, plus a RuleCode.
- **Corrected: adopt.ts** clusters typed entries only, so untyped imports get no kind inference.
- **Corrected: M8.2 is not the governing rule for fetched material; M13 is.** `cache_source` already writes `type: Source` into `sources/`.
- **Corrected: Linear CSV precedence.** Macro checks Archived/Canceled before Completed; do not copy it. Macro's CSV path does keep an honest residue (`linearImport.ts:170-198`). Vendor columns are unverified (**live-check**).
- **Corrected: licences / HTTP.** scraper is ISC. reqwest is pulled in only for Android/iOS (tauri 2.11.5 `Cargo.toml:321`); `target/debug/deps` holds no reqwest/hyper/rustls. -8's skip is firmer.
- **Corrected: -7 fidelity mirror → adapt** (suffix host match, GitHub, "ID Title", sentence case). Effort S holds.
- **Confirmed:** `create_note` uniquifies and `write_source` overwrites exact paths; the Notion normalizer is 925 lines plus 14 tests; Slack pure parsing is 1,904 + 1,607 LOC (with `macro_user_id`/`mention_utils` coupling); Macro matches title hosts with `contains()`; Cerebro's watcher already excludes its own writes.
- **Unverifiable:** Notion vendor shape (Macro's tests are synthetic; its parser accepts several shapes, so the shape has drifted before); Linear CSV columns; whether R14 covers one-shot imports.
- **Added (missed items):** -2a (live slug defects, incl. the TS/Rust `+-+` break shown by a node replay), -12 (control channel), -13 (Notion DB → Type), -14 (authority decision), -15 (headless permission), -16 (forgeable provenance), -17 (Notion export ZIP). Gateway frecency goes to DOMAIN:search.
- **Live-checks before planning:** init timing with `alwaysLoad`; headless connector permission; `mcp_call`/`mcp_authenticate` in local `-p`; token reuse; claude.ai connectors under `--strict-mcp-config`; Notion/Linear vendor shapes.
- **Macro defects not to copy:** the Linear CSV path has no dedupe; Microsoft grants are written but never read; disconnect sends no provider revoke; `/unfurl/bulk` duplicates the crate; the unfurl service has no authz; hosts are matched with `contains()`.
- **Already scheduled in the draft roadmap (2026-10-12):** -1 (M54.11), -2a (M53.17), -2/-4/-5/-7 (M69).
- **Suggested order:** -2a → -15 → -1 → -16 → -7 → -14 (decision) → -2 → -4 → -12 → -5 → -3 → -13 → -6 → -17.

## 9. Where to read first

1. `crates/import/src/domain/models.rs`
2. `crates/import/src/inbound/toolset.rs`
3. `crates/import/src/domain/service.rs` (585-753 accept paths and `try_tool_call`; 1540-2464 Notion normalizer; 2514-2553 Linear compose + residue)
4. `crates/import/src/outbound/mcp_slack_source/parse.rs`
5. `crates/import/src/outbound/pg_import_repo.rs`
6. `apps/web/src/features/settings/connections/model.ts`
7. `apps/web/src/lib/core/component/AI/component/mcpConstants.ts`
8. `crates/unfurl/src/domain/url_parsers.rs`
9. `apps/web/src/lib/core/util/linearImport.ts`
10. `crates/onboarding/src/domain/service.rs`
11. `docs/SLACK_ARCHIVE_IMPORT_CONTRACT.md`
12. `crates/import/src/source_binding.rs`
13. `crates/slack_integration/src/domain/models.rs`
14. `crates/slack_integration/src/domain/slack/mrkdwn.rs`
15. `crates/slack_integration/src/domain/slack/threads.rs`
16. `crates/slack_integration/src/domain/slack/references.rs`
17. `apps/web/src/features/slack-import/primitives/import-controller.ts`
18. `apps/web/src/lib/queries/import.ts`
19. `docs/SLACK_LIVE_CHANNEL_IMPORT.md`
20. `crates/unfurl/src/outbound/http_safety.rs` (only if network unfurl is ever approved)
21. `services/authentication_service/src/microsoft_token_cipher.rs` (only as a template if Cerebro ever holds tokens)
