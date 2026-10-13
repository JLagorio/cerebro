# Macro reference — Search: indexing, extraction, unified query, name search and frecency

**Scope**: Macro's search stack, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored). Every
Macro path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: root `LICENSE.txt` is AGPL-3.0 and covers every owned unit except `crates/opensearch_query_builder` (MIT,
"Copyright (c) 2025 William Hutchinson"). `infra/stacks/opensearch/helpers/package.json` says ISC; that is likely
npm-init boilerplate, so treat it as AGPL. `apps/web/LICENSE` reads "Copyright 2023 CoParse, Inc. All rights reserved."
Vendored `pdfium-lib/*/libpdfium.{so,dylib}` ship with no licence file (upstream PDFium is BSD-3). Cerebro is
Apache-2.0. **Design input only; copy no code.** Upstream deps may be adopted: pdfjs-dist (Apache-2.0, upstream, not
Macro's fork), pdfium-render 0.8.37 (MIT/Apache-2.0), tiktoken-rs 0.5.9, zip 2.4.2, quick-xml 0.41.0, fflate 0.8.3,
@leeoniya/ufuzzy 1.0.19 (all MIT).
**Evidence**: stages 1–2 read the code; stage 3 re-read both trees. Nothing was executed (no cargo, vitest, e2e or
pdf.js spike), and the owner's vault was not measured. Stage 3 overrides stages 1–2.

---

## 1. What it is

- OpenSearch 3.5 behind 8 aliases (`dynamic:false`). It is fed by `services/search_processing_service` (Kafka, legacy
  SQS, HTTP backfills) and queried through `crates/search_service`, which is mounted in document_storage_service at
  `/search` and `/internal/search`.
- Ingest treats each event as a hint: it rereads Postgres/S3/the lexical service, then fully overwrites the doc. Docs,
  chats, calls and agent sessions are parent/child (chunk-level hits); the other aliases are flat.
- ⌘K and the @mention pickers never call the search service. They rank a client cache (`crates/client/cache-core`).
  Server frecency (`crates/frecency`) feeds only soup's Frecency sort. There is **no semantic search**.

## 2. What users get

| Feature | UX details | Paths |
| --- | --- | --- |
| Unified search view | One query across docs/tasks/skills, emails, channel msgs, AI chats, calls, agent sessions, projects, calendar, and opt-in CRM. Type chip, Tags chip (Any/All), @person narrows, quotes force exact. Preview with `l`/`h`; `/` opens. Local fuzzy results after 20ms (top 3 non-channel + all channels "featured"); service results after 300ms, deduped by id with featured first. Server needs ≥3 **bytes** (`query.len()`). Page 10 by default, max 100. Ordered **newest-first**, not by relevance. | `apps/docs/product/search.mdx`, `apps/web/src/features/soup/search/create-search-state.ts`, `apps/web/src/lib/queries/soup/search.ts`, `crates/search_service/src/api/search/simple/simple_unified.rs`, `crates/search_service/src/api/search/unified.rs` |
| Modes name / content / name_content | Most surfaces send name_content; property pickers and channel lists send name; the channel find-bar sends content. Name mode = docs, agent sessions, email subjects, projects, calls, calendar, plus Postgres chat names. Content mode drops projects and calendar. A name match is its own parent hit (`goto=None`). | `crates/models_search/src/lib.rs`, `crates/opensearch_client/src/search/unified.rs`, `apps/web/src/features/home/queries/home-search.ts`, `apps/web/src/features/channel/Channel/create-channel-find-bar.ts` |
| Jump-to-match + snippets | Each hit carries a `goto`: Lexical node id, PDF/DOCX page, call segment (speaker, seq, times), email message, channel msg + thread, chat msg + role, or agent turn. Matches are wrapped in `<macro_em>`. Fragments: invisible chars stripped, whitespace collapsed, spans split at `@` merged, window starts ~200 visible chars before the first match, capped at 1000 with tag-aware `...`. **Every** query term is highlighted in a returned chunk. | `crates/models_search/src/simple.rs`, `crates/opensearch_client/src/search/model.rs`, `crates/opensearch_client/src/search/documents.rs` |
| File content | PDF/DOCX per page (DOCX via a **converted PDF**), Markdown per top-level block, code/text as one chunk capped at 100k chars, Figma/PSD/AI via Macro's own engines. Canvas, archives, media and unreadable designs are name-only (PSD pixel budget 256MB, no retry). Email bodies are indexed; attachments are not. | `services/search_processing_service/src/process/document/raw_document.rs`, `.../parsers/{pdf,psd,fig,ai}.rs`, `crates/opensearch_client/src/upsert/document.rs` |
| Filters | Tag option ids (any/all), property def+values, owners, project subtree, file types incl. `assoc:*`, email sender/cc/bcc/labels/importance/inbox, channel thread/mentions/senders, calendar status/organizer/attendees. An active tag filter silently drops channels, CRM and agent sessions. A type is excluded by putting a NIL UUID in its id filter. | `crates/search_service/src/api/search/simple/filter.rs`, `crates/opensearch_client/src/search/properties.rs`, `crates/models_search/src/unified.rs` |
| ⌘K + @mention pickers | Instant name lookup over cached entities. cache-core: `0.7·fuzzy + 0.3·exp(-0.5·age/30d)` on viewedAt, 30-day cliff, DM ×1.8, bounded top-k heap; empty query = recency browse. Fuzzy per token: word-start substring 1.0, mid-word 0.9, scattered subsequence `clamp(len/span,0.1,0.8)`. The TS command menu **re-ranks** through uFuzzy (fuzzyWeight 0.7, timeWeight 0.7 → 0.5/0.5) and patches the two rankers' disagreements. User pickers add +50% same-domain and a brevity weight. "Search for <q>" hands off to full search; "Ask AI" row. | `crates/client/cache-core/src/search.rs`, `.../search/ranking.rs`, `apps/web/src/features/command/rank-command-search-items.ts`, `apps/web/src/lib/core/util/freshSort.ts`, `apps/web/src/features/command/useCommandItems.ts`, `.../MentionsMenu/hooks/useEntityMention.ts` |
| Launcher / command recency | Launcher stores `{count,lastUsedAt}` (`launcher-frecency-v1`) but **sorts by lastUsedAt only**. Commands remember last-used (`command-recency-v1`). | `apps/web/src/features/command/Launcher.tsx`, `.../command/core/launcher-history.ts`, `.../command/recency.ts` |
| Frecency sort | Per-user frecency of opened entities drives soup's Frecency sort and filters. Open +2, Ping 0, Close −1. | `crates/frecency/src/domain/models.rs`, `crates/soup/src/domain/service.rs`, `services/connection_gateway/src/service/tracker.rs` |
| Agent tools | ContentSearch / NameSearch: matchType partial\|exact, entityTypes, inbox, tags/tagsMatch. Descriptions: keyword not semantic, 1–3 literal words, separate person + topic searches, ListEntities for "what happened today". Page 50, own chat excluded, email importance filter forced on, hits annotated with tags, regexp/query modes hidden. SearchSkills reuses the same endpoint. | `crates/ai_tools/src/search/search_service/{content,name,types,context}.rs`, `apps/docs/AI/mcp/tools/{content-search,name-search}.mdx`, `crates/skills/src/outbound/search_service_searcher.rs` |
| Channel search | Find-in-channel (content, optional thread-grouped sort). Name search: word-start regex over channels the user is in, batches of 256; unnamed DMs match participant names. | `crates/search_service/src/api/search/channel.rs`, `crates/name_search/src/channel.rs` |
| PDF citation text | Text with inline `[[uuid]]` part markers plus a page-% rect per part (1-based page), token count via tiktoken o200k. Encrypted PDFs skipped. | `services/document_text_extractor/src/handler/extract_text_citations.rs`, `.../service/db/document_text_parts.rs`, `crates/macro_db_client/src/dcs/get_part_by_id.rs` |
| Zip folder upload | Browser zips the folder; a Lambda unzips it into a project tree. Skips `.*`, `__MACOSX`, `~$`, Thumbs.db, ehthumbs.db, desktop.ini, `Icon\r`. Keeps empty folders, per-file sha256, Pending/Completed/Failed/PartiallyCompleted. | `services/upload_extractor_lambda_handler/src/main.rs`, `services/upload_extractor_lambda_trigger/src/main.rs` |

## 3. How it's built

### Overview

- **Write**: producers publish to Kafka. `search_processing_service` (consumer group `search-processing-service`)
  rereads the source of truth and full-overwrites OpenSearch. Legacy SQS workers, HTTP backfills and
  S3→EventBridge→Lambda relays call the same `process/` functions.
- **Read**: `search_service` resolves Postgres permission allowlists (owner OR id ∈ allowlist), then runs one
  multi-index bool/should with a **named clause per entity type**, in parallel with Postgres chat-name and CRM searches.
  It merges by recency under one composite base64 cursor and enriches from Postgres.
- Query details: one `has_child` per term (AND across chunks); inner_hits give one hit per chunk with `goto`; plain
  highlighter; script sort on `sent_at`/`updated_at` desc, then `entity_id` asc; `size = page_size+1` + `search_after`.
- Agents: `ai_tools` → `search_service_client` → `/internal/search`.
- Client: ⌘K ranking runs in `cache-core` (Rust; native in Tauri, WASM on web).
- Frecency: connection_gateway ingests websocket events; soup reads the aggregates.
- Backlinks sit in Postgres `comms_entity_mentions`, outside search. `crates/embedding` serves only `task_dedup`.

### Components

| unit | path | role | LOC |
| --- | --- | --- | --- |
| search_service | `crates/search_service` | Orchestration + HTTP API (unified, simple, channel, channel/name) | 4240 |
| search_service_client | `crates/search_service_client` | reqwest client for `/internal/search` | 110 |
| opensearch_client | `crates/opensearch_client` | Upsert/delete/query, hit expansion, highlight normalization, paging | 8316 |
| opensearch_query_builder | `crates/opensearch_query_builder` | Typed OS DSL builder (MIT) | 3550 |
| models_opensearch | `crates/models_opensearch` | Alias enums; `query_name` ↔ `from_matched_queries` | 237 |
| models_search | `crates/models_search` | API DTOs, filter conversion | 1948 |
| models_search_cursor | `crates/models_search_cursor` | Keyset + composite cursors | 241 |
| name_search | `crates/name_search` | Postgres chat/channel name search + highlight | 551 |
| frecency | `crates/frecency` | Scoring, 60s advisory-locked aggregator, Postgres storage | 2287 |
| search_processing_service | `services/search_processing_service` | Indexer: consumers, backfills, extraction, chunking | 7824 |
| search_upload_handler | `services/search_upload_handler` | S3 upload → DSS relay Lambda | 107 |
| document_text_extractor | `services/document_text_extractor` | PDF citation extraction Lambda | 695 |
| upload_extractor_lambda_handler / _trigger | `services/upload_extractor_lambda_{handler,trigger}` | Zip → project tree; status + enqueue | 1113 / 126 |
| opensearch infra | `infra/stacks/opensearch` | Pulumi domain, index bodies, plan/dry-run scripts | ~4500 |
| search stacks | `infra/stacks/{search-event-queue,search-processing-service,search-text-extractor-queue,search-upload,document-text-extractor}` | Pulumi queues/ECS/Lambdas (text-extractor queue looks orphaned) | 1173 |
| cache-core search (related) | `crates/client/cache-core/src/search.rs` | ⌘K / @mention ranking | 823 |
| agent search tools (related) | `crates/ai_tools/src/search` | ContentSearch / NameSearch | 655 |

### Data model

| entity | storage | key fields | path |
| --- | --- | --- | --- |
| 8 aliases (documents, emails, channels, chats, call_records, agent_sessions, projects, calendar_events) | OpenSearch | join parent/child for 4; flat for the rest; nested `{definition_id, values[], number_value, date_value}` properties; `dynamic:false` | `infra/stacks/opensearch/helpers/scripts/create_indices.ts` |
| frecency_events / frecency_aggregates | Postgres | events (user, entity, type, ts, was_processed); aggregates unique(user, entity), stored score, last-10 deque | `crates/macro_db_client/migrations/20251029143441_add_frecency_table.sql` |
| DocumentText / DocumentTextParts | Postgres | text with `[[part]]` markers + tokenCount; part → page-% rect | `crates/macro_db_client/migrations/0001_baseline.sql` |
| comms_entity_mentions | Postgres | target, source, user (backlinks) | `crates/macro_db_client/migrations/20251104101012_comms_db_schema.sql` |
| Backfill jobs | DynamoDB | id, status, enqueued, TTL | `services/search_processing_service/src/domain/jobs.rs` |

### Key flows

**Upload → index**
1. S3 Object Created → `search_upload_handler` → DSS `content_uploaded` → Kafka.
2. Consumer hashes the entity key onto N sequential workers with bounded queues (per-entity order, retry 3×).
3. `raw_document.rs` picks a parser by type: pdfium per page, DOCX via its converted-PDF key, text as one chunk
   (≤100k), design engines, or name-only.
4. Properties and tags are denormalized onto the parent; the parent and chunks are bulk-upserted.

**Markdown sync**
1. Lexical service parses the doc into top-level blocks (legacy JSON fallback).
2. Delete the old chunks, write the new ones keyed by node id. An empty doc early-returns, so it is likely never
   name-searchable (inferred).

**Unified query**
1. Split terms (quotes keep phrases) and enforce caps: >50 terms is an error; terms are truncated to 80 chars.
2. Resolve per-entity allowlists in Postgres. An empty list means nothing.
3. Build one multi-index query with a named clause per type. Each term is `match_phrase_prefix` (≤256 expansions) when
   ≥3 chars, a whole token otherwise.
4. Expand hits: a name hit plus one hit per inner chunk; type comes from `matched_queries`.
5. Merge with chat-name and CRM results, count the page in **distinct entities**, emit a composite cursor (trimmed
   entities re-surface next page), and enrich from Postgres.

**Frecency**
1. Websocket open/ping/close → `frecency_events`.
2. A 60s advisory-locked aggregator appends events, `event_count += 1` per event (Open, Ping **and** Close), then
   stores `0.7·log2(count+2) + 0.3·Σ_{last10} w·exp(-0.1·hours)`.
3. Soup sorts by the stored score; it is never recomputed on read.

**PDF citations**
1. pdfium reads each page and walks its text lines.
2. A part closes on the newline **after** 4 lines have been counted, so each part holds 5 lines. Part ids are UUIDv4
   and the marker is `[[uuid]]`.
3. Each part's rect is stored as % of the page. Whitespace-only parts get `PdfRect::zero()`; failed pages are skipped
   silently.

## 4. Ideas worth stealing

1. **Windowed snippets, every term highlighted.** These are pure functions: start ~200 chars before the first match,
   cap the length, use tag-aware ellipses, strip invisible chars, merge spans split at `@`. Cerebro's excerpt can miss
   the term entirely. `crates/opensearch_client/src/search/model.rs`, `.../search/documents.rs`
2. **Agent search contract.** Say keyword-not-semantic; use separate person and topic searches; send activity
   questions to a list tool; exclude the caller's own conversation; annotate hits; hide internal modes; refuse an
   unknown type with the valid list. Restate it in Cerebro's terms (strict AND, flagged widening).
   `crates/ai_tools/src/search/search_service/{content,name,types,context}.rs`
3. **Two-tier UX.** Instant local name hits, then debounced content hits, deduped by id. Cerebro already holds every
   title in memory. `apps/web/src/features/soup/search/create-search-state.ts`
4. **Chunk hits with anchors.** A note matches if every term appears in some block. Return up to N blocks per note and
   count the page in notes. A title match is a separate hit with no anchor. `crates/opensearch_client/src/search/unified.rs`,
   `crates/search_service/src/api/search/simple/simple_unified.rs`
5. **Event-as-hint, reread, overwrite.** Duplicate or out-of-order events converge. Cerebro's no-index scan is this
   idea at its limit. `services/search_processing_service/README.md`, `.../process/document.rs`
6. **Frecency from raw events, not a stored score.** Keep the raw events and compute at read time. Macro shows the
   failure mode to avoid: a stored score, and an all-time count that dominates after ~48h. `crates/frecency/src/domain/models.rs`
7. **Index everything by name; cap pathological input** (100k chunk, highlight offset cap, PSD pixel budget, no retry).
   `services/search_processing_service/src/process/document/raw_document.rs`, `crates/opensearch_client/src/search/mod.rs`
8. **Named clauses type multi-source hits.** Never infer the type from the shape of a hit. `crates/models_opensearch/src/lib.rs`
9. **A failed property fetch is never written as "no properties"** (absent ≠ empty). `services/search_processing_service/src/process/document/raw_document.rs`
10. **Schema convergence as a pure plan, dry-run by default.** Unmapped fields under `dynamic:false` silently match
    nothing (macro-2731). `infra/stacks/opensearch/helpers/scripts/create_indices.ts`, `infra/stacks/opensearch/helpers/README.md`
11. **Generation-tagged rebuilds**: write the new generation, then prune old ones, so readers never see a half-deleted
    entity. `crates/opensearch_client/src/upsert/agent_session.rs`
12. **Folder-import clutter rules + partial success** (for the migration wizard). `services/upload_extractor_lambda_handler/src/main.rs`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | value | note |
| --- | --- | --- | --- |
| Unified human search (local 20ms + service 300ms) | absent | high | No search command in `src-tauri/src/lib.rs`, `src/lib/ipc.ts` or `mockIpc.ts`. ⌘K matches label/alias only (`QuickOpen.tsx:220-227`). TypePage/ListPage already search metadata per view (`viewFilters.ts:524-540`), but that search turns nested objects into `[object Object]`. Bodies are unsearchable. |
| Windowed snippets, all terms highlighted | partial | high | `excerpt()` takes the first 180 chars of the best line (`search.rs:259-279`). Demo-vault has 19 lines >180 chars. |
| One name ranker, fuzzy + freshness | partial | high | Many matchers: quickOpenScore ranks in QuickOpen/ChatInput/WhiteboardView but only filters in Picker/LibraryIndex. Editor `filterItems` is unranked and uncapped, in scan order (`MarkdownEditor.tsx:89-102`). RelationPicker sorts alphabetically. LinkPopover puts the exact match first. The ChatInput skill menu uses `startsWith`. No recency anywhere. Macro itself runs two rankers. |
| Frecency of opens | absent | medium | No open log. navStore history lives in memory. Favorites (`cerebro.favorites`) are pruned, never remapped. |
| Query grammar (phrase, prefix, exact, caps) | partial | medium | Strict AND, then a flagged widening. Quotes are stripped; a phrase is a ×1.5 bonus. No prefix, exact mode or caps. 60 stopwords. |
| name / content modes | partial | medium | search_notes searches title, `type` and body; ⌘K searches names only. |
| Frontmatter/property matching | partial | medium | Only `type:` (as kind, ×2) and a concept's `title:` match. Key, status, owner, description, about, tags, relationships and path are invisible, even though the description claims frontmatter (`mcp.rs:756`, `tools.ts:52`). |
| Agent search contract | partial | medium | One-line description that misstates what is searched. Results are truncated silently (`search.rs:218`). Unattended TS job lanes (distill, recheck, refresh, schema, skills) **do** get search_notes (`useJobRunner.ts:465-546`); only the three internal Rust spawns are denied it. |
| Filters (tags, properties, folder) | partial | medium | Type only. |
| Chunk hits + goto | absent | medium | Hits are whole notes. DocOutline `jumpTo` scrolls to H1–H3 by runtime id, but Selection carries no anchor. |
| get_note window | absent | high | `get_note` is uncapped (`mcp.rs:2150-2185`) while ingest admits 4MB and MCP caps results at 100k chars. |
| PDF/DOCX extraction | absent | medium | The Inbox takes text formats ≤4MB. The HTML5 drop is probably inert in the packaged app (Tauri's own drop handler is on). |
| PDF citation rects | absent | medium | Needs a PDF viewer (files domain). |
| Name-only index of binaries | absent | low | The scanner skips `attachments/`. |
| Alias-aware search | absent | low-medium | search_notes ignores the expansion-v1 registry; expansion-v1 serves only assembly and ingest. |
| Relevance ranking | already-better | low | BM25 vs Macro's recency sort. |
| Permission prefilter | partial | low | `read_scope` filters before ranking and states the withheld count, but non-internal, non-shell runs keep CLI Read/Glob/Grep (agents domain). |
| Semantic search | different-by-design | low | Neither app has it in search. Cerebro's expansion-v1 is retrieval for assembly. |
| Indexing pipeline, cursors, mention table | different-by-design | low | No index (M17.19). Capped lists. Backlinks derived from the scan. |
| Conversation search | absent | low | Macro indexes chats; Cerebro keeps ≤30 conversations in localStorage. A human-only search would respect M9.5. |
| CJK tokenization | partial | low | `tokenize` keeps a CJK run as one token. Changing it bumps RETRIEVER_VERSION. |
| Zip import clutter rules | absent | low | Files domain (migration wizard). |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEARCH-1 | search_notes tells the truth: meta field, windowed excerpts + match ranges, "N more matched", caps, trust labels, sharper text | rebuild | adapt | M | high | `crates/opensearch_client/src/search/model.rs`, `crates/ai_tools/src/search/search_service/{content,types}.rs`, `apps/docs/AI/mcp/tools/content-search.mdx`, `crates/opensearch_client/src/search/properties.rs` | `src-tauri/src/search.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/knowledge.rs`, `src/engine/tools.ts`, `src/views/viewFilters.ts` | — |
| SEARCH-9 | get_note line window + line numbers in excerpts | rebuild | inspire | S | high | `crates/opensearch_client/src/upsert/document.rs` (100k cap), `crates/models_search/src/simple.rs` (goto) | `src-tauri/src/mcp.rs`, `src-tauri/src/search.rs`, `src/engine/tools.ts` | — |
| SEARCH-4 | One name ranker + local open log (merged with SHELL-3, WORK-13) | rebuild (+ adopt-upstream uFuzzy optional) | adapt | M | high | `crates/client/cache-core/src/search.rs`, `.../search/ranking.rs`, `crates/frecency/src/domain/models.rs`, `apps/web/src/features/command/rank-command-search-items.ts`, `apps/web/src/lib/core/util/freshSort.ts` | `src/lib/nameRank.ts` (new), `quickOpenScore.ts`, `uiStore.ts`, `QuickOpen.tsx`, `MarkdownEditor.tsx`, `ChatInput.tsx`, `RelationPicker.tsx`, `WhiteboardView.tsx`, `LibraryIndex.tsx`, `Picker.tsx`, `mermaid/flowchart/LinkPopover.tsx`, `SettingsPage.tsx` | owner R12 call; SHELL-3 |
| SEARCH-3 | ⌘K content tier: names instantly, page matches after 250ms | rebuild | inspire | M | high | `apps/web/src/features/soup/search/create-search-state.ts`, `apps/web/src/features/command/useCommandItems.ts`, `crates/opensearch_client/src/search/model.rs` | `src-tauri/src/search.rs`, `mcp.rs`, `lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/app/QuickOpen.tsx` | SEARCH-1 |
| SEARCH-2 | Query contract v2: quoted phrases, prefix, exact, `in:` scope | rebuild | adapt | M | medium | `crates/search_service/src/api/search/terms.rs`, `crates/opensearch_client/src/search/{documents,query}.rs`, `crates/models_search/src/lib.rs`, `crates/ai_tools/src/search/search_service/name.rs` | `src-tauri/src/search.rs`, `mcp.rs`, `src/engine/tools.ts`, `src/lib/mockIpc.ts` | SEARCH-1; browse/where/dates → MCP-7 (`list_notes`) |
| SEARCH-6 | PDF + DOCX (+zip) text as Inbox captures (merged with FILES-5) | adopt-upstream | adapt | M–L | medium | `services/search_processing_service/src/parsers/pdf.rs`, `services/document_text_extractor/src/handler/extract_text_citations.rs`, `.../process/document/raw_document.rs`, `apps/web/package.json` | `package.json`, `src/lib/ingest.ts`, `src/lib/extract/{pdf,docx}.ts` (new), `InboxPage.tsx`, `ipc.ts`, `mockIpc.ts`, `src-tauri/src/lib.rs` (`import_attachment`) | FILES-14 (OS drop paths) |
| SEARCH-10 | Alias leg for search_notes | rebuild | inspire | S–M | low-medium | — (Cerebro-native) | `src-tauri/src/search.rs`, `src-tauri/src/retrieval/mod.rs` (`entities_named_in`) | SEARCH-1 |
| SEARCH-5 | Block hits + jump-to-anchor in the UI (deferred) | rebuild | adapt | L | medium | `crates/opensearch_client/src/search/{documents,unified}.rs`, `crates/models_search/src/simple.rs`, `.../process/document/raw_document.rs` | `search.rs`, `mcp.rs`, `src/engine/types.ts`, `navStore.ts`, `DocPage.tsx`, `editor/DocOutline.tsx`, `QuickOpen.tsx` | SEARCH-3, SEARCH-9, DOMAIN:editor |
| SEARCH-7 | Persistent engine + indexing pipeline | skip | — | XL | low | `services/search_processing_service/src/inbound/kafka_consumer.rs`, `infra/stacks/opensearch/helpers/scripts/create_indices.ts` | — | — |
| SEARCH-8 | Embedding / semantic search | skip | — | L | low | `crates/embedding/src`, `crates/task_dedup/src/lib.rs` | — | — |

**Acceptance highlights**

- SEARCH-1: a note whose only `maya` is `owner: [[maya-chen]]` is found. A 600-char line with the term at char 400
  gives an excerpt ≤240 chars that contains the term and starts with `…`. A 51-term query states the cap, and a 120-char
  term is cut to 80. Truncated results say "N more matched". A superseded concept names its replacement. Agent memory
  keys (`recent`, `preferences`) stay out of meta. `knowledge/log.md` and `templates/` are excluded or labelled. An
  unknown `type` refuses and lists the vault's types. Frontmatter parse failures are counted. Tests stay green for
  M34.4 withheld-count and retrieval, with RETRIEVER_VERSION unchanged. The description is ≤2,048 chars and says keyword,
  not semantic.
- SEARCH-9: a `lines` window on a 4MB transcript returns only that window. Excerpts print `L120 § Heading — …`.
- SEARCH-4: within a tier, a path opened 3× today beats an unopened one, but tiers never invert. Score(now+30d) <
  score(now). An agent `open_note` or a backdrop jump records nothing. A rename via `replacePath` keeps history and a
  delete prunes it. Editor `[[` comes back best-first with groups contiguous. Settings can show and clear the log.
  `'ab'` vs `'A Better World'` stays 0.
- SEARCH-3: a body-only word shows a `quick-open-content-result` with `<mark>`. Name rows keep `quick-open-result` and
  their order. Late rows do not move a user-set highlight. A rejected `searchVault` shows `section-unavailable`, never
  "No matches". A 2-char query makes no call.
- SEARCH-6: a 3-page PDF gives 3 `## Page N` sections. A failed page reads "Page 2: text not extracted" and later pages
  keep their numbers. An image-only PDF says it has no text. The extracted **body** is byte-identical on re-ingest.

### Top three

- **SEARCH-1 (M, high)**: fixes a false tool contract that both the attended panel and the unattended distiller rely on
  today (`prompts.ts:44` tells the distiller to use search_notes). It needs an offset tokenizer for match ranges, beside
  `tokenize()`, never changing it. Pull "replaced by" from the existing `knowledge.rs` walk without folding the ledger
  per hit. Share one "searchable value" rule with `viewFilters.searchEntries` and fix `[object Object]` there. Fix the
  quoted-phrase bonus (`search.rs:201,241-244`). Delete the false comments at `mcp.rs:756` and `tools.ts:52`. Write the
  invisible-char lists as escapes.
- **SEARCH-9 (S, high)**: the cheapest real gap. `get_note` can return a 4MB transcript into a 100k-char MCP cap. Add
  an offset/limit (1-based lines, states the total) and print line numbers in search excerpts. This also lays the
  anchor groundwork for SEARCH-5 without touching the editor. It overlaps the MCP domain's tool-contract work.
- **SEARCH-3 (M, high)**: the first human content search. One Rust corpus/rank path serves both `search_notes` and an
  ungated `search_vault`. The mock is **containment-only**: no TS BM25 and no goldens; ranking is pinned in cargo. Read
  each file once (today `scan_vault` and `read_note` read it twice) and cache by mtime. Do no `ledger_review` work on
  keystrokes. Restructure the highlight reset effect (`QuickOpen.tsx:231-238`). Render excerpts without chip syntax
  (`@[[x]]`, `[[x|alias]]`, `[^id]`). Add a "Search pages for…" hand-off. Placing it inside ⌘K is the owner's product
  call; Macro's ⌘K has no content tier.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| `serviceSearchResults` returns `[]` unless the query succeeded; no soup view renders `error()` (`create-search-state.ts:107-119,183-184`) | Unavailable is never empty | The content tier renders `section-unavailable`. The store catches and returns null. The call site writes down why it shows an inline row instead of toasting on every keystroke. |
| Stored frecency score, never decayed on read; all-time `log2(count+2)` with Ping/Close counted | Derived, never stored (`engine/okf.ts`) | Store raw open times (last N) plus counts. Count opens only, with a decayed or windowed frequency computed at read with an injected `now`. |
| Opens recorded wherever navigation happens | Records reflect the user | Record only at user-intent sites. `navigate`/`openDetail` also carry agent `open_note` and backdrop jumps (`AgentActions.tsx:28-34`, `useOpenPath.ts:87-98`). |
| Learned ranking with no view | §81: learned preferences are inspectable/editable; R12 tail under R8 | Owner call on whether ⌘K frecency is the R12 tail. Either way, show and clear the log in Settings and label it Recent. |
| Recency sort returns 0 for a missing timestamp (`builder.rs updated_at_sort`) | Absent is never zero | Browse (in MCP-7 `list_notes`) orders recorded times and states how many are unrecorded. Fix or flag `scan.rs iso_or_now` (missing mtime → now). |
| `filter_map` drops failed PDF pages; `PdfRect::zero()` for empty parts | Absent is never zero; unavailable never empty | Keep page numbering, write "text not extracted", never emit zero rects, and say so when a PDF has no text. |
| UUIDv4 part ids; `[[uuid]]` markers | Files-first, git-stable; `[[…]]` is wikilink syntax | Use deterministic `page.part` ids and never bracket them as wikilinks. |
| DM ×1.8, same-domain +50% | No type special-casing | No per-type boosts. Any future boost is capability-gated data. |
| Unified results by recency only | M17.19: best N by BM25 | Keep BM25. Recency only for browse and as the tie-break inside name tiers. |
| Persistent index + event pipeline; NameSearch/ContentSearch split | M17.19 no index; tool grant derived from catalog (M26.3c); partition-test rows | Skip the index. One `search_notes` with `in: name\|content\|all`; activity questions go to a separate read-only `list_notes` with its own partition row. |
| Twin ranker in TS mock | Policy is data; no twin rules (`shared/policy/README.md:8-12`; `mockIpc.ts:1086-1092`) | Containment-only mock; ranking pinned in cargo. |
| Silent 100k-char chunk cut (`upsert/document.rs:21`) | Totals say what they skipped | State any per-note cap in the result. |
| Rename handled nowhere central | — | The open log and favorites share SHELL-14's rename hook. External git/Finder renames do not reach `replacePath`, so prune on scan. |

## 8. Verification notes

- **Refuted**: search.rs has 63 stopwords. It has **60** (`search.rs:58-64`).
- **Refuted**: the Macro launcher ranks by count + recency. `sortLauncherBlocks` sorts by `lastUsedAt` only
  (`apps/web/src/features/command/core/launcher-history.ts:9-18`).
- **Refuted**: SEARCH-1 is S. Macro windows fragments the engine has already tagged, so Cerebro needs an offset
  tokenizer, and "replaced by" is ledger-gated inline in `knowledge::about`. Effort → **M**.
- **Refuted**: SEARCH-6 can write bytes the way `export_png` does. `export_png` writes outside the vault through a save
  dialog; `import_attachment` (`lib.rs:1077-1106`) is the vault lane.
- **Refuted**: re-ingesting gives byte-identical markdown. `ingested_at` is stamped (`engine/ingest.ts:273-277`), and
  slug dedupe writes a second file. Assert determinism on the body only.
- **Refuted**: opens via `navigate`/`openDetail` are user opens. Agent and backdrop opens share them.
- **Refuted**: an index would break M26.2 purity. Receipts pin RETRIEVER_VERSION, not BM25; M26.2 allowed a disposable
  app-data index, and FTS5 is already compiled in. The skip stands on M17.19 alone.
- **Corrected**: frontmatter is not entirely invisible; `type:` and a concept's `title:` match.
- **Corrected**: "no full-text search" means bodies. Metadata is searchable per view (TypePage/ListPage).
- **Corrected**: search_notes also reaches **unattended** TS job lanes, not just attended and user-Agent runs. Test
  SEARCH-1 there.
- **Corrected**: the prefilter is only partially "better": CLI Read/Glob/Grep bypass `read_scope`.
- **Corrected**: Cerebro's semantic edge (expansion-v1) is in assembly, not in search.
- **Corrected**: decaying Macro's formula on read still leaves the all-time count dominant after ~48h
  (exp(−4.8) ≈ 0.008).
- **Corrected**: Macro runs two cmd+k rankers (cache-core 0.7/0.3; TS uFuzzy, effectively 0.5/0.5). One ranker is
  Cerebro's own design.
- **Corrected**: Macro's caps: >50 terms is a hard error, not a truncation. The 3-char minimum counts bytes. Prefix uses
  `match_phrase_prefix` capped at 256 expansions, so its recall is incomplete. The caps exist to avoid has_child OOM,
  which is not Cerebro's cost model.
- **Corrected**: "1–3 keywords" exists because Macro matches chats/calls as one phrase prefix. Restate it for
  Cerebro's bag-of-words AND within 2,048 chars.
- **Corrected**: citation parts hold 5 lines, not 4.
- **Corrected**: Macro's DOCX parser is dead code (`parsers/docx.rs`). Real DOCX goes through a DOCX→PDF converter
  Cerebro lacks.
- **Corrected**: pickers number more than "3 across 7": LinkPopover and the ChatInput skill menu were missed. Ranking
  Picker/LibraryIndex changes their behaviour.
- **Corrected**: "nothing scrolls to a block". DocOutline does; what is missing is an anchor carried through navigation.
- **Corrected**: CSP (`tauri.conf.json:24`): a same-origin pdf.js worker is allowed. cMap and font fetches are blocked
  (`connect-src` lacks `'self'`), and so are wasm decoders (no `wasm-unsafe-eval`); text extraction is mostly fine. Not
  spiked.
- **Corrected**: SEARCH-8 rests on the user's deterministic-retrieval choice (`m25-m28-handoff.md:1174-1178`) and the
  R12 tail, not on M26.2 or R6.
- **Folded in**: SEARCH-9 (get_note window) and SEARCH-10 (alias leg). Cross-domain duplicates: SEARCH-4 ≈
  SHELL-3/WORK-13, SEARCH-2 browse ≈ MCP-7, SEARCH-6 ≈ FILES-5/FILES-14; EMAIL-8 depends on SEARCH-6.
- **Comments the changes falsify (delete them)**: `search.rs:15-25`, `:93-97`; `mcp.rs:756`; `tools.ts:52`;
  `QuickOpen.tsx:130-131`, `:190-192`. QuickOpen's "No matches" row can never render, because the Ask row is always
  present.
- **Unmeasured**: per-query scan cost at the owner's vault size. The only data point is 4.6ms scan / 48µs query at
  ~133 notes.

## 9. Where to read first

1. `crates/opensearch_client/src/search/model.rs` (highlight normalize / window / truncate)
2. `crates/ai_tools/src/search/search_service/content.rs`, `name.rs`, `types.rs`, `context.rs`
3. `apps/docs/AI/mcp/tools/content-search.mdx`, `name-search.mdx`
4. `crates/search_service/src/api/search/terms.rs`, then `.../simple/simple_unified.rs`
5. `crates/opensearch_client/src/search/documents.rs`, `unified.rs`
6. `apps/web/src/features/soup/search/create-search-state.ts`
7. `crates/client/cache-core/src/search.rs`, `.../search/ranking.rs`
8. `crates/frecency/src/domain/models.rs` (read for the failure modes)
9. `services/search_processing_service/src/process/document/raw_document.rs`, `.../parsers/pdf.rs`
10. `services/document_text_extractor/src/handler/extract_text_citations.rs`
11. `crates/models_search_cursor/src/lib.rs`, `crates/models_opensearch/src/lib.rs`
12. `services/upload_extractor_lambda_handler/src/main.rs` (clutter rules only)
