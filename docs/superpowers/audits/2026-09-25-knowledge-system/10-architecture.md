# Architecture & proportionality

> Audit lens `architecture` · first-pass auditor, each finding adversarially verified

## Summary

The banner is caused by Cerebro's own sanctioned write door, not by a stranger. When the running process did not hold the ledger writer, write_concept silently fell back to writing files directly with a fresh `generated` stamp. The ledger's capture rule then calls a changed `generated` stamp "provenance forgery", and one bad file pauses capture across the whole vault until a choice is made. The only exit that works discards the agent's edits. Architecturally, the design fails in ways that do not fit a 30-belief vault: a global failure domain, a per-device ledger that is gitignored while it claims authority over git-synced files, diagnostics that are thrown away, and large subsystems with no producer or reader (coverage, the TS reducer twin, shadow `vault.write` events, index tables, trigger governance).

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F89 | critical | yes | write_concept's silent file-first fallback produces exactly the bytes the ledger later calls forgery (root cause of the live banner) |
| F90 | high | yes | A single global reconciliation mode: 3 bad paths froze all 30, with all-or-nothing exits |
| F91 | high | yes | 'Files-first, vault is source of truth' contradicts a gitignored, per-device ledger that claims authority over git-synced knowledge files |
| F92 | high | yes | The 'provenance forgery' rule treats a generated restamp like a verified self-certification |
| F93 | medium | yes | Every layer throws away why a divergence happened: scan reasons, watcher refusals and banner detail |
| F94 | medium | yes | Coverage is a vocabulary with no producer, which pins every belief in the protected Blindness lane forever |
| F95 | medium | yes | A 6.9k-line TS reducer twin exists only to replay conformance vectors; production uses 3 validators |
| F96 | medium | yes | The epistemic ledger is mostly write amplification: shadow vault.write hashes, a log.md 'Belief' and an unread SQLite index |
| F97 | medium | yes | Deferred-capability governance and never-exercised pipelines outweigh the product they serve |
| F98 | medium | yes | Load-bearing comments falsified by M23.3 and M23.7, including one that describes the incident path as safe |

### F89 — write_concept's silent file-first fallback produces exactly the bytes the ledger later calls forgery (root cause of the live banner)

- **Severity (claimed):** critical
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, confirmed/critical)
- **Locations:**
  - `src-tauri/src/vault/write.rs:606-626`
  - `src-tauri/src/vault/write.rs:698-721`
  - `src-tauri/src/ledger/shadow.rs:288-305`
  - `src-tauri/src/ledger/concepts.rs:66-79`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/ledger/capture.rs:960-966`
  - `src-tauri/src/ledger/reconcile.rs:313-325`
  - `src-tauri/src/ledger/shadow.rs:344-365`

**Evidence**

with_writer returns None whenever this process holds no writer (lock lost to another instance, refused verdict, path mismatch). write_concept then takes the 'Legacy file-first path' (write.rs:612-626) and stamps a fresh generated.at (mcp.rs:2501). Live proof: runtime.db `runs` shows 6 attended agent runs 11:50:08-11:57:44Z on 2026-08-17 for store 30de3878 (this vault). Vault commits at 11:51:37, 11:52:09, 11:54:44, 11:56:52 and 11:57:42 carry server-format log bullets ('* **Update**: [...]') and a YAML block-style `generated:` (the legacy serializer) replacing the ledger projection's flow-style `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`. The ledger has zero events between seq 178 (00:10Z) and 179 (11:58Z). At the next launch, diff_projection_file refuses with 'provenance forgery: the generated stamp changed' (capture.rs:963-966), which becomes the divergence. LedgerStatus has no field saying whether this process holds the writer, so the lock-lost state reports verdict 'valid'.

**Impact**

The app's own agent tool writes knowledge through a path the ledger then rejects. Knowledge capture has been paused vault-wide for 39 days. Nothing in the UI ever showed that the running instance had no writer.

**Recommendation**

Fail closed. If `.cerebro/ledger/store.json` exists and this process has no writer, write_concept, verify_concept and append_log return a typed `ledger_writer_unavailable` (operational destiny) instead of writing to disk. Delete the legacy branches at write.rs:612-626 and 703-721 for ledger-armed vaults. Add `writer_held` plus the reason to LedgerStatus and surface it in the UI.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real, and I followed it end to end.
  - `shadow::with_writer` returns None when there is no active writer.
  - `concepts::write_concept` then returns None, and `vault::write::write_concept` quietly falls back to legacy `concept_write`. That path uses serde_yaml block style plus the `generated.at` that MCP stamps fresh on every write.
  - Its `shadow_write`/`record` also no-ops when there is no writer. Result: the file changes and the ledger records zero events.
  - At the next launch, `diff_projection_file` sees `generated` changed, returns "provenance forgery", and `launch_scan` pushes the file to divergent. That raises ManifestReducerDisagreement, which is the banner.
- The bytes on disk are a fingerprint of the legacy path, not guesswork.
  - The ledger renderer (`project.rs`) writes object fields in flow style: `generated: { by, at }`.
  - Commits 812605a and e3543b4 swap that for block style (`generated:\n  by:\n  at: 2026-08-17T11:51:31Z`), with `- '[[..]]'` lists. That is serde_yaml output, which only `concept_write` produces.
  - The `at` values are server-stamped, 6s before each commit.
- runtime.db confirms 6 attended agent runs for store 30de3878 (this vault's store.json) between 11:50:08 and 11:57:44Z. The ledger jumps from seq 178 (vault.write, 00:10Z) to 179/180 (the scan). Even the plain vault writes behind commits 90437f4/f7df8b4 left no events, which fits the whole process having no writer.
- The "silent" part holds too.
  - `activate()` does `LedgerWriter::open(&vault,&id).ok()`, so a held lock becomes None while the verdict stays Valid.
  - `status()` re-classifies from disk. `LedgerStatus` has no writer-held field, so a process that lost the lock reports "valid".
  - The comment in write.rs ("the refusal is visible through ledger_status") is false for the lock-lost case.
- Corrections:
  - The data can't show WHY the writer was None on Aug 17. A lost lock to a second instance is the most likely cause, but not proven; a refused verdict would also fit. The ledger log does rule out "no ledger" and a build that predates the switch to ledger-first writes (seq 168 shows ledger-first `write_concept` working on Aug 16).
  - The log bullet format is the same in both paths (`insert_log_entry`), so it proves nothing. Only the YAML style and the `generated` restamp tell the paths apart.
  - Severity is high, not critical. No data was lost, both versions are recoverable (git plus ledger), and the impact is paused capture plus a banner that is hard to clear.
- Side finding: the incident facts get the `about:` change backwards. The diff in 812605a shows the OLD bytes held the self-reference `[[gcs-5-supervision-ratio]]` and the Aug 17 edit replaced it with `[[arb-4-disposition]]`.

**Evidence checked.** - `src-tauri/src/vault/write.rs:600-626`: `write_concept` tries `ledger::concepts::write_concept`; on None it runs "Legacy file-first path" `concept_write` (serde_yaml `serialize_mapping`, :629-655) and `shadow_write`.
- `src-tauri/src/ledger/concepts.rs:66-79`: returns None unless `with_writer` yields.
- `src-tauri/src/ledger/shadow.rs:293-305`: `with_writer` returns None if there is no active writer or the vault path differs.
- `src-tauri/src/ledger/shadow.rs:113-121`: `LedgerWriter::open(..).ok()`; a held lock gives None, verdict stays Valid.
- `src-tauri/src/ledger/shadow.rs:344-407`: `LedgerStatus`/`status()` has no writer-held field and classifies from disk.
- `src-tauri/src/mcp.rs:2501`: `generated = {by: actor, at: now_iso()}`.
- `src-tauri/src/mcp.rs:2539` and `:2546`: calls into `write_concept` and `append_knowledge_log`.
- `src-tauri/src/ledger/project.rs:34-42`: the ledger renders Object fields in flow style.
- `src-tauri/src/ledger/capture.rs:961-966`: generated/verified change refused as "provenance forgery".
- `src-tauri/src/ledger/reconcile.rs:313-331`: a failed capture goes to divergent, which raises ManifestReducerDisagreement.
- Vault git `812605a` (04:51:37 -0700): `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }` becomes block `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`.
- Vault git `e3543b4`: same restamp on tx-6-np-shared-j12-common-mode.md.
- `runtime.db` runs: 6 rows, store_uuid 30de3878…, attended/agent, 11:50:08Z–11:57:44Z, all succeeded.
- `.cerebro/ledger/store.json`: store_id 30de3878….
- Ledger seq 172-178: vault.write events (inbox capture), then seq 179 projection.overridden and 180 ledger.divergence; nothing in between.

**Correction.** The mechanism and root cause are confirmed, with three corrections:
- The data does not show which condition left the writer None on Aug 17. A lost lock to a second instance is the most likely cause but unproven; a refused verdict would also fit.
- The log bullet format is the same in both paths, so it proves nothing. The legacy path is identified only by the serde_yaml block-style frontmatter and the fresh `generated.at`.
- Severity is high rather than critical, because no data was lost and both versions can be recovered.

</details>

<details><summary>Verifier 2: confirmed (severity → critical)</summary>

**Reasoning.** - **Refutation failed.** Nothing blocks this path. `mcp.rs` calls `vault::write::write_concept` with no check for whether this process holds the writer. `with_writer` returns None when the Active slot has `writer: None`, which is what `activate` stores when `LedgerWriter::open` fails on a held lock (shadow.rs:111-119). The call then drops into `concept_write`, which writes the file first.
- **The file bytes identify the writer.** The Aug 17 commits contain exactly what `concept_write` produces through serde_yaml: block style, unindented `- '[[...]]'`, and `generated:` split over two lines with a server `at` of 11:51:31Z, 6 seconds before the commit. The log gained a `## 2026-08-17` heading plus `* **Update**: [title](/decisions/...)`, which is exactly what `insert_log_entry` formats. The old projection used flow style (`generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`, `tags: [..]`). A model editing the file by hand would not re-serialize the whole frontmatter this way, so the edits came from the app's own MCP tool and not from a direct Edit/Write.
- **The ledger was silent in this process.** `shadow_write` goes through `record`, which also returns early when `writer` is None, so no events were written. The ledger jumps from seq 178 (00:10Z) to 179 (11:58:53Z).
- **Runtime data matches.** runtime.db `runs` has six attended agent runs for store 30de3878 (this vault, per store.json) between 11:50:08 and 11:57:44Z. `operational_log` has matching rows. So the agent ran in this app while it had no writer.
- **This produces the forgery refusal.** `generated.at` always differs from the projection, and capture.rs:961-966 hard-refuses any change to the `generated` value. reconcile.rs:313-325 then turns a failed capture into a divergence, which raises the ManifestReducerDisagreement signal.
- **The status blind spot is real.** `shadow::status` classifies only from what is on disk. `LedgerStatus` has no field saying whether this process holds the writer, so a process that lost the lock still reports `valid`.
- **Caveats (do not refute the claim):**
  - Why the 11:50 process had no writer is not established. A held lock from a second or dev instance is the likely cause, since the 11:58 scan shows a fresh activation that did get the writer. A vault path mismatch or a refused verdict are also possible.
  - The shared incident facts have the `about:` change reversed. The Aug 17 edit changed `[[gcs-5-supervision-ratio]]` (the self-reference, which was in the ledger projection) to `[[arb-4-disposition]]`. So the agent fixed the self-reference; it did not introduce it.

**Evidence checked.** - src-tauri/src/vault/write.rs:600-626: `write_concept` falls back to `concept_write` plus `shadow_write` when `ledger::concepts::write_concept` returns None.
- src-tauri/src/vault/write.rs:698-721: `append_knowledge_log` has the same fallback, using `insert_log_entry` (knowledge.rs:288 bullet format `* **{kind}**: [{title}]({link}).`).
- src-tauri/src/ledger/concepts.rs:66-79: returns None via `shadow::with_writer`.
- src-tauri/src/ledger/shadow.rs:288-305: `with_writer` returns None when `active.writer` is None.
- src-tauri/src/ledger/shadow.rs:111-119: "A held lock (second instance) lands in the None arm", i.e. `LedgerWriter::open(..).ok()`.
- src-tauri/src/ledger/shadow.rs:310-322: `record` is a no-op without a writer.
- src-tauri/src/ledger/shadow.rs:344-400: `LedgerStatus` has no writer-held field, and the verdict comes from `classify` on disk.
- src-tauri/src/mcp.rs:2501: server stamps `generated {by, at: now_iso()}`.
- src-tauri/src/ledger/capture.rs:961-966: returns "provenance forgery: the {key} stamp changed out of band".
- src-tauri/src/ledger/reconcile.rs:313-330: a failed capture becomes divergent, which raises ManifestReducerDisagreement.
- Vault commit 812605a (2026-08-17T11:51:37Z): the diff shows `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }` replaced by block style `at: 2026-08-17T11:51:31Z`; `about` goes from `"[[gcs-5-supervision-ratio]]"` to `'[[arb-4-disposition]]'`; log.md gains `## 2026-08-17` and `* **Update**: [GCS-5 supervision ratio ...](/decisions/gcs-5-supervision-ratio.md).`
- Ledger seq 172-181: seq 178 at 00:10:35Z, then seq 179 projection.overridden at 11:58:53Z and seq 180 ledger.divergence at 11:58:54Z.
- runtime.db `runs`: 6 attended/agent runs for store 30de3878, 11:50:08Z to 11:57:44Z, all succeeded.
- .cerebro/ledger/store.json: store_id 30de3878.

</details>

### F90 — A single global reconciliation mode: 3 bad paths froze all 30, with all-or-nothing exits

- **Severity (claimed):** high
- **Category:** design
- **Verification:** survived (partially_confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/reduce.rs:761`
  - `src-tauri/src/ledger/reduce.rs:841-844`
  - `src-tauri/src/ledger/reconcile.rs:256-292`
  - `src-tauri/src/ledger/reconcile.rs:441-474`
  - `src-tauri/src/ledger/reconcile.rs:520-528`
  - `src-tauri/src/ledger/reconcile.rs:595-600`
  - `src-tauri/src/ledger/capture.rs:322`
  - `src-tauri/src/ledger/capture.rs:642`
  - `src-tauri/src/ledger/capture.rs:779`
  - `src-tauri/src/ledger/capture.rs:840`
  - `src-tauri/src/ledger/capture.rs:885`
  - `docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:391-395`

**Evidence**

reconciliation_open() is `!reconciliation_divergences.is_empty()`, one flag for the whole vault. While it is open, every capture entry point refuses every knowledge path (capture.rs x5), and launch_scan skips safe finalize/regenerate for ALL paths (`if !already_open`, reconcile.rs:277,286). Accept refuses the entire action if any single file fails ('one bad file kills the whole adoption', reconcile.rs:597-599). Restore regenerates every projection and also runs remove_file on any knowledge .md the reducer cannot explain (reconcile.rs:441-474). The M23 spec's restore only 'regenerates every affected projection' and never mentions deletion. Live: mismatch_count 3 out of projection_count 30, open since 2026-08-17.

**Impact**

In-app edits to any concept fail, and pending recoveries on healthy paths never run. The user's only working exit also throws away unrelated agent work and can delete files without a preview.

**Recommendation**

Quarantine per path. Replace the global map with a quarantined-path set. Capture refuses only quarantined paths, and launch_scan keeps executing safe branches elsewhere. Add per-path resolution events (keep this file / restore this file). Keep a global mode only for MassProjectionMismatch and the migration signals (the restore-signature cases where a global stop is justified). Restore must never delete; move unexplained files to a quarantine folder instead.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real. There is one vault-wide flag, `reconciliation_open()`, and it is true whenever `reconciliation_divergences` is non-empty.
- While that flag is set, all five human-capture entry points return `RECONCILIATION_SUSPENDED`. `save_note` and `update_frontmatter` in lib.rs pass that `Some(Err)` straight back, so every in-app knowledge edit fails, not just edits to the 3 bad paths.
- `launch_scan` skips `complete_entry` and `write_projection` for every path once `already_open` is set, but still reports those paths as finalized or regenerated. So recoveries on healthy paths are blocked vault-wide.
- Accept runs `diff_projection_file` with `?` on each non-Match path, so one forged file refuses the whole action.
- Restore regenerates all projections and removes every knowledge `.md` that is not in `projection_paths`. The M23 spec's restore text (L391-395) says only "regenerates every affected projection" and never mentions removal, so the deviation is real.

Where the claim overstates:
1. "Froze all 30" is too broad. The breaker suspends only human capture and launch recovery. The code says so itself (capture.rs L320: "agent writes continue"), and `write_concept` has no `reconciliation_open` check.
2. All-or-nothing Accept is the documented design (spec L386-387: "Refuse the entire action if any file ... forges provenance"), not a code defect. It is still a real usability trap here, because the forged-stamp files are exactly what the mode is about.
3. "Throws away unrelated agent work / can delete files" is not true for the live vault today:
   - All 30 knowledge `.md` files match the 30 manifest entries, so Restore would currently delete nothing.
   - `log.md`'s Aug 17 edit was already captured (seq 179), so it would be regenerated as it is on disk and survive.
   - What Restore would revert is the Aug 17 edits to the 3 divergent files. Those are the agent work in question, not unrelated work.
   - The deletion risk is real in the code, but latent (it needs an unexplained `.md` to exist).

**Evidence checked.** - src-tauri/src/ledger/reduce.rs:758-761: the doc comment says the mode is "OPEN exactly while this is non-empty".
- src-tauri/src/ledger/reduce.rs:842-844: `reconciliation_open() { !self.reconciliation_divergences.is_empty() }`.
- src-tauri/src/ledger/capture.rs:320-323, 642, 779, 840, 885: each returns `Err(RECONCILIATION_SUSPENDED)`. The comment at L320 reads "(agent writes continue)".
- src-tauri/src/lib.rs:96-108 and 111-129: `save_note` and `update_frontmatter` `return result` when capture returns `Some`, so in-app edits error out.
- src-tauri/src/ledger/reconcile.rs:256, 276-291: `if !already_open` gates `complete_entry` and `write_projection` for every path.
- src-tauri/src/ledger/reconcile.rs:313-326: out-of-band capture is skipped when the mode is already open.
- src-tauri/src/ledger/reconcile.rs:432-474: restore regenerates all `projection_paths`, prunes the manifest, and calls `remove_file` on any knowledge `.md` not in `projection_paths`.
- src-tauri/src/ledger/reconcile.rs:595-599: `diff_projection_file(...).map_err(...)?` has the comment "one bad file kills the whole adoption".
- docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:386-387: all-or-nothing Accept is by design.
- Same spec, L391-395: restore regenerates and finalizes, with no deletion mentioned.
- Live vault /Users/joseflagorio/Documents/test: 30 knowledge `.md` files, 30 manifest entries, zero set difference, so no current deletion exposure.

**Correction.** There is one global circuit breaker. While it is open:
- It suspends every human in-app knowledge edit, not just edits to the 3 divergent paths.
- It blocks every launch-time finalize/regenerate recovery, not just recovery of those 3 paths.
- Agent `write_concept` writes are NOT suspended.

Accept's all-or-nothing refusal is the specified design. In this incident it means Accept can never succeed, because the 3 files carry out-of-band changes to their generated stamp. Restore is therefore the only exit.

Restore would revert the Aug 17 edits to those 3 files (log.md's edit was already captured). The code can also delete unexplained knowledge `.md` files without a preview, and the spec never mentions that. In the live vault today the delete set is empty, so it would delete nothing now.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** Confirmed from code: the mode is one flag for the whole vault. While it is open, every human capture entry point refuses every knowledge path. save_note and update_frontmatter return that refusal directly, so in-app edits to all 30 concepts fail. launch_scan skips finalize and regenerate for every path. Accept is all-or-nothing, and on the live vault it fails because of the forged generated stamp. Restore regenerates every projection and deletes any knowledge .md it cannot explain, and the M23 spec does not mention that deletion.

Overstated in three places:
(1) "Froze all 30" is only true for human and out-of-band capture. Agent writes through write_concept keep working (capture.rs:321, shadow.rs:126, reconcile.rs:209: "agent writes continue"), and restore keeps them because they are in the ledger.
(2) "Pending recoveries on healthy paths never run" does not apply to this vault. All 30 manifest entries have write_state=complete, so nothing is pending.
(3) "Throws away unrelated agent work and deletes files" also does not apply here. The 30 .md files on disk match the 30 manifest entries exactly, so nothing would be deleted. Only 3 files differ by hash, and they are the 3 diverged paths. The log.md edit was already captured as projection.overridden at seq 179. On the other 27 paths, restore writes back the same bytes, so the only loss is the 3 Aug 17 edits (which are also defective). The deletion and silent-loss risks are latent design hazards, for example an out-of-band edit to a healthy path made while the mode is open. They are not a live outcome.

Real live impact: every human in-app edit to knowledge has been blocked for about 39 days, and "Keep my files" is a dead button.

**Evidence checked.** - reduce.rs:758-761, 841-844: reconciliation_open() = !reconciliation_divergences.is_empty(), one flag for the vault.
- capture.rs:319-323, 640-643, 777-780, 848-851, 882-885: each capture entry point returns RECONCILIATION_SUSPENDED.
- lib.rs:96-109, 112-128: save_note and update_frontmatter return the capture result, so in-app knowledge edits fail.
- reconcile.rs:256, 276-289: `if !already_open` gates complete_entry and write_projection for ALL paths.
- reconcile.rs:595-599: "one bad file kills the whole adoption".
- reconcile.rs:441-474: restore rewrites every projection and runs remove_file on .md files not in projection_paths.
- Spec lines 391-395: restore only "regenerates every affected projection"; deletion is not mentioned.
- Counter-evidence, agent path: capture.rs:321, shadow.rs:126 and reconcile.rs:209 all say "agent writes continue"; mcp.rs and knowledge.rs contain no reconciliation check.
- Live vault: the manifest has 30 entries, all write_state=complete. `find knowledge -name '*.md'` returns 30 files, the same set as the manifest (comm shows no difference). SHA-256 comparison shows only gcs-5-supervision-ratio.md, tx-6-changeover-transient-cross-channel-sync-disabled.md and tx-6-np-shared-j12-common-mode.md differ from the manifest.

**Correction.** One vault-wide reconciliation mode blocks human and out-of-band capture for all 30 knowledge paths. It also blocks launch-time recovery for every path. Agent write_concept writes are not blocked. Both exits are all-or-nothing: Accept fails on the live vault because of the forged provenance stamp, which leaves Restore as the only way out. On the live vault, Restore would revert only the 3 diverged files. The other 27 already match the recorded history, nothing is pending, and no file would be deleted. The deletion hazard (remove_file on any unexplained .md, with no preview and not in the spec) and the loss of uncaptured edits made while the mode is open are latent design risks, not current outcomes.

</details>

### F91 — 'Files-first, vault is source of truth' contradicts a gitignored, per-device ledger that claims authority over git-synced knowledge files

- **Severity (claimed):** high
- **Category:** design
- **Verification:** survived (partially_confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `AGENTS.md:7`
  - `src-tauri/src/ledger/reconcile.rs:441-442`
  - `src-tauri/src/ledger/reconcile.rs:76-79`
  - `src-tauri/src/git/commit.rs:21`
  - `src-tauri/src/git/commit.rs:49`
  - `src-tauri/src/git_commands.rs:107`
  - `src/git/SyncBadge.tsx:60`
  - `src-tauri/src/git/status.rs:101-116`
  - `src-tauri/src/git/conflict.rs:89`

**Evidence**

AGENTS.md:7 says 'the vault on disk is the source of truth', but restore says 'The ledger is the authority' (reconcile.rs:441). The ledger sits in `.cerebro/`, which git/commit.rs ignores and actively rm --cached's, so it never syncs. knowledge/*.md is git-tracked. The app's own pull (SyncBadge), discard (checkout HEAD) and conflict resolve (checkout --ours/--theirs) rewrite knowledge bytes with no ledger awareness. A concept revised on device B arrives with a new generated stamp, which is 'forgery'. A new concept from B hits 'path is unknown to both manifest and reducer' (reconcile.rs:78). Both open the global mode, and Restore would then delete B's new concept (reconcile.rs:472).

**Impact**

Normal use of the product's own sync and history features structurally triggers divergence. The 'authoritative' history is the only artifact that isn't backed up or portable.

**Recommendation**

Pick one authority. Proportional to a 30-belief vault: files win. Treat any observed file state as a captured external revision, so the ledger becomes an audit trail of observed states and never a reason to refuse or delete. The alternative is to make the ledger portable (committed or synced) and route git operations on knowledge/ through it. Either way, fix AGENTS.md:7 to state the knowledge exception.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** The mechanism is real. I read each cited path end to end.
- The ledger lives in `.cerebro/ledger`, which is gitignored and `rm --cached`'d, so it is local to one device. `knowledge/*.md` is tracked in git.
- Restore treats the ledger as the authority. It regenerates every projection and deletes any `knowledge/*.md` the reducer can't explain.
- `classify_path` sends an unknown knowledge path to Divergence.
- `diff_projection_file` hard-refuses any change to the `generated`/`verified` stamp as "forgery".
- Git pull, discard (`checkout HEAD`) and conflict resolve (`checkout --ours/--theirs`) all rewrite bytes with no ledger call.
- The M21 plan itself expects "Two Macs syncing one vault" (separate writer_ids) yet keeps the ledger untracked. So it knowingly accepts a history that can't be carried to another device, while the files it rules over are synced by git.

Corrections and overstatements:
1. Not every pull or discard causes divergence. A change to body or presentation fields with an unchanged stamp is captured as an `out_of_band` override. Divergence needs one of these:
   - a changed `generated`/`verified` stamp (any agent revision made on another device)
   - a new or unknown concept path
   - a deleted projection file
   - a file that won't parse
2. The mode does not open live. The watcher calls `capture_out_of_band` and throws away the error (`let _ =`). The divergence is recorded at the NEXT `launch_scan`, which runs at activation (`shadow.rs:144`).
3. "Keep my files" also fails on forged stamps (`resolve_accept` calls `diff_projection_file`). After a cross-device agent revision, Restore is the only way out, and it reverts or deletes the other device's work locally. Git history still has those bytes, so they can be recovered by hand.
4. This is NOT the cause of the live incident. The user's vault (`/Users/joseflagorio/Documents/test`) has no git remote, so no pull or sync happened. The incident came from a local Claude Code agent writing around the ledger. The claim describes a latent flaw for multi-device and git-history use, not what happened here.

Severity stays high. Once a remote is added, ordinary use of the app's own sync and history features can open the global capture-pause mode, and the only resolution deletes or reverts synced knowledge.

**Evidence checked.** - AGENTS.md:7 says "the vault on disk is the source of truth".
- src-tauri/src/git/commit.rs:21 has `IGNORE_ENTRIES = [".DS_Store", ".cerebro/"]`, and :47-50 runs `git rm -r --cached .cerebro`.
- src-tauri/src/ledger/mod.rs:2,9,45: `LEDGER_DIR = ".cerebro/ledger"`, "Not git-tracked".
- docs/superpowers/plans/2026-08-07-cerebro-m21-ledger-substrate.md:67-77: the ledger is not git-tracked, and "Two Macs syncing one vault must present different writer_ids".
- src-tauri/src/ledger/reconcile.rs:
  - :76-78 `(None, None) => Divergence("path is unknown to both manifest and reducer")`
  - :119-124 changed file => OutOfBandEdit; missing file => Divergence
  - :441-442 "The ledger is the authority… files … the reducer cannot explain are removed"
  - :457-474 WalkDir + `remove_file` for any krel not in `projection_paths`
  - :216-300 `launch_scan` walks every `knowledge/*.md`
- src-tauri/src/ledger/capture.rs:
  - :960-966 a changed `generated`/`verified` key returns Err "provenance forgery"
  - :767-783 `capture_out_of_band_with` -> `diff_projection_file`
- src-tauri/src/vault/watcher.rs:255-261: live capture result is thrown away (`let _ =`).
- src-tauri/src/ledger/shadow.rs:144: `launch_scan` runs only on activation.
- src-tauri/src/git/status.rs:101-116 `discard_file` = `checkout HEAD` / `clean -f`; src-tauri/src/git/conflict.rs:89 `checkout --ours/--theirs`.
- src/git/SyncBadge.tsx:60-64: pull then rescan, with no ledger call.
- Live vault: `git remote -v` is empty. `.gitignore` contains `.cerebro/`. 30 `knowledge/` files are tracked. So sync did not cause the current incident.

**Correction.** Confirmed: a gitignored ledger local to one device claims authority over git-synced knowledge files. Four corrections to the claim:
- Only some synced or git-rewritten changes cause divergence: a changed `generated`/`verified` stamp (an agent revision from another device), a new concept path, a deleted projection, or a file that won't parse. Pure body or field edits are captured as out-of-band overrides.
- The mode opens at the next launch scan, not live. The watcher throws away the capture error.
- "Keep my files" also refuses forged stamps, so Restore is the only way out, and it reverts or deletes the other device's work locally (still recoverable from git history).
- This design flaw did not cause the user's current banner. Their vault has no remote; the cause was a local agent writing around the ledger.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The code checks out on every point. AGENTS.md:6-7 says "vault on disk is the source of truth", but restore says "The ledger is the authority" (reconcile.rs:441-442). The ledger lives in `.cerebro/`, which is git-ignored and `rm --cached`'d (git/commit.rs:21, 49-52), while knowledge/*.md is git-tracked.
- A pulled concept revision changes the `generated` stamp. diff_projection_file hard-refuses that as "provenance forgery" (capture.rs:959-966).
- A pulled new concept is unknown to both the manifest and the reducer, which is a Divergence (reconcile.rs:76-79). "Keep my files" also refuses it, because diff_projection_file errors with "not a committed projection" (reconcile.rs:~596, capture.rs:936-939). The only way out is Restore, which deletes every knowledge .md the reducer can't explain (reconcile.rs:456-474). So the data-loss path is real.
- Overstatements:
  1. Detection runs only at vault activation. launch_scan's only caller is shadow.rs:144. A pull, discard or conflict resolve does not trip the mode right away; it trips on the next launch. Saying normal use "structurally triggers" divergence is right in outcome but not in timing.
  2. The live vault has NO git remote (`git remote -v` is empty; 47 commits, one author). The pull/sync path is not reachable there today, and it did not cause this incident. The incident was a Claude Code agent write that bypassed the ledger (established facts).
  3. A fresh clone on a new device is partly guarded. arm.rs migrates existing knowledge into a new per-device ledger. The failure is the fork afterwards: every later pull between two ledgers diverges.
  4. The single-device path is reachable. ChangesPage discard runs git checkout HEAD on a knowledge file (status.rs:101-116), which can restore an older generated stamp. But autosync commits often, so the window is narrow.
- Net: this is a real design defect with a data-loss exit for any synced or multi-device vault. It is not currently reachable in the user's live vault through sync, so medium rather than high.

**Evidence checked.** - AGENTS.md:6-7 "the vault on disk is the source of truth"
- src-tauri/src/ledger/reconcile.rs:441-442 "The ledger is the authority"; :456-474 remove_file for any knowledge .md not in projection_paths; :76-79 (None,None) => Divergence("path is unknown to both manifest and reducer"); :525-527 + ~596 accept refuses the whole action on any diff_projection_file error
- src-tauri/src/ledger/capture.rs:936-939 "is not a committed projection"; :959-966 generated/verified change => "provenance forgery"
- src-tauri/src/git/commit.rs:21 IGNORE_ENTRIES includes ".cerebro/"; :49-52 git rm -r --cached .cerebro
- src-tauri/src/git/status.rs:101-116 discard_file = checkout HEAD / clean -f; src-tauri/src/git/conflict.rs:89 checkout --ours/--theirs; src-tauri/src/git_commands.rs:107 git_pull; src/git/SyncBadge.tsx:60-68 pull then rescan (no ledger call)
- src-tauri/src/ledger/shadow.rs:144 is the ONLY caller of launch_scan (activation-time only)
- src-tauri/src/ledger/arm.rs:1-16: a fresh ledger migrates existing knowledge (guards the clone case, creates a per-device fork)
- Live vault /Users/joseflagorio/Documents/test: `git remote -v` empty, 47 commits all JLagorio; .gitignore contains .cerebro/

**Correction.** Structurally correct: a git-ignored, per-device ledger claims authority over git-synced knowledge files. A concept pulled, merged or discarded from git is refused (forged stamp, or path unknown to both manifest and reducer) at the NEXT app launch, not at pull time. "Keep my files" cannot adopt it; only Restore can close the mode, and Restore deletes new concepts that arrived from elsewhere. It is not reachable through sync in the user's live vault (no remote) and did not cause the current banner, which came from an agent write that bypassed the ledger. Local discard on the Changes page is a narrow single-device path to the same failure.

</details>

### F92 — The 'provenance forgery' rule treats a generated restamp like a verified self-certification

- **Severity (claimed):** high
- **Category:** design
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:958-967`
  - `src-tauri/src/ledger/reconcile.rs:595-600`

**Evidence**

`if key == "generated" || key == "verified" { return Err("provenance forgery ...") }`. The same refusal feeds live capture, launch capture and accept_current_files, so 'Keep my files' can never succeed for a file whose only provenance change is a newer generated.at. An out-of-band `verified` really is a trust escalation. A changed `generated` is at worst a downgrade, and the app's own legacy and git paths produce it routinely.

**Impact**

Harmless metadata drift is classified as tampering, which opens the global mode and makes adoption impossible. Today the user's only choices are to discard content or hand-edit timestamps.

**Recommendation**

Make `generated` non-diffable: capture reprojects the ledger's stamp and records the difference as an editorial note at most. For `verified`, refuse only an ADDED or CHANGED stamp that the ledger has no attestation for, and capture the rest of the file instead of refusing it whole. This is the smallest change that unblocks 'Keep my files' for the live incident.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The mechanism is real. `diff_projection_file` hard-refuses any change to `generated` or `verified` with an Err. It does not look inside the stamp, so a newer `generated.at` from the same actor is refused exactly like a changed `verified`.
- `resolve_accept_with` calls the same function and turns the Err with `?`, so one refused file makes the whole "Keep my files" action fail.
- In the live vault only the `at` value changed; `by: claude-code` stayed the same. The refusal fires on a timestamp bump alone, and "Keep my files" cannot close this incident.
- The legacy source is real. `vault/write.rs::write_concept` falls back to a file-first write that stamps a fresh `generated` when no ledger writer is active. The next scan then reads that as an out-of-band stamp change.
- Overstated 1: a changed `generated` is not "at worst a downgrade". `generated.by` decides whether the UI calls a note AI-written (okf.ts:1052-1057, `by.kind !== 'human'`) and which actor a write is committed under (concepts.rs:248-257). An out-of-band change to `by`, or removing the stamp, would pass AI text off as human-written, which is the exact risk the mcp.rs comments guard against. Refusing a `by` change is sound. The flaw is that the rule is too coarse: it does not separate an `at`-only restamp by the same actor from an attribution change.
- Overstated 2: "harmless metadata drift" is wrong here. The restamps came with real content edits (a self-referencing `about:`, duplicate log lines) that an agent made outside the ledger. The stamp change marked a real ledger bypass, not noise.
- Overstated 3: "routinely" is not shown. The legacy path runs only when no writer is active, and I found no git-path code that restamps `generated`.
- The claim that the user's only options are to discard the content or hand-edit timestamps holds for these 3 files.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:958-967: `if key == "generated" || key == "verified" { return Err("provenance forgery: the {key} stamp changed out of band — refused") }`. The check is on whole-value inequality with no sub-field check.
- src-tauri/src/ledger/reconcile.rs:595-600: `capture::diff_projection_file(&state, krel, &raw).map_err(|e| format!("accept-current-files refused at {path}: {e}"))?;`, with the comment "one bad file kills the whole adoption".
- src-tauri/src/vault/write.rs:600-625: the legacy file-first `write_concept` runs when `ledger::concepts::write_concept` returns None, which `shadow::with_writer` (shadow.rs:294-306) does when no writer is active. The frontmatter it writes carries a new `generated` stamped at mcp.rs:2501.
- src/engine/okf.ts:1052-1057: the AI-written check uses `generated.by.kind !== 'human'`.
- src-tauri/src/ledger/concepts.rs:248-257: `write_actor` is taken from `generated.by`.
- Live vault, knowledge/decisions/gcs-5-supervision-ratio.md: before (1a42ee4) `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`; on disk `by: claude-code, at: 2026-08-17T11:52:02Z`. Only `at` changed.
- The same pattern holds for risks/tx-6-np-shared-j12-common-mode.md (at 2026-08-17T11:57:37Z).
- src/lib/mockIpc.ts:222 mirrors the same refusal.

**Correction.** The provenance-forgery rule is too coarse, not wrong in principle. It refuses every change to `generated`, including an `at`-only restamp by the same actor, which is all that happened in the live incident. Because `resolve_accept_with` runs the same diff, "Keep my files" cannot resolve these files, and "Restore recorded history" is the only way out. But a change to `generated.by`, or removing the stamp, is a real attribution and trust change (it controls the AI-written label and the commit actor), so refusing that is correct. The incident's restamps also came with real, partly defective content edits made outside the ledger, so this was not harmless drift. The fix is to separate an `at`-only restamp from a `by` change, not to treat `generated` as benign. The legacy file-first write path can cause this, but that it happens "routinely" is not shown.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** Confirmed in code. diff_projection_file hard-refuses any change to `generated` or `verified` (capture.rs:961-967). accept_current_files calls the same function, and one refusal fails the whole action (reconcile.rs:595-600). capture_frontmatter_patch documents the same refusal. mockIpc.ts:221 mirrors it.

Confirmed in data. In the ledger, belief.created for gcs-5-supervision-ratio carries generated {by: claude-code, at: 2026-08-16T19:38:29Z}. On disk the file has generated {by: claude-code, at: 2026-08-17T11:52:02Z}. So the provenance change here is only a newer `at`, and it is exactly what blocks adoption.

The claim that the app's own path produces this holds up. Neither agents nor the model can set `generated`: the MCP write_concept stamps it server-side with the current time (mcp.rs:2501). vault/write.rs:write_concept falls back to the legacy file-first path whenever shadow::with_writer returns None. That happens with no active writer, or when active.vault != normalize(vault) (shadow.rs:294-300). That path writes a fresh server stamp and emits no ledger event, which fits the Aug 17 incident: a claude-code stamp and zero ledger events. So the app can refuse, as forgery, a stamp it wrote itself.

What I refute. "At worst a downgrade" is false for `by`: the project's own comments name disclaiming `generated.by` as the threat. Also, these files were not harmless metadata drift. They had substantive content and `about:` changes (including a self-reference), and capture would book them as human:owner edits. Severity stays high because this rule makes the non-destructive exit ("Keep my files") impossible for the user's actual open divergence. Only the rationale and the scope of the fix change.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:961-967: `if key == "generated" || key == "verified" { return Err("provenance forgery: the {key} stamp changed out of band — refused") }`. It compares the whole value, so an `at`-only change is refused.
- src-tauri/src/ledger/reconcile.rs:595-600: accept_current_files calls capture::diff_projection_file, and `.map_err(...)?` makes one bad file fail the whole adoption.
- capture.rs:870-903: capture_frontmatter_patch doc says "provenance stamps ... stay refused".
- src/lib/mockIpc.ts:221: the mock mirrors the same rule.
- src-tauri/src/mcp.rs:2499-2501 and 2647-2649: the server stamps `generated` {by: actor, at: now_iso()}. The comment reads "an agent that could choose its own generated.by could disclaim its own output", so a `by` change is not benign.
- src-tauri/src/vault/write.rs:~605-625: write_concept falls back to the legacy file-first path (no ledger event) when concepts::write_concept returns None.
- src-tauri/src/ledger/shadow.rs:294-300: with_writer returns None when there is no writer or the vault path does not match.
- Live ledger: seq 113 belief.created gcs-5-supervision-ratio has generated {by: claude-code, at: 2026-08-16T19:38:29Z}. On disk, /Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md has generated {by: claude-code, at: 2026-08-17T11:52:02Z} and a self-referencing about: [[gcs-5-supervision-ratio]].

**Correction.** The mechanism is right and it happens in the live vault. The rule compares the whole `generated` value, so a restamp where only `at` moved (same `by`) is refused as "provenance forgery". Live capture, launch capture and accept_current_files all share this refusal, so "Keep my files" cannot adopt these 3 files. Two parts are overstated. (1) "At worst a downgrade" is wrong for `generated.by`. The codebase treats a changed `by` as a real integrity risk, because an agent could disclaim its own output (mcp.rs:2499-2501, 2647-2649). Only the case where `at` changes and `by` stays the same is benign. (2) Adopting through this path records the edit as `human:owner` / out_of_band. Loosening the rule without care would let a human override absorb agent-authored content. A correct fix is narrow: accept a change to `generated.at` alone when `generated.by` matches the reducer's value, not drop the check. The "routinely" claim is also unproven. The legacy path is reachable, but I saw no evidence of how often it fires.

</details>

### F93 — Every layer throws away why a divergence happened: scan reasons, watcher refusals and banner detail

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:144`
  - `src-tauri/src/vault/watcher.rs:256-261`
  - `src-tauri/src/ledger/shadow.rs:363-364`
  - `src/app/ReconciliationBanner.tsx:17-21`
  - `src/app/ReconciliationBanner.tsx:46-47`
  - `src/lib/mockIpc.ts:568-596`

**Evidence**

launch_scan's ScanOutcome.divergent (path, reason) is dropped (`let _ = super::reconcile::launch_scan(...)`). The ledger.divergence body stores sample_paths but no reasons. LedgerStatus exposes only detection keys. The banner renders `divergences.length`, which counts events, not files ('1 unresolved' for 3 files), and turns a status-read failure into no banner, violating 'unavailable is never empty'. The live watcher discards capture refusals (`let _ = capture_out_of_band`), and its comment claims the launch scan 'retries', when in fact it escalates. The banner has no unit or e2e test, and the mock's mode is hard-coded closed.

**Impact**

The user sees a one-line alarm with no files and no reason, and needed an agent forensics pass to learn which 3 files and why. The only user-facing exit path has never run under test.

**Recommendation**

Persist per-path reasons (bounded) in the divergence event. Return {path, reason, class} in LedgerStatus. Have the banner list the files, name the count accurately and render a section-unavailable state on read failure. Log watcher refusals to runtime.db operational_log. Add a mock mode that can be opened so e2e can test both exits.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - Core claim holds: the per-path reason is created and then thrown away. No layer keeps it or shows it.
- Where it is overstated:
  - "Every layer throws away why" is too broad. The ledger event DOES keep WHICH files (sample_paths), just not WHY. The UI never shows those paths.
  - The watcher comment is not false. launch_scan does retry the capture (reconcile.rs:317-322). It is incomplete: it leaves out that a failed retry opens divergence mode instead of quietly trying again.
  - The banner does show the resolve error text (setError) when a button fails. So the forgery refusal on "Keep my files" would reach the user, but only after they click.
- Medium severity is right. This is a diagnosability and invariant gap, not data loss. The user needed a forensic pass to learn about 3 files and a "provenance forgery" reason that the code had in memory.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:144: `let _ = super::reconcile::launch_scan(...)` discards the ScanOutcome. No logging anywhere in shadow.rs, reconcile.rs or watcher.rs (grep for log/eprintln/tracing finds nothing).
- reconcile.rs:191-192: `divergent: Vec<(String, String)>` holds "the classifier's reason". Line 322 pushes the capture refusal reason into it. Lines 349-355 keep only paths (`.map(|(path, _)| path)`) for sample_paths.
- The LedgerDivergence body (lines 376-396) has no reason field.
- Live ledger seq 180 body: signals, digests, mismatch_count 3, sample_paths (the 3 files). No reasons.
- shadow.rs:363-364: LedgerStatus exposes only `divergences: Vec<String>` ("Unresolved divergence detection keys"). `detail` is the chain verdict sentence, not divergence detail.
- ReconciliationBanner.tsx:17-21: `.catch(() => setStatus(null))` means a failed status read shows no banner, which breaks "unavailable is never empty".
- Line 37: returns null when status is null.
- Lines 46-47: renders `status.divergences.length`, which counts detection keys (events), not files. So it says 1 while 3 files are affected.
- Line 33 does surface resolve errors.
- watcher.rs:256-261: `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);` with the comment "(or the launch scan) retries". Per reconcile.rs:311-323 the scan does retry, but on failure it escalates to divergent.
- Tests: grep finds ReconciliationBanner only in App.tsx:6,339. There is no ReconciliationBanner test and no e2e spec. ledgerStatus appears only in ipc.test.ts.
- mockIpc.ts:577-596: ledgerStatus is hard-coded `reconciliation_open: false`. resolveReconciliation (570-572) always throws.

**Correction.** The claim is right that the per-path divergence REASON is created in launch_scan and dropped at every hop: shadow.rs discards the outcome, the ledger.divergence body stores only sample_paths, LedgerStatus exposes only detection keys, and the banner shows only a count of divergence events (1 event covering 3 files). Also confirmed: the banner hides a failed status read as "no banner", it has no unit or e2e test, and the mock's mode is hard-coded closed.

Three corrections:
1. WHICH files is not lost. The ledger event keeps sample_paths; it is just never shown in the UI.
2. The watcher's "launch scan retries" comment is incomplete, not false. The scan does retry the capture, and escalates to divergence when the retry fails.
3. The banner does show resolveReconciliation errors (for example the forgery refusal) once a button is clicked.

</details>

### F94 — Coverage is a vocabulary with no producer, which pins every belief in the protected Blindness lane forever

- **Severity (claimed):** medium
- **Category:** complexity
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/schema/coverage.rs:1-37`
  - `src-tauri/src/ledger/reduce.rs:1133-1136`
  - `src-tauri/src/dynamics/coverage.rs:436-443`
  - `src-tauri/src/attention/lanes.rs:616-630`
  - `shared/policy/lanes.v1.json:16-22`
  - `src/lib/epistemic/schema.ts`

**Evidence**

KIND_COVERAGE_{FACT_RECORDED,ASSESSED,GAP,RESTORED} are referenced only in schema/, reduce.rs, conformance.rs and the TS twin. ACTOR_VAULT_INDEXER and ACTOR_RETRIEVAL_ENGINE appear outside the schema only in conformance.rs:4291-4299. With no assessments, coverage folds to Summary::Blind (dynamics/coverage.rs:440). The blindness lane emits CoverageUnassessed for every such facet (lanes.rs:629), and that lane is `protected: true`. Live runtime.db: 43/43 attention_signals rows have coverage_assessments=0; coverage_cache and coverage_dimension_cache hold 0 rows.

**Impact**

About 1.2k lines of schema plus reducer folds, a TS port and conformance vectors are maintained for events nothing can emit. Meanwhile the 'base itself' surface carries a permanent protected alarm the user can never clear.

**Recommendation**

Delete the coverage event family and fold until a real producer ships. At minimum, keep NoAssessments out of the protected Blindness lane: 'nobody built the assessor' is not a per-belief blind spot.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** I tried to refute this and couldn't. The claim holds.

- **No producer.** Outside `ledger/schema/`, the only code that builds or matches the four coverage kinds is `reduce.rs` (the folds), `conformance.rs` (test vectors) and the TS twin. No writer, MCP tool, ingest step or health step appends one.
- **Half-built health path.** `runtime/health.rs` only mentions `coverage.gap` in a doc comment.
- **Planned but never landed.** The M25–M28 handoff lists "coverage facts need adapter producers (M26.7)" and "the blindness threshold needs a ledger writer (M26.7)". Later the same handoff says "M26.7 — DONE. All six sub-phases landed", and none of those sub-phases is a coverage producer. So this is a planned seam that was never closed, not a design choice.
- **Always "blind".** With zero assessments, `coverage_of` returns `NoAssessments { summary: Blind }`. `lanes()` then calls `blindness()` for every facet of every belief, which emits `CoverageUnassessed`.
- **Can't be hidden.** `lanes.v1.json` marks the blindness lane `protected: true`. In `preferences.rs`, dismissals, the quiet cadence and the per-lane cap all sit inside `if !protected`, so nothing can hide these items. `attention_lanes` also only ever passes `Preferences::default()`.
- **Shown to the user.** The lane reaches the UI through `WhatsContested` in `BaseItself.tsx`.
- **Live data agrees.** The live ledger's 273 events have no `coverage.*` kind. In `runtime.db`, all 43 `attention_signals` rows have `coverage_assessments=0` and `open_coverage_gaps=0`, and `coverage_dimension_cache` / `coverage_cache` hold 0 rows.

Minor corrections, none of which changes the verdict:
- The line count is understated. `schema/coverage.rs` alone is 1201 lines, and `dynamics/coverage.rs` adds 920 more.
- "Never clear" is true only until a producer ships. Nothing is wrong with the fold itself: "Blind / nobody has looked" is an accurate statement. The defect is the missing producer plus the protected lane, which together make a permanent alarm the user can do nothing about.

Medium severity stands: it's constant noise in a protected lane, and there is no data-integrity impact.

**Evidence checked.** - `src-tauri/src/ledger/schema/coverage.rs:35-37` defines ACTOR_VAULT_INDEXER / ACTOR_RETRIEVAL_ENGINE. Grepping the kind constants, event bodies and actor constants outside `schema/` finds only `reduce.rs:1133-1136, 2721, 2773` and `conformance.rs:4216-4522`.
- `src-tauri/src/ledger/schema/mod.rs:174-177` defines the kind strings. The only other hit for those strings is a doc comment at `runtime/health.rs:14`.
- `src-tauri/src/dynamics/coverage.rs:436-443`: empty assessments return `Coverage::NoAssessments { summary: Summary::Blind }`.
- `src-tauri/src/attention/lanes.rs:437` calls `blindness()` for every facet; `lanes.rs:616-638` emits `Reason::CoverageUnassessed`.
- `shared/policy/lanes.v1.json`: blindness has `"protected": true`.
- `src-tauri/src/attention/preferences.rs:118-133`: dismissal, cadence and cap are applied only inside `if !protected`.
- `src-tauri/src/lib.rs:620-632`: `attention_lanes` uses `Preferences::default()`.
- `src/knowledge/BaseItself.tsx:619-621` renders the lanes.
- `docs/superpowers/plans/2026-08-09-m25-m28-handoff.md:238-245, 1296-1297` defer coverage producers and the blindness-gap writer to M26.7; `:986` then declares "M26.7 — DONE", with no producer landed (git log M26.7a-f covers conflict, attention, monitor, runtime and projection).
- Live ledger kind counts: vault.write 124, belief.created 30, belief.revised 28, proposal.* 58, batch.committed 29, migration 2, projection.overridden 1, ledger.divergence 1, coverage.* 0.
- `runtime.db`: attention_signals has 43 rows with `sum(coverage_assessments)=0` and `sum(open_coverage_gaps)=0`; `coverage_dimension_cache` and `coverage_cache` have 0 rows.

**Correction.** The substance is right. Scale correction: the dead weight is about 2.1k lines (1201 in `schema/coverage.rs` plus 920 in `dynamics/coverage.rs`), plus the TS twin and the conformance vectors, not about 1.2k. Also, the handoff deferred the producers to M26.7, which was later marked DONE without them. So this is an unfinished seam the docs wrongly call complete, not unused-by-design code.

</details>

### F95 — A 6.9k-line TS reducer twin exists only to replay conformance vectors; production uses 3 validators

- **Severity (claimed):** medium
- **Category:** complexity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/lib/epistemic/reduce.ts:1-6`
  - `src/lib/epistemic/schema.ts`
  - `src/lib/mockIpc.ts:10`
  - `src/lib/trigger/evaluation.ts:17`
  - `conformance/README.md:5-8`
  - `src-tauri/src/ledger/conformance.rs`
  - `AGENTS.md:109-114`

**Evidence**

reduce.ts (3341 lines) plus schema.ts (3585 lines) port reduce.rs 'fold-for-fold'. The only non-test imports are validateFieldPath and validateOverridePointer (mockIpc.ts:10) and isRfc3339 (trigger/evaluation.ts:17). conformance/README.md:7-8 claims 'mockIpc consumes the TS reducer', which is false. The browser mock has no ledger at all (mockIpc.ts:560-596). The scaffolding also includes conformance.rs (6018 test-only lines) and a 772K conformance/ directory.

**Impact**

Each of the 39 event kinds costs a Rust implementation, a TS port and a vector regeneration, and the TS copy protects no shipped behaviour. This is the twin-rule pattern AGENTS.md calls review-blocking.

**Recommendation**

Delete reduce.ts, the unused parts of schema.ts, and the conformance and soak TS tests. Move the pointer grammar that mockIpc needs into shared/policy data. Keep a few targeted Rust goldens rather than full cross-language vectors.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** The facts in the claim check out, but its framing and severity are overstated.
- Confirmed: reduce.ts has 3341 lines and schema.ts has 3585. reduce.ts:1-6 says it is a "fold-for-fold port of reduce.rs, replayed against the shared conformance vectors".
- Confirmed: across src/, e2e/ and scripts/, the only code outside src/lib/epistemic that imports it is mockIpc.ts:10 (validateFieldPath, validateOverridePointer) and trigger/evaluation.ts:17 (isRfc3339). reduce.ts is only run by conformance.test.ts and soak.test.ts.
- Confirmed: conformance/README.md:7-8 says "mockIpc consumes the TS reducer". That is false. mockIpc.ts:561-596 says the browser mock has no ledger and returns a fixed 'no-ledger' status. That makes it a stale doc comment, which AGENTS.md's "retired workaround comment" rule covers. conformance.rs:7-9 has the same claim in softer form.
- Confirmed: conformance.rs is 6018 lines and test-only (`#[cfg(test)] mod conformance;` at ledger/mod.rs:24-25). conformance/ is 772K across 29 files.
- Overstated, "the twin-rule pattern AGENTS.md calls review-blocking": that rule (AGENTS.md:97-99, not 109-114; 109-114 is the "absent is never zero" rule) is about POLICY rules in shared/policy/. It asks for parity through a shared artifact. The ledger reducer is schema and fold logic, and its parity uses exactly that kind of shared artifact: vectors generated by Rust, with a check that the committed bytes match regeneration. This was a deliberate M22.4 design, not an accidental duplicate. It is still a fair cost and value question: the TS copy guards no shipped runtime behaviour beyond three validators.
- "39 event kinds" was not verified.
- No bearing on the divergence incident. Nothing in the banner, capture or reconcile path touches the TS reducer.
- So this is maintenance cost plus one false doc claim, not a correctness or user-facing defect. Low, not medium.

**Evidence checked.** src/lib/epistemic/reduce.ts:1-6 (header: fold-for-fold port); wc -l: reduce.ts 3341, schema.ts 3585, conformance.rs 6018. grep of imports across src/e2e/scripts: only src/lib/mockIpc.ts:10 `import { validateFieldPath, validateOverridePointer } from './epistemic/schema'` and src/lib/trigger/evaluation.ts:17 `import { isRfc3339 } from '../epistemic/schema'`. conformance/README.md:7-8 says "(mockIpc consumes the TS reducer, not its own copy of the rules)", which is false per src/lib/mockIpc.ts:561-596 ("The browser mock has no ledger (M21.7)", where ledgerStatus returns verdict 'no-ledger'). src-tauri/src/ledger/mod.rs:24-25 `#[cfg(test)] mod conformance;`. du -sh conformance = 772K, 29 files. AGENTS.md:97-99: the twin-rule defect is scoped to shared/policy/ rules, with parity via a shared artifact, which is the mechanism the conformance vectors implement.

**Correction.** About 6.9k lines of TS (reduce.ts + schema.ts) port the Rust reducer and are only run by the conformance and soak tests. Production uses three validators from schema.ts. conformance/README.md:7-8 (and conformance.rs:7-9) wrongly say mockIpc consumes the TS reducer; the mock has no ledger. This is a deliberate, vector-checked parity design (M22.4), not the policy-twin defect that AGENTS.md:97-99 calls review-blocking. It is a cost and value question plus a stale doc to fix, with no link to the divergence incident. Severity: low.

</details>

### F96 — The epistemic ledger is mostly write amplification: shadow vault.write hashes, a log.md 'Belief' and an unread SQLite index

- **Severity (claimed):** medium
- **Category:** complexity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/vault/write.rs:263-272`
  - `src-tauri/src/ledger/shadow.rs:311-330`
  - `src-tauri/src/ledger/writer.rs:407-424`
  - `src-tauri/src/ledger/mod.rs:13-19`
  - `src-tauri/src/ledger/concepts.rs:25-29`
  - `src-tauri/src/ledger/index.rs:13-19`
  - `src-tauri/src/ledger/index.rs:339`
  - `src-tauri/src/ledger/soak.rs:83`

**Evidence**

Live ledger: 124 of 273 events (45%) are `vault.write` {path, content_hash} for inbox/, records/, types/ and collection.yml, and all 93 events after seq 180 are of this kind. No production code reads the kind (grep: tests only). Each append is F_FULLFSYNC under the global active() mutex that also gates knowledge writes. knowledge/log.md is modeled as a Belief (1 belief.created and 28 belief.revised by system:knowledge-log), even though concepts.rs:28 calls it 'not a claim about the world', and it was one of the incident's out-of-band paths (seq 179). index.rs materializes 15 epistemic tables on every activation (materialize at :339). Their only reader is dump_epistemic in the test-only soak.rs.

**Impact**

Every autosave of any note pays a full disk flush and lock contention for data nobody reads. Operational noise is mixed into the tamper-evident epistemic chain, against the accepted 'operational state out of the epistemic ledger' amendment and AGENTS.md's 'when in doubt: operational'.

**Recommendation**

Stop shadow-recording non-knowledge writes (drop the shadow_write call sites, or send them to runtime.db). Make log.md a view regenerated from the ledger instead of a Belief, and delete append_log_with. Shrink index.rs to the `meta` remembered-head row.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The details hold up in both the code and the live data.
- The headline does not. The ledger is not "mostly" write amplification: 55% of events (149 of 273) are real epistemic facts: 58 belief events, 29 proposals, 29 batches, the migration pair, one override and one divergence. The reducer builds state from those events, and production readers use that state: reconcile, the manifest, attention/status, dynamics, and convergence in lib.rs.
- The SQLite index is not wholly unread. Its `events` and `meta` tables are read in production (head hash at index.rs:280, `remembered()` for divergence detection via shadow.rs). Only the 15+ epistemic materialized tables are unread; `dump_epistemic` is their only reader and it runs in tests.
- The cost is real but small: one F_FULLFSYNC per note save, taken under the shared `active()` mutex. It is shadow mode from M21.8 and marked "additive-only" by design, so this is a design smell, not a defect.
- The strongest point is this one. After the seq-180 divergence opened reconciliation ("capture paused"), the shadow path kept appending `vault.write` (93 events). So the only ledger activity for ~39 days was operational noise, and nothing reads it.

**Evidence checked.** - **Live ledger** (…0001.ndjsonl.open, python tally):
  - Kinds: vault.write 124, belief.created 30, proposal.submitted 29, proposal.applied 29, batch.committed 29, belief.revised 28, migration.started/completed 1+1, projection.overridden 1, ledger.divergence 1.
  - Events with seq > 180: 93, all vault.write.
  - vault.write paths: records/ 54, inbox/ 24, test/ 15, home/ 15, types/ 14, work/ 2. This covers collection.yml, *.list.yml and types/*.md, which is broader than the claim's list, so a minor detail is wrong.
  - Belief actors: 29 belief.created by claude-code; system:knowledge-log with 1 created (the log.md one) and 28 revised.
- **Code:**
  - vault/write.rs:263-272 `shadow_write` hashes content and calls `ledger::shadow::record`. It is called with "vault.write" from save_note (:367), update_frontmatter (:334), create_note (:590), write_source (:681), set_note_title (:752), save_collection/list/view (:927/:946/:964).
  - shadow.rs:311-330 `record` locks the global `active()` mutex (the same one `with_writer` uses at :294, which concepts.rs:77/89/106 and mcp.rs:1596/1717 use for knowledge writes), then calls `writer.append`.
  - writer.rs:407-424 `append` calls `self.sync()` (sync_all = F_FULLFSYNC per mod.rs:13-19).
  - reduce.rs:883-886: `Ok(None) => continue, // plumbing: indexable, zero entity state`. grep finds no production reader of "vault.write" in Rust or TS; every hit is a test fixture.
  - index.rs:13-19 doc plus :338-339 `reduce` and `materialize` on replay.
  - The public readers are remembered/max_seq/event_count/dump_events/dump_epistemic. `dump_epistemic` (:453) is called only from index.rs tests and soak.rs:83 (`mod soak` is test-only, per the `#[cfg(test)]` block in mod.rs:38).
  - The index's events/meta tables ARE read (index.rs:280, 386).
  - concepts.rs:25-29 says append_log is "not a claim about the world", yet the log is recorded as a Belief.

**Correction.** - Several parts check out:
  - Non-knowledge saves (notes, records, inbox, types, collection/list/view yml) each append an F_FULLFSYNC'd `vault.write` event to the hash-chained epistemic ledger.
  - They take the same global mutex as knowledge writes.
  - No production code reads those events: the reducer skips them as "plumbing".
  - The index's epistemic materialized tables are unread outside tests.
  - knowledge/log.md is modeled as a Belief (1 created + 28 revised by system:knowledge-log), despite concepts.rs calling the log "not a claim about the world".
- It is overstated in three ways:
  - vault.write is 45% of events, not "mostly".
  - The index's events/meta tables are read in production for divergence detection.
  - The ledger's belief/proposal/batch events feed live production readers.
- The cost is one flush per save, and the shadow design was intentional under M21.8.
- It is a cleanup item: move vault.write to runtime.db or drop it, and treat log.md as operational. It is not a medium defect.

</details>

### F97 — Deferred-capability governance and never-exercised pipelines outweigh the product they serve

- **Severity (claimed):** medium
- **Category:** complexity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/trigger/mod.rs:1-11`
  - `src/lib/trigger`
  - `shared/policy/trigger-registry.v1.json`
  - `src-tauri/src/ingest/mod.rs:1-21`
  - `src-tauri/src/maintain`
  - `src-tauri/src/runtime`

**Evidence**

trigger/ is 7,114 Rust lines plus 1,446 TS, a registry JSON and goldens, for a module that says it 'authorizes nothing'. A fired gate licenses only 'a dated plan document'. Live runtime.db: trigger_evaluations has 10 rows, all from 2026-08-15. 25 of 36 runtime.db tables have 0 rows after about 40 days, including source_registration, ingestion_failures, resolver_outcomes, source_taint_assessments, ambient_*, maintenance_findings, responsibility_contracts and working_memory_manifests. The live ledger has 0 source.registered, observation.recorded, ingest.assessed or belief.attested events ever. All 30 beliefs were created on 2026-08-16 with the 'unsupported' basis (concepts.rs:34-36).

**Impact**

About 40k lines (ingest 9.3k, maintain 2.1k, trigger 7.1k, plus a large share of policy and runtime) have never produced a record on the user's only real vault. Every change to the ledger schema has to keep them compiling and consistent, which slows fixes like the ones above.

**Recommendation**

Replace the trigger module with a markdown decision checklist and delete the code. Put ingest, maintain and the evidence and independence machinery behind a cargo feature until a vault actually registers a source. Ratchet complexity down the same way coverage thresholds ratchet up.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The code is real, and so are the data facts. trigger/ is 7,114 Rust lines and src/lib/trigger is 1,446 TS lines. The mod.rs header does say "authorizes nothing" and that a fired gate licenses only "a dated plan document". ingest is 9,278 lines and maintain is 2,066.
- runtime.db has 36 tables and 25 of them have 0 rows, including every table the claim names. trigger_evaluations has 10 rows, all dated 2026-08-15.
- The ledger holds 273 events and none of them is source.registered, observation.recorded, ingest.assessed or belief.attested. All 30 belief.created events are dated 2026-08-16 and carry "unsupported" (see concepts.rs:34-36).
- The modules are reachable, not dead. IPC commands call them from lib.rs (trigger_run, trigger status, ambient enable/disable, and ingest::driver::reservation in the dispatch path). They go unused because ambient ingest is opt-in and off by default (ambient.rs:684 needs the setting to equal "true"). So "never exercised" is true of the live vault, but it is not a defect in the code.
- The impact is overstated:
  - "About 40k lines never produced a record" is wrong. trigger did write records (10 evaluations and 10 snapshots). runtime (16k lines) is used: runs, job_ledger, convergence_runs, attention_signals, operational_log and budget_days all have rows.
  - The lines that truly never recorded anything are about 11.4k (ingest plus maintain), plus parts of runtime and policy.
  - "It slows fixes like the ones above" has no evidence behind it. The divergence incident comes from capture.rs and reconcile.rs, not from these modules.
- What stands is a scope and maintenance-cost observation, not a correctness bug. Low severity.

**Evidence checked.** - src-tauri/src/trigger/mod.rs:1-11: "This module authorizes nothing … a fired result permits exactly one thing — a dated plan document".
- Line counts: trigger 7114, ingest 9278, maintain 2066, runtime 16358, policy 15833, ledger 39920 Rust lines; src/lib/trigger 1446 TS lines.
- runtime.db, read-only query: 11 of 36 tables have rows (job_ledger 19, lane_registry 7, attention_signals 43, operational_log 19, budget_days 11, budget_settings_versions 1, trigger_evaluations 10, trigger_input_snapshots 10, convergence_runs 26, vault_registry 2, runs 19). The other 25 have 0 rows, including source_registration, ingestion_failures, resolver_outcomes, source_taint_assessments, ambient_*, maintenance_findings, responsibility_contracts and working_memory_manifests.
- trigger_evaluations rows are timestamped 2026-08-15T04:05:47Z.
- Ledger event kinds across 273 events: vault.write 124, belief.created 30, proposal.submitted/applied 29, batch.committed 29, belief.revised 28, migration.started/completed 1 each, projection.overridden 1, ledger.divergence 1. None of the ingest, observation or source kinds appear.
- All belief.created events have ingested_at 2026-08-16 and contain "unsupported". concepts.rs:34-36 says "`unsupported` at creation".
- Reachability: lib.rs:661/668 (ingest::ambient enabled/set_enabled), lib.rs:713-717 and 749-775 (trigger status and trigger_run IPC), lib.rs:1320 (ingest::driver::reservation in the dispatch path).
- ingest/ambient.rs:684-689: enabled only when the setting == "true", so it is off by default.

**Correction.** About 11.4k lines (ingest and maintain) plus parts of policy and runtime have never recorded anything on the live vault. The cause is that ambient ingest is opt-in and off by default, not that the code is unreachable. trigger/ did write 10 evaluations on 2026-08-15, and runtime/ is actively used (runs, job_ledger, convergence_runs, attention_signals). Nothing shows these modules slowed the divergence-incident fixes. This is a scope and maintenance-cost concern, not a defect.

</details>

### F98 — Load-bearing comments falsified by M23.3 and M23.7, including one that describes the incident path as safe

- **Severity (claimed):** medium
- **Category:** stale-comment
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/vault/write.rs:612-615`
  - `src-tauri/src/ledger/shadow.rs:1-10`
  - `src-tauri/src/ledger/shadow.rs:288-292`
  - `src-tauri/src/lib.rs:1459-1460`
  - `src-tauri/src/knowledge.rs:3-7`
  - `src-tauri/src/knowledge.rs:19-21`
  - `src-tauri/src/mcp.rs:15-17`
  - `src-tauri/src/ledger/capture.rs:29-31`
  - `src-tauri/src/vault/watcher.rs:256-258`
  - `AGENTS.md:122-123`
  - `src-tauri/src/agent/mod.rs:657-674`

**Evidence**

(1) write.rs:614 says the M23.6 scan 'reconciles once a writer returns', but it escalates a restamped file to divergence. (2) shadow.rs:1-4 promises 'zero behavioral change', but the module hosts with_writer, the authoritative M23.3 write door. (3) shadow.rs:291 and write.rs:614 say 'ledger_status names why', but LedgerStatus has no writer-held field. (4) lib.rs:1460 says 'no UI', but ledger_status drives ReconciliationBanner. (5) knowledge.rs:4-7 says humans 'do not edit it' and that this is enforced at IPC, but lib.rs:98-106 captures human edits. (6) capture.rs:29-31 says 'valve opens at M23.7 — until then', and M23.7 has shipped. (7) AGENTS.md:123 says 'write_concept/verify_concept only'. (8) knowledge.rs:21 and mcp.rs:16 say write_concept is 'the only way into the bundle'. But user-authored runs get `--permission-mode acceptEdits` with no disallowedTools (agent/mod.rs:670-674), and agent/mod.rs:659 itself says acceptEdits 'auto-approves built-in writes' in the cwd, which is the vault.

**Impact**

Maintainers, and the agents that read this code, were told that the fallback write was reconciled and that the bundle had a single door. Both claims are false, and the first is the mechanism of the current incident.

**Recommendation**

Per AGENTS.md's 'retired workaround' rule, rewrite or delete each comment in the same change as the F1 through F4 fixes. Rename shadow.rs's authoritative half (for example ledger/active.rs). Either add knowledge/** to disallowed native tools for user-authored runs, or stop claiming single-door.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **write.rs:612-615** says the M23.6 scan "reconciles once a writer returns". The legacy path does call concept_write with frontmatter that carries the server-stamped `generated`. The out-of-band diff then hard-refuses any change to `generated` as "provenance forgery" (capture.rs:960-966), which leads to the divergence and reconciliation mode. So the comment is false, and resolve_accept hits the same refusal.
- **shadow.rs:1-4** says "No UI ... zero behavioral change". The same module hosts with_writer (L288-292), described as "the door the M23.3 canonical knowledge write paths use", and LedgerStatus carries reconciliation_open/divergences. Stale.
- **lib.rs:1459-1460** says ledger_status has "no UI". ReconciliationBanner.tsx:2,19 calls ledgerStatus. False.
- **knowledge.rs:3-7** says humans "do not edit it; enforced at IPC". lib.rs:98-106 save_note now captures knowledge body edits via capture_body_edit and only falls back to guard_human_write. The comment right above it (lib.rs:92-95) also still says agents reach the bundle "through write_concept alone". Stale.
- **capture.rs:29-31** says "valve opens at M23.7 — until then guard_human_write still refuses". M23.7 has shipped: save_note uses the valve and watcher.rs:256 says "M23.7: live out-of-band capture". Stale.
- **knowledge.rs:19-21, mcp.rs:15-17 and AGENTS.md:122-123** say write_concept is the only door. agent/mod.rs:657-674 gives non-internal runs `--permission-mode acceptEdits` with no --disallowedTools. Its own comment says acceptEdits "auto-approves built-in writes" in the cwd, and the cwd is the vault (L678). So the single-door claim covers MCP tools only, not the CLI's built-in Edit/Write.
- **watcher.rs:256-258** is cited, but the evidence names no falsified claim in it. The comment reads as accurate apart from "retries", since a forgery refusal escalates rather than retries.
- The claim is directionally right and the severity of medium fits: misleading invariants around the exact failure path. The two overstated details are covered in the correction.

**Evidence checked.** src-tauri/src/vault/write.rs:612-615 (legacy file-first comment "M23.6 scan reconciles once a writer returns"); src-tauri/src/ledger/capture.rs:960-966 (`if key == "generated" || key == "verified" { return Err("provenance forgery ...") }`); src-tauri/src/mcp.rs:42 DEFAULT_ACTOR="claude-code", mcp.rs:2501/2649 stamp generated {by, at}; live vault knowledge/decisions/gcs-5-supervision-ratio.md generated.by=claude-code at 2026-08-17T11:52:02Z, vault commit 1c8c9e9 at 11:52:09Z; src-tauri/src/ledger/shadow.rs:1-4 ("No UI ... zero behavioral change"), shadow.rs:288-292 (with_writer, "ledger_status names why"), shadow.rs:349-365 (LedgerStatus: verdict/detail/head/seq/segments/anomalies/reconciliation_open/divergences, no writer-active field); src-tauri/src/lib.rs:1459-1460 ("no UI") vs src/app/ReconciliationBanner.tsx:2,19; src-tauri/src/lib.rs:92-106 (save_note M23.7 capture valve before guard_human_write); src-tauri/src/knowledge.rs:3-7, 19-21; src-tauri/src/mcp.rs:15-17; src-tauri/src/ledger/capture.rs:29-31; src-tauri/src/vault/watcher.rs:255-258; AGENTS.md:122-123; src-tauri/src/agent/mod.rs:657-674 (acceptEdits for non-internal runs, no disallowedTools).

**Correction.** Every cited comment exists and nearly all are stale or false. Two details are overstated. (a) The claim that ledger_status "names why" is only partly false. LedgerStatus.verdict/detail does name a REFUSED ledger. What it cannot name is a writer that is absent because a second instance lost the lock or the vault was switched, since there is no writer-active field. (b) The data does not prove that the write.rs:612-615 legacy path is "the mechanism of the current incident". The Aug 17 stamp (generated {by: claude-code, at: 11:52:02Z}, committed at 11:52:09Z) fits both MCP write_concept falling back to the legacy path and a built-in Edit/Write under acceptEdits. Either way the comment is false: any legacy write_concept restamps `generated`, and the scan refuses that as forgery and escalates it to divergence instead of reconciling it.

</details>
