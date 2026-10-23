# Four-pass recheck and UI refresh review

**2026-10-22 · research and documentation only.** Four independent reviewers
challenged the expansion roadmap, current M91 integration, visual system,
everyday journeys and acceptance criteria. The coordinating review reconciled
their findings, inspected retained images and attempted the current demo. No
application source was changed.

Start with the [UI refresh plan](../2026-10-22-ui-refresh-plan.md). It adds a
parallel design and interaction track to the
[AI expansion plan](../2026-10-22-ai-expansion-plan.md), building on the earlier
[eight-repository research packet](../2026-10-22-ai-expansion-review/README.md)
and its linked original comparison. This is a further check of that work, not a
claim that all eight reference applications were installed or exercised again.

## Independent passes

| Pass | Review                                             | What it contributes                                                                                                              |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1    | [Architecture and M91](01-architecture-recheck.md) | Current source evidence, stale-claim corrections, broker ownership, save/history/readiness gaps and Rust/storage sequencing      |
| 2    | [Visual system](02-visual-system.md)               | Thirteen candidate refinements, reference image/source comparisons and a three-composition design direction                      |
| 3    | [Product journeys](03-product-journeys.md)         | Twelve journeys covering creation, drafts, metadata, search, navigation, authoring, connections, chat and knowledge              |
| 4    | [Acceptance challenge](04-acceptance-challenge.md) | Six corrections and a surface/state/viewport matrix separating appearance, behavior, accessibility, performance and native proof |

The fourth reviewer also challenged the synthesized delivery plan. That final
pass corrected table/header dimensions, distinguished Button from IconButton
targets, and limited creation-draft recovery to a session until persistent
retention is separately specified.

## Decisions after reconciliation

1. **Give visual quality its own delivery track.** Keep the accepted rail/sidebar,
   typography, tokens, motion, editor and panel ownership. Refine document,
   collection and utility compositions; test them on complete screens. The
   existing implementation is the starting point, not a blank design system.
2. **Start with four concrete surfaces.** A prose page, record with inspector,
   Pages browser and populated table form the first comparison slice. Carry
   accepted geometry, density and action rules to chat and the remaining surfaces.
3. **Update M91 claims at handoff.** Researcher policy, delegation ceilings and
   request fields now exist in source. Their artifacts, loaders and consumers
   are not yet a coherent verified slice. Child-event projection and production
   component adoption remain separate gaps at the recorded checkpoint.
4. **Treat the reproduced startup failure as a blocker to fresh visual evidence.**
   The final browser retry still reports the policy field `agent_types` as
   unknown. This is an intermediate working-tree observation; no current
   rendered UI or native pass is claimed.
5. **Keep correctness visible.** Existing failed-save ownership, actor/vault
   history scope and readiness-error findings remain open. A restyled message
   does not close them. Reuse the existing CP work items rather than estimating
   their repairs twice under UI IDs.
6. **Make execution authority explicit.** The narrow connected-action beta must
   prove that its managed provider is reached through the scoped broker without
   also forwarding raw access to the CLI. Use `outcome_unknown` consistently for
   a mutation whose remote effect is unresolved.
7. **Separate reversible UI work from storage decisions.** Rust services and a
   metadata-authority prototype can proceed alongside the refresh. Replacing
   YAML or React is not a prerequisite for better page composition and chat.

## Finding-to-delivery map

These are coverage links, not additional estimates or a second backlog. UI IDs
are provisional; CP and AX IDs retain their meanings in the earlier plans.

| Findings      | Primary delivery home                            | Boundary                                                                                       |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| VS01–04, VS07 | UI01–02                                          | Three compositions; measured edges; role-based type, actions and corners                       |
| VS05–06, VS08 | UI02–04                                          | Shell, content-appropriate density, cards and inspector; preserve preferences                  |
| VS09; PJ10    | UI05 / AX00                                      | Chat and Agent presentation depends on real M91 producers and reducer integration              |
| VS10–13       | UI01–07                                          | Dark theme, targets, motion and complete states accompany every adopted composition            |
| PJ01; AC03    | Existing CP01 plus affected UI acceptance        | Retain failed drafts and acknowledge actual write success; separate functional repair          |
| PJ02          | Existing performance work plus UI04/07           | Reproduce scale measurements; typography cannot close latency failures                         |
| PJ03–05; PJ08 | UI03                                             | Creation destination, session draft recovery, return paths and vocabulary                      |
| PJ06          | UI02–04                                          | Existing embeds/related records retain their source, scope and writer contracts                |
| PJ07          | UI06 and separately specified passage navigation | Improve current search journeys without pretending passage addressing already exists           |
| PJ09          | UI06 plus connected-action AX packages           | Account repair returns to the originating draft; action availability needs runtime evidence    |
| PJ11–12       | UI06                                             | Knowledge, quiet Home, onboarding and truthful unavailable/not-recorded states                 |
| AC01–02       | UI00 and package release definitions             | Coherent startup; separate correctness, visual targets and new capabilities                    |
| AC04–06       | UI07 and each package's acceptance               | Actual pane geometry, real zoom, measured accessibility, focus/status/scroll and native checks |

The final plan preserves database rows at **32/44/56px** with a **36px header**,
Button roles at **28/32/36px**, and IconButton targets at **24/28/32px**. Alternative
dimensions are proposals to compare, not descriptions of existing source.
UI03 includes session-scoped creation recovery; restart recovery needs a separate
store and retention decision. Engineering allowances exclude unresolved runtime
work and do not predict the elapsed time needed for owner or native review.

## Evidence and limits

The [browser and image evidence record](../../specs/2026-10-22-ui-refresh-evidence/README.md)
contains the failed fresh check and the historical captures actually inspected.
October 17 images predate later toolbar, sidebar and panel changes. Reference
images establish examples of composition; their capture dates and upstream
commits were not independently established. Source readings establish concrete
implementation seams, not interaction quality or measured accessibility.

The [source manifest](source-manifest.json) records local source hashes, checked
document links and preservation of the starting workspace. It is a final
checkpoint rather than an atomic snapshot of every reviewer's observation. The
earlier packet's manifest remains historical and was not rewritten to imply a
fresh verification of all its claims.

Validation for this documentation update comprises explicit Markdown/JSON
formatting, local link existence, source fingerprints and a comparison against
the starting 3,137-path content baseline. Only three pre-existing documentation
files were intentionally amended: the AI expansion plan, its review index and
the connector/workflow dossier. New review/evidence files were added. The
isolated browser startup was attempted and failed as recorded; application unit,
Rust and full E2E suites were not run for this documentation-only change.

Fresh before/after visuals, owner aesthetic acceptance, real interaction checks,
performance remeasurement and packaged native acceptance remain work for the
implementation phases. This packet specifies those gates; it does not mark them
complete.
