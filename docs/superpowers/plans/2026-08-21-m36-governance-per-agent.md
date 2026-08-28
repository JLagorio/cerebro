# M36 — Governance per agent: consequence on the record, safety at the birth

**Spec:** `docs/superpowers/specs/2026-08-17-agent-platform-design.md` §7 (M36 row).
**Branch:** `m34-agent-platform`. Written after recon on 2026-08-21.

## What the spec asked for, corrected by recon

1. **"The escalator" already ships.** `policy.v3.json` has carried
   `target_has_attestation → floor HIGH` since M27.4 — revising a
   human-verified page queues, whatever the op — evaluated in `policy/risk.rs`
   from server-derived signals and covered by the goldens. Nothing to build;
   the row's claim was already true.
2. **"New agents default paused" is half-true.** Creation ships INERT (no
   schedule, no trigger — LibraryPage's own comment), but inert-by-absence is
   not paused-by-default: the moment someone adds a schedule it is live. The
   cerebro-ds decision was two acts — configure, then unpause — so creation
   now stamps `paused: true`, and the existing duty toggle (which already
   writes `paused: null | true`) is the way back. No new UI.
3. **Risk thresholds as per-agent settings — the override half is DEFERRED,
   named.** Rendering the CONSEQUENCE is buildable now from the shared policy
   artifact (no twin table). A per-agent override (an agent forced to
   queue-everything) is a policy-table axis: it needs the artifact format to
   grow, goldens, and conformance vectors on both sides — a session of its
   own, and doing it as a code path beside the table is exactly the
   twin-implementation defect AGENTS.md forbids. Deferred until the table
   grows the axis.
4. **The capture-gate move (`is_knowledge_path` → governed-agent-write) is a
   no-op until a second governed agent exists.** The gate's two sites guard
   human edits to ledger-backed projections; today every such projection is
   under `knowledge/`, so re-keying the gate changes no behavior and adds a
   seam nothing uses. Deferred to the milestone that ships a second governed
   surface, with this paragraph as the pointer.

## Tasks

- **M36.2 — born paused.** LibraryPage's `create` stamps `paused: true` on a
  new Agent record (agents only — the settled decision names agents; a skill
  stays inert-by-absence as today). Duty label shows Paused from birth.
- **M36.3 — the read axis reaches the editor.** AgentEditor gains the
  `read-scope:` row beside `scope:` (the M34.4 deferral): same folder
  grammar, absent = reads everything, `[]` = reads nothing.
- **M36.4 — the prompt states the read boundary.** An agent run whose grant
  narrows reads is TOLD so (agentRunPrompt gains the sentence when
  `read-scope:` is set) — the M34.4 deferral's other half: the enforcement
  existed, the agent just could not plan around it.
- **M36.5 — consequence, not membership.** AgentEditor renders what this
  agent's proposals DO, derived from the SHARED policy artifact: low/medium
  ops apply on their own once committed, high-risk ops queue for you, and
  revising a human-verified page always queues (the escalator, said out
  loud). Rendered only when the record holds the proposal toolset — an
  unarmed agent gets no table about weapons it does not carry.
- **M36.6 — the root's ceiling stops the chain.** `start_handoff_run` walks
  `parent_run_id` to the root, sums the chain's recorded spend, and refuses
  the hop when it has consumed the per-run ambient ceiling — the settled
  D-decision (hops bill to the root; the root's ceiling gates the chain),
  enforced at the spawn like every other hop rule.
- **M36.7 — spec fold** with corrections 1–4.
