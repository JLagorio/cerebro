# Example repository review — 2026-10-26

This packet continues the October 24 audits across all ten supplied example repositories, with deeper AFFiNE and Outline analysis and coverage beyond M99: agents, subagents, skills, MCP, connectors, automation, infrastructure, rich editing, databases and UI composition. It changes documentation only.

Start with [comparison and priorities](comparison-and-priorities.md), then the [current Cerebro baseline](cerebro-baseline.md). The repository chapters provide granular feature matrices, source anchors, execution/failure traces, decisions and acceptance examples. [Coverage and limits](coverage.md) distinguishes file inventory, automated body screening, actual source inspection and untested runtime behavior.

The [full reference feature breakdowns](../../../acceptance/2026-10-26-example-review/feature-breakdowns/README.md) contain all **3,217 catalogued entries**: 1,608 source-traced narrow behaviors and 1,609 declaration-only entries. All 3,575 source anchors passed path/line validation. These local-only inventories preserve the dated reference evidence and omit stale Cerebro status columns; use the current chapters for comparisons and corrections. They are not a claim of 3,217 shipped features.

## Repository chapters

| Repository             | Detailed review                                                            | Main comparison areas                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AFFiNE                 | [Application, services and platforms](affine-application.md)               | All 69 frontend module families; navigation, search, templates, collaboration, permissions, AI/MCP, storage, administration, native/mobile and delivery. |
| AFFiNE                 | [BlockSuite editor, data views and canvas](affine-editor.md)               | Schemas, serialization, clipboard, blocks/inlines, fields/views, gestures, history, rendering, extensions and design-system contracts.                   |
| Outline                | [Full product and service review](outline.md)                              | Editor/document lifecycle, search, import/export, publication, comments, identity, permissions, collaboration, MCP, plugins, jobs and operations.        |
| Macro                  | [Product families and infrastructure](macro.md)                            | Documents/Office/PDF, mail, search, projects/data, AI, media, collaborative sync, native/service boundaries and failure/recovery.                        |
| Activepieces and n8n   | [Workflow platforms and connectors](workflows-connectors.md)               | Authoring, expression/mapping, publication, triggers, durable execution, waits, credentials/OAuth, packages, administration and operations.              |
| n8n                    | [Agent runtime, skills, memory and repair proposals](n8n-agent-runtime.md) | Delegation, tool batches, suspension, cancellation, checkpointing, artifact lifecycle, MCP, budgets/evals and version-bound repair proposals.            |
| Morrow and ThoughtDesk | [Small editor/product implementations](morrow-thoughtdesk.md)              | Editor/database state, publication/export, encryption/privacy, assistant boundaries, native/browser persistence and recovery.                            |
| AppFlowy               | [Workspace, editor, databases and platform](appflowy.md)                   | Desktop/mobile interaction, field/view composition, plugin boundaries, cloud/local state, AI and storage lifecycle.                                      |
| Plane                  | [Work management and service infrastructure](plane.md)                     | Issues/projects/views, page/editor UX, collaboration, roles/integrations, asynchronous work and deployment.                                              |
| Tolaria                | [Local workspace, AI and native integrations](tolaria.md)                  | Durable source carriers, source/rich editor, sheets/whiteboards, multiple CLI adapters, MCP, native lifecycle and diagnostics.                           |

## How to use the findings

- **Retain:** Cerebro already has the behavior or a stronger owning contract. Avoid duplicating it.
- **Adapt:** A concrete interaction or mechanism is useful, subject to the stated acceptance examples.
- **Investigate:** A promising boundary needs more source or runtime evidence before selection.
- **Defer:** A separate product commitment, such as hosted collaboration, broad mobile parity or always-on execution.
- **Reject:** The specified mechanism would weaken ownership, fidelity, privacy or truthful outcomes. This is not a rejection of the entire reference application.

A feature registration, frontend setting, paid-edition flag, native wrapper or test fixture does not establish shipped end-to-end behavior. Full-file inspection also does not prove correctness. Tests and runtime scenarios are proposed or read as source unless explicitly stated otherwise; no reference applications, services, provider requests, builds or test suites were run for this review.

## Important corrections

1. Cerebro already has templates, record views, field arithmetic, IronCalc sheets, JSON Canvas, source editing, comments, conversation layouts, CLI subagents and MCP. The useful additions are more precise than these broad categories.
2. M99 selected-workspace SQLite metadata and its mounted native editor are real. Ordinary vault authority remains separate. This review does not recommend reverting the selected design or automatically activating a conversion.
3. M96 advanced during this review: the macOS production bridge now selects an owned native import bundle; other platforms select unsupported. Live acquisition/provider acceptance was not run, and the inspected Settings copy still describes a metadata-only surface. Metadata, secret acquisition, provider execution and managed routing are different capabilities.
4. AFFiNE and Outline feature breadth includes external implementations, build/edition gates and partial or lossy behavior. Those limits are part of the comparison.
5. n8n has several distinct agent implementations. Approval/suspension semantics from one cannot be generalized to all of them. Its default-off repair service creates reviewed proposals; it is not proof of generally enabled autonomous repair.

## Relationship to earlier work

The earlier [reference audit](../2026-10-24-reference-audit/README.md) and [M93–M99 research](../2026-10-23-m93-m99-research/README.md) remain dated context. They were not overwritten. The two prior local audit packets contain the broad feature/declaration/component catalogs; current chapters supersede stale absence and gate interpretations where fresh source changed the conclusion.

The raw evidence packet is local-only under ignored `docs/acceptance/2026-10-26-example-review/` and `/tmp/cerebro-example-review-2026-10-26/`. It includes per-file classification, body-screen signals, exact inspected ranges/hashes, prior catalogs and validation output. Vendored references and raw evidence are unavailable in a fresh checkout; the maintained prose contains the decisions and limitations needed to understand the review.

## Verification and local evidence download

The [independent review](review-check.md) found no remaining substantive chapter blocker after the recorded corrections. Documentation links, table structure, source-anchor bounds, evidence accounting and scoped formatting are checked separately from runtime behavior. The [complete local evidence archive](../../../acceptance/2026-10-26-example-review/example-review.zip) contains this packet, full feature inventories, component/integration declaration indexes, the all-path census, read ledgers and validation metadata. It is local-only and ignored by Git.
