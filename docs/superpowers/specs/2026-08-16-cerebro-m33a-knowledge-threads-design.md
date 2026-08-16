# M33a — One Knowledge tab

**Status:** design, 2026-08-16. Continues `m33-status-hub-fleet` after
M33.1–.10. Supersedes two earlier drafts of this file: one proposed letting
the distiller create records in the user's workspace (cut, see D1), one
treated dangling anchors as a defect (cut, see §2).

**One line:** the knowledge system works better than it renders — it just
writes its best material in prose instead of fields, and it is spread across
two tabs, neither of which opens on the thing you want.

---

## 1. The two planes

- **The workspace** — projects, tasks, deliverables, notes, transcripts. The
  user's.
- **The knowledge base** — `knowledge/`. The agent's own persistent beliefs,
  formed in the background as things change.

They collide only when the user asks. Already defended in code —
`mcp.rs:1237-1240`, on why `write_concept` is exempt from run scope:

> an agent's whole job may be to record what it found, **which is not the same
> permission as editing the user's records**.

Nothing has deviated. Everything below is on the knowledge side of that line.

---

## 2. Evidence

Measured on `~/Documents/test` — 30 concepts distilled from 4 meeting
transcripts (~850 lines each) by this branch.

**What works, and should not be touched:**

- **Types follow folders exactly.** `risks/` → all 8 `Risk`; `decisions/` →
  all 4 `Decision`. Not coincidence.
- **Anchors resolve.** 54 `about:` targets across 14 subjects; 8 dangling
  across 4 (`mpm-410`, `sib-220`, `mb-boot`, `kos-3.2`) — components mentioned
  but not yet written up. **This is correct.** A dangling anchor is an open
  thread the base is tracking about something nothing has named. It is not a
  broken link and must stop rendering as one.
- **29/30 cite sources.** 29/30 carry tags.
- **Duplicate input handled.** Captures `1253` and `1658` are both FRB-118
  Session 1. One concept, revised in place.

**The one real failure — relations are written as prose:**

`supersedes: 0` · `refines: 0` · `contradicts: 0`, across all 30. Yet:

- `cdr-session-3-disposition` — *"RFA-2-019: thermal correlation → superseded
  by 3-002"*
- `arb-4-disposition` — ADR-019 **Rejected**, revision A due 2027-05-19
- `ims-7-contingency-three-layer` — titled *"(proposed)"*

Supersession is stated in English inside tables and never lifted into the
field. So *"what replaced this"* and *"is this still true"* are unanswerable,
and M8.7 — *"the reason the bundle can stop being append-only"* — is dead
weight in a bundle that needs it.

**The type gap, now proven by controlled comparison:** the 16 `Reference`
concepts are 3 programs + 13 systems. The same run typed `Risk`, `Decision`
and `Metric` correctly — common words — and fell back to `Reference` wherever
it needed a domain word. `write_concept`'s type description
(`mcp.rs:750`) reads in full: `"OKF concept type, e.g. Metric, Playbook,
Reference"`. Three examples, one of them the fallback.

**Two fields at zero:**

- `description:` — **0/30**. Every list row is title + type + `Unreviewed`,
  because there is nothing else to show.
- `verified:` — **0/30**. Hence `All concepts 29` and `Needs review 29`: two
  nav rows carrying the same number.

**Rendering faults:**

- `SECTIONS` and `ABOUT` are two complete partitions of the same 29 items.
- `ABOUT` sorts alphabetically, so `Compass gcs 5 (13)` and `Ims 7 (8)` — the
  two real threads — sit among 19 singletons.
- Labels are sentence-cased slugs: `Rq 84b kestrel`, `Tx 6 np shared j12
  route`, `Frb 118 session 1 disposition`.
- `[[gcs-5-client-architecture]]` renders as raw text in concept bodies.
- `unsupported · coverage unassessed · freshness unknown` — three greys on a
  sourced concept. Means *not computed*; reads *we know nothing*.

---

## 3. Decisions

**D1 — The agent is sovereign inside `knowledge/`, and only there.** It writes
what it wants, no approval card. It never creates or retypes a workspace
record on its own initiative. Promotion of a thread into a workspace page is a
user act, from a button.

**D2 — ONE Knowledge tab.** Status is absorbed entirely: what the base holds,
what it knows about itself, and what its agents have been doing are three
views of one subject. The rail goes 10 → 9 and `Selection.status` is retired
into `Selection.knowledge`.

The tab's own nav:

| View | Holds |
| --- | --- |
| **Threads** | subjects, heaviest first — the default |
| **All concepts** | the flat list, as search fallback |
| **Folders** | `sectionOf`, demoted (was `SECTIONS`) |
| **What changed** | update log + belief moves |
| **What's contested** | contradictions, blind spots, stale, owed |
| **Agent work** | runs, actors, cost, budget — absorbs M33.5's `FleetSection` |

**D3 — The concept-type vocabulary ships as data.** Under `shared/policy/`,
loaded by Rust (`include_str!`) and TS (vite) from one file. A second
hard-coded copy in either language is a review-blocking defect. Vaults may
extend it.

Initial list, from the R4/R5 capability names plus what this vault proves it
needs: `program, system, component, risk, issue, decision, action,
assumption, hypothesis, forecast, question, finding, metric, playbook,
reference`.

**D4 — Relations are lifted into frontmatter, not narrated.** The prompt gains
an explicit instruction with the failure named. This is the highest-value
change in the milestone and outranks D3.

**D5 — Shipping D3 retires the R4/R5 gates.** Those gates held this vocabulary
open pending evidence; the vault in §2 is the evidence. Recorded as a decision
so it is not a leak. R1–R3 and R6–R14 are untouched.

**D6 — Deferral gates collapse to one line.** `24 capabilities held back, none
fired`, expandable. 3,225px → ~40px. Reversible in either direction once it
has been lived with.

**D7 — A dangling anchor reads as an open thread**, with `+ Create page` as
the user act in D1. Never a grey broken-link icon.

**D8 — Threads sort by weight, not alphabetically**, and keep the source
casing of their target (`RQ-84B KESTREL`, not `Rq 84b kestrel`).

**D9 — No rail badge.** Unchanged from M8.1.

**D10 — `unreviewed` is not a queue** while it is 29/29. It renders as
provenance; nothing sorts or filters by it as attention.

---

## 4. What already exists — do not rebuild

| Capability | Where |
| --- | --- |
| Subject/thread model | `okf.ts` — `Subject`, `listSubjects`, `conceptsAbout` |
| Dangling anchors legal by design | `okf.ts:374-376` |
| Relation kinds and their labels | `RELATION_KINDS`, `RELATION_LABELS` (M8.7) |
| Lifecycle, staleness, supersession | `lifecycleOf`, `staleAfter`, `supersededBy` |
| Plane separation | `mcp.rs` guards, `knowledge.rs` |
| Self-knowledge reads | contradictions, blindness, staleness, debt |
| Run history, actor attribution | `runtime/fleet.rs`, `runs.actor` (M33.1) |
| Record ↔ knowledge join | `RelatedKnowledge`, `EntityDossier` |

Vocabulary, prompt, rendering, invocation. Almost no new model.

---

## 5. Phases

**M33a.0 — `description` and relations in the prompt.**
Two additions to `write_concept`'s contract and both distil prompts: require a
one-sentence `description`, and require that any supersession, refinement or
disagreement stated in the body is *also* expressed in `supersedes` /
`refines` / `contradicts`. Fixes both zero-fields. Smallest change, largest
effect. *Verify by re-distilling `~/Documents/test` and asserting the fields
are non-empty.*

**M33a.1 — Ship the vocabulary.**
D3 as policy data; `write_concept` enumerates it plus vault additions. Test: a
vault declaring no types still offers the full default list.

**M33a.2 — One tab.**
D2. Status folds into Knowledge as views; rail 10 → 9; gates collapse per D6.
Carries the three defects found in M33.1–.10: nav order reversed against DOM
order, four sections absent from the nav, fleet rows rendering no timestamp.

**M33a.3 — Threads first.**
Default view; weight-sorted; source casing; dangling reads as open thread with
`+ Create page`. `SECTIONS → Folders`, `ABOUT → Threads`.

**M33a.4 — Thread view.**
One subject: what is known, what changed, what is contested, what is stale,
where it came from. Existing reads only. Wikilinks render as links.

**M33a.5 — Invocable.**
Ask the base a question from the work — *"what do you know that bears on
this?"* — and expose the same read as a tool an agent workflow can call.

**M33a.6 — Enriching.**
Surface relevant findings into the workspace. Bound by M8's tone rule; this is
the phase most able to violate it and does not ship without deciding when it
is allowed to speak.

---

## 6. Out of scope

- Agents creating or retyping workspace records. D1, permanently.
- Parallel agents — M33b, though its fleet surface now lands inside this tab
  (D2) rather than beside it.
- Worktrees. Notifications.

---

## 7. Risks

- **D3 may over-correct.** A rich vocabulary invites typing everything as a
  domain kind when `reference` was honest. The list keeps a generic fallback.
- **D5 sets a precedent** — shipping past a gate on judgement. Defensible once,
  named here; a second time needs a better argument.
- **D4 may produce false relations.** An agent told to record supersession will
  find some. Mitigation: it may only assert a relation whose target it has
  read in this run, and `contradicts` stays the honest answer when it cannot
  tell which is right.
- **D2 makes one tab hold six views.** The failure mode is M33's own — a page
  nobody can navigate. The nav is fixed and named; sections are not free to
  multiply.
- **M33a.6 is where the tone rule dies** if it is going to. It is last for that
  reason.
