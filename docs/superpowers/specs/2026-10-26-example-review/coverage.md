# File coverage and review method

Review date: 2026-10-26. All ten supplied reference repositories are accounted for. The prior inventory remains the path baseline. The current pass reads every eligible UTF-8 text body for explicit static signals; this is a machine check, not a claim that a model understood every line. Fresh semantic reads have a separate range-and-hash ledger; legacy evidence limitations are reported below.

## Complete body-screen census

| Repository        | All inventoried paths | Text bodies screened | Text lines screened | Classified/excluded paths | Changed body hashes |
| ----------------- | --------------------: | -------------------: | ------------------: | ------------------------: | ------------------: |
| AFFiNE-canary     |                10,291 |                9,367 |           1,236,145 |                       924 |                   0 |
| AppFlowy-main     |                 4,597 |                3,554 |             524,128 |                     1,043 |                   0 |
| Morrow-main       |                   145 |                  139 |              35,430 |                         6 |                   0 |
| activepieces-main |                31,127 |               30,880 |           2,884,538 |                       247 |                   0 |
| macro-main        |               155,947 |               21,936 |           3,953,782 |                   134,011 |                   0 |
| n8n-master        |                32,113 |               30,263 |           5,744,406 |                     1,850 |                   0 |
| outline-main      |                 2,641 |                2,548 |             442,146 |                        93 |                   0 |
| plane-preview     |                 5,115 |                4,610 |             567,764 |                       505 |                   0 |
| thought-desk-main |                   217 |                  197 |              48,877 |                        20 |                   0 |
| tolaria-main      |                 2,244 |                2,069 |             476,586 |                       175 |                   0 |

The census accounts for **244,437 paths**, screens **105,563 text bodies / 15,913,802 lines**, and detects no changed body hash against the prior inventories. It preserves paths classified as dependencies, generated/lock artifacts, binary assets or build outputs rather than presenting them as product behavior. The outer examples `.DS_Store` is not part of the ten repository totals.

The static checks locate network, file/process, authorization, retry, transaction, cancellation, error/fallback, stub, accessibility, persistence, feature-gate, scheduling and schema signals. They also flag test-like paths, generated headers and conservatively recognizable barrel modules. These signals are review navigation, not security findings, proof of reachability, test passes or semantic coverage. A property called `permission` does not prove authorization; an empty catch is a review candidate until its caller and consequence are traced.

Exclusions by original inventory category: `asset` 4,752, `build-output` 23, `configuration-or-data` 42, `dependency` 128,647, `generated-or-lock` 5,069, `other` 110, `test-or-fixture` 231.

## Semantic review and evidence

The combined packets record **1,990 distinct reference files with substantive body-review evidence**. This continuation freshly inspected **864 reference files / 122,777 distinct line positions**, adding **687 files** beyond the previous 1,303-file union. These are source-review counts, not runtime correctness or all-file semantic coverage.

**1,933 files have quantifiable ranges**, totaling **226,933 recorded line positions** across the combined packets. Range unions cover a complete file for 1,003 files; 930 have partial quantified ranges. The remaining **57 files have legacy body-review claims without recoverable exact ranges** (Morrow 15, Outline 25, ThoughtDesk 17). They contribute zero to the line total and are not described as exact-range coverage.

| Repository        | Fresh files this continuation | Combined files with body evidence | Quantifiable-range files | Legacy claims without exact ranges |
| ----------------- | ----------------------------: | --------------------------------: | -----------------------: | ---------------------------------: |
| AFFiNE-canary     |                           223 |                               677 |                      677 |                                  0 |
| AppFlowy-main     |                            85 |                               165 |                      165 |                                  0 |
| Morrow-main       |                            58 |                               127 |                      112 |                                 15 |
| activepieces-main |                            27 |                                82 |                       82 |                                  0 |
| macro-main        |                            83 |                               190 |                      190 |                                  0 |
| n8n-master        |                            57 |                               107 |                      107 |                                  0 |
| outline-main      |                           143 |                               227 |                      202 |                                 25 |
| plane-preview     |                            97 |                               161 |                      161 |                                  0 |
| thought-desk-main |                            57 |                               129 |                      112 |                                 17 |
| tolaria-main      |                            34 |                               125 |                      125 |                                  0 |

The aggregate requires a matching current reference hash before combining evidence. Fresh reads retain exact printed ranges and hashes; prior explicit range logs are reused only with matching original/current hashes. Prior whole-file attestations are credited as whole-file evidence, while a targeted legacy attestation supplies no invented range. A metadata reconciliation recovered explicit historical ranges for 140 files; 91 previously unquantified files gained ranges. This recovered evidence is prior review, not new semantic reading. No range was inferred from a feature citation or the mechanical census.

The aggregate includes root and independent-review reads as well as repository reviewers, so chapter-local counts may be smaller. Source, tests, configuration and documentation may all appear in body evidence; a test file read is not a test executed. A range-complete file is an accounting result, not a correctness or security certification. AFFiNE's two initially clipped outputs were repaired explicitly: the share-setting prefix by its reviewer and the remaining 83 comment-resolver lines by root.

Current Cerebro comparisons were read separately. The working tree changed during review, so the ledger retains dated hashes and superseded observations; later source edits are not silently counted as reviewed. Material drift was reconciled: M96 changed from an unavailable production worker to an owned macOS import bundle, M98 gained substantive draft/version/publication persistence, and M99 backup/opening ownership advanced. These do not establish live provider, production workflow or migration/activation acceptance. Read the [current baseline](cerebro-baseline.md) and [independent review](review-check.md) for the scoped conclusions. A fresh implementation task must reread affected owners. The final aggregate separately lists later concurrent changes in `src-tauri/src/client_access/listener.rs`, `src/agent/ChatTurn.tsx` and `src/agent/useAgentChat.ts`; those new bytes are not claimed as reviewed. This is a set of dated source observations, not an atomic or zero-drift certification of the changing application.

The generated local [feature breakdowns](../../../acceptance/2026-10-26-example-review/feature-breakdowns/README.md) preserve 3,217 reference entries: 1,608 narrow source-traced behaviors and 1,609 declarations. All 3,575 entry anchors pass path/line checks. Prior Cerebro-status columns were removed to avoid reintroducing stale absence claims. Neither those checks nor the integration/component catalogs certify shipped capabilities.

## What this review does not establish

- Runtime correctness, performance measurements, native accessibility, actual provider authorization or successful external effects. Reference applications, installers, provider calls and test suites were not run.
- A line-by-line semantic certification of every first-party file. Mechanical body screening and feature-family review do not establish that.
- Behavior inside unavailable external packages/submodules, cloud services or excluded vendored dependency bodies. Such boundaries are recorded explicitly.
- Approved implementation scope. Adapt/defer/reject recommendations remain review decisions.

## Local evidence and reproducibility

Raw inventories, signal indexes, exact read ledgers, validation output and any copied evidence belong under ignored `docs/acceptance/2026-10-26-example-review/` and the local scratch directory `/tmp/cerebro-example-review-2026-10-26/`. They are not forced into Git. Maintained prose and decisions are in this tracked documentation directory. A fresh checkout will not contain vendored examples or local raw evidence.

The first mechanical run was interrupted after a whole-file barrel-detection regular expression stalled. That partial output is retained locally as `body-census-interrupted.jsonl` and excluded from totals. The completed rerun uses a conservative per-line check. This affected only scratch tooling; no reference or application code was executed or changed.
