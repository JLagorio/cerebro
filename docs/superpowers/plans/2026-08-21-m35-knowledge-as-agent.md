# M35 — Knowledge as agent #1: the base's judgement gets a face

**Spec:** `docs/superpowers/specs/2026-08-17-agent-platform-design.md` §7 (M35 row),
D5/D6 ("knowledge/ stops being a place and becomes a capability").
**Branch:** `m34-agent-platform`. Written after recon on 2026-08-21.

## The shape, corrected by recon

The spec row asks for three things. One is deliverable now, one is a set of
declarations, and one is deferred with a reason worth recording:

1. **The knowledge agent ships.** `demo-vault/records/agents/knowledge.md` —
   the second Agent record in the corpus and the first consumer of M34.1.3's
   `capabilities: knowledge` gate (until now the capability existed and no
   record declared it; the job-runner's knowledge lanes carried it in all but
   name). `scope: []` on purpose: its writes go through `write_concept` /
   `cache_source`, which carry their own guards and are scope-exempt by
   declared design (mcp.rs), so the folder axis narrows to nothing and the
   guarded tools are the only doors. Unscheduled, like release-scout — the
   demo vault ships agents off so the background stays predictable.
2. **The tab names its agent.** KnowledgePage's header gets a "Maintained by"
   chip that resolves the vault's knowledge-capable Agent record — by
   CAPABILITY, never by slug or title — and opens it. No record → no chip:
   the tab predates the agent and works without one; an absent agent is not
   a failure and gets no placeholder.
3. **The full relocation (tab → agent detail page) moves to M37, stated
   here.** Relocating the tab now and again when the shell flattens would
   churn the same 7/13 e2e specs twice for one outcome. The identity link is
   what M35 owes ("the base's judgement has a face"); the geometry lands
   once, with the sidebar it will actually live in.

## Declarations (M35.4 — folded into the spec, no code moves)

- **The three constructs are permanently internal.** `agent:m26-ingest`, the
  maintenance pass, assembly synthesis (`CONSTRUCT_ACTORS`): their tool
  grants are structural (`internal: true` is unreachable from the wire),
  their spawn sites are Rust, and making them records would hand
  vault-authored frontmatter control over machinery the vault must not
  steer. The fleet already renders them as the unowned rest of the roster.
- **`okf.ts` is already the private read model.** Its importers are the
  knowledge components and the knowledge lanes — no generic surface reads
  it. Nothing to move; declared so nobody "promotes" it later.
- **The eight parked tables stay parked.** A consumer licenses a revival;
  M35 found none.

## Tasks

- **M35.2** `records/agents/knowledge.md` + the e2e churn it causes
  (fleet.spec's roster counts assert 1 Agent record; a second one is exactly
  what those assertions exist to notice — treat as test changes, per
  AGENTS.md's demo-vault rule).
- **M35.3** `Maintained by` chip on KnowledgePage, capability-resolved;
  component test for present/absent.
- **M35.4** spec fold carrying the declarations and the M37 deferral.
