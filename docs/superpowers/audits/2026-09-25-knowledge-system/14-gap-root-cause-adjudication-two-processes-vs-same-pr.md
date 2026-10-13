# Follow-up: Root-cause adjudication: two processes vs same-process reopen (contradictory, both unverified)

> Audit lens `gap:Root-cause adjudication: two processes vs same-process reopen (contradictory, both unverified)` · critic-directed follow-up auditor, each finding adversarially verified

## Summary

Both causes happened on Aug 17. Two Cerebro dev processes from two checkouts ran against the live vault. Each webview kept its own job-run log: the localhost:5173 origin logged runs 721fd174/ee2a46d7/f3e456fa (M33a build, whose rewrites include `description`) and the localhost:5274 origin logged a8e7a828/37769bc1/344cd412 (Studio build from before dedff4b, whose rewrites have no `description`). Neither process recorded a single event, and a two-process race alone leaves one of them with the writer. So the process holding the lock must also have dropped its own writer by re-opening the vault. The Aug 31 04:08:50Z gap had only one dev process, so it was the same-process re-open alone; the most likely trigger is an agent's docs .md edit at 04:00:27Z, which makes the Tailwind Vite plugin reload the page. The dev process running now (pid 70308) holds the lock, and the next webview reload will drop it again. A single-instance guard alone does not fix this.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F114 | critical | yes | Adjudication: on Aug 17 both happened. Two dev processes from two checkouts, and the lock holder had also dropped its own writer by re-opening the vault. Aug 31 was the re-open alone. |
| F115 | high | yes | Under `tauri dev`, an agent editing any tracked Markdown file reloads the user's app, and each reload flips the ledger writer on or off. The dev process running now (pid 70308) will lose its writer on the next reload. |
| F116 | high | yes | Every build from every worktree shares the com.cerebro.app app data (lastVault, runtime.db, writer id), so a second checkout's dev build auto-opens the user's live vault and runs its own agents against it |
| F117 | medium | yes | app_sessions, the table that would have shown process overlap, has no production writer, and runtime.db has no process identity at all |
| F118 | medium | yes | The job run log records `files: []` for every write_concept run, because tool input is cut to 200 characters before it is parsed |
| F119 | medium | yes | Writer-less windows kept happening after Aug 17: 8 autosync commits contain Cerebro writes the ledger never recorded, and nothing noticed because only knowledge/ projections are checked |

### F114 — Adjudication: on Aug 17 both happened. Two dev processes from two checkouts, and the lock holder had also dropped its own writer by re-opening the vault. Aug 31 was the re-open alone.

- **Severity (claimed):** critical
- **Category:** root-cause-adjudication
- **Verification:** survived (partially_confirmed/high, confirmed/high)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:118`
  - `src-tauri/src/ledger/shadow.rs:169`
  - `src-tauri/src/ledger/shadow.rs:274`
  - `src-tauri/src/lib.rs:1478`
  - `src/App.tsx:298`
  - `~/Library/WebKit/cerebro/WebsiteData/Default/F_gqFcoz-*/LocalStorage/localstorage.sqlite3 (origin localhost:5274)`
  - `~/Library/WebKit/cerebro/WebsiteData/Default/v72gHfXE-*/LocalStorage/localstorage.sqlite3 (origin localhost:5173)`

**Evidence**

(1) Two processes. The WebKit origin files decode to port 0x1435=5173 and 0x149a=5274. `cerebro.runLog` in the 5173 store holds the durableIds 721fd174, ee2a46d7 and f3e456fa. The 5274 store holds a8e7a828, 37769bc1 and 344cd412. These are the two overlapping chains in runtime.db `runs` (11:50:08→11:57:44Z and 11:50:09→11:56:56Z). JobRunnerHost is mounted once per window, and tauri.conf.json declares one window, so two chains means two webviews. (2) Two builds. Chain B (5274) rewrote gcs-5 in commit 812605a and np-shared in e3543b4 with NO `description:`. Chain A (5173) added `description:` in 1c8c9e9 and e1770e4. That matches `git merge-base --is-ancestor dedff4b` = no for the m34-design-studio commits 3451319 and 6784fff. The 5274 build was the Studio branch: prototypes/pricing-page was scaffolded into the live vault at 04:49 PDT, and app-data studio/cache was created at 04:50 PDT (11:50Z). Studio code existed only on m34-design-studio then. (3) Neither process had a writer. Zero ledger events between seq 178 (00:10:35Z) and 179 (11:58:53Z), although types/risk.md, types/decision.md and 4 prototype files, all shadow-recorded paths, were written at 11:49-11:50Z. A lock that one process holds leaves only the other process writer-less. Both being writer-less needs the holder to have dropped its own writer (activate → try_lock on a second fd → WouldBlock → writer None → replace_active drops the old writer and its lock). writer.rs `the_lock_admits_exactly_one_writer` proves the same-process refusal, and every shadow.rs test calls deactivate() before activate(). (4) The 11:58:53.806Z scan that did get the lock came 18.7s after the first src-tauri edit in the 5173 checkout (runtime/schema.rs at 11:58:35.085Z by subagent a72e). That fits a `tauri dev` rebuild-and-restart that found the lock free. (5) Aug 31: only one dev origin was in use. The 5274 store has been unchanged since Aug 17 18:00 PDT. The only tauri Vite was pid 31504 on 5173, serving the m44 worktree (lsof at 02:04:33Z). There were no Rust edits and so no restart between 04:00:18.9Z (last event) and 04:08:50Z (unrecorded test.md), which rules out a second launch.

**Impact**

Either fix alone leaves the incident reproducible. A single-instance guard would not have prevented Aug 31, and an idempotent activate would not have prevented the 5274 process from running writer-less on Aug 17. The two builds also wrote different schemas: one wrote descriptions and the other stripped them, and each overwrote the other's concept rewrites.

**Recommendation**

Ship both fixes. (a) Make activate idempotent: if ACTIVE already holds the same normalized vault with a writer, keep it (only re-run the watcher). Never drop a working writer for a failed re-open, and add a test for activate→activate without deactivate. (b) Refuse knowledge writes and show a blocking banner whenever the writer is absent, instead of the silent legacy fallback. Add a per-vault single-writer check at launch that names the other process.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - Two processes on Aug 17: CONFIRMED. The WebKit origin files decode to localhost:5274 (0x149a) and localhost:5173 (0x1435). Each store's `cerebro.runLog` holds a different set of durableIds (5274: a8e7a828, 37769bc1, 344cd412; 5173: 721fd174, ee2a46d7, f3e456fa). runtime.db `runs` shows those as two overlapping chains over the same 3 concepts.
- Two builds: SUPPORTED. The 5274-timed commits (812605a, e3543b4) add no `description:`. The 5173-timed commits (1c8c9e9, e1770e4) add one. Each overwrote the other's `generated.at`.
- Both were writer-less: SUPPORTED. With no writer, `concepts::write_concept`/`append_log` return None and the caller writes the file directly, stamping `generated`. With a writer, a failure returns Err and nothing is written. So files written by both chains with zero ledger events means neither process had a writer. Fail-stop only happens after a failed rotation, and there is 1 segment at 273/1024 records, so it is ruled out.
- Same-process re-open mechanism: REAL in code. `start_watcher` calls `activate` with no guard. A webview reload runs App.tsx:298 → openVault → start_watcher, and re-picking the vault (App.tsx:163, SettingsPage:100) does the same. `activate` then opens a second fd, `flock` returns WouldBlock, the writer is None, and `replace_active` drops the live writer and its lock. A vault switch does not trigger this.
- OVERSTATED: "Both writer-less needs the holder to have dropped its own writer." The claim skips a third lock holder. ~/Library/WebKit/com.cerebro.app is a packaged-build WebKit store, born 2026-08-16 06:21 PDT, with ResourceLoadStatistics written 2026-08-17 05:52 and 17:56 PDT. So a bundled Cerebro process was alive around the incident. Whether it held test's lock at 11:49–11:58Z cannot be shown either way. An orphaned earlier dev process is another candidate. The re-open on Aug 17 is therefore a plausible inference, not an established fact.
- Aug 31 "re-open alone": consistent with the code. It is the only remaining path that drops a live writer for the same vault. But it is inferred, not observed.
- Severity: high rather than critical. The defect is real and systemic: `activate` is not idempotent, there is no single-instance guard, and a writer-less write_concept falls back to writing the file silently. The root-cause split is still uncertain.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:113-119: `LedgerWriter::open(&vault,&id).ok()`. The comment says "A held lock (second instance) lands in the None arm".
- shadow.rs:168-174 `replace_active(Active{writer,...})`, and shadow.rs:236-240: replacing drops the old writer and releases its flock.
- writer.rs:955-966: `acquire_lock` uses flock `try_lock`, which returns WouldBlock. writer.rs:1087 `the_lock_admits_exactly_one_writer` shows the refusal within one process.
- writer.rs:46: SEGMENT_MAX_RECORDS=1024. The ledger dir has one segment with 273 records, so no rotation and no fail-stop.
- lib.rs:1478: start_watcher calls activate unconditionally. vaultStore.ts:117-123: openVault always calls startWatcher. App.tsx:298 (boot), :163, SettingsPage.tsx:100.
- concepts.rs:67-79 / 82-92: returns None without a writer, and the caller writes the file directly.
- WebKit origin bytes: `...localhost\x01\x9a\x14` = 5274 in F_gqFcoz; `\x35\x14` = 5173 in v72gHfXE. runLog decoded (UTF-16) from copies.
- runtime.db runs: 721fd174 11:50:08→11:52:08, a8e7a828 11:50:09→11:51:38, 37769bc1, ee2a46d7, 344cd412, f3e456fa.
- Vault git: 812605a 04:51:37 PDT and e3543b4 04:56:52 add no description. 1c8c9e9 04:52:09 and e1770e4 04:57:42 add `+description:`.
- Ledger: seq 178 at 2026-08-17T00:10:35Z, then seq 179/180 at 11:58:53–54Z. seq 273 at 2026-08-31T04:00:18.9Z. records/bets/test.md was modified later and committed 5b5b6b5 21:10 PDT with no event.
- Competing holder: ~/Library/WebKit/com.cerebro.app/WebsiteData/ResourceLoadStatistics. Born 2026-08-16T06:21:25-0700; observations.db modified 2026-08-17T05:52:48-0700; the -wal modified 2026-08-17T17:56:25-0700. This is a packaged-build process the claim did not rule out.

**Correction.** - Established: on Aug 17, two dev webviews/processes (5173 and 5274, different builds) ran the same three schema jobs concurrently, and neither had a ledger writer, so write_concept fell back to writing files directly.
- Real in code: `activate` is not idempotent, and any re-open of the same vault in one process (a webview reload or re-picking the vault) silently drops that process's own writer.
- Not established: that this re-open is why the lock holder lost its writer on Aug 17. A third holder fits the evidence equally well: a packaged com.cerebro.app build demonstrably alive Aug 16–17, or an orphaned dev process.
- Aug 31 as a single-process re-open is consistent with the code but inferred.
- The fix conclusion stands: a single-instance guard and an idempotent activate are both needed, and a writer-less write_concept should refuse rather than write the file directly.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Two processes on Aug 17: confirmed.** The two WebKit origin files decode to localhost:5274 (0x149a) and localhost:5173 (0x1435). Each store's `cerebro.runLog` holds exactly the three durableIds the claim names. runtime.db `runs` has the two interleaved chains, 11:50:08→11:57:44Z and 11:50:09→11:56:56Z. Commit times match run end times (812605a at 11:51:37 against a8e7a828 ending 11:51:38; 1c8c9e9 at 11:52:09 against 721fd174 ending 11:52:08). The 5274 commits drop `description:` and the 5173 commits add it, so each process overwrote the other.
- **Both processes writer-less: confirmed by code.**
  - `vault::write::write_concept` goes ledger-first through `with_writer` and falls back to writing the file directly only when it gets `None`.
  - A writer that exists but whose append fails returns `Some(Err)`, and then the file is never written.
  - The files were written and 0 events were recorded, so neither process had a writer.
- **Same-process reopen drops the writer: confirmed and reachable.**
  - `activate` has no "already active for this vault" guard. It calls `LedgerWriter::open`, which calls `acquire_lock`. That is `flock` on a new fd, so it hits WouldBlock against its own lock and the writer is `None`. `replace_active` then drops the old writer and releases the lock.
  - The trigger is `start_watcher` (lib.rs:1478), which runs on every `openVault`. In dev that happens on every webview reload or Fast Refresh remount of App's boot effect. In production it happens when the user re-picks the open vault.
  - Nothing guards against this.
- **No third holder: confirmed.** `/Applications/Cerebro.app` is not installed, and the prod WebKit dir holds only a salt from Aug 16.
- **Aug 31 single origin: supported.** The 5274 store mtime is Aug 17 18:00 PDT, and only two origin dirs exist. Commit 5b5b6b5 at 04:10Z is unrecorded after seq 273 at 04:00Z.
- **Could not re-verify now:** the 11:58:35Z src-tauri edit timing and the historical lsof. That the Aug 17 holder lost its writer through a reopen, rather than some other path, is inferred. It is the only code path found that leaves a live lock holder with no writer and then releases the lock.
- **Severity:** high rather than critical. The ledger is disabled silently and knowledge writes fall back to direct file writes. No data is destroyed until the user resolves the divergence.

**Evidence checked.** - ~/Library/WebKit/cerebro/WebsiteData/Default/F_gq*/…/origin: bytes `9a14` = 5274. The v72g* origin file has `3514` = 5173.
- runLog: the F_gq (5274) store holds 344cd412, 37769bc1, a8e7a828. The v72g (5173) store holds 721fd174, ee2a46d7, f3e456fa. The 5274 localstorage.sqlite3 mtime is Aug 17 18:00:59 local.
- runtime.db `runs` shows six attended runs between 11:50:08Z and 11:57:44Z, all with proposals_submitted=0 and applied=0.
- Vault commit diffs: 812605a and e3543b4 have no `+description`. 1c8c9e9 and e1770e4 add `+description:`.
- Write path:
  - vault/write.rs:600-615: `write_concept` goes through `ledger::concepts::write_concept`, which returns `None` without a writer, and then writes the file directly.
  - ledger/concepts.rs:68-80 calls `shadow::with_writer`.
  - shadow.rs:311-323: `record` returns silently when writer is `None`.
- Reopen path:
  - shadow.rs:81-175: `activate` has no idempotency check. `LedgerWriter::open(...).ok()` feeds `replace_active`.
  - shadow.rs:274: `replace_active` overwrites the guard, which drops the old writer.
  - writer.rs:955-970: `acquire_lock` opens a new fd and calls `try_lock`, returning Err "another Cerebro instance…" on WouldBlock.
  - writer.rs:1087 `the_lock_admits_exactly_one_writer` shows a same-process second open is refused.
- Reopen trigger:
  - lib.rs:1471-1480: `start_watcher` calls `shadow::activate`.
  - vaultStore.ts:123: `openVault` calls `startWatcher`.
  - App.tsx:290-305: the boot effect calls `openVault(last)`.
- Other holders: /Applications has no Cerebro.app, and ~/Library/WebKit/com.cerebro.app holds only a salt (Aug 16).
- Ledger tail: seq 273 at 2026-08-31T04:00Z, then vault commit 5b5b6b5 "Update test" at 04:10:12Z with no event.

</details>

### F115 — Under `tauri dev`, an agent editing any tracked Markdown file reloads the user's app, and each reload flips the ledger writer on or off. The dev process running now (pid 70308) will lose its writer on the next reload.

- **Severity (claimed):** high
- **Category:** recurrence
- **Verification:** survived (confirmed/high, confirmed/high)
- **Locations:**
  - `node_modules/@tailwindcss/vite/dist/index.mjs (hotUpdate, v4.3.3)`
  - `src/App.tsx:298`
  - `src/stores/vaultStore.ts:123`
  - `src-tauri/src/lib.rs:1478`
  - `src-tauri/src/ledger/shadow.rs:118`
  - `src-tauri/src/ledger/shadow.rs:169`

**Evidence**

In @tailwindcss/vite 4.3.3, `hotUpdate` exempts only /^\.[cm]?[jt]sx?$/ and CSS. Any other file Tailwind scanned and watched through addWatchFile gets `hot.send({type:'full-reload'})`. The oxide scanner ignores only css/less/lock/sass/scss/styl, so tracked .md files (docs/superpowers/**, AGENTS.md, demo-vault/**) are scanned. Each reload re-runs App.tsx:298 openVault(last) → vaultStore.ts:123 startWatcher → lib.rs:1478 activate, and activate has no already-active check. React Fast Refresh also re-runs `useEffect(...,[])` whenever an HMR update reaches App. The timings match: the M48 agent edited docs/superpowers/specs/2026-08-30-cerebro-m48-page-layout-design.md at 04:00:27.165Z, 8.3s after the last ledgered write (seq 273, 04:00:18.9Z). The unrecorded test.md write followed at 04:08:50Z, and the only other edits in that window were CSS and *.test.tsx files, which cannot trigger a reload. Before the 00:09Z unrecorded home/untitled.md, the agent edited the M47 spec .md at 00:04:59, 00:05:14 and 00:05:19, and vite.config.ts (which restarts Vite) at 00:07:44. On Aug 17 the main checkout saw about 13 .md edits and many src-tauri restarts overnight; the last before the incident were .md edits at 04:39:16Z and 04:39:25Z. Current state: `lsof .cerebro/ledger/lock` shows pid 70308 (target/debug/cerebro, Vite pid 70174 from /Users/joseflagorio/Development/cerebro) holding fd 6w on the lock and 7w on the segment.

**Impact**

The ledger writer's state depends on how many reloads have happened since launch, and the user cannot see it. Every docs commit by any agent in the checkout the user runs from turns recording off (or back on). Knowledge writes in an 'off' phase take the legacy fallback and trip divergence at the next launch.

**Recommendation**

Make activate idempotent (see the first finding). As a stopgap, set the Tailwind source to `@source not` docs/, demo-vault/ and *.md, or `@import 'tailwindcss' source('../src')`. Never point a dev build at a real vault. Surface writer-held in the UI chrome.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** I could not refute the claim. I read each link in the chain and all of them hold.
- **Nothing blocks a second activate.** `activate` (shadow.rs:82) has no already-active check. It calls `LedgerWriter::open` while the old Active still owns the lock fd. Only after that does `replace_active` (shadow.rs:274) drop the old writer, which releases the lock.
- **The lock refuses a second open in the same process.** `acquire_lock` (writer.rs:955) does a fresh `open()` and then `File::try_lock` = `flock(LOCK_EX|LOCK_NB)`. On macOS, flock locks belong to the open file description, not the process, so a second fd in the same process gets WouldBlock.
- **So the writer alternates on every activate.** Activate N+1 fails the lock, installs `writer: None`, and drops the old writer (lock released). Activate N+2 finds the lock free, opens it and runs launch_scan (writer on).
- **The tests match this.** Every activate in the shadow.rs tests is preceded by `deactivate()`.
- **Every reload reaches activate.** The effect at App.tsx:298 calls `openVault(last)`. That calls `ipc.startWatcher` (vaultStore.ts:123), which runs `start_watcher` (lib.rs:1478), which calls `ledger::shadow::activate` unconditionally.
- **Tailwind turns a .md edit into a full reload.** `@tailwindcss/vite` is 4.3.3 and `src/styles/index.css` has a bare `@import 'tailwindcss'` with no `source()`. That means the scan root is the Vite root with `**/*`, and every scanned file is registered through `addWatchFile`. Vite 7.3.6 (`createFileOnlyEntry`) gives those file-only nodes `type="asset"`. That passes the check at the top of `hotUpdate`. The check exempts only `/^\.[cm]?[jt]sx?$/` and CSS, and any other scanned file gets `hot.send({type:'full-reload'})`.
- **Nothing filters the .md files out.** vite.config.ts sets no `server.watch.ignored`. `docs/superpowers`, `AGENTS.md` and `demo-vault` are not gitignored, so the scanner covers them.
- **The live state fits.** `lsof` on the vault lock shows cerebro pid 70308 holding fd 6w. It was launched 19:57:58 today with Vite pid 70174 on :5173 from this checkout, so its writer is on now and the next reload will drop it.

What I did not check and what I would add:
- I did not check the exact edit timestamps (04:00:27 spec edit, 04:08:50 test.md). They are consistent with the ledger tail: seq 273 at 04:00:18.9Z is the last event.
- The Fast Refresh sub-claim is somewhat overstated: effects re-run only when App's module itself is re-executed, not on every HMR update.
- The bug is not dev-only. SettingsPage.tsx:100 (`openVault(picked)`) re-picking the already-open vault also runs start_watcher → activate, and the same toggle happens in a production build.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:82-179: activate has no already-active guard. `LedgerWriter::open(&vault,&id).ok()` runs at ~L118 before `replace_active` at ~L170. A failed open becomes `writer: None`.
- shadow.rs:274-278: `replace_active` swaps the value and drops the old Active, releasing the lock (the doc comment at L25-27 says so).
- src-tauri/src/ledger/writer.rs:948-970: `acquire_lock` opens a new fd and calls `try_lock` (flock EX|NB). WouldBlock returns Err("another Cerebro instance holds this vault's ledger").
- shadow.rs tests (L435-782): every `activate()` comes after `deactivate()`.
- src-tauri/src/lib.rs:1466-1478: `start_watcher` calls `ledger::shadow::activate` unconditionally.
- src/stores/vaultStore.ts:117-123: openVault calls `ipc.startWatcher`.
- src/App.tsx:291-298: the mount effect calls `openVault(last)`.
- src/pages/SettingsPage.tsx:100: a second caller that also reaches activate.
- node_modules/@tailwindcss/vite (v4.3.3) dist/index.mjs `hotUpdate`: requires `modules.every(type==='asset'||id===undefined)`, skips `/^\.[cm]?[jt]sx?$/` and CSS, otherwise sends `hot.send({type:'full-reload'})`. The scanner is built with `{base: vite root, pattern:'**/*'}` when there is no `source()`, and files go through `addWatchFile`.
- node_modules/vite 7.3.6 config.js:34692-34705: `createFileOnlyEntry` sets `mod.type = "asset"`.
- src/styles/index.css:1: `@import 'tailwindcss';`
- vite.config.ts: only `server: {port, strictPort}`, no watch ignore.
- lsof: cerebro 70308 holds fd 6w on /Users/joseflagorio/Documents/test/.cerebro/ledger/lock. ps shows 70308 (target/debug/cerebro) and 70174 (vite, this checkout) both started Sep 25 19:57:5x.
- Ledger tail: last event is seq 273, vault.write at 2026-08-31T04:00:18.904Z.

</details>

<details><summary>Verifier 2: confirmed (severity → high)</summary>

**Reasoning.** - **Toggle is real and I could not refute it.** `activate` tries `LedgerWriter::open` while the previous `Active` is still installed. `acquire_lock` opens a new descriptor and calls `flock(LOCK_EX|LOCK_NB)`. flock is per open-file-description, so this conflicts with the lock the same process already holds, returns WouldBlock, and leaves `writer = None`. `replace_active` then drops the old Active and releases the lock. The next activate succeeds. On/off parity follows exactly.
- **No guard anywhere.** `start_watcher` calls `activate` every time. `activate` never checks whether a writer for this vault is already active. `replace_active` swaps blindly.
- **The reload trigger is real (checked, not assumed).** I ran the oxide scanner read-only on the repo root, which is Tailwind's base because `@import 'tailwindcss'` has no `source()`. It scans 242 .md files, including the M48 spec, AGENTS.md and 140 demo-vault files. Vite 7.3.6's CSS plugin turns `addWatchFile` deps into file-only entries whose importer is the CSS module. Tailwind 4.3.3's `hotUpdate` then sends `full-reload` for any extension that is not JS/TS or CSS. `.md` is never added to the transformed-extension set, because the only .md imports are `?raw` globs and those ids contain `?`.
- **Reload path confirmed.** A full reload remounts App, `App.tsx:298` calls `openVault(last)`, `vaultStore.ts:123` calls `startWatcher`, and `lib.rs` calls `activate`.
- **The user cannot see the state.** `shadow::status` classifies only the on-disk ledger. It never reports whether this process holds a writer.
- **Current state matches the claim.** Pid 70308 (`target/debug/cerebro`) holds fd 6w on `ledger/lock` and 7w on the segment right now. By the mechanism above, the next reload will drop it.
- **Timeline fits.** The last ledger event is seq 273 at 04:00:18.904Z. The M48 spec was committed at 04:00:57Z (32c0f77), consistent with an edit at about 04:00:27.
- **Minor corrections:**
  - Fast Refresh re-runs App's effect only when App.tsx itself (the boundary) is edited, not on any HMR update.
  - The toggle is not dev-only. Re-picking the same vault via `SettingsPage.tsx:100` or `App.tsx:163` also re-runs `activate`, so a production build can flip too.
  - That writes in an 'off' phase go to the legacy fallback comes from the `with_writer` doc comment. That they trip divergence at the next launch is plausible and matches the incident pattern, but I did not trace it end to end here.

**Evidence checked.** - src-tauri/src/ledger/shadow.rs:82-172: `activate` opens a writer via `LedgerWriter::open(&vault,&id).ok()` BEFORE `replace_active`, with no already-active check.
- src-tauri/src/ledger/shadow.rs:274-278: `replace_active` does `*guard = Some(next)`; the drop releases the lock.
- src-tauri/src/ledger/writer.rs:955-970: `acquire_lock` does a fresh `File::open` plus `try_lock` (flock NB), returning "another Cerebro instance holds this vault's ledger" on WouldBlock.
- src-tauri/src/lib.rs:1465-1478: `start_watcher` runs `let _ = ledger::shadow::activate(&dir,&vault_path)` unconditionally.
- src-tauri/src/ledger/shadow.rs:367-408: `status()` reports only the classify verdict and reducer state, with no writer-presence field.
- src/stores/vaultStore.ts:117-123: `openVault` calls `ipc.startWatcher`.
- src/App.tsx:292-305: the boot effect calls `openVault(last)`.
- Other callers: App.tsx:158, App.tsx:163, SettingsPage.tsx:100.
- node_modules/@tailwindcss/vite 4.3.3 `hotUpdate`: exempts only `/^\.[cm]?[jt]sx?$/` and `isCSSRequest`, otherwise sends `hot.send({type:"full-reload"})`.
- vite 7.3.6 config.js:30004-30008: CSS `addWatchFile` imports become `createFileOnlyEntry` deps of the CSS module.
- Oxide scan run at the repo root: 1230 files, 242 .md, including the M48 spec, /AGENTS.md and 140 demo-vault files.
- src/styles/index.css:1: `@import 'tailwindcss';` with no `source()`.
- src-tauri/tauri.conf.json: devUrl localhost:5173, beforeDevCommand `pnpm dev`.
- `lsof -p 70308`: fd 6w on /Users/joseflagorio/Documents/test/.cerebro/ledger/lock and 7w on the .ndjsonl.open segment.
- `ps`: Vite 70174 and cerebro 70308 both started Sep 25 19:57.
- Ledger tail: seq 273 ingested_at 2026-08-31T04:00:18.904Z.
- git: 32c0f77 at 2026-08-30T21:00:57-07:00 touched the M48 spec.

</details>

### F116 — Every build from every worktree shares the com.cerebro.app app data (lastVault, runtime.db, writer id), so a second checkout's dev build auto-opens the user's live vault and runs its own agents against it

- **Severity (claimed):** high
- **Category:** isolation
- **Verification:** survived (partially_confirmed/high, partially_confirmed/high)
- **Locations:**
  - `src-tauri/tauri.conf.json:5`
  - `src-tauri/src/lib.rs:40`
  - `src-tauri/src/lib.rs:74`
  - `~/Library/Application Support/com.cerebro.app/config.json`
  - `~/Library/Application Support/com.cerebro.app/ledger-writer-id`

**Evidence**

config_dir = app_config_dir(), which is keyed by the identifier com.cerebro.app. get_last_vault reads config.json there, which holds lastVault=/Users/joseflagorio/Documents/test. The Studio worktree build (5274) booted straight into the live vault. It scaffolded prototypes/pricing-page there (vault commit f7df8b4) and ran three paid schema rechecks (runs a8e7a828, 37769bc1, 344cd412) that rewrote live concepts. Both processes wrote to the same runtime.db, with interleaved `runs` and `operational_log` rows and nothing to tell them apart. Both also present the same ledger writer id d62256b3…, so even a correctly locked ledger cannot say which build wrote an event. zsh history shows `PORT=5274 pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:5274"}}'` as a habit (lines 1448-1517). A packaged-app store (~/Library/WebKit/com.cerebro.app, created 2026-08-16 06:21 PDT, written until 2026-08-17 17:56 PDT) shows a third build ran on the same app data during this period.

**Impact**

A branch nobody meant to test on real data mutates the user's live knowledge with a different schema contract, and it silently races the main build for the single-writer lock. That race is half of the Aug 17 incident.

**Recommendation**

Give dev builds a per-checkout identifier and data directory (for example, derive the identifier from the worktree path in `tauri dev`). Do not auto-open lastVault in dev builds unless explicitly asked. Record the build SHA and pid on the ledger lock and in runtime.db.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - **The mechanism is real.** There is one fixed identifier, no dev override and no single-instance plugin. Every worktree's `tauri dev` build therefore shares one app-config dir. On boot, each build calls get_last_vault and opens `lastVault`, which is `/Users/joseflagorio/Documents/test`. Each build also reuses the same `ledger-writer-id` (d62256b3…) and the same `runtime.db`.
- **A second instance does worse than the claim says.** It loses the flock, so `LedgerWriter::open(...).ok()` gives None and the ledger stays silent for that process. `write_concept` then falls back to the old file-first path: files are written with no ledger event. That matches the incident exactly (edits on disk, zero events, the commit trailers keep the same head).
- **A worktree build did touch the live vault on Aug 17.** Studio code existed only on a branch then (first commit a4b651e, Aug 16; on main only after the PR #17 merge on Aug 27). The shared `studio/` app-data dir was created Aug 17 04:50 PDT (11:50Z). Vault commit f7df8b4, which scaffolds `prototypes/pricing-page`, landed at 11:50:05Z.
- **The runs are interleaved but can't be attributed.** Six agent runs ran in overlapping pairs 11:50–11:57Z, all with the same `vault_id` and nothing that identifies the process or build. They look like two concurrent chains, but one process could also run two.
- **Overstated parts:**
  - Nothing I found shows the three runs (a8e7a828, 37769bc1, 344cd412) were "schema rechecks", or came from the Studio build rather than their paired runs.
  - "That race is half of the Aug 17 incident" is plausible but not proven. The fallback fires whenever this process has no active writer for the vault. That includes a same-process cause: the active-writer slot is one process-global entry keyed by vault path. So two processes and a same-process no-writer state both remain possible explanations.
  - The zsh history shows the port-5274 habit but has no timestamps, so it cannot place a second build at 11:50Z.
  - The WebKit dir shows the bundle id was used as a packaged/WebKit app. It does not show a third process at 11:50Z.

**Evidence checked.** - `src-tauri/tauri.conf.json:5`: `"identifier": "com.cerebro.app"`, and no other conf file in `src-tauri/`. No single-instance plugin in `Cargo.toml` or `lib.rs`.
- `src-tauri/src/lib.rs:40-42`: `config_dir = app.path().app_config_dir()`. `lib.rs:72-75`: `get_last_vault` reads `app_config::load(config_dir).last_vault`.
- `src/App.tsx:297-298`: `const last = await getLastVault(); if (last && !cancelled) await openVault(last);` so the vault opens automatically on boot.
- `~/Library/Application Support/com.cerebro.app/config.json`: `lastVault` = `/Users/joseflagorio/Documents/test`. `ledger-writer-id` = `d62256b3040f66f44f65d74c91d2b60c` (same file for every build).
- `src-tauri/src/ledger/writer.rs:52` (`WRITER_ID_FILE` lives in config_dir) and `:955-969` (`acquire_lock`: flock try_lock, WouldBlock gives "another Cerebro instance holds this vault's ledger").
- `src-tauri/src/ledger/shadow.rs:115-118`: "A held lock (second instance) lands in the None arm below: shadow stays silent there", via `LedgerWriter::open(&vault,&id).ok()`.
- `shadow.rs:294-300`: `with_writer` returns None when there is no writer or the vault path doesn't match.
- `src-tauri/src/vault/write.rs:606-626`: `write_concept` tries the ledger first, and without an active writer falls back to "Legacy file-first path", writing the file with only a best-effort `shadow_write`.
- `src-tauri/src/mcp.rs:2539-2546`: `tool_write_concept` calls `vault::write::write_concept`, then `append_knowledge_log`, which adds the "**Update**" line.
- `runtime.db` `runs`: 721fd174 / a8e7a828 start 11:50:08 / 11:50:09Z, 37769bc1 / ee2a46d7 at 11:51:42 / 11:52:12, 344cd412 / f3e456fa at 11:54:42 / 11:54:54. All have `vault_id` 5171d169…, mode attended, lane agent, and no build or process column. `operational_log` ids 13-18 are interleaved and indistinguishable. `app_sessions` is empty.
- `vault_registry`: 5171d169… = `/Users/joseflagorio/Documents/test`.
- `com.cerebro.app/studio/` created Aug 17 04:50 PDT. Vault commit f7df8b4 (04:50:05 -0700) adds `prototypes/pricing-page/*` with trailer Cerebro-Ledger-Head 619957fc…
- `git log`: Studio code first appears in a4b651e (2026-08-16, M34.S4a, branch-only at the time).
- `~/.zsh_history` (no timestamps) has repeated `PORT=5274 pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:5274"}}'` and one 5275 variant.

**Correction.** Confirmed: every build and worktree shares the com.cerebro.app app data (lastVault, runtime.db, ledger-writer-id). Any dev build opens the live vault on boot and can run agents against it, and runtime.db rows cannot say which build wrote them. The failure mode is worse than a "race": the losing instance gets no ledger writer, and its knowledge writes silently fall back to the file-first path, which records no ledger event (shadow.rs:115-118, vault/write.rs:606-626). That exactly produces on-disk edits the ledger can't explain. The data shows a Studio-branch build ran on the live vault at 11:50Z Aug 17. It does NOT show that runs a8e7a828/37769bc1/344cd412 were schema rechecks, that they came from that build, or that two processes were running at once. A same-process "no active writer for this vault" state produces the same fallback, so "half of the incident" is a hypothesis, not a finding.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → high)</summary>

**Reasoning.** Reachability is real, and the live data shows it happened.
- **Shared app data:** every build uses identifier com.cerebro.app, so they all share one app-data directory. config_dir() = app_config_dir(), and get_last_vault reads config.json from it. App.tsx boots by calling getLastVault(). Any checkout's dev build therefore opens /Users/joseflagorio/Documents/test automatically.
- **Studio build on the live vault:** only branch m34-design-studio had the prototypes/ scaffolding at the time (commit 6784fff at 05:07 PDT; main got Studio in M40 on Aug 21). That code writes <app_data>/studio and studio-probe-vault. On the live vault:
  - vault commit f7df8b4 (04:50:05 PDT) added prototypes/pricing-page and types/decision.md;
  - app-data studio/ and studio/cache were created at 04:50 on Aug 17.
  So a build of the design-studio branch was running against the live vault and the shared app data.
- **Two processes, not one:** in m34-design-studio, useJobRunner is single-flight (running ref, lines 164-225). Yet runtime.db holds two overlapping attended-agent chains, both on store_uuid 30de3878 and vault_id 5171… (= /Users/joseflagorio/Documents/test), both starting 2-4s after the types/decision.md commit. Both hit the same three concepts, which is only consistent with two processes each enqueuing schema rechecks (schemaRecheckPrompt).
- **Shared writer id:** ledger-writer-id (d62256b3…, dated Aug 7) is one file shared by every build. It matches the live ledger segment's writer prefix, so ledger events cannot tell builds apart.
- **Mis-attributed evidence:** the Aug 17 commit 359c825 records a port-reuse collision, but for e2e, not app data.

Overreach: we cannot attribute the specific run ids to the Studio build. The claim that the race is "half of the incident" is plausible but not proven here: this check did not establish how the lock race led to ledger-bypassing writes.

**Evidence checked.** - src-tauri/tauri.conf.json:5 has identifier "com.cerebro.app".
- src-tauri/src/lib.rs:40-42: config_dir = app.path().app_config_dir(). lib.rs:74-76: get_last_vault reads it. src/App.tsx:297 calls getLastVault() on boot.
- ~/Library/Application Support/com.cerebro.app/config.json holds lastVault=/Users/joseflagorio/Documents/test. ledger-writer-id is d62256b3040f66f44f65d74c91d2b60c, the same prefix as the live ledger segment.
- The same app-data directory holds studio/ (created Aug 17 04:50, runs/ Aug 17 18:02) and studio-probe-vault/ (Aug 16 12:44). m34-design-studio:src-tauri/src/studio/mod.rs:110 and :204 write prototypes/<slug>/ and app_data/studio-probe-vault.
- Vault git history, in PDT:
  - 90437f4 at 04:49:20 added types/risk.md.
  - f7df8b4 at 04:50:05 added prototypes/pricing-page/* and types/decision.md.
  - Then 812605a (04:51:37, gcs-5), 1c8c9e9 (04:52:09, gcs-5), 7658504 (04:54:44, changeover, 2 log lines), e3543b4 (04:56:52, tx-6-np), e1770e4 (04:57:42, tx-6-np).
- runtime.db runs, all attended/agent on vault 5171… and store 30de3878, in UTC:
  - 721fd174: 11:50:08 to 11:52:08
  - a8e7a828: 11:50:09 to 11:51:38
  - 37769bc1: 11:51:42 to 11:54:38
  - ee2a46d7: 11:52:12 to 11:54:50
  - 344cd412: 11:54:42 to 11:56:56
  - f3e456fa: 11:54:54 to 11:57:44
  That is two interleaved chains, and each run's end matches a commit. operational_log ids 13-18 alternate between the two chains, with no process id.
- m34-design-studio:src/agent/useJobRunner.ts:164 and :221-225 show single-flight with running.current, and :336 calls schemaRecheckPrompt.
- ~/.zsh_history has repeated `PORT=5274 pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:5274"}}'` and one for 5275.
- ~/Library/WebKit/com.cerebro.app was created Aug 16 06:21.

**Correction.** The core claim holds, and the data supports it more strongly than the auditor argued. There is one overreach: nothing in runtime.db ties runs a8e7a828, 37769bc1 and 344cd412 to the Studio build in particular. Two single-flight job-runner chains ran at the same time, and both rechecked the SAME three concepts in the same order:
- Chain A: a8e7a828, then 37769bc1, then 344cd412.
- Chain B: 721fd174, then ee2a46d7, then f3e456fa.
Each run's end lines up with a vault commit: 812605a/1c8c9e9 for gcs-5, 7658504 for tx-6-changeover, e3543b4/e1770e4 for tx-6-np. One chain belongs to the Studio-branch build and the other to a second build. The runs table has no process or build id, so we cannot say which chain is which. The same fact also explains the duplicate "**Update**" lines in log.md: two processes each ran the same schema-recheck queue.

</details>

### F117 — app_sessions, the table that would have shown process overlap, has no production writer, and runtime.db has no process identity at all

- **Severity (claimed):** medium
- **Category:** forensics-gap
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/runtime/catchup.rs:337`
  - `src-tauri/src/runtime/catchup.rs:366`
  - `src-tauri/src/runtime/catchup.rs:391`
  - `src-tauri/src/mcp.rs:120`
  - `src-tauri/src/ledger/concepts.rs:406`

**Evidence**

open_session, heartbeat and close_session are called only from catchup.rs tests (lines 878-893). grep finds no other caller since they were introduced in a049a03 (M25.3, 2026-08-14). The docstring at catchup.rs:366 says the heartbeat is 'Called every HEARTBEAT_SECONDS while a vault is open', which is false. app_sessions has 0 rows and catchup_outcomes has 0 rows. `runs.run_id` and `operational_log.run_id` are booked per-spawn ids (for example 721fd174 in both tables). The MCP base-token id from run_id_of is never persisted. Ledger proposal run_ids are head-derived (concepts.rs:406: sha256('cerebro-write-concept-run-v1', krel, head_hash)). No row carries a pid, port, build or writer-held flag. The processes could only be told apart through WebKit per-origin localStorage.

**Impact**

Overlapping instances, crashes and writer loss leave no durable trace. Catch-up's last_closure always returns None, so 'how long was the app closed' is never known. The next incident cannot be diagnosed from Cerebro's own records.

**Recommendation**

Call open_session in start_watcher, heartbeat on a timer and close_session on exit. Add pid, build SHA and writer_held columns, and write a row whenever activate gets or loses the writer. Delete the false docstring if the feature is dropped instead.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - The code is real and has no production caller. `open_session`, `heartbeat` and `close_session` (catchup.rs:337/368/391) are called only by the test at catchup.rs:874-893.
  - A repo-wide grep of src-tauri/src finds no other reference.
  - The other catchup exports that are used in production are `scan`, `plan` and `apply`, all from ingest/driver.rs:112-129.
  - git `-S` shows the functions came in with a049a03 (M25.3, 2026-08-09; the claim says 08-14, a minor date slip).
- The live data agrees: `app_sessions` has 0 rows and `catchup_outcomes` has 0 rows.
- runtime.db has no process identity:
  - No table has a pid, host, build or instance column. The only "version" columns are rule, schema or contract versions.
  - `std::process::id()` shows up only in temp-dir names in git/vault code and tests.
- The claim's MCP detail checks out. `run_id_of` (mcp.rs:120) says the base-token derivation is not a booked run, so it is not persisted.
- The concepts.rs detail checks out. The run_id at concepts.rs:406 is `sha256('cerebro-write-concept-run-v1\0krel\0head_hash')`, so it is derived from the chain head, not the process.
- The closest thing to a process signal is the 0-byte `runtime.db.open` marker (runtime/mod.rs:81, 495-501). It is file-level, it carries no identity, and it is overwritten on every open.
  - Two overlapping instances share one marker, so it cannot show overlap.
  - An unclean shutdown only escalates `quick_check` to `integrity_check`. Nothing about it is recorded: `runtime_health` is empty, and operational_log has only 19 `capability_unavailable` rows.
- `ledger-writer-id` is one static id per install (d62256b3…, Aug 7), not per process.
- The heartbeat docstring at catchup.rs:366 ("Called every HEARTBEAT_SECONDS while a vault is open") is false. It is also a "retired/falsified comment", which AGENTS.md specifically warns against. The module doc at catchup.rs:22 makes the same false claim.
- One detail in the impact is slightly off. `last_closure` does not "always return None"; it is never called in production at all, because its only caller is `open_session`. The effect is the same: the closed interval is never known.
- Severity stays medium. This is an observability gap that blocks diagnosing the incident, not a correctness bug.

**Evidence checked.** - src-tauri/src/runtime/catchup.rs:337 `pub fn open_session`, :366-368 heartbeat docstring and fn, :391 `close_session`, :409 `last_closure`, which only `open_session` calls at :344.
- The only callers are tests at catchup.rs:874-893.
- `grep -rn 'open_session|close_session|heartbeat|last_closure|app_sessions' src-tauri/src` finds only catchup.rs, runtime/mod.rs:166 (a table list), schema.rs:267-280 (DDL) and comments.
- `git log -S'fn open_session'` returns a049a03 2026-08-09 (M25.3).
- `sqlite3 -readonly runtime.db`: `app_sessions`=0, `catchup_outcomes`=0, `runtime_health`=0 rows. operational_log only has capability_unavailable|19. No pid, host, build or instance column appears in any table DDL.
- runtime/mod.rs:81 OPEN_MARKER 'runtime.db.open' is written empty at :501 and removed at :680. It is used only to choose integrity_check (:495) and is never persisted.
- `std::process::id()` appears only in git/commit.rs:162, git/command.rs:178 and vault test helpers.
- mcp.rs:109-122 `run_id_of`: its doc says the base token is never booked.
- ledger/concepts.rs:401-407 derives run_id from krel and head_hash.
- The app-data file `ledger-writer-id` = d62256b3040f66f44f65d74c91d2b60c, dated Aug 7, one per install.

</details>

### F118 — The job run log records `files: []` for every write_concept run, because tool input is cut to 200 characters before it is parsed

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/agent/mod.rs:1032`
  - `src/engine/runLog.ts:165`
  - `src/agent/useJobRunner.ts:586`
  - `src/agent/useJobRunner.ts:244`

**Evidence**

agent/mod.rs:1032 builds the ToolStart `input` as `text.chars().take(200).collect()`. writtenPath (runLog.ts:165-174) JSON.parses that string and returns null on failure. A write_concept call always carries a body, so its input is always longer than 200 characters and never parses. All 6 Aug 17 runLog entries in both webview stores show `"files":[]`, yet vault commits 812605a, 1c8c9e9, 7658504, e3543b4 and e1770e4 show each run rewrote a concept and appended to knowledge/log.md. useJobRunner.ts:244 promises that 'wrote nothing' can be told apart from 'we did not look'.

**Impact**

The one per-run record of what an agent wrote into knowledge/ says it wrote nothing, which is exactly the fact needed to attribute the divergent files. This is the 'absent is never zero' invariant violated in the log.

**Recommendation**

Send the full input (or just the extracted path) in ToolStart, or derive written paths in Rust from the MCP dispatch itself. Render 'unknown' rather than an empty list when parsing fails.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - **The code does what the claim says.** agent/mod.rs builds the ToolStart `input` by serializing the tool arguments with `i.to_string()` and then keeping only the first 200 characters (`text.chars().take(200).collect()`). Cutting a JSON string at 200 characters leaves it invalid.
- **The parser gives up quietly.** `writtenPath` (runLog.ts) runs `JSON.parse` on that string. When the parse fails it returns null, even though it has a `case 'write_concept'` meant to return `path`.
- **write_concept inputs are always too long.** The tool requires both a body and a one-sentence description (mcp.rs:2463-2465), so its input is effectively always over 200 characters. Key order does not matter here: Cargo enables serde_json `preserve_order`, but even with `path` first the cut string still fails to parse.
- **The code path is live.** useJobRunner.ts:584-586 feeds every ToolStart through `writtenPath` into `wrote.current`.
- **The UI shows it as a real outcome.** runLog.ts:129-130 displays an empty list as "Wrote nothing". That breaks the promise in the comment at useJobRunner.ts:244 that "wrote nothing" can be told apart from "we did not look".
- **The live data matches.** I read both webview localStorage stores (F_gq… and v72g…). They hold 6 run-log entries from 2026-08-17 11:51 to 11:57Z, all `trigger: schema`, `status: ok`, `files: []`, for the three concept files that diverged.
- **Those runs did go through write_concept.** Vault commit 812605a changes the frontmatter in the style tool_write_concept writes: YAML re-serialized, and a `generated: {by: claude-code, at: 11:51:31Z}` stamp that the server adds (mcp.rs ~L2501). It also appends to knowledge/log.md, which the tool writes itself (mcp.rs ~L2541).
- **Severity stays medium.** The claim slightly overstates the impact: the vault git autosync commits still let you work out who wrote what. But the run log shown in the UI does state "Wrote nothing" for runs that rewrote concepts.

**Evidence checked.** - **Truncation:** src-tauri/src/agent/mod.rs:1031-1034 `input: b.get("input").map(|i| { let text = i.to_string(); text.chars().take(200).collect() })`
- **Parse and fallback:** src/engine/runLog.ts:165-174 does the `JSON.parse`, and the catch returns null. runLog.ts:186-187 is `case 'write_concept': return str('path') ?? str('folder')`, which the failed parse never reaches.
- **Display:** runLog.ts:129-130 renders an empty list as 'Wrote nothing'.
- **Caller:** src/agent/useJobRunner.ts:584-586 `if (event.kind === 'ToolStart') { const path = writtenPath(event.tool_name, event.input ?? null); ... }`. The promise it breaks is in the comment at L243-247.
- **Required fields:** src-tauri/src/mcp.rs:2463-2465 (body and description are required).
- **Serialization:** src-tauri/Cargo.toml:18 has serde_json with `preserve_order`.
- **Live runLog:** ~/Library/WebKit/cerebro/WebsiteData/Default/{F_gq…,v72g…}/LocalStorage/localstorage.sqlite3, key cerebro.runLog. It has 6 entries dated 2026-08-17T11:51:38Z to 11:57:44Z for gcs-5-supervision-ratio.md, tx-6-changeover-…md and tx-6-np-shared-j12-common-mode.md, all with files=[] and status=ok.
- **Vault commit:** /Users/joseflagorio/Documents/test commit 812605a changes the gcs-5 frontmatter (re-serialized YAML, `generated: by: claude-code at: 2026-08-17T11:51:31Z`) and adds 3 lines to knowledge/log.md. That matches tool_write_concept's server-side stamp and log append.

</details>

### F119 — Writer-less windows kept happening after Aug 17: 8 autosync commits contain Cerebro writes the ledger never recorded, and nothing noticed because only knowledge/ projections are checked

- **Severity (claimed):** medium
- **Category:** recurrence
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/shadow.rs:321`
  - `src-tauri/src/vault/write.rs:367`
  - `/Users/joseflagorio/Documents/test/.git (commits 26da267, 2a53309, c59b190, cc25166, ff0d52a, 499d6c8, 5b5b6b5)`

**Evidence**

I mapped each vault commit's Cerebro-Ledger-Head to a ledger seq and diffed its files against the vault.write events since the previous commit. Commits containing unrecorded writes: 2a53309 (Aug 27 20:53 PDT, types/bet.md and test/bets.list.yml), c59b190 (Aug 28 21:25, records/bets/test.md and types/bet.md), cc25166 and ff0d52a (Aug 29 20:42 and 20:44, types/bet.md tabs), 499d6c8 (Aug 30 17:09, new home/untitled.md), 5b5b6b5 (Aug 30 21:10, records/bets/test.md) and 26da267 (Aug 20, records/agents/new-agent.md). The same paths go through the same shadowed doors (save_note and update_frontmatter call shadow_write), and are recorded at other times (types/bet.md at seq 199-207, test.md at seq 196-197). Recording therefore switched on and off with the writer, not with the code path. `record` returns silently when writer is None (shadow.rs:321-323).

**Impact**

The ledger's claim to be a complete history of vault writes has been false repeatedly for weeks, with no signal to the user. Any knowledge write in those windows would have caused another divergence.

**Recommendation**

Count writes that go unrecorded because no writer is active, and report them through ledger_status and the banner. Treat a writer-less process as degraded mode in the UI, not as normal.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Tried to refute it by content-hash matching instead of trusting the trailer mapping. I sha256'd every blob in every vault commit from 26da267 to HEAD and searched ALL vault.write events for the same path and hash. The claim holds.
- Commits whose bytes appear nowhere in the ledger: 26da267 (records/agents/new-agent.md), f8b79f8 (studio/test/index.md, the 8th commit, left out of the claim's list), 2a53309 (types/bet.md, test/bets.list.yml), c59b190 (records/bets/test.md, types/bet.md), cc25166 and ff0d52a (types/bet.md), 499d6c8 (home/untitled.md), 5b5b6b5 (records/bets/test.md). That is 8. The whiteboard.mmd in 2e54eb0 is unrecorded by design (save_note skips .mmd), so it does not count.
- Every other commit's bytes match a recorded seq. Examples: 933afcd→199, 91fd1c3→200/201, 9e6c6c9→202, 28cd501→205/207, 22b4fec→239, 7bdf5a2→273. So the same paths were recorded before and after the gaps, as the claim says.
- The diffs are Cerebro-UI shaped: layout groups and tabs (M44 work, Aug 27–29), a cerebro-database fence and ::::column (M48, Aug 30), and a new Agent record from the "New agent" template during M34.1 dev on Aug 20. Cerebro's own autosync (useGit.ts) committed them. So they are Cerebro writes, not an external editor.
- The trailer comes from ledger::head(), which reads the on-disk head. The head therefore reflects what was really recorded at commit time.
- Code path checks out: shadow::record returns silently when writer is None (shadow.rs:321-323). activate() leaves writer None when LedgerWriter::open fails; its own comment says "A held lock (second instance) lands in the None arm below: shadow stays silent there". launch_scan only runs inside `if let Some(writer)`.
- Nothing surfaces a writer-less state. LedgerStatus (shadow.rs:349-365) has no field for "this process holds the writer", and the only UI consumer, ReconciliationBanner, reads only reconciliation_open and divergences.
- Launch reconciliation only compares manifest projections (knowledge/), so non-knowledge unrecorded writes can never trip a signal.
- Caveats: the writer-less cause (probably a second instance, e.g. a dev build, holding no lock) is a strong inference from the code, not directly observed. The "any knowledge write would have caused another divergence" part is plausible but untested. Medium severity stands.

**Evidence checked.** - Hash-match script over vault git blobs against .cerebro/ledger/d62256b3...-0000000000000001.ndjsonl.open vault.write events:
  - Unmatched: 26da267, f8b79f8, 2a53309, c59b190, cc25166, ff0d52a, 499d6c8, 5b5b6b5.
  - Matched (examples): 2e54eb0→195/197/198, 933afcd→199, 9e6c6c9→202, 28cd501→205/207, 104cc52→208, d8a9125→225, 22b4fec→239, 7bdf5a2→273.
- Trailers: 2a53309 and 2e54eb0 both carry head 5682f1d4 (seq 198). c59b190 carries seq 199. cc25166 and ff0d52a carry seq 202. 499d6c8 carries seq 225. 5b5b6b5 carries seq 273.
- src/git/useGit.ts:320-323 builds the trailer from ledgerHead(). lib.rs:1455 ledger_head calls ledger::head (mod.rs:134), which reads the ledger from disk.
- src-tauri/src/ledger/shadow.rs:311-323: record() returns when writer is None.
- shadow.rs:113-119: the second instance's held lock makes the writer None, and the comment says "shadow stays silent there".
- shadow.rs:125-148: launch_scan only runs with a writer.
- shadow.rs:349-365: LedgerStatus has no writer-held field.
- src-tauri/src/vault/write.rs: save_note (363-367), update_frontmatter (327-334), create_note (578-590) and save_list (933-946) all call shadow_write.
- Diffs: cc25166 adds layout group-2/tab-2. 5b5b6b5 adds a cerebro-database fence and ::::column. 26da267 adds a type: Agent template.

</details>
