# M99.8 — Native backup coordinator acceptance matrix

This is an implementation design for [M99](../plans/2026-10-23-m99-rust-services-and-storage.md), under the approved SQLite metadata/Markdown decision. [Current implementation status](../plans/2026-10-23-m93-m99-implementation-record.md) and [reproduced inactive-copy failures](../../acceptance/2026-10-24-workspace/portable-backup/nested-format-boundary/root-red/ROOT-CHECKPOINT.md) remain separate from proposed behavior.

Design specification only. No test in this packet was executed. Root owns RED/GREEN registration and all native execution. Use deterministic barriers/test hooks at real production boundaries and observable bytes/handles/publication results; wall-clock sleeps and assertions against a duplicate model are insufficient. The current library's direct-root evidence does not establish these cases.

## Invariants

I1. A renderer never supplies a write/input path as authority. A native choice belongs to the actual live main-window incarnation, its exact mode/input and one pending nonce.

I2. At most one pending workflow, one active chooser/validator/copy and one bounded terminal result exist. No Verified manifest, SQLite transaction, WorkspaceLock or per-part inventory is held across review. Pending TTL never releases a running output lease.

I3. A selected export admitted before a switch reads only its original current binding and physical source identity through the existing Source/PinnedConnection path. A pre-admission switch, same-path reopen, replacement root/database or missing binding refuses.

I4. Output reservation and opening admission share ActiveRoot serialization. Every requested/entered/published opening intersecting the output either wins first and prevents output writes, or loses and cannot begin its native effects or publication. Public active_root=None is not an absence of protected opening scopes.

I5. Exact-file and recursive scopes retain their distinction. Parent/container/higher-ancestor opening or traversal cannot consume inactive/preparing marked output; unrelated siblings remain usable. This is P1's separate required proof.

I6. Native-held original input/parent descriptors reach the actual validator/mkdir. Same spelling with a different valid object refuses. All output leaves are create-new. Error cleanup never deletes an existing or partial output and never follows a replacement.

I7. Output lease lives through the final library validation/publication and closure of every writer/source resource. UI lifetime, elapsed 60 seconds, retired window or lost IPC cannot release it early. Unrelated openings and ordinary UI navigation do not wait for the copy's long I/O.

I8. The existing save owners define acknowledgements. Failure, blocked child draft, retained owner, in-flight/new generation and same-path presentation change do not disappear into success. Later edits remain owned; no copy operation promises to include every future draft.

I9. Results retain their original operation/source labels. Missing native result state is unknown, never implied completion/cancellation. No status read, duplicate commit or reload can write again.

I10. No API acquires ActiveRoot under a source WorkspaceLock/SQLite/ledger or while holding book/listener/native-owner locks. No extra source database FD crosses SQLite's POSIX lock lifetime.

## P2 opening/output interleavings

| ID | Controlled interleaving at actual route | Required observation |
| --- | --- | --- |
| P2-01 | Choose Restore outside A but inside ordinary legacy B; publish B before commit | output_overlap; no container/Pages/metadata created; B remains selected |
| P2-02 | While A remains physically watched, request B and pause before OPEN_LOCK; public active root is None; attempt output under A | refused before mkdir from protected previous scope, despite None |
| P2-03 | Request B and pause before OPEN_LOCK; attempt output under B | refused from latest-requested scope; no copy effect |
| P2-04 | Enter B, pause before recovery/connector/watcher side effects; request C to supersede B; attempt output under B | refused from entered B scope even though latest request is C |
| P2-05 | Reserve output R first; request an ordinary legacy ancestor/container/root of R | refuse before advancing opening generation or agents.begin_open; current watcher/root/agent admission unchanged |
| P2-06 | Candidate observes old scope, then output reservation wins before request/entry lock | newly installed reservation is compared; stale observation cannot enter; no opening side-effect sentinel |
| P2-07 | Opening request/entry wins first, then commit tries to reserve intersecting output | copy refuses before first mkdir; opening can finish normally |
| P2-08 | Reserve/copy R, pause before final manifest or restored_inactive marker, request overlapping legacy opening through direct path and alias | no watcher/connector/recovery/agent publication for intersecting target; final copy may finish |
| P2-09 | Reserve/copy R, request unrelated legacy C and selected D while copy paused | unrelated opening completes; copy still reads original source and never retargets C/D |
| P2-10 | Two requests A then B reach agents.begin_open in reverse order | existing monotonic agent generation rejects stale A; no stale opener effects; only B may publish |
| P2-11 | Enter A then supersede with B; fail A cleanup | A cleanup cannot clear B's requested footprint or copy lease; failure leaves conservative denial if cleanup incomplete |
| P2-12 | New open fails after old watcher stop | previous protected scope retained until a successful replacement; no false absence permits output there; unrelated output remains available |
| P2-13 | Force failed watcher start, failed finish_legacy_open and selected publication failure | actual cleanup occurs before entered footprint releases; no stray watcher/listener becomes active over later output |
| P2-14 | Complete copy; pause after library publication before resources close/reservation removal | overlapping open still refuses; only after cleanup does ephemeral lease end; restored marker remains independently denied by P1 |
| P2-15 | File/parent/containing root renamed or replaced across footprint observation | matching known physical identity refuses overlapping admission; ambiguous/missing identity fails closed; no replacement tree is accepted; unrelated sibling control succeeds |
| P2-16 | Target ancestor contains selected/app-data metadata or a registered/observed selected root through a symlink/nonexistent tail | existing external-write exclusion still refuses; selected namespace denial was not narrowed to current root |

P2-02 and P2-04 are essential: checking only active_root, only the original active root, or only the newest request can pass simpler tests while retaining the actual source gap. P2-09 is the control against holding ActiveRoot/OPEN_LOCK for the full copy. Run actual native route tests at first effect as well as publication.

## Exact choice and source/input handoff

| ID | Stimulus | Required observation |
| --- | --- | --- |
| C-01 | Cancel each native picker | no output, no pending choice or leaked slot/descriptor; truthful cancelled result |
| C-02 | Different window instance with same label, wrong native view, different registration Arc, wrong origin or disallowed URL uses token | refusal before consumption of rightful pending choice; no filesystem work |
| C-03 | Original window destroyed while picker/check is returning | return discarded, pending resources released, no review token becomes valid |
| C-04 | Original window retires after book enters preparing but before gate admission | no first write; live-registration recheck refuses |
| C-05 | Window retires after output admission while copy paused | output lease and worker remain owned until unwind/completion; no false cancelled result or second worker |
| C-06 | Duplicate commit concurrently and duplicate commit after response loss | one invocation reaches first write; other gets already_started/status or invalid_choice; no duplicate output |
| C-07 | Wrong-mode token, expired token, random nonce, token already consumed by choose_restore | exact typed refusal; no implicit new dialog or filesystem work |
| C-08 | Pending lasts beyond 60 seconds versus Running lasting beyond 60 seconds | Pending refuses/cleans up; Running continues with lease; status remains truthful |
| C-09 | Source selected A at choose; switch to B or reopen same A before commit | source opening refuses even if path/workspace ID matches; no output |
| C-10 | Valid commit admission for A, then unrelated switch B before Source opens | Source still re-resolves and validates original A; no read or write of B as source |
| C-11 | Source registry/marker/database changed to another valid binding or object with same ID before Source::open_expected | SourceChanged/WrongIdentity; no alternative source admitted; use real pinned connection boundary |
| C-12 | Legitimate selected body/metadata save completes after choose and before flush/commit | coherent newly acknowledged source may export; content digest/data_version from choice was not incorrectly frozen |
| C-13 | Parent moved away and replaced at identical spelling after choose and after commit's preliminary check | held-parent create primitive refuses replacement; neither replacement nor foreign symlink target receives contents |
| C-14 | Fresh child appears before mkdir or is a symlink/regular file | create-new refusal; original child bytes unchanged; no overwrite or cleanup deletion |
| C-15 | Bundle root replaced by a second valid bundle at same path; separately change valid manifest on original root | original identity/digest refusal; valid replacement is not silently restored |
| C-16 | Input part/metadata/ledger changes after review and during copy/final verify | existing full validator rejects mismatch; no restored_inactive marker published |
| C-17 | Restore container created but Pages/Workspace data creation or later copy fails | typed incomplete with location verification state; preparing/incomplete bytes retained, no automatic removal/retry |
| C-18 | Gate/footprint/book lock poisoned, worker scheduling fails, or worker unwinds | typed unavailable when reportable; active slot/reservation cleanup occurs in correct order after resources close; no fallback copy |

Use Root::create's real held-parent primitive and Source::open's real pinned SQLite implementation in these tests. A pre-check plus an unchanged path-only call is not a passing implementation.

## Save and UI lifecycle

| ID | Stimulus | Required observation |
| --- | --- | --- |
| U-01 | Retained unmounted dirty owner, child Sheet draft, Library explicit-save block, reconciliation failure and pending field save | flush resolves via existing owners or blocks with original identities/links; no backup commit on unresolved result |
| U-02 | New generation/owner appears during async flush or between returned report and immediate commit check | fresh unresolved check blocks; no forged acknowledgement and no lost generation |
| U-03 | Switch, away/back or same-path reopen while chooser/flush await resolves | pending Create stays scoped to original opening and cannot commit; new Settings opening not relabeled |
| U-04 | New edit appears after native commit invocation | edit remains held/saved by original owner; UI promises saved snapshot only; no claim this later generation was included |
| U-05 | Navigate away/unmount Settings during copy and mount it for another vault | app-level operation remains; completion names original source; no write to new vault's success state |
| U-06 | Reload same native webview while Running and after Terminal | status rehydrates single owned operation; no retry; wrong/recreated native window cannot claim it |
| U-07 | Commit response lost before UI receives operation ID | status command without caller path finds own native Running/Terminal; no duplicate commit |
| U-08 | Process restart or terminal result replaced, then old UI asks status | explicit unknown/no known result; explicit Check offered; no automatic write |
| U-09 | Check/Restore pending while current vault changes | held input stays original; current native output overlap checked at commit; no dependence on missing original source |
| U-10 | Native summary fails, unsupported legacy Create, required part fails, unknown count | unavailable/unsupported/refused text; never empty/zero or fake complete result |
| U-11 | Browser demo action | explicit preview state, no native file-written claim |
| U-12 | Close/quit during Running including forced quit | no new exit guarantee; no premature lease release while process alive; later explicit Check treats incomplete output honestly |

## Resource, contracts and regression controls

Measure book and descriptor ownership at every transition. Repeating cancelled/expired/busy requests cannot accumulate queued work, Verified manifests, snapshots or descriptors. A large valid manifest check followed by Pending must drop the large validation object; small summary/descriptor retention is the asserted contract, not merely a map-length test. A second large check while Running is refused before scheduling/reading.

Re-run the existing portable corruption, manifest/part/metadata/ledger, alias/path/symlink, new-root, source-database replacement, ledger-lock and final-publication cases after factoring the kernels. Inspect actual source-lock/SQLite handle lifetime and prove no second pathname connection/FD close undermines the pinned lock. Preserve macOS-only live backup refusal elsewhere and every existing selected/staging/attachment/manifest bound.

Reconcile generated schema bytes and TypeScript from actual Rust DTOs; assert finite native policy covers every new registered command with no unknown fallback. Token-only handlers must verify the exact window in addition to policy. Browser mocks use the same typed outcome vocabulary and never obtain paths as authority. Source audit includes all production request/entry/publish callers so no old target-free bypass remains.

Root must separately execute actual native folder dialogs, cancel/choose/review/commit, save-owner blocking, same-window reload and unrelated-switch journeys. Unit barriers alone do not prove native window observation, Tauri scheduling, main-thread deadlock freedom or packaged UI. Record failed, passing and unverified individually; no aggregate historical count substitutes for these causal cases.
