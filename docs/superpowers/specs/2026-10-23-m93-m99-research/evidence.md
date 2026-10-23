# M93–M99 — Research evidence

**2026-10-23.** This packet was written from the existing research and selected
current-source rechecks. It is a documentation deliverable. No application unit,
Rust or full E2E suites, native app, live CLI, provider action, migration or
reference application was run for this drafting task.

## Research inputs

- [Five-repository strengthening plan](../../plans/2026-10-22-reference-strengthening-plan.md) and [46-finding packet](../../plans/2026-10-22-reference-review/README.md).
- [AI expansion plan](../../plans/2026-10-22-ai-expansion-plan.md) and [AppFlowy/n8n/Plane plus architecture packet](../../plans/2026-10-22-ai-expansion-review/README.md).
- [UI refresh plan](../../plans/2026-10-22-ui-refresh-plan.md) and [four-pass review](../../plans/2026-10-22-ui-refresh-review/README.md).
- [M91 implementation plan](../../plans/2026-10-22-m91-ai-elements-and-subagents.md), current [AGENTS.md](../../../../AGENTS.md), and linked application source.

Older packets retain their original hashes, dates and evidence limitations. The
new packet supplements their recommendations; it does not rewrite historical
records to match the current source.

## Meaningful source drift since the prior review

| Earlier observation                                                        | Current source observation                                                                                                                                            | Disposition                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Policy artifacts included fields unknown to their loaders; browser blanked | [TS tool approval](../../../../src/lib/policy/toolApproval.ts) and [Rust subagent policy](../../../../src-tauri/src/policy/subagents.rs) now include the added fields | Historical startup failure; fresh startup remains unverified here      |
| Frontend flattened/dropped child structure                                 | [Transcript projection](../../../../src/agent/transcript.ts) now routes children and ordered parts                                                                    | Preserve implementation; reconcile live/replay evidence in M95.1       |
| Context and checked branching paths absent                                 | [Context usage](../../../../src/agent/useContextUse.ts) and [Rust transcript](../../../../src-tauri/src/agent/transcript.rs) contain those paths                      | No duplicate implementation project                                    |
| AI components not adopted in production                                    | [ChatTurn](../../../../src/agent/ChatTurn.tsx) and current agent elements consume them                                                                                | Test complete journeys rather than count components                    |
| Child-hop details not mounted                                              | [Run detail](../../../../src/status/RunDetailPanel.tsx) contains recursive child details                                                                              | Regression coverage; scope/read races still separate REL work          |
| Search exact-passage context not carried to UI                             | [VaultHit](../../../../src-tauri/src/search.rs) still returns display parts/path; [Quick Open](../../../../src/app/QuickOpen.tsx) opens the path                      | KNOW specifies the missing shared location/reveal boundary             |
| Current live permissions are durable across restart                        | [Interaction book](../../../../src-tauri/src/agent/interaction.rs) remains memory-only                                                                                | ACT durable action approval is new proposed work                       |
| Runtime database is a disposable index                                     | [Runtime documentation](../../../../src-tauri/src/runtime/mod.rs) says operational state is not reconstructible                                                       | Preserve runtime separately from proposed workspace metadata authority |

These are source readings, not proof of successful behavior. The M91 plan may
continue advancing while this packet is reviewed; its next implementer records
fresh source identity before deciding which tasks remain.

## Current validation scope

Documentation verification checks the explicit new Markdown/JSON files, local
link existence, plan headers/required sections, requirement/task IDs, coverage
denominators and source fingerprints. Preservation compares the starting
**3,235-path** content baseline with the final tree, including pre-existing
uncommitted changes. The final checks observed concurrent changes to existing
M91 source/test paths, continuing between checkpoints. Their before/after fingerprints are recorded in the
manifest; this drafting task did not write or revert them. New documentation is
the only write scope of this task. A frozen-workspace preservation pass is therefore
not claimed, and those evolving paths need fresh checks at implementation handoff.

The [manifest](source-manifest.json) hashes linked source files and selected
integration seams. It is a final checkpoint, not an atomic snapshot of every
reviewer's observation. Directory links are checked for existence rather than
recursively fingerprinting vendored repositories. Future implementation paths
are not asserted to exist merely because a plan names them as Create.

Independent builder review assessed spec/plan contradictions and shared ownership;
its corrections are in the [review record](review-record.md). There was no
application fix to verify in this documentation task. Future verification commands
inside the plans must not be reported as commands already executed.

## Historical visuals and protocol references

The [October 22 UI evidence](../2026-10-22-ui-refresh-evidence/README.md)
contains failed startup captures and links the older October 17 app images. Those
images predate subsequent shell/panel changes and are not fresh UI baselines.
The new UI plan explicitly requires coherent before/after captures and owner
judgment during implementation.

The ACT author reopened the official MCP changelog, Tasks and Apps references
while drafting protocol boundaries. Those documents describe protocol capabilities,
not support in the installed CLI or a tested Cerebro adapter. Read the ACT spec's
linked primary sources and exact compatibility gates. No interoperability or live
service pass is claimed.

Reference snapshots' upstream commits and image capture dates remain unverified
where the original dossiers said so. No vendored source was linted, tested or
edited as project code. No source copying/license clearance is implied by an
architectural recommendation.

The architecture diagram was syntax-parsed using the installed Mermaid with
JSDOM browser globals. A plain Node attempt first failed because DOMPurify had no
browser environment; the corrected harness parsed the unchanged diagram. This
is a documentation syntax check, not an application test or visual render pass.

## Milestone naming checkpoint

After the original drafting review, the owner requested milestone naming. A new **3,259-path** baseline was captured before renaming. M93–M99 preserve all seven subsystem scopes and their 75 requirements/60 phases, accompanied by the master roadmap and research index. A separate manifest checkpoint records naming/link/phase validation and any concurrent changes; the original source observation hashes and timestamps remain historical.

M92 is now explicitly linked as a dependency for overlapping M94/M95 assistant work. Its plan records its own decisions and probe evidence; this documentation correction did not rerun those probes or certify its completion. No application files were edited for the naming correction.

The naming checkpoint validates 280 local links, two Markdown anchors, seven paired milestone ranges and all 60 phase references; the 75 requirements and 78/34/31 research coverage counts remain intact. Targeted Prettier checks use `--ignore-path /dev/null` on only these 22 documentation files because the repository default excludes `docs/`. The 3,259-path baseline comparison found no changes outside this reorganized packet at the checkpoint.

## Final source-review checkpoint

The later owner-requested final check is recorded separately in
[final-review.md](final-review.md), four domain/fresh-review reports and
[reference-crosscheck.md](reference-crosscheck.md). It reread actual source in all
eight example snapshots and incorporated the new M91 implementation record.
The [final-review manifest](final-review-manifest.json) supersedes earlier hashes
for current document validation while retaining the prior source manifest as
historical evidence. The final pass changed only documentation; it did not rerun
application/reference suites or certify visuals/native/provider behavior.
