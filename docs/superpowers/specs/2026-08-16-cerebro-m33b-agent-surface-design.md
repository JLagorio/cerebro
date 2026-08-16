# M33b — Agents as things you watch

**Status:** design, 2026-08-16. Continues `m33-status-hub-fleet` after M33a.

**One line:** an agent is already a record with a scope, a schedule and a
memory — but only one may run at a time, and nothing renders the fleet, so it
reads as a background daemon rather than a team.

---

## 1. What already exists — do not rebuild it

**An agent is a record.** `src/engine/agents.ts:8-21` (M13.4):

> A record of `type: Agent` whose body is its standing instructions. It runs
> unattended on its `schedule:`, its writes are attributed to
> `process:<slug>` … and its memory between runs is the `memory:` frontmatter
> property … Memory in frontmatter rather than a hidden state file on purpose:
> it renders as an ordinary property on the record.

> Activation is a human act: an Agent record without a `schedule:` is a
> description, not a daemon.

| Capability | Where | State |
| --- | --- | --- |
| Agent identity, brief, memory, schedule | `engine/agents.ts` — `AgentRef`, `parseMemory` | Complete |
| Write isolation per agent | `parseScope` + `RunGrant.may_write` (M17.13) | Complete |
| Read isolation per agent | `ungranted_tool_refusal` (M31.1b) | Complete |
| Shell widening, capped by Settings | `AgentRef.shell` | Complete |
| Run history with actor attribution | `runtime/fleet.rs`, `runs.actor` (M33.1) | Complete |
| Per-agent detail strip | `library/AgentDossier.tsx` (M33.9) | Partial |
| Budget, metering, quota gates | `runtime/budget.rs`, the Meter | Complete |

**So M33b is not "make an agent a first-class object."** It already is one.
Three things are missing, and only the first is structural.

---

## 2. The three gaps

**a. Concurrency is one.** `src-tauri/src/runtime/dispatch.rs:22-25`:

> **Background concurrency is one.** The singleton `ambient_dispatch` row is
> the enforcement, not a comment: chat keeps its headroom inside the
> process-wide cap of four because the database will not hand out a second
> ambient lease.

A singleton row is a blunt instrument standing in for a budget decision. It
was right when there was no metering; there is metering now.

**b. Nothing shows the fleet at once.** Agents are reachable one at a time
through Library. `FleetSection` (M33.5) lists *runs*, not *agents* — the
history, not the team. There is no surface answering "what is everyone doing".

**c. You cannot address one by name.** Chat threads anchor to a place
(M17.5), not to an agent. Talking to a specific agent means opening its record
and triggering it.

---

## 3. Decisions

**D1 — No worktrees.** Scape isolates by git worktree because its unit of work
is a branch. Cerebro's is a subject, and forking a vault per agent would
require merging notes. **The proposal channel is already the isolation
primitive**: N agents work concurrently against one vault and serialise at the
write. Optimistic concurrency — one timeline, and every collision surfaces as
`stale_target_version`, a card rather than a conflict.

**D2 — Scope is the other half of isolation, and it exists.** Two agents with
disjoint `scope:` cannot collide at all; the grant refuses the write before the
tool body runs. Overlapping scopes fall through to D1.

**D3 — Concurrency is gated by budget, not by a row.** Replace the singleton
primary key with N leases, each of which must pass the same gate a single
ambient run passes today. The invariant that survives verbatim: *missing usage
never becomes zero* — an abandoned run still records
`abandoned_usage_unknown`, requeues its work, and marks the day unknown.

**D4 — The concurrency ceiling is a Settings number, defaulting to 1.** The
change ships inert. Raising it is a human act, like `schedule:` is.

**D5 — The fleet surface lists agents, not runs.** One row per agent: what it
is on, when it last ran, what it has spent, what it has queued waiting for
you. Runs become that agent's history, one level down. This is what M33.5's
`FleetSection` was reaching for and is where it gets absorbed.

**D6 — An idle agent still appears.** A fleet that only showed working agents
would answer "what is happening" and not "who works here", and the second is
the question a person actually has.

**D7 — Still no rail badge.** Unchanged from M8.1 and M33's `StatusNav`.

**D8 — Addressing an agent does not create a new chat surface.** An existing
thread gains a recipient. The place anchor stays.

---

## 4. Phases

**M33b.1 — N leases.**
Retire the `ambient_dispatch` singleton for a lease table gated by budget.
Existing tests that assert global concurrency of one become tests that assert
*the configured ceiling*, with 1 as the default so current behaviour is the
default behaviour. Recovery, finalization and the unknown-usage path unchanged.

**M33b.2 — The ceiling in Settings.**
One number, capped by the process-wide four. Refuses to exceed the budget
gate rather than racing it.

**M33b.3 — The fleet surface.**
Agents, not runs (D5, D6). Absorbs `FleetSection`; keeps `runtime/fleet.rs`
(SELECT-only), the `actor` column, the v13 migration and the mock parity from
M33.1–.9. Fixes carried from that work: nav order reversed against DOM order,
four sections absent from the nav, and **fleet rows rendering no timestamp**.

**M33b.4 — Live state.**
Working / idle / waiting-on-you / paused, per agent, from the run and proposal
tables. No polling loop where an event exists.

**M33b.5 — Pause and resume, per agent.**
Today pausing is global (`Pause background work`). Per-agent pause is what
makes a fleet governable — and is the cheapest answer to a misbehaving agent
that is not deleting its record.

**M33b.6 — Address by name.**
`@agent-slug` in a thread routes the turn to that agent's grant, scope and
memory. The thread keeps its place anchor (D8).

---

## 5. Out of scope, named

- Worktrees, per D1.
- Agents spawning agents. Every run is traceable to a human act or a
  `schedule:`; a self-spawning fleet breaks that and the budget model with it.
- Rendezvous / multi-party chat / encrypted rooms.
- Notifications. M33a's summoning question is unresolved and stays that way.

---

## 6. Risks

- **N leases weaken an invariant that is load-bearing.** The singleton is how
  the accounting stays honest across crashes. M33b.1 is the phase most likely
  to need a written proof rather than a test, and it should not ship on tests
  alone.
- **The fleet surface can become the nagging screen** M8 exists to prevent.
  D6 puts idle agents on it deliberately; if it grows counts and urgency it has
  become the thing the rule forbids.
- **Per-agent pause is a governance claim.** If a paused agent can still be
  triggered from its record, the pause is a lie. The phase includes proving it
  is not.
