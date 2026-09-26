# Reconciliation recovery & UX

> Audit lens `recovery-ux` · first-pass auditor, each finding adversarially verified

## Summary

The user can't really get out. 'Keep my files' is certain to fail on the 3 agent-stamped files: their generated.at changed, which is treated as provenance forgery, and one refusal blocks everything. So the only exit is 'Restore', which gives no confirmation, preview or backup and can delete files, something the spec never allowed. The banner can't name the files, the cause or the consequences: IPC exposes only opaque detection keys, and '(1 unresolved)' counts events, not the 3 files. 'Paused' is also misleading: Verify and agent writes silently restore files one at a time. Human and watcher captures are refused without any record. The banner reads status once, before the launch scan runs, and turns failed reads into 'no banner'. No test or mock ever shows the mode open.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F19 | high | yes | 'Keep my files' always fails for this incident, and for any agent write that went around the ledger |
| F20 | high | yes | 'Restore recorded history' destroys data with no confirmation, preview or backup, and it deletes files the spec never mentions |
| F21 | high | yes | The banner can't say which files, why, or what each button does, and '(1 unresolved)' counts events, not files |
| F22 | high | yes | 'Paused until you choose' is false: agent writes and the human Verify button quietly restore files one at a time while the mode is open |
| F23 | medium | yes | What gets suspended while the mode is open is refused without any record; nobody can tell what was lost during the 39 days |
| F24 | medium | yes | No per-file or partial resolution: one bad file blocks everything, and restore rewrites every projection |
| F25 | medium | yes | Banner reads status once, before the launch scan can open the mode, and never checks again |
| F26 | medium | yes | Failed status reads become 'no banner', and the ledger states that route writes around the ledger are never shown |
| F27 | medium | yes | No test ever shows an open banner; the mock can't open the mode or mirror the suspension guard |
| F28 | low | yes | A migration_source_changed divergence likely has no working exit (inferred from code, not the live incident) |

### F19 — 'Keep my files' always fails for this incident, and for any agent write that went around the ledger

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:597-600`
  - `src-tauri/src/ledger/capture.rs:961-966`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/vault/write.rs:610-614`
  - `src-tauri/src/ledger/reconcile.rs:1639`
  - `src/app/ReconciliationBanner.tsx:50-56`

**Evidence**

resolve_accept_with runs every non-Match path through diff_projection_file. Any change to the `generated` stamp is refused as 'provenance forgery' (capture.rs:961-966), and one refusal refuses the whole action (reconcile.rs:600). The MCP write_concept stamps a new `generated.at = now_iso()` on every write (mcp.rs:2501). The legacy file-first path (write.rs:610-614) writes those bytes and its comment says 'the M23.6 scan reconciles once a writer returns', but it can't: the scan refuses them. Live vault check (python sha256 against the manifest): exactly 3 files are DIFF, and each has a changed `generated.at`. The test one_forged_file_refuses_the_entire_adoption (reconcile.rs:1639) locks this behaviour in. No test covers agent-authored bytes.

**Impact**

The banner shows a button that is certain to fail. The user gets raw internal text ('accept-current-files refused at knowledge/decisions/gcs-5-supervision-ratio.md: provenance forgery…'). The only way out is Restore, which throws away the agent's Aug 17 work. Any future write that bypasses the ledger will lead to the same place.

**Recommendation**

Add a third exit, 'adopt as agent revision': when `generated.by` names an agent, re-commit the file through write_concept_with (ledger-first, agent actor) instead of human capture. Add a dry-run IPC that runs the diff preflight, and disable 'Keep my files' with the reason when it would refuse. Delete or fix the false comment at write.rs:612-613.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real. resolve_accept_with collects every knowledge path. Each non-Match path goes through capture::diff_projection_file with `?`, so the first refusal aborts the whole action and nothing is committed.
- diff_projection_file hard-refuses any change to the `generated` or `verified` stamp as "provenance forgery".
- I checked the live vault read-only: exactly 3 manifest entries have different hashes. There are no missing or unmanifested knowledge files. All 3 carry `generated: {by: claude-code, at: 2026-08-17T11:5x}`, while the recorded projection is the Aug 16 version.
- The paths are iterated in sorted order, so "Keep my files" will fail on this incident, first at decisions/gcs-5-supervision-ratio.md. It returns the raw string "accept-current-files refused at knowledge/decisions/gcs-5-supervision-ratio.md: provenance forgery: the generated stamp changed out of band — refused", and the banner shows it verbatim.
- The test one_forged_file_refuses_the_entire_adoption locks in the all-or-nothing refusal. That test forges `verified`, not an agent's `generated`.
- The legacy write_concept path is real. Its comment says the scan reconciles later, but the scan runs the same diff and escalates to divergence instead. The MCP handler always stamps `generated.at = now_iso()`. So every write_concept that took the legacy file-first path, and every concept revision in general, changes `generated` and can never be adopted.
- Overstated: "any agent write that went around the ledger". The refusal fires only when `generated`/`verified` changes, or on alias removal, an unparsable file, a missing file, or a path that isn't a committed projection. A bypassing edit that leaves the stamps alone is adopted. log.md in this same scan is the example: its out-of-band edit was captured as projection.overridden (seq 179).
- Accurate generalization: any bypass write that restamps provenance, which includes every write_concept revision on the legacy path, is unadoptable. Restore is then the only exit, and it reverts that work.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:520-527 (doc: "One unparsable, forged, ambiguous, or unrepresentable file refuses the entire action")
- src-tauri/src/ledger/reconcile.rs:~595-600: `capture::diff_projection_file(&state, krel, &raw).map_err(|e| format!("accept-current-files refused at {path}: {e}"))?;`
- src-tauri/src/ledger/capture.rs:~961-966: `if key == "generated" || key == "verified" { return Err(format!("provenance forgery: the {key} stamp changed out of band — refused")); }`
- src-tauri/src/mcp.rs:~2501: `frontmatter.insert("generated".into(), json!({ "by": actor, "at": now_iso() }));`
- src-tauri/src/vault/write.rs:~605-614: the legacy path comment "the M23.6 scan reconciles once a writer returns"
- reconcile.rs:1639: test one_forged_file_refuses_the_entire_adoption (forges `verified`)
- src/app/ReconciliationBanner.tsx:~50-70: renders `{error}` raw
- Live vault, sha256 of the files vs the manifest: DIFF for knowledge/decisions/gcs-5-supervision-ratio.md (generated.at 2026-08-17T11:52:02Z), risks/tx-6-changeover-transient-cross-channel-sync-disabled.md (11:54:42Z) and risks/tx-6-np-shared-j12-common-mode.md (11:57:37Z). No MISSING or UNMANIFESTED files.
- Ledger seq 179: projection.overridden for log.md, a bypass edit that was captured.

**Correction.** For this incident, "Keep my files" is certain to fail. It refuses at knowledge/decisions/gcs-5-supervision-ratio.md with a raw "provenance forgery" message, and restore is the only exit. It does NOT fail for every write that went around the ledger. It fails only when the out-of-band bytes change the generated/verified stamp, or remove an alias, don't parse, are missing, or sit at a path that isn't a committed projection. Out-of-band body or field edits that leave provenance alone are adopted, as log.md was at seq 179. Because MCP write_concept always restamps generated.at, every write_concept revision that took the legacy file-first path falls in the refused class. The write.rs comment that the scan will reconcile these writes is false.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** - Confirmed for this incident. resolve_accept_with sends every non-Match path through diff_projection_file, and the first error cancels the whole adoption. diff_projection_file hard-refuses any change to `generated` or `verified`.
- The live ledger shows the three beliefs were created with an Aug 16 `generated.at` stamp and never revised. The files on disk carry Aug 17 stamps. So the diff hits the forgery refusal on the first path in BTreeSet order (knowledge/decisions/gcs-5-supervision-ratio.md), and "Keep my files" is certain to fail.
- The banner's .catch shows the raw Rust string in red. The mode stays open. Restore is the only way out, and it throws away the Aug 17 content.
- Reachability of the bypass is real. ledger::concepts::write_concept returns None whenever shadow::with_writer has no active writer, and vault/write.rs then falls back to the legacy file-first path. mcp.rs always stamps a fresh `generated.at = now_iso()`, so every legacy MCP write produces bytes that capture and accept can never adopt. The comment "the M23.6 scan reconciles once a writer returns" is false for these bytes.
- Overstated part: "any agent write that went around the ledger". The refusal only fires when the `generated`/`verified` stamp changes, or on alias removal, a file that isn't a committed projection, or a parse failure. A raw file edit that keeps the stamp (for example an Edit-tool change to the body only) is captured by the scan as an ordinary out-of-band override. That is what happened to log.md at seq 179, which raised no divergence and needed no button. The universal claim holds for every write through write_concept's legacy path, because it always restamps. It does not hold for every bypass.
- The one_forged_file_refuses_the_entire_adoption test does lock in the all-or-nothing behaviour. Its case is a forged `verified` stamp, not agent-restamped `generated`.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:520-600 (resolve_accept_with: classify, then `diff_projection_file(...).map_err(|e| format!("accept-current-files refused at {path}: {e}"))?`, where one error aborts the action)
- src-tauri/src/ledger/capture.rs:958-966 (`if key == "generated" || key == "verified" { return Err("provenance forgery: ...") }`)
- src-tauri/src/mcp.rs:2501 (`frontmatter.insert("generated", json!({"by": actor, "at": now_iso()}))`)
- src-tauri/src/vault/write.rs:610-625 (legacy path when ledger::concepts::write_concept returns None)
- src-tauri/src/ledger/concepts.rs:68-80 (returns None without an active writer)
- src-tauri/src/ledger/reconcile.rs:415-420 (resolve dispatch)
- src-tauri/src/ledger/reconcile.rs:1639 (test uses a forged `verified` stamp)
- src/app/ReconciliationBanner.tsx:28-35 (the raw error string goes into setError)
- Live ledger, belief.created records: seq 113 gcs-5 at 2026-08-16T19:38:29Z, seq 158 tx-6-changeover at 2026-08-16T20:00:24Z, seq 163 tx-6-np-shared-j12 at 2026-08-16T20:00:42Z. There are no later events for those belief_ids.
- Files on disk: generated.at 2026-08-17T11:52:02Z, 11:54:42Z and 11:57:37Z.
- seq 179: log.md captured as projection.overridden with origin out_of_band, which shows an edit that keeps the stamp is adopted without divergence.

**Correction.** "Keep my files" is certain to fail for this incident: all three affected files carry an Aug 17 `generated.at` against Aug 16 in the reducer, and one refused file refuses the whole action. More generally it fails for any bypass write that changes the generated/verified stamp, which includes every write_concept call that falls to the legacy file-first path, because MCP restamps `generated.at` each time. A bypass edit that leaves the stamp alone is captured normally, like log.md at seq 179, and never reaches the banner. So it is not "any agent write that went around the ledger".

</details>

### F20 — 'Restore recorded history' destroys data with no confirmation, preview or backup, and it deletes files the spec never mentions

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:447-474`
  - `src-tauri/src/ledger/manifest.rs:218-229`
  - `src/app/ReconciliationBanner.tsx:58-64`
  - `docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:393-397`

**Evidence**

resolve_restore_with rewrites every projection through write_projection (a temp file renamed over the original; the prior bytes are only hashed). It also calls std::fs::remove_file on every knowledge/*.md the reducer can't explain (L472). There is no snapshot, no trash and no git commit first. The button fires on one click with no confirmation, and it is styled the same as 'Keep'. The M23 spec says restore 'regenerates every affected projection' and says nothing about deleting files. Live vault now: restore would overwrite 3 files (losing the Aug 17 `description` field, the stale_after change from 2027-07-31 to 2027-10-31, and the body edits) and delete 0. Those bytes survive only by accident in vault git (e1770e4, autosync).

**Impact**

The user can't see what they're about to lose. In a vault without git autosync, or with agent-created concepts the ledger never saw, the loss is permanent.

**Recommendation**

Before restoring, list the paths it will overwrite and delete, with diffs, and require a confirmation. Snapshot the affected bytes to .cerebro/reconcile-backup/<divergence_event>/ or commit them to git first. Move unexplained files aside instead of calling remove_file. Style the button as destructive.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** I read the whole restore path and could not refute any part of the claim.
- One click runs it. `act('restore_ledger_authority')` goes straight to `resolveReconciliation`. There is no confirm dialog, no preview of what will be lost, and it has the same class string as "Keep my files".
- The backend command `resolve_reconciliation` (lib.rs:922) passes the call straight to `reconcile::resolve`. Nothing snapshots the vault or makes a git commit first.
- `resolve_restore_with` rewrites every projection through `manifest::write_projection`. That function only hashes the prior bytes into `prior_hash` in the manifest. It writes a `.md.cerebro-tmp` file and renames it over the original, so the old content is gone.
- It then walks `knowledge/` and calls `std::fs::remove_file` on every .md the reducer cannot explain (reconcile.rs:472).
- The M23 spec's restore paragraph (lines 393-397) only says it "regenerates every affected projection". It never mentions deleting files. The deletion appears only in the code's doc comment ("remove what the ledger cannot explain").
- Live vault: all 30 manifest keys match the 30 knowledge/*.md files, so a restore would delete 0 files and overwrite the diverged ones, as claimed.
- The prior bytes survive only because the vault's autosync committed them (e1770e4 and the 1c8c9e9/812605a commits touch these files). Cerebro does nothing to keep them.
- The risk is worse than it looks: "Keep my files" refuses on provenance-forged files, so for this incident "Restore" is the only button that works. That pushes users toward the destructive action.
- Nuances, which don't overturn the claim: on this vault the overwritten Aug 17 bytes include agent defects (a self-referencing `about:` field and duplicate log lines), so restoring may even be what the user wants. The loss is also recoverable from git here.
- High is justified in general. In a vault without git, or one where agents created concepts the ledger never recorded, those files are deleted permanently with no warning.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:28-35 (act → resolveReconciliation, no confirm) and :50-65 (both buttons use the identical className).
- src-tauri/src/lib.rs:922-926 resolve_reconciliation passes straight through; no backup.
- src-tauri/src/ledger/reconcile.rs:427 resolve_restore_with; :444-447 write_projection for every projection_paths entry; :457-474 WalkDir over knowledge/ with std::fs::remove_file on any .md not in state.projection_paths (line 472).
- src-tauri/src/ledger/manifest.rs:190-194 prior bytes are only hashed (sha256_hex); :218-229 temp `.md.cerebro-tmp` then fs::rename over file_path.
- docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:393-397: restore "regenerates every affected projection... rechecks F=M=R". A grep for delete/remove in the spec finds no file-deletion wording.
- Live vault: the manifest's 30 keys equal the 30 knowledge/*.md files on disk, so restore deletes 0.
- Vault git e1770e4 (2026-08-17 04:57 -0700, "Update 2 notes in knowledge") touches knowledge/risks/tx-6-np-shared-j12-common-mode.md and log.md. The prior bytes are recoverable only through this autosync.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - I could not refute the mechanics. `resolve_restore_with` rewrites every projection whose disk hash differs. It also calls `std::fs::remove_file` on every `knowledge/**/*.md` outside `state.projection_paths`, and nothing is snapshotted, trashed or committed first.
- The UI path is reachable with one click. `resolve_reconciliation` (lib.rs:922) goes straight to `reconcile::resolve`, with no confirm or preview step in the banner or the IPC. The two buttons use identical classes.
- The M23 spec (L393-397) says only "regenerates every affected projection"; it never mentions removing files. The code comment at reconcile.rs:441-442 does add that removal, so the deletion goes beyond the spec.
- No write is skipped by accident. `write_projection` compares the DISK hash with the target, not the manifest hash, so the 3 diverged files really are overwritten.
- In the live vault, disk `knowledge/*.md` (30) equals the manifest entries (30), so restore deletes 0 files, which matches the claim.
- The impact is overstated for this vault. `git status` in the vault shows `knowledge/` clean, so the current Aug 17 bytes are all committed (1c8c9e9, 812605a, e1770e4 among others). Cerebro's own autosync makes those commits, and they carry the `Cerebro-Ledger-Head` trailer. That is a product feature, not an accident, so the loss can be recovered in this vault.
- The overwritten content is 3 agent edits that bypassed the ledger. One of them carries a data defect: a self-referencing `about:`.
- Permanent loss needs a vault without git autosync, or agent-created concept files the ledger never recorded. That path is real, but it is not the live case.
- The design gap is real and worth fixing: no preview, no confirmation, no pre-restore snapshot, and deletion not in the spec. It is also made worse because 'Keep my files' is refused on forged-provenance files, which leaves Restore as the only way out. Given the git mitigation in the live vault, this is medium, not high.

**Evidence checked.** - `src-tauri/src/ledger/reconcile.rs:415-421`: `resolve` dispatches directly to `resolve_restore_with`.
- `src-tauri/src/ledger/reconcile.rs:443-446`: `write_projection` runs for every `projection_paths` entry.
- `src-tauri/src/ledger/reconcile.rs:456-474`: the WalkDir loop calls `std::fs::remove_file` on any .md outside `projection_paths`.
- `src-tauri/src/ledger/manifest.rs:183-229`: the prior hash is taken from DISK bytes; if they differ, a temp file is renamed over the original; nothing is backed up.
- `src-tauri/src/lib.rs:922-926`: `resolve_reconciliation` has no guard or preview.
- `src/app/ReconciliationBanner.tsx:28-35,50-64`: `act()` fires on click with no confirm; both buttons share identical styling.
- `docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:393-397`: the restore text never mentions deletion (a grep for remove/delete finds only alias removal).
- Live vault: `find knowledge -name '*.md'` gives 30 files, identical to the 30 `projection-manifest.json` keys, so there are 0 deletions. `git status --porcelain knowledge` is empty, so the Aug 17 bytes are committed (e1770e4 touches log.md and tx-6-np-shared-j12-common-mode.md; the gcs-5 file is in 1c8c9e9/812605a).

**Correction.** The claim is accurate about the code: Restore is one click with no confirmation, preview or backup. It also deletes unexplained knowledge .md files, which the M23 spec never mentions. What's overstated is the impact on the live vault. Restore would overwrite 3 files and delete none, and all of those bytes are already committed by Cerebro's own vault git autosync. That is intended behaviour, not survival "by accident", so nothing is permanently lost here. Permanent loss is only possible in vaults without autosync, or where agent-created concept files the ledger never recorded exist. Severity is medium, not high.

</details>

### F21 — The banner can't say which files, why, or what each button does, and '(1 unresolved)' counts events, not files

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/medium, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:363-364`
  - `src-tauri/src/ledger/shadow.rs:393`
  - `src-tauri/src/ledger/reconcile.rs:350-356`
  - `src/lib/ipc.ts:295-296`
  - `src/app/ReconciliationBanner.tsx:44-48`

**Evidence**

LedgerStatus.divergences is `reconciliation_divergences.keys()`, which are opaque sha256 detection keys. Signals, sample_paths, mismatch_count and the event time never reach IPC. Even the ledger event drops the per-path reason: `.map(|(path, _)| path)` (reconcile.rs:354), so 'provenance forgery' is recorded nowhere durable. The banner shows `{divergences.length} unresolved` inside a sentence about files disagreeing. Live: 1 detection key, while mismatch_count is 3 and three sample_paths are listed.

**Impact**

The user reads '1 unresolved' as one file. They can't find the 3 files, can't learn that an agent wrote them, and can't judge either button. That fits the mode sitting open for about 39 days.

**Recommendation**

Extend LedgerStatus with, per divergence: event_id, recorded time, signals, mismatch_count, sample_paths and per-path reason (record the reasons in the event body as well). Render the file list with links, the cause, and one line for each button saying what it keeps and what it discards. Count affected files, not events.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The mechanism is real, and I checked every cited line.
- `LedgerStatus.divergences` is only the set of detection-key strings. Signals, sample_paths, mismatch_count and the event time never reach IPC or the TypeScript side.
- The banner renders `divergences.length`. On the live vault that is 1 detection key, against mismatch_count 3 and 3 sample_paths.
- The per-path reason is thrown away twice: `.map(|(path, _)| path)` when the event is built, and `let _ = launch_scan(...)` in shadow.rs, which discards the whole outcome including `divergent: Vec<(path, reason)>`.
- No other UI surface in src/ reads reconciliation detail. Only App.tsx mounts the banner, and the status/ and knowledge/ folders have no reconciliation consumer.
- The banner has no text explaining either button.
- Overstatements:
  1. The banner is not completely unable to say which file or why. Clicking "Keep my files" fails, and the banner's error span then shows the backend message "accept-current-files refused at knowledge/<path>: provenance forgery: the generated stamp changed out of band — refused". So the first offending file and its reason do surface, one at a time, after a failed click. The refusal happens before anything is written.
  2. The affected paths are recorded durably. `sample_paths` (capped at 32) sits in the seq 180 ledger event. What is lost is only the per-path reason and any UI exposure of the paths.
  3. Saying this UX gap explains the mode staying open for 39 days is a guess. The root cause is the agent writing through a path that bypassed the ledger.
- This is a clarity and recoverability defect, not data loss. Medium fits better than high.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:363-364: `divergences: Vec<String>` is documented as "detection keys".
- src-tauri/src/ledger/shadow.rs:393: `state.reconciliation_divergences.keys().cloned().collect()`.
- src-tauri/src/ledger/shadow.rs:144: `let _ = super::reconcile::launch_scan(...)` throws away the outcome and its reasons.
- src-tauri/src/ledger/reconcile.rs:192: `divergent: Vec<(String, String)>` holds (path, reason).
- src-tauri/src/ledger/reconcile.rs:350-356: `.map(|(path, _)| path)` drops the reason; only `samples` and `mismatch_count` go into the `LedgerDivergence` body (L376-395).
- src/lib/ipc.ts:285-297: `LedgerStatus` has no samples, signals or count field.
- src/app/ReconciliationBanner.tsx:44-48: renders `{status.divergences.length} unresolved`; the buttons have no explanatory copy; L32 plus L65 set and render the backend error string.
- src-tauri/src/ledger/reconcile.rs:598-599: `diff_projection_file(...).map_err(|e| format!("accept-current-files refused at {path}: {e}"))?`, so a failed Keep-my-files click shows one path plus "provenance forgery".
- src-tauri/src/ledger/capture.rs:964-965: the forgery message.
- Live ledger, …0001.ndjsonl.open line 180: detection_key 1aa2ef74…, mismatch_count 3, sample_paths lists the three files, and there is no reason field.
- Grep of src/ for `reconciliation_open`, `divergences` and `sample_paths`: the only UI consumer is ReconciliationBanner.

**Correction.** Accurate: before the user acts, the banner cannot name the files, the reason, or what each button does, and "(1 unresolved)" counts detection keys (divergence events), not files (live: 1 vs 3 files). Two corrections: (a) the affected paths ARE stored durably in the ledger event's sample_paths, and only the per-path reason is dropped (reconcile.rs:354 and `let _ =` at shadow.rs:144); (b) clicking "Keep my files" shows the first refused path and its "provenance forgery" reason in the banner's error line, one file per failed click. Severity medium (clarity and recoverability, no data loss); the link to the 39-day open mode is a guess.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** I tried to refute this on reachability and could not. Every part of the claim holds in both the code and the live data.
- The banner is the only UI that shows the reconciliation mode. It is mounted at src/App.tsx:339, and nothing else in src/ reads sample_paths, mismatch_count or signals.
- The IPC type LedgerStatus only carries `divergences: Vec<String>`. That value is `reconciliation_divergences.keys()`, and each key is a sha256 detection key that maps to an event_id. No paths, signals, counts or times cross IPC.
- The banner renders `{status.divergences.length} unresolved` inside a sentence about files disagreeing. There is no per-button explanation, tooltip or file list.
- In the live vault that yields 1 (one detection key, 1aa2ef74…). The divergence event itself records mismatch_count 3 and three sample_paths.
- The per-path reason is lost twice. reconcile.rs:350-356 keeps only the path (`.map(|(path, _)| path)`). shadow.rs:144 then discards the whole LaunchOutcome (`let _ = launch_scan(...)`). So the "provenance forgery" refusal from capture.rs:965 is not stored anywhere durable.
- One small nuance, which does not change the verdict: after the user clicks "Keep my files", the error line would show "accept-current-files refused at <path>: provenance forgery…" (reconcile.rs:600). It names only the first failing file, appears only after a failed attempt, and is gone on refresh. The user still cannot judge either button before choosing.
- High severity stands. This is the only recovery surface, and it has kept the mode open for about 39 days.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:44-48: the text "({status.divergences.length} unresolved)". There is no file list and no explanation of either button. Line 21 swallows an error into null.
- src/lib/ipc.ts:285-297: LedgerStatus.divergences is documented as "Unresolved divergence detection keys".
- src-tauri/src/ledger/shadow.rs:363-364 and 393: `divergences: Vec<String>` = `state.reconciliation_divergences.keys()`.
- src-tauri/src/ledger/reduce.rs:761 and 4535-4537: the map goes from detection_key to event_id.
- src-tauri/src/ledger/reconcile.rs:350-356: the reason is dropped by `.map(|(path, _)| path)`.
- src-tauri/src/ledger/shadow.rs:144: `let _ = super::reconcile::launch_scan(...)` discards the outcome.
- src-tauri/src/ledger/reconcile.rs:599-600: the only place the reason reaches the UI, as a post-click error that names one path.
- grep of src/ for sample_paths, mismatch_count and reconciliation: no consumer apart from the banner (App.tsx:339).
- Live ledger seq 180: detection_key 1aa2ef74…, signals [manifest_reducer_disagreement], mismatch_count 3, projection_count 30, and 3 sample_paths.

</details>

### F22 — 'Paused until you choose' is false: agent writes and the human Verify button quietly restore files one at a time while the mode is open

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/concepts.rs:213-216`
  - `src-tauri/src/ledger/concepts.rs:353-357`
  - `src-tauri/src/ledger/concepts.rs:882-888`
  - `src/pages/KnowledgePage.tsx:317`

**Evidence**

verify_with, write_concept_with and append_log_with never check reconciliation_open(). Each ends with write_projection of the reducer's bytes, which overwrites whatever is on disk. Every agent write_concept also runs append_log, which regenerates knowledge/log.md. The M23 spec keeps 'regular agent writes' available but promises the user a choice.

**Impact**

Clicking Verify on gcs-5-supervision-ratio.md replaces the Aug 17 bytes with the ledger's version, with no warning. The next agent run rewrites log.md over any uncaptured edit. The decision the banner says it is waiting for gets made silently for each file.

**Recommendation**

While the mode is open, have these writers refuse (typed code) on any path the open divergence lists (divergent or out-of-band), or first compare the on-disk hash with the manifest entry and refuse if they differ. Surface the refusal in the UI.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - **Mechanism is real.** The pause is only enforced in the capture paths and in launch_scan. verify_with, write_concept_with and append_log_with never read reconciliation_open(), and each ends in manifest::write_projection.
- **write_projection blindly replaces the file.** It hashes the bytes on disk only to choose between advancing the manifest identity and writing the file. It never checks those bytes against the manifest entry, so divergent out-of-band bytes get atomically renamed over with no warning.
- **Verify on gcs-5-supervision-ratio.md would:**
  - write the reducer's Aug 16 bytes plus the stamp over the Aug 17 file on disk;
  - append a belief.attested pinned to the ledger revision. The human was looking at the Aug 17 bytes (the scanned entry), so they attest content they never saw. That is worse than the claim says.
  - leave the divergence event open. The mode stays open while the file's disagreement is gone without a word.
- **Nothing in the UI stops it.** Neither KnowledgePage nor the lib.rs verify_concept command (guard_verify only checks the path and patch keys) gates on the mode.
- **The scan does honor the pause.** launch_scan skips regeneration and capture when already_open (reconcile.rs:256-321), which makes the write/verify bypass inconsistent.
- **Nuances that don't change the verdict:**
  - The M23 spec deliberately keeps "Regular agent writes" available during the mode, so agent writes going ahead is by design. Overwriting divergent bytes without a check is still not.
  - An agent write_concept doesn't strictly "restore": it writes the reducer state plus the agent's change. The Aug 17 edits are lost either way.
  - log.md was captured at seq 179. append_log would clobber only edits made after that, which the open mode now refuses to capture.
- **Not yet triggered in the live vault.** All 93 events after seq 180 are vault.write shadow events on non-knowledge paths. No concept write, verify or log append has happened yet.
- **Why still high.** The Aug 17 bytes survive in vault git history, but the attestation of unseen content and the silent, per-file settling of the open decision justify it.

**Evidence checked.** - **Pause enforced:**
  - src-tauri/src/ledger/capture.rs:320-323, 642, 779, 840, 885 (capture_* functions return RECONCILIATION_SUSPENDED).
  - src-tauri/src/ledger/reconcile.rs:256-321 (launch_scan skips write_projection and capture when already_open).
- **No gate:**
  - src-tauri/src/ledger/concepts.rs:118-217 (verify_with ends `write_projection(vault, rel, &projection)` at L216).
  - concepts.rs:325-357 (write_concept_with; the no-op branch L353-357 also rewrites the file).
  - concepts.rs:800-888 (append_log_with writes LOG_PATH at L888).
  - `grep reconciliation_open()` finds no hit in concepts.rs, vault/write.rs or lib.rs.
- **Blind overwrite:** src-tauri/src/ledger/manifest.rs:184-240. write_projection compares the disk hash only against projection.content_hash, then does temp write + rename. It never compares against the manifest entry.
- **Call chain:**
  - vault/write.rs:350 (verify_frontmatter) calls concepts::verify_concept.
  - vault/write.rs:609 → write_concept; write.rs:700 → append_log.
  - lib.rs:931-940 (verify_concept: guard_verify only).
- **UI:** src/pages/KnowledgePage.tsx:311-338. verify() uses selected.entry (disk scan) and has no reconciliation check.
- **Spec:** docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:363-365 ("suspends automatic capture ... Regular agent writes remain available").
- **Live ledger:** /Users/joseflagorio/Documents/test/.cerebro/ledger/d62256b3040f66f44f65d74c91d2b60c-0000000000000001.ndjsonl.open, seq > 180 = 93 vault.write events. Paths: records/tasks/kk.md, home/untitled.md, test/bets.list.yml, types/*; none under knowledge/.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Mechanism confirmed.** `verify_with`, `write_concept_with` and `append_log_with` never call `reconciliation_open()`. The only places that do are capture.rs and reconcile.rs. Each of the three functions ends in `manifest::write_projection`, which renames the reducer's bytes over whatever is on disk. It records the old hash only as the pending entry's `prior`, and never compares it to the manifest. Nothing upstream stops the call either: not lib.rs `verify_concept` (guard_verify only), `vault::write`, mcp.rs, `shadow::with_writer`, or the UI. KnowledgePage has no ledgerStatus or reconciliation gate.
- **Worse than claimed on Verify.** The Verify button reads the disk file (Aug 17 bytes), but it revises and attests the reducer's current revision (Aug 16 content). The resulting `belief.attested` pins content the human never saw, then overwrites the file they did see.
- **Reachable in the live vault.** The writer is active: the app appended seqs 179–273. The 3 contested files still differ from their manifest hashes, and every event after seq 180 is a `vault.write`. So clicking Verify on gcs-5 today would silently revert it.
- **Overstated parts:**
  - (a) "Automatic capture is paused" is literally true. capture.rs:322/642/779/840/885 refuse while the mode is open. The false part is the implied "nothing changes files until you choose".
  - (b) The M23 spec (projection-capture-design.md:363-365) keeps "Regular agent writes remain available" on purpose, so agent writes staying available is intended. The defect is that such writes clobber contested files without any check.
  - (c) The log.md half is latent right now. log.md matches its manifest hash, because seq 179 captured it. Nothing uncaptured would be lost until a new out-of-band edit lands while the mode is open.
  - (d) Practical loss in this vault is limited. "Keep my files" already refuses these exact files as provenance forgery, so the only exit that works (Restore) reverts them anyway. The Aug 17 bytes also survive in the vault's git autosync commits.
- **Net:** a real bypass of the "you choose" promise and a false attestation, with limited data loss here. Medium, not high.

**Evidence checked.** - src-tauri/src/ledger/concepts.rs:118-217 (`verify_with`: `current_state`, then revise/attest `current.event_id`, then `write_projection`; no `reconciliation_open` check), :325-357 (`write_concept_with`, including the no-op path that also rewrites the projection), :800-888 (`append_log_with` rewrites knowledge/log.md), :793 (`write_projection` wrapper).
- src-tauri/src/ledger/manifest.rs:184-242: the file is overwritten unconditionally through temp+rename, and the prior hash is not checked against the manifest entry.
- `grep reconciliation_open` hits only capture.rs:322,642,779,840,885 (these refuse with RECONCILIATION_SUSPENDED, comment "agent writes continue") and reconcile.rs:256,408,514,912.
- src-tauri/src/lib.rs:931-940 (`verify_concept` → `guard_verify` → `verify_frontmatter`); src-tauri/src/vault/write.rs:342-356, 604-611, 693-700; mcp.rs:2539-2546 (`write_concept` then `append_knowledge_log`).
- src/pages/KnowledgePage.tsx:311-318 (verify has no reconciliation gate; no reconcil/ledgerStatus reference in the file).
- Spec docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:363-365: "suspends automatic capture ... Regular agent writes remain available."
- Live vault (read-only):
  - Events after seq 180 are 93 × `vault.write` only (no belief or verify events).
  - The 3 contested files' sha256 != manifest `content_hash` (still divergent). knowledge/log.md == manifest (nothing uncaptured at risk now).

**Correction.** Capture really is paused. What is not paused are ledger-authoritative projection writes: Verify (lib.rs verify_concept → concepts::verify_with) and agent write_concept/append_log never check reconciliation_open, and manifest::write_projection overwrites the disk file without comparing it to the manifest. Clicking Verify on gcs-5-supervision-ratio.md in the live vault today would revert it to the Aug 16 content. It would also attest the Aug 16 revision while the user was reviewing the Aug 17 text, and the banner would stay up. Agent writes to non-contested paths are allowed during reconciliation by spec. log.md clobbering is latent for now: its disk bytes match the manifest. Harm in this vault is bounded, because "Keep my files" already refuses these files, Restore would revert them too, and git autosync holds the Aug 17 bytes. Severity: medium.

</details>

### F23 — What gets suspended while the mode is open is refused without any record; nobody can tell what was lost during the 39 days

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/vault/watcher.rs:260`
  - `src-tauri/src/ledger/capture.rs:154-155`
  - `src-tauri/src/ledger/capture.rs:840-841`
  - `src-tauri/src/lib.rs:103`
  - `src/editor/NoteBodyEditor.tsx:162-166`
  - `src-tauri/src/ledger/reconcile.rs:277`
  - `src-tauri/src/ledger/reconcile.rs:286`
  - `src-tauri/src/ledger/reconcile.rs:313-326`
  - `shared/policy/policy.v3.json`

**Evidence**

Live out-of-band capture: `let _ = capture_out_of_band(...)` swallows RECONCILIATION_SUSPENDED. In-app save_note and update_frontmatter on knowledge paths return that error, and the editor catch replaces it with 'Couldn't save page'. The launch scan also skips crash recovery while the mode is open (finalize and regenerate are gated on !already_open, L277/L286). Neither RECONCILIATION_SUSPENDED nor 'provenance forgery' is a code in policy.v3.json. runtime.db operational_log holds only capability_unavailable rows (19), so no suspended capture was ever logged. Live ledger: zero knowledge events after seq 180.

**Impact**

Any knowledge edit made during those 39 days sits uncaptured on disk, and Restore will wipe it. The user gets a generic save error that never points to the banner. AGENTS.md says every refusal names a code with a declared ledger or operational destiny; this breaks that rule.

**Recommendation**

Add a policy-table code (operational) for reconciliation_suspended and for provenance forgery. Log each swallowed watcher capture to operational_log. Show the real reason in the editor toast with a link to the banner. List the parked edits in the banner.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The code-level mechanics are real and reachable:
  - The watcher throws away the capture result with `let _ =`.
  - Every capture entry point returns the RECONCILIATION_SUSPENDED string while the mode is open.
  - save_note and update_frontmatter pass that Err straight back to the UI, and NoteBodyEditor turns any failure into the generic "Couldn't save page" toast.
  - The launch scan skips finalize/regenerate when already_open.
  - Neither the suspension string nor "provenance forgery" is a code in policy.v3.json, and runtime.db only has capability_unavailable rows.
- The impact claims are overstated or wrong in three ways:
  - (1) In-app edits are refused BEFORE the file is written. They never sit uncaptured on disk, so Restore cannot wipe them. What is lost is the unsaved editor buffer, and the user sees a generic toast.
  - (2) "Without any record" is false for out-of-band edits. Every launch scan while the mode is open re-classifies the files. Out-of-band paths go into sample_paths (up to 32), and a changed condition gives a new detection_key, so a NEW ledger.divergence event is appended. An edit to a new knowledge file during the open period IS recorded in the ledger and would show as a second unresolved divergence. The gap is narrower than claimed: re-edits to the 3 already-sampled files (same key, not re-recorded), live watcher refusals, and in-app refusals leave no trace.
  - (3) Live data shows nothing was lost: no file under knowledge/ changed after 2026-08-17 04:57 local (11:57Z), and there is exactly one divergence event. "Nobody can tell what was lost during the 39 days" is wrong: we can tell, and the answer is nothing.
- The ledger was not silent either: 94 vault.write events were appended from 2026-08-22 to 08-31.
- What is left is a real conformance defect: the refusal has no declared code or destiny, which AGENTS.md forbids, and the UI message is misleading. Its impact in this incident is nil, so the severity is low.

**Evidence checked.** - src-tauri/src/vault/watcher.rs:260: `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`. Confirmed swallowed.
- src-tauri/src/ledger/capture.rs:154-155 defines RECONCILIATION_SUSPENDED. The gates are at 322 (capture_structured_with), 642, 779, 840-841 (capture_body_edit) and 885. Confirmed.
- src-tauri/src/lib.rs:103-110 (save_note) and 121-128 (update_frontmatter) return the capture Err before vault::write runs. The edit is refused and never written to disk.
- src/editor/NoteBodyEditor.tsx:162-166: the catch shows toast("Couldn't save page"). Confirmed.
- reconcile.rs:277/286: complete_entry and write_projection are gated on !already_open. Confirmed.
- reconcile.rs:313-326: capture is skipped when already_open, so out_of_band paths stay in outcome.out_of_band.
- reconcile.rs:350-403: samples = divergent ∪ out_of_band (MAX_SAMPLE_PATHS=32, schema/reconciliation.rs:46), detection_key = sha256(signals, samples, manifest_digest, reducer_digest), and append_once runs when the key is new. So new out-of-band paths during the open mode ARE recorded as a new ledger.divergence event. This contradicts "without any record".
- grep of shared/policy/policy.v3.json for SUSPENDED/forgery/reconciliation finds no match. Confirmed.
- runtime.db operational_log: capability_unavailable|19 only. Confirmed.
- Live ledger, seq>=178: 1 projection.overridden, 1 ledger.divergence (08-17), and vault.write ×1 (08-17), 18 (08-22), 4 (08-29), 15 (08-30), 56 (08-31). No further divergence events.
- `find knowledge -newermt '2026-08-17 12:00'` in /Users/joseflagorio/Documents/test finds nothing. The knowledge/ dir and log.md mtimes are Aug 17 04:57 local. No knowledge edits happened during the 39 days, so nothing was lost.

**Correction.** While the mode is open:
- Suspended captures are refused with an uncoded string. Nothing reaches runtime.db or the policy table, and the UI shows a generic "Couldn't save page". That breaks the AGENTS.md rule that every refusal names a code.
- In-app edits are refused before the write, so they never reach disk. What is lost is the unsaved editor buffer; Restore does not wipe anything.
- Out-of-band edits to NEW knowledge files are recorded: each launch scan re-detects them and appends a new ledger.divergence event carrying their sample paths.
- Only these leave no record: re-edits to the already-sampled files, watcher-time refusals, and in-app refusals.

In this vault, no knowledge file changed after 2026-08-17 11:57Z, so nothing was lost during the 39 days.

</details>

### F24 — No per-file or partial resolution: one bad file blocks everything, and restore rewrites every projection

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:415-421`
  - `src-tauri/src/lib.rs:922-926`
  - `src/lib/ipc.ts:302`
  - `src-tauri/src/ledger/reconcile.rs:577-583`

**Evidence**

resolve(vault, action) takes only an action string. Accept stops at the first refusing or missing file ('a deleted projection has no bytes to adopt'). Restore regenerates all projections (30 in the live vault) to fix 3. There is no 'keep A, restore B' and no 'accept this deletion'.

**Impact**

One agent-stamped file forces the user to discard every other legitimate edit. A user who deleted a concept on purpose can only get it back, never confirm the deletion.

**Recommendation**

Take a per-path decision map (keep / restore / adopt-as-agent / accept-deletion). Build one batch whose resolution digest covers the chosen paths, and close the mode only when every listed path is decided.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The core claim holds, and the code path is real and reachable: banner → ipc.resolveReconciliation → the Tauri command → reconcile::resolve(vault, action). It takes only an action string, so there is no per-path parameter anywhere in the chain.
- Accept (resolve_accept_with) is all-or-nothing:
  - A missing file returns Err ("a deleted projection has no bytes to adopt; restore ledger authority instead").
  - A refused diff_projection_file returns Err via `?` ("one bad file kills the whole adoption").
  - So "Keep my files" cannot confirm a deletion, and one forged file blocks adoption of every other file.
- Restore (resolve_restore_with) calls write_projection for every reducer projection and deletes any knowledge/*.md the reducer cannot explain. It has no path filter.
- Overstatements:
  1. "Restore rewrites every projection (30 to fix 3)": write_projection has a byte-identical fast path (manifest.rs:200-208) that only updates the manifest entry. Files already matching the ledger are not changed on disk; only the divergent ones are reverted.
  2. "Forces the user to discard every other legitimate edit": edits that were captured into the ledger survive a restore. Example: log.md's out-of-band edit was captured as projection.overridden at seq 179, so restore reproduces it. What restore throws away is only uncaptured content. But while the mode is open, capture is suspended (capture.rs:322, RECONCILIATION_SUSPENDED). So any human edit to knowledge files since 2026-08-17 is also uncaptured and would be reverted or deleted. That makes the impact real, and it grows the longer the mode stays open.
- Medium severity is appropriate.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:414-420: resolve(vault, action: &str) dispatches to one of two whole-vault actions and takes no paths.
- src-tauri/src/lib.rs:919-925: resolve_reconciliation(vault, action) carries no path argument.
- src/lib/ipc.ts:302 and src/app/ReconciliationBanner.tsx:28-61: the only two actions are the two buttons.
- reconcile.rs:441-447: restore loops over all state.projection_paths and calls write_projection.
- reconcile.rs:448-476: restore prunes the manifest and remove_file()s any knowledge .md not in projection_paths.
- reconcile.rs:~577-583 (accept): a missing file returns Err "a deleted projection has no bytes to adopt; restore ledger authority instead".
- reconcile.rs (accept loop): `capture::diff_projection_file(...).map_err(...)?` has the comment "one bad file kills the whole adoption".
- Mitigating detail, manifest.rs:200-208: write_projection makes no disk write when the file is already byte-identical.
- capture.rs:320-324: capture returns RECONCILIATION_SUSPENDED while reconciliation is open, so later human edits stay uncaptured and are exposed to restore.

**Correction.** - No per-file or partial resolution exists; confirmed.
- Accept aborts on the first forged, unrepresentable or missing file, so a deletion can never be confirmed.
- Restore touches only files that differ from the ledger. It reverts every divergent file and deletes unexplained knowledge .md files. It does not rewrite files that already match, and it does not lose edits that were captured.
- The real collateral risk: restore also wipes every human edit made while capture was suspended since the mode opened (39 days in the live vault), not just the 3 agent-stamped files.

</details>

### F25 — Banner reads status once, before the launch scan can open the mode, and never checks again

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/app/ReconciliationBanner.tsx:16-26`
  - `src/stores/vaultStore.ts:118`
  - `src/stores/vaultStore.ts:123`
  - `src/App.tsx:310-339`

**Evidence**

openVault sets vaultPath right away (L118), so the shell and the banner mount and call ledgerStatus. startWatcher, which runs activate → launch_scan (where the divergence is appended), is only awaited later (L123), after scanVault, loadCollections and listFolders. The banner's effect depends only on `vault`, and there is no listener for vault-changed or any poll.

**Impact**

A divergence found during this launch (as on Aug 17 at 11:58:54Z) doesn't show until the next launch or vault switch. Capture is suspended and nothing tells the user. Later state changes never reach the banner either.

**Recommendation**

Refresh after startWatcher resolves and on every vault-changed event. Better: have launch_scan emit a reconciliation-changed event that the banner subscribes to.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - The code is real and it runs on every launch.
- openVault sets vaultPath first. App.tsx only checks `!vaultPath` before rendering the shell, with no gate on status 'scanning'. So ReconciliationBanner mounts and calls ledgerStatus at once.
- startWatcher is awaited only after scanVault, loadCollections and listFolders. It is the only path to shadow::activate → launch_scan, and launch_scan is the only non-test code that appends ledger.divergence (reconcile.rs:376).
- ledger_status is a read-only reduce of the on-disk ledger. The first call almost certainly reads the state from before the divergence was appended.
- The banner's effect depends only on [refresh] → [vault]. There is no poll and no event listener. The only re-read happens after the user clicks a resolve button.
- So a divergence found during this launch stays hidden for the whole session, while capture is suspended.
- Two refinements to the claim:
  - The mode is stored in the ledger and rebuilt by ledger_status on every read. So it does show on the next launch or vault switch. That is why the user sees it now, and why the Aug 17 hiding was temporary.
  - "Later state changes never reach the banner" is true but matters less than it sounds. Only launch_scan opens the mode, so the missed update is essentially this one: the mode opening during launch.
- Medium severity stands: the mode is invisible for a session while capture is paused.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:16-26: refresh is memoized on [vault], and the useEffect runs only when refresh changes. No interval, no listen().
- src/stores/vaultStore.ts:118 (`set({ vaultPath: path, status: 'scanning' ...})`) runs before :123 (`await ipc.startWatcher(path)`), which comes after scanVault, loadCollections and listFolders.
- src/App.tsx:310: only `if (!vaultPath)` gates the shell. :339 renders `<ReconciliationBanner vault={vaultPath} />`.
- src-tauri/src/lib.rs:1467-1490: start_watcher → ledger::shadow::activate.
- src-tauri/src/ledger/shadow.rs:144: activate → reconcile::launch_scan.
- src-tauri/src/ledger/reconcile.rs:376: the only non-test LedgerDivergence construction (index.rs:1027 and conformance.rs are test/fixture code).
- src-tauri/src/ledger/shadow.rs:367-408: status() rebuilds reconciliation_open from the on-disk frames on every call. This is why the banner does appear on the next launch.
- grep: ledgerStatus has no caller besides the banner.

</details>

### F26 — Failed status reads become 'no banner', and the ledger states that route writes around the ledger are never shown

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src/app/ReconciliationBanner.tsx:17-21`
  - `src-tauri/src/ledger/shadow.rs:396`
  - `src-tauri/src/lib.rs:1462`
  - `src/lib/ipc.ts:283-285`
  - `src-tauri/src/ledger/shadow.rs:113-121`
  - `src-tauri/src/vault/write.rs:610-614`

**Evidence**

The banner turns a failed ledgerStatus into null ('renders no banner'). shadow::status maps `read: None` (Corrupt/Gap/Fork) to reconciliation_open=false. ledger_status can't return an error. ipc.ts says of the verdict 'no UI consumes this yet'. When the writer is refused (ForeignStore/Diverged/ForeignWriter, or a second instance holding the lock), every write_concept takes the legacy file-first path with zero ledger events. That is exactly what Aug 17 shows: 6 agent runs between 11:50 and 11:57Z with proposals_submitted=0, and the ledger jumps from seq 178 to 179. If the mode is open and there is no writer, resolve() returns 'no active ledger writer' while the banner still shows both buttons.

**Impact**

This breaks the rule that unavailable is never shown as empty. The upstream condition that creates these divergences can't be seen, so the user never learns that writes are going around the ledger until the unrecoverable forgery banner appears.

**Recommendation**

Give ledger_status an error channel, and add a has_active_writer field. Render a section-unavailable banner, or a 'ledger not recording (reason)' banner for refused or lock-lost states. Hide or disable the exits when there is no writer.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - Every cited line is real and reachable. The main point holds: no UI shows the ledger verdict, and when there is no ledger writer, write_concept silently falls back to writing the file only, so nothing reaches the ledger.
- Aug 17 runtime.db backs this up: 6 attended agent runs between 11:50 and 11:57Z, each with proposals_submitted=0. The rewritten files carry generated.by claude-code, which is the MCP DEFAULT_ACTOR stamp, so these edits went through MCP write_concept and took the legacy path.
- Wrong detail 1, the cause: the store id (30de38…) and the writer id (d62256…) on disk match this app's store.json and ledger-writer-id. So ForeignStore/ForeignWriter/Diverged were NOT the Aug 17 cause. What is left: a second instance holding the lock, or the process-wide Active slot pointing at another vault or path (with_writer returns None when the normalized path differs). The claim leaves out the Active-slot case, and the exact cause is inferred, not proven.
- Wrong detail 2, it is worse than claimed: ledger_status is a fresh read-only classify from disk. It never checks whether this process actually holds a writer. With the lock held, or the Active slot pointing elsewhere, it reports verdict "valid". The write.rs comment says the refusal "is visible through ledger_status", and that is false for these cases.
- Minor: Rust ledger_status returns a plain struct, not a Result. The TS catch→null only fires when the IPC call itself fails, so it matters less than claimed. The bigger gap is that Corrupt/Gap/Fork map to reconciliation_open=false and the verdict is never shown anywhere.
- Buttons with no writer: resolve returns "no active ledger writer … reconciliation is unavailable", and the banner shows it as an error line. So the user gets an error, not a silent failure, but both buttons are still offered.

**Evidence checked.** - src/app/ReconciliationBanner.tsx:17-21: `.catch(() => setStatus(null))`. Line 37 renders nothing when status is null or the mode is closed. The status is only fetched on mount or vault change (no polling).
- src/lib/ipc.ts:283-285: "no UI consumes this yet". A grep shows ledgerStatus is used only by ReconciliationBanner.
- src-tauri/src/lib.rs:1462-1465: `fn ledger_status(...) -> ledger::shadow::LedgerStatus` (not a Result).
- src-tauri/src/ledger/shadow.rs:396: `None => (None, None, 0, 0, false, Vec::new())`. recovery.rs:104-131 gives read: None for NoLedger/Corrupt/Gap/Fork/MultipleWriters.
- shadow.rs:113-121: the writer is opened only for Valid/TornTail/SealPending/NoLedger; any other verdict, or a failed open (lock held), gives None.
- shadow.rs:294-300: with_writer returns None on a vault-path mismatch or when there is no writer.
- shadow.rs:367-395: status() re-classifies from disk and does not check whether this process holds a writer.
- vault/write.rs:610-614 plus concepts.rs:68-80: legacy file-first fallback when with_writer returns None.
- mcp.rs:42: DEFAULT_ACTOR="claude-code". mcp.rs:2539 calls vault::write::write_concept.
- lib.rs:922-924: "no active ledger writer for this vault — reconciliation is unavailable".
- runtime.db runs table: 6 rows started 2026-08-17T11:50:08Z–11:54:54Z, lane agent, proposals_submitted=0, store_uuid 30de3878….
- Vault .cerebro/ledger/store.json: store_id 30de3878c1e1224a950a933de9543c62. App-data ledger-writer-id: d62256b3040f66f44f65d74c91d2b60c, the same as the segment prefix, so there is no foreign store or foreign writer.

**Correction.** Directionally right, with two fixes. (1) The Aug 17 bypass was NOT caused by ForeignStore, ForeignWriter or Diverged: the store id and writer id on disk match this installation. What is left: a second instance holding the ledger lock, or the process-wide Active slot pointing at another vault or path. The exact cause is unproven. (2) The visibility gap goes further than a missing UI. ledger_status re-classifies from disk and never checks whether the running process holds a writer. So in the lock-held and Active-mismatch cases it reports "valid", even though every write_concept goes around the ledger. That makes write.rs's comment "the refusal is visible through ledger_status" false. Also minor: Rust ledger_status cannot return an error, so the banner's catch→null only fires when the IPC call itself fails. With no writer and the mode open, the resolve error does appear in the banner, but both buttons are still offered.

</details>

### F27 — No test ever shows an open banner; the mock can't open the mode or mirror the suspension guard

- **Severity (claimed):** medium
- **Category:** test-coverage
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/lib/mockIpc.ts:568-596`
  - `src/lib/ipc.test.ts:105-117`
  - `src/app/ReconciliationBanner.tsx`
  - `e2e/`
  - `src-tauri/src/ledger/reconcile.rs:1434-1460`

**Evidence**

There is no ReconciliationBanner.test.tsx and no e2e spec that mentions reconciliation. The mock's ledgerStatus is hard-coded to reconciliation_open:false and resolveReconciliation always throws. ipc.test only checks the closed verdict. On the Rust side, the migration-signal test records the divergence but never resolves it. No test covers a legacy agent write leading to divergence and then an exit, or Verify/write_concept overwriting a divergent file.

**Impact**

Every UX defect above (the count, the dead-end button, the missing re-poll, catch→null) ships with no test. The mock also leaves out the RECONCILIATION_SUSPENDED guard, which goes against the AGENTS.md rule that the mock mirrors every Rust guard.

**Recommendation**

Let the mock be seeded with an open divergence (paths, reasons, refusing accept). Add vitest cases for count, error, busy and re-poll, and an e2e spec. Add Rust tests for a divergence written by an agent through the legacy path and for writes made while the mode is open.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - **Front-end half: confirmed.** No test renders the banner in the open state.
  - There is no ReconciliationBanner.test.tsx.
  - Outside the banner and ipc.ts, the only references to `reconciliation_open` / `resolveReconciliation` / `ReconciliationBanner` are the mount in App.tsx.
  - No e2e spec mentions reconciliation.
  - The mock hard-codes `reconciliation_open: false`, and its `resolveReconciliation` always throws.
  - ipc.test.ts only checks the no-ledger verdict and the invoke wiring.
  - So the count wording, the swallow-to-null catch, the missing re-poll and the error path for a failed button all ship with no test.
- **Rust half: overstated.** Both exits have real tests in reconcile.rs:
  - `restore_ledger_authority_regenerates_everything_and_closes_the_mode` (L1545)
  - `accept_current_files_adopts_through_capture_in_one_batch` (L1585)
  - `one_forged_file_refuses_the_entire_adoption` (L1639). This test covers the "Keep my files" dead end on a forged stamp and asserts it as intended behavior (mode stays open, nothing committed).
  - Capture suspension while the mode is open is tested at L1348.
  - Still true: no test builds the exact incident, where a `generated` stamp is changed out of band by an agent, then diverges, then only Restore can exit. Also no test of write_concept/verify_concept overwriting a divergent file.
- **Mock-parity half: overstated.** The mock has no ledger on purpose, and says so in place (mockIpc.ts:560-562, M21.7): mirroring the chain "would be guard logic the mock must not grow".
  - Its mode can never open, so the RECONCILIATION_SUSPENDED guard has nothing to fire on in the mock.
  - This is a documented scope exclusion, not a missing mirror of a reachable guard.
  - The real cost is testability: jsdom and e2e cannot reach the open banner without spying on ipc. That gap is real but low severity.

**Evidence checked.** - `src/lib/mockIpc.ts:560-562`: "The browser mock has no ledger (M21.7) ... mirroring it here would be guard logic the mock must not grow".
- `src/lib/mockIpc.ts:568-571`: `resolveReconciliation` throws "no ledger in the browser".
- `src/lib/mockIpc.ts:576-596`: `ledgerStatus` returns fixed `reconciliation_open: false`.
- `src/lib/ipc.test.ts:103-117`: checks only the no-ledger verdict and the invoke call.
- grep over src/ and e2e/: no ReconciliationBanner test and no spec. The only references outside `src/app/ReconciliationBanner.tsx` and `src/lib/ipc.ts` are in `src/App.tsx` (L6 import, L339 mount).
- `src-tauri/src/ledger/reconcile.rs` tests:
  - L1348: divergence opens the mode and suspends capture.
  - L1434: migration-signal test records the divergence only.
  - L1545: restore exit.
  - L1585: accept exit.
  - L1639: a forged `verified` stamp refuses the whole accept; the mode stays open and the head is unchanged.
- `src-tauri/src/ledger/capture.rs`: RECONCILIATION_SUSPENDED is defined at L154 and returned at L323, 643, 780, 841 and 886.

**Correction.** - **Holds:** there is no front-end or e2e test of an open ReconciliationBanner. The browser mock can never open the mode, so the banner's copy, its error handling (catch→null), its lack of re-polling and its button failure path are all untested.
- **Wrong:** "No test covers divergence then exit". Rust tests cover both exits, and also cover a forged stamp refusing all of "Keep my files" (reconcile.rs L1545, L1585, L1639).
- **Remaining Rust gap:** no test of the incident's exact path (an agent changes the `generated` stamp out of band → divergence → only Restore works), and none of write_concept/verify_concept writing while divergent.
- **Mock parity:** the missing RECONCILIATION_SUSPENDED guard is a documented design exclusion (no ledger in the mock, M21.7). It is not a breach of the mirroring rule, because the guard can never fire there.

</details>

### F28 — A migration_source_changed divergence likely has no working exit (inferred from code, not the live incident)

- **Severity (claimed):** low
- **Category:** recovery-ux
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:436-439`
  - `src-tauri/src/ledger/reconcile.rs:461-473`
  - `src-tauri/src/ledger/migrate.rs:199-226`
  - `src-tauri/src/ledger/arm.rs:61-67`
  - `src-tauri/src/ledger/capture.rs:937-940`

**Evidence**

SourceChanged fires when a migration epoch was started over different corpus bytes, which means the migration was interrupted. Restore then either errors with 'nothing to restore — the ledger holds no projections', or deletes every knowledge .md that the partial migration never projected. Accept refuses non-projection files ('is not a committed projection'). Neither exit finishes the migration, so arm hits the same refusal again on the next launch.

**Impact**

A crash during the first migration, followed by any edit, can leave the vault in a mode it can't leave, or deletes the concepts that were never ingested.

**Recommendation**

Give the migration signals their own exit (for example, re-migrate under a superseding epoch or finish from current bytes). Don't allow restore to delete files while migration.completed is missing.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** The claim holds. The path is real and reachable, the exits behave as described, and no test covers either exit after this signal.

**How it fires**
- migrate_vault appends migration.started with append_once. The key is `migrate-v1:{store}:started` and the body carries source_digest, a hash of every knowledge/*.md file's path and content.
- It then appends each belief, snapshot, alias, attestation and relation one at a time, not as one batch.
- So a crash or IO failure after `started` leaves a partial epoch with no `completed` event.
- If any knowledge file changes before the next launch (a user edit, a git sync, or an agent write while arm is in its Failed state), the rerun hits a key conflict. That becomes MigrateError::SourceChanged.
- arm returns Refused before it creates the initial manifest. shadow.rs maps that to DivergenceSignal::MigrationSourceChanged, and launch_scan records a ledger.divergence and opens the mode. Capture is also skipped whenever migration_signal is set.

**What each exit does**
- With no manifest, every migrated file classifies as a Divergence ("a file exists for reducer state the manifest never recorded"). Every file the migration never reached classifies as "path is unknown to both manifest and reducer".
- **Accept** runs diff_projection_file on every non-Match path. For any file the migration never reached, that fails with "is not a committed projection", and one failure refuses the whole action.
- **Restore**, if no belief was created before the crash: it errors "nothing to restore — the ledger holds no projections". Accept also refuses in that case, so the mode is stuck open for good.
- **Restore**, if some beliefs were created: it regenerates only those and deletes every knowledge .md the reducer cannot explain. That silently removes every concept the migration never reached, then closes the mode.
- **After either exit**, the next launch runs arm again with no `completed` event. The corpus digest is now the partial set, which still differs from the one recorded in `started`, so SourceChanged fires again.

**One detail beyond the claim**
- After a restore the manifest digest changes, so the next launch records a new divergence and reopens the mode.
- A later restore can produce the same detection key. Its append_once then conflicts because the body's ledger_head differs, and launch_scan's error is discarded with `let _ =`.
- In that case the mode may stay closed while the migration stays incomplete forever and the launch scan never captures anything.
- Either way, neither exit ever finishes the migration.

**Why low severity is fair**
- It needs a crash or IO failure in the middle of the first migration, then a corpus change before relaunch.
- It is unrelated to the live incident, whose only signal was manifest_reducer_disagreement.
- The deleted concepts can likely be recovered from vault git, if they were committed.

**Evidence checked.** - src-tauri/src/ledger/migrate.rs:156-179: source_digest is a hash over every knowledge file's path and content.
- migrate.rs:199-226: the append_once of `migrate-v1:{store}:started` maps a key conflict to SourceChanged.
- migrate.rs:240+: each output is its own append_output, not batched, so a crash leaves a partial epoch.
- src-tauri/src/ledger/arm.rs:55-69: `completed` is checked; otherwise it migrates, and SourceChanged returns Arming::Refused before the manifest is created. The test at arm.rs:268-272 asserts "no manifest".
- src-tauri/src/ledger/shadow.rs:127-150: Refused becomes MigrationSourceChanged and is passed to launch_scan; its error is ignored with `let _ =`.
- src-tauri/src/ledger/reconcile.rs:311-315: capture is skipped when migration_signal is set.
- reconcile.rs:73-84 (classify_path): (None, None) is "path is unknown to both manifest and reducer"; (None, Some) with a file present is Divergence.
- reconcile.rs:436-439 (restore): "nothing to restore — the ledger holds no projections" when projection_paths is empty.
- reconcile.rs:456-473: every knowledge .md not in projection_paths is removed with remove_file.
- reconcile.rs:~597-599 (accept): diff_projection_file is called on every non-Match path.
- src-tauri/src/ledger/capture.rs:937-940: "is not a committed projection".
- src-tauri/src/ledger/reduce.rs:4590: a resolution clears reconciliation_divergences.
- No test in ledger/ exercises resolve_restore_with or resolve_accept_with after a MigrationSourceChanged divergence. The only tests are the arm refusal (arm.rs:268) and launch_scan recording the signal (reconcile.rs:1434-1460).

</details>
