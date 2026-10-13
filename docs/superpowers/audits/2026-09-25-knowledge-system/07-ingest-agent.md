# Ingest / distill / agent pipeline

> Audit lens `ingest-agent` · first-pass auditor, each finding adversarially verified

## Summary

The banner was caused by an agent-pipeline chain that can be traced end to end in the live vault. At 11:50:01Z the user created types/decision.md. That fired the TS schema-recheck lane, because concept types and vault Type names share a namespace and those concepts' `about:` pointed at Decision-typed concepts, one of them at itself. Six unattended Opus runs followed (two per concept, $5.20) and concluded nothing had changed: every body is byte-identical. The replace-only write_concept still rewrote the frontmatter, restamped `generated` and added 8 log lines, all through the file-first fallback with no ledger writer. The next scan correctly called that a provenance forgery. Around this chain the pipeline has more gaps: no `about`, `stale_after` or log validation; a default-on paid recheck lane that adds a second and third definition of 'stale'; native Write/Edit auto-approved for the panel and job lanes; and fleet counters that show 0 as if measured.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F55 | critical | yes | write_concept silently writes files with no ledger record when no writer is armed, and its own `generated` restamp guarantees the next scan calls that write forgery |
| F56 | high | yes | The schema-recheck lane fires when a concept's `about:` lands on a concept (or on itself) whose OKF type shares a name with a new vault Type doc. This was the trigger of the Aug 17 runs. |
| F57 | high | yes | Recheck prompts require 'change nothing else' through a replace-only tool, so every no-op recheck is a full rewrite that reshuffles fields, restamps provenance, logs an Update and demotes human review |
| F58 | high | yes | Panel and unattended knowledge-lane runs keep acceptEdits with no disallowedTools, so native Write/Edit reach knowledge/ and .cerebro/ around write_concept |
| F59 | medium | yes | `about:` is unvalidated: 13 of 29 live concepts anchor to themselves and none anchors to a vault entity, which defeats duplicate detection |
| F60 | medium | yes | The knowledge log has no dedupe and cannot tell a no-change recheck from a revision; modelled as a Belief, it grows the ledger quadratically |
| F61 | medium | yes | stale_after is agent-only and unvalidated, and 'stale' has three definitions that contradict the maintenance rule 'time is not a reason' |
| F62 | medium | yes | The stale lane can loop: runKey is the concept's mtime, so a rewrite that leaves stale_after in the past re-queues a paid recheck |
| F63 | medium | yes | Unattended knowledge spend is on by default, against the codebase's own opt-in rule |
| F64 | medium | yes | Fleet run rows show 0 proposals applied/rejected as measured, and concept writes cannot be traced to the run that made them |
| F65 | low | yes | 'Ask the agent to revise' always sends a prompt saying the recheck date has passed, even for concepts that are not stale |
| F66 | low | yes | The 'Needs review' count now counts up in the always-visible chrome, and its comment claiming otherwise was made false by M43 |

### F55 — write_concept silently writes files with no ledger record when no writer is armed, and its own `generated` restamp guarantees the next scan calls that write forgery

- **Severity (claimed):** critical
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/vault/write.rs:609`
  - `src-tauri/src/vault/write.rs:616`
  - `src-tauri/src/ledger/shadow.rs:294`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/mcp.rs:2563`
  - `src-tauri/src/ledger/capture.rs:962`
  - `src-tauri/src/ingest/commit.rs:38`
  - `src-tauri/src/mcp.rs:1691`

**Evidence**

vault::write::write_concept falls back to the legacy concept_write + shadow_write when ledger::concepts::write_concept returns None. with_writer returns None for a refused verdict or for 'a second instance that lost the lock', and shadow::record is then a silent no-op. mcp.rs:2501 always stamps generated.at = now_iso(). capture.rs:962-966 hard-refuses any out-of-band change to `generated` as 'provenance forgery'. The tool still returns 'Wrote {path}.' In contrast, ingest's ShadowCommit (commit.rs:43-49) and the propose tools (mcp.rs:1691) REFUSE when no writer is armed. Live data: 5 autosync commits (812605a..e1770e4, 11:51-11:57Z) all carry the same Cerebro-Ledger-Head 619957fc…; the ledger has zero events between seq 178 and seq 179 (the scan). The log.md lines match insert_log_entry's exact format ('* **Update**: [title](/path).'), which proves these writes came through the MCP write_concept door, not a hand edit.

**Impact**

The sanctioned agent write door creates the exact bytes the reconciler is built to reject. Any write_concept while the writer is absent (second window or instance, refused verdict) is certain to open reconciliation mode on the next launch. Because resolve_accept also runs diff_projection_file, 'Keep my files' can never succeed on these files. The agent and the user were both told the write succeeded.

**Recommendation**

Make write_concept and append_knowledge_log refuse, with a typed operational refusal, when with_writer returns None, matching ShadowCommit and the propose tools. Delete the legacy file-first knowledge branch, and its comment, for knowledge/. If a fallback must exist, it should queue a pending batch rather than write projection bytes. Surface 'no ledger writer' in the tool result.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - Read each cited path end to end; the fallback chain holds.
- vault::write::write_concept (write.rs:609-626) calls ledger::concepts::write_concept, which returns None when with_writer finds no active writer (shadow.rs:294-306). The code then runs the legacy concept_write + shadow_write.
- shadow::record returns early with no writer (shadow.rs:321-323), so nothing is recorded.
- tool_write_concept stamps generated = {by: actor, at: now_iso()} (mcp.rs ~2501) and returns "Wrote {path}." (mcp.rs ~2563).
- diff_projection_file (capture.rs ~962-966) returns Err "provenance forgery" whenever `generated` differs from the reducer's overlaid fields. A fresh `at` always differs from the committed value, so any legacy rewrite of an existing projection is refused.
- The contrast holds: ShadowCommit (ingest/commit.rs:38-49) and the propose tools (mcp.rs ~1691) turn a None from with_writer into an error; write_concept does not.
- Live data fits the path:
  - The ledger has 0 knowledge.write_concept shadow events and no events between seq 178 (a vault.write) and seq 179/180 (the scan).
  - The log.md bullets match insert_log_entry's `* **{kind}**: [{title}]({link}).` format.
  - The gcs-5 file carries generated {by: claude-code (mcp.rs:42 DEFAULT_ACTOR), at: 2026-08-17T11:52:02Z}.
- log.md itself was captured (projection.overridden at seq 179), because its `generated` did not change. That fits the claim.
- Overstatements are listed in the correction.

**Evidence checked.** - src-tauri/src/vault/write.rs:600-626: ledger-first attempt, else legacy concept_write + shadow_write (comment admits "a ledger the startup verdict refused").
- src-tauri/src/vault/write.rs:263-272: shadow_write goes to shadow::record.
- src-tauri/src/vault/write.rs:692-717: append_knowledge_log uses the same fallback.
- src-tauri/src/ledger/concepts.rs:66-79: returns None without a writer.
- src-tauri/src/ledger/shadow.rs:112-120: LedgerWriter::open(...).ok(), so a held lock or refused verdict leaves writer None.
- src-tauri/src/ledger/shadow.rs:294-306: with_writer returns None.
- src-tauri/src/ledger/shadow.rs:311-323: record is a silent no-op.
- src-tauri/src/mcp.rs:42: DEFAULT_ACTOR = "claude-code".
- src-tauri/src/mcp.rs ~2501: `frontmatter.insert("generated", json!({"by": actor, "at": now_iso()}))`.
- src-tauri/src/mcp.rs ~2563: `Ok(text_result(format!("Wrote {path}. ...")))`.
- src-tauri/src/ledger/capture.rs:936-939: a new file errors "not a committed projection".
- src-tauri/src/ledger/capture.rs:962-966: `if key == "generated" || key == "verified" { return Err("provenance forgery ...") }`.
- src-tauri/src/ledger/capture.rs:767-782: capture_out_of_band_with calls diff_projection_file.
- src-tauri/src/vault/watcher.rs:260: live capture result is discarded with `let _`.
- src-tauri/src/ingest/commit.rs:38-49: ShadowCommit errors on None.
- src-tauri/src/mcp.rs ~1691: propose errors "no active ledger writer".
- Live ledger (checked with a python scan):
  - Event-kind counts include vault.write 124, belief.* 58, projection.overridden 1, ledger.divergence 1, and knowledge.write_concept 0.
  - seq 172-178 are vault.write, then seq 179 projection.overridden and seq 180 ledger.divergence.
- Vault git log shows 5 "Update 2 notes in knowledge" commits from 04:51 to 04:57 -0700 on Aug 17.
- knowledge/log.md shows duplicated `* **Update**: [...](/risks/...).` lines.
- knowledge/decisions/gcs-5-supervision-ratio.md has `generated: {by: claude-code, at: 2026-08-17T11:52:02Z}`.

**Correction.** The mechanism is real. When no writer is armed, write_concept falls back to writing the file directly and records nothing in the ledger. The MCP tool always restamps generated.at, and diff_projection_file hard-refuses a changed `generated` field, so both the launch scan and "Keep my files" refuse the file. Three details are overstated. (1) The forgery refusal is only certain for REVISIONS of already-committed projections. A new concept hits "not a committed projection" in diff_projection_file, which is a different refusal. (2) Reconciliation mode opens at the next launch_scan only if that launch arms a writer. A persistently refused verdict never scans. If the gap came from a second instance, the first instance's live watcher capture refuses silently (`let _`) and opens nothing until a relaunch. (3) "Silent" is only partly true. ledger_status exposes a missing writer, but nothing tells the agent or the user at write time. Why the Aug 17 process had no writer (second instance, refused verdict, or another build) is not proven by this code. Severity is high rather than critical: no data is lost, but it forces a choice that throws away data.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Can it happen in the real app?** Yes. `tool_write_concept` never checks for an armed writer. `write_concept` is in `base_tools` and is always offered (`tool_catalog`). `vault::write::write_concept` quietly falls back to `concept_write` + `shadow_write` when `with_writer` returns None. `shadow::record` does nothing when there is no Active entry or `active.vault` is a different vault. The tool still returns "Wrote {path}."
- **When is there no writer?**
  - `activate()` sets `writer: None` for a refused verdict, a missing writer id, or a lost lock (a second instance: "shadow stays silent there").
  - Also reachable, and missing from the claim: `Active` is ONE global slot. If the app switches to another vault while an agent session still targets this one, `with_writer` returns None for this vault.
- **Is it guarded anywhere else?** No. The ingest `ShadowCommit` and the propose tools refuse on None, so `write_concept` is the one door that fails open.
- **Is the forgery refusal guaranteed?** `mcp.rs:2501` always restamps `generated: {by, at: now_iso()}`, and `diff_projection_file` hard-refuses any change to `generated`. So a revision of a committed concept is certain to be refused as forgery at the next scan, unless it lands in the same second as the last projection.
- **Understated part:** a NEW concept written this way skips the stamp check and still diverges. `classify_path` returns Divergence("path is unknown to both manifest and reducer"). So every `write_concept` without a writer opens reconciliation, not just revisions.
- **The live data matches the MCP path exactly:**
  - Frontmatter keys are in `tool_write_concept`'s insertion order (type, title, description, about, tags, lifecycle, generated{by: claude-code, at}, sources, stale_after).
  - Every log.md line uses `insert_log_entry`'s "* **Update**: [title](/path)." format.
  - The duplicate log lines are explained by per-commit diffs: gcs-5 in 812605a then 1c8c9e9, j12 in e3543b4 then e1770e4. Each tool call appended one log line.
  - The shadow recorded `vault.write` for this vault on Aug 16 (seq 172-178), then nothing at all, not even legacy `vault.write` events, until the 11:58:54Z launch scan. So the serving process had no Active writer for this vault.
  - The unchanged Cerebro-Ledger-Head trailer is read from disk by `useGit.withLedgerTrailer` → `ledger_head`, which fits an app instance that was running but had no writer.
- **Why high, not critical:**
  - The failure is loud at the next launch (the banner).
  - The bytes survive in vault git.
  - It needs a no-writer state, which is not the normal single-instance path.
- **What still makes it serious:**
  - The tool tells the agent and the user it succeeded.
  - Automatic capture has now been paused for about 39 days.
  - "Keep my files" also runs `diff_projection_file` (reconcile.rs:599) and cannot adopt these files. The only exit, "Restore recorded history", throws the agent's edits away.

**Evidence checked.** - src-tauri/src/vault/write.rs:600-625: `write_concept` returns early only when `ledger::concepts::write_concept` returns Some. Otherwise it runs `concept_write` + `shadow_write`. write.rs:692-720 does the same for `append_knowledge_log`, using `insert_log_entry`.
- src-tauri/src/ledger/concepts.rs:68-80: `write_concept` returns `shadow::with_writer(...)`, which is None when no writer is armed.
- src-tauri/src/ledger/shadow.rs:294-307: `with_writer` returns None when there is no Active, the vault does not match, or `writer` is None. shadow.rs:311-322: `record` silently returns in the same cases. shadow.rs:82-120: `activate` leaves `writer` None on a refused verdict or a held lock ("second instance ... shadow stays silent"). `Active` is a single global Option (`replace_active`).
- src-tauri/src/mcp.rs:2446-2560: `tool_write_concept` has no writer check. mcp.rs:2501 stamps `generated {by: actor, at: now_iso()}`. It then calls `vault::write::write_concept` and returns "Wrote {path}.".
- mcp.rs:1202-1206: `tool_catalog` always includes `base_tools` (write_concept).
- Contrast, both refuse on None: ingest/commit.rs:38-49 `.ok_or_else("no ledger writer is armed")`; mcp.rs:1691 `.ok_or_else("this vault has no active ledger writer")`.
- src-tauri/src/ledger/capture.rs:962-966: a change to `generated`/`verified` is refused as "provenance forgery".
- reconcile.rs:73-77: an unknown path is Divergence. reconcile.rs:121 classifies a changed file as OutOfBandEdit. reconcile.rs:311-325: a failed capture escalates to divergent, which raises ManifestReducerDisagreement. reconcile.rs:599: accept-current-files also calls `diff_projection_file`.
- Live vault /Users/joseflagorio/Documents/test:
  - Commits 812605a/1c8c9e9 (gcs-5 + 3 and 1 log lines), 7658504 (tx-6-changeover), and e3543b4/e1770e4 (j12) each touch one concept plus log.md. All five carry Cerebro-Ledger-Head 619957fc….
  - Frontmatter key order matches mcp.rs insertion order, with `generated.by: claude-code` and `at: 2026-08-17T11:52:02Z` / `11:57:37Z`.
  - log.md lines 4-9 are pairs of "* **Update**: [...](/...)".
  - Ledger seq 172-178 are Aug 16 `vault.write` shadow events. Seq 179 is `projection.overridden` and seq 180 is `ledger.divergence`, from the scan. There is nothing in between.
- src/git/useGit.ts:319-324: the trailer is read via `ledgerHead`, a disk read (lib.rs:1455).

</details>

### F56 — The schema-recheck lane fires when a concept's `about:` lands on a concept (or on itself) whose OKF type shares a name with a new vault Type doc. This was the trigger of the Aug 17 runs.

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src/engine/jobs.ts:168`
  - `src/engine/jobs.ts:179`
  - `src/engine/jobs.ts:189`
  - `shared/policy/concept-types.v1.json`
  - `src/lib/prompts.ts:144`

**Evidence**

jobs.ts builds typeDocs keyed by Type-doc title (L169), resolves each about target against ALL entries including knowledge/ concepts (L179), and reads entry.type, which for a concept is its OKF conceptType. concept-types.v1.json offers Decision, Risk, Issue, Action, Metric, Playbook… The live vault confirms the chain. types/decision.md was created with mtime 2026-08-17T04:50:01-0700 = 11:50:01Z. job_ledger 'attempts' rows for exactly gcs-5-supervision-ratio, tx-6-changeover-…, tx-6-np-shared-j12… all have runKey 2026-08-17T11:50:01Z. Those are the ONLY 3 of 29 concepts whose about resolves to a Decision-typed entry: gcs-5 anchors itself, and the two risks anchor [[frb-118-session-1-disposition]], a Decision concept. runtime.db holds 6 Opus runs, 11:50:08-11:57:44Z, $5.20 total, and all 3 concept bodies are byte-identical before and after.

**Impact**

Adding or editing a vault Type whose name matches one of the 14 concept types launches paid unattended rechecks of unrelated concepts. The schemaRecheckPrompt tells the model that 'a Type it references was edited' when the concept references no record of that type. Those rewrites fed directly into the divergence banner.

**Recommendation**

Restrict the schema lane to about targets that resolve OUTSIDE knowledge/, since concepts are not records of a vault Type. Never count a concept's own path. Better still, retire the TS schema and stale lanes into the M27 staleness lane / M26.6 maintenance pass as jobs.ts:32-34 already promises.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - The claim holds end to end, in both the code and the live data.
- Code path: jobQueue keys typeDocs by the Type doc's title (jobs.ts:168-169). It resolves each `about` target against every scanned entry, knowledge/ concepts included, using resolveTarget's filename-stem match (wikilink.ts:58-63). It then looks up `entry.type`, which for a concept is its own `type: Decision` frontmatter. The Type doc `types/decision.md` has the title "Decision", so a concept anchored to a Decision concept, or to itself, counts as "about a Decision record".
- Why this was the schema lane and not the stale lane: all 3 job_ledger run_keys equal the decision.md mtime, 2026-08-17T11:50:01Z. jobs.ts:189-192 only produces a run_key like that when a Type doc change is the trigger; a stale-only job uses the concept's own mtime. useJobRunner.ts:423-424 sends a `schema` job to schemaRecheckPrompt.
- Exactly 3 of 29 concepts are affected. I resolved every concept's `about` at commit f7df8b4. Only these 3 hit a Decision-typed entry: gcs-5 through itself, and the two risks through frb-118-session-1-disposition, whose type is Decision. `types/risk.md` was also created at 11:49:06Z, but nothing anchors to a Risk-typed entry, so it triggered no jobs.
- Runs table: 6 Opus 4.7 runs from 11:50:08 to 11:57:44Z. Their total_cost_micros add up to 5,200,710, about $5.20.
- Concept bodies: the text after the frontmatter hashes identically before (f7df8b4) and after (e1770e4) the runs. The runs only rewrote frontmatter (a new description, a reformatted about/tags, a new generated stamp, sources).
Corrections:
- (a) The runs are recorded as `mode='attended'`, lane `agent`, not ambient. "Unattended" is true only in the sense that the background job runner started them.
- (b) 3 jobs produced 6 runs, in start pairs about 2s apart. That points to duplicate dispatch, a separate defect this claim does not mention.
- (c) gcs-5's self-anchor `[[gcs-5-supervision-ratio]]` already existed on Aug 16 (f7df8b4). The self-reference is an older defect that made gcs-5 eligible. It was not introduced on Aug 17, which also contradicts the incident fact that `about` changed from arb-4-disposition.
- (d) Severity lowered to medium. This lane was the trigger, but the divergence banner comes from the write path that bypassed the ledger and changed the generated stamp. The trigger bug alone costs spurious paid runs (about $5 here) and prompts that describe a schema change that does not apply to the concept. That is real, but it is not what breaks the ledger.

**Evidence checked.** - /Users/joseflagorio/Development/cerebro/src/engine/jobs.ts:168-169: `if (e.type === 'Type') typeDocs.set(e.title, e)`
- jobs.ts:179-181: `resolveTarget(target, all)` then `typeDocs.get(entry.type)`
- jobs.ts:189-192: runKey is the type-doc mtime when that is newer than the concept's mtime
- /Users/joseflagorio/Development/cerebro/src/engine/wikilink.ts:58-63: matches on the filename stem
- /Users/joseflagorio/Development/cerebro/src/agent/useJobRunner.ts:423-424: `schema` jobs use schemaRecheckPrompt
- /Users/joseflagorio/Development/cerebro/src/lib/prompts.ts:146: "a Type it references was edited"
- Live vault: `types/decision.md` has `type: Type`, H1 "Decision", mtime 2026-08-17T04:50:01-0700 (11:50:01Z), and was added in commit f7df8b4. `types/risk.md` mtime is 11:49:06Z.
- runtime.db job_ledger: 3 `attempts` rows (gcs-5-supervision-ratio, tx-6-changeover…, tx-6-np-shared-j12…), all with run_key 2026-08-17T11:50:01Z
- runtime.db runs: 6 rows, mode attended, lane agent, model claude-opus-4-7, started 11:50:08 to 11:54:54Z, total_cost_micros summing to 5,200,710
- Python pass over the 29 generated concepts at f7df8b4: only these 3 resolve an `about` target to a Decision-typed entry (gcs-5 itself; frb-118-session-1-disposition is `type: Decision`), and none resolve to a Risk-typed entry
- Body hashes after the frontmatter, f7df8b4 vs e1770e4: identical for all 3 files
- `git show f7df8b4~1:knowledge/decisions/gcs-5-supervision-ratio.md`: `about` already lists `[[gcs-5-supervision-ratio]]` on Aug 16

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Code path:** in jobs.ts, `typeDocs` is keyed by the Type doc's title (L168-170), and each `about` target is resolved against all entries, knowledge/ concepts included (L179, `resolveTarget` in wikilink.ts:58). The lookup then uses `entry.type` (L181). A concept's `entry.type` is its frontmatter `type: Decision|Risk`, the OKF type. So if a vault Type doc titled "Decision" is edited after a concept's `generated.at`, every concept whose `about` resolves to a Decision-typed entry becomes kind 'schema'.
- **Prompt:** useJobRunner.ts:423 sends kind 'schema' to `schemaRecheckPrompt`. That prompt (prompts.ts:144) tells the model "a Type it references was edited".
- **Timing:** types/decision.md was added in f7df8b4 (04:50:05-0700), mtime 11:50:01Z. types/risk.md was added at 11:49:06Z.
- **Which concepts matched:** I scanned all 29 concepts. Exactly 3 have an `about` that resolves to a Decision or Risk entry:
  - gcs-5-supervision-ratio points at itself.
  - The two tx-6 risks point at frb-118-session-1-disposition, which is a Decision.
  - No concept's `about` resolves to a Risk entry, which is why the Risk Type doc triggered nothing.
- **job_ledger confirms the trigger:** its attempts rows for exactly those 3 paths have run_key 2026-08-17T11:50:01Z. That is the Type doc's mtime, not the concepts' own Aug 16 mtimes, so `newestTypeChange` is what fired them.
- **Runs table matches:** 6 claude-opus-4-7 runs between 11:50:08 and 11:57:44Z, costing 5,200,710 micros ($5.20).
- **Bodies unchanged:** diffing f7df8b4 against e1770e4, all 3 bodies are byte-identical. Only the frontmatter was reformatted, plus `description`, `generated.at` and `stale_after` changes. That is the "Still true / extend `stale_after`" verdict, and it still led to a write that restamped `generated`.
- **No guard found:** nothing checks whether the resolved entry is a record rather than a concept, or keeps OKF concept types out of the Type doc namespace. The trigger is reachable, and it demonstrably fired.

**Evidence checked.** - **Trigger code:** src/engine/jobs.ts:168-170, where typeDocs is keyed by `e.title` when `e.type==='Type'`. At jobs.ts:179-182, `resolveTarget(target, all)` is followed by `typeDocs.get(entry.type)` and the mtime-vs-`generatedAt` check.
- **Resolver:** src/engine/wikilink.ts:58-74 matches on filename stem, so concepts resolve.
- **Prompt routing:** src/agent/useJobRunner.ts:423-424 sends kind 'schema' to `schemaRecheckPrompt`. The prompt is at src/lib/prompts.ts:144.
- **Type docs:**
  - Vault types/decision.md mtime is 2026-08-17T04:50:01-0700, added in commit f7df8b4.
  - types/risk.md mtime is 04:49:06-0700, commit 90437f4.
- **Pre-run concept:** in f7df8b4, knowledge/decisions/gcs-5-supervision-ratio.md already has `about: [[compass-gcs-5]], [[gcs-5-supervision-ratio]]` and `generated.at` 2026-08-16T19:38:29Z.
- **Concept scan:** a Python pass over all 29 concepts found only gcs-5-supervision-ratio (self), tx-6-changeover-… and tx-6-np-shared-j12-… (frb-118-session-1-disposition, a Decision) hitting a Decision or Risk target.
- **job_ledger:** attempts rows for exactly those 3 paths, run_key=2026-08-17T11:50:01Z.
- **runs table:** 6 rows, lane=agent, mode=attended, model claude-opus-4-7. Started 11:50:08.038Z to 11:54:54.783Z, ended by 11:57:44.893Z. `total_cost_micros` sums to 5,200,710.
- **Body hashes:** body-after-frontmatter shasum is identical at f7df8b4 and e1770e4 for all 3 files (09a21da…, ede9f64…, 2eb5a6e…).
- **Frontmatter diff:** adds `description`, restamps `generated.at` to 2026-08-17T11:52:02Z, and moves `stale_after` from 2027-07-31 to 2027-10-31.

**Correction.** The mechanism and the Aug 17 attribution both hold. Three details need correcting, and severity is overstated:
- **Self-reference was already there:** gcs-5's self-referencing `about:` existed before the runs (it is in f7df8b4^, generated 2026-08-16T19:38:29Z). The run did not create it; it is what made gcs-5 match the new Decision Type doc.
- **Mode:** the runtime.db `runs` rows say mode='attended', lane='agent'. They were not recorded as 'ambient', even though the job queue launched them with no human action.
- **"Unrelated" is a stretch:** these concepts are OKF `type: Decision` concepts, or point at one. The actual defect is a namespace collision: the OKF concept type and the vault record Type share one `entry.type` lookup, so a new Type doc named after an OKF type counts as a schema change for those concepts.
- **Blame for the banner:** the recheck lane only caused the runs. What produced the divergence is that the writes skipped the ledger and restamped `generated.at` (the capture refused it as provenance forgery). That is a separate, more severe defect.
- **Cost:** the trigger itself cost $5.20 in 6 wasted Opus runs, plus metadata-only churn. That rates medium, not high.

</details>

### F57 — Recheck prompts require 'change nothing else' through a replace-only tool, so every no-op recheck is a full rewrite that reshuffles fields, restamps provenance, logs an Update and demotes human review

- **Severity (claimed):** high
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src/lib/prompts.ts:125`
  - `src/lib/prompts.ts:150`
  - `src-tauri/src/mcp.rs:841`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/mcp.rs:2546`
  - `src/engine/okf.ts:164`
  - `src/engine/okf.ts:190`

**Evidence**

The prompts say '**Still true** — extend `stale_after` with write_concept and change nothing else', but write_concept is 'Create or replace'. Frontmatter is rebuilt only from args, so the model must re-type about, tags, sources, description and title from memory, and any omitted field is dropped. Aug 17 diffs show exactly this. Bodies were unchanged, but gcs-5 `about` went [[gcs-5-supervision-ratio]] → [[arb-4-disposition]] (11:51:31Z) → [[gcs-5-supervision-ratio]] (11:52:02Z), `description` was added, all YAML was reflowed, and generated.at was restamped. Two runs per concept overlapped, and the last writer won with contradictory values, because write_concept carries no expected version of what the agent read. After any revision, reviewStatus() returns 'predates_current', so a human verification is demoted.

**Impact**

A verdict of 'nothing changed' produces churn, provenance restamps, spurious 'Update' log entries, and on the ledger path it silently revokes human review, putting the concept back in Needs review. Off-ledger, the same writes are what trip the forgery rule. Parallel runs can flip anchors back and forth.

**Recommendation**

Add a narrow `recheck_concept {path, verdict, stale_after, expected_version}` tool, or a patch mode on write_concept, that records a verdict without rewriting content. Do not restamp `generated` or log 'Update' when content and fields are unchanged. Require an expected_version from the agent's read and reject stale writes.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The mechanism is real. `write_concept` is the only way an agent can write to knowledge/, because `update_frontmatter` and `append_to_note` both go through `guard_agent_write`, which refuses any knowledge/ path.
- `write_concept` rebuilds the frontmatter from the call's arguments alone. Nothing is merged from the file on disk, so a field the model leaves out is dropped.
- It always sets `generated.at` to the current time. On the ledger path, `revision_ops` compares values and turns an omitted stored key into `Missing`. Only `aliases` is carried forward. So a "still true" recheck can never be a no-op: the `ops.is_empty()` short-circuit never fires, and every call appends an **Update** line to the log.
- The Aug 17 vault history matches the claim exactly:
  - `about` went gcs-5 (Aug 16) → arb-4-disposition (812605a, 11:51:31Z) → gcs-5 (1c8c9e9, 11:52:02Z).
  - The two runs set contradictory `stale_after` values: 2028-02-28, then 2027-10-31.
  - `description` was added, the YAML was reflowed and `generated.at` was restamped. The body did not change.
  - log.md has a duplicate **Update** line for each of the 3 concepts.
  - Nothing ties the write to the version the agent read.
- One correction to the verifier's facts: the Aug 16 version already had the self-referencing `about`. The Aug 17 edit did not introduce it.
- Overstated: "silently revokes human review" on the ledger path. Policy v3 escalates `target_has_attestation` to HIGH. So rewriting a verified concept is **queued for review**: the agent gets a `queued_for_review:` error and nothing changes on disk. The review is marked as predating the current revision (`reduce.rs` `apply_review_overlay`) only after a human approves.
- So the real harm on the ledger path is that every "still true" recheck of a verified concept creates a HIGH review card. Approving that card, which carries no real change, demotes the review. That is noisy and misleading, but it is not silent.
- For unverified concepts, and for the off-ledger legacy path, the churn is ungated.
- Also unconfirmed: that these particular Aug 17 writes came from the recheck prompts. The `stale_after` of 2027-07-31 had not passed, so they may have come from a manual Recheck or a schema recheck. The mechanism holds either way.
- 812605a has no `description`, but the description requirement landed in dedff4b, about 10h earlier. The running binary was probably older than that commit.

**Evidence checked.** - src/lib/prompts.ts:125,150 — "extend `stale_after` with write_concept and change nothing else".
- src-tauri/src/mcp.rs:841 — the tool is described as "Create or replace".
- src-tauri/src/mcp.rs:2448-2503 — frontmatter is built only from args; `generated` = {by: actor, at: now_iso()}; `verified` is never accepted.
- src-tauri/src/mcp.rs:2546 — `append_knowledge_log` runs on every write.
- src-tauri/src/knowledge.rs:215-220 — `guard_agent_write` refuses knowledge/ paths, so `update_frontmatter` and `append_to_note` cannot patch `stale_after`.
- src-tauri/src/vault/write.rs:600-625 — ledger-first, with a legacy file-first fallback.
- src-tauri/src/ledger/concepts.rs:642-790 — `revision_ops` is a value diff; an omitted key becomes `after: Missing`; only `aliases` is carried forward.
- src-tauri/src/ledger/concepts.rs:351 — `ops.is_empty()` no-op; unreachable here because of the `generated.at` restamp.
- shared/policy/policy.v3.json:124-125 — the `target_has_attestation` escalator sets a HIGH floor.
- concepts.rs test `a_later_revision_renders_the_predating_notice_and_keeps_the_attestation` (~L1193-1255) — the rewrite of a verified concept is `queued_for_review` (HIGH), the file is unchanged, and it shows "attestation predates revision" only after `approve_and_resolve`.
- reduce.rs:421-449 — `apply_review_overlay`.
- src/engine/okf.ts:190 — `reviewStatus` returns `predates_current`.
- Vault git (/Users/joseflagorio/Documents/test), gcs-5-supervision-ratio.md:
  - 812605a~1: `about` = compass-gcs-5 + gcs-5-supervision-ratio; `stale_after` 2027-07-31.
  - 812605a: `about` = arb-4-disposition, no `description`, `at` 11:51:31Z, `stale_after` 2028-02-28.
  - 1c8c9e9: `about` = gcs-5-supervision-ratio, `description` added, `at` 11:52:02Z, `stale_after` 2027-10-31.
  - The diff is frontmatter only.
- log.md at e1770e4, lines 4-9: two **Update** lines for each of the 3 concepts.

**Correction.** The mechanism holds. Recheck prompts ask the agent to change nothing else, but `write_concept` replaces the whole file and rebuilds frontmatter from the arguments alone. So every recheck restamps `generated.at`, drops any field the model leaves out, and logs an **Update**. The Aug 17 edits show anchor flip-flops and contradictory `stale_after` values from overlapping runs, with no check against the version the agent read. On the ledger path, human review is NOT silently revoked. Rewriting a verified concept hits the `target_has_attestation` HIGH escalator and is queued for human approval, and the agent gets a `queued_for_review` error. The harm is a spurious HIGH review card for every "still true" recheck, and approving that no-op change demotes the review to "predates revision". Without review, the churn is ungated on unverified concepts and on the off-ledger path. The claim that these Aug 17 writes came from recheck prompts is plausible but unproven, because `stale_after` 2027-07-31 had not passed.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** Mechanism is real. The recheck prompts ask for "change nothing else", but the only tool that can write to knowledge/ replaces the whole concept. Every recheck therefore becomes a full revision: generated.at is always restamped, so a write is never a byte-level no-op, and an Update log line is always appended.

Three parts of the claim are overstated or unverified:
(1) "Silently revokes human review" is wrong on the ledger path. A revision of an attested concept trips the policy escalator target_has_attestation, which raises it to HIGH. The write is then queued_for_review and waits for human approval; nothing is silently demoted. The concept reads 'predates_current' only after a human approves the change. Also, the live vault has ZERO verified concepts, so no demotion happened in this incident.
(2) "Two runs per concept overlapped" is not shown. The two gcs-5 writes are 31s apart. They could come from one run writing twice. The job runner uses one shared agent stream, so parallel job runs are unlikely.
(3) The forgery trip happened because the writes took the legacy file-first path with no active ledger writer. The prompt/tool mismatch is not the cause. Replace semantics make every such write restamp generated, so they make it certain the refusal fires, but the root cause is the missing writer.

Confirmed details: omitted fields are dropped on both paths (only aliases carry forward). write_concept takes no expected version, so the last writer wins. The Aug 17 diffs match the claim: bodies unchanged, about went gcs-5 → arb-4 → gcs-5 (the self-reference was already there on Aug 16), description was added, the YAML was reflowed, stale_after went 2027-07-31 → 2028-02-28 → 2027-10-31, and the log got a duplicate Update line.

**Evidence checked.** - src/lib/prompts.ts:125 and :150: both say "extend `stale_after` with write_concept and change nothing else". Callers: useJobRunner.ts:424-426 (stale/schema jobs) and KnowledgePage.tsx:661 (the Ask agent button, which fires whether or not the concept is stale).
- src-tauri/src/mcp.rs:841: write_concept is described as "Create or replace".
- mcp.rs:2402-2423 update_frontmatter and mcp.rs:2426ff append_to_note: both call knowledge::guard_agent_write (knowledge.rs:215), which refuses every knowledge/ path. So no patch route exists for agents.
- mcp.rs:2468-2508: frontmatter is built only from args, and `generated.at` is always now_iso(). mcp.rs:2546: append_knowledge_log(existed) always runs.
- ledger/concepts.rs:731-750 revision_ops: every stored key missing from args is patched to Missing (only aliases carry forward, :659-664). There is no base-version check.
- ledger/concepts.rs:1208-1227 test plus shared/policy/policy.v3.json:124 escalator target_has_attestation → floor HIGH: rewriting a verified concept is queued_for_review, not applied silently. reduce.rs:426-449 renders the 'predates revision' notice only after the revision is applied.
- Live vault: `grep -rl '^verified' knowledge` returns nothing, so no concept is human-verified.
- Vault git 812605a / 1c8c9e9: the diffs confirm the claim's details (bodies unchanged, about reverted to the pre-existing self-reference, description added, YAML reflowed, stale_after flip-flopped, duplicate Update line).
- The Aug 16 stale_after was 2027-07-31, not yet passed on Aug 17. The trigger was therefore a schema recheck or the manual Ask agent button, not an expired stale date.

**Correction.** Real, medium severity. Agents cannot patch knowledge/: update_frontmatter and append_to_note are both refused there. A "still true, extend stale_after" verdict must therefore go through write_concept as a full replace. That restamps generated.at, drops any field the model forgets (only aliases carry forward), logs an Update, and has no expected-version check (last writer wins).

On the ledger path, rewriting a verified concept is raised to HIGH (target_has_attestation) and queued for human approval. It is not a silent revocation. The live vault has no verified concepts, so no review was demoted in this incident.

The forgery trip comes from the off-ledger write path; replace semantics only make every such write guaranteed to trip it. "Parallel overlapping runs" is not demonstrated.

</details>

### F58 — Panel and unattended knowledge-lane runs keep acceptEdits with no disallowedTools, so native Write/Edit reach knowledge/ and .cerebro/ around write_concept

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/medium, confirmed/high)
- **Locations:**
  - `src-tauri/src/agent/mod.rs:150`
  - `src-tauri/src/agent/mod.rs:660`
  - `src-tauri/src/agent/mod.rs:665`
  - `src-tauri/src/agent/mod.rs:674`
  - `src/agent/useJobRunner.ts:508`
  - `src/agent/systemPrompt.ts:33`

**Evidence**

build_args withdraws Read/Write/Edit and uses permission-mode default ONLY when req.internal. internal is set only by Rust-constructed ingest, maintain and assembly requests (skip_deserializing). The code's own comment says 'acceptEdits auto-approves built-in writes'. The TS stale/schema/refresh lanes run with attended:false and lane: job.kind but internal=false, so they get acceptEdits. The refresh lane handles externally fetched content. The knowledge system-prompt fragment never says knowledge/ may only be written through write_concept, and never forbids Edit/Write on knowledge/, log.md or .cerebro/. The M17.1 test (mcp.rs 'the_agent_cannot_route_around_write_concept') covers only the MCP doors.

**Impact**

The rule 'knowledge/ writes only via write_concept' is enforced on MCP tools but not on the CLI's built-ins. A model, or a prompt injection in a cached source, can edit concepts, forge `generated`, append to log.md, or touch .cerebro/projection-manifest.json. Every such edit lands as out-of-band or forgery, which opens reconciliation mode.

**Recommendation**

Treat cerebro-initiated knowledge lanes (stale, schema, refresh, distill buttons) as internal for build_args purposes. At minimum, always pass --disallowedTools Write,Edit,MultiEdit,NotebookEdit unless the run explicitly declares shell. Add a line to the knowledge prompt fragment that knowledge/ is written only through write_concept.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The mechanism is real.** `build_args` only withdraws the CLI's built-in tools and drops to `--permission-mode default` when `req.internal` is true. Every other run gets `acceptEdits` and no `--disallowedTools`. `--allowedTools` only lists tools that skip the approval prompt; it does not take tools away. The code's own M31.1a comment says `acceptEdits` auto-approves built-in writes inside the cwd, and the cwd is the vault.
- **Only three runs are internal.** `internal: true` is set only at ingest/spawn.rs:174, maintain/live.rs:133 and assembly/live.rs:163.
- **The knowledge-lane jobs are not internal.** The TS jobs `stale`, `schema` and `refresh` run with `attended:false`, `lane: job.kind` and `capabilities:['knowledge']`, so they get `acceptEdits`. The `refresh` job re-fetches cached external sources through connectors.
- **The prompt never forbids editing knowledge/ directly.** The knowledge fragment in systemPrompt.ts has no rule against Edit/Write on `knowledge/`, `log.md` or `.cerebro/`.
- **A mislabel in the code.** The comment at mod.rs:150-158 calls the non-internal callers "user-authored (panel, scheduled Agent records)". But stale, schema and refresh are cerebro-generated background jobs (engine/jobs.ts), not user-authored. That is the real gap.
- **Overstated: the panel.** The panel keeping `acceptEdits` is a documented, deliberate choice for turns the user is watching.
- **Overstated: the link to this incident.** The data points to `write_concept`, not native Write/Edit, as the source of the Aug 17 edits:
  - `generated.by: claude-code` is the MCP server's own stamp (`DEFAULT_ACTOR`, mcp.rs:42).
  - The log.md diff matches `insert_log_entry` byte for byte: a newest-first `## 2026-08-17` heading, then `* **Update**: [title](/path.md).`
  - The duplicate Update lines are what repeated `write_concept` calls produce.
  - `vault::write::write_concept` (write.rs:600-627) falls back to a file-first path that records nothing in the ledger when no ledger writer is active, and `tool_write_concept` writes log.md directly either way.
  - So the incident most likely came from `write_concept` running with no active ledger writer, not from native tools getting around it.
- **Severity: medium.** The hole exists and can be exploited (for example by prompt injection through refreshed source content in an unattended run). It is not shown to have caused this banner.

**Evidence checked.** - src-tauri/src/agent/mod.rs:661-674: `if req.internal { --permission-mode default; --disallowedTools INTERNAL_DISALLOWED } else { --permission-mode acceptEdits }`. Comment at L664: "acceptEdits auto-approves built-in writes, so both are withdrawn".
- src-tauri/src/agent/mod.rs:560-588: `tool_policy` grants only MCP tools, plus Bash/Read/Write/Edit/Glob/Grep when `shell` is on. It is an auto-approve list, not a restriction.
- `internal: true` appears only at assembly/live.rs:163, ingest/spawn.rs:174 and maintain/live.rs:133.
- src/agent/useJobRunner.ts:474: `capabilities: job.kind === 'agent' ? ... : ['knowledge']`. Around L510: `attended: false, lane: job.kind`. `internal` is never set from TS (`skip_deserializing`).
- src/engine/jobs.ts:141-158: `refresh` jobs are derived from `sources/` entries past `stale_after`. They are cerebro-generated, not user records.
- src/agent/systemPrompt.ts:33-40: the knowledge fragment has no ban on Edit/Write to knowledge/, log.md or .cerebro/.
- Evidence against the incident link:
  - mcp.rs:2498: `tool_write_concept` stamps `generated: {by: actor}`, with `DEFAULT_ACTOR = "claude-code"` at mcp.rs:42.
  - mcp.rs:2542: log.md is appended via `append_knowledge_log`, and knowledge.rs:286 `insert_log_entry` produces the format `* **Update**: [title](/path.md).`
  - Vault commit 812605a's log.md diff shows exactly that format.
  - vault/write.rs:609-626: `write_concept` goes through the ledger only if `ledger::concepts::write_concept` returns `Some`, i.e. a ledger writer is active. Otherwise it falls back to the legacy file-first `shadow_write` path.

**Correction.** The mechanism is real: every non-internal run keeps `acceptEdits` with no `--disallowedTools`, so native Write/Edit are auto-approved anywhere in the vault, including knowledge/, log.md and .cerebro/. The real gap is the unattended, cerebro-generated knowledge lanes (stale, schema, refresh), which the code wrongly groups with "user-authored" runs. The panel's `acceptEdits` is a documented choice for turns a person is watching. This mechanism most likely did NOT cause the Aug 17 divergence: the `generated.by=claude-code` stamp and the log.md lines match `write_concept`'s own server-side output. That points to `write_concept` running with no active ledger writer, on the file-first path that records no ledger event.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Code confirms the claim.** In `build_args`, only `req.internal` runs get `--permission-mode default` plus `--disallowedTools` (which withdraws Read, Write, Edit, Bash and the other built-ins). Every other run gets `--permission-mode acceptEdits` and no disallowed list.
- **`internal` cannot be set from TS.** It is `skip_deserializing`, and only three Rust call sites set it to true: `ingest/spawn.rs:174`, `maintain/live.rs:133` and `assembly/live.rs:163`.
- **Panel and job-runner runs are not internal.** That covers the distill prompt ("Learn from the note…", `src/lib/prompts.ts:17`) and the TS job-runner lanes (refresh, stale, schema, agent). They run with acceptEdits and no deny list.
- **`--allowedTools` does not block Write or Edit.** It only lists MCP tools, plus shell tools when shell is on. It pre-approves tools and does not shrink the toolset. Under acceptEdits, Write and Edit inside the cwd (the vault) are auto-approved.
- **Nothing else guards this path.** No Cerebro hook or deny rule applies; `--setting-sources user` is the only settings input. The knowledge prompt fragment in `systemPrompt.ts` never says knowledge/ may only be written through `write_concept`.
- **Live data shows the path is used.** The one surviving CLI transcript for this vault is a non-internal distill run from 2026-08-16. It called built-in `Read` ×5 on `knowledge/*.md` and `log.md`, `Bash` (ls of `knowledge/`) and a general-purpose `Agent`, alongside `mcp__cerebro__write_concept` ×6. All of these succeeded without a permission error. That transcript has no Write or Edit call.
- **Aug 17 link is likely but unproven.** The Aug 17 transcripts that would show who made those edits are gone. Still, the evidence fits this path: `generated: {by: claude-code}` restamped, zero ledger events, and autosync commits. So this is the likely root cause of the live divergence, not a proven one.
- **The impact is slightly overstated.** Not every bypass edit opens reconciliation mode. A plain out-of-band edit is captured quietly, as `log.md` was at seq 179 (`projection.overridden`, origin `out_of_band`). Only edits that change the `generated` stamp, or that the reducer cannot explain, fail as forgery and open the mode. The core claim still stands, and high severity is right given the live incident.

**Evidence checked.** - `src-tauri/src/agent/mod.rs:650-674`: `if req.internal { --permission-mode default, --disallowedTools INTERNAL_DISALLOWED } else { --permission-mode acceptEdits }`. The comment there reads "acceptEdits auto-approves built-in writes, so both are withdrawn".
- `src-tauri/src/agent/mod.rs:150-159`: `#[serde(skip_deserializing)] pub internal: bool`.
- Search for `internal: true` finds only `ingest/spawn.rs:174`, `maintain/live.rs:133` and `assembly/live.rs:163`.
- `src-tauri/src/agent/mod.rs:560-588` (`tool_policy`): `--allowedTools` lists only MCP tools, plus Bash/Read/Write/Edit when shell is on.
- `src/agent/useJobRunner.ts:~488-512`: job runs send `attended:false` and `lane: job.kind`, with no internal flag.
- `src/agent/systemPrompt.ts:33-36`: the knowledge fragment has no rule restricting knowledge/ writes to `write_concept`.
- Live transcript `~/.claude/projects/-Users-joseflagorio-Documents-test/638cbe80-….jsonl`, 2026-08-16T19:53Z, distill prompt: tool counts Read 5, Bash 1, Agent 1, `write_concept` 6. `Bash` ls of `/Users/joseflagorio/Documents/test/knowledge/` returned output with `is_error` None. `Read` of `knowledge/log.md` and concept files succeeded.
- Vault git history on 2026-08-17 04:49-04:57 PDT: autosync commits "Update 2 notes in knowledge" ×5.

</details>

### F59 — `about:` is unvalidated: 13 of 29 live concepts anchor to themselves and none anchors to a vault entity, which defeats duplicate detection

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/mcp.rs:847`
  - `src-tauri/src/mcp.rs:2484`
  - `src-tauri/src/knowledge.rs:48`
  - `src/lib/prompts.ts:23`
  - `src-tauri/src/ledger/concepts.rs:290`

**Evidence**

tool_write_concept copies `about` verbatim (mcp.rs:2484-2486), and no code in mcp.rs, knowledge.rs, ledger/concepts.rs or okf.ts rejects a self-link. intended_relations silently drops self-edges for supersedes/refines/contradicts (concepts.rs:290) but not for about. Live vault scan: 29 concepts; about targets resolve to 13 self, 41 other concepts, 0 vault entities, 8 unresolved. Prompt pressure: 'Anchor every concept with `about`' (prompts.ts:23) and 'Anchor every concept you can' (mcp.rs:850). near_duplicates only warns when a new concept shares an about anchor with an old one (knowledge.rs:95-100), and self-anchors are unique per file, so they never match.

**Impact**

Self-anchors add a Thread named after the concept itself and feed the schema-lane misfire. They also switch off the one guard against the 'fourth concept about the same thing' failure. M8.1's goal of knowledge reaching the project page never happens in this vault.

**Recommendation**

Refuse, or strip with a note in the tool result, any about target that resolves to the concept's own path. Warn when every anchor resolves inside knowledge/. Reword the prompts: when no vault entity exists, leave `about` empty or unresolved rather than self-anchoring. Run the dedup check on title overlap alone when the anchors are all self or concept links.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - Code facts hold. `about` is copied into the file exactly as the agent sent it. Nothing in mcp.rs, knowledge.rs or the mock rejects a concept that anchors to itself. `intended_relations` drops self-edges only for supersedes, refines and contradicts; `about` is not in that loop.
- The data numbers hold exactly when I recount them from the live vault: 29 concepts; `about` targets are 13 self, 41 other concepts, 0 vault entities and 8 unresolved (mpm-410 ×3, sib-220 ×2, kos-3.2 ×2, mb-boot ×1).
- Overstated: "defeats duplicate detection" and "switches off the one guard". `near_duplicates` fires when two concepts share any one anchor and have similar titles. 10 of the 13 self-anchored concepts also anchor to a shared hub concept, so they can still be matched through that hub. Only the 3 program hubs (tx-6-sable, uc-9-crane, rq-84b-kestrel) anchor to nothing but themselves. A new duplicate of one of those would be anchored under its own new name, so the guard would miss it. The guard is weakened for those 3, not switched off.
- Why nothing anchors to a vault entity: the vault has almost no entities that fit. Outside knowledge/ there are only inbox captures, test stubs (records/bets/test.md, tasks/kk.md, agents/new-agent.md) and types. The agent made hub concepts (compass-gcs-5, tx-6-sable, ims-7) to stand in for the missing program and system records. So "0 entities" mostly reflects the vault's contents, not a code defect. Still, M8.1's link from knowledge to project pages cannot happen here.
- The "Thread named after itself" and "schema-lane misfire" impacts were not checked; the evidence given does not support them.
- Real defect, but small: no check at the schema boundary for self-anchors or unresolved `about` targets (8 dangling links). Severity: low, not medium.

**Evidence checked.** - src-tauri/src/mcp.rs:2484-2486: `if let Some(about) = args.get("about") { frontmatter.insert("about", about.clone()) }`. Copied as sent.
- src-tauri/src/mcp.rs:2521-2536: `about` goes to `near_duplicates` unfiltered.
- src-tauri/src/knowledge.rs:49-106: returns nothing when `about` is empty; otherwise a match needs title overlap ≥0.5 AND one shared normalized anchor.
- src-tauri/src/ledger/concepts.rs:278-290: the self-edge filter (`target != from_belief`) covers only supersedes, refines and contradicts.
- src/lib/prompts.ts:23 says "Anchor every concept with `about`"; mcp.rs:850 says "Anchor every concept you can".
- Live vault /Users/joseflagorio/Documents/test/knowledge, recounted with a python scan: self=13, concept=41, unresolved=8, entity=0.
  - Self-only: programs/tx-6-sable.md, uc-9-crane.md, rq-84b-kestrel.md.
  - Self plus a shared hub (still matchable): e.g. systems/gcs-5-*.md (anchor compass-gcs-5); decisions/gcs-5-supervision-ratio.md ([[compass-gcs-5]] plus self, from the Aug 17 out-of-band edit).
- Non-knowledge .md files in the vault: home/untitled.md, types/*.md, inbox/capture-2026-08-16-*.md, records/{bets/test*.md, tasks/kk.md, agents/new-agent.md}. None is a plausible program or system entity.

**Correction.** `about` gets no checks at all: nothing rejects a self-anchor or a target that does not exist. In the live vault 13 of 29 concepts list themselves among their anchors and 8 anchors point at nothing. Duplicate detection is weakened only for the 3 program-hub concepts whose only anchor is themselves. The other 10 self-anchored concepts share a hub anchor that `near_duplicates` still matches on. No concept anchors to a vault entity mainly because the vault has almost no relevant entities; the agent built hub concepts in their place. Severity: low.

</details>

### F60 — The knowledge log has no dedupe and cannot tell a no-change recheck from a revision; modelled as a Belief, it grows the ledger quadratically

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/knowledge.rs:287`
  - `src-tauri/src/mcp.rs:2546`
  - `src-tauri/src/ledger/concepts.rs:800`
  - `src-tauri/src/ledger/concepts.rs:840`

**Evidence**

insert_log_entry prepends a bullet with no check for an identical line under the same date heading. tool_write_concept logs on every successful write, whatever the verdict. Live log.md has 3 exact duplicate pairs on 2026-08-17 (gcs-5 ×2, changeover ×2, j12 ×2) and 8 'Update' lines for writes whose bodies did not change. In the ledger path each append is a belief.revised carrying the FULL log body as before and after (concepts.rs:840). In the live ledger, 29 knowledge-log events make up 104,827 of 445,541 bytes (23.5%). All 28 belief.revised events in the store are log.md, and no concept was ever revised.

**Impact**

The changelog can no longer answer 'is this actually learning anything', because duplicates and no-op rechecks read as revisions. Because log.md is modelled as a belief, it takes part in divergence (seq 179 overrode log.md), and ledger size grows O(n²) with activity.

**Recommendation**

Make the log append idempotent per (date, kind, path). Log 'Rechecked' (or nothing) when the content and fields hash is unchanged. Record log entries as structured events, or derive log.md as a view, rather than as full-body belief revisions.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Confirmed: the ledger grows quadratically.** Every log append is a `belief.revised` whose patch carries the full old log body and the full new one. Event size climbs linearly, from 989 B at seq 17 to 6,770 B at seq 171, so total bytes grow O(n²). All 28 `belief.revised` events share one belief_id, the log.md belief created at seq 12. No concept was ever revised through the ledger. Log events are 105,147 of 446,607 bytes (23.5%), which matches the claim.
- **Confirmed: no dedupe.** `insert_log_entry` has no dedupe check, and mcp.rs logs after every successful write.
- **Overstated: the duplicates are not no-op rechecks.** Each duplicate pair is two separate writes, and each one really changed the file.
  - The second write of each concept added a `description:` field; for gcs-5 it also changed `about:`.
  - There are 6 Update lines, not 8. None of them comes from a write with no change.
  - Adding dedupe would erase a real second revision. The actual defect: a bullet records only kind, title and path, so two different revisions produce identical lines.
- **A true no-op cannot come through MCP.** `tool_write_concept` always stamps `generated.at = now`, so every write changes the file. What the log cannot show is a write that changed only the stamp or metadata versus one that changed the substance.
- **The Aug 17 duplicates never touched the ledger.** The ledger head is unchanged across those commits. So they are no evidence of ledger growth, and the log.md override at seq 179 comes from the out-of-band write, not from log.md being modelled as a belief.

**Evidence checked.** - src-tauri/src/knowledge.rs:286-330: `insert_log_entry` builds `* **{kind}**: [{title}](path).` and pushes it under the day heading with no check for an existing identical line.
- src-tauri/src/mcp.rs:2540-2546: `write_concept`, then an unconditional `append_knowledge_log`. mcp.rs:2501 stamps `generated.at = now_iso()` on every write.
- src-tauri/src/vault/write.rs:700: with an active writer, the append goes to `ledger::concepts::append_log`.
- src-tauri/src/ledger/concepts.rs:800-855: `append_log_with` writes a `BeliefRevised` with patch /body `before: current.content` (the full log) and `after: next` (the full log). It skips only when `next == current.content`, which never happens because a bullet is always added.
- Live ledger (d62256…0001.ndjsonl.open, 446,607 B now): 28 `belief.revised` events, all belief 49e24332… (log.md, created at seq 12). Sizes rise 989 → 6,770 B. The 29 system:knowledge-log events total 105,147 B.
- Live knowledge/log.md lines 4-9: three identical pairs of Update lines on 2026-08-17.
- Vault git history: 812605a then 1c8c9e9 (gcs-5; the second adds `description` and changes `about` to a self-reference). 7658504 (changeover, two log lines). e3543b4 then e1770e4 (j12; the second adds `description`). Every commit changed the concept file, so none was a no-op. All carry ledger head 619957fc…, so none of these writes went through the ledger.

**Correction.** - **Holds:** in the ledger path, `append_log_with` records every knowledge-log append as a `belief.revised` carrying the full log body before and after (concepts.rs:840). Ledger bytes therefore grow O(n²) with the number of concept writes. Live figures: 28 revisions, all log.md, 105 KB of 447 KB (23.5%).
- **Also holds:** `insert_log_entry` never dedupes, and a bullet holds only kind, title and path. So separate revisions of one concept on one day produce identical lines. A stamp-only rewrite (`generated.at` always changes) also logs as an "Update", indistinguishable from a real revision.
- **Wrong in the claim:**
  - The live duplicates (6 Update lines, not 8) are real, separate revisions (added `description`, changed `about`), not no-op rechecks.
  - They were written outside the ledger, so they do not show ledger growth.
  - log.md's part in the divergence comes from the out-of-band write, not from the belief modelling.
- **Fix direction:** keep revisions and diff-or-append the log (or make it derived rather than a stored belief). Do not dedupe lines.

</details>

### F61 — stale_after is agent-only and unvalidated, and 'stale' has three definitions that contradict the maintenance rule 'time is not a reason'

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/mcp.rs:2505`
  - `src/engine/okf.ts:252`
  - `src-tauri/src/knowledge.rs:683`
  - `src/engine/jobs.ts:32`
  - `src-tauri/src/attention/lanes.rs:489`
  - `src-tauri/src/maintain/prompt.rs:50`
  - `src/pages/KnowledgePage.tsx:320`

**Evidence**

write_concept accepts any string for stale_after (mcp.rs:2505-2507, no date parse). Staleness is a lexical `today >= after`, implemented twice: TS okf.ts:252-255 and Rust knowledge.rs:683-685. That is a twin Rust+TS rule, which AGENTS.md forbids. A third definition exists in the M27 staleness lane, whose doc says 'M27 builds no second recheck mechanism', while jobs.ts:32-34 still runs `stale`/`schema` lanes that 'M26.6's maintenance pass will take over'. The maintenance prompt says 'TIME IS NOT A REASON', yet the stale lane is purely date-driven. Humans cannot set it: guard_human_write blocks knowledge/ and verify_concept may write only `verified` (KnowledgePage.tsx:320: 'the recheck date is the agent's to move'). Live data: concurrent runs set j12 to 2027-07-15 and then 2027-02-17 within 52s; gcs-5 went 2027-07-31 → 2028-02-28 → 2027-10-31 in 31s. 22 of 29 concepts have no stale_after and so are never rechecked.

**Impact**

The recheck horizon is arbitrary, unreviewable and non-deterministic. A malformed date like '2027-7-1' or 'never' silently changes staleness. The UI 'Stale since' chip and the M27 staleness lane can disagree about the same concept.

**Recommendation**

Move the recheck-horizon rule into shared/policy as data, with one evaluator. Validate YYYY-MM-DD at write_concept. Let the human set or extend stale_after, or record 'reviewed, still true', as part of verify. Retire the TS stale and schema lanes in favour of the M27 lane.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** The mechanics check out. Two parts are overstated.

Confirmed:
- **No validation on write.** write_concept copies any string into stale_after. The only check is the tool schema's description text "YYYY-MM-DD".
- **Lexical compare, done twice.** Staleness is a plain string compare, `today >= after`, written once in TS (okf.ts:252-255) and once in Rust (knowledge.rs:683-685). That is a twin rule, which AGENTS.md calls review-blocking.
- **Malformed dates change staleness silently.** For example, "never" is never stale, and "2027-7-1" sorts after every 2027 date from 07 to 12.
- **A third reading exists, and it disagrees.** monitor/sources.rs:130-145 validates ISO format (a malformed date means never expires) and uses strict `<`. jobs.ts:146 uses `<=`. So stale_after is read three different ways across the codebase.
- **Humans cannot set it.** guard_human_write refuses every knowledge/ path, and the KnowledgePage.tsx comment confirms the recheck date is the agent's to move.
- **Live data matches.** 7 of 29 concepts carry stale_after. The date flip-flops happened: j12 changed 07-15 to 02-17 in 50s, and gcs-5 changed 2028-02-28 to 2027-10-31 in 32s.

Overstated:
1. **The M27 staleness lane is not a third definition of concept stale_after.** It derives Freshness from shared/policy/freshness.v1.json. Those rules are policy-as-data, apply to ledger evidence anchors, and are compiled once, so this is not a twin rule. The line "M27 builds no second recheck mechanism" (lanes.rs:489) means the lane and the maintenance pass share one computation. It does not deny the jobs.ts lane. Still, jobs.ts `stale`/`schema` and the M27 lane are two recheck systems over different inputs, and the jobs.ts comment about M26.6 taking over is lagging. So the UI chip and the lane can disagree, as claimed.
2. **"Contradicts TIME IS NOT A REASON" is a stretch.** That rule forbids justifying a proposal by inactivity ("nobody touched it"). A declared expiry date, or a policy-declared evidence age, is a different thing. It is a tension, not a contradiction.

The date flips also came from the Aug 17 out-of-band agent edits that bypassed the ledger, not from write_concept calls. Impact is limited to recheck scheduling: no data loss, and unrelated to the divergence banner. Severity: low, not medium.

**Evidence checked.** - src-tauri/src/mcp.rs:2505-2507 stores `arg_str(args,"stale_after")` with no parse; the only constraint is the schema description at mcp.rs:875 ("YYYY-MM-DD after which this should be rechecked").
- src/engine/okf.ts:252-255 `after !== null && today >= after`.
- src-tauri/src/knowledge.rs:683-685 `stale_after.as_deref().is_some_and(|after| today >= after)`. This is the twin.
- src-tauri/src/monitor/sources.rs:130-145 uses is_iso_date, returns NeverExpires on a malformed date, and flags due only when `stale_after < today`. That is a third, inconsistent reading.
- src/engine/jobs.ts:146 `stale > today` skip.
- src/engine/jobs.ts:32-34 says the stale/schema lanes are ones "M26.6's maintenance pass will take over", and :195 still emits kind 'stale'.
- src-tauri/src/attention/lanes.rs:644-660: the staleness lane keys on facet.validity.freshness.
- src-tauri/src/dynamics/freshness.rs:1-15 and :270-290: freshness comes from shared/policy/freshness.v1.json (anchor + declared seconds, no default rule, so unknown ≠ fresh). It does not come from concept stale_after.
- src-tauri/src/maintain/prompt.rs:44-47: "TIME IS NOT A REASON ... not stale because nobody touched it".
- src-tauri/src/knowledge.rs:198-203: guard_human_write refuses every knowledge/ path.
- src/pages/KnowledgePage.tsx:320-322: "the recheck date is the agent's to move (verify_concept may write `verified` and nothing else)".
- Live vault /Users/joseflagorio/Documents/test/knowledge: 29 non-log concepts, 7 with stale_after.
- Vault git history:
  - j12: e3543b4 04:56:52 sets 2027-07-15; e1770e4 04:57:42 sets 2027-02-17.
  - gcs-5: 1a42ee4 Aug16 sets 2027-07-31; 812605a 04:51:37 sets 2028-02-28; 1c8c9e9 04:52:09 sets 2027-10-31.
  - These are the Aug 17 out-of-band commits.

**Correction.** - **Confirmed:**
  - stale_after is agent-only and unvalidated at write (mcp.rs:2505).
  - Concept staleness is a lexical `today >= after` compare, twinned in okf.ts:252 and knowledge.rs:683 (an AGENTS.md policy-as-data violation).
  - monitor/sources.rs reads the same field a third way: ISO-validated, with strict `<`. So malformed or boundary dates behave differently across paths.
- **Overstated:**
  - The M27 staleness lane is not a definition of concept stale_after. It derives from policy-as-data freshness rules (freshness.v1.json) over ledger evidence, which is not a twin rule.
  - That lane does not contradict "TIME IS NOT A REASON". That rule bans inactivity as a justification, not declared expiries.
- **Real residual issues:**
  - Two parallel recheck systems: the jobs.ts stale/schema lanes and the M27 lane. They can disagree, and the jobs.ts M26.6 comment is lagging.
  - No input validation on stale_after.
- **Severity:** low. It affects recheck scheduling only.

</details>

### F62 — The stale lane can loop: runKey is the concept's mtime, so a rewrite that leaves stale_after in the past re-queues a paid recheck

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/engine/jobs.ts:186`
  - `src/engine/jobs.ts:189`
  - `src/lib/prompts.ts:126`

**Evidence**

For the stale lane, runKey = concept.entry.modifiedAt (jobs.ts:189-192), and a job is suppressed only when attempts[path] === runKey. Any write changes the mtime and so mints a new runKey. The 'Needs revising' verdict ('rewrite it in place… keeping the sources that still hold') never tells the model to move stale_after, and write_concept keeps whatever date the model re-sends. The header's loop-stopper only covers 'a recheck that decided there was nothing to revise writes nothing'.

**Impact**

If a revise-verdict run re-sends the old (past) stale_after, or picks a date at or before today, the concept stays stale with a new runKey. It is then rechecked at every settle (4s) and yield cycle, about $0.9 per Opus run, until the budget gate defers it. The opposite omission, no stale_after sent, silently removes the concept from rechecks for good. This comes from reading the code; it was not seen in the live data.

**Recommendation**

Key recheck attempts on (path, stale_after), not mtime. Refuse a recheck write whose stale_after is not strictly in the future, or set a server default horizon. Cap recheck attempts per concept per day.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - **Real and reachable.** `jobQueue` is called from `useJobRunner` whenever autoLearn is on, and autoLearn defaults to true (`uiStore.ts:887`). For a stale concept whose type docs have not changed, `runKey` is the concept's mtime (`jobs.ts:186-192`). The job is skipped only when `attempts[path] === runKey`.
- **How the loop happens.** Before the run, the old mtime is recorded as the claim (`useJobRunner.ts:339-340`). The recheck then rewrites the concept through write_concept, which gives it a new mtime. `finish()` rescans (`useJobRunner.ts` ~L284), so `next` is derived again with a runKey that is not in `attempts`. If the file still has a `stale_after` on or before today, the concept is still stale (`okf.ts:252-254`: `today >= after`). A new job then starts after `SETTLE_MS = 4_000`.
- **The prompt does not prevent it.** Under "Needs revising" (`prompts.ts:126`) the model is told to rewrite in place, with no instruction to move `stale_after`. Only "Still true" says to extend it.
- **Re-sending the old date is the likely case.** `tool_write_concept` (`mcp.rs:2446-2507`) builds the frontmatter from scratch on every call and never merges the existing file. So the model must re-send `stale_after` to keep it, and copying the current (past) value is the natural thing for it to do.
- **The flip side is also real.** If `stale_after` is left out, it is dropped (`mcp.rs:2505` only inserts it when present). With no `stale_after`, `isStale` returns false, so the concept silently leaves the stale lane for good.
- **The only bound is the budget gate.** On a deferral, the claim is released but the local attempts record stays (`useJobRunner.ts:518-528`), which stops re-runs for that session only.
- **What is overstated.** The ~$0.9 per Opus run figure was not checked. "Every 4s" really means back-to-back runs: each run's full duration plus the 4s settle. The claimant also says this was not seen in the live data, and I did not look for it there either. So it is a latent, code-level defect, not an observed incident.

**Evidence checked.** - `src/engine/jobs.ts:186-199`: `runKey = newestTypeChange > mtime ? newestTypeChange : concept.entry.modifiedAt`, and `if (attempts[path] === runKey) continue`.
- `src/engine/jobs.ts:101-106`: the header describes the loop-stopper as covering only "a recheck that ... writes nothing".
- `src/engine/okf.ts:252-254`: `isStale = after !== null && today >= after`.
- `src/lib/prompts.ts:124-127`: only "Still true" says to extend `stale_after`. "Needs revising" says to rewrite in place and says nothing about the date.
- `src-tauri/src/mcp.rs:2468-2507`: the frontmatter is a fresh `Map::new()`, and `stale_after` is inserted only if the model passes it. There is no merge with the existing file.
- `src-tauri/src/vault/write.rs:600-627` and `src-tauri/src/ledger/concepts.rs`: no `stale_after` carry-over on either write path.
- `src/agent/useJobRunner.ts:68`: `SETTLE_MS = 4_000`.
- `src/agent/useJobRunner.ts:339-340`: the attempt is claimed with the pre-run mtime.
- `src/agent/useJobRunner.ts:284`: `finish()` calls `rescan()`.
- `src/agent/useJobRunner.ts:425-426`: the stale kind maps to `reviewConceptPrompt`.
- `src/agent/useJobRunner.ts:518-528`: on a budget-gate deferral the claim is released and the local suppression stays.
- `src/stores/uiStore.ts:887`: autoLearn defaults to `'true'`.

</details>

### F63 — Unattended knowledge spend is on by default, against the codebase's own opt-in rule

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/stores/uiStore.ts:887`
  - `src-tauri/src/ingest/ambient.rs:10`
  - `src/agent/useJobRunner.ts:512`

**Evidence**

ambient.rs:10-15: 'an app may not start spawning CLI runs against somebody's subscription without being asked… a default that spends money is not a default' (ambient.ingest_enabled defaults false; runtime.db has 0 ambient runs). But autoLearn loads with default 'true' (uiStore.ts:887), and lane_registry in the live runtime.db has stale=1 and schema=1 for enabled_by_default. On Aug 17, creating two Type docs caused six unasked Opus runs costing $5.20 (887805+947833+866351+601160+906324+991237 micros).

**Impact**

The expensive half of the knowledge pipeline, the TS recheck lanes, runs without consent, while the governed Rust ingest stays off. Users pay for, and are then locked out by, runs they never started.

**Recommendation**

Default autoLearn and the stale/schema/refresh lanes to off, behind the same owner opt-in as ambient.ingest_enabled, or put them under that single switch.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - **Default is on:** `autoLearn` loads as true unless the user has turned it off (`src/stores/uiStore.ts:887`).
- **Nothing else stops it:** `useJobRunner` builds its queue from `autoLearn`, the vault path and `ledgersReady` alone (`src/agent/useJobRunner.ts:206`). It never reads `ambient.ingest_enabled`.
- **Editing a Type doc queues paid runs:** in `src/engine/jobs.ts:160-202`, changing a Type doc puts a 'schema' recheck job on the queue for every live concept whose `about` target has that type. Each job spawns the CLI.
- **The opt-in rule does not reach these lanes:** `ambient.rs:10-15` makes spending opt-in, but its flag only gates the Rust ingest and maintenance tick. The TS stale/schema lanes are the ones "M26.6's maintenance pass will take over" (`jobs.ts:33`), so they are maintenance work running with no opt-in.
- **The current gate does not close the gap:** since M34.2.4 (e0d1c56, 2026-08-20), `lib.rs:1289-1345` sends these runs through `dispatch::claim` → `budget::gate`. That gate checks `settings::lane_enabled`, and that falls back to `lane_registry.enabled_by_default`, which is 1 for stale and schema. It never checks `ambient.ingest_enabled`. A budget ceiling now limits the spend (20 runs/day in `budget_settings_versions`). It does not ask for consent.
- **Live data matches the claim:** vault git shows `types/risk.md` created at 11:49:20Z and `types/decision.md` at 11:50:05Z on Aug 17. Six Opus runs followed at 11:50:08–11:54:54Z, costing 5,200,710 micros ($5.20). The knowledge edits that came out of them are Risk and Decision concepts, the same files behind the divergence.
- **Corrections:**
  - The six runs are booked `mode='attended', lane='agent'`, `actor NULL`. They are not booked as schema-lane ambient runs, because the Aug 17 build predates M34.2.4, and M34.2.4's own comment calls that booking a gap. So the job-runner attribution comes from timing and target files, not from a recorded lane.
  - `lane_registry` stale=1/schema=1 is the seeded registry default, not stale data.
  - `ambient_gate_decisions` has 0 rows, so no job-runner run has gone through the new gate on this machine yet.

**Evidence checked.** - `src/stores/uiStore.ts:887`: `autoLearn: loadString(AUTO_LEARN_KEY, 'true') === 'true'`
- `src/agent/useJobRunner.ts:206`: `if (!autoLearn || vaultPath === null || !ledgersReady) return null;`. At :512 it sends `attended:false, lane: job.kind`.
- `src/engine/jobs.ts:160-202`: a Type doc with `modifiedAt` > concept `generated.at` makes a 'schema' job.
- `src-tauri/src/ingest/ambient.rs:10-15, 52, 684`: `ENABLED` only gates ingest/maintenance. Its only other reader is `lib.rs:661`, a status read.
- `src-tauri/src/lib.rs:1289-1345`: the lane claim goes through `runtime::dispatch::claim` → `budget::gate`. `budget.rs:~721` calls `settings::lane_enabled`, and `settings.rs:349-362` defaults to `lane_registry.enabled_by_default`.
- `runtime.db`:
  - `lane_registry`: `stale|5|1`, `schema|6|1`
  - `runs` on 2026-08-17 11:50:08–11:54:54Z: six succeeded `claude-opus-4-7` runs, cost micros 866351, 601160, 947833, 906324, 887805, 991237 (sum 5,200,710). All `attended/agent`, actor NULL.
  - `ambient_gate_decisions`: 0 rows. `budget_settings_versions`: max_daily_runs=20.
- Vault git: 90437f4 `types/risk.md` at 04:49:20-07:00 and f7df8b4 `types/decision.md` at 04:50:05-07:00. Then 812605a..e1770e4 rewrote the knowledge/decisions and risks concepts.
- Commit e0d1c56 (M34.2.4, 2026-08-20) added `lane: job.kind` after the incident.

**Correction.** The core claim holds: TS recheck runs are on by default and still bypass the `ambient.ingest_enabled` opt-in in current code. Three details need correcting. (1) The Aug 17 runs are booked attended/lane=agent with NULL actor, from a build before M34.2.4. That they were schema-lane runs comes from timing and target files, not from a recorded lane. (2) Current code does put these runs through a budget gate (20 runs/day), which caps the spend but does not ask for consent. (3) `lane_registry` enabled_by_default=1 is the seeded default, not stale data.

</details>

### F64 — Fleet run rows show 0 proposals applied/rejected as measured, and concept writes cannot be traced to the run that made them

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/runtime/dispatch.rs:280`
  - `src-tauri/src/runtime/dispatch.rs:525`
  - `src/status/FleetSection.tsx:243`
  - `src-tauri/src/ledger/concepts.rs:407`

**Evidence**

runs.proposals_submitted, applied and rejected are INSERTed as 0 (dispatch.rs:280-283), and no UPDATE anywhere in src-tauri writes them: the only 'UPDATE runs' statements (dispatch.rs:525, :801) set usage and outcome. FleetSection renders `{run.applied} applied · {run.rejected} rejected` unconditionally. write_concept's commit sets use a synthetic run_id, sha256('cerebro-write-concept-run-v1', krel, head) at concepts.rs:407, not the CLI run's id. Live: 14 succeeded attended runs (Aug 15-17) all show 0/0/0, while the ledger holds 29 applied commit sets by actor claude-code.

**Impact**

'Absent is never zero' is broken on the Agents and Fleet surfaces: a run that wrote many concepts reads as '0 applied'. After an incident like Aug 17, nobody can ask which run wrote which concept from the ledger alone.

**Recommendation**

Carry the run's durable id through the MCP bearer into write_concept's proposal run_id, and increment the counters on commit. Until a producer exists, render the counts as 'not recorded'.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Tried to refute it and could not. The code and the live data both back every part of the claim.
- Nothing in src-tauri ever writes `runs.proposals_submitted`, `applied` or `rejected` after insert:
  - Every INSERT sets them to literal 0: ambient at dispatch.rs:278, attended at dispatch.rs:758, plus :961 and fleet.rs:424/500.
  - The only `UPDATE runs` statements set usage/outcome (dispatch.rs:525) or run facts (dispatch.rs:801). A grep for `SET ... applied` finds nothing.
  - So the zeros are placeholders, not measurements.
- FleetSection.tsx:243 renders `{run.applied} applied · {run.rejected} rejected` with no condition. It treats usage the opposite way: when `usage_state` is not exact it shows "unknown" (L236-239) with the comment "The zeros in the columns are not a measurement." This breaks "absent is never zero".
- Second symptom: RunDetailPanel.tsx:170's "still waiting on a decision" branch can never fire, because `proposals_submitted` is always 0.
- Why runs can't be traced:
  - `RunGrant.run_id` exists and is documented as "the SAME id the meter and the runs table book the run under" (mcp.rs:60-73).
  - But dispatch passes only `actor` to `tool_write_concept` (mcp.rs:1407, signature at :2446).
  - concepts.rs:405-407 then makes up its own id: `sha256_first128("cerebro-write-concept-run-v1\0{krel}\0{head_hash}")`.
- Live data (read-only):
  - runtime.db has 14 succeeded, 3 failed and 2 abandoned attended runs, all with `proposals_submitted`/`applied`/`rejected` = 0/0/0.
  - The ledger has 29 `proposal.applied` / 29 `batch.committed` events with actor `claude-code`, each with a distinct `run_id`.
  - None of those 29 run_ids matches any row in `runs` (29 of 29 match 0 rows).
- One caveat, which doesn't change the verdict: attribution could still be guessed from timestamps against run start/end windows. So "cannot be traced from the ledger alone" is accurate, but a rough time-based join is possible.
- Medium severity is right: this is a lost-observability defect, not a data-corruption risk.

**Evidence checked.** - src-tauri/src/runtime/dispatch.rs:278-283 (ambient INSERT with `0, 0, 0` for proposals_submitted/applied/rejected).
- dispatch.rs:758-763 (attended INSERT with the same literal zeros).
- dispatch.rs:525 and :801 (the only `UPDATE runs`; neither touches the counters).
- src-tauri/src/runtime/schema.rs:226-228 (columns NOT NULL, no NULL meaning "not recorded").
- src/status/FleetSection.tsx:243 (renders the counts without a condition), against L236-239 (usage shows "unknown").
- src/status/RunDetailPanel.tsx:170 ("still waiting" branch that never fires).
- src-tauri/src/mcp.rs:73 (`RunGrant.run_id` doc), :1407 (`"write_concept" => tool_write_concept(&vault, args, actor)`, grant not passed), :2446.
- src-tauri/src/ledger/concepts.rs:405-407 (synthetic run_id).
- Live runtime.db:
  - attended/succeeded = 14 runs (2026-08-15T14:43Z to 2026-08-17T11:54Z), sums 0/0/0.
  - failed = 3 runs, abandoned_usage_unknown = 2 runs, also 0/0/0.
- Live ledger d62256b3...0001.ndjsonl.open:
  - 29 proposal.applied, 29 batch.committed.
  - 29 distinct run_ids; `select count(*) from runs where run_id=?` returns 0 for all 29.

</details>

### F65 — 'Ask the agent to revise' always sends a prompt saying the recheck date has passed, even for concepts that are not stale

- **Severity (claimed):** low
- **Category:** data-quality
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src/knowledge/KnowledgePanel.tsx:404`
  - `src/pages/KnowledgePage.tsx:659`
  - `src/lib/prompts.ts:121`

**Evidence**

The always-visible 'Ask the agent to revise' button (KnowledgePanel.tsx:404-406) and the stale-only 'Recheck' chip share onAskAgent. That handler always sends reviewConceptPrompt, whose first line is 'Its recheck date has passed.' and whose default verdict is 'extend `stale_after`'.

**Impact**

A false premise pushes the model to invent or extend stale_after (as happened for j12, which had none) and to rewrite a fresh concept. A user asking for a real revision gets a recheck framing instead.

**Recommendation**

Send reviewConceptPrompt only when concept.stale. Give the revise button its own prompt that states the user's intent and does not mention recheck dates.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** The claim holds. KnowledgePanel shows "Ask the agent to revise" on every concept, and it uses the same onAskAgent handler as the "Recheck" chip, which only appears on stale concepts. KnowledgePage wires that handler to reviewConceptPrompt with no check on whether the concept is stale. That prompt opens with "Its recheck date has passed." and its first verdict is "extend `stale_after`". So a fresh concept gets a false premise, and a user asking for a real revision gets a recheck framing instead. The prompt was written for stale concepts: useJobRunner uses it only for job.kind === 'stale', so the button reusing it is a mismatch. One part is unproven: the evidence says the j12 concept picked up an invented stale_after because of this button. I did not check that, and nothing I read ties that write to this button rather than the Aug-17 agent that bypassed the ledger. Severity stays low: it is a prompt-quality defect, and the agent can still reach "Needs revising".

**Evidence checked.** - src/knowledge/KnowledgePanel.tsx:404-406: `<Button ... onClick={onAskAgent}>Ask the agent to revise</Button>`, rendered with no condition.
- src/knowledge/KnowledgePanel.tsx:284-297: the "Recheck" button (data-testid recheck-concept) uses the same onAskAgent and is shown only when `concept.stale`.
- src/pages/KnowledgePage.tsx:659-664: `onAskAgent={() => { askAgent(reviewConceptPrompt(selected.entry.path, selected.title), selected.entry.path); }}`, with no stale check.
- src/lib/prompts.ts:119-122: reviewConceptPrompt's first line is "Recheck the knowledge concept at ${path} ("${title}"). Its recheck date has passed."; the first verdict is "Still true — extend `stale_after` with write_concept".
- src/agent/useJobRunner.ts:425-426: the job runner uses reviewConceptPrompt only for `job.kind === 'stale'`, which confirms it was meant only for stale concepts.
- The j12 example in the stated impact was not checked.

</details>

### F66 — The 'Needs review' count now counts up in the always-visible chrome, and its comment claiming otherwise was made false by M43

- **Severity (claimed):** low
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/knowledge/KnowledgeNav.tsx:150`
  - `src/knowledge/KnowledgeNav.tsx:155`
  - `src/app/Sidebar.tsx:696`

**Evidence**

KnowledgeNav renders the 'Needs review' row with count={reviewCount}, next to the comment 'The count lives on the row, not in the chrome'. Since M43.10, KnowledgeNav mounts in the Base section of the single nav column, which AGENTS.md says 'IS the chrome' on every surface (Sidebar.tsx:696). Every agent write adds an unverified concept, and every no-op recheck demotes a review to 'predates_current', so the number rises with no human action (29/29 live concepts unverified).

**Impact**

This wears down the M8 'nothing speaks first' principle. Background churn from the recheck lanes shows up as a growing to-do count on every screen.

**Recommendation**

Remove the count from the Base-section row, or show it only inside the Knowledge surface. Fix or delete the falsified comment, per the retired-workaround rule.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - Code is real and reachable. `Needs review` renders `count={reviewCount}` right under the comment "The count lives on the row, not in the chrome".
- KnowledgeNav mounts in the sidebar whenever `groupOpen('base')` is true. `navClosed` defaults to an empty list, so the Base section is open by default on every surface. The live review count therefore shows in the always-visible nav column.
- The Sidebar's own comment and KnowledgeNav's lower comment both cite M8.1 as "the rule that kept a review count off Knowledge". The always-visible row breaks that rule, so the upper comment is stale.
- Wrong detail on timing: M43 did not cause this. The count became always-visible in M42.2 (369327b), when `groupOpen('base')` replaced the M37.3 gate `knowledgeMode && selection.kind === 'knowledge'`. M43.10 (db9212b) only kept it when Base became a section. Before M42.2, the nav, and the count with it, showed only on the Knowledge surface.
- Softening factors: the user can fold the section, which persists in `cerebro.navClosed`. The rule's wording also allows a row to "say how big it is". But this is a to-do count, which is exactly what M8.1 excluded.
- Checked: `needsReview` is true for any unverified, stale or deprecated concept that has not been superseded. So new agent concepts raise the count with no human action.
- Not checked: the "no-op recheck demotes to predates_current" mechanism and the "29/29 unverified" figure.
- Cosmetic and principle drift only; no data risk.

**Evidence checked.** - src/knowledge/KnowledgeNav.tsx:103 has `reviewCount = concepts.filter(needsReview).length`. Lines 150-157 have the comment plus `count={reviewCount}`. Lines ~178-183 say no counts, citing "the rule that kept a review count off Knowledge (M8.1)".
- src/app/Sidebar.tsx:183 has `groupOpen = key => !navClosed.includes(key)`. Lines 672-698 have `{groupOpen('base') && <KnowledgeNav .../>}` and the comment "nothing counts up at you from the chrome".
- src/stores/uiStore.ts:761: `navClosed: loadStringList('cerebro.navClosed')`, empty by default, so the section starts open.
- src/engine/okf.ts:696-706: `needsReview` is true for unverified, stale or deprecated concepts.
- git history:
  - M8 77cbd3e: the comment said "not on the Rail".
  - M37.3 bff2ecc: the nav was gated on `knowledgeMode && selection.kind === 'knowledge'`.
  - M42.2 369327b: the gate changed to `groupOpen('base')`, making it always-visible.
  - M43.10 db9212b: kept the M42.2 behaviour when Base became a section.

**Correction.** The core claim holds: the stale comment is real, and the review count shows on every surface by default in the always-visible nav column. The regression came from M42.2 (369327b), which replaced the knowledge-surface-only gate with `groupOpen('base')`, not from M43. M43 only renamed the column "the chrome" and kept the behaviour. The user can fold the Base section to hide it. The recheck "predates_current" mechanism and the 29/29 figure were not checked.

</details>
