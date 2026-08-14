# M33 — The status hub, the fleet made visible, and agents with dossiers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the four status-shaped surfaces (Needs review, Background,
Epistemic status, Knowledge) into two — one Status hub plus Knowledge — and give
every LLM run and every Agent record a persistent, visible history backed by the
runtime DB the app already writes.

**Architecture:** Rust gains one new read module (`runtime/fleet.rs`) over
existing runtime tables plus one additive schema step (`runs.actor`). The
renderer folds `ReviewPage` and `PipelinePage` into `EpistemicStatusPage` as
full sections, deletes their rail buttons, and adds a fleet-activity section
with per-run detail and per-agent run history in `AgentEditor`. No new
epistemic objects, no new stores of truth — the vault stays canonical for
agent identity; SQLite stays the operational record.

**Tech Stack:** Rust (Tauri 2, rusqlite), React 19 + Zustand, vitest,
Playwright, existing mock-IPC parity layer.

---

**Brief for the agent picking this up cold.** Written 2026-08-14 out of a
deep-read of two reference products — scape.work (Argus orchestrator, per-run
cost chips, "the audit feed is a queryable table the user owns") and the
vendored `docs/examples/munder-difflin-main` (agents-as-files, archived never
deleted, context-push on resume) — against this branch. The adopted decisions,
in the owner's words: agents must not be invisible to the user, run history
must persist, and the needs/background/epistemic/knowledge tabs collapse to
"one or two things max." The owner chose the **Status hub + Knowledge** shape:
Needs review and Background merge INTO the Epistemic status page; Knowledge
stays its own surface.

What M33 is NOT (settled during research, defend these):

- **No personas for the internal constructs.** Ingest, maintenance, and
  assembly stay batched runs (D6). The fleet UI shows their run *history*;
  it never presents them as standing agents. M26's name-discipline trap
  applies: a face implies memory and judgment a construct does not have.
- **No agent-writable SQLite tables** (the scape "Tables" feature). An agent
  writing rows the vault cannot see bypasses the proposal layer. Agents that
  want structured rows propose into markdown collections via existing M24 ops.
- **No LLM-auto-answering of permission gates** (scape watchdogs). The
  proposal/review layer is categorically stronger; nothing here weakens it.
- **No new reader for `ledger/index.rs`.** The fleet UI reads `runtime.db`,
  not the ledger index. M31.7's README verdict on the index stands untouched
  by this milestone — do not cite M33 as its missing reader.
- **No Knowledge changes** beyond what the rail refactor mechanically touches.
  KnowledgeNav, the OKF bundle, chips, and `knowledge.spec.ts`'s axis
  assertions are out of scope.
- **No reconciliation with origin/main's shell.** M30's workspace surfaces
  (`src/workspace/` — RootTree, EditorGroups, TabBar) and M32's Track B git
  UI live only on main; this plan's rail map describes the branch. The
  eventual branch↔main merge reconciles the two shells and is its own piece
  of work (the same boundary M31 draws with "no rebase onto current main"
  and M32 draws by building on main).

**Read before touching anything**, in this order:

1. `AGENTS.md` — house rules. The ones that bite here: store-layer never-throw
   is HUMAN-UI ONLY and typed refusal channels are exempt; the mock backend
   mirrors every Rust-side guard, tested; ratchets only tighten; no type
   special-casing (the dossier is capability-gated, never `if agent`).
2. `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md` — the living
   handoff. **Update it in the same commit as every phase.**
3. `docs/superpowers/plans/2026-08-12-cerebro-m31-claims-and-records.md` —
   M33's hard prerequisite (see below).

## Prerequisite: M31 must be executed first

M33 goes on `m22-m28-convergent-intelligence` AFTER M31 lands. It consumes,
by name:

- **M31.2a** — one run, one id: the grant, meter, proposals, and answers all
  join on `ledger::new_run_id()`. The fleet detail view joins on that id.
- **M31.2b** — per-name loopback tool-call counts (drained by the attended
  assembly path into `record_from_assembly`).
- **M31.5/M31.6** — the schema step with the `estimated` flag and
  assembly-latency column, and the production writer for
  `run_cost_components` + `assembly_metrics` on the attended path.

Degradation rule (M31's own): **absent is never zero.** A run with no cost
rows renders "not recorded", never $0 or 0 calls. Every fleet surface in this
plan must render honestly for pre-M31 rows and for ambient runs M31.6 does
not cover.

**Schema-version chain, settled by the 2026-08-14 alignment pass:** this
tree's `runtime/schema.rs` is at `USER_VERSION = 11` — V11 is M28.0b's
trigger tables (`schema.rs:996-1018`, commit `e826a93`), which landed AFTER
the M31 plan's Rev 2 verification. The M31 plan has been amended in place:
its M31.5 step is now **`SCHEMA_V12`**. M33's step below is written as
`SCHEMA_V13` on that basis — **verify at start that M31 landed exactly V12
(its trap says overflow goes to V13 and gets noted in the handoff doc; if
that fired, M33 takes the next free number). Never edit a committed
migration.**

---

## Where things stand (verified 2026-08-14 at `b6dbb8a`, M28.0h — refs drift, re-verify)

M28.0a–h are on the branch (trigger-registry substrate: the two V11 tables,
extractors, evaluation seams — no UI, no IPC). M31 executes next, then M33.
Anchors below predate M31's edits to `lib.rs`, `meter.rs`, `mcp.rs`, and
`assembly/ask.rs` — re-verify each at phase start.

**Navigation.** No router: a `Selection` union (`src/engine/types.ts:175-219`,
16 arms) in `src/stores/navStore.ts`, rendered by `CanvasOutlet`
(`src/App.tsx:94-129`). The rail (`src/app/Rail.tsx:72-212`) has 11 buttons;
`src/app/Sidebar.tsx:56` holds `SIDEBARLESS = {settings, pulse, inbox,
library}`. The four surfaces in play:

| Rail label | Selection kind | Page | What it shows |
| --- | --- | --- | --- |
| Needs review | `review` | `src/pages/ReviewPage.tsx` (273 lines, no unit test) | M24 review cards + revertables, via `ipc.reviewQueue`/`revertableApplications`; ledger reduce per call |
| Background | `pipeline` | `src/pages/PipelinePage.tsx` (283 lines, no unit test) | `ipc.pipelineOverview` → `runtime::surface::overview`: budget meter, lane toggles, banners, held piles, and a 50-row `runs` activity table (`surface.rs:207`, not clickable, no run detail) |
| Epistemic status | `status` | `src/pages/EpistemicStatusPage.tsx` (337 lines + 214-line unit test) | Four independent `Feed<T>` sections: converge changes, attention lanes, **a count-and-door to `review`** (`:202-226`), **a two-line door to `pipeline`** (`:231-268`) |
| Knowledge | `knowledge` | `src/pages/KnowledgePage.tsx` | OKF bundle + belief chips — NOT touched by M33 |

The status page is already the hub: two of its four sections are doors to the
two tabs being merged. The merge replaces doors with bodies.

**Run persistence.** `runs` (SCHEMA_V3, `runtime/schema.rs:206`) is live and
rich — run_id, vault, mode, lane, started/ended, 7-value outcome,
usage_state, 4 token columns, proposals_submitted/applied/rejected — but has
**no `actor` column**: nothing attributes a run to the Agent record that
launched it. `AgentRequest.actor` (`process:<slug>`) exists and reaches
`run_token` (`lib.rs:685`) but never reaches the Meter
(`src-tauri/src/agent/meter.rs:52-67`) or the two `INSERT INTO runs` sites
(`runtime/dispatch.rs:180`, `:575`).

**Run history UI today**: `src/agent/RunList.tsx` (a StatusBar popover) over
`uiStore.runs` + `src/engine/runLog.ts` — a localStorage log (`cerebro.runLog`,
cap 200) that shares nothing with the `runs` table, not even an id.

**Governance tables** (`run_cost_components`, `assembly_metrics`,
`resolver_outcomes`) are schema-complete with write APIs at
`governance.rs:125/225/273`; M31.6 gives the first two their attended-path
writer. `coverage_cache`/`coverage_dimension_cache` are dead (zero writers,
zero readers) — noted, not M33's to delete.

**IPC gaps**: no command queries `runs` beyond `pipeline_overview` (top-50,
all vaults, no filters, no detail); nothing serves cost components, metrics,
or per-actor history. Mock parity convention: types declared in
`src/lib/mockIpc.ts`, re-exported from `src/lib/ipc.ts`; every e2e-driven IPC
needs a `window.__cerebroSeed*` seam.

**Agent records**: markdown files; frontmatter per `src/engine/libraryDraft.ts`
(`AgentDraft` `:78-95` — slug, scope, allowed-tools, connectors,
tools safe|shell, schedule, when-triggers, preferences). "Active" is derived,
never stored (`:142`). Editor: `src/library/AgentEditor.tsx` (461 lines).
Runner: `src/agent/useJobRunner.ts` → `agentIpc.runAgent` → `run_agent`
(`lib.rs:668`).

**e2e exposure** (all use `boot` from `e2e/boot.ts`; clock pinned to
`VAULT_TODAY='2026-07-28T12:00:00Z'`):

- `e2e/status.spec.ts` (7 tests) — highest churn; `:210` asserts the review
  section is *a door, not a second copy* — that assertion inverts here.
- `e2e/pipeline-surface.spec.ts` (7 tests) — retargets to hub sections; the
  `:105` activity test is replaced by the fleet section's.
- `e2e/review.spec.ts` (5 tests) — same cards, new home.
- `e2e/knowledge.spec.ts:148` — asserts the rail carries no review badge;
  re-verify after the rail edit.
- `e2e/smoke.spec.ts`, `Rail.test.tsx`, `Sidebar.test.tsx`,
  `navStore.test.ts`, `EpistemicStatusPage.test.tsx` all churn mechanically.

---

## Four rules that must survive contact with implementation

**The vault is the agent registry.** Agent identity, mission (the record
body), schedule, and tools live in frontmatter. SQLite stores runs and joins
them to an agent by `actor` string — it never stores a second copy of agent
config. A `registry`-style table would be the twin-inventory defect.

**Absent is never zero.** Pre-M33 runs have `actor = NULL` ("unattributed"),
pre-M31.6 runs have no cost rows ("not recorded"), `usage_state != 'exact'`
renders "unknown". No backfill, no guessed attribution, no $0 placeholders.

**A door that becomes a body loses its door test in the same commit.** Every
merged section inverts the old count-and-door assertions when the body lands,
never after. The `Feed<T>` three-state contract (loading | unavailable |
ready) extends to the merged bodies: `ReviewPage.tsx:64` and
`PipelinePage.tsx:92` currently collapse "unavailable" into "empty" — the
merge FIXES that to match `status.spec.ts:141`'s standard, not the reverse.

**Read model, not a second truth.** `fleet.rs` only SELECTs. It computes no
new facts, caches nothing, and every aggregate it serves (lifetime tokens,
run counts) is recomputable from the rows it reads. If a number needs a new
fact recorded, that is a Meter/governance change, not a fleet query.

---

## Phases

One commit per phase, `type(scope): sentence (M33.n)`. Gate green per phase
(commands at the bottom). **Every phase's Files list includes the handoff
doc.**

### M33.0 — Commit this plan

```sh
git add docs/superpowers/plans/2026-08-14-cerebro-m33-status-hub-fleet.md
git commit -m "docs(plan): M33 — status hub, visible fleet, agent dossiers (M33.0)"
```

---

### M33.1 — Runs learn who ran them

The `actor` column plus the threading from spawn site to insert. Nullable by
design: ambient constructs pass their lane-derived actor
(`construct:ingest` etc.), renderer runs pass the `AgentRequest.actor`
already minted (`process:<slug>`, `chat`), and history stays NULL.

**Files**
- Modify: `src-tauri/src/runtime/schema.rs` (new `SCHEMA_V13` const — see the
  version trap above; take the next free number)
- Modify: `src-tauri/src/runtime/mod.rs` (`MIGRATIONS`, `USER_VERSION`,
  `EXPECTED_V*_TABLES` smoke test)
- Modify: `src-tauri/src/agent/meter.rs` (`Meter` gains `actor`)
- Modify: `src-tauri/src/runtime/dispatch.rs` (both INSERT sites)
- Modify: `src-tauri/src/lib.rs` (`run_agent` passes `request.actor` into the
  Meter at `:690`)
- Modify: `src-tauri/src/ingest/spawn.rs`, `src-tauri/src/maintain/live.rs`,
  `src-tauri/src/assembly/live.rs` (each names its construct actor)
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Write the failing test** (in `runtime/dispatch.rs`'s existing
  `mod tests`, mirroring its fixture style):

```rust
#[test]
fn a_run_records_its_actor_and_null_stays_null() {
    // M33.1 — attribution is recorded at insert, never backfilled. An old
    // row (actor NULL) renders "unattributed", which is the truth.
    let db = test_db();
    let meter = test_meter_with_actor(Some("process:weekly-digest"));
    begin_run(&db, &meter);
    let actor: Option<String> = db
        .query_row("SELECT actor FROM runs WHERE run_id = ?1",
                   [&meter.run_id], |r| r.get(0))
        .unwrap();
    assert_eq!(actor.as_deref(), Some("process:weekly-digest"));
}
```

- [ ] **Step 2: Run it** — `cd src-tauri && cargo test --lib runtime::dispatch`.
  Predicted failure: COMPILE ERROR (`Meter` has no `actor` field; the helper
  does not exist). Normal for this plan's test-first steps.

- [ ] **Step 3: The migration.** Append the next `SCHEMA_V*` const:

```rust
/// M33.1 — runs learn who ran them. Nullable: rows from before this step
/// are unattributed and stay that way (absent is never zero, and a guessed
/// attribution is a lie in a table whose whole job is honesty).
pub const SCHEMA_V13: &str = "
    ALTER TABLE runs ADD COLUMN actor TEXT;
    CREATE INDEX runs_by_actor ON runs (actor, started_at);
";
```

Register in `MIGRATIONS`, bump `USER_VERSION`, extend the post-migration
smoke test (the `EXPECTED_V*_TABLES` pattern at `runtime/mod.rs:146+` — this
step adds a column, so assert `SELECT actor FROM runs LIMIT 0` is queryable).

- [ ] **Step 4: Thread it.** `Meter` gains `pub actor: Option<String>`; both
  `INSERT INTO runs` column lists gain `actor`; `lib.rs:690` passes
  `request.actor.clone()`; the three internal spawn sites pass
  `Some("construct:ingest".into())` / `"construct:maintenance"` /
  `"construct:assembly"` (string literals beside a shared
  `pub const CONSTRUCT_ACTORS` doc comment in `meter.rs` naming all three, so
  the fleet UI's filter list and these sites cannot drift — the M31
  no-twin-inventory rule applied to actor names).

- [ ] **Step 5: Gate, handoff, commit**

```sh
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
git add -A && git commit -m "feat(runtime): runs carry their actor, nullable and never backfilled (M33.1)"
```

**Acceptance:** new runs carry the actor their spawn site declared; the three
constructs are attributed; old rows stay NULL; migration smoke test green.

---

### M33.2 — The fleet read surface (Rust + IPC + mock parity)

One new module that only SELECTs, two new commands.

**Files**
- Create: `src-tauri/src/runtime/fleet.rs`
- Modify: `src-tauri/src/runtime/mod.rs` (`pub mod fleet;`)
- Modify: `src-tauri/src/lib.rs` (register `fleet_runs`, `fleet_run_detail`)
- Modify: `src/lib/ipc.ts`, `src/lib/mockIpc.ts` (facade + mock +
  `__cerebroSeedFleet` seam)
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Failing Rust tests** (in `fleet.rs`'s own `mod tests`, fixture
  style from `runtime/surface.rs` tests):

```rust
#[test]
fn fleet_runs_filters_by_actor_and_orders_newest_first() {
    let db = seeded_runs(&[("r1", Some("process:digest")), ("r2", None),
                           ("r3", Some("process:digest"))]);
    let page = runs(&db, &Filter { actor: Some("process:digest".into()),
                                   ..Filter::default() }).unwrap();
    assert_eq!(page.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(),
               vec!["r3", "r1"]);
}

#[test]
fn detail_without_cost_rows_is_absent_not_zero() {
    let db = seeded_runs(&[("r1", None)]);
    let d = run_detail(&db, "r1").unwrap();
    assert!(d.cost_components.is_none(), "no rows means not recorded");
    assert!(d.assembly.is_none());
}
```

- [ ] **Step 2: Implement.** The types are the contract; serde-serialize
  camelCase like `surface.rs` does:

```rust
//! Fleet read model (M33.2). SELECT-only over runs and the governance
//! tables. Computes nothing the rows do not already say; a missing join is
//! `None`, never a zero (M31's measurement rule).

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub vault_id: Option<String>,
    pub lane: Option<String>,
    pub mode: Option<String>,     // 'attended' | 'ambient'
    pub actor: Option<String>,
    pub limit: Option<u32>,       // clamped to 200 server-side
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetRun {
    pub run_id: String,
    pub actor: Option<String>,
    pub vault_id: Option<String>,
    pub mode: String,
    pub lane: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub outcome: String,
    pub usage_state: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub proposals_submitted: u64,
    pub applied: u64,
    pub rejected: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: FleetRun,
    /// None = no rows recorded for this run (pre-M31.6, or ambient).
    pub cost_components: Option<Vec<CostComponentRow>>,
    pub assembly: Option<AssemblyMetricsRow>,
}
```

`runs()` builds one WHERE clause from the present filters, `ORDER BY
started_at DESC LIMIT ?`; `run_detail()` is three queries joined on the one
id (`runs`, `run_cost_components`, `assembly_metrics`), each optional join
mapped empty→`None`. Per-agent aggregates (`lifetime` — run count, token
sums, last outcome) are one `GROUP BY` helper `actor_summary(db, actor)` used
by M33.6; include it here with its own unit test asserting sums skip
`usage_state != 'exact'` rows into an explicit `unknown_runs` count rather
than adding zeros.

- [ ] **Step 3: Register + TS facade + mock.** Commands `fleet_runs(filter)`
  and `fleet_run_detail(run_id)` in `lib.rs` beside `pipeline_overview`
  (`:194`); `ipc.ts` re-exports the row types from `mockIpc.ts` per the house
  convention; mock returns seeded arrays with
  `window.__cerebroSeedFleet(rows, details)` following the exact shape of
  `__cerebroSeedPipeline` (`mockIpc.ts:1118`). A vitest parity test asserts
  the mock refuses an unknown run_id the same way Rust does (Err, not null).

- [ ] **Step 4: Gate, handoff, commit**

```sh
cd src-tauri && cargo test --lib runtime::fleet && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm test:run && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(fleet): SELECT-only run history and detail over runtime.db, with mock parity (M33.2)"
```

**Acceptance:** filtered, ordered run pages; detail joins that are absent
when unrecorded; both commands mocked with a seed seam; no writes anywhere in
`fleet.rs` (grep-clean of INSERT/UPDATE/DELETE).

---

### M33.3 — Needs review moves into the hub

The review cards become a full section of `EpistemicStatusPage`; the `review`
Selection kind and rail button die; the door test inverts.

**Files**
- Modify: `src/pages/EpistemicStatusPage.tsx` (door section → full body)
- Create: `src/status/NeedsYouSection.tsx` (the moved card list — extraction,
  not a rewrite: `ReviewPage.tsx`'s card body, approve/reject/revert handlers,
  and its reject-reason guard move verbatim)
- Delete: `src/pages/ReviewPage.tsx`
- Modify: `src/engine/types.ts:175-219` (drop the `review` arm; `status`
  gains `section?: 'needs' | 'lanes' | 'fleet' | 'changes' | 'system'`)
- Modify: `src/stores/navStore.ts` (nothing structural; its tests churn)
- Modify: `src/App.tsx:94-129`, `src/app/Rail.tsx` (button removed, 11 → 10),
  `src/app/Sidebar.tsx` (status stays sidebarless — add to `SIDEBARLESS` if
  the merge changes its classification; verify at `:56`)
- Modify: `e2e/status.spec.ts` (`:210` inverts: the section now contains
  cards, not a door), `e2e/review.spec.ts` (drives the hub section instead of
  the dead tab; keep the five behavioral tests — approve, reject-with-reason,
  revert — retargeted), `src/pages/EpistemicStatusPage.test.tsx`,
  `src/app/Rail.test.tsx`, `src/stores/navStore.test.ts`
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Retarget the e2e specs first** (they are the spec of record
  for the cards): in `review.spec.ts`, navigation becomes
  `rail → "Status"` + `getByTestId('status-section-needs')`; keep every card
  testid (`card-risk`, `approve`, `reject-reason`, `revert`) unchanged so the
  card extraction cannot silently drop behavior. In `status.spec.ts:210`,
  invert: assert the needs section renders `review-card` elements and NOT
  `review-summary`. Run `PORT=<free> pnpm e2e` — predicted RED on exactly
  those specs.

- [ ] **Step 2: Extract and mount.** `NeedsYouSection` owns the load
  (`ipc.reviewQueue` + `ipc.revertableApplications`) with the hub's
  `Feed<T>` three-state wrapper — the old `catch → empty` collapse at
  `ReviewPage.tsx:64` is replaced by `unavailable`, matching
  `status.spec.ts:141`'s standard. The hub renders it where the door was
  (`EpistemicStatusPage.tsx:202-226`). The section header carries the open
  count the door used to show.

- [ ] **Step 3: Kill the tab.** Remove the rail button (`Rail.tsx:126`), the
  `review` Selection arm, the `CanvasOutlet` case, and `ReviewPage.tsx`.
  Typecheck is the completeness check: every dangling
  `navigate({kind:'review'})` call site the compiler finds retargets to
  `{kind:'status', section:'needs'}`.

- [ ] **Step 4: Full gate (both suites), handoff, commit**

```sh
pnpm lint && pnpm typecheck && pnpm test:run
p=5473; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo "$p BUSY — pick another" || PORT=$p pnpm e2e
git add -A && git commit -m "refactor(status): review cards live in the hub; the review tab is gone (M33.3)"
```

**Acceptance:** all five review behaviors pass inside the hub; the rail has
10 buttons; `kind:'review'` no longer exists; unavailable ≠ empty for the
needs section.

---

### M33.4 — Background moves into the hub

Same operation for `PipelinePage`: budget meter, banners, lane toggles, held
piles become the hub's "System" section. The old 50-row activity table is
NOT moved — M33.5 replaces it.

**Files**
- Create: `src/status/SystemSection.tsx` (extraction of `PipelinePage.tsx`'s
  meter/banners/toggles/held-piles blocks and their three actions —
  `setGlobalPause`, `setLaneEnabled`, `resolveHeldItems`)
- Delete: `src/pages/PipelinePage.tsx`
- Modify: `src/pages/EpistemicStatusPage.tsx` (`SystemHealth` door `:231-268`
  → `SystemSection`), `src/engine/types.ts` (drop `pipeline` arm),
  `src/App.tsx`, `src/app/Rail.tsx` (10 → 9)
- Modify: `e2e/pipeline-surface.spec.ts` (retarget six of seven tests to
  `status-section-system`; DELETE the `:105` activity-row test with a comment
  pointing at M33.5's fleet spec), `src/app/Rail.test.tsx`,
  `src/stores/navStore.test.ts`, `src/pages/EpistemicStatusPage.test.tsx`
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1** — retarget specs first (as M33.3 Step 1; keep `budget-meter`,
  `pipeline-banner`, `lane-toggles`, `held-items` testids verbatim). RED.
- [ ] **Step 2** — extract, mount with `Feed<T>` (unavailable ≠ empty), kill
  the tab and the `pipeline` arm; compiler finds the stragglers
  (`EpistemicStatusPage.tsx:326`'s own overview call collapses into the
  section's).
- [ ] **Step 3** — full gate incl. e2e, handoff, commit:

```sh
git add -A && git commit -m "refactor(status): background controls live in the hub; the pipeline tab is gone (M33.4)"
```

**Acceptance:** rail has 9 buttons (Home, Status, Inbox, Docs, Knowledge,
History, Assistant, Library, Settings); every pipeline control works inside
the hub; `kind:'pipeline'` no longer exists; `knowledge.spec.ts:148` still
green.

---

### M33.5 — The fleet section: runs on screen, with detail

The hub's new activity surface over M33.2's IPC. This is the scape/Argus
"audit feed as a table the user owns" — status pill, actor, cost, outcome
per row; click for detail.

**Files**
- Create: `src/status/FleetSection.tsx`, `src/status/RunDetailPanel.tsx`
- Create: `src/status/FleetSection.test.tsx`
- Modify: `src/pages/EpistemicStatusPage.tsx` (mount as section `fleet`)
- Create: `e2e/fleet.spec.ts`
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Failing unit test** (vitest, mock IPC seeded):

```tsx
it('renders absent cost as "not recorded", never $0', async () => {
  seedFleet([run({ runId: 'r1', usageState: 'exact' })],
            { r1: { run: run({ runId: 'r1' }), costComponents: null, assembly: null } });
  render(<FleetSection vault={vault} />);
  fireEvent.click(await screen.findByTestId('fleet-row'));
  expect(await screen.findByTestId('run-detail')).toHaveTextContent('not recorded');
  expect(screen.queryByText(/\$0\b/)).toBeNull();
});
```

- [ ] **Step 2: Implement.** `FleetSection`: filter chips (mode, lane, actor —
  actor options are the distinct values in the loaded page, plus the three
  construct constants), rows with `data-testid="fleet-row"` showing actor
  (NULL renders "unattributed"), lane, outcome pill (`data-outcome` attr for
  styling; `running` pulses), tokens or "unknown" per `usage_state`,
  proposals applied/rejected. `RunDetailPanel` (opens in the existing detail
  panel chrome, `src/detail/` conventions): the full `RunDetail` — cost
  component table when present, assembly latency when present, and a door to
  the needs section when the run has queued proposals.
- [ ] **Step 3: e2e** — `e2e/fleet.spec.ts` with `__cerebroSeedFleet`: rows
  render newest-first; filter by actor narrows; detail opens; unknown usage
  renders "unknown" (the `pipeline-surface.spec.ts:105` behavior, reborn
  here).
- [ ] **Step 4: Full gate, handoff, commit**

```sh
git add -A && git commit -m "feat(status): the fleet section — every run visible, filterable, and inspectable (M33.5)"
```

**Acceptance:** every run the DB holds is reachable in the UI; absent data
says so; the section degrades to `unavailable` without a runtime DB.

---

### M33.6 — Agent dossiers: the record grows its history

`AgentEditor` gains a dossier strip: status pill (on-duty is DERIVED from
schedule/triggers exactly as `libraryDraft.ts:142` already computes — never
stored), next scheduled fire (from `engine/skills.parseSchedule`), and the
run history for `actor = process:<slug>` via `fleet_runs` + `actor_summary`.
Capability-gated: the strip renders for any record whose draft derives
on-duty-capable, per the no-type-special-casing rule.

**Files**
- Modify: `src/library/AgentEditor.tsx` (dossier strip + history list)
- Create: `src/library/AgentDossier.tsx`, `src/library/AgentDossier.test.tsx`
- Modify: `src-tauri/src/lib.rs` + `src/lib/ipc.ts` + `src/lib/mockIpc.ts`
  (`fleet_actor_summary(actor)` command over M33.2's `actor_summary`)
- Modify: `e2e/agent.spec.ts` (one new test: seeded runs appear in the
  editor; zero runs renders "no runs yet", not an empty table)
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Failing unit test** — dossier shows lifetime tokens with
  `unknown_runs` called out separately ("3 runs unmetered"), last outcome,
  and a next-fire time computed against the pinned clock (`VAULT_TODAY`
  discipline: the test pins `Date` the way `AgentEditor`'s existing tests
  do — verify their fixture and mirror it).
- [ ] **Step 2: Implement**, reusing `FleetSection`'s row component for the
  history list (same testids, scoped under `agent-dossier`).
- [ ] **Step 3: Full gate, handoff, commit**

```sh
git add -A && git commit -m "feat(library): agent records carry a dossier — status, next fire, run history (M33.6)"
```

**Acceptance:** an Agent record's editor answers "what has this agent done,
what did it cost, when does it run next" without leaving the page; nothing
about the agent is stored outside the vault.

---

### M33.7 — The two run logs meet

The renderer's localStorage `runLog` and the durable `runs` table share no
id. After M31.2a the panel's durable id exists BEFORE the token mint
(`lib.rs` hoist) — surface it to the renderer so live runs and history link
to fleet detail.

**Files**
- Modify: `src-tauri/src/lib.rs` (`run_agent`'s return value gains
  `runId: String` — the durable id; verify the current return shape at
  `:668+` and extend, don't replace)
- Modify: `src/agent/agentIpc.ts`, `src/agent/runs.ts` (`RunRecord` gains
  `durableId?: string`), `src/agent/useJobRunner.ts`, `src/agent/AiPanel.tsx`
  (thread it), `src/engine/runLog.ts` (`RunLogEntry` gains
  `durableId?: string` — additive, old entries parse unchanged)
- Modify: `src/agent/RunList.tsx` (entries with a `durableId` link to
  `{kind:'status', section:'fleet'}` detail; entries without stay plain text
  labeled "this device only")
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Failing vitest** — a `RunList` entry with `durableId`
  navigates to the fleet section; one without renders no link.
- [ ] **Step 2: Thread the id end to end.** The localStorage log remains the
  disposable device-local record it declares itself to be
  (`engine/runLog.ts` header) — M33 links it, it does not migrate it.
- [ ] **Step 3: Full gate, handoff, commit**

```sh
git add -A && git commit -m "feat(agent): renderer runs carry the durable id and link into the fleet (M33.7)"
```

**Acceptance:** clicking a finished run in the StatusBar popover lands on its
fleet detail; pre-M33 log entries degrade gracefully.

---

### M33.8 — Context-push for scheduled agent runs

The munder-difflin pattern: a resumed/scheduled agent gets current state
pushed, not remembered. Small and prompt-only.

**Files**
- Modify: `src/agent/useJobRunner.ts` (the scheduled-agent prompt composition
  path — locate where the record body becomes the prompt, ~`:348-367`)
- Modify: `src/agent/useJobRunner.test.tsx`
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md`

- [ ] **Step 1: Failing test** — the composed prompt for a scheduled run
  begins with a `CURRENT STATE (supersedes anything you remember)` block
  containing vault name, today's date, the agent's last run outcome (from
  `fleet_actor_summary`, "none" when absent), and open review count; and the
  block is ABSENT for attended chat runs (the panel pushes its own context).
- [ ] **Step 2: Implement** — one template literal, data from calls the
  runner already has or M33.6 added; a fetch failure degrades to omitting
  the line, never blocking the run (store-layer rule: this is a human-action
  path).
- [ ] **Step 3: Gate, handoff, commit**

```sh
git add -A && git commit -m "feat(agent): scheduled runs get current state pushed, superseding memory (M33.8)"
```

---

### M33.9 — The sweep: docs, dead code, coverage

**Files**
- Modify: `AGENTS.md` (the repo-map bullet naming surfaces: reflect the
  9-button rail and the hub)
- Modify: `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md` (M33
  section: what merged, what the fleet shows, the actor column, the two
  linked run logs)
- Verify-and-delete: any orphaned exports the merges left (`knip`/manual grep
  for `ReviewPage`, `PipelinePage` references)
- Modify: `vite.config.ts` ONLY if coverage rose (ratchet up, never down)

- [ ] **Step 1** — grep for the dead names; delete stragglers; run
  `pnpm test:coverage` and ratchet if the floor moved up.
- [ ] **Step 2** — full gate, commit:

```sh
git add -A && git commit -m "docs(status): the hub is the map — sweep, ratchet, handoff (M33.9)"
```

---

## Acceptance matrix

| Scenario | Must hold |
| --- | --- |
| rail after M33.4 | exactly 9 buttons; no `review`/`pipeline` Selection kinds compile |
| review card approved inside the hub | same server behavior as before the move; reject still demands a reason |
| runtime DB missing/locked | every hub section shows `unavailable`, never `empty` |
| run with no cost rows | detail says "not recorded"; no $0 anywhere |
| run with `usage_state != 'exact'` | tokens render "unknown"; agent lifetime sums exclude it into `unknown_runs` |
| pre-M33 run row | actor renders "unattributed"; nothing backfills |
| agent record with zero runs | dossier says "no runs yet"; on-duty pill still derived correctly |
| scheduled run prompt | CURRENT STATE block present, superseding clause verbatim; absent on attended chat |
| StatusBar popover, old entry | no fleet link, labeled device-only; new entry links to detail |
| `knowledge.spec.ts` | untouched tests stay green — Knowledge is out of scope |
| internal construct in fleet UI | shows as `construct:*` run history; no persona, no name implying judgment |

## Traps

- **The schema-version race with M31.** Verify the next free `SCHEMA_V*` at
  execution; a committed migration's text is immutable (M31's D5 rule).
- **e2e port discipline**: `lsof` before every run; a busy port silently
  tests another worktree's branch.
- **The clock**: every date the dossier or fleet renders is asserted against
  `VAULT_TODAY`; an unpinned spec has a shelf life (M26's lesson).
- **Mock parity is tested, not assumed**: every new command gets a mock stub
  AND a parity assertion; `__cerebroSeedFleet` follows the existing seed
  seams' shape exactly.
- **Do not resurrect the door-collapse**: `Feed<T>`'s unavailable state is
  the standard the merged bodies adopt; `catch → empty` is the defect the
  merge retires.
- **`fleet.rs` writes nothing.** If a phase needs a new fact, it goes through
  the Meter or governance writers with its own test — never a side-write
  from the read model.
- **This milestone touches no quota**: every test runs against seeded mocks
  or copied fixtures; nothing spawns a real CLI run.

## Gate commands (all green per phase)

```sh
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm lint && pnpm typecheck && pnpm format:check
pnpm test:run          # NEVER `pnpm test` — watch mode, never exits
pnpm test:coverage
p=5473; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo "$p BUSY — pick another" || PORT=$p pnpm e2e
```

## Exit criteria

Rail at 9 buttons with review and background living as full hub sections
whose unavailable ≠ empty · every run the app has ever booked is visible,
filterable, and inspectable, with absent data rendered as absent · runs carry
their actor from M33.1 forward and constructs are attributed without personas
· Agent records answer what/when/cost from their own editor with identity
still vault-only · renderer and durable run logs joined by the M31.2a id ·
scheduled runs receive superseding current state · Knowledge untouched ·
handoff doc current at every commit · full gates green.
