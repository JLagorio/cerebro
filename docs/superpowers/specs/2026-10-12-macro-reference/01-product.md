# Macro reference — Product surface and feature catalog (the user view)

**Scope**: Macro as a user meets it, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored). Every
Macro path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: root `LICENSE.txt` is AGPL-3.0 (BSL until 2026-05-31, `apps/docs/faq.mdx:59`). `apps/web/LICENSE` reads
"Copyright 2023 CoParse, Inc. All rights reserved." `apps/marketing` has no LICENSE and holds "frozen" copies of
`apps/web` components. `apps/docs/LICENSE` is Mintlify's MIT starter-template licence, not a grant over Macro's prose.
Docs prose, recipes, tool descriptions and system-skill prompts are AGPL text: **write new text, do not paraphrase**.
Only `vendor/ironcalc` (MIT/Apache-2.0) is reusable as code; no PRODUCT candidate is adopt-upstream or reuse-permissive.
**Sources disagree in age**: `apps/docs` (Mintlify, ~June 2026; changelog ends v2026.6.9.0) < `docs/AGENT_GUIDE` (live
behavioural spec, verified 2026-08-31 → 2026-09) < `apps/marketing` (Sept 2026). The guide wins where they differ.
**Evidence**: stages 1–2 read code and docs; stage 3 re-read both trees. Nothing was executed. Stage 3 overrides 1–2.
**Cerebro baseline**: M49–M52 (`vault_writes`, the `app_sessions` writer, Knowledge's three tabs) exist only on
`m49-knowledge-integrity`, not on `origin/main`.

---

## 1. What it is

- "The unified workspace for your company": email, chat, tasks, docs, agents and CRM in one tab, with "team level
  memory for agents" (`apps/marketing/src/features/setup/components/WelcomeSteps.tsx:144-160`).
- SolidJS web + Tauri desktop + iOS over hexagonal Rust crates on Postgres; Loro CRDT docs; one AI tool registry
  (`crates/ai_tools`) served to four hosts: Chat, AgentSession, ChannelBot, Mcp (117 documented MCP tools).
- About half the surface is team/comms SaaS (Gmail, LiveKit, Google Calendar, CRM). Most post-June features sit behind
  PostHog flags; which are GA is unknown from the repo.

## 2. What users get

### 2.1 Shell, navigation, search

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Home / work feed | One live feed: mail, channel messages and thread replies (own row, "Peter in #battlefield"), assignments, comment @mentions, shares, agent sessions finished / needing an answer, plus own recent work. `g h` (`g i` alias). j/k move + preview; space previews in a split; Enter opens; Shift+Enter new split; `e` done → Mark Done/Undo toast (⌘Z also undoes); Shift+↓ multi-select. Sections: Last few minutes, Last hour, This evening/afternoon/morning, Earlier today, Yesterday, older dates. `f` filter: Unread/Read/All + type checkboxes, badge counts hidden types. Lifecycle unseen → seen → done; undo returns to seen. Pure-notification rows leave on done; rows you also worked on stay as read. Empty pane: AI composer "What should we get done in Macro?" + ≤3 cached AI suggestions; retry after 45 s stall. Rail shows a presence dot, never a count. | `docs/AGENT_GUIDE/surfaces.md:197-400`, `crates/work_feed/src/lib.rs`, `apps/web/src/features/home`, `apps/docs/product/inbox.mdx` |
| Splits | Desktop tiling in one tab; per-split history. ⌘\\ new split (guide also ` and \\ — drift); Shift+H/L focus; Shift+Esc focus mode (glass scrim); ⌘Esc close/home; ⌥[ ⌥] split back/forward. Cap by monitor width + zoom. Shift-click any mention/row → new split. URL `/app/home/~/drive`, per-split `sN.*` params. One entity, one split ("Content already open"). ⌘. hides nav per split, sticky per app type. 6px gaps, inactive pane darker. | `docs/AGENT_GUIDE/navigation.md:120-307`, `apps/web/src/lib/split-router`, `apps/web/src/components/app/split-layout` |
| Command menu ⌘K | Category bubbles All/Command/Agents/Files/Tasks/Projects/Channels/People (Tab cycles); `o` leader opens a category. Empty query = last viewed → updated. Commands: Create, Change theme (live preview, Esc restores), MCP setup, copy entity id, markdown commands. Cached hits first, server search ~250 ms later; settled empty = "No results found". | `docs/AGENT_GUIDE/navigation.md:686-781`, `apps/web/src/features/command` |
| Create launcher | `c` then letter. Groups: Docs (d Document, s Snippet), Organization (f Folder), Design (n Canvas, i Design, h PSD, v AI), Data (l Database, b Spreadsheet, q Form), Comms (e m g c), Tasks (t Task, p Project, Reminder), AI (a Agent, u Routine, k Skill), Other (o Code). ≤3 Recents first; detail pane (tagline, description, examples, "C then T"). `/` search mode. Shift+Enter → new split. Composers: popover (desktop) / drawer (touch), "Continue editing in split", ⌘Enter submits. | `docs/AGENT_GUIDE/navigation.md:439-563`, `apps/web/src/features/command/Launcher.tsx:535-860`, `apps/web/src/features/command/core/create-menu-details.ts` |
| Keyboard model | Global: `c`, ⌘K, ⌘\\, ⌘; settings, ⌘. panels, ⌘Z/⇧⌘Z mutation undo. Go `g`+: h/i Home, a Agents, e Email, f Files, d Docs, t Tasks, r Calendar, c Channels, l Calls, o Customers, y Activity, n Recent, v Reviews; `/` search. Lists: j/k, h/l, Shift+j/k, gg/Shift+G, x, ⌘A, Tab/1–9 tabs, ⌘F, `f`. Entity: e done, ⌫ delete, r rename, ⌘D duplicate, m move, ⇧⌘C copy link, `]` side panel. Editor: ⌘B/I/U, ⇧⌘X, ⇧⌘H, ⌘E, `;` snippet, `@`, `#`, `/`, `:`. Letters inert while an editor has focus. | `apps/docs/keyboard-shortcuts.mdx`, `apps/web/src/lib/core/hotkey/tokens.ts`, `docs/AGENT_GUIDE/navigation.md:783-845` |
| Unified search | `/`; live filtering, Featured Results; quotes = exact phrase. Filters: type, Tags (Any/All once ≥2), @person. l/h expand preview. Hits deep-link: channel message (replies open parent thread), email message, markdown node, PDF page + highlight, agent turn ("Turn N"), call segment. Claims <50 ms (OpenSearch). | `apps/docs/product/search.mdx`, `docs/AGENT_GUIDE/surfaces.md:1035-1077` |
| Settings | Ctrl+; or gear, opens as a split. Groups Blocks / Personal / Workspace / Developer. Typo-tolerant search ("singature") highlights the row. Theme editor + custom themes. | `docs/AGENT_GUIDE/surfaces.md:2325-2420`, `apps/web/src/features/settings` |
| Onboarding, seed, tours | Slides: colour, interests, Google accounts, tools, team, plan. First login seeds a support channel, a "Macro how to guide" doc, 3 sample tasks; "Getting started" database once, never re-seeded after delete. Tours (flag): card + Back/n of N/Next/Dismiss; never navigate, pulsing beacon on the revealing control; **appear by themselves on every desktop view until dismissed**; localStorage progress. | `docs/AGENT_GUIDE/login.md:3-20`, `docs/AGENT_GUIDE/databases.md:426-435`, `docs/AGENT_GUIDE/view-tours.md:3-31` |

### 2.2 Content and data

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Blocks, previews, embeds, References | Every entity is a block (md, email, channel, chat, project, contact, company, call, canvas, code, image, video, pdf; later task, snippet, skill, spreadsheet, database, form, pptx, fig, psd, ai, docx, pr, initiative). Hover card: icon, title, byline, menu (copy link, open in split, embed, Ask Macro, delete). "Convert to Embed" → read-only card, resized height persists. References panel = backlinks. Title info card labels missing metadata rather than inferring it. | `apps/docs/concepts/blocks.mdx`, `docs/AGENT_GUIDE/documents.md:34-53,2104-2177,2452-2489` |
| @mentions | Opens at word start only. Buckets: People, Docs/Agents/Tasks, Channels, recent agent sessions, Companies, Projects, dates. Live pills (task status/priority). Side effects by surface: channel shares + notifies; doc/task body silent, grants nothing; comment notifies; email adds CC; agent prompt = context pointer. Pasted app URL → mention. | `apps/docs/concepts/mentions.mdx`, `docs/AGENT_GUIDE/documents.md:1951-2060` |
| Properties | Types STRING, NUMBER, BOOLEAN, DATE, SELECT_STRING/NUMBER (single/multi), ENTITY, LINK, TAG. System (non-removable, name reserved) vs custom; metadata flag. Inline / popover / modal editors. Pinned props render as pills under the title beside "Add tags" / "Add property"; Unpin keeps value, Delete from item removes it. | `apps/docs/concepts/properties.mdx`, `crates/macro_db_client/migrations/20251030100000_init_properties_schema.sql`, `crates/properties` |
| Tags | One namespace, personal or team. `#` picker creates. 12 fixed colours. Rename/recolour keeps identity; delete is global. `/` in name nests in sidebars. Filter Any/All; pill click → search by tag. | `apps/docs/product/tagging.mdx` |
| Documents | Loro CRDT, markdown-native. H1–H3, lists, checklist, quote, code (Prism, Copy), table, image, video, KaTeX, inline Task. Drag handles; Tab indent. ⌘F find/replace with regex (matches mention chips). `/document`, `/database`. Tick-rail outline at ≥3 headings (hover previews, click jumps). Checklist progress meter; task checklists get status/priority/assignee/due filters that dim. "Edit with AI": streams edits with a named cursor "Macro (AI)", Stop, **no accept/reject**. Front-matter toggle; word count; no nested docs. | `apps/docs/product/docs.mdx`, `docs/AGENT_GUIDE/documents.md:54-110,1949-2020,2179-2193`, `apps/web/src/lib/core/component/LexicalMarkdown` |
| Snippets | `c s`; a full markdown doc (sub_type snippet). `;` at line start or after space → filterable menu; Esc/space keeps the `;`. Works in docs, tasks, messages, canvas text, agent instructions. Team access Edit shares it. | `apps/docs/product/snippets.mdx` |
| Comments | Select → Comment → margin card (drawer on touch); bottom Discussion thread. Anchor deleted → thread moves to Discussion. `?comment_id` links. Agents comment as themselves with a "from <user>" pill. | `docs/AGENT_GUIDE/documents.md:2194-2321` |
| History + fork | … → History: read-only preview + timeline graph and sessions; Current version / Fork into a new doc. Desktop only. | `docs/AGENT_GUIDE/documents.md:2440-2450` |
| Databases (flag) | `c l`; tables as tabs. First entry infers type; lossy type change → "Convert into a new column" ("Amount (Number)"). Formula columns with plain-language errors; refuse deleting a referenced column. Types: Text (md + mentions), Number, Select, Multi-select, Date, Checkbox, URL, People, Documents, Tasks, relations. Personal "All records" filters vs shared stored views. And/Or filter groups, multi-sort, cross-table search. Board group by select/person, `n` new card. Undo journal of inverse ops; per-record history survives deletion. Footer calcs. CSV import ≤8 MB / 100 cols / 10k rows. `/database` in a doc = live answer (table, scalar or chart), runs per reader view-only, refreshes on change; "People never see SQL". | `docs/AGENT_GUIDE/databases.md`, `crates/databases/src/lib.rs`, `crates/database_sql/src/lib.rs` |
| Forms, spreadsheets, office editors | Forms = views over a database table (questions = columns), polls in channels. IronCalc spreadsheets (pilot). PPTX / Figma / PSD / AI / DOCX editors via Rust→WASM. All flag-gated. | `docs/AGENT_GUIDE/forms.md`, `docs/AGENT_GUIDE/documents.md:111-1947`, `vendor/ironcalc` |
| Canvas, Files | Canvas with live mention cards, shapes, connectors, tools v/h/r/x/p/t. Drive: Recent / My Files / Shared / Folders; email + channel attachments auto-import; breadcrumbed detail; sort restored on return. | `apps/docs/product/canvas.mdx`, `docs/AGENT_GUIDE/surfaces.md:1078-1217` |

### 2.3 Work, agents, activity

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Tasks | Tabs My / Created by me / Team / Projects. Statuses Not Started → Completed. Created from `c t`, message hover, `- [ ]`, `/task`, @Macro, agent, MCP. List/Board, Group, Sort, Filter with "Filter with AI…" (English → facet plan, typed failures UNAVAILABLE/UNREADABLE/NO_FILTERS). Board drag sets the property. ⇧⌘B copies branch name. A task is a doc (sub_type task). | `apps/docs/product/tasks.mdx`, `docs/AGENT_GUIDE/tasks.md:1-350`, `apps/web/src/components/view-shell/AiFilterInput.tsx` |
| Projects (initiatives) | `c p`; Overview + Tasks tab; agents as assignees auto-take tasks moved in. API naming: folder = "project", project = "initiative". | `docs/AGENT_GUIDE/tasks.md:352-530` |
| Reviews (GitHub) | Branch → In Progress, PR → In Review, merge → Done. PR inbox with scopes and filters; "Started from" origin (Claude, Codex, Cursor, Devin, Copilot, Jules, Macro) from session link, footer, Co-Authored-By, bot author, branch prefix. Changes pane (unified/split diff); Merge only when checks pass. | `apps/docs/integrations/github.mdx`, `docs/AGENT_GUIDE/tasks.md:194-323`, `docs/AGENT_GUIDE/surfaces.md:1674-1763` |
| Agent sessions | `c a` / `g a`. Work/Code sessions in one sidebar. Model picker + reasoning effort + Fast toggle; coding agents get a Repo/Branch drawer. `/` skills/PRs/commands, `@` mentions; Whisper dictation. Mid-turn sends queue server-side (≤50) with Steer / Send next / Stop. AskUser cards block the turn. Non-owner prompts need owner approval (Decline / Always allow / Approve; 30 min). Tool rows group "Called N tools" in a 5-row window. Magic Chip cards follow the latest turn. Fast-model opener in ~0.5 s; pre-warmed sessions. "Copy as prompt" / "Open in" Claude Code Web, Codex, Cursor, Zed. | `docs/AGENT_GUIDE/ai-chat.md`, `crates/agent_inmem/src/rig_engine.rs`, `docs/AGENT_GUIDE/documents.md:2456-2464` |
| Routines | `c u`. Schedules (hourly … cron, natural language, run once) or events (channel, doc, task property, new email); ≤16 trigger groups / 32 filters. Deterministic selectors first, then "Only run if" LLM condition (flag). Skipped runs recorded ("Condition not met", "couldn't be checked") and collapsed; bot-authored changes don't retrigger. Docs still say "Automations". | `docs/AGENT_GUIDE/navigation.md:577-685`, `crates/routines/src/lib.rs`, `crates/agent_trigger` |
| Skills + system skills | `c k`; doc sub_type skill; `/` Skills section. Tools ListSkills / SearchSkills / ReadSkill. Code-defined: Catch Me Up (LLM-prioritised briefing), What I Did Yesterday, Configure Agent. | `crates/skills/src/lib.rs`, `crates/system_skills/src/lib.rs:1-12`, `crates/system_skills/src/catch_me_up.rs:25-31` |
| Unified memory | Docs: "refreshed nightly", team memory. Code: one prose row per user, regenerated on read when >24 h old by a tool-using agent, gated by a Sonnet judge, injected as `<user_memory>`. "Team memory" = team-shared access, not a store. | `crates/memory/src/domain/service.rs`, `crates/agent_inmem/src/rig_engine.rs:590-611` |
| BYO runtimes, connectors, MCP | `macrod` pairs local ACP agents (Claude Code, Codex, OpenCode…) by device code; docs say "Coming soon", guide says live. Pipedream catalog + custom MCP; "Connect <app>" chip resumes the turn. Remote MCP: `claude mcp add --transport http macro https://mcp-server.macro.com/mcp`, OAuth; all schemas eager, no review cards. | `apps/docs/AI/bring-your-own.mdx`, `crates/pipedream_mcp/src/lib.rs`, `apps/docs/AI/mcp/overview.mdx` |
| Activity (flag) | `g y`. Year heatmap, "Most active" chips, day-grouped feed. Consecutive same actor/entity/action folds ("edited 5 times"; "Status from A to C · 3 changes"). Per-entity panel: 3 newest, View all, "created this" pinned last. Failure: "Couldn't load more." + Retry. | `docs/AGENT_GUIDE/surfaces.md:2112-2172`, `docs/AGENT_GUIDE/documents.md:2474-2483`, `apps/web/src/features/activity` |
| Import | Notion page importer, Linear connector or CSV with assignee mapping, Slack connector or ZIP archive. Ledger states staged → importing → imported / discarded. | `apps/docs/switch-to-macro.mdx`, `crates/import/src/lib.rs` |
| Comms/SaaS half | Email (multi-inbox, Signal/Noise = Gmail IMPORTANT + `email_filters`), email reminders, channels/DMs, calls (LiveKit), calendar + booking links, CRM from sent mail, bots, teams/billing, mobile. | `apps/docs/product/{email,channels,calls,calendar,crm}.mdx`, `crates/email/src/outbound/email_pg_repo/dynamic/query.rs:515-539` |

**Changelog trajectory** (`apps/docs/changelog/2025-12.mdx` → `2026-05.mdx`, ~2,900 PR lines / 117 releases): Dec–Feb
email, unified search, unified list (Soup); Mar channels rebuild, GitHub sync, pricing, memory, MCP server; Apr Calls,
scheduled agents, subagents, teams, undo; May RIG-based agent, external MCP, CRM from sent mail, multi-inbox.

## 3. How it's built

### Overview

- Three doc units shape the product: `apps/docs` (Mintlify; MCP tool pages generated from `crates/ai_tools` schemas by
  `apps/docs/scripts/generate-mcp-tool-pages.ts`; changelog from GitHub Releases), `docs/AGENT_GUIDE` (updated in the
  same PR as UI changes, per Macro's `CLAUDE.md`), `apps/marketing` (standalone SolidJS, boundary check bans app imports).
- Each surface maps 1:1 onto `apps/web/src/features/*`, backed by hexagonal Rust crates.
- Cross-cutting: Soup (unified query behind every list), `entity_access`, properties, notification lifecycle,
  work feed, and `ai_tools` (one registry, per-host filtering, 27 eager tools + a named deferred catalog).

### Components

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| Docs site | `apps/docs` | User docs, MCP tool pages, changelog | 9,455 |
| Agent guide | `docs/AGENT_GUIDE` | Verified spec of live UI, routes, flags, empty states | 11,115 |
| Marketing | `apps/marketing` | Positioning, comparisons, scripted demo workspace | 180,100 |
| Web features | `apps/web/src/features` | Per-surface SolidJS (`block-*`, `*-view`) | 1,362,467 |
| Home (web) | `apps/web/src/features/home` | Feed rows, date buckets, start pane | 10,281 |
| Work feed | `crates/work_feed` | Membership policy, stacking, seen/done, undo | 3,208 (1,165 test) |
| Activity | `apps/web/src/features/activity` + `crates/activity` | Heatmap, folding, timeline | 6,550 + 6,168 |
| Command | `apps/web/src/features/command` | ⌘K + launcher (1,451) + details (298) | 7,244 |
| Tours | `apps/web/src/features/tours` | Per-view tours | 628 |
| AI tools | `crates/ai_tools` | Per-host toolsets, deferred-tool prompt | 7,285 |
| Memory | `crates/memory` | Generator + judge + store | 894 |
| System skills | `crates/system_skills` | Code-defined skills | 266 |
| Soup | `crates/soup` | Unified filtered query | 32,070 |
| Properties | `crates/properties` | Typed fields and tags | 26,152 |
| Entity access | `crates/entity_access` | Channel/team/user grants | 32,408 |
| Databases | `crates/databases` (+ `database_sql`) | Typed tables, SQL subset → ops | 69,163 |
| Routines | `crates/routines` + `services/scheduled_action` | Cron + event triggers | 31,607 |
| Import | `crates/import` | Import ledger, Notion importer | 12,933 |
| MCP service | `services/mcp_service` | Streamable HTTP + OAuth 2.1 | 6,372 |

### Data model

| Entity | Key fields | Path |
| --- | --- | --- |
| Properties | `property_definitions` (owner, data_type enum, is_multi_select, is_system); `property_options`; `entity_properties` (values JSONB) | `crates/macro_db_client/migrations/20251030100000_init_properties_schema.sql` |
| Notification | `notification` + `user_notification` (state unseen/seen/done, seen_at); per-entity snooze/mute | `crates/macro_db_client/migrations/20260909141557_user_notification_state.up.sql` |
| Work-feed ack | `attention_through`: done marks only notifications with created_at ≤ through | `crates/work_feed/src/domain/models.rs:231-237` |
| Activity event | actor_id **separate from** subject_id, entity, action, time | `crates/activity/src/domain/events.rs:27-33`, `crates/macro_db_client/migrations/20260805180315_create_activity_events.sql` |
| Memory | `memory(user_id UNIQUE, memory TEXT, updated_at)` | `crates/macro_db_client/migrations/20260323000000_create_memory_table.sql` |
| Routine | `scheduled_action` (trigger_type cron/events, event_filters ≤32, task JSONB); `action_execution_record` | `crates/macro_db_client/migrations/20260922181603_add_scheduled_action_event_triggers.sql` |
| Favorite, reminder | `favorite(sort_order DOUBLE)`; `reminder(remind_at XOR cron, next_run_at)` | `crates/macro_db_client/migrations/20260702014623_create_favorites_table.sql`, `.../20260729145833_create_reminders_tables.sql` |
| Document | Loro doc per room in sync-service + S3 snapshots; sub_type task/snippet/skill | `services/sync-service/wrangler.toml` |

### Key flows

1. **Mark done (Home)**: user presses `e` → client sends the revision seen (`attention_through`) → service marks done only
   notifications created ≤ that point (`crates/work_feed/src/domain/service.rs:325-399`) → rows with own work stay as
   read → Undo calls `undo_done` with exact ids (`service.rs:400-433`) → row returns as seen.
2. **Agent turn**: prompt → session (pre-warmed) → `get_or_generate_memory` returns stored profile, regenerates in
   background if >24 h → `<user_memory>` in system prompt → `tools_for(AgentSession)` sends eager schemas + named
   deferred catalog → user-tools (SendEmail) wait for in-turn review; non-owner prompts wait for owner approval → Home
   gets "finished" / "needs your answer" (`crates/agent_inmem/src/rig_engine.rs:590-611`, `crates/ai_tools/src/lib.rs:136-296`).
3. **Activity record**: edit → session coalesced at record time (Redis EDITING_IDLE 5 min,
   `crates/documents/src/domain/activity.rs:181-195`) → event row → display fold `collapseRuns` merges consecutive runs
   with no time window (`apps/web/src/features/activity/core/collapse-runs.ts:18-50`).
4. **Routine run**: trigger fires (cron or event selector) → optional LLM condition reads the event as owner → yes: agent
   session; no / error: skipped run recorded → history collapses skips (`docs/AGENT_GUIDE/navigation.md:620-656`).
5. **Live database answer**: `/database` → AI runs ListDatabases, DescribeDatabase, view-only QueryDatabase → doc stores
   query + chart settings, never results → each reader re-runs with own access (`docs/AGENT_GUIDE/databases.md:437-514`).

## 4. Ideas worth stealing

1. **One self-description served to the model** — `SelfKnowledge` returns one "about" page so the agent's picture of the
   product never drifts from the product. Cerebro's prompt still describes a retired model (see PRODUCT-10).
   `crates/ai_tools/src/self_knowledge.rs:9-16`.
2. **Ack the revision you saw, undo exactly** — done covers only what was visible; anything newer resurfaces. Safe with
   agents writing concurrently. `crates/work_feed/src/domain/models.rs:231-237`, `service.rs:325-433`.
3. **Actor vs subject** — who acted mechanically vs whose activity it is; lets assistant writes count as "your" work.
   `crates/activity/src/domain/events.rs:27-33`.
4. **Unknown is never empty** — missing projections read "unknown", not absence; mirrors Cerebro's rule with concrete
   wording. `docs/AGENT_GUIDE/surfaces.md:174-180,628,1470-1475`.
5. **Sessionize, then fold** — coalesce edit sessions at record time; fold consecutive same actor/entity/action for
   display; net change for properties. `crates/documents/src/domain/activity.rs:181-195`,
   `apps/web/src/features/activity/core/collapse-runs.ts`.
6. **Seed once, never resurrect** — starter content applied at most once; delete is final.
   `docs/AGENT_GUIDE/databases.md:426-435`.
7. **Create launcher with a "where it lands" pane** — every creatable kind in one grouped list, recents, examples, chord.
   `apps/web/src/features/command/core/create-menu-details.ts`.
8. **Visible skipped runs** — routine history records and collapses condition skips instead of dropping them silently.
   `docs/AGENT_GUIDE/navigation.md:620-656`.
9. **Partial bulk failure reporting** — report what succeeded, leave only failed items selected.
   `docs/AGENT_GUIDE/navigation.md:903-904`.
10. **Copy as prompt / Open in** — trivial bridge from a page to external coding agents.
    `docs/AGENT_GUIDE/documents.md:2452-2464`.

(Agent-session UX, tool-surface design, Databases, routines detail, search and shell ideas live in their domain files.)

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Home work feed | partial | high | `src/pages/HomePage.tsx`: greeting, LearnedCard (≤3), My Tasks, Collections. Attention split over Inbox, Knowledge, Agents, My work. → PRODUCT-1 |
| Notification lifecycle, push, digest | different-by-design | low | Nothing speaks first; no bell (M43). Folds into PRODUCT-1 acks. |
| Recents | absent | medium | navStore history never shown. → PRODUCT-1 own-work lane; ⌘K recents → 02-shell |
| Splits | partial | medium | Repo workspace only. → 02-shell |
| ⌘K command menu | partial | high | `src/app/QuickOpen.tsx` scores titles/aliases only; places lack My work, Studio, Agents, Work; labels "List"/"Type" (:102, :114). → 02-shell |
| Create launcher | partial | medium | 3-item New menu + 8 scattered creators; two database creators. → PRODUCT-4 |
| Keyboard model | partial | medium | No j/k/e, leaders or sheet. → 02-shell |
| Search UI | partial | high | BM25 `search_notes` is MCP-only (`src-tauri/src/mcp.rs:755`); no IPC. → 12-search |
| Hover previews, embeds, References | partial | medium | Backlinks tab + database block. → 03-editor |
| Properties / tags | partial | medium | Fields, relations, rollups solid. → 04-data |
| Snippets, find/replace, comments, history fork | partial/absent | medium–low | → 03-editor |
| Databases extras | partial | high | → 04-data |
| Tasks, Reviews | partial/absent | medium | → 05-work, 10-coding |
| Agent session UX | partial | high | Mid-turn send dropped. → 06-agents |
| Routines | parity in shape | medium | Deterministic `when:` then `ask:` (a full turn, `src/engine/triggers.ts:17-19`). Lacks Macro's visible skipped-run history. → 08-automation |
| Skills / system skills | partial | medium | User folders get none; demo ships `create-an-agent`, `weekly-review`, `risk-sweep`. → PRODUCT-5, -6 |
| Memory | different-by-design | medium | Human-verified Knowledge bundle. → 07-ai |
| Studio | Cerebro-only (partial analogue) | — | Macro has SharePreview tunnels, HTML Render tabs, DisplayResults; none is an assistant-built page set in the store. |
| MCP for external clients | absent | medium | Loopback only. → 09-mcp |
| Activity heatmap + folding | partial | medium | History = last 50 git checkpoints; `vault_writes` unread, actor always NULL. → PRODUCT-2, -3 |
| History read failure | defect | medium | `src/git/useGit.ts:210,239` catch → `[]` → "No history yet". → PRODUCT-11 |
| "What changed since you looked" | defect | medium | converge with no `fromSeq` = since last ambient tick (≤300 s); BaseItself blurb false. → PRODUCT-1 + blurb fix |
| Reminders list / missed | defect | medium | >24 h overdue never fires; line-index key refires; global localStorage. → PRODUCT-1 |
| Delete feedback | defect | low–medium | "Recoverable from git history" but delete → OS trash, git optional. → PRODUCT-12 |
| User help / product brief | absent | high | Prompt says "work-management app", projects/items, Types screen. → PRODUCT-10 |
| Seeded starter content | partial | medium | Demo vault only. → PRODUCT-5 |
| Copy as prompt / Open in | partial | low | Records already have Copy link/path. → PRODUCT-8 |
| Favorites | already-better | low | Parity, dead pointers pruned. No port. |
| Settings search | absent | low | Six short sections; not worth it. |
| Tours | absent | low | Dropped (§7). |
| Email, channels, calls, calendar, CRM, bots, teams, billing, office editors, forms, mobile | different-by-design | low | → PRODUCT-9 skip |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PRODUCT-10 | One shared product brief for system prompt + `get_vault_context`, retired-terms test | rebuild | inspire | S | high | `crates/ai_tools/src/self_knowledge.rs:9-16`, `apps/docs/getting-started.mdx`, `apps/docs/keyboard-shortcuts.mdx` | `src/agent/systemPrompt.ts:21-26`, `src-tauri/src/mcp.rs:1986`, new shared brief + test | — |
| PRODUCT-2 | Stamp actor + run_id on every vault write | rebuild | adapt | L | medium | `crates/activity/src/domain/events.rs:27-33`, `apps/web/src/features/activity/core/actor.ts`, `docs/AGENT_GUIDE/surfaces.md:364-367` | `src-tauri/src/vault/write.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/runtime/vault_writes.rs`, `src-tauri/src/runtime/schema.rs` (v19), `src/lib/mockIpc.ts`, `src/engine/authors.ts` | m49 merged |
| PRODUCT-1 | Home catches you up: deterministic attention list | rebuild | inspire | L | high | `docs/AGENT_GUIDE/surfaces.md:197-400`, `crates/work_feed/src/domain/models.rs`, `crates/work_feed/src/domain/service.rs:325-433`, `apps/web/src/features/home/queries/home-date-buckets.ts` | `src/pages/HomePage.tsx`, `src/engine/homeFeed.ts` (new), reminders store (new), `src/engine/reminders.ts`, `src/hooks/useReminders.ts`, `src/knowledge/usePendingCards.ts`, `src/lib/mockIpc.ts`, `e2e/home.spec.ts` (new) | owner decision, PRODUCT-2, PRODUCT-3, m49 merged |
| PRODUCT-11 | History read failure renders section-unavailable | rebuild | inspire | S | medium | `docs/AGENT_GUIDE/surfaces.md:2112-2172` ("Couldn't load more." + Retry) | `src/git/useGit.ts:210,239`, `src/pages/PulsePage.tsx:43`, `src/git/GitHistoryPanel.tsx:28` | — |
| PRODUCT-3 | History gains heatmap, folded feed, per-page activity | rebuild | adapt | L | medium | `apps/web/src/features/activity/core/collapse-runs.ts`, `.../contribution-grid.ts`, `.../fold-panel.ts`, `crates/documents/src/domain/activity.rs:181-195`, `crates/activity/src/domain/timeline.rs` | `src-tauri/src/runtime/activity.rs` (new, SELECT-only), `src/engine/activity.ts` (new), `src/pages/PulsePage.tsx`, `src/detail/DocSidePanel.tsx`, `src/detail/DetailPanel.tsx`, `e2e/history.spec.ts` (new) | PRODUCT-2, PRODUCT-11 |
| PRODUCT-4 | One New launcher for every creatable kind | rebuild | adapt | M | medium | `docs/AGENT_GUIDE/navigation.md:439-563`, `apps/web/src/features/command/core/create-menu-details.ts`, `apps/web/src/features/command/Launcher.tsx:535-860` | `src/app/CreateMenu.tsx`, `src/engine/createCatalog.ts` (new), `src/app/QuickOpen.tsx`, `src/app/TypeDialogs.tsx`, `src/app/typeActions.ts` | DOMAIN:shell |
| PRODUCT-5 | Starter kit, offered once | rebuild | adapt | M | medium | `docs/AGENT_GUIDE/login.md:15-20`, `docs/AGENT_GUIDE/databases.md:426-435` | `shared/starter/` (new), `src-tauri/src/starter.rs` (new), `src-tauri/tauri.conf.json`, `src/pages/HomePage.tsx`, `src/pages/SettingsPage.tsx`, `demo-vault/inbox/welcome.md` | — |
| PRODUCT-6 | Shipped recipes: "Catch me up", "What I did" | rebuild | adapt | M (L if feed composed in Rust) | medium | `crates/system_skills/src/lib.rs`, `crates/system_skills/src/catch_me_up.rs`, `crates/system_skills/src/what_i_did_yesterday.rs` | `shared/starter/skills/` (new), `src/library/LibraryPage.tsx`, `src/engine/skills.ts`, `src-tauri/src/mcp.rs` | PRODUCT-3, PRODUCT-5, DOMAIN:mcp; PRODUCT-1 only if lane order shared |
| PRODUCT-12 | Honest delete feedback, partial bulk failure | rebuild | inspire | S | low–medium | `docs/AGENT_GUIDE/navigation.md:903-904` | `src/views/TableView.tsx:2302-2330,3125-3133` (+4 sibling dialogs) | — |
| PRODUCT-8 | Page "Open with": Copy as prompt, Reveal, Open | rebuild | inspire | S | low | `docs/AGENT_GUIDE/documents.md:2452-2464` | `src/pages/DocPage.tsx`, `src/detail/DetailHeaderActions.tsx`, `src/lib/prompts.ts`, `src-tauri/src/lib.rs` | — |
| PRODUCT-9 | Skip the team/comms SaaS half | skip | — | S | low | `apps/docs/product/{email,channels,calls,calendar,crm}.mdx`, `apps/docs/permissions.mdx` | update existing `docs/superpowers/specs/2026-10-12-macro-reference/README.md` | — |
| ~~PRODUCT-7~~ | View tours — **dropped** (§8) | — | — | — | — | `docs/AGENT_GUIDE/view-tours.md` | — | — |

**Other candidate notes**

- **PRODUCT-11**: catch → `section-unavailable` with Retry, never `[]`. Prerequisite for PRODUCT-3.
- **PRODUCT-3**: keep the name History (Knowledge already has an Activity tab, `KnowledgePage.tsx:354`). Sessionize
  before folding (autosave every 500 ms, `MarkdownEditor.tsx:267`). Day presence = local-time interval overlap over
  `app_sessions`; unit-test at a non-UTC offset (e2e is UTC). No session that day → "not recorded"; NULL actor →
  "unattributed". Git checkpoints = separate tab, never counted. Knowledge changes from `run_writes` + ledger, or say
  they're not shown. Per-page section replaces or merges `GitHistoryPanel` (`DocPage.tsx:731`, `DetailPanel.tsx:577`).
  Label the v17 seam; never blend git and `vault_writes`. Never a score or streak.
- **PRODUCT-4**: groups Write / Organize / Data / Diagram / Build / AI / Capture; ≤3 recents; detail pane says where it
  lands. Collapse database creation onto `createDatabase` (seeds statuses, does not navigate — launcher navigates).
  Stale-copy sweep: `CreateMenu.tsx:219,230`, `TypeDialogs.tsx:73`, `DocProperties.tsx:458`, `ListView.tsx:286`,
  `QuickOpen.tsx:102,114,141,148`, `HomePage.tsx:288`. Acceptance: use Work item (`records/work-items`), not "Task"
  (no Task type, no `folder:` in demo). Budget Sidebar.test + smoke churn. Keep the M42.5 Ask row.
- **PRODUCT-5**: explicit click, create-only, ≤1 per vault (`.cerebro/` marker). Tasks database (Type doc, status
  groups, Table + Board, 3 samples) + Getting-started page + demo's `create-an-agent` and `weekly-review`. **Do not seed
  a "paused" Knowledge agent** — lanes follow `autoLearn` (`useJobRunner.ts:243,522`), `paused` gates only the record;
  omit it or seed without schedule and say lanes follow Settings › Knowledge. Add `tauri.conf.json` resources entry.
  Write via guarded `vault::write`, never `knowledge/`. Needs a boot seam for an empty-vault e2e. `welcome.md` edits
  are test changes (`e2e/diagrams.spec.ts:904`, `Sidebar.test.tsx:695-709`, `DocProperties.test.tsx:12`).
- **PRODUCT-6**: decide where lane order lives first — compose the feed once (Rust or `shared/policy`), never TS +
  Rust twins. Or limit "Catch me up" to Rust-readable lanes (review queue, runs, `list_inbox`, converge) and name the
  omitted ones. Read-only `allowed-tools`. Never re-rank (Macro's is LLM-prioritised). No persisted summary. New prompts.
- **PRODUCT-12**: delete copy says OS trash; git history only if the vault is tracked. Partial bulk delete: report
  successes, keep only failed rows selected.
- **PRODUCT-8**: Copy link/path new only for docs (records have them, `DetailHeaderActions.tsx:231,240`). Reveal/Open via
  `open -R` / `open` through `std::process::Command`, no plugin. Toast only after the clipboard promise resolves. Browser
  mock: disabled + "Desktop app only".

### Top three

**PRODUCT-10 — one product brief (S, high).**
- Every agent turn hears that Cerebro is "a work-management app" with `project.md` folders and `<folder>/items/`, and
  that schema changes go through "the Types screen" (`src/agent/systemPrompt.ts:21-26`). `get_vault_context` still
  describes `collection.yml` / `*.list.yml`, which M47 retired (`src-tauri/src/mcp.rs:1986`).
- Build one bundled brief (Macro's `SelfKnowledge` shape) read by both the prompt and the MCP context, and later shown
  in-app as a getting-started page plus the 02-shell shortcut sheet.
- A unit test fails on retired terms in prompt and UI strings. Smallest, highest-value fix in the domain.

**PRODUCT-2 — actor + run_id on vault writes (L, medium; unblocks 1, 3, 6).**
- 8 `shadow_write` sites (`write.rs` update_frontmatter, save_note, create_note, write_source, set_note_title,
  save_collection, save_list, save_view) plus rename and delete all pass `None`.
- Stamp `human:me` (the established stamp, `usePendingCards.ts:84`) for UI IPC, `RunGrant.actor` for MCP, construct for
  jobs; add `run_id` (`mcp.rs:61-75`) so on-your-behalf writes count as yours.
- Record or explicitly declare unrecorded: `.mmd` saves (`write.rs:503`), `write_text_file`, `import_attachment`,
  `create_folder`, `git_discard_file`, shell-granted CLI Write/Edit. v19: `vault.create` kind (CHECK change = table
  rebuild), `(vault_id, recorded_at)` index, coalescing or retention. Mock parity + RunGrant security review.

**PRODUCT-1 — Home attention list (L, high; owner decision first).**
- Lane lines on the launch page, one row per subject, Macro's date buckets on a whole-minute clock (future → newest,
  invalid → last). Lanes: proposals (review_queue cards via `useDecisions`, own lane), runs since ack, Inbox captures,
  reminders, "what changed", own recent edits.
- Required plumbing: stored per-vault convergence cursor as `fromSeq`; reminders moved into a store with "missed while
  closed" rows, stable keys, per-vault fired times; runs filtered client-side with a "N past the 200 cap" note; a mock
  seam that can fail `reviewQueue`; page-owned Undo (toast is message-only, `uiStore.ts:405`); lane order in one place.
- Done acks only the revision seen; Undo restores as seen. No bell, no nav count, no push, no LLM ordering.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| Home = notification inbox: dots, push/email delivery, AI suggestions on empty pane | Nothing speaks first (2026-07-28); no bell (M43); "Home = My Work/Tasks" (product direction) | Owner must decide explicitly: lane lines on the launch page *do* speak first, so "pulled" is not a defence. Quiet mono counts are the accepted precedent (M42.1). No push, no new badge, AI suggestions dropped. |
| Model-ranked importance (Signal/Noise, prioritised Catch Me Up) | LLM never orders attention (`src-tauri/src/attention/lanes.rs`, M27.6) | Order by time, then declared reason rank; recipes summarise within that order. |
| Work feed owns done for every reason | One queue, two doors (agent-platform §7.6); proposals return typed results | Proposals stay review_queue cards; local acks only for informational rows. |
| Heatmap counts empty days as 0 | Absent is never zero | No session → "not recorded"; NULL actor → "unattributed"; page says out-of-app edits aren't recorded. |
| Failed reads collapse to empty | Unavailable is never empty | PRODUCT-11; per-lane `section-unavailable` on Home. |
| Starter content auto-seeded at first login | Vault is the source of truth; agents arrive paused (M36) | Explicit offer, create-only, once per vault. |
| System skills defined in code | Skills are vault records; prompt says `get_note` them | Ship recipes as installed files. |
| Twin feed logic (TS Home + Rust MCP) | Policy is data; twin code is a review-blocking defect | Compose once in Rust or `shared/policy`. |
| Optimistic done/undo with ⌘Z | Human-UI store actions never throw | Done/Undo/Snooze toast + return null/false; proposals keep typed results. |
| Tours appear unasked with pulsing beacons | No popups; "a dot promising nothing is a lie" (M43); no decorative chrome | PRODUCT-7 dropped; revisit only as a user-started "Show me around". |
| AGPL prose and prompts | Guided rebuild, no 1:1 copy | Write new prompts and copy; read code for behaviour only. |

## 8. Verification notes

- **Refuted**: "`vault_writes` logs every app write." It logs most `vault::write` note/YAML writes only; `.mmd` saves,
  `write_text_file`, `import_attachment`, `create_folder`, `git_discard_file`, concept writes and shell-granted CLI
  Write/Edit are unrecorded (`write.rs:503,608,680,1114`; `git_commands.rs:48`; `agent/mod.rs:582,703-716`).
- **Refuted**: "Knowledge writes are attributed in the ledger, so Activity must not double-count." `concept_write` /
  `write_concept` never call `shadow_write`; the risk is **omission**, not double counting.
- **Corrected**: 8 `shadow_write` sites, not 9 (`write.rs` was being edited during the read; function names are the anchor).
- **Corrected**: `vault_writes` / `app_sessions` unread except a validator, never pruned, indexed only by
  `(vault_id, path)`; branch-only (not on `origin/main`).
- **Corrected**: `app_sessions` can tell "not open" from "open, no writes" only with interval overlap; rows span days, a
  second process truncates the first (`catchup.rs:345-380`), vaults without a ledger store id are skipped, the mock has
  no sessions table, times are UTC.
- **Corrected**: "every Home lane already has a read." Reminders have none (hook ref); fleet has no `since` and caps at
  200; converge without `fromSeq` covers ≤300 s; mock `reviewQueue` cannot fail; toast has no action. Own-work lane also
  needs PRODUCT-3's read IPC.
- **Corrected**: M43's "there is no feed" justifies no bell; it doesn't ban a feed. "Acceptable only collapsed and
  pulled" was stage 2's inference. Missed owner direction "Home = My Work/Tasks".
- **Corrected**: Routines are parity in shape, not "already better" — Macro also runs deterministic selectors first
  and shows skipped runs. Studio has partial Macro analogues. The demo vault does ship three skills.
- **Corrected**: Macro activity fold has no time window; 5-min idle is record-time sessionization. Tours do appear
  unprompted. Stage 2's `service.rs:325-450` overruns a 433-line file.
- **Confirmed**: no seeding outside the demo; `paused` gates only a record's own schedule/triggers; fired reminders only
  toast (and >24 h overdue never fire); recipes must be files; creation scattered with two database creators; no
  content-search UI; Home date-bucket rules; done acks revision; seed-once rule; licences.
- **Unverifiable**: Tauri opener plugin licence — not needed; use `open -R`.
- **Adjustments applied**: PRODUCT-1 fidelity adapt → inspire, deps + scope added; PRODUCT-2 `human:me`, `run_id`, v19,
  M → L; PRODUCT-3 keeps name History, M → L; PRODUCT-4 acceptance + sweep; PRODUCT-5 no paused Knowledge agent;
  PRODUCT-6 single lane-order source; PRODUCT-7 dropped; PRODUCT-8 no plugin; PRODUCT-9 updates the existing README.
  New: PRODUCT-10, -11, -12; converge cursor and reminders fixes folded into PRODUCT-1; help folded into PRODUCT-10.
- **Fix now (S, no candidate)**: `src/knowledge/BaseItself.tsx:761-763` blurb "Since the last time anybody looked" is
  false — a comment a change has falsified.

## 9. Where to read first

1. `docs/AGENT_GUIDE/surfaces.md:197-400` — Home feed behaviour.
2. `crates/work_feed/src/domain/models.rs` and `crates/work_feed/src/domain/service.rs:325-433` — ack and undo.
3. `apps/web/src/features/home/queries/home-date-buckets.ts` — date sections.
4. `crates/ai_tools/src/self_knowledge.rs` — the self-description pattern.
5. `crates/activity/src/domain/events.rs` and `crates/documents/src/domain/activity.rs:181-195` — actor/subject, sessions.
6. `apps/web/src/features/activity/core/collapse-runs.ts`, `contribution-grid.ts`, `fold-panel.ts` — folding + heatmap.
7. `docs/AGENT_GUIDE/surfaces.md:2112-2172` and `docs/AGENT_GUIDE/documents.md:2474-2483` — Activity UX.
8. `docs/AGENT_GUIDE/navigation.md:439-563` and `apps/web/src/features/command/core/create-menu-details.ts` — launcher.
9. `docs/AGENT_GUIDE/login.md:3-20` and `docs/AGENT_GUIDE/databases.md:426-435` — seeding.
10. `crates/system_skills/src/lib.rs` — system skills (behaviour only; prompts are AGPL).
11. `docs/AGENT_GUIDE/navigation.md:577-685,903-904` — routines skips, bulk-failure reporting.
12. `apps/docs/changelog/introduction.mdx` and `apps/docs/faq.mdx` — trajectory, licence history.
