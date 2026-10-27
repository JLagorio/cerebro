# M98 — Workflow platform and retention decision

**Status:** Proposal awaiting the owner's selection. The owner authorized the M93–M99 implementation program; the M98 plan separately requires a format, limits, scheduling and retention choice before these phases. This proposal makes those choices concrete. It does not enable a workflow, import a credential, publish anything externally or schedule work in an existing vault.

[Plan](../plans/2026-10-23-m98-workflows-and-automation.md) · [Design](2026-10-23-m98-workflows-and-automation-design.md) · [Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md)

## Recommended first release

| Choice | Proposal and consequence |
| --- | --- |
| Definition format | Versioned JSON in `.cerebro/workflows/<id>/`, with mutable draft, immutable content-addressed versions and a publication pointer written last. Visible pages remain Markdown. Workflow JSON is a domain format, independent of the selected SQLite page-metadata migration. |
| Execution | Sequential desktop engine written in Rust. It runs only while Cerebro is open and the vault/runtime are ready. No always-on server, parallel join or arbitrary JavaScript/shell step in format v1. |
| Initial steps | Read, declarative transform, condition, managed action, wait and result. Optional agent steps remain unavailable until the supervised-child scope and start-once tests pass. New or imported workflows start disabled. |
| Per-definition limits | At most 32 steps and 256 KiB encoded definition bytes. Declarative mappings allow at most 128 expression nodes and depth 16. Oversized or unsupported definitions fail validation before publication. |
| Output limits | At most 256 KiB normalized output per step and 8 MiB normalized output per run. Large artifacts are references to separately bounded artifacts, never a bypass for unlimited inline data. Missing or skipped output remains missing; it is not replaced with zero, null or current page contents. |
| Catch-up | Default `skip_missed`. Explicit optional `coalesce_latest` may run at most the latest missed occurrence within 24 hours. No unlimited replay of missed runs. Changes to schedule/timezone/version get distinct occurrence identities and do not reinterpret existing waits. |
| Completed detail retention | 90 days from completion for normalized inputs, outputs and detailed execution views. Expiry removes eligible details and labels historical content unavailable. This is local operational storage and is not ingested into the knowledge corpus. |
| Aggregate detail budget | Proposed 256 MiB per vault for retained workflow input/output/detail bodies. Admission stops visibly when full; it does not silently delete unexpired data. New durable work reserves its maximum bounded storage before dispatch, so a provider effect cannot be sent before the recovery identity has durable space. |
| Recovery records | Nonterminal runs, waits, immutable version references and unresolved external effects retain their required identities until safely settled. They cannot be deleted by the 90-day detail cleanup. Capacity problems refuse new work rather than discarding recovery facts. |
| Preview | Deterministic, read-only matching/admission preview using scoped selected samples. It makes no reservation, wake, lease, connector call, enable-state change or model rehearsal claim. Sample secrets and tokens are excluded; unavailable source bytes remain unavailable. |

Completed detail records can include sensitive selected page text and normalized action results. The retention choice authorizes implementing that documented local lifecycle; it is not permission to run a particular workflow or to collect arbitrary samples. Published definitions reference account/connection IDs, never secret values. Existing guarded vault writers, approval decisions and action reconciliation remain authoritative.

Disabling a workflow prevents new starts. It does not silently cancel an already-running action or discard an existing wait. Cancel run is separate; after an outside request has been submitted, an uncertain outcome remains unknown until the action service can reconcile it. Retrying the workflow cannot bypass that unresolved-effect guard.

## Later choices remain separate

This selection would not enable durable creation-form drafts, a live model rehearsal sandbox, managed Gmail sending, external publishing, a server service, live multi-device metadata sync or conversion of the current vault. The initial guided actions use already-approved concrete action adapters and each action's existing review. Calendar preparation creates a reviewable artifact; it is not a booking.

## Required acceptance

- Validate cycles, duplicate/unreachable IDs, missing path-dependent output, schema hashes, limits and unknown formats; publication failure leaves the previous version usable.
- Prove lost-response start/prepare retries return the original run/action and a changed payload conflicts. Duplicate or early resume signals advance at most once.
- Crash at input freeze, action prepare, dispatch, result and wait boundaries; retain pinned versions and unknown effects without rerunning completed steps.
- Use fake clocks for expiry, capacity and missing occurrences; test DST/timezone edits and app sleep/reopen in a packaged build. Display skipped/coalesced counts and unavailable coverage honestly.
- Prove preview uses the same production decision seam and creates no effects. A failed or incomplete source read is not an empty successful preview.
- UI presents step list, current version, account, permissions, waiting decisions and recorded results; approval comes from the shared action service rather than a second workflow approval implementation.

## Owner answer

Pending. Recommended selection: **Implement the bounded desktop workflow proposal above.** Alternative: implement definition/preview work only and leave runner/scheduling/detail retention disabled until a later decision. Other M93–M99 work continues while this choice is pending.

## Implementation continuation — 2026-10-26

The owner's renewed instruction to finish M93–M99 authorizes proceeding with
reversible implementation. The implementation uses the proposed bounded JSON
definition format and Rust validator, with new workflows disabled. This is an
implementation ruling, not an inferred selection of the proposed 90-day content
retention policy. Enabling execution and retaining completed input/output bodies
remain explicit product choices; this work does not activate either in a vault.

The definition layer reuses the existing bounded exact-decimal JSON/schema
implementation. It rejects unknown formats, arbitrary code, invalid control flow,
path-dependent required output, schema digest mismatches and altered sealed
versions. Schedule configuration is data only until runtime admission is wired.


The runtime continuation uses **completed-detail retention Off**. Necessary active
recovery values (run inputs, frozen step inputs, outputs and wait schemas) plus
reserved output space share a 256 MiB active-vault budget. Each step reserves its
256 KiB maximum output before dispatch; the separate 8 MiB run limit counts only
outputs and output reservations. Eligible body rows are removed atomically at
terminal settlement, leaving minimal identities/digests for deduplication.
Unresolved waits and uncertain external effects are nonterminal and keep their
required recovery facts; a full budget refuses new work. This implements bounded
operational persistence without choosing the proposed 90-day completed archive.
New workflows remain disabled until explicitly enabled through the finished UI.
