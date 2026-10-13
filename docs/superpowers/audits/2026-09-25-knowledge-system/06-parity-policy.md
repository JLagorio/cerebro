# TS↔Rust parity & policy-as-data

> Audit lens `parity-policy` · first-pass auditor, each finding adversarially verified

## Summary

Lens: TS<->Rust parity and policy-as-data. The reducer's parity with Rust is real: the event kinds match 1:1 and the reconciliation fold replays identically. But everything that actually produced this banner sits outside the conformance/goldens mechanism, and none of it is shared policy data: the generated/verified forgery rule, the capture classifier, the launch-scan escalation and both exits. The browser mock copies some of those rules by hand, and the copies have already drifted. It can't represent reconciliation at all, so the banner, its buttons and the RECONCILIATION_SUSPENDED refusal have never run under any test. Separately, the legacy write_concept/verify fallback plus the forgery rule make the divergence certain rather than just possible, and the knowledge-path guard can be bypassed with a non-canonical path.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F46 | high | yes | Legacy file-first fallback always ends in divergence; the comment saying the scan 'reconciles once a writer returns' is false |
| F47 | high | yes | Knowledge-path guard is a raw prefix check (twinned in TS); './knowledge/…' and 'Knowledge/…' get past guard_agent_write |
| F48 | high | yes | Provenance-forgery and alias-removal rules are hand-written in both Rust and mockIpc, and the copies already disagree |
| F49 | high | yes | The reconciliation surface cannot be reached or tested outside Tauri |
| F50 | medium | yes | The mock capture valve is missing most of Rust's refusals, including the one blocking the user now |
| F51 | medium | yes | Capture and reconciliation refusals have no code and no declared destiny; the forgery reason is recorded nowhere |
| F52 | medium | yes | Conformance vectors cover only the reducer fold, not the capture classifier, the classify_path table or the reconciliation exits |
| F53 | medium | yes | The 3.3k-line TS reducer has no runtime consumer, contradicting the conformance README |
| F54 | low | yes | The mass-mismatch circuit-breaker thresholds are hard-coded in Rust, not policy data |

### F46 — Legacy file-first fallback always ends in divergence; the comment saying the scan 'reconciles once a writer returns' is false

- **Severity (claimed):** high
- **Category:** invariant-violation
- **Verification:** survived (confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/src/vault/write.rs:607-626`
  - `src-tauri/src/vault/write.rs:342-357`
  - `src-tauri/src/vault/write.rs:692-718`
  - `src-tauri/src/ledger/capture.rs:961-967`
  - `src-tauri/src/ledger/reconcile.rs:77`
  - `src-tauri/src/ledger/reconcile.rs:472`
  - `src-tauri/src/ledger/reconcile.rs:600`
  - `src-tauri/src/ledger/shadow.rs:113-121`
  - `src-tauri/src/ledger/shadow.rs:294-300`
  - `src-tauri/src/ledger/reconcile.rs:1639-1662`

**Evidence**

write_concept, verify_frontmatter and append_knowledge_log fall back to writing the file directly when shadow::with_writer returns None. That happens when the lock is held by a second instance (shadow.rs:118 `LedgerWriter::open(..).ok()`), when the path is not the active vault (shadow.rs:297), or when the lock is poisoned. The comment at write.rs:612-615 says the M23.6 scan 'reconciles once a writer returns'. It cannot. A legacy REVISION re-stamps `generated.at` (mcp.rs:2501), and diff_projection_file hard-refuses any change to generated/verified as 'provenance forgery' (capture.rs:963). A legacy CREATE is classified 'path is unknown to both manifest and reducer' (reconcile.rs:77). Either way the scan escalates to divergence, 'Keep my files' refuses on the same diff (reconcile.rs:600), and 'Restore recorded history' deletes the unexplained files (reconcile.rs:472). The fallback's own shadow_write also no-ops, because shadow::record needs the same active writer. The only forgery test (reconcile.rs:1639) covers a human adding `verified`; nothing tests a server-stamped legacy write followed by a scan.

**Impact**

This is the exact mechanism behind the user's banner. Aug 17: 3 concept files written with generated.by=claude-code and zero ledger events, then a forgery refusal, then reconciliation open for 39 days. Any future write_concept or verify made while a second app instance holds the lock repeats it. The user's only working exit throws away the agent's work.

**Recommendation**

Fail closed. When a vault has a ledger store but no active writer, refuse write_concept/verify/append_log with a typed operational code instead of writing the file. If a legacy path must stay, have it write a provenance record that the scan can match, so a server-stamped write is not classified as forgery. Delete the false comment.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** - **Mechanism is real, end to end.** `write_concept`, `verify_frontmatter` and `append_knowledge_log` all fall back to writing the file directly when `shadow::with_writer` returns None.
- **When the writer is None.** `with_writer` returns None when:
  - the lock is poisoned (`.lock().ok()?`)
  - no vault is active
  - the vault path differs from the active one
  - there is no writer. That covers a refused startup verdict, and a second instance that failed `LedgerWriter::open(..).ok()`.
- **The fallback leaves no ledger trace.** Its `shadow_write` goes through `shadow::record`, which needs the same active writer, so it silently no-ops.
- **A legacy revision can never be captured.** `mcp.rs` re-stamps `generated: {by, at: now_iso()}` on every write, so `generated` always differs from the reducer's version. `diff_projection_file` hard-refuses any `generated`/`verified` change as "provenance forgery". A legacy verify adds `verified`, which hits the same refusal.
- **A legacy create is divergent immediately.** `classify_path` (None, None) returns Divergence("path is unknown to both manifest and reducer") before capture is even tried.
- **The scan cannot fix either case.** In `launch_scan`, a failed capture is pushed to `divergent`, which raises ManifestReducerDisagreement and appends `ledger.divergence`.
- **"Keep my files" fails on the same files.** `resolve_accept_with` calls `diff_projection_file` on every non-Match path, and one error refuses the whole action.
- **"Restore recorded history" discards the work.** `resolve_restore_with` regenerates from reducer state and deletes any knowledge `.md` the reducer does not know.
- **So the comment is false.** The write.rs comment says "the M23.6 scan reconciles once a writer returns". For these writes it cannot: the scan escalates instead.
- **No test covers this path.** The only forgery test hand-injects `verified` and runs only the accept exit. No test does a server-stamped legacy write followed by a scan.
- **The incident data matches this path.** The live file has `generated: {by: claude-code, at: 2026-08-17T11:52:02Z}`. That matches `now_iso()`'s format exactly (`%Y-%m-%dT%H:%M:%SZ`, no fractional seconds), so it was written through MCP's `write_concept`, not free-form. The vault git commits (04:51–04:52 -07:00) all carry one unchanged `Cerebro-Ledger-Head`, meaning zero events were recorded. The log lines use the `insert_log_entry` "* **Update**" format.
- **One caveat, which does not change the verdict.** The data cannot tell which None cause fired on Aug 17 (second instance / lock, path mismatch, or refused verdict). "The exact mechanism" is highly likely but inferred from the stamp format and the zero events, not proven.

**Evidence checked.** - **src-tauri/src/vault/write.rs**
  - L607-626: `write_concept` falls back to `concept_write` plus `shadow_write` when `ledger::concepts::write_concept` returns None. The comment at L612-615 claims "the M23.6 scan reconciles once a writer returns".
  - L342-357: `verify_frontmatter`, same fallback.
  - L692-718: `append_knowledge_log`, same fallback.
  - L263-272: `shadow_write` just calls `shadow::record`.
- **src-tauri/src/ledger/concepts.rs:68-107**: all three return `shadow::with_writer(...)`, so they are None without an active writer.
- **src-tauri/src/ledger/shadow.rs**
  - L113-121: `LedgerWriter::open(&vault,&id).ok()`, with a comment saying a held lock lands in None.
  - L294-300: `with_writer` returns None on a poisoned lock, no active vault, a vault mismatch, or no writer.
  - L311-322: `record` has the same guards, so it silently no-ops.
- **src-tauri/src/mcp.rs**
  - ~L2501: `frontmatter.insert("generated", json!({by: actor, at: now_iso()}))` on every write.
  - L2567: `now_iso` uses the format `%Y-%m-%dT%H:%M:%SZ`.
- **src-tauri/src/ledger/capture.rs:961-967**: `if key == "generated" || key == "verified" { return Err("provenance forgery ...") }`.
- **src-tauri/src/ledger/reconcile.rs**
  - L74-77: (None, None) returns Divergence("path is unknown to both manifest and reducer").
  - ~L318-330 (launch_scan): a capture Err is pushed to `divergent`.
  - ~L336: `divergent` raises ManifestReducerDisagreement.
  - ~L455-472 (restore): removes knowledge `.md` files the reducer does not know.
  - ~L597-600 (accept): `diff_projection_file(...).map_err(...)?` refuses the whole action.
  - L1639-1662: the only forgery test injects `verified` by hand and tests accept only.
- **Live vault /Users/joseflagorio/Documents/test**
  - `knowledge/decisions/gcs-5-supervision-ratio.md` has `generated: {by: claude-code, at: 2026-08-17T11:52:02Z}`, which matches `now_iso`'s format.
  - `git log` shows commits 812605a and 1c8c9e97 (2026-08-17 04:51/04:52 -07:00). The trailer carries the same `Cerebro-Ledger-Head: 619957fc...`.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** I tried to refute this through reachability and could not.

- **The fallback is reachable.** concepts::write_concept, verify_concept and append_log return None whenever shadow::with_writer finds no active writer. That happens with no active slot, a different vault path, a poisoned lock, or a writer that failed to open. In the second-instance case, LedgerWriter::open(..).ok() comes back None, and the code comment at shadow.rs:116-118 says exactly this. shadow::record needs the same writer, so the fallback's own shadow_write silently no-ops. Result: zero ledger events.
- **Why revisions and creates diverge:**
  - The MCP layer always stamps generated {by: actor, at: now_iso()} (mcp.rs:2501), so a legacy revision always differs in `generated`.
  - diff_projection_file hard-errors on any generated/verified change (capture.rs:961-967).
  - launch_scan turns a capture Err into a divergent entry (reconcile.rs ~L320: `Err(reason) => outcome.divergent.push`), which raises ManifestReducerDisagreement.
  - A legacy create hits classify_path (None, None) → Divergence (reconcile.rs:75-78).
  - resolve_accept calls the same diff_projection_file (reconcile.rs:600), so it refuses as well.
  - restore deletes knowledge .md files that are not in projection_paths (reconcile.rs:472).
- **The live data matches the MCP legacy path specifically, not an agent hand-editing files:**
  - log.md's Aug 17 bullets are byte-for-byte the insert_log_entry format (`* **Update**: [title](/risks/...md).`), with duplicates from repeated calls.
  - The concept frontmatter keys appear in mcp.rs insertion order (type, title, description, about, tags, lifecycle, generated, sources, stale_after).
  - generated.by = claude-code, which is mcp.rs DEFAULT_ACTOR.
  - The ledger recorded zero events.
  - The most likely writer-less process is a second Cerebro instance (dev or installed) whose MCP served this vault while the other instance held the lock. I cannot prove that from the data, but some writer-absent condition must have held.
- **The overstatement:** the log.md legacy append did reconcile (seq 179 projection.overridden, origin out_of_band), because the log has no provenance stamp. So "always ends in divergence" is too strong for append_knowledge_log.
- **Test coverage:** the only forgery test (reconcile.rs:1639) hand-injects `verified`. No test covers a server-stamped legacy write_concept followed by launch_scan.

Severity stays high. The comment is false for the concept and verify paths, the failure mode is silent, and the only exit discards work.

**Evidence checked.** - src-tauri/src/vault/write.rs:607-626 (write_concept falls back when concepts::write_concept returns None; the comment says the "M23.6 scan reconciles once a writer returns"); :342-357 (verify_frontmatter fallback); :692-718 (append_knowledge_log fallback); :263-272 (shadow_write → shadow::record).
- src-tauri/src/ledger/concepts.rs:68-107: all three return None via shadow::with_writer when there is no writer.
- src-tauri/src/ledger/shadow.rs:113-121: `LedgerWriter::open(&vault,&id).ok()`, with the comment "A held lock (second instance) lands in the None arm"; :294-300 (with_writer returns None on lock error, no slot, or vault mismatch); :311-323 (record silently returns in the same cases).
- src-tauri/src/mcp.rs:42 `DEFAULT_ACTOR = "claude-code"`; :2501 stamps generated {by, at: now_iso()} on every write_concept.
- src-tauri/src/ledger/capture.rs:961-967: "provenance forgery: the {key} stamp changed out of band — refused".
- src-tauri/src/ledger/reconcile.rs:75-78 (None,None → Divergence "path is unknown to both manifest and reducer"); launch_scan (~L294-330: OutOfBandEdit → capture_out_of_band_with, Err → divergent → ManifestReducerDisagreement); :472 (restore deletes .md files outside projection_paths); :600 (accept refuses on the same diff); :1639-1662 (only forgery test, which hand-injects `verified`).
- Live vault /Users/joseflagorio/Documents/test:
  - knowledge/decisions/gcs-5-supervision-ratio.md has generated {by: claude-code, at: 2026-08-17T11:52:02Z}, with keys in MCP insertion order.
  - knowledge/log.md lines 3-9 are duplicate `* **Update**: [..](/risks/..md).` bullets in the exact knowledge.rs:287 insert_log_entry format.
  - The log.md edit was captured at ledger seq 179 (projection.overridden), which refutes "always" for the log path.

**Correction.** For concept writes and verifies, the claim holds and the path is reachable in the real app. It is overstated in one place: the legacy knowledge/log.md append DOES reconcile. It carries no generated/verified stamp, so the scan captures it as an out-of-band override. The live ledger shows exactly this at seq 179 (projection.overridden for log.md). The comment at write.rs:612-615 is therefore false for write_concept (both revision and create) and for verify_frontmatter, but true for append_knowledge_log. Every legacy write_concept revision re-stamps generated.at, and every legacy verify changes `verified`. So those writes cannot reconcile. The scan's capture refuses them, and so does "Keep my files". Only "Restore recorded history" clears the mode, and it throws the agent's work away (it reverts revisions and deletes legacy-created files).

</details>

### F47 — Knowledge-path guard is a raw prefix check (twinned in TS); './knowledge/…' and 'Knowledge/…' get past guard_agent_write

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/knowledge.rs:30-32`
  - `src/engine/okf.ts:30-32`
  - `src-tauri/src/vault/write.rs:167-171`
  - `src-tauri/src/mcp.rs:159`
  - `src-tauri/src/mcp.rs:2397`
  - `src-tauri/src/mcp.rs:2421`
  - `src-tauri/src/mcp.rs:2434`
  - `src-tauri/src/lib.rs:102`
  - `src-tauri/src/lib.rs:121`

**Evidence**

is_knowledge_path is `path == "knowledge" || path.starts_with("knowledge/")`, and okf.ts:30 is a byte-for-byte twin. safe_join accepts Component::CurDir. scope_admits (mcp.rs:159) strips './' before its check, but guard_agent_write in tool_create_note, tool_update_frontmatter and tool_append does not. So update_frontmatter{path:'./knowledge/x.md', patch:{verified:…}} passes the guard, and vault::write::update_frontmatter joins it into knowledge/x.md. A case variant like 'Knowledge/x.md' behaves the same on case-insensitive APFS (the macOS default). The human IPC branches (lib.rs:102/121) use the same predicate. This is from reading the code; I did not run it.

**Impact**

An agent can self-certify (write `verified`) or rewrite concepts entirely outside write_concept and the ledger. The next launch then classifies the file as forgery, opens reconciliation, and the user sees another banner. The mock refuses these paths only because the Map key misses, so dev and e2e cannot reproduce it.

**Recommendation**

Canonicalize once (lexically normalize, and compare case-insensitively on the resolved path, or compare the canonical target against the canonical knowledge/ dir) inside safe_join or a shared predicate that every guard uses. Add Rust tests for './knowledge', 'Knowledge' and 'knowledge/../knowledge'.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The mechanism is real.** I read the code end to end and the bypass works as described.
  - `is_knowledge_path` is a plain string-prefix check, and `guard_agent_write` calls it on the path exactly as the agent sent it.
  - `tool_create_note`, `tool_update_frontmatter` and `tool_append` never normalize the path before that check.
  - `safe_join` accepts `.` path parts (`Component::CurDir`), so `./knowledge/x.md` resolves to `knowledge/x.md` on disk.
  - `scope_admits` strips `./`, but it only runs when the run has a scope. That is the scope check, not the knowledge guard.
  - This Mac's root volume is APFS, not "Case-sensitive APFS", so `Knowledge/x.md` also reaches `knowledge/`.
  - The governed-type refusals only look at `type:`/Agent. They do not stop a `verified` patch.
  - No test in `src-tauri/src` or `src/` uses `./knowledge` or `Knowledge/` spellings.
- **The impact is overstated, so medium rather than high.**
  - A bigger door is already open. Non-internal runs (the Assistant panel and scheduled Agent records) start with `--permission-mode acceptEdits`. The code's own comment says this "auto-approves built-in writes".
  - With `shell: true`, the grant adds `Write` and `Edit` outright.
  - So a user-started agent can already write `knowledge/` directly with the CLI's own Write/Edit tools. It never has to touch `guard_agent_write`.
  - The prefix hole only matters for internal runs, which have Write/Edit disallowed, or for a model that picks an odd path spelling on purpose, for example after a prompt injection.
  - It is almost certainly not how the Aug 17 incident happened. That run looks like a direct CLI Edit/Write, given the acceptEdits door.
- **Other points.**
  - The human IPC branches (`lib.rs` ~L102/121) do use the same predicate. Only the UI calls them, so exposure there is low.
  - The TS twin in `okf.ts` is real. It is a duplicated path predicate, not a policy-table rule, so calling it the "policy is data" defect overstates it.
  - The mock has no MCP agent tools, so saying dev and e2e "cannot reproduce it" is true but beside the point.

**Evidence checked.** - `src-tauri/src/knowledge.rs:30-32` is `path == KNOWLEDGE_DIR || path.starts_with("knowledge/")`. `knowledge.rs:215-220` has `guard_agent_write` calling `is_knowledge_path(path)` on the raw path.
- `src/engine/okf.ts:30-32` is the same predicate in TS.
- `src-tauri/src/vault/write.rs:167-171`: `safe_join` accepts `Component::Normal | Component::CurDir`. `write.rs:327-336`: `update_frontmatter` writes `safe_join(vault, rel)` directly.
- `src-tauri/src/mcp.rs:155-164`: `scope_admits` is the only place that does `trim_start_matches("./")`, and it only applies when a scope exists (`mcp.rs:1335`).
- `mcp.rs:2397`, `2421`, `2434`: `guard_agent_write` is called on raw `folder`/`path`. `mcp.rs:1233`: `arg_str` does no normalization.
- `diskutil info /` reports "File System Personality: APFS", which is case-insensitive.
- `src-tauri/src/agent/mod.rs:657-674`: non-internal runs get `--permission-mode acceptEdits`, with the comment "acceptEdits auto-approves built-in writes".
- `agent/mod.rs:580-585`: `shell: true` grants `Write` and `Edit`.
- `agent/mod.rs:628-636`: only internal runs are given `INTERNAL_DISALLOWED` (which includes Write and Edit).
- grep for `./knowledge` and `Knowledge/` in `src-tauri/src`, `src/lib` and `src/engine` returned no tests.

**Correction.** The bypass works as claimed: `guard_agent_write` checks the raw path with a string prefix, so `./knowledge/...` (and `Knowledge/...` on case-insensitive APFS) gets past it in create_note, update_frontmatter and append_to_note, and `safe_join` resolves the path into `knowledge/`. Its real impact is smaller than claimed. User-started agent runs already get `acceptEdits`, and `Write`/`Edit` too when shell is on, so they can write `knowledge/` directly without going near this guard. The hole only adds reach for internal runs, or for a deliberate or prompt-injected odd path spelling. It is not the likely cause of the Aug 17 divergence. The fix is still worth doing: normalize the path (strip `./` and empty parts, compare case-insensitively) inside `is_knowledge_path`, or once before the guards run. Severity: medium.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **The code defect is real.** `is_knowledge_path` is a raw `starts_with("knowledge/")` check. `guard_agent_write` uses it and nothing normalizes the path first:
  - `call_tool` only normalizes inside `scope_admits`.
  - `tool_update_frontmatter`, `tool_append` and `tool_create_note` pass the raw string.
  - `safe_join` accepts `CurDir`.
  - So `./knowledge/x.md` gets past the guard and is written to `knowledge/x.md`. The same goes for `Knowledge/…` on case-insensitive APFS.
- **Reachability is weaker than claimed:**
  1. **Not the tightest door.** User-authored (non-internal) runs are spawned with `--permission-mode acceptEdits`, and only internal runs get `INTERNAL_DISALLOWED` (Write/Edit/Bash…). Shell-enabled runs are granted Write/Edit outright. Such an agent can edit `knowledge/x.md` directly with the CLI's own Edit tool, so bypassing the ledger doesn't need the `./` trick. The prefix gap only adds reach for internal runs, which are cerebro's own code paths using `write_concept`.
  2. **The model has to go off-script.** It must send a non-canonical path. Tool docs and the refusal text both point it to `write_concept`, and scanner-provided paths are always canonical.
  3. **The human IPC branches (lib.rs:102/121) can't be reached from the UI.** The UI passes scanner `entry.path`, which is already normalized. Reaching them takes a hand-crafted IPC call from the app's own webview.
  4. **Not the live incident's cause.** The Aug 17 files carry `generated: {by: claude-code, at: …}` plus `sources`/`description`. That is exactly what `write_concept` stamps, not what a `./`-prefixed `update_frontmatter` would produce.
- **Impact claim holds in part.** A `verified` patch via `./knowledge/…` would lead to a reconciliation banner: capture.rs:963 treats a changed generated/verified stamp as forgery.
- **"Twinned in TS" is overstated as a policy-parity defect.** It's a path predicate, not a policy rule, though it has the same normalization gap.

**Evidence checked.** - src-tauri/src/knowledge.rs:30-32: `path == KNOWLEDGE_DIR || path.starts_with("knowledge/")`, with no normalization. Tests at :718-724 and :908-912 cover no `./` or case variants.
- src/engine/okf.ts:30-32: identical TS predicate.
- src-tauri/src/mcp.rs:155-163: `scope_admits` trims `./` and `/` for scope only.
- mcp.rs:1310-1407 (`call_tool`): passes raw args to the tools.
- mcp.rs:2397, 2421, 2434: `guard_agent_write` on the raw folder/path.
- src-tauri/src/vault/write.rs:167-171: `safe_join` allows `Component::CurDir`. write.rs:333 and :365 write via `safe_join(vault, rel)`.
- src-tauri/src/ledger/capture.rs:961-965: a changed generated/verified stamp is "provenance forgery", which goes to reconciliation.
- src-tauri/src/agent/mod.rs:665-675: non-internal runs get `--permission-mode acceptEdits` with no disallow list. mod.rs:580-585: shell runs are granted Write/Edit. mod.rs:627-640: `INTERNAL_DISALLOWED` applies only to internal runs.
- Live vault knowledge/…/gcs-5-supervision-ratio.md frontmatter has `generated: {by: claude-code, at: 2026-08-17T11:52:02Z}` and `sources:`. This matches the `write_concept` stamp at mcp.rs:2501 (DEFAULT_ACTOR = "claude-code", mcp.rs:42), not the prefix bypass.
- src-tauri/src/lib.rs:96-133: human `save_note`/`update_frontmatter` use the same predicate, but paths come from the scanner.

**Correction.** The prefix and case gap in `guard_agent_write` is real: `./knowledge/…` and `Knowledge/…` (on APFS) get past `create_note`, `update_frontmatter` and `append_to_note`, and a `verified` patch sent that way would open reconciliation. But it is not the main agent bypass. Non-internal runs already get acceptEdits, and shell runs are granted Write/Edit, so they can edit knowledge/ directly. The human IPC branches can't be reached from the UI. The live incident's files carry `write_concept`-shaped stamps, not this path. Fix: normalize the path (strip `./` and `/`, compare case-insensitively) inside `is_knowledge_path`/`guard_agent_write`, and add tests. That's medium severity, not high.

</details>

### F48 — Provenance-forgery and alias-removal rules are hand-written in both Rust and mockIpc, and the copies already disagree

- **Severity (claimed):** high
- **Category:** parity
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/capture.rs:961-979`
  - `src/lib/mockIpc.ts:219-237`
  - `src/lib/epistemic/normalize.ts:17`
  - `conformance/README.md:6-8`

**Evidence**

Rust (capture.rs:963) refuses generated/verified only when the value CHANGES (`if before == after { continue }` runs first). The mock (mockIpc.ts:221) refuses if the key is merely present in the patch. For aliases, Rust compares normalize_alias_v1 sets; the mock compares raw strings (`before.some(a => !after.includes(a))`), even though the conformance-pinned normalizeAliasV1 exists in src/lib/epistemic/normalize.ts. So a case-only alias edit is accepted in Tauri and refused in the mock. The messages also differ ('changed out of band' vs 'is never a human edit'). Neither rule is in shared/policy/ or any vector. conformance/README.md:8 says mockIpc does not hold its own copy of the rules; for these two rules it does.

**Impact**

AGENTS.md calls a twin rule a review-blocking defect, and this one has already drifted. The rule at the heart of the incident behaves differently in the browser, vitest and e2e than in the packaged app.

**Recommendation**

Move the provenance-key list and the alias-removal comparison into a shared artifact, or at least have the mock call normalizeAliasV1 and mirror the changed-value semantics. Add a shared vector the mock test replays, and correct the README claim.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** The mechanism is real. There are two hand-written copies of each rule, and they do disagree:
- **Provenance stamps:** Rust skips any key whose value did not change (`before == after`) and only then refuses `generated`/`verified`. The mock refuses as soon as either key is present in the patch, even with the same value.
- **Aliases:** Rust compares sets normalized by `normalize_alias_v1`. The mock compares raw strings and does not use the `normalizeAliasV1` that `src/lib/epistemic/normalize.ts` exports. A case-only or whitespace-only alias edit (`["Foo"]` to `["foo"]`) is accepted by Tauri and refused by the mock.
- **Messages** differ ("changed out of band" vs "is never a human edit").
- **Neither rule is data:** they are not in `shared/policy/policy.v3.json` or in any conformance vector.
- **Doc claims are false:** the mock's comment says "the SAME hard refusals as Rust", and `conformance/README.md` says mockIpc holds no copy of its own rules.

The claim is overstated in three ways:
1. **Right comparison, but the claim does not say it.** The mock's `updateFrontmatter` mirrors the Rust IPC command `update_frontmatter` (`lib.rs:112`). That command reaches `diff_projection_file` through `capture_frontmatter_patch`, so the comparison holds.
2. **The drift only runs one way.** The mock is stricter, so the only effect is false refusals in browser, vitest and e2e. It cannot hide or cause a real forgery, and it never ships in the packaged app.
3. **It is not "the rule at the heart of the incident."** The incident came from `launch_scan`'s out-of-band capture and the reconciliation actions. The mock has no counterpart to either, so the drift did not contribute and does not change how the incident behaves.

The copies are also not identical elsewhere: the mock skips the `reconciliation_open` suspension check that Rust runs first.

AGENTS.md's "twin Rust+TS rule = review-blocking" line is about policy rules. The more exact breach is the "mockIpc must mirror every Rust guard" invariant, which is a real defect. Severity is medium, not high: there is no production or data-integrity impact, only test-fidelity drift.

**Evidence checked.** - `src-tauri/src/ledger/capture.rs:955-979`: the loop runs `if before == after { continue; }` before `if key == "generated" || key == "verified" { return Err("provenance forgery: the {key} stamp changed out of band — refused") }`. Aliases are checked with `norms(before).difference(&norms(after))` over `schema::normalize_alias_v1`.
- `src-tauri/src/ledger/capture.rs:875-906`: `capture_frontmatter_patch` merges the patch into the overlaid fields, then calls `diff_projection_file`. The `reconciliation_open` check runs first (L885).
- `src-tauri/src/lib.rs:112-130`: the `update_frontmatter` IPC command routes knowledge paths to `capture_frontmatter_patch`.
- `src/lib/mockIpc.ts:216-237`: the comment reads "SAME hard refusals as Rust". The code runs `for key of Object.keys(patch) if key==='generated'||'verified' throw` (presence only), then `before.some((a) => !after.includes(a))` (raw strings, no normalization). There is no reconciliation-suspended check.
- `src/lib/epistemic/normalize.ts:17`: `normalizeAliasV1` exists, but mockIpc imports only `validateFieldPath`/`validateOverridePointer` from `./epistemic/schema` (`mockIpc.ts:10`).
- `conformance/README.md:6-8`: "mockIpc consumes the TS reducer, not its own copy of the rules".
- `shared/policy/policy.v3.json`: has no provenance-forgery code and no unsupported_alias_removal code (grep).
- `src-tauri/src/ledger/concepts.rs:62,658-676`: a third, separate alias-removal check sits on the `write_concept` path, compared against the registry.

**Correction.** The drift is real, but only in the mock, and the mock is the stricter side. It causes false refusals (an unchanged generated/verified key re-sent in a patch, or a case- or whitespace-only alias change) in browser, vitest and e2e. It has no effect on the packaged app, and it did not cause or mask the reconciliation incident, which runs through launch_scan and resolve_accept_with (neither is modeled in the mock). The defect is that the mock breaks the parity invariant ("mockIpc mirrors every Rust guard"), and its comment and conformance/README.md claim parity that does not exist. Fix: import normalizeAliasV1 in the mock, compare against existing values, and add the reconciliation-suspended check, or pin these refusals in conformance vectors. Severity: medium.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → low)</summary>

**Reasoning.** - The code facts hold. There are two hand-written copies and they do differ. Rust's diff_projection_file skips any unchanged key before its provenance check. The mock refuses as soon as `generated` or `verified` appears in a patch, even with the same value. For aliases, Rust compares normalize_alias_v1 sets, while the mock compares raw strings and does not use normalizeAliasV1. So an alias edit that only changes case or whitespace passes in Tauri and is refused by the mock. The error wording differs too.
- The rules are not in shared/policy/ or in the conformance vectors. The only test is mockIpc.test.ts:346, which covers the mock and nothing else.
- Overstated 1, the AGENTS.md framing: the "twin Rust+TS = review-blocking" rule is about `shared/policy/` rules. The "Knowledge is guarded" bullet in AGENTS.md says the mock MUST mirror every Rust-side guard. So having a mirror is the sanctioned design. The real defect is that the mirror drifted, plus the conformance README's claim that mockIpc holds no copy of its own. It is a parity bug, not a policy-as-data violation.
- Overstated 2, the incident link: the incident ran through launch_scan and out-of-band capture. The mock has no ledger and no reconciliation. mockIpc.ts:568-593 hard-codes reconciliation_open=false, and resolveReconciliation throws "Tauri-only". The browser, vitest and e2e never reach that path. In the incident the `generated` stamp really did CHANGE, and both copies refuse that. The drift has no effect on the incident.
- Reachability of the drift: it only shows up through the in-app updateFrontmatter on a knowledge/ file in browser mode. The one realistic trigger is a case-only or whitespace-only alias edit through the generic property editor (DocProperties). Nobody sends a patch that re-sends an unchanged `generated` value. The packaged app does not behave this way; only dev and e2e fidelity suffer.

**Evidence checked.** - src-tauri/src/ledger/capture.rs:957-959 has `if before == after { continue; }` before the provenance refusal at 962-966. Aliases are compared as normalize_alias_v1 sets at 967-978.
- src-tauri/src/lib.rs:111-129: update_frontmatter reaches that code through capture_frontmatter_patch (capture.rs:875-906).
- src/lib/mockIpc.ts:219-237: the mock refuses on key presence (`Object.keys(patch)`) and does a raw `before.some(a => !after.includes(a))` alias comparison. normalizeAliasV1 is not imported; only validateFieldPath and validateOverridePointer are, at line 10.
- src/lib/epistemic/normalize.ts:17 exports normalizeAliasV1, which is unused here.
- conformance/README.md:6-8: "mockIpc consumes the TS reducer, not its own copy of the rules".
- A grep of conformance/ and shared/policy/ for forgery or alias_removal finds no refusal vector for these rules. The only test is mockIpc.test.ts:346-366, and it covers the mock alone.
- The mock has no ledger: mockIpc.ts:568-593 fixes ledgerStatus reconciliation_open=false and resolveReconciliation throws "Tauri-only". The out-of-band capture path (capture_out_of_band_with, capture.rs:767-783) has no mock counterpart.
- AGENTS.md "Knowledge is guarded": the mock backend must mirror every Rust-side guard.

**Correction.** The two copies (Rust capture.rs:957-979 and mockIpc.ts:219-237) have drifted. The mock refuses a `generated`/`verified` key that is present but unchanged, and it compares aliases as raw strings instead of normalizeAliasV1 sets. As a result the mock refuses case-only or whitespace-only alias edits that Tauri accepts. This drift touches only the in-app updateFrontmatter path in browser, vitest and e2e runs. It is not the out-of-band capture path behind the incident: the mock has no ledger or reconciliation, and a changed stamp is refused by both copies. AGENTS.md requires mockIpc to mirror the Rust guards, so the defect is the drift plus the missing shared vector, not the fact that a mirror exists. The conformance README's claim that mockIpc holds no rule copy of its own is inaccurate. Fix: use normalizeAliasV1 and an "unchanged value is a no-op" check in the mock, or pin both refusals in the conformance vectors.

</details>

### F49 — The reconciliation surface cannot be reached or tested outside Tauri

- **Severity (claimed):** high
- **Category:** parity
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src/lib/mockIpc.ts:568-596`
  - `src/app/ReconciliationBanner.tsx:9`
  - `src/app/ReconciliationBanner.tsx:17-21`
  - `src/lib/ipc.test.ts:103-111`

**Evidence**

The mock's ledgerStatus hard-codes reconciliation_open:false and divergences:[], and resolveReconciliation always throws. The mock exposes seed hooks for review, chips, lanes, changes, pipeline, fleet and trigger (__cerebroSeed*), but none for ledger status. There is no ReconciliationBanner test file and no e2e spec that mentions reconciliation (grep of e2e/ and all *.test.* returns nothing relevant). The only 'parity' test (ipc.test.ts:103) checks that the command exists.

**Impact**

The banner the user is stuck on has never been rendered by any test. That includes the '(N unresolved)' count, which counts events rather than files, the error line after 'Keep my files' refuses, and the silent collapse of a status error to no banner. None of this can be reproduced in dev or e2e.

**Recommendation**

Add a __cerebroSeedLedgerStatus hook, plus a scriptable resolveReconciliation outcome (success, or refusal text). Add a component test and an e2e spec covering: open mode, the accept refusal rendering, restore closing the mode, and a status read failure rendering unavailable rather than nothing.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** - The mechanism is real. The mock always reports the mode closed, resolveReconciliation always throws, there is no __cerebroSeed* hook for ledger status, and neither e2e/ nor any vitest file renders or mentions the banner. So in dev and e2e the banner can never be reached, and no test has ever rendered it: not the count, not the error line, not the status catch that collapses to null.
- Overstated: "cannot be tested outside Tauri" is wrong. src/App.test.tsx already does vi.mock('@/lib/ipc') and mocks ipc return values per test. The same pattern could make ledgerStatus report reconciliation_open:true and resolveReconciliation reject. The component is testable in vitest. Nobody wrote the test.
- The no-ledger mock is a documented design choice (mockIpc.ts:561-563: the mock "must not grow" ledger guard logic). It is not an accidental parity hole.
- The backend has tests. reconcile.rs has 14 #[test]s, including one_forged_file_refuses_the_entire_adoption (L1639), which covers the refusal the user will hit.
- What is actually missing is component and e2e coverage of the UI layer. That is a test-coverage gap (medium), not a high-severity defect. The UI flaws it hides (counting events rather than files, swallowing a status error) are separate findings.

**Evidence checked.** - src/lib/mockIpc.ts:561-563: a comment says the mock deliberately has no ledger.
- src/lib/mockIpc.ts:567-572: resolveReconciliation throws 'no ledger in the browser'.
- src/lib/mockIpc.ts:574-596: ledgerStatus returns reconciliation_open:false and divergences:[].
- Seed hooks exist only for Review, Chips, Lanes, Changes, Pipeline, Fleet and TriggerLatest (mockIpc.ts:863-1817). There is none for ledger status.
- ReconciliationBanner.tsx:9 says the banner "Renders nothing ... always, in the browser mock". L17-21 has `.catch(() => setStatus(null))`. L44 shows `{status.divergences.length} unresolved`.
- Running grep -rlE 'ReconciliationBanner|reconciliation-banner|reconciliation_open|resolveReconciliation|ledgerStatus' over src and e2e hits only App.tsx, ReconciliationBanner.tsx, ipc.ts, ipc.test.ts and mockIpc.ts. A grep for 'reconcil' in e2e/ finds nothing.
- ipc.test.ts:103-118 only checks the no-ledger verdict and that the command is invoked.
- Counter-evidence: src/App.test.tsx:6 uses `vi.mock('@/lib/ipc', ...)`, so the ipc layer is already mockable in vitest.
- Counter-evidence: src-tauri/src/ledger/reconcile.rs has 14 #[test]s, including L1545 restore_ledger_authority_regenerates_everything_and_closes_the_mode, L1585 accept_current_files_adopts_through_capture_in_one_batch and L1639 one_forged_file_refuses_the_entire_adoption.

**Correction.** The banner is unreachable in dev and e2e, because the mock always reports the mode closed and has no seed hook. No vitest or e2e test renders it. It is not untestable outside Tauri: vi.mock('@/lib/ipc'), already used in src/App.test.tsx, would render it. The Rust reconcile and accept logic, including the forged-file refusal, is covered by unit tests. The gap is missing UI test coverage (medium). The component and backend are testable.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - Confirmed: the banner UI has never been rendered by any test. The mock hard-codes a closed mode, `resolveReconciliation` always throws, there is no `__cerebroSeed*` hook for ledger status, there is no ReconciliationBanner test, and no e2e spec mentions reconciliation. The only non-Rust tests are two IPC-routing checks in `ipc.test.ts`.
- Overstated: "cannot be reached or tested outside Tauri" is wrong for vitest. 18 test files already use `vi.mock('@/lib/ipc')`, and the same seam could render the banner with `reconciliation_open: true` and a rejecting `resolveReconciliation`. Nobody has written that test, but nothing blocks it. The claim holds only for dev and e2e, where the lack of a seed hook makes the banner unreachable.
- Overstated: the logic behind the surface is tested in Rust. `reconcile.rs` covers opening the mode, both exits, and the case where one forged file refuses the whole adoption (`one_forged_file_refuses_the_entire_adoption`). So the backend refusal the user will hit is a known, tested behaviour. The untested part is only the UI layer: the count of events rather than files, how the error line renders, and a status error collapsing to no banner.
- Severity: this is a test gap, not what caused the incident. The banner renders correctly for the user. Medium, not high.

**Evidence checked.** - `src/lib/mockIpc.ts:568-596`: `resolveReconciliation` throws "reconciliation is a Tauri-only surface", and `ledgerStatus` returns `reconciliation_open: false, divergences: []`.
- `src/lib/mockIpc.ts` seed hooks (lines 863-1817) cover Review, Chips, Lanes, Changes, Pipeline, Fleet and TriggerLatest. None covers ledger status.
- `src/app/ReconciliationBanner.tsx:9-21`: its own doc comment says it renders nothing "which is always, in the browser mock", and `.catch(() => setStatus(null))` swallows a status error.
- `src/app/ReconciliationBanner.tsx`, around line 45: the banner text counts `{status.divergences.length}`.
- grep for `reconcil`, `ledgerStatus` and `reconciliation-banner` in `src` and `e2e`: the only tests hit are `src/lib/ipc.test.ts:103-116` (mock verdict and invoke routing). There are no e2e hits. `ReconciliationBanner` is used only in `src/App.tsx:339`.
- `grep -rn "vi.mock('@/lib/ipc'" src` finds 18 files, so the banner is testable in vitest.
- `src-tauri/src/ledger/reconcile.rs` tests: `an_unproven_state_records_one_divergence_opens_the_mode_and_suspends_capture` (~L1348), `restore_ledger_authority_regenerates_everything_and_closes_the_mode` (~L1545), `accept_current_files_adopts_through_capture_in_one_batch` (~L1585), `one_forged_file_refuses_the_entire_adoption` (~L1639).

**Correction.** The reconciliation banner UI is untested at every layer, and it cannot be reached in dev or e2e because the mock has no ledger-status seed hook. It can be tested in vitest through the existing `vi.mock('@/lib/ipc')` pattern; nobody has written that test. The Rust reconciliation logic, including the forged-file refusal of "Keep my files", is covered by `reconcile.rs` unit tests. The gap is limited to how the UI renders: the count of events rather than files, the error line, and a status error collapsing to no banner.

</details>

### F50 — The mock capture valve is missing most of Rust's refusals, including the one blocking the user now

- **Severity (claimed):** medium
- **Category:** parity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/lib/mockIpc.ts:187-238`
  - `src/lib/mockIpc.ts:290-326`
  - `src-tauri/src/ledger/capture.rs:154-155`
  - `src-tauri/src/ledger/capture.rs:312-387`
  - `src-tauri/src/ledger/capture.rs:841-846`
  - `src-tauri/src/ledger/capture.rs:886-891`
  - `src-tauri/src/lib.rs:102-107`
  - `src-tauri/src/lib.rs:121-128`

**Evidence**

In Rust, saveNote and updateFrontmatter on knowledge/ can refuse with: RECONCILIATION_SUSPENDED; '<path> is not a committed projection'; the no-writer case (falls to guard_human_write, READ_ONLY); a stale before-value (capture.rs:347-357); an alias that is already registered or normalizes to empty (380-387); or an ambiguous extracted-text overlap. The mock has none of these, so its saveNote and updateFrontmatter always succeed on a knowledge path. Its structured capture also ignores `relations` and throws 'captures nothing' on a relations-only request (mockIpc.ts:312). Rust accepts that request (capture.rs:312 includes relations).

**Impact**

In the user's vault reconciliation has been open for about 39 days, so every in-app edit to a concept in Tauri has been refused with RECONCILIATION_SUSPENDED. The same edit succeeds in dev, vitest and e2e, so the failure mode and its toast have never been seen in testing.

**Recommendation**

Give the mock a minimal ledger-mode flag (writer active or absent, reconciliation open or closed) and mirror these guards, taking them from the shared validators where possible. Add mockIpc tests that assert each Rust refusal string or code.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The core claim holds. Rust's save_note and update_frontmatter send knowledge/ paths through capture_body_edit and capture_frontmatter_patch, which can refuse with RECONCILIATION_SUSPENDED, "not a committed projection", the alias refusals and the ambiguous-overlap refusal. The mock saveNote has no knowledge guard at all. The mock updateFrontmatter has only the provenance-key and alias-removal refusals.
- Overstated 1: the mock not refusing with RECONCILIATION_SUSPENDED is a documented design choice, not a forgotten guard. mockIpc.ts:568-594 says "the mock's mode is never open": ledgerStatus is fixed at no-ledger with reconciliation_open false, and resolveReconciliation throws. The real gap is that there is no mock state that can reach that refusal and its toast, not a missing if-branch.
- Overstated 2: the stale before-value refusal (capture.rs:347-357) cannot be hit through saveNote or updateFrontmatter. On those paths diff_projection_file builds `before` from the same folded state, so it always matches. Only the direct capture_concept_edit call can hit it.
- Overstated 3: the relations-only mismatch is real (mockIpc.ts:311-313 counts only fields and alias_adds, while capture.rs:312 also counts relations). But captureConceptEdit has no caller in the UI; only mockIpc.test.ts calls it. It does not change any in-app behaviour.
- Overstated 4: the mock updateFrontmatter DOES copy two Rust refusals: the generated/verified provenance keys and alias removal (mockIpc.ts:216-236).
- The no-writer fallback is a fair point: Rust falls to guard_human_write (READ_ONLY) when there is no writer, and the mock has no equivalent.
- Impact: in the live vault reconciliation is open, so any in-app body or frontmatter edit to a committed concept would be refused with RECONCILIATION_SUSPENDED, provided the shadow writer is active. That is real. But it is a test-coverage gap. It did not cause the divergence, and it is not what blocks "Keep my files"; that is the provenance-forgery refusal in diff_projection_file.

**Evidence checked.** - src-tauri/src/lib.rs:97-107 (save_note) and :110-128 (update_frontmatter): knowledge paths go to capture_body_edit / capture_frontmatter_patch, falling back to guard_human_write when there is no writer (the call returns None).
- src-tauri/src/ledger/capture.rs:834-848 and :875-893: refuse with RECONCILIATION_SUSPENDED (capture.rs:154) and "is not a committed projection".
- capture.rs:380-387: the alias refusals ("normalizes to empty", "already registered").
- capture.rs:1031: the ambiguous extracted-text overlap refusal.
- capture.rs:347-357: the stale check. It sits in capture_structured_with, and on the save paths the diff builds its before values from the same state, so it never fires there.
- src/lib/mockIpc.ts:187-203: saveNote has no knowledge guard.
- mockIpc.ts:205-238: updateFrontmatter refuses only generated/verified and alias removal.
- mockIpc.ts:568-594: "No ledger, no reconciliation: the mock's mode is never open"; ledgerStatus returns reconciliation_open: false.
- mockIpc.ts:311-313 vs capture.rs:312: the relations-only mismatch is confirmed.
- grep of src/: captureConceptEdit is called only from lib/ipc.ts, mockIpc.ts and mockIpc.test.ts. It has no UI caller.
- UI callers of saveNote/updateFrontmatter that can reach knowledge paths: src/editor/NoteBodyEditor.tsx:162, src/pages/DocPage.tsx:460, src/stores/vaultStore.ts:191.

**Correction.** The mock saveNote and updateFrontmatter on knowledge/ paths lack Rust's refusals for "not a committed projection", the alias refusals (already registered / normalizes to empty), ambiguous extracted-text overlap, and the no-writer READ_ONLY fallback. RECONCILIATION_SUSPENDED can never be reached in the mock, because the mock deliberately models a vault with no ledger where reconciliation is never open (mockIpc.ts:568-594). So the refusal and its toast have no dev, vitest or e2e coverage. The stale-before refusal cannot be reached through the save paths. The relations-only mismatch in captureConceptEdit is real but test-only, since no UI code calls captureConceptEdit. The mock updateFrontmatter does copy the provenance and alias-removal refusals. This is a coverage and parity gap, not a cause of the incident: the user's "Keep my files" is blocked by the provenance-forgery refusal in diff_projection_file, not by the capture valve.

</details>

### F51 — Capture and reconciliation refusals have no code and no declared destiny; the forgery reason is recorded nowhere

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `shared/policy/policy.v3.json (rejection_destinies)`
  - `src-tauri/src/ledger/capture.rs:154`
  - `src-tauri/src/ledger/capture.rs:964-966`
  - `src-tauri/src/ledger/reconcile.rs:295`
  - `src-tauri/src/ledger/reconcile.rs:325`
  - `src-tauri/src/ledger/reconcile.rs:344-373`
  - `src-tauri/src/ledger/shadow.rs:144`
  - `src-tauri/src/ledger/shadow.rs:363-364`

**Evidence**

rejection_destinies has 36 codes and none of them covers capture or reconciliation, although `untrusted_provenance` exists and would fit. RECONCILIATION_SUSPENDED, 'provenance forgery', 'ambiguous extracted-text overlap' and 'stale edit' are bare prose strings. launch_scan collects a reason for each divergent path (reconcile.rs:295,325), but the LedgerDivergence body keeps only signals and sample_paths. The scan result is discarded (`let _ = launch_scan(..)`, shadow.rs:144). No runtime::sink call exists anywhere in ledger/. ledger_status exposes only detection keys.

**Impact**

This breaks AGENTS.md's 'two records, two destinies' rule. The fact the user needs ('generated stamp changed out of band on 3 files') exists neither in the ledger nor in runtime.db, and the banner cannot say why history diverged.

**Recommendation**

Give capture refusals closed codes in policy.v3's table, with destinies declared (forgery maps to untrusted_provenance or a new code). Persist per-path reasons: either in the divergence body (schema bump) or operationally in runtime.db. Surface them through ledger_status.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - I could not refute any cited detail. The code is real and it runs on the live vault's path.
- The policy has 36 `rejection_destinies` codes. None of them covers capture refusals, reconciliation refusals or suspension. `untrusted_provenance` exists but is never used by `ledger/`.
- The capture refusals are plain `format!`/`&str` strings with no code: "provenance forgery", `RECONCILIATION_SUSPENDED`, and the others.
- `launch_scan` gathers `(path, reason)` pairs into `outcome.divergent`. The `LedgerDivergence` body has no reason field, and when samples are built the reason is thrown away (`.map(|(path, _)| path)`).
- `shadow.rs` throws away the whole scan outcome with `let _ = launch_scan(..)`.
- Nothing under `ledger/` calls `runtime::sink` or `operational::record`. The live `runtime.db` `operational_log` holds only `capability_unavailable` (19 rows).
- `LedgerStatus` exposes only `reconciliation_open` plus the detection-key strings.
- Extra point the claim missed: the live watcher also drops capture errors (`let _ = capture_out_of_band`). A forgery refusal hit while the app is running is lost too, and it does not escalate.
- Two small caveats, neither enough to change the severity:
  - `RECONCILIATION_SUSPENDED` is not recorded nowhere in every case. On the IPC capture paths it goes back to the frontend caller as an error string, but with no code.
  - The ledger does record WHICH files diverged (`sample_paths`), just not WHY.

**Evidence checked.** - `shared/policy/policy.v3.json` `rejection_destinies`: 36 keys, none for capture or reconciliation.
- `src-tauri/src/ledger/capture.rs:154-155`: `RECONCILIATION_SUSPENDED` is a plain `&str`, returned at lines 323, 643, 780, 841 and 886.
- `capture.rs:962-966`: `Err(format!("provenance forgery: the {key} stamp changed out of band — refused"))`, with no code.
- `reconcile.rs:295-296` and `:322`: `outcome.divergent.push((path, reason))`.
- `reconcile.rs:349-353`: samples are built with `.map(|(path, _)| path)`, so the reason is dropped.
- `reconcile.rs:376-396` and `schema/reconciliation.rs:58-69`: `LedgerDivergence` fields are `detection_key`, `signals`, heads, digests, counts and `sample_paths`. There is no reason field.
- `shadow.rs:144`: `let _ = super::reconcile::launch_scan(...)`.
- `shadow.rs:361-364`: `LedgerStatus` has `reconciliation_open` and `divergences: Vec<String>` (detection keys only).
- `vault/watcher.rs:260`: `let _ = crate::ledger::capture::capture_out_of_band(&vault, &rel);`, so the watcher discards refusals too.
- Grep for `runtime::sink` / `operational::record` finds callers only in `knowledge.rs`, `mcp.rs`, `policy/commit.rs`, `runtime/*`, `agent/meter.rs`, `assembly/ask.rs` and `ingest/ambient.rs`. There are none in `ledger/`.
- Live `runtime.db`, read-only: `SELECT code, count(*) FROM operational_log GROUP BY code` returns only `capability_unavailable|19`.

</details>

### F52 — Conformance vectors cover only the reducer fold, not the capture classifier, the classify_path table or the reconciliation exits

- **Severity (claimed):** medium
- **Category:** parity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `conformance/capture.json`
  - `conformance/reconciliation.json`
  - `src-tauri/src/ledger/capture.rs:927-1042`
  - `src-tauri/src/ledger/reconcile.rs:67-140`
  - `src-tauri/src/ledger/reconcile.rs:216-410`
  - `src-tauri/src/ledger/conformance.rs`

**Evidence**

The 'forged' refusals in capture.json are the reducer's authority_provenance mismatch (seq 14), not the generated/verified stamp rule. reconciliation.json covers only divergence de-duplication and the resolution digest proof (seq 3,5,6,8,13). conformance.rs has no reference to diff_projection_file, classify_path, launch_scan or resolve_accept_with/resolve_restore_with. The only tests for these are Rust-local, so the rule that caused the incident has no shared artifact at all.

**Impact**

The parity machinery reports green while the refusal that caused the incident is outside it. Any TS or mock surface that reasons about capture outcomes has nothing shared to check against.

**Recommendation**

Add file-level vectors of the form (reducer state + file bytes → FileDiff or typed refusal) and classify_path table vectors to conformance/. Replay them in TS, or declare explicitly that this layer is Rust-only and drop the mock's hand copies.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** Every detail I checked matches the claim. capture.json's "forged" refusal (seq 14) is the reducer's authority_provenance check. reconciliation.json covers only duplicate divergences, stale or wrong resolutions, the digest mismatch and an orphaned batch. conformance.rs has no reference to diff_projection_file, classify_path, launch_scan or resolve_*_with. The rule that refused the files (capture.rs:961-966) is tested only in Rust (reconcile.rs:1656) and, separately, against the mock's own copy in mockIpc.test.ts. That copy (mockIpc.ts:219-223) is a real hand-written mirror with no shared artifact behind it, which supports the "nothing shared to check against" point. The claim overstates the impact, though. The vectors are scoped to the reducer on purpose, and the README documents that. The incident came from an agent writing that bypassed the ledger (a different finding), not from Rust and TS disagreeing. And diff_projection_file / classify_path have no TS counterpart that could drift, apart from the mock's one guard. That makes this a real but low-severity coverage and parity gap, not a medium defect.

**Evidence checked.** - conformance/README.md: "The schema-v1 parity mechanism... The minimal TS reducer replays the same files". Each file is {name, description, store_id, events, expected_state, expected_refusals}, i.e. reducer replays.
- conformance/capture.json expected_refusals: seq12 stale before-value, seq13/16 whole batch has no effect, seq14 "authority_provenance TrustedHumanCapture disagrees with the registration-derived AgentInferred". None of them is the generated/verified stamp rule.
- conformance/reconciliation.json refusals: seq3 detection key already open, seq5/8 divergence not active, seq6 resulting_projection_digest mismatch, seq13 orphaned batch.
- grep src-tauri/src/ledger/conformance.rs for diff_projection_file|classify_path|launch_scan|resolve_accept|resolve_restore: 0 hits. derivations.json keys are store_id, normalize_alias_v1, relation_ids, sources, migrate_ids, attested_content (no classifier).
- src-tauri/src/ledger/capture.rs:961-966: `if key == "generated" || key == "verified" { return Err("provenance forgery: the {key} stamp changed out of band — refused") }`.
- src-tauri/src/ledger/reconcile.rs:67-140: classify_path is a pure table (Match/OutOfBandEdit/LedgerAhead*/Interrupted*/Divergence) and has no vector. The only Rust test touching forgery is at reconcile.rs:1656.
- src/lib/mockIpc.ts:219-223: a hand-written twin of the forgery rule; tested only by mockIpc.test.ts:346-356 (regex /provenance forgery/), not against any shared vector.

**Correction.** The facts are right, but the severity is overstated. The vectors are replays of event streams through the reducer, and conformance/README.md says that is their whole scope: they are the "schema-v1 parity mechanism" between the Rust reducer and the TS reducer. So they never claimed to cover capture, classify_path or the reconciliation exits, and a green suite does not falsely vouch for those parts. The Rust code refused the edit exactly as designed. No drift between Rust and TS helped cause the incident, so this is a gap in test coverage and parity, not a live defect. The one concrete parity problem is sharper than the claim says. src/lib/mockIpc.ts:219-223 is a hand-written twin of the generated/verified forgery rule, with different wording ("stamp is never a human edit" vs "stamp changed out of band"). Its only check is a regex test of its own in mockIpc.test.ts:346-356; no shared vector checks it against Rust. That is the kind of twin rule AGENTS.md warns about ("mockIpc mirrors every Rust guard, and that parity is itself tested").

</details>

### F53 — The 3.3k-line TS reducer has no runtime consumer, contradicting the conformance README

- **Severity (claimed):** medium
- **Category:** complexity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src/lib/epistemic/reduce.ts`
  - `src/lib/epistemic/project.ts`
  - `src/lib/mockIpc.ts:10`
  - `conformance/README.md:6-8`

**Evidence**

A grep for imports of epistemic/reduce, project, ids or normalize outside src/lib/epistemic finds none. reduce.ts is imported only by conformance.test.ts (and soak.test.ts). mockIpc imports just validateFieldPath and validateOverridePointer from schema.ts. The README says 'mockIpc consumes the TS reducer, not its own copy of the rules'. It does not.

**Impact**

About 7.4k lines of TS (reduce.ts plus schema.ts) are kept in lockstep with Rust at real cost, yet they gate no runtime behavior. Meanwhile the twin code that does run (the mock's knowledge guards) is unpinned and drifting.

**Recommendation**

Either drive the mock's capture and ledger surfaces through the TS reducer (which also fixes the two parity findings above), or rewrite the README honestly and consider shrinking the TS reducer to the pieces the mock consumes.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - The core claim holds. reduce.ts (3341 lines) and project.ts (100 lines) have no non-test importer. The only thing that imports reduce.ts is conformance.test.ts, and project.ts is imported only by reduce.ts. The README's line "mockIpc consumes the TS reducer" is literally false.
- The impact is overstated in three ways:
  - (a) schema.ts (3585 lines) does run. mockIpc.captureConceptEdit calls validateOverridePointer and validateFieldPath from it, and trigger/evaluation.ts imports isRfc3339. schema.ts also pulls in ids.ts and normalize.ts, so those run too. "7.4k lines gate no runtime behavior" is wrong. Only about 3.4k lines (reduce + project) are dead at runtime.
  - (b) The README's intent, "not its own copy of the rules", is partly honored for the capture guards. mockIpc.ts:280-287 documents this and does it.
  - (c) The only possible runtime consumer is mockIpc, which is the browser/dev/e2e mock. The shipped Tauri app never runs any TS reducer, so production behavior is unaffected. The real cost is a stale doc claim plus lockstep upkeep of a reducer that only tests use.
- I did not verify the "mock guards are unpinned and drifting" sub-claim, and it isn't supported here.
- Net: this is a doc/maintenance-cost finding at low severity, not medium.

**Evidence checked.** - Repo-wide grep `grep -rn "epistemic/" src scripts e2e` outside src/lib/epistemic finds only two hits:
  - src/lib/mockIpc.ts:10 `import { validateFieldPath, validateOverridePointer } from './epistemic/schema'`
  - src/lib/trigger/evaluation.ts:17 `import { isRfc3339 } from '../epistemic/schema'`
- No dynamic `import(` of epistemic anywhere.
- Internal imports:
  - reduce.ts:8-22 imports ids, normalize, project and schema.
  - project.ts is imported only by reduce.ts and tests.
  - schema.ts:18-31 imports ids and normalize, so those are reachable at runtime through mockIpc.
- Guards in use: mockIpc.ts:305 calls validateOverridePointer and :315 calls validateFieldPath, inside captureConceptEdit. The doc comment at mockIpc.ts:280-287 says the guards come from src/lib/epistemic.
- conformance/README.md:6-8 says "mockIpc consumes the TS reducer, not its own copy of the rules". The first half is false (the reducer is never consumed). The second half is partly true (the schema guards are shared).
- wc -l: reduce.ts 3341, schema.ts 3585, project.ts 100, ids.ts 142, normalize.ts 33.

**Correction.** Only reduce.ts and project.ts (about 3.4k lines) have no runtime consumer. schema.ts, ids.ts and normalize.ts do run: mockIpc's captureConceptEdit calls validateOverridePointer and validateFieldPath, and trigger/evaluation calls isRfc3339. The README wrongly says mockIpc consumes the TS reducer, but mockIpc does use the shared schema guards rather than copies of its own. Its only consumer is the browser mock, so the shipped Tauri app is unaffected. This is a stale doc plus test-only maintenance cost, not a gap in runtime behavior.

</details>

### F54 — The mass-mismatch circuit-breaker thresholds are hard-coded in Rust, not policy data

- **Severity (claimed):** low
- **Category:** policy-as-data
- **Verification:** survived (partially_confirmed/none)
- **Locations:**
  - `src-tauri/src/ledger/reconcile.rs:199-202`
  - `shared/policy/policy.v3.json (thresholds)`
  - `shared/policy/README.md (lineage_fan_in_high judgment call)`

**Evidence**

MASS_MIN_PROJECTIONS=8, MASS_MIN_MISMATCHES=5 and MASS_MIN_RATIO=0.25 are Rust consts. policy.v3 `thresholds` holds only lineage_fan_in_high:5, and the README justifies making that one data 'so it can be retuned without touching either interpreter'. The mass thresholds decide the same kind of question: whether edits are auto-captured or open reconciliation.

**Impact**

Retuning when the vault goes into reconciliation is a code change with no digest or golden trail. For example, a 30-projection vault like the user's needs 8 mismatches before the mass signature fires.

**Recommendation**

Move the three values into a policy artifact (policy.v3 thresholds, or a reconciliation table with its own sha256), loaded by reconcile.rs and covered by a vector.

<details><summary>Verifier 1: partially_confirmed (severity → none)</summary>

**Reasoning.** The facts are right, but the claim that this is a defect does not hold up.
- The consts exist and are reachable. launch_scan computes mass_signature from them before capture (reconcile.rs:305-307). It suppresses capture at :314 and emits MassProjectionMismatch at :334. For 30 projections the arithmetic checks out: it takes at least 8 mismatches (7.5 rounded up).
- It does not break the house rule. AGENTS.md and shared/policy/README.md:8 define the defect as a rule written twice, in Rust and in TS. This threshold exists only in Rust. The TS side (src/lib/epistemic/schema.ts:63) holds only the signal name, so there is no second copy that could drift.
- It is intended. The accepted M23 spec (docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:359-361) says the threshold is 'fixed' at ≥8 / ≥5 / ≥25%. Smaller vaults deliberately rely on anchors instead. The code comment at :199 says 'The fixed ... threshold'.
- The comparison to lineage_fan_in_high does not fit. That value is data because two interpreters (Rust and TS) read it and goldens check them against each other. The mass breaker has only one interpreter.
- It has nothing to do with the incident. The user's scan had 3 mismatches out of 30, so the mass signature never fired. Reconciliation opened through the forged-provenance capture refusal, which turned into divergence and raised ManifestReducerDisagreement.
- At most this is a design preference (making the threshold tunable), not a correctness or parity defect.

**Evidence checked.** - src-tauri/src/ledger/reconcile.rs:199-202 has const MASS_MIN_PROJECTIONS=8, MASS_MIN_MISMATCHES=5, MASS_MIN_RATIO=0.25, under the doc comment 'The fixed mass-mismatch circuit-breaker threshold'.
- reconcile.rs:305-307 computes mass_signature from those consts.
- reconcile.rs:313-316 capture runs only when !mass_signature.
- reconcile.rs:333-335 pushes MassProjectionMismatch.
- shared/policy/policy.v3.json:119-121 thresholds has only lineage_fan_in_high: 5.
- shared/policy/README.md:8 states the house rule as 'twin Rust and TS code'.
- shared/policy/README.md:93-98 is the lineage_fan_in_high judgment call ('without touching either interpreter').
- Spec docs/superpowers/specs/2026-08-08-cerebro-m23-projection-capture-design.md:359-361 says 'The mass-mismatch signal is fixed at projection count ≥ 8, mismatch count ≥ 5, and mismatches ≥ 25% of projections'.
- No TS twin: grep of src/lib/mockIpc.ts and src/lib/epistemic finds only the signal name at schema.ts:63.
- Incident: 3 mismatches out of 30, and the divergence event carries only the manifest_reducer_disagreement signal. The mass path was not involved.

**Correction.** The mass-mismatch thresholds are Rust consts, as claimed. But the M23 spec (§ launch reconciliation) fixes them there on purpose, and they have a single interpreter with no TS twin. So this does not violate 'policy is data', which targets twin Rust/TS rules. Moving them into policy.v3.json is an optional design choice, not a defect. The breaker also played no part in the user's banner incident (3 of 30 mismatches, below every threshold).

</details>
