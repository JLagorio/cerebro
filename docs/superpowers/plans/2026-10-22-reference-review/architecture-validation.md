# Independent architecture validation

Date: 2026-10-22. This review challenges the consolidated strengthening plan and
five repository dossiers against the current Cerebro working tree. It is a source
audit, not a fresh runtime reproduction or test pass. Reference snapshots were
read as study material; no application or reference files were changed. Paths and
line numbers below identify the inspected source and may move during later work.

The proposed direction is sound: repair save acknowledgement and history first,
measure scale, then improve agent inspection and task outcomes. Cerebro already
has the central architecture that several reference products would otherwise
suggest building. Three corrections matter before implementation: failed drafts
must survive editor teardown; history scope must reach every detail and link;
and cached search statistics must preserve the effective readable corpus.

## Finding dispositions

| Finding                                                                                    | Disposition                                              | Consequence                                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CP01 failed autosave cannot be retried by ordinary flush after settling                    | Confirmed in source; actual loss incident not reproduced | Keep P0, with acknowledgement and teardown retention in the same acceptance boundary       |
| CP02 global limit precedes actor filtering; detail failures disappear                      | Confirmed                                                | Keep P0; extend scope to detail subsections and child selection                            |
| CP03 native and live acceptance is incomplete                                              | Confirmed as recorded evidence gap                       | Do not label existing implementations absent or browser results native passes              |
| CP04 table scale is already acceptable because rows are memoized                           | Rejected                                                 | Retained production measurements miss the proposed target                                  |
| Cerebro lacks recovery, bounded scheduling, search caching or evidence manifests           | Rejected                                                 | Extend the existing owners instead of introducing replacement subsystems                   |
| A reference's progressive rendering proves bounded virtualization                          | Rejected                                                 | Choose a renderer only after measuring a complete keyboard/editing journey                 |
| Content search's no-index rule forbids every derived index                                 | Rejected                                                 | Preserve the distinction between content search, ledger projection and operational records |
| A workflow retry or wake claim implies exactly-once outside effects                        | Rejected                                                 | Continue to expose uncertain effects and constrain reruns                                  |
| Raw source editing, retained historical configuration and rehearsal are small UI additions | Reclassified                                             | Each needs explicit ownership or retention/isolation contracts before its UI               |

## CP01: the failure is broader than an unavailable Retry button

`src/editor/MarkdownEditor.tsx:671–677` assigns `lastSaved` before the callback
settles. Its `flushPendingSave` emits only when a debounce timer exists
(`:715–720`). `src/editor/NoteBodyEditor.tsx:299–332` catches a rejected write and
reports failure, but does not retain a retryable payload or restore dirty status.
Consequently, a settled autosave failure followed by Save without another edit
has no evident retry path. The existing test at
`src/editor/NoteBodyEditor.test.tsx:227–240` establishes notification, not recovery.

Morrow provides the useful invariant, verified directly in
`docs/examples/Morrow-main/src/storage/saveQueue.ts:97–154`: unsuccessful IDs
return to the dirty set, and the next attempt reads current state. Its
`src/storage/storage.test.ts:89–117` changes the document after failure and expects
the replacement text. Borrow this behavior, not its independent workspace store.

There are two additional teardown constraints. Cerebro's `heldOpenPages` registry
only reports holds for reconciliation, choices and pending outside writes
(`NoteBodyEditor.tsx:510–520`); it does not report a settled failed save. The leave
cleanup clears held content before an asynchronous write
(`:531–545`). More directly, `src/app/quit.ts:181–186` unmounts the shell before
checking leave-triggered failures and explicitly acknowledges that staying open
then cannot keep the text. A component-local Retry state alone cannot solve this.
Retain the latest failed generation outside the disappearing editor, or obtain
an acknowledged/retained outcome before destroying that owner. The retention key
must include vault identity and path; path alone can collide after vault switch.

The first fixture should fail a completed autosave, restore the writer, and Save
without typing. The next must fail a write initiated during leave and verify the
exact draft after quit is cancelled. Include an older failure that predates quit:
the controller currently compares cumulative failures against a counter captured
at quit entry (`quit.ts:174–186`). Failure count is not unresolved-draft state.

Do not silently change unrelated exit policy. `settlePageWrites` returns false on
timeout (`src/lib/ipc.ts:181–205`), but `prepareQuit` ignores that value. The native
gate deliberately exits after five seconds, and Dock Quit/logout bypass the
prepare path (`src-tauri/src/shell/quit.rs:1–29,49–52`). Its timeout and second-quit
behavior already have tests. A promise that _every_ exit preserves all text would
require a separate persistent-draft/native-exit design.

Propagate typed internal outcomes through the existing flush callers. Assistant
launch currently awaits a never-rejecting flush and continues
(`src/agent/useAgentChat.ts:766–771`); rename checks held paths after flushing
(`src/stores/vaultStore.ts:488–497`). Retaining a failure without making these
callers understand it would still let subsequent operations assume screen text
is durable. Keep CV-03's nonthrowing human actions and D2's human-save winner.

## CP02: correct roots are necessary but not sufficient

`src/status/AgentRunHistory.tsx:37–75` fetches the newest 200 global runs, then
filters by actor and can render “No runs recorded.” Rust already applies actor
and vault filters before its limit (`src-tauri/src/runtime/fleet.rs:43–57,276–308`).
The immediate scope repair is justified without waiting for pagination.

Scope cannot be supplied as a raw path in `vault_id`. Runtime identity is derived
from the canonical absolute path; the portable ledger `store_uuid` answers a
different question (`src-tauri/src/runtime/scope.rs:1–31,43–65`). Reuse Rust's
mapping, following the page-scoped command pattern in
`src-tauri/src/lib.rs:459–474`. Keep genuinely global fleet views explicit.

Three adjacent defects belong in the acceptance inventory:

1. Detail requests at `AgentRunHistory.tsx:29–34` have no request identity and
   erase selection on error. A late response can replace a newer selection.
2. Child-hop buttons use the same open handler, but the detail panel is mounted
   only beneath `mine` rows (`:144–152`). Selecting a different actor's child can
   fetch a detail that has no visible host. Test opening the child itself, not
   merely the presence of its row.
3. `KnowledgeChanged` queries the currently open vault
   (`src/status/RunDetailPanel.tsx:72–98`), while `PagesWritten` resolves titles and
   navigates relative paths through current-vault state (`:131–180`). A
   cross-vault run can therefore show the wrong knowledge result or open a
   same-named page in the wrong vault. Carry originating-vault identity through
   detail reads and links; if it cannot be resolved, report that explicitly.

The knowledge subsection also converts read rejection into `null`, despite the
adapter documenting `null` as no ledger/not recorded (`src/lib/ipc.ts:1016–1022`).
Keep unavailable distinct from absent. Macro's retained unavailable row is a
verified presentation reference
(`docs/examples/macro-main/apps/web/src/features/routines/views/routine-history.tsx:85–148`).

Pagination should be a separate bounded change after truthful scoping. Use the
existing `(started_at, run_id)` order, a continuation contract and scoped lineage
reads. Filtering roots by actor must not erase cross-actor children. New history
queries stay on `runtime::ReadOnly`, whose SQLite file mode actually refuses
writes (`src-tauri/src/runtime/read_only.rs:1–13,28–56`).

## CP04: preserve the measurement and the meaning of caches

The retained [production report](../../specs/2026-10-17-polish-implementation/data/performance/production-report.md)
supports 398.8 ms and 1,376.2 ms p95 for 1,000 rows with 12 and 24 fields. It
supports a navigation timeout at 5,000×12, not a measured input failure at that
size. It does not support a 5,000×24 result or native input-to-photon claim.
Twenty synthetic ArrowDown samples are useful diagnostics; they do not establish
editing, filtering, scrolling and save latency. Preserve the original workload
before adding these dimensions, so later comparison remains meaningful.

Thought Desk's `Progressive` increases a retained prefix on scrolling
(`docs/examples/thought-desk-main/src/lib/progressive.svelte.ts:7–50`). Its table
even limits a jump to 500 rows beyond the mounted prefix
(`src/lib/db/TableView.svelte:138–149`). This is evidence for reducing initial
work, not proof of bounded DOM or complete End navigation. Cerebro's discarded
`content-visibility` experiment already demonstrated an actual accessibility-tree
regression. Explicit pagination remains a legitimate alternative when a proposed
virtualizer cannot preserve editing, selection, find and assistive navigation.

Tolaria's bounded content cache is a useful independent mechanism
(`docs/examples/tolaria-main/src/hooks/noteContentCache.ts:118–174`), but its
mtime/size identity must not be transplanted as sufficient freshness. Cerebro
already retains mounted panes and separately caches search bodies. Closed-clean
editor caching is an experiment, not a missing universal cache layer.

Search's existing cache handles stat, ctime/inode and racily clean files
(`src-tauri/src/vault/corpus.rs:1–35`). The scanner deliberately remains uncached
because triggers need fresh changes. `search.rs:23–26` identifies per-file tokens
as the next possible optimization. Preserve the current ordering: `docs_of`
filters readable entries before ranking (`:856–878`). Corpus-level document
frequency/statistics must be keyed by effective readable scope or recomputed
after filtering. A global token cache can be safe; global BM25 statistics shared
across different grants can change scoped results using inaccessible material.

The no-index decision applies to content search. The ledger already has an
explicit, disposable materialized SQLite index that is reconstructed from
authoritative segments (`src-tauri/src/ledger/index.rs:1–19`). Neither this nor
operational `runtime.db` makes SQLite the owner of Markdown content. Avoid turning
historical “no index” prose into a claim that all indexes are unrebuildable.

## Agent and knowledge work: build on the existing authorities

CP07 correctly separates execution configuration from evidence assembly. The
working-memory manifest already represents satisfied/exhausted/blocked intents
and refuses silent counterevidence trimming
(`src-tauri/src/assembly/manifest.rs:1–20`). Its inspector should read that proof.
A new execution manifest needs new dispatch-time facts, explicit retention and
old-run “not recorded” behavior; hashes alone do not reconstruct instructions.

CP08's full rehearsal is an isolation project. Merely substituting a temporary
vault path is insufficient when the process can still reach global runtime
state, scheduler/followups, connectors or shell. Deterministic trigger preview
can ship separately, with an explicit clock and no admission transaction. Its
budget result is an observation at the preview instant, never a reservation or
promise of later admission.

CP09 must preserve existing recovery. Wakes already deduplicate live admission
and claim alongside the run lease (`src-tauri/src/runtime/wakes.rs:1–30`). Expired
leases finalize with unknown usage and requeue (`runtime/dispatch.rs:1231–1274`);
pending writes mark interrupted applications (`runtime/pending_writes.rs:363–374`).
Batch preimages are intentionally deleted at commit, so that journal is crash
rollback, not permanent version history (`runtime/batch_journal.rs:1–15`). This
supports CP11's separate recovery investigation rather than a “missing merge”
claim.

Activepieces's reporter retains periodic snapshots every 15 seconds
(`docs/examples/activepieces-main/packages/server/engine/src/lib/helper/flow-run-progress-reporter.ts:19,33–41,93–125`).
That does not establish exactly-once outside effects. Cerebro should describe
recorded effects and unknowns before rerun, while keeping delegated CLI traces
separate from its own durable handoffs. The fold deliberately skips sidechain
events (`src-tauri/src/agent/fold.rs:31`); changing that requires real protocol
fixtures and preservation of capture/attribution boundaries.

## First reviewable implementation boundaries

1. **Save acknowledgement:** reproduce settled failure; retain latest generation;
   make Save retry it without typing. No persistent archive or automatic retry
   policy is required for this first increment.
2. **Leave retention:** cover failed leave, preexisting failure, navigation and
   vault switch; integrate assistant/rename flush outcomes. Review quit deadlines
   separately from acknowledgement correctness.
3. **History scope:** actor plus authoritative vault identity, visible bounds,
   preserved lineage and correct originating-vault detail/link behavior.
4. **History read states:** keyed selection, child detail host, unavailable versus
   absent and local Retry. Then cursor pagination in a separate change.
5. **Evidence infrastructure:** retain/reproduce the existing benchmark, add the
   smallest outcome fixtures and inventory native acceptance in parallel.

Do not make deterministic preview wait for every live/native case, or make these
correctness fixes wait for an execution-manifest schema. Full rehearsal, source
editing and historical retention each follow their own proven boundary. The
result is a sequence of useful changes without a new content authority, query
framework, workflow engine or shell redesign.
