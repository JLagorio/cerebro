# AI expansion review packet

This packet supports the [AI expansion plan](../2026-10-22-ai-expansion-plan.md).
It adds AppFlowy, n8n and Plane to the [earlier five-repository review](../2026-10-22-reference-review/README.md),
reassesses the actual M91 working tree, and develops the requested connectors,
MCP, workflow actions, subagents, chat, Rust and YAML-removal directions.

**Later same-day follow-up:** the [four-pass refresh review](../2026-10-22-ui-refresh-review/README.md)
and [UI plan](../2026-10-22-ui-refresh-plan.md) add the requested visual/interaction
track and update moving M91 claims. The source manifest and preservation counts
below describe this packet's earlier checkpoint. The follow-up records its own
browser evidence, source drift and documentation corrections.

**Documentation only.** No application implementation, migration, provider
sign-in, external action, reference build, test suite or live CLI trial was
performed for this packet. The earlier plan and M91 plan remain unchanged.
Current architecture rules are recorded as existing contracts; proposed amendments
are explicit. A recommendation here is not an implementation or publication.

## Review coverage

Eight additional specialist agents worked in bounded waves, with at most three
reviewers active alongside the lead. The lead independently inspected key
producer/consumer, persistence and MCP paths, researched current official MCP
documentation, and consolidated the delivery plan. These are eight specialist
reviews, not one separately spawned agent for every topic/repository cell.

| Specialist document                                 | Scope                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [AppFlowy](appflowy.md)                             | Ten ranked findings: AI context, sources, chat persistence, answer actions, Rust services and storage tradeoffs                            |
| [n8n](n8n.md)                                       | Twelve ranked findings: actions/credentials, MCP, effects, continuation, workflow versions, both agent architectures, chat and evaluations |
| [Plane](plane.md)                                   | Ten ranked findings: contextual commands, work/page relationships, versioning, integration lifecycle and actual AI limits                  |
| [M91 audit](m91-current-state.md)                   | Source implementation inventory, incomplete integration, accounting, retention and CP01–CP13 reconciliation                                |
| [Rust/storage](rust-and-storage.md)                 | UI versus domain ownership, five persistence choices, stable identity, migration, backup/sync and rollback                                 |
| [Connectors/workflows](connectors-and-workflows.md) | Proposed shared Rust runtime, durable objects, effect state, account lifecycle, waits and initial integrations                             |
| [Chat/agent UX](chat-and-agent-experience.md)       | Composer, sources, child contributions, approvals, outputs, history and complete task journeys                                             |
| [Independent challenge](architecture-challenge.md)  | Contradictions, scope, effort units, migration races, identity and recovery assumptions                                                    |

The lead's [protocol compatibility note](protocol-compatibility.md) separates the
local `2025-06-18` server from the official `2026-07-28` specification and proposes
incremental compatibility proof. It does not infer installed CLI/server support
from protocol publication.

The three new repository dossiers contain **32 ranked findings**, with parity,
partial implementation and proposed expansion distinguished. They supplement the
previous packet's 46 findings. Counts describe review organization, not unique
features: the synthesis deliberately merges overlapping recommendations.

## Reading and precedence

Read the main plan first, then the M91 audit, then the decision studies relevant
to a proposed implementation package. Repository dossiers retain evidence and
candidate scope; the main plan governs the combined sequence. In particular:

- The initial beta is one provider/read plus reviewed work-item creation and
  honest recovery. Three connector journeys form a later incremental release
  train, not a claim that an entire connector platform is a small launch.
- Gmail send is a later explicit policy amendment. The first mail journey retains
  the current draft behavior. No external sending was performed or authorized
  by this research.
- Storage estimates use explicit units: two-engineer team-weeks in the deep study,
  converted to engineer-weeks in the main roadmap. They are rough planning ranges
  and overlap with other work; they must not be added into a promised deadline.
- The metadata migration recommendation remains conditional on a measured
  SQLite/Markdown versus JSON-sidecar prototype. Rust service work and better
  chat can proceed while the current format remains authoritative.
- M91 findings are timestamped observations of work in progress. Reconcile them
  with Claude's next handoff before filing duplicate tasks.

## Evidence quality and limits

Each dossier links to local source and names important symbols/line locations.
Tests cited by name are evidence of intended coverage, not claimed passes. Source
presence does not prove production adoption, packaged accessibility, remote
service availability or performance. The UX assessment is derived from source
and interaction structure; the reference apps were not launched for visual QA.

AppFlowy's cloud/collaboration behavior partly depends on separately pinned
repositories, and its local MCP module is not exported. n8n contains distinct
legacy/new agent stacks and license/edition boundaries. Plane's visible AI
affordances do not establish an advanced agent runtime. These limits are part of
the comparison, not missing review work.

The [source manifest](source-manifest.json) records the final review timestamp,
Cerebro HEAD, and SHA-256 fingerprints of linked local evidence. Dossiers also
retain fingerprints from their individual checkpoints where the working tree
could change. The final manifest does not retroactively make all checkpoints one
atomic snapshot. No upstream commit is invented for an unpacked reference folder.

Repository preservation was checked against a start-of-task fingerprint of 3,109
pre-existing tracked/untracked paths. New M91 component files appeared during the
review; this packet does not claim authorship of concurrent work. Documentation
formatting is checked with the repository's Prettier explicitly overriding the
`docs/` ignore, and local document/source links are validated separately.

Final validation covers 11 new Markdown documents, 254 local links and 156 local
source fingerprints. All 3,109 pre-existing paths matched the start-of-task hashes.
The two Mermaid architecture diagrams were checked for syntax. These checks verify
the documentation and workspace preservation; they are not application tests.

## From research to implementation

Start with the M91 handoff and AX00 correctness/integration work. For each later
package, write a bounded implementation spec with current source identity,
proposed contract amendments, one user journey, a failure/recovery contract,
source-of-truth ownership, and acceptance evidence. Preserve useful existing
guards and UI instead of rebuilding them under new names. The first design
question is who owns a state transition; the first release question is whether
the person can complete and recover a useful task.
