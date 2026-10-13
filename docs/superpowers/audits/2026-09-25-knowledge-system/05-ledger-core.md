# Ledger core integrity

> Audit lens `ledger-core` · first-pass auditor, each finding adversarially verified

## Summary

- The hash chain itself is fine: an independent re-hash of all 273 records verifies (head 9a551151…). The `.ndjsonl.open` file is normal: a segment seals only at 1,024 records (writer.rs:46).
- Premise correction: capture is not paused for vault.write (seq 181–273 were recorded while the mode was open). The current process (pid 70308) holds the lock and the segment file handle, and the vault has not changed since 2026-08-30 21:08 PDT. The gap since Aug 31 is simply no activity, apart from ONE lost write at 04:08:50Z.
- Likely root cause of both vaults' divergences: opening the same vault a second time in one process (reload, Fast Refresh, re-picking the vault) conflicts with the process's own lock and silently drops the writer. With no writer, write_concept writes the files directly, and the next launch scan always rejects those files as forged. That fits Aug 17 and the old vault's two divergences 32 s apart mid-run.
- The failure is invisible: status and UI never say whether a writer exists, the git head trailer is never read, and rewind detection has gaps (remembered head lags, silent index rebuild, silent re-baseline if the ledger is deleted).

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F39 | critical | yes | Opening the same vault twice in one process quietly drops the ledger writer, and this likely caused both vaults' divergences |
| F40 | high | yes | With no writer, write_concept quietly writes the file directly, and the next launch scan always rejects that file as forged |
| F41 | high | yes | No status or UI shows whether this process actually holds the writer; refused verdicts show no banner and record no event |
| F42 | medium | yes | Nothing ever reads the git ledger-head trailer, and two divergence signals are declared but never produced |
| F43 | medium | yes | Rewind detection has gaps: the remembered head lags behind, an index refusal is silently rebuilt, and deleting the ledger silently starts a fresh baseline |
| F44 | low | yes | The writer does not stop after a failed write or fsync, which can turn a recoverable torn tail into permanent corruption |
| F45 | low | yes | ledger_status, documented as read-only, can delete and recreate the live index; the index's belief/entity tables are still written but never read |

### F39 — Opening the same vault twice in one process quietly drops the ledger writer, and this likely caused both vaults' divergences

- **Severity (claimed):** critical
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/high, confirmed/critical)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:111-121`
  - `src-tauri/src/ledger/shadow.rs:169`
  - `src-tauri/src/ledger/writer.rs:955-968`
  - `src-tauri/src/lib.rs:1478`
  - `src/stores/vaultStore.ts:123`
  - `src/App.tsx:290-308`

**Evidence**

- activate() calls LedgerWriter::open (a new flock on <vault>/.cerebro/ledger/lock) BEFORE replace_active drops the previous Active. Nothing checks whether that Active already holds the same vault.
- macOS flock is per open file description. Measured in scratchpad: a second flock(LOCK_EX|LOCK_NB) from the SAME process returns EWOULDBLOCK (Errno 35).
- So a second start_watcher on the same vault goes: open → Err('another Cerebro instance…') → .ok() → writer None. replace_active then drops the old writer, the lock is released, and the next activation succeeds. The writer alternates on/off.
- No test activates twice without deactivate(); every test in shadow.rs calls deactivate() first.
- Triggers: webview reload, a Fast Refresh of App's boot effect, or Settings → 'Change vault…' picking the same folder. The user runs `pnpm tauri dev` (pid 70308, target/debug/cerebro).
- Live data fits the alternating pattern:
  (a) 2026-08-17 11:49:20Z types/risk.md, 11:50 prototypes/* and types/decision.md, then 11:51–11:57 agent knowledge writes: all have no events. Launch scan at 11:58:53Z.
  (b) 2026-08-31 04:08:50Z records/bets/test.md (M48 column test content) has no vault.write. Its autosync commit 5b5b6b5 still carries head seq 273.
  (c) Old vault 'Cerebro Test Vault' (store 8e726…): ledger.divergence at seq 42 (21:30:11Z) and seq 53 (21:30:43Z), 32 s apart, DURING one agent run (1e504d2a, 21:24–21:31Z) whose other writes kept landing ledger-first (seq 43–52, 54–68). Each launch scan only runs on a successful activation.
- Both of the user's vaults ended with unresolved reconciliation (old: 3 open divergences, abandoned; new: 1 open, 39 days).

**Impact**

Every reload during development opens a window with no writer. In that window, agent and UI writes land on disk with no ledger event. The next successful activation finds them and opens reconciliation mode. The user sees 'Knowledge history diverged' without having done anything.

**Recommendation**

- Make activate idempotent: if Active.vault == vault and its writer is Some, reuse it (skip re-open), or drop the old Active before LedgerWriter::open.
- Make start_watcher a no-op for the already-active vault.
- Add a test: activate twice with no deactivate, then assert with_writer is Some and that a record() lands.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Mechanism: confirmed.** activate() opens a second LedgerWriter on the same vault while the old Active still holds the flock. That open fails and `.ok()` turns the failure into `writer: None`, which replace_active then installs. Dropping the old Active releases the lock, so the next activation succeeds and the writer flips back on.
- **Silent: confirmed.** `ledger_status` classifies the disk only. It never reports whether the process holds a writer, so it still says "valid" while nothing is being recorded.
- **Same-process flock: confirmed.** I ran my own test. A second `open` + `flock(LOCK_EX|LOCK_NB)` from the same process gets Errno 35.
- **No-writer writes: confirmed.** Every write falls to the legacy file-first path. It writes the file and stamps `generated`, but `shadow::record` returns early, so no event is recorded.
- **Live vault matches that path:**
  - The Aug 17 log.md lines use `insert_log_entry`'s `* **Update**: [...]` format, including the duplicates. That is Cerebro's own legacy branch, so these were Cerebro MCP `write_concept` calls that ran while `with_writer` returned None. They were not an outside tool.
  - The 11:49 UI write to types/risk.md also has no event.
  - The day before, the same agent's writes went ledger-first (seq 167-170, `proposal.submitted` by claude-code).
  - The next successful activation's launch_scan then hit the forged `generated` stamp and opened the divergence.
- **Overstated: the cause.** The window with no writer is proven. That double activation opened it is not. A second Cerebro process holding the lock (installed app plus `tauri dev`, or another worktree's build) leaves the same trace. shadow.rs says itself that this case "lands in the None arm". Nothing in the data tells the two apart, so "likely" is fair but it is not established.
- **Triggers:**
  - Real: webview reload, Settings "Change vault…" (or the chooser) picking the same folder, and HMR full reloads or Fast Refresh re-running App's boot effect.
  - Not a trigger: StrictMode's double effect. The `cancelled` guard stops the first openVault.
  - In release builds the only easy trigger is re-picking the same vault. So this is mainly a dev hazard, and "every reload" really means every other reload.
- **Old vault (c):** I did not verify it. I did check that `ledger.divergence` is only written by launch_scan (reconcile.rs:400; index.rs:1026 is test code), which fits the claim that each divergence marks a successful activation.
- **Severity: high rather than critical.** The failure is serious and silent, but it is conditional, and the causation for this incident is not unique.

**Evidence checked.** - **src-tauri/src/ledger/shadow.rs:**
  - L103-111: `LedgerWriter::open(&vault, &id).ok()`, with the comment "A held lock (second instance) lands in the None arm".
  - L160-166: `replace_active` runs AFTER the open.
  - L274-278: `replace_active` just overwrites the slot, with no same-vault check.
  - L283: `deactivate` is `#[cfg(test)]` only.
  - L311-323: `record` returns early when `writer` is None.
  - L367-408: `status()` classifies the disk and ignores the Active writer.
- **src-tauri/src/ledger/writer.rs:955-968:** `acquire_lock` = `try_lock`; WouldBlock maps to "another Cerebro instance holds this vault's ledger".
- **src-tauri/src/lib.rs:1478:** `start_watcher` ignores what activate returns.
- **src/stores/vaultStore.ts:123:** every `openVault` calls `startWatcher`.
- **Callers of openVault:** App.tsx:298 (boot effect, `cancelled` guard), App.tsx:158/163, SettingsPage.tsx:100.
- **src-tauri/src/vault/write.rs:**
  - L609-625: if `concepts::write_concept` returns None, the legacy `concept_write` + `shadow_write` path runs.
  - L700-716: legacy `insert_log_entry` append.
- **flock test (scratchpad python):** second flock in the same process returns `[Errno 35] Resource temporarily unavailable`.
- **Live ledger:** seq 167-170 (Aug 16) are ledger-first agent writes (`proposal.submitted` actor claude-code). seq 178 is followed directly by 179/180 from the scan, with nothing for the 11:49-11:57Z writes.
- **Vault git log -p knowledge/log.md:** commits 812605a..e1770e4 add duplicate `* **Update**: [...]` lines in Cerebro's legacy log format; 90437f4 (types/risk.md, 11:49Z) has no ledger event.
- **Where divergence is written:** `KIND_LEDGER_DIVERGENCE` is only appended at reconcile.rs:400; index.rs:1026 is a test.

**Correction.** - **Confirmed:**
  - A second start_watcher on the vault already active in the same process silently installs an Active with no writer.
  - Activations alternate writer on and off.
  - In the gap, writes land on disk with no event, and the next successful activation opens reconciliation.
  - The Aug 17 edits in the live vault did go through Cerebro's legacy no-writer path.
- **Not proven:** that double activation caused it. A second Cerebro process holding the lock leaves an identical trace.
- **Trigger scope:** mainly dev (webview/HMR reloads); in release it needs the same vault re-picked. React StrictMode does not trigger it.
- **Severity:** high, not critical.

</details>

<details><summary>Verifier 2: confirmed (severity → critical)</summary>

**Reasoning.** - **Refutation failed.** Nothing checks whether the vault being opened is already the active one, and the running app does re-activate a vault it already has open.
- **Mechanism:** the webview boot effect (App.tsx:298) or Settings → Change vault (SettingsPage.tsx:100) calls openVault. That calls startWatcher, which calls start_watcher (lib.rs:1478), which calls shadow::activate. activate runs LedgerWriter::open (writer.rs:265 acquire_lock), and the `.ok()` at shadow.rs:118 turns its error into None. replace_active (shadow.rs:274) then drops the old writer and releases the lock.
- **The lock fails inside one process.** I measured it: a second flock(LOCK_EX|LOCK_NB) on a new file description in the same process returns Errno 35. So the writer is off after every other re-activation. The `deactivate()` that tests call is `#[cfg(test)]` only, so the app never clears the old Active first.
- **Silent drop:** with no writer, vault/write.rs:609-626 write_concept falls back to the "legacy file-first path". The file gets the server-stamped `generated: {by: claude-code}` and no ledger event. shadow::record (shadow.rs:321) returns silently. This is the path that produced the Aug 17 files. It is not a separate agent bypass: they came through the sanctioned write_concept door while the writer was down.
- **Old vault shows the alternation.** Agent run 1e504d2a ran without interruption from 21:24:10 to 21:31:23Z, outcome succeeded, so the process never restarted. Only one vault was registered on Aug 15 (the test vault was first seen Aug 16), so no vault switch was involved. Inside that run the sequence was:
  - Launch scans succeeded at 21:30:11 (seq 42) and 21:30:43 (seq 53). Each needs a successful in-process activation.
  - Seq 43–52 landed ledger-first in between. Only the lock holder can do that, so the agent's MCP host and the scan runner are the same process.
  - Seq 53 flags 2 NEW unrecorded paths (authority-bearing-actions, promotion-local-to-canonical) written after 21:30:25.
  - So the writer was lost and regained inside one process in about 18 seconds. That is the alternation the code forces.
- **Live vault fits the same pattern.** Six attended agent runs by the app on vault 5171d… (runtime.db runs, 11:50:08–11:57:44Z, all succeeded) left no ledger events. A successful activation then ran the launch scan at 11:58:53 (seq 179/180). Cerebro repo commits every few minutes at that time (05:07–05:59 local) show active `tauri dev` work, where Vite full reloads and Fast Refresh re-run the boot effect.
- **Caveat:** for the live vault I can't tell a failed re-activation apart from a second process holding the lock. Both leave the writer at None, and the old-vault evidence points to re-activation.
- **Production reach is narrower:** it needs a webview reload or re-picking the same folder. The user runs the dev build, though, and the effect is silent history loss plus a reconciliation mode that "Keep my files" can't close. Critical stands.

**Evidence checked.** - Nothing guards against re-activating the same vault:
  - src-tauri/src/ledger/shadow.rs:111-121 `LedgerWriter::open(&vault,&id).ok()`, and its comment says a held lock "lands in the None arm".
  - shadow.rs:170 `replace_active` is called unconditionally. shadow.rs:274-278 swaps Active and drops the old writer (releasing the flock). shadow.rs:283 `deactivate` is `#[cfg(test)]`.
- The lock is a per-descriptor flock:
  - writer.rs:955-968 acquire_lock uses File::try_lock, and WouldBlock returns Err "another Cerebro instance…".
  - Scratchpad python test: a second flock on a new fd in the same process gives `[Errno 35] Resource temporarily unavailable`.
- Callers:
  - lib.rs:1470-1478 start_watcher → shadow::activate.
  - vaultStore.ts:117-123 openVault → ipc.startWatcher.
  - App.tsx:290-305 boot effect. SettingsPage.tsx:100 openVault(picked).
- Silent drop:
  - vault/write.rs:606-626: no writer → "Legacy file-first path", with generated.by stamped and no event.
  - ledger/concepts.rs:67-79 write_concept returns None without a writer.
  - shadow.rs:311-323: record returns silently when writer is None.
- Old vault (ledger at /Users/joseflagorio/Documents/Cerebro Test Vault/.cerebro/ledger/…open):
  - Divergences at seq 42 (21:30:11.954Z, 2 paths) and seq 53 (21:30:43.938Z, 4 paths, 2 of them new).
  - Seq 43–52 are ledger-first belief events from 21:30:16–21:30:25.
  - runtime.db `runs`: 1e504d2a… on vault 17e64…, 21:24:10.501Z→21:31:23.818Z, succeeded.
  - vault_registry: the test vault was first seen 2026-08-16, so only one vault was registered on Aug 15.
- Live vault:
  - runtime.db `runs`: 6 attended agent runs on vault 5171d…, 2026-08-17T11:50:08Z–11:57:44Z, all succeeded.
  - Ledger: seq 178 at 00:10:35Z, then seq 179/180 at 11:58:53Z. Seq 180 ledger_head = remembered_head = seq 178.
- The remembered-head fields are NOT diagnostic: shadow.rs:328-339 updates the remembered head only on `record`, not on with_writer appends.

</details>

### F40 — With no writer, write_concept quietly writes the file directly, and the next launch scan always rejects that file as forged

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/vault/write.rs:600-626`
  - `src-tauri/src/vault/write.rs:695-719`
  - `src-tauri/src/mcp.rs:2500-2539`
  - `src-tauri/src/mcp.rs:1717-1743`
  - `src-tauri/src/ledger/capture.rs:960-966`
  - `src-tauri/src/ledger/shadow.rs:288-304`

**Evidence**

- with_writer returns None when there is no writer. vw::write_concept and append_knowledge_log then take the 'legacy file-first path' and report Ok. That path's shadow_write is also a no-op without a writer, so zero events are written.
- tool_write_concept stamps generated:{by: actor, at: now} (mcp.rs:2501). A legacy write therefore always changes the `generated` stamp.
- capture.rs:962-966 hard-refuses any out-of-band change to generated/verified as 'provenance forgery'. The app's own fallback output is exactly what its own reconciler classifies as forgery.
- The two agent-facing doors disagree: tool_commit_proposals refuses with no writer ('this vault has no active ledger writer…', mcp.rs:1741); tool_write_concept silently succeeds.
- The 5 Aug-17 commits (812605a…e1770e4) changed knowledge/ with duplicate '**Update**' log lines from insert_log_entry. log.md was then captured as projection.overridden with actor human:owner (seq 179), which attributes agent output to the human.

**Impact**

Every no-writer window leads to divergence. The divergence can only be closed by 'Restore recorded history', which reverts the agent's work. Provenance is wrong: agent output is recorded as a human override.

**Recommendation**

- In app builds, knowledge/ writes must refuse without a writer, as commit_proposals already does. Keep the legacy path only behind cfg(test) or for the browser mock.
- If a fallback must stay, record a pending capture that carries the server-stamped actor, and never let capture label it human:owner.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - I read the whole chain and each step holds.
- With no writer, `with_writer` returns None, so `ledger::concepts::write_concept` and `append_log` return None too. `vault::write::write_concept` and `append_knowledge_log` then fall back to plain file writes and return Ok. `shadow_write` calls `shadow::record`, which returns early when there is no writer. Result: zero events.
- `tool_write_concept` always stamps `generated: {by: actor, at: now_iso()}`, where `DEFAULT_ACTOR` is "claude-code". That matches the Aug-17 files. So a fallback rewrite of an existing projection always changes `generated.at`.
- At the next launch scan, a Complete manifest entry plus a changed, parseable file is classified OutOfBandEdit. Capture calls `diff_projection_file`, which hard-refuses any `generated`/`verified` change as "provenance forgery". The refusal is pushed to `divergent`, which raises ManifestReducerDisagreement.
- The vault git history backs this up. Commit 1c8c9e9 changes only `generated.at` (11:51:31Z to 11:52:02Z), `about`, `description` and `stale_after`. The trailer carries the same ledger head, 619957fc. The log.md bullets match `insert_log_entry`'s format byte for byte.
- log.md has no `generated` stamp, so its capture succeeds. It is recorded with actor_id "human:owner" (hard-coded), which misattributes agent output to the human.
- The asymmetry is real. `tool_commit_proposals` turns None into an error ("no active ledger writer"). `tool_write_concept` succeeds silently.
- Small overstatements, none of which change the finding:
  - "Always rejected as forged" is exact for REVISIONS of existing projections. A brand-new concept written with no writer is instead classified Divergence("path is unknown to both manifest and reducer"). The outcome is the same (reconciliation opens), but the reason is not forgery.
  - "Every no-writer window" should read: every window in which write_concept is actually called, followed by a launch where a writer is active.
  - log.md itself is captured, not rejected.

**Evidence checked.** - src-tauri/src/vault/write.rs:600-626: legacy path after `ledger::concepts::write_concept` returns None, then `concept_write` and `shadow_write`.
- src-tauri/src/vault/write.rs:695-719: `append_knowledge_log` legacy branch, calling `insert_log_entry`.
- src-tauri/src/vault/write.rs:263-272: `shadow_write` calls `shadow::record`.
- src-tauri/src/ledger/shadow.rs:320-322: `record` returns when `active.writer` is None.
- src-tauri/src/ledger/shadow.rs:293-304: `with_writer` returns None when there is no writer or the vault path does not match.
- src-tauri/src/ledger/concepts.rs:68-92: `write_concept` and `append_log` return None without a writer.
- src-tauri/src/mcp.rs:2501: `generated: {by: actor, at: now_iso()}`.
- src-tauri/src/mcp.rs:42: `DEFAULT_ACTOR = "claude-code"`.
- src-tauri/src/mcp.rs:1717-1743: commit_proposals `.ok_or_else("this vault has no active ledger writer…")`.
- src-tauri/src/ledger/reconcile.rs:119-124: Complete entry, file differs and parses → OutOfBandEdit.
- src-tauri/src/ledger/reconcile.rs:74-77: a new file unknown to both manifest and reducer → Divergence.
- src-tauri/src/ledger/reconcile.rs:~318-330: failed capture is pushed to `divergent`, then ManifestReducerDisagreement.
- src-tauri/src/ledger/capture.rs:767-784: `capture_out_of_band_with`.
- src-tauri/src/ledger/capture.rs:960-966: forgery refusal.
- src-tauri/src/ledger/capture.rs:810,822: actor_id "human:owner".
- Vault /Users/joseflagorio/Documents/test, commit 1c8c9e9: gcs-5-supervision-ratio.md `generated.at` 11:51:31Z → 11:52:02Z. Commits 812605a..e1770e4 all carry trailer Cerebro-Ledger-Head 619957fc…. The log.md bullets `* **Update**: [title](/risks/….md).` match knowledge.rs:288.

**Correction.** The mechanism is real, with three corrections:
- The forgery refusal applies to revisions of existing projections. A new concept written with no writer also opens reconciliation, but the reason is "path is unknown to both manifest and reducer", not forgery.
- Divergence follows only when write_concept is actually called during the no-writer window and a later launch runs with an active writer.
- log.md is captured, not rejected, and is misattributed to human:owner.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** - Could not refute it. Each code step is real, and the live vault shows this path is how the Aug 17 incident happened.
- No-writer window happens in the real app. `activate` sets `writer` to None when the ledger is refused, when the writer id fails, or when a second instance holds the lock. Tauri has no single-instance plugin, so a dev build and the installed app can both open the same vault.
- Live data shows such a window on Aug 17. Commits at 04:49–04:57 PDT changed types/risk.md, prototypes/* and knowledge/*, and NONE of them has a ledger event. The ledger jumps from seq 178 (00:10Z) to seq 179 (11:58Z, the scan). Every other app write also goes through shadow `record`, so only a missing writer explains why none of them were recorded.
- The knowledge edits have the legacy path's fingerprints: the concept_write serde_yaml layout (block lists, `generated:` as a mapping) and `insert_log_entry` bullets in log.md. The Aug 16 writes (seq 162–171) went through the ledger as `belief.created`/`revised`, so the same tool used the ledger path while a writer existed.
- Forgery refusal is certain for an existing concept. `tool_write_concept` always stamps `generated.at = now`, so the diff always contains `generated`, and capture refuses that with "provenance forgery".
- The two agent doors disagree, as claimed: `commit_proposals` errors when there is no writer, while `write_concept` returns Ok and says nothing.
- Misattribution confirmed: seq 179 records log.md as `projection.overridden` with actor human:owner. The legacy `append_knowledge_log` passed actor None, and capture fills in human:owner.
- Overstatements:
  - "Always rejected as forged" is only true for revisions of concepts the ledger already tracks. A NEW concept written with no writer lands in classify_path's (None, None) case. That is Divergence("path is unknown to both manifest and reducer"), a different reason with the same outcome, so the real impact is somewhat BROADER than claimed.
  - "Every no-writer window leads to divergence" only holds if a writer comes back later and runs a launch scan. With a permanently refused ledger no scan runs. With a NoLedger vault, migration adopts the files instead.
- Severity stays high: live, reachable, silent loss of provenance, and the only way to close the mode reverts the agent's work.

**Evidence checked.** - src-tauri/src/vault/write.rs:600-626: write_concept falls back to `concept_write` plus `shadow_write` when `ledger::concepts::write_concept` returns None.
- src-tauri/src/vault/write.rs:695-719: append_knowledge_log falls back the same way, with actor None.
- src-tauri/src/ledger/concepts.rs:68-92: `write_concept` and `append_log` return None when there is no writer (via `with_writer`).
- src-tauri/src/ledger/shadow.rs:294-306: `with_writer` returns None when there is no writer.
- src-tauri/src/ledger/shadow.rs:311-323: `record` returns early when there is no writer, so zero events are written.
- src-tauri/src/ledger/shadow.rs:82-121: `activate` sets writer to None on a refused verdict, a writer_id failure, or a lock held by another instance ("A held lock (second instance) lands in the None arm").
- No tauri single-instance plugin found in Cargo.toml or lib.rs.
- src-tauri/src/mcp.rs:2501: `generated: {by: actor, at: now_iso()}` is always stamped.
- src-tauri/src/ledger/capture.rs:963-966: a changed `generated`/`verified` stamp is refused as forgery.
- src-tauri/src/mcp.rs:1737-1742: commit_proposals errors with "no active ledger writer".
- src-tauri/src/ledger/reconcile.rs:73-77: (None, None) gives Divergence("path is unknown to both manifest and reducer") for new concept files.
- reconcile.rs:118-121: an edited tracked file is classified OutOfBandEdit.
- Live ledger (.ndjsonl.open), seq 162-171 (2026-08-16T20:00Z): belief.created by claude-code plus belief.revised by system:knowledge-log, i.e. the ledger-first path.
- Live ledger, seq 178 is 2026-08-17T00:10Z and seq 179 is 2026-08-17T11:58:53Z (projection.overridden log.md, actor human:owner).
- Vault git, commits 90437f4 (types/risk.md), f7df8b4 (prototypes/*, types/decision.md), and 812605a..e1770e4 (knowledge/*) are all on 2026-08-17 04:49-04:57 PDT, and none has a ledger event.
- The 812605a diff shows the serde_yaml frontmatter layout and the `* **Update**: [...]` bullet from knowledge.rs:287 insert_log_entry.
- src/git/useGit.ts:320-326 and lib.rs:1455: the commit trailer head is read from disk, so it is present even with no writer.

**Correction.** - The mechanism is real and reachable, and it explains the live Aug 17 divergence.
- Precise wording: with no active writer, write_concept and append_knowledge_log silently take the file-first path and record zero ledger events.
- When a writer later returns, the launch scan behaves as follows:
  - An edited, tracked concept is refused as provenance forgery, because `generated.at` always changes.
  - A newly created concept goes to divergence as "path is unknown to both manifest and reducer".
  - log.md is captured as a human:owner override.
- No divergence follows if the ledger stays refused, so no scan ever runs, or if the vault had no ledger yet, so migration adopts the files.

</details>

### F41 — No status or UI shows whether this process actually holds the writer; refused verdicts show no banner and record no event

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:343-411`
  - `src-tauri/src/ledger/shadow.rs:1-10`
  - `src-tauri/src/ledger/shadow.rs:113-121`
  - `src/app/ReconciliationBanner.tsx:50`
  - `src/lib/ipc.ts:283-297`

**Evidence**

- status() classifies from disk only and never consults active(). No field says whether this process has a writer, yet the module doc (shadow.rs:9-10) claims 'What IS active is visible through status'.
- A lost lock is discarded with .ok() (shadow.rs:118) and never logged.
- For the Diverged, ForeignWriter, Corrupt, Gap and Fork verdicts, activate opens no writer and runs no launch_scan, so no ledger.divergence is written.
- The banner renders only when reconciliation_open is true (computed from disk events). No UI reads `verdict`: only mockIpc declares it, and the ipc.ts doc says 'no UI consumes this yet'.
- Consequences: a restore that trips RememberedHeadRegression, a wiped app-data writer id (ForeignWriter), or a second Mac all put the app into permanent silent legacy mode with no banner.

**Impact**

The ledger can be off for a whole session, or forever, while the app looks healthy. Agent and human knowledge writes pile up unrecorded until some later scan turns them into an unresolvable divergence.

**Recommendation**

- Add writer_active: bool and writer_refusal: Option<String> to LedgerStatus, read from Active.
- Show a banner for any verdict other than valid and for a missing writer ('Knowledge history is not being recorded: <reason>').
- Record refused verdicts as a divergence or operational row instead of staying silent.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real, end to end. `status()` reclassifies from disk only and never reads the process-global `active()` slot, so nothing reports whether this process actually holds a writer.
- The lost-lock case is the worst one. A second instance gets verdict `valid` from disk, but `LedgerWriter::open(..).ok()` returns None, so `ledger_status` says "valid, chain verifies" while this process records nothing. The `.ok()` also swallows every other open error, not just a held lock.
- Refused verdicts (Corrupt, Gap, Fork, ForeignWriter, ForeignStore, Diverged) fall into `_ => None`. No writer means no `arm` and no `launch_scan`, so no `ledger.divergence` event is written and `reconciliation_open` stays false.
- `start_watcher` throws away `activate()`'s returned verdict with `let _`.
- On the UI side, the only `ledgerStatus` consumer is ReconciliationBanner. It renders only when `reconciliation_open` is true, never reads `verdict` or `detail`, and turns errors into null. ipc.ts itself says "no UI consumes this yet".
- The refusal persists. `activate` deliberately does not overwrite the remembered head when it refuses, so Diverged or ForeignWriter comes back on every launch until someone intervenes by hand.
- The impact claim holds: the knowledge write paths quietly fall back to writing the file directly. `vault/write.rs:609-615` `write_concept` calls `concepts::write_concept`, gets None without a writer, and takes the legacy file-first path. That path writes the agent's `generated` stamp straight to the file.
- A later scan with a live writer classifies those files as out-of-band edits, and `diff_projection_file` refuses them as "provenance forgery". That is the same shape as the live incident (Aug 17 agent edits with `generated: claude-code`, no ledger events, then an unresolvable divergence).
- Minor imprecisions:
  - "RememberedHeadRegression" is a `DivergenceSignal` name. The writer-refusing path is actually `Verdict::Diverged`, which `classify` returns on head regression.
  - The comment at shadow.rs:9-10 is not strictly false for refused verdicts, because `status.verdict` does name them. It is false for the lost-lock case, and in every case no UI shows it.
- None of this weakens the claim.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:9-10: module doc says "What IS active is visible through `status`".
- shadow.rs:113-121: the writer opens only on Valid/TornTail/SealPending/NoLedger, via `LedgerWriter::open(&vault,&id).ok()`; everything else is `_ => None`.
- shadow.rs:127-150: `arm` and `launch_scan` run only under `if let Some(writer)`, so a refused verdict writes no divergence event.
- shadow.rs:155-167: no index replay and no remembered-head update when refused, so the refusal persists.
- shadow.rs:367-408: `status()` calls `classify(&dir, ...)` from disk. There is no `active()` access and no has-writer field in `LedgerStatus`.
- recovery.rs:136-180: Diverged on head regression, ForeignWriter when a segment's writer_id differs from ours.
- lib.rs:1476-1478 (`start_watcher`): `let _ = ledger::shadow::activate(...)`. lib.rs:1462: `ledger_status` returns the disk-only status.
- src/app/ReconciliationBanner.tsx:19-21: `.catch(() => setStatus(null))`. Line 37: `if (status === null || !status.reconciliation_open) return null`. `verdict` is never read.
- src/lib/ipc.ts:283-285: "no UI consumes this yet".
- The only non-test consumer of `ledgerStatus` is ReconciliationBanner.
- vault/write.rs:606-625: `write_concept` falls back to the legacy file-first `concept_write` + `shadow_write` when `concepts::write_concept` returns None. `shadow_write` is itself a no-op without a writer. The same pattern applies to `verify_concept` (write.rs:350) and `append_log` (write.rs:700).

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - I couldn't refute this. Every part of the claim holds in code, and I found nothing that guards it elsewhere.
- One nuance: status() does expose refused verdicts (foreign-writer, diverged, gap, fork, corrupt) through its `verdict` tag, because it re-runs classify live. But no UI reads that field, so nobody sees it.
- The case status truly cannot report is a verdict of valid/torn-tail/seal-pending/no-ledger where LedgerWriter::open fails, for example on a held lock. status says "valid" while this process has no writer.
- The refused cases are reachable. A missing ledger-writer-id makes writer_id() mint a new id, and classify then returns ForeignWriter, as it also does for a second Mac. A head older than the remembered one returns Diverged. In all of these, activate opens no writer, runs no launch_scan and writes no event. lib.rs throws the returned verdict away.
- The same silence covers knowledge writes. write_concept falls back to a legacy file-first write, and its comment says the refusal "is visible through ledger_status", which no UI surfaces.
- That legacy write later trips the forged-stamp refusal during a scan. This is plausibly how the Aug 17 edits bypassed the ledger, for example a second app instance (dev build plus installed build) that lost the lock. That is inference, not proven.
- Live check: the running target/debug/cerebro (PID 70308) holds the vault's ledger lock right now. So the live vault is not in silent legacy mode today. The gap is latent but reachable.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:9-10: the module doc says "What IS active is visible through `status`".
- src-tauri/src/ledger/shadow.rs:113-121: `LedgerWriter::open(&vault, &id).ok()` runs only for the recoverable verdicts; every other verdict gets `None`, and the open error is never logged.
- src-tauri/src/ledger/shadow.rs:127-150: launch_scan runs only when a writer exists.
- src-tauri/src/ledger/shadow.rs:367-408: status() calls classify() from disk and never reads active(); LedgerStatus has no field saying whether a writer is held.
- src-tauri/src/lib.rs:1478: `let _ = ledger::shadow::activate(&dir, &vault_path);` discards the verdict.
- src-tauri/src/ledger/writer.rs:201-226: writer_id mints a new id when the file is NotFound.
- src-tauri/src/ledger/recovery.rs:131-180: returns Diverged when the head regressed and ForeignWriter when a segment's writer id differs from ours.
- src-tauri/src/vault/write.rs:606-625: legacy file-first write_concept, whose comment says "the refusal is visible through ledger_status".
- src/app/ReconciliationBanner.tsx:43: renders only when `status.reconciliation_open` is true and never reads `verdict`.
- src/lib/ipc.ts:283-285: the doc comment says "no UI consumes this yet".
- grep: ledgerStatus has no other UI consumer outside ReconciliationBanner.tsx.
- Live: `lsof` shows /Users/joseflagorio/Documents/test/.cerebro/ledger/lock held by cerebro PID 70308 (target/debug/cerebro), so this process holds the writer now.

</details>

### F42 — Nothing ever reads the git ledger-head trailer, and two divergence signals are declared but never produced

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/git/useGit.ts:322-323`
  - `src-tauri/src/ledger/reconcile.rs:389`
  - `src-tauri/src/ledger/schema/reconciliation.rs:22-29`
  - `src-tauri/src/ledger/reconcile.rs:212-215`

**Evidence**

- Every autosync commit carries 'Cerebro-Ledger-Head: <hash>' (useGit.ts:323). Nothing in src/ or src-tauri/src parses it.
- git_anchored_head is hard-coded to None ('read at M23.7's exits'), and the exits never read it.
- DivergenceSignal::GitAnchorRegression and RememberedHeadRegression exist in the schema, but grep finds no producer outside schema/conformance.
- A 10-line shell scan of the live vault flags exactly the 5 bypass commits: they change knowledge/ while the trailer head stays at 619957fc, the same as the previous commit.

**Impact**

The cross-attestation that was built to catch this failure is write-only. The bypass happened on Aug 17 and was detectable at every commit, but surfaced only indirectly 7 minutes later, as a forgery refusal.

**Recommendation**

- At commit time (useGit) and at launch scan: if the staged or recent commits touch knowledge/ while the ledger head has not moved since the previous trailer, emit a bypass signal (or GitAnchorRegression).
- Otherwise, delete the unused signals and the trailer claim.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - **Confirmed, trailer is write-only.** Only `useGit.ts:323` writes 'Cerebro-Ledger-Head'. The other hits are the two unit tests in `useGit.test.ts`. No code in `src/` or `src-tauri/src` parses the trailer.
- **Confirmed, GitAnchorRegression is never produced.** `git_anchored_head` is hard-coded to `None` in `reconcile.rs:389` and in `index.rs:1038`. No non-test code pushes `DivergenceSignal::GitAnchorRegression`.
- **Wrong, remembered-head detection does run.** The `RememberedHeadRegression` enum variant is never emitted, but the check it describes is live. `shadow.rs:106-111` loads the remembered app-data head into `recovery::classify`. `recovery.rs:146-168` flags a regressed head (lower seq, or same seq with a different hash) as `Verdict::Diverged`, and the writer stays closed. The check goes through the startup verdict instead of a `ledger.divergence` signal. The accurate claim is that the enum label is unused, not that the check is missing.
- **Impact overstated.** The anchor was designed to catch a ledger REWIND (git trailer ahead of the ledger), per spec M23 §6 ("restore detection is best effort"). It was not built to catch writes that skip the ledger. In the Aug 17 commits the trailer head stays the same as the ledger head, which is exactly what a healthy anchor looks like. A GitAnchorRegression producer would NOT have fired. The flag the claimant's shell scan uses ("knowledge/ changed but the head did not move") is a different, new detector. It would also fire on ordinary out-of-band human edits, which the design expects and captures at the next scan. So "the cross-attestation built to catch this failure is write-only" is wrong. The missing piece is a separate detector for writes that bypass the ledger, not an unfinished anchor.
- **Data re-checked.** `git log` on the vault shows the 5 commits from 2026-08-17 04:51-04:57 -0700 all carry trailer 619957fc…, while earlier commits each carry a different head. That fact holds, but it is a heuristic signal, not an anchor regression.
- **Net:**
  - Dead trailer and a dead GitAnchorRegression producer: real, at low-to-medium hygiene level. The comment on the unimplemented exits is out of date.
  - RememberedHeadRegression: only the enum label is dead.
  - Having neither signal did not cause the Aug 17 incident, and adding them would not have caught it.

**Evidence checked.** - `src/git/useGit.ts:320-323`: `withLedgerTrailer` is the only non-test place 'Cerebro-Ledger-Head' appears (the other hits are `useGit.test.ts:43,74`).
- `src-tauri/src/ledger/reconcile.rs:389`: `git_anchored_head: None, // best-effort: read at M23.7's exits`. `src-tauri/src/ledger/index.rs:1038` also sets it to `None`.
- Production signal pushes exist only at `reconcile.rs:332`, `335` and `339` (ManifestReducerDisagreement, MassProjectionMismatch, migration) and at `shadow.rs:132,135` (migration). There is no push of GitAnchorRegression or RememberedHeadRegression outside `schema/reconciliation.rs` and `conformance.rs`.
- Remembered-head check: `src-tauri/src/ledger/shadow.rs:106-111` calls `classify(&dir, Some(&id), remembered.as_ref())`. At `src-tauri/src/ledger/recovery.rs:146-168`, `head < seen || (head == seen && hash !=)` returns `Verdict::Diverged` "a restore or rewrite landed". `shadow.rs:113-120`: for any verdict other than Valid/TornTail/SealPending/NoLedger the writer is `None`.
- Design intent: `docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:41` ("Restore detection is best effort. Git anchors, the remembered app-data…") and `:356`/`:365` (anchor REGRESSION = rollback).
- Vault check: `git log -- knowledge` shows e1770e4, e3543b4, 7658504, 1c8c9e9 and 812605a (2026-08-17 04:51-04:57 -0700) all with trailer 619957fc…. Earlier commits (bd6f0a8 50e28f…, e67bed2 63d404…) each carry a different head.

**Correction.** Only the Cerebro-Ledger-Head trailer and the GitAnchorRegression signal are dead. The trailer is written by useGit.ts:323 and never parsed, and git_anchored_head is always None (reconcile.rs:389, index.rs:1038). Remembered-head regression IS detected, by recovery::classify in recovery.rs:146-168 (called from shadow.rs:111). It returns Verdict::Diverged and the writer stays closed; only the RememberedHeadRegression enum label goes unused. The anchor was designed to detect ledger rollback, not writes that skip the ledger. In the Aug 17 bypass the trailer head is the same as the ledger head, so a GitAnchorRegression producer would not have fired. The "constant head while knowledge/ changes" check would be a new detector, and it would also flag ordinary out-of-band human edits.

</details>

### F43 — Rewind detection has gaps: the remembered head lags behind, an index refusal is silently rebuilt, and deleting the ledger silently starts a fresh baseline

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:320-341`
  - `src-tauri/src/ledger/shadow.rs:288-304`
  - `src-tauri/src/ledger/shadow.rs:155-163`
  - `src-tauri/src/ledger/recovery.rs:146-152`
  - `src-tauri/src/ledger/recovery.rs:109`
  - `src-tauri/src/ledger/shadow.rs:105-110`
  - `src-tauri/src/ledger/index.rs:264-295`

**Evidence**

- remember() runs only in record(). with_writer appends (beliefs, proposals, batches, captures) never update it. Old store 8e726…: at the seq-85 divergence, remembered_head = 9a9d… = seq 71 (the last vault.write) while the real head was seq 84, a lag of 13 events.
- classify only flags `head < seen || (head == seen && hash differs)`. It never checks that the remembered hash is an ancestor when head > seen, so a rewrite followed by further appends passes.
- Index::replay's 'history disagrees at cursor — diverged' refusal is handled by `Err(_) => index.rebuild(...)` (shadow.rs:162). That wipes the evidence and re-remembers the rewound head with no signal.
- The remembered head is looked up by the store id read from the vault's own store.json. If .cerebro/ledger is deleted: NoStore → NoLedger → a fresh store is minted and every current file, forged ones included, is migrated as the new baseline, with no signal. This is the obvious user workaround for the current stuck banner.

**Impact**

A backup restore or a ledger reset between checkpoints is undetected, and a 'rm -rf .cerebro' escape quietly re-baselines the vault, forgeries included.

**Recommendation**

- Call remember() after every with_writer closure.
- When head > seen, check read.frames[seen-1].hash == remembered.head_hash.
- Turn a replay refusal into a divergence signal before rebuilding.
- Remember the last store id per vault path (runtime.db vault_registry already keys by path) and flag a re-mint.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - All three gaps are real and reachable. I could not refute any of them. One detail in the claim is wrong.
- Wrong detail: the claim says remember() runs only in record(). Index::replay also writes the remembered head (store_id, head_seq, head_hash) into meta when the app activates. So the lag is not open-ended. It covers only the appends made through with_writer (beliefs, proposals, batches, captures) since the last activation. Each restart catches it up. The measured lag stands: in the old store's index (8e726…), the seq-85 ledger.divergence records remembered_head = 9a9d9a62… (seq 71, a vault.write). Seqs 72–84 are all proposal, belief and batch events written through with_writer.
- Ancestor gap: classify only flags `head < seen || (head == seen && hash differs)`. When head > seen it never checks that the frame at `seen` still has the remembered hash, even though read.frames is right there. A rewrite followed by more appends therefore passes as Valid. The lag widens this window: a restore landing anywhere between remembered_seq and the real head passes both classify and the replay cursor check, so the with_writer events it lost disappear with no signal.
- Index-refusal gap: Index::replay is documented as 'must never smooth over a divergence' and returns 'history disagrees… diverged'. shadow.rs catches that with `Err(_) => index.rebuild(...)`. rebuild deletes the files, replays from zero and remembers the new head. No verdict or event is recorded, so the only surviving anchor is overwritten.
- Deleted-ledger gap: activate looks up the remembered head through store::load on the vault's own ledger dir. A missing store.json gives Ok(None), so remembered is None and classify returns NoLedger. LedgerWriter::open mints a new store and arm migrates the current files as the baseline. Nothing checks for other stores' indexes this machine already holds in ledger-index/.
- Scope limit on that last point: the claim's impact says 'rm -rf .cerebro' (manifest also gone), which is a silent re-baseline. If only .cerebro/ledger is deleted, the stale manifest survives and the launch scan may still flag a mismatch. I did not trace that sub-case.
- The code's own docs (reconcile.rs:212-216) call detection 'best effort'. That excuses a coherent restore of ledger, manifest, files and anchors together. It does not excuse these three cheaper holes.
- Medium is the right severity: this is a gap in integrity detection, not active data loss.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:105-110: remembered is loaded via store::load(&dir), then Index::open(store_id), then remembered().
- src-tauri/src/ledger/shadow.rs:155-163: `Err(_) => index.rebuild(&read, &id).ok()`, commented 'A cache that refuses (diverged) is rebuilt from zero'.
- src-tauri/src/ledger/shadow.rs:288-304: with_writer never calls remember.
- src-tauri/src/ledger/shadow.rs:320-341: record() calls index.remember after an append.
- src-tauri/src/ledger/index.rs:264-295: replay refuses 'behind the index cursor' and 'history disagrees… at seq'.
- src-tauri/src/ledger/index.rs:~326-333: replay upserts meta store_id, writer_id, head_seq and head_hash. This is the part the claim missed.
- src-tauri/src/ledger/index.rs:347-355: rebuild removes the files and replays.
- src-tauri/src/ledger/recovery.rs:109: NoStore maps to Verdict::NoLedger.
- src-tauri/src/ledger/recovery.rs:146-152: the regressed check never tests ancestry when head > seen.
- src-tauri/src/ledger/store.rs:34-49: a missing store.json returns Ok(None).
- src-tauri/src/ledger/reconcile.rs:212-216: detection is documented as best effort.
- Data (read with sqlite3 -readonly, immutable) from ~/Library/Application Support/com.cerebro.app/ledger-index/8e726f10….sqlite:
  - seq 85 ledger.divergence has remembered_head = 9a9d9a62369a…
  - that hash is seq 71 (vault.write).
  - seqs 72–84 are proposal.submitted, belief.created, proposal.applied, batch.committed, belief.revised and belief.relation, all via with_writer.
  - the index meta head is now 85, consistent with replay remembering at activation.
- Live vault: store.json has store_id 30de3878…, created 2026-08-16T19:12Z, and its seq 1 is migration.started. I did not establish whether the older 8e726 store belonged to this same vault: inbox/kk.md is absent from the vault.

**Correction.** remember() is not called only from record(). Index::replay also writes the remembered head when the app activates, so the lag covers only the with_writer appends made since the last activation and resets on restart. The measured 13-event lag (seq 71 vs 84 at the seq-85 divergence) is accurate. The other two gaps hold exactly as stated. Deleting all of .cerebro silently re-baselines the vault. Deleting only .cerebro/ledger keeps a stale manifest that the launch scan may still flag, which I did not verify.

</details>

### F44 — The writer does not stop after a failed write or fsync, which can turn a recoverable torn tail into permanent corruption

- **Severity (claimed):** low
- **Category:** crash-safety
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/segment.rs:207-215`
  - `src-tauri/src/ledger/writer.rs:386-389`
  - `src-tauri/src/ledger/writer.rs:425-429`
  - `src-tauri/src/ledger/writer.rs:239-241`
  - `src-tauri/src/ledger/shadow.rs:325-329`

**Evidence**

- SegmentWriter::append does write_all. On a partial failure (ENOSPC/EIO), bytes are on disk but last_hash/next_seq are not advanced, and nothing poisons the writer.
- The only fail-stop is segment=None after a failed rotation (writer.rs:239).
- record() swallows the error, and the next save appends right after the partial bytes. That makes a terminated, malformed line in the middle of the file, which parse_segment treats as Corrupt, not Torn.
- Separately, write_frame advances head_seq/last_hash before sync(). A failed fsync returns Err, but the next append chains onto the frame the caller was told had failed.

**Impact**

One transient disk-full event during an editor autosave, which calls record() about once per keystroke burst (kk.md: 34 events in 60 s), can leave the ledger permanently Corrupt. Together with the silent no-writer fallback above, that means knowledge is recorded nowhere from then on.

**Recommendation**

- Poison the writer (segment=None) on any write or sync error so later appends fail loudly.
- Let the next open truncate the torn tail.
- Add an injected-IO-error test next to the killed_* crash tests.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - The write-failure half holds up. SegmentWriter::append only advances last_hash/next_seq after write_all succeeds. A short write followed by an error (ENOSPC/EIO) leaves partial bytes in an O_APPEND file with the writer state unchanged, and nothing poisons the writer. The only fail-stop is segment=None after a failed rotate().
- shadow::record swallows the Err (`if writer.append(..).is_ok()`), so the next save rebuilds a frame with the same seq/prev and appends it straight after the partial bytes. Result: one newline-terminated line of invalid JSON.
- parse_segment treats a terminated malformed line as Err ("malformed record at byte N"), not Tail::Torn. Only an unterminated final line is Torn.
- On the next launch, recovery::classify maps that to Verdict::Corrupt. LedgerWriter::open and shadow::activate refuse Corrupt, so writer=None and nothing is recorded after that. Corrupt is never auto-truncated.
- Nuance 1: the damage only shows at the next activate/restart. In-session appends keep going, and the whole post-failure session is then stranded behind the bad line.
- Nuance 2: ledger_status does surface the verdict, so it is not strictly silent.
- The fsync half is real but overstated as corruption. write_frame advances head_seq and the segment state before sync(). A failed sync_all returns Err, yet the frame bytes are in the file and chain-consistent, so later appends link validly. That is an acknowledgement-semantics breach (the caller was told the write failed, but the event persists or is chained upon). It is not a corruption path. Also, on some OSes a failed fsync can drop dirty pages, which could leave a real gap/torn state.
- Severity stays low: it needs a partial write failure on a local disk, which is rare. The live vault ledger (273 events) shows no sign this has happened, and it is unrelated to the divergence banner incident.

**Evidence checked.** - src-tauri/src/ledger/segment.rs:207-213: `self.file.write_all(line)...?; self.last_hash = frame.hash.clone(); self.next_seq += 1;` State only advances on full success. The file is opened with append(true) (segment.rs:167-169 in resume).
- segment.rs:325-345: only an unterminated line returns Tail::Torn.
- segment.rs:364-381: a terminated line that parses as neither Frame nor Seal returns `Err("malformed record at byte {pos}")`.
- writer.rs:239-241, 368, 396, 731-746: the only fail-stop is `segment.take()` in rotate(). No poisoning after an append/sync error.
- writer.rs:386-389 (write_frame): `segment.append(&frame)?; self.prev_wall_clock=...; self.head_seq = Some(frame.seq);` This happens before sync. writer.rs:425-429 (append): `write_frame(...)?; self.sync()?;`
- writer.rs:275-281 (open_with_limit): only Valid/TornTail/SealPending proceed; any other verdict (Corrupt) returns Err.
- recovery.rs:43-46, 123: SegmentCorrupt maps to Verdict::Corrupt, which is "surfaced, never silently truncated".
- shadow.rs:112-119 (activate): writer = LedgerWriter::open(..).ok() only on recoverable verdicts, `_ => None`.
- shadow.rs:311-329 (record): "A failed append is swallowed"; `if writer.append(kind, body).is_ok()`.

**Correction.** Confirmed for the write_all path: a partial write followed by a swallowed error and a retried append leaves a terminated malformed line mid-segment. The next launch classifies it as Corrupt, and shadow runs with writer=None (visible via ledger_status, not fully silent). The fsync half is an acknowledgement-semantics issue (a frame reported as failed still persists and is chained upon), not a corruption path in itself. The damage appears at the next restart, not immediately.

</details>

### F45 — ledger_status, documented as read-only, can delete and recreate the live index; the index's belief/entity tables are still written but never read

- **Severity (claimed):** low
- **Category:** complexity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:346-347`
  - `src-tauri/src/ledger/shadow.rs:372-376`
  - `src-tauri/src/ledger/index.rs:252-262`
  - `src-tauri/src/ledger/index.rs:334-337`
  - `shared/runtime/README.md:85-104`

**Evidence**

- status() is documented as 'Read-only: no minting, no index creation, no side effects', but it calls Index::open.
- Index::open runs PRAGMA quick_check. healthy() returns false on ANY error, and the index files (plus -wal/-shm) are then removed while Active holds an open connection to the same DB. It then sets WAL mode and runs CREATE TABLE DDL.
- The ~20 materialized belief/entity tables in the index (the 'epistemic tables') are fully rewritten on every activate. Per M31.7 they have zero production readers; M31.7 said 'If M32 has not given the epistemic tables a reader, delete the materialization.' M32 has shipped and they are still there.
- The live index (30de…sqlite) matches the NDJSON (head_seq 273, hash 9a551151…), so there is no staleness today.

**Impact**

A status poll can destroy the remembered-head anchor (the only regression detector) and race the active connection. Every launch pays for a full reduce plus a rewrite of tables nothing reads.

**Recommendation**

- Open the index read-only in status() (SQLITE_OPEN_READ_ONLY, no delete, no DDL), or read the meta head through Active.
- Delete the epistemic materialization as M31.7 planned.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - Both halves of the claim are real, in code that actually runs. The impact is overstated.
- ledger_status (lib.rs:1462) calls shadow::status. The doc comment at shadow.rs:344-346 says "Read-only: no minting, no index creation, no side effects". Yet status() calls Index::open (shadow.rs:376) whenever the index file exists.
- Index::open (index.rs:252-262) does three things:
  - if healthy() (quick_check == "ok") fails, it deletes the db plus its -wal and -shm files (remove_index_files, index.rs:822);
  - it then opens a read-write connection;
  - that connection sets journal_mode=WAL and runs CREATE TABLE IF NOT EXISTS DDL (open_connection, index.rs:43-51).
- So the "read-only" doc is false. Active still holds its own Index from activate (shadow.rs:157, then replace_active). If the delete happens, Active keeps writing to an unlinked inode, and status recreates an empty index with no remembered head.
- Where the impact is overstated:
  - It is not a poll. The only caller is ReconciliationBanner, which calls it on mount or vault change and after a resolve click (ReconciliationBanner.tsx:16-35).
  - The delete needs quick_check to fail. That is real corruption, or an error after rusqlite's default 5s busy timeout. In WAL mode an idle writer connection does not block a reader, so the race is theoretical, not routine.
  - On a healthy db the DDL and the WAL pragma are no-ops.
- Tables half, confirmed:
  - Index::replay runs a full reduce and materialize() rewrites all 18 EPISTEMIC_TABLES on every replay (index.rs:334-337), and activate replays on every launch.
  - The only reader is dump_epistemic, used only by tests (index.rs:1053/1073, soak.rs:83). No SELECT on those tables exists anywhere else in src-tauri.
  - shared/runtime/README.md:85-104 names this and says to delete the materialization if M32 gives the tables no reader. M32 and later milestones have shipped and the materialization is still there, so the condition has fired and nothing was done.
- Side note: status() also runs a full reduce() over all frames on every call (shadow.rs:385).

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:344-346: doc says "Read-only: no minting, no index creation, no side effects".
- src-tauri/src/ledger/shadow.rs:372-377: `if !path.exists() { return None; } let index = Index::open(config, &store.store_id).ok()?;`
- src-tauri/src/ledger/index.rs:241-246: healthy() returns true only when `PRAGMA quick_check` returns "ok".
- src-tauri/src/ledger/index.rs:252-262: `if path.exists() && !healthy(&path) { remove_index_files(&path)?; } let conn = open_connection(&path)?;`
- src-tauri/src/ledger/index.rs:43-51: open_connection runs pragma_update journal_mode WAL, then CREATE TABLE IF NOT EXISTS.
- src-tauri/src/ledger/index.rs:822-834: remove_index_files unlinks the db, -wal and -shm.
- src-tauri/src/ledger/shadow.rs:157-163: activate opens and replays the index, and Active keeps it.
- src-tauri/src/ledger/index.rs:334-337: `let state = reduce(...); materialize(&tx, &state)?;` runs on every replay.
- Readers: grep for `FROM beliefs|entities|...` outside index.rs finds nothing. dump_epistemic is used only in index.rs tests (1053, 1073) and soak.rs:83.
- shared/runtime/README.md:87-104: "Zero production readers ... If M32 has not given the epistemic tables a reader, delete the materialization."
- src/app/ReconciliationBanner.tsx:16-35: ledgerStatus is called on mount/vault change and after a resolve, not on an interval.

**Correction.** - The doc claim "Read-only, no side effects" on ledger_status is false. It opens the live index read-write and runs WAL and DDL setup. If quick_check fails, it deletes the index files and recreates them while Active holds an open connection. That would lose the remembered-head anchor and orphan Active's writes.
- This is not a periodic poll. It runs on banner mount or vault change and after a resolve, and it only deletes when quick_check fails (corruption, or a busy timeout of 5s or more). Real-world risk is low.
- The epistemic tables are fully re-materialized on every activate and have no production reader. The README's own M32 deletion condition has fired and has not been acted on.

</details>
