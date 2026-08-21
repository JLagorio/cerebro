# Agents are pages — the Cerebro agent platform

**Date:** 2026-08-17
**Status:** design, approved in outline; slice 1 ready to plan
**Milestone:** M34
**Supersedes framing in:** M8 (knowledge as a bundle), M21–M28 (the base as an epistemic
agent in its own right)

---

## 1. Decisions

Settled in the brainstorming session that produced this document:

| # | Decision |
| - | -------- |
| D1 | The pivot is **six sub-projects**, not one. Each gets its own spec → plan → build cycle. |
| D2 | **Agent platform first.** Shell flattening, page unification and types→databases stack behind it. |
| D3 | Execution is **app-lifetime only**, with catch-up on launch. No daemon, no cloud. A missed schedule fires late and says it was late. |
| D4 | Governance is **per-agent configuration**, surfaced in the agent's own settings — not a universal policy the app enforces over the user's head, and not a `governed:` flag routed on in code. |
| D5 | **Knowledge is the corpus.** Docs, records and cached external sources are the knowledge. The concept layer is an *index over* that corpus, owned by one agent — not a second store of truth. |
| D6 | Nothing built in M21–M33 gets deleted. One boundary moves: `knowledge/` stops being a **place** and becomes a **capability**. |
| D7 | Slice 1 is **"make agents real"** — grant, prompt, instructions, chat. No UI demolition, no schema migration, no new MCP tool. |

### D4, stated precisely

The original objection to a per-agent governance switch was that AGENTS.md forbids
type special-casing — behavior is capability-gated. That objection does not apply
here, and the distinction is worth writing down because it will come up again:

- A **flag routed on in code** (`if (agent.governed) …`) is the forbidden thing.
- **Per-agent policy binding** is data in the agent's settings, enforced in Rust
  against the run's bearer token. That is the same shape `scope:` and
  `allowed-tools:` already have.

An agent that should not propose is not "ungoverned" — it is **unarmed**. It holds
no write tools, so it never reaches the channel. Same outcome, no flag.

### D5, stated precisely

M22–M28's *mechanism* is not overbuilt. Its *framing* was:

- **was:** "the base holds a position on this claim" → the system has judgement
- **is:** "the agent shows its work, you sign off" → the human has judgement, the
  agent has evidence

Same code, different sentence. What follows from the reframe:

| Existing work | Fate under D5 |
| ------------- | ------------- |
| `engine/okf.ts` (1039 lines, pure derivation, zero IO), concepts, `about:` anchors, threads | **Private read model of the knowledge agent.** An index, not a truth store. |
| `cache_source`, `type: Source` records, Source Monitor, `stale_after` | **Promote.** This *is* "connected sources agents consume." Freshness of Slack/Jira/Confluence copies is the product. |
| Policy risk ladder, `applied \| queued \| rejected`, two-destinies split | **Promote.** Generic; serves any agent. |
| `policy.v3.json`'s 20 epistemic ops and 7 target classes | **Stay** as the knowledge agent's private proposal ops. |
| Ledger envelope (`ledger/frame.rs` hash-chained NDJSON) | **Promote.** Domain-agnostic. The capture gate at `lib.rs:102`/`:121` eventually moves from `is_knowledge_path` to "governed agent write." |
| Meter, `RunGrant`, `fleet.rs` | **Already generic.** Nothing to do. |
| Knowledge tab (M33/M33a) | **Relocates** — becomes the knowledge agent's detail page. The work is not wasted; it moves. |
| R1–R14 gates, `coverage_cache`, `attention_signals`, `convergence_runs`, `parked_promotions`, `source_taint_assessments`, `working_memory_manifests` | **Park.** The real overbuild: tables and gates serving capabilities that were never switched on. |

---

## 2. What already exists

Recorded here so no phase rebuilds it. All verified against the tree on
`m33a-knowledge-tab`.

**An agent is already a page.** `type: Agent` records parse to an `AgentRef`
(`src/engine/agents.ts:138-160`) carrying:

- `actor: process:<slug>` — fixed by a declared `slug:` so a rename does not split
  provenance
- `scope: string[] | null` — write folders; **null ≠ `[]`**, and the doc comment
  says why
- `allowedTools: string[] | null` — intersected with policy, never unioned
- `connectors: string[] | null` — narrowing of the vault's enabled MCP servers
- `memory` tiers, `shell`, `description`

**A settings panel already exists**: `src/library/AgentEditor.tsx` — identity,
schedule, scope, tools, connectors, shell, triggers, memory.

**Triggers and schedules already exist**:

- `src/engine/triggers.ts` — `when:` → `{event: created|changed|moved, field, to, in, ask, do}`;
  a deterministic frontmatter gate, then a model gate, then a per-waking shape
- `src/engine/skills.ts:265` — `hourly | daily HH:MM | weekdays HH:MM | weekly <day> HH:MM`
- `src/engine/jobs.ts` — `jobQueue`, pure derivation; `TRIGGER_COOLDOWN_MS` 15min at `:57`; `isPaused` at `:73`
- `src/agent/useJobRunner.ts` — 60s tick, 4s settle, one job at a time, yields to chat

**Per-agent authorization already exists in Rust**: `RunGrant{actor, run_id, scope, tools}`
(`src-tauri/src/mcp.rs:60`), minted by `run_token` (`:550`), enforced before any tool
body — write scope at `:1249` (separator-matched prefix), tool allowlist at `:1271`.

**Per-agent run history already exists**: `runtime/fleet.rs:276` `actor_summary`,
joined to the record by actor string in `src/library/AgentDossier.tsx`.
`src/status/FleetSection.tsx:84` already filters by actor.

**The wire already carries everything slice 1 needs**: `RunOptions`
(`src/agent/agentIpc.ts:58-95`) declares `systemPrompt`, `actor`, `scope`,
`allowedTools`, `connectorNames`, `model`, `sessionId`. `build_args`
(`src-tauri/src/agent/mod.rs:626`) already honours `--append-system-prompt`,
`--model` and `--resume`.

**One agent record ships in the corpus**: `demo-vault/records/agents/release-scout.md`.

### The gaps, named

| # | Gap | Evidence |
| - | --- | -------- |
| G1 | The **grant** ignores the record's tools. `run_token(actor, scope, None, run_id)` — always `None`. argv *is* narrowed (`mod.rs:586`), so this is a defence-in-depth hole, not an open door; but `mcp.rs:1189` states the intent as "argv is advice, the grant is the boundary." | `src-tauri/src/lib.rs:997-1002` |
| G2 | **Every agent is told it maintains `knowledge/`.** `buildSystemPrompt` hard-codes the OKF paragraph and the M17.20 trust-weighting paragraph; `useJobRunner` passes it verbatim to every unattended run. | `src/agent/AiPanel.tsx:717-731`, `src/agent/useJobRunner.ts:375` |
| G3 | **No per-agent instructions.** The record's body rides the *user* message. `AgentRequest.system_prompt` exists and is never set per-agent. | `src/lib/prompts.ts:215` |
| G4 | **No chat with a named agent.** One global conversation; `runAgent` from the panel carries no `actor`, no `scope`, no `connectorNames`. Agent records only ever run unattended. | `src/agent/useAgentChat.ts:321-336` |
| G5 | The background runner imports its system prompt **from a React panel component**. | `src/agent/useJobRunner.ts:3` |
| G6 | Schedules and fire-ledgers live in **localStorage**. Closed window fires nothing; clearing localStorage re-fires one catch-up. | `src/stores/uiStore.ts:338-341` |
| G7 | **No agent-invokes-agent.** No MCP tool starts a run; `Task` is never in `tool_policy` and is withdrawn from internal runs by `INTERNAL_DISALLOWED` (`mod.rs:607`). | `src-tauri/src/agent/mod.rs:559-571` |
| G8 | **No inbound events.** `tiny_http` on loopback is the only listener; no reqwest/hyper/axum in `Cargo.toml`. Trigger inputs are only renderer-diffed `VaultEvent`s. | `src-tauri/Cargo.toml` |

### One more fact that changes the risk calculus

The heavyweight M26 ambient pipeline has **never run for a real user**.
`ambient.ingest_enabled` defaults false and **no UI turns it on** — `lib.rs:494`/`:501`
have zero frontend callers. `agent_proposals_enabled` is the same: default false, no
setter command, hand-edited `config.json` only. The seven epistemic phases on the
ambient tick (conflict detection, D12 gauntlet, contradiction backfill, freshness
scheduler, attention signals, convergence, Source Monitor) are dark.

Only the light renderer distiller (`useJobRunner`, gated on `uiStore.autoLearn`,
default **true**) is live.

We are not unwinding a system. We are deciding whether to finish one.

---

## 3. Target model

**An agent is a page.** Its frontmatter is its settings panel; its body is its
instructions. This is Notion's agent Settings panel, expressed as a file the user
owns and can diff.

```yaml
---
type: Agent
slug: knowledge                 # fixes the actor; a rename must not split provenance
description: Keeps an index over what this vault knows.
schedule: daily 06:00
when: { event: changed, in: records/ }
scope: [knowledge/]             # what it may WRITE
allowed-tools: [read, knowledge]
connectors: [slack, jira]       # what it may READ from outside
capabilities: [knowledge]       # NEW in M34.1 — which prompt fragments it gets
---

You keep an index over this vault's documents and connected sources…
```

Four axes, all already enforced in Rust against the bearer token rather than
requested in a prompt:

| Axis | Bounds | Enforced |
| ---- | ------ | -------- |
| `scope:` | what it may CHANGE in the vault | `mcp.rs:1249` |
| `allowed-tools:` | which tools it may call | `mcp.rs:1271` (after G1) |
| `connectors:` | what it may READ from outside | `connectors.rs:143`/`:177` |
| `tools: shell` | shell access, capped by Settings | `mod.rs:559` |

`capabilities:` is the one new axis, and it is deliberately the smallest possible
mechanism: a list of named system-prompt fragments. It is **not** routed on in
behavior code — it selects text. That keeps D4's line intact.

---

## 4. Slice 1 — M34.1 "make agents real"

Five phases, each an atomic commit. No rail change, no Docs change, no type rename,
no new MCP tool, no `lane_registry` migration, **no demo-vault edit**. The corpus and
every navigation path stay byte-identical, so **no e2e spec is touched.**

### M34.1.1 — the grant stops lying

- `src-tauri/src/lib.rs:997-1002` — pass `request.allowed_tools` into `run_token`
  in place of `None`.
- Delete the comment the change falsifies: *"No tool narrowing (M31.1b): the
  panel's own turns are unrestricted, and a person is watching them."* Per AGENTS.md,
  a retired workaround's comment dies with the workaround.
- Verify the four call sites behave as intended afterwards:

  | Call site | Passes | Grant after |
  | --------- | ------ | ----------- |
  | panel chat turn | absent → `None` | unrestricted — unchanged |
  | `AskAiPopover.tsx:105` | `[]` | narrowed to nothing — now matches its own doc comment at `:35` |
  | `MarkdownEditor.tsx:566` | `[]` | narrowed to nothing — same |
  | `useJobRunner.ts:390` | `agent?.allowedTools ?? null` | **honours the record** — the actual fix |

- Rust test: a run holding `Some([...])` is refused an ungranted tool at `mcp.rs:1271`
  with `ungranted_tool_refusal`.
- Mirror in `src/agent/mockAgent.ts` — parity is a tested requirement.

**Risk:** low. `None` vs `Some([])` is already the established contract on both
sides; nothing currently relies on `[]` meaning "unrestricted."

### M34.1.2 — the system prompt gets a home

- New module `src/agent/systemPrompt.ts`. Move `buildSystemPrompt` and its private
  `describeSelection` out of `src/agent/AiPanel.tsx:717-782`.
- `useJobRunner.ts:3` imports the module, not the panel. `useJobRunner.test.tsx:32`'s
  `vi.mock('./AiPanel', …)` re-points to the new module.
- Pure move. No behavior change. Lands green on its own.

### M34.1.3 — the knowledge paragraph becomes a capability

- Split two lines out of the `lines` array into a named fragment:
  - `AiPanel.tsx:726` — the OKF/`about:`/never-write-`verified` paragraph
  - `AiPanel.tsx:728` — the M17.20 trust-weighting paragraph
- `buildSystemPrompt` takes `capabilities: string[]`. The fragment is emitted only
  when `knowledge` is present.
- The **panel assistant keeps it** — the human-facing assistant's behavior does not
  change in this slice.
- `useJobRunner` passes `agent?.capabilities ?? []`, so an Agent record gets the
  fragment only if it declares it.
- **No demo-vault edit is required.** An undeclared `capabilities:` parses to empty,
  so `release-scout.md` stops being told it maintains `knowledge/` by absence, not by
  an edit. The corpus stays byte-identical and the 9 `Release scout` assertions in
  `e2e/agent.spec.ts` are untouched.

### M34.1.4 — unattended instructions ride the system prompt

- `agentRunPrompt` stops folding the record's body into the user message for
  **useJobRunner runs only**: `systemPrompt: buildSystemPrompt(…) + record body`,
  delivered via the existing `--append-system-prompt` path (`mod.rs:626`). No wire
  change. Rationale: instructions are *standing*, not *this turn's request*, and an
  unattended run is a fresh session every time.
- **Attended addressed turns keep M33b.6's user-message preamble, deliberately.**
  One conversation can address different agents per turn, and `--append-system-prompt`
  is per-SESSION — a resumed session cannot swap its system prompt mid-conversation.
  `addressedAgentPrompt` (`prompts.ts:278`) is the right shape there; do not "fix" it.

### M34.1.5 — chat with a named agent — **DELIVERED by M33b.6** (`d841901`)

Built by the concurrent session while this spec was in review, as mention-addressing
rather than a picker: a turn addressed to an agent passes `actor`, `scope`,
`connectorNames`, an intersected `allowedTools` (`narrowTools`, never union), and a
shell ceiling. `runs.actor` populates; the fleet reads it. M33b.5 added
stop-without-delete; M33b.1–.4 rebuilt the fleet surface and made background
concurrency a setting. Nothing left to build here — this phase is now a
verification-only checkpoint: confirm the M34.1.1 grant change composes with
addressed turns (the intersected allowedTools must reach the grant, not just argv).

### What slice 1 delivers

- `allowed-tools:` stops being advice and becomes the boundary its own comments claim.
- Two agents visibly behave differently. That is the platform, minimally.
- The knowledge system becomes a thing you can **open, read, edit, chat with, and see
  the cost of** — instead of ambient behavior with no address.

---

## 5. Invariants this slice must not break

Drawn from AGENTS.md; each has live tests.

1. **Store-layer error invariant (human-UI actions only).** The agent picker and chat
   send are human actions: catch, `toast()`, return `null`/`false`. Never throw.
2. **Proposal channels stay exempt and stay typed.** Nothing in this slice touches
   `SubmitResult`, but any future agent-invocation channel must return
   `applied | queued | rejected {code, rule, expected, actual}` and never collapse a
   queued HIGH-risk mutation into `null`.
3. **Absent is never zero; a failed read is never the empty state.** The agent picker
   with no agents says "no agents yet"; a picker that *failed to read* renders
   `section-unavailable`. Asserted in 10 files today.
4. **`null` ≠ `[]`** on `scope`, `allowedTools`, `connectors`. Null is unrestricted;
   empty is nothing. `agents.ts:40-52` documents why, and M34.1.1 depends on it.
5. **Mock parity is tested.** `src/lib/mockIpc.ts` (62 exports vs 92 Tauri commands)
   and `src/agent/mockAgent.ts` mirror every Rust guard. A new command without a mock
   twin makes e2e go **dark** rather than fail loudly.
6. **A retired workaround's comment dies with it.** M34.1.1 kills one. Budget for
   more: the comment a change falsifies is rarely the comment the change is about.
7. **Ratchets only tighten.** Coverage floors are lines/statements 78, functions 73,
   branches 82 (`vite.config.ts:60-65`); M33.9 measured 79.42 / 83.38 / 74.74 / 79.42
   — roughly 1.4–1.7 points of headroom.

---

## 6. Testing and blast radius

### Files touched

`src-tauri/src/lib.rs` · `src-tauri/src/mcp.rs` (test only) · `src/agent/systemPrompt.ts` (new) ·
`src/agent/AiPanel.tsx` (+test) · `src/agent/useJobRunner.ts` (+test) ·
`src/agent/useAgentChat.ts` · `src/agent/mockAgent.ts` · `src/lib/prompts.ts` (+test) ·
`src/engine/agents.ts` (+test)

`src/lib/prompts.test.ts` asserts `agentRunPrompt`'s current shape in three places
(`:17`, `:31`, `:121`) — M34.1.4 changes that shape deliberately, so those are the
test edits the phase is *about*, not collateral.

### Deliberately NOT touched

| Surface | Why it stays out |
| ------- | ---------------- |
| `Rail.tsx` / `Rail.test.tsx` | `Rail.test.tsx:59-69` asserts the exact nine labels in DOM order plus three negatives |
| `getByTestId('sidebar-type')` | **All 100 Playwright tests block on it at boot** (`e2e/boot.ts:53` + 3 hand-rolled copies) |
| `Selection` union | 28 unit files build Selection literals (272 lines); 19 drive `navStore` directly |
| `navigate` MCP tool | Hard-codes `home \| inbox \| knowledge \| docs \| view` (`mcp.rs:827-834`) — changing it is an MCP **schema** change with a mock twin and a parity test |
| Any new MCP tool | `src/engine/tools.test.ts` **regex-scrapes `mcp.rs base_tools()`**. The suite is red right now for exactly this class of change |
| `lane_registry` | Closed FK set, seeded once (`schema.rs:519`). A new agent lane is a migration |

### Test plan per phase

- **M34.1.1** — Rust: ungranted-tool refusal under `Some([...])`; unrestricted under
  `None`. TS: `mockAgent` twin.
- **M34.1.2** — existing `AiPanel.test.tsx` and `useJobRunner.test.tsx` pass unchanged
  after the mock re-points. If they don't, the move wasn't pure.
- **M34.1.3** — `systemPrompt.test.ts`: fragment present with `capabilities: ['knowledge']`,
  absent without. Grep the 5 e2e refs to Release scout.
- **M34.1.4** — assert the record body lands in `systemPrompt`, not `message`.
- **M34.1.5** — picker renders agents; selecting one puts `actor` on the run;
  `AgentDossier` shows the attended run. Failure path renders `section-unavailable`,
  not empty.

### Gate

`pnpm lint && pnpm typecheck && pnpm test:run` on every commit; `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test` on the Rust phases.
`lsof -iTCP:5173 -sTCP:LISTEN` before any e2e run — `reuseExistingServer` silently
adopts another worktree's app and produces confident, wrong failures. **Never
`--no-verify`.**

### Blocking prerequisite — RESOLVED

The red tree this section originally described was the concurrent session's in-flight
M33a/M33b work; it landed and the branch is green at `1e97866` (which also raised the
coverage ratchet to what M33a/M33b earned). M34.1 builds on top of it.

---

## 7. Roadmap after slice 1

Each is a separate spec. Ordering reflects dependency, not appetite.

**Folded in from the design work (`docs/examples/cerebro-ds`, 2026-08-20).** The
prototype settled six decisions this roadmap now assumes:

1. A chat turn that writes IS a run — already true; every turn books a `runs` row.
2. A handoff condition is a **sentence** the agent interprets (the `ask:` precedent),
   never a second expression grammar.
3. Handoffs run in **series only**.
4. The hop budget is **fixed at two, in code** — enforcement, not configuration.
5. A runaway chain is stopped by the **root run's ceiling**; hops bill to the root
   (`parent_run_id` is the migration that makes both true).
6. "Ask me first" **reuses the queued-proposal review queue** — one queue, two doors;
   a second queue is a defect.

It also surfaced three obligations the milestones below absorb: **read scoping**
(the prototype draws "Can read / No access"; only writes are enforced today —
`get_note`/`search_notes` are unscoped), **run-state honesty** (wrote-nothing /
found-nothing / could-not-tell are three sentences, and a late run says how late),
and **new agents arrive paused with triggers off**, so nothing fires by surprise.

| Milestone | Sub-project | Gist |
| --------- | ----------- | ---- |
| **M34.2** | Durable schedules + honest runs — **DELIVERED 2026-08-20** (plan: `plans/2026-08-20-m34.2-durable-schedules.md`), with three recon corrections: no `lane_registry` migration was needed (the lanes have been seeded since M25); `jobQueue`/`parseSchedule`/`diffEntries` stay TS as pure derivations — what moved to Rust is the STATE (`job_ledger`, schema v16, claim/unclaim semantics) and the ACCOUNTING; and the lease reconciliation is that the job runner became a `dispatch::claim` client, so schedules and ingest share one budget, one concurrency ceiling, one deferral record. | Honest runs landed in M34.2.1 (could-not-tell rows, `dueAt`, late-is-not-failed); M34.2.2–.4 delivered the durable claim table, the hydration-gated queue with one-time localStorage import, and unattended runs booking `mode=ambient` on their real lane behind the gate — a deferral is a typed answer that surrenders the fire key. |
| **M34.3** | Handoffs — agent invokes agent (scope-checked 2026-08-20: call_tool already holds an AppHandle at mcp.rs:1259 and run_agent is a plain fn a tool can invoke, so the spawn plumbing exists; what remains is the parent_run_id migration, hop depth in the grant, cycle refusal, and the §8.3 accounting answer, which blocks the budget half) | Moved up from last: it is the centerpiece of the settled design. A run-starting MCP tool; series only; two hops fixed in code, a cycle refuses and names the agent it refused; `parent_run_id` migration so hops bill to the root and the root's ceiling gates the chain; a paused agent cannot be called and the chain stops with it — enforced at the call, not the UI. |
| **M34.4** | Read scoping | `get_note` / `search_notes` / `knowledge_about` / `list_inbox` honor the grant. Until this ships, every surface that draws "Can read" says reads are unscoped — the prototype already carries that footnote; the code catches up to the drawing, not the other way around. |
| **M34.5** | Sources are the knowledge — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m34.5-sources-are-the-knowledge.md`), and recon corrected three of the four claims: the connector UI has existed since M13.3 (`ConnectorSettings.tsx`; headers/env stay file-edited BY DESIGN — credentials never enter cerebro); `cache_source` never wrote under `knowledge/` (`sources/` is top-level on both sides); and every `is_knowledge_path` site belongs to the guard itself, to M35's relocation (okf.ts + the knowledge components + the agent's own tools), or to M36's capture-gate move — no generic surface routes on the string. | What was real and shipped: `sourceFreshness` (engine/ingest.ts, gated on the fetch-bookkeeping PROPERTIES, never `type: Source`) and the detail panel's freshness line — stale-since / fresh-until / **no refresh date set** (absent ≠ fresh) / **fetch not recorded** (absent ≠ zero); plus the noticed-not-pushed loop pinned by test: a refreshed copy's write is an ordinary VaultEvent and `when: changed in sources` wakes the watching agent, at app pace, behind the budget gate. |
| **M35** | Knowledge as agent #1 — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m35-knowledge-as-agent.md`) | The knowledge agent SHIPS: `demo-vault/records/agents/knowledge.md`, the first consumer of `capabilities: knowledge` (M34.1.3), with `scope: []` because its only doors are the guarded `write_concept`/`cache_source`. The tab names its maintainer — a byline resolved by CAPABILITY, never slug or title; no record → the anonymous label stands. Declarations: the three constructs are **permanently internal** (recorded on `CONSTRUCT_ACTORS` — records would hand vault frontmatter the steering of machinery the vault must not steer); `okf.ts` is already the private read model (its importers are the knowledge components and lanes — nothing to move); the eight parked tables STAY parked, a consumer licenses a revival. The physical relocation (tab → agent detail page) moves to **M37** deliberately: relocating now and again when the shell flattens would churn the same 7/13 e2e specs twice for one outcome. |
| **M36** | Governance per agent — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m36-governance-per-agent.md`), with two corrections and two named deferrals | Corrections: the escalator ALREADY shipped (`target_has_attestation → floor HIGH`, policy.v3 since M27.4), and "new agents default paused" was half-true (inert-by-absence, now an explicit `paused: true` at birth — activation is two acts, and the duty toggle is the way back). Delivered: the AgentEditor read-scope row + the prompt stating the read boundary (both halves of the M34.4 deferral); the consequence table on armed agents (*applies on its own / queues for you / locked — people only* + the escalator sentence), counts derived from the SHARED artifact; and the root-ceiling chain gate (`dispatch::refuse_if_chain_spent` — a chain that spent the per-run ambient ceiling gets no further hops, refused at the spawn). Deferred, named: the per-agent risk OVERRIDE is a policy-table axis (goldens + conformance on both sides — a session of its own, and a code path beside the table would be the twin-implementation defect); the capture-gate re-keying is a no-op until a second governed surface exists. |
| **M37** | Shell flattening — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m37-shell-flattening.md`) | M37.2 spent the locked names as LABELS (**Base**, **Work**; the `knowledge`/`workspace` selection kinds stay — internal vocabulary shared with the `navigate` MCP tool). M37.3 flattened rail + contextual sidebar into ONE nav column: vault header, search, nine destination rows keeping the rail's a11y contract, Collections + Types inline, Docs tree / Base rows nested under their destination while current (the M35 relocation), chrome at the foot. The SIDEBARLESS set retired — collapse is the escape hatch. `Rail.test.tsx`'s nine-name contract moved whole into `Sidebar.test.tsx`; `rail`/`rail-badge` became `nav-surfaces`/`nav-badge` across 8 specs; nested trees sit OUTSIDE the destination containers because folder rows share accessible names with destinations. The 89 type-vocabulary occurrences were never M37's — they are M39's. |
| **M38** | Everything is a page — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m38-everything-is-a-page.md`, which re-enumerates the enforcement points as recon found them) | The correction that scoped it: the peek does not die — the WALL does. "Open in full page" landed in the peek header (the deliberate absence and its M12.1 comment died together); DocPage renders a record with the panel's own RecordProperties and a backdrop crumb; useOpenPath keeps peek-as-default as a DEFAULT, not a law. The Docs surface deleted: the Pages tree (docsOnly FileTree + its New page/folder) stands in the nav on every surface, the `docs` Selection kind and the navigate tool's `docs` vocabulary are gone, old persisted docs anchors deliberately fail isPlace, and the partition helpers (isDocEntry & co) survive as descriptions of content rather than routing prohibitions. |
| **M39** | Types → databases — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m39-types-are-databases.md`) | The recon correction that scoped it: the 89 counted occurrences are the INTERNAL vocabulary — the `type:` frontmatter key (the on-disk files-first contract), the `Type` metamodel, `TypeListing`, the `type` selection kind — and none of it can move without breaking every existing vault. So M39 is the M37.2 split again: LABELS spend (**Databases** section, `New database` / `Delete database`, dialog copy and toasts), kinds stay. `libraryKind`'s type-NAME routing survives by not being touched. Deliberately unchanged, recorded in the plan: the Inbox's "Has a type" and the adopt-schema copy name the literal `type:` key they edit. |
| **M40** | Studio — **DELIVERED 2026-08-21** (plan: `plans/2026-08-21-m40-studio.md`) | Two recon facts bound v1: the vault WRITES MARKDOWN (no path creates an index.html, for app or agent), so a prototype is a folder of pages under `studio/` previewed rendered — the artifact Studio builds is the artifact the vault can hold; and the chat rail already exists — the Assistant panel with its `askAgent` seam IS the rail, seeded at the prototype's folder (a second transcript surface would be the two-chromes defect). Shipped: `engine/studio.ts` derivation, the `studio` selection kind (project = subject, previewed page = lens), the Studio destination seated with Work (the contract returns to nine), and StudioPage — empty bench, New prototype, live ConceptBody preview (a write rescans, the body refetches), Build-with-the-assistant. The `navigate` tool deliberately does not learn `studio` in v1: agents reach the folder by path. |

**Parked, explicitly:** R1–R14 deferral gates stay fired and dated — a firing licenses
a plan, never code. The knowledge-shaped `runtime.db` tables (`coverage_cache`,
`coverage_dimension_cache`, `attention_signals`, `maintenance_findings`,
`working_memory_manifests`, `source_taint_assessments`, `convergence_runs`,
`parked_promotions`) stay in place, unread, until M35 decides their fate. Six of the
seven ambient deterministic phases park; Source Monitor survives because M34.3 needs it.

---

## 8. Open questions

1. **`capabilities:` vocabulary.** M34.1 needs exactly one value (`knowledge`).
   Should the list be validated against a shipped artifact the way
   `concept-types.v1.json` is, or stay free text until there are three of them?
   *Recommendation: free text in M34.1, artifact when the second one lands.*
2. **The panel assistant's identity.** After M34.1.5, is the default unnamed
   assistant its own Agent record shipped in the vault, or a built-in with no file?
   *Recommendation: built-in for M34.1 — making it a record is an M35 question,
   since it changes what a fresh vault contains.*
3. **Attended vs ambient accounting.** `dispatch.rs:605` books every renderer-started
   run as `mode='attended', lane='agent'`, so scheduled Agent records are metered but
   never budget-gated. No test defends this. Is it intent or an accounting gap?
   Answering it is a prerequisite for M34.2, not M34.1.
   **ANSWERED (M34.2.4): a gap.** An unattended run that names its lane now claims a
   zero-item dispatcher lease and finalizes `Mode::Ambient`; attended chat stays
   metered-never-gated. The test that defends it is
   `an_unattended_schedule_run_books_ambient_on_its_own_lane_and_settles_the_budget`.
