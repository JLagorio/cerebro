# Knowledge UI vs project invariants

> Audit lens `ui-invariants` · first-pass auditor, each finding adversarially verified

## Summary

Only one component in the whole UI reads ledger_status: ReconciliationBanner. It ignores the verdict, can check before the launch scan has run (so it misses a divergence found that session), turns a failed read into "no banner", and gives no paths, no preview and no confirmation before a destructive restore. Every other knowledge surface acts as if the reconciliation mode does not exist. Chips, lanes and "What changed" are folded from the ledger's Aug 16 state while the concept pane shows the Aug 17 disk bytes. Human actions like Verify and Approve still write projections, which silently overwrites the divergent files. The two most serious problems are that Verify on the 3 divergent concepts, which currently sit in Needs review, attests content the user never saw, and that ledger refusals are invisible even though write.rs relies on them being visible.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F77 | high | yes | Verify on a divergent concept attests ledger bytes the user never saw and silently overwrites the out-of-band file |
| F78 | high | yes | No knowledge surface except the banner knows the mode is open; ledger-derived views silently show pre-divergence state beside post-divergence files |
| F79 | high | yes | Banner copy 'Automatic capture is paused' misstates the mode: agent, verify, proposal and background writes all continue |
| F80 | medium | yes | Banner checks ledger_status before the launch scan runs and never re-checks, so a newly detected divergence shows no banner that session |
| F81 | medium | yes | Ledger health is invisible: the verdict is never rendered, a failed status read renders as 'all well', and write.rs's silent fallback relies on that visibility |
| F82 | medium | yes | The banner gives the user nothing to decide with: opaque count, no paths, no preview, no confirmation, and a 'Keep my files' that is certain to refuse |
| F83 | medium | yes | Editing a knowledge file in a doc while the mode is open fails with a generic 'Couldn't save page'; the suspension reason is dropped |
| F84 | medium | yes | Concept reading pane turns a failed read into an empty body and never re-reads after a rewrite |
| F85 | medium | yes | Knowledge update log renders 'Nothing logged yet' for any read failure |
| F86 | low | yes | chipsFor collapses 'ledger unavailable' and 'file not in the ledger' into null; the contract FacetChips documents has no caller |
| F87 | low | yes | Background meter shows counted usage as plain numbers when accounting is unknown |
| F88 | low | yes | Agent context special-cases the retired 'Project' type name |

### F77 — Verify on a divergent concept attests ledger bytes the user never saw and silently overwrites the out-of-band file

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src/knowledge/KnowledgePanel.tsx:396`
  - `src/pages/KnowledgePage.tsx:311`
  - `src-tauri/src/ledger/concepts.rs:98`
  - `src-tauri/src/ledger/concepts.rs:140`
  - `src-tauri/src/ledger/concepts.rs:213`
  - `src-tauri/src/ledger/manifest.rs:184`
  - `src-tauri/src/policy/commit.rs:1319`

**Evidence**

The Verify button is enabled whatever the ledger state. verify_concept goes to verify_with, which never checks state.reconciliation_open(). It attests `belief.current()`, the LEDGER revision (content hash of the Aug 16 projection), then calls write_projection. manifest::write_projection only compares the prior file hash with the NEW projection hash (L200). It never compares against the manifest's recorded hash, so it overwrites whatever is on disk. The reading pane shows the disk body (readNote, KnowledgePage.tsx:287). Live vault: the 3 divergent files (gcs-5-supervision-ratio, tx-6-*) have no `verified` key, so they appear under Needs review and invite exactly this click. Proposal Approve goes through the same unguarded projection write in policy/commit.rs:1319.

**Impact**

A human verifies what they read (Aug 17 text), but the ledger records an attestation of different bytes (Aug 16), and the file they looked at is replaced without a word. This breaks the 'agent-written, human-VERIFIED' guarantee in the worst way: a signed review of content nobody reviewed. The mode also stays open, so the banner persists after the file was quietly 'restored' one concept at a time.

**Recommendation**

Refuse verify_concept and proposal apply while reconciliation is open (same RECONCILIATION_SUSPENDED error capture uses). In manifest::write_projection, refuse when the prior disk hash is neither the manifest's content_hash nor the target. In the UI, disable Verify with a reason when ledgerStatus says the mode is open.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** The mechanism holds end to end. Nothing on the verify path checks the reconciliation state:
- **The button:** it is enabled whatever the ledger state.
- **The IPC command:** it passes the request straight through.
- **The ledger function:** `verify_with` attests the ledger's current revision (the Aug 16 projection), not the text on disk.
- **The file write:** `write_projection` compares the file on disk only with the new projection bytes, never with the manifest's recorded hash. So the Aug 17 out-of-band text on disk is overwritten without any notice.

Meanwhile the reading pane shows the disk body from `readNote`. The user reads Aug 17 text, and the ledger records an attestation of Aug 16 bytes.

`reconciliation_open()` is only read in `reconcile.rs` and `shadow.rs` status. No reference to it exists in `policy/`, `mcp.rs`, `knowledge.rs`, `concepts.rs`, `KnowledgePage` or `KnowledgePanel`.

The mode stays open after a verify, because only a `reconciliation.resolved` event clears `reconciliation_divergences`.

Live-vault check: none of the 3 divergent files has a `verified` key. The ledger has no `/fields/verified` revision and no `belief.attested` event at all. So all 3 files count as 'unverified', `needsReview` puts them in the review queue, and the Verify button is live for them.

Two points soften the claim slightly, but not enough to change the severity:
1. **`policy/commit.rs` `project_applied`:** it skips any path whose manifest entry already matches the new projection. A proposal Approve therefore overwrites a divergent file only when the proposal changes that concept's projection. Approving an unrelated proposal leaves the file alone. When it does touch the concept, the write is the same unguarded, disk-blind overwrite.
2. **Recoverability:** the overwritten Aug 17 bytes still exist in the vault's own git autosync commits. They are not lost for good, but Cerebro keeps no record of them: the prior hash is cleared from the manifest once the write completes.

**Evidence checked.** - `src/knowledge/KnowledgePanel.tsx:396-403`: the Verify button is `disabled={verifying || verifiedToday}` only. No ledger or reconciliation input.
- `src/pages/KnowledgePage.tsx:281-296`: the body shown is `readNote(vaultPath, selectedConceptPath)`, i.e. the bytes on disk.
- `src/pages/KnowledgePage.tsx:309-318`: `verify()` calls `verifyConcept` with a patch built from the disk-scanned `selected.entry`.
- `src-tauri/src/lib.rs:931-940`: the `verify_concept` command runs only `guard_verify`, then calls `vault::write::verify_frontmatter`.
- `src-tauri/src/vault/write.rs:350`: this delegates to `ledger::concepts::verify_concept`.
- `src-tauri/src/ledger/concepts.rs:98-107`: only the `knowledge/` prefix check, then `shadow::with_writer` (`shadow.rs:294-306`), which has no state check.
- `src-tauri/src/ledger/concepts.rs:140-172`: `current_state`, `belief.current()`, then a `belief.revised` for `/fields/verified` built from the ledger fields.
- `src-tauri/src/ledger/concepts.rs:178-208`: `belief.attested` with `attested_content_hash = hash(project(current.content, current.fields))`, the ledger bytes.
- `src-tauri/src/ledger/concepts.rs:211-214`: `write_projection(vault, rel, &projection)`.
- `src-tauri/src/ledger/manifest.rs:184-230`: `prior = sha256(disk)`, compared only with `projection.content_hash` (L200). Otherwise it stores Pending with the prior hash, then an atomic temp+rename over the file. It never compares against the manifest's recorded hash.
- `src-tauri/src/ledger/reduce.rs:842`: `reconciliation_open()` is the only gate, and grep shows it read only in `reconcile.rs` (L256, L408, L514, L912) and `shadow.rs` L392.
- `src-tauri/src/ledger/reduce.rs:4541-4590`: the mode is cleared only by `apply_reconciliation_resolved`.
- `src-tauri/src/policy/commit.rs:1300-1321`: `project_applied` skips entries where the manifest matches the projection. Otherwise it calls the same `write_projection` with no disk-versus-manifest check.
- Live vault: the 3 divergent files have no `verified:` frontmatter key. `grep -c` finds 0 `belief.attested` events and 0 `/fields/verified` revisions in the `.ndjsonl.open` segment.
- `src/engine/okf.ts:698`: `!humanReviewed`, so the reason is 'unverified' and the concept lands in Needs review.

**Correction.** The core claim is accurate. One detail needs narrowing: a proposal Approve (`policy/commit.rs` `project_applied`) rewrites a divergent file only when the approved proposal changes that concept's projection. Paths whose manifest entry already equals the new projection are skipped. The overwritten out-of-band bytes can still be recovered from the vault's git autosync history, though Cerebro keeps no record of them.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** I tried to refute this and couldn't. The claim is reachable in the live vault right now.
- **No guard anywhere on the verify path.** It runs `verify_concept` (lib.rs:931) → `guard_verify` → `verify_frontmatter` (write.rs:350) → `concepts::verify_concept` → `verify_with`. Nothing on that chain checks `reconciliation_open()`. The only checks are in capture.rs and reconcile.rs. `shadow::with_writer` (shadow.rs:294) returns the writer whenever one is active, and it is active here: seq 179 was captured through it.
- **The wrong bytes get attested.** `verify_with` takes `belief.current()` from the ledger state and appends `belief.revised` (the `verified` stamp only). It then appends `belief.attested`, whose `attested_content_hash` comes from projecting the LEDGER content and fields. That is the Aug 16 text plus the new stamp, not the Aug 17 disk text the user read.
- **The disk file is overwritten without a word.** Next it calls `write_projection`. At manifest.rs:200 that function only compares the current file hash with the NEW projection hash. When they differ it writes the file, and it never checks the manifest's recorded hash or reports an out-of-band difference.
- **The UI invites the click.**
  - KnowledgePage reads the body from disk (`readNote`, ~L287).
  - The Verify button is disabled only by `verifying || verifiedToday`. Neither KnowledgePage nor KnowledgePanel reads the ledger or reconciliation state.
  - `needsReview` includes `unverified` (okf.ts:698).
  - `verifyPatch` sends only `{verified: [...]}`, so the file-sourced text never reaches the ledger.
- **The mode stays open.** `reconciliation_open` = `reconciliation_divergences` is not empty (reduce.rs:842), and verifying never resolves a divergence. The banner stays up while that one file quietly goes back to the ledger text.

Two minor corrections, neither of which lowers the severity:
- **commit.rs is narrower than stated.** `project_applied` (commit.rs:1300-1322) skips any path whose manifest entry already matches the new projection. So a proposal Approve overwrites only divergent files whose belief the proposal actually changes, not every divergent file.
- **The Aug 17 bytes are recoverable.** The vault's autosync git commits (Aug 17 11:51-11:57Z) still hold them, so the overwrite is not permanent data loss. It remains a signed attestation of content nobody reviewed.

**Evidence checked.** - **src-tauri/src/lib.rs:931-940:** the `verify_concept` IPC runs `guard_verify` (path and key scope only), then `vault::write::verify_frontmatter`.
- **src-tauri/src/vault/write.rs:342-352:** `verify_frontmatter` hands off to `ledger::concepts::verify_concept` when a writer is active.
- **src-tauri/src/ledger/concepts.rs:98-106, 116-213:**
  - `verify_with` uses `current_state` and `belief.current()`.
  - It appends BeliefRevised, then BeliefAttested, where `attested_content_hash` = `project(&current.content, &current.fields)`.
  - It ends with `write_projection(vault, rel, &projection)`.
  - There is no `reconciliation_open` check.
- **grep:** `reconciliation_open` appears in non-test code only in reduce.rs:842, shadow.rs, reconcile.rs and capture.rs (L322/642/779/840/885). There are no hits in concepts.rs, knowledge.rs, mcp.rs or policy/.
- **src-tauri/src/ledger/manifest.rs:184-237:** `write_projection` computes the prior hash from the disk file and compares it only with `projection.content_hash` (L200). On a mismatch it writes the file, with no check against the manifest's recorded `content_hash`.
- **src-tauri/src/ledger/shadow.rs:294-306:** `with_writer` has no gate for the reconciliation state.
- **src-tauri/src/policy/commit.rs:1300-1322:** `project_applied` skips entries whose manifest already matches the new projection. It calls `write_projection` otherwise, with no divergence check.
- **UI:**
  - src/knowledge/KnowledgePanel.tsx:396-399: the button is `disabled={verifying || verifiedToday}`.
  - src/pages/KnowledgePage.tsx:~285-330: `readNote` supplies the disk body, and `verify` calls `verifyConcept` with `verifyPatch`.
  - src/engine/okf.ts:1036-1044: `verifyPatch` returns `{verified: [...]}` only.
  - src/engine/okf.ts:698: `unverified` is a review reason.
  - Neither KnowledgePanel nor KnowledgePage references the ledger or reconciliation state.
- **Live vault (read-only):** none of the 3 divergent files has a `verified` key, so they land in Needs review. Manifest hash vs disk hash:

| File | Manifest `content_hash` | Disk sha256 |
|---|---|---|
| gcs-5-supervision-ratio.md | e096dab8… | b11f52e0… |
| tx-6-changeover…md | d3291abf… | 14b6aa9e… |
| tx-6-np-shared…md | f9517aae… | 176c6cf3… |

All three entries are `write_state: complete`, so Verify would attest and write the ledger bytes over the differing disk bytes.

**Correction.** The claim holds as stated, with two refinements. First, `policy/commit.rs` `project_applied` rewrites only paths whose projection changed against the manifest. So a proposal Approve overwrites a divergent file only if that proposal revises that belief, not every divergent file. Second, the overwritten Aug 17 bytes survive in the vault's autosync git commits, so the loss is recoverable. The defect is still a real one: an attestation of content nobody reviewed, plus a silent revert of that one file while the mode stays open.

</details>

### F78 — No knowledge surface except the banner knows the mode is open; ledger-derived views silently show pre-divergence state beside post-divergence files

- **Severity (claimed):** high
- **Category:** parity
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src/knowledge/useBeliefChips.ts:41`
  - `src/pages/KnowledgePage.tsx:650`
  - `src/knowledge/BaseItself.tsx:194`
  - `src/knowledge/BaseItself.tsx:603`
  - `src-tauri/src/lib.rs:563`
  - `src-tauri/src/attention/status.rs:537`
  - `src/status/SystemSection.tsx:172`

**Evidence**

`grep -rn ledgerStatus src` finds only ReconciliationBanner. Belief chips (keyed by path, with no content hash in BeliefChips: mockIpc.ts:1035), attention lanes and converge ('What changed') are all folded from ledger frames. attention::status and convergence contain no reconciliation reference, and LanesView.incomplete never names the open mode. Out-of-band edits are not recorded while capture is refused, so 'What changed' renders 'Nothing has changed since the last time anybody looked.' (BaseItself.tsx:195) while 3 concept files changed on disk. SystemSection says 'The background is running.' and its banners (runtime_health/source_health/ingestion/accounting_unknown) have no ledger kind.

**Impact**

For gcs-5-supervision-ratio the provenance column shows Support/Coverage/Validity for the Aug 16 revision directly under the Aug 17 body, with nothing marking the mismatch. For 39 days every 'what the base knows about itself' tab has been making statements about a history that disagrees with disk, and none of them says so.

**Recommendation**

Add ledger/reconciliation state to one shared feed (e.g. extend LanesView.incomplete and ChangesView with a 'reconciliation open: N paths diverged' sentence from Rust) and render a per-concept 'disk differs from recorded history' marker when a path is in the divergence sample.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** The mechanism is real. The only TS consumer of ledgerStatus/reconciliation_open is ReconciliationBanner. On the Rust side, belief_chips (dynamics::bundle), attention::status::for_vault and convergence contain no reconciliation or divergence reference. BeliefChips is joined to the file on screen by path alone, with no content hash or manifest check. That means KnowledgePage passes chipsFor(chipIndex, path) into KnowledgePanel, and the panel shows axes for the last ledger revision (Aug 16) beside whatever body is on disk (Aug 17). Live data confirms the 'What changed' claim. For the test vault's store (30de3878…), the latest convergence_runs row has to_seq=273, and the ledger head is also 273, so converge with no from_seq computes an empty window. BaseItself's Changes then renders 'Nothing has changed since the last time anybody looked.' Every event after the divergence (seq 181–273) is vault.write, and the three refused concept edits were never recorded at all. SystemSection's 'The background is running.' reflects global_pause only and has no ledger kind.

The claim is overstated in one place. The views are not fully 'silent', and it is wrong that 'none of them says so' for 39 days. ReconciliationBanner is mounted once, app-wide, in App.tsx:339 above the canvas column. It shows on every surface, including Knowledge and Base, whenever the mode is open. So the user is told that the base as a whole disagrees with disk. What is actually missing is scoping. No per-path marker says which 3 files diverged. The chips, lanes and 'What changed' views give no caveat that they describe ledger state and not disk state. And the 'Nothing has changed' sentence stands as an unqualified claim beside an open divergence. This breaks the spirit of 'unavailable is never empty', but in a way that sits under a visible global warning, so medium is a better fit than high.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:19,37: this is the only ledgerStatus consumer (grep of src). It is mounted app-wide at src/App.tsx:339, above every surface.
- src/knowledge/useBeliefChips.ts:41-60 → ipc.beliefChips; indexChips keys on `${KNOWLEDGE_DIR}/${row.path}` only. BeliefChips (src-tauri/src/dynamics/bundle.rs:102-112; src/lib/mockIpc.ts:1035) has belief_id/path/revision_event_id/facets and no content hash. bundle.rs has no reconcil/diverg/manifest references.
- src/pages/KnowledgePage.tsx:650: chips={chipsFor(chipIndex, selected.entry.path)} is passed to KnowledgePanel.
- src-tauri/src/attention/status.rs:537-550: `incomplete` names only the parked-promotions read failure, never reconciliation. No reconcil/diverg grep hits in attention/ or convergence/.
- src-tauri/src/lib.rs:563-596: converge sets from_seq = latest stored run's to_seq, and an empty window is 'a real answer'.
- runtime.db convergence_runs for store 30de3878c1e1224a950a933de9543c62 (the vault_registry row for /Users/joseflagorio/Documents/test): max(to_seq)=273, last generated 2026-08-31T04:04Z. The ledger head is seq 273, so the window is empty, the view is quiet, and BaseItself.tsx:195 renders 'Nothing has changed since the last time anybody looked.'
- Live ledger: all events after seq 180 are kind vault.write (93). None of them covers the 3 diverged concept files.
- src/status/SystemSection.tsx:172: shows 'The background is running.' based only on overview.global_pause.

**Correction.** No knowledge-derived view (belief chips, attention lanes, 'What changed', System) checks reconciliation_open or the diverged paths. They present ledger-derived state as current. For example, 'What changed' in the live vault really does render 'Nothing has changed since the last time anybody looked.' (the last run's to_seq equals head 273), and the chips on gcs-5-supervision-ratio describe the Aug 16 revision beside the Aug 17 body. However, the reconciliation banner is app-wide chrome shown on every surface, including Knowledge, so the divergence is not hidden from the user. The defect is that the warning is not scoped: nothing marks which files diverged, and the self-description views carry no caveat. Severity: medium, not high.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Mechanically true:** only ReconciliationBanner reads ledgerStatus. The chips, attention lanes, converge (What changed) and SystemSection all have no reconciliation or divergence input. No view marks a path whose disk bytes differ from the ledger-projected bytes.
- **Overstated:** "none of them says so" is wrong for the whole app. App.tsx:339 mounts `<ReconciliationBanner>` inside the main column, above every surface, so the Knowledge and Base tabs show that banner while the mode is open. What is missing is per-surface or per-concept marking, not any signal at all. The one real hole is that the banner catches ledgerStatus errors and returns null.
- **What changed:** the exact "Nothing has changed" string is only likely, not shown. The window runs from the last stored converge run to the head. The ledger holds 93 `vault.write` events after the divergence (seq 181–273), so the window may not be empty. Also, the 3 edits would be missing from What changed even with no mode open, because no ledger events exist for them. That is the capture-refusal and bypass defect, not a UI-invariant one.
- **Chips claim holds:** chips are indexed by path only (useBeliefChips.ts indexChips; `belief_chips` → dynamics::bundle::for_vault). KnowledgePage.tsx:650 passes them into KnowledgePanel with no hash check, so gcs-5's Aug 16 chips render beside the Aug 17 body with nothing marking the mismatch at the panel level.
- **Severity:** the global banner already tells the user the base disagrees with disk. That makes this a medium clarity gap, not high.

**Evidence checked.** - **grep for ledgerStatus / reconcil / divergen across src** (excluding tests): the only real use is src/app/ReconciliationBanner.tsx. The other hits are unrelated comments (vaultStore.ts:192, SyncBadge.tsx:17, etc.).
- **Rust:** no reconcil/divergen reference in src-tauri/src/attention, convergence, agent or mcp.rs. lib.rs only has resolve_reconciliation (L917-924).
- **src/App.tsx:336-339:** `<ReconciliationBanner vault={vaultPath} />` is rendered at the top of the main column, so it is global across surfaces.
- **src/knowledge/useBeliefChips.ts:27-34:** indexChips builds a byPath map with no content hash.
- **src/pages/KnowledgePage.tsx:650:** `chips={chipsFor(chipIndex, selected.entry.path)}`.
- **src-tauri/src/attention/status.rs:529-548:** for_vault reduces ledger frames; `incomplete` only names parked-promotion read failure.
- **src-tauri/src/lib.rs:563-596:** converge window runs from the last stored run (or 0) to the head, over ledger frames only.
- **src/knowledge/BaseItself.tsx:192-195:** the quiet text "Nothing has changed since the last time anybody looked."
- **src/status/SystemSection.tsx:170:** "The background is running." keys only on global_pause.
- **Live ledger** (python count, seq>178): 93 `vault.write`, 1 `projection.overridden`, 1 `ledger.divergence`. Events kept being written after divergence, so the converge window is not necessarily empty.

**Correction.** - **Corrected claim:** apart from the banner, no knowledge surface is aware of reconciliation mode. The banner itself is mounted app-wide in App.tsx above every surface, so the base is not silent overall.
- **The real gap:** belief chips (keyed by path, no content hash), attention lanes, "What changed" and SystemSection don't mark concepts whose disk bytes differ from the ledger projection. The banner also swallows ledgerStatus errors, so it can disappear.
- **"What changed":** it would miss the 3 out-of-band edits whether or not the mode is open, because they never reached the ledger. It says "Nothing has changed" only if no belief-relevant frames fall in the window since the last stored run, and 93 `vault.write` events were written after the divergence.

</details>

### F79 — Banner copy 'Automatic capture is paused' misstates the mode: agent, verify, proposal and background writes all continue

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src/app/ReconciliationBanner.tsx:45`
  - `src-tauri/src/ledger/capture.rs:321`
  - `src-tauri/src/ledger/concepts.rs:68`
  - `src/agent/useJobRunner.ts:206`

**Evidence**

Only the capture entry points check reconciliation_open (capture.rs:322/642/779/840/885). The code itself says 'agent writes continue' (capture.rs:321). concepts::write_concept, append_log, verify_with, policy commit and the ambient/auto-learn job runner (no 'reconcil' reference anywhere in src/agent or src-tauri/src/{policy,maintain,mcp.rs}) all keep writing and regenerating projections.

**Impact**

A reader naturally takes 'paused' to mean the base has stopped changing until they choose. In fact the agent keeps revising concepts, and each revision re-projects from the ledger, which can overwrite the very divergent files the user is being asked to decide about. What the user chooses between keeps changing under them.

**Recommendation**

Either gate every projection writer on the mode (see the Verify finding), or change the copy to say exactly what is paused (your in-app edits to knowledge/) and what is not. Also pause the background distiller while the mode is open.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The mechanism is real.** The only reconciliation gates are on the capture entry points in capture.rs. They also exist in reconcile.rs, where they gate the resolve and scan paths. concepts.rs has no gate on write_concept_with, verify_with or append_log_with, route() has none, and neither do writer.rs or policy/. The same is true of the TS job runner: useJobRunner.ts gates only on autoLearn, vaultPath and ledgersReady. The code's own comment admits this: capture.rs:320-321 says "(agent writes continue)".
- **The overwrite hazard is real.** write_concept_with on an existing path runs revision_ops, then route, then project_belief, then manifest::write_projection. That renames ledger-projected bytes over the file on disk. Even the no-op branch (concepts.rs:351-357) rewrites the projection. So an agent write to decisions/gcs-5-supervision-ratio.md would silently replace the Aug 17 bytes that "Keep my files" is offering to keep.
- **Overstated point 1: the wording is technically accurate.** "Automatic capture" is the code's term for adopting out-of-band edits, and that IS paused. The defect is that the copy leaves out the writes that are not paused. It does not state something false.
- **Overstated point 2: it did not happen in this vault.** The claim says the agent "keeps revising concepts" and the choice "keeps changing under them". The live ledger shows otherwise. Seqs 181-273 are 93 events, all of kind vault.write, and all on non-knowledge paths (records/tasks/kk.md, home/untitled.md, test/bets.list.yml, types/*, collection.yml). There are zero belief or knowledge events after the divergence at seq 180. So the hazard is latent here, not observed.
- **Severity is medium, not high.** This is misleading copy plus a latent overwrite path. No evidence of harm in the incident vault.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:45-47: the copy reads "...({status.divergences.length} unresolved). Automatic capture is paused until you choose."
- src-tauri/src/ledger/capture.rs:320-324: the comment says "while reconciliation is open, automatic capture is suspended — resolve the divergence first (agent writes continue)", then `if state.reconciliation_open() { return Err(RECONCILIATION_SUSPENDED) }`. The other capture gates are at :642, :779, :840 and :885.
- `grep reconciliation_open src-tauri/src`: outside capture.rs it appears only in shadow.rs (status), reconcile.rs (scan and resolve) and reduce.rs (definition). It is absent from concepts.rs, writer.rs, mcp.rs, knowledge.rs, policy/ and maintain/.
- src-tauri/src/ledger/concepts.rs:325-379 (write_concept_with): current_state, then revision_ops, then route, then project_belief. The no-op branch at :351-357 still calls write_projection.
- src-tauri/src/ledger/concepts.rs:215-216: verify_with calls project_belief, then write_projection.
- src-tauri/src/ledger/concepts.rs:887-888: append_log_with rewrites log.md.
- src-tauri/src/ledger/manifest.rs:184-224: write_projection overwrites the file when its hash differs, via a temp file and rename.
- src/agent/useJobRunner.ts:205-207: the auto-learn job gates only on `!autoLearn || vaultPath === null || !ledgersReady`. It never checks reconciliation.
- Live ledger (/Users/joseflagorio/Documents/test/.cerebro/ledger/…0001.ndjsonl.open), seq > 180: 93 events, all of kind vault.write. Top paths: records/tasks/kk.md ×46, home/untitled.md ×14, test/bets.list.yml ×13, types/bet.md ×7. None touch knowledge/, and there are no belief.* events.

**Correction.** The banner leaves out that agent write_concept, verify_concept, log appends and the auto-learn job are not gated during reconciliation. Any of them can re-project a concept and overwrite the divergent on-disk bytes the user is deciding about, so "paused" understates what still runs. "Automatic capture" is literally accurate in the code's vocabulary, since out-of-band adoption is suspended. And in the live vault nothing touched knowledge/ during the 39-day open window: all 93 later events are non-knowledge vault.write. This is a latent hazard plus incomplete copy, not observed churn. Medium severity.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Mechanism: confirmed.** Only the capture entry points check `reconciliation_open()`. `write_concept_with`, `append_log_with` and `verify_with` never check it. Neither do `shadow::with_writer` or `manifest::write_projection`.
- **Clobbering: confirmed.** `write_projection` renames the reducer's bytes over the disk file without comparing them to the manifest. An agent `write_concept` or log append on a divergent path during reconciliation would silently replace the very file the user is being asked to decide about. After that, "Keep my files" has nothing left to keep.
- **The copy is overstated as a defect.** "Automatic capture" is the code's own term for recording out-of-band edits, and that really is suspended. So the sentence is literally true. It is misleading by omission: it does not say that agent and verify writes continue and can overwrite those files.
- **Live vault: the harm has not happened.** Seqs 181–273 (Aug 22–31) are all `vault.write` shadow events for non-knowledge paths: records/tasks/kk.md, home/, test/, types/. There are zero knowledge/ belief events and nothing for log.md after the divergence at seq 180. So the three divergent files have not been re-projected under the user.
- **Severity.** High becomes medium. The overwrite path is real but conditional (an agent must write one of the 3 divergent concepts or log.md), it has not occurred in 39 days of the open mode, and the copy is technically accurate.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:45-47 has the "Automatic capture is paused until you choose" copy. Its header comment (lines 6-7) says "automatic capture is suspended".
- src-tauri/src/ledger/capture.rs:320-324 has the comment "automatic capture is suspended — resolve the divergence first (agent writes continue)". RECONCILIATION_SUSPENDED is checked only at capture.rs:322/642/779/840/885.
- src-tauri/src/ledger/concepts.rs:325-379 (`write_concept_with`): no reconciliation check. It calls `route()`, then `write_projection`. The same holds for `append_log_with` (line 800+) and `verify_with` (line 118+).
- src-tauri/src/ledger/shadow.rs:294-306 (`with_writer`) has no mode gate.
- src-tauri/src/ledger/manifest.rs:184-241 (`write_projection`) reads the prior hash only to record `previous_content_hash`, then unconditionally writes a temp file and renames it over the target.
- `grep reconciliation` finds no hit in mcp.rs, knowledge.rs, writer.rs, policy/ or src/agent.
- Live ledger (d62256b3…-0000000000000001.ndjsonl.open) after seq 180: seqs 181-273 are all kind `vault.write`. Paths: records/tasks/kk.md ×46, home/untitled.md ×14, test/bets.list.yml ×13, types/bet.md ×7, and others. No knowledge/ path and no belief/projection events, so no agent write has touched the divergent files since the mode opened.

**Correction.** The banner is literally accurate: capture of out-of-band edits is suspended. What is real is omission plus an unguarded overwrite. During reconciliation, `write_concept`, `append_log` and `verify_concept` still commit and run `manifest::write_projection`, and that overwrites the disk file without checking for divergence. An agent revision of one of the 3 divergent concepts or of log.md would therefore silently discard the disputed on-disk bytes. The live vault shows no knowledge/ writes since seq 180, so this has not happened there. Medium severity: a latent data-overwrite risk plus incomplete banner copy, not a high-severity misstatement that is actively changing the user's choice.

</details>

### F80 — Banner checks ledger_status before the launch scan runs and never re-checks, so a newly detected divergence shows no banner that session

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/stores/vaultStore.ts:118`
  - `src/stores/vaultStore.ts:123`
  - `src/App.tsx:339`
  - `src/app/ReconciliationBanner.tsx:24`
  - `src-tauri/src/lib.rs:1467`
  - `src-tauri/src/ledger/shadow.rs:144`

**Evidence**

openVault sets vaultPath synchronously (L118), which renders the shell (App.tsx `if (!vaultPath)` gate) and mounts the banner, whose effect calls ledgerStatus at once. start_watcher, which runs shadow::activate and then reconcile::launch_scan (the step that appends ledger.divergence), is awaited only after scanVault, loadCollections and listFolders (L120-123). The banner's only refresh triggers are mount/vault change and its own button actions. There is no listener for 'vault-changed' or for scan completion.

**Impact**

In the session where the divergence is first recorded, the user gets no banner while capture is already refusing their edits. The banner appears only after a relaunch, separated in time from the edits that caused it.

**Recommendation**

Have start_watcher return the launch-scan outcome (reconciliation_open, sample paths) or emit an event, and refresh the banner on it and on 'vault-changed'.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** The code does what the claim says, and I could not refute any part of it.
- **Order of calls.** `openVault` sets `vaultPath` synchronously. The `App.tsx` gate then renders the shell, and the `ReconciliationBanner` effect calls `ledgerStatus` right away. `startWatcher` is only called after `scanVault`, `loadCollections` and `listFolders` have all resolved.
- **Where the event is written.** `start_watcher` calls `shadow::activate`, which calls `reconcile::launch_scan`. The `ledger.divergence` event is built inside `launch_scan` (reconcile.rs:376, within 216-410).
- **What status reads.** `ledger_status` → `shadow::status` classifies and reduces the on-disk ledger itself, not the Active slot. On first open it therefore reads the ledger before the divergence event exists and returns `reconciliation_open: false`.
- **No re-check.** The banner's only refresh triggers are mount, a change to the `vault` prop, and its own button actions. `vault-changed` is only listened to by `vaultStore`, which calls `rescan()`, and `rescan()` never touches ledger status. Nothing else calls `ledgerStatus`.

Result: in the session that first records a divergence, capture is paused but no banner shows until relaunch or a vault switch. The divergence is persisted, so the banner does appear on the next launch. That limits the impact to a single session, but it is still a silent pause of capture, so medium stands.

One small addition: a vault switch also re-runs the check, because `refresh` depends on `[vault]`. Only launch-time detection writes divergence events (every `PathClass::Divergence` use outside tests is in reconcile.rs), so this gap applies to launch-time divergences only.

**Evidence checked.** - src/stores/vaultStore.ts:118 sets `vaultPath` synchronously. `await ipc.startWatcher(path)` at L123 runs only after scanVault, loadCollections and listFolders (L120-122).
- vaultStore.ts:126: the `vault-changed` listener only calls `rescan()`.
- src/App.tsx:310: the `if (!vaultPath)` gate. App.tsx:339: `<ReconciliationBanner vault={vaultPath} />`.
- src/app/ReconciliationBanner.tsx:16-26: `refresh` depends on `[vault]` and runs from `useEffect` on mount. It is re-invoked only by `act()` (L28-35). No event listener.
- src/lib/ipc.ts:308 is the only non-test caller of `ledger_status`, and the banner is its only user.
- src-tauri/src/lib.rs:1467-1478: `start_watcher` calls `ledger::shadow::activate`.
- src-tauri/src/ledger/shadow.rs:144: `activate` calls `reconcile::launch_scan`.
- src-tauri/src/ledger/reconcile.rs:376: the `LedgerDivergence` event is built inside `launch_scan` (216-410).
- src-tauri/src/ledger/shadow.rs:367-397: `status()` reads and reduces the disk ledger via `classify` and `reduce`, and returns `state.reconciliation_open()`. It has no dependency on activation having run.

</details>

### F81 — Ledger health is invisible: the verdict is never rendered, a failed status read renders as 'all well', and write.rs's silent fallback relies on that visibility

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/app/ReconciliationBanner.tsx:17`
  - `src/app/ReconciliationBanner.tsx:37`
  - `src/lib/ipc.ts:283`
  - `src-tauri/src/ledger/shadow.rs:396`
  - `src-tauri/src/vault/write.rs:612`
  - `src-tauri/src/ledger/shadow.rs:289`
  - `src-tauri/src/mcp.rs:42`

**Evidence**

ReconciliationBanner `.catch(() => setStatus(null))` and renders nothing for null. `verdict`/`detail` (corrupt, gap, fork, foreign-writer, foreign-store, diverged) are never displayed by any component. For a refused ledger, status() returns reconciliation_open=false (shadow.rs:396), so no banner appears either. ipc.ts:283-285 still says 'no UI consumes this yet'. write.rs:612-615 justifies the legacy file-first concept write ('a ledger the startup verdict refused; the refusal is visible through ledger_status'), and with_writer returns None for a refused ledger, a lost lock or a different active vault. Live files carry generated.by 'claude-code' (mcp.rs DEFAULT_ACTOR) with zero ledger events, which is consistent with this fallback.

**Impact**

This breaks 'unavailable is never empty'. An unreadable or refused ledger looks exactly like a healthy one, knowledge writes then bypass the ledger without any signal, and the next launch scan classifies those same writes as 'provenance forgery'. The user sees nothing until a divergence banner appears on a later launch (if the race above does not hide it), with no link to the cause.

**Recommendation**

Render a ledger-health line (verdict + detail) in the Background tab and a distinct banner state for non-valid verdicts and for status-read failure. Make the legacy fallback in write.rs refuse, or record an operational refusal, instead of writing silently. Delete the stale 'no UI consumes this yet' comment.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Every part of the claim holds up in the code, and I found one gap that makes it worse.
- **Banner hides a failed read:** if the `ledgerStatus` call fails, `ReconciliationBanner` sets status to null and shows nothing (L19-21, L37). The page looks exactly like a healthy ledger. That breaks the "unavailable is never empty" rule.
- **Verdict is never shown:** `ReconciliationBanner` is the only UI that reads `ledgerStatus`, and it uses only `reconciliation_open` and `divergences`. The `verdict` and `detail` fields reach no screen, and ipc.ts:284 still says "no UI consumes this yet".
- **A refused ledger shows no banner:** for Corrupt, Gap and Fork, `classify` has nothing readable (recovery.rs:128-130), so `status()` reports the mode as closed (shadow.rs:396).
- **The silent fallback is real and reachable:** `with_writer` gives up when no writer is open for the vault (shadow.rs:295-305). `write_concept` then falls back to writing the file first (write.rs:612-626). Its `shadow_write` → `record` step also quietly does nothing, so the ledger gets zero events.
- **Worse than claimed, lost lock:** when a second app instance fails to take the ledger lock, the verdict is still Valid but no writer opens (shadow.rs:114-120). `ledger_status` re-reads the disk every time and never asks whether this process holds a writer (shadow.rs:367-407, lib.rs:1462). So it reports "valid" while writes go around the ledger. The comment at write.rs:614 ("the refusal is visible through ledger_status") is false for this case, not just unseen.
- **Fits the incident, not proven:** the Aug 17 files were stamped by `claude-code` and got zero ledger events, while commit trailers show a readable head. A second instance losing the lock would produce exactly that. A different active vault is also possible; the code alone can't tell which happened.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:16-22: `.catch(() => setStatus(null))`, with a comment saying an unreadable status renders no banner. L37: `if (status === null || !status.reconciliation_open) return null`. `verdict` and `detail` are never read.
- grep of src/: `ledgerStatus` and `LedgerStatus` are used only in ReconciliationBanner.tsx, ipc.ts and mockIpc.ts. No component renders the verdict.
- src/lib/ipc.ts:283-285: "no UI consumes this yet".
- src-tauri/src/ledger/recovery.rs:104-131: read errors (Corrupt, Gap, Fork, ForeignWriter-multi, NoLedger) return `read: None`.
- src-tauri/src/ledger/shadow.rs:396: `None => (None, None, 0, 0, false, Vec::new())`, so the mode reads as closed.
- shadow.rs:114-120: on Valid, `LedgerWriter::open(&vault,&id).ok()`, with the comment "A held lock (second instance) lands in the None arm below: shadow stays silent there".
- shadow.rs:367-407: `status()` only re-reads the disk and has no knowledge of the Active writer. lib.rs:1462-1464 passes it straight through.
- shadow.rs:295-305: `with_writer` returns None when there is no Active, a different vault, or `writer` is None. shadow.rs:309-321: `record` silently returns in the same cases.
- src-tauri/src/vault/write.rs:609-626: the legacy file-first fallback, with the comment "the refusal is visible through ledger_status".
- src-tauri/src/mcp.rs:42: `DEFAULT_ACTOR = "claude-code"`. mcp.rs:2501/2649: server stamps `generated {by, at}`.

</details>

### F82 — The banner gives the user nothing to decide with: opaque count, no paths, no preview, no confirmation, and a 'Keep my files' that is certain to refuse

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/app/ReconciliationBanner.tsx:46`
  - `src/app/ReconciliationBanner.tsx:53`
  - `src/app/ReconciliationBanner.tsx:61`
  - `src-tauri/src/ledger/shadow.rs:393`
  - `src-tauri/src/ledger/reconcile.rs:441`
  - `src-tauri/src/ledger/reconcile.rs:597`
  - `src/lib/mockIpc.ts:576`

**Evidence**

`status.divergences` holds opaque sha256 detection keys (live: 1aa2ef74…), so '(1 unresolved)' counts events, not the 3 affected files. The event's sample_paths are never passed to the UI. Both buttons fire immediately. Restore regenerates every projection and deletes any knowledge/*.md the reducer cannot explain (reconcile.rs:441-470), with no preview and no confirmation. Accept refuses on the first forged generated stamp and returns a raw string ('accept-current-files refused at <path>: provenance forgery…'), shown in red with no suggested next step. The mock hard-codes reconciliation_open:false and throws on resolve, and no vitest or e2e file references 'reconciliation-banner'.

**Impact**

The user is asked to make an irreversible choice blind. One option cannot succeed on this vault and the other discards the Aug 17 edits without listing them. Nothing tests this recovery path.

**Recommendation**

Send affected paths (and per-path classification: adoptable/forged/missing) in LedgerStatus. List them in the banner and show what Restore will revert or delete, with a confirmation. Disable or explain 'Keep my files' when a dry-run diff would refuse. Add a mock seam and a component test for the open state.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Every part of the claim checks out in the code, and all of it is reachable.
- The count: the banner shows `status.divergences.length`. `divergences` is built from the keys of `reconciliation_divergences`, which are detection keys, not file paths. So "(1 unresolved)" counts divergence events, not the 3 affected files.
- No paths: `LedgerStatus` has no field for affected paths. The TS schema parses `sample_paths` from the event body, but nothing passes it to the banner.
- No preview or confirmation: both buttons call `resolveReconciliation` directly on click.
- Restore is destructive: it rewrites every projection from reducer state and deletes any `knowledge/**/*.md` the reducer cannot explain. It shows no list of what it will change first.
- Keep my files will refuse: accept runs `capture::diff_projection_file` on every file that doesn't match. That function returns an error whenever the `generated` stamp changed. The live file `knowledge/decisions/gcs-5-supervision-ratio.md` still carries `generated.at: 2026-08-17T11:52:02Z`, which differs from the ledger's projection. Paths are checked in sorted order, so accept fails at the first such file with the raw string "accept-current-files refused at <path>: provenance forgery: the generated stamp changed out of band — refused". The banner shows that string in red with no next step.
- Mock and tests: the mock hard-codes `reconciliation_open: false` and throws on resolve. Only `src/App.tsx` and the component itself reference `ReconciliationBanner` or `reconciliation-banner`, so no vitest or e2e test covers this path.
- Severity stays medium: the only way out is an uninformed, irreversible choice, but no data is lost until the user clicks.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:46: the count is `status.divergences.length`.
- src/app/ReconciliationBanner.tsx:53 and :61: both buttons call `act(...)` directly, with no confirmation.
- src/app/ReconciliationBanner.tsx:67: the raw error string is rendered.
- src/app/ReconciliationBanner.tsx:19-21: a failed status read becomes `setStatus(null)`, so no banner shows.
- src-tauri/src/ledger/shadow.rs:393: `state.reconciliation_divergences.keys().cloned().collect()` sends only keys, no paths.
- src/lib/ipc.ts:295-296: `divergences` is documented as "Unresolved divergence detection keys".
- src-tauri/src/ledger/reconcile.rs:441-473 (restore): `write_projection` runs for every projection path, the manifest is trimmed with `retain`, and a WalkDir loop calls `remove_file` on any .md not in `projection_paths`.
- src-tauri/src/ledger/reconcile.rs:~597-599 (accept): `capture::diff_projection_file(...).map_err(|e| format!("accept-current-files refused at {path}: {e}"))?`, so one failing file aborts the whole action.
- src-tauri/src/ledger/capture.rs:962-966: `if key == "generated" || key == "verified" { return Err("provenance forgery: the {key} stamp changed out of band — refused") }`.
- Live file /Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md: `generated: {by: claude-code, at: 2026-08-17T11:52:02Z}`, the Aug 17 out-of-band stamp.
- src/lib/mockIpc.ts:570-594: `resolveReconciliation` throws and `ledgerStatus` returns `reconciliation_open: false`.
- A grep for `reconciliation-banner|ReconciliationBanner` across src and e2e finds only src/App.tsx and the component itself.

</details>

### F83 — Editing a knowledge file in a doc while the mode is open fails with a generic 'Couldn't save page'; the suspension reason is dropped

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/editor/NoteBodyEditor.tsx:161`
  - `src-tauri/src/lib.rs:102`
  - `src-tauri/src/ledger/capture.rs:154`
  - `src/app/useOpenPath.ts:33`

**Evidence**

Knowledge files keep their document form (useOpenPath.ts:33-35) and open in the editable NoteBodyEditor. save_note sends knowledge paths through capture_body_edit, which returns RECONCILIATION_SUSPENDED ('reconciliation is open for this vault — resolve the divergence before capturing edits'). NoteBodyEditor's catch throws away `e` and toasts "Couldn't save page".

**Impact**

A human edit to a concept fails on every debounce with no explanation. The one sentence that names the cause and the fix never reaches the user, and the editor gives no sign the page is effectively read-only for now.

**Recommendation**

Show the refusal message in the toast/save state. Better, open knowledge files read-only with an inline note while ledgerStatus.reconciliation_open is true.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** Every link in the claimed chain is real and reachable. A knowledge/ path is never a record: isRecordEntry excludes isKnowledgePath. So useOpenPath falls through to navigate({kind:'doc'}), and DocPage mounts an editable NoteBodyEditor. That editor's readOnly is only `lossy && !unlocked`, and nothing checks the reconciliation state. save_note sends knowledge paths to capture_body_edit. When a writer is active, as in the live vault where the mode is open, capture_body_edit returns Err(RECONCILIATION_SUSPENDED) before it does anything else. NoteBodyEditor's `catch {}` drops the error and toasts "Couldn't save page". Nothing under src/editor or src/pages reads ledgerStatus or the reconciliation state; only App.tsx, ReconciliationBanner, ipc and mockIpc do. So the reason and the fix never reach the editor, and every debounce or Cmd+S fails the same way. One small correction: DocPage does show a red "Couldn't save" label in its header (SAVE_LABEL.failed), so there is a visible failure signal. It still gives no reason and does not say the page is effectively read-only, so the claim holds. update_frontmatter follows the same pattern through capture_frontmatter_patch at capture.rs:886.

**Evidence checked.** - src/engine/typeCatalog.ts:167-177: isRecordEntry excludes knowledge paths, so useOpenPath.ts:~93 opens them with navigate({kind:'doc'}).
- src/pages/DocPage.tsx:580: renders NoteBodyEditor; :168 SAVE_LABEL.failed = "Couldn't save".
- src/editor/NoteBodyEditor.tsx:161-165: `try { await saveNote(...) } catch { emitSaveState('failed'); toast("Couldn't save page"); return; }` (the error is never bound).
- NoteBodyEditor.tsx:194/262: readOnly={locked}, where locked = lossy && !unlocked. Nothing gates on reconciliation.
- src-tauri/src/lib.rs:102-111: save_note sends knowledge paths to ledger::capture::capture_body_edit.
- src-tauri/src/ledger/capture.rs:154: RECONCILIATION_SUSPENDED = "reconciliation is open for this vault — resolve the divergence before capturing edits". :834-842: capture_body_edit returns it when state.reconciliation_open().
- grep over src/ for "reconciliation|ledgerStatus" (non-test): only App.tsx, ReconciliationBanner.tsx, ipc.ts, mockIpc.ts and lib/epistemic. Nothing in editor/ or pages/.

</details>

### F84 — Concept reading pane turns a failed read into an empty body and never re-reads after a rewrite

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/pages/KnowledgePage.tsx:281`
  - `src/pages/KnowledgePage.tsx:291`
  - `src/pages/KnowledgePage.tsx:297`
  - `src/pages/KnowledgePage.tsx:318`

**Evidence**

`.catch(() => { if (!cancelled) setBody(''); })`, so an unreadable concept renders as a blank body under a real title. The effect's deps are `[selectedConceptPath, vaultPath]`. verify() awaits rescan() (L318), and agent writes, Restore and proposal apply all change the file, but the body is not re-read. Only the header, chips and provenance (from entries) refresh.

**Impact**

This breaks 'unavailable is never empty'. After Verify on a divergent concept (which re-projects Aug 16 bytes), the pane keeps showing the Aug 17 text beside refreshed metadata, so the user believes they verified what is on screen.

**Recommendation**

Hold a tagged loading/unavailable/ready state for the body and render section-unavailable on failure. Add the entry's modifiedAt (or a content hash) to the effect's deps.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - The code is real and reachable. KnowledgePage reads the body with `readNote` inside a useEffect whose only deps are `[selectedConceptPath, vaultPath]`. On failure it calls `.catch(() => setBody(''))`, so a read that failed renders as an empty body under the real title and description. That breaks "unavailable is never empty".
- `verify()` awaits `rescan()`, which refreshes `entries` (title, chips and provenance). Neither effect dep changes, the page is not remounted (App.tsx:102 has no key), and `ConceptBody` is keyed by path. So the body is never read again after a write to the same concept. Selecting a different concept and coming back is the only thing that refreshes it.
- The divergence impact holds. With an active writer, `verify_frontmatter` goes to `ledger::concepts::verify_with`. That function appends belief.revised and belief.attested against the REDUCER's current revision, then calls `write_projection` with `project_belief(state)`. For the three divergent files, that state is the Aug 16 content, so Verify overwrites the Aug 17 bytes on disk with Aug 16 bytes.
- I found no reconciliation-mode guard on this path. `guard_verify` only checks the path and the key.
- `attested_content_hash` is the hash of the projected (Aug 16) bytes, while the pane still shows the Aug 17 text read before the click. The user signs off on content they are not looking at.
- Normally the impact is milder (a stale body after agent writes or proposal applies, or a blank body on a read error). Medium is fair.

**Evidence checked.** - **Empty body on failure:** src/pages/KnowledgePage.tsx:281-297 has `readNote(...).then(setBody).catch(() => { if (!cancelled) setBody(''); })` with deps `[selectedConceptPath, vaultPath]`.
- **No reload key:** KnowledgePage.tsx:618-619 renders `<ConceptBody key={selected.entry.path} markdown={body} .../>`, and App.tsx:102 renders `<KnowledgePage selection={selection} />` with no key.
- **Verify only rescans:** KnowledgePage.tsx:310-319 runs `await verifyConcept(...)` then `await rescan()` and never re-reads the body.
- **Rust verify path:** src-tauri/src/lib.rs:931-940 calls `guard_verify`, then `vault::write::verify_frontmatter`. src-tauri/src/vault/write.rs:342-352 hands off to `ledger::concepts::verify_concept` whenever a writer is active ("the file regenerates as the projection").
- **Rewrite from reducer state:** src-tauri/src/ledger/concepts.rs:118-216 (`verify_with`) runs `current_state(...)` (the reducer), appends BeliefRevised and BeliefAttested (`attested_content_hash` = hash of the projection of `current.content`), then calls `project_belief` and `write_projection`. That rewrites the on-disk file from ledger state, with no check for reconciliation mode.
- **Writer lookup has no reconciliation gate:** src-tauri/src/ledger/shadow.rs:294-306 (`with_writer`) only checks that a writer is active and matches the vault.

</details>

### F85 — Knowledge update log renders 'Nothing logged yet' for any read failure

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src/knowledge/KnowledgeLog.tsx:92`
  - `src/knowledge/KnowledgeLog.tsx:102`

**Evidence**

readNote(LOG_PATH) `.catch(() => setMarkdown(''))`, then `markdown !== null && days.length === 0` renders the EmptyState 'Nothing logged yet'. The comment justifies only the not-found case, but every error (IO, permission, bad path) takes the same branch.

**Impact**

This is the catch-to-empty collapse AGENTS.md says M33 retired. 'The assistant has learned nothing' and 'we could not read the log' become the same sentence on the one surface meant to answer 'is this thing learning'.

**Recommendation**

Distinguish not-found (empty state) from other failures (section-unavailable), as Feed<T> does in BaseItself.tsx.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - The code matches the claim and is reachable. KnowledgeLog is mounted in KnowledgePage when nav.tab === 'log'.
- Every failure of readNote goes into a blanket `.catch(() => setMarkdown(''))`. `''` parses to zero days, so the page shows the EmptyState "Nothing logged yet". There is no unavailable state.
- On the Rust side, read_note calls read_file, which is `std::fs::read_to_string(safe_join(..)?).map_err(|e| format!("{rel}: {e}"))`. That turns every kind of error into the same Err string: NotFound, EACCES, invalid UTF-8, a path refused by safe_join, and an iCloud read failure (the live vault sits under ~/Documents). The component gets all of these through one catch and handles them all the same way.
- The comment in place only justifies the not-found case ("a bundle with no log yet"). This is the catch→empty collapse that AGENTS.md forbids. Other status sections already use a `section-unavailable` state, for example SystemSection, FleetSection and NeedsYouSection.
- A related gap: a log.md that exists but that parseLog cannot parse (zero days) also shows "Nothing logged yet" rather than an unreadable-log state.
- Severity is lowered to low. The failures other than NotFound are rare for a local file. The Tauri command also returns the error as an untyped string, so fixing this needs a typed not-found signal or matching on the error string. And the Knowledge page is not where the divergence incident shows up. For reference, the live vault's knowledge/log.md exists and is readable, so this bug is not active in the user's incident.

**Evidence checked.** - src/knowledge/KnowledgeLog.tsx:86-94: readNote(vaultPath, LOG_PATH).then(setMarkdown).catch(() => setMarkdown('')), with the comment "A bundle with no log yet is not an error".
- src/knowledge/KnowledgeLog.tsx:100-111: `markdown !== null && days.length === 0` renders the EmptyState "Nothing logged yet".
- src/lib/ipc.ts:37-39: readNote → invokeTauri('read_note').
- src-tauri/src/lib.rs:88-90: read_note → vault::write::read_note.
- src-tauri/src/vault/write.rs:217-219: read_file maps every io::Error (and safe_join errors) to one String.
- src-tauri/src/vault/write.rs:405-412: read_note passes those errors through unchanged.
- src/pages/KnowledgePage.tsx:403-408: KnowledgeLog is mounted for nav.tab === 'log'.
- The section-unavailable pattern exists in src/status/SystemSection.tsx, FleetSection.tsx and NeedsYouSection.tsx.

</details>

### F86 — chipsFor collapses 'ledger unavailable' and 'file not in the ledger' into null; the contract FacetChips documents has no caller

- **Severity (claimed):** low
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/knowledge/useBeliefChips.ts:25`
  - `src/knowledge/useBeliefChips.ts:37`
  - `src/knowledge/FacetChips.tsx:138`
  - `src/pages/KnowledgePage.tsx:650`
  - `src/knowledge/KnowledgePanel.tsx:313`
  - `src/knowledge/EntityDossier.tsx:70`

**Evidence**

useBeliefChips.ts:10-15 says the tagged state exists so 'the caller decides', and FacetChips.tsx:141-143 says the not-in-ledger case 'is said out loud by the caller'. But chipsFor returns null for both kinds, and every caller (KnowledgePage, EntityDossier) goes through it. The initial state is NO_CHIPS = unavailable, so loading is also treated as unavailable.

**Impact**

A concept written through the legacy bypass (not in the ledger, the incident mechanism) looks the same as a vault with no ledger: the 'What this rests on' block just disappears. The most useful signal that a file escaped the ledger is thrown away.

**Recommendation**

Return a tagged result from chipsFor ('unavailable' | 'absent' | row). Render 'Not in the recorded history' for absent in KnowledgePanel and EntityDossier, and add a loading kind.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The code defect is real and reachable. `chipsFor` returns null both when the index is `unavailable` and when a `ready` index has no row for the path. The index starts as `NO_CHIPS` (`unavailable`), which is also what a failed `beliefChips` read sets, so "loading", "no ledger / read failed" and "not in the ledger" all come out as the same null.
- Both callers pass the index through `chipsFor`, and nothing else reads the `ChipsIndex` tag. That breaks the contract documented in `useBeliefChips.ts:10-14` ("the caller decides") and `FacetChips.tsx:141-143` ("said out loud by the caller"). No caller says it out loud.
- `KnowledgePanel.tsx:263-264` actually documents the collapse ("null when nobody derived them — a vault with no ledger, or a file the ledger does not hold"). So the doc comments contradict each other, and the panel only hides the block: `chips !== null && ...` at L313.
- It also breaks the "unavailable is never empty" invariant, but only mildly: the result is silence, not a false "empty" claim.
- The impact is overstated for this incident. The three diverged files (the gcs-5 decision and the two tx-6 risks) were projected by the ledger on Aug 16 and have manifest entries, so the ledger does hold them. What is wrong for them is stale content, and a "not in ledger" signal would not have flagged it. The signal would only help for brand-new knowledge files that a bypass writer created and that never entered the ledger. So "the most useful signal that a file escaped the ledger" does not apply to the observed divergence.

**Evidence checked.** - `src/knowledge/useBeliefChips.ts:25` sets `NO_CHIPS = {kind:'unavailable'}`. L37-38: `return index.kind === 'ready' ? (index.byPath.get(path) ?? null) : null;`. L42 starts the state at NO_CHIPS (loading = unavailable), and the L54-59 catch sets NO_CHIPS.
- `src/knowledge/FacetChips.tsx` (about L135-146): the doc comment says the not-in-ledger case "is said out loud by the caller", and the component does `if (chips === null) return null`.
- Callers (a grep of src, excluding tests):
  - `src/pages/KnowledgePage.tsx:650` passes `chips={chipsFor(chipIndex, selected.entry.path)}`.
  - `src/knowledge/EntityDossier.tsx:205` passes `chips={chipsFor(chipIndex, concept.entry.path)}`, which feeds `FacetLines` at L70.
  - No other file reads `ChipsIndex.kind`.
- `src/knowledge/KnowledgePanel.tsx:263-264`: the prop doc merges the two cases. L313: `{chips !== null && (<div data-testid="belief-axes">What this rests on ...)}`, so the block silently disappears.
- Incident data (given facts): the manifest content_hash entries exist for the 3 diverged paths, so the files are in the ledger and the not-in-ledger distinction does not apply to them.

**Correction.** The claim holds: `chipsFor` collapses unavailable, loading and not-in-ledger into null, and no caller carries out the "caller decides" contract (KnowledgePanel's prop doc even documents the collapse). But the stated impact does not apply to this incident. The three diverged files are in the ledger (they have manifest entries from the Aug 16 projection); what they lack is fresh content. A "not in ledger" line would only catch new files a bypass writer created. Fix options: pass the tagged state through to the callers, or drop the misleading doc comments in `useBeliefChips.ts` and `FacetChips.tsx`.

</details>

### F87 — Background meter shows counted usage as plain numbers when accounting is unknown

- **Severity (claimed):** low
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/status/SystemSection.tsx:88`
  - `src/status/SystemSection.tsx:98`
  - `src-tauri/src/runtime/surface.rs:172`

**Evidence**

When `meter.accounting_state !== 'exact'` the section prints 'Spend for this day is unknown — it is not zero.' and then still renders `used.toLocaleString()` / ceiling for Runs/Tokens/Output, plus a filled bar. The Rust fields are plain u64 (surface.rs:41-45), so an unmeasured day arrives as 0.

**Impact**

The line under the warning reads '0 / 200,000 tokens', rendering an unrecorded number as zero, which is the exact case AGENTS.md forbids.

**Recommendation**

When accounting is not exact, render the figures as 'at least N (not all recorded)' or 'not recorded', and hide or hatch the bar. Better, make the Rust fields Option when not exact.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** The code is real and the path can happen. When accounting_state is 'unknown', Meter still draws used/ceiling and a filled bar for all three rows, with no qualifier. A Rust test pins the exact case: a run abandoned with unknown usage leaves the day not exact, and ambient_tokens_used is still 0. So '0 / 200,000' under the 'unknown' warning does occur. Three details in the claim are overstated. (1) Runs are not unrecorded. runs_started is incremented when a run is dispatched, so that count stays exact on an unknown day, and only Tokens and Output are affected. (2) Tokens and Output are a partial lower bound, not a blanket 0. They add up the metered runs and skip the unmetered ones, so they read 0 only when every run that day went unmetered. That is still the pattern AGENTS.md forbids ('a total that had to skip unmetered rows says how many it skipped'). (3) The plain u64 fields are not the cause. budget_days carries an accounting_state flag, and the display is the defect because it ignores that flag for the two token rows. The warning line reduces the harm, so severity stays low. It is also operational (runtime budget), not part of the knowledge ledger.

**Evidence checked.** src/status/SystemSection.tsx:87-90 shows the 'Spend for this day is unknown — it is not zero.' line when accounting_state !== 'exact'. :91-106 then always renders used.toLocaleString() / ceiling and a width bar for Runs, Tokens and Output. src-tauri/src/runtime/surface.rs:172-177 maps accounting_exact to 'exact'/'unknown'; :178-183 copies ambient_runs_started, ambient_tokens_used and ambient_output_tokens as plain u64 (struct at :41-46). src-tauri/src/runtime/budget.rs:627 sets accounting_state='unknown' without changing the token sums. src-tauri/src/runtime/dispatch.rs:1804-1805 is a test asserting !day.accounting_exact ('unknown is not zero') together with ambient_tokens_used == 0, so the UI would show '0 / ceiling'. dispatch.rs:310 increments ambient_runs_started at dispatch, so Runs stays exact.

**Correction.** Only the Tokens and Output rows are wrong. When accounting_state is 'unknown' they show a partial sum of metered runs as a plain number and a filled bar, without saying they are lower bounds or how many runs went unmetered. They read 0 only when every run that day was unmetered. The Runs count stays exact because it is counted at dispatch. The fix is in the display (SystemSection.tsx), for example 'at least N' plus a skipped-run count, not in the u64 fields.

</details>

### F88 — Agent context special-cases the retired 'Project' type name

- **Severity (claimed):** low
- **Category:** invariant-violation
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src/agent/context.ts:182`

**Evidence**

`projects: entries.filter((e) => e.type === 'Project').length` routes on a literal type name. The product direction killed the Project system type, and AGENTS.md: 'Do not route on type names'.

**Impact**

Every agent turn is told 'projects: 0' in vaults that model projects under any other type name. This is a type special-case in the one payload that frames the agent's view of the vault.

**Recommendation**

Drop the field or derive it from a capability (e.g. records other records are nested under), never a type literal.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - The code is real and it runs. `buildSnapshot` counts entries by the literal type name `'Project'`.
- `AiPanel` calls `buildSnapshot` on every assistant turn. `renderSnapshot` then JSON-dumps the whole snapshot, including `vault.projects`, into the prompt.
- This line has been there unchanged since M9.5 (commit 4eb2c0b). That is before the product direction killed the Project/Work item system types.
- It breaks AGENTS.md's "do not route on type names" rule. It also breaks "absent is never zero": a vault with no type named `Project` tells the agent `projects: 0` as if it had counted zero.
- One detail needs correcting. "Project" is not retired as a name. The demo vault still defines it as a user type (`demo-vault/types/project.md`, `records/projects/*.md`), so the count is right there by coincidence. The defect is that the name is hardcoded, not that the type is dead.
- Impact is cosmetic and limited to the prompt: nothing routes behavior on this count, and it has nothing to do with the ledger divergence incident.

**Evidence checked.** - `src/agent/context.ts:182`: `projects: entries.filter((e) => e.type === 'Project').length`
- `src/agent/context.ts:78`: the type `vault: { types: string[]; projects: number; notes: number }`
- `src/agent/context.ts:304-312`: `renderSnapshot` puts `JSON.stringify(snapshot)` into the prompt
- `src/agent/AiPanel.tsx:375`: `buildSnapshot({... entries, schema ...})`, called on each panel turn
- `git log -L182,182`: the line was introduced in 4eb2c0b (M9.5) and never changed
- `demo-vault/types/project.md` exists, and `demo-vault/records/projects/` holds four records with `type: Project`, so the name still exists as a user-defined type
- No other `=== 'Project'` routing exists under `src/` outside tests

**Correction.** The hardcoded type-name count is confirmed. "Project" is still a user-defined type in the demo vault, not a retired name. The real problem is a hardcoded name that makes any vault without that type report `projects: 0` instead of "not recorded". It is low severity and unrelated to the knowledge-ledger divergence.

</details>
