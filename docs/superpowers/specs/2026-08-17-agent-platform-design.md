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

### M34.1.4 — instructions ride the system prompt

- `src/lib/prompts.ts:215` `agentRunPrompt` stops folding the record's body into the
  user message.
- `useJobRunner` sets `systemPrompt: buildSystemPrompt(…) + record body`, delivered
  via the existing `--append-system-prompt` path (`mod.rs:626`). No wire change.
- Rationale: instructions are *standing*, not *this turn's request*. Folding them
  into the user message means a multi-turn agent re-reads its own charter as if the
  user had just typed it.

### M34.1.5 — chat with a named agent

- `AiPanel` gains an agent picker sourced from `listAgents(entries)`
  (`src/engine/agents.ts:161`). Default is the unnamed assistant — existing behavior
  is the default, not a migration.
- `useAgentChat.ts:321-336` passes `actor`, `scope`, `connectorNames` and the agent's
  `capabilities`-built `systemPrompt` through the existing `RunOptions` fields.
- Consequence, free: attended runs gain identity → `runs.actor` populates →
  `AgentDossier` and `FleetSection` light up with **no new code**, because both
  already join on the actor string.

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

### Blocking prerequisite

The tree is **red** and being edited by a concurrent session:

- `src/library/LibraryPage.test.tsx:216` asserts the read toolset's exact allowed-tools
  list; `knowledge_about` was added at `src/engine/tools.ts:55` without updating it
- `src/app/Sidebar.tsx:263` has a JSX parse error (bare comment as a ternary branch) —
  `tsc` reports TS1005/TS1382/TS1381
- HEAD advanced `0febd5c → 8326eaf` mid-recon; 16 files modified, 3 untracked

Because one red test suppresses the whole coverage report, "are we still above the
floor?" is currently unanswerable. **M34.1 starts from green, on a branch off a green
commit.**

---

## 7. Roadmap after slice 1

Each is a separate spec. Ordering reflects dependency, not appetite.

| Milestone | Sub-project | Gist |
| --------- | ----------- | ---- |
| **M34.2** | Durable schedules | Move `jobQueue` / `parseSchedule` / `diffEntries` and three localStorage ledgers into Rust. Catch-up on launch, marked LATE (D3). Needs a `lane_registry` migration and reconciliation with `ambient.rs`'s single lease. |
| **M34.3** | Sources are the knowledge | Connector setup UI (today: hand-edit `connectors.json`). Promote `cache_source` records out of `knowledge/`. Source Monitor surfaces staleness on the source record. This is where `is_knowledge_path`'s 8 leak sites get addressed. |
| **M34.4** | Agent invokes agent | The first genuinely new capability. Needs a run-starting MCP tool, a depth/cycle bound, and a cost-attribution decision (child run charged to whom?). |
| **M35** | Knowledge as agent #1 | The Knowledge tab relocates to the knowledge agent's detail page. `okf.ts` becomes its private read model. The Rust constructs (`agent:m26-*`) either become Agent records or are declared permanently internal. |
| **M36** | Governance per agent | The ledger capture gate moves off `is_knowledge_path`. Risk thresholds become agent settings. |
| **M37** | Shell flattening | Rail → one Notion sidebar. Blast radius: `Rail.test.tsx`, 7/13 e2e specs, the `navigate` MCP tool's surface vocabulary. |
| **M38** | Everything is a page | Delete the Docs surface. Nine enforcement points identified in recon, incl. the *deliberate absence* of "Open in full page" (`DetailHeaderActions.tsx:26-31`). |
| **M39** | Types → databases | 89 occurrences of `type: 'Type'` across 42 files; `libraryKind`'s type-NAME routing (`library.ts:99-104`) must survive or Agents/Skills fall back to generic property editors. |

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
