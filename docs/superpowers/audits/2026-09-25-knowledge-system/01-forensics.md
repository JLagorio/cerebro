# Incident root cause

> Audit lens `forensics` · first-pass auditor, each finding adversarially verified

## Summary

Root cause: two Cerebro processes were running on ~/Documents/test at the same time, and neither held the ledger writer. One was built before dedff4b and the other after it. Creating types/decision.md queued a schema recheck, and both processes ran it. Each run called MCP write_concept, which fell through to the silent legacy file-first path (vault/write.rs:600-621) because shadow::with_writer returned None. The next activation (11:58:53Z) could not reconcile those writes: the generated stamp had changed, so the scan refused them as forgery and diverged. Every link in that chain is still present on m45-layout-editor. The branch also has a second, independent bypass: panel and job-runner agents run with acceptEdits and have the built-in Write/Edit tools on the vault.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F1 | critical | yes | Knowledge writes silently fall back to a ledger-less file write when no writer is active (proximate root cause) |
| F2 | critical | yes | Re-opening the already-open vault in the same process drops the ledger writer for the rest of the process |
| F3 | high | yes | No single-instance guard; a second Cerebro process on the same vault writes knowledge with no writer and says nothing |
| F4 | high | yes | ledger_status cannot report a missing writer, so a non-recording process shows as `valid` |
| F5 | high | yes | Legacy knowledge writes can never be reconciled: they always read as 'provenance forgery' or an unknown path |
| F6 | high | yes | Panel and job-runner agents (including the knowledge recheck lanes) can write knowledge/ directly with the built-in Write/Edit tools |
| F7 | high | yes | Out-of-band capture attributes every edit to `human:owner`, so agent edits enter history as the owner's |
| F8 | medium | yes | The schema-recheck lane fires on cosmetic Type-doc edits and on concept self-anchors, fanning out into full concept rewrites |

### F1 — Knowledge writes silently fall back to a ledger-less file write when no writer is active (proximate root cause)

- **Severity (claimed):** critical
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/vault/write.rs:600-621`
  - `src-tauri/src/vault/write.rs:692-720`
  - `src-tauri/src/vault/write.rs:342-357`
  - `src-tauri/src/ledger/concepts.rs:68-107`
  - `src-tauri/src/ledger/shadow.rs:294-306`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/mcp.rs:2539-2546`

**Evidence**

vault::write::write_concept calls ledger::concepts::write_concept, and on None drops into concept_write + shadow_write. shadow::record is itself a no-op with no writer, so zero events are recorded. append_knowledge_log and verify_frontmatter work the same way. with_writer returns None when there is no Active entry, the vault differs, writer is None, or the mutex is poisoned (`active().lock().ok()?`, shadow.rs:295). Incident bytes match this path exactly. The Aug 17 files use serde_yaml block style (`- '[[compass-gcs-5]]'`, `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`), unlike the Aug 16 projection style (`generated: { by: claude-code, ... }`). log.md gained one `* **Update**:` bullet per tool call in insert_log_entry format, which is why the lines are duplicated. The ledger has no event between seq 178 (00:10:35Z) and seq 179 (11:58:53Z).

**Impact**

Any agent knowledge write made while the writer is missing lands on disk with no ledger record and no policy decision. M24.4 (concepts.rs:17-23) says a rewrite of a VERIFIED concept is floored at HIGH and queued. The legacy path applies it directly and rebuilds the frontmatter from the tool args alone, so the human `verified` stamp is erased without anyone being told. The user only finds out at the next launch, as a divergence banner.

**Recommendation**

Delete the legacy fallback for live app vaults. When with_writer returns None, return a typed refusal (`no active ledger writer ... see ledger_status`), the same way capture_concept_edit already does (lib.rs:944-951). Keep file-first behind cfg(test)/browser only. Kill the write.rs:612-615 comment that says the scan reconciles later (see the unreconcilable-writes finding).

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real, and it is the only code path that produces the incident bytes.** If `with_writer` returns None, `write_concept`, `append_knowledge_log` and `verify_frontmatter` each fall back to writing the file directly, with no policy check and no ledger event.
- The vault's git diffs show the fallback's own output:
  - serde_yaml block style (`- '[[compass-gcs-5]]'`, `generated:\n  by: claude-code\n  at: 2026-08-17T11:51:31Z`). The Aug 16 ledger projection used quoted flow style instead.
  - `* **Update**:` log bullets in the exact `insert_log_entry` format, one per tool call.
  - No events between seq 178 and 179.
- A writer-backed write would have added events and written the projection style, so no writer was active for these writes.
- **The commit trailer does not show a writer was live.** `withLedgerTrailer` → `ledger_head` → `ledger::head(path)` reads the head from disk (lib.rs:1455).
- **Where the claim overstates:**
  1. **Why the writer was missing is unproven.** Candidates: a refused verdict, a second instance that lost the lock, a poisoned mutex, or the window before activation. The code documents this fallback on purpose (write.rs:612-616, shadow.rs:290-293), and the launch scan catches it; that scan is what raised this banner. "Silent" means unrecorded until the next launch, not undetectable.
  2. **Erasing the `verified` stamp is a real risk but did not happen here.** `concept_write` rebuilds frontmatter from the tool args alone, and mcp.rs never accepts `verified`. But none of the 3 files was verified, before or after (grep for `verified` = 0 on both sides). So no human verification was lost in this incident, and the HIGH floor was never triggered.
  3. **Side note:** the incident fact about the `about:` change is backwards for commit 812605a. That diff REMOVED the self-reference `[[gcs-5-supervision-ratio]]` and ADDED `[[arb-4-disposition]]`.
- **Severity:** high, not critical. It bypasses governance and the ledger, but the launch scan detects it, and in this incident it caused no verified-data loss.

**Evidence checked.** - **Fallback in write.rs**
  - src-tauri/src/vault/write.rs:600-621: `write_concept` → `ledger::concepts::write_concept`. On None it runs `concept_write` + `shadow_write`. The comment says: "Legacy file-first path — no active writer ... the M23.6 scan reconciles once a writer returns".
  - write.rs:630-657: `concept_write` builds the YAML with `serde_yaml` from the args map only.
  - write.rs:692-720: `append_knowledge_log` uses the same fallback, via `knowledge::insert_log_entry`.
  - write.rs:342-357: `verify_frontmatter` uses the same fallback.
- **concepts.rs** src-tauri/src/ledger/concepts.rs:68-107: each function returns `shadow::with_writer(...)`, so None when there is no writer. Lines 17-23 hold the M24.4 HIGH floor for verified targets.
- **shadow.rs**
  - src-tauri/src/ledger/shadow.rs:294-306: `with_writer` has `active().lock().ok()?` → `guard.as_mut()?` → vault mismatch None → `active.writer.as_mut()?`.
  - shadow.rs:309+: `record()` returns early when nothing is active.
  - shadow.rs:113-120: a held lock (second instance) or refused verdict gives `writer: None`.
- **mcp.rs** src-tauri/src/mcp.rs:2501 server-stamps `generated {by, at}`. mcp.rs:2539-2546 calls `vault::write::write_concept` then `append_knowledge_log`. `verified` is never accepted (mcp.rs ~2508).
- **Trailer** src/git/useGit.ts:320-323 → lib.rs:1455 `ledger::head` (a disk read).
- **Vault evidence**
  - `git show 812605a` in /Users/joseflagorio/Documents/test shows the flow→block YAML rewrite and the `## 2026-08-17\n* **Update**: [...]` log insert.
  - The about diff is `-"[[gcs-5-supervision-ratio]]"` / `+'[[arb-4-disposition]]'`.
  - `grep -c verified` = 0 before (90437f4) and now, for all 3 files.

**Correction.** When no ledger writer is active, knowledge writes (`write_concept`, `append_knowledge_log`, `verify_frontmatter`) fall back on purpose to a plain file write that skips policy and records no ledger event. The incident bytes can only have come from this path. Two things are not established: why the writer was missing (refused verdict, second instance without the lock, poisoned mutex or startup window), and any lost verification (none of the 3 files was ever verified, so the HIGH-floor bypass is a risk that did not happen here). The launch scan does detect the problem, one launch late. That scan is what raised this banner.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** Reachability check.
- **The fallback path is real.** vault::write::write_concept, append_knowledge_log and verify_frontmatter all fall back to concept_write/insert_log_entry plus shadow_write when ledger::concepts::* returns None. with_writer returns None if the mutex is poisoned, if nothing is active, if the vault differs, or if writer is None. shadow::record is a no-op when writer is None.
- **writer=None happens in the shipping app.** In shadow::activate, LedgerWriter::open(...).ok() yields None on a held flock (writer.rs try_lock) or on any refused verdict. No tauri single-instance plugin is present, so a second instance (installed app plus a dev build) gets writer=None, and the MCP tool still reports success.
- **The live data fits only this path.**
  - The ledger has no events at all between seq 178 (00:10:35Z) and 179 (11:58:53Z).
  - Over that window the vault git history shows 7 commits (11:49–11:57Z), all carrying the same Cerebro-Ledger-Head 619957fc (= seq 178 hash). Even the non-knowledge commits (types/risk.md, prototypes/) left no vault.write events, so the whole writing process had no writer.
  - The Aug 17 bytes are serde_yaml block style (`- '[[compass-gcs-5]]'`, `generated:\n  by: claude-code\n  at: ...`). That is what concept_write's serialize_mapping produces. The ledger projection renders flow style (`generated: { by: ..., at: ... }`, see project.rs:365 and concepts.rs:1014 tests), which matches the Aug 16 pre-image.
  - log.md gained `## 2026-08-17\n* **Update**: [...]` entries in insert_log_entry format, one per tool call.
- **Overstatements.** The verified-erasure impact is only potential in this incident, and nothing was lost. Critical → high.

**Evidence checked.** src-tauri/src/vault/write.rs:600-621 (write_concept: `if let Some(result) = ledger::concepts::write_concept(..) {return result;}` else concept_write + shadow_write). write.rs:342-357 (verify_frontmatter same pattern). write.rs:692-720 (append_knowledge_log legacy insert_log_entry). ledger/concepts.rs:68-107 (returns shadow::with_writer(..), None without a writer). ledger/shadow.rs:294-306 (with_writer: `active().lock().ok()?`, `active.writer.as_mut()?`). shadow.rs:111-118 (activate: `LedgerWriter::open(&vault,&id).ok()`, "A held lock (second instance) lands in the None arm"). writer.rs:948-963 (flock try_lock). No single_instance in Cargo.toml/lib.rs. mcp.rs:2501 (generated stamped from actor), mcp.rs:2539-2546 (vault::write::write_concept then append_knowledge_log). Ledger .open: seq 178 ingested 2026-08-17T00:10:35Z hash 619957fc...; seq 179 at 11:58:53Z. Vault git 90437f4..e1770e4 (04:49–04:57 -07:00): all trailers Cerebro-Ledger-Head 619957fc. `git show 812605a`: block-style YAML, and the log.md `## 2026-08-17 * **Update**` entry. Pre-image f7df8b4: flow-style `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }` and no `verified` on any of the 3 files. project.rs:365 shows that projections render flow style.

**Correction.** The mechanism is right, it can happen in the real app, and it is the proximate cause of this incident. Two parts of the impact are overstated. (1) None of the 3 affected concepts had a `verified` stamp in their Aug 16 versions (git show f7df8b4: only lifecycle and generated, and no `verified:` anywhere under knowledge/). The "silently erases a human verified stamp" harm is real in the code but did not happen here. (2) Nothing was lost: the bytes are on disk and in vault git, and the next activation's launch_scan caught the gap. The damage is governance bypass (no ledger event, no M24.4 policy/HIGH-risk queue) plus a stuck reconciliation mode, which is a separate defect. It is not silent data loss. Likely trigger: a second app instance that lost the ledger flock. There is no single-instance plugin, and the user was running dev builds that morning (M33b commit at 13:17Z). That instance got writer=None, and its MCP knowledge writes took the legacy path.

</details>

### F2 — Re-opening the already-open vault in the same process drops the ledger writer for the rest of the process

- **Severity (claimed):** critical
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:112-118`
  - `src-tauri/src/ledger/shadow.rs:169-175`
  - `src-tauri/src/ledger/writer.rs:955-969`
  - `src-tauri/src/ledger/writer.rs:1087-1097`
  - `src-tauri/src/lib.rs:1478`
  - `src/stores/vaultStore.ts:123`
  - `src/App.tsx:298`
  - `src/pages/SettingsPage.tsx:100`

**Evidence**

activate() calls `LedgerWriter::open(&vault,&id).ok()` while the previous Active still holds its writer. The lock is flock(LOCK_EX|LOCK_NB) on a new descriptor, which the same process's existing lock refuses; the test the_lock_admits_exactly_one_writer proves this in-process. The error is discarded by `.ok()`, and replace_active then installs `writer: None` and drops the old writer. start_watcher → activate runs on every openVault, which happens on app boot, on a webview or Vite full reload, and when the vault is re-picked in Settings. Every shadow test calls deactivate() before activate(), so re-activation is never tested. The user runs `tauri dev` (PID 70308 target/debug/cerebro holds the lock today), so reloads are routine. Incident fit: ordinary app writes in the window also have no events. The autosync commits 90437f4 (types/risk.md, 11:49Z) and f7df8b4 (types/decision.md plus prototypes/*, 11:50Z) have no matching vault.write events, so the whole process was writer-less, not only the knowledge path.

**Impact**

Every other reload silently turns recording off: vault.write, write_concept and verify all go unrecorded. The next reload turns it back on and runs launch_scan against the process's own earlier writes, which turns normal app activity into divergences.

**Recommendation**

In activate(), if Active already names this vault and holds a writer, keep it: skip the re-open and re-run only the scan and index steps. Otherwise drop the old Active before opening the new writer. Add a test that calls activate twice on the same vault and asserts the writer is still held.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real.** I traced it end to end.
  - `activate()` has no check for a vault that is already active.
  - It calls `LedgerWriter::open(&vault,&id).ok()` while the old `Active` still holds its writer, and `open` takes the flock before it does anything else.
  - `try_lock` is `flock(LOCK_EX|LOCK_NB)` on a new descriptor, so the same process is refused. The test `the_lock_admits_exactly_one_writer` shows this in-process.
  - `.ok()` swallows the error. `writer = None` means `launch_scan` and the index replay are skipped. `replace_active` then installs `writer: None`, which drops the old writer and releases the lock.
  - The next `activate` succeeds, so recording alternates on and off across reloads.
  - Only `start_watcher` in lib.rs:1478 calls `activate`. The frontend calls it on every `openVault`: boot in `App.tsx:298` (which runs again on a webview reload while the Rust process lives on), the chooser in `App.tsx:158/163`, and `SettingsPage.tsx:100`.
- **It fits the incident, and more strongly than the claim says.** With no writer, `vault::write::write_concept` (write.rs:609-626) and `append_knowledge_log` (write.rs:700-718) fall back to the legacy file-first path, and `shadow_write` records nothing.
  - That matches what is on disk: concept files carrying the MCP server-stamped `generated.by: claude-code`, `**Update**` lines appended to `log.md`, and zero ledger events.
  - Autosync commits from 11:49Z to 11:57Z (useGit.ts:375 message format) show the app, and so the in-process MCP server, was running without a writer. The `activate` at 11:58:53 then succeeded (seq 179/180 exist, so a writer opened). It ran `launch_scan` against those legacy writes and opened reconciliation mode.
  - This proves the process was writer-less. It does not prove re-activation caused it. Another Cerebro instance holding the lock (for example a second worktree's `tauri dev` on the same vault) would produce the same trace.
  - The claim's evidence that `types/risk.md` and `prototypes/*` had no `vault.write` is weak on its own: those could have been written directly by the agent's own file tools.
- **Corrections to the claimed impact:**
  - `launch_scan` only reconciles manifest projections under `knowledge/`. Ordinary note saves in a writer-less window are silently unrecorded, but they do not become divergences. Only `write_concept`, `append_log` and `verify` writes do, and only a changed `generated` stamp escalates to divergence. Other edits are captured as `projection.overridden`.
  - "Every other reload" holds for the same vault in the same process. In a production build that means Cmd+R or re-picking the same vault. In `tauri dev`, where Vite full reloads are routine, it is frequent.
  - Nothing tells the user. Only `ledger_status` would show the missing writer.
- **Severity: high rather than critical.** It silently disables the ledger-first guarantee and is the most likely root cause of the banner, but it loses no data. Files are still written and recording resumes on the next `activate`.

**Evidence checked.** - `src-tauri/src/ledger/shadow.rs:112-118`: `LedgerWriter::open(&vault, &id).ok()`, with the comment "A held lock (second instance) lands in the None arm". There is no same-vault guard before it.
- `shadow.rs:128`: `launch_scan` runs only `if let Some(writer)`.
- `shadow.rs:169-175`: `replace_active(Active{ writer, .. })`.
- `shadow.rs:274-278`: `*guard = Some(next)` drops the old writer and its lock.
- `shadow.rs:280-287`: `deactivate` is `#[cfg(test)]` only ("the app itself just replaces the target").
- `writer.rs:262-265`: `open_with_limit` calls `acquire_lock(&dir)?` first.
- `writer.rs:955-969`: `file.try_lock()` returns `WouldBlock`, which becomes the "another Cerebro instance" error.
- `writer.rs:1087-1097`: the in-process test `the_lock_admits_exactly_one_writer`.
- `lib.rs:1478`: `let _ = ledger::shadow::activate(...)` in `start_watcher`, the only non-test caller.
- `vaultStore.ts:117-123`: `openVault` calls `ipc.startWatcher` every time. `App.tsx:298` (boot), `App.tsx:158/163` and `SettingsPage.tsx:100` call `openVault`.
- `vault/write.rs:609-626`: the legacy `write_concept` fallback when `concepts::write_concept` returns `None` (no writer).
- `vault/write.rs:700-718`: the legacy `log.md` append.
- `ledger/concepts.rs:66-107`: returns `None` without an active writer.
- Live ledger: seq 178 at 2026-08-17T00:10:35Z, seq 179 `projection.overridden` at 11:58:53.8Z, seq 180 `ledger.divergence` at 11:58:54.1Z, next event seq 181 on 2026-08-22.
- Vault git: 90437f4 at 04:49-07:00 (types/risk.md), f7df8b4 at 04:50, then 812605a, 1c8c9e9, 7658504, e3543b4 and e1770e4 at 04:51-04:57, all "Update 2 notes in knowledge", touching `log.md` plus the 3 concept files.

**Correction.** The mechanism is correct as stated: re-activating the same vault in the same process refuses the new writer, discards the error, installs `writer: None` and drops the working writer, so it alternates across reloads. Two parts are overstated.
- Only knowledge projection writes made in a writer-less window (`write_concept`, `append_log`, `verify`, which fall back to legacy file-first writes) are later seen by `launch_scan`. Only a changed `generated` stamp turns one into a divergence; other edits are captured as overrides. Ordinary note saves are just silently unrecorded, not turned into divergences.
- The incident proves the app process had no writer from 11:49Z to 11:57Z on 2026-08-17. Re-activation is the most likely cause, not a proven one: a second instance holding the lock leaves the same trace.
Severity is high.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Mechanism holds; I could not refute it.** `start_watcher` runs `shadow::activate` every time the vault is opened, and nothing checks whether that vault is already active. Inside `activate`, `LedgerWriter::open` asks for a new flock on a new descriptor while the old `Active` still holds its lock. That second lock is refused inside the same process, which the in-process test `the_lock_admits_exactly_one_writer` shows. `.ok()` throws the error away, so `writer` is None. `replace_active` then installs `writer: None` and drops the old `Active`, which releases the lock.
- **Result:** recording turns off and on with each re-open. Opens 1, 3, 5… get a writer; opens 2, 4… get none. No frontend guard stops it: `openVault` has no same-path check. Only test builds (`#[cfg(test)]`) have `deactivate()`, so a re-activation without it is never tested.
- **Reachability:**
  - A webview reload re-runs the boot `openVault(last)` while Rust keeps its global `ACTIVE`.
  - Choosing the same folder again in Settings re-runs it too.
  - Vite full reloads cause it under `tauri dev`.
  - StrictMode double-mount does not: `cancelled` blocks the first run.
- **Incident fit is strong.** `knowledge/log.md` got duplicate `* **Update**: [title](/path)` lines, which is the app's own log format. So the Aug 17 concept writes went through the app's `write_concept`. With no writer, `ledger::concepts::write_concept` returns None, so `vault/write.rs:609` takes the legacy file-first path. That path writes the file with the MCP-stamped `generated.by`, and `shadow_write` records nothing. `types/risk.md` (11:49Z) and `types/decision.md` (11:50Z) also have no `vault.write` events, although the ledger normally records them (124 of them). So the whole process had no writer, not just the knowledge path. The 11:58:53Z scan then shows a writer came back. That fits a re-activation in the same process.
- **Not proven:** that this particular path was the cause. A second instance that lost the lock (for example the installed app plus `tauri dev`) would leave the same traces. The code comment at `shadow.rs:112-118` expects that case.
- **Overstatement:** "turns normal app activity into divergences" goes too far. `launch_scan` only reconciles files in the projection manifest (`knowledge/`). Ordinary `vault.write`s made while no writer is held just go unrecorded; they are not divergences. The divergence comes from knowledge writes whose `generated` stamp changed, which the forgery check then refuses. The comment at `write.rs:612` says "the M23.6 scan reconciles once a writer returns". That is false for agent concept writes: they are always refused as forgery. That comment is itself a defect.
- **Severity: high rather than critical.** Recording is lost silently and it produced this unresolvable banner. But the trigger is a reload or re-picking the same vault, mostly a dev-mode path, and the harm beyond the silent recording gap is limited to `knowledge/`.

**Evidence checked.** - **`src-tauri/src/ledger/shadow.rs`**
  - `:103-110` (inside `activate`, `:81`): `LedgerWriter::open(&vault, &id).ok()` with no already-active check.
  - `:257-263`: `replace_active(Active{writer, ..})`.
  - `:274-278`: `replace_active` does `*guard = Some(next)`, which drops the old writer and releases the lock.
  - `:282-287`: `deactivate` is `#[cfg(test)]` only.
- **`src-tauri/src/ledger/writer.rs`**
  - `:265`: `open_with_limit` takes the lock first, via `acquire_lock`.
  - `:955-969`: `acquire_lock` does `File::try_lock` (flock `LOCK_EX|LOCK_NB`) on a new descriptor.
  - `:1087-1097`: the in-process test `the_lock_admits_exactly_one_writer` asserts the second open is refused.
- **Callers**
  - `src-tauri/src/lib.rs:1478`: `start_watcher` calls `activate` unconditionally.
  - `src/stores/vaultStore.ts:117-123`: `openVault` calls `startWatcher` with no same-path guard.
  - `src/App.tsx:298` (boot), `src/pages/SettingsPage.tsx:100` (re-pick) and `src/App.tsx:158,163` also call `openVault`.
- **Legacy path:** `src-tauri/src/vault/write.rs:609-626`: if `concepts::write_concept` returns None, the file is written directly and `shadow_write` records nothing without a writer. `src-tauri/src/ledger/concepts.rs:66-78`: `with_writer` returns None when there is no writer.
- **Live ledger** (`/Users/joseflagorio/Documents/test/.cerebro/ledger/…0001.ndjsonl.open`):
  - Counts: 124 `vault.write` events in total, so app writes are normally recorded.
  - Seq 178: 2026-08-17T00:10:35Z.
  - Seq 179 / 180: 11:58:53Z / 11:58:54Z.
  - Next event, seq 181: 2026-08-22.
- **Vault git log, 2026-08-17 (times PDT, UTC-7)**
  - 90437f4, 04:49 (11:49Z): `types/risk.md`.
  - f7df8b4, 04:50 (11:50Z): `types/decision.md` and `prototypes/*`.
  - 812605a through e1770e4, 04:51–04:57 (11:51–11:57Z): the knowledge files and `log.md`.
  - None of these have ledger events.
- **Log format:** the duplicate `* **Update**:` lines in `knowledge/log.md` are the app's format (compare `knowledge.rs:790`), so these were app `write_concept` legacy-path writes.

**Correction.** The mechanism is confirmed in code. Opening an already-active vault again in the same process (webview or Vite full reload, or re-picking the same vault in Settings) leaves the new Active with writer=None and releases the old lock. Recording therefore alternates off and on with each re-open, silently. The live data is consistent with this being the Aug 17 cause, but a second instance that lost the lock leaves the same traces, so it is not proven. Impact is narrower than claimed. While there is no writer, every write (`vault.write`, `write_concept`, `verify`) goes unrecorded. On the next successful activation, `launch_scan` only turns `knowledge/` projection edits into divergence, and specifically agent concept writes whose `generated` stamp changed, which it refuses as forgery. It does not turn all normal app activity into divergences. Also, the `write.rs:612` comment claims the scan reconciles legacy writes once a writer returns; that is false for these writes.

</details>

### F3 — No single-instance guard; a second Cerebro process on the same vault writes knowledge with no writer and says nothing

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/tauri.conf.json:5`
  - `src-tauri/src/ledger/shadow.rs:112-118`
  - `src-tauri/src/ledger/writer.rs:965-967`
  - `src/agent/useJobRunner.ts:338-339`

**Evidence**

runtime.db `runs` holds two interleaved chains of sequential attended agent runs: 721fd174→ee2a46d7→f3e456fa and a8e7a828→37769bc1→344cd412, starting 11:50:08Z and 11:50:09Z. One AgentState per process cannot run two children at once, so these came from two processes. The chains also came from different builds. The writes at 11:51:31Z (812605a) and 11:56:45Z (e3543b4) have no `description`. Every build since dedff4b (2026-08-17 01:31Z) hard-requires it (mcp.rs:2464-2466), so a pre-dedff4b binary was serving MCP at the same time as a newer one. Both builds used identifier com.cerebro.app and shared one runtime.db and ledger-writer-id. There is no tauri single-instance plugin, and the lock error ('another Cerebro instance holds this vault's ledger') is thrown away at shadow.rs:118.

**Impact**

Two processes processed the same concepts and overwrote each other. gcs-5's `about` self-anchor was removed and then re-added, and stale_after went 2027-07-31 → 2028-02-28 → 2027-10-31. All six runs were unrecorded. The double dispatch itself is fixed on the current branch by the M34.2.3 durable claim, but a second instance still writes knowledge with no writer.

**Recommendation**

Add tauri-plugin-single-instance, or make the process that loses the lock read-only for knowledge (refuse write_concept and verify) and show why in the UI.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Mechanism is real.**
  - There is no single-instance plugin: `tauri.conf.json` and `src-tauri/` contain no `single-instance` or `single_instance`.
  - `shadow::activate` calls `LedgerWriter::open(&vault,&id).ok()`, so the flock refusal "another Cerebro instance holds this vault's ledger" is thrown away and `writer` becomes `None`.
  - With no writer, `concepts::write_concept` and `append_log` return `None`. `vault/write.rs` then falls back to the legacy file-first write, and `shadow_write` or `record` silently does nothing. The concept file changes and no ledger event is written.
- **"Says nothing" holds.** `ledger_status` (shadow.rs ~L360-406) re-runs `classify()` on disk, which ignores the lock. A lock loser therefore reports verdict `valid`. The comments in lib.rs:1475 and shadow.rs:292 ("ledger_status names why") are false for this case. The edits only surface later, as a divergence the next time a process that holds the writer runs its launch scan.
- **Two-process inference holds, on the build evidence.**
  - runtime.db has two interleaved chains:
    - Chain A: 721fd174→ee2a46d7→f3e456fa.
    - Chain B: a8e7a828→37769bc1→344cd412.
  - Chain B's writes (812605a at 11:51:31, e3543b4 at 11:56:45) have no `description`. Chain A's writes (1c8c9e9, 7658504, e1770e4) add one.
  - mcp.rs:2464 hard-requires `description` since dedff4b (2026-08-17 01:31Z). The two chains therefore came from different binaries, which means two MCP servers and two processes.
- **Wrong detail.** "One AgentState per process cannot run two children at once" is false. `AgentState` has been a `HashMap<u64, Child>` of concurrent runs since M17.3 (e026d5e, 2026-08-03). This point is not evidence; the build difference is.
- **Overstated or incomplete.**
  - Neither chain produced a ledger event: head 619957fc stays unchanged across all five commits, and seq 178 is the last event before the scan.
  - So a lost lock explains at most one process. The other process must also have had no writer (refused verdict, fail-stopped writer, or a third lock holder). That cause is unproven.
  - The launch scan recorded at 11:58:54, so no process held the lock by then.
  - The edits are not permanently silent: the scan catches them as the divergence behind the banner. What is missing is a warning at write time.
- **Impact details check out.**
  - stale_after changed 2027-07-31→2028-02-28 (812605a), then →2027-10-31 (1c8c9e9).
  - gcs-5 `about`: the self-anchor `[[gcs-5-supervision-ratio]]` was replaced by `[[arb-4-disposition]]` (old build, 812605a), then restored (new build, 1c8c9e9).
  - The incident fact that the self-reference was newly introduced on Aug 17 is therefore backwards: it was already in the Aug 16 projection.

**Evidence checked.** - src-tauri/tauri.conf.json:5 has identifier com.cerebro.app. Grepping src-tauri for single-instance / single_instance finds nothing.
- src-tauri/src/ledger/shadow.rs:112-118: `LedgerWriter::open(&vault, &id).ok()`, with the comment "A held lock (second instance) lands in the None arm below: shadow stays silent there."
- src-tauri/src/ledger/writer.rs:965-967: the `WouldBlock` branch returns "another Cerebro instance holds this vault's ledger — one writer per vault".
- src-tauri/src/ledger/shadow.rs:294-305 (`with_writer` returns `None`) and :310-323 (`record` silently returns).
- src-tauri/src/ledger/concepts.rs:67-79: `write_concept` returns `None` without a writer.
- src-tauri/src/vault/write.rs:609-626: legacy file-first fallback; :700-715: `append_knowledge_log` fallback.
- src-tauri/src/ledger/shadow.rs ~360-406: `status()` re-classifies from disk and has no field for "writer not held".
- src-tauri/src/lib.rs:1476-1478: comment says a refused ledger "says why through ledger_status", which does not cover lock loss.
- src-tauri/src/agent/mod.rs:315-317: `children: Arc<Mutex<HashMap<u64, Child>>>` (concurrent since e026d5e, M17.3), which refutes the AgentState argument.
- src-tauri/src/mcp.rs:2464-2466: `description` is required (dedff4b, 2026-08-16T18:31-07:00).
- runtime.db (read from a copy), `runs` table on 2026-08-17: 721fd174 11:50:08-11:52:08, a8e7a828 11:50:09-11:51:38, 37769bc1 11:51:42-11:54:38, ee2a46d7 11:52:12-11:54:50, 344cd412 11:54:42-11:56:56, f3e456fa 11:54:54-11:57:44. All are attended agent runs on claude-opus-4-7.
- Vault git history:
  - 812605a and e3543b4: no `description` added.
  - 1c8c9e9, 7658504, e1770e4: `description` added.
  - All five commits carry trailer Cerebro-Ledger-Head 619957fc.
  - gcs-5 `about`: [[gcs-5-supervision-ratio]]→[[arb-4-disposition]] (812605a), then →[[gcs-5-supervision-ratio]] (1c8c9e9).
  - gcs-5 stale_after: 2027-07-31→2028-02-28→2027-10-31.

**Correction.** - **Mechanism: confirmed.** There is no single-instance guard. A process that loses the vault's flock gets `writer=None` with the error discarded (shadow.rs:118). Its `write_concept` and `append_log` calls fall back to file-first writes that produce no ledger event. `ledger_status` still reports `valid`, so nothing names the lost lock at write time. The edits surface only later, as a divergence in the next launch scan.
- **Two processes: confirmed, on build evidence only.** The two runtime.db chains came from two builds: chain B's writes lack `description`, which mcp.rs has required since dedff4b. They did not come from AgentState, which has supported concurrent children since M17.3.
- **Not fully explained.** Both chains' writes escaped the ledger, but a lost lock accounts for only one process. Why the other process also had no writer is unproven: a refused verdict, a fail-stopped writer, or a third lock holder are all possible.
- **Correction to the incident facts.** The gcs-5 self-anchor was already in the Aug 16 projection. The old build removed it and the new build restored it; the Aug 17 edits did not introduce it.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Core claim holds, and the path is live today.** Nothing stops a second process. When it loses the ledger lock, knowledge writes fall back to the legacy file-first path, and no status surface reports it.
- **One piece of evidence is wrong.** "One AgentState per process cannot run two children at once" is false. Runs have been concurrent since M17.3 (e026d5e, 2026-08-03), and `MAX_CONCURRENT_RUNS` = 4. Two interleaved chains alone would not prove two processes.
- **Two processes is still proven, by a better route.** Matching each commit's generated.at to the run windows:
  - Chain A (721fd174→ee2a46d7→f3e456fa) wrote at 11:52:02, 11:54:42 and 11:57:37, all WITH description. That fits a post-dedff4b build, where description is enforced.
  - Chain B (a8e7a828→37769bc1→344cd412) wrote at 11:51:31 and 11:56:45, both WITHOUT description. The frontmatter key order has no description slot, which is the pre-dedff4b path, where description was optional.
  - So the vault was served by two different binaries at the same time.
- **Neither process had a writer.**
  - The ledger holds zero events 11:50–11:57. Every commit carries the same Ledger-Head.
  - At 11:58:54 a fresh launch opened a writer and ran launch_scan on the same ledger. That makes a refused verdict unlikely.
  - The remaining explanation is the flock being held by another process, which fits a multi-instance setup.
- **Reachable in practice.** macOS LaunchServices blocks a double-launch of one bundle. It does not block distinct binaries: the installed app next to `tauri dev` or a worktree build. All share identifier com.cerebro.app and one app-data dir. This user runs several worktrees plus mac-build.sh installs.
- **Impact details check out.** In gcs-5, the about self-anchor was removed in 812605a and re-added in 1c8c9e9. Its stale_after went 2027-07-31 → 2028-02-28 → 2027-10-31. These ledger-less writes are exactly what launch_scan later flagged as forged, which opened the banner.

**Evidence checked.** - **No single-instance guard.** src-tauri/Cargo.toml has only tauri-plugin-dialog. Grep finds no single-instance code. tauri.conf.json:5 sets identifier "com.cerebro.app".
- **Lock error discarded.** src-tauri/src/ledger/shadow.rs:112-118 does `LedgerWriter::open(&vault, &id).ok()`, with the comment "A held lock (second instance) lands in the None arm below: shadow stays silent there". writer.rs:965-967 is the discarded "another Cerebro instance holds this vault's ledger" error.
- **Silent fallback.** vault/write.rs:606-626: when concepts::write_concept returns None (no writer), the concept goes through the legacy concept_write + shadow_write path. shadow::record (shadow.rs:311-323) returns silently when `writer` is None.
- **Status blind to the lock.** shadow::status (shadow.rs:367-408) reclassifies from disk read-only. Nothing in LedgerStatus says the lock was lost, so a writer-less instance reports "valid".
- **Concurrency.** agent/mod.rs:295-317 allows concurrent children (`HashMap<u64, Child>`, MAX_CONCURRENT_RUNS = 4) since e026d5e (2026-08-03). This refutes the AgentState argument.
- **The runs.** runtime.db `runs`: six attended/agent runs on 2026-08-17, all vault 5171d169…, as listed in the claim.
- **Vault commits** (git show, read-only):
  - 812605a (gen.at 11:51:31Z) and e3543b4 (11:56:45Z): no description key.
  - 1c8c9e9 (11:52:02Z), 7658504 (11:54:42Z), e1770e4 (11:57:37Z): add description.
  - gcs-5 about: [[gcs-5-supervision-ratio]] → [[arb-4-disposition]] (812605a) → [[gcs-5-supervision-ratio]] (1c8c9e9).
  - gcs-5 stale_after: 2027-07-31 → 2028-02-28 → 2027-10-31.
- **dedff4b** (2026-08-16 18:31 PDT): turns description from optional (`if let Some`) into a hard `ok_or` refusal in tool_write_concept. Current location is mcp.rs:2464-2466.

**Correction.** The claim is right: nothing stops a second instance, and one that loses the ledger lock writes knowledge with no writer, silently. The ledger records nothing and ledger_status still reports "valid". One piece of evidence is wrong: one process CAN run agent children concurrently (M17.3, up to 4), so the interleaved run chains alone do not prove two processes. The proof is the description split: chain B's writes (11:51:31, 11:56:45) have no description (pre-dedff4b build) and chain A's (11:52:02, 11:54:42, 11:57:37) do. Two builds were live at once, and neither held the ledger writer. This is how two separate binaries (installed app plus a dev or worktree build) sharing com.cerebro.app get in. macOS itself blocks a double-launch of the same bundle.

</details>

### F4 — ledger_status cannot report a missing writer, so a non-recording process shows as `valid`

- **Severity (claimed):** high
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:367-409`
  - `src-tauri/src/ledger/shadow.rs:1-10`
  - `src-tauri/src/vault/write.rs:612-615`
  - `src/app/ReconciliationBanner.tsx:19`

**Evidence**

status() re-classifies the ledger from disk (classify + reduce) and never reads the Active slot or the lock, so a healthy ledger on disk returns verdict `valid` even when this process holds no writer. The shadow.rs module doc says 'What IS active is visible through status', and write.rs:612-615 says 'the refusal is visible through ledger_status'. Both are false for the lost-lock and re-activation cases. ReconciliationBanner is the only consumer of ledgerStatus and reads only reconciliation_open.

**Impact**

The recording gap on Aug 17 gave no signal while it was happening. The damage showed up only after the fact, as the 'history diverged' banner, which blames the files rather than the lost writer.

**Recommendation**

Add `recording: bool` and `not_recording_reason` (lost lock / refused verdict / other vault) to LedgerStatus, sourced from Active. Show a distinct 'Not recording' banner and block agent knowledge runs while it is false.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Mechanism is real.** `status()` rebuilds its answer from disk alone: `classify(dir, existing_writer_id, remembered)` plus `reduce`. It never looks at the `Active` slot, `Active.writer`, or the lock.
- **The lost-writer case reports `valid`.** When `LedgerWriter::open` fails in `activate`, for example because another instance holds the lock, the writer is `None`, but `classify` on a clean ledger still returns `Verdict::Valid`. The same installation id is read from app-data, so the foreign-writer check does not fire either.
- **The two doc comments are false for this case.** shadow.rs:9-10 says what is active is visible through `status`. write.rs:612-615 says the refusal is visible through `ledger_status`. Neither holds when the verdict was recoverable but the writer did not open.
- **The Aug 17 data fits this path.** The edits carry `generated: {by: claude-code, at: now}` (stamped by the MCP server, mcp.rs:42 and :2501) and `**Update**` lines in log.md (the knowledge.rs:263-280 log format). That points to MCP `write_concept` falling through to the legacy file-first path, which only happens with no active writer (write.rs:606-622). The shadow write there is a silent no-op, so nothing reached the ledger.
- **Overstated on impact.** A `ledger_status` that could name the missing writer would not by itself have given any signal. `ReconciliationBanner` is the only UI consumer of `ledgerStatus`, and it renders only `reconciliation_open` and `divergences.length`. No UI shows `verdict` or `detail`, even for refusals `status` does report (`foreign-writer`, `diverged`, `corrupt`).
- **Bigger cause of the silence.** The real reason nothing was recorded is the silent legacy fallback in `write_concept`: it writes knowledge files with no ledger and no warning. The status gap is one part of that, not the root cause, so medium rather than high.
- **Unproven detail.** The claim's cause, "lost lock", is plausible but not proven from the data. An `open()` I/O failure, or a second instance (a dev build sharing the same app-data), gives the same result.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:367-409: `status()` calls `classify` / `reduce` on disk only and never touches `active()`.
- shadow.rs:112-120: `LedgerWriter::open(...).ok()`. A held lock gives writer None, but the returned verdict stays Valid.
- shadow.rs:1-10 and src-tauri/src/vault/write.rs:612-615: the "visible through status / ledger_status" comments.
- src-tauri/src/ledger/recovery.rs:170-183: a clean tail with the same writer id gives `Verdict::Valid`.
- src-tauri/src/lib.rs:1461-1464: `ledger_status` is a thin wrapper over `status()`.
- src/app/ReconciliationBanner.tsx:19 and :36-46: the banner reads only `reconciliation_open` and `divergences.length`, and swallows errors into null.
- grep: `ledgerStatus` has no other non-test consumer (only ipc.ts / mockIpc.ts).
- src-tauri/src/mcp.rs:42 and :2501: the server stamps `generated.by = "claude-code"` with `at = now`.
- src-tauri/src/knowledge.rs:263-280: the log.md `**Update**` entry format, which matches the Aug 17 log lines.
- write.rs:606-622: the legacy path runs when `ledger::concepts::write_concept` returns None (no active writer), and its shadow write is a silent no-op.

**Correction.** - **What holds:** `ledger_status` reads only the disk, so a process with no active ledger writer (lock held elsewhere, or `open()` failed) reports verdict `valid`. The shadow.rs:9-10 and write.rs:612-615 comments are false for that case.
- **What is overstated:** fixing `status` alone would not have given a signal on Aug 17. The only UI consumer, `ReconciliationBanner`, never shows `verdict` or `detail`. The main defect is that `write_concept` silently falls back to the legacy file-first path, which writes knowledge files with no ledger event.
- **Not proven:** that the missing writer was a lost lock specifically. The data only shows there was no active writer.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The code defect is real. `status()` runs `classify()` plus `reduce()` on the files on disk only. It never reads `active()`, `Active.writer` or `Active.vault`, and it never tests the lock.
- A second instance that lost the lock, or an Active slot that now points at another vault, gets `Valid` from `classify`, so `ledger_status` reports `valid` while nothing is being recorded. `activate()` reaches the second-instance case: `LedgerWriter::open(..).ok()` returns None on a held lock.
- The code says this is visible in `ledger_status` in at least five places, and every one is false for these cases: the shadow.rs module doc, the `activate` doc, the `with_writer` doc, the write.rs:612-615 comment and the lib.rs:951 error text.
- The impact is overstated in two ways:
  - (a) Even a correct `status()` would not have given a signal on Aug 17. Nothing in the frontend renders `verdict` or `detail`. `ReconciliationBanner` only checks `reconciliation_open`, and `LedgerStatus.verdict` is declared in ipc.ts but never read. The missing signal is mostly a UI-consumer gap, not only a `status()` gap.
  - (b) A lost writer is plausible for Aug 17 but not proven:
    - For: `generated.at` is re-stamped to the second on each write, and each commit pairs a concept file with log.md. That fits MCP `write_concept` falling to the legacy path when `with_writer` returns None. Autosync commits were also being made, so an app process was live.
    - Against: user-authored runs with the shell grant get native Write/Edit (agent/mod.rs:580-585), which would bypass the ledger with the writer fully present.
  - Nothing on disk shows which of these happened.
- Severity: this is an observability gap that hid a cause but did not create the damage, so medium rather than high.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:367-409: `status()` calls `existing_writer_id`, `Index::remembered`, `classify(&dir, ..)` and `reduce()`. It never touches `active()`, so writer presence is not an input.
- shadow.rs:112-120: `activate` opens the writer with `LedgerWriter::open(&vault,&id).ok()`, and the comment says "A held lock (second instance) lands in the None arm below: shadow stays silent there". The verdict is still `Valid`.
- shadow.rs:294-300: `with_writer` returns None on a vault mismatch or a None writer. Its doc says "ledger_status names why", which is false.
- Other false claims: shadow.rs:9-10 ("What IS active is visible through `status`"), write.rs:612-615, lib.rs:951 ("see ledger_status").
- src/app/ReconciliationBanner.tsx:19,38: the only caller of `ledgerStatus`, and it only checks `reconciliation_open`. A grep of src/ finds no consumer of `.verdict`; it appears only in the ipc.ts:287 type.
- Vault git e1770e4 (2026-08-17 04:57 -0700): diff shows `generated.at` 11:56:45Z -> 11:57:37Z plus a log.md line, and the trailer is still Cerebro-Ledger-Head 619957fc. This fits the MCP legacy file-first path (write.rs:616-628) with no active writer, but it cannot be told apart from native Write/Edit, which shell-granted user runs are allowed (agent/mod.rs:580-585).

**Correction.** The claim is right about `ledger_status`: it cannot report a missing writer (lost lock, or an Active slot bound to another vault), so it says `valid` while recording is silently off, and five code comments wrongly say otherwise. Two parts need correcting. First, no UI surface displays `verdict` at all, so fixing `status()` alone would still leave no signal; the frontend also needs to render it. Second, a lost writer is a plausible cause of the Aug 17 gap but is not established, because shell-granted agent runs could also have written the files directly with native Write/Edit. Severity: medium.

</details>

### F5 — Legacy knowledge writes can never be reconciled: they always read as 'provenance forgery' or an unknown path

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/ledger/capture.rs:961-967`
  - `src-tauri/src/ledger/reconcile.rs:73-77`
  - `src-tauri/src/vault/write.rs:612-615`

**Evidence**

tool_write_concept re-stamps `generated: {by: actor, at: now_iso()}` on every call. diff_projection_file hard-refuses any change to `generated` or `verified` ('provenance forgery ... refused'). A brand-new concept is classified Divergence('path is unknown to both manifest and reducer'). So every write_concept made with no writer is guaranteed to open reconciliation mode, and this is exactly what seq 180 recorded for the three files. The write.rs:612-615 promise that 'the M23.6 scan reconciles once a writer returns' is false.

**Impact**

The app's own sanctioned tool output looks like tampering. 'Keep my files' cannot accept it. 'Restore recorded history' reverts the agent's work and deletes new concepts. The vault has now sat in reconciliation mode for about 39 days.

**Recommendation**

Close the fallback (see the silent-fallback finding). Until then, record legacy writes in an app-data side journal (path, hash, actor, run_id) that launch_scan can use to prove the bytes were app-written and replay them as proposals. Kill the false comment.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - The core mechanism is real. With no active writer, `write_concept` takes the legacy path that writes the file first, and `tool_write_concept` always sets a new `generated.at` (now_iso). `diff_projection_file` hard-refuses any change to `generated` or `verified`. `resolve_accept_with` calls that same diff, and one refused file blocks the whole adoption. So a legacy `write_concept` or `verify_concept` on a concept that already exists can only be undone with "Restore". It can never be adopted.
- A brand-new concept is classified `Divergence("path is unknown to both manifest and reducer")`. On accept, `diff_projection_file` refuses it with "is not a committed projection". The claim is right on this point.
- The incident fits this path. The vault commit 812605a rewrites the YAML in `write_concept`'s block style, sets `generated.at` to 11:51:31Z, and appends `* **Update**: [...]`, which is `insert_log_entry`'s exact format. `shadow_write` or `record` with no writer records nothing, which matches zero ledger events and an unchanged Cerebro-Ledger-Head.
- Overstated: "legacy knowledge writes ALWAYS read as forgery or an unknown path" is false as a blanket claim. The legacy `append_knowledge_log` write to `knowledge/log.md` comes from the same tool call and the same no-writer path, and it WAS captured. Seq 179 recorded it as projection.overridden with origin out_of_band. Only writes that change the `generated`/`verified` stamps, or that create new paths, cannot be reconciled.
- "Never reconciled" also needs a precise meaning. Reconciliation mode CAN be closed, but only by Restore, which throws the edits away. The edits cannot be adopted.
- The write.rs comment is misleading rather than simply false. The scan does detect these writes and routes them into reconciliation. It just cannot adopt them.
- Side note on the incident facts: in commit 812605a the `about` field went from self-reference to `[[arb-4-disposition]]`. The self-reference only came back in a later commit, and the current file has the self-reference. So the stated direction of the `about` change is oversimplified.
- Severity stays high. Every `write_concept` or `verify_concept` made while the writer is absent (second instance lost the lock, refused ledger, and so on) produces a state that only data-losing Restore can clear. This is the exact state the vault has been stuck in.

**Evidence checked.** - src-tauri/src/mcp.rs:2501: `frontmatter.insert("generated", json!({"by": actor, "at": now_iso()}))` runs on every call.
- src-tauri/src/vault/write.rs:600-615: if `ledger::concepts::write_concept` returns None, the legacy file-first `concept_write` plus `shadow_write` runs.
- src-tauri/src/ledger/concepts.rs:68-80: goes through `shadow::with_writer`, which returns None when there is no active writer.
- src-tauri/src/ledger/shadow.rs:289-305 (`with_writer`) and ~310 (`record` is a silent no-op with no writer).
- src-tauri/src/ledger/capture.rs:933-937: an unknown path gives "is not a committed projection".
- src-tauri/src/ledger/capture.rs:961-967: a changed `generated`/`verified` stamp gives "provenance forgery ... refused".
- src-tauri/src/ledger/reconcile.rs:75-78: Divergence "path is unknown to both manifest and reducer".
- src-tauri/src/ledger/reconcile.rs:306-318: `launch_scan` capture failure escalates to divergent.
- src-tauri/src/ledger/reconcile.rs:596-600: `resolve_accept_with` calls `diff_projection_file` and uses `?`, so one bad file refuses everything. Test `one_forged_file_refuses_the_entire_adoption` at L1639.
- src-tauri/src/vault/write.rs:692-713: legacy `append_knowledge_log` writes log.md file-first. Its captured out-of-band edit is seq 179, which is the counterexample to "always".
- Vault commit 812605a (2026-08-17 04:51:37 -0700): `generated.at` 2026-08-16T19:38:29Z became 2026-08-17T11:51:31Z, YAML was re-serialized, log.md got `* **Update**: [...]` (the `knowledge.rs` `insert_log_entry` format), and the trailer head 619957fc… is unchanged.

**Correction.** When no ledger writer is active, a `write_concept` or `verify_concept` that changes an existing concept always fails the capture/adoption diff as "provenance forgery", because `generated.at` is re-stamped on every call. A brand-new concept is an "unknown path" divergence. Either way "Keep my files" cannot adopt them, and only "Restore recorded history" closes the mode, which discards the edits. This does NOT hold for every legacy knowledge write: the legacy knowledge/log.md append is captured normally as an out-of-band override (seq 179). The write.rs comment is misleading: the scan detects these writes and routes them into reconciliation, but it cannot adopt them.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Reachable, not guarded elsewhere.** `ledger::concepts::write_concept` returns None, which sends the write down the legacy file-first path, whenever `shadow::with_writer` finds no writer for this vault. That happens in three cases: the active vault differs (the global holds only one), the startup verdict refused, or a second instance lost the writer lock. shadow.rs:113-115 says the second-instance case "lands in the None arm". There is no single-instance plugin and no MCP-side refusal of legacy writes.
- **The live data matches the legacy path.** The Aug 17 concept bytes use write_concept's serializer: block-style YAML, where the Aug 16 bytes were flow-style. Each commit carries a server-stamped `generated: {by: claude-code (DEFAULT_ACTOR), at: now}`, and every write comes with an auto "**Update**" log line from append_knowledge_log. The ledger head did not move across these commits.
- **An existing concept can never be adopted.** tool_write_concept always re-stamps `generated.at = now_iso()`. diff_projection_file hard-refuses any change to `generated` or `verified`. So launch_scan escalates the file to divergent, and resolve_accept_with ("one forged file refuses the entire action") fails. The "Keep my files" button can never succeed on these files.
- **A new concept can never be adopted either.** classify_path returns Divergence("path is unknown to both manifest and reducer"). diff_projection_file errors "is not a committed projection".
- **The promise in write.rs:612-615 is false.** It says "the M23.6 scan reconciles once a writer returns". For concept writes the scan does the opposite: it opens reconciliation mode.
- **Overstatements in the claim:**
  - (a) Not all legacy knowledge writes fail. The legacy log.md appends from the same incident WERE captured as projection.overridden (seq 179). Only concept writes are forced into forgery or unknown-path divergence.
  - (b) "Never reconciled" means "never adoptable". "Restore recorded history" does close the mode, but it throws the agent's work away. The work comes back only if the agent redoes it through the ledger path.
  - (c) "Guaranteed to open reconciliation mode" also needs a later launch_scan on that vault by an instance that holds the writer.

**Evidence checked.** - **mcp.rs:2501** — `frontmatter.insert("generated", json!({"by": actor, "at": now_iso()}))` runs unconditionally. DEFAULT_ACTOR = "claude-code" (mcp.rs:42).
- **vault/write.rs:604-626** — ledger-first only `if let Some(result) = ledger::concepts::write_concept(...)`. Otherwise it falls to the legacy path with the comment "the M23.6 scan reconciles once a writer returns".
- **ledger/concepts.rs:68-80** — returns None when `shadow::with_writer` is None.
- **shadow.rs:294-300** — returns None if `active.vault != normalize(vault)` or the writer is None.
- **shadow.rs:110-116** — writer None on a refused verdict or a held lock (second instance). There is no tauri single-instance plugin in Cargo.toml/lib.rs.
- **capture.rs:961-967** — `if key == "generated" || key == "verified" { return Err("provenance forgery ...") }`.
- **capture.rs:~935-937** — an unknown path gives "is not a committed projection".
- **reconcile.rs:73-77** — `(None, None) => Divergence("path is unknown to both manifest and reducer")`.
- **reconcile.rs:~595-597** — resolve_accept_with maps any diff error to "accept-current-files refused at {path}".
- **Live vault git** — 812605a (04:51:37-07:00) rewrote gcs-5-supervision-ratio.md from flow-style (`generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`) to block-style with `at: 2026-08-17T11:51:31Z`. 1c8c9e9 changed it again to 11:52:02Z. Each commit appended `* **Update**:` lines to knowledge/log.md, including duplicates.
- **Ledger seq 179** — log.md captured as projection.overridden (out_of_band). This shows log appends are reconcilable and concept rewrites are not.

**Correction.** - **Accurate version:** a legacy (no-writer) write_concept can never be adopted by capture or by "Keep my files".
  - Rewriting an existing concept always changes `generated.at`, so it is refused as provenance forgery.
  - A new concept is an unknown path.
- **Scope:** this applies to concept writes only. The legacy knowledge-log appends in the same incident were captured fine (seq 179).
- **What closes the mode:** only "Restore recorded history", which discards the work.
- **When the path is taken:** only when no writer holds the vault — a different active vault, a refused verdict, or a second instance that lost the lock. Divergence then opens at the next launch_scan by the instance that holds the writer.
- **The write.rs:612-615 comment is false for concepts.**

</details>

### F6 — Panel and job-runner agents (including the knowledge recheck lanes) can write knowledge/ directly with the built-in Write/Edit tools

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/agent/mod.rs:656-676`
  - `src-tauri/src/agent/mod.rs:150-160`
  - `src-tauri/src/agent/mod.rs:833`
  - `src/agent/useJobRunner.ts:455-500`

**Evidence**

Only Rust-constructed internal runs (ingest/spawn.rs:174, maintain/live.rs:133, assembly/live.rs:163) get `--disallowedTools Read,...,Write,Edit,MultiEdit,Bash`. Every TS-originated run gets `--permission-mode acceptEdits` with cwd = vault and no disallow list. That covers the panel, scheduled skills, Agent records, and the stale/schema recheck lanes that useJobRunner calls 'the knowledge agent in all but name'. The code's own comment (mod.rs:657-660) says acceptEdits 'auto-approves built-in writes'. `--setting-sources user` also imports the user's global allow rules. On this machine those include `Bash(python3 -c ':*)`, `Bash(node -e ':*)` and `Bash(git add:*)`, so shell writes are possible even with Cerebro's shell setting off. This path was not used on Aug 17: the byte-level evidence points to the MCP path.

**Impact**

This breaks the invariant that knowledge/ is written only through write_concept and verify_concept. A built-in Edit skips the verified-refusal, type-refusal, description, provenance stamp and policy checks. If the writer is active, the watcher captures the edit as a human one (see the human:owner finding). If it is not, the edit becomes another divergence.

**Recommendation**

Always pass `--disallowedTools Write,Edit,MultiEdit,NotebookEdit` for non-shell runs, or deny writes under knowledge/ through a permission rule. Treat the Settings shell grant as the only way to get Bash, independent of the user's global allow list, for example with `--setting-sources` none plus explicit rules.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real. `build_args` has only two branches. When `req.internal` is true, the run gets `--permission-mode default` and `--disallowedTools` with the 11 built-ins. Every other run gets `--permission-mode acceptEdits` and no disallow list.
- `internal` has `#[serde(skip_deserializing)]`, so a TS caller can never set it. Only three Rust call sites set it to true.
- `--allowedTools` is only an auto-approve list. It does not limit which tools the run has. The project's own M31 plan says this directly (D2, plan line ~140). So Write/Edit are available to non-internal runs even with shell off. `acceptEdits` auto-approves them inside cwd, and cwd is the vault.
- The job runner covers the knowledge lanes. Their kinds include 'refresh', 'stale' and 'schema', and they get the knowledge capability fragment. They go through `runAgent` with `internal` left at false, so they get the `acceptEdits` branch.
- A test locks this in: `a_user_authored_run_keeps_its_shipped_surface_even_unattended` asserts that a non-internal run has no `--disallowedTools` and does have `acceptEdits`.
- The global-settings detail checks out. `~/.claude/settings.json` allow rules include `Bash(python3 -c ':*)`, `Bash(node -e ':*)` and `Bash(git add:*)`. Because of `--setting-sources user`, these load into every run.
- Nuance, not a refutation: the M31 plan chose this on purpose ("user-authored runs keep their shipped argv"). So it is a known, accepted gap rather than an oversight. It still breaks the AGENTS.md rule that knowledge/ is written only through write_concept/verify_concept.
- Nothing I read in the code enforces that rule for these runs. The only thing standing in the way is the system prompt.

**Evidence checked.** - src-tauri/src/agent/mod.rs:150-160: `#[serde(skip_deserializing)] pub internal: bool`. Its comment says "Every TS caller (panel, scheduled jobs...) is untouched".
- mod.rs:560-588: `tool_policy` adds Bash/Read/Write/Edit/Glob/Grep to `--allowedTools` only when shell is on.
- mod.rs:621-640: `INTERNAL_DISALLOWED` includes Write, Edit and MultiEdit.
- mod.rs:657-675: the comment says "acceptEdits auto-approves built-in writes". The non-internal branch pushes `--permission-mode acceptEdits` and no disallow list.
- mod.rs:~676-685: `--setting-sources user`.
- mod.rs:833: `.current_dir(vault)`.
- mod.rs:1170-1185: the test asserts that a non-internal run has no `--disallowedTools` and does contain `acceptEdits`.
- `internal: true` is set only at ingest/spawn.rs:174, maintain/live.rs:133 and assembly/live.rs:163.
- src/agent/useJobRunner.ts:455-500: `runAgent` is called with capabilities `['knowledge']` for non-agent jobs, `lane: job.kind`, and no internal flag.
- docs/superpowers/plans/2026-08-12-cerebro-m31-claims-and-records.md:139-150 (D2) says "--allowedTools is a permission auto-approval list, not a tool roster".
- ~/.claude/settings.json allow list contains `Bash(git add:*)`, `Bash(node -e ':*)` and `Bash(python3 -c ':*)`.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - I could not refute this. Nothing in Cerebro stops a TS-originated run from using the built-in Write/Edit on knowledge/.
- build_args gives every non-internal request `--permission-mode acceptEdits`, and it passes no `--disallowedTools`.
- `--allowedTools` is only a list of tools that run without a prompt. It does not hide the built-in tools. The one flag that removes them, `--disallowedTools`, is used only when `internal` is true.
- `internal` is `#[serde(skip_deserializing)]`, so no TS caller can set it. Only three Rust spawn sites set it: ingest/spawn.rs:174, maintain/live.rs:133 and assembly/live.rs:163.
- A Rust test locks this behaviour in on purpose: `a_user_authored_run_keeps_its_shipped_surface_even_unattended` asserts that an unattended run has no disallowed list and does get acceptEdits.
- The code's own comment at mod.rs:657-660 admits that acceptEdits auto-approves built-in writes inside the cwd. The cwd is the vault (mod.rs:833).
- useJobRunner hands the stale/schema/refresh lanes the 'knowledge' capability prompt and spawns them with internal false. They therefore get acceptEdits with no withdrawal.
- The only thing pointing agents at write_concept is prose in the system prompt (systemPrompt.ts:35). That is not an enforcement point.
- `--setting-sources user` does load the user's global allow rules. On this machine those include `Bash(python3 -c ':*)`, `Bash(node -e ':*)` and `Bash(git add:*)`, so shell writes remain possible when Cerebro's shell setting is off.
- The user's PreToolUse hooks are GSD tooling, not Cerebro guards. Nothing in them is specific to knowledge/.
- Caveats: this is a capability gap and I have not seen it exploited. The auditor also says the Aug 17 edits came through a different path. I did not re-verify the impact line "captured as human:owner", which depends on a separate finding.

**Evidence checked.** - src-tauri/src/agent/mod.rs:150-160: `#[serde(skip_deserializing)] pub internal: bool`. The doc comment says "Every TS caller (panel, scheduled jobs…) is untouched".
- src-tauri/src/agent/mod.rs:560-587: tool_policy adds Read/Write/Edit/Bash to `--allowedTools` only when shell is on. It never removes the built-ins.
- src-tauri/src/agent/mod.rs:657-676: `if req.internal { --permission-mode default --disallowedTools INTERNAL_DISALLOWED } else { --permission-mode acceptEdits }`. The comment reads "acceptEdits auto-approves built-in writes".
- src-tauri/src/agent/mod.rs:685-686: `--setting-sources user`.
- src-tauri/src/agent/mod.rs:833: `.current_dir(vault)`.
- src-tauri/src/agent/mod.rs:1170-1184: the test asserts that a non-internal unattended run has no `--disallowedTools` and does contain `acceptEdits`.
- `grep "internal: true"`: only assembly/live.rs:163, ingest/spawn.rs:174 and maintain/live.rs:133 set it.
- src/agent/useJobRunner.ts:465-470: the knowledge lanes get `capabilities: ['knowledge']`, with the comment "the knowledge lanes ARE the knowledge agent in all but name".
- src/agent/useJobRunner.ts:456-500: runAgent is called with no internal flag. The flag cannot come over the wire anyway.
- src/agent/systemPrompt.ts:35: the knowledge rule is prompt text only.
- ~/.claude/settings.json: allow rules include `Bash(git add:*)`, `Bash(node -e ':*)` and `Bash(python3 -c ':*)`. The PreToolUse Write|Edit hooks are gsd-* scripts, not Cerebro guards.

</details>

### F7 — Out-of-band capture attributes every edit to `human:owner`, so agent edits enter history as the owner's

- **Severity (claimed):** high
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/medium, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:808-823`
  - `src-tauri/src/vault/watcher.rs:255-261`
  - `src-tauri/src/ledger/reconcile.rs:635`

**Evidence**

capture_diff_with hard-codes actor_id 'human:owner' for both structured and editorial captures. Live ledger seq 179: the agent-appended log.md bullets were recorded as a projection.overridden with actor {id:'human:owner'}, origin out_of_band. The watcher runs capture_out_of_band live for any knowledge/*.md change. Changes made by the agent CLI are not the app's own writes, so they are captured.

**Impact**

The ledger now says the owner hand-edited log.md, which is false. Combined with the built-in-tools bypass, an agent Edit that leaves `generated` alone is recorded as the OWNER's structured assertion. That turns agent claims into human-attested history and defeats the agent-written, human-verified split.

**Recommendation**

Record out-of-band captures under a distinct unattributed actor (e.g. `unknown:out_of_band`) with authority 'unknown'. Promote to human:owner only when a human UI action is known to have caused the change.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - Mechanism is real. capture_diff_with hard-codes actor "human:owner" for both the structured and the editorial request. The watcher feeds every changed knowledge/*.md into capture_out_of_band. The live ledger shows the misattribution happened.
- It is by design, not a slip. The doc comment on capture_out_of_band_with says outright that captures use actor human:owner with authority "unknown". Out-of-band bytes carry no writer identity, so the code assumes the owner wrote them. The flaw is that assumption.
- Structured path is worse than the claim says. A field diff becomes ObservationKind::HumanAssertion with authority_provenance TrustedHumanCapture. So an agent's field edit that leaves `generated` alone would be recorded as a trusted human assertion.
- Impact is overstated in three ways:
  - Authority role and assertion_basis are both "unknown" by default and never inferred from the actor.
  - A changed `generated` or `verified` stamp is refused as forgery, so an agent cannot mint human VERIFICATION this way. That is exactly what blocked the 3 Aug 17 files. "Defeats the agent-written, human-verified split" goes too far.
  - The live case (seq 179) is an editorial override of log.md's body, a presentation-layer change, not a structured assertion.
- Reach: only non-internal runs get built-in Write/Edit, and only when shell is on (tool_policy). Those runs use acceptEdits. Internal runs are denied the file tools by INTERNAL_DISALLOWED.
- Minor: reconcile.rs:635 is the "Keep my files" adoption path (origin ReconciliationAdoption). There, human:owner is accurate, because a human clicks the button. It does not support the claim.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:808-823 (capture_diff_with): `actor_id: "human:owner".to_string()` in both CaptureRequest and EditorialRequest. The authority is AuthorityAnswers::default().
- capture.rs:757-766: doc comment states "with actor `human:owner`, both authority fields `unknown`".
- capture.rs:73-99: AuthorityAnswers defaults to Unknown/Unknown, "never inferred from who the actor is".
- capture.rs:250-290 (human_assertion): observation_kind HumanAssertion, authority_provenance TrustedHumanCapture.
- capture.rs:961-966: a changed generated/verified key triggers the "provenance forgery" refusal.
- src-tauri/src/vault/watcher.rs:240-261: knowledge/*.md paths are collected, then capture_out_of_band runs on each after the debounce.
- src-tauri/src/agent/mod.rs:580-585 and 627-678: built-in Write/Edit are granted only when shell is on. Non-internal runs use acceptEdits; internal runs get INTERNAL_DISALLOWED.
- reconcile.rs:635: `actor: common("human:owner")` with origin ReconciliationAdoption. This is the human-clicked accept path.
- Live ledger seq 179 (event 17c472b4…, ingested 2026-08-17T11:58:53.806Z): kind projection.overridden, actor {id:"human:owner"}, origin out_of_band, path log.md, change set /body. This matches the agent-appended "**Update**" lines.

**Correction.** Out-of-band capture attributes every captured edit to human:owner, and it does so by design. The live proof is seq 179, where the agent's log.md append was recorded as the owner's editorial override. The structured path would record an agent field edit as a HumanAssertion with TrustedHumanCapture provenance. However, authority role and basis stay "unknown", and any change to the generated/verified stamps is refused as forgery. So agents cannot forge human verification this way. What the ledger loses is who wrote the edit, not the verification gate. The exposure exists only for user-authored runs with shell enabled, which get built-in Write/Edit under acceptEdits. reconcile.rs:635 is the explicit human-clicked adoption path and does not belong in this finding.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** Could not refute; the claim holds.
- The actor is hard-coded. `capture_diff_with` sets `actor_id: "human:owner"` for both the structured and the editorial request. Nothing checks who actually wrote the file: capture compares hashes only, and the watcher never looks at the writer.
- A structured capture is recorded as the owner's own claim. `capture_structured_with` turns each field edit into a `human_assertion(... FieldChange)` event under that actor. So an agent's field or body edit enters history as the owner's firsthand assertion.
- It is reachable in the real app. Panel runs and scheduled Agent-record runs (non-internal) start the CLI with `--permission-mode acceptEdits`. That auto-approves the built-in Write and Edit tools inside the vault. Only internal runs have them withdrawn via `INTERNAL_DISALLOWED`. When the agent edits `knowledge/*.md`, the watcher queues the path and calls `capture_out_of_band`, which attributes the edit to `human:owner`.
- The one guard is narrow. `diff_projection_file` refuses only a changed `generated` or `verified` stamp ("provenance forgery"). That is why the 3 concept files were refused and opened reconciliation. Any agent edit that leaves those stamps alone is captured as the owner's.
- Live evidence matches. Seq 179 is a `projection.overridden` event for `log.md`: actor `{id: human:owner}`, origin `out_of_band`, from the 2026-08-17 agent-era edits.
- Two details to soften:
  - The live case is editorial only (a presentation/body override). No structured owner assertion from an agent exists in this ledger yet; that path is shown from the code, not from live data.
  - The `verified` stamp itself cannot be forged this way (it is refused). The concept is not marked human-verified. The agent's content becomes a human assertion, not a verification.
- Severity stays high: the ledger is tamper-evident, and this corrupts who it says made a change.

**Evidence checked.** - `src-tauri/src/ledger/capture.rs:808-826` (`capture_diff_with`): `actor_id: "human:owner"` for both the `CaptureRequest` and the `EditorialRequest`.
- `src-tauri/src/ledger/capture.rs:303-420` (`capture_structured_with`): emits `human_assertion(&request.actor_id, ..., HumanAssertionForm::FieldChange{..})`.
- `src-tauri/src/ledger/capture.rs` (~L960-966, `diff_projection_file`): refuses only when `key == "generated" || key == "verified"` ("provenance forgery").
- `src-tauri/src/vault/watcher.rs:240-261`: every `knowledge/*.md` change goes to `knowledge_pending`, then `capture_out_of_band(&vault, &rel)` with no writer identity.
- `src-tauri/src/agent/mod.rs:665-676`: non-internal runs get `--permission-mode acceptEdits` (built-in Write/Edit auto-approved, cwd is the vault); only `req.internal` runs get `--disallowedTools INTERNAL_DISALLOWED`.
- `src-tauri/src/ledger/reconcile.rs:635`: the reconciliation adoption path also records `actor: common("human:owner")`.
- Live ledger seq 179: `projection.overridden`, `path` `log.md`, `actor` `{"id":"human:owner"}`, `idempotency_key` `...-editorial`, `ingested_at` 2026-08-17T11:58:53.806Z.

</details>

### F8 — The schema-recheck lane fires on cosmetic Type-doc edits and on concept self-anchors, fanning out into full concept rewrites

- **Severity (claimed):** medium
- **Category:** complexity
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/engine/jobs.ts:167-196`
  - `src/lib/prompts.ts:144-157`
  - `src/app/TypeDialogs.tsx:20`

**Evidence**

The lane compares only `doc.modifiedAt > generated.at`. It resolves `about` over all entries, including knowledge concepts, so a concept whose `about` names itself or another concept of type X is rechecked whenever types/x.md is touched. Incident: types/decision.md was created at 11:50:01Z containing only icon and color (TypeDialogs default '#3D8BE8'). All three concepts were then queued: runtime.db job_ledger `attempts` rows show run_key 2026-08-17T11:50:01Z for exactly gcs-5-supervision-ratio, tx-6-changeover and tx-6-np. gcs-5's `about` already contained [[gcs-5-supervision-ratio]] (itself), and the tx-6 risks anchor to [[frb-118-session-1-disposition]], a Decision concept. The 'Still true' verdict is told to use write_concept, which has no patch mode, so even a no-op verdict re-stamps `generated` and rewrites every field.

**Impact**

Changing a type's icon or color starts unattended agent rewrites of knowledge. Each rewrite is a full overwrite, and on Aug 17 all of them went through the no-writer path. Self-anchors are never refused.

**Recommendation**

Trigger on a hash of the type's field schema, not on mtime. Skip concept targets when resolving `about` for this lane. Have write_concept refuse an `about` entry that points at the concept itself. Give recheck verdicts a stamp-only operation (extend stale_after) that does not re-stamp `generated`.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - The code is real and reachable. `deriveJobs` in jobs.ts:161-196 builds `typeDocs` from every `type: Type` entry. It resolves each `about` target against all entries, concepts included, and queues a `schema` job whenever `doc.modifiedAt > generated.at`. Nothing looks at what changed in the Type doc.
- useJobRunner.ts:423-424 sends `kind === 'schema'` to `schemaRecheckPrompt`.
- The incident data matches. types/decision.md was created in commit f7df8b4 at 11:50:05Z and holds only `icon: file-text` and `color: '#3D8BE8'`. types/risk.md was created 45s earlier.
- runtime.db job_ledger has exactly three `attempts` rows with run_key 2026-08-17T11:50:01Z: gcs-5, tx-6-changeover and tx-6-np.
- gcs-5 is type Decision and was already anchored to itself before Aug 17 (f7df8b4^ shows `about: [[compass-gcs-5]], [[gcs-5-supervision-ratio]]`). Both tx-6 risks anchor `[[frb-118-session-1-disposition]]`, a `type: Decision` concept.
- write_concept creates or replaces the whole file. It rebuilds the frontmatter from its arguments and always re-stamps `generated: {by: actor, at: now}`. It also sets `lifecycle` to `draft` whenever the agent leaves it out. So even a "Still true" verdict is a full rewrite.
- I found no self-anchor refusal in tool_write_concept or knowledge.rs.
- The five sequential edits (11:51 to 11:57Z) fit this lane working through its queue one concept at a time.

Caveats:
- The Aug 17 trigger was a newly created Type doc, not an edit to an existing one. It is cosmetic in content (icon and color only), but "icon or color change" describes the general case, not this exact event.
- The recorded_at on the attempts rows is 2026-08-21. Those rows were probably migrated into runtime.db later, but run_key still identifies the trigger.
- This also contradicts one of the "verified" incident facts. gcs-5's self-anchor was NOT introduced on Aug 17. It already existed in the Aug 16 version (f7df8b4^).

**Evidence checked.** - src/engine/jobs.ts:161-196: the schema/stale recheck loop. `resolveTarget(target, all)` resolves against every entry, and the only test is `doc.modifiedAt <= generatedAt`.
- src/engine/wikilink.ts:58-74: resolveTarget matches any entry by stem or title, concepts included.
- src/agent/useJobRunner.ts:423-424: schema jobs go to `schemaRecheckPrompt`.
- src/lib/prompts.ts:144-157: "Still true — extend `stale_after` with write_concept and change nothing else".
- src-tauri/src/mcp.rs:840: write_concept is described as "Create or replace a concept".
- mcp.rs:2446-2540 (tool_write_concept): builds the frontmatter from scratch. `lifecycle` defaults to "draft" when omitted, `generated` is always `{by: actor, at: now_iso()}`, then vault::write::write_concept.
- Vault git: f7df8b4 (2026-08-17T04:50:05-07:00) adds types/decision.md, whose frontmatter is type/icon/color only. 90437f4 adds types/risk.md. The recheck edits are commits 812605a to e1770e4 (11:51-11:57Z).
- `git show f7df8b4^:knowledge/decisions/gcs-5-supervision-ratio.md` shows the self-anchor was already present on Aug 16.
- runtime.db job_ledger holds three attempts rows with run_key '2026-08-17T11:50:01Z': gcs-5-supervision-ratio.md, tx-6-changeover-transient-cross-channel-sync-disabled.md and tx-6-np-shared-j12-common-mode.md.
- knowledge/decisions/frb-118-session-1-disposition.md is `type: Decision`.

</details>
