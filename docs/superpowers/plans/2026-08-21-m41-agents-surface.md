# M41 — The Agents surface: the platform gets its front door

**Spec:** `docs/superpowers/specs/2026-08-17-agent-platform-design.md` (D2:
"agent platform first"). Requested 2026-08-21 after the M34–M40 delivery:
agents were configurable in the Library, observable under Base's "Agent
work", and addressable in the panel — three rooms, no house.
**Branch:** `m34-agent-platform`. Written after recon on 2026-08-21.

## The shape, corrected by recon

- `FleetRun` does NOT carry `parent_run_id` — M34.3 wrote it to the DB and
  nothing SELECTs it. The chain-trace UI starts with a Rust column, not a
  component.
- `AgentRoster` and `FleetSection` are self-contained (they fetch their own
  reads and take `focus`/`now`), so the surface COMPOSES them; the only
  coupling to break is `FleetSection` reading its deep-linked run off the
  knowledge selection.
- The Library's editor plumbing (draft → patch → save) spans LibraryPage
  end-to-end. **Editing stays there** — the agent page carries one Edit
  affordance that navigates to it. One editor, one save path; re-hosting it
  would be the two-copies drift this repo keeps killing.

## What ships

- **`agents` selection kind** (`{ actor?: string }` — the ACTOR string, so
  internal constructs get pages too, not just record-backed agents) +
  place.ts entries. The **Agents** destination sits after Inbox — the
  platform surface, not chrome. The contract goes to TEN.
- **AgentsPage, no actor**: the roster (reused `AgentRoster`; clicking a row
  opens the agent's page) over the fleet's run feed (reused `FleetSection`).
- **AgentsPage, actor open**: charter (the record body, rendered read-only),
  a grants summary derived from the same `agentDraft` the editor uses
  (tools, write scope, read scope, schedule/triggers, the consequence
  sentence), pause/resume, **Edit in Library**, and the actor's run history
  **with chains rendered** — a hop says which run it hopped from; a root
  with hops shows them indented, billed-to-root stated. A construct's page
  says it is permanently internal instead of offering an editor that could
  not exist.
- **`parent_run_id` through the stack**: fleet.rs RUN_COLUMNS + `FleetRun`,
  the TS twin, the mock's demo rows (null — the demo corpus has no chains;
  a unit seed provides one).
- Base's "Agent work" tab stays — it is the base's own runs view; the
  roster there now links across to the agent page.

## Slices

- **M41.2** Rust + twin: `parent_run_id` selected end to end.
- **M41.3** the kind, the destination, AgentsPage roster+feed.
- **M41.4** the agent page: charter, grants, chains, Edit-in-Library.
- **M41.5** e2e (`agents.spec.ts`) + contract updates.
- **M41.6** spec/AGENTS.md fold.
