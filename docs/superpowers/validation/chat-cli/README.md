# M95.1 — Chat and CLI validation

Status: incomplete validation record, not release acceptance. Current implementation remains on `m53-macro-port` at base `6c92709187ee0f1c54a049be23b7717eeb3dfcae` plus shared uncommitted M92–M99 work. Test artifacts identify their checked files; the base commit alone does not identify the built product.

[Current M91/M92 handoff](m91-m92-handoff.md) · [Plan](../../plans/2026-10-23-m95-chat-and-supervised-agents.md) · [M91 historical record](../../plans/2026-10-23-m91-implementation-record.md) · [M92 plan and source handoff](../../plans/2026-10-23-m92-conversation-rail.md) · [Current implementation record](../../plans/2026-10-23-m93-m99-implementation-record.md)

## Current case evidence

| Case | Expected and observed | Evidence class / result |
| --- | --- | --- |
| `reattach_keeps_each_text_block_once_before_done` | Serialize the live reply through the real browser conversation cache, detach, deliver a second whole text block while detached, reattach before Done and assert exact ordered text parts and one tool identity. A third block remains unique while still streaming. Done with unavailable CLI history preserves the same parts. | Synthetic real-hook/cache test: PASS. No native CLI invocation or account used. |
| Busy quota trim preserves prior-turn availability | Real cache and chat hooks retain the live question/reply and attach identity; missing earlier bodies remain explicitly unavailable before Done and after unavailable CLI healing. | PASS: 113 focused tests and independent specification/quality review. Browser coverage below verifies the notice and unsent draft through docked, minimized and canvas presentation. |
| Repeated quota save avoids repeating full trim per delta | Later saves omit the previously discarded prefix before serialization, with zero reads of its historical text; changed cached prefixes invalidate admission. | PASS: causal tests and independent review. Prefix identity checks still scan references; this is not a sublinear-work or absolute retained-byte guarantee. |
| Child projection and partial restoration | Orphan, wrong-parent, contradictory tool/child identity and ambiguous replay evidence stays outside the parent answer. Partial restore keeps cached content on disagreement and shows unavailable child details. | PASS for the bounded reducer/cache/UI slice after independent review and repair: 241 affected cases, plus 14 rail cases. Native/live matrix remains OPEN. |
| Discovery and retry | Native unavailable is distinct from missing; refresh preserves the persistent chat. | M93.5 frontend/browser checks passed; native readiness repair passed 29 focused cases and independent review. This is not authentication or CLI session capability evidence. |

The new reattachment case passed against the existing implementation; no behavioral code was changed to make it pass. An initial test draft used a noncanonical tool-completion name; the final test uses `ToolDone`. The initial helper also emitted a React act warning. The final test awaits startup, reattach and completion under act and passes without that warning. The complete existing hook suite passed 136 cases before the final test-only act refinement; the final focused case passed again in 3.40s. The full suite still has pre-existing act warnings in other cases. No performance conclusion follows from these test durations.

Final focused output is [the retained Vitest log](2026-10-23-reattach-vitest.log). Exact test preimage, final SHA-256 and owned patch are in `.superpowers/sdd/2026-10-23-m93-m99-master-roadmap/m95-1-chat-reconciliation/`. Independent review of this case passed as part of the M95.1 quota follow-up; its final focused rerun passed without an act warning.

The child-attribution review initially found that partial healing could combine a cached child identity with another child’s replayed steps or output. Eight causal failures preceded the repair. Healing now matches one reply, checks tool names, parents and known child identities, and preserves the cached reply on ambiguous or conflicting attribution. The final affected checks passed 241 tests across seven files; 14 additional rail checks, all three current TypeScript configurations, scoped lint/format and independent rereview also passed. The exact source, preimages, failure logs and final proof are retained in `.superpowers/sdd/2026-10-23-m93-m99-master-roadmap/m95-child-availability/repair1/`. Existing test warnings remain recorded; this is not a full repository pass.

Late-delivery checks establish one child/part identity and preservation of the parent answer. They do not deduplicate equal text: several legitimate normalized blocks can share a message ID. Actual duplicate delivery remains owned by Rust UUID filtering and the attach sequence cursor. The historical native unreadable-child and meter runs passed 1 and 60 checks respectively; their recorded binary has since been rebuilt, so those observations are not a current native/live acceptance claim.

## Current browser evidence

The actual browser cache marker is seeded, then the existing mock streaming backend holds a live turn. Light and dark Chromium at 900 × 600 each preserve the same composer node and unsent draft through minimize/reopen and expansion to canvas. Wheel scrolling the named Conversation region exposes the partial-history notice both while streaming and after Done. The notice is at the start of the transcript, not sticky at the latest turn. Both cases passed (47.3 seconds total on a contended machine; no performance conclusion).

The first browser run passed text/identity checks but its captures did not show the notice. A strengthened draft incorrectly scrolled the outer Chat container and failed in both themes. Correcting the test to use real wheel input over the actual scroll region passed; no production layout change was made. The final screenshots were visually inspected for readable notice copy, retained messages and draft. Evidence is [the browser log](2026-10-23-cache-browser.log), [light live view](captures/cache-partial-live-light.png), and [dark completed view](captures/cache-partial-completed-dark.png). Exact new test source and its diagnostic preimages are retained in `.superpowers/sdd/2026-10-23-m93-m99-master-roadmap/m95-1-quota/browser-followup/`. These are browser/mock-backend checks, not native CLI recordings.

Separate child-details checks seed the availability fact in the real browser cache and display it beside the retained parent answer. Both 900 × 600 Chromium themes pass, preserve the draft, and were visually inspected: [light](captures/child-details-light.png), [dark](captures/child-details-dark.png), [browser log](2026-10-23-child-attribution-browser.log). The first sandbox attempt could not bind the local server; the unchanged permitted run passed 2/2. These captures predate the healing-only repair, whose presentation is unchanged. They prove presentation of a seeded fact, not native production of that fact.

## Historical evidence and required live matrix

The dated M91 record reports live Claude Code 2.1.250 probes for foreground researcher flags, subagent event/session storage, summarized thinking, fork flags and denied cross-session tools. These are historical observations, not reruns against the current shared working tree. Its recorded open calls remain evidence gaps unless a later owner record closes them. M92's existing rail/stdin implementation is preserved; its source presence alone is not a packaged acceptance claim.

Current isolated preflight on 2026-10-23 found installed Claude Code **2.1.250** (the repository pin) and `loggedIn: false` in the default recording profile. Only the boolean authentication result was retained; no account/configuration dump was read into evidence. A fresh private fixture folder was prepared at `/private/tmp/cerebro-m95-live-2026-10-23` using the existing setup driver. Its separate login was requested; the signed-in live matrix is **environment-blocked**, not passed. The default `pnpm exec tsx` setup hit sandbox IPC `EPERM`; `node --import tsx` ran the same existing driver successfully without changing the sandbox or normal Claude profile.

The current live matrix still needs sanitized recordings for researcher enabled/disabled, scope escape and disallowed type, parent Stop, missing hooks, each permission/question decision outcome, fork identity, whole-tree and missing cost accounting, context availability, attachment send, restart while waiting, and vault switch. Each future row must identify case ID, exact source/build/toolchain, observed CLI version, expected/observed behavior, pass/defect/environment-blocked result and sanitized artifact references. Use the repository `record-cli` skill and existing sanitization/scanning kit; no auth/config or prompt-secret dumps belong here.

No durable conversation archive, retention opt-in, supervised job execution or current-vault conversion is enabled by this record. Archive retention remains an unanswered owner decision; unrelated implementation continues.


## 2026-10-24 isolated preflight recheck

The same isolated profile still reports CLI **2.1.250** and `loggedIn: false`.
Only those two fields were retained from the bounded local CLI preflight; no
account/config dump or provider call was performed. The prior login request stays
pending. The [bounded supervised-job foundation](../../../acceptance/2026-10-24-chat/m95-supervised-job-foundation.md)
has passing internal checks but admits and launches no job. The successful M96
native-window smoke uses a local fixture CLI and supplies no live CLI isolation
acceptance for this matrix.
