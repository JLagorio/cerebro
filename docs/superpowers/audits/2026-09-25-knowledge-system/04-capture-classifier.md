# Capture valve & F/M/R classifier

> Audit lens `capture-classifier` · first-pass auditor, each finding adversarially verified

## Summary

The divergence mechanics work as designed, but they sit on a broken trigger. Re-opening the already-active vault turns off the writer in the same process, so agent write_concept calls fall to the legacy file-first path. The forgery rule then flags the app's own server-stamped output, and the launch scan partly adopts that change set before escalating: log.md is recorded as a human:owner /body override, which freezes the knowledge log for good. 'Keep my files' is blocked twice over, by forgery and by the check that compares raw file bytes against the canonical projection's digest. Meanwhile parked edits can be silently overwritten by agent writes, Verify or in-app saves, and out-of-band capture records agent edits as trusted human evidence.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F29 | critical | yes | Re-opening the vault that is already active turns the ledger writer off, and knowledge writes then silently skip the ledger (likely root cause of the incident) |
| F30 | high | yes | The 'provenance forgery' rule fires on Cerebro's own write_concept and verify output, so every legacy-path write is certain to cause a divergence |
| F31 | high | yes | 'Keep my files' can never succeed on files that are not byte-canonical, independent of the forgery rule |
| F32 | high | yes | The launch scan partly adopts a change set before escalating, and log.md was recorded as a human edit that freezes the knowledge log for good |
| F33 | high | yes | Out-of-band capture turns non-human edits into trusted human evidence |
| F34 | high | yes | Parked out-of-band edits are silently overwritten by ledger-first writes; Verify can attest content the human never saw |
| F35 | medium | yes | The live watcher swallows every capture refusal: no divergence, no toast, no log until the next launch |
| F36 | medium | yes | Neither exit is safe for edits made after the mode opened, and the open mode itself makes 'Keep my files' less and less likely to work |
| F37 | low | yes | The divergence record describes a stale ledger state, and its detection key changes with unrelated manifest churn |
| F38 | low | yes | relation_diff guesses when two concepts share a filename stem |

### F29 — Re-opening the vault that is already active turns the ledger writer off, and knowledge writes then silently skip the ledger (likely root cause of the incident)

- **Severity (claimed):** critical
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/high, confirmed/critical)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:118`
  - `src-tauri/src/ledger/shadow.rs:162`
  - `src-tauri/src/ledger/shadow.rs:274`
  - `src-tauri/src/ledger/writer.rs:955`
  - `src-tauri/src/ledger/writer.rs:1087`
  - `src-tauri/src/lib.rs:1478`
  - `src/stores/vaultStore.ts:123`
  - `src-tauri/src/vault/write.rs:609`

**Evidence**

`activate()` calls `LedgerWriter::open` (shadow.rs:118) while the previous Active still holds the flock. writer.rs's own test `the_lock_admits_exactly_one_writer` shows that a second open in the same process is refused. The failure lands in `.ok()` → `writer: None`. `replace_active` (shadow.rs:274) then drops the working writer anyway. `start_watcher` (lib.rs:1478) activates on every `openVault` (vaultStore.ts:123): webview reload, dev HMR full reload, or picking the same vault again. After that, `with_writer` returns None, and write_concept, append_log and verify all take the legacy file-first path (write.rs:609-625): no ledger events and no policy routing. Live data matches: 0 ledger events between seq 178 (08-17T00:10Z) and seq 179 (11:58:53Z). Meanwhile runtime.db `runs` shows 6 attended agent runs (11:50–11:57Z), the vault got 5 autosync commits, and every commit carries the same Cerebro-Ledger-Head 619957fc. The next activation found the lock free, got a writer, scanned and diverged.

**Impact**

The whole ledger can go dark for the rest of a session with no signal. While it is dark, agent rewrites of human-VERIFIED concepts skip the HIGH-risk review queue (legacy concept_write overwrites the file and drops `verified`). Every such write guarantees a divergence at the next activation.

**Recommendation**

In `activate`, reuse the existing Active writer when the normalized vault matches instead of reopening it. Never replace a live writer with None. With no writer, knowledge writes should be refused rather than falling back to file-first.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real.** A second `activate()` on the same vault, in the same process, turns the writer off:
  - `activate` calls `LedgerWriter::open(...).ok()` (shadow.rs:118) while the old `Active` still holds its writer.
  - `acquire_lock` uses std `try_lock`, which is flock(LOCK_EX|LOCK_NB) (writer.rs:948-970). flock locks attach to the open file description, so a second descriptor in the same process gets WouldBlock. The test `the_lock_admits_exactly_one_writer` (writer.rs:1087) shows this.
  - The result is `writer: None`, with no `launch_scan` and no index. `replace_active` (shadow.rs:274) then drops the old `Active`, which frees the lock, but only after the new open has already failed. The writer stays off until the next activation, so activations alternate between on and off.
- **Nothing tells the user.** `status()` (shadow.rs:367) re-classifies what is on disk and never asks whether this process holds a writer, so it reports `valid`. Every shadow.rs test calls `deactivate()` before `activate()`, so no test covers activating twice.
- **The write path is as claimed.** When `with_writer` returns `None`, `concepts::write_concept` and `append_log` return `None` too, and write.rs:609-625 falls back to the legacy file-first path:
  - `record()` also bails when there is no writer, so zero ledger events are written.
  - There is no policy `route()`.
  - `concept_write` rebuilds the frontmatter from the MCP map, and that map never carries `verified`, so the stamp is dropped.
- **The live data matches the legacy MCP path.**
  - The Aug 17 log.md lines use the exact `* **Update**: [title](/path).` format of `insert_log_entry`.
  - The files carry `generated.by` stamped by the server in mcp.rs:2500.
  - runtime.db `runs` holds 6 attended agent runs for this vault between 11:50 and 11:57Z, as two parallel chains. The pairs line up with the duplicate Update lines.
  - The 0 events between seq 178 and seq 179 also match.
- **Overstated point 1: the root cause is not proven.** The data shows the in-process writer was off during those runs. It cannot tell a second in-process activation apart from a second Cerebro process holding the flock:
  - Candidates for the second process are a dev build and the installed app, which share the com.cerebro.app app-data and the last vault.
  - That case lands in the same `.ok()` → `None` arm and is just as silent.
  - `app_sessions` is empty, so there is no record of which activation or instance happened.
  - "Likely" is fair; "root cause" is unproven.
- **Overstated point 2: "every write guarantees a divergence".** This holds for rewrites of paths already tracked in the manifest, because MCP always re-stamps `generated.at` and the capture step refuses that as forgery. It is not shown for brand-new concepts.
- **Trigger scope.**
  - In release builds, re-activation needs picking the same vault again (SettingsPage.tsx:100 or the chooser) or reloading the webview.
  - In dev, every full reload re-runs the boot effect (App.tsx:298) and calls `start_watcher`. StrictMode does not double-fire it, because of the `cancelled` guard.
  - Severity is high rather than critical, because the ledger goes dark silently but the trigger is narrow.

**Evidence checked.** - **src-tauri/src/ledger/shadow.rs**
  - :114-121 `LedgerWriter::open(&vault, &id).ok()`, with a comment saying a held lock "lands in the None arm below: shadow stays silent there".
  - :126 `launch_scan` runs only if a writer exists.
  - :156-168 no index is built without a writer.
  - :169 `replace_active` drops the old `Active` after the failed open (:274-278).
  - :300 `with_writer` returns `None` when `writer` is `None`.
  - :321 `record()` returns early when there is no writer.
  - :367-397 `status()` classifies what is on disk and has no writer-presence field.
  - Tests at :465, :542, :559, :590 and :650 all call `deactivate()` first; none activates twice.
- **src-tauri/src/ledger/writer.rs**
  - :948-970 `acquire_lock` is `File::try_lock` (flock) and gives WouldBlock → "another Cerebro instance holds this vault's ledger".
  - :1087-1098 a second open in the same process is refused.
- **Call chain**
  - src-tauri/src/lib.rs:1478 is the only non-test caller of `activate`, from `start_watcher`.
  - src/stores/vaultStore.ts:123 `openVault` calls `startWatcher` each time.
  - `openVault` is called from src/App.tsx:158, :163 and :298 (boot) and from src/pages/SettingsPage.tsx:100.
- **Write path**
  - src-tauri/src/ledger/concepts.rs:68-92 `write_concept` and `append_log` return `None` without a writer.
  - src-tauri/src/vault/write.rs:609-625 is the legacy `concept_write` plus a `shadow_write` that records nothing.
  - write.rs:697-720 is the legacy `append_knowledge_log`.
  - src-tauri/src/mcp.rs:2500 stamps `generated {by: actor, at: now}`, and mcp.rs:2539/2546 calls `write_concept` then `append_knowledge_log`.
- **Live data**
  - Vault commit 812605a5 (04:51:37-07:00) adds `* **Update**: [GCS-5 supervision ratio ...]` to log.md, in the app's format.
  - The current log.md has duplicate Update pairs for all 3 concepts.
  - runtime.db `runs` holds 6 attended agent runs for vault 5171d169… (store 30de3878…), started between 11:50:08 and 11:54:54Z, with `proposals_submitted` = 0.
  - runtime.db `operational_log` shows only `agent.usage` rows in the window.
  - runtime.db `app_sessions` is empty, so which activation or instance it was cannot be determined.

**Correction.** - **Confirmed:** a second `activate()` of the same vault in the same process fails the flock. It leaves `writer: None` and frees the lock by dropping the old writer, so activations alternate on and off.
- **Confirmed:** while the writer is off, `ledger_status` shows nothing wrong. MCP `write_concept` and `append_log` write files through the legacy path, with no ledger events, no policy routing and `verified` dropped.
- **Confirmed:** the Aug 17 edits did go through that legacy MCP path. The log format, the server-stamped `generated` field and the 6 agent runs all match.
- **Not proven:** that re-opening the vault caused it. A second Cerebro process on the same vault holding the lock (dev build plus installed app sharing com.cerebro.app) produces the same picture. No surviving record separates the two.
- **Too strong:** "every write guarantees a divergence" holds only for rewrites of concepts the manifest already tracks, since the re-stamped `generated.at` is refused as forgery.
- **Recommended fix either way:** `activate()` should keep the existing writer when the vault is the same, and `ledger_status` should report "this process has no writer".

</details>

<details><summary>Verifier 2: confirmed (severity → critical)</summary>

**Reasoning.** - **The mechanism is real and nothing else guards it.** `activate()` never drops or checks the current Active before it opens a new writer. With the same vault still active, the old writer still holds the flock. The second open fails, `.ok()` turns that into `None`, and `replace_active` then drops the working writer. Every re-activation of the same vault flips the writer: on becomes off, off becomes on.
- **Nothing shows the gap.** `ledger_status` reports only the on-disk verdict (`valid`) and has no field for whether a writer exists. The `with_writer` doc says "ledger_status names why", and that is false.
- **How it can be triggered:** `openVault` calls `start_watcher` with no same-vault guard. Callers are the App.tsx boot effect (it runs on every webview load, so any reload or dev HMR full reload), the Settings vault picker and the chooser. StrictMode does not double-call it, because the `cancelled` flag blocks the first effect. In the installed release build, reload is harder to reach (no Reload menu by default). The Settings re-pick of the same vault and any webview reload still reach it. Under `tauri dev` it is easy to hit.
- **The live data proves the writes took the legacy path.** The Aug 17 concept bytes are in serde_yaml block style: `generated:\n  by: claude-code`, `tags:\n- ADR`, single-quoted `'[[…]]'`. That is `concept_write`'s renderer. The ledger projection renderer (`project.rs`) writes flow style (`generated: { by, at }`, `tags: [..]`), which is exactly what the Aug 16 bytes look like. So Cerebro's own MCP `write_concept` handled these writes while `with_writer` returned `None`. The Claude Code built-in Edit tool would not re-serialize the YAML like this. `shadow_write` is also a no-op without a writer, which is why seq 178→179 is empty. The non-knowledge edits in the same window (`types/risk.md` at 11:49Z, `types/decision.md` and `prototypes/*` at 11:50Z) are also unrecorded. That fits a missing writer.
- **The successful scan at 11:58:53 fits the flip.** A re-activation only gets the lock if the previous Active had no writer, or if this is a fresh process.
- **What is inferred, not proven:** that same-process re-activation was the trigger this time. A second app instance losing the lock (for example `tauri dev` running beside the installed app, which share the config dir) leaves the same legacy-path signature. `app_sessions` is empty, so the data cannot tell the two apart. Both need the same fix: never silently drop to no writer, and surface writer absence.
- **Impact holds.** The legacy `concept_write` overwrites the whole file. The MCP layer never passes `verified` (mcp.rs:2508), so a verified concept loses its stamp. The next activation's scan then refuses the changed `generated` stamp as forgery and opens reconciliation mode.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:83-120: `activate` has no deactivate or same-vault check before `LedgerWriter::open(&vault,&id).ok()` at L118.
- shadow.rs:268-272: `replace_active` overwrites the slot, which drops the old writer.
- writer.rs:265 then 945-958: `acquire_lock` does `try_lock`, and WouldBlock returns "another Cerebro instance holds this vault's ledger".
- writer.rs:1087-1098: `the_lock_admits_exactly_one_writer` shows a second open in the same process is refused.
- shadow.rs:349-408: `LedgerStatus` has no writer-present field.
- lib.rs:1466-1479: `start_watcher` always calls `activate`.
- vaultStore.ts:117-123: `openVault` always calls `startWatcher`.
- App.tsx:290-308: `openVault` runs on every boot.
- SettingsPage.tsx:100: Settings picker calls `openVault`.
- vault/write.rs:609-625: legacy fallback when `ledger::concepts::write_concept` returns None.
- ledger/project.rs:21-60: the ledger projection renders flow style.
- Vault git show 812605a: gcs-5 rewritten from `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }` / `tags: [ADR, …]` to block-style serde_yaml, with trailer Cerebro-Ledger-Head 619957fc; commits 90437f4 (types/risk.md, 11:49Z) and f7df8b4 (11:50Z) carry the same head.
- Ledger ingested_at: seq 178 = 2026-08-17T00:10:35Z, seq 179 = 11:58:53.806Z, with nothing in between.
- runtime.db runs: 6 attended agent runs 11:50:08–11:57:44Z for vault 5171d169 (/Users/joseflagorio/Documents/test).
- runtime.db `app_sessions` is empty, so a same-process re-activation cannot be told apart from a second instance.
- mcp.rs:2501-2509: MCP stamps `generated` and never passes `verified`.

**Correction.** - **Confirmed:** re-activating the active vault flips the writer off, and while it is off, knowledge writes silently skip the ledger. Live bytes prove the Aug 17 edits went through the legacy `concept_write` path (the writer was absent).
- **Not provable from the data:** that re-activation, rather than a second instance losing the lock, caused this incident. Both leave the same signature.
- **Correction on the "whole session" impact:** the ledger is not dark for the rest of the session. The next re-activation turns the writer back on.
- **Reachability:** in release builds it is narrower (Settings re-pick of the same vault, or a webview reload). Under `tauri dev` it is trivial to hit.

</details>

### F30 — The 'provenance forgery' rule fires on Cerebro's own write_concept and verify output, so every legacy-path write is certain to cause a divergence

- **Severity (claimed):** high
- **Category:** false-positive-divergence
- **Verification:** survived (partially_confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:961`
  - `src-tauri/src/mcp.rs:2501`
  - `src-tauri/src/vault/write.rs:613`
  - `src-tauri/src/vault/write.rs:351`
  - `src-tauri/src/ledger/reconcile.rs:77`
  - `src-tauri/src/ledger/reconcile.rs:320`

**Evidence**

diff_projection_file refuses whenever `generated` or `verified` differs (capture.rs:963-967). tool_write_concept restamps `generated: {by: actor, at: now_iso()}` on every call (mcp.rs:2501). The legacy verify path writes `verified` into the file (write.rs:351-354). So every legacy write_concept revision and every legacy Verify click is labelled 'forgery'. Legacy-created NEW concepts become 'path is unknown to both manifest and reducer' (reconcile.rs:77). The comment at write.rs:613-616 says 'the M23.6 scan reconciles once a writer returns', and that is false. Live: all 3 incident files carry the server stamp `generated.by: claude-code, at: 2026-08-17T11:5xZ` and were refused as forgery.

**Impact**

A legitimate, server-stamped agent write, or the human's own verification, is shown to the user as forgery and puts the vault into reconciliation. The only exit that works then throws the work away.

**Recommendation**

Distinguish a server-shaped restamp from forgery. Adopt it as an agent `belief.revised` (actor = generated.by, unsupported basis) through the policy route, flagged 'unrecorded agent write'. Keep the forgery label for a stamp that goes backwards or is malformed, or for a `verified` without an attestation path. Remove the false comment at write.rs:613-616.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real.** When a concept is revised through the legacy path, the next scan with an active writer calls it forgery. `tool_write_concept` stamps `generated: {by: actor, at: now_iso()}` on every call, so the `at` value always differs from the stamp the reducer projected. `diff_projection_file` hard-refuses on any change to `generated` or `verified`. The launch scan then turns that refused capture into a divergence.
- **Verify behaves the same way.** Legacy `verify_frontmatter` writes the `verified` stamp straight into the file. On a committed projection, the next scan refuses that as forgery too.
- **A new concept written the legacy way also diverges, for a different reason.** Neither the manifest nor the reducer knows its path.
- **The write.rs comment is false for revised and verified concepts.** It says "the M23.6 scan reconciles once a writer returns". In those cases the scan escalates to reconciliation instead.
- **The live data fits this path.** The log lines match the server's own format ("**Update**" entries, duplicated as a double write would produce). `generated.by` is claude-code, which is `mcp.rs:42` `DEFAULT_ACTOR`. The ledger recorded zero events for the edits. With no active writer, the legacy `shadow_write` / `shadow::record` step silently records nothing, which explains that.
- **Overstated: this is not "Cerebro's own write_concept" in general.** `vault::write::write_concept` and `verify_frontmatter` try `ledger::concepts::write_concept` / `verify_concept` first. With an active writer, those commit `belief.revised` / `belief.attested`, and the file is regenerated as the projection, so the stamp is in reducer state and the rule never fires.
- **Two conditions must both hold:**
  - `shadow::with_writer` returns None. That means no writer, a writer for a different vault, or a failed lock.
  - A writer is later armed for this vault, and a launch scan runs on files that are already committed projections.
- **"Certain" holds only when both conditions are met.** It is not true of every write the app makes.
- **Severity stays high.** The legacy path demonstrably ran in production and produced this incident. The only exit that works discards the agent's work.
- **Still unverified:** why no writer was active on 2026-08-17 around 11:51Z.

**Evidence checked.** - **src-tauri/src/ledger/capture.rs:961-967:** `if key == "generated" || key == "verified" { return Err("provenance forgery ...") }`
- **src-tauri/src/mcp.rs:2501:** `frontmatter.insert("generated", json!({ "by": actor, "at": now_iso() }))`
- **src-tauri/src/mcp.rs:42:** `DEFAULT_ACTOR = "claude-code"`
- **src-tauri/src/vault/write.rs:~605-627:** `write_concept` tries `crate::ledger::concepts::write_concept` first and falls back to the legacy file-first path only on None. The comment "the M23.6 scan reconciles once a writer returns" sits there.
- **src-tauri/src/vault/write.rs:~342-356:** `verify_frontmatter` tries `ledger::concepts::verify_concept` first. The legacy fallback writes the `verified` patch into the file.
- **src-tauri/src/ledger/concepts.rs:68-105:** these return None only when `shadow::with_writer` yields None.
- **src-tauri/src/ledger/shadow.rs:294-306:** `with_writer` returns None when there is no active writer, the vault differs, or the lock fails.
- **src-tauri/src/ledger/reconcile.rs:75-77:** (None, None) is classified as Divergence("path is unknown to both manifest and reducer").
- **src-tauri/src/ledger/reconcile.rs:~310-322:** `capture_out_of_band_with` Err is pushed to `divergent`, which raises the ManifestReducerDisagreement signal.
- **Live vault, knowledge/decisions/gcs-5-supervision-ratio.md:** `generated: {by: claude-code, at: 2026-08-17T11:52:02Z}`
- **Live vault, knowledge/log.md lines 4-9:** duplicated server-format "**Update**" entries for each of the 3 incident concepts.

**Correction.** The provenance-forgery rule fires only on LEGACY-path (file-first) output: `write_concept` or verify running while `shadow::with_writer` returns None, meaning no writer is active for that vault. When a writer is active, both route through `ledger::concepts`, and the rule does not fire on their output. So a legacy revision or verify of an already-committed projection is certain to diverge at the next launch scan with an armed writer. A legacy create diverges too, as "path is unknown to both manifest and reducer". The write.rs:613-616 comment claiming the scan "reconciles" these is false. The open question is why the writer was inactive on 2026-08-17 around 11:51Z.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Mechanism holds.** `diff_projection_file` refuses on any change to `generated` or `verified`. Legacy `write_concept` stamps `generated.at = now_iso()` again on every call. Legacy verify writes `verified`. A legacy-created concept falls into classify_path's (None, None) branch, which is a Divergence.
- **The escalation holds.** In launch_scan, a failed capture is pushed to `divergent`. That raises ManifestReducerDisagreement and opens reconciliation mode.
- **The legacy path is reachable in the real app, not just in unit fixtures.** `with_writer` returns None whenever the shadow target has no writer: a refused verdict, or a second app instance that lost the single-writer lock. `shadow.rs` says so itself.
- **The live vault proves it happened.** Every signature of the legacy MCP path is present in the Aug 17 commits:
  - the server-shaped stamp `generated: {by: claude-code, at: <each call's time>}`, written block-style by legacy `concept_write`, where the ledger projection writes it flow-style (`{ by: ..., at: ... }`);
  - `* **Update**:` lines from legacy `append_knowledge_log` → `insert_log_entry`, with a new `## 2026-08-17` heading;
  - zero ledger events.
  These are Cerebro's own server-stamped writes, not a raw Claude Code file edit. They were refused as "provenance forgery".
- **No guard exists elsewhere.** Nothing in the capture/reconcile path tells a legacy server-stamped write apart from a forged one.
- **Minor overstatements (not enough to downgrade):**
  - Not literally "every legacy-path write". The legacy `knowledge/log.md` append has no provenance keys and IS captured cleanly (seq 179, projection.overridden, log.md).
  - "Certain" depends on a later launch_scan running with an active writer. That is the normal next start.
  - A rewrite in the same second as the prior stamp would not trip it. That is negligible.
- **The write.rs:613-616 comment is misleading.** It says the scan "reconciles once a writer returns". What actually happens is that reconciliation mode opens, and `resolve_accept_with` also calls `diff_projection_file`, so "Keep my files" is refused too.

**Evidence checked.** - **src-tauri/src/ledger/capture.rs:960-967** — `if key == "generated" || key == "verified" { return Err("provenance forgery: ...") }`
- **src-tauri/src/mcp.rs:2501** — `frontmatter.insert("generated", json!({ "by": actor, "at": now_iso() }))`, applied on every call.
- **src-tauri/src/vault/write.rs:600-624** — the ledger-first `write_concept` returns None without a writer. The legacy `concept_write` then runs, and `shadow_write` records nothing because no writer is active.
- **src-tauri/src/vault/write.rs:341-356** — legacy `verify_frontmatter` writes the `verified` patch straight to the file.
- **src-tauri/src/vault/write.rs:692-722** — legacy `append_knowledge_log` → `insert_log_entry`.
- **src-tauri/src/ledger/shadow.rs:288-305** — `with_writer` returns None for "a refused ledger, a second instance that lost the lock".
- **src-tauri/src/ledger/reconcile.rs:75-78** — (None, None) → `Divergence("path is unknown to both manifest and reducer")`.
- **src-tauri/src/ledger/reconcile.rs:309-330** — a capture Err is pushed to `divergent`, which yields the ManifestReducerDisagreement signal.
- **Live vault /Users/joseflagorio/Documents/test, git log for 2026-08-17 11:51-11:57Z:**
  - Commits 812605a, 1c8c9e9, 7658504, e3543b4 and e1770e4 each change `generated: { by: claude-code, at: 2026-08-16T... }` (flow style) to block-style `generated:\n  by: claude-code\n  at: 2026-08-17T11:5x` with a new `at` per call.
  - The same commits add `+## 2026-08-17` and `+* **Update**: [...]` to knowledge/log.md. Commit 7658504 adds a duplicate Update line.

</details>

### F31 — 'Keep my files' can never succeed on files that are not byte-canonical, independent of the forgery rule

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:854`
  - `src-tauri/src/ledger/reduce.rs:4584`
  - `src-tauri/src/ledger/project.rs:37`
  - `src-tauri/src/vault/write.rs:643`
  - `src-tauri/src/ledger/capture.rs:807`

**Evidence**

The accept resolution pins `content_hash = sha256(raw file bytes)` (reconcile.rs:854-871). The reducer recomputes the digest from the canonical projection after the staged members and refuses on mismatch (reduce.rs:4584). project() renders objects in flow style and short lists as `[a, b]` (project.rs:37-41, 58-68). The legacy writer, and any YAML editor, emits block style through serde_yaml (write.rs:643-653, 230-236). Live: gcs-5-supervision-ratio.md on disk has `generated:\n  by: claude-code` and a block `tags:` list. The Aug 16 projection (git 812605a^, hash e096dab8 = the manifest entry) has `generated: { by: …, at: … }` and `tags: [ADR, …]`. A change that is only formatting yields an empty diff: capture_diff_with does nothing and reports success, the file never converges, and it counts toward the mass signature on every launch.

**Impact**

Even if forgery were fixed, accepting the 3 incident files would be refused with a cryptic digest error. Any file saved by Obsidian or a formatter makes 'Keep my files' permanently unavailable.

**Recommendation**

Adopt semantically: pin the digest to the reducer's projection of the adopted state, not the raw bytes, and rewrite the adopted files to canonical bytes after commit. Treat a parse-equal file as 'format-only': regenerate it with zero capture and keep it out of the mismatch count.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - **Byte pin vs canonical render.** The accept path pins the raw file bytes, but the reducer checks those bytes against its own canonical rendering (`project()`). Nothing in between normalises the file.
  - `resolve_accept_with` writes `content_hash = sha256(raw.as_bytes())` for each affected file and sets `resulting_projection_digest` to that value.
  - `apply_reconciliation_resolved` recomputes the hash from `projected_bytes`, which is `project(overlaid(content, fields))`, and refuses when the two differ.
- **Formatting is invisible to the diff.** `diff_projection_file` compares parsed JSON values (`before == after`) and body strings. A change that is only YAML spelling (block vs flow, list style, key order) produces no field edit and no editorial op, so no member can make the reducer render the file's bytes.
- **Result.** Any affected file whose bytes are not the canonical spelling makes the digest mismatch. The whole accept batch fails, because it is all-or-nothing.
- **Out-of-band capture has the same gap.** A formatting-only change gives an empty diff, so `capture_diff_with` does nothing and returns Ok (the scan records it as captured). It never calls `manifest::write_projection`, so the file never converges. It is counted again on every launch, and `initial_mismatches` is computed before capture, so it feeds the mass-mismatch check.
- **Live data matches the claim.**
  - The vault commit before `812605a` holds the canonical version (`generated: { by, at }`, `tags: [ADR, ...]`, quoted flow `about`). Its sha256 is `e096dab8...`, which is exactly the manifest's `content_hash` for this file.
  - The file on disk uses block style everywhere, including `generated:` and `tags:`, in the serde_yaml-looking spelling.
  - So even without the forgery rule, accepting this file would fail on the digest.
- **The test never covers this case.** `accept_current_files_adopts_through_capture_in_one_batch` asserts that the adopted bytes equal `project_belief(...).bytes`, but its fixture only makes edits that are already canonical.
- **Correction to incident fact (outside this claim).** The self-referencing `about: [[gcs-5-supervision-ratio]]` is already in the canonical version before `812605a`. The Aug 17 agent edits did not introduce it.
- **Two points not verified.**
  - The exact error text may come from `append_batch` validating members before writing, or from the anomaly detail. Either way the accept fails.
  - I did not check the source lines for the claim that `write.rs` or third-party editors emit block style. The live file's block style is enough on its own to show the mechanism.

**Evidence checked.** - `src-tauri/src/ledger/reconcile.rs:854-887`: the `adopted` list hashes `raw.as_bytes()`, and `resulting_projection_digest: accepted_digest`.
- `src-tauri/src/ledger/reconcile.rs:902-910`: if the batch is not committed, it returns "accept-current-files refused: {detail}".
- `src-tauri/src/ledger/reduce.rs:4559-4586`: the digest is recomputed from `projected_bytes(state, belief)` and refused when it does not match.
- `src-tauri/src/ledger/reduce.rs:471-474`: `projected_bytes = project(overlaid)`.
- `src-tauri/src/ledger/project.rs:21-68`: objects render in flow style, and flow-safe scalar arrays render as `[a, b]`.
- `src-tauri/src/ledger/capture.rs:927-1001`: `diff_projection_file` skips a key when the parsed `before == after`; the body is compared as a string only.
- `src-tauri/src/ledger/capture.rs:789-829`: `capture_diff_with` does nothing on an empty diff and returns Ok; the manifest is only written inside the capture_* writers (`capture.rs:339/614/659/730`).
- `src-tauri/src/ledger/reconcile.rs:119-121`: a hash mismatch against a complete manifest entry is classified OutOfBandEdit, every launch.
- `src-tauri/src/ledger/reconcile.rs:305-309`: the mass-mismatch check is computed before capture.
- Live vault `knowledge/decisions/gcs-5-supervision-ratio.md`: block-style `about`/`tags`/`generated:\n  by: claude-code`.
- `git show 812605a^:knowledge/decisions/gcs-5-supervision-ratio.md`: flow-style `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }` and `tags: [ADR, human-factors, operations, supervision]`; its sha256 `e096dab8d7ac771c...` equals the manifest `content_hash`.
- Test `reconcile.rs:1585-1633` only covers canonical edits.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - The mechanism is real and nothing else in the code guards against it.
- **Accept pins the raw file bytes.** `resolve_accept_with` builds the resolution's `resulting_projection_digest` from `sha256(raw)` of each affected file.
- **The reducer checks against canonical bytes.** It recomputes the same digest from `projected_bytes()`, which is `project()`'s one canonical spelling: flow-style `{ by, at }` objects, `[a, b]` scalar lists, double-quoted wikilinks. If the digests differ, it refuses the whole batch.
- **The diff cannot close the gap.** `diff_projection_file` compares parsed values only, so formatting never produces a member that would make the projection equal the raw bytes.
- **Result:** any affected file whose bytes are not canonical makes the batch fail. `resolve_accept_with` then returns "accept-current-files refused: <anomaly detail>" (reconcile.rs ~L901-911). This happens whether or not the diff is empty.
- **The live vault reaches this.** All 3 incident files are in serde_yaml block style: `generated:` over indented `by:`/`at:`, block `tags:`, single-quoted `'[[...]]'`. The Aug 16 canonical version (812605a^) hashes to e096dab8…, and uses flow `generated` and `tags: [ADR, …]`.
- **Today the forgery refusal fires first**, so this is the second blocker, not the one users see now. Fixing forgery alone would still leave "Keep my files" refused with a cryptic digest error.
- **Formatting-only edits never converge.** The empty-diff part of the claim holds:
  - `capture_diff_with` pushes nothing and returns `Ok`.
  - Only the `capture_*_with` paths call `manifest::write_projection`, which is what rewrites the file to canonical bytes.
  - So the file stays OutOfBandEdit on every launch and counts toward the mass-mismatch check (8 projections / 5 mismatches / 25%).
- **Severity: high is justified.** "Keep my files" is the only choice that keeps the edits. Restore is destructive, and any YAML-reformatting editor (Obsidian properties, serde_yaml writers) would leave only that option.

**Evidence checked.** - **src-tauri/src/ledger/reconcile.rs:854-871** — `adopted` = `{path, content_hash: sha256_hex(raw.as_bytes())}`; `resulting_projection_digest: accepted_digest`.
- **src-tauri/src/ledger/reduce.rs:~4565-4590** — the reducer recomputes `sha256_hex(projected_bytes(state, belief))` per affected path and refuses on mismatch: "resulting_projection_digest does not match the reducer projections over the affected paths".
- **src-tauri/src/ledger/reconcile.rs:~901-911** — batch not committed → `Err("accept-current-files refused: {detail}")`.
- **src-tauri/src/ledger/project.rs:37-68** — objects are rendered with `render_flow`; flow-safe scalar arrays become `key: [a, b]`.
- **src-tauri/src/ledger/capture.rs:927-1010** — `diff_projection_file` compares parsed values (`before == after → continue`), and the body is compared as parsed content, so a formatting-only change yields an empty diff.
- **src-tauri/src/ledger/capture.rs:807-829** — `capture_diff_with` with an empty diff calls nothing and returns `Ok(())`.
- **src-tauri/src/ledger/manifest.rs:184-214** — `write_projection` (reached only via `capture_*_with`) is what canonicalizes the file on disk.
- **src-tauri/src/ledger/reconcile.rs:200-202, 303-307** — mass thresholds 8 / 5 / 0.25.
- **Live data:** `/Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md` has block `about:` with `'[[compass-gcs-5]]'`, block `tags:`, and `generated:\n  by: claude-code\n  at: 2026-08-17T11:52:02Z`. The two tx-6 risk files show the same style. The Aug 16 blob (`git show 812605a^:…`, sha256 e096dab8…) has `tags: [ADR, human-factors, operations, supervision]` and `generated: { by: claude-code, at: 2026-08-16T19:38:29Z }`.

</details>

### F32 — The launch scan partly adopts a change set before escalating, and log.md was recorded as a human edit that freezes the knowledge log for good

- **Severity (claimed):** high
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/medium, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:313`
  - `src-tauri/src/ledger/capture.rs:820`
  - `src-tauri/src/ledger/reduce.rs:3970`
  - `src-tauri/src/ledger/reduce.rs:4360`
  - `src-tauri/src/ledger/concepts.rs:815`
  - `src-tauri/src/ledger/reconcile.rs:443`

**Evidence**

The capture loop commits each parked path one at a time, in BTreeSet order. decisions/… fails, then knowledge/log.md is captured (seq 179: projection.overridden, actor human:owner, origin out_of_band, /body set), then risks/… fail and the divergence is recorded (seq 180). The log.md 'edit' was the system's own legacy append_knowledge_log output, yet it is recorded as human:owner (capture.rs:822). The /body override never clears: revisions only mark overrides stale (reduce.rs:3970-3974), apply_overlay_op replaces the body wholesale (reduce.rs:4360-4364), and no production code emits OverrideChange::Clear. append_log_with revises `current.content`, the base under the override (concepts.rs:815-842), so new log entries never reach the file. Restore regenerates from state that includes the override (reconcile.rs:443-446). Live manifest: log.md generating_event = 17c472b4 (the override), and the file hash 34e25ca2 equals the override's after-hash.

**Impact**

log.md keeps six '**Update**' lines for edits that 'Restore recorded history' will revert. After either exit, every future write_concept log entry is committed but never shown: the 'is the base learning anything' changelog is silently frozen at Aug 17.

**Recommendation**

Make launch-scan capture all-or-nothing: classify and diff every parked path first, and capture only if all succeed. Never capture system-owned projections (log.md, index.md) as human overrides; regenerate them. Add a Clear producer, or let a system log revision supersede stale /body overrides.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Partial adoption is real.** In reconcile.rs:313-323 the scan captures each parked out-of-band path one at a time. A failed capture moves that path to `divergent`, but paths that capture successfully stay committed. Divergence is only checked after the loop (L326+). That is why log.md was captured at seq 179 while the three concept files failed and seq 180 recorded the divergence.
- **Actor is hard-coded.** capture.rs:810/822 set `actor_id` to "human:owner" for every out-of-band capture. The log.md text is in the system's own `insert_log_entry` format, which the legacy direct-write fallback produces (vault/write.rs:692-720, used when `ledger::concepts::append_log` returns None). So the system's own output was recorded as a human edit.
- **The /body override is effectively permanent.**
  - A revision only sets `stale = true` on overrides (reduce.rs:3970-3974).
  - `overlaid()` (reduce.rs:457-468) applies every override, stale or not.
  - `apply_overlay_op` replaces the whole body for /body (reduce.rs:4360-4364).
  - `OverrideChange::Clear` is only built in tests: conformance.rs is `#[cfg(test)]`, index.rs:994 sits under `cfg(test)` at L835, and the rest is schema tests. Every production emitter (capture.rs:702, reconcile.rs:647) emits `Set` with an empty `supersedes`.
- **New log entries never reach the file.** `append_log_with` revises `current.content`, the base under the override (concepts.rs:815-842). The projected log.md therefore keeps showing the override's frozen body.
- **Restore keeps the override.** `resolve_restore_with` uses `project_belief` → `projected_bytes` → `overlaid`, so restore regenerates log.md with the override still applied.
- **Live data matches.** Manifest `generating_event` for log.md is 17c472b4 (the override), `content_hash` 34e25ca2 equals the override's `after_projection_hash`, and log.md holds 6 "**Update**" lines.
- **Overstated parts.**
  - "For good" is too strong. A later human body edit (`capture_body_edit`) or another out-of-band capture can stack a newer /body override, so the log is only frozen against automatic appends.
  - Nothing is lost from the ledger: the revisions are recorded and only the projection hides them.
  - The freeze has not shown up yet. There are no log.md events after seq 179, because reconciliation has been open ever since.
  - The effect is silent loss of a presentation changelog that can be recovered, not data loss. Medium, not high.

**Evidence checked.** - **Capture loop:** src-tauri/src/ledger/reconcile.rs:313-323 captures each path in its own call; divergence is appended only at L341+.
- **Actor:** src-tauri/src/ledger/capture.rs:810,822 (`actor_id: "human:owner"`); capture.rs:702-705 emits `Set` with `supersedes_override_event_ids: vec![]`.
- **Overrides:** src-tauri/src/ledger/reduce.rs:3970-3974 only mark overrides stale; reduce.rs:457-468 `overlaid` applies all overrides; reduce.rs:4360-4364 /body replaces content wholesale; reduce.rs:583-598 `project_belief` uses `projected_bytes`.
- **No production Clear:** `grep OverrideChange` finds `Clear` only in the conformance.rs tests (ledger/mod.rs:24-25), schema tests and the reducer's match arm. index.rs:994 is inside `#[cfg(test)]` (L835).
- **Log append:** src-tauri/src/ledger/concepts.rs:815-842 `append_log_with` patches `current.content`.
- **Legacy fallback:** src-tauri/src/vault/write.rs:692-720 writes the file directly, in `insert_log_entry` format, when no writer is active; it is called from mcp.rs:2546.
- **Live ledger:** log.md belief 49e24332 has `belief.revised` events by system:knowledge-log up to seq 171 (2026-08-16), then seq 179 `projection.overridden` by human:owner, origin out_of_band, patch ['/body'], base revision 29, after hash 34e25ca2. There are no log.md events after that.
- **Live manifest:** knowledge/log.md `generating_event` is 17c472b4…, `content_hash` 34e25ca2…; sha256 of the file on disk is also 34e25ca2; `grep -c "**Update**"` returns 6.

**Correction.** The mechanism is real. The launch scan commits successful captures one path at a time before deciding whether to escalate, so log.md's out-of-band edit (the system's own legacy-fallback log format, labelled human:owner) was adopted as a /body override while its sibling concept files were refused. Production code never clears or supersedes that override, and both future `append_log` revisions and "Restore recorded history" project through it. After either exit, automatic knowledge-log entries will be recorded in the ledger but not shown in log.md. Two corrections: nothing is lost from the ledger, and the freeze can be broken by a later human body edit or out-of-band capture, which stacks a newer /body override. The freeze also has not happened yet, because reconciliation has blocked writes since seq 180. Severity: medium, not high.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** I tried to refute each link in the chain and could not. Every one holds in the code and in the live vault.

- **The scan adopts part of the change set before it escalates.** At reconcile.rs:313-323 the capture loop runs on each parked path in turn. A failed capture goes into `divergent` and the loop keeps going, so captures that already succeeded stay committed. In the live ledger, log.md was captured at seq 179 and the divergence was recorded at seq 180, in the same scan.
- **System output was recorded as a human edit.** The "**Update**" lines in log.md come from the app's own MCP `tool_write_concept` (mcp.rs:2546), which calls `vault::write::append_knowledge_log`. At the time no ledger writer was active, so it took the legacy file-first path (write.rs:692-715). `log_kind(true)` returns "Update". The capture then stamped this `actor_id: "human:owner"` (capture.rs:810-822). Seq 179 shows actor human:owner, origin out_of_band, and a patch on `/body` only.
- **Nothing in production ever clears the override.**
  - A revision only sets `stale = true` (reduce.rs:3970-3974).
  - `overlaid()` applies every active override on top of `current.content` (reduce.rs:457-467).
  - `apply_overlay_op` replaces the whole content for `/body` (reduce.rs:4360-4364).
  - `OverrideChange::Clear` is built only in conformance and schema tests. No production emitter exists, and capture and accept never set `supersedes` (both use `vec![]`).
  - Nothing outside the index reads `stale`, so no maintenance step acts on it either.
- **New log entries land under the override.** With a writer active, `append_knowledge_log` goes to `ledger::concepts::append_log` → `append_log_with` (concepts.rs:800-842). That revises `current.content`, which sits under the `/body` override, so the regenerated file stays the Aug 17 bytes.
- **Neither way out removes the override.** "Restore recorded history" regenerates through `project_belief`, which uses the overlaid state (reconcile.rs:443-446), so log.md keeps the override and its six Update lines. "Keep my files" also builds on `overlaid()` and adds another Set.

Two nuances, neither of which refutes the claim:
- **The freeze has not happened yet.** Reconciliation mode has blocked every write since seq 180. There are no log.md revisions after seq 179, so no entry has been silently dropped so far. The freeze begins as soon as either button closes the mode.
- **Nothing is deleted.** Future entries are committed to the ledger as `belief.revised`. What goes stale is the file people read, not the record, which fits "silently frozen".

**Evidence checked.** - **Partial adoption:** src-tauri/src/ledger/reconcile.rs:313-323. The loop runs `capture_out_of_band_with` per path; `Err` goes to `divergent` and the loop continues. Signals are pushed at L330-333.
- **Actor stamp:** src-tauri/src/ledger/capture.rs:810-830 sets `actor_id: "human:owner"` for both the structured and the editorial capture. capture.rs:706-708 builds `OverrideChange::Set` with `supersedes: vec![]`.
- **Where the Update lines came from:** src-tauri/src/mcp.rs:2546 calls `append_knowledge_log`. src-tauri/src/vault/write.rs:692-715 takes the legacy file path when `ledger::concepts::append_log` returns `None` (no writer). src-tauri/src/knowledge.rs:272-277: `log_kind(true)` = "Update".
- **Overlay mechanics:**
  - reduce.rs:3970-3974: a revision only marks overrides stale.
  - reduce.rs:457-467: `overlaid` applies all overrides on top of `current.content`.
  - reduce.rs:4355-4364: a `/body` override replaces the content wholesale.
  - reduce.rs:4474: `Clear` is handled, but grep finds emitters only in ledger/conformance.rs:2370/2386/2500 and schema/projection.rs and tests.rs.
  - The only reader of `stale` is ledger/index.rs:728 (index only).
- **Log append:** src-tauri/src/ledger/concepts.rs:800-842. `append_log_with` builds a `BeliefRevised` from `current.content` with a `/body` patch.
- **Restore:** reconcile.rs:443-446 regenerates via `project_belief`, which uses the overlaid state. Accept (reconcile.rs:624-650) also layers on `overlaid()` with `supersedes: vec![]`.
- **Live ledger:**
  - The log.md belief 49e24332 has `belief.revised` events by system:knowledge-log from seq 12 through 171 (Aug 16).
  - Seq 179 is `projection.overridden` 17c472b4, actor human:owner, out_of_band, `['/body']`, after-hash 34e25ca2.
  - There are no log.md events after that, because the mode is open and writes are suspended.
- **Live manifest and file:** the manifest entry for knowledge/log.md has `generating_event` 17c472b4d99b…, `content_hash` 34e25ca27c4e…, and `projected_revision` 29. sha256 of the knowledge/log.md file on disk is 34e25ca2.
- **Live log.md:** lines 4-9 are six "**Update**" bullets, two for each of the 3 concepts. Vault git: five "Update 2 notes in knowledge" commits on 2026-08-17 between 04:51 and 04:57 -0700.

</details>

### F33 — Out-of-band capture turns non-human edits into trusted human evidence

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:807`
  - `src-tauri/src/ledger/capture.rs:288`
  - `src-tauri/src/ledger/capture.rs:507`
  - `src-tauri/src/vault/watcher.rs:254`
  - `src-tauri/src/agent/mod.rs:672`

**Evidence**

capture_diff_with hard-codes actor `human:owner` for every out-of-band diff (capture.rs:808-826). Field diffs become human_assertion Observations with `authority_provenance: TrustedHumanCapture` (capture.rs:288-290) and are added as `supports` basis links (capture.rs:507-516). The only guard is whether `generated`/`verified` changed. User-authored agent runs spawn with `--permission-mode acceptEdits` and cwd = vault (agent/mod.rs:672-674). The M31.1a comment at :656-660 concedes that acceptEdits auto-approves built-in writes. So a Claude Code Edit/Write on knowledge/*.md that leaves `generated` alone, a git pull, or a sync merge is captured by the live watcher (watcher.rs:254-261) as a trusted human assertion. The ingest source comment (ingest/source.rs:47) builds on the same attribution.

**Impact**

The trust model is inverted. An honest agent that restamps provenance is called forgery, while one that edits silently is promoted to the highest human authority tier and counts as supporting evidence.

**Recommendation**

Record out-of-band changes under a distinct `unattributed:out_of_band` actor with authority `unknown`, not trusted capture. Also, or alternatively, refuse built-in Write/Edit under knowledge/ for all agent runs (disallowedTools or a path deny rule), not only for internal runs.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Real:** every out-of-band diff is recorded as `human:owner`. Field diffs become HumanAssertion observations with `authority_provenance: TrustedHumanCapture`, and they are added to the belief as `Supports` basis links.
- **Real:** user-authored agent runs get `acceptEdits` with the vault as cwd. Only internal runs are denied Write/Edit (`INTERNAL_DISALLOWED`). The live watcher captures any change to `knowledge/*.md`. The only guard is the generated/verified stamp check.
- **Real:** an agent that restamps `generated` is refused as "forgery", while one that edits silently is captured. That asymmetry is true.
- **Seen in live data:** seq 179 `projection.overridden` on log.md is attributed to `human:owner`, origin out_of_band. log.md was changed by the agent's Aug 17 edits ("**Update**" lines), so an agent edit is already on record as the owner's. That event is an editorial override, not an assertion.
- **Overstated:** "highest human authority tier". The capture uses `AuthorityAnswers::default()`, i.e. role Unknown and basis Unknown. The human authority routes require role project_owner/team_member and basis firsthand/responsible_owner, so these captures never satisfy an authority route. They also cannot back the `distinct_firsthand_origin` independence proof, which needs basis Firsthand. What they do get is the TrustedHumanCapture label, human:owner attribution and supporting-evidence status.
- **Not seen in live data:** the live ledger has zero out-of-band HumanAssertion observations. In this incident the three concept edits were refused, not promoted. The promotion path is a real latent bug, not the cause of the banner.

**Evidence checked.** - capture.rs:807-829: `capture_diff_with` hard-codes `actor_id: "human:owner"` for both the structured and the editorial requests, with `authority: AuthorityAnswers::default()`.
- capture.rs:92-98: the default is `SubjectRole::Unknown` / `AssertionBasis::Unknown`.
- capture.rs:269-290: `observation_kind: HumanAssertion`, `authority_provenance: TrustedHumanCapture`.
- capture.rs:507-516: every new observation is pushed as `BasisRole::Supports`.
- capture.rs:961-966: the only guard, `generated`/`verified` changed → "provenance forgery".
- watcher.rs:254-261: `capture_out_of_band` runs for every pending `knowledge/*.md`.
- agent/mod.rs:628-674: `INTERNAL_DISALLOWED` (Write/Edit/…) applies only when `req.internal`. Other runs get `--permission-mode acceptEdits`.
- ingest/source.rs:47-50: `OWNER_ACTOR = "human:owner"`, shared with capture.
- policy/authority.rs:475-580: route criteria filter on relationship_roles and assertion_bases.
- shared/policy/authority-routes.v1.json: roles are only project_owner/team_member and bases only firsthand/responsible_owner. Unknown never qualifies.
- reduce.rs:3643-3650: `distinct_firsthand_origin` needs TrustedHumanCapture and basis Firsthand.
- Live ledger event counts: no human_assertion observations. There is exactly 1 `projection.overridden` by `human:owner` (seq 179, log.md, the agent-edited file).

**Correction.** The mechanism is real. Every out-of-band edit to knowledge/*.md is attributed to `human:owner`, and that includes edits from a user-authored agent run (acceptEdits, cwd = vault), a git pull or a sync merge. Field diffs become HumanAssertion observations labelled TrustedHumanCapture and are added as Supports links. But role and basis are always Unknown, so they satisfy no authority route and cannot back firsthand independence. The misattribution is real and reaches supporting evidence, not the highest authority tier. In the live vault it shows up only as the seq-179 editorial override on log.md credited to human:owner. The three concept edits were refused, not promoted.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** Reachable, and it has already happened once in the live vault, but the claim oversells the authority granted.

Confirmed:
- capture_diff_with hard-codes `human:owner` for both field captures and editorial captures.
- Field diffs become human_assertion observations. The reducer's derive_authority grants TrustedHumanCapture whenever the registered human_actor id equals the observation actor, and here both are `human:owner`. Those observations are appended as `supports` basis links.
- The only provenance guard is a changed `generated` or `verified` key.
- User-authored runs (the panel and Agent records) keep the built-in Write/Edit tools under `--permission-mode acceptEdits` with cwd set to the vault. INTERNAL_DISALLOWED applies only to internal runs. The live watcher then captures any knowledge/*.md change.
- Live proof of misattribution: at seq 179, the agent's Aug 17 "**Update**" lines in log.md were recorded as projection.overridden, actor human:owner, origin out_of_band. It is the only human:owner event in the ledger. The inverted trust model is real: the 3 concept files that honestly restamped `generated` were refused as "forgery" and opened reconciliation, while the silent log.md edit was accepted as the owner's.

Overstated:
1. It is not "the highest human authority tier". AuthorityAnswers::default() sets assertion_basis=Unknown and role=Unknown, so these observations cannot satisfy firsthand-gated rules. For example, distinct_firsthand_origin (reduce.rs:3643-3655) requires TrustedHumanCapture plus Firsthand.
2. The live ledger has ZERO human_assertion observations. The TrustedHumanCapture `supports` path has not fired in this vault. The realized harm is limited to one editorial override on log.md being attributed to the owner.
3. Attributing out-of-band edits to the owner is a deliberate M23.7 design: file bytes carry no actor identity, and ingest/source.rs:47 names that choice. So this is a known attribution gap, not a hidden bug. It is still a real defect for a vault where agents with acceptEdits write into the same directory.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:807-826: actor_id "human:owner" for CaptureRequest and EditorialRequest, with authority AuthorityAnswers::default().
- capture.rs:77-99: the default is role Unknown, assertion_basis Unknown.
- capture.rs:288-290: TrustedHumanCapture on the payload.
- capture.rs:503-512: new observations pushed as BasisRole::Supports.
- capture.rs:961-967: the only guard, which refuses a changed generated/verified stamp as forgery.
- src-tauri/src/ledger/schema/observation.rs:660-686: derive_authority grants TrustedHumanCapture when the HumanActor registration actor_id equals the observation actor.
- src-tauri/src/ledger/reduce.rs:3641-3655: independence proof requires TrustedHumanCapture AND Firsthand, which the Unknown basis blocks.
- src-tauri/src/agent/mod.rs:628-640: INTERNAL_DISALLOWED (Write/Edit/MultiEdit…) applies only when req.internal.
- agent/mod.rs:665-670: non-internal runs get acceptEdits.
- src-tauri/src/vault/watcher.rs:254-261: capture_out_of_band on every debounced knowledge/*.md change.
- src-tauri/src/ingest/source.rs:47-51: OWNER_ACTOR "human:owner" is the deliberate attribution.
- Live ledger (d62256b3…0001.ndjsonl.open): seq 179 is kind projection.overridden, actor {id:"human:owner"}, path log.md, origin out_of_band. Actor counts: claude-code 58, human:owner 1 (only seq 179). `grep -c human_assertion` = 0.

**Correction.** Out-of-band capture does attribute every non-app edit to `human:owner`, and field edits become TrustedHumanCapture `supports` observations. The only check is whether the generated/verified stamp changed, and user-authored agent runs can reach this path through Write/Edit under acceptEdits. However, the captures carry assertion_basis=Unknown and role=Unknown, so they cannot meet firsthand-gated rules; this is not the top authority tier. In the live vault the only realized instance is the seq 179 editorial override of log.md recorded as human:owner. No human_assertion observations exist there. Severity: medium (a latent trust inversion with one live misattribution), not high.

</details>

### F34 — Parked out-of-band edits are silently overwritten by ledger-first writes; Verify can attest content the human never saw

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/manifest.rs:184`
  - `src-tauri/src/ledger/concepts.rs:68`
  - `src-tauri/src/ledger/concepts.rs:182`
  - `src-tauri/src/ledger/capture.rs:849`
  - `src-tauri/src/ledger/capture.rs:840`

**Evidence**

manifest::write_projection reads the prior bytes only to store `previous_content_hash`. It never compares them to the manifest entry's content_hash, so it overwrites whatever is on disk (manifest.rs:190-229). write_concept, append_log and verify_concept never check `reconciliation_open` (concepts.rs:68-110); only the capture paths do. verify_with attests the reducer's current revision (concepts.rs:182-203) and then regenerates the file. The Knowledge UI renders the disk bytes, so while the mode is open (since Aug 17) a Verify on gcs-5-supervision-ratio.md attests the Aug 16 text and deletes the Aug 17 text it displayed. capture_body_edit combines the saved body with the reducer's fields, not the file's (capture.rs:849-864), which silently reverts any parked frontmatter edit. Meanwhile human in-app saves are refused while the mode is open (capture.rs:840-842) and agent writes proceed.

**Impact**

The out-of-band bytes are lost with no record. A belief.attested can pin content the human did not review. The circuit breaker stops the human while letting the agent keep writing.

**Recommendation**

In write_projection, refuse (or capture first) when prior ≠ entry.content_hash. Make verify pin the hash of the bytes the UI showed and refuse on mismatch. Gate agent writes to paths with parked mismatches while reconciliation is open.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The mechanism is real.** `manifest::write_projection` hashes the file on disk only to fill `previous_content_hash`. It never checks that hash against the manifest entry, so it renames the projection over whatever bytes are there.
- **No reconciliation check on the agent and verify paths.** `write_concept_with`, `append_log_with` and `verify_with` never call `reconciliation_open()`. The reducer does not gate `belief.revised`/`attested` either (`reconciliation_open` appears in reduce.rs only at its definition). Only the capture paths refuse.
- **Human saves are refused, agent writes proceed.** In-app `save_note` and `update_frontmatter` go through `capture_body_edit`/`capture_frontmatter_patch`, which return `RECONCILIATION_SUSPENDED`. Agent `write_concept` via MCP is not stopped. So the asymmetry is real.
- **Verify does attest content the user may not have seen.** `verify_with` attests the reducer's current revision, then regenerates the file. The attested bytes are the ledger's, not the bytes on disk.
- **Overstatement 1, it's a design choice.** The M23 spec says agent writes stay open during the mode: "Regular agent writes remain available" (docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:364-365). The defect is that nothing guards the parked divergent bytes when those writes land.
- **Overstatement 2, not "lost with no record".** The vault's git autosync commits from Aug 17 still hold those bytes. Only the ledger and manifest have no record of them. Also, the only exit that works, "Restore recorded history", reverts those same bytes on purpose.
- **Overstatement 3, it hasn't happened here.** On the live vault, every event from seq 181 to 273 is a non-knowledge `vault.write` (records/tasks, home, test, types). No `write_concept`, `append_log` or verify landed while the mode was open.
- **Overstatement 4, the frontmatter-revert case is narrow.** `capture_body_edit` does join the saved body with the reducer's fields (`overlaid`), not the file's. But it refuses while the mode is open. A frontmatter edit is only reverted when the mode is closed and a live out-of-band capture already failed quietly (watcher.rs:260 discards the result with `let _`), until the next launch scan. That's real but narrow.
- **Severity: medium.** The mechanism is confirmed, but it is latent here, git keeps a backstop copy, and letting agents write during the mode is in the spec.

**Evidence checked.** - src-tauri/src/ledger/manifest.rs:184-231: `prior` is only compared with `projection.content_hash` (the byte-identical shortcut). The file is replaced with temp+rename and there is no check against the manifest's `content_hash`.
- src-tauri/src/ledger/concepts.rs:68-110, 115-222 (`verify_with`), 325-376 (`write_concept_with`), 800-886 (`append_log_with`): no call to `reconciliation_open`.
- `grep reconciliation_open` finds it only in capture.rs:322/642/779/840/885, reconcile.rs and reduce.rs:842 (the definition).
- src-tauri/src/ledger/capture.rs:840-841 and 885-886: `capture_body_edit`/`capture_frontmatter_patch` return `RECONCILIATION_SUSPENDED`. Lines 848-864 build the body from `overlaid(&state, belief)` fields.
- src-tauri/src/lib.rs:97-129: `save_note`/`update_frontmatter` go to capture and return its error.
- src-tauri/src/lib.rs:931-940 → vault/write.rs:341-356 → `ledger::concepts::verify_concept`.
- src-tauri/src/mcp.rs:2539 → vault/write.rs:609 → `ledger::concepts::write_concept` (no gate).
- src-tauri/src/vault/watcher.rs:260: `let _ = capture_out_of_band(...)`, so a failed capture is swallowed.
- src-tauri/src/ledger/capture.rs:779: out-of-band capture refuses while the mode is open, so edits stay parked.
- Spec docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:363-365: "suspends automatic capture ... Regular agent writes remain available."
- Live ledger (/Users/joseflagorio/Documents/test/.cerebro/ledger/d62256b3040f66f44f65d74c91d2b60c-0000000000000001.ndjsonl.open): all events at seq 181-273 are `vault.write` on non-knowledge paths (records/tasks/kk.md ×46, home/untitled.md ×14, test/bets.list.yml ×13, …). No knowledge belief writes or attestations happened after the seq 180 divergence.

**Correction.** While reconciliation is open, and also after a live out-of-band capture fails quietly, agent `write_concept`, the automatic log append and human Verify all go ahead without checking the file on disk. The file is then replaced with the reducer's projection, so the parked out-of-band bytes are dropped with no ledger or manifest record. Verify attests the reducer's revision, not the bytes the user had on screen. Letting agent writes proceed during the mode is in the M23 spec. The missing piece is a check of disk bytes against the manifest before overwriting.

Three limits on the claim:
- The bytes still exist in the vault's git autosync history.
- This has not happened on the live vault: no knowledge writes since seq 180.
- The `capture_body_edit` frontmatter revert only applies while the mode is closed, because the in-app capture paths refuse while it is open.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** - **Core mechanism confirmed and reachable.** Only the capture paths and the reconcile paths check `reconciliation_open()`. `write_concept`, `append_log` and `verify_concept` in ledger/concepts.rs never check it, and neither do their callers: vault/write.rs, mcp.rs `tool_write_concept` and the lib.rs `verify_concept` command.
- **The disk is overwritten without a check.** `manifest::write_projection` hashes the prior file only to store it as the transient `previous_content_hash`, which is cleared at step 4. It never compares that hash to the manifest entry, so it overwrites whatever is on disk, including the 3 divergent Aug 17 files.
- **Verify attests text the human did not review.** KnowledgePage.tsx renders the disk bytes (the Aug 17 text) through `readNote`, and the Verify button is not gated on reconciliation. `verify_with` pins `belief.attested` to the reducer's current revision (the Aug 16 content) and then regenerates the file, which replaces what the human was looking at. It is reachable with one click on gcs-5-supervision-ratio.md.
- **The circuit breaker is asymmetric.** Human in-app body and frontmatter saves are refused (capture.rs:840, 885), while the agent's `write_concept` over MCP proceeds.
- **Overstated: "lost with no record".** The Aug 17 bytes are in the vault's git autosync commits (five commits 11:51–11:57Z). The loss is only from the ledger and manifest.
- **Wrong detail: the `capture_body_edit` "parked frontmatter" point.** That function checks `reconciliation_open` and refuses first (capture.rs:840-842), so it cannot revert a parked edit while the mode is open. Rebuilding from the reducer's fields only drops an out-of-band frontmatter edit the scan has not yet classified, while the mode is closed. That is a narrower case.
- **Not yet happened in the live vault.** All 93 events after seq 180 are `vault.write` shadow events on non-knowledge paths (records/, types/, home/, work/, test/). There is no `belief.*` event and no knowledge write, so no agent write or Verify has hit the divergent files yet. The risk is latent but live for as long as the mode stays open and a writer is active.

**Evidence checked.** - src-tauri/src/ledger/manifest.rs:183-229: `write_projection` reads the prior hash only to store `previous_content_hash`, with no comparison to the existing manifest entry; it renames the temp file over the target unconditionally.
- src-tauri/src/ledger/concepts.rs:68-110 and 325-379: `write_concept`, `append_log`, `verify_concept` and `write_concept_with` have no `reconciliation_open` check. `grep reconciliation_open` hits only capture.rs:322/642/779/840/885 and reconcile.rs:256/514/912.
- src-tauri/src/ledger/concepts.rs:131-216: `verify_with` attests `current.event_id` and the projected hash of the reducer content, then calls `write_projection`.
- src-tauri/src/vault/write.rs:350 and 609: ledger-first calls with no guard.
- src-tauri/src/mcp.rs:2539: the agent write path.
- src-tauri/src/lib.rs:931-940: `verify_concept` runs `guard_verify` only.
- src/pages/KnowledgePage.tsx:287 (`readNote` shows the disk bytes) and 311-317 (verify has no reconciliation gate).
- src-tauri/src/ledger/capture.rs:840-842: `capture_body_edit` refuses while the mode is open.
- Live ledger, seq 181-273: 93 `vault.write` events, none under `knowledge/`, and no `belief.revised` or `belief.attested`.

**Correction.** While the reconciliation mode is open, agent `write_concept`/`append_log` and human Verify still write, and `write_projection` overwrites the divergent on-disk bytes without comparing them to the manifest. Verify pins the reducer's Aug 16 revision while the UI shows the Aug 17 disk text, and human in-app saves are refused. The overwritten bytes are gone from the ledger and manifest but still exist in vault git autosync history, so "lost with no record" is overstated. The `capture_body_edit` point does not apply to parked edits, because it is refused while the mode is open; it only drops out-of-band frontmatter the scan has not yet seen, and only while the mode is closed. The live vault has had no knowledge write or Verify since the mode opened, so this is latent, not realized.

</details>

### F35 — The live watcher swallows every capture refusal: no divergence, no toast, no log until the next launch

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/vault/watcher.rs:260`
  - `src-tauri/src/ledger/capture.rs:767`

**Evidence**

`let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);` (watcher.rs:260). Forgery, alias removal, ambiguous extracted text, unknown path and RECONCILIATION_SUSPENDED all vanish. Escalation happens only in launch_scan at the next activation, so the edit sits on disk unrecorded, and the overwrite window in the previous finding stays open.

**Impact**

The user gets no signal that an edit was not recorded. The same refusal becomes a scary divergence banner hours or days later, disconnected from its cause.

**Recommendation**

On a typed refusal, record the operational row and trigger the same divergence recording the launch scan uses (or at least emit an event the ReconciliationBanner listens to).

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Code is real and reachable. The watcher's debounce loop collects every `knowledge/*.md` path, then on flush runs `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`. That discards both the `Option` (no writer) and the `Result` (refusal).
- `capture_out_of_band_with` returns `Err` for five cases, each one dropped by the watcher: a non-knowledge path, unparsable OKF, RECONCILIATION_SUSPENDED when the mode is open, forgery, and alias removal or ambiguity (the last two come from `diff_projection_file`). No eprintln, no runtime.db sink call and no emitted event on this path.
- Escalation into divergence exists only in `reconcile::launch_scan`. Its one production caller is `shadow::activate` (shadow.rs:144). `activate` is called only from the `start_watcher` IPC (lib.rs:1478), which runs on `openVault`.
- The `vault-changed` handler (vaultStore.ts:126) only calls `rescan()`, which does not re-activate the ledger. So a live refusal waits until the next vault open or launch. `ledger_status` is documented as read-only.
- The code comment (watcher.rs:255-258) says quiet failure is deliberate: best-effort, and the next event or the launch scan retries. That covers transient half-saved files. It does not cover deterministic refusals like forgery, which fail the same way on every retry.
- Small overstatements:
  - RECONCILIATION_SUSPENDED is already shown by the open banner, so swallowing that one is mostly harmless.
  - "Hours or days later" is the worst case, not what happened here. The Aug 17 edits (11:51–11:57Z) were escalated at 11:58:54Z, within minutes, by a scan at re-activation.
- The core claim holds: the live path gives no signal and leaves the edit unrecorded until re-activation.

**Evidence checked.** - src-tauri/src/vault/watcher.rs:238-246: collects knowledge/*.md into knowledge_pending.
- src-tauri/src/vault/watcher.rs:255-261: comment "errors quietly and the next event (or the launch scan) retries", then `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`.
- src-tauri/src/ledger/capture.rs:171-173: capture_out_of_band returns Option<Result<(),String>>.
- src-tauri/src/ledger/capture.rs:767-788: returns Err for a non-knowledge path, a parse_okf failure, RECONCILIATION_SUSPENDED, and diff_projection_file refusals. The doc comment says "the caller escalates those into reconciliation"; the watcher caller does not.
- src-tauri/src/ledger/shadow.rs:144: the only production call to launch_scan, inside activate().
- src-tauri/src/lib.rs:1478: activate is called only from the start_watcher command.
- src/stores/vaultStore.ts:126-131: the vault-changed listener only calls rescan().
- src-tauri/src/ledger/shadow.rs:294-305: with_writer adds no logging.

</details>

### F36 — Neither exit is safe for edits made after the mode opened, and the open mode itself makes 'Keep my files' less and less likely to work

- **Severity (claimed):** medium
- **Category:** recovery-ux
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:277`
  - `src-tauri/src/ledger/reconcile.rs:286`
  - `src-tauri/src/ledger/reconcile.rs:436`
  - `src-tauri/src/ledger/reconcile.rs:471`
  - `src-tauri/src/ledger/reconcile.rs:594`
  - `src-tauri/src/ledger/reconcile.rs:239`

**Evidence**

Restore regenerates every projection and `remove_file`s every knowledge .md the reducer cannot explain (reconcile.rs:456-475). Its resolution records affected_paths = ALL projection paths with no before-hashes (436, 503), so the ledger cannot say what was discarded. The scan walks hidden and sync-duplicate files too (239-253): iCloud 'foo 2.md' or Syncthing conflict copies under ~/Documents become 'unknown to both' divergence and are then deleted. While the mode is open, the scan skips the safe InterruptedWrite, LedgerAhead and InterruptedFinalize repairs (277, 286) but still reports them as regenerated/finalized. Accept later diffs such a path's OLD bytes against the newer reducer state (594-600), which records a human:owner reversal of the ledger's own commit. Because write_concept restamps `generated`, that reversal also trips forgery. Any single new file, missing file or alias removal refuses the whole accept.

**Impact**

The longer the banner is ignored (39 days here), the more certain it becomes that only the destructive exit works, and it destroys edits and conflict copies without a trace.

**Recommendation**

Before restore, snapshot the discarded bytes (e.g. to .cerebro/restore-<event>/) and record the per-path before-hashes in the resolution. Keep executing the safe ledger-ahead repairs while open, or exclude those paths from accept's diff set. Let accept adopt a subset and keep the rest parked.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - **Code claims hold up:**
  - Restore regenerates every projection and calls `remove_file` on every knowledge .md the reducer cannot explain.
  - Its resolution records `affected_paths` as every projection key. The removed files are not listed, and there are no before-hashes.
  - The scan's walkdir has no filter for hidden files or sync duplicates, so a stray `foo 2.md` would classify as "unknown to both". That is a divergence, and restore would then delete the file.
  - While the mode is open, the scan skips the InterruptedFinalize, InterruptedWrite and LedgerAhead repairs (`if !already_open`), but still adds those paths to `finalized`/`regenerated`. The misreport is small: those vectors are only read by tests.
  - Accept refuses the whole action if any single path is missing, forged, has an alias removed or is unknown.
- **"Neither exit is safe" is overstated:**
  - Accept is fail-closed. It either adopts the edits through the capture valve or refuses outright, and it never destroys anything.
  - Only restore destroys data.
  - The claimed "human:owner reversal" of the ledger's own commit is never actually recorded. The claim admits the reversal also trips forgery: `write_concept` restamps `generated`, and `diff_projection_file` refuses any change to `generated`/`verified`. So a crash-interrupted write during open mode makes accept refuse. It does not make it write a false event.
- **"Less and less likely over time" is not shown by the live data:**
  - For the premise to fire, a write has to be crash-interrupted during open mode, or new out-of-band or conflict files have to appear.
  - In the live vault, all 93 events after the divergence (seq 181–273) are `vault.write`, with no knowledge writes.
  - Today exactly 3 files differ from the manifest (the original 3). There are no stray, hidden or conflict-copy .md files. No drift has built up in 39 days.
  - Accept was already certain to fail on day 0, because of the forgery refusal on those 3 files. Time has not changed that.
- **"Without a trace" is overstated:** the ledger does not record what restore discarded. But the vault has git autosync (the Aug 17 edits exist as commits), so overwritten or deleted content that autosync committed can be recovered from vault git.
- **What survives:** restore is an unrecorded destructive action. It can delete any unexplained .md, including sync-conflict copies, and edits made while the mode is open are exposed to it. Treat that as a design hazard, not an observed or escalating harm.

**Evidence checked.** - `src-tauri/src/ledger/reconcile.rs:239-253`: the scan walkdir only checks for the `.md` extension, with no hidden or duplicate filter.
- `reconcile.rs:74-77`: the (None, None) case → Divergence "unknown to both".
- `reconcile.rs:276-293`: `if !already_open` guards the repair, but the path is pushed to `finalized`/`regenerated` regardless.
- `reconcile.rs:1298`, `1498`, `1516`: the only readers of `regenerated` are tests.
- `reconcile.rs:436`: `affected` = `state.projection_paths.keys()`.
- `reconcile.rs:456-475`: `remove_file` for any .md not in `projection_paths`.
- `reconcile.rs:497-506`: the `ReconciliationResolved` body. `schema/reconciliation.rs:156` has `affected_paths` and no before-hash field.
- `reconcile.rs:571-578`: accept errors on any missing file.
- `reconcile.rs:594-600`: any failure from `diff_projection_file` aborts the whole accept.
- `capture.rs` (in `diff_projection_file`): a changed `generated`/`verified` → "provenance forgery" Err; alias removal → Err; a path that is not a projection → Err.
- Live vault check (python sha256 vs `.cerebro/projection-manifest.json`): only `decisions/gcs-5-supervision-ratio.md`, `risks/tx-6-changeover-transient-cross-channel-sync-disabled.md` and `risks/tx-6-np-shared-j12-common-mode.md` are DIFF. There are no NO-ENTRY or MISSING paths, and no conflict copies under `knowledge/`.
- Events 181–273 in the ledger .open file are all `vault.write` (93).

**Correction.** - **Holds:** "Restore ledger authority" is destructive and records nothing about what it discards. It overwrites every projection and deletes every unexplained knowledge .md, including hidden files and sync-conflict copies the scan picks up. Its resolution lists only reducer paths, with no before-hashes, so what it discarded has to be recovered from vault git autosync, not the ledger.
- **Wrong:** "Keep my files" is not unsafe. It fails closed, refusing the whole action on any missing, forged or alias-removing file, and it never records a reversal.
- **Wrong:** the idea that it gets less likely to work over time. Here it was already blocked from day 0 by the forgery refusal on the 3 agent-edited files, and there has been no additional drift since seq 180. The skipped-repair misreport only reaches test-visible outcome vectors.

</details>

### F37 — The divergence record describes a stale ledger state, and its detection key changes with unrelated manifest churn

- **Severity (claimed):** low
- **Category:** data-quality
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:222`
  - `src-tauri/src/ledger/reconcile.rs:350`
  - `src-tauri/src/ledger/reconcile.rs:362`
  - `src-tauri/src/ledger/reconcile.rs:388`
  - `src-tauri/src/ledger/reconcile.rs:397`

**Evidence**

`ledger_head`, `reducer_projection_digest` and the detection key are computed from the read at the start of the scan (222-223, 350), yet the capture loop appends events before the divergence is written. Live: seq 180 body.ledger_head = 619957fc (seq 178's hash), but its `prev` = fc98dc81 (seq 179, the scan's own capture). The key also hashes the raw manifest file bytes (346-349, 362-367), and recording is not gated on `already_open` (397). A Divergence-class path that persists therefore records a NEW ledger.divergence on every launch after any agent write changed the manifest, and the banner's '(N unresolved)' grows.

**Impact**

The epistemic record states a head and digest the ledger had already moved past, and duplicate divergence events can pile up on one unresolved condition.

**Recommendation**

Re-read the ledger and reduce after the capture loop, before building the body and key. Key the condition on signals plus the sorted (path, file-hash, manifest-hash) tuples, not whole-file digests. While a mode is open, add to the open condition instead of minting new events.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - Stale snapshot is real. `read`/`state` come from one read at scan start (L222-223). The capture loop then appends events (L319-326). The divergence body still uses `ledger_head: read.head_hash` and `reducer_digest` from that old `state` (L350, L388).
- Live ledger proves it. seq 180's `ledger_head` is 619957fc (seq 178). Its `prev` is fc98dc81 (seq 179, the scan's own log.md capture).
- Mixed snapshot, beyond the claim. `manifest_digest` is re-read from disk AFTER capture (L346-349), so the record pairs a post-capture manifest digest with a pre-capture reducer digest.
- Churn-sensitive key is real. The detection key hashes the raw manifest file bytes (L346-367). Dedup (`already_recorded`) is a lookup on that key only (L368-370). Recording is not gated on `already_open` (L397).
- It is reachable. shadow.rs:144 runs launch_scan on every writer activation. Agent writes keep going while the mode is open: the capture.rs guards block only automatic capture, and the comment at L320 says "agent writes continue". The banner counts `status.divergences.length` (ReconciliationBanner.tsx:46).
- Correction on scope: it did NOT happen in the live vault. There is exactly 1 `ledger.divergence`, even though ~93 events came after seq 180. The 3 live paths are OutOfBandEdit, and they only escalate through capture, which is skipped once `already_open` (L319). So a relaunch while open yields no signal. Duplicates need a persistent `classify_path` Divergence class, a mass signature or a migration signal. The claim is scoped that way, so it stands as a latent defect. Low is right.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:222-223: `read` and `state` are taken once, at scan start.
- reconcile.rs:319-326: `capture_out_of_band_with` appends events before the divergence is written.
- reconcile.rs:346-349: `manifest_digest` is re-read from disk after capture.
- reconcile.rs:350: `reducer_projection_digest(&state)` uses the stale state.
- reconcile.rs:362-367: the detection key covers signals, samples, manifest_digest and reducer_digest.
- reconcile.rs:368-370: `already_recorded` is a key lookup only.
- reconcile.rs:388: `ledger_head: read.head_hash.clone()`.
- reconcile.rs:397: `if !already_recorded` is the only gate; it does not check `already_open`.
- ledger/shadow.rs:144: launch_scan runs on activation.
- ledger/capture.rs:320-323: only capture is suspended while open ("agent writes continue").
- ReconciliationBanner.tsx:46: count = `status.divergences.length`.
- Live ledger (d62256b3…-0000000000000001.ndjsonl.open):
  - seq 180 has `ledger_head` = 619957fc… and `prev` = fc98dc81… (seq 179's hash).
  - `grep -c ledger.divergence` = 1, so no duplicates occurred in this incident.

</details>

### F38 — relation_diff guesses when two concepts share a filename stem

- **Severity (claimed):** low
- **Category:** invariant-violation
- **Verification:** survived (confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:1057`
  - `src-tauri/src/ledger/concepts.rs:272`
  - `src-tauri/src/ledger/migrate.rs:403`

**Evidence**

`stems: BTreeMap<stem, belief>` is built with `.collect()` over projection_paths (capture.rs:1057-1061), so with `risks/foo.md` and `systems/foo.md` the last path wins. `supersedes: [[foo]]` then records a human_assertion relation_change and a belief.relation to whichever belief sorts last. The same last-wins map exists in concepts.rs:272-276 and migrate.rs:403-406. `[[x|label]]` never resolves, so the field changes with no relation event.

**Impact**

The live relation graph can point at the wrong belief, recorded as trusted human capture, which contradicts 'never guess'.

**Recommendation**

Detect stem collisions and refuse as ambiguous (escalate), or resolve by full bundle path; strip `|alias` before lookup.

<details><summary>Verifier 1: confirmed (severity → low)</summary>

**Reasoning.** - Real and reachable. `relation_diff` builds a stem→belief map with `.collect()` into a BTreeMap, so when two stems collide the last one inserted wins. `projection_paths` iterates in sorted order, so the path that sorts last lexicographically wins.
- It is called from `diff_projection_file` (capture.rs:1010), which is the out-of-band capture path. Its edits become `human_assertion` RelationChange events (capture.rs:445-462), so a wrong target would be recorded as trusted human capture.
- The same pattern appears in concepts.rs:272-276 (`intended_relations`) and migrate.rs:403-406. The concepts.rs doc comment says unresolvable links are "skipped, never guessed", but it has no ambiguity check. Migrate records `unresolved_relations` only when there is no match, never when a stem is ambiguous.
- Nothing prevents a stem collision. `tool_write_concept` (mcp.rs:2451-2454) only checks that the path is inside knowledge/. A grep of the ledger and knowledge.rs finds no ambiguous-stem guard; the only "never a guess" refusal covers extracted-text overlap (capture.rs:1031).
- The label claim is correct. `wikilinks` strips only `[[` and `]]`, so `[[x|label]]` becomes `x|label`, which matches no stem, and no relation event is recorded. In capture this drop is silent.
- Why low severity: the defect is latent. Neither the live vault nor demo-vault has a duplicate knowledge basename today, and it has nothing to do with the current divergence incident.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:1057-1061: `let stems: BTreeMap<String,String> = state.projection_paths.iter().map(|(path, belief)| (stem_of(path).to_string(), belief.clone())).collect();` — later entries overwrite earlier ones.
- capture.rs:1010: called from `diff_projection_file`.
- capture.rs:445-462: `human_assertion(... HumanAssertionForm::RelationChange{...})`.
- src-tauri/src/ledger/concepts.rs:264-276: the same map, under a doc comment that says "skipped, never guessed".
- src-tauri/src/ledger/migrate.rs:402-419: the same map over `concepts`; `None` goes to `unresolved_relations`, and there is no ambiguity branch.
- migrate.rs:634-654: `wikilinks` strips only `[[`/`]]`, so `x|label` is kept as-is; `stem_of` takes the basename minus `.md`.
- mcp.rs:2451-2454: `write_concept` checks only `is_knowledge_path`, so there is no stem-uniqueness guard.
- `find ... | xargs basename | sort | uniq -d` on demo-vault/knowledge and /Users/joseflagorio/Documents/test/knowledge returned nothing, so no collision exists today.

</details>
