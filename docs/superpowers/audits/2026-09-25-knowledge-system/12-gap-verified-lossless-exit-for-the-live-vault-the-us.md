# Follow-up: Verified lossless exit for the live vault (the user's 'what do I do now')

> Audit lens `gap:Verified lossless exit for the live vault (the user's 'what do I do now')` · critic-directed follow-up auditor, each finding adversarially verified

## Summary

You can get out of reconciliation without losing anything, but the path is not what the buttons suggest. First re-write the 3 disputed concepts through the ledger, with the write_concept MCP tool while the writer is armed. Then 'Keep my files' refuses with 'nothing differs', and 'Restore recorded history' closes the mode without changing any file. Nothing closes the mode by itself. Four traps sit around that path. One Keep attempt that passes the forgery check but fails the byte-canonical check disables Keep for this divergence permanently. A Restore done before the repair re-arms exactly these 3 schema rechecks. Every re-open of the vault flips the writer between armed and dropped, and only `lsof` on the lock shows which state it is in. Neither exit unfreezes log.md.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F99 | high | yes | A lossless exit exists: re-write the 3 concepts through the ledger, check them, then click 'Restore recorded history' (a no-op for files) |
| F100 | high | yes | 'Keep my files' can never succeed for this divergence, and nothing closes the mode by itself |
| F101 | high | yes | One Keep that fails at the digest check disables Keep for this divergence permanently. Hand-reverting `generated` leads straight there |
| F102 | medium | yes | Confirmed: Restore re-arms schema rechecks on exactly these 3 concepts, and the stored attempts rows do not stop them |
| F103 | high | yes | Re-opening the vault flips the writer on and off rather than dropping it for good. Only lsof on the lock shows the real state |
| F104 | medium | yes | Restore keeps the seq-179 log.md override, and no code path can clear it. append_log keeps adding revisions that never reach the file |
| F105 | low | yes | Correction: the gcs-5 self-anchor was already in the ledger's version. The Aug 17 runs flipped it to arb-4 and back |

### F99 — A lossless exit exists: re-write the 3 concepts through the ledger, check them, then click 'Restore recorded history' (a no-op for files)

- **Severity (claimed):** high
- **Category:** recovery-runbook
- **Verification:** survived (confirmed/medium, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/concepts.rs:64-76`
  - `src-tauri/src/policy/commit.rs:1299-1321`
  - `src-tauri/src/ledger/manifest.rs:199-208`
  - `src-tauri/src/ledger/reconcile.rs:427-520`
  - `src-tauri/src/ledger/reduce.rs:4590`
  - `src-tauri/src/mcp.rs:2468-2503`
  - `src-tauri/src/ledger/concepts.rs:740-750`

**Evidence**

- Live check: 27 of 30 manifest entries match disk exactly (sha256).
- Only gcs-5 (e096…→b11f…), tx-6-changeover (d329…→14b6…) and tx-6-np (f951…→176c…) differ.
- log.md on disk = manifest = the seq-179 override's after_projection_hash (34e25ca2…).
- The set of knowledge .md files equals the 30 manifest keys, so Restore would delete nothing.
- pid 70308 holds `.cerebro/ledger/lock` (fd 6w) and the segment (fd 7w).
- With the writer armed, write_concept does not fall back: vault/write.rs:609-611 returns the ledger result.
- update_belief is MEDIUM risk, which auto-applies (policy.v3.json risk_ladder). None of the 3 is attested, so the HIGH floor for attested targets does not apply.
- Nothing in policy/ checks reconciliation_open.
- commit.rs:1319 writes the projection and advances the manifest. The path then classifies as Match (reconcile.rs:120-121).
- Restore then calls write_projection for all 30 paths. When the bytes are already on disk it only advances the manifest identity (manifest.rs:201-208), so no file bytes or mtimes change.
- Its F=M=R recheck passes. The unbatched resolution clears every divergence (reduce.rs:4590).

**Impact**

The only exit the user sees ('Restore') silently throws away the Aug 17 descriptions and stale_after dates. This order of steps keeps them, and it records them in the ledger under the agent's name rather than as human:owner.

**Recommendation**

Runbook. Each step lists what is kept (+) and what is lost (−).

0. Check the writer is armed: `lsof /Users/joseflagorio/Documents/test/.cerebro/ledger/lock` must list a `cerebro <pid> … w` line.
   - If the output is empty, quit `tauri dev` and relaunch. Never use Cmd+R.
   - Keep this checkout's src/ untouched until step 7.
   - (+) everything. (−) nothing.

1. Back up outside the vault: `cp -Rp ~/Documents/test/knowledge ~/Documents/test/.cerebro ~/cerebro-bak-0925/`.
   - `git -C ~/Documents/test status --porcelain knowledge` must print nothing.
   - Aug 16 bytes are in commit f7df8b4; Aug 17 bytes are in HEAD (last touched in e1770e4).
   - (+) both file versions, plus the only copy of the gitignored ledger and manifest. (−) nothing.

2. Settings → turn OFF 'Learn on its own'.
   - (+) all. Pauses rechecks and schedules.

3. Optional probe: click 'Keep my files'.
   - Armed: 'accept-current-files refused at knowledge/decisions/gcs-5-supervision-ratio.md: provenance forgery…'. This refusal happens before any append, so it is harmless.
   - 'no active ledger writer…' means the writer is dropped: go back to step 0.
   - Never hand-edit these files and retry Keep (see the op-key finding).

4. In the assistant panel, tell the agent: use ONLY the write_concept MCP tool, not Edit or Write. Re-write the 3 paths, passing type, title, description, about, tags, lifecycle: stable, sources, stale_after, and the body unchanged. Optionally restore about [[arb-4-disposition]] on gcs-5.
   - (+) description ×3, stale_after ×3 (2027-10-31; 2027-02-17 ×2), plus body, about, tags, sources, type and title, all as ledger revisions.
   - (−) The Aug 17 generated.at stamps: restamped to now, and still in git.
   - (−) The serde_yaml spelling: the frontmatter is re-rendered in canonical style, with description moved to the end.
   - Any omitted argument is destructive: lifecycle falls back to draft, type to Reference, and other omitted keys are removed (concepts.rs:745-748).

5. Verify each file matches the manifest:
   `python3 -c "import json,hashlib;r='/Users/joseflagorio/Documents/test/';m=json.load(open(r+'.cerebro/projection-manifest.json'))['entries'];[print(p,hashlib.sha256(open(r+p,'rb').read()).hexdigest()==e['content_hash'],e['write_state']) for p,e in sorted(m.items())]"`
   - Expect all True and complete.
   - The ledger tail should show proposal.applied / batch.committed / belief.revised for each path.
   - `lsof` should still show the lock.
   - A False means the write bypassed the ledger: relaunch and repeat step 4.

6. Click 'Keep my files'. Expect 'accept-current-files: nothing differs — resolve by restore instead'.
   - Harmless: it returns before appending anything.

7. Click 'Restore recorded history'.
   - (+) everything. No file is rewritten or deleted, and the banner clears.
   - (−) nothing.

8. Turn 'Learn on its own' back on.
   - No recheck re-arms: generated.at is newer than the Type docs, and the stale_after dates are in 2027.

What remains afterwards: log.md stays frozen (see the log-override finding).

Contrast, Restore only (skipping steps 4–6):
- Loses description ×3 and stale_after ×3 from the working tree (both recoverable from git HEAD or the backup).
- Re-arms 3 paid rechecks.
- If the writer is dropped when those rechecks run, the same divergence opens again.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - I tried to refute the claim and could not. The mechanism works as described, end to end.
- **The write is not blocked.** Only the capture path checks `reconciliation_open` (capture.rs:322/642/779/840/885). Nothing in policy/, writer.rs, concepts.rs or mcp.rs checks it, so write_concept still commits while the mode is open.
- **No escalation applies.** The rewrite produces an `update_belief` op (MEDIUM, `apply: auto` in policy.v3.json). There are no attestation events in the ledger, and the only other escalator (lineage fan-in above 5) should not trigger here.
- **The write overwrites the out-of-band bytes.** `project_applied` sees the manifest differs from the new projection and calls `write_projection`. That function does not compare disk to manifest before writing.
- **Restore then changes no file.**
  - Disk will equal the reducer's bytes for all 30 paths, so `write_projection` only advances the manifest identity.
  - The set of files equals `projection_paths`, so nothing is deleted.
  - The F=M=R recheck passes, and the resolution clears every divergence (reduce.rs:4590).
- **How small the loss actually is.** The diff between the manifest version and the files on disk (vault git) is frontmatter only:
  - a new `description` in all 3 files;
  - `stale_after` 2027-07-31 → 2027-10-31 (gcs-5), and a new `stale_after` of 2027-02-17 in the two tx-6 files;
  - a changed `generated` stamp and a YAML re-style;
  - no body change in any of the 3.
  So Restore would lose 3 descriptions and 3 `stale_after` values — useful, but small. That is why I lower the severity from high to medium.
- **Caveats the claim leaves out:**
  1. The call must run inside the running app process (pid 70308), which holds the writer. Any other process gets `None` from `with_writer` and falls back to the legacy file-first path (vault/write.rs:612+) — the same path that caused the Aug 17 bypass. The Aug 17 files are in serde_yaml block style, not the reducer's flow style, which fits a legacy write.
  2. The caller must pass every field again. If `lifecycle` is left out it defaults to `"draft"` (mcp.rs ~2495), which would quietly demote the concepts from `stable`.
  3. `generated.at` is re-stamped to the time of the rewrite, so the Aug 17 timestamps are not kept.
  4. Each MCP write adds another "**Update**" line to log.md (mcp.rs ~2540, through the ledger), which adds to the existing duplicate log lines.
- **Correction to the shared facts:** the `gcs-5` self-reference `[[gcs-5-supervision-ratio]]` was already in the Aug 16 manifest bytes (commit 1a42ee4). It was not introduced on Aug 17.

**Evidence checked.** - **The write reaches the ledger:**
  - concepts.rs:64-76 (`write_concept` goes through `shadow::with_writer`);
  - shadow.rs:294-306 (returns `None` in any process that does not hold the writer);
  - vault/write.rs:609-611 (returns the ledger result when a writer is active).
- **Reconciliation mode gates capture only:** `grep reconciliation_open` finds it only in capture.rs:322,642,779,840,885 and reconcile.rs. There are no hits in policy/, writer.rs, concepts.rs or mcp.rs.
- **The rewrite patch:** concepts.rs:642-750 (`revision_ops`). Relations come only from supersedes/refines/contradicts (concepts.rs:267-292), so `about` produces no relation op.
- **Policy:** policy.v3.json has `update_belief` base_risk MEDIUM, `risk_ladder` MEDIUM = auto, and escalators `target_has_attestation` and `lineage_fan_in > 5`. The ledger event kinds are: belief.created 30, belief.revised 28, proposal.* 29, vault.write 124, one projection.overridden, one ledger.divergence. There are no attestation events.
- **The projection write:** commit.rs:1299-1321 (`project_applied` calls `write_projection` when the manifest differs from the projection). manifest.rs:199-240: when the file already has the target bytes, only the manifest advances; otherwise the file is overwritten without comparing disk to manifest.
- **Restore:** reconcile.rs:427-520 regenerates all 30 paths, deletes only knowledge .md files outside `projection_paths`, rechecks bytes, then appends the resolution. reduce.rs:4590 clears `reconciliation_divergences`.
- **Live vault check (sha256 of disk vs manifest):**
  - 30 files on disk, equal to the 30 manifest keys; all entries `complete`.
  - Only gcs-5, tx-6-changeover and tx-6-np differ (e096→b11f, d329→14b6, f951→176c).
  - The ledger has only vault.write events after seq 180, all outside knowledge/.
  - `lsof`: cerebro pid 70308 holds `.cerebro/ledger/lock`.
- **The Aug 17 edits:** `git diff` from 1a42ee4, 3614cc0 and e67bed2 to HEAD shows frontmatter-only changes (description, stale_after, generated, YAML style). `lifecycle: stable` is on all 3 files.
- **MCP defaults:** mcp.rs ~2493-2500 (`lifecycle` defaults to `draft`; `generated` is stamped by the server with the current time). mcp.rs ~2538-2545 appends to the knowledge log on every write, and vault/write.rs:692-701 sends that append through the ledger.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** I could not refute that the exit can be reached. Every step holds in the live app and vault:
- **The ledger writer is armed.** pid 70308 is `target/debug/cerebro`, started Sep 25 19:57. It holds `.cerebro/ledger/lock` (6w) and the open segment (7w). So `vault::write::write_concept` takes the ledger-first path and does not fall back to the legacy one.
- **Nothing in the write path checks reconciliation.** `concepts::write_concept`, `shadow::with_writer`, `revision_ops`, `route`/`submit_proposal` and `policy/` never look at `reconciliation_open`. The only reconciliation gates are in `capture.rs`: automatic capture, not governed writes.
- **Policy lets the rewrite apply automatically.** `update_belief` is MEDIUM, and MEDIUM means `apply: auto`. The only escalators are `target_has_attestation` and `lineage_fan_in`. The live ledger has zero `belief.attested` events.
- **The commit overwrites the bytes on disk.** `project_applied` calls `manifest::write_projection`, which writes over whatever is there without comparing it to the manifest first. After that the path is Match.
- **Restore changes no files.** `resolve_restore_with` regenerates all 30 paths. `write_projection` skips the file write when the bytes already match. The F=M=R recheck then passes, and the unbatched resolution clears the divergence map.
- **The ledger code has not changed since Aug 14.** So the reducer's projection for the other 27 still equals the manifest, and those files are not rewritten either.
- **Restore deletes nothing.** I re-ran the check: 30 knowledge .md files equal the 30 manifest keys. Only the 3 named files differ from the manifest.
- **The MCP tool can carry all of the Aug 17 content.** The 3 files use only keys `tool_write_concept` accepts: type, title, description, about, tags, lifecycle, sources, stale_after. `generated` is stamped by the server. `about` is not one of the relation fields, so the self-reference does not trip `intended_relations`' self-link filter.

Where the claim overstates:
1. **Not byte-lossless.** `tool_write_concept` re-stamps `generated.at` to now. `append_knowledge_log` also runs once per call, so log.md gets 3 more "**Update**" lines on top of the duplicates it already has.
2. **Any content defect is copied too.** The agent has to copy each file faithfully, and a faithful copy keeps the gcs-5 self-referencing `about` unless the user fixes it on purpose.
3. **Only one route works.** The rewrite has to go through the in-app assistant's MCP `write_concept` while this writer is armed. An external Claude Code editing files directly would just recreate the divergence. That is likely how the Aug 17 bypass happened: `generated.by: claude-code`, zero ledger events, which matches the legacy no-writer path at `vault/write.rs:612+`.
4. **Untested live.** No `update_belief` revision has ever run on this vault; all 28 `belief.revised` events are knowledge-log appends. The revise path is supported by code and unit tests only.

**Evidence checked.** - `src-tauri/src/ledger/concepts.rs:64-76`: `write_concept` goes through `shadow::with_writer`. Neither checks reconciliation. `shadow.rs:294-306`
- `concepts.rs:325-379` (`write_concept_with`) → `route` → `commit::submit_proposal`. `concepts.rs:249-257`: the actor comes from `generated.by`.
- `concepts.rs:267-292`: only supersedes/refines/contradicts become relations; `about` stays a plain field.
- `grep reconcil` over `policy/*.rs`, `concepts.rs` and `writer.rs`: no hits. The gates live only in `capture.rs` (lines 322, 642, 779, 840, 885).
- `policy/commit.rs:1299-1321` (`project_applied`) rewrites only the paths whose manifest differs from the reducer.
- `ledger/manifest.rs:181-208`: `write_projection` skips the file write on identical bytes and never compares disk to the manifest before overwriting.
- `ledger/reconcile.rs:427-510`: `resolve_restore_with` regenerates, retains, deletes non-projections, rechecks bytes, then appends the unbatched resolution.
- `shared/policy/policy.v3.json`: `risk_ladder` has MEDIUM as auto. `update_belief` base_risk is MEDIUM. The escalators are only `target_has_attestation` and `lineage_fan_in`.
- `mcp.rs:2446-2503`: `tool_write_concept` stamps `generated {by, at: now_iso()}` and defaults lifecycle to draft. `mcp.rs:2541`: `append_knowledge_log` runs on every write.
- `vault/write.rs:609-611`: the ledger result is returned, with no fallback when the writer is active.
- Live: `lsof -p 70308` shows `.cerebro/ledger/lock` 6w and the segment 7w; the process started Sep 25 19:57:58.
- Live: 30 knowledge .md files equal the 30 manifest keys. DIFF only for gcs-5 (e096dab8→b11f52e0), tx-6-changeover (d3291abf→14b6aa9e) and tx-6-np (f9517aae→176c6cf3).
- Live: the manifest mtime is Aug 17 04:58:53 local, the seq-179 write, unchanged since.
- Live ledger event counts: 0 `belief.attested`; 28 `belief.revised`, all on the log belief 49e24332 (actor `system:knowledge-log`). No concept revision has ever run.
- `git log -- src-tauri/src/ledger/`: last change Aug 14 (da3bd37), so projection bytes are unchanged since the manifest was written.
- The frontmatter of all 3 files uses only keys the MCP tool accepts; `generated.by` is `claude-code`.

**Correction.** An exit that keeps the content exists and can be reached. It is not byte-lossless. Use the in-app assistant (MCP `write_concept`, writer armed by pid 70308) to rewrite the 3 concepts with their Aug 17 fields and body. The same field values are kept, but `generated.at` is re-stamped to now and log.md gets 3 more "Update" lines. The self-referencing `about` on gcs-5 carries over unless it is fixed during the rewrite. After that, 'Restore recorded history' writes no files and closes the mode. The rewrite must go through Cerebro's MCP. A direct file edit by an external agent recreates the divergence. Nothing on this vault has exercised the revise path yet; only unit tests cover it.

</details>

### F100 — 'Keep my files' can never succeed for this divergence, and nothing closes the mode by itself

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:599-606`
  - `src-tauri/src/ledger/reconcile.rs:256-285`
  - `src-tauri/src/ledger/reduce.rs:4590`
  - `src/app/ReconciliationBanner.tsx:50-65`

**Evidence**

- Keep diffs every path that is not a Match. A legacy-written file hits the forgery check and is refused (reconcile.rs:599-600).
- Once the files are repaired so that every path matches, `affected.is_empty()` returns 'accept-current-files: nothing differs — resolve by restore instead' (reconcile.rs:604-606).
- The mode closes only through reduce.rs:4590, which runs only on a `ledger.reconciliation_resolved` event.
- That event is appended only by resolve_restore_with (reconcile.rs:508) and resolve_accept_with (reconcile.rs:893).
- launch_scan with the mode open never resolves anything. Its finalize and regenerate recoveries are also skipped (`if !already_open` at reconcile.rs:268, 277).
- So a vault that matches the ledger on every path stays in reconciliation until a human clicks Restore.
- Detection keys play no part in resolving: the resolution names a divergence event id, and the reducer only checks that it is active (reduce.rs:4545-4553).

**Impact**

To keep their repaired files, the user has to click the button labelled as the destructive one. The mode also freezes crash recovery (pending and ledger-ahead entries) for as long as it stays open: 39 days here.

**Recommendation**

- Let Keep close the mode when there are zero diffs, or rename and split the exits by outcome.
- When every path matches, have launch_scan append the resolution itself. Restore already proves the same F=M=R condition before it writes.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Scan of the live vault:** 27 of 30 manifest paths match the files on disk. The 3 affected concept files differ. log.md matches, and no knowledge .md sits outside the manifest.
- **Ledger since the divergence:** events after seq 180 are 97 `vault.write` and 1 `projection.overridden` (seq 179 is just before it). No event touches beliefs, so manifest and reducer still agree on these paths. Keep therefore sends exactly these 3 files to `diff_projection_file`.
- **Refusal 1, forgery:** vault git shows `generated` changed on all 3 files (Aug 16 → Aug 17 timestamps). `diff_projection_file` refuses any change to `generated`, and one bad file stops the whole action.
- **Refusal 2, byte digest (a second blocker the claim missed):**
  - `resolve_accept_with` sets `resulting_projection_digest` to a hash of the raw file bytes.
  - The reducer (`apply_reconciliation_resolved`) recomputes that digest from its own canonical projection of each file and refuses on mismatch.
  - The Aug 17 files use block YAML (`- '[[x]]'`, a multi-line `generated:`). The canonical Aug 16 bytes used flow style.
  - So even with the stamps restored, the batch dies unless every byte is reformatted to canonical form.
  - Keep can therefore succeed only after that byte-exact hand repair, which makes "never" technically false but practically true.
- **Other points in the claim hold up:**
  - The "nothing differs → resolve by restore instead" error exists.
  - The mode is cleared only at reduce.rs:4590, and `reconciliation_resolved` is written only by the two resolve functions.
  - `launch_scan` skips finalize and regenerate recovery while the mode is open.
  - Neither banner button is marked as the destructive one. Both use identical styling.

**Evidence checked.** - **src-tauri/src/ledger/reconcile.rs:**
  - :255 `already_open`; :268 and :277 finalize/regenerate recovery gated on `!already_open`.
  - :596-606 in `resolve_accept_with`: Match paths are skipped, every other path goes to `capture::diff_projection_file(...)` with `.map_err(...)?`; an empty `affected` list returns "nothing differs — resolve by restore instead".
  - :850-887: `accepted_digest` is a hash over the raw bytes and is used as `resulting_projection_digest`.
  - :508/:888: the only two places that append `KIND_RECONCILIATION_RESOLVED` (restore and accept).
- **src-tauri/src/ledger/capture.rs:963-966:** `if key == "generated" || key == "verified" { return Err("provenance forgery: ...") }`
- **src-tauri/src/ledger/reduce.rs:**
  - :4543-4553: the resolution only has to name an active divergence event.
  - :4560-4586: the digest is recomputed from `projected_bytes` and refused on mismatch.
  - :4590: `reconciliation_divergences.clear()` is the only clear.
  - :471: `projected_bytes` is canonical output from `project::project`.
- **Live vault manifest scan** (/Users/joseflagorio/Documents/test/.cerebro/projection-manifest.json): only these 3 paths differ from disk — gcs-5-supervision-ratio.md, tx-6-changeover-transient-cross-channel-sync-disabled.md, tx-6-np-shared-j12-common-mode.md. log.md matches.
- **Ledger events at seq ≥175:** `{vault.write: 97, projection.overridden: 1, ledger.divergence: 1}`.
- **Vault `git diff 812605a~1 HEAD`:** in all 3 files, `generated: { by: claude-code, at: 2026-08-16T... }` became block-style `generated:\n  by: claude-code\n  at: 2026-08-17T11:5x`, and the about/tags lists changed from flow to block YAML. The agent also added `description:` and added or changed `stale_after`.
- **src/app/ReconciliationBanner.tsx:50-65:** both buttons have identical classes; neither is styled as destructive.

**Correction.** The mechanism is real, but "never" goes slightly too far. With the files as they are, "Keep my files" is refused twice over. First, the `generated` stamp changed on all 3 files, so it hits the forgery check. Second, even with the stamps put back, the reducer only accepts a resolution when the file bytes exactly match its canonical projection. The agent rewrote the frontmatter in block-style YAML, so the bytes no longer match. The only way Keep could pass is a hand-rewrite of all 3 files: original `generated` stamps back, and byte-identical canonical formatting. No user would realistically do that, and the UI gives no hint of it. Nothing else closes the mode. The reducer closes it only on a `ledger.reconciliation_resolved` event, and only the two resolve functions write one. So in practice "Restore recorded history" is the only exit, and it reverts the Aug 17 edits. Those edits still exist in vault git.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The mechanics hold. Accept runs diff_projection_file on every path that is not a Match. The first forged file refuses the whole action. An empty affected set also refuses ("nothing differs — resolve by restore instead").
- Only two code paths can close the mode: resolve_restore_with and resolve_accept_with. They are the only emitters of KIND_RECONCILIATION_RESOLVED, and the reducer clears reconciliation_divergences only on that event. launch_scan with the mode already open skips finalize, regenerate and capture. Nothing closes the mode by itself: confirmed.
- Live vault: only the 3 sample files differ from the manifest; the other 27 entries hash-match. All 3 carry a changed `generated:` stamp (claude-code, 2026-08-17T11:5x), so Accept fails on today's bytes: confirmed.
- Overstated: "can NEVER succeed". The forgery check fires only on the `generated`/`verified` keys (capture.rs:961-967). If the user hand-reverts just those stamps and keeps the body and relation edits, the files are still non-Match, the stamp no longer trips the check, and Accept can succeed. Other refusals (alias removal, ambiguous overlap) could still apply.
- Overstated: the impact. When every file already matches, Restore rewrites the same bytes and deletes nothing, because every file is in projection_paths. The concern is a mislabelled button, not data loss.
- On the live vault as it stands, Restore reverts only the 3 Aug 17 agent edits. Those edits carry defects: gcs-5's `about:` points at itself, and log.md has duplicate Update lines. The prior bytes are in vault git (1a42ee4, e67bed2). So the practical exit is low-loss.
- The crash-recovery freeze while the mode is open is real (reconcile.rs:277, 286). But the live manifest shows no pending entries, so for now it costs nothing.
- Severity is medium, not high: the design gap is real, but no data is lost in this incident.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:596-606 (L599-600 is the forgery path) — Accept diffs each non-Match path; one refusal kills the action; the empty affected set refuses.
- src-tauri/src/ledger/capture.rs:961-967 — forgery refusal fires only when the `generated`/`verified` key differs.
- src-tauri/src/ledger/reconcile.rs:256, 277, 286, 313 — `already_open` skips finalize, regenerate and capture.
- KIND_RECONCILIATION_RESOLVED is emitted only at reconcile.rs:509 (restore) and reconcile.rs:888 (accept). The reducer clears the mode only at reduce.rs:4590; reduce.rs:4545-4553 checks that the named divergence is active.
- reconcile.rs:436-484 — Restore regenerates every projection, deletes only knowledge .md files outside projection_paths, then checks the bytes. It is a no-op on files that already match.
- Live vault check (Python, manifest vs sha256 of files on disk):
  - Only 3 of 30 entries differ: decisions/gcs-5-supervision-ratio.md, risks/tx-6-changeover-transient-cross-channel-sync-disabled.md, risks/tx-6-np-shared-j12-common-mode.md. All are write_state complete; none are pending.
  - gcs-5 has `generated.at` 2026-08-17T11:52:02Z and `about:` includes [[gcs-5-supervision-ratio]].
  - Vault git has the prior versions at 1a42ee4 and e67bed2.

**Correction.** "Keep my files" cannot succeed on the vault's current bytes: all 3 differing files have a changed `generated` stamp, and one forged file refuses the whole action. It is not impossible in general. If the user restores the `generated` stamps to their recorded values and keeps the other edits, Keep can run. Nothing closes the mode automatically: only a human Restore or Accept emits reconciliation_resolved. If the files are fully repaired to match, Restore is byte-for-byte harmless, so the cost is a misleading "destructive" label, not data loss. On this vault, Restore reverts only the 3 defective Aug 17 agent edits, and those remain in vault git history.

</details>

### F101 — One Keep that fails at the digest check disables Keep for this divergence permanently. Hand-reverting `generated` leads straight there

- **Severity (claimed):** high
- **Category:** recovery-trap
- **Verification:** survived (partially_confirmed/medium, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:854-913`
  - `src-tauri/src/ledger/writer.rs:552-567`
  - `src-tauri/src/ledger/reduce.rs:977-995`
  - `src-tauri/src/ledger/reduce.rs:4559-4588`
  - `src-tauri/src/vault/write.rs:642-655`
  - `src-tauri/src/ledger/project.rs:6-12`

**Evidence**

Q4. Reverting only `generated` gets past the forgery check (capture.rs:961-967 compares JSON values). The adoption batch is then appended under op key `reconcile-accept-v1:{store}:{divergence_event}` (reconcile.rs:892-893).

The batch's resolution pins sha256 of the raw file bytes (reconcile.rs:854-870). The reducer recomputes projected_bytes, gets a different digest, and refuses the whole batch (reduce.rs:4583-4588, 977-995). The frames stay in the ledger.

The bytes cannot match, for two reasons:
- The legacy path writes serde_yaml spelling (write.rs:642-655): `- '[[x]]'` and block tags.
- project.rs renders `  - "[[x]]"`, `tags: [a, b]` and `{ by, at }`. `git diff f7df8b4 HEAD` shows exactly this for identical values.
- The new `description` key is also appended last by set_typed_at, while on disk it is line 4.

What a retry does:
- Same plan: replayed (writer.rs:557-560). Then 'the adoption resolution did not close the mode' (reconcile.rs:912-913).
- Changed plan: 'idempotency conflict' (writer.rs:562-565).

Today's Keep clicks refuse before appending anything, so Keep is not yet poisoned (no batch after seq 180).

**Impact**

A plausible manual fix leaves permanent refused human:owner frames in the ledger. Keep can then never work for this divergence, leaving Restore as the only exit.

**Recommendation**

- Tell the user not to hand-edit the disputed files and retry Keep.
- In code: check the canonical digest BEFORE append_batch, by staging a reduce. Also derive the op key from the plan digest, not only the divergence event.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The mechanism is real and every cited detail holds.** Hand-reverting `generated` gets past the forgery check, because capture.rs compares JSON values, not spelling. The adoption batch is then appended under op key `reconcile-accept-v1:{store}:{divergence_event}`.
- **The digests cannot match.** The resolution pins sha256 of the raw file bytes. The reducer's check recomputes `projected_bytes`, and that always renders through `project()` in canonical spelling. The live file uses serde_yaml spelling (`- '[[x]]'`, block `tags:`, block `generated:`), so the digest can never match. The member is refused, and so is the whole batch, but the frames stay on disk.
- **The key stays claimed.** The writer's idempotency claim depends only on the marker being structurally valid (ids match, frames contiguous, digest matches). It ignores the reducer's verdict, both in `rebuild_idempotency` and in the in-session insert. So the refused batch claims the op key for good.
- **Retries can't recover.** Retrying the same plan replays the claimed receipt. The `!committed && !receipt.replayed` guard is skipped, and the mode is still open, so you get "the adoption resolution did not close the mode". A changed plan hits "idempotency conflict".
- **Overstated in three ways:**
  - The deeper fact is that Keep can't succeed on these serde_yaml-spelled files anyway, poisoned or not. The first failure just makes that permanent and writes refused `human:owner` frames.
  - A lossless path exists if the user rewrites the frontmatter in canonical `project()` spelling before the first Keep.
  - "Permanently" is slightly too strong. The op key is taken from `reconciliation_divergences.values().next()` over a map keyed by detection key. A new divergence condition whose key sorts first would give a fresh op key. That is an edge case.
- Restore remains an exit throughout. The damage is losing Keep plus some permanent ledger noise, not data loss, so severity is medium rather than high.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:961-967: `generated`/`verified` are compared as JSON values, so reverting the value alone passes the forgery check.
- src-tauri/src/ledger/reconcile.rs:854-870: the `adopted` content_hash is sha256 of the raw file bytes.
- src-tauri/src/ledger/reconcile.rs:892-893: op_key = `reconcile-accept-v1:{store}:{divergence_event}`, passed to append_batch.
- src-tauri/src/ledger/reconcile.rs:899-913: the refusal check is skipped when `receipt.replayed`, then returns Err 'the adoption resolution did not close the mode'.
- src-tauri/src/ledger/reduce.rs:471-474: `projected_bytes` = `project::project(overlaid)`, always the canonical renderer.
- src-tauri/src/ledger/project.rs:6-12 and 51-70: wikilinks quoted, `tags: [a, b]` flow style, `{ by, at }` flow objects.
- src-tauri/src/ledger/reduce.rs:4559-4588: the digest is recomputed over `projected_bytes`; a mismatch returns Err refused.
- src-tauri/src/ledger/reduce.rs:~1050-1066: runs on a scratch clone; a refused member gives 'member N refused — whole batch has no effect'.
- src-tauri/src/ledger/writer.rs:854-918 (`rebuild_idempotency`): an op key is claimed whenever the marker's ids, contiguity and members_digest are valid, with no reducer verdict involved. The in-session insert is at writer.rs:716-723.
- src-tauri/src/ledger/writer.rs:556-566: same digest replays with `replayed = true`; a different digest gives 'idempotency conflict'.
- Live file /Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md is in serde_yaml spelling (`- '[[compass-gcs-5]]'`, block `tags:`, block `generated:`), which matches src-tauri/src/vault/write.rs:642-655 (serde_yaml `serialize_mapping`).
- src-tauri/src/ledger/reconcile.rs:538 uses `reconciliation_divergences.values().next()`; reduce.rs:4519-4531 keys that map by detection_key. This is the edge-case escape.

**Correction.** Accurate: once the adoption batch reaches the ledger and the reducer refuses it at the digest check, the writer still claims op key `reconcile-accept-v1:{store}:{divergence}`, because the claim depends only on marker validity. Every later Keep for that divergence then either replays and errors with 'did not close the mode', or errors with 'idempotency conflict'. Corrections:
- The digest refusal is not specific to hand-reverting `generated`. Any adoption of these serde_yaml-spelled files fails that check, because `projected_bytes` always renders in canonical `project()` spelling.
- Keep is therefore not a working exit for these files as written. It could only succeed if the user rewrote the frontmatter in canonical spelling before the first attempt.
- "Permanent" has a small edge-case escape: a new divergence whose detection key sorts first in the BTreeMap would change the op key.
- Restore stays available the whole time, so the harm is losing Keep plus refused frames left in the ledger. Medium severity, not high.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Refusal attempt failed.** Nothing checks the batch against the reducer before writing it. A batch the reducer refuses still claims its op key, and while reconciliation is open no new divergence id is minted, so the key never changes.
- **Hand-reverting `generated` is enough to get past the forgery check.** capture.rs:961-967 compares parsed JSON, so a correct `{by, at}` value passes whatever its spelling. The vault git diff shows `generated` changed only its value and layout: flow on Aug 16, block on Aug 17. `verified` did not change. No other refusal fires before the append.
- **The digest mismatch is certain for these files.** The resolution pins sha256 of the raw file bytes (reconcile.rs:854-870). The reducer recomputes the hash from `project()` (reduce.rs:471-474, 4572-4588). The files on disk use serde_yaml spelling: `- '[[x]]'`, block `tags:` and block `sources`. `project()` renders `"[[x]]"`, `tags: [..]` and flow `{by, at}`.
- **Nothing preflights the reducer.** `append_batch_planned` checks only schema decode and `validate()` before it writes (writer.rs:606-645), then writes the members, the marker and fsync. The reducer's `commit_batch` then refuses the whole batch (reduce.rs:977+).
- **The op key is poisoned.** `rebuild_idempotency` claims the op key from any structurally valid marker and ignores the reducer's verdict (writer.rs:846-915). A retry with the same plan replays: `receipt.replayed` skips the committed check, then "did not close the mode" (reconcile.rs:902-913). A changed plan hits "idempotency conflict" (writer.rs:556-566).
- **The key stays fixed.** It is `reconcile-accept-v1:{store}:{divergence_event}`. With the mode open, `launch_scan` skips capture and puts out-of-band paths in neither the divergent list nor the signals (reconcile.rs:306-320), so no new divergence id appears.
- **Small overstatement.** A new divergence can still be recorded while the mode is open if some path classifies as a hard `Divergence`, such as an unparsable or missing file. `.values().next()` might then choose the new event id. That escape is contrived, so "effectively permanent" is fair.
- **Amplification the claim missed.** `resolve_accept_with` always stages a `source-register-v1:{store}:{source_id}` member (reconcile.rs:614-618). The live ledger has no `source.registered` event, so this batch would carry one. Once refused, `rebuild_idempotency` claims that member key too, but the reducer never registers the source. After that, every human-assertion capture (capture.rs:393) and every Authored ingest (ingest/source.rs:99) stages the same registration. The writer rejects each one as "already committed — stage only what does not exist" (writer.rs:622-628). This survives Restore, so the damage reaches past Keep.
- **Test gap.** The happy-path test (reconcile.rs:1585) only uses files already in projection spelling, so this path is untested.

**Evidence checked.** - **Adoption batch and its key:** reconcile.rs:854-870 hashes raw bytes; :892-893 builds the op key `reconcile-accept-v1:{store}:{divergence_event}`; :899-913 lets a replayed receipt skip the committed check and then return "the adoption resolution did not close the mode".
- **Registration always staged:** reconcile.rs:614-618.
- **No new divergence while open:** reconcile.rs:256 sets `already_open`, and capture is gated on `!already_open` at :306-320; signals come only from the divergent list, mass or migration at :323-336.
- **Writer:** writer.rs:556-566 replays or returns an idempotency conflict; :606-645 checks only decode and `validate()`, with no reducer preflight; :846-915 `rebuild_idempotency` claims op and member keys from any structurally valid marker, refused or not; :622-628 rejects a member key that is already claimed.
- **Reducer:** reduce.rs:471-474 `projected_bytes` = `project(overlaid)`; :4559-4588 digest refusal; :977+ `commit_batch` refuses the whole batch.
- **Forgery check:** capture.rs:927-1000 `diff_projection_file` compares JSON values (:961-967) and never checks that the raw bytes reproduce.
- **Registration reuse:** capture.rs:205-245 `resolve_registration` stages the keyed registration whenever the source is missing from reducer state.
- **Live vault:** `git diff 90437f4 HEAD` on the 3 files shows `"[[x]]"` → `'[[x]]'`, `tags: [..]` → block, `generated: { by, at }` → block with a new `at`, and `description` inserted at line 4. The ledger kinds are vault.write 124, belief.created 30, proposal.* 29/29, batch.committed 29, belief.revised 28, projection.overridden 1, ledger.divergence 1. There are zero `source.registered` events and no reconcile batch yet.

</details>

### F102 — Confirmed: Restore re-arms schema rechecks on exactly these 3 concepts, and the stored attempts rows do not stop them

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/engine/jobs.ts:167-196`
  - `src/agent/useJobRunner.ts:206`
  - `src/pages/SettingsPage.tsx:232-237`

**Evidence**

- The runKey is `max(concept mtime, newest Type-doc mtime)`, where a Type doc only counts when its mtime is later than the concept's `generated.at` (jobs.ts:175-189).
- runtime.db job_ledger holds attempts rows for exactly the 3 paths with run_key 2026-08-17T11:50:01Z. That is types/decision.md's mtime.
- gcs-5 is anchored to itself, typed Decision. Both tx-6 concepts reach Decision through [[frb-118-session-1-disposition]].
- Today: generated.at (11:52–11:57Z) is later than every Type doc, so nothing is eligible. A scan of all 29 concepts found no eligible concept.
- After Restore, generated.at goes back to Aug 16 (19:38 / 20:00 / 20:00Z), which is earlier than 11:50:01Z. The runKey becomes the restored file's new mtime, which differs from the stored 11:50:01Z, so the job queues (jobs.ts:193).
- The gate is autoLearn, on by default (useJobRunner.ts:206).
- The repair path in the runbook does not re-arm anything: its generated.at is now.

**Impact**

Restore alone triggers 3 unattended, paid LLM rewrites of the same concepts, with random results (the Aug 17 runs flipped about: back and forth). If the writer happens to be dropped when they run, the same forgery divergence opens again.

**Recommendation**

- Turn off 'Learn on its own' before any Restore. Better: do the repair first, as in the runbook.
- In code: key the schema lane on the Type-doc mtime alone, or stop letting a restore reset generated.at to a date before the trigger.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Mechanism is real and reachable. jobs.ts:171-196 makes a concept eligible when a Type doc's mtime is later than `generated.at`. The runKey is max(typeDoc mtime, concept mtime). The job is skipped only when attempts[path] === runKey.
- Restore rewrites these files. resolve_restore_with (reconcile.rs:443-446) calls write_projection for every projection. The 3 files differ from the projection bytes, so write_projection (manifest.rs:200-214) does a real write and the file mtime becomes the restore time.
- The restored bytes are the Aug 16 git versions. Their SHA-256 matches the manifest content_hash. Their generated.at values are 2026-08-16T19:38:29Z, 20:00:24Z and 20:00:42Z. All are earlier than types/decision.md's mtime of 2026-08-17T11:50:01Z.
- Anchors check out:
  - gcs-5's Aug 16 `about:` already includes [[gcs-5-supervision-ratio]], a self-reference typed Decision. So the incident fact that the self-reference first appeared on Aug 17 is wrong, but the claim still holds.
  - Both tx-6 concepts reach Decision through [[frb-118-session-1-disposition]].
  - The other anchors are typed Reference, and there is no types/reference.md.
- After Restore the runKey is the new mtime, not the stored 2026-08-17T11:50:01Z (job_ledger rows for vault 5171… = /Users/joseflagorio/Documents/test), so all 3 jobs queue.
- Today the files' generated.at (Aug 17 11:52–11:57Z) is later than both Type docs, so nothing is eligible. A rough scan of all knowledge/ concepts found no other eligible concept.
- The gate is `autoLearn` (useJobRunner.ts:206), which defaults to 'true' (uiStore.ts:887). The user's actual localStorage value is unknown.
- The job_ledger rows with run_key 11:50:01Z show that this same schema-recheck path already ran on these 3 concepts on Aug 17. That is very likely the origin of the out-of-band edits.
- Caveats on impact:
  - The runs happen once each: a ledgered rewrite stamps a new generated.at, which stops further rechecks.
  - "Random results" and "divergence reopens if the writer is dropped" are speculative. They depend on the write path the agent uses, which I did not verify.
  - The user may have turned autoLearn off.
- Severity medium stands.

**Evidence checked.** - **src/engine/jobs.ts:171-196:** eligibility is `doc.modifiedAt <= generatedAt → skip`. The runKey is newestTypeChange when that is later than the concept mtime, otherwise the concept mtime. The job is skipped only if `attempts[path] === runKey`.
- **src/agent/useJobRunner.ts:206:** `if (!autoLearn || ...) return null`.
- **src/stores/uiStore.ts:887:** `autoLearn: loadString(AUTO_LEARN_KEY, 'true') === 'true'`.
- **src-tauri/src/ledger/reconcile.rs:443-446:** restore calls write_projection for every projection path.
- **manifest.rs:200-214:** a file is left untouched only when its bytes are identical to the projection; otherwise it is rewritten.
- **Type doc mtimes** (stat, local PDT converted to UTC): types/decision.md = 2026-08-17T11:50:01Z and types/risk.md = 11:49:06Z.
- **runtime.db job_ledger** (vault 5171d169… = /Users/joseflagorio/Documents/test): `attempts` rows for knowledge/decisions/gcs-5-supervision-ratio.md and both knowledge/risks/tx-6-*.md, each with run_key 2026-08-17T11:50:01Z.
- **Restore target bytes:** the vault git versions 1a42ee4, 3614cc0 and e67bed2 have sha256 values that appear in .cerebro/projection-manifest.json. Their `generated.at` values are 2026-08-16T19:38:29Z, 20:00:24Z and 20:00:42Z.
- **gcs-5 `about:`** at 1a42ee4 is [[compass-gcs-5]] (Reference) and [[gcs-5-supervision-ratio]] (Decision).
- **tx-6 `about:`** includes [[frb-118-session-1-disposition]], which is typed Decision (knowledge/decisions/frb-118-session-1-disposition.md).
- **Current files:** generated.at is 2026-08-17T11:52:02Z, 11:54:42Z and 11:57:37Z, all later than both Type doc mtimes, so none is eligible today.

</details>

### F103 — Re-opening the vault flips the writer on and off rather than dropping it for good. Only lsof on the lock shows the real state

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src/App.tsx:290-305`
  - `src/stores/vaultStore.ts:117-123`
  - `src-tauri/src/lib.rs:1466-1478`
  - `src-tauri/src/ledger/shadow.rs:112-118`
  - `src-tauri/src/ledger/shadow.rs:169-175`
  - `src-tauri/src/ledger/writer.rs:955-969`
  - `src-tauri/src/lib.rs:922-925`

**Evidence**

Q5, confirmed. The chain on every re-open:
- A page load runs the App effect, which calls openVault(last) (App.tsx:298).
- openVault calls ipc.startWatcher (vaultStore.ts:123), which calls shadow::activate (lib.rs:1478).
- activate calls LedgerWriter::open while the old Active still holds the flock. The new descriptor's try_lock returns WouldBlock, because flock is per open file description (writer.rs:955-969). The `.ok()` turns that into None (shadow.rs:118).
- replace_active then drops the old writer and its lock fd (shadow.rs:169-175).

The drop is not permanent: on the next re-open the lock is free, so the writer re-arms and the launch scan runs again. The armed state flips with each re-open.

What triggers re-opens:
- StrictMode (main.tsx:7) is neutralised by the `cancelled` guard, so a cold start opens once.
- Cmd+R, a Vite full reload, or (inferred) a Fast Refresh edit to App.tsx each re-open. Fast Refresh re-runs effects that have dependencies.
- pid 70308's cwd is /Users/joseflagorio/Development/cerebro/src-tauri under `tauri dev`: the same checkout that other agents are editing.

How to tell:
- `lsof /Users/joseflagorio/Documents/test/.cerebro/ledger/lock` lists `cerebro 70308 … 6w` now. Empty output means dropped.
- In the app, either banner button shows 'no active ledger writer for this vault — reconciliation is unavailable' (lib.rs:923-925, banner line 67).
- ledger_status still reports `valid` either way.

**Impact**

Any runbook step taken after a reload can silently fall back to the file-only path. write_concept then writes another forged file, and the next armed launch scan parks it or escalates it. The earlier findings' claim 'dropped for the rest of the process' is inaccurate: a second reload re-arms the writer, which hides the problem further.

**Recommendation**

- For the user: check the lock with `lsof` before steps 4 and 7, and relaunch the whole process rather than reloading.
- In code: make activate for an already-active vault a no-op that keeps the writer. Also expose `writer_armed` in ledger_status.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real, and I read it end to end. `start_watcher` calls `shadow::activate` on every `openVault`, with no check for "this vault is already active".
- `activate` calls `LedgerWriter::open`, which opens a new descriptor for `<ledger>/lock` and calls `try_lock`. That is BSD flock, which applies per open file description, so the process's own existing writer blocks it and `.ok()` turns the result into `None`. The writer's own test proves the refusal happens inside one process.
- With the writer `None`, the arm and `launch_scan` steps are skipped. `replace_active` then overwrites the slot with `writer: None`, which drops the old `LedgerWriter` and its `_lock` File, and that releases the flock.
- On the next `openVault` the lock is free, so the writer opens, arms and runs the launch scan again. The state flips with each re-open.
- `with_writer` returns `None` while the writer is dropped. Its callers "keep legacy file-first behavior", so knowledge writes go around the ledger.
- `ledger_status` classifies from disk only (`recovery::classify` plus reduce). It has no field for whether a writer is armed, so it reports `valid` either way.
- Re-open triggers are real:
  - App.tsx:298 runs on every page load.
  - App.tsx:158/163 and SettingsPage.tsx:100 re-open when a vault is picked again.
  - StrictMode is neutralised by the `cancelled` guard.
- Live check: `lsof` right now shows `cerebro 70308 6w` on the lock, so the writer is currently armed. That fits the claim, but does not prove any drop happened in the past.
- Small overstatement: lsof is not the ONLY signal. The claim itself names a second one: `resolve_reconciliation` returns "no active ledger writer" when either banner button is clicked. It is still true that no passive status surface shows the state.
- Severity high: the drop is silent and quietly turns the knowledge write paths back to file-first. Under `tauri dev` with HMR it happens easily. This also plausibly explains how the Aug 17 agent edits got past the ledger, though I did not verify that link.

**Evidence checked.** - src-tauri/src/lib.rs:1467-1478: `start_watcher` makes an unconditional `let _ = ledger::shadow::activate(&dir, &vault_path)`.
- src-tauri/src/ledger/shadow.rs:112-119: `LedgerWriter::open(&vault, &id).ok()`. The comment there says "A held lock (second instance) lands in the None arm".
- src-tauri/src/ledger/shadow.rs:167-173 and 274-278: `replace_active` does `*guard = Some(next)`, which drops the previous Active and its writer.
- src-tauri/src/ledger/writer.rs:235-236: `_lock: std::fs::File`, with the comment "the flock rides the descriptor".
- src-tauri/src/ledger/writer.rs:955-969: `acquire_lock` opens a new File and calls `try_lock`; `WouldBlock` becomes Err("another Cerebro instance...").
- src-tauri/src/ledger/writer.rs:1087-1096: the test `the_lock_admits_exactly_one_writer` shows a second open in the same process is refused while the first lives, and succeeds after `drop(first)`.
- src-tauri/src/ledger/shadow.rs:289-299: `with_writer` returns None when there is no writer; its callers keep legacy file-first behavior.
- src-tauri/src/ledger/shadow.rs:367-405: `status()` is built from `classify` plus `reduce` on disk and has no writer-armed field.
- src-tauri/src/lib.rs:922-925: returns the "no active ledger writer" error.
- src/App.tsx:290-307 is the boot effect; src/stores/vaultStore.ts:117-123 is where `openVault` calls `ipc.startWatcher`; src/App.tsx:158,163 and src/pages/SettingsPage.tsx:100 are the other `openVault` callers.
- Live: `lsof .../Documents/test/.cerebro/ledger/lock` returns "cerebro 70308 ... 6w REG", so the writer is currently armed.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - I could not refute it. The toggle follows from the code, and a unit test proves the same-process lock conflict.
- `activate` runs its steps in this order: writer_id, classify, then `LedgerWriter::open` (which calls `acquire_lock` first). Only after all that does `replace_active` drop the old Active. So the old writer's flock is still held when the new fd tries to lock.
- flock is per open file description, so a second open in the same process gets WouldBlock. `writer.rs` `the_lock_admits_exactly_one_writer` shows this: two opens in one process, the second fails with "another Cerebro".
- `.ok()` turns that failure into None. With writer=None, launch_scan and the index are skipped. `replace_active` then drops the old writer, which frees the lock. The next re-open finds the lock free and re-arms. So the state flips on each re-open, as claimed.
- Re-opens are reachable in the real app:
  - App.tsx:298 runs on page reload (Cmd+R, a Vite full reload, or Fast Refresh, which ignores effect deps).
  - The live process is pid 70308, `target/debug/cerebro` (tauri dev), started 2026-09-25 19:57.
  - Beyond the claim: SettingsPage.tsx:100 changeVault and App.tsx:163 chooseFolder can re-pick the same vault. That makes it reachable in release builds too, not only in dev.
- The impact is real:
  - vault/write.rs:600-625: with no writer, `write_concept` takes the legacy file-first path. Its `shadow_write`/`record` is a no-op with no writer, so a concept file is written with a `generated` stamp and zero ledger events.
  - That is exactly the Aug 17 signature: autosync commits carrying the same Cerebro-Ledger-Head, followed by a forged-provenance refusal at the next armed launch scan. This makes the toggle a strong candidate root cause for the incident itself, not just a hazard for the runbook.
- Wrong detail: "only lsof shows the real state" goes too far.
  - The banner buttons (lib.rs:923-925) and MCP commit_proposals (mcp.rs ~1737) both return explicit "no active ledger writer" errors.
  - What is true: `ledger_status` (shadow.rs:367-408) reads only from disk and never reports whether the writer is present. So the passive status surface cannot tell you, and lsof is the only non-destructive external check.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:77-176: `activate` computes the verdict, then `LedgerWriter::open(&vault,&id).ok()` (L116-118) while the old Active is still installed. `replace_active` (L169, fn at L274-278) runs `*guard = Some(next)` and drops the old writer and its lock only after that.
- src-tauri/src/ledger/writer.rs:258-265: `open` calls `acquire_lock` first.
- writer.rs:955-969: `try_lock` maps WouldBlock to Err.
- writer.rs:1087-1097: test `the_lock_admits_exactly_one_writer`. A second open in the same process is refused while the first lives and succeeds after drop.
- src-tauri/src/lib.rs:1466-1478: `start_watcher` calls `shadow::activate` on every call, with no same-vault short-circuit.
- src/stores/vaultStore.ts:117-123: `openVault` calls `ipc.startWatcher`.
- `openVault` call sites:
  - src/App.tsx:290-305 (boot effect, deps [openVault], cancelled guard)
  - App.tsx:158, 163
  - src/pages/SettingsPage.tsx:100 (change vault; can re-pick the same one)
- src-tauri/src/vault/write.rs:600-625: legacy file-first `write_concept` when `ledger::concepts::write_concept` returns None (no writer), then `shadow_write`/`record`, a no-op without a writer.
- shadow.rs:367-408: `status()` classifies from disk only and carries no writer-present field.
- lib.rs:922-925: `resolve_reconciliation` returns "no active ledger writer for this vault — reconciliation is unavailable".
- mcp.rs:1717-1737: commit_proposals returns a similar error.
- Live checks:
  - `lsof .../Documents/test/.cerebro/ledger/lock` shows `cerebro 70308 ... 6w` (currently armed).
  - `ps` shows 70308 = target/debug/cerebro, started Fri Sep 25 19:57:58 2026.

**Correction.** The mechanism and reachability are confirmed. Two changes to the claim:
- "Only lsof shows the real state" is wrong. The banner buttons and MCP commit_proposals both give explicit "no active ledger writer" errors. What is true is that `ledger_status`, the passive status surface, never exposes whether the writer is present.
- Re-picking the same vault in Settings (SettingsPage.tsx:100) also triggers the toggle, so it is not limited to dev reloads.

</details>

### F104 — Restore keeps the seq-179 log.md override, and no code path can clear it. append_log keeps adding revisions that never reach the file

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/reduce.rs:457-467`
  - `src-tauri/src/ledger/reduce.rs:3970-3974`
  - `src-tauri/src/ledger/reduce.rs:4360-4363`
  - `src-tauri/src/ledger/concepts.rs:806-866`
  - `src-tauri/src/ledger/schema/projection.rs:61-70`

**Evidence**

Q2.
- seq 179 is `change: {action: set, patch: [/body …]}`. It replaces the whole body.
- Restore projects through overlaid(), which applies every active override (reduce.rs:462-465). A /body op always replaces the content (reduce.rs:4360-4363).
- The log.md on disk already hashes to the override's after_projection_hash (34e25ca2…), so Restore rewrites nothing here and nothing conflicts.
- After Restore, append_log_with appends belief.revised on the underlying content (concepts.rs:825-845). A revision only marks the override `stale = true` (reduce.rs:3972-3974); overlaid() ignores that flag, so the file bytes never change.
- OverrideChange::Clear exists in the schema, but no production code emits it. grep finds it only in schema, tests, conformance and the reducer.

**Impact**

Neither exit brings back the knowledge log. Every future concept write adds a revision nobody can see, so the log belief drifts further from log.md. If anything ever clears the override, all the hidden entries reappear at once. This sharpens earlier findings #12 and #32.

**Recommendation**

- Add a Clear producer, for example an 'Unfreeze log' action.
- Or make capture treat log.md as system-owned, so it is never recorded as a human override.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Every step of the claim checks out in the code and in the live ledger.
- seq 179 is a `/body` Set override on the log.md belief (49e24332…). It carries `supersedes_override_event_ids: []`, and its after_projection_hash 34e25ca2… matches the sha256 of log.md on disk today.
- Restore (`resolve_restore_with`) regenerates through `project_belief` → `projected_bytes` → `overlaid()`. That applies every override in `belief.overrides` and ignores the `stale` flag. For log.md it rewrites the same bytes, so the override survives Restore.
- `append_log_with` appends `belief.revised` on the underlying `current.content`. The reducer then only sets `stale = true` on the overrides. `apply_overlay_op` replaces the content outright for `/body`, so a new log entry never reaches the projected file.
- `OverrideChange::Clear` is emitted only in reduce.rs (the match arm), conformance.rs, schema/tests.rs and schema/projection.rs. No production code constructs it: not IPC, not MCP, not TS.
- Every producer of `OverrideChange::Set` passes `supersedes_override_event_ids: vec![]`:
  - capture.rs:704
  - reconcile.rs:649 (the Accept path)
  - index.rs:1017
- So overrides only stack and never go away.
- `stale_overrides` is only surfaced as a status list (reduce.rs:4697, reduce.ts:3102). Nothing acts on it.
- Nuances, which don't overturn the claim:
  - Hidden revisions accumulate only once writes resume. After seq 179 the live ledger has zero log.md revisions: seq 180–273 are only 93 `vault.write` events plus the divergence.
  - A later hand edit of log.md reaches the file only by stacking another `/body` override. The belief still drifts.
  - The seq-179 override is attributed to `human:owner`. The content actually came from the Claude agent's out-of-band edit.
- Medium severity is appropriate: this is silent loss of the knowledge-log's visibility, not data corruption of the concepts themselves.

**Evidence checked.** - src-tauri/src/ledger/reduce.rs:457-467: `overlaid()` applies all overrides and never reads `stale`.
- reduce.rs:583-588: `project_belief` → `projected_bytes`.
- reduce.rs:3970-3974: a revision only sets `override_state.stale = true`.
- reduce.rs:4356-4363: a `/body` op does `*content = value.clone()`.
- reduce.rs:4474: the Clear arm, the only non-test/schema reference to Clear.
- `grep -rln OverrideChange::Clear src-tauri/src` returns only reduce.rs, conformance.rs, schema/tests.rs, schema/projection.rs.
- Set producers, all with `supersedes_override_event_ids: vec![]`:
  - capture.rs:704
  - reconcile.rs:649
  - index.rs:1017
- reconcile.rs:427-475: `resolve_restore_with` rewrites every projection via `project_belief`. It never touches overrides.
- concepts.rs:800-850: `append_log_with` revises `current.content` with a `/body` PatchOp.
- Live ledger, log.md belief 49e24332…:
  - seq 12 created; revisions from seq 17 through 171 (the last on 2026-08-16T20:01Z).
  - seq 179 `projection.overridden`: `change.action=set`, `patch=['/body']`, `supersedes=[]`, after_projection_hash=34e25ca27c4e20a2…
  - sha256(knowledge/log.md) = 34e25ca27c4e20a215062052725f46927a75c522314a83c02ae494e3d0899468.
  - Events after seq 179: 93× `vault.write`, 1× `ledger.divergence`, no further log.md revisions.

</details>

### F105 — Correction: the gcs-5 self-anchor was already in the ledger's version. The Aug 17 runs flipped it to arb-4 and back

- **Severity (claimed):** low
- **Category:** data-quality
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `/Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md:5-7`

**Evidence**

- `git show f7df8b4` (the Aug 16 bytes matching manifest hash e096dab8…) already has `about: "[[compass-gcs-5]]", "[[gcs-5-supervision-ratio]]"`.
- Commit 812605a (11:51Z) changed it to [[arb-4-disposition]]. Commit 1c8c9e9 (11:52Z) changed it back to the self-anchor.
- The net difference between the ledger and disk for all 3 files is: description added, stale_after changed or added, generated restamped, YAML re-spelled. The bodies are byte-identical.

**Impact**

No exit can recover the arb-4 anchor, because neither the ledger nor the working tree holds it. It survives only in git commit 812605a. The earlier 'about changed to self' fact overstates what the Aug 17 runs damaged.

**Recommendation**

If the arb-4 anchor is the one wanted, pass about [[compass-gcs-5]], [[arb-4-disposition]] in runbook step 4.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - Every part checks out against the vault's git history, the manifest and the ledger.
- The ledger's own write_concept event for gcs-5 (belief 06dd1cbb…) already has the self-anchor in its `about:`. So the earlier incident fact, that the Aug 17 edits changed `about` to point at itself, is wrong.
- The Aug 17 runs flipped the anchor to arb-4-disposition (812605a, 11:51Z), then back to the self-anchor (1c8c9e9, 11:52Z).
- The net damage between ledger and disk is front matter only: a `description` was added, `stale_after` and `generated` changed, and the YAML was re-spelled. The bodies of all 3 files are byte-identical.
- Neither exit button recovers the arb-4 anchor, because neither the ledger's version nor the files on disk contain it. It exists only in git commit 812605a.
- Nuance: the concept `decisions/arb-4-disposition.md` does exist. Only the gcs-5 → arb-4 link is gone.
- The self-reference looks like a real data defect, but it came from the ledger-recorded Aug 16 write, not from the Aug 17 edits.

**Evidence checked.** - **Manifest match:** in the vault /Users/joseflagorio/Documents/test, `git show f7df8b4:knowledge/decisions/gcs-5-supervision-ratio.md` hashes to sha256 e096dab8d7ac…6697. That equals the manifest `content_hash` for the path in .cerebro/projection-manifest.json. 1a42ee4 gives the same hash. The other 2 files at f7df8b4 also match their manifest hashes (d3291aab…, f9517aae…).
- **f7df8b4 (the ledger's version):** `about:` is `"[[compass-gcs-5]]", "[[gcs-5-supervision-ratio]]"`.
- **Ledger event 06dd1cbb4024cbd95f424f99d5cd6d52** in the .ndjsonl.open file: `"about":["[[compass-gcs-5]]","[[gcs-5-supervision-ratio]]"]`, with `generated` at 2026-08-16T19:38:29Z.
- **812605a (04:51:37-07:00):** `about:` is `'[[compass-gcs-5]]'`, `'[[arb-4-disposition]]'`.
- **1c8c9e9 (04:52:09-07:00):** `about:` is `'[[compass-gcs-5]]'`, `'[[gcs-5-supervision-ratio]]'`, and a `description` line was added. The file on disk matches this (sha b11f52e0…).
- **Bodies:** after the front matter, diffing f7df8b4 against disk shows BODY-IDENTICAL for all 3 paths.
- **Where arb-4 still appears:** `git grep arb-4-disposition HEAD -- knowledge` hits only log.md, plus the concept file knowledge/decisions/arb-4-disposition.md. The ledger mentions arb-4-disposition only in that concept's own write events, never in gcs-5's `about`.

</details>
