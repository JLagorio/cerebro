# M93–M99 — Research and review index

**2026-10-23 · drafts for owner review · documentation only.** This packet turns
the eight reference-repository reviews, M91 reconciliation, M92 handoff and four-pass UI review
into seven proposed designs and seven implementation plans, joined by a program
design and master roadmap. Nothing here changes the application or authorizes an
implementation, provider action or data migration.

## Final review entry point

Read the [final review and corrected gaps](final-review.md), [eight-repository source cross-check](reference-crosscheck.md), and the master roadmap's [first build sequence](../../plans/2026-10-23-m93-m99-master-roadmap.md#first-build-sequence-after-this-review). The original research remains below; the final pass incorporates the newer M91 handoff and checks the actual vendored source again.

## Read in this order

1. [M93–M99 master roadmap](../../plans/2026-10-23-m93-m99-master-roadmap.md) — milestone sequence, dependencies, release slices and coordination.
2. [M93–M99 program design](../2026-10-23-m93-m99-program-design.md) — product direction, alternatives and shared ownership.
3. [Decisions for review](decisions.md) — proposed defaults, tradeoffs and the work each choice gates.
4. The seven paired milestone specs/plans below — complete behavioral contracts and numbered implementation phases.
5. [Finding coverage](traceability.md), [evidence](evidence.md) and [independent review corrections](review-record.md) — every research finding, current-state limits and review dispositions.

| Milestone                                | Spec / plan                                                                                                                                     | Requirements / phases |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| M93 — Reliable workspace                 | [Spec](../2026-10-23-m93-reliable-workspace-design.md) · [Plan](../../plans/2026-10-23-m93-reliable-workspace.md)                               | 13 / 11               |
| M94 — UI polish and journeys             | [Spec](../2026-10-23-m94-ui-polish-and-journeys-design.md) · [Plan](../../plans/2026-10-23-m94-ui-polish-and-journeys.md)                       | 10 / 9                |
| M95 — Chat and supervised agents         | [Spec](../2026-10-23-m95-chat-and-supervised-agents-design.md) · [Plan](../../plans/2026-10-23-m95-chat-and-supervised-agents.md)               | 9 / 7                 |
| M96 — Connectors, MCP and actions        | [Spec](../2026-10-23-m96-connectors-mcp-and-actions-design.md) · [Plan](../../plans/2026-10-23-m96-connectors-mcp-and-actions.md)               | 10 / 8                |
| M97 — Knowledge, evidence and evaluation | [Spec](../2026-10-23-m97-knowledge-evidence-and-evaluation-design.md) · [Plan](../../plans/2026-10-23-m97-knowledge-evidence-and-evaluation.md) | 11 / 8                |
| M98 — Workflows and automation           | [Spec](../2026-10-23-m98-workflows-and-automation-design.md) · [Plan](../../plans/2026-10-23-m98-workflows-and-automation.md)                   | 10 / 9                |
| M99 — Rust services and storage          | [Spec](../2026-10-23-m99-rust-services-and-storage-design.md) · [Plan](../../plans/2026-10-23-m99-rust-services-and-storage.md)                 | 12 / 8                |

There are **75 subsystem requirements and 60 subsystem tasks**, plus six program
coordination/release tasks. Counts describe review organization, not delivered
features or reliable estimates. The coverage register accounts for 78 ranked
reference findings, 34 CP/AX/UI packages and 31 visual/journey/acceptance reviewer
IDs. Shared findings map to one owner rather than multiplying the backlog.

## Repository research documents

These dated dossiers remain the detailed source research. Their findings feed M93–M99 through the traceability register; the earlier CP/AX/UI packages are historical input rather than a second execution backlog.

| Reference repository | Research document                                                               | Main lessons feeding the milestones                                              |
| -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Macro                | [Macro dossier](../../plans/2026-10-22-reference-review/macro.md)               | Rust boundaries, source formats, agent workflows and workspace composition.      |
| Morrow               | [Morrow dossier](../../plans/2026-10-22-reference-review/morrow.md)             | Knowledge provenance, contextual work and reliable interaction.                  |
| Tolaria              | [Tolaria dossier](../../plans/2026-10-22-reference-review/tolaria.md)           | Workspace scale, storage boundaries and local-first behavior.                    |
| Thought Desk         | [Thought Desk dossier](../../plans/2026-10-22-reference-review/thought-desk.md) | Chat continuity, knowledge journeys and focused UI.                              |
| Activepieces         | [Activepieces dossier](../../plans/2026-10-22-reference-review/activepieces.md) | Connector definitions, workflow versioning and durable execution.                |
| AppFlowy             | [AppFlowy dossier](../../plans/2026-10-22-ai-expansion-review/appflowy.md)      | Rust/service boundaries, document UX and storage tradeoffs.                      |
| n8n                  | [n8n dossier](../../plans/2026-10-22-ai-expansion-review/n8n.md)                | Action schemas, credential ownership, workflow waits and recovery.               |
| Plane                | [Plane dossier](../../plans/2026-10-22-ai-expansion-review/plane.md)            | Polished work surfaces, contextual creation and explicit relationship semantics. |

Cross-cutting research: [architecture validation](../../plans/2026-10-22-reference-review/architecture-validation.md) · [knowledge and agents](../../plans/2026-10-22-reference-review/knowledge-agent-validation.md) · [chat experience](../../plans/2026-10-22-ai-expansion-review/chat-and-agent-experience.md) · [connectors/workflows](../../plans/2026-10-22-ai-expansion-review/connectors-and-workflows.md) · [Rust/storage](../../plans/2026-10-22-ai-expansion-review/rust-and-storage.md) · [protocol compatibility](../../plans/2026-10-22-ai-expansion-review/protocol-compatibility.md) · [four-pass UI review](../../plans/2026-10-22-ui-refresh-review/README.md).

## What changed from the research

Current M91 source already implements several gaps described on October 22,
including parent/child projection, context usage, branching and production AI
presentation. These plans credit that work and require integrated evidence. The
older startup failure is historical; the new drafting task did not rerun the app.

The four-pass UI recommendation becomes a concrete design and adoption sequence,
including creation-draft ownership. The connected-action proposal now defines
authenticated subjects, idempotent preparation, review revisions, unresolved-effect
fences and a workflow-to-action recovery contract. Storage recommendations specify
their portability and old-client limitations rather than promising a magic format
switch. Independent builder review corrected cross-plan gaps before handoff.

## How to review

Review each spec's user-visible behavior and proposed decisions before its file
and test steps. A decision can be accepted for one slice and deferred for another.
The UI refresh, connected-action beta and storage comparison are independent
investments. Items labeled conditional or deferred are retained deliberately;
they are not silently accepted features or forgotten research.

The plans are detailed enough to guide the selected work after review, but open
product decisions remain gates. Future test commands and expected results are not
evidence those tests ran. M93–M99 and their phase numbers are assigned for review; no implementation method is selected by this drafting request. Existing research remains unchanged and linked.

## Validation and provenance

The [source manifest](source-manifest.json) records source fingerprints, document
links, required plan sections, task/requirement counts and preservation of the
starting workspace, including observed concurrent M91 edits. The [evidence record](evidence.md) names the specific limits
of this review. The [review record](review-record.md) tracks builder findings and
their dispositions; it is a document review, not a software correctness certificate.
