# M93–M99 — Independent reviews and corrections

**2026-10-23 · document review only.** Authors drafted subsystem pairs from the
research and selected current source. Three independent builder passes then read
the designs as engineers who would have to implement them, identifying material
questions rather than aesthetic wording changes. The coordinator self-reviewed
the master and locally authored plans; a separate coverage reviewer mapped every
research finding.

## Pass 1: reliability, chat and Rust/storage

| Finding                                                                    | Correction                                                                                                                                                                        | Disposition                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A new format marker cannot stop already-released clients that ignore it    | CORE specifies a format-aware compatibility release, tested minimum version, newly registered converted root, preserved old archive and explicit unsupported legacy access limits | Corrected; no universal old-client refusal or OS boundary claim |
| CHAT delegated physical archive cleanup to unscheduled CORE work           | CHAT owns numbered archive migrations, logical purge, typed cleanup status and best-effort physical cleanup with WAL/backup limits                                                | Corrected in M95.3                                              |
| CHAT required a nonexistent CORE child claim/lease service                 | CHAT owns child runtime schema, transactional claim/lease/recovery and idempotent admission                                                                                       | Corrected in M95.6/M95.7                                        |
| Deleting a conversation called Stop while claiming never to cancel effects | Active generation/child/approval deletion returns blocked-active; separate user cancellation must settle first; no implicit ACT cancellation                                      | Corrected in CHAT-09 / M95.3                                    |

No material REL blocker was reported. Named existing CORE modify paths were
checked, including the scanner. The independent closure recheck reported all four
findings resolved and confirmed that the master reflects the corrected ownership
and compatibility boundaries. This is not a native deletion or migration test.

## Pass 2: actions and workflows

| Finding                                                                          | Correction                                                                                                                                      | Recheck                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Crash between ACT preparation and FLOW linkage could duplicate pending approvals | Scoped stable prepare key persisted before call; digest-checked idempotent mapping returns original invocation; equivalent child admission gate | Resolved                                             |
| Serializable ActionSubject could be mistaken for caller authority                | Rust derives subject from authenticated context and stored relationships; dispatch internal-only; forged-ID regressions                         | Resolved                                             |
| FLOW introduced a second composer draft store                                    | Consume UX canonical draft/context/revision/submission; persistence is a later explicit opt-in adapter                                          | Resolved after final dialog-claim wording correction |
| Compact effect reference lacked details and revision inputs for review           | Added scoped effect_details, safe previews/attempt receipts and invocation/approval CAS revisions                                               | Resolved                                             |
| Workflow input schema and terminal wait dispositions were missing                | Immutable input schema/digest plus expiry/denial/invalid-input/child-outcome transition table and tests                                         | Resolved                                             |
| Workflow authoring/publishing UI had no implementing task                        | Added M98.9 for editor, mappings, validation, save/publish conflicts and version selection                                                      | Resolved                                             |

The recheck caught one remaining sentence retaining a dialog claim until submission
acknowledgement. It was corrected: the pending operation survives independently,
while closing/unmounting releases the dialog claim so Resume remains possible.
The owner-gated persistent adapter does not change UX's first session-only release.

## Pass 3: knowledge and UI

| Finding                                                                   | Correction                                                                                                             | Recheck  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| Session creation and persistent FLOW recovery conflicted                  | One canonical owner with later persistence adapter and explicit enablement gate                                        | Resolved |
| Close→Resume before create acknowledgement lacked ownership               | Store-owned submission ID/frozen revision, blocked duplicate submit and delayed settlement across unmount/vault change | Resolved |
| CHAT used undefined opaque locationRef while KNOW defined inline locators | CHAT now consumes inline SourceLocator with scope, retention and revocation handling                                   | Resolved |
| Property locations promised body-style reveal without a property owner    | Exact property-row semantics using current field flattening, changed-key/value behavior and M97.2 journey/tests        | Resolved |
| KNOW invoked an unidentified existing run-retention policy                | KNOW owns proposed 90-day/64-MiB manifest lifecycle, active pinning, expiry reasons and admission failure at quota     | Resolved |

The independent recheck reported all five resolved, with no material inconsistency
introduced by their fixes. It also confirmed the explicit byte/hash/position
conventions and the evaluation requirement to use production guards and failing
negative controls.

## Coverage review

The register accounts for all 78 ranked reference findings, 34 CP/AX/UI packages
and 31 UI review IDs. It distinguishes accepted-in-design work, already-existing
behavior needing evidence, conditional experiments and deferrals. In particular,
Plane's broader typed relationship semantics and saved-view bulk execution are
not falsely covered by contextual links or a bounded sequential workflow runner.
They retain explicit re-entry criteria.

## Remaining gates

Owner choices in [decisions.md](decisions.md) are intentionally unresolved.
Current-source inspections do not close native, live-service, performance or
visual acceptance. This review establishes a more coherent proposal; it does
not certify unimplemented software or authorize automatic execution of its plans.

## Milestone naming correction

The owner requested the repository's dated `m<number>-name` convention. An independent read-only audit confirmed M92 was the highest allocated milestone. The seven pairs are now M93–M99 with 60 numbered phases, one master roadmap, one program spec and this research directory. Cross-links and task references were updated; earlier task aliases remain in the traceability register.

M91/M92 files were preserved. The audit also identified overlap with M92's conversation rail, so M94/M95 and the master now require its recorded handoff before modifying shared assistant seams. This correction assigns documentation identifiers; it does not assert that any implementation gate passed.

## Final source-backed builder pass

A final user-requested review added three parallel source-comparison agents and a
fresh chat-contract reviewer. Their findings, exact source references, corrected
dispositions and deliberate limits are preserved in the [final review](final-review.md).
The reviewer-found display-question archive gap was corrected and explicitly
rechecked; master integration has a separate read-only closure check. This extends
the earlier three builder passes without rewriting their historical observations.
