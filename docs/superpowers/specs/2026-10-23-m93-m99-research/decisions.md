# M93–M99 — Decisions for review

**Proposals, not previously granted approvals.** The user requested the complete
spec/plan packet. That authorizes writing these proposals, not choosing their
product consequences on the user's behalf. Program-local `DEC` IDs do not rename
the repository's permanent D/CV decisions.

Read the [program design](../2026-10-23-m93-m99-program-design.md)
for the integrated recommendation. Each decision below gates only dependent work;
it does not hold all seven workstreams hostage.

| ID     | Decision and recommendation                                                                                                                        | Alternative / consequence                                                                                                              | Gate                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| DEC-01 | Rust owns durable services; retain React/editor and immediate UI state                                                                             | Rust-native UI remains a separate parity prototype with substantial editor/native cost                                                 | M99.1; new service ownership                                    |
| DEC-02 | Compare SQL metadata + Markdown against stable-ID JSON sidecars; prefer SQL only if its portability tradeoff is accepted                           | Sidecars preserve paired-file portability but need multi-file recovery; legacy format may remain if neither wins                       | M99.5 before production M99.6–M99.8                             |
| DEC-03 | First managed provider: GitHub scoped issue read and individually reviewed issue creation                                                          | Another provider changes credentials, reconciliation and test-account proof; no general external-write grant implied                   | M96.2–M96.5                                                     |
| DEC-04 | Classify read/local write/external draft/mutation/send/publish/delete separately; retain mail drafts-only                                          | Sending, publishing or deletion requires a separate policy/product amendment and tests, not a generic Write toggle                     | ACT policy and any FLOW publishing slice                        |
| DEC-05 | Credential references through a Rust-owned OS secret-store adapter for managed accounts; preserve labeled CLI-owned custom MCP                     | An alternative secret store needs threat/backup/locking behavior; plaintext fallback is not assumed                                    | M96.2; provider auth implementation                             |
| DEC-06 | Durable normalized chat: recommend 90 days, choices off/30/90/forever and explicit export/delete; existing installations choose before new capture | Off retains only disclosed live recovery essentials; permanent retention increases privacy/storage obligations                         | M95.2/M95.3; proposed 256 MiB content budget                    |
| DEC-07 | Workflows initially desktop-awake; skip missed occurrences by default, optional bounded latest-once                                                | Always-on execution needs hosting, credential delegation, sync, billing and operational ownership; not a toggle on this desktop runner | M98.4; no hosted promise                                        |
| DEC-08 | First independently scoped children read-only, one level, two concurrent/eight per session, ten-minute deadline, 256 KiB result proposal           | Broader grants, detach/background and longer budgets need measured resource and authority proof                                        | M95.6/M95.7; unsupported backend keeps jobs unavailable         |
| DEC-09 | Three UI compositions; first compare prose/record/Pages/table before global adoption                                                               | Different spacing/density can be chosen from same-content prototypes; preserve current shell/fonts/ownership                           | M94.2/M94.3 and owner visual review                             |
| DEC-10 | Creation recovery first session-only; later persistent recovery is an opt-in adapter over the same draft/submission owner                          | Disk retention requires enable/disable/purge/export and crash reconciliation; no second Resume/Discard system                          | M94.4 now; M98.7 persistence later                              |
| DEC-11 | Source mode body-only through one save owner; governed concepts initially unavailable until their contract is proven                               | Whole-file arbitrary editing would bypass guarded metadata/knowledge and needs a separate design                                       | M93.8                                                           |
| DEC-12 | Optional displaced-byte journal: opt-in seven days, 100 MiB global, 10 MiB per entry, explicit exclusions and failure behavior                     | Existing Git/history alone may suffice; a new journal adds local sensitive-data retention                                              | M93.9 after measuring current recovery                          |
| DEC-13 | New configuration manifests: 64 KiB each, 90 completed days, 64 MiB per vault; active entries pinned                                               | Smaller budget/longer retention changes capture admission; no existing general purge policy is assumed                                 | M97.3; full active quota blocks required capture explicitly     |
| DEC-14 | Versioned workflow JSON carrier and bounded typed steps; proposed 32 steps/256 KiB definition/256 KiB step output/8 MiB run output                 | Arbitrary code, cycles/unbounded expansion or a different carrier need a new execution/retention contract                              | M98.1/M98.2; owner reviews limits                               |
| DEC-15 | Pending/unknown effects and waits retain minimum reconciliation evidence independently of conversation deletion                                    | Evidence deletion must disclose loss of recovery; full-store quota behavior cannot silently discard it                                 | M96.3/M96.6 and M98.3; detailed policy chosen before enablement |
| DEC-16 | Construct history may span all registered vaults visibly; ordinary Agent history is vault-scoped                                                   | A per-vault-only construct view is simpler and more private; historical origins still cannot be inferred                               | M93.3/M93.4                                                     |
| DEC-17 | Improve large-table rendering only with full logical-row find/navigation and measured p95                                                          | Explicit paged views may be preferable to windowing if browser find/accessibility cannot be preserved                                  | M93.6/M93.7; 5k target follows measured spike                   |
| DEC-18 | MCP Tasks/Apps, second backend and live rehearsal each require their own capability/isolation proof                                                | Keep supported tools/preview and defer experiments without blocking the useful beta                                                    | M96.7/M96.8, M98.6                                              |

All limits above are starting proposals unless identified as an existing bound.
They are not evidence of measured workload capacity. Specs contain the detailed
state/cleanup/error behavior that must be reviewed with the numeric choice.

## Decisions that remain deliberately outside the first release

The [coverage register](traceability.md) preserves narrower optional projects:
offline archive import, startup snapshots, broad relationship graph, personal
recall, typed relationship semantics, saved-view bulk actions, CRDT bodies and
always-on hosting. Re-entry requires a demonstrated user journey and a dedicated
scope/authority/recovery specification. Existing content/file or verification
contracts cannot be weakened merely to imitate a reference screenshot.

The first connected beta does not require every item above to be settled.
DEC-03/04/05/15 govern it; core transport ownership is DEC-01. UI comparison uses
DEC-09 and session draft behavior DEC-10. Storage selection DEC-02 can remain open
while both tracks deliver useful improvements.

## Recording review outcomes

For each selected decision, append the date, accepted alternative, affected
requirement/task IDs and any revised limits. Preserve rejected alternatives and
the reason only where they explain a tradeoff. Do not mark an unreviewed default
accepted because a dependent implementation has already been written. A later
change to retention, authority or external effect classes reopens its decision;
ordinary local implementation choices remain the builder's responsibility.

## Final source-review refinements

These clarify proposed implementation choices; they do not claim prior owner
approval or completed product behavior.

- **DEC-02 / M99.3–M99.8:** First metadata conversion retains governed concept
  projection YAML and historical attestation codecs. Select authority only after
  the full reader/writer cutover matrix, backup categories and post-edit rollback
  are reviewable. Record operational-history export/omission explicitly.
- **DEC-03/05 / M96.2:** The first GitHub bootstrap is an explicit native import
  from one selected github.com `gh` login. Rust validates identity and stores the
  app copy in the OS secret store. No app OAuth/device registration is assumed.
  Disconnect disables Cerebro and deletes its app copy; it does not revoke the
  upstream token or sign out gh. Secrets never traverse React or logging.
- **DEC-07/14 / M98.4/M98.9:** Publish remains disabled; Enable pins a selected
  version. Pause stops new automatic starts without canceling existing waits.
  Re-enable begins a new cursor epoch and does not backfill disabled intervals.
- **DEC-06 / M95.2/M95.3:** Archive capture is a Rust completion producer, not a
  panel callback, and includes a display-only user question separate from the CLI
  prompt assembly. The proposed shared byte/event bound must replay the existing
  journal ceilings consistently; truncation is visible. CV-30's delete-stops-run
  behavior changes only in the reviewed archive-deletion phase.
- **DEC-10 / M94.4:** The draft identity includes the frozen creation recipe
  (blank page versus sheet), template version and context; FLOW persistence later
  consumes the same identity. It cannot resume a sheet draft as an ordinary page.
- **M97.5 bounded occurrence query:** Initial shared proposals are 50 returned
  rows, 500 examined sources and 8 MiB examined searchable bytes per query page,
  with explicit continuation/truncation even at zero rows. They bound scanning
  over the existing corpus snapshot, not all vault loading; scale review may
  refine them before the shared artifact is accepted.
- **Managed recipe scope:** M98.7's first brokered recipe uses the delivered
  GitHub action. Existing Gmail Draft reply stays CLI-owned compatibility behavior;
  a managed Gmail workflow remains unavailable until a named drafts-only adapter,
  account bootstrap and mail admission tests are delivered. No send is introduced.

The first daily-work increment can proceed without choosing a new storage format,
chat retention or a second model backend. Those choices do not block correcting
save outcomes, creation recovery, source navigation and visual composition.
