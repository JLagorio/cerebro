# M13 — The agentic platform: one primitive, four faces

**Branch:** `m13-agentic-platform` (off `main` @ 84f86e2) · **Date:** 2026-07-31
**Trigger:** the user's brainstorm on agentic knowledge — Productboard skills,
ClickUp AI agents, second-brain pipelines — "make sure it works and is refined,
then build the damn thing."

## The direction (user's four questions)

1. What does knowledge truly look like? Does the agent create types? What happens
   to synthesized knowledge when types are added or removed?
2. Productboard-style **skills**: create them inside the platform, load them only
   when invoked (small, targeted context), and schedule them.
3. **Connectors** — MCP/datasource support "like Tolaria".
4. ClickUp-style **AI agents** that act like team members on the backend.

## What the research actually said (four parallel deep-dives, 2026-07-31)

- **Cerebro today**: knowledge is already a guarded OKF bundle — `write_concept`
  is the only writer, Rust stamps `generated`, the agent can never claim
  `verified`, trust is derived, staleness re-queues concepts through a *derived*
  learn queue (`learn.ts`), drained single-flight by a ~90-line runner
  (`useLearnRunner.ts`). No LLM API anywhere: we spawn the user's Claude CLI
  against a loopback MCP server with an allowlist (`agent.rs` / `mcp.rs`).
- **claude-obsidian** (evidence-first): claim/source ledgers, transactional
  writes, conflicts preserved as `contested`, zero background automation on
  principle. **obsidian-second-brain** (rewrite-first): bi-temporal facts,
  freshness policy ("every fact is timeless, dated, or a pointer"), scheduled
  nightly agents with one iron rule — *unattended runs are additive-only; only
  an interactive session may resolve a contradiction*.
- **Tolaria has no connector story.** It is only an MCP *server* (registers
  itself into other tools' configs, injects itself into 8 CLI agents at spawn).
  Worth stealing anyway: the per-vault Safe/Power permission mode and tool risk
  annotations. Cerebro's `cache_source` + non-strict-MCP approach is already the
  better local-first connector architecture.
- **My-Brain-Is-Full-Crew demystifies ClickUp**: an "agent" is a markdown file
  with frontmatter (name, triggers, capabilities), a dispatcher prompt routes to
  it, per-agent memory is a bounded "post-it" file, and the build-me-an-agent
  flow is a 12-question interview skill that writes a new agent file + registry
  row — guarded by a hook that protects core agents but allows new ones. No
  backend. It's all files.

**The unlock:** skills, scheduled jobs, connectors, and agents are the same
primitive wearing different clothes — **a job = (prompt, tool policy, trigger)**.
Cerebro already ships one instance of it (the learn runner). M13 generalizes it
instead of building four systems.

## Decisions made

- **A skill is a record** (`type: Skill`). Body = the instructions. Only
  name + description ride in every system prompt; the body is injected only on
  invocation (`/name` in chat). The five `prompts.ts` templates stay code — they
  are the OKF pipeline's contract, not user skills.
- **Scheduling is a job kind, not a daemon.** `schedule:` on a Skill record;
  the runner derives due jobs (last-run ledger, same loop-stopper pattern as
  `learnAttempts`) and drains them on the existing single-flight lock. Local-
  first honesty: jobs run while the app is open — "runs next time you open
  Cerebro" beats pretending we have a cloud.
- **Unattended runs are additive-only.** Scheduled/background prompts carry the
  second-brain rule verbatim: flag contradictions (`contradicts:`), never
  resolve, never deprecate, never rewrite a human's note.
- **Connectors are the user's own MCP servers, managed per-vault.** A
  Cerebro-owned connectors file (per vault) is merged into the `--mcp-config`
  handed to the CLI, keeping `--strict-mcp-config` for per-server control —
  replacing the all-or-nothing "inherit whatever is in ~/.claude.json" toggle.
  Cerebro still holds zero credentials and runs zero sync. Everything fetched
  lands in `sources/` via `cache_source` with provenance.
- **`connector-refresh` closes the loop with almost no wiring**: cached sources
  already carry `stale_after`; a stale source becomes a re-fetch job; the
  refreshed file's `modifiedAt` makes citing concepts `behind`; the distiller
  re-checks them. Ingest → distill starts ticking on external data.
- **An agent is a record** (`type: Agent`): instructions, allowed tools
  (safe/shell), triggers (mention, schedule), and a bounded, *visible* memory —
  a `## Memory` section in the record body (the crew repo's post-it, but
  auditable and git-tracked). Identity is `process:<slug>` — the actor slot the
  OKF schema already reserves (`verified.by: process:metrics-nightly` is in the
  demo vault today). Agent work products are ordinary records/concepts with
  attribution.
- **The agent proposes types; it never silently creates them.** Type creation
  via `create_note` is currently ungated — M13 routes schema changes through the
  propose-pattern (`analyzeVault` from M12.6 as the read-only analyzer, proposal
  card, user approves).
- **Re-synthesis is staleness, not a big bang.** Adding/removing/changing a type
  never triggers bulk reprocessing: concepts `about:` records of that type
  become stale (type-doc `modifiedAt` beats `generated.at`) and the derived
  queue re-checks them lazily.
- **Knowledge freshness**: distill/review prompts adopt the freshness rule —
  a stored fact is timeless, dated (`2026-07-13: pipeline at 13 open deals`),
  or a pointer to where truth lives. The undated volatile present-tense claim
  is the sentence that becomes a lie next Tuesday.

## The phases

- **M13.1 — a skill is a record.** `type: Skill` seeded type; `engine/skills.ts`
  lists skills from entries; system prompt gains a compact skill index
  (name + description only); `/name` in ChatInput injects the body for that
  turn; demo-vault seed skills.
- **M13.2 — the runner generalizes; skills get schedules.** `engine/jobs.ts`
  supersedes the learn-only queue: job kinds `filed | behind | stale | scheduled`
  with one attempts/last-run ledger; `useLearnRunner` → `useJobRunner` (same
  single-flight yield to `agentBusy`, same silent failure); `schedule:` parsing
  (daily/weekly/hourly + time); additive-only preamble for unattended runs.
- **M13.3 — connectors get a face; sources get a pulse.** Per-vault connectors
  config + settings UI (name, transport, command/url, env, per-server toggle);
  `agent.rs` merges enabled servers into the spawned CLI's MCP config while
  keeping `--strict-mcp-config`; `connector-refresh` job kind derived from stale
  `sources/` files.
- **M13.4 — agents are teammates.** `type: Agent` seeded type; agent runs carry
  `process:<slug>` identity into provenance (Rust stamps `generated.by` from the
  run's actor); per-run tool policy in `agent.rs` (replacing the global-only
  allowlist); bounded `## Memory` write-back; a seeded "create an agent"
  interview skill that ends in a proposal, not a write.
- **M13.5 — knowledge stays honest.** Freshness rules in the distill/review
  prompts; type-change → staleness derivation in the queue; background
  contradiction-flagging (never resolution); schema changes agent-side routed
  through proposals.

## State

In progress. Each phase lands as its own commit, green (vitest + cargo + tsc +
build) before commit, following the M12 discipline.

## Known follow-ups (declared up front)

- One global agent child process (`AgentState`) — agents queue single-flight in
  v1; concurrency needs the Rust change first.
- `generated.by` is stamped `claude-code` unconditionally today; M13.4 threads
  the actor through `McpState`.
- Skill/Agent records are vault files — a malicious vault could ship prompt
  instructions. Same trust boundary as CLAUDE.md in any repo; revisit if vaults
  become shareable.
- Playwright coverage for the new surfaces lands with each phase's e2e pass,
  real-vault (tauri dev) shakeout at milestone end.
