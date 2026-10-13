# Write-path census

> Audit lens `write-census` · first-pass auditor, each finding adversarially verified

## Summary

The Aug 17 incident was caused by the fallback in write_concept, the knowledge log append and verify_concept. When the window has no ledger writer they write files directly instead of failing. The Aug 17 files use the fallback's YAML format, which proves it. The window's writer is lost without any record (a second window or dev build is the likely cause), and every such write is certain to become divergence that 'Keep my files' cannot accept. Four other bypasses reach knowledge/: Claude Code's own Edit/Write on user-started runs (auto-approved), guard-dodging path spellings like './knowledge/…', git discard/pull, and out-of-band renames or deletes. Every out-of-band capture is recorded as `human:owner` (log.md is now frozen by one), and while reconciliation is open, agent writes and Verify still overwrite the disputed files.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F9 | critical | yes | write_concept, the knowledge log append and verify_concept fall back to writing files directly when this window has no ledger writer. This fallback is the direct cause of the Aug 17 divergence. |
| F10 | high | yes | When a window has no ledger writer, nothing tells the user or the code, and nothing stops a second Cerebro window from opening the same vault |
| F11 | high | yes | Agent runs started from the TS side (panel chat, background distill jobs, Agent records) can use Claude Code's built-in Edit/Write on knowledge/ files and skip write_concept |
| F12 | high | yes | Every out-of-band change is recorded as `human:owner`. The captured log.md override now freezes the knowledge log for good. |
| F13 | high | yes | The agent-side knowledge guard is a plain string-prefix check, so path spellings like './knowledge/…' or 'Knowledge/…' get around it on this case-insensitive disk |
| F14 | high | yes | While reconciliation is open, agent writes, Verify and proposal decisions still overwrite the disputed files. Verify signs off on content the user never saw. |
| F15 | medium | yes | The live watcher silently drops every refused out-of-band capture: forgery, alias removal, deletions and the reconciliation suspension alike |
| F16 | medium | yes | Git operations in the app, and git sync generally, conflict with the ledger by design: Discard, Pull and conflict resolution rewrite knowledge/ files the ledger cannot explain, and Restore permanently deletes them |
| F17 | medium | yes | There is no sanctioned way to rename, move or delete a knowledge file, and every unsanctioned way ends in reconciliation |
| F18 | low | yes | The mock backend's saveNote on knowledge/ paths does not match Rust's capture refusals, so tests never exercise the refused cases |

### F9 — write_concept, the knowledge log append and verify_concept fall back to writing files directly when this window has no ledger writer. This fallback is the direct cause of the Aug 17 divergence.

- **Severity (claimed):** critical
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/vault/write.rs:600-628`
  - `src-tauri/src/vault/write.rs:630-660`
  - `src-tauri/src/vault/write.rs:692-725`
  - `src-tauri/src/vault/write.rs:342-358`
  - `src-tauri/src/ledger/shadow.rs:294-307`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/mcp.rs:2539-2546`
  - `src-tauri/src/lib.rs:157-169`
  - `src-tauri/src/mcp.rs:1691-1693`

**Evidence**

`vault::write::write_concept` tries `ledger::concepts::write_concept`. When `shadow::with_writer` returns None (no writer, a refused verdict, a lost lock, or a vault mismatch), it drops to `concept_write` and serializes with serde_yaml. `append_knowledge_log` and `verify_frontmatter` fall back the same way. Live proof that this path ran: the Aug 17 commit 812605a5 wrote block-style YAML (`generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`, `- '[[compass-gcs-5]]'`). That is concept_write's serializer. The ledger projection spelling in project.rs:1-12, as seen in the Aug 16 bytes, is flow style: `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`. runtime.db operational_log has 6 agent runs between 11:51 and 11:57Z. The ledger has zero events between seq 178 (00:10Z) and seq 179 (11:58Z), and the types/risk.md write at 11:49Z is also unrecorded, so the whole process ran without a writer. Other paths behave the opposite way: decide_proposal, revert_application and MCP propose all fail closed with 'no active ledger writer'. The comment at write.rs:612-615 says 'the M23.6 scan reconciles once a writer returns'. That is false, for two reasons. Every legacy write re-stamps `generated.at` (mcp.rs:2501), and diff_projection_file hard-refuses that as 'provenance forgery' (capture.rs:965). A legacy-created concept is classified 'unknown to both manifest and reducer' (reconcile.rs:73-77).

**Impact**

An agent's knowledge edits (and a human Verify) made in a window without a writer get no ledger events and no provenance. On the next launch they are guaranteed to open reconciliation. 'Keep my files' refuses them for the same forgery reason. 'Restore recorded history' reverts them. This is exactly what happened to the 3 files still unresolved after 39 days.

**Recommendation**

Fail closed. When with_writer is None for a knowledge/ path, return a typed error such as 'knowledge is read-only in this window: <reason>' and do not write. Delete the legacy branches in write_concept, append_knowledge_log and verify_frontmatter, and delete the falsified comment in the same change.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **The fallback is real.** `vault::write::write_concept`, `append_knowledge_log` and `verify_frontmatter` each try `ledger::concepts::*` first. That call returns None whenever `shadow::with_writer` finds no active writer, and each function then writes the file directly. The only trace left is `shadow_write`, and `shadow::record` drops it when `writer` is None, so zero events is exactly what this path produces.
- **The fallback ran on Aug 17.** The bytes in commit 812605a5 match the legacy path and do not match the projection:
  - The frontmatter is serde_yaml block style: `- '[[compass-gcs-5]]'`, block `tags`, block `generated:\n  by/at`. `project.rs` renders `{by, at}` in flow style and `tags: [..]` inline.
  - The log line `* **Update**: [title](/decisions/...).` is exactly what `knowledge::insert_log_entry` produces.
  - `generated.by: claude-code` with a new `at` is the server-side stamp in `mcp.rs:2501`.
  - An agent editing through its own Edit tool would not re-serialize the file this way.
- **The claim is false that the M23.6 scan will reconcile these writes.**
  - Every legacy concept write re-stamps `generated.at`, and every legacy verify changes `verified`. `diff_projection_file` hard-refuses both as provenance forgery (`capture.rs` ~L962-966).
  - A concept created through the fallback is classified "unknown to both manifest and reducer" (`reconcile.rs:73-77`).
  - Revised and newly created concepts are therefore certain to open reconciliation.
- **Overstatements:**
  - (a) The log-append fallback does NOT cause divergence. `log.md` has no frontmatter, so it was captured as `projection.overridden` (seq 179). It was attributed to `human:owner`/`out_of_band`, which is a misattribution, not a divergence. The claim's "all three are guaranteed to diverge" is wrong for the log.
  - (b) The fallback is the proximate cause, but the root trigger is that no writer was active for this vault on Aug 17. The code does not record why:
    - `activate` returns a `writer: None` when the verdict is refused.
    - `LedgerWriter::open` fails when a second instance holds the lock.
    - `with_writer` returns None when the normalized vault path differs.
    
    Fail-open is documented design, not an accident, though the design is wrong.
  - (c) Critical is too high. The edits exist on disk and in vault git, so nothing is destroyed. The harm is lost provenance plus a stuck reconciliation, where the only exit that works reverts the edits. That is high severity.
- **Inconsistency confirmed.** Other paths fail closed on the same condition: `decide_proposal` (`lib.rs:157-169`) and MCP propose (`mcp.rs:1691-1693`) both return "no active ledger writer".

**Evidence checked.** Code:
- src-tauri/src/vault/write.rs:342-358 (`verify_frontmatter` falls back when `ledger::concepts::verify_concept` returns None).
- write.rs:600-628 (`write_concept` falls back to `concept_write`, a serde_yaml Mapping; the false comment "the M23.6 scan reconciles once a writer returns" is at L612-615).
- write.rs:692-725 (`append_knowledge_log` falls back to `insert_log_entry`).
- src-tauri/src/ledger/concepts.rs:68-106: all three call `shadow::with_writer`, so they return None when there is no writer.
- shadow.rs:294-307: `with_writer` returns None when there is no active target, the vault does not match, or the writer is None.
- shadow.rs:~320: `record` returns early when the writer is None, so the legacy writes leave no event.
- shadow.rs:113-121: `activate` sets the writer to None on a refused verdict or when `LedgerWriter::open` fails (a held lock).
- mcp.rs:2501: `generated: {by: actor, at: now_iso()}` is stamped on every write.
- capture.rs:~962-966: a change to `generated` or `verified` returns Err "provenance forgery".
- reconcile.rs:73-77: a file unknown to both manifest and reducer is classified as Divergence.
- project.rs:1-12: the canonical spelling is flow-style `{by, at}` with quoted wikilinks.

Data: `git show 812605a5` in /Users/joseflagorio/Documents/test:
- Frontmatter goes from flow `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }` and `tags: [ADR, ...]` to block `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`, `- '[[compass-gcs-5]]'`, and block tags.
- `log.md` gains `## 2026-08-17\n* **Update**: [GCS-5 ...](/decisions/gcs-5-supervision-ratio.md).`, the exact `insert_log_entry` format (knowledge.rs:287-288).
- The five commits between 04:51 and 04:57 -07:00 all carry the same `Cerebro-Ledger-Head` 619957fc.
- Side note: the diff shows `about` going FROM the self-reference `[[gcs-5-supervision-ratio]]` TO `[[arb-4-disposition]]`. The self-reference was in the Aug 16 ledger bytes, not introduced on Aug 17. This is the reverse of the incident fact list.

**Correction.** The fallback exists and it produced the Aug 17 concept writes; the bytes are serde_yaml output from `concept_write` plus the log line from `insert_log_entry`. It is the proximate cause of the divergence on the 3 concept files. The root trigger is that no ledger writer was active for the vault that day, and the code does not record why (a refused verdict, a second instance holding the lock, or a path mismatch).

Legacy concept writes and verifies are certain to diverge later: `generated.at` or `verified` always changes, which is refused as forgery, and a newly created concept is unknown to both manifest and reducer. The legacy log append does NOT diverge. It is captured as `projection.overridden`, misattributed to `human:owner`/`out_of_band` (seq 179).

Severity is high, not critical. Nothing is destroyed: the files are on disk and in vault git. The harm is lost provenance and a reconciliation mode that stays open.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Fallback exists as described.** All three paths go through `shadow::with_writer`, which returns `None` when there is no writer, the vault does not match, or the ledger was refused. Each then drops to a file-first write. The shadow event from that write (`shadow::record`) is also a no-op without a writer, so nothing reaches the ledger.
- **The Aug 17 bytes are the legacy serializer's output, not the projection's.** The file was re-spelled in serde_yaml block style: unindented `- '[[..]]'` lists, block `tags`, and `generated:\n  by:\n  at:`. project.rs defines flow style for `{by, at}` objects, and the Aug 16 parent bytes are in that flow style. The log.md lines match `insert_log_entry` exactly (`## date` heading, then `* **Update**: [title](/decisions/..).`). The `generated.at` value has the MCP layer's second-precision server stamp. An agent using the CLI's Edit/Write tools would not rewrite untouched fields into serde_yaml style, so the writes came through the MCP `write_concept` fallback.
- **Reachable in the live app.** runtime.db `runs` holds 6 attended agent runs between 11:50 and 11:57:44Z, scoped to this vault (`5171d169…`). `operational_log` ids 13-18 are timestamped at their ends. So the app process was up and serving MCP. Yet the ledger has nothing between seq 178 (00:10Z) and seq 179 (11:58:53Z). This includes no `vault.write` shadow events for the 11:49Z types/risk commit or for these writes, which fits "no writer in that process". The next launch then found the files by scan.
- **Chain to the banner holds.** The MCP layer always re-stamps `generated` (mcp.rs ~L2501). capture.rs ~L963 hard-refuses any change to `generated` or `verified` as "provenance forgery". The out-of-band capture therefore fails, escalates to divergence, and "Keep my files" is refused on the same files. The comment at write.rs:612-615 says the M23.6 scan reconciles these writes. For concept writes that promise is false.
- **Caveats (why high, not critical).**
  - The fallback is the direct write mechanism, but why that process had no writer is still unknown. Candidates are a second instance that lost the lock, or a refused startup verdict. The data does not say which.
  - The running binary was older than HEAD. Its files have no `description`, which became required in dedff4b (2026-08-17T01:31Z). The fallback itself has existed since M23.3 (58b17dd, Aug 9) and is still in HEAD, so the finding stands for current code.
  - The design is fail-open and loses provenance silently, but nothing was destroyed. The Aug 17 bytes are still on disk and in vault git.
- **Side note on the incident facts.** They have the `about:` defect backwards. The Aug 17 edit REMOVED the self-reference `[[gcs-5-supervision-ratio]]` and put `[[arb-4-disposition]]` in its place. The Aug 16 ledger-projected bytes are the ones with the self-reference.

**Evidence checked.** - **Fallback code:**
  - src-tauri/src/vault/write.rs:604-626: `write_concept` goes ledger-first, else `concept_write`, which uses serde_yaml `serialize_mapping`.
  - write.rs:692-718: `append_knowledge_log` falls back the same way.
  - write.rs:342-356: `verify_frontmatter` falls back the same way.
  - src-tauri/src/ledger/concepts.rs:68-107: each path returns `None` via `shadow::with_writer`.
  - src-tauri/src/ledger/shadow.rs:294-305: `with_writer` returns `None` for no active writer, a vault mismatch, or `writer: None`.
  - shadow.rs:310+: `record` is a silent no-op without a writer.
- **Fail-closed paths for contrast:** lib.rs:157-169 (`decide_proposal`) and mcp.rs:1691-1693 (propose).
- **Stamp and refusal:** mcp.rs ~L2501 stamps `generated {by, at: now_iso()}` on every write. src-tauri/src/ledger/capture.rs:961-966 returns "provenance forgery: the {key} stamp changed out of band — refused".
- **Classification:** src-tauri/src/ledger/reconcile.rs:73-77 marks a path "unknown to both manifest and reducer" as divergence.
- **Spelling contract:** src-tauri/src/ledger/project.rs:1-12 specifies `{ by, at }` objects in flow style.
- **Vault git:** `git show 812605a` in /Users/joseflagorio/Documents/test.
  - Old: `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`, `tags: [ADR, ...]`, `  - "[[compass-gcs-5]]"`, `  - "[[gcs-5-supervision-ratio]]"`.
  - New: `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`, block tags, `- '[[compass-gcs-5]]'`, `- '[[arb-4-disposition]]'`. No `description` key.
  - log.md: `## 2026-08-17\n* **Update**: [GCS-5 ...](/decisions/gcs-5-supervision-ratio.md).`, which matches knowledge.rs:287-288.
- **runtime.db:**
  - `runs`: 721fd174, a8e7a828, 37769bc1, ee2a46d7, 344cd412 and f3e456fa, 11:50:08-11:57:44Z, vault 5171d169… (/Users/joseflagorio/Documents/test), all succeeded.
  - `operational_log` ids 13-18 at 11:51:38-11:57:44Z.
- **Ledger:** seq 178 `vault.write` at 2026-08-17T00:10:35Z, then seq 179 `projection.overridden` at 11:58:53Z. Nothing in between.
- **History:** `git log -S` shows the fallback since 58b17dd (2026-08-09, M23.3). The description requirement arrived in dedff4b (2026-08-16T18:31 PDT), so the running binary predated it.

**Correction.** The mechanism is confirmed. The legacy fallback in write_concept, append_knowledge_log and verify_frontmatter wrote the Aug 17 files, and it produced no ledger or shadow events. The MCP layer re-stamps `generated` on every write, which makes the next launch's capture refuse the change as "provenance forgery" and open reconciliation. Two overstatements should be corrected. First, the fallback is the immediate write path, not the whole root cause: why that app process (up and running 6 agent runs from 11:50 to 11:57Z) had no active writer is undetermined. It could be a second instance that lost the lock or a refused startup verdict. Second, severity is high rather than critical: this is a silent fail-open that loses provenance and leaves reconciliation stuck, but no data was lost. Separately, the incident facts have the gcs-5 `about:` defect backwards. The Aug 17 edit replaced the self-reference with `[[arb-4-disposition]]`.

</details>

### F10 — When a window has no ledger writer, nothing tells the user or the code, and nothing stops a second Cerebro window from opening the same vault

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:118`
  - `src-tauri/src/ledger/writer.rs:955-969`
  - `src-tauri/src/ledger/shadow.rs:349-405`
  - `src/app/ReconciliationBanner.tsx:17-37`
  - `src-tauri/tauri.conf.json:5`
  - `src/git/useGit.ts:318-325`

**Evidence**

`activate` calls `LedgerWriter::open(&vault,&id).ok()`, which discards the error 'another Cerebro instance holds this vault's ledger — one writer per vault'. `LedgerStatus` has no field saying whether this process holds the writer. `status()` re-reads the disk, so a window that lost the lock still reports `valid`. The only UI consumer, ReconciliationBanner, renders only when `reconciliation_open` is true and swallows errors into null. It is never refreshed on vault-changed. There is no tauri single-instance plugin. Dev worktree builds and the installed app share the identifier com.cerebro.app, the same app-data folder and the same `lastVault` (config.json = /Users/joseflagorio/Documents/test), so both auto-open the same vault. The autosync commit trailer stamped the same head (Cerebro-Ledger-Head 619957fc…) on 5 consecutive commits that changed knowledge/. That pattern is a free tripwire for unrecorded writes, and nothing checks it.

**Impact**

A second window, a refused ledger, or an older build silently turns every knowledge write into the bypass in the first finding. The user learns about it days later as an unexplained divergence banner. Several code comments say 'the refusal is visible through ledger_status', and it is not.

**Recommendation**

Add `writer: held | lost_lock | refused{verdict}` to LedgerStatus and render it: 'Knowledge is read-only in this window — another Cerebro window holds the ledger'. Add a single-instance guard, or a per-vault check at open. Make autosync flag a commit that touches knowledge/ while the ledger head has not moved.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - Mechanism holds end to end.
- `activate` discards the writer-open error with `.ok()`. The lock error ("another Cerebro instance holds this vault's ledger") exists only in `writer.rs::acquire_lock`.
- `status()` calls `classify()` on disk and never checks the lock. So a window that lost the lock still reports `valid`, and `LedgerStatus` has no field saying whether this process holds the writer.
- With no writer, `write_concept` quietly falls back to the old file-first path. `shadow::record` does nothing, so knowledge files are written with a `generated` stamp and no ledger event. This is exactly the pattern in the Aug 17 incident: the owning instance's next launch_scan sees an out-of-band change to the `generated` stamp, calls it provenance forgery, and marks the vault diverged.
- The only UI consumer of `ledgerStatus` is ReconciliationBanner. It hides errors by setting status to null. It refreshes only on mount, when the vault prop changes, or after a resolve. It renders only when `reconciliation_open` is true.
- There is no single-instance plugin, and there is only one tauri.conf.json (`identifier com.cerebro.app`). Dev and installed builds share app-data and `lastVault` (`/Users/joseflagorio/Documents/test`).
- Comments that say the refusal "is visible through ledger_status" (vault/write.rs:614, shadow.rs:10/81/293, lib.rs:951/1476) are false in practice.
- Circumstantial fit: repo commits show active dev work on Aug 17 from 04:59 PT (11:59Z), right around the 11:51–11:57Z bypass writes. That makes a dev window plus the installed app on the same vault plausible, but not proven.
- Small caveat: the incident could also come from a refused verdict or a direct file write, not only a second window. The claim covers all of these.

**Evidence checked.** - `src-tauri/src/ledger/shadow.rs:113-121`: `LedgerWriter::open(&vault,&id).ok()`. The comment there admits "A held lock (second instance) lands in the None arm below: shadow stays silent there."
- `shadow.rs:1-10`, module doc: "silent no-op whenever there is no active writer ... a second app instance that lost the single-writer lock".
- `shadow.rs:349-405`: `LedgerStatus` has only verdict/detail/head/seq/segments/anomalies/reconciliation_open/divergences, with no writer-held field. `status()` reads `classify(&dir,...)` from disk.
- `src-tauri/src/ledger/writer.rs:955-969`: `acquire_lock`, the WouldBlock error string. A grep for lock/try_lock finds it only in writer.rs, never in recovery.rs.
- `src-tauri/src/vault/write.rs:600-628`: `write_concept` falls back to the old `concept_write` + `shadow_write` path when `ledger::concepts::write_concept` returns None. The comment says "the refusal is visible through ledger_status".
- `src/app/ReconciliationBanner.tsx:16-37`: `.catch(() => setStatus(null))`. Refresh runs only in `useEffect([refresh])` and after `act`. Returns null unless `reconciliation_open`.
- `src/App.tsx:339` is the only mount. `src/lib/ipc.ts:308` is the only `ledgerStatus` caller.
- `src-tauri/tauri.conf.json:5`: identifier `com.cerebro.app`. No other conf files. Grep finds no single-instance plugin.
- `~/Library/Application Support/com.cerebro.app/config.json`: `lastVault` = `/Users/joseflagorio/Documents/test`.
- `src/git/useGit.ts:318-325`: `withLedgerTrailer` stamps the disk head and does not check whether the head moved while knowledge/ changed.
- `git log` shows repo commits on 2026-08-17 from 04:59 PT onward, overlapping the incident window.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - I could not refute it. The no-writer state is silent in both code and UI, and nothing prevents it from happening.
- Why it is reachable: `activate` swallows the lock error with `LedgerWriter::open(..).ok()`. `start_watcher` also drops the verdict (`let _ = activate`). Nothing enforces a single instance. So a second Cerebro process on the same vault ends up with `writer = None` and gives no signal.
- What that does to writes: with no writer, `with_writer` and `ledger::concepts::write_concept` return None. `vault::write::write_concept` then takes the legacy file-first path. That path still writes the concept and log.md, but `shadow_write`/`record` quietly do nothing, so zero ledger events are recorded.
- The live data fits this exactly:
  - The Aug 17 log.md lines use the exact `insert_log_entry` format ("* **Update**: [Title](/path.md).").
  - Each concept got two log lines, and there are five "Update 2 notes in knowledge" commits.
  - So these writes went through Cerebro's own write_concept code (MCP), not a raw Edit by the agent. Yet the ledger holds no events between seq 178 (00:10Z) and seq 179 (11:58:53Z).
  - Then at 11:58:53Z a fresh `activate` got the writer and its launch scan opened the divergence.
  - This is the pattern you get when a process with no writer does the writing and a later activation picks up the writer.
- `ledger_status` cannot show the lost-lock case: `status()` reclassifies from disk. `classify` never checks the lock, and `LedgerStatus` has no field saying whether this process holds the writer. So a process that lost the lock still reports `valid`.
- The only UI consumer is ReconciliationBanner. It renders only when `reconciliation_open`, turns errors into null, and refreshes only on mount or when `vault` changes. It has no vault-changed listener.
- The commit trailer is written and never checked: the only occurrence of 'Cerebro-Ledger-Head' is where useGit.ts writes it.
- Corrections / nuances:
  1. For a ledger refused by its verdict (corrupt, rollback, etc.), `ledger_status` does report a non-`valid` verdict tag. The comments are accurate for that case, but no UI reads the verdict, so in practice nobody sees it. For the lost-lock case the comments really are false.
  2. A second window is not the only trigger. `Active` is one global slot (`replace_active`), and `with_writer` returns None when `active.vault != vault`. So within a single process, a later `activate` that replaced the active slot (another vault, or a vault that got no writer) also silently sends writes down the legacy path.
  3. The divergence is not undetectable forever: the M23.6 launch scan finds it at the next activation that gets the writer (it did here, 7 minutes later). But the scan escalates to divergence and does not capture the edit, because of the generated-stamp refusal.
  4. Today only one process holds the lock (`target/debug/cerebro`, PID 70308, per lsof), and there is no /Applications/Cerebro.app installed right now. So I can't prove from live state that a second window caused the Aug 17 bypass. I can only show it is consistent with the evidence and that nothing guards against it.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:113-121: `LedgerWriter::open(&vault, &id).ok()`, with the comment "A held lock (second instance) lands in the None arm below: shadow stays silent there".
- shadow.rs:1-10 (module doc): the no-writer state is "visible through `status`, never through behavior".
- shadow.rs:294-307 `with_writer` and :311-324 `record`: both return None / no-op when there is no writer or `active.vault != vault`.
- shadow.rs:345-405: `LedgerStatus` has no writer-held field; `status()` = `classify(&dir, ..)` + reduce from disk.
- src-tauri/src/ledger/writer.rs:955-969 `acquire_lock`: WouldBlock -> "another Cerebro instance holds this vault's ledger — one writer per vault".
- src-tauri/src/lib.rs:1478: `let _ = ledger::shadow::activate(&dir, &vault_path);` (verdict discarded).
- src-tauri/src/vault/write.rs:600-624: the legacy file-first fallback when `ledger::concepts::write_concept` returns None; its comment claims "the refusal is visible through ledger_status".
- src/app/ReconciliationBanner.tsx:16-37: `.catch(() => setStatus(null))`, refresh only via useEffect on [vault], returns null unless `reconciliation_open`.
- src/git/useGit.ts:318-325: only writes the trailer; grep finds no reader of 'Cerebro-Ledger-Head'.
- tauri.conf.json:5: identifier com.cerebro.app. A grep for single-instance in src-tauri/package.json found nothing.
- ~/Library/Application Support/com.cerebro.app/config.json: lastVault=/Users/joseflagorio/Documents/test.
- Live ledger timeline: seq 178 at 2026-08-17T00:10:35Z, seq 179 at 11:58:53Z (projection.overridden), seq 180 at 11:58:54Z (ledger.divergence). Vault git commits 812605a..e1770e4 at 04:51-04:57 PDT (11:51-11:57Z) sit in that gap.
- knowledge/log.md lines 4-9: duplicated "* **Update**: [..](/..md)." lines, which is exactly the `crate::knowledge::insert_log_entry` output (called from vault/write.rs:706 on the legacy path and ledger/concepts.rs:819 on the ledger path).
- lsof: only PID 70308 (target/debug/cerebro) holds .cerebro/ledger/lock now.

**Correction.** - The claim holds for the lost-lock / second-instance case.
- For a verdict-refused ledger, `ledger_status` does report the non-`valid` verdict; what's missing is any UI that reads it.
- The same silent fallback also happens inside one process: `Active` is a single global slot, so after a later `activate` replaces it (another vault, or this vault reactivated without getting the writer), `with_writer` returns None and write_concept falls back to legacy.
- The next writer-holding activation's launch scan does eventually catch the drift, but as a divergence rather than a capture.

</details>

### F11 — Agent runs started from the TS side (panel chat, background distill jobs, Agent records) can use Claude Code's built-in Edit/Write on knowledge/ files and skip write_concept

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/agent/mod.rs:640-675`
  - `src-tauri/src/agent/mod.rs:833`
  - `src-tauri/src/agent/mod.rs:152-160`
  - `src-tauri/src/agent/mod.rs:1305-1318`
  - `src/agent/useJobRunner.ts:457`

**Evidence**

`build_args` passes `--disallowedTools Read,Glob,Grep,Write,Edit,MultiEdit,…` only when `req.internal`. That flag is `skip_deserializing`, so every TS caller is false. Every other run gets `--permission-mode acceptEdits` with the vault as cwd. The file's own comment (mod.rs:657-660) says 'acceptEdits auto-approves built-in writes, so both are withdrawn' — for internal runs only. The test `the_default_is_cerebros_own_tools_and_never_a_shell` only checks that Write/Edit are missing from `--allowedTools`. acceptEdits does not depend on that list. Distill jobs spawn through `runAgent` in useJobRunner.ts:457, so the unattended main knowledge writer is covered too.

**Impact**

A model whose write_concept call is refused commonly falls back to editing the file directly. That skips server-stamped `generated`, the `verified` refusal (the M17.1 self-certification hole) and the ledger. With a writer active, the watcher then records the edit as a human override (next finding). If the edit touched generated or verified, the refusal is swallowed and the next launch opens reconciliation.

**Recommendation**

Always disallow Write, Edit, MultiEdit and NotebookEdit on non-shell runs, or deny knowledge/** in a PreToolUse hook. Replace the argv-only test with a probe against the real CLI that tries an Edit on knowledge/x.md.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real. `build_args` removes the built-in file and web tools (`--disallowedTools` plus `--permission-mode default`) only when `req.internal` is true.
- Only three Rust call sites set `internal: true`: assembly, ingest and maintain.
- `internal` is `#[serde(skip_deserializing)]`, so every TS `runAgent` caller gets `false`. The callers are useAgentChat, useJobRunner (learn/distill/stale/skill/agent jobs), MarkdownEditor and AskAiPopover.
- All of those runs spawn with `--permission-mode acceptEdits` and cwd = the vault. `--allowedTools` is an allow list, not a tool restriction, and nothing withdraws Edit/Write.
- The code's own comment (mod.rs:659) says acceptEdits auto-approves built-in writes. That is the reason internal runs withdraw them.
- One correction to the evidence: this is not a test-coverage oversight. `a_user_authored_run_keeps_its_shipped_surface_even_unattended` deliberately asserts that non-internal runs keep acceptEdits and get no `--disallowedTools`. The hole is by design, not accidental.
- Live data backs up the incident chain. runtime.db has six lane=`agent` runs between 2026-08-17 11:50:08Z and 11:57:44Z, each with proposals_submitted=0 and applied=0.
- job_ledger has `attempts` claims at 11:50:01Z for exactly the three diverged knowledge files. That is useJobRunner's attempts ledger, the background learn/stale queue, which spawns through `runAgent` at useJobRunner.ts:457.
- Those runs changed the files, and the ledger recorded zero events. That fits Claude Code's built-in Edit/Write bypassing `write_concept` (mcp.rs:2446), not a write_concept call.
- Caveat: I did not run the CLI binary to confirm how acceptEdits and `--allowedTools` interact. The repo's own comment and tests assert it, and the incident data matches.

**Evidence checked.** - src-tauri/src/agent/mod.rs:152-160: `#[serde(skip_deserializing)] pub internal: bool`. The doc comment says every TS caller "keeps the shipped ceiling model".
- src-tauri/src/agent/mod.rs:629-641: `INTERNAL_DISALLOWED` includes Read, Glob, Grep, Write, Edit, MultiEdit and NotebookEdit.
- src-tauri/src/agent/mod.rs:657-675: `if req.internal { --permission-mode default --disallowedTools ... } else { --permission-mode acceptEdits }`.
- src-tauri/src/agent/mod.rs:560-588: `tool_policy` grants Write/Edit only with shell, but that list feeds `--allowedTools` only.
- src-tauri/src/agent/mod.rs:833-838: spawn uses `.current_dir(vault)`.
- `internal: true` is set only at assembly/live.rs:163, ingest/spawn.rs:174 and maintain/live.rs:133.
- TS callers of `runAgent`: useAgentChat.ts:365, useJobRunner.ts:457, MarkdownEditor.tsx:689 and AskAiPopover.tsx:93.
- Test mod.rs:1170-1184 asserts `!--disallowedTools && acceptEdits` for user-authored unattended runs.
- runtime.db `runs`: six rows with lane=agent, started 2026-08-17T11:50:08Z to 11:54:54Z, outcome succeeded, proposals_submitted=0, applied=0.
- runtime.db `job_ledger`: `attempts` rows for knowledge/decisions/gcs-5-supervision-ratio.md, knowledge/risks/tx-6-changeover-transient-cross-channel-sync-disabled.md and knowledge/risks/tx-6-np-shared-j12-common-mode.md at 2026-08-17T11:50:01Z. useJobRunner.ts:338-339 claims these.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Mechanism: confirmed.** Only `req.internal` runs get `--permission-mode default` plus `--disallowedTools Read,…,Write,Edit,MultiEdit,…`. `internal` is `#[serde(skip_deserializing)]`, so every TS caller gets `--permission-mode acceptEdits` with the vault as cwd.
- **The allowlist does not stop built-ins.** In the default non-shell case `--allowedTools` leaves out Write/Edit, but the CLI treats it as an auto-approve list, not a limit on which tools exist. acceptEdits approves Write/Edit in cwd on its own terms.
- **The code knows this.** The file's own comment says as much, and there is no other guard: no `--tools`, no deny rule, and `--setting-sources user` drops vault settings.
- **Distill jobs are covered too.** They spawn through `runAgent` (useJobRunner.ts:457) without `internal`.
- **Live evidence it is reachable.** The one surviving CLI transcript for the live vault (permissionMode acceptEdits) shows the model calling the built-in `Agent` (Task) tool, which is not in the non-shell allowlist, and it ran without a denial.
- **Overstated: the incident link.** No evidence built-in Edit/Write was ever used on knowledge/ in the live vault. The Aug 17 edits that opened reconciliation did not come through this path.
  - Commit 812605a re-serialized the frontmatter in serde_yaml block style (`- '[[compass-gcs-5]]'`, `generated:` as a block).
  - It added a `* **Update**: [title](/decisions/...)` line under a new `## 2026-08-17` heading, which is exactly `knowledge::insert_log_entry`'s format.
  - It stamped `generated.by` the way the server does.
  - That is `mcp.rs` `tool_write_concept` on the LEGACY file-first branch of `vault::write::write_concept` (write.rs:606-626). It writes the file and only a shadow write when `ledger::concepts::write_concept` returns None (no active writer), so no ledger event is recorded.
  - It matches runtime.db: six attended `agent`-lane runs ending 11:51:38–11:57:44Z, each a few seconds before the five autosync commits.
- **Net.** The Edit/Write bypass is real and reachable but has not been seen happening. The divergence was caused by write_concept writing without the ledger while no ledger writer was active. That is a different, confirmed defect.
- **Severity lowered to medium.** Exploiting the bypass depends on how the model behaves, the panel path is attended, and the damage (skipped server stamp, self-applied `verified`) is still caught later by the launch scan.

**Evidence checked.** - src-tauri/src/agent/mod.rs:150-160: `internal` field is `#[serde(skip_deserializing)]`, with a doc comment saying every TS caller is untouched.
- mod.rs:621-641: INTERNAL_DISALLOWED includes Write, Edit, MultiEdit.
- mod.rs:657-675: `if req.internal { --permission-mode default --disallowedTools ... } else { --permission-mode acceptEdits }`. The comment admits "acceptEdits auto-approves built-in writes".
- mod.rs:560-588: tool_policy adds Write/Edit to the allowlist only when shell is on. The allowlist is not a denylist.
- grep of src-tauri/src finds `--disallowedTools` only at mod.rs:668 (plus tests). No other guard.
- src/agent/useJobRunner.ts:457: `runAgent(vaultPath, {...})` for distill, refresh, stale and agent jobs, with no internal flag possible.
- ~/.claude/projects/-Users-joseflagorio-Documents-test/638cbe80-….jsonl: permissionMode "acceptEdits". The built-in `Agent` tool ran and returned content with no denial. No Edit/Write calls in the surviving transcripts; the others were purged.
- Vault commit 812605a (2026-08-17T11:51:37Z) diff:
  - frontmatter re-serialized block-style
  - `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`
  - log.md gained `## 2026-08-17\n* **Update**: [GCS-5 ...](/decisions/gcs-5-supervision-ratio.md).`, which is the format of src-tauri/src/knowledge.rs:287 insert_log_entry, called only from mcp.rs:2542ff tool_write_concept.
- src-tauri/src/vault/write.rs:600-627: write_concept falls back to the legacy file-first path with only `shadow_write` (no ledger event) when `ledger::concepts::write_concept` returns None.
- runtime.db `runs`: 6 attended lane=agent runs, claude-opus-4-7, 2026-08-17T11:50:08Z–11:57:44Z. Their ends line up with the 5 commits (11:51:37, 11:52:09, 11:54:44, 11:56:52, 11:57:42 UTC).

**Correction.** Agent runs started from the TS side (panel chat, distill and other useJobRunner jobs, Agent records) do run with `--permission-mode acceptEdits` and no `--disallowedTools`. The CLI's built-in Edit/Write can reach knowledge/ files and skip write_concept, and nothing else guards against it. However, nothing shows this happening in the live vault. The Aug 17 edits behind the divergence banner came from the server's own write_concept on its legacy file-first branch (vault/write.rs:612-626, taken when no ledger writer is active). That branch writes the concept file and log.md with no ledger event, which is why the manifest and reducer disagreed. It is a separate, confirmed ledger-bypass defect inside write_concept itself.

</details>

### F12 — Every out-of-band change is recorded as `human:owner`. The captured log.md override now freezes the knowledge log for good.

- **Severity (claimed):** high
- **Category:** data-quality
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:790-830`
  - `src-tauri/src/vault/watcher.rs:255-261`
  - `src-tauri/src/ledger/reduce.rs:457-467`
  - `src-tauri/src/ledger/reduce.rs:3970-3974`
  - `src-tauri/src/ledger/concepts.rs:815-849`
  - `src-tauri/src/ledger/concepts.rs:541-554`
  - `src-tauri/src/ledger/schema/projection.rs:156`

**Evidence**

`capture_diff_with` hard-codes `actor_id: "human:owner"` (capture.rs:810, 822) for every watcher or launch-scan capture. It does this whatever wrote the bytes: an agent's fallback write, a CLI Edit, a git pull, or a sync client. Live evidence is seq 179: `projection.overridden` on log.md, actor human:owner, origin out_of_band. Its /body is the agent's five duplicated `**Update**` lines, which is system:knowledge-log content. Overrides are never cleared by later revisions ('A revision never silently clears a human overlay', reduce.rs:3970). `overlaid()` applies every override, and no production code emits `OverrideChange::Clear` (only schema tests do). So each future `append_log_with` commits a log.md revision that `project_belief` still renders with the Aug 17 body. The same masking hits any concept with a body override: `projection_is_stale` returns 'write_concept did not apply' after the revision has already been committed.

**Impact**

The ledger falsely says the owner wrote agent content. From the next write_concept on, knowledge/log.md silently stops recording changes. 'Restore' keeps the override, so the log will go on listing the Aug 17 updates that the restore reverted. Agents get a 'failed' result for writes that did commit, which invites retries or the Edit fallback in the previous finding.

**Recommendation**

Record out-of-band authorship as unattributed (for example `system:out_of_band` or `unknown`), never as the owner. Do not capture editorial overrides on the system-owned log.md; regenerate it instead. Give stale overrides a clear or supersede path, or drop a body override when a newer revision of the same field lands.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - **Attribution is real.** `capture_diff_with` hard-codes `actor_id: "human:owner"` for both the structured and editorial halves. The watcher calls it blind (`let _ = capture_out_of_band(...)`) for any knowledge/*.md change, whoever wrote it. The accept path (reconcile.rs ~L636) also stamps `human:owner`.
- **Live data matches.** Seq 179 is a `projection.overridden` on log.md, actor human:owner, origin out_of_band. Its /body holds the six duplicated `**Update**` lines for 2026-08-17 (agent content). The earlier log.md events (seq 12 to 171) all came from `system:knowledge-log`.
- **The override is permanent in production.**
  - reduce.rs:3970-3974 only marks overrides `stale`. It never removes them.
  - `overlaid()` applies every active override, and a /body op replaces the content wholesale (apply_overlay_op L4360).
  - `OverrideChange::Clear` is only built in `conformance.rs` (`#[cfg(test)]` in ledger/mod.rs) and schema tests. Every production `Set` passes `supersedes_override_event_ids: vec![]` (capture.rs:704, reconcile.rs:649, index.rs:1017).
- **The log freezes as claimed.** `append_log_with` revises from `current.content`, which is the un-overlaid revision, then writes `project_belief`, which is overlaid. So every later log entry is committed to the ledger but never reaches disk.
- **Restore keeps the override.** `resolve_restore_with` regenerates each file through `project_belief`, which applies overrides. After restore, log.md would still list the Aug 17 updates that the restore itself reverted.
- **Concept masking is real code, but latent here.** `projection_is_stale` runs after `route()` has already committed, so a concept with a /body override would return an error for a write that landed. In this vault no concept has an override: the other 3 captures were refused. Only log.md does.
- **The freeze is latent today.** Since seq 180, all 93 later events are `vault.write`; there have been no concept or log revisions since reconciliation opened. The freeze starts once the mode closes. That is certain with Restore, which is the only button that works.

**Evidence checked.** - **src-tauri/src/ledger/capture.rs:810,822:** `actor_id: "human:owner".to_string()` in `capture_diff_with`. L704: `supersedes_override_event_ids: vec![]`.
- **src-tauri/src/vault/watcher.rs:259-260:** `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`
- **src-tauri/src/ledger/reduce.rs:**
  - 3970-3974: "A revision never silently clears a human overlay" plus `override_state.stale = true`.
  - 457-467: `overlaid()` applies all overrides.
  - 4360-4363: a /body op replaces the content.
  - 4474: the Clear branch exists, but nothing in production emits it.
- **src-tauri/src/ledger/mod.rs:23-24:** `#[cfg(test)] mod conformance;`. It is the only non-schema builder of `OverrideChange::Clear`.
- **src-tauri/src/ledger/concepts.rs:**
  - 815-849: `append_log_with` builds `next` from `current.content`, the un-overlaid revision.
  - 887-888: then writes `project_belief`.
  - 372-376: `projection_is_stale` runs after `route()` commits.
  - 541-554: `ends_with` check on the intended body.
- **src-tauri/src/ledger/reconcile.rs:**
  - 443-446: `resolve_restore_with` writes `project_belief` for every path, so overrides are kept.
  - 636: the accept path also uses `common("human:owner")`.
- **Live ledger** (/Users/joseflagorio/Documents/test/.cerebro/ledger/…0001.ndjsonl.open):
  - seq 12-171: log.md events come from `system:knowledge-log`.
  - seq 179: `projection.overridden` log.md, `{'id':'human:owner'}`, out_of_band, /body holding the duplicated Update lines.
  - seq 181-273: all 93 events are `vault.write`, with no log revisions since.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Actor mislabel is real.** The watcher and the launch scan both reach `capture_diff_with`, which hard-codes `actor_id: "human:owner"`. Nothing inspects who wrote the bytes. "Keep my files" (`resolve_accept_with`) also stamps `human:owner`. In the live ledger, seq 179 attributes agent content to the owner: six duplicated `**Update**` lines under a new `## 2026-08-17` heading, in exactly the format `append_log_with` writes as `system:knowledge-log`.
- **The log freeze is real and permanent without a code change:**
  - A `/body` override replaces the content wholesale.
  - A revision only marks overrides stale, and nothing in production reads that stale flag.
  - Production code never emits `OverrideChange::Clear`. Every production `Set` passes `supersedes: vec![]`.
  - So each later `append_log_with` commits a `belief.revised`, then `write_projection` rewrites `log.md` with the Aug 17 override body. New entries are committed to the ledger but never show on disk.
- **Restore keeps the override.** `resolve_restore_with` regenerates every file through `project_belief`, which applies overrides. `log.md` would keep the Aug 17 lines while the three concept files revert.
- **Reachability caveats (why this is not overstated but is partly latent):**
  - Right now the open reconciliation already blocks capture. The ledger has zero `log.md` revisions after seq 179. The freeze shows up only once the mode closes, and Restore is the only way to close it.
  - `log.md` is the only override in the live ledger (one `projection.overridden` in 273 events). So the second harm, `projection_is_stale` giving a false "did not apply" after a committed write, cannot fire in this vault today. It follows from the code for any concept that has a body override.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:810,822: `actor_id: "human:owner".to_string()` in `capture_diff_with`, reached from `capture_out_of_band_with` (line 783).
- src-tauri/src/vault/watcher.rs:258-259: calls `capture_out_of_band` for every changed knowledge/*.md file.
- src-tauri/src/ledger/reconcile.rs:~632: the accept path uses `common("human:owner")`.
- src-tauri/src/ledger/reduce.rs:4360-4363: `apply_overlay_op` for `/body` sets `*content = value.clone()`, a full replacement.
- src-tauri/src/ledger/reduce.rs:457-467: `overlaid()` applies every override.
- src-tauri/src/ledger/reduce.rs:3970-3974: a revision only sets `stale = true`.
- grep for `OverrideChange::Clear` outside tests: only the reducer match arm (reduce.rs:4474) and the schema definition. Hits in conformance.rs and tests are test code. The production `Set` builders (capture.rs:702, reconcile.rs:647, index.rs:1011) pass `supersedes_override_event_ids: vec![]`.
- `maintain/` has no reference to overrides.
- src-tauri/src/ledger/concepts.rs:880-887: `append_log_with` ends with `project_belief` + `write_projection` for `log.md`.
- src-tauri/src/ledger/concepts.rs:541-554: `projection_is_stale` does a tail comparison, called after the commit at line 375.
- src-tauri/src/ledger/reconcile.rs:443-446: restore re-projects through `project_belief` and does not clear overrides.
- Live ledger (d62256b3…-0000000000000001.ndjsonl.open):
  - seq 179 `projection.overridden`: `path=log.md`, `actor=human:owner`, `origin=out_of_band`, base revision 29, `/body` diff adds the six duplicated `**Update**` lines.
  - Belief 49e24332… (`log.md`) has 29 revisions by `system:knowledge-log` (seq 12-171) and none after seq 179.
  - Seq 181-273 are all `vault.write`.
  - The whole ledger holds only one `projection.overridden`.

</details>

### F13 — The agent-side knowledge guard is a plain string-prefix check, so path spellings like './knowledge/…' or 'Knowledge/…' get around it on this case-insensitive disk

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/knowledge.rs:30-32`
  - `src-tauri/src/knowledge.rs:215-220`
  - `src-tauri/src/vault/write.rs:167-200`
  - `src-tauri/src/mcp.rs:2397`
  - `src-tauri/src/mcp.rs:2421`
  - `src-tauri/src/mcp.rs:2434`
  - `src-tauri/src/mcp.rs:155-164`
  - `src/engine/okf.ts:30-32`

**Evidence**

`is_knowledge_path` is `path == "knowledge" || path.starts_with("knowledge/")`. `safe_join` accepts `Component::CurDir` and resolves on the filesystem. `ls -d /Users/joseflagorio/Documents/test/KNOWLEDGE` succeeds, so the vault's volume is case-insensitive. The following MCP calls all pass `guard_agent_write` and write the real concept file: `update_frontmatter {path:"./knowledge/x.md", patch:{verified:…}}`, `append_to_note {path:"Knowledge/x.md"}`, and `create_note {folder:"Knowledge"}`. The scope check next to them already strips "./" (`scope_admits`, mcp.rs:159), but the knowledge guard does not.

**Impact**

An agent (for example one following instructions injected through an ingested source) can mark concepts verified or author pre-stamped concepts. The UI shows them as verified straight away, because the scanner reads the disk. The ledger never learns. The live watcher's forgery refusal is swallowed, and the next launch opens reconciliation.

**Recommendation**

Guard the canonical vault-relative path that safe_join resolves, not the argument string: reject CurDir, and case-fold on case-insensitive volumes. Use one resolver for both the guard and the write. Mirror it in mockIpc/okf `isKnowledgePath`.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** I traced the path from dispatch to disk and it holds. The only agent-side check on knowledge/ is a case-sensitive string-prefix test. Nothing between call_tool and the write normalises the path. safe_join only rejects `..`, absolute paths and symlink escapes. It accepts CurDir and hands the raw spelling to the filesystem. The vault's volume is case-insensitive APFS. So `./knowledge/x.md`, `Knowledge/x.md` or folder `Knowledge` all get past guard_agent_write and write the real concept file. That covers update_frontmatter (including `verified`), append_to_note and create_note (pre-stamped concepts). The scope check next to it strips "./", which shows the author knew about the spelling problem and fixed it only on that axis. Scope does not save you here: panel runs are unrestricted by default, so the scope check passes too.

Caveats (they do not refute the claim):
- (1) When a user-authored run has shell on, it gets native Write/Edit under acceptEdits. That is an easier bypass than this one, so this hole matters most when shell is off. It is also the likely route for the Aug 17 incident, since a model would not use odd path spellings on its own.
- (2) okf.ts isKnowledgePath is the UI/mock twin of the same string test. It is not the agent guard.
- (3) I did not trace the "watcher's forgery refusal is swallowed" part of the impact. The shadow event is recorded under the non-canonical rel path (for example `./knowledge/x.md`), so the ledger's record does not line up with the manifest key. That is consistent with "the ledger never learns".

Severity high is fair: it defeats the M17.1 self-certification boundary, and a prompt injection could reach it.

**Evidence checked.** src-tauri/src/knowledge.rs:30-32 `path == KNOWLEDGE_DIR || path.starts_with(&format!("{KNOWLEDGE_DIR}/"))` (no lowercase, no ./ strip); knowledge.rs:215-220 guard_agent_write only calls is_knowledge_path. src-tauri/src/mcp.rs:2397 (create_note guards raw `folder`), :2421 (update_frontmatter guards raw `path`), :2434 (append guards raw `path`), with no normalization before these calls in call_tool (mcp.rs:1306-1400). mcp.rs:155-164 scope_admits does `trim_start_matches("./").trim_start_matches('/')`, but the knowledge guard does not. src-tauri/src/vault/write.rs:167-200 safe_join allows `Component::Normal | Component::CurDir` and checks only containment. write.rs:327-335 update_frontmatter writes to safe_join(rel) with shadow_write(rel) under the raw rel. write.rs:578-591 create_note uses unique_rel_path(folder,...) and writes vault.join(rel). Live check: `ls -d /Users/joseflagorio/Documents/test/KNOWLEDGE` and `.../Knowledge` both resolve (APFS, case-insensitive). src-tauri/src/agent/mod.rs:580-585 and :665-677: with shell on, user runs get Write/Edit under acceptEdits, which is a separate and broader bypass. src/engine/okf.ts:30-32 is the same string test on the TS side.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The mechanism is real.** `is_knowledge_path` is a string-prefix check that is case-sensitive and does not normalize paths. `safe_join` accepts `CurDir`. The volume is case-insensitive APFS: `ls -d` succeeds for both `KNOWLEDGE` and `Knowledge`. Nothing in `call_tool` or the three tool bodies normalizes the path before the guard runs.
- **So the three calls get through for an unscoped run:**
  - `update_frontmatter` on `./knowledge/x.md` or `Knowledge/x.md`
  - `append_to_note` on `Knowledge/x.md`
  - `create_note` with folder `Knowledge`
  Unscoped runs are the panel and Agent records with no `scope:`. Their default grant is the full catalog.
- **The claimed ingested-source impact does not hold.** The runs that read ingested sources are ingest, maintain and assembly, all flagged `internal`. Their grant is `scope: Some(vec![])`, so `scope_admits` refuses every write target. Their `declared_tools` are only the proposal, report and organize tools, which excludes `create_note`, `update_frontmatter` and `append_to_note`. Those runs cannot exploit this.
- **Scoped Agent records are also blocked.** `scope_admits` compares case-sensitively and strips `./`, so `Knowledge/…` and `./knowledge/…` fail the scope check unless the scope already covers the knowledge folder.
- **For the runs that can reach the bypass, it adds almost nothing.** Non-internal runs start with `--permission-mode acceptEdits` and the vault as the working directory. The code's own comment says acceptEdits auto-approves built-in writes. Those runs can therefore write `knowledge/` directly with the CLI's native Write and Edit tools, which have no knowledge guard at all.
- **The Aug 17 incident is not evidence for this path.** Files stamped `generated.by: claude-code` with no ledger events are consistent with the native Edit tool, which needs no spelling trick.
- **Net:** a real correctness defect. The guard does not uphold its stated invariant, and it is inconsistent with `scope_admits`, which strips `./`. But its practical reach is limited to runs that already have an unguarded door into `knowledge/`. Medium, not high.

**Evidence checked.** - **Guard:** `src-tauri/src/knowledge.rs:30-32` is `path == "knowledge" || path.starts_with("knowledge/")`, with no normalization. `src-tauri/src/knowledge.rs:215-220` has `guard_agent_write` call it on the raw argument.
- **Call sites:** `src-tauri/src/mcp.rs:2397` (create_note, folder), `:2421` (update_frontmatter), `:2434` (append_to_note). All pass the raw path.
- **Scope check:** `src-tauri/src/mcp.rs:155-164`. `scope_admits` strips `./` and `/`, but only for scope, and compares case-sensitively. `call_tool` at `mcp.rs:1310-1407` has no path normalization.
- **Join:** `src-tauri/src/vault/write.rs:167-200`. `safe_join` accepts `Component::CurDir` and resolves on the filesystem. `create_note` (`write.rs:578-592`) writes `vault.join(folder/slug)`, which lands in the existing `knowledge/` folder on a case-insensitive volume.
- **Disk:** `ls -d /Users/joseflagorio/Documents/test/KNOWLEDGE` and `.../Knowledge` both succeed. `diskutil` reports APFS, case-insensitive.
- **Internal runs are fenced:**
  - `src-tauri/src/ingest/spawn.rs:138-143,161-174`: `scope: Some(vec![])`, `allowed_tools = proposal tools + REPORT + ORGANIZE`, `internal: true`.
  - `src-tauri/src/maintain/live.rs:99-133`: same pattern.
  - `src-tauri/src/agent/mod.rs:620-674`: internal runs get `INTERNAL_DISALLOWED` (Write, Edit and others).
- **Native writes are open for non-internal runs:** `src-tauri/src/agent/mod.rs:670-674` sets `--permission-mode acceptEdits` for every non-internal run. The comment at `:657-663` says acceptEdits auto-approves built-in writes and the vault is the working directory. Panel requests use `scope: None` (`lib.rs:1638`).

**Correction.** - **What holds:** `guard_agent_write` has a real prefix and case bypass. Unscoped user-authored runs (the panel, and Agent records without `scope:`) can reach it through `create_note`, `update_frontmatter` and `append_to_note`, using `./knowledge/…` or `Knowledge/…`.
- **Wrong detail 1:** ingested-source prompt injection does not reach it through the ingest, maintain or assembly runs. They have an empty write scope and no grant for those tools.
- **Wrong detail 2:** scoped agents are also blocked, because the scope check is case-sensitive.
- **Wrong detail 3:** the runs that can reach the bypass already have unguarded native Write and Edit into `knowledge/` under acceptEdits. So the bypass is a defense-in-depth hole, not the main door. It is probably not how the Aug 17 edits happened; the native Edit tool is the more likely route.
- **Fix:** normalize the path (strip `./`, apply path components, fold case, or canonicalize) before `is_knowledge_path`. Separately, address the native-tool door for panel runs.

</details>

### F14 — While reconciliation is open, agent writes, Verify and proposal decisions still overwrite the disputed files. Verify signs off on content the user never saw.

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/manifest.rs:184-242`
  - `src-tauri/src/ledger/concepts.rs:113-222`
  - `src-tauri/src/ledger/concepts.rs:323-370`
  - `src-tauri/src/policy/commit.rs:1300-1322`
  - `src/pages/KnowledgePage.tsx:311-318`
  - `src-tauri/src/ledger/reconcile.rs:208-210`

**Evidence**

Only the capture functions check `reconciliation_open()` (capture.rs:322, 642, 779, 840, 885). `write_concept_with`, `verify_with`, `append_log_with`, `project_applied`, decide_proposal and revert do not. `manifest::write_projection` records the prior hash but never compares the disk bytes to the manifest entry's `content_hash` before overwriting. `verify_with` pins `belief.current()` and hashes the reducer's projection (concepts.rs:188-205). KnowledgePage verifies `selected.entry`, which comes from the disk scan, and sends no content hash.

**Impact**

With the banner open, an agent revising gcs-5-supervision-ratio.md, or the user clicking Verify on it, silently throws away the Aug 17 bytes the banner is asking the user to decide about. The mode stays open. Verify attests the Aug 16 revision while the user is reading the Aug 17 text. The same thing happens outside reconciliation whenever a live capture was refused (next finding).

**Recommendation**

In write_projection, refuse to overwrite when the disk hash differs from the manifest entry. Have Verify send the hash of the bytes the user viewed and refuse on mismatch. Block agent writes to divergent paths while the mode is open.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real, end to end.** Only the capture paths check `reconciliation_open()`. The one other check is at reconcile.rs:912, which is the accept-current-files self-check. `write_concept`, `verify_concept`, `append_log` and `project_applied` have no gate.
- **`write_projection` never looks at the manifest entry before overwriting.** It hashes the bytes on disk only to fill `prior` or to spot a byte-identical write. It never compares that hash to the entry's `content_hash`, so an out-of-band file (the Aug 17 bytes) is overwritten with the reducer's projection.
- **Verify attests the ledger's version, not the one on screen.**
  - `verify_with` pins `belief.current()`, which is the reducer's (Aug 16) revision, and hashes `project(current)`. It then rewrites the file through `write_projection`.
  - KnowledgePage shows the body from `readNote` (the disk, i.e. Aug 17). It builds the patch from `selected.entry`, which comes from the scan, and sends no content hash.
  - Nothing in KnowledgePage checks for reconciliation.
  - Net effect: the user attests Aug 16 content while reading Aug 17 text.
- **The mode stays open after the overwrite.** It is driven by events (a divergence with no resolution), not by the files.
- **Nuances, which don't change the verdict:**
  - Agent writes staying available is deliberate. The reconcile.rs:208-210 doc says "Regular agent writes stay available while the mode is open; automatic capture does not." So the defect is the missing check of disk bytes against the manifest, plus Verify having no gate, not that writes are allowed at all.
  - "Silently throws away" is a bit strong. The vault's autosync git commits (1c8c9e9, 812605a) still hold the Aug 17 bytes, but the app offers no way to recover them and gives no warning.
  - The claim that the same thing happens outside reconciliation after a refused live capture is plausible, since `write_projection` behaves the same way everywhere.

**Evidence checked.** - src-tauri/src/ledger/manifest.rs:183-241: `prior` is the hash of the bytes on disk. It is compared only to `projection.content_hash` (the byte-identical shortcut), never to `manifest.entries[rel].content_hash`. The file is then renamed over unconditionally.
- `grep reconciliation_open` in src-tauri/src finds only capture.rs:322/642/779/840/885, reconcile.rs:256/408/514/912 and the reduce/shadow definitions. There are no hits in ledger/concepts.rs or policy/*.rs.
- ledger/concepts.rs:66-79, 96-106: the `write_concept` / `verify_concept` entry points go straight into `with_writer`.
- ledger/concepts.rs:152-205 (verify_with): `belief.current()` feeds `BeliefAttested` with `attested_content_hash` of `project(current)`, then `write_projection`.
- ledger/concepts.rs:323-370 (write_concept_with): `route`, then `project_belief`, with no check for reconciliation or the state of the disk.
- policy/commit.rs:1300-1322 (project_applied): it compares the manifest entry to the projection only. It never looks at the disk before calling `write_projection`.
- vault/write.rs:342-355 and 600-610: these call the ledger versions first, with no guard.
- ledger/reconcile.rs:208-210 doc: "Regular agent writes stay available while the mode is open; automatic capture does not."
- src/pages/KnowledgePage.tsx:281-292: the body comes from disk via `readNote`. At 311-318, `verifyPatch(selected.entry, …)` goes to `verifyConcept` with no content hash.
- No hits for "reconcil" in KnowledgePage.tsx; only App.tsx and ReconciliationBanner.tsx reference it.
- Vault `git log` for knowledge/decisions/gcs-5-supervision-ratio.md shows 1c8c9e9 and 812605a, so the Aug 17 bytes can be recovered from git.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** Checked reachability end to end. Human Verify goes KnowledgePage.verify, then ipc verifyConcept, then lib.rs:931 verify_concept. That runs knowledge::guard_verify (a path and key guard only), then vault/write.rs:350 into ledger::concepts::verify_concept. shadow::with_writer (shadow.rs:294) only checks that a writer is active and the vault matches, with no reconciliation gate. Agent writes go mcp.rs:1407 tool_write_concept, then vault/write.rs:609, then concepts::write_concept_with, with no reconciliation check either. The only reconciliation_open() callers are in capture.rs (the 5 cited lines), reconcile.rs and shadow.rs status. There are none in the policy/, concepts.rs or reduce.rs transition logic; reduce.rs:842 is only the predicate. No TS file other than ReconciliationBanner, App, ipc, mockIpc or epistemic reads ledger status, so the UI does not disable Verify. manifest::write_projection (manifest.rs:184-242) reads the disk hash only to record it as `prior` and never compares it to the manifest entry's content_hash, so it overwrites the out-of-band bytes. verify_with (concepts.rs:140-205) resolves belief.current() from the ledger and attests project(current.content, current.fields), then write_projection regenerates the file. The attested bytes are therefore the ledger revision, not the disk text the page shows. reconciliation_divergences are cleared only by ReconciliationResolved (reduce.rs:4541-4590), so the mode stays open. project_applied (commit.rs:1299-1321) skips a path whose manifest content_hash, digest and generating event equal the reducer's, which is true for the 3 disputed files. So proposal decisions reach them only when the proposal touches that belief. Live data: no belief events after seq 180, and disk hashes still differ from the manifest for all 3 paths, so the harm has not happened yet.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:294-306: with_writer has no reconciliation gate.
- `grep reconciliation_open` finds hits only in capture.rs:322/642/779/840/885, reconcile.rs:256/408/514/912, shadow.rs:392 and reduce.rs:842 (the definition). There are none in concepts.rs, policy/, mcp.rs, knowledge.rs, lib.rs or vault/write.rs.
- src-tauri/src/lib.rs:931-940: the verify_concept command runs guard_verify and then vault::write::verify_frontmatter.
- src-tauri/src/vault/write.rs:350 and :609: both go straight to ledger::concepts::*.
- src-tauri/src/mcp.rs:2446-2539: tool_write_concept has no mode check.
- src-tauri/src/ledger/manifest.rs:189-193: prior is hashed but never compared to the existing entry, and the file is renamed over.
- src-tauri/src/ledger/concepts.rs:140-205: verify_with attests project(current.content, current.fields) from the ledger, then write_projection.
- src-tauri/src/policy/commit.rs:1305-1317: project_applied `unchanged` skip.
- src/pages/KnowledgePage.tsx:311-318: verifyPatch(selected.entry,...) sends no content hash.
- Live vault: manifest vs disk sha256 for gcs-5 is e096dab8… vs b11f52e0…, for tx-6-changeover d3291abf… vs 14b6aa9e…, and for tx-6-np f9517aae… vs 176c6cf3… (all still diverged). Events with seq > 180 are 93 vault.write, none on knowledge/ paths, and there are no belief.* events.

**Correction.** The core claim holds. While reconciliation is open, nothing stops write_concept or verify_concept: there is no check in the Rust code path, in the reducer or policy, or in the UI. Both overwrite a disputed file with the reducer's projection, and Verify attests the ledger revision (the Aug 16 content plus the stamp), not the Aug 17 text on disk that the user is reading. One detail is overstated: proposal decisions (project_applied) re-project only beliefs whose manifest tuple differs from the reducer. For a disputed file the manifest still matches the reducer, so it is skipped unless the applied proposal itself changes that belief. The claim is reachable but has not happened in the live vault yet. Since the divergence at seq 180 the ledger holds only 93 vault.write shadow events (none for knowledge/ paths) and no belief.* events. All 3 disputed files still differ from the manifest. The overwritten Aug 17 bytes would also still be recoverable from the vault's git autosync history, so "silently throws away" is not permanent loss.

</details>

### F15 — The live watcher silently drops every refused out-of-band capture: forgery, alias removal, deletions and the reconciliation suspension alike

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/vault/watcher.rs:255-261`
  - `src-tauri/src/ledger/capture.rs:767-787`
  - `src-tauri/src/ledger/reconcile.rs:305-322`

**Evidence**

`let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`. A deleted file fails `read_to_string` (capture.rs:775). Forgery, alias removal, ambiguity and RECONCILIATION_SUSPENDED all return Err. None of them records a divergence event, an operational_log row, or a UI signal. Only the next `launch_scan` escalates them to divergence.

**Impact**

The user gets no warning while the file sits diverged. Meanwhile the unguarded overwrites in the previous finding can destroy the edit, and the problem only shows up after a restart as an unexplained banner.

**Recommendation**

Escalate a refused live capture the way launch_scan does (record the divergence and open the mode), or at least log it operationally and emit an event that refreshes the banner.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - The code is real and it runs. `debounce_loop` puts every changed `knowledge/*.md` path into `knowledge_pending`. That includes paths from remove events, because the insert does not depend on `relevant_change`. When the debounce fires, it calls `capture_out_of_band` and throws the `Option<Result>` away with `let _`.
- `capture_out_of_band` is just `shadow::with_writer(... capture_out_of_band_with)`. Neither function writes to any log, the operational log (runtime.db) or a UI event. There are no eprintln/log/tracing/operational calls in `capture.rs` or `watcher.rs`.
- Four cases return `Err` there and nothing records them:
  - a deleted file (`read_to_string` fails at `capture.rs:775`)
  - `RECONCILIATION_SUSPENDED` (`capture.rs:780`)
  - forgery, alias removal and ambiguity (all from `diff_projection_file`)
- The Err→divergent escalation happens in only one place, `reconcile.rs:305-322`. That is inside `launch_scan`, and its only production caller is `shadow::activate` (`shadow.rs:144`), which `lib.rs:1478` calls when a vault is opened. So a forged or deleted file sits undetected until the next activation, usually a restart. The watcher's own comment ("the next event (or the launch scan) retries") assumes the error is transient. That holds for a half-saved file but not for forgery or alias removal: a retry fails the same way every time.
- Fits the incident: seq 180, the divergence record from the next launch scan, flagged the three agent-edited files with forged `generated` stamps. There was no earlier record.
- Minor overstatement: dropping `RECONCILIATION_SUSPENDED` loses no warning, because the mode is already open and the banner is already showing. The finding is about the other three cases.

**Evidence checked.** - `src-tauri/src/vault/watcher.rs:240-261`: `knowledge_pending.insert(rel)` for any `knowledge/*.md` path, then `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`
- `src-tauri/src/ledger/capture.rs:171-173`: `capture_out_of_band` = `shadow::with_writer(vault, |w| capture_out_of_band_with(w, vault, rel))`
- `src-tauri/src/ledger/capture.rs:767-787`: `read_to_string(...)?` (a deleted file errs), `reconciliation_open` → `Err(RECONCILIATION_SUSPENDED)`, `diff_projection_file(...)?`. The doc comment says "the caller escalates those into reconciliation"; the watcher caller does not.
- `src-tauri/src/ledger/reconcile.rs:305-322`: `Err(reason) => outcome.divergent.push(...)`. This escalation exists only in `launch_scan`.
- `grep launch_scan`: the only non-test caller is `src-tauri/src/ledger/shadow.rs:144` inside `activate`, called from `src-tauri/src/lib.rs:1478`.
- `grep operational|eprintln|log::|tracing` in `capture.rs` and `watcher.rs`: no matches.

</details>

### F16 — Git operations in the app, and git sync generally, conflict with the ledger by design: Discard, Pull and conflict resolution rewrite knowledge/ files the ledger cannot explain, and Restore permanently deletes them

- **Severity (claimed):** medium
- **Category:** parity
- **Verification:** survived (partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/git/commit.rs:21`
  - `src-tauri/src/git/mod.rs:16-18`
  - `src-tauri/src/git/status.rs:102-116`
  - `src-tauri/src/git/remote.rs:181-211`
  - `src-tauri/src/git_commands.rs:142-160`
  - `src/pages/ChangesPage.tsx:106-116`
  - `src/app/StatusBar.tsx:104-116`
  - `src-tauri/src/ledger/reconcile.rs:455-474`
  - `src-tauri/src/vault/write.rs:999-1011`

**Evidence**

`.cerebro/` (ledger and manifest) is gitignored, while knowledge/ is tracked on purpose. `git_discard_file` runs `checkout HEAD --` or `clean -f` with no knowledge guard. `git_pull` fast-forwards pulled concepts in. Neither tells the ledger. A restored or pulled concept carries a different `generated.at`, which triggers the forgery refusal. A pulled new file is 'unknown to both'. A discarded untracked concept counts as 'disappeared out of band'. Every one of these ends in divergence. `resolve_restore_with` then calls `std::fs::remove_file` on every knowledge .md the local reducer cannot explain, whereas `delete_note` moves files to the trash ('user markdown is never hard-deleted').

**Impact**

Syncing knowledge between two machines through git, or clicking Discard on a knowledge change, always ends in reconciliation. 'Restore' then permanently deletes concepts that came from another device and have not been committed locally yet.

**Recommendation**

Refuse git_discard_file on knowledge/ paths, or route it through the ledger. After a pull, adopt knowledge/ changes through a dedicated 'imported from git' capture attributed to git, not the owner. Have restore move files to the trash instead of unlinking them.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** The core mechanism is real and reachable. `.cerebro/` (ledger and manifest) is gitignored while `knowledge/` is deliberately tracked. Discard, Pull and conflict resolution all rewrite knowledge files and never tell the ledger. The next launch scan then classifies what they did, and several of those outcomes are hard Divergence:
- a pulled or git-resolved file the ledger never saw: "path is unknown to both manifest and reducer"
- a discarded untracked concept: "a complete projection file disappeared out of band"
- any pulled, discarded or resolved revision whose generated/verified stamp differs: capture refuses it as provenance forgery
- any alias removal
- 5 or more mismatches making up at least 25% of the paths: the mass-restore signature

`resolve_restore_with` really does call `std::fs::remove_file` on every knowledge .md the reducer can't explain, while `delete_note` sends files to the trash.

Two parts are overstated.
(1) "Always ends in reconciliation" is wrong. A git-restored or pulled edit that keeps the generated/verified stamps and touches only the body or non-provenance fields goes through `diff_projection_file` fine and is captured as an out-of-band override. The live incident shows this: log.md was captured at seq 179. Divergence is reliable only for agent revisions (write_concept stamps a new generated.at), new files, deleted files, alias removals, or mass changes. Also, the live watcher swallows capture errors (`let _ =`), so divergence is only recorded at the next activation's launch scan, not at the moment of the pull or discard.
(2) "Restore permanently deletes concepts from another device that haven't been committed locally yet" is wrong. Anything that arrived through git pull or merge is by definition in local git history, so `remove_file` deletes only the working copy, and git can bring it back (which then re-triggers divergence). Restore permanently loses only knowledge .md files that were never committed, such as a locally written file the autosync hasn't picked up. Restore also overwrites pulled edits to existing concepts with the local ledger's bytes, but git can recover those too.

The design tension is explicit in code. git/mod.rs and commit.rs justify tracking knowledge/ so that agent writes "can be reviewed or reverted", but the ledger treats exactly that kind of revert as forgery.

**Evidence checked.** - src-tauri/src/git/commit.rs:21 — IGNORE_ENTRIES = [".DS_Store", ".cerebro/"]. The comments at L12-14 and mod.rs L16-18 say knowledge/ is tracked so writes "can be reviewed or reverted".
- src-tauri/src/git/status.rs:102-116 — discard_file runs `checkout HEAD --` for tracked files and `clean -f` for untracked ones. No knowledge guard, no ledger call.
- src-tauri/src/git/remote.rs:181-211 — pull runs `pull --ff-only` and falls back to a merge. No ledger call.
- src-tauri/src/git_commands.rs:142-150 — git_resolve_conflict has no ledger call.
- src/pages/ChangesPage.tsx:106-116 — discard, then refresh and rescan only.
- src/app/StatusBar.tsx:104-116 — sync pulls, then rescans only if files updated.
- src-tauri/src/vault/watcher.rs:260 — `let _ = capture_out_of_band(...)`: live capture errors are dropped.
- src-tauri/src/ledger/shadow.rs:144 — launch_scan runs at activation.
- src-tauri/src/ledger/reconcile.rs:73-88 — (None,None) gives "unknown to both"; (None,Some) with a file present gives Divergence.
- reconcile.rs:119-124 — "a complete projection file disappeared out of band"; parseable changed bytes are classed OutOfBandEdit.
- reconcile.rs:306-324 — mass signature, then capture; a failed capture escalates to divergent.
- src-tauri/src/ledger/capture.rs:961-966 — a changed generated/verified stamp gives "provenance forgery" Err, while body-only and non-provenance diffs are accepted (L1000+).
- reconcile.rs:455-474 — resolve_restore_with calls std::fs::remove_file on knowledge .md files not in state.projection_paths.
- src-tauri/src/vault/write.rs:999-1011 — delete_note uses trash::delete ("user markdown is never hard-deleted").
- Live vault: all 30 knowledge .md files are manifest entries, so any new pulled file would be "unknown to both". log.md's out-of-band edit was captured (seq 179), which shows not every git-borne edit diverges.

**Correction.** Discard, pull and conflict resolution bypass the ledger, and on next launch they open reconciliation whenever they:
- bring in knowledge files the ledger never recorded
- remove recorded projection files
- change a generated/verified stamp (i.e. any agent revision made through write_concept elsewhere or earlier)
- remove aliases
- hit the mass-mismatch threshold

Body-only or non-provenance edits made through git are captured silently as out-of-band overrides, so this is not "always". Restore hard-deletes (`remove_file`, not trash) any knowledge .md the local reducer can't explain. For pulled or merged files that loss is recoverable from local git history. It is permanent only for knowledge files that were never committed.

</details>

### F17 — There is no sanctioned way to rename, move or delete a knowledge file, and every unsanctioned way ends in reconciliation

- **Severity (claimed):** medium
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/lib.rs:970-1028`
  - `src-tauri/src/knowledge.rs:229-232`
  - `src-tauri/src/ledger/reconcile.rs:73-77`
  - `src-tauri/src/ledger/reconcile.rs:121`
  - `src-tauri/src/ledger/reduce.rs:4385-4396`

**Evidence**

The human rename_note, delete_note, set_note_title and create_folder commands all refuse knowledge/ paths. MCP has no rename or delete tool. No ledger event changes a Belief's projection path (apply_override checks `belief.path` against the path fixed at creation). The only retirement op, the `tombstone_belief` proposal, sits behind agentProposalsEnabled=false in this install (config.json). A rename in Finder, Obsidian or git classifies as 'unknown to both' plus 'a complete projection file disappeared out of band', which is divergence. Restore recreates the old path and unlinks the new one.

**Impact**

A user tidying up the knowledge folder outside the app unknowingly opens the banner. Any resolution either reverts the tidy-up or fails.

**Recommendation**

Add a human 'retire/move concept' action backed by ledger events. Until one exists, detect an out-of-band move by matching content hash (same bytes, new path) and adopt it rather than declaring divergence.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** I could not refute the claim. Every part of it holds up in the code, and all of it is reachable.
- **Human IPC:** `rename_note` runs `guard_human_move`, which checks both the source and the destination. `delete_note`, `set_note_title` and `create_folder` all run `guard_human_write`. So the app refuses to rename, move or delete anything under knowledge/.
- **MCP:** there is no rename, move or delete tool. The test `no_tool_deletes` enforces that no tool name contains delete, remove or trash.
- **Ledger:** `apply_override` rejects any path other than the Belief's path, which is fixed when the Belief is created. No event re-paths a projection.
- **Retirement:** `tombstone_belief` is a HIGH-risk agent proposal op, not a human action. It retires a belief; it does not rename one. It is gated by `agentProposalsEnabled`, which is false in the live config.json.
- **Out-of-app rename:** the launch scan builds its path list from manifest keys, knowledge/*.md files and reducer paths. The new path has no manifest entry and no reducer state, so it is classified "unknown to both" and marked divergent. The old path's entry is Complete but its file is gone, so it is also divergent ("disappeared out of band"). Capture only runs when nothing is divergent, so these paths are never captured.
- **"Keep my files":** `resolve_accept_with` returns an error outright when any expected file is missing ("a deleted projection has no bytes to adopt; restore ledger authority instead"). `diff_projection_file` also refuses unknown paths. Either way the action fails.
- **"Restore recorded history":** `resolve_restore_with` rewrites every reducer projection at its original path. It then deletes every knowledge/*.md the reducer cannot explain, which includes the renamed file.

Minor nuances that do not change the verdict:
- Divergence only opens at the next launch scan, not the moment the file changes.
- Creating a copy with `write_concept` under a new slug is possible, but the old file stays, so it is not a rename.
- The same trap covers a plain delete, not just a rename or move.

**Evidence checked.** - `src-tauri/src/lib.rs:969-972` (`set_note_title`), `1006-1010` (`create_folder`), `1012-1016` (`rename_note` → `knowledge::guard_human_move`), `1018-1026` (`delete_note` → `guard_human_write`).
- `src-tauri/src/knowledge.rs:229-232`: `guard_human_move` guards both `from` and `to`.
- `src-tauri/src/mcp.rs:749-907`: the tool list (`create_note`, `update_frontmatter`, `append_to_note`, `write_concept`, `cache_source`, `propose_organize`, `open_note`, `navigate`, etc.) has no rename or delete. `mcp.rs:4282-4294`: test `no_tool_deletes`.
- `src-tauri/src/ledger/reduce.rs:4376-4396`: `apply_override` refuses when `body.path` differs from `belief.path`.
- `shared/policy/policy.v3.json:879`: `tombstone_belief` has base_risk HIGH and transition tombstone.
- `~/Library/Application Support/com.cerebro.app/config.json`: `"agentProposalsEnabled": false`.
- `src-tauri/src/ledger/reconcile.rs:73-77`: `(None, None)` → Divergence "path is unknown to both manifest and reducer". `reconcile.rs:121`: Complete entry with a missing file → Divergence "a complete projection file disappeared out of band".
- `reconcile.rs:228-252`: the scan's path list is manifest ∪ knowledge files ∪ reducer paths. `reconcile.rs:309-322`: capture runs only when `outcome.divergent.is_empty()`.
- `reconcile.rs:586-593`: accept returns an error on a missing file ("restore ledger authority instead"). `reconcile.rs:608-611`: `diff_projection_file` refuses unknown paths, and one refusal fails the whole action.
- `reconcile.rs:442-472`: restore rewrites every `projection_paths` entry at its original path and runs `remove_file` on every knowledge .md not in `projection_paths`.

</details>

### F18 — The mock backend's saveNote on knowledge/ paths does not match Rust's capture refusals, so tests never exercise the refused cases

- **Severity (claimed):** low
- **Category:** parity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/lib/mockIpc.ts:187-202`
  - `src/lib/mockIpc.ts:568-593`
  - `src-tauri/src/lib.rs:97-109`
  - `src-tauri/src/ledger/capture.rs:834-873`

**Evidence**

Rust save_note on a knowledge/ path is refused in three cases: when reconciliation is open (RECONCILIATION_SUSPENDED), when the file is not a committed projection, and when there is no writer (READ_ONLY). The mock writes unconditionally. The mock's ledgerStatus hard-codes `reconciliation_open: false`, and its resolveReconciliation always throws.

**Impact**

No vitest or e2e test covers the banner, the paused capture, or the no-writer refusal. AGENTS.md's rule that 'mockIpc mirrors every Rust guard' is broken for exactly the paths behind this incident.

**Recommendation**

Give the mock a switchable ledger state (writer held or lost, mode open or closed) that mirrors the three refusals, and add an e2e spec for the banner.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The code facts hold. Rust `save_note` on a `knowledge/` path goes through `capture_body_edit`. That path refuses in two cases: reconciliation is open (RECONCILIATION_SUSPENDED), or the path is "not a committed projection". When no writer is active, `capture_body_edit` returns None and `guard_human_write` refuses with READ_ONLY. So there are three refusals, and all are reachable.
- The mock's `saveNote` never calls `guardHumanWrite` and writes unconditionally. It only requires the file to already exist. The mock's `ledgerStatus` hard-codes `reconciliation_open: false`, and `resolveReconciliation` always throws.
- No `ReconciliationBanner` test exists in `src/` or `e2e/`. The only TS test on these commands is `ipc.test.ts`, which checks that the commands exist on both sides.
- Overstated point 1: "tests never exercise the refused cases" is not true for Rust. `reconcile.rs:1371-1388` asserts that capture is refused while reconciliation is open, but it calls `capture_structured_with`, not `capture_body_edit`. `knowledge.rs:732` and `:917` test `guard_human_write`. The real gap is narrower: nothing in Rust calls `capture_body_edit` directly, and nothing in TS/UI covers the refusals or the banner.
- Overstated point 2: calling this a breach of "mockIpc mirrors every Rust guard" ignores that the carve-out is written down. `mockIpc.ts:562-564` says the ledger is a Rust-only substrate that "mirroring it here would be guard logic the mock must not grow", and the banner's own docstring says it "renders nothing ... always, in the browser mock". The only arguable parity miss is the no-writer READ_ONLY fallback: the mock always behaves as if a writer is active.
- This gap did not cause the incident. The divergence came from an agent editing files outside the ledger, not from a missing mock guard. Low severity stands.

**Evidence checked.** - src-tauri/src/lib.rs:97-109: `save_note` calls `capture_body_edit`; if that returns None it calls `guard_human_write`.
- src-tauri/src/ledger/capture.rs:834-848: `capture_body_edit` returns RECONCILIATION_SUSPENDED when reconciliation is open, errors "not a committed projection" when the path isn't one, and returns None when there is no writer.
- src/lib/mockIpc.ts:187-202: `saveNote` has no guard and does no ledger check.
- src/lib/mockIpc.ts:562-564: the comment documenting that the ledger stays out of the mock on purpose.
- src/lib/mockIpc.ts:570-572: `resolveReconciliation` always throws.
- src/lib/mockIpc.ts:576-596: `ledgerStatus` returns `reconciliation_open: false` and `divergences: []`.
- src/app/ReconciliationBanner.tsx:9-10: "Renders nothing when the mode is closed — which is always, in the browser mock"; lines 19-21 turn a failed status read into null, so no banner shows.
- grep of src/ and e2e/: `ReconciliationBanner` / `ledgerStatus` appear only in App.tsx, ReconciliationBanner.tsx, ipc.ts, ipc.test.ts and mockIpc.ts. There is no banner test.
- Rust coverage that does exist: src-tauri/src/ledger/reconcile.rs:1371-1388 tests the open-reconciliation refusal through `capture_structured_with`; src-tauri/src/knowledge.rs:732 and :917 test `guard_human_write`. No test calls `capture_body_edit` directly.

**Correction.** The mock's `saveNote` on `knowledge/` paths writes with no checks, and the mock can never open reconciliation. As a result, no vitest or e2e test covers the banner, the paused body capture, or the no-writer READ_ONLY fallback. Rust unit tests do cover the open-reconciliation refusal (through the structured-capture path, reconcile.rs:1371-1388) and `guard_human_write`. The mock's lack of a ledger is a written design choice, so this is not an unnoticed parity violation. The real gap: `capture_body_edit`'s refusals have no direct Rust test, and the banner and its resolution flow have no TS/UI test.

</details>
