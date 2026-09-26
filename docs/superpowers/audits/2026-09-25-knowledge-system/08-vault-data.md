# Live vault data audit

> Audit lens `vault-data` · first-pass auditor, each finding adversarially verified

## Summary

The live vault is structurally sound. Files and manifest match 30/30, no orphans, every source file exists, nothing is past its stale_after date, every type is in the vocabulary, and there are no near-duplicate concepts. The divergence touches only the frontmatter of 3 files; their bodies are byte-identical to the ledger versions. The trigger was the M13.5 schema-recheck rule: the user created the Type docs types/decision.md and types/risk.md, and the rule then picked exactly those 3 concepts. Two parallel runners rewrote each concept, in a session whose data shows no active ledger writer. Two of the stated incident facts need correcting. The gcs-5 self-anchor is already in the ledger version, so Restore does not fix it. And the ledger's silence after Aug 31 is mostly harmless: the only file written after 04:00:18Z Aug 31 is records/bets/test.md (04:08Z), and its ledger entry is missing. Restore loses little: 3 descriptions and some stale_after dates. It also leaves 6 log lines for updates that will no longer exist, and it re-arms the same 3 agent rechecks.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F67 | high | yes | What 'Restore recorded history' would revert: frontmatter only on 3 files; no body content, no deletions; log.md is left pointing at updates that will no longer exist |
| F68 | high | yes | Trigger: creating Type docs named 'Decision' and 'Risk' fired M13.5 schema rechecks on exactly the 3 divergent concepts |
| F69 | high | yes | The rewrites ran with no active ledger writer: zero events of any kind for ~11.8 h, while ledgered paths (types/*.md) were written |
| F70 | medium | yes | Two parallel runners rewrote each concept, producing duplicate log lines and last-writer-wins flips |
| F71 | medium | yes | The agent's log.md appends were adopted as a human:owner edit, while the concept edits they describe were refused |
| F72 | medium | yes | The Fleet shows '0 applied · 0 rejected' for runs that wrote 29 concepts: proposal counters are never written |
| F73 | medium | yes | The corpus predates the description and concept-type contracts: 26/29 have no description, 16 are mistyped 'Reference', 0/29 verified |
| F74 | low | yes | 13/29 concepts anchor to themselves and no anchor reaches outside knowledge/; KOS 3.2 shows as an open thread although a concept about it exists |
| F75 | low | yes | The divergence event is mislabeled and drops its reason, so the user cannot tell why capture paused |
| F76 | low | yes | The golden corpus (demo-vault) models none of these shapes, so tests cannot reproduce this incident |

### F67 — What 'Restore recorded history' would revert: frontmatter only on 3 files; no body content, no deletions; log.md is left pointing at updates that will no longer exist

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `/Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md:4`
  - `/Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md:21`
  - `/Users/joseflagorio/Documents/test/knowledge/risks/tx-6-changeover-transient-cross-channel-sync-disabled.md:4`
  - `/Users/joseflagorio/Documents/test/knowledge/risks/tx-6-changeover-transient-cross-channel-sync-disabled.md:23`
  - `/Users/joseflagorio/Documents/test/knowledge/risks/tx-6-np-shared-j12-common-mode.md:4`
  - `/Users/joseflagorio/Documents/test/knowledge/risks/tx-6-np-shared-j12-common-mode.md:23`
  - `/Users/joseflagorio/Documents/test/knowledge/log.md:3-9`
  - `src-tauri/src/ledger/reconcile.rs:427-470`
  - `src/engine/jobs.ts:182`

**Evidence**

The manifest content_hash matches vault git revisions 1a42ee4 (gcs-5, e096dab8), 3614cc0 (tx-6-changeover, d3291abf) and e67bed2 (tx-6-np, f9517aae). Diffing each against the current file shows the body after the frontmatter is identical in all three.

What Restore removes or changes per file:
(a) gcs-5: drops `description:` (L4), moves stale_after from 2027-10-31 back to 2027-07-31, sets generated.at back to 2026-08-16T19:38:29Z.
(b) tx-6-changeover: drops `description:` (L4), drops stale_after 2027-02-17 (the Aug 16 version has none), sets generated.at back to 2026-08-16T20:00:24Z.
(c) tx-6-np: drops `description:` (L4), drops stale_after, sets generated.at back to 2026-08-16T20:00:42Z.
The rest is YAML reflow only (flow style to block style).

What Restore does not do:
- Delete anything: 30 .md files = 30 manifest entries = projection_count 30.
- Touch log.md. Its manifest hash 34e25ca2 equals the current file, and seq 179 adopted it, so the 6 '**Update**' lines stay.
- Fix the self-anchor. The Aug 16 version already has `- "[[gcs-5-supervision-ratio]]"`. The only version without it was 812605a, which lasted 32 s.

Side effect: restored generated.at (Aug 16) is older than types/decision.md's mtime (2026-08-17T11:50:01Z), so jobs.ts:182 no longer skips these concepts. They get a new runKey and the same 3 schema rechecks are queued again.

**Impact**

The user loses the only 3 `description` lines in the whole base (26 other concepts have none) and 3 stale_after dates. No knowledge prose is lost. Afterwards log.md lists 6 updates dated 2026-08-17 that exist in neither the files nor the concept beliefs. The background runner may then repeat the same rewrite.

**Recommendation**

Before offering Restore, show this per-file diff in the banner: fields only, bodies unchanged. Make Restore also regenerate or annotate the log entries for reverted revisions. Suppress the schema-recheck re-trigger for paths that Restore just regenerated.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Mechanism is real. `resolve_restore_with` rewrites every file in `state.projection_paths` from `project_belief`, trims the manifest to that same set, deletes only knowledge `.md` files the reducer has no path for, and then checks that files, manifest and reducer agree byte for byte.
- None of the 3 affected beliefs has a ledger event after its creation. So restore writes back exactly the Aug 16 bytes, which match the manifest `content_hash`.
- Those bytes differ from the current files in frontmatter only. The body text is identical.
- log.md is safe. Its belief was last touched at seq 179 (the out-of-band capture that adopted the current bytes), and the manifest hash equals the file on disk, so restore rewrites the same bytes. The six duplicate "**Update**" lines for 2026-08-17 stay and point at content that reverts.
- No deletions. 30 knowledge `.md` files map to 30 manifest entries, and log.md is one of them.
- The self-anchor survives restore. The Aug 16 version already has `[[gcs-5-supervision-ratio]]` in `about:`, and only 812605a had `[[arb-4-disposition]]` instead.
- The re-queue side effect holds (see the jobs.ts evidence).
- Severity is overstated. What is lost is 3 `description` lines and the `stale_after` changes, all agent-generated metadata. No prose is lost. Restore is the only button that works and the damage is recoverable from vault git, so medium, not high.
- Small wording fix: log.md does not point at missing files. It points at Aug 17 revisions of files that still exist.

**Evidence checked.** - **Restore code:** src-tauri/src/ledger/reconcile.rs:427-520.
  - L443-446: `write_projection(project_belief(...))` for every entry in `projection_paths`.
  - L447-455: the manifest keeps only reducer paths.
  - L456-475: deletes only knowledge `.md` files not in `projection_paths`.
  - L478-485: byte-for-byte recheck.
- **Projection source:** reduce.rs:583 `project_belief` builds the bytes from belief state.
- **Ledger history** (.cerebro/ledger/*.open, grepped by belief id):
  - gcs-5 (0eb6e3…) appears only at seq 112-114.
  - tx-6-changeover (ff8249…) appears only at seq 157-159.
  - tx-6-np (73720f…) appears only at seq 162-164.
  - log.md (49e243…) was last touched at seq 179, event 17c472…, which is the manifest's `generating_event` for log.md.
- **Manifest vs git vs disk:**
  - gcs-5: manifest e096dab8 = sha of `git show 1a42ee4:` the file; disk is b11f52e0.
  - tx-6-changeover: manifest d3291abf = 3614cc0; disk is 14b6aa9e.
  - tx-6-np: manifest f9517aae = e67bed2; disk is 176c6cf3.
  - log.md: manifest 34e25ca2 = disk.
- **Diffs** (old revision vs current file): the only changes are the added `description:`, the `stale_after` changes, the newer `generated.at`, and flow-to-block YAML reflow. Nothing changes after the frontmatter.
- **The 1a42ee4 gcs-5 version** already contains `- "[[gcs-5-supervision-ratio]]"`. 812605a had `[[arb-4-disposition]]` instead.
- **File counts:** 30 knowledge `.md` files and 30 manifest entries.
- **Re-queue:** in src/engine/jobs.ts:182 a concept is skipped only if `doc.modifiedAt <= generatedAt`.
  - types/decision.md mtime is 2026-08-17T04:50:01-0700 (11:50:01Z) and types/risk.md is 11:49:06Z. Both are after the restored Aug 16 `generated.at` values (19:38Z, 20:00Z).
  - The tx-6 risks reach Decision through the `about` target frb-118-session-1-disposition.
  - The restored file gets a new mtime, so `runKey` = the new mtime, which differs from any recorded attempt. The schema recheck is queued again.
- **git diff bd6f0a8..HEAD -- knowledge/log.md:** shows the 6 duplicate `**Update**` lines added under "## 2026-08-17".

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - Restore (reconcile.rs:427-516) rebuilds every file from the recorded history. It is not a copy of the manifest.
  - It rewrites every path in projection_paths (L442-445).
  - It deletes only knowledge .md files the history cannot explain (L456-474).
- launch_scan labels a file OutOfBandEdit only when the manifest and the reducer agree and the file on disk differs. So for these 3 files the history's version equals the manifest hash, and Restore writes back the Aug 16 bytes.
- log.md is part of the history (belief 49e24332…, manifest generating_event = the seq-179 override 17c472b4). Overrides are applied when files are rebuilt (reduce.rs:454-465, 1117). Its rebuilt version is therefore 34e25ca2, which is the file on disk now, so Restore leaves it untouched.
- Nothing gets deleted. The vault holds 30 .md files, all 30 are in the manifest, the scan reported projection_count 30, and .DS_Store is skipped because it is not .md.
- Hashing: 27 of 30 files match the manifest. Only the 3 named files differ, and their manifest hashes equal git 1a42ee4 (e096dab8), 3614cc0 (d3291abf) and e67bed2 (f9517aae).
- Diffing those revisions against the current files shows changes in frontmatter only:
  - description added in all 3;
  - stale_after changed on gcs-5 (2027-07-31 → 2027-10-31) and added on the two tx-6 files;
  - generated.at moved to Aug 17;
  - the rest is YAML reflow. Body text is identical.
- The Aug 16 gcs-5 version already had the "[[gcs-5-supervision-ratio]]" self-anchor.
- The 3 description lines are the only ones in the base (grep).
- jobs.ts side effect is plausible:
  - types/decision.md was modified 2026-08-17 11:50:01Z. That is later than the Aug 16 generated.at values but earlier than the Aug 17 ones.
  - gcs-5's about includes itself (type Decision); the tx-6 files point to frb-118-session-1-disposition (Decision).
  - After Restore the concept's modifiedAt changes, so runKey changes and a recheck is queued again.
- Why severity drops: no prose is lost, the removed values are recoverable from vault git, and the stale log.md is a cosmetic inconsistency. The larger problem is that the user has no lossless way to resolve the banner, which is a separate finding.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:
  - L442-445: every file in the history is rewritten.
  - L456-474: knowledge .md files the history cannot explain are deleted.
  - L476-484: each file is checked byte-for-byte after the rewrite.
  - L256-297: the classification loop that labels files OutOfBandEdit.
- src-tauri/src/ledger/reduce.rs:
  - L454-465: overrides are applied when a file is rebuilt.
  - L1117: dispatch of the override event.
- Vault manifest (/Users/joseflagorio/Documents/test/.cerebro/projection-manifest.json):
  - The log.md entry has generating_event 17c472b4 (the seq-179 override) and content_hash 34e25ca2, which equals the log.md on disk.
  - 27 of 30 content_hash values match the files on disk. The 3 that differ are exactly the sample_paths named at seq 180.
- Vault git: `git show 1a42ee4|3614cc0|e67bed2:<path> | diff - <path>` shows frontmatter-only differences (description, stale_after, generated.at, YAML style). Bodies are identical.
- knowledge/log.md lines 3-9: six "**Update**" lines under 2026-08-17, each concept listed twice.
- The only 3 description lines in knowledge/ are in these 3 files. stale_after appears in 7 files.
- src/engine/jobs.ts:173-195: the recheck gate compares type-file modifiedAt against generated.at. types/decision.md mtime is 2026-08-17T04:50:01 PDT (11:50:01Z). The about targets resolve to Decision entries (gcs-5 itself, frb-118-session-1-disposition).

**Correction.** The mechanics are right: Restore rewrites only the frontmatter of the 3 concept files back to their Aug 16 bytes. It changes no body text, deletes nothing and leaves log.md as it is, so log.md keeps 6 duplicated "**Update**" lines that no longer match anything. Two details are overstated. First, only 2 stale_after dates are lost: gcs-5's goes back to 2027-07-31 and the two tx-6 files lose theirs. Second, the severity is too high. Restore loses 3 description lines and 2 dates. The Aug 17 versions stay in vault git (autosync commits 1a42ee4/3614cc0/e67bed2 and later), so they can be recovered. The self-anchor defect is older than Aug 17 and Restore neither causes nor fixes it. Medium, not high.

</details>

### F68 — Trigger: creating Type docs named 'Decision' and 'Risk' fired M13.5 schema rechecks on exactly the 3 divergent concepts

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src/engine/jobs.ts:161-199`
  - `/Users/joseflagorio/Documents/test/types/decision.md:1-7`
  - `/Users/joseflagorio/Documents/test/types/risk.md:1-7`
  - `/Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md:7`

**Evidence**

Timeline (birth times):
- types/risk.md created 2026-08-17T04:49:06 PDT; types/decision.md created 04:50:01 PDT (vault commits 90437f4, f7df8b4). Both are empty `type: Type` docs titled Risk / Decision.
- runtime.db `runs` shows 6 attended agent runs between 11:50:08Z and 11:57:44Z, starting 7 s after decision.md was created.

How the rule selects concepts: jobs.ts:169 keys Type docs by title. jobs.ts:182 queues a 'schema' recheck for any concept whose `about:` target resolves to an entry of that type. Applying this to the live vault selects exactly 3 concepts:
- gcs-5-supervision-ratio, via its SELF-anchor (itself typed Decision)
- both tx-6 risks, via [[frb-118-session-1-disposition]] (typed Decision)
Those are exactly the 3 sample_paths in the seq 180 divergence event.

**Impact**

When a user adds a database Type whose name matches a concept vocabulary word (Decision, Risk, System, Metric...), background agent rewrites fire across the knowledge base with no prompt. Self-anchored concepts also get rechecked whenever the Type named after their own concept type changes. This is type-name coupling across two namespaces.

**Recommendation**

Scope schema-drift rechecks to about-targets outside knowledge/: a concept's type is not a user schema. Skip self-anchors. Or namespace the concept vocabulary so a user Type named 'Decision' cannot match it.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The mechanism is real, and the data proves it directly. `job_ledger` holds `attempts` rows for exactly the 3 divergent concepts, each with `run_key` = 2026-08-17T11:50:01Z. That is the mtime of types/decision.md (created 04:50:01 PDT). Per jobs.ts:190-193 the run key is max(concept mtime, newest type-doc mtime), so these keys can only come from the `schema` branch. They are not `stale` jobs.
- Selection matches jobs.ts:169/182 as stated. gcs-5 (type: Decision) is picked up through its own self-anchor `[[gcs-5-supervision-ratio]]`. Both tx-6 risks are picked up through `[[frb-118-session-1-disposition]]`, which is `type: Decision`. Their other `about` targets are typed Reference, and no Type doc named Reference exists.
- Detail correction 1: the self-anchor already existed before the Aug 17 edits (pre-edit commit 812605a^ shows `about: [compass-gcs-5, gcs-5-supervision-ratio]`), so the trigger never depended on the agent's own edit. The incident brief's "changed from arb-4-disposition" does not match the pre-edit file.
- Detail correction 2: types/risk.md selected nothing, because no `about` target is typed Risk. Decision.md alone fired all 3 jobs. The 6 attended runs map to 3 schema jobs, so this was not a knowledge-base-wide fan-out.
- Severity is overstated. M13.5 schema recheck is designed behavior ("lazily, one at a time"), and it is only the trigger. The actual defect is the downstream write path: the agent rewrote files outside the ledger, the `generated` stamp was changed out of band, and capture refused it. The type-name coupling is real: concept frontmatter `type: Decision` is matched by title against a database `type: Type` doc, across two namespaces, which fits AGENTS.md's no-type-special-casing rule. On its own it causes unprompted rechecks, not divergence. Medium.

**Evidence checked.** - src/engine/jobs.ts:167-170: `typeDocs.set(e.title, e)` for `e.type === 'Type'`.
- jobs.ts:176-183: resolves each `about` target and looks up `typeDocs.get(entry.type)`, firing when `doc.modifiedAt > generatedAt`.
- jobs.ts:190-199: `runKey` = max, and the kind is `'schema'`.
- Vault git: 90437f4 (04:49:20 PDT) adds types/risk.md. f7df8b4 (04:50:05 PDT) adds types/decision.md. Both files are an empty `type: Type` with an H1 of Risk / Decision. 812605a…e1770e4 (04:51–04:57) are the "Update 2 notes in knowledge" commits.
- runtime.db `job_ledger`: `attempts | knowledge/decisions/gcs-5-supervision-ratio.md | 2026-08-17T11:50:01Z`. The two knowledge/risks/tx-6-*.md files have the same run_key. No other row carries that key.
- runtime.db `runs`: 6 attended/agent runs, 11:50:08Z–11:57:44Z, all with proposals_submitted=0 and applied=0.
- Pre-edit `about` fields (git show 812605a^):
  - gcs-5: `[[compass-gcs-5]]`, `[[gcs-5-supervision-ratio]]`
  - tx-6 changeover: `[[epc-40-controller]]`, `[[tx-6-sable]]`, `[[frb-118-session-1-disposition]]`
  - tx-6 np: `[[tx-6-np-shared-j12-route]]`, epc-40, tx-6-sable, frb-118
- Target types: knowledge/decisions/frb-118-session-1-disposition.md is `type: Decision`. compass-gcs-5, epc-40-controller, tx-6-sable and tx-6-np-shared-j12-route are `type: Reference`.

**Correction.** Creating types/decision.md (11:50:01Z) caused `schema` recheck jobs on exactly the 3 divergent concepts. `job_ledger` run_keys equal that mtime. types/risk.md contributed nothing, since no `about` target is typed Risk. gcs-5's self-anchor was already there before the edits and was not introduced by them. The recheck is intended M13.5 behavior and only the trigger. The divergence comes from the ledger-bypassing write path and the out-of-band change to the `generated` stamp in those runs. The title-keyed coupling between concept `type:` and database Type docs is a real design smell, at medium severity rather than high.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Can it happen in the real app? Yes.**
  - src/agent/useJobRunner.ts:207-220 calls jobQueue whenever `autoLearn` is on.
  - uiStore.ts:887 defaults `autoLearn` to 'true'.
  - jobs.ts:167-169 keys Type docs by title. jobs.ts:180-182 matches them against `entry.type` of the `about:` target.
  - Knowledge concepts carry `type: Decision` / `type: Risk`. So a user database Type titled "Decision" or "Risk" collides with concept vocabulary types. That is routing on type names across namespaces, which AGENTS.md prohibits in spirit.
- **What the live data shows:**
  - runtime.db job_ledger 'attempts' for vault 5171d… (= /Users/joseflagorio/Documents/test) has exactly 3 knowledge keys with run_key 2026-08-17T11:50:01Z: gcs-5-supervision-ratio.md and both tx-6 risks.
  - That timestamp is decision.md's birth/mtime (04:50:01 PDT).
  - It matches the `newestTypeChange > concept mtime` runKey branch (jobs.ts:186-189). No other knowledge concept carries that key.
  - The pre-edit gcs-5 (git 812605a~1) already had the self-anchor [[gcs-5-supervision-ratio]]. So the claim's self-anchor path is right. The incident fact "about changed from arb-4-disposition" is wrong for that file.
  - Both tx-6 risks point at [[frb-118-session-1-disposition]], a Decision concept.
- **Why the severity is overstated:** the rule is intended, lazy, one-at-a-time behaviour. The harmful part is the write path: runs show proposals_submitted=0 and applied=0, and the edits reached the ledger with no events. Also, 6 attended agent runs ran for 3 jobs (two pairs started ~1.8s apart), so each concept was rewritten twice and log.md got duplicate lines. That is a separate double-dispatch issue.

**Evidence checked.** - /Users/joseflagorio/Development/cerebro/src/engine/jobs.ts:161-199: Type docs keyed by `e.title`, and a concept is queued `kind: 'schema'` when a resolved `about:` target's `entry.type` names a Type doc whose modifiedAt is later than generated.at.
- /Users/joseflagorio/Development/cerebro/src/agent/useJobRunner.ts:206-220 (`if (!autoLearn ...) return null; jobQueue(...)`) and :423-424 (`schemaRecheckPrompt`).
- /Users/joseflagorio/Development/cerebro/src/stores/uiStore.ts:887: autoLearn defaults to 'true'.
- Vault:
  - types/risk.md born Aug 17 04:49:06 PDT (commit 90437f4); types/decision.md born 04:50:01 PDT (commit f7df8b4). Both are empty `type: Type` docs.
  - git 812605a~1:knowledge/decisions/gcs-5-supervision-ratio.md shows about [[compass-gcs-5]], [[gcs-5-supervision-ratio]] and generated.at 2026-08-16T19:38:29Z.
  - tx-6 risks list [[frb-118-session-1-disposition]].
  - Commits 812605a, 1c8c9e9, 7658504, e3543b4 and e1770e4 (04:51-04:57 PDT) each rewrote one of the 3 concepts plus log.md, with duplicated **Update** lines.
- runtime.db (read-only):
  - `job_ledger`: knowledge/decisions/gcs-5-supervision-ratio.md, knowledge/risks/tx-6-changeover-transient-cross-channel-sync-disabled.md and knowledge/risks/tx-6-np-shared-j12-common-mode.md all have run_key=2026-08-17T11:50:01Z.
  - `runs`: 6 rows, mode=attended, lane=agent, 11:50:08Z-11:57:44Z, all with proposals_submitted=0 and applied=0.

**Correction.** The mechanism holds. Adding the Type docs Decision (11:50:01Z) and Risk (11:49:06Z) fired M13.5 'schema' rechecks, through jobs.ts:167-199, on exactly the 3 concepts that later diverged. The job ledger stores the run key as decision.md's mtime. The trigger is still only a contributing cause, not the defect that opened the banner. The recheck rule did what it was designed to do. The divergence came from how those runs wrote their changes: 0 proposals in runs, and no ledger events for the edits. Blast radius is limited to concepts whose `generated.at` is older than the new Type doc and whose `about:` resolves to an entry of that type. It does not reach "across the knowledge base". There is also a separate problem: 6 agent runs ran for 3 jobs, and that double dispatch caused the duplicate **Update** lines in log.md. The claim does not explain it.

</details>

### F69 — The rewrites ran with no active ledger writer: zero events of any kind for ~11.8 h, while ledgered paths (types/*.md) were written

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/vault/write.rs:606-626`
  - `src-tauri/src/ledger/shadow.rs:311-327`
  - `/Users/joseflagorio/Documents/test/.cerebro/ledger/d62256b3040f66f44f65d74c91d2b60c-0000000000000001.ndjsonl.open`

**Evidence**

The ledger has seq 178 at 2026-08-17T00:10:35Z, then seq 179 at 11:58:53Z (the launch scan). In that gap, 7 autosync commits wrote:
- types/risk.md and types/decision.md
- 4 prototypes/pricing-page files
- 3 concepts, 6 writes
- 6 log.md appends
None of those blob hashes appear in any ledger event. types/*.md writes are normally ledgered (types/bet.md has vault.write events on 08-29 and 08-30).

If a writer had been active, the legacy fallback (write.rs:612-626) would have emitted `knowledge.write_concept` shadow events. There are 0 in all 273 events. shadow::record returns silently when there is no writer, the vault path does not match, or append fails (shadow.rs:312-327).

Same pattern later: records/bets/test.md versions at c59b190 (Aug 28) and 5b5b6b5 (Aug 30, 04:08Z) and types/bet.md at 2a53309/cc25166/ff0d52a have no matching ledger hash.

**Impact**

The ledger is not a complete history. Any session without a writer rewrites knowledge/ silently. The next launch then opens reconciliation days later, blaming the edits as 'out of band' when the app itself made them.

**Recommendation**

Make the legacy file-first knowledge path refuse, or at least surface a visible degraded state, when the vault has a ledger but no active writer. Record shadow drops to runtime.db instead of discarding them silently.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real.** The MCP tool_write_concept (mcp.rs:2539) calls vault::write::write_concept. That function tries ledger::concepts::write_concept first (concepts.rs:68-80), which goes through shadow::with_writer and returns None when no writer is active. It then falls back to the legacy file write plus shadow_write → shadow::record. record (shadow.rs:311-327) returns silently when there is no Active, the vault path does not match, or the writer is None, and it swallows append errors.
- **The data fits "no active writer".**
  - There are zero events between seq 178 (2026-08-17T00:10:35Z) and seq 179 (11:58:53Z), a gap of 11h48m.
  - Ledger-tracked paths were written in that gap. SHA-256 of types/risk.md@90437f4, types/decision.md@f7df8b4, gcs-5@812605a/1c8c9e9 and the intermediate log.md blobs all appear nowhere in the ledger.
  - types/bet.md writes are normally recorded; the Aug 16 and Aug 29-30 commits match vault.write hashes.
- **The writes were the app's own.** The "* **Update**: [...]" log lines come from knowledge::insert_log_entry, which the app appends via append_knowledge_log after every MCP write_concept. The generated.by stamp is the MCP server's. So this was the app's MCP legacy path, not an outside edit.
- **Extra evidence the writer was absent (not just bypassed).**
  - The live watcher runs capture_out_of_band on every knowledge/*.md change (watcher.rs:255-261), but only through with_writer. With a writer active, log.md would have been captured around 11:51-11:57Z.
  - Instead log.md was captured only by the launch scan (seq 179). launch_scan runs only inside shadow::activate (shadow.rs:144), which start_watcher calls (lib.rs:1478).
  - An app instance was running during the edits: the autosync checkpoints come from useGit.ts, whose withLedgerTrailer reads the head from disk and needs no writer. So that session had the vault open with no active writer.
- **Minor corrections.**
  - The writes were bunched at 11:49-11:57Z. Reconciliation opened about 1 minute later at the next activation, not "days later" in this case.
  - The launch scan and reconciliation only cover knowledge/ projections. Unrecorded types/ and records/ writes are never reconciled; they stay out of the ledger with nothing flagged.
  - The later examples fit the same pattern: c59b190 at 08-29T04:25Z falls between events 199 (03:34Z) and 200 (12:58Z), and 5b5b6b5 (08-31T04:10Z) comes after the last event, 273 (04:00Z). But those could also be a write path that skips shadow_write; the data alone can't tell the two apart.

**Evidence checked.** - src-tauri/src/vault/write.rs:600-626: tries the ledger-first path, then falls back to legacy concept_write + shadow_write.
- src-tauri/src/ledger/concepts.rs:68-80: returns None without a writer.
- src-tauri/src/ledger/shadow.rs:294-305 (with_writer returns None) and 311-327 (record returns silently, swallows append failure).
- src-tauri/src/mcp.rs:2539-2546: write_concept, then append_knowledge_log (the "**Update**" lines, knowledge.rs:287).
- src-tauri/src/vault/watcher.rs:255-261: live out-of-band capture, which needs a writer (capture.rs:171).
- src-tauri/src/ledger/shadow.rs:82-150: launch_scan runs only from activate; lib.rs:1478 calls it from start_watcher.
- src/git/useGit.ts:320-327: the Ledger-Head trailer is a disk read of the head.
- Ledger: seq 178 = 2026-08-17T00:10:35.508Z vault.write inbox/...; seq 179 = 11:58:53.806Z projection.overridden. Hash cross-check:
  - NOT in ledger: types/risk.md@90437f4 (294995ba), types/decision.md@f7df8b4 (b96c620c), gcs-5@812605a (a4eec04a) and @1c8c9e9 (b11f52e0), log.md@812605a/7658504/e3543b4, types/bet.md@2a53309/c59b190/cc25166/ff0d52a, records/bets/test.md@c59b190/5b5b6b5.
  - IN ledger: types/bet.md@cb0ed36/933afcd/91fd1c3/9e6c6c9/28cd501, and log.md@e1770e4 (the capture at scan time).
- Vault commits 90437f4..e1770e4 are 04:49-04:57 -07:00 (11:49-11:57Z); gcs-5 at 1c8c9e9 carries generated {by: claude-code, at: 2026-08-17T11:52:02Z}.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - Tried to refute via "the agent bypassed the app entirely (own Write tool), so writer state is irrelevant". Disproved by byte style: the Aug 17 concept files are serde_yaml BLOCK style (`- '[[compass-gcs-5]]'`, `generated:\n  by: claude-code`). That is the legacy `concept_write` serializer. The ledger projection emits FLOW style (`generated: { by: ..., at: ... }`), which is what the Aug 16 ledger-projected bytes had. log.md got the app's own `* **Update**: [...]` line format.
- So these edits went through the app's MCP write_concept, and `ledger::concepts::write_concept` returned None. `shadow::with_writer` returns None only when there is no Active entry, the vault path does not match, or `writer` is None. In all three cases the legacy fallback wrote the file, and `shadow::record` then dropped the `knowledge.write_concept` event silently. That is exactly the "no active writer" claim.
- The gap is real: seq 178 was ingested 2026-08-17T00:10:35Z and seq 179 at 11:58:53Z (11.8 h). Seven autosync commits landed in between (11:49Z–11:57Z): types/risk.md, types/decision.md, 4 prototype files, 3 concepts ×2, and log.md. None of their sha256 values appear in any ledger event, and types/risk.md and types/decision.md have 0 events.
- The Cerebro-Ledger-Head trailer does not prove a writer. `ledger_head` (lib.rs:1455) reads the head from disk, which is why every trailer shows the frozen 619957fc.
- Seq 179/180 come from `activate()` → `launch_scan` (shadow.rs:144), so a fresh activation happened at 11:58. That fits: the earlier session had no writer, then a writer came back and the scan flagged the edits as out of band.
- This is reachable in the real app. `activate` leaves `writer: None` when writer_id fails, on a refused verdict, or when `LedgerWriter::open` fails because another instance holds the lock (see the comment at shadow.rs ~L113). I could not determine which cause applied on Aug 17.
- The comment at write.rs:612-615 says "the M23.6 scan reconciles once a writer returns". That is false for this case: the scan refuses the changed generated stamp as forgery, so there is no reconciliation.
- Minor overstatement: the "same pattern later" hash mismatches (types/bet.md 2a53309/c59b190/cc25166/ff0d52a, records/bets/test.md c59b190/5b5b6b5) are consistent with a missing writer, but they could also be edits outside the app. Only the Aug 17 set has the decisive legacy-serializer fingerprint. 5b5b6b5 (2026-08-31T04:10Z) does fall after the last event, seq 273.

**Evidence checked.** - src-tauri/src/vault/write.rs:606-626: the ledger-first path is tried first, then the legacy `concept_write` and `shadow_write`.
- src-tauri/src/ledger/concepts.rs:68-80: returns None without `shadow::with_writer`.
- src-tauri/src/ledger/shadow.rs:295-305 (`with_writer` returns None when there is no active entry, the vault does not match, or the writer is None) and 311-327 (`record` returns silently).
- src-tauri/src/ledger/shadow.rs:81-176: `activate` sets `writer: None` on writer_id failure, a refused verdict, or a failed open such as a held lock. It calls `launch_scan` at L144.
- src-tauri/src/ledger/concepts.rs:1014 and ledger/project.rs:365: the projection uses flow style `generated: { by: ..., at: ... }`.
- `git show 812605a` in the vault: the file changed to block style with `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`, and log.md got `* **Update**: [...]`.
- Ledger `ingested_at`: seq 177 2026-08-16T23:59:13Z, seq 178 2026-08-17T00:10:35Z, seq 179 11:58:53Z, seq 180 11:58:54Z, seq 181 2026-08-22T05:15:52Z.
- Hash match: types/risk.md (90437f4) and types/decision.md (f7df8b4) have 0 ledger events. types/bet.md matches at seq 58/199/201/202/207 but not for 2a53309, c59b190, cc25166 or ff0d52a.
- src-tauri/src/lib.rs:1455: `ledger_head` reads the head from disk, so the trailer does not prove a writer.

</details>

### F70 — Two parallel runners rewrote each concept, producing duplicate log lines and last-writer-wins flips

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `/Users/joseflagorio/Documents/test/knowledge/log.md:4-9`
  - `src/agent/useJobRunner.ts:380-440`
  - `src/engine/jobs.ts:195`

**Evidence**

The runs table shows two lock-step chains, each handling the same 3-job list, each new run starting about 4 s after its chain's previous run ended:
- Chain A: 721fd174 (11:50:08) → ee2a46d7 (11:52:12) → f3e456fa (11:54:54)
- Chain B: a8e7a828 (11:50:09.9) → 37769bc1 (11:51:42) → 344cd412 (11:54:42)

Conflicting outputs from the paired runs:
- gcs-5 about [[arb-4-disposition]] with stale_after 2028-02-28 (812605a), then 31 s later about [[gcs-5-supervision-ratio]] with stale_after 2027-10-31 (1c8c9e9)
- tx-6-np stale_after 2027-07-15 (e3543b4), then 2027-02-17 (e1770e4)

log.md L4-9 has each '**Update**' line twice. The global concurrency ceiling of one landed 30 min later (vault clock 05:24 PDT; M33b.1/M33b.2, ec4fe55/e0e1986).

**Impact**

The concept's final content is whichever run finished last, not a reviewed merge. The changelog double-counts, and stale_after is effectively a random LLM guess (the two values for tx-6-np are 5 months apart).

**Recommendation**

Dedupe jobs by (kind, path, runKey) across runners, and hold a per-concept single-flight lock in the backend rather than only in the React runner. Add a test that two runners cannot claim the same job.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - **Data confirmed.** runtime.db `runs` holds exactly the two lock-step chains described. Every run is mode=attended, lane=agent, claude-opus-4-7. Each run in a chain starts about 4s after the previous one ends, which matches SETTLE_MS = 4_000 in the runner at the incident-time commit.
- **The job list.** job_ledger `attempts` rows have run_key 2026-08-17T11:50:01Z for the 3 concept paths. These are schema rechecks triggered by the types/risk.md and types/decision.md commits (90437f4 and f7df8b4, 11:49–11:50Z). This fits jobs.ts ~L195 `kind: 'schema'`: 1 Decision and 2 Risks.
- **Commits line up with run ends.** 812605a (11:51:37) matches a8e7 ending at 11:51:38. 1c8c9e9 (11:52:09) matches 721f ending at 11:52:08. 7658504 carries both changeover log lines. e3543b4 and e1770e4 match 344c and f3e4 ending.
- **Why two runners.** At 6a6d730, JobRunnerHost is mounted once in App.tsx, and the dedupe relies on a per-instance `running.current` ref. Attempts sat in `cerebro.learnAttempts` localStorage, loaded once when the store starts. So two app windows or instances each ran their own serial runner and both picked the same 3 jobs.
- **Flips confirmed.** gcs-5 went about [[arb-4-disposition]] with stale_after 2028-02-28, then back to [[gcs-5-supervision-ratio]] with 2027-10-31. tx-6-np went 2027-07-15, then 2027-02-17. log.md L4-9 has each Update line twice.
- **Wrong fix attribution.** M33b.1/M33b.2 (ec4fe55/e0e1986) only turned the existing AMBIENT dispatch singleton into N leases capped by a setting defaulting to one. Ambient concurrency was already one before that. These runs were `attended`, so no ambient ceiling would have gated them.
- **Actual fix.** M34.2.3 (7c8a9e6, 2026-08-20) made every fire a durable claim. Current useJobRunner.ts:338-340 calls `jobLedgerClaim(vaultPath, 'attempts', ...)` before spawning, and a window that loses the claim spawns nothing. The cited current code (380-440) is therefore not a live defect.
- **What remains.** Historical residue in the vault: duplicated log lines and unreviewed last-writer content, which are also the files behind the divergence banner.

**Evidence checked.** - runtime.db `runs`:
  - 721fd174: 11:50:08.0 to 11:52:08.5
  - a8e7a828: 11:50:09.9 to 11:51:38.2
  - 37769bc1: 11:51:42.4 to 11:54:38.4
  - ee2a46d7: 11:52:12.9 to 11:54:50.5
  - 344cd412: 11:54:42.6 to 11:56:56.0
  - f3e456fa: 11:54:54.8 to 11:57:44.9
  - All mode=attended, lane=agent.
- runtime.db `job_ledger` attempts: gcs-5, tx-6-changeover and tx-6-np all have run_key 2026-08-17T11:50:01Z.
- Vault git:
  - 812605a: about → arb-4, stale_after 2028-02-28
  - 1c8c9e9: about → gcs-5-supervision-ratio, 2027-10-31
  - 7658504: two identical changeover Update lines
  - e3543b4: 2027-07-15; e1770e4: 2027-02-17
  - The Aug 16 original already had the self-reference, and 812605a had removed it.
- knowledge/log.md:4-9 has duplicated pairs.
- Incident-time code (6a6d730):
  - src/agent/useJobRunner.ts:59 `SETTLE_MS = 4_000`
  - L221-225 `running.current` per-instance guard
  - L246 `ui.recordLearnAttempt`
  - src/stores/uiStore.ts:339 `LEARN_ATTEMPTS_KEY = 'cerebro.learnAttempts'`, L806 loaded once
  - App.tsx:426 single `<JobRunnerHost />`
- ec4fe55 message: "The `ambient_dispatch` singleton primary key becomes N leases ... defaults to one — so nothing about background behaviour changes". This is ambient only.
- Fix: 7c8a9e6 (M34.2.3, 2026-08-20) "every fire is a claim". Current src/agent/useJobRunner.ts:338-340 has `jobLedgerClaim(vaultPath, 'attempts', job.key, job.runKey)`, and comment L444-447 says "losing it means another window answered this fire".

**Correction.** - **What holds:** two runner instances (almost certainly two app windows or instances) each ran the same 3 schema-recheck jobs serially and in parallel with each other. That produced last-writer-wins flips (gcs-5 about/stale_after, tx-6-np stale_after) and doubled log.md Update lines.
- **Fix attribution is wrong:** M33b.1/b.2 did not add a guard for this. They refactor AMBIENT dispatch, which was already capped at one, and these runs were attended.
- **The real fix** is M34.2.3 (7c8a9e6, 2026-08-20). The attempts ledger became a durable cross-window claim, visible today at useJobRunner.ts:338-340, so the current code at the cited location is not defective.
- **Severity:** what remains is historical data residue in the vault, not a live code bug, so low.

</details>

### F71 — The agent's log.md appends were adopted as a human:owner edit, while the concept edits they describe were refused

- **Severity (claimed):** medium
- **Category:** provenance
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:757-783`
  - `src-tauri/src/ledger/capture.rs:806-826`
  - `src-tauri/src/ledger/reconcile.rs:302-311`

**Evidence**

Seq 179 is `projection.overridden` for log.md with actor human:owner, origin out_of_band, after_projection_hash 34e25ca2, containing the 6 agent-written '**Update**' lines. capture_diff_with hard-codes actor_id "human:owner" (capture.rs:810, 822). launch_scan captures each out-of-band path separately (reconcile.rs:302-311), so log.md was adopted while all 3 concept files were refused as 'provenance forgery'.

The ledger now says log belief revision 29 records 3 concept updates on 2026-08-17, while those concept beliefs are still at projected_revision 1.

**Impact**

The epistemic history attributes machine output to the human, and holds a changelog that contradicts the beliefs it logs. Neither Restore nor Keep undoes seq 179.

**Recommendation**

Make launch-scan capture all-or-nothing when sibling paths fail. At minimum, never capture knowledge/log.md on its own when the concept paths it references were refused. Stop defaulting out-of-band actors to human:owner when generated.by names an agent.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Code is real and reachable. launch_scan captures each parked out-of-band path in its own loop iteration (reconcile.rs:302-311). A failure on one path does not stop the others, so log.md captured OK while the 3 concept files went to divergent.
- capture_diff_with hard-codes actor_id "human:owner" for both the structured and editorial requests (capture.rs:810, 822). The docstring at ~L757 says this is deliberate ("with actor `human:owner`"). The result is still that agent output is attributed to the human.
- Ledger data matches the claim. Seq 179 is projection.overridden, actor human:owner, origin out_of_band, path log.md, base_belief_revision 29, after_projection_hash 34e25ca2…. Diffing its body adds "## 2026-08-17" plus 6 "**Update**" lines: each of the 3 concepts appears twice.
- Manifest agrees:
  - log.md: projected_revision 29, generating_event = seq 179's event_id (17c472b4…), content_hash 34e25ca2….
  - gcs-5-supervision-ratio, tx-6-changeover…, tx-6-np-shared-j12…: each still at projected_revision 1.
- "Neither Restore nor Keep undoes seq 179" holds. resolve_restore_with (reconcile.rs:427-455) regenerates every projection from the reducer state, and that state includes seq 179. So Restore reverts the concept files but keeps log.md's Update lines, leaving a changelog that claims updates that no longer exist. Keep (resolve_accept_with) cannot undo a committed ledger event, and per the incident facts it refuses on the forged-stamp concept files anyway.
- Minor wording fix: seq 179 is an editorial override on top of belief revision 29. It does not create a new revision; the log belief's revision stays 29 and only generating_event moves.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:302-311: per-path loop over `parked`. `capture_out_of_band_with` returns Ok → captured, Err → divergent.
- src-tauri/src/ledger/capture.rs:810 and :822: `actor_id: "human:owner".to_string()`.
- capture.rs:757-783: `capture_out_of_band_with` → `diff_projection_file` → `capture_diff_with(..., OverrideOrigin::OutOfBand)`.
- src-tauri/src/ledger/reconcile.rs:427-455: `resolve_restore_with` writes `project_belief` output for every entry in `state.projection_paths`, with seq 179 already folded into that state.
- Live ledger seq 179: kind projection.overridden, actor.id human:owner, path log.md, base_belief_revision 29, after_projection_hash 34e25ca27c4e…, origin out_of_band. Its body diff adds 6 duplicated "**Update**" lines for the 3 concepts.
- Live ledger seq 180: ledger.divergence, sample_paths = those same 3 concepts.
- .cerebro/projection-manifest.json:
  - knowledge/log.md: projected_revision 29, generating_event 17c472b4d99b70fc807b0dd052b2a323, content_hash 34e25ca2….
  - The 3 concept entries: each at projected_revision 1.

</details>

### F72 — The Fleet shows '0 applied · 0 rejected' for runs that wrote 29 concepts: proposal counters are never written

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/runtime/dispatch.rs:524-538`
  - `src-tauri/src/ledger/concepts.rs:406-408`
  - `src/status/FleetSection.tsx:243`
  - `src/status/RunDetailPanel.tsx:170`

**Evidence**

All 19 `runs` rows have proposals_submitted = applied = rejected = 0. The ledger has 29 proposal.submitted and 29 proposal.applied events (Aug 16, 19:24-20:01Z) during runs 99dccac6, 49ab2e39 and 6cbeab57.

Why they never meet: the proposal run_id is derived as sha256(path, head) (concepts.rs:406), and none of those 29 ids matches any runs.run_id. The only `UPDATE runs` (dispatch.rs:525) never sets the counters.

**Impact**

This breaks 'absent is never zero': the Fleet renders a measured 0 where the true number was never recorded. The RunDetailPanel 'still waiting on a decision' link (L170) can never appear, so a queued HIGH-risk proposal from a run is unreachable from that run.

**Recommendation**

Thread the dispatcher's run_id into write_concept proposals and increment the counters on commit. Until then, render the counters as 'not recorded' instead of 0.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Confirmed: no production code path ever writes a non-zero proposals_submitted/applied/rejected to `runs`.
- Every production INSERT hardcodes 0,0,0: the ambient insert at dispatch.rs:278-283 and the attended insert at dispatch.rs:758-763.
- The only production `UPDATE runs` statements are dispatch.rs:525 (finalize: tokens and outcome) and dispatch.rs:801 (model_id and similar). Neither touches the counters. Every other INSERT is under #[cfg(test)].
- One detail is off: all 19 live rows are mode=attended, so the attended INSERT at dispatch.rs:758 wrote their zeros, not the UPDATE at L525. The conclusion is the same.
- The id mismatch is real. write_concept derives run_id = sha256_first128("cerebro-write-concept-run-v1\0{krel}\0{head_hash}") at concepts.rs:406-408. So the 29 proposal.submitted events carry 29 distinct derived ids (e8aaf2ba, 1100252b, …), and none matches a runs.run_id (99dccac6, 49ab2e39, 6cbeab57, …).
- UI impact holds:
  - FleetSection.tsx:243 renders `{run.applied} applied · {run.rejected} rejected` with no absent-state guard. Tokens get an `unknown` guard; these counters do not.
  - RunDetailPanel.tsx:170 gates its button on `proposals_submitted > applied + rejected`, which is never true. So the "still waiting on a decision" link can never render.
- Medium is right: the numbers are misleading and the link is dead, but nothing is corrupted.

**Evidence checked.** - Production writes to `runs`:
  - src-tauri/src/runtime/dispatch.rs:278-283 (ambient INSERT, `0, 0, 0` for proposals_submitted/applied/rejected)
  - dispatch.rs:758-763 (attended INSERT: `..., 0, 0, 0, 0, 0, ?12, ?13`, i.e. reserved×2 plus counters×3 all 0)
  - dispatch.rs:525 (UPDATE sets ended_at, outcome, usage_state and tokens only)
  - dispatch.rs:801 (UPDATE sets model_id, stop_reason and service_tier)
  - `grep "UPDATE runs"` finds nothing else outside tests.
- src-tauri/src/ledger/concepts.rs:406-408: run_id = sha256_first128("cerebro-write-concept-run-v1\0{krel}\0{head_hash}").
- runtime.db (queried read-only): 19 rows, all mode=attended, lane=agent, every one with proposals_submitted|applied|rejected = 0|0|0. That includes 99dccac6 (19:18-19:26Z), 49ab2e39 (19:32-19:39Z) and 6cbeab57 (19:53-20:01Z) on 2026-08-16.
- Live ledger .ndjsonl.open: Counter shows proposal.submitted = 29 and proposal.applied = 29. The 29 submitted events carry 29 distinct run_ids (e8aaf2ba, 1100252b, ac2fe333, …), none of them in `runs`. The applied events carry no run_id.
- src/status/FleetSection.tsx:243: `{run.applied} applied · {run.rejected} rejected` (unguarded; tokens get a usage-unknown guard two lines above).
- src/status/RunDetailPanel.tsx:170: `{run.proposals_submitted > run.applied + run.rejected && (<button data-testid="run-detail-to-review" …>)}`, which is unreachable.

**Correction.** The claim is right. The only wrong detail: the zeros on these 19 live rows come from the attended-run INSERT at dispatch.rs:758-763, which hardcodes proposals_submitted/applied/rejected to 0, not from the ambient finalize UPDATE at dispatch.rs:525. Neither path, nor any other production code, ever updates the counters.

</details>

### F73 — The corpus predates the description and concept-type contracts: 26/29 have no description, 16 are mistyped 'Reference', 0/29 verified

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `/Users/joseflagorio/Documents/test/knowledge/programs/rq-84b-kestrel.md:2`
  - `/Users/joseflagorio/Documents/test/knowledge/systems/ims-7.md:2`
  - `src-tauri/src/mcp.rs:2464-2466`
  - `shared/policy/concept-types.v1.json:1-22`

**Evidence**

The only ingest ran on Aug 16, 19:24-20:01Z. Two contracts landed hours later:
- dedff4b (2026-08-17T01:31Z) made `description` required.
- 2df4aa5 (01:33Z) added the Program/System/... vocabulary.

State of the base:
- 26 of 29 concepts have no `description`; only the 3 Aug 17 rewrites do.
- All 3 programs/*.md and 13 of 14 systems/*.md are `type: Reference` ("fits none of the above"), even though Program and System exist.
- There are no `verified` stamps and no belief.attested events in the 273 ledger events. 25/29 are lifecycle: stable, a value the agent set on unverified material.

The Aug 17 rewrites were effectively a description backfill (bodies unchanged), and that backfill is what tripped reconciliation.

**Impact**

Most concepts show no summary line, the type facets are wrong, and nothing has been human-reviewed after 40 days. The only backfill path, an agent rewrite, is the one that caused this incident.

**Recommendation**

Ship a ledger-routed migration that proposes description and type for pre-contract concepts as a reviewable batch. Surface the verified/unverified count on the Base page.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - Counts check out on disk: 29 concepts, 26 with no `description` (the 3 with one are the Aug 17 rewrites), all 3 programs/*.md and 13 of 14 systems/*.md are `type: Reference` (ims-7's state-latency-budget is `Metric`), none has a `verified` frontmatter key, and 25 are `lifecycle: stable` (4 draft).
- The ledger has 0 `belief.attested` events.
- Timing is right. The ingest commits run 2026-08-16 12:25–13:00 PDT (19:25–20:00Z). dedff4b and 2df4aa5 are dated 18:31 and 18:33 PDT, which is 01:31 and 01:33Z on Aug 17, so both landed after the ingest.
- mcp.rs's write_concept now requires `description` and falls back to "Reference" when no type is given. concept-types.v1.json has Program and System, with Reference as the fallback.
- The Aug 17 diff on tx-6-np-shared-j12-common-mode.md adds `description` and `stale_after`, rewrites the YAML style and changes the `generated` stamp. The first body line is unchanged, so calling it a "description backfill" is accurate.
- Overstated part: the idea that the only backfill path is an agent rewrite, and that this path caused the incident. write_concept is a ledger-routed backfill path and needs a description. The incident happened because the Aug 17 writes went around it: zero ledger events, and the `generated` stamp changed out of band, which reconcile refuses as forgery. The backfill itself was not the cause.
- Severity: this is legacy data quality, not a code defect. The contracts are simply not applied to older records. Nothing is broken or unreachable in the code. Missing verification is expected in a base that is agent-written and human-verified, where no human has verified anything yet. Low is more fitting than medium.

**Evidence checked.** - The vault knowledge/*.md frontmatter scan found `description:` in 3/29 files (decisions/gcs-5-supervision-ratio.md, risks/tx-6-changeover-..., risks/tx-6-np-shared-j12-common-mode.md).
- `type: Reference` appears in programs/{rq-84b-kestrel,tx-6-sable,uc-9-crane}.md and in 13/14 systems/*.md; systems/gcs-5-state-latency-budget.md is Metric.
- No `^verified` key appears in any file.
- Lifecycle is draft in 4 files and stable in 25.
- Event kinds in the ledger .open file: batch.committed 29, belief.created 30, belief.revised 28, vault.write 124, ledger.divergence 1, projection.overridden 1, belief.attested 0.
- Commit dates: dedff4b is 2026-08-16T18:31:43-07:00 and 2df4aa5 is 18:33:53-07:00. Vault ingest commits run from 04c2152 (12:25 PDT) to 3614cc0 (13:00 PDT).
- src-tauri/src/mcp.rs, tool_write_concept (~L2446-2470): `description` is required (ok_or refusal), and type defaults to "Reference".
- shared/policy/concept-types.v1.json: fallback is "Reference", and the types include Program and System.
- `git diff` of risks/tx-6-np-shared-j12-common-mode.md: adds description and stale_after, reformats YAML and changes `generated.at` to 2026-08-17T11:57:37Z. The body is unchanged.

**Correction.** The data claims are accurate: 26/29 have no description, 16 are typed Reference although Program or System exist (3 programs, 13 systems), 0 are verified, 0 belief.attested, and 25 are lifecycle: stable. Both contracts landed after the Aug 16 ingest. But the incident was not caused by backfill as such. An agent wrote the files directly, without write_concept, the ledger-routed tool that requires a description. That left no ledger events and an out-of-band `generated` stamp change, and that is what tripped reconciliation. A backfill through write_concept is a real path and would have gone through the ledger. This is stale legacy data, not a code defect: severity low.

</details>

### F74 — 13/29 concepts anchor to themselves and no anchor reaches outside knowledge/; KOS 3.2 shows as an open thread although a concept about it exists

- **Severity (claimed):** low
- **Category:** data-quality
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `/Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md:7`
  - `/Users/joseflagorio/Documents/test/knowledge/systems/kos-3.2-partition-architecture.md:5`
  - `/Users/joseflagorio/Documents/test/knowledge/systems/ims-7-contingency-three-layer.md:6`
  - `/Users/joseflagorio/Documents/test/knowledge/systems/ims-7-boot-chain.md:6-8`
  - `src/engine/okf.ts:259-268`

**Evidence**

13 concepts have `about:` containing their own stem: the 3 programs, 9 systems, and the gcs-5 Decision. Every resolvable anchor points into knowledge/. The anchors [[mpm-410]], [[sib-220]], [[mb-boot]] and [[kos-3.2]] dangle, while kos-3.2-partition-architecture.md is itself the KOS 3.2 concept.

okf.ts:263 calls `about` 'the join' so knowledge is not 'a parallel corpus'. In this vault that join never reaches a record. The self-anchor is also what made gcs-5 eligible for the schema recheck.

**Impact**

Knowledge never appears on any record or project page. The Threads view shows 'kos-3.2' as unnamed while its concept exists, and self-anchors make concepts sensitive to Type edits.

**Recommendation**

Have write_concept reject or warn on a self-anchor. Resolve a dangling anchor to a concept whose title or stem prefix matches it (kos-3.2 → kos-3.2-partition-architecture), or add aliases.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - The data holds up. The vault has 29 concepts (4 decisions, 3 programs, 8 risks, 14 systems; log.md excluded). 13 of them list their own stem in `about:`: the 3 programs, 9 systems (compass-gcs-5, epc-40-controller, gcs-5-client-architecture, gcs-5-control-authority, gcs-5-deployment-topology, gcs-5-state-distribution, gcs-5-state-latency-budget, ims-7, tx-6-np-shared-j12-route) and the gcs-5-supervision-ratio Decision.
- No anchor reaches a record. The only records are records/bets/test*, records/tasks/kk and records/agents/new-agent, and nothing anchors to them. Every anchor that resolves points into knowledge/.
- Four anchors dangle: mpm-410, sib-220, mb-boot and kos-3.2. The code can't match kos-3.2 to kos-3.2-partition-architecture.md. resolveTarget (wikilink.ts:58-74) matches only on the exact stem, a project.md folder, or the entry title. That concept file has no H1, so its title falls back to the humanized stem, not "kos-3.2".
- The UI path is real and reachable. listSubjects (okf.ts:388-419) keys a dangling target by its raw text and labels it that way. KnowledgeNav.tsx:121-132 renders a subject with a null entry as an OPEN THREAD (circle-dashed icon). So 'kos-3.2' shows as an open thread even though a concept about it exists.
- The schema-recheck point holds for gcs-5. jobs.ts:161-195 fires a recheck when an `about` target resolves to an entry whose type has a Type doc edited after `generated.at`. gcs-5's other anchor, compass-gcs-5, is a Reference, and there is no types/reference.md. Its self-anchor resolves to a Decision, and types/decision.md exists.
- Nuance 1: self-anchoring is not the only way in. Any anchor to a Decision concept does the same, e.g. tx-6-changeover anchors frb-118-session-1-disposition.
- Nuance 2: the code expects anchors that point into the bundle. listSubjects' comment cites `about: "[[rq-84b-kestrel]]"`, and it prefers the concept's own title for such anchors. So this is a data-quality problem in this vault, not a code defect.
- Severity low is right.

**Evidence checked.** - Frontmatter of all 29 files under /Users/joseflagorio/Documents/test/knowledge/:
  - gcs-5-supervision-ratio.md about: [[compass-gcs-5]], [[gcs-5-supervision-ratio]]
  - kos-3.2-partition-architecture.md about: [[kos-3.2]], [[ims-7]]
  - ims-7-contingency-three-layer.md about: [[ims-7]], [[kos-3.2]]
  - ims-7-boot-chain.md about: ims-7, mpm-410, sib-220, mb-boot
  - The 13 self-anchors are confirmed by inspection.
- No mpm-410/sib-220/mb-boot .md exists anywhere in the vault. kos-3.2 matches only by prefix (kos-3.2-partition-architecture.md), which has no '# ' H1.
- Non-knowledge .md files are only home/, types/, inbox/, studio/, prototypes/, records/{bets,tasks,agents}, and none of them is an anchor target.
- src/engine/wikilink.ts:58-74: resolveTarget matches exact stem, project.md folder, or entry.title.
- src/engine/okf.ts:388-419: listSubjects gives a dangling target key = target.toLowerCase(), entry null, label = raw target.
- src/knowledge/KnowledgeNav.tsx:121-132: `entry === null` is rendered as an OPEN THREAD with the 'circle-dashed' icon.
- src/engine/okf.ts:259-281 (parseAbout doc): calls about 'the join'; src/engine/okf.ts:524-546 (relatedConcepts): a note's related concepts are only those whose about resolves to that note's subjects.
- src/engine/jobs.ts:161-195: schema recheck when an about target's entry.type has a Type doc (types/decision.md exists) modified after generated.at.

</details>

### F75 — The divergence event is mislabeled and drops its reason, so the user cannot tell why capture paused

- **Severity (claimed):** low
- **Category:** recovery-ux
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:330-333`
  - `src-tauri/src/ledger/reconcile.rs:386-393`
  - `src-tauri/src/ledger/capture.rs:969-975`

**Evidence**

Seq 180 records signals [manifest_reducer_disagreement]. In fact the manifest and the reducer agree: the manifest hash equals the Aug 16 bytes that the reducer projects. Only the FILE differs. reconcile.rs:330-333 emits this signal for any non-empty `divergent` list, capture refusals included.

The per-path reason ('provenance forgery: the generated stamp changed out of band') lives in outcome.divergent but is not in the LedgerDivergence body. That body holds only counts, digests and sample_paths.

**Impact**

Neither the banner nor any later audit can explain the cause: 3 app-agent rewrites changed `generated`. That is also why 'Keep my files' is certain to fail on all 3.

**Recommendation**

Persist the per-path reason codes in the divergence body, add a distinct signal for capture refusals, and have the banner name the reason and say which exit can work.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** The claim holds up, and one detail makes it worse.
- **The label is wrong for this case.** reconcile.rs:331-332 pushes ManifestReducerDisagreement whenever `outcome.divergent` is non-empty. That list collects two different things: the classifier's own divergence reasons (L295-296) and capture refusals (L322). A refusal like "provenance forgery" comes from diff_projection_file (capture.rs:962-966). That check compares the reducer's projection with the file, not the manifest with the reducer. So in this incident the signal names a disagreement that did not happen. The closed DivergenceSignal enum (schema/reconciliation.rs:22-29) has no variant for a capture refusal or a provenance change.
- **The reason is dropped.** The LedgerDivergence body (schema/reconciliation.rs:58-69) holds only detection_key, signals, heads, digests, counts and sample_paths. It has no field for a reason. The only place the per-path reason lives is ScanOutcome.divergent (reconcile.rs:192).
- **It is not logged anywhere either.** The only production caller, shadow.rs:144, discards the whole ScanOutcome with `let _ = launch_scan(...)`, so the reason is never persisted or logged.
- **The banner cannot show it.** ReconciliationBanner.tsx shows only `status.divergences.length`.
- **One small overstatement.** sample_paths does name the three files, so a later auditor can find them and re-derive the cause by hand. They just cannot read it from the recorded event. The event is diagnostic metadata and affects no decision, so low severity is right.

**Evidence checked.** - **src-tauri/src/ledger/reconcile.rs:192**: `pub divergent: Vec<(String, String)>`, documented as "Unproven states, with the classifier's reason".
- **reconcile.rs:295-296**: classifier Divergence(reason) is pushed into divergent.
- **reconcile.rs:319-322**: `Err(reason) => outcome.divergent.push((path, reason))` for capture refusals.
- **reconcile.rs:331-332**: `if !outcome.divergent.is_empty() { signals.push(ManifestReducerDisagreement) }`, which makes no distinction between the two sources.
- **reconcile.rs:350-357**: samples take only the path from divergent (`.map(|(path, _)| path)`), and the reason is discarded.
- **reconcile.rs:373-392**: the LedgerDivergence body has no reason field.
- **schema/reconciliation.rs:22-29**: the six closed signals, none of which covers a capture or provenance refusal.
- **schema/reconciliation.rs:58-69**: the struct fields listed above.
- **capture.rs:962-966**: `if key == "generated" || key == "verified" { return Err("provenance forgery: the {key} stamp changed out of band — refused") }`.
- **shadow.rs:144**: `let _ = super::reconcile::launch_scan(...)`, the outcome with its reasons is thrown away.
- **src/app/ReconciliationBanner.tsx:46**: renders only `status.divergences.length`.

</details>

### F76 — The golden corpus (demo-vault) models none of these shapes, so tests cannot reproduce this incident

- **Severity (claimed):** low
- **Category:** test-coverage
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `demo-vault/knowledge/metrics/sync-error-rate.md:1-25`
  - `demo-vault/knowledge/systems/status-model.md:1-9`

**Evidence**

Running the same audit over demo-vault/knowledge (8 concepts): all have a `description`, all `about:` targets resolve to records outside knowledge/, there are no self-anchors, no duplicate log lines and no .cerebro/ ledger. The only flags are its intentional ones: stale dates, a supersedes edge, a prose `resource`.

**Impact**

Self-anchors, bundle-only entities, missing descriptions, Type-name collisions and ledger reconciliation are never exercised against the corpus that dev, vitest and e2e share.

**Recommendation**

Add a ledger-backed fixture vault, not demo-vault (to avoid e2e churn), with a self-anchored concept, a concept-typed about-target and a user Type named 'Decision'. Assert that no schema recheck fires and that Restore/Keep behave.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The facts about the demo-vault data hold. It has 8 concepts plus index.md and log.md. Every concept has a `description`, there is no self-anchoring `about:` and there is no `.cerebro/` directory.
- The conclusion does not hold. The claim says ledger reconciliation is never exercised against the corpus and that tests cannot reproduce the incident. Rust tests do exactly that. `corpus_copy()` copies `demo-vault/knowledge` into a temp vault. `armed()` then sets up a ledger and manifest on that copy, so the missing `.cerebro/` does not matter.
- Tests on that copied corpus already cover the incident's mechanism:
  - opening divergence and suspending capture
  - the mass-edit circuit breaker (it edits `sync-error-rate.md` and others)
  - "Keep my files" being refused by a forged provenance stamp. That test forges `verified`; the refusal branch in capture.rs is the same one that handles `generated`.
- What is really missing is narrower:
  - No test covers a single out-of-band edit, found during `launch_scan`, whose changed `generated` stamp makes capture refuse. That refusal escalates to `manifest_reducer_disagreement`, which is the live incident's exact path. The existing lone-edit test only covers a capture that succeeds.
  - The mock backend has no ledger. Its reconciliation status is hard-coded to closed, so vitest and e2e never render ReconciliationBanner or its two buttons.
  - Self-anchors, duplicate log lines and bundle-only entities are not modelled in the corpus.
- Corrected claim: the corpus does drive Rust reconciliation tests, including the forged-stamp refusal. The gaps are the scan-time path where a `generated` stamp change escalates to divergence, the banner flow in the browser (no ledger in the mock), and the data defects (self-anchor, duplicate log lines).

**Evidence checked.** - src-tauri/src/ledger/migrate.rs:675-690: `corpus_copy` copies `CARGO_MANIFEST_DIR/../demo-vault/knowledge` into a temp vault.
- src-tauri/src/ledger/reconcile.rs:1241-1252: `armed()` = `corpus_copy` + `arm()`, which asserts `manifest_created: true`.
- reconcile.rs:1348: `an_unproven_state_records_one_divergence_opens_the_mode_and_suspends_capture`. It forges the manifest entry for `knowledge/systems/status-model.md`, then asserts reconciliation is open, only one event is written, capture is refused with "reconciliation is open", and the status lists the divergence.
- reconcile.rs:~1395: `a_mass_of_out_of_band_edits_trips_the_circuit_breaker` edits 5 of the 10 corpus projections and expects the signal `mass_projection_mismatch`.
- reconcile.rs:1639: `one_forged_file_refuses_the_entire_adoption` forges `sync-error-rate.md`; `resolve_accept_with` fails with "forgery" and the mode stays open.
- src-tauri/src/ledger/capture.rs:963-966: `generated` and `verified` share one refusal branch ("provenance forgery").
- Test list in reconcile.rs: `ledger_ahead_regenerates_and_a_lone_out_of_band_edit_is_captured` covers only a capture that succeeds. No test covers a `generated` change at scan time escalating to divergence.
- src/lib/mockIpc.ts:568-593: "No ledger, no reconciliation: the mock's mode is never open"; `reconciliation_open: false`.
- demo-vault/knowledge: every concept has `description:`. The `about:` targets are record slugs such as `[[offline-sync-hardening]]`, with no self-anchors. There is no `.cerebro` in the demo-vault root.

**Correction.** The demo vault does feed the Rust reconciliation tests. Divergence, the mass-edit breaker and the forged-stamp refusal of "Keep my files" are all tested on a copy of it with a ledger set up. What no test covers: (1) a single out-of-band `generated` stamp change at scan time that escalates to `manifest_reducer_disagreement`, the live incident's exact path; (2) ReconciliationBanner in vitest/e2e, because the mock has no ledger and the mode is hard-coded closed; (3) data defects such as self-anchoring `about:` and duplicate log lines, which the corpus does not contain.

</details>
