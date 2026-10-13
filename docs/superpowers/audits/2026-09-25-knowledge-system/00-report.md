# Knowledge System Audit: why the "history diverged" banner appeared

## 1. What the banner means

- **Which files:** 3 knowledge files no longer match Cerebro's recorded history:
  - `decisions/gcs-5-supervision-ratio.md`
  - `risks/tx-6-changeover-transient-cross-channel-sync-disabled.md`
  - `risks/tx-6-np-shared-j12-common-mode.md`
  - "(1 unresolved)" counts one detection event, not one file.
- **Who changed them:** on Aug 17 (11:50–11:57Z), Cerebro's own background "schema recheck" agents rewrote these files. No Cerebro process had a ledger writer at the time, so none of those edits were recorded. This was neither you nor tampering.
- **What changed:** frontmatter only.
  - Changed: `description` added (×3), `stale_after` moved or added, `generated.at` restamped, YAML reformatted.
  - Unchanged: the bodies are byte-identical.
  - Both versions are in vault git: Aug 16 is `f7df8b4`, Aug 17 is HEAD.
- **What "paused" actually means:** your in-app edits to `knowledge/`, out-of-band capture, and crash-recovery repairs are refused. Agent `write_concept`, **Verify** and log appends are *not* paused, and they can silently overwrite the disputed files.
- **The buttons:**
  - **"Keep my files" cannot succeed** on these files.
  - **"Restore recorded history"** is the only working exit. It reverts the Aug 17 frontmatter on the 3 files and deletes nothing.

## 2. What to do right now

**Before anything else**
- Do not click **Verify** on the 3 files. It attests the Aug 16 revision and silently reverts the file you are reading (K6).
- Do not hand-edit the files and retry Keep. A failed Keep claims the operation key and disables Keep for this divergence permanently (K5).
- Do not `rm -rf .cerebro`. That silently starts a new baseline and erases the history (K26).

**Steps**

0. **Get one clean writer.**
   - Quit `tauri dev` (pid 70308 runs from the main checkout). Agents editing any `.md` in that checkout trigger a full reload, and each reload switches the writer off or back on (K2).
   - Quit any other Cerebro build: the 5274 worktree or the packaged app.
   - Launch exactly one instance, then check `lsof ~/Documents/test/.cerebro/ledger/lock`. It must show one `cerebro … w` line. If it is empty, relaunch. Never use Cmd+R.

1. **Back up.**
   - Run `cp -Rp ~/Documents/test/knowledge ~/Documents/test/.cerebro ~/cerebro-bak-0925/`. The ledger and manifest are gitignored, so this is their only copy.
   - `git -C ~/Documents/test status --porcelain knowledge` should print nothing.

2. **Settings → turn OFF "Learn on its own".** Restore pushes `generated.at` back before `types/decision.md`'s mtime, which re-queues 3 paid rechecks (K18).

3. **Choose one:**
   - **B, recommended: Restore.** Click "Restore recorded history".
     - Lost from the working tree: 3 `description` lines; gcs-5 `stale_after` goes back to 2027-07-31; the tx-6 pair lose `stale_after`. All of this stays in git HEAD and the backup.
     - Nothing is deleted. `log.md` is left untouched.
   - **A: keep the edits.** In the in-app assistant, tell it to use **only the `write_concept` MCP tool** to rewrite the 3 paths with every argument:
     - Arguments: type, title, description, about, tags, `lifecycle: stable`, sources, stale_after, and the body unchanged. Any argument left out is dropped (lifecycle becomes draft, type becomes Reference).
     - Check every file against the manifest; all must print True: `python3 -c "import json,hashlib;r='/Users/joseflagorio/Documents/test/';m=json.load(open(r+'.cerebro/projection-manifest.json'))['entries'];[print(p,hashlib.sha256(open(r+p,'rb').read()).hexdigest()==e['content_hash']) for p,e in sorted(m.items())]"`
     - Then click Restore. It changes no file bytes and only closes the mode.
     - Cost: `generated.at` becomes "now" and `log.md` gains 3 more Update lines. Caveat: the revise path has never run on this vault, only in unit tests.
     - For gcs-5's `about`: the `[[arb-4-disposition]]` anchor exists only in commit `812605a`. The self-anchor predates Aug 17.

4. **Relaunch**, since the banner does not re-poll. Confirm it is gone, then turn "Learn on its own" back on.

**What remains after either path**
- `log.md` keeps 6 duplicate "Update" lines. A human:owner `/body` override from seq 179 means **future log entries will never appear in the file**. No in-app fix exists yet (K11).
- There is no safe manual alternative. Any repair has to go through the ledger.

## 3. Root cause

- **Trigger:** creating `types/decision.md` at 11:50:01Z fired the TS schema-recheck lane on exactly these 3 concepts.
  - The lane's `entry.type` lookup does not separate OKF concept types from vault Type docs.
  - gcs-5 was selected through its self-anchor; the tx-6 pair through `[[frb-118-session-1-disposition]]`, which is a Decision concept.
- **Two dev builds, neither holding the writer:**
  - The main checkout (5173) and the Studio worktree (5274, a build before the description change) share the `com.cerebro.app` app data, so both auto-opened the live vault and ran the same queue.
  - The losing process's lock error is discarded (`shadow.rs:118`). `activate()` also drops its own writer when the same vault is re-opened.
  - Why the lock holder lost its writer is not proven: a re-open, a third build, or an orphaned process all fit.
- **The fallback wrote around the ledger:** a writer-less `write_concept` silently takes the legacy file-first path. It writes serde_yaml frontmatter with a fresh `generated.at`, records zero ledger events and applies no policy, while `ledger_status` still reports `valid`.
- **The next launch opened the mode:** at 11:58:53Z (a `tauri dev` restart) the process got the lock.
  - It adopted `log.md` as a human:owner override (seq 179).
  - It refused the 3 concepts as "provenance forgery", recorded `ledger.divergence` (seq 180) and opened the vault-wide mode.
- **Why it stayed stuck for 39 days:**
  - Keep cannot adopt the files: the forgery rule plus the raw-byte vs canonical-byte digest check.
  - The banner hides the files, the reason and the consequences of each button.

## 4. Findings (deduplicated; source F-numbers in parentheses)

| ID | Sev | Area | Finding | Where |
|---|---|---|---|---|
| K1 | High | Write path | Knowledge writes silently fall back to a ledger-less, policy-less file write when no writer is active | src-tauri/src/vault/write.rs:600-626, :692-720, :342-357; src-tauri/src/ledger/shadow.rs:294-306 |
| K2 | High | Ledger core | Re-opening the active vault drops the writer (toggles on each reload); dev Markdown edits trigger reloads | src-tauri/src/ledger/shadow.rs:112-118, :169-175; src-tauri/src/ledger/writer.rs:955-969; src-tauri/src/lib.rs:1478; src/stores/vaultStore.ts:123 |
| K3 | High | Isolation | No single-instance guard; every worktree build shares app data and auto-opens the live vault; lock loss discarded | src-tauri/tauri.conf.json:5; src-tauri/src/lib.rs:40,74; src-tauri/src/ledger/shadow.rs:118 |
| K4 | High | Visibility | ledger_status can't report a missing writer (says `valid`); verdict never rendered; unrecorded windows recurred through Aug 30 | src-tauri/src/ledger/shadow.rs:343-411; src/app/ReconciliationBanner.tsx:17-21; src/lib/ipc.ts:283 |
| K5 | High | Recovery | "Keep my files" can't adopt legacy writes (forgery on `generated`, raw vs canonical digest); a failed attempt poisons the op key | src-tauri/src/ledger/capture.rs:961-967; src-tauri/src/ledger/reconcile.rs:597-606, :854-913; src-tauri/src/ledger/reduce.rs:4584 |
| K6 | High | Write path | Projection writers ignore the open mode and overwrite disk without comparing against the manifest; Verify attests bytes the user never saw | src-tauri/src/ledger/manifest.rs:184-242; src-tauri/src/ledger/concepts.rs:113-222, :323-370; src/pages/KnowledgePage.tsx:311-318 |
| K7 | High | Agents | TS-originated runs (panel, recheck lanes, Agent records) get acceptEdits with no disallowedTools, so native Write/Edit reach knowledge/ | src-tauri/src/agent/mod.rs:640-676, :833; src/agent/useJobRunner.ts:455-508 |
| K8 | Med | Recovery | One vault-wide mode: 3 paths froze capture and crash recovery for all 30; no per-file exits | src-tauri/src/ledger/reduce.rs:761,841; src-tauri/src/ledger/reconcile.rs:256-292, :415-421 |
| K9 | Med | Architecture | Gitignored per-device ledger claims authority over git-synced knowledge; Discard/Pull/merge cause divergence | src-tauri/src/git/commit.rs:21; src-tauri/src/git_commands.rs:142-160; src-tauri/src/ledger/reconcile.rs:441-474 |
| K10 | Med | Capture | Every out-of-band edit is recorded as `human:owner` (TrustedHumanCapture) | src-tauri/src/ledger/capture.rs:806-826, :288, :507; src-tauri/src/vault/watcher.rs:255-261 |
| K11 | Med | Capture | Launch scan adopts piecemeal; the log.md `/body` override has no Clear producer, so the log freezes | src-tauri/src/ledger/reconcile.rs:302-313; src-tauri/src/ledger/reduce.rs:3970-3974, :4360; src-tauri/src/ledger/concepts.rs:815-849 |
| K12 | Med | Recovery | Restore: no confirm, preview or backup; `remove_file` on unexplained .md (not in spec); no exit for migration signals | src-tauri/src/ledger/reconcile.rs:436-474, :461-473; src/app/ReconciliationBanner.tsx:58-64 |
| K13 | Med | UX | Banner counts events not files; no paths, reasons or button consequences; generic "Couldn't save page" | src/app/ReconciliationBanner.tsx:44-65; src-tauri/src/ledger/shadow.rs:363,393; src/editor/NoteBodyEditor.tsx:161 |
| K14 | Med | UX | Banner reads status before the launch scan and never refreshes | src/stores/vaultStore.ts:118-123; src/app/ReconciliationBanner.tsx:16-26 |
| K15 | Med | Capture | Live watcher swallows every capture refusal (`let _`) | src-tauri/src/vault/watcher.rs:260 |
| K16 | Med | Policy | Capture and reconciliation refusals have no code or destiny; per-path reason dropped and signal mislabeled | shared/policy/policy.v3.json; src-tauri/src/ledger/reconcile.rs:330-356; src-tauri/src/ledger/shadow.rs:144 |
| K17 | Med | Guards | Knowledge guard is a string prefix; `./knowledge/`, `Knowledge/` bypass it (twinned in TS) | src-tauri/src/knowledge.rs:30-32; src/engine/okf.ts:30-32; src-tauri/src/mcp.rs:2397,2421,2434 |
| K18 | Med | Lanes | Schema lane collides OKF concept type with vault Type, fires on cosmetic Type edits; Restore re-arms it | src/engine/jobs.ts:167-196; src/lib/prompts.ts:144-157 |
| K19 | Med | Lanes | Recheck through replace-only write_concept: restamps, drops fields, no expected_version, log Update; stale lane can loop; log belief grows O(n²) | src/lib/prompts.ts:125,150; src-tauri/src/mcp.rs:2501,2546; src/engine/jobs.ts:186-192; src-tauri/src/ledger/concepts.rs:840 |
| K20 | Med | Spend | Unattended recheck lanes on by default (autoLearn=true), unlike ambient ingest opt-in | src/stores/uiStore.ts:887; src-tauri/src/ingest/ambient.rs:10 |
| K21 | Med | Trust | Trust read from the file's `verified` field, not ledger attestation; the ledger review axis is computed but unused | src/engine/okf.ts:190-222; src-tauri/src/knowledge.rs:425-451 |
| K22 | Med | Trust | Unverified `supersedes` auto-applies (MEDIUM) and retires a verified concept on the read side | src-tauri/src/ledger/concepts.rs:606-617; src-tauri/src/policy/interpreter.rs:51-59; src/engine/okf.ts:627-697 |
| K23 | Med | Trust | write_concept and cache_source exempt from write and read scope; provenance not served to readers | src-tauri/src/mcp.rs:1246-1256, :1370-1373, :3663-3667 |
| K24 | Med | Parity | Agent labels inconsistent (`trust` key absent, lifecycle dropped, one-way contradictions); Rust/TS concept semantics hand-twinned (dedup, supersedes, stale) | src/agent/systemPrompt.ts:41; src/agent/context.ts:80-101,276; src-tauri/src/knowledge.rs:49-116,683; src/engine/okf.ts:252,847 |
| K25 | Med | Attribution | Proposal counters always 0; synthetic run_id; runLog `files: []` (input cut to 200 chars); app_sessions never written | src-tauri/src/runtime/dispatch.rs:280,758; src-tauri/src/ledger/concepts.rs:406; src-tauri/src/agent/mod.rs:1032; src-tauri/src/runtime/catchup.rs:337-391 |
| K26 | Med | Ledger core | Rewind detection gaps: remembered head lags, replay refusal silently rebuilt, deleting .cerebro re-baselines | src-tauri/src/ledger/shadow.rs:155-163, :320-341; src-tauri/src/ledger/recovery.rs:146-152 |
| K27 | Med | UI | Knowledge surfaces unaware of the mode; reading pane and log turn read failures into empty; pane never re-reads | src/pages/KnowledgePage.tsx:281-318; src/knowledge/KnowledgeLog.tsx:92-102; src/knowledge/BaseItself.tsx:194; src-tauri/src/mcp.rs:1754,1916 |
| K28 | Med | Tests | Mock can't open the mode; no banner vitest or e2e; mock twin rules drift; conformance excludes capture; corpus lacks incident shapes | src/lib/mockIpc.ts:187-238, :568-596; conformance/; demo-vault/knowledge |
| K29 | Med | Capture | No sanctioned rename, move or delete for knowledge; every outside move diverges | src-tauri/src/lib.rs:970-1028; src-tauri/src/ledger/reconcile.rs:73-77 |
| K30 | Med | Docs | Load-bearing comments falsified (e.g. "scan reconciles once a writer returns", "single door") | src-tauri/src/vault/write.rs:612-615; src-tauri/src/ledger/shadow.rs:1-10,288-292; src-tauri/src/knowledge.rs:3-21; src-tauri/src/mcp.rs:15-17 |
| K31 | Med | Status | Coverage events have no producer, so the protected Blindness lane can never clear | src-tauri/src/dynamics/coverage.rs:436-443; src-tauri/src/attention/lanes.rs:616-630 |
| K32 | Low | Ledger core | Divergence body records a stale head; detection key churns with the manifest | src-tauri/src/ledger/reconcile.rs:222,350-397 |
| K33 | Low | Capture | relation_diff uses last-wins on a stem collision; `[[x\|label]]` unresolved | src-tauri/src/ledger/capture.rs:1057; src-tauri/src/ledger/concepts.rs:272; src-tauri/src/ledger/migrate.rs:403 |
| K34 | Low | Ledger core | Writer doesn't fail-stop after a write or fsync error; a torn line becomes Corrupt | src-tauri/src/ledger/segment.rs:207-215; src-tauri/src/ledger/writer.rs:386-429 |
| K35 | Low | Ledger core | ledger_status isn't read-only (can delete the index); unread epistemic tables; vault.write noise in the chain | src-tauri/src/ledger/shadow.rs:346-376; src-tauri/src/ledger/index.rs:252-339 |
| K36 | Low | Detection | Git `Cerebro-Ledger-Head` trailer never read; GitAnchorRegression has no producer | src/git/useGit.ts:322; src-tauri/src/ledger/reconcile.rs:389 |
| K37 | Low | Data | `about` unvalidated: 13/29 self-anchors, 8 dangling, none reach a record | src-tauri/src/mcp.rs:2484; knowledge/systems/kos-3.2-partition-architecture.md:5 |
| K38 | Low | Data | Corpus predates the contracts: 26/29 lack description, 16 mistyped Reference, 0 verified | src-tauri/src/mcp.rs:2464; shared/policy/concept-types.v1.json |
| K39 | Low | UI | "Ask the agent to revise" always sends the stale-recheck prompt | src/knowledge/KnowledgePanel.tsx:404; src/pages/KnowledgePage.tsx:659 |
| K40 | Low | UI | Needs-review count in the always-visible chrome; comment says otherwise | src/knowledge/KnowledgeNav.tsx:150-155 |
| K41 | Low | UI | chipsFor collapses unavailable, loading and absent into null | src/knowledge/useBeliefChips.ts:25-41 |
| K42 | Low | UI | Meter shows token and output partial sums as plain numbers when accounting is unknown | src/status/SystemSection.tsx:88-98 |
| K43 | Low | Agents | `projects` count routes on the literal type name `Project` | src/agent/context.ts:182 |
| K44 | Low | Metrics | Knowledge reads vs writes are unmeasured; distillPrompt never names knowledge_about | src-tauri/src/assembly/ask.rs:272; src/lib/prompts.ts:15-35 |
| K45 | Low | Trust | Governed lifecycle and contest never reach the file, the concept graph or knowledge_about | src-tauri/src/ledger/reduce.rs:457-474 |
| K46 | Low | Debt | TS reducer twin (~3.4k lines, test-only), trigger module, idle ingest/maintain; README says mockIpc consumes the reducer (false) | src/lib/epistemic/reduce.ts; conformance/README.md:6-8; src-tauri/src/trigger/ |

**Notes on each finding**

- **K1** (F1,F5,F9,F30,F40,F46,F55,F69,F89)
  - Problem: when `with_writer` returns None, write_concept, append_log and verify write files directly, and MCP restamps `generated.at`.
  - Impact: this is the direct cause of the incident. Every legacy concept revision or verify is guaranteed to diverge; log appends are captured instead.
  - Fix: refuse with a typed `ledger_writer_unavailable` (operational code), matching commit_proposals and ingest; delete the legacy branches.
- **K2** (F2,F29,F39,F103,F115)
  - Problem: `activate()` opens a second flock while the old Active holds the first; `.ok()` turns the refusal into `writer: None`, and `replace_active` then drops the working writer.
  - Impact: under `tauri dev`, any `.md` edit causes a Tailwind full reload, which switches recording off or on. Aug 31 matches this pattern.
  - Fix: skip the re-open when the same vault already holds a writer. Test activate→activate with no deactivate.
- **K3** (F3,F10,F114,F116)
  - Problem: shared `com.cerebro.app` identifier, `lastVault`, runtime.db and writer id; the lost-lock error is discarded.
  - Impact: on Aug 17 the Studio worktree build rewrote live concepts with an older schema (it stripped descriptions).
  - Fix: per-checkout identifier and data directory in dev; no auto-open in dev; record pid and build on the lock; single-instance guard.
- **K4** (F4,F10,F26,F41,F81,F119)
  - Problem: `status()` classifies from disk and never looks at Active; nothing renders the verdict; the banner turns errors into null.
  - Impact: recording silently stopped at least 8 times (Aug 17–30); a refused verdict shows no banner.
  - Fix: `writer: held|lost_lock|refused|other_vault` in LedgerStatus, a "Not recording" banner, and block knowledge runs while it's shown.
- **K5** (F19,F31,F92,F100,F101)
  - Problem: any `generated` change is treated as forgery; the accept batch pins a raw-byte digest while the reducer checks canonical bytes; the op key depends only on the divergence event.
  - Impact: Keep cannot work here, and a hand-fixed retry leaves refused frames that disable Keep permanently.
  - Fix: accept an `at`-only restamp when `by` matches; adopt as an agent revision; pin the canonical digest via a staged reduce before appending; derive the op key from the plan digest; add a dry-run preflight.
- **K6** (F14,F22,F34,F77,F79)
  - Problem: `write_projection` never compares disk bytes to the manifest; verify attests `belief.current()`.
  - Impact: clicking Verify on gcs-5 today attests Aug 16 text and silently reverts the file (recoverable only from git). Latent: no such write has happened yet.
  - Fix: refuse when disk ≠ manifest; Verify sends the hash of the bytes shown; gate these writers on quarantined paths; correct the banner text.
- **K7** (F6,F11,F58)
  - Problem: only `internal` runs get `--disallowedTools`; everything else gets acceptEdits with cwd = vault, and user-global allow rules are imported.
  - Impact: unattended recheck lanes can Edit `knowledge/`, `log.md` and `.cerebro/`, bypassing every guard.
  - Fix: always disallow Write, Edit, MultiEdit and NotebookEdit unless shell is granted; treat Cerebro-generated lanes as internal; add a CLI probe test.
- **K8** (F24,F36,F90)
  - Problem: `reconciliation_open` is a single flag; Accept aborts on the first bad file.
  - Impact: all human knowledge edits and all crash recovery have been blocked for 39 days.
  - Fix: a per-path quarantine set and per-path decisions; keep the global stop only for the mass-mismatch and migration signals.
- **K9** (F16,F91)
  - Problem: `.cerebro/` is gitignored, while `knowledge/` is tracked; git operations bypass the ledger.
  - Impact: multi-device sync or Discard leads to divergence, and Restore unlinks concepts from the other device. Not the cause here (the vault has no remote).
  - Fix: owner decision Q1; refuse Discard on `knowledge/`; add an "imported from git" capture.
- **K10** (F7,F12,F33,F71)
  - Problem: `actor_id: "human:owner"` is hard-coded.
  - Impact: seq 179 records agent log output as the owner's; agent field edits would become human-assertion support.
  - Fix: record under an `unattributed:out_of_band` actor with unknown authority.
- **K11** (F12,F32,F104,F71)
  - Problem: the scan commits log.md before refusing its siblings; revisions only mark the override stale, and nothing emits `OverrideChange::Clear`.
  - Impact: after either exit, every future log entry is committed to the ledger but never appears in log.md.
  - Fix: all-or-nothing scan capture; treat log.md as system-owned (regenerate, never override); add a Clear producer.
- **K12** (F20,F28,F36)
  - Problem: one click, no snapshot; `remove_file` instead of trash; resolution records no before-hashes.
  - Impact: permanent loss in vaults without autosync, or for uncommitted concepts. Live vault: 3 overwrites, 0 deletes, all in git.
  - Fix: preview diffs, require confirmation, back up to `.cerebro/reconcile-backup/<event>/`, move to trash, style the button as destructive.
- **K13** (F21,F82,F83,F93)
  - Problem: opaque detection keys; sample_paths never reach the UI; the editor catch drops `RECONCILIATION_SUSPENDED`.
  - Impact: the user can't find the 3 files or judge either button.
  - Fix: `{path, reason, class}` in LedgerStatus; list the files; one line per button saying what it keeps and discards; show the real refusal text.
- **K14** (F25,F80)
  - Problem: the banner effect depends only on `vault`; startWatcher is awaited later.
  - Impact: a divergence found during a launch shows nothing until the next launch.
  - Fix: return the scan outcome from start_watcher or emit an event; refresh on `vault-changed`.
- **K15** (F15,F35)
  - Problem: forgery, deletion and suspension refusals all vanish in the watcher.
  - Impact: no signal until a later launch; the overwrite window from K6 stays open.
  - Fix: log the refusal operationally and escalate it the way the launch scan does.
- **K16** (F23,F51,F75)
  - Problem: bare prose errors; the `manifest_reducer_disagreement` signal is emitted even though manifest and reducer agreed.
  - Impact: violates "two records, two destinies"; the reason exists nowhere durable.
  - Fix: codes in policy.v3 (e.g. `untrusted_provenance`, `reconciliation_suspended`); per-path reasons in the event body; a distinct capture-refusal signal.
- **K17** (F13,F47)
  - Problem: the prefix check runs on the raw argument; `safe_join` accepts CurDir; APFS is case-insensitive.
  - Impact: an agent can plant `verified` through update_frontmatter. This is a secondary door; K7 is the main one.
  - Fix: normalize and case-fold the resolved path in one predicate; mirror it in okf.ts; add tests.
- **K18** (F8,F56,F68,F102)
  - Problem: typeDocs are keyed by title; `about` resolves over concepts too; the trigger is mtime.
  - Impact: 6 Opus runs ($5.20) on Aug 17; Restore re-queues the same 3.
  - Fix: only about-targets outside `knowledge/`; skip self-anchors; key on a schema hash.
- **K19** (F57,F60,F62)
  - Problem: "change nothing else" goes through a full replace; no expected_version; runKey = mtime.
  - Impact: anchor and `stale_after` flip-flops, spurious HIGH cards on verified concepts, possible paid recheck loops, and 23.5% of ledger bytes are log.md.
  - Fix: a `recheck_concept {path, verdict, stale_after, expected_version}` tool; no restamp or log line when nothing changed; make log.md a derived view.
- **K20** (F63)
  - Problem: autoLearn defaults on, and the lanes' `enabled_by_default` = 1.
  - Impact: unasked spend and unasked knowledge rewrites.
  - Fix: put the lanes behind the same opt-in as ambient ingest.
- **K21** (F107)
  - Problem: `parseVerified` and `trust_tier` read the file; `facets[].review` goes unused.
  - Impact: a refused forged stamp still reads as human-reviewed to the UI and to agents (latent).
  - Fix: derive review state from `belief.attested` plus the pinned hash; show "disputed" when the two disagree.
- **K22** (F106)
  - Problem: `edit_relation` targets exclude the attested Belief; readers treat a bare `supersedes` field as retirement.
  - Impact: an agent can retire human-verified knowledge in the UI and in agent context without a human card.
  - Fix: route through `supersede_belief` (HIGH floor for attested targets); treat supersession as "proposed" until reviewed; guard against cycles.
- **K23** (F108)
  - Problem: `write_target` omits both tools; the comment claiming "knowledge has its own guard" is false.
  - Impact: a `scope: []` run can replace any unattested concept, even one it cannot read.
  - Fix: a knowledge grant axis; require read access to the concept being replaced; serve `sources` and `generated.by` to readers.
- **K24** (F61,F109,F112)
  - Problem: the prompt names a `trust` field the snapshot doesn't have; `trust_tier` mirrors a TS function that was deleted; the stale rule is twinned.
  - Impact: agents can quote deprecated or contradicted claims as current; the write-time warning and the UI disagree.
  - Fix: one Rust-generated concept label served to both the snapshot and knowledge_about; put stale semantics in shared/policy.
- **K25** (F64,F72,F117,F118)
  - Problem: counters are inserted as 0 and never updated; run_id is head-derived; tool input is truncated before parsing.
  - Impact: violates "absent is never zero"; the incident could not be attributed from Cerebro's own records.
  - Fix: thread the run id into proposals; show "not recorded"; persist written paths in Rust; wire app_sessions with pid and build.
- **K26** (F43)
  - Problem: `remember()` runs only in `record()`; there is no ancestor check when head > seen; replay errors trigger a rebuild.
  - Impact: a backup restore or `rm -rf .cerebro` goes undetected and re-baselines, forgeries included.
  - Fix: remember after every append; check the ancestor hash; turn a replay refusal into a divergence signal; remember the store id per vault path.
- **K27** (F78,F84,F85,F110)
  - Problem: chips, lanes, "What changed", reading pane, log and MCP reads ignore the mode and swallow errors.
  - Impact: provenance for Aug 16 is shown under the Aug 17 body; "Nothing logged yet" can mean the read failed.
  - Fix: a per-concept "disk differs from recorded history" marker; tagged unavailable states; include modifiedAt in the effect deps.
- **K28** (F18,F27,F48,F49,F50,F52,F76)
  - Problem: the mock's ledgerStatus is hard-coded closed; its mock rules check key presence and raw alias strings.
  - Impact: the incident path has never been rendered or replayed in any test.
  - Fix: a `__cerebroSeedLedgerStatus` hook; banner vitest and e2e specs; a ledger-backed fixture vault reproducing Aug 17; mock uses `normalizeAliasV1`.
- **K29** (F17)
  - Problem: humans and MCP both refuse moves; no event changes a belief's path; `tombstone_belief` is behind a disabled flag.
  - Impact: tidying up in Finder or Obsidian opens the banner.
  - Fix: a ledger-backed move/retire action; adopt a same-hash rename.
- **K30** (F98)
  - Problem: comments promise reconciliation, visibility and a single write door.
  - Impact: maintainers and agents were misled on exactly the incident path.
  - Fix: delete or rewrite them in the same commits as K1, K2, K4 and K7 (the AGENTS.md retired-workaround rule).
- **K31** (F94)
  - Problem: coverage producers were deferred and never built (~2.1k lines).
  - Impact: a permanent protected alarm the user cannot clear.
  - Fix: keep NoAssessments out of the Blindness lane, or delete the family.
- **K32–K46** are low severity. The fixes are as stated in the source findings (F37, F38, F44, F45/F96, F42, F59/F74, F73, F65, F66, F86, F87, F88, F111, F113, F53/F95/F97).

**Corrections to the incident facts**
- gcs-5's self-anchor already existed on Aug 16. The Aug 17 runs flipped it to `arb-4` and back (F105).
- Restore loses 2 `stale_after` values, not 3.

## 5. Remediation plan

- **M49.1 Fail closed** (K1, K2, K30)
  - Scope:
    - writer-less write_concept, verify and append_log refuse with `ledger_writer_unavailable` (operational destiny in policy.v3);
    - delete the legacy branches;
    - make `activate` idempotent for the same vault and never replace a live writer with None;
    - kill the falsified comments.
  - Proof: Rust tests `activate_twice_keeps_writer`, `write_concept_without_writer_refuses_and_writes_nothing`; an incident fixture (legacy restamp) can no longer be produced.
- **M49.2 Writer visibility and isolation** (K3, K4, K14, K25 sessions)
  - Scope:
    - LedgerStatus reports `writer` state and reason;
    - a "Not recording" banner, with agent knowledge runs blocked while it shows;
    - banner refresh on a scan event;
    - per-checkout dev identifier, no dev auto-open;
    - lock file records pid and build;
    - app_sessions wired;
    - Tailwind `source('../src')`.
  - Proof: a second `LedgerWriter::open` reports `lost_lock`; a banner vitest covers each writer state.
- **M49.3 Guard projection writes** (K6, K15)
  - Scope:
    - `write_projection` refuses when disk ≠ manifest;
    - Verify pins the viewed hash;
    - writers refuse on quarantined paths;
    - watcher refusals are logged and escalated.
  - Proof: tests that Verify and write_concept on a divergent path refuse and the disk bytes are unchanged.
- **M49.4 Close agent side doors** (K7, K17, K10, K23)
  - Scope:
    - disallow native write tools unless shell is granted;
    - canonical knowledge-path predicate shared with okf.ts;
    - out-of-band actor = unattributed;
    - knowledge write grant axis.
  - Proof: argv plus a real-CLI Edit probe; tests for `./knowledge/`, `Knowledge/` and `knowledge/../knowledge`; capture actor assertion.
- **M49.5 Recoverable exits** (K5, K8, K11, K12, K29)
  - Scope:
    - per-path quarantine;
    - adopt-as-agent-revision;
    - canonical-digest adoption with a dry-run preflight;
    - op key derived from the plan;
    - Restore backs up and trashes;
    - log.md system-owned, plus a Clear producer;
    - content-hash move detection.
  - Proof: the Aug 17 fixture resolves by Keep **and** by Restore; Restore never unlinks; log entries appear after resolution.
- **M49.6 Say why** (K13, K16, K27, K28)
  - Scope:
    - per-path reasons in the event and in LedgerStatus;
    - count files, not events;
    - policy codes for suspension and forgery;
    - real refusal text in toasts;
    - disputed markers on surfaces and in MCP reads;
    - seedable mock plus e2e.
  - Proof: e2e spec covering open mode, Keep refusal text, Restore closing the mode, and a failed status read showing unavailable.
- **M49.7 Lane hygiene** (K18, K19, K20, K37)
  - Scope:
    - schema lane limited to targets outside knowledge/, keyed on a schema hash;
    - `recheck_concept` stamp-only tool with expected_version;
    - autoLearn opt-in;
    - refuse self-anchors; validate `stale_after`;
    - log idempotent or derived.
  - Proof: fixture where a new Type "Decision" produces 0 jobs; a no-op recheck gives 0 restamps and 0 log lines.
- **M49.8 Trust read side** (K21, K22, K24, K45)
  - Scope: review state from attestation; gated supersession; one agent-facing concept label; governed lifecycle projected.
  - Proof: a forged `verified` reads as disputed; an unverified `supersedes` on an attested target is queued HIGH.
- **M49.9 Attribution** (K25, K44)
  - Scope: run_id threading, counters, written paths, tool counts.
  - Proof: a run row shows the applied count equal to its ledger commit sets.
- **M49.10 Debt and ledger hardening** (K26, K31–K36, K46)
  - Scope: remembered-head fixes, writer fail-stop, read-only status, drop the vault.write shadow events, trailer detector or deletion, the scope cuts from Q5.
  - Proof: injected ENOSPC test; `rm .cerebro` re-mint is flagged.

## 6. Design questions for the owner

1. **Which is the authority, files or ledger?** Either files win (the ledger becomes an audit trail of observed states and never refuses or deletes), or the ledger wins (it must become portable, and git operations on `knowledge/` go through it). The current hybrid is what makes this kind of incident unrecoverable.
2. **Should knowledge sync across devices via git?** If yes, Q1 has to come out "files win", or the ledger has to be committed or synced.
3. **Should background recheck lanes exist at all?** Options: keep them opt-in (same switch as ambient ingest), or retire the TS stale/schema lanes in favour of the M27 staleness lane.
4. **Is `log.md` a belief or a derived view?** And should non-knowledge `vault.write` hashes stay in the tamper-evident epistemic chain, or move to runtime.db?
5. **Scope cut:** about 15k lines (TS reducer twin, trigger module, coverage family, idle ingest/maintain) have never produced a record on this vault. Cut them or feature-gate them so M49 ships faster, or keep them?
