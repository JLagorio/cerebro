# Outline: AI, MCP server, OAuth/API keys, integrations, webhooks, imports (OKF) - reference audit 2026-10-24

> **Scope:** Outline 1.12.0 snapshot. MCP server (tools, skills, route, tests), WebMCP, OAuth AS (DCR/CIMD), API keys and scope grammar, webhooks, the plugin providers (GitHub, GitLab, Linear, Figma, Iframely, Slack, Notion, Zapier, search-postgres), unfurls and issue sources, the import pipelines (Markdown, JSON, Notion, OKF) and OKF export, search indexing and the query log, and every AI hit. Judged against `src-tauri/src/mcp.rs`, `client_access/`, `runtime/client_tokens.rs`, `shared/policy/tools.v1.json`, `forge.rs`, `runtime/budget.rs`, M69 imports, `src/engine/{okf,skills}.ts`, the starter kit, and the M95–M99 docs.
> **Files read:** about 90 (Outline about 55, Cerebro about 25, program docs about 12).
> **Licence:** Outline is BSL 1.1. Ideas only, no code. No row is "adopt". Where a row cites an RFC, SEP-2640 or the OKF spec, the idea comes from that public spec, not from Outline's code.
> **Basis:** [read] I read the code or test · [docs] README, spec or plan text · [grep] a search that returned no hit (used for "absent" claims) · [names] inferred from names only.
> **Paths:** `O/` = `docs/examples/outline-main/`. Plans and specs = `docs/superpowers/{plans,specs}/`. Sibling dossier OUT1 (`outline-1-architecture.md`) already covers WebMCP (OUT1-22), commands behind every transport (OUT1-17) and the plugin registry (OUT1-18). This file goes deeper on my slice and does not repeat them.

## Top findings

1. **Outline has no in-app model.** No OpenAI, Anthropic, LLM, embedding or vector code exists anywhere in the tree [grep]. "AI answers" is a disabled Switch labelled "Requires a paid license" (`O/app/scenes/Settings/AI.tsx:144-153`). Its AI strategy is to be a good tool server for the user's own agent: MCP, Skills and WebMCP. This confirms Cerebro's no-API-key CLI bet: spend effort on tool quality, not on an in-app model. **Confirms M95 and M96.**
2. **The MCP server is stateless and rebuilt per request from the bearer's scopes.** One SDK handler serves both the legacy protocol (2025-03-26 initialize) and 2026-07-28 (header routing, `_meta`, `subscriptions/listen` completing at once), and tests pin both. Cerebro's `answer_value` and `listed_tools` already work per request and per grant. So the modern inbound adapter in M96.4 is a thin wire layer, not a session redesign. **Amends M96.4** (adapter shape and a test matrix).
3. **OKF works as an interchange format in a mature app**, but Outline's round trip loses data. Export writes a root `index.md` with `okf_version: "0.2"` plus per-document frontmatter. Import goes through the Markdown pipeline and keeps only `title`. Cerebro's `knowledge/` already is an OKF v0.2 bundle, yet Cerebro has no exporter or importer. M99 moves metadata into SQLite, so an OKF export profile is the cheap way to stay portable. **Amends M99.8; adds NEW:okf-interchange.**
4. **`get_document_changes` is the one Outline tool Cerebro lacks.** It returns a diff since `my_last_edit`, a time or a revision, with authors. Cerebro agents get a `stale_content` refusal but never see what the person changed. A `page_changes` tool can be built from `vault_writes`, `run_commits` and bounded git, with authors taken only from records (CV-34/35). **Adds NEW:agent-read-tools.**
5. **Skills over MCP (SEP-2640) and the find-and-cite recipe are cheap product.** Outline serves its skills whatever the token's scope. Cerebro's Skill records are already grant-checked (`holds`), so it could do this correctly. Now: ship an "Answer with sources" starter Skill and make it the subject of the M97.6 find/cite fixture. Later: serve Skills to token clients. **Amends M97.6; M96.4 watch.**
6. **Integration hygiene to copy, and one anti-pattern to refuse.**
   - Copy: the unfurl cache is keyed by team, user and URL, with a per-provider TTL set by how fast the data changes, negative caching and single-flight requests. Secrets carry a prefix and only their hash is stored. Token refresh checks, locks, then checks again.
   - Refuse: GitHub unfurl falls back to *any* installation when no installation matches the owner. That is exactly the `wrong_account_never_falls_back` case M96.5 must refuse.
   - **Confirms M96.2 and M96.5; amends M96.5/6.**
7. **Webhooks are server-shaped.** The design: a delivery log, auto-disable at ≥80% failures over 24 h with at least 10 deliveries (the owner gets an email), HMAC `t=,s=` signatures, no HTTP retry, and a privacy re-check at delivery time. M98 is right to refuse public webhooks. Take only three ideas: re-validate exclusions at dispatch, keep bounded effect evidence, and add a per-activation failure breaker. **Amends M98.4; confirms M98.8 and ACT-09.**

## Map

| Area | Path | What it does |
|---|---|---|
| MCP factory | `O/server/mcp/index.ts:24-104` | `createMcpServer(origin, scopes, guidance)`: builds a fresh server and registers each tool only if `canAccess(route, scopes)`. Adds the icons resource and the skills extension. |
| MCP route | `O/server/routes/mcp/index.ts:56-210` | Auth (MCP/OAuth/API), team toggle, `createMcpHandler(…, {responseMode:"json"})`, 401 with `WWW-Authenticate`, 405/404 probes. |
| MCP helpers | `O/server/mcp/util.ts` | `success`/`error` shapes, `optionalString` (`""` → undefined), scoped breadcrumbs, public share URLs, tracing. |
| Document tools | `O/server/mcp/tools/documents.ts` | list/search, collection tree, create (md/html), move, update (replace/append/prepend/patch), delete/archive, restore. |
| Fetch | `O/server/mcp/tools/fetch.ts` | One read tool for five resource types; accepts an ID or a URL. |
| Changes | `O/server/mcp/tools/revisions.ts` | `get_document_changes`: revisions with authors plus a unified diff. |
| Skills | `O/server/mcp/skills/index.ts`, `*/SKILL.md` | SEP-2640 `skills/list` and `skills/get`, plus `skill://` resources with digests. |
| MCP tests | `O/server/routes/mcp/index.test.ts`, `O/server/mcp/tools/*.test.ts` | Protocol, annotation, scope and skills matrix. |
| Scope grammar | `O/shared/helpers/AuthenticationHelper.ts` | `canAccess(path, scopes)` and `isValidScope`. |
| Discovery | `O/server/routes/discovery/mcp.ts` | RFC 8414 AS metadata and RFC 9728 protected-resource metadata. |
| OAuth AS | `O/server/routes/oauth/index.ts`, `O/server/utils/oauth/{OAuthHelper,ClientMetadataHelper,OAuthInterface}.ts` | authorize, token, revoke, DCR register/manage, CIMD. |
| OAuth janitors | `O/server/queues/tasks/CleanupDynamicOAuthClientsTask.ts`, `O/server/queues/processors/TeamUpdatedProcessor.ts` | Purge unused clients; revoke dynamic clients when MCP is turned off. |
| API keys | `O/server/models/ApiKey.ts` | Prefix, hash, last4, scope, expiry, throttled `lastActiveAt`. |
| WebMCP | `O/app/hooks/useWebMCPActions.ts`, `O/app/utils/ModelContext.ts`, `O/app/actions/definitions/webmcp.ts` | Command actions become browser-agent tools. |
| Webhooks | `O/plugins/webhooks/server/{processors/WebhookProcessor.ts,tasks/DeliverWebhookTask.ts,tasks/CleanupWebhookDeliveriesTask.ts}`, `O/server/models/WebhookSubscription.ts` | Subscribe, sign, deliver, log, auto-disable. |
| Providers | `O/server/utils/PluginManager.ts:35-70`, `O/plugins/*/server/index.ts` | Hooks: Unfurl, IssueProvider, Mention, Uninstall, SearchProvider. |
| Unfurl | `O/server/routes/api/urls/urls.ts:39-246`, `O/app/stores/UnfurlsStore.ts` | Server cache and provider chain; client stale-while-revalidate. |
| Issue sources and tokens | `O/server/queues/tasks/CacheIssueSourcesTask.ts`, `O/plugins/github/server/GitHubIssueProvider.ts`, `O/server/models/IntegrationAuthentication.ts:95-140` | Repo snapshot; refresh check-lock-check. |
| Import core | `O/server/models/{Import,ImportTask}.ts`, `O/server/queues/tasks/APIImportTask.ts`, `O/server/queues/processors/ImportsProcessor.ts` | Staged waves, then one-transaction persistence. |
| Markdown/OKF import | `O/server/queues/{tasks/MarkdownAPIImportTask.ts,tasks/OKFAPIImportTask.ts,processors/OKFImportsProcessor.ts}`, `O/server/converters/{BaseConverter,DocumentConverter}.ts` | Zip tree → docs; frontmatter title only. |
| OKF export | `O/server/models/helpers/OKFHelper.ts`, `O/server/queues/tasks/{ExportOKFZipTask,ExportDocumentTreeTask}.ts` | Bundle index plus per-doc frontmatter. |
| Notion | `O/plugins/notion/server/{tasks/NotionAPIImportTask.ts,notion.ts}` | API import, rate limiter, database flattening. |
| Search | `O/server/utils/BaseSearchProvider.ts`, `O/server/queues/processors/SearchIndexProcessor.ts`, `O/plugins/search-postgres/server/PostgresSearchProvider.ts`, `O/server/models/SearchQuery.ts`, `O/server/queues/tasks/UpdateDocumentsPopularityScoreTask.ts` | Provider seam, ranking, query log, popularity. |
| AI settings | `O/app/scenes/Settings/AI.tsx` | MCP toggle, endpoint copy, guidance text, disabled AI answers. |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
|---|---|---|---|---|---|---|---|
| OUT5-01 | No in-app model; the agent's tool server is the AI | No LLM SDK, embeddings or answer code in server, plugins, app or shared. AI settings hold only the MCP switch, the endpoint copy and guidance. AI answers is a paid placeholder. | No model keys or cost in the product; value is tool quality | `O/app/scenes/Settings/AI.tsx:59-153` [read]; openai/anthropic/llm/embedding/pgvector/gpt- [grep] | Same bet: the user's CLI, no API key (M96 Global Constraints) [docs] | already-have | M95, M96 (confirm) |
| OUT5-02 | Stateless per-request MCP server, scope-filtered, both protocols | See flow A. A fresh `McpServer` per POST. Tools exist only if the token's scopes reach their REST route. JSON replies, no SSE, no sessions. | Nothing to recover; the tool list equals what the token can call; 2026-07-28 support came cheap | `O/server/routes/mcp/index.ts:56-185`; `O/server/mcp/index.ts:24-104` [read] | Per-request, grant-filtered `listed_tools` (`src-tauri/src/mcp.rs:2758-2790`). Legacy only: `PROTOCOL_VERSION="2025-06-18"`, capabilities `tools` only (`mcp.rs:68,1678-1690`) [read] | adapt | M96.4 |
| OUT5-03 | Protocol and annotation-invariant test matrix | Tests cover:<br>• 401 with `WWW-Authenticate`; JWT refused; 404 when disabled; 405 for GET/DELETE; 404 for a sub-path and for `/sse`<br>• 2026-07-28 `tools/call` with `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `_meta` `io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}`<br>• `subscriptions/listen` returns `resultType:"complete"`; legacy initialize still works; `notifications/initialized` → 202<br>• every tool sets all four hints: readOnly ⇒ not destructive, `delete_`/`update_` ⇒ destructive, openWorld only on `create_document`<br>• more than 1000 argument elements → isError; skill digests match the bytes | Compatibility is pinned by tests, not by a version constant | `O/server/routes/mcp/index.test.ts:23-292,357-460,463-600,622-631` [read] | Hints are derived from the manifest kind, so they hold by construction (`mcp.rs:2377-2400`). M96.1 plans `broker_only_reviewed_rows_are_open_world`; M96.4 plans `mcp-action-cases.json` [read/docs] | adapt (write the cases fresh) | M96.1, M96.4 |
| OUT5-04 | One scope grammar for REST and MCP, with a create-only tier | Grammar: `*`, `read|write|create`, `ns:verb`, `/api/ns.method`. Method → scope: list/info/search/export/get → read, create → create, anything else → write. A tool registers only if `canAccess("<ns>.<method>")`. OAuth clients cannot ask for root wildcards. The consent screen shows scopes as words. | A capture key can create without reading; one grammar covers every transport | `O/shared/helpers/AuthenticationHelper.ts`; `O/server/utils/oauth/OAuthInterface.ts:376-390`; `O/app/scenes/Login/OAuthScopeHelper.ts` [read] | Toolsets plus folder scopes from the manifest (`clients:{default:read, grantable:[write,comment]}`, `shared/policy/tools.v1.json:166`). A token always reads; read scope is 1–20 folders (`runtime/client_tokens.rs:157`) [read] | adapt: a `capture` toolset of additive note-door rows (manifest `kind`, CV-04), read and write scoped to one folder | NEW:client-tokens (M96.4 inbound) |
| OUT5-05 | OAuth for MCP clients (RFC 9728/8414/7591/7592 and CIMD) | Metadata documents and a 401 challenge. DCR is rate limited to 5/h and its registration token rotates on PUT. CIMD treats an `https` client_id as a metadata URL: fetched in ≤5 s, ≤5 KiB, no redirects, cached 5 min–1 day by `Cache-Control`; its own hosts are refused and private JWKs rejected. PKCE S256 is required for CIMD. Loopback redirects match any port. `/authorize` accepts only a session. Refresh tokens always rotate. Unused clients are purged (48 h never used, 30 d idle), and turning MCP off revokes them. Consent tolerates Claude's bogus `scope=claudeai`. | Spec-following clients connect with no setup; abuse stays bounded | `O/server/routes/oauth/index.ts:47-350`; `O/server/routes/discovery/mcp.ts`; `O/server/utils/oauth/OAuthHelper.ts:64-150`; `ClientMetadataHelper.ts:85-160,276-400`; `O/server/queues/tasks/CleanupDynamicOAuthClientsTask.ts`; `O/server/queues/processors/TeamUpdatedProcessor.ts`; `O/app/scenes/Login/OAuthAuthorize.tsx:58-72` [read] | Paste a token; loopback only; off by default (CV-49) [read] | watch: needs a loopback AS plus in-app consent; only worth it for a client that cannot send a static bearer | NEW:client-oauth (gate like M96.7) |
| OUT5-06 | Credential hygiene | Secret prefixes `ol_api_`, `ol_at_`, `ol_rt_`, `ol_whs_`. Hash stored; the plaintext column is deprecated. `last4` for display. Optional `expiresAt`. `lastActiveAt` written at most every 5 min. Integration tokens use `@Encrypted`. | Leaks are scannable, keys revocable, display safe | `O/server/models/ApiKey.ts:41-167`; `O/server/models/oauth/OAuthAuthentication.ts:37-47,117-130`; `O/server/models/IntegrationAuthentication.ts:45-60` [read] | `cbr_` prefix, SHA-256 only, `Debug` prints `cbr_…last4`, `last_used_at`, a cap of 20, revoke (`client_tokens.rs:15,73,219-223,376`). No expiry [grep] | already-have (adapt: optional expiry) | NEW:client-tokens |
| OUT5-07 | Skills served over MCP (SEP-2640) | Each skill directory becomes `skill://outline/<name>/<file>` resources with a sha256 digest and size. `skills/list` and `skills/get` return `ttlMs` 1 h and `cacheScope:"public"`. Frontmatter is validated at load (name must equal the directory). Not filtered by token scope: a read-only token still gets `capture-conversation`, which needs `create_document`. | Agents receive task recipes from the server; digests make caching safe | `O/server/mcp/skills/index.ts:24-221` [read] | Skill records with `allowed-tools`, `arguments` and `connectors`; the catalog is name and description; the body is read when used; grant-checked via `holds` (`src/engine/skills.ts:1-22`). Server answers only tools (`mcp.rs:1655-1672`) [read] | watch: if served, list only Skills whose `allowed-tools` fit the token's tools, read through the scope guard | M96.4, M96.7 |
| OUT5-08 | The find-and-cite recipe | Every term must match; `or` for alternatives; quotes for a phrase. Pick by the `context` snippet, then fetch the best hits. Answer, then give the exact quote and one link per claim, plus the breadcrumb. When sources disagree, show each `updatedAt`. Archived means historical. If nothing is found, say so and offer to write a page after the user confirms. | 30 lines of prose set the citation discipline | `O/server/mcp/skills/find-and-cite/SKILL.md` [read] | M97 owns the contract (SourceLocator, evidence roles, the abstain and counterevidence scenarios; m97 design `:38-100,286-300`). No starter Skill does this: the kit has catch-me-up, draft-reply, what-i-did (`shared/starter/vault/records/skills/`) [read] | adapt: an "Answer with sources" starter Skill (`search_notes`, `get_note`, `knowledge_about`) as the M97.6 find/cite subject | M97.6 (starter kit, M64.8 lineage) |
| OUT5-09 | Changes since my last edit | See flow C. | The agent merges a person's edits before rewriting; diff lines double as patch targets | `O/server/mcp/tools/revisions.ts:26-320` [read] | `expect_hash` refusal (CV-23) and `read_activity` rows. No content-diff tool [grep `tools.v1.json`]. Authorship is recorded in `vault_writes` and `run_commits` (`runtime/schema.rs`) [read] | adapt | NEW:agent-read-tools (consumers M95, Agent Memory) |
| OUT5-10 | Lean two-block results | `fetch` returns [JSON metadata, raw markdown], so the body is never JSON-escaped. Lists carry metadata only, plus `context`, a `breadcrumb` (only when the reader can read the collection) and a `shareUrl` (only when public and unrevoked). An empty list returns a `[]` block. offset/limit ≤100. Large enums (icons) live in a resource, not the schema. A no-op update returns isError, never a false success. | Few tokens, no leaks through breadcrumbs, no fake success | `O/server/mcp/util.ts:62-111,254-286`; `O/server/mcp/tools/fetch.ts:120-160`; `documents.ts:72-320,733-748` [read] | Plain-text answers with header lines, "how many more" and scope counts; no offset or cursor (`tools.v1.json` search_notes/list_notes/query_records) [read] | already-have (watch: paging for token clients) | M96.4 |
| OUT5-11 | Workspace guidance in the MCP instructions | Admin text (≤10,000 chars, warning at 2,000) is appended to fixed instructions that name tools ("Use the list_users tool") — tools a scoped token may not have | One place to teach outside agents the layout | `O/server/routes/mcp/index.ts:56-66`; `O/server/mcp/index.ts:105-119`; `O/shared/validations.ts:183-186` [read] | Fixed instructions ≤2048 chars that name no tool (CV-19). The vault's `CLAUDE.md` is excluded via `--setting-sources user` (`src-tauri/src/agent/mod.rs:1966-1972`). Layout comes from `get_vault_context` [read] | avoid (names tools, ignores scope); watch owner-authored guidance kept in app config | M96.4 |
| OUT5-12 | WebMCP | Command-bar actions also register as `document.modelContext` tools while mounted (`useCommandBarActions` → `useWebMCPActions`). `dangerous` and invisible actions are skipped. Tools unregister on navigation (AbortController); errors go back to the agent. Root tools: `get_current_context`, `search_workspace`. | No extra tool code | `O/app/hooks/useWebMCPActions.ts:30-147`; `O/app/hooks/useCommandBarActions.ts:16-36`; `O/app/actions/definitions/webmcp.ts` [read] | The agent surface is the manifest through Rust doors. A structured context snapshot carries visible records and filters (`src/agent/context.ts`, M9.5) [read] | avoid (= OUT1-22); context is already-have | none |
| OUT5-13 | Unfurl provider chain | See flow D. | The cache is permission-safe, the TTL follows how fast data changes, negatives are cheap | `O/server/routes/api/urls/urls.ts:39-246`; `O/app/stores/UnfurlsStore.ts`; `O/plugins/{github,gitlab,linear,figma,iframely}/server/index.ts` [read] | One provider: the `forge.rs` PR reader, success 60 s / failure 10 s, 64 entries / 16 MiB (`src-tauri/src/forge.rs:20-25`) [read] | adapt | M96.5, M96.6 |
| OUT5-14 | Choosing the account for a read | GitHub unfurl orders installations by owner match, then uses *any* installation | Convenient | `O/plugins/github/server/github.ts:343-376` [read] | M96.5 requires `wrong_account_never_falls_back` [docs] | avoid | M96.5 (confirm) |
| OUT5-15 | Account-scoped source snapshot and refresh | Creating an integration queues `CacheIssueSourcesTask` (jobId dedupe), which writes the reachable repos to `issueSources` under a row lock. Provider webhooks for added, removed or renamed repos and new permissions refresh both the sources and the stored scopes. Token refresh is check → lock → check, with a 5 min threshold. | Pickers skip live calls; scope drift gets recorded | `O/server/queues/tasks/CacheIssueSourcesTask.ts`; `O/plugins/github/server/GitHubIssueProvider.ts:29-150`; `O/server/models/IntegrationAuthentication.ts:102-140` [read]; nothing outside the providers reads `issueSources` [grep] | M96.4 `CapabilitySnapshot` (catalog digest; discovered, authenticated, granted and callable kept separate); M96.2 refresh CAS. Tables `managed_connections` and `action_*` exist (`runtime/schema.rs`) [read/docs] | already-have (planned): refresh only on Connect/Check, since there are no inbound webhooks | M96.2, M96.4 (confirm) |
| OUT5-16 | Webhook delivery log and breaker | See flow E. | Delivery evidence is inspectable; dead endpoints switch themselves off and tell the owner | `O/plugins/webhooks/server/tasks/DeliverWebhookTask.ts:142-989`; `O/server/models/WebhookSubscription.ts:68-251` [read] | No outbound webhooks. M98 refuses a public listener ("External input is local authenticated IPC", m98 design `:22,239`). A lane-level `ConsecutiveFailures` gate defers background runs (`runtime/budget.rs:471-521,795-800`) [read] | avoid (the feature); adapt (per-activation breaker, bounded evidence, re-check at dispatch) | M98.4, M98.8, ACT-09 |
| OUT5-17 | Staged import, then one-transaction persist | `Import` states: created → in_progress → processed → completed/errored/canceled, with one import in flight per team (advisory lock). `ImportTask` rows hold 3 pages; children form the next wave, so parents come first. A 4xx is treated as deterministic and not retried. Cancel is checked per task. At `processed`, one transaction creates everything via an externalId → id map, rewrites mentions, links and attachments, and keeps source urlIds when they are free. Deleting the import destroys its collections. | A fetch failure never leaves half a tree; one action undoes it | `O/server/models/{Import.ts:100-133,ImportTask.ts}`; `O/server/queues/tasks/APIImportTask.ts:47-140`; `O/server/queues/processors/ImportsProcessor.ts:63-330,598-870` [read] | M69: an identity planner from stamps, a batch journal, one undoable change, an explicit outcome per request, imports serialized before path locks (`shared/import/sources.v1.json`; AGENTS.md) [read] | already-have | none (confirm) |
| OUT5-18 | Notion workspace import | Uses the Notion API through OAuth, with an `async-sema` rate limiter and `Retry-After`. A database becomes an empty page with its rows as children (properties are lost). Pages that are not found, unauthorized or linked databases are skipped with only a log line. | Broad coverage, silent loss | `O/plugins/notion/server/tasks/NotionAPIImportTask.ts:22-205`; `O/plugins/notion/server/notion.ts:61-140` [read] | Per-page import from the person's connector capture (CV-60). "Notion databases are not imported" (`tools.v1.json` `import_notion_page`) [read] | avoid (flattening, silent skips); watch database → Type doc plus records | NEW:import-notion-db |
| OUT5-19 | OKF bundle export and import | See flow B. | Interchange is proven in a mature app | `O/server/models/helpers/OKFHelper.ts`; `O/server/queues/tasks/ExportDocumentTreeTask.ts:200-470`; `O/server/converters/DocumentConverter.ts:60-93` [read] | `knowledge/` is OKF v0.2 (`src/engine/okf.ts:6-29`). Lifecycle "translates to `status` on OKF export" (`okf.ts:345`), but there is no exporter or importer [grep] | adapt | M99.8, NEW:okf-interchange |
| OUT5-20 | Search seam plus query log | `BaseSearchProvider` (index/remove/updateMetadata); the index processor queues only for providers other than Postgres. Postgres ranks by `ts_rank × (1 + 0.25·ln(1+popularity))`, and an unquoted query with no hit is retried quoted. Popularity is decayed weighted activity (revision 1.0, comment 1.2, reaction 0.8, view 0.5). MCP search tries an exact-ID lookup first. `SearchQuery.record` logs per source (app, api, slack, oauth, mcp): first page only, collapsing a growing prefix within a recency window, with results, duration and score; kept 365 days. | Real miss data per surface; a cheap ranking signal | `O/server/utils/BaseSearchProvider.ts:55-140`; `O/server/queues/processors/SearchIndexProcessor.ts:21-46`; `O/plugins/search-postgres/server/PostgresSearchProvider.ts:464-720`; `O/server/queues/tasks/UpdateDocumentsPopularityScoreTask.ts:20-40`; `O/server/models/SearchQuery.ts:23-150`; `documents.ts:140-198` [read] | `corpus.rs` is a stat-keyed cache, "never an index"; whole-word, no stemming, phrases first. No query-log table (`runtime/schema.rs`) [grep] | adapt (a local bounded log to nominate miss classes); watch (activity boost, only after a measured miss) | M97.7, M97.8 |
| OUT5-21 | One switch closes the whole surface | MCP off: `/mcp` and the protected-resource metadata return 404, DCR and the CIMD fetch are refused, and dynamic clients are revoked. Rate limits are keyed on IP plus credential. | No half-open surface | `O/server/routes/discovery/mcp.ts:9-65`; `O/server/routes/oauth/index.ts:236`; `ClientMetadataHelper.ts:125-129`; `TeamUpdatedProcessor.ts`; `O/server/middlewares/rateLimiter.ts` [read] | The client port is off by default; disabling stops the listener; tokens persist (`client_access/listener.rs:851-880`) [read] | already-have | none |
| OUT5-22 | Agent lifecycle tools | `move_document` (with sibling index), `delete_document` (to trash, or `archive`, with a `reason`), `restore_document` | Agents can tidy, not only write | `O/server/mcp/tools/documents.ts:515-933` [read] | No agent tool moves, renames or trashes a page; only `propose_organize`, for Inbox captures (`tools.v1.json`). Renames go through `renameActions` (CV-41), deletes through Trash (CV-37) [read] | watch: only as person-approved proposals through the existing writers | NEW:agent-lifecycle-tools (owner) |

### Flow A: stateless MCP per request (OUT5-02/03)

```
POST /mcp                          O/server/routes/mcp/index.ts:121-185
  rateLimiter(1000/h; ids = [ip, credential] for API/OAuth tokens)
  auth({type: [MCP, OAUTH, API]})  → {user, token, scope[]}; JWT session refused
  team MCP preference off → 404
  mcpHandler = createMcpHandler(createServer, {responseMode: "json"})   // no SSE, no session
  createServer({authInfo}) → createMcpServer(origin, scope, team.guidanceMCP)
    tool files: if AuthenticationHelper.canAccess("documents.update", scopes) registerTool(...)
    capabilities {tools:{listChanged:false}, resources:{listChanged:false,subscribe:false}, extensions:{skills}}
    maxToolInputElements: 1000
  401 → WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="read write"
```

Cerebro mapping:
- `answer_value(app, grant, request)` (`mcp.rs:1701`) plays the role of `createServer`.
- `listed_tools(grant, …)` (`mcp.rs:2776`) plays the role of scope-gated registration.

M96.4's modern adapter adds:
- routing on `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`;
- reading the `_meta` keys;
- answering `subscriptions/listen` with `resultType:"complete"` at once.

It keeps legacy `initialize`. No session store is needed. Run identity stays Cerebro's own (protocol review).

### Flow B: OKF round trip (OUT5-19)

**Export** (`ExportOKFZipTask` → `ExportDocumentTreeTask`):
- A title becomes `Title.md`. If that collides or is reserved (`index.md`, `log.md`), it becomes `Title (n).md` (`:435-470`).
- Internal links are rewritten to relative paths, *then* frontmatter is prepended (`:218-222`).
- The frontmatter (`OKFHelper.ts:60-77`) is `{type:"Document", title, description: one-line summary, resource: <origin><path>, status: draft|stable|deprecated, generated:{by:"human:<email|id>", at: updatedAt}}`.
- The root `index.md` is `okf_version: "0.2"` plus `* [Name](root/) - description` (`:87-95`).

**Import** (`OKFImportsProcessor` → Markdown pipeline):
- The frontmatter `title` beats the H1 (`DocumentConverter.ts:60-93`). Every other key is stripped (`BaseConverter.stripFrontmatter`).
- The import path does nothing special with reserved names [grep]. So the bundle's `index.md` would become an ordinary page [read, not run].

**Cerebro mapping:** concept frontmatter already carries `generated`, `verified`, `sources`, `lifecycle`, `stale_after` and relations (`okf.ts`).
- Export profile, next to M99.8 `export_legacy`:
  - write `knowledge/index.md` with `okf_version`;
  - map `lifecycle` to `status`;
  - keep `verified` and `sources` as they are;
  - spell actors without email;
  - report dropped keys in `losses`.
- Import:
  - land foreign bundles as M69-stamped imported pages (CV-22/58, a new `systems` row in `sources.v1.json`);
  - a foreign `verified`/`generated: human:` never becomes Cerebro review state.

### Flow C: `get_document_changes` (OUT5-09)

```
in:  {id, from: revisionId | ISO date/time | "my_last_edit", to?: revisionId}
authorize(listRevisions) (+restore if trashed)
start: my_last_edit → current doc if the actor made the last edit, else Revision.findLatestByUser
       uuid → Revision; time → Revision.findAt, or the current doc if time ≥ updatedAt
end:   to?.createdAt ?? document.updatedAt      // bound to the loaded doc
out[0] JSON {document, from, to{current, updatedAt, unsavedEditsBy?}, title{before,after}?,
       revisions[≤25]{id,name,createdAt,author,collaborators}, revisionCount, hasChanges, truncated?, tooLarge?}
out[1] unified markdown diff ≤50,000 chars (verbatim lines → reusable as patch findText)
```

Cerebro build of `page_changes {path, since: "my_last_write" | RFC 3339 | commit}`:
- Resolve `since` from this actor's `vault_writes` rows or `run_commits`.
- Diff with bounded git (as `git/conversation.rs` already does for M92.12).
- Name authors only from recorded rows; otherwise say "unattributed" (CV-35).
- Scope by `grant.may_read`.
- When the page has pending editor saves, say so (M93 save owners).
- Diff lines verbatim, so they fit `edit_note.old`.

### Flow D: unfurl (OUT5-13/14)

1. A share URL of this install: public preview, no auth.
2. `mention:`: `authorize(read user)` plus `authorize(read document)`.
3. An internal doc: `can(read)`, otherwise 204.
4. External:
   - `CacheHelper.getDataOrSet(key(teamId, userId, url))`, a single-flight lock.
   - Providers run in priority order; the first non-undefined result wins.
   - `{error}` is cached for `cacheExpiry ?? 60 s`. Success is cached for the provider's `cacheExpiry`: GitHub, GitLab and Linear 60 s; Figma 600 s; Iframely 1 day (lowest priority, a catch-all).
   - Nothing → 204.

The client (`UnfurlsStore`):
- allows http/https/mention only;
- returns the cached copy and refetches if it is older than 5 min;
- remembers empty results for 5 min;
- dedupes in-flight requests.

**Cerebro:** link cards call M96.5's `github.issue.read` through ActionService under the selected binding. TTL and negative-TTL live in provider rows (data, CV-04). The cache is keyed by (vault, account binding, canonical URL). No fallback account, and no third-party catch-all unfurler.

### Flow E: webhook delivery (OUT5-16, reference only)

```
WebhookProcessor.shouldQueue: cached [{id, events}] per team (Redis 1 h, invalidated afterCommit)
  → matchEvent: exact or "<prefix>." ; perform: skip if the event is in a personal collection
DeliverWebhookTask.perform: reload subscription (skip if disabled); re-check personal collection
sendWebhook: WebhookDelivery{pending} → body {id:deliveryId, actorId, webhookSubscriptionId, createdAt, event, payload:{id, model}}
  header Outline-Signature: t=<ms>,s=hex(HMAC-SHA256(secret, "<t>.<json>"))
  fetch POST, redirect:"error", timeout 5 s → update {status, statusCode, req/resp headers, responseBody ≤1 KiB}
failed → window 86,400 s: failed/total ≥ 80% and total ≥ 10 → enabled=false + email to creator
no HTTP retry: sendWebhook catches; BaseTask's 5× exponential applies only if perform throws
CleanupWebhookDeliveriesTask: delete rows > 7 days; max 10 subscriptions/team under an advisory lock
```

## Avoid / doesn't transfer

- **Outbound webhooks to arbitrary URLs.** This is network egress from a local vault, and Cerebro has no server to sign or relay. If it is ever chosen, it is an ACT effect class with an owner decision (M98.8), not a feature toggle.
- **WebMCP** (OUT1-22). Page-scoped tools bypass doors, receipts and ask-first; the browser API is behind a flag.
- **Instructions and skills that name tools regardless of scope** (OUT5-07, OUT5-11). CV-19 already forbids this.
- **Implicit account fallback** (OUT5-14) and **Iframely-style catch-all unfurl.** The latter sends every pasted URL to a third party, against the spirit of CV-61.
- **`update_document` patch replaces the first occurrence without a CAS.** Cerebro's `edit_note` (refuses on ambiguity, `occurrence`, all-or-nothing, `expect_hash`) is stronger; keep it. The same applies to Outline's comment anchors, which default to the first occurrence.
- **Notion database flattening and silent skips** (OUT5-18). They violate "every request gets an explicit outcome" (M69).
- **OKF export details.** It writes the last editor's email into `generated.by`, and import keeps only `title`. Do not copy either loss (OUT5-19).
- **Popularity-weighted ranking now.** It needs view and reaction telemetry. A single-user vault gives a weak signal. Only after an M97.8 measured miss.
- **Server-only plugins**: Slack `/outline`, the Zapier settings (`deployments: ["cloud"]`), and AI answers (closed code; nothing to read).

## Implications for M93–M99

- **M93, M94:** no change from this slice.
- **M95:**
  - *Confirm* M95.4: Save/Append go through existing writers. Outline's capture-conversation shows the same need.
  - *Amend* M95.4: before creating a page, the Save target picker should offer the best `search_notes` match as an Append target. This is Outline's "update instead of duplicate" step.
  - *Add* a consumer of NEW:agent-read-tools: supervised jobs read `page_changes` before rewriting a page the person edited.
- **M96:**
  - *Amend* M96.4: build the inbound modern adapter as a per-request answer over `answer_value`/`listed_tools`. Route on headers, read `_meta`, complete `subscriptions/listen` at once, keep legacy initialize. Add the OUT5-03 matrix to `mcp-action-cases.json`.
  - *Confirm* M96.1: open-world applies only to reviewed broker rows (the same invariant as Outline's test).
  - *Confirm* M96.2: refresh uses CAS (Outline checks, locks, then checks again).
  - *Confirm* M96.5: no account fallback (OUT5-14 is the counterexample).
  - *Amend* M96.5/M96.6: link cards for issue URLs use the read action under the selected binding, with TTL values as data.
  - *Add* NEW:client-tokens: a `capture` toolset, optional expiry, and toolset consent words in the token dialog.
  - *Watch* NEW:client-oauth and the skills extension (M96.7-style gate).
- **M97:**
  - *Amend* M97.6: an "Answer with sources" starter Skill is the subject of the find/cite, counterevidence and abstain scenarios.
  - *Amend* M97.7: a local, bounded search log nominates miss classes. It records source (panel, agent, token), query, hits, cap hit, duration and run id, for the first page only, collapsing a growing prefix. It is never a quality score.
  - *Confirm* KNOW-02: ambiguity is refused, never resolved to the first occurrence.
- **M98:**
  - *Confirm* the no-public-webhook decision (design `:22,239`).
  - *Amend* M98.4: add a per-activation breaker. Pause automatic starts when the failure rate over a window passes a threshold with a minimum sample. Show the reason in `GateReason`-style words. Thresholds are the owner's.
  - *Confirm* M98.8 and ACT-09: re-check mail and knowledge exclusions at dispatch, and keep bounded delivery evidence.
- **M99:**
  - *Amend* M99.8: add an OKF v0.2 export profile (flow B) next to `export_legacy`, with losses listed.
- **Add NEW phases:**
  - NEW:agent-read-tools (`page_changes`, flow C);
  - NEW:okf-interchange (import side);
  - NEW:import-notion-db (watch);
  - NEW:agent-lifecycle-tools (owner).

## Owner questions

1. **OKF import:** should foreign bundles land only as imported pages, or may they seed `knowledge/` as unverified concepts (foreign `verified` dropped)?
2. **Skills for other apps:** should product Skills be served to token clients over MCP (grant-filtered), or stay Cerebro-only?
3. **Client access:** do you want capture-only tokens (create/append in one folder) and optional expiry? Is OAuth (DCR/CIMD) needed for a specific client that cannot send a bearer header?
4. **Agent tidy-up:** may agents *propose* page moves, renames or Trash, with your approval, as Outline lets agents do directly? Or does this stay human-only?
5. **Search log:** may Cerebro keep a local search log for retrieval evaluation, and for how long?
