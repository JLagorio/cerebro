# M93–M99 — Final source review and build handoff

**2026-10-23 · documentation correction, not implementation certification.**
Four independent agent reviews plus coordinator inspection checked all seven
spec/plan pairs, the program/master contracts, the newer M91 implementation
record, M92 ownership and actual source from all eight local example repositories.
Three domain reviewers worked in parallel; a fresh fourth reviewer challenged the
revised chat archive contract and rechecked its correction. The assigned scopes,
findings, source locations and declined judgments are preserved in the audit
reports below. This was a targeted source review, not an exhaustive audit of every
file in the eight repositories.

**Result:** the final pass found real implementation-plan gaps and corrected the
owning documents. M93–M99 retain their 75 numbered requirements and 60 phases.
The [master roadmap](../../plans/2026-10-23-m93-m99-master-roadmap.md#first-build-sequence-after-this-review)
now specifies build order and demonstrable exits. No application code, dependency,
reference source, git staging or branch state was changed by this review.

## Read the evidence

| Review                        | Scope and source comparisons                                                                          | Report                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Core                          | M93/M99; Macro, Tolaria, AppFlowy and Cerebro save/storage/ledger code                                | [Core audit](final-core-audit.md)                                    |
| Connected execution           | M96/M98; Activepieces, n8n and Cerebro policy/runtime/connectors                                      | [Actions and workflows audit](final-actions-audit.md)                |
| Product and knowledge         | M94/M97; Morrow, Thought Desk, Plane and Cerebro creation/navigation/evidence                         | [Product audit](final-product-audit.md)                              |
| Fresh chat contract challenge | Revised M95 with Cerebro live fold/start/cache and neighboring contracts                              | [Chat audit and closure](final-chat-audit.md)                        |
| Coordinator integration       | M95/master; AppFlowy message persistence/actions, Macro transition/reconnect tests, newer M91 handoff | This record and the [reference cross-check](reference-crosscheck.md) |

Finding line numbers in the detailed reports refer to the reviewed pre-correction
text unless labeled as a closure reread. Current phase IDs are the durable lookup.
The [final manifest](final-review-manifest.json) records current document/source
hashes and inspection scope; the earlier source manifest remains historical.

## Material corrections now assigned to implementation

| Gap found                                                                           | Concrete correction                                                                                                                                                                                                                                               | Owning phases                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Save/leave promise omitted diagram and buffered/blur-only writers                   | Inventory all save participants; prepare local buffers before unmount; preserve exact failed payloads and acknowledge through the existing writers. Keep the native five-second hung-webview limit explicit.                                                      | M93.1/M93.2                    |
| Scoped history could exclude an Agent's only run when it was a hop                  | Listing anchors are actor/vault matches, not only parentless runs; lineage remains separately bounded.                                                                                                                                                            | M93.3/M93.4                    |
| Metadata migration treated guarded concept YAML like ordinary metadata              | First conversion retains the complete concept projection codec and historical attestation hashes; full removal requires a versioned ledger design and must never infer re-verification.                                                                           | M99.3/M99.5/M99.6              |
| Format marker/prototype did not migrate direct metadata consumers                   | Require a read/write/guard/import/query/MCP/mock cutover matrix; every supported consumer adapts or explicitly refuses before activation. Supply guard-minted receipts through the mutation boundary.                                                             | M99.1/M99.5/M99.6/M99.7        |
| Backup promise omitted canonical and operational categories                         | Name ledger parts, bodies, attachments, comments, metadata and explicit runtime-history disposition; validate bounded contained restore and post-cutover edits.                                                                                                   | M99.8                          |
| Connect/reconnect had no implementable credential bootstrap                         | Native bounded gh import of one selected github.com login; provider identity validation, app OS-store copy, revision/cancel binding and no React secret path. Disconnect does not claim upstream revocation.                                                      | M96.2                          |
| New MCP broker bypassed its own plan's manifest/policy integration                  | Add scoped action catalog/definition reads and broker entries through shared tools/policy/refusal/goldens; honest external-effect annotations and no MCP person-answer door.                                                                                      | M96.1/M96.4                    |
| Completion before wait parking could strand workflow execution                      | Persist link/wait identity, observe canonical durable outcome and reconcile after commit/restart; one continuation claim, no replacement action or child.                                                                                                         | M98.3                          |
| Publishing could implicitly arm work                                                | New workflows disabled; separate Enable/Pause/Unpublish, pinned activation version/revision, explicit cursor epochs and no disabled-interval backfill.                                                                                                            | M98.4/M98.9                    |
| Workflow recipe promised a managed Gmail adapter that no phase built                | First managed workflow uses delivered GitHub actions; existing Gmail draft recipe stays explicitly CLI-owned until a separate managed adapter exists. Skipped-branch mappings, manual-start idempotency and unknown post-submit responses have explicit outcomes. | M96.3/M96.5, M98.1/M98.2/M98.7 |
| Blank-page and sheet creation could share the wrong resumed draft                   | Freeze recipe/variant/template identity with destination, revision and submission; never resume or submit one as the other.                                                                                                                                       | M94.4                          |
| Source hash could describe different bytes than search ranges                       | Cache hash/body/metadata from the same changed-file read; reject mismatched snapshots and preserve exact raw-byte positions.                                                                                                                                      | M97.1                          |
| Search→source→Back lacked an origin owner                                           | Typed Quick Open/visit snapshot and source-open/return contract; handle held editors, peeks, parked panes, changed results and canvas navigation.                                                                                                                 | M97.2                          |
| Deduplicated backlinks could not identify occurrences                               | Add a bounded raw occurrence producer with snapshot-bound cursor and stable occurrence identity; report caps/changed snapshot without guessed first-match selection.                                                                                              | M97.5                          |
| Unresolved scope descriptors looked like vault files; evidence roles collapsed      | Typed resource targets plus separate observations/producers/basis for supporting evidence; no inference from compact source rows or model wording.                                                                                                                | M94.8, M97.4                   |
| Agent grants picker swallowed failed connector inventory as empty                   | Explicit unavailable/Retry state preserves selected grants and draft; execution remains independently fail-closed.                                                                                                                                                | M94.7/M94.8                    |
| Chat archive had a consumer API but no reliable detached producer                   | Bind attempt/run before launch; Rust completion owns a checked non-reasoning archive carrier, deferred-run settlement, incomplete recovery and tombstones; reuse the single fold/reducer.                                                                         | M95.2/M95.3                    |
| Fold-derived archive could lose the user question or store assembled prompt context | Freeze bounded display-only question/chips before prompt composition; never recover that bubble from confidential CLI prompt assembly. Fresh reviewer found and closed this correction.                                                                           | M95.2                          |
| M91 status and chat conveniences were stale/incomplete                              | Credit the newer implementation record; test reattach before Done and live quota pressure; explicitly wire Copy/Save/Edit-question/Branch recovery through real existing owners. Remove the nonexistent ACT local-save dependency.                                | M95.1/M95.4/M95.5              |

These are design/plan corrections and future regression requirements. They are not
claims that the corresponding current application bugs were reproduced or fixed.
Individual source-confirmed defects remain named as such in the detailed reports.

## The first useful application increment

Begin with acknowledged saves and leave behavior, the four-surface UI comparison,
variant-safe creation recovery, scoped history and precise source navigation.
That is a coherent daily-work improvement a person can feel: edit, recover, create,
find, return. It does not need a new storage format or a second model backend.
M94's visual acceptance uses the same populated prose page, record, Pages browser
and table; source CSS resemblance alone does not settle aesthetic quality.

Build the useful chat controls on the existing assistant and editor. Introduce
durable archive storage only with its explicit retention choice and producer
contract. Then prove the single GitHub account/read/reviewed-create/lost-response
journey through the action broker. Workflows consume that same action identity and
add explicit publication/activation/wait recovery. Rust storage comparison proceeds
in parallel on copies; conversion stays behind actual consumer/recovery/restore
proof. The master lists exact phase order and shared-file ownership.

## Existing failures and evidence boundaries

The newer [M91 record](../../plans/2026-10-23-m91-implementation-record.md) reports
11 unit failures and 42 E2E failures with baseline qualifications. This review did
not rerun those suites and does not certify their current count. M91/M92 keep
ownership of their fixes, recordings and native gates. Each first-build phase
must capture current source identity, reproduce affected baseline failures and
record owners; an affected failure blocks that slice. A release candidate cannot
be called green while required gates are failing or unverified.

The work performed here was source reading, document correction, independent
review, link/phase/coverage validation and explicit documentation formatting.
No application/reference build, browser/native UI capture, runtime test, CLI
research run, provider credential request or migration was executed. The actions
reviewer checked installed gh help and official manuals, without requesting a
token or making an account request. Source snapshots establish patterns only;
reference commit identity and full/paid-edition parity remain unverified.

## Choices deliberately still visible

The [decision register](decisions.md) distinguishes existing contracts from
recommendations: retention, account ownership, child execution capabilities,
storage authority and visual preferences remain explicit. These do not make
ordinary implementation details additional approval gates. In particular, basic
save/UI/source repairs can proceed independently of storage migration and optional
MCP Apps/Tasks, alternate backends, hosted execution, graphs or supervised jobs.
No broad rewrite is required to deliver the first increment.

## Document validation checkpoint

The final packet contains 27 Markdown documents: seven paired milestone designs/plans, the program design/master roadmap and 11 research/review records. Structured checks retained all 75 requirements, 60 phases and 78/34/31 research coverage counts; 360 local links and five Markdown anchors resolved. The source inventory fingerprints 158 inspected files, including 53 files across all eight example snapshots. These counts describe inspection coverage, not exhaustive repository audits.

The starting comparison covered 3,300 existing paths. Concurrent work changed four existing agent IPC/thread-status files and added a conversation-status lab file while this review ran; the manifest records those outside-packet changes without attributing them to a particular author. This review did not write or revert them. Current M91/M92 plan/implementation records remain preserved. Format validation explicitly overrides the repository's docs ignore rule for only this packet.
