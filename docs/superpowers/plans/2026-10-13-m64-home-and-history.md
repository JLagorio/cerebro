# M64 — Home and History

**Goal.** History shows who did what, folded into sessions and days. Home pulls together what needs you in quiet lanes that say nothing when empty. Reminders you set fire once, even after the app was closed, and reach Notification Center through an honest permission. Meetings become records, an empty vault is offered a starter kit, and two recipes ship as files. The platform step (macOS 14, Tauri 2.12) lands here too.

Roadmap: `2026-10-12-macro-port-roadmap.md`, § M64. House style and rails: the M53–M63 and M70 plans. M62's and M63's names come from their plans (`2026-10-13-m62-agents-query-your-data.md`, `2026-10-13-m63-routines-that-wake-once.md`); neither is built yet.

**Read first (Macro, behaviour only), by part:** .1 `apps/web/src/features/billing-lab` · .2, .2b `crates/activity/src/domain/timeline.rs`, `apps/web/src/features/activity/core/{collapse-runs,contribution-grid}.ts` · .2c `apps/docs/AI/mcp/tools/read-activity.mdx` · .3 `crates/reminders/src/domain/service/dispatch.rs`, `crates/calendar_events/src/domain/reminder_dispatch.rs`, `crates/notification_state/src/lib.rs` · .4, .4b, .4c `crates/work_feed/src/domain/{models,policy,stacking,service}.rs`, `apps/web/src/features/home/queries/{home-date-buckets,home-admission}.ts`, `docs/AGENT_GUIDE/surfaces.md` (Home) · .6 `apps/web/tauri/src-tauri/src/macos_notification_permission.rs` (design only) · .7 `crates/call/src/outbound/ai_call_summarizer.rs` · .9 `crates/system_skills/src/{lib,catch_me_up}.rs`.

## Status

- **Precondition:** M53–M57, M70 and M58–M63 are closed, in that order, with green gates and updated roadmap statuses. They are being built unstaged in this checkout today, so this plan names their finished functions, never today's lines.
- **Built:** nothing. All 9 roadmap parts were scouted against those plans and today's tree (`runtime.db` v18, tauri 2.11.5, no `src/lab`, `src/history` or `shared/starter`). All build. Three split by their own bullets, giving 14 parts.
- **Effort:** 3 S + 4 M + 7 L ≈ 9.8 L; the roadmap said ≈5 L. Re-measured: .2 L → L + L (.2b) + M (.2c); .3 M → L + M (.3b); .4 L → L + L (.4b) + S (.4c); .7 and .8 M → L.
- **Crash risk:** .3 only (schema step).
- **Packaged checks:** .2, .2b, .3, .4b, .5 (the owner's smoke test), .6. **Live checks** (CLI 2.1.250, the owner's isolated login, never the main `~/.claude`): .2c, .7, .9. **Dev-build check:** .8.
- **Schema steps:** one (.3), the next free `user_version` at build time. **New refusal codes:** none. **New CV ids:** one (.1, Q1). **Artifacts:** `tools.v1.json` bumps once (.2c). **New case file:** `reminder-state-cases.json` (.3), prettier-formatted with no digest, plus a twin-registry row. **New crates:** none. .6 depends directly on four objc2 crates already in the lock; .5 moves the tauri family to 2.12.x.
- **demo-vault:** untouched. Specs seed through mock seams; demo operational rows live in `demoOperational.ts`.
- **Closes left-open items:** M58 Q5 ("M64's Activity History reads both as You", .2); BaseItself's false "since the last time anybody looked" (.4b); dismissals and fired reminders leave localStorage (.3); CLIENT-DESKTOP-16's path-keyed body caches (.3).

## Decisions

- **Owner decisions** (roadmap, 2026-10-12), as they bind M64:
  - D0: Macro is read for behaviour only. No copied code, names, prompt text or fixtures; the kit and the recipes are written in new words.
  - D1: single user. Your page writes (`human:me`) and your comments (`human:owner`, M70) both read "You". Agents read as their handle, with their run. A NULL actor reads "not recorded"; bytes changed outside Cerebro read "unattributed".
  - D2 (c): Done marks and reminder claims are operational rows, not page writes, so no `expect_hash`. The kit and the recipes install as create-only batches (M60.6). Undo of a Done removes only the mark that Done set.
  - D3 (a): one new twin, held by data: `reminder-state-cases.json` (.3) holds the mock's reminder claims and Done marks to Rust's rules and words, listed in `shared/policy/README.md`'s twin registry (CV-04 as M60.3 amended it). The session fold and Home's sections and lanes are TS-only, over raw rows both backends feed. Rust's coalescing window and the TS session gap are one 5-minute rule, held by a tripwire. read_activity's words are Rust-only. The mock mirrors every other new Rust refusal word for word; .8's ride `write-doors.json`.
  - D4 (a): read_activity and the recipes ride per-turn `claude -p`. No transport change.
  - D5 (b), D6 (b), D7 (a): untouched. A run whose plan let the shell write reads "shell changes not recorded" in History and in read_activity (M58.1's `writes_booked`).
  - D18: History is the History page plus each page's History tab (M58.4's, merged, never a second one). Home and its lanes are views over pages, and every row opens a page. The kit's database, records, agents and recipes are pages on disk.
  - **Governed types hold:** agents never write Agent pages or Type docs. The kit writes them as your batch, recipes write nothing, and a meeting filing patches only its capture.
  - **D8+, default taken** (roadmap recommendation):
    - D9 (b): pull-only lanes under My work, silent when empty; no nav count, bell or push; Done only on event rows; proposals decided on their own cards; OS banners only for reminders you set (.6: type-level ones, and chips on pages you last wrote). Recorded as an amendment to M43 (.4). The starter offer (.8) is the one explicit, one-time exception (PRODUCT-5).
    - D12 (b): the macOS 14 floor and Tauri 2.12 in one gated part (.5). Its packaged smoke test of navigation, IPC and drag is the owner's step. Plugin-free routes stay the default: .6 posts through objc2, not tauri-plugin-notification.
    - D11 (b), as M61 took it: Home's Done has a toast Undo only. ⌘Z and `e` wait for M65's registry.
    - D10 (b), as M70 took it: a comment counts in History as "commented", never as an edit.
- **Rules:**
  - One part, one commit: `type(scope): sentence (M64.n)`. Each commit deletes the comments it falsifies (CV-11).
  - Parts start on M63's closed tip. Edits anchor by name or text, never line number.
  - The waves are fixed, and parts in a wave share no file.
    - Each part builds in its own worktree, confined to its declared files, with its own e2e `PORT`.
    - cargo runs one at a time with a shared `CARGO_TARGET_DIR`. In wave 5, .5 runs cargo last, because its lock bump rebuilds everything.
    - Parts cherry-pick in numeric order, the wave tip is re-gated, and the branch stays in the main checkout.
  - Schema: one step (.3), `n = USER_VERSION + 1` read at build time.
  - Refusal codes: none. Human IPC errors stay plain strings (CV-03). A code found necessary goes through policy.v3's README ritual.
  - Artifacts: only .2c edits `tools.v1.json`, through the `policy-artifact-edit` skill (`artifact_version` +1, `rule_version` `tools/<commit date>`, digest by the README's ignored test). Never run prettier over `shared/`; .8 adds `shared/starter/` to `.prettierignore`.
  - Clock: specs boot through `e2e/boot.ts` with the clock pinned to `VAULT_TODAY` (CV-15), and the lab pins the same instant. Every local-day assertion sets and restores `process.env.TZ`.
  - Every new section ships five lab presets (.1) and fails alone. A failed read renders `section-unavailable`, never the empty state; an unrecorded day or value reads in words, never 0 (CV-05).
  - The claude CLI never runs against the owner's main `~/.claude`. .2c, .7 and .9 test against mocks; their live checks are the owner's.
  - With the owner's OK, push after wave 4 (CI's Linux crash suite meets .3) and after wave 5 (CI builds .5's stack).
- **Contracts between parts.** Whichever part lands second does the shared work:
  - **One lab (.1).** A file in `src/lab/sections/` exports `section` or `sections`; `labSections()` flattens them and refuses a missing state. Parts add files and never edit the registry. A browser branch reaches a fault through `faulted(command, …)`, and a part wraps exactly the commands its tests or presets fail: .2 `vault_activity`; .2b `page_activity`; .3 `reminder_state`, `done_marks_read`; .4 the review-card and pending-write reads; .4b `home_runs`, `home_changes`; .6 `notification_permission`; .8 `starter_marker`, `install_starter_kit`.
  - **One activity read and one fold (.2).** `runtime/activity.rs` (`Window`, `write_rows`, `run_rows`, `app_session_spans`, `recording_since`) and `engine/activity.ts` (`sessionsOf`, `SESSION_GAP_MS`). .2b, .2c and .4c read them; nobody folds twice. .2 also makes `vault/comments.rs`' page-and-sidecar mapping visible, so .2b's lib.rs and .2c's mcp.rs share it. `WriteRow.content` comes from M58.1b's `write_log::CONTENT_KINDS`, so no TS kind list decides what counts as an edit.
  - **One Done (.3 → .4b).** `done_marks` lanes are insight, run, reminder and change. `mark` returns the mark it replaced; Undo unmarks exactly the mark its Done set, then restores the one that Done replaced. .4b's subjects: the actor or `unattributed` (run), `reminderId` (reminder), `knowledge` (change). Its revisions: the newest `ended_at` shown, the fire time, `to_seq`.
  - **One reminder path (.3 → .3b → .6 → .4b):** `reminderId`, `planReminders`, `announcements` and `reminderStore`. .3b adds property reminders to the same pass, .6 posts `bannerFor` over the reminders you set, and .4b's lane reads `reminderStore` and the claims, never a second body read.
  - **One Home (.4 → .4b → .4c → .9).** `HOME_LANES` is the one ordered lane list and `Lane.tsx` the one anatomy. `useHomeClock` is the one clock for back sections, and M61.3's `bandContext()` the one for forward ones. `src/lab/sections/home.tsx` maps every `HOME_PRESETS` entry to `<HomeLanes only={id} />`, so .4b and .4c add presets without touching the lab. .9's Catch me up reads HOME_LANES for its order and its can't-see list.
  - **One kit (.8 → .9).** `shared/starter/vault/` is the kit; .9 adds two skill files and two `STARTER_FILES` rows.
  - New commands land with their adapter calls (M54.3): .2 one, .2b one, .3 seven, .4b two, .6 three, .8 three.
- **Scout reconciliations** (no part changed wave):
  - .4b assumed receipts with ids and keys like `runs:<actor>`. It uses .3's `(lane, subject, revision)` marks instead, and .3's `mark` returns the replaced mark, so Undo restores exactly what that Done changed.
  - .4c filtered on "page content" that .2 didn't carry. .2's `WriteRow` gains `content`, and `write_log.rs` joins .2 for visibility only.
  - Lab files: .4's registry edit becomes `src/lab/sections/home.tsx`, and .7's and .8's `src/lab/presets/*.ts` become `src/lab/sections/*.tsx`. .6 adds `reminderSettings.tsx` and .9 `recipesOffer.tsx`, so their new sections meet the five-state bullet too.
  - .4 gains `src/lib/ipc.ts` for its two `faulted` wraps; nothing else in wave 5 edits it.
  - .3's cell names CALENDAR-4, which is M61.8's hours grid; its reminder slice is CALENDAR-6. .4's CALENDAR-11 is CALENDAR-12 ("Coming up"). Relabel both cells.
  - .6: the roadmap allowed "UN or tauri-plugin-notification". The plugin reports Granted on every desktop and posts as Terminal in dev, so UN it is.

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M64.1 | the state lab |
| 2 | M64.2, M64.7 | activity read, fold, heatmap and History page · meetings become records |
| 3 | M64.2b, M64.2c | a page's History merged · `read_activity` |
| 4 | M64.3 | durable reminders and Done marks (schema step) |
| 5 | M64.3b, M64.4, M64.5 | type-level reminders · Home's frame and state lanes · macOS 14 and Tauri 2.12 |
| 6 | M64.4b | event lanes with Done and Undo |
| 7 | M64.4c, M64.6 | your recent edits · Notification Center |
| 8 | M64.8 | the starter kit |
| 9 | M64.9 | the recipes |

**Before wave 1:**

- Commit this plan on M63's closed tip.
- Re-read the finished names it leans on:
  - M58: `WriteRow`, `CONTENT_KINDS`, `COALESCE_WINDOW`, `page_attribution` and its rename follow, `useFileHistory`, `useCommitRuns`, GitHistoryPanel's tab variant;
  - M56.7 and .9: `RunWhy`, `cause.rs`, `ReadOnly`. M70.2 and .2b: the sidecar path and the Comments tab;
  - M61.3 and .3b: `bandContext`, `workSections`, `workState`, `TypeDef.deadline`, PropertyEditor's date section. M60.3, .6 and .7: `parseDateProperty`, `applyBatch`, the toast action. M57.4c: `usePendingWrites`;
  - M62 and M63, from their plans: `query_records`, `list_agenda`, the read toolset and its token default (M62.5), `RunGrant::for_client` (M62.5b), actorLabel's "<slug> (other app)" (M62.5c), the `assigned` event's spelling, the runs rows M63.7's checks book, and the last schema step.
- Ask each wave's questions before it starts. The default applies if unanswered.

**Roadmap acceptance, by part:**

| Roadmap bullet | Parts |
| --- | --- |
| Each new section has state-lab presets for all five states | .1 (the type and the replay), then each section's own part |
| History folds five saves into one session | .2 |
| Failed reads render `section-unavailable`, and days before the first app session read "not recorded" | .2, .2b |
| Home shows "2 proposals waiting" and "3 runs ended since you looked" in relative-time sections | .4, .4b |
| Empty lanes render nothing, and the sidebar shows no count | .4 |
| Done on a run row hides it until a newer run of that agent ends, and Undo restores it | .4b on .3 |
| A reminder due while the app was closed yields one "passed while Cerebro was closed" notice and never re-fires after a webview data wipe | .3 (.6 adds the banner) |
| An unbundled dev build reads notification permission as "unknown" | .6 |
| Dropping the same VTT twice says "already filed as X" | .7 |

.2c, .3b, .5, .8 and .9 answer their own roadmap rows.

## Parts

### M64.1 State lab: real sections over the mock in five states, with the clock pinned and a one-shot `failNext`

- **What:** nothing puts a section into each of its five states on demand. The mock has per-domain seeds (`__seedFleet`, `resetMockFs`, `resetMockGit`) but no fault seam, no URL presets and no shared presets. Every later M64 section registers here. Macro's billing lab is the pattern: a dev-only entry, scenario links, fail the next request, fixtures reused by tests.
- **Files:** `state-lab.html` (new), `src/lab/{main.tsx, StateLab.tsx, StateLab.test.tsx, presets.ts, presets.test.tsx, clock.ts, clock.test.ts}` (new), `src/lab/sections/{agentSpend,fleetRuns}.tsx` (new), `src/lib/{mockFaults,mockFaults.test,vaultToday}.ts` (new), `src/lib/ipc.ts`, `e2e/{boot.ts, state-lab.spec.ts (new)}`, `AGENTS.md`, `.claude/skills/verify-ui/SKILL.md`.
- **Approach:**
  - **Clock.** `VAULT_TODAY` moves to import-free `src/lib/vaultToday.ts`, and boot.ts re-exports it. `src/lab/clock.ts` `pinClock()` pins `Date.now()` and zero-argument `new Date()` to it (built with `Date.UTC`). `new Date(value)` and timers stay real, as with Playwright's `setFixedTime`.
  - **Faults** (`src/lib/mockFaults.ts`). `failNext(command)` arms one failure. `faulted(command, run)` rejects every call in the same task with "state lab: <command> was told to fail once", so StrictMode's double effect and parallel reads see one failure, then disarms on `setTimeout(0)`. Also `armedFaults`, `resetFaults` and the window seam `__cerebroFailNext`. ipc.ts wraps the browser branches of `fleet_runs` and `fleet_actor_summaries`; Tauri branches are untouched.
  - **Presets** (`src/lab/presets.ts`). `LAB_STATES`: ready, empty, not-recorded, partial, unavailable. `LabSection {id, title, surface, render(), states}`; `LabPreset {note, seed?, failNext?, expect {present, absent?, text?}}`. `labSections()` globs `./sections/*.tsx` (the mockIpc precedent), reads `section` or `sections`, sorts by id and throws naming any missing state. `applyPreset` resets the mock fs, git and faults, seeds, opens `/demo-vault`, then arms faults last, so a preset never fails the scan. `?section=&state=` round-trips; an unknown name falls back to the first ready preset with a notice.
  - **Seed sections.**
    - agent-spend renders AgentRoster: "12,940 tokens"; "nothing spent — no runs yet"; "not recorded — 1 run unmetered"; "12,940 tokens · 1 run unmetered"; failNext `fleet_actor_summaries`.
    - fleet-runs renders FleetSection: metered runs; `section-empty`; a run-legacy-1-shaped run (`usage-unknown`, M56.7's "why not recorded"); both side by side; failNext `fleet_runs`.
  - **Page.** `StateLab.tsx` lists sections with five state buttons each (`lab-state-<id>-<state>`), the pinned clock (`lab-clock`), Copy link, Reset, Light/Dark (this document only, no storage), a fail box (`lab-fail-command`, `lab-fail-next`, `lab-remount`), and `lab-stage` with `data-section`, `data-state` and `data-ready`. `mountStateLab(root, dev)` refuses outside DEV ("The state lab runs only under pnpm dev.") and sets `window.__cerebroLabPresets`. `state-lab.html` sits beside index.html. Vite builds only index.html, so the lab never ships.
  - **e2e and docs.** boot.ts gains `openStateLab(page, section, state)`: the fixed clock, goto, wait for `data-ready`. AGENTS.md gains a Commands row and one convention at the next free CV id: a section that reads ships five presets in `src/lab/sections/`, replayed by vitest and e2e, enforced by the two loop tests. verify-ui gains one line.
- **Comments to delete:** boot.ts' `VAULT_TODAY` docblock (moves; a pointer stays); ipc.ts' header line on mock delegation gains the `faulted` seam.
- **Tests:**
  - mockFaults: the next read fails, then recovers; two calls in one task both fail; two arms fail two reads; reset; an unarmed command runs untouched; a source scan pairs every `faulted('x'` with an invoke of `'x'`.
  - clock: pinned reads; `new Date(value)` untouched; unpin; `LAB_NOW === VAULT_TODAY`.
  - presets: "every preset renders the state it names" under `vi.setSystemTime`; unavailable presets render `section-unavailable` and no `-empty` testid; reverse order gives the same results; the URL round-trips and falls back.
  - StateLab: listing, push and popstate, Reset, fail then remount, the refusal outside dev, `__cerebroLabPresets`, the clock line.
  - e2e `state-lab.spec.ts` loops every preset through `openStateLab`, one `test.step` each. A failed read recovers on remount, and a reload keeps the preset.
- **Acceptance:**
  - Roadmap: every section can carry presets for all five states. The type demands all five, and vitest and e2e replay each.
  - `/state-lab.html?section=agent-spend&state=partial` mounts the real AgentRoster reading "12,940 tokens · 1 run unmetered", with the clock pinned to `VAULT_TODAY`.
  - `failNext` fails one burst, then reads recover. A preset is a URL.
  - The lab never ships: after `pnpm build`, dist/ holds no state-lab.html and no lab chunk. No Rust, IPC command, schema step, refusal code or mock behaviour changes.
- **Wave** 1 · **Depends** M53.20; M54.3; M56.7 · **Size** S · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(lab): a dev-only state lab mounts real sections in five states over the mock (M64.1)`.

### M64.2 History becomes activity: who changed what, folded into sessions and days, under a year heatmap

- **What:** the History page lists git commits only. Edits between commits, agent runs and days Cerebro was closed don't show, and nothing tells "nothing happened" from "not recorded". M58.1 records actor, run and approver on every write, and `app_sessions` (M49.9) records when Cerebro was open. The roadmap row is XL, so it splits: this part is the read, the fold, the heatmap and the page. .2b merges a page's History tab, and .2c adds read_activity.
- **Files:** `src-tauri/src/runtime/{activity.rs (new), mod.rs, fleet.rs, cause.rs, write_log.rs, vault_writes.rs}` (fleet, cause and write_log: visibility only), `src-tauri/src/{lib.rs, vault/write.rs, vault/comments.rs}` (comments.rs: visibility only, moved here from .2c because .2b's lib.rs needs the same mapping in wave 3), `src/engine/{activity (new), attribution}{,.test}.ts`, `src/lib/{ipc, mockIpc, mockIpc.test, demoOperational}.ts`, `src/history/{vaultActivityStore{,.test}.ts, ActivityHeatmap{,.test}.tsx, ActivityFeed{,.test}.tsx}` (new), `src/pages/PulsePage{,.test}.tsx`, `src/lab/sections/{historyHeatmap,historyFeed}.tsx` (new), `e2e/{history.spec.ts (new), boot.ts}`, `AGENTS.md`.
- **Approach:**
  - **Read** (`runtime/activity.rs`, SELECT-only; every pub fn takes M56.9's `&ReadOnly`).
    - `Window::parse(since, until)` refuses in words: "History needs a window that starts before it ends.", "History reads at most 400 days at a time.", "<x> is not an RFC 3339 instant." `Window::through(until)` serves .2b.
    - `write_rows` returns rows of every kind, comments included, whose `[first_at, recorded_at]` overlaps the window, optionally only for `paths` (path or `to`). Newest first; it reads limit + 1 to set `more`. Writers stamp different precisions, so SQL narrows on `(vault_id, recorded_at)` with a one-second margin, and Rust filters exact instants.
    - `WriteRow {kind, content, path, to, actor, run_id, approved_by, first_at, at}`; `content` comes from `write_log::CONTENT_KINDS`.
    - comments.rs' page-to-sidecar mapping (both ways) goes pub(crate), unchanged, for .2b and .2c.
  - **Lanes.** `run_rows` reuses fleet.rs' columns, mapper and cause reader, carrying `writes_booked` and `cli_session_id`. `app_session_spans` runs from open to clean close or last heartbeat, and `recording_since` is the vault's first `first_at`. `vault_activity` returns writes, runs and spans, each `Read {rows, more}` or `Unavailable {reason}`, so one failed SELECT fails one lane; caps are 20,000, 5,000 and 5,000. lib.rs `vault_activity(vault, since, until)` derives the vault id (`derive_vault_id`) and opens ReadOnly as the fleet commands do. An unregistered vault reads empty lanes and no `recording_since`.
  - **Fold** (`engine/activity.ts`, pure).
    - `SESSION_GAP_MS` is 5 minutes, M58.1's `COALESCE_WINDOW`. `sessionsOf` keys by actor and run. A gap of 5 minutes or more, or a new local day, starts a session. Verbs: created, edited, renamed, deleted, commented; a sidecar row maps to its page through engine/comments.ts.
    - `dayStates`: a day is recorded from `recording_since`'s day on, when a span, write or run touches it. Otherwise it is not recorded, and older than a capped lane's oldest row it is not read.
    - `heatmapOf`: 371 days in Sunday-first weeks, levels 0–4 by sessions; null when writes, spans or `recording_since` failed.
    - `feedOf`: newest day first, with sessions, runs (absorbing their sessions; attended turns sharing a `cli_session_id` fold per day) and commits on their local day. Gap lines appear only when all three lanes read.
    - attribution.ts' `writerWords` reads `human:owner` as "You" too.
  - **Mock and demo.**
    - ipc.ts `vaultActivity` goes through `faulted`. mockIpc mirrors the window refusals word for word.
    - Mock writes are the demo history plus M58.1's `__cerebroMockWrites`, stamped with `first_at` and `at` from the clock; their content set is pinned to `CONTENT_KINDS` by a tripwire. Runs come from the mock fleet and read unavailable under `__seedFleet(null)`. `__seedActivity({writes?, sessions?})` (null fails that lane), window seam `__cerebroSeedActivity`.
    - `demoActivity()`: spans 2026-07-20 to 07-24 and 07-27 (08:00–18:00Z), and 07-28 from 08:00Z, still open. Recording begins 07-21 with a NULL-actor edit. Two `human:me` sessions on 07-27; run-ingest-2's and run-scout-1's writes on 07-28. Demo rows stay out of `__cerebroMockWrites`, so M58.1b's e2e doesn't move.
  - **Page.**
    - `vaultActivityStore`: one read per vault and window, deduped, re-read 1 s after entries change, plus `reload`.
    - `ActivityHeatmap` (`history-heatmap`): `heatmap-day` cells with `data-day`, `data-state`, `data-sessions` and words ("Mon, Jul 27, 2026 — 3 editing sessions", "— no edits", "— not recorded: Cerebro wasn't open", "— not read"); a legend; the seam line "Cerebro began recording edits here on <date>." or "Cerebro hasn't recorded an edit in this vault yet."
    - `ActivityFeed`: `history-day`, `history-session`, `history-run` (RunWhy), commit cards with CommitAuthor and the diff dialog moved from PulsePage, `history-gap`, one `section-unavailable` per failed lane, `history-earlier` (14 days at a time) and `history-outside`: "Edits made outside Cerebro aren't recorded here; they show up only as checkpoints."
    - PulsePage becomes History: the heatmap, then the feed. Git states become feed lines ("Checkpoints could not be read." with Try again; the untracked sentence) instead of blanking the page.
  - **Lab and docs.** `historyHeatmap` and `historyFeed` presets: a recorded year; recorded days with no edits; no spans or rows; recording began 07-20 (heatmap) or the runs lane down (feed); failNext `vault_activity`. AGENTS.md names `activity.rs` beside fleet.rs and `history/` among the surfaces.
- **Comments to delete:** PulsePage's docblock ("What has happened in this vault (M9.4)…", M53.15's "Four answers…", "Nothing renders until the read lands…"); write.rs `shadow_write`'s "Best-effort and invisible", if it survived M58.1; vault_writes.rs' module doc gains activity.rs, if it names its readers; `writerWords`' doc; AGENTS.md's fleet.rs line gains activity.rs.
- **Tests:**
  - activity.rs: rows overlap the window, newest first; window parsing and refusals (an offset read as its instant); `text_order_never_drops_a_row_at_a_seconds_boundary`; paths match a row or its rename target; `more` past the limit; runs read as Fleet reads them; spans end at a clean close or the last heartbeat; `recording_since` or none; an unregistered vault; `each_lane_fails_alone` (a dropped `app_sessions` table); `activity_reads_never_write` (source scan). lib.rs: `vault_activity_refuses_a_malformed_window`.
  - engine/activity.test, with `process.env.TZ` set and restored per case:
    - five rows a minute apart fold into one session; 4:59 joins and 5:00 splits; another actor or run splits;
    - no session crosses local midnight (America/Los_Angeles); day keys across DST (Australia/Sydney 2026-10-04, America/Los_Angeles 2026-11-01); a span across midnight marks both days;
    - days before `recording_since` read not recorded even with a span; a recorded day with no rows reads "no edits", and an unrecorded day never reads 0;
    - the grid, capped lanes, comment rows, "You" and "not recorded", the session-id fold, gap lines, commits grouping when activity failed;
    - `SESSION_GAP_MS` equals `COALESCE_WINDOW` (reads vault_writes.rs).
  - attribution.test (`human:owner`); mockIpc.test (the refusals; a live save appears stamped; each lane fails alone; reset); vaultActivityStore; ActivityHeatmap and ActivityFeed (five states through `applyPreset`, cell words, the seam line, Show earlier); PulsePage.test (a git failure shows its line while activity renders; untracked; an activity failure shows Retry while checkpoints render; the commit dialog opens).
  - e2e `history.spec.ts`:
    - five saves to How we schedule show one `history-session` today reading "You edited How we schedule";
    - 2026-07-20 and 07-25 read not recorded, and 07-22 reads recorded with no edits;
    - with `__cerebroFailNext('vault_activity')` armed, heatmap and feed show `section-unavailable` while a seeded 07-28 commit still renders;
    - run-scout-1 reads "Release scout ran" with its why and its page.
- **Acceptance:**
  - Roadmap: History folds five saves into one session.
  - Roadmap: failed reads render `section-unavailable`, each lane alone. Days before the first app session read "not recorded", never 0, and a recorded day with no edits reads "no edits".
  - Roadmap risk: writes made outside the app are unattributed, and the page says so.
  - Commits keep their own rows in the day groups, never blended into a session or counted in the heatmap. Local days hold at non-UTC offsets, DST included. The name stays History, and the sidebar shows no count.
  - Heatmap and feed have five presets each. No schema step, refusal code or MCP tool.
- **Packaged check (owner):** today reads recorded and a day before the first session reads not recorded. Two minutes of typing on one page show one "You edited …" session. A scheduled agent's run names why it ran and what it wrote. `sqlite3 "$HOME/Library/Application Support/com.cerebro.app/runtime.db" "SELECT opened_at, last_heartbeat_at, close_precision FROM app_sessions ORDER BY opened_at DESC LIMIT 3;"` matches the recorded days. WKWebView draws the grid.
- **Wave** 2 · **Depends** M64.1; M58.1, .1b, .4; M56.7, .9; M70.2; M60.8 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(history): History reads who changed what, folded into sessions and days under a year heatmap (M64.2)`.

### M64.2b A page's History merges its versions, its edits and its Knowledge changes

- **What:** after M58.4, a page's History tab lists commits only. Edits between commits, the runs that wrote the page, and a concept's revisions, proposals and verifications don't show, and a renamed page loses the rows under its old name. This builds on M58.4's tab; there is no second History.
- **Files:** `src-tauri/src/{runtime/write_log.rs, knowledge.rs, ledger/index.rs, lib.rs}`, `src/engine/activity{,.test}.ts`, `src/lib/{ipc, mockIpc, mockIpc.test, demoOperational}.ts`, `src/history/{usePageActivity.ts, PageHistory.tsx, PageHistory.test.tsx}` (new), `src/git/GitHistoryPanel{,.test}.tsx`, `src/detail/DocSidePanel{,.test}.tsx`, `src/stores/uiStore{,.test}.ts` (only if concepts lack the tab), `src/lab/sections/{pageHistory,conceptHistory}.tsx` (new), `e2e/{page-activity.spec.ts (new), boot.ts}`.
- **Approach:**
  - **Rust pieces.** write_log.rs exposes M58.1b's rename follow as `pub(crate) rename_chain(ro, vault_id, path, 8)`, newest name first. knowledge.rs pulls run_writes' belief rule into `beliefs_named` and adds pure `concept_history(state, krel)`: created, each later revision, each applied attestation (verified), and each proposal naming the belief, with state, actor and run. ledger/index.rs `Index::event_rows(ids)` returns kind, `ingested_at` and actor, works on `open_read_only`, and leaves out an id the index hasn't replayed.
  - **Command.** lib.rs `page_activity(vault, path)` resolves through `landing_path` (outside the vault refuses in words) and opens ReadOnly. It takes the rename chain plus each name's sidecar (comments.rs' mapping, visible since .2), then reads `write_rows` (`Window::through(now)`, limit 2,000), `run_rows` for those rows' runs, and `recording_since`. Only a bundle path reads the knowledge lane: no store reads not_recorded; otherwise `state_of` plus `concept_history`, with times and actors from the index (no index: times not recorded); any error reads unavailable.
  - **Timeline** (engine/activity.ts). `pageTimeline({activity, commits, attribution, isKnowledge, todayKey})` merges page-scoped sessions ("You edited it", "<Agent> wrote it", "You created it", "Renamed from <old>", "Commented"), the runs that wrote it, knowledge events and M58.4's FileCommit rows, newest day first.
    - A seam row sits where recording began after the oldest commit.
    - A top row reads "changed outside Cerebro" when M58.1b reads Unattributed.
    - On a knowledge page, the concept file's write and create rows give way to the ledger lane; comments stay. Untimed events sit last under "Time not recorded".
    - `foldTimeline(entries, 8)` keeps the newest 8 and pins the oldest.
  - **Surfaces.** `usePageActivity` reads `page_activity`, M58.4's `useFileHistory` and M58.1b's `pageAttribution`; each fails alone, and newer requests win. `PageHistory.tsx` (`page-history`) renders `history-session`, `history-run`, `history-concept`, `page-history-seam`, `page-history-outside`, `page-history-empty` ("No history yet for this page.") and `page-history-more`. Commit rows reuse GitHistoryPanel's exported CommitRow with M58.4's batched `useCommitRuns`, so `git-commit`, CommitAuthor and the version lens hold. DocSidePanel's History tab renders it on docs and concepts.
  - **Mock and lab.** mockIpc mirrors the refusal words and follows mock renames 8 hops. The knowledge lane comes from `__seedConceptHistory(path, events | 'not_recorded' | null)`, typed in boot.ts: warehouse-cutover and pick-queue-drain default to "created by process:knowledge in run-ingest-2", and other bundle paths read not recorded (the browser keeps no ledger). Presets: pageHistory (records/risks/risk-rollback-unrehearsed.md) and conceptHistory (warehouse-cutover.md), five states each.
- **Comments to delete:** GitHistoryPanel's tab-variant docs (it keeps the foot list and exports CommitRow); DocSidePanel's History tab comment; knowledge.rs run_writes' docblock names `beliefs_named`; write_log.rs' rename-follow doc gains its second caller.
- **Tests:**
  - knowledge.rs: `concept_history_lists_creation_revisions_verifications_and_proposals`, `a_path_with_no_belief_has_no_history`, `run_writes_and_concept_history_name_the_same_beliefs`. index.rs: `event_rows_reads_kind_time_and_actor`, `an_id_the_index_lacks_is_absent`. write_log.rs: the 8-hop chain, unless M58.1b pins it. lib.rs: `page_activity_refuses_a_path_outside_the_vault`, `a_renamed_page_reads_rows_under_its_old_name`, `a_page_outside_the_bundle_has_no_knowledge_lane`.
  - vitest: pageTimeline (order, seam, the outside row only for Unattributed, ledger rows replacing concept writes, untimed last, the fold; TZ per case); mockIpc; PageHistory (each lane alone; commit rows open the lens; one batched attribution read; empty and not-recorded words; both sections' presets); GitHistoryPanel (the foot list unchanged); DocSidePanel.
  - e2e `page-activity.spec.ts`: typing puts "You edited it" above `git-commit` rows that still open `version-lens`; Warehouse cutover lists "Created by Knowledge agent"; `__cerebroFailNext('page_activity')` shows "Edits could not be read" while commits render; a direct `__cerebroMockFs` edit plus a rescan shows the outside row. M58.4's `page-history.spec.ts` passes unchanged.
- **Acceptance:**
  - Roadmap: a page's History merges GitHistoryPanel. Commits and recorded edits share one timeline and are never blended.
  - Roadmap: knowledge pages merge the ledger: creation, revisions, proposals with their state, and your verifications.
  - Roadmap: each lane fails alone as `section-unavailable`, and both sections have five presets.
  - A renamed page keeps its earlier rows, up to 8 hops. A page changed outside Cerebro says so at the top. No schema step, refusal code or MCP tool.
- **Packaged check (owner):** a concept's History lists its creation and your verification from the real ledger. A renamed page keeps its earlier sessions. An edit in another editor shows the outside row. The lens and Restore still work.
- **Wave** 3 · **Depends** M64.2; M58.1b, .4; M70.2b; M50.3 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(history): a page's History merges its versions, its edits and its Knowledge changes (M64.2b)`.

### M64.2c `read_activity`: agents read who changed what, inside their read scope

- **What:** no agent tool answers "what changed" (COMMS-1 counted 17 base tools, none for activity or runs), so a catch-me-up answer needs the shell or a guess. .9's recipes need it.
- **Files:** `shared/policy/{tools.v1.json, tools.v1.sha256}`, `src-tauri/src/{mcp.rs, policy/tools.rs}`, `src-tauri/fixtures/{tool-cases,tool-grants}.json`, `src/lib/policy/tools.test.ts`, `src/engine/tools.test.ts`, `src/library/AgentProperties.test.tsx`, `SECURITY.md`. comments.rs' visibility change moved to .2. Only if they pin read-toolset names: `e2e/agents.spec.ts`, `shared/policy/goldens-tool-approval/` (by their update path), and M62.5's `src-tauri/fixtures/client-tokens.json`, `src/engine/clientAccess.test.ts` and `e2e/client-access.spec.ts`.
- **Approach:**
  - **Manifest row** (the skill), right after list_notes and shaped like it: surface base, title "Read activity", toolset read, kind read_only, idempotent, door none, axis read, target null, renderer step, icon history, `always_load` false (deferred), search hint "recent changes edits runs who changed what". The description names no other tool (CV-19): "List what changed in this vault between two times, newest first: page edits, renames, deletions and comments with who made them, and agent runs with why they started. Rows outside your read scope are counted, never listed. Times are UTC." Input: `from` (required), `to`, `path`, `limit` (1–100, default 50).
  - **Dispatch.** mcp.rs `tool_read_activity` opens ReadOnly as the fleet commands do and calls a pure `read_activity_answer(ro, vault_id, args, grant, now)`; no runtime database refuses "Activity could not be read: <reason>". `from` and `to` take RFC 3339 or YYYY-MM-DD (00:00 UTC, restated), and `Window::parse`'s refusals apply. A limit below 1 is refused; above 100 it is cut, and the answer says so. A named path outside read scope is refused in the dispatcher's words.
  - **Scope.** It reads `write_rows` (the page and its sidecar when a path is named) and `run_rows`, merged newest first, plus `app_session_spans` for the open line. A row whose page fails `grant.may_read` is withheld and counted. A sidecar maps to its page through comments.rs' mapping (visible since .2). A run lists only its in-scope pages and counts the rest. The read toolset is M62.5's token default, so other apps holding a read token reach it too, inside `RunGrant::for_client`'s read scope.
  - **Answer text** (exact; no run ids, hashes or session ids):
    - header "Activity from <from> to <to> (UTC; this machine's zone is <zone>). Showing N of M.", plus "— K more not shown; narrow the window or raise limit (at most 100)." and "J rows withheld: they touch pages outside your read scope." when they apply;
    - the open line, after the header: "Cerebro was open 2026-07-27 08:00–18:00Z, 2026-07-28 08:00Z–now; nothing is recorded while it is closed." (the newest 20 stretches, then "and N earlier"). No overlapping span: "Cerebro was not open in this window, so nothing here was recorded." No ledger store (no store id, so sessions.rs never tracks the vault): "When Cerebro was open is not recorded for this vault." A failed spans read: "When Cerebro was open could not be read.";
    - writes "- 2026-07-27 14:00–14:12Z · you · edited records/risks/x.md" (created, deleted, "renamed a.md to b.md", "commented on x.md"; " · you allowed it"). Who: "you" (`human:*`), "<slug> (other app)" (`client:<slug>`, as M62.5c's actorLabel reads it), the handle, "the assistant", a construct's stamp, or "not recorded who";
    - runs "- … · release-scout ran (succeeded) · <cause.rs' words> · wrote 1 page", or "wrote no pages", "pages written: not recorded", " · shell changes not recorded";
    - trailer "Not recorded here: edits made outside Cerebro, and anything before <date>." or "Cerebro has not recorded an edit in this vault yet."; an empty window Cerebro was open in reads "No recorded activity in this window."
  - **Enumerations and docs.** tool-cases.json gains a case shaped like list_notes'. Every whole-catalog case in tool-grants.json gains read_activity after list_notes (M55.5's precedent). tools.rs, lib tools.test (M56.8's fold set included), engine tools.test and AgentProperties.test add it where read rows are listed. SECURITY.md: operational write and run records reach agents, and other apps holding a read token (M62.5's default), only inside their read scope, counted outside it, through a read-only connection; when Cerebro was open is vault-wide.
- **Comments to delete:** mcp.rs call_tool's enumerating-readers note ("search_notes, list_inbox, get_vault_context …") gains read_activity.
- **Tests:**
  - mcp.rs, on a temp vault and an armed sink seeded with writes and runs: `read_activity_lists_writes_and_runs_newest_first`; `…_reads_people_as_you_other_apps_by_slug_and_null_as_not_recorded`; `…_withholds_and_counts_rows_outside_read_scope` (and a run's hidden page); `…_keeps_a_client_tokens_read_scope` (a `RunGrant::for_client` read token scoped to one folder lists only its rows and counts the rest); `…_says_when_cerebro_was_closed` (spans on 07-27 only: a window over 07-25–07-27 names the stretch, a 07-25 window reads not open, a vault with no store reads not recorded, a failed spans read says so); `…_names_a_comment_on_its_page`; `…_cuts_at_its_limit_and_says_how_many_more` (60 rows at 50; 101 cut to 100); `…_refuses_a_malformed_or_backwards_window` (401 days too; a date restated); `…_refuses_a_path_outside_read_scope`; `…_says_what_it_cannot_see`; `…_without_a_runtime_database_refuses_in_words`; `…_is_served_read_only` (title, hints, deferred, after list_notes, naming no tool). M54's catalog, annotation, schema and spelling tests pass.
  - tools.rs and lib tools.test: the digest and the fold set. engine tools.test: the read toolset and the case replay. AgentProperties.test: the read toolset.
  - e2e: `agent.spec.ts`, `agents.spec.ts` and `client-access.spec.ts` pass, and "Read the vault" still reads Read-only.
- **Acceptance:**
  - Roadmap: `read_activity` for agents.
  - At most 100 rows, newest first. Truncation is stated, rows outside read scope are counted as withheld, and lines carry names and paths, not ids.
  - A read-only, deferred manifest row. Both digests are pinned, Rust and TS refuse the same malformed rows, and CV-19 holds.
  - Answers name what they can't see and when Cerebro was open; a window it was never open in says nothing was recorded (CV-05). Other apps read by slug, and a client token's read scope holds like an agent's. No schema step, refusal code, write or `propose_` name.
- **Live check (owner):** a panel turn asked "what changed today?" calls read_activity and answers from its rows.
- **Wave** 3 · **Depends** M64.2; M62.5, .5b, .5c; M54.1, .2, .7; M56.8; M59.5; M58.1; M70.2; M53.5 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(mcp): read_activity tells agents who changed what, inside their read scope (M64.2c)`.

### M64.3 Durable reminders and Done marks in runtime.db (schema step)

- **What:** fired reminders sit in global localStorage (`cerebro.firedReminders`, keyed `path#line@at`). A webview wipe re-fires them, a line inserted above re-fires them, and two vaults share keys. Insight dismissals are global localStorage too (`cerebro.dismissedInsights`). `dueReminders` drops anything older than 24 h without a word, and `sessions::track` throws away the closure `open_session` returns. Body caches are keyed by path only. The roadmap row is XL as one commit: this part is the durable core, and .3b adds the type-level reminder and the labels.
- **Files:** `src-tauri/src/runtime/{schema.rs, mod.rs, reminders.rs (new), done_marks.rs (new), sessions.rs, catchup.rs}`, `src-tauri/src/lib.rs`, `src-tauri/fixtures/reminder-state-cases.json` (new), `shared/policy/README.md` (its twin-registry row), `src/lib/{ipc, mockIpc, mockIpc.test}.ts`, `src/engine/reminders{,.test}.ts`, `src/stores/{reminderStore, doneMarksStore}{,.test}.ts` (new), `src/hooks/{useReminders.ts, useReminders.test.tsx, useDocTasks.ts, useDocTasks.test.tsx}`, `src/stores/uiStore{,.test}.ts`, `src/knowledge/LearnedCard{,.test}.tsx`, `e2e/{boot.ts, reminders.spec.ts (new)}`.
- **Approach:**
  - **Schema** (`SCHEMA_V<n>`, n = `USER_VERSION + 1` at build time: v30 if M62 and M63 take their planned steps (M62.5 v26, M63 v27–v29); trust the constant). One step, two tables, both operational, never the ledger.
    - `reminder_fires`: vault_id REFERENCES vault_registry; path 1–1024 chars; chip 16 lowercase hex; ordinal >= 0; `fire_at`, the chip's floating local minute, never converted to UTC (M16.14); outcome fired, missed, moved or imported; `claimed_at` ending in Z; PRIMARY KEY (vault_id, path, chip, ordinal, fire_at).
    - `done_marks`: vault_id; lane insight, run, reminder or change; subject 1–1024 chars; until revision or forever; revision NULL or 1–256 chars, with CHECK (until = 'revision') = (revision IS NOT NULL); `marked_at`; PRIMARY KEY (vault_id, lane, subject). They are "marks", because WriteReceipt already owns "receipt".
    - `validate_v<n>` checks both column lists and both IN-lists in sqlite_master, so a table without its CHECK rolls back.
  - **Rust.**
    - `reminders.rs`: `claim` runs one transaction of INSERT … ON CONFLICT DO NOTHING (fresh when a row changed) and takes only fired, missed or moved; a batch over 500, or any malformed fire, refuses whole. `import` forces imported, skips remnants and never overwrites. `read_all`.
    - `done_marks.rs`: `mark` upserts and returns the mark it replaced; `unmark` deletes only the exact mark it names, so an Undo never removes a newer Done; `import` writes forever with DO NOTHING; `read_all`.
    - sessions.rs keeps `open_session`'s closure: `window_for(vault_id)` gives `SessionWindow {closed_at, precision, reopened_at, cause}`, where cause is vault when the closure is later than this process's start and app otherwise. catchup.rs: a vault reopened by the same process (A→B→A) clears `clean_closed_at` and goes back to open, after the closure is read.
    - lib.rs: `reminder_state` (fires plus the window; no database refuses as job_ledger_read does), `reminder_claim`, `reminder_import`, `done_marks_read`, `done_mark`, `done_unmark`, `done_marks_import`, with camelCase structs and `job_ledger_scope`.
  - **Identity and plan** (engine/reminders.ts).
    - `chip` = `sha256Hex('cerebro-reminder-chip-v1\0' + token).slice(0, 16)` over the trimmed date token, written as an escape, never a raw NUL (CV-13). `ordinal` counts earlier same-chip tokens in the file, skipping fences. `reminderId` = path, chip, ordinal and time; `reminderKey` goes.
    - `planReminders({reminders, now, claimed, window, graceHours = 24})` replaces `dueReminders`. Claimed and future reminders wait. Inside a window, `closedAt <= at < reopenedAt` is missed; otherwise `at >= max(reopenedAt, now − 24 h)` fires, and older stays silent.
    - `legacyImports` maps old keys (ambiguous and future keys dropped). `carriedRenames` moves a vanished path's claim to an appeared path's reminder with the same chip, ordinal and time.
    - `announcements` words: "⏰ Reminder: {text}" or "⏰ Reminder ({late} late): {text}" (lateness through whenText's `lateBy`); "⏰ {n} reminders: {a} · {b} · {c}" plus " · and {k} more"; "⏰ A reminder passed while Cerebro was closed: {a}" or "⏰ {n} reminders passed while Cerebro was closed: …", with "while this vault was closed" for a vault cause; "Scheduled reminder" for empty text.
  - **Reminder hook.**
    - `reminderStore` holds, per vault, the status, reminders, fires by id and the window, reset on a vault switch.
    - useReminders keys its cache by vault and path and hydrates only after the vault's first scan lands (`entriesVault === vaultPath`, after start_watcher tracked the session). It imports `cerebro.firedReminders` once when the vault has no rows, and never writes it again.
    - Each check (on ready, then every 30 s, one in flight) claims missed, then due, and renames as moved with no toast; it toasts only after the claim. A failed read or claim toasts once ("Reminder history could not be read, so a reminder may fire again after a restart.") and falls back to once per session (Q17).
  - **Done marks.** `doneMarksStore` hydrates per vault and imports `cerebro.dismissedInsights` once when the vault has no insight marks. `markDone` returns the replaced mark, or false on failure; `undoDone(set, replaced)` unmarks `set` and restores `replaced`. Both toast and never throw (CV-03); `isDone(lane, subject, revision?)`. uiStore's `dismissedInsights` becomes the browser mirror and import source (plus `restoreInsight`). LearnedCard filters by insight marks, and Dismiss marks forever (Q18). It renders nothing while loading and `section-unavailable` when the read failed: "What you dismissed here could not be read, so these are held back." useDocTasks keys its cache by vault and path.
  - **Mock and e2e.** mockIpc mirrors both stores per vault. `reminder-state-cases.json` holds it to Rust: both vocabularies, the 500 cap, claim freshness, `mark` returning the replaced mark, exact `unmark`, both imports and every refusal's words. reminders.rs, done_marks.rs and mockIpc.test replay it, and `shared/policy/README.md`'s twin registry lists it (edited through the `policy-artifact-edit` skill). Seams `__cerebroSeedSessionWindow` and `__cerebroSeedReminderFires`, reader `__cerebroMockReminderFires`. ipc.ts wraps `reminder_state` and `done_marks_read` in `faulted`. boot.ts gains `seedFileBeforeBoot(page, path, text)`.
- **Comments to delete:** useReminders' "Storage unavailable: fired-state is session-only.", "Fired reminders persist in localStorage so restarts don't re-ping." and "Body cache keyed by path, invalidated by modifiedAt"; reminders.ts' `reminderKey` doc ("Stable identity…") and `dueReminders`' "stale reminders from long-closed sessions stay silent"; uiStore's "Persisted, because a card you dismissed…"; useDocTasks' "Body cache keyed by path"; sessions.rs' module doc gains its reader; the `USER_VERSION` doc gains step n.
- **Tests:**
  - reminders.rs: `a_first_claim_is_fresh_and_a_repeat_is_not`, `a_claim_outlives_the_connection_that_made_it` (the wipe proof), `two_vaults_never_share_a_fire`, `the_schema_refuses_a_malformed_fire`, `claim_takes_only_fired_missed_or_moved`, `import_never_overwrites_and_skips_remnants`, `a_batch_over_the_cap_is_refused_whole`, `claims_replay_the_shared_cases`.
  - done_marks.rs: `a_newer_done_replaces_the_revision_it_saw` (and returns it), `undo_removes_only_the_mark_it_names`, `forever_carries_no_revision_and_revision_needs_one`, `an_unknown_lane_is_refused_by_the_schema`, `import_keeps_every_existing_mark`, `two_vaults_never_share_a_mark`, `marks_replay_the_shared_cases`.
  - sessions.rs: the window after a reopen; a reload keeps it; a first session has none; cause. catchup.rs: `a_vault_reopened_by_the_same_process_is_open_again`. runtime/mod.rs: `a_previous_version_database_gains_reminder_fires_and_done_marks` (every row kept), `the_v<n>_validator_refuses_tables_without_their_checks`. No test name holds a skip-list substring.
  - vitest: reminders (identity across an inserted line, a changed date, same-chip ordinals, edited context; planReminders' bounds and fallback; `toLocalWindow` at America/Los_Angeles; legacyImports; carriedRenames; the words); reminderStore; useReminders (claim before toast; a reminder claimed elsewhere never fires with localStorage empty; missed said once; vault cause; the grace fallback; one import; a renamed note never re-fires; two vaults apart; a failed read toasts once; hydration waits); doneMarksStore; uiStore; LearnedCard; useDocTasks; mockIpc (replays `reminder-state-cases.json`).
  - e2e `reminders.spec.ts`:
    - missed while closed: a seeded window (closed 07-27 18:00Z, reopened 07-28 11:58Z) and four chips give one toast "⏰ 2 reminders passed while Cerebro was closed: Call the vendor · Send the deck", one "⏰ Reminder: Book the room", and fires with 2 missed and 1 fired;
    - a wiped webview: a claimed "Pay the invoice" (chip computed with node:crypto) stays quiet with localStorage empty, while an unclaimed "Water the plants" fires.
  - `pipeline.spec.ts` still keeps a dismissed insight across reload, and `ipcContract.test.ts` passes with the seven commands.
- **Acceptance:**
  - Roadmap: a reminder due while the app was closed gives one "passed while Cerebro was closed" notice and never fires again after a webview data wipe.
  - Roadmap: claims and Done marks live in runtime.db per vault. localStorage is imported once, and nothing writes `cerebro.firedReminders` again.
  - Roadmap: identity is path + chip hash + ordinal + fire time. An inserted line doesn't re-fire a chip; a changed date does. Reminder and task caches are scoped to the vault.
  - Done marks carry the revision seen. Undo removes only that mark and restores the one it replaced; forever is explicit.
  - Rust and the mock agree through `reminder-state-cases.json`, a registered twin (CV-04).
  - A failed history read toasts in words, and LearnedCard's is `section-unavailable` (CV-05). v<n-1> → v<n> keeps every row. No refusal code, MCP tool or artifact.
- **Packaged check (owner):** a reminder made due while quit gives one notice after relaunch. Quit, delete `~/Library/WebKit/com.cerebro.app`, relaunch: nothing re-fires. `sqlite3 … "SELECT path, outcome FROM reminder_fires;"` lists the claims.
- **Wave** 4 · **Depends** M64.1, .2; M54.3; M56.7; M63.8 · **Size** L (roadmap M) · **Crash risk** yes (the step runs inside the migration kill points) · **Packaged check** yes
- **Commit:** `feat(reminders): fired reminders and Done marks live in runtime.db, and a reminder missed while closed is said once (M64.3)`.

### M64.3b Date fields remind every record of their type, and labels state the time

- **What:** reminders exist only as body chips, so a declared date field can't remind. Labels read "(9:00 AM)" even for timed values, which fire at their own time, and DatePicker strips the suffix with a regex. Checked lines (`- [x]`) still remind, and FieldEditor passes `showRemind={false}`, so no property sets a reminder. These are the roadmap's bullets 4 and 5, plus CALENDAR-6's gating.
- **Files:** `src/engine/{dates, schema, typeCatalog, reminders}{,.test}.ts`, `src/engine/types.ts`, `src/components/ui/DatePicker{.tsx, .test.tsx (new)}`, `src/app/typeActions{,.test}.ts`, `src/views/PropertyEditor{,.test}.tsx`, `src/hooks/useReminders{.ts, .test.tsx}`, `src-tauri/src/vault/schema.rs` (a test only), `e2e/reminders.spec.ts`.
- **Approach:**
  - **Labels.** dates.ts exports `REMIND_OFFSETS` and `DATE_ONLY_REMIND_TIME = '09:00'`, which `remindAt` uses. `REMIND_OPTIONS` labels lose the time. `remindLabel(id, value)` reads "1 day before, 4:00 PM" from the value's own time, or 9:00 AM for a date. DatePicker uses it, so the regex strip goes. Hint: "Reminders show in Cerebro while it is open. One that passes while it is closed is said once when it opens."
  - **The type's setting.** `FieldDef.remind?: RemindOffset`, on date and daterange only. schema.ts parses it only from `REMIND_OFFSETS` and drops anything else, like `dateFormat`. typeCatalog's `fieldToSpec` writes it, and typeActions' `KIND_KEYS` and `setFieldConfig` gain it, so a kind change away from date drops it. PropertyEditor's date section (beside M61.3b's `property-deadline`) gains `property-remind`, hinted "Every {Type} with a {Field} reminds. Dates without a time remind at 9:00 AM." FieldEditor keeps `showRemind={false}`: one cell must not set a reminder for every record.
  - **Collection.** `propertyReminders(entries, schema)` gives one Reminder per record whose declared field has `remind` and parses through `parseDateProperty`: line −1, the chip of `field:<name>`, ordinal 0, context "<title> · <Field>". A daterange reminds before its start (Q19). Records M61.3b's `workState` reads as finished, and templates, are skipped, and `collectReminders` skips checked lines. useReminders merges them each pass with no body read. A new value changes the fire time, so the old claim never fires again.
  - **Rust.** vault/schema.rs gains one test: M60.3's `parse_field_def` reads a date field carrying `remind: 1d` as a date. remind is TS-only behaviour, so neither the twin registry nor field-kinds.v1 changes. If that reader refuses unknown keys, `remind` needs a field-kinds.v1 case through the ritual: stop and re-plan.
  - **e2e.** Work items → Due's property editor → Remind → 1 day before writes `remind: 1d` under `due` in the Type doc. One toast names "Conflict resolution UX spec · Due": SYN-1 is due 07-29, and its 09:00 fire is 3 h late at the pinned 12:00. demo-vault is untouched.
- **Comments to delete:** `remindAt`'s "date-only events at 9:00 AM (mirrors the picker's preset labels)"; the "(9:00 AM)" suffixes; DatePicker's label strip and "Reminders fire as desktop notifications"; reminders.ts' module doc "This module finds them in note bodies" (bodies and declared date fields now).
- **Tests:** dates (no label carries a time; `remindLabel` timed, 24-hour and date-only; `remindAt` unchanged); DatePicker (labels per value; the hint); schema (date and daterange parse remind, text ignores it, a bad value drops); typeCatalog (round-trip); typeActions (write, delete, dropped on a kind change; nothing throws); PropertyEditor (writes the Type doc; the hint; nothing on a text field); reminders (`propertyReminders` for a date, a range start, a timed value, and a finished, template or invalid record skipped; a `- [x]` line skipped); useReminders (fires once; a changed due date re-arms); schema.rs `a_date_field_with_remind_reads_as_its_kind`; the e2e case.
- **Acceptance:**
  - Roadmap: date fields get a type-level default reminder. Every record of the type with a value reminds: date-only at 9:00 AM, timed at its own time.
  - Roadmap: the "(9:00 AM)" labels are fixed, and no timed value shows 9:00 AM.
  - Checked lines and finished records never remind (CV-08: capability, never a type name). No artifact, demo-vault or golden changes.
- **Wave** 5 · **Depends** M64.3; M61.3b; M60.3 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(reminders): a date field reminds every record of its type, and labels state the time (M64.3b)`.

### M64.4 Home catches you up: the lane frame and four state lanes (D9 b)

- **What:** Home is a greeting, LearnedCard, doc checklist tasks and the Collections grid. Record deadlines reach only My work (M61.3b), and proposals, captures and coming-up dates have no place on the launch page. The roadmap row is XL (8 lanes, Done, two Rust reads), so it splits: .4 the frame and the state lanes, .4b the event lanes with Done, .4c your recent edits.
- **Files:** `src/engine/{homeLanes, homeSections}{,.test}.ts` (new), `src/engine/destinations.ts`, `src/hooks/useFeed{.ts, .test.tsx}` (new), `src/hooks/useDocTasks{.ts, .test.tsx}`, `src/knowledge/{BaseItself, LearnedCard}.tsx`, `src/pages/HomePage{,.test}.tsx`, `src/pages/HomeTasks.test.tsx` → `src/pages/home/MyWorkLane.test.tsx` (git mv), `src/pages/home/{HomeLanes, Lane, MyWorkLane, ProposalsLane, CapturesLane, ComingUpLane}.tsx` (new), `src/pages/home/{HomeLanes.test.tsx, stateLanes.test.tsx, useHomeClock.ts, useHomeClock.test.ts, home.presets.ts}` (new), `src/lab/sections/home.tsx` (new), `src-tauri/src/policy/review.rs`, `src/lib/{ipc, mockIpc, mockIpc.test, demoOperational}.ts`, `src/app/Sidebar.test.tsx`, `e2e/home.spec.ts` (new), `docs/superpowers/specs/2026-08-25-m43-shell-completion-design.md`, `AGENTS.md`.
- **Approach:**
  - **Sections** (`engine/homeSections.ts`, pure; no clock read; stamps through M60.3's dateGrammar). `Feed<T>` and `useFeed` move from BaseItself to `src/hooks/useFeed.ts` unchanged.
    - Back: Last few minutes (under 5 min), Last hour, then the same local day's Evening, Afternoon, Morning and Earlier today, then M61.3's back-scale days, then "When not recorded". A missing or bad stamp never lands in Older (CV-05); a future stamp lands in Last few minutes.
    - Forward: Now (ongoing), then M61.3b's deadline scale through `bandContext()`, then Not a date and No date. `sectionize` keeps the order, and ties break by subject.
  - **Lanes** (`engine/homeLanes.ts`, pure, with its own input shapes, since the engine rails forbid IPC types).
    - `HOME_LANES` is the one ordered list: mywork, proposals, runs, captures, reminders, changes, edits, comingup. Only runs, reminders and changes are kind event. `laneView` is null when ready and empty; a partial lane with no rows keeps its notes; `ROW_CAP = 10`.
    - Builders: `myWorkRows` (M61.3b's `workSections` through This week, plus every open doc task); `proposalRows` (review cards stacked by first target, M57.4c's pending writes by target; `at` is the newest `submitted_at` or `queued_at`); `captureRows` (`inboxEntries`); `comingUpRows` (declared date fields except the type's `deadline:`, starting in the next 7 days or ongoing; finished work, templates and knowledge/ left out; one row per record; at most 200).
    - Lines: "N overdue · N due today · N due this week · N open tasks" (non-zero parts), "N proposals waiting" (+ " · N page writes waiting"), "N captures to organize", "N coming up in the next 7 days", with singulars.
  - **Anatomy.** `Lane.tsx`: `home-lane` (`data-lane`, `data-state`), `home-lane-line`, a door, `home-lane-note`s, `home-section`, `home-row` (`data-subject`, `data-kind`), and "Show all N" past the cap. Loading and empty render nothing. Unavailable renders `section-unavailable`: "{label} could not be read, so nothing here is a statement about this vault." Counts are quiet mono, never a filled pill (M42.1). `useHomeClock` reads whole minutes every 30 s. HomeLanes renders HOME_LANES order (with `only?` for the lab), and nothing re-reads on a timer.
  - **The four lanes.**
    - MyWorkLane: useDocTasks plus `workSections`; TaskRow, the assignee filter and "N done" move from HomePage; door "Open My work". A vault error is unavailable. useDocTasks returns `unreadable` instead of skipping, and the lane names those notes in a partial note.
    - ProposalsLane: `usePendingCards` plus `usePendingWrites`. Rows open their concept, or Review for a targetless card or a page write. Home offers no Approve, Reject or Allow. One read failed gives a partial note; both give unavailable.
    - CapturesLane renders nothing when Inbox is off and follows Inbox's own membership and period. ComingUpLane notes unreadable dates and truncation.
  - **Home and Rust.** HomePage: greeting, the fresh-vault empty state, LearnedCard, `<HomeLanes />` led by My work, then Collections. review.rs: `ReviewCard.submitted_at` from `ProposalRow.submitted_at` (optional in TS; absent reads "When not recorded"); demo cards are stamped on `VAULT_TODAY`. ipc.ts wraps the two proposal reads in `faulted`. `home.presets.ts` holds `HOME_PRESETS` (four lanes × five states), and `src/lab/sections/home.tsx` maps every entry.
  - **D9 record.** Sidebar.test pins Home's accessible name to "Home" with every lane full, and destinations.ts' Home row says why. The M43 spec gains "Amendment — M64.4 (D9 b, default taken)", and its §2 "No notifications bell — there is no feed" points to it. AGENTS.md: Home is pull-only, and lane order lives in `HOME_LANES`.
- **Comments to delete:** HomePage's "M8.3 — the only surface in the app that speaks first…"; LearnedCard's "The one thing Home is allowed to volunteer (M8.3)…"; useDocTasks' "unreadable note: skip rather than fail the rollup" (its docblock gains `unreadable`); HomeTasks' docblock (moves to MyWorkLane, rewritten).
- **Tests:**
  - homeSections: each boundary (4:59/5:00 min, 59/60 min, 05:59/06:00, 11:59/12:00, 17:59/18:00); rolling windows across midnight; a future stamp; null and junk last; all under America/Los_Angeles and Australia/Sydney; the forward scale equals M61.3b's on 2026-07-28; a source scan finds no clock read.
  - homeLanes: order and kinds; `laneView`; the cap; each builder's edges; two cards on one concept make one row reading "2 proposals waiting"; 201 coming-up rows give 200 and truncated; no clock read.
  - HomeLanes: order; an empty lane renders nothing; a failed review read leaves My work and Captures standing; no state row has `home-row-done`; every preset; a scan finds no Notification, requestPermission or sendNotification.
  - MyWorkLane (the git mv: toggle, filter, show done; deadline rows; the unreadable note; empty renders nothing), stateLanes, useHomeClock, useFeed, useDocTasks, HomePage, Sidebar ("Home carries no count, whatever its lanes hold (D9 b)"), review.rs `a_card_says_when_the_store_received_it`, mockIpc (demo cards stamped).
  - e2e `home.spec.ts`: two proposals wait in relative-time sections (cards at 11:58Z and yesterday 15:00Z: "2 proposals waiting", rows under Last few minutes and Yesterday, a row opens its concept, no Approve); an empty lane renders nothing; a failed lane says so alone; deadlines lead ("Blank-state coaching copy" under Overdue); the sidebar shows no count.
- **Acceptance:**
  - Roadmap (with .4b): Home shows "2 proposals waiting" in relative-time sections.
  - Roadmap: empty lanes render nothing, and the sidebar shows no count.
  - Roadmap: five presets each for mywork, proposals, captures and comingup.
  - Each lane fails alone, and a partly failed lane names what it is missing; no task list thins silently.
  - One row per subject per lane. State rows carry no Done, proposals are decided only on their own cards, and every row opens a page. Lane order lives once, in HOME_LANES.
  - D9 (b) is recorded in the M43 spec and AGENTS.md.
- **Wave** 5 · **Depends** M64.1; M61.3, .3b; M60.3; M57.4c; M59.1 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(home): Home pulls together what needs you in quiet lanes, each silent when empty (M64.4)`.

### M64.4b Event lanes: runs ended since you looked, reminders, what changed — Done on the revision seen, with Undo

- **What:** runs, reminders and Knowledge changes are events, so "since you looked" needs a Done mark on the revision seen (.3). No vault-scoped read of finished runs exists: TS can't name the runtime vault id, and panel turns and constructs crowd `fleet_runs`' page. converge without `fromSeq` covers only the last ambient tick (at most 300 s, PRODUCT-1's defect), so BaseItself's "Since the last time anybody looked at this." is false. ChangesView carries no time.
- **Files:** `src-tauri/src/{runtime/fleet.rs, convergence/mod.rs, attention/status.rs, lib.rs}`, `src/lib/{ipc, ipcContract.test, mockIpc, mockIpc.test, demoOperational}.ts`, `src/engine/homeLanes{,.test}.ts`, `src/pages/home/{HomeLanes.tsx, HomeLanes.test.tsx, Lane.tsx, home.presets.ts}`, `src/pages/home/{RunsLane, RemindersLane, ChangesLane}.tsx` (new), `src/pages/home/{useHomeDone.ts, useHomeDone.test.tsx, eventLanes.test.tsx}` (new), `src/knowledge/BaseItself{,.test}.tsx`, `e2e/home.spec.ts`.
- **Approach:**
  - **Runs** (fleet.rs, SELECT-only on ReadOnly). `ended_runs(ro, vault_id, limit)` returns `{runs, truncated}`: this vault's ambient runs that ended, with any outcome but running, whose actor is NULL or not in `agent::meter::CONSTRUCT_ACTORS` (bound as parameters). Newest first, clamped, reading one past for `truncated`; cause through `map_run`. If M63.7's pre-run checks book runs rows, leave them out by their lane or cause. lib.rs `home_runs(vault, limit?)` derives the vault id with no registry write. No index, no schema step.
  - **Changes.** convergence/mod.rs, pure: `home_window(after_seq, last_run_from, head_seq)` starts at your mark, else the latest stored run's `from_seq`, else 0, clamped to the head; `changed_at(frames, window)` is the newest frame's `ingested_at`. status.rs: `ChangesView.changed_at`, skipped when None, so converge's JSON is unchanged. lib.rs `home_changes(vault, after_seq?)`: no ledger store returns None (not recorded); a failed read is an error.
  - **Done** (on .3's marks). `useHomeDone.done(lane, row)` sends exactly the row's rendered revision and toasts "Marked done" with Undo through M60.7's toast action. Undo unmarks that exact mark and restores the one it replaced. Both never throw (CV-03) and stay off undoStore and ⌘Z (D11). `home-row-done` (aria "Mark {title} done") shows only on event lanes, disabled while marks are unreadable.
  - **Lanes.**
    - `runRows` stacks per actor and keeps runs that ended after the actor's mark. An actor with no mark, or any actor while marks are unreadable, keeps only runs that ended in the last 7 days (`useHomeClock`). Rows show the newest outcome (underscores to spaces, no TS table), "+N earlier", a danger tone when it didn't succeed. A row opens the agent page's Runs tab (M55.12), or the fleet when there is no record. RunsLane renders RunWhy ("why not recorded" when NULL). Truncation adds "Only the newest 200 finished runs are counted.", and unreadable marks make the lane partial.
    - RemindersLane reads .3's store and claims for 7 days: "Passed while Cerebro was closed" on missed, and "A reminder in {page} (since removed)".
    - ChangesLane calls `homeChanges` with the mark's `to_seq`; null or quiet renders nothing, and a row expands to BaseItself's exported `ChangeLines`.
    - Lines: "N runs ended since you looked" (+ " · N didn't succeed") only when every counted actor holds a mark; otherwise "N runs ended", noted "Agents you haven't marked done show their last 7 days.", so a first look never claims "since you looked". "N reminders" (+ " · N passed while Cerebro was closed"). "Knowledge changed since you looked · N changes" once the lane holds a mark, else "Knowledge changed since the last convergence run · N changes" (Q26). BaseItself's blurb becomes "Since the last convergence run. Cerebro runs one every few minutes while it is open."
  - **Mock and presets.** `homeRuns` filters the fleet seed as Rust does (vault `demo`; constructs from engine/authors' `CONSTRUCT_ACTORS`), caps at 200 with truncated, and refuses while the fleet is unavailable. `homeChanges` is null with no seed, quiet at or past `to_seq`, else the seed with `changed_at`. Both go through `faulted`. Presets: runs, reminders and changes × five states.
- **Comments to delete:** BaseItself's "What moved since the last time anybody looked.", its blurb and its quiet line; ipc.ts' and lib.rs' converge docs ("`fromSeq` omitted means since the last stored run, which is the question a person actually asks").
- **Tests:**
  - fleet.rs: `ended_runs_are_this_vaults_finished_unattended_agent_runs`; `ended_runs_says_when_it_truncated` (201 give 200 and true; 200 give false); `ended_runs_never_lists_a_construct`; `fleet_reads_never_write` holds.
  - convergence: the window starts at your mark, at the last run, or at the start; a mark past the head is quiet; `changed_at` is the newest frame, and a quiet window has none. status.rs: `converge_json_has_no_changed_at`.
  - vitest: mockIpc; homeLanes (a mark hides until a newer run ends; a run that ended after the row rendered keeps it; unattributed; outcome words; reminder and change rows; lines; no mark yet: "N runs ended", the 7-day note, an 8-day-old run left out, and changes "since the last convergence run"; every actor and the change lane marked: both lines read "since you looked"; some actors marked: the note); useHomeDone (sends the rendered revision, never a newer one; Undo restores exactly; a rejected mark toasts and returns false); eventLanes (RunWhy; Done then Undo; a failed runs read stands alone; unreadable marks are partial with no Done; a null changes view renders nothing; the missed tag; runs and changes lines before and after a first mark); HomeLanes (seven lanes; every preset); BaseItself.
  - e2e `home.spec.ts`:
    - a first look, with no marks, reads "3 runs ended" with the 7-day note, each with why (release-scout at 11:30Z and 09:19Z, weekly-review yesterday at 20:00Z, plus a running, an attended and a construct row left out); release-scout sits under Last hour with "+1 earlier"; weekly-review sits under Yesterday;
    - after Done on each agent's 07-26 run and a reseeded fleet, the same three read "3 runs ended since you looked";
    - Done hides a run row until a newer run ends, and Undo restores it;
    - what changed clears on Done, and Undo restores it;
    - a failed runs read says so alone (`__cerebroSeedFleet(null)`);
    - a missed reminder says it passed while Cerebro was closed.
- **Acceptance:**
  - Roadmap (with .4): Home shows "3 runs ended since you looked" in relative-time sections, each row with its cause, once each agent shown holds a mark. A first look reads "3 runs ended" and names its 7-day window.
  - Roadmap: Done on a run row hides it until a newer run of that agent ends, and Undo restores it.
  - Roadmap: five presets each for runs, reminders and changes.
  - Done exists only on event rows and covers only the revision shown. A failed mark or undo toasts and never throws.
  - What changed covers since your Done, else the last convergence run's window, and says which. The false copy is gone. Each event lane fails alone, and neither a lane before its first mark nor unreadable marks claim "since you looked".
- **Packaged check (owner):** a scratch agent scheduled two minutes out ends, and Home reads "1 run ended" with its why. Done; relaunch; still hidden; its next run brings it back as "1 run ended since you looked". Approve a proposal; after the tick, Home shows Knowledge changed; Done; relaunch; hidden. `sqlite3` shows the marks in `done_marks`.
- **Wave** 6 · **Depends** M64.4, .3, .1; M56.7, .9; M55.12; M60.3, .7 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(home): runs, reminders and Knowledge changes since you looked, each with Done and Undo (M64.4b)`.

### M64.4c Your recent edits on Home, from History's fold

- **What:** "Your recent edits" needs M58.1's actor, read and folded by .2. It stays apart so .4 holds at L and Home reuses History's one fold.
- **Files:** `src/engine/homeLanes{,.test}.ts`, `src/pages/home/{EditsLane.tsx, EditsLane.test.tsx}` (new), `src/pages/home/{HomeLanes.tsx, HomeLanes.test.tsx, home.presets.ts}`, `e2e/home.spec.ts`.
- **Approach:**
  - EditsLane reads .2's `vaultActivity` over the last 7 days through useFeed and folds with `sessionsOf`.
  - `editRows(sessions, entries)` keeps `human:me` sessions whose rows are `content` (Rust's CONTENT_KINDS decide; comments never count). One row per current path, following rename rows inside the window; `at` is the newest session's end; "edited N times". Pages gone from the vault are counted in a note. Line: "N pages you edited in the last 7 days".
  - Notes: always "Edits made outside Cerebro aren't listed."; "Edits before {date} weren't recorded." when recording began inside the window; the writes lane's `more` gives a partial note; a failed read gives `section-unavailable`.
  - HomeLanes registers edits after changes, and its test asserts every HOME_LANES id has a component. Presets: edits × five (not recorded: recording began inside the window; partial: truncated; unavailable: failNext `vault_activity`).
- **Comments to delete:** none known.
- **Tests:** homeLanes `editRows` (only `human:me` content rows; agent, unattributed and comment rows left out; five saves are one row; newest first; gone pages counted; the before-recording note); EditsLane (unavailable; the not-recorded note; the outside footnote; rows open pages); HomeLanes (eight lanes; every id has a component; every preset); e2e "a page you saved five times shows once" (one row under Last few minutes, reading edited).
- **Acceptance:**
  - Roadmap: five presets for edits.
  - Roadmap risk: writes made outside the app are unattributed, and the lane says they aren't listed.
  - A page saved five times in one session is one row, and days before recording read "not recorded". Agent and unattributed writes never count as yours.
- **Wave** 7 · **Depends** M64.4b, .4, .2, .1; M58.1, .1b · **Size** S · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(home): your recent edits, one row per page, from History's fold (M64.4c)`.

### M64.5 Platform step (D12 b): macOS 14 and Tauri 2.12 in one gated commit

- **What:** the lock holds tauri 2.11.5, @tauri-apps/api 2.11.1 and @tauri-apps/cli 2.11.4, and `minimumSystemVersion` is 10.15. Current plugins need tauri ^2.12. Comments in shell/, lib.rs and the policy README cite tauri-2.11.5 lines, and shell/mod.rs says the floor is 10.15. Checked in this Mac's cargo cache: 2.12.3 keeps every API the shell uses with no new deprecation, its default menu is byte-identical, and it needs Rust 1.90 (the pin is 1.95).
- **Files:** `src-tauri/{tauri.conf.json, Cargo.toml, Cargo.lock}`, `package.json`, `pnpm-lock.yaml`, `src-tauri/src/{shell/mod.rs, shell/links.rs, shell/quit.rs, lib.rs}`, `shared/policy/README.md`, `deny.toml`, `scripts/toolchain.test.ts`, `README.md`.
- **Approach:**
  - **Precondition.** M55.10's quit.rs and M59.1's title hook are in. No other part edits Cargo.toml, the locks, package.json or lib.rs in parallel, and this part runs cargo last in wave 5.
  - **Bump.** tauri.conf.json `minimumSystemVersion` "14.0". Cargo.toml tauri `~2.12`, commented: D12 (M64.5), the floor current plugins need, and crate and JS API move together because the CLI checks their minor. tauri-build and the dialog plugin stay "2". `cargo update -p tauri --precise <newest 2.12.x>`: the lock diff names only the tauri family and its new transitive crates, and `cargo tree -d` shows one version of each tauri-* crate and of wry. package.json @tauri-apps/api and cli `~2.12.0`, then `pnpm install`; @tauri-apps/plugin-dialog stays 2.7.2, so its halves still pair. No plugin and no capability change.
  - **Citations** (CV-11). Re-read each claim in the new source, then fix it: shell/mod.rs (create:true windows get no hooks; `get_app_url`; M59.1's title hook and the new wry); links.rs and the policy README's links.v1 row (the asset fallback); lib.rs (Ready right after setup); quit.rs (Tauri's macOS default menu; the tao version). The throttling paragraph: the floor is macOS 14, so wry applies backgroundThrottling on every supported Mac. deny.toml's urlpattern sentence changes only if unic-* left the tree, and a new license is allowed one at a time, naming its crate. README: "It needs macOS 14 (Sonoma) or later."
  - **Build and smoke.** `scripts/mac-build.sh --no-install`, then `PlistBuddy -c 'Print :LSMinimumSystemVersion'` reads 14.0. The owner runs the smoke list, recorded in the commit body:
    - navigation: an http link and `target=_blank` open the browser; a `[[link]]` stays in-app; a path link is refused without a reload;
    - IPC: open the demo vault, save a page and see the file change, run one assistant turn, read Settings;
    - drag: a block by its handle, a board card across columns, a sidebar favorite, the window by its title bar;
    - the title follows the page, and ⌘Q right after typing keeps the line (M55.10's probe).
- **Comments to delete:** shell/mod.rs' "(tauri-2.11.5 app.rs:2524-2525)", "`minimumSystemVersion` is still 10.15, so an older Mac keeps WebKit's default.", "(`get_app_url`, tauri-2.11.5 manager/mod.rs:348-367)" and M59.1's "tauri 2.11.5's hook; wry 0.55.1 implements it on WKWebView"; links.rs' and the README row's "(tauri-2.11.5 manager/mod.rs:405-425)"; lib.rs' "(tauri-2.11.5 app.rs:1423-1428)"; quit.rs' "Tauri 2.11.5's macOS default" and "tao 0.35.3"; deny.toml's unic-* sentence, only if the bump removes them.
- **Tests:** shell/mod.rs `the_macos_floor_is_14` (through tauri's own Config); toolchain.test: the tauri crate and @tauri-apps/api share a major.minor, and so do both dialog halves. Unchanged and passing: the shell config and guard tests, `shell/links.rs::replays_the_shared_link_cases`, `shell/quit.rs::the_menu_is_tauris_macos_default_with_our_quit`, `ipcContract.test.ts`. Full vitest, e2e and skip-listed cargo; CI Linux runs the crash suite.
- **Acceptance:**
  - Roadmap: `minimumSystemVersion` 14 and Tauri 2.12 in one gated commit, with the full gate and a packaged smoke test of navigation, IPC and drag (the owner's step, recorded in the commit body).
  - The bundle's LSMinimumSystemVersion is 14.0. The lock holds one version of each tauri-family crate, the JS API and CLI are 2.12.x, and both dialog halves pair.
  - Every 2.11.5 citation names the locked version with re-checked lines, and no comment claims a 10.15 floor. No plugin and no capability change.
- **Wave** 5 · **Depends** M64.3; M55.10; M59.1; M53.12, .24 · **Size** S · **Crash risk** no · **Packaged check** yes (the owner's smoke test)
- **Commit:** `chore(platform): macOS 14 floor and Tauri 2.12 in one gated step (M64.5)`.

### M64.6 Reminders reach Notification Center, with an honest permission

- **What:** useReminders posts through the web `Notification` API. Whether that works in WKWebView is unmeasured, it is likely inert, and it fails silently. Nothing reads the macOS permission. objc2-user-notifications 0.3.2, objc2 0.6.4, objc2-foundation 0.3.2 and block2 0.6.2 are already locked. tauri-plugin-notification reports Granted on every desktop and posts as Terminal in dev, so both permission and delivery go through UNUserNotificationCenter. D9 (b) holds: banners only for reminders you set, no badge, no count.
- **Files:** `src-tauri/{Cargo.toml, Cargo.lock}`, `src-tauri/src/{shell/notify.rs (new), shell/mod.rs, lib.rs, rails.rs}`, `src/lib/{ipc, mockIpc, mockIpc.test}.ts`, `src/engine/reminders{,.test}.ts`, `src/hooks/useReminders{.ts, .test.tsx}`, `src/pages/{ReminderSettings (new), SettingsPage}{.tsx, .test.tsx}`, `src/components/ui/DatePicker{.tsx, .test.tsx}`, `src/lab/sections/reminderSettings.tsx` (new), `scripts/lint-rails.test.ts`, `e2e/{boot.ts, reminders.spec.ts}`, `AGENTS.md`, `README.md`.
- **Approach:**
  - **Crates.** macOS-only direct dependencies on the four locked crates, with minimal features (the notification center, settings, content, request, trigger and sound; NSBundle, NSString, NSError). A comment says they are already locked and why the plugin was refused. Only the dependency lists change in Cargo.lock.
  - **`shell/notify.rs`.**
    - Pure: `Permission {Allowed, Quiet, Denied, NotAsked, Unknown}` from the UN status, where anything unrecognised reads Unknown; `is_bundled(identifier, bundle_path, expected)` is true only for the config's identifier and a `.app` path; `capped(text, max)` counts characters.
    - macOS: `permission`; `request`, only from NotAsked, with Alert and Sound and never Badge (D9), waiting up to 120 s and then re-reading; `post(id, title, body)`, which re-reads settings, posts only when Allowed or Quiet with the default sound and no trigger, and waits up to 2 s (an error gives Failed).
    - `is_bundled` runs before any UN call, because UN raises an Objective-C exception in an unbundled process. Completion handlers send over `sync_channel(1)`, and a timeout reads Unknown or Failed. Both unsafe derefs carry SAFETY comments. Off macOS, all three read Unknown.
  - **Commands and mock.** lib.rs: `notification_permission`, `request_notification_permission`, `post_notification(id, title, body)`, async, answering in words and passing `app.config().identifier`. ipc.ts reads any other word as unknown (CV-05) and wraps `notification_permission` in `faulted`. The mock counts as unbundled: it reads unknown, and a post returns unknown and logs. Seam `__cerebroSeedNotifications(state)`; reader `__cerebroMockNotifications()`.
  - **Delivery.** `bannerFor(announcements)` merges one tick into at most one banner: one announcement keeps its title and body, and several read "{n} reminders" joined by " · ", capped at 120 and 400 characters. That coalesces the launch burst. useReminders deletes `notifyDesktop` and the web path; each tick toasts every announcement first, then calls `void postNotification(…)` with only the reminders you set. The hook never asks for permission (Q29).
    - You set it (D9 b, Q30): a type-level reminder (.3b; Type docs are human-only), or a chip on a page whose last recorded content writer is `human:me` (M58.1b's `pageAttribution`, read once per page at post time). An agent's write, unattributed, not recorded, Knowledge or a failed read toasts only.
  - **Settings.** `ReminderSettings.tsx` adds a Reminders section after Workflow. It reads the permission on mount and on window focus and says it in words:
    - Allowed: "Allowed. A reminder also shows in Notification Center."
    - Quiet: "Allowed quietly. Reminders go to Notification Center without a banner."
    - Denied: "Off. Turn on Cerebro in System Settings → Notifications to see reminders there. They still show in Cerebro."
    - Not asked: "Not asked yet.", with Allow notifications (`reminders-allow`).
    - Unknown: "Unknown. Only the installed app can read this. Reminders still show in Cerebro."
    - A failed read is `section-unavailable`, and `notification-permission` carries `data-state`. Presets: ready is allowed, empty not asked, not recorded unknown, partial quiet, unavailable a failed read. DatePicker's hint names Notification Center.
  - **Rails and docs.** lint-rails: only useReminders calls `postNotification`, so agent runs never notify, and no `new Notification(` or `Notification.requestPermission` remains in src. rails.rs: `notify::post(` is called only from lib.rs' command. AGENTS.md names notify.rs as the one door to Notification Center. README gains a Reminders paragraph: allow in Settings, and a self-built app may need allowing again.
- **Comments to delete:** useReminders' `notifyDesktop`, "Best-effort desktop notification; in-app toast always fires alongside." and "Webview without Notification support: the toast already covers it."; .3b's DatePicker hint; shell/mod.rs' "useReminders' 30 s check, which exists to post a desktop notification"; AGENTS.md's shell/ entry, which names only the window.
- **Tests:**
  - notify.rs: `unknown_statuses_never_read_as_allowed`; `only_the_app_bundle_counts_as_bundled` (no id, a wrong id, the right id outside a `.app`, both right); `an_unbundled_process_reads_unknown_without_asking_macos` (the cargo test process itself); `an_unbundled_post_never_reaches_macos`; `text_is_capped_by_characters`. rails.rs: `only_the_reminders_command_posts_a_notification`.
  - vitest: mockIpc (unknown by default; the seam; the post log); `bannerFor` (one; missed plus due merged; the caps); useReminders (at most one post per tick; the toast fires when the post rejects or reads not allowed; no permission request; a chip on a page an agent last wrote, or an unattributed, unrecorded or unreadable one, toasts with no post, while a type-level reminder and a chip on a page you last wrote post); ReminderSettings (each state's words; Allow only when not asked; asking re-renders; focus re-reads; unavailable); SettingsPage; DatePicker; lint-rails.
  - e2e `reminders.spec.ts`: the browser build reads Unknown. With `__cerebroSeedNotifications('allowed')`, two due reminders saved through the editor (so you are the page's last writer) give one toast and exactly one logged post, titled "2 reminders"; the same chips in a file seeded with no write row toast with no post.
- **Acceptance:**
  - Roadmap: an unbundled dev build reads notification permission as "unknown".
  - Roadmap, with .3: a reminder due while the app was closed gives one notice: a toast plus at most one banner.
  - The real permission is read through objc2 behind a bundle-id guard, and nothing reports a false "granted".
  - D9 (b): banners go only to reminders you set, type-level ones and chips on pages you last wrote. A chip an agent wrote, or one on an unattributed or unrecorded page, toasts only.
  - The launch burst is one banner per tick, the toast always fires, agent runs never notify, and no Dock badge is asked for or set. No web Notification code remains, no plugin is added, and capabilities are unchanged.
- **Packaged check (owner):** Allow shows the macOS prompt and the row reads Allowed. A reminder two minutes out, with Cerebro in the background, gives one banner. One made due while quit gives one toast and one banner after relaunch. `pnpm tauri dev` reads Unknown. An agent run ends with no banner, a chip an agent appended toasts with no banner, and the Dock shows no badge.
- **Wave** 7 · **Depends** M64.5, .3b, .3; M58.1b · **Size** M · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(reminders): reminders reach Notification Center through an honest permission read (M64.6)`.

### M64.7 Meetings become records: speakers matched to people, a summary card, and a repeat drop names its filed copy

- **What:** VTT and SRT ingest exists (`toWorkingDoc`, `ingestFiles`), but speakers stay plain strings, a repeat drop files a numbered second copy, and the organize card shows no summary and never checks attendees. M53.18 already fixed the card's title and failure handling. No Rust or manifest change is needed: propose_organize's `properties` already carries summary and attendees.
- **Files:** `src/engine/{ingest, transcripts (new), filing (new)}{,.test}.ts`, `src/lib/{ingest, prompts}{,.test}.ts` (ingest.test new), `src/lib/productBrief.test.ts`, `src/agent/{ProposalCard.tsx, ProposalCard.test.tsx, promptGrant.test.ts, mockAgent.ts, mockAgent.test.ts}`, `src/detail/TranscriptSpeakers{.tsx, .test.tsx}` (new), `src/pages/InboxPage{.tsx, .test.tsx}`, `src/lab/sections/transcriptSpeakers.tsx` (new), `e2e/pipeline.spec.ts`.
- **Approach:**
  - **Repeats.** `toWorkingDoc` stamps `source_sha256: sha256Hex(content)` on every inlet, files and pastes. `filedCopyOf(entries, sha)` returns the first copy in path order outside knowledge/. `ingestOne` returns `filed {path}` or `duplicate {path, title}`, checking a per-drop `seen` map, then the store. It reads entries only when `entriesVault === vaultPath`; otherwise "The vault is still opening. Try again in a moment." A duplicate writes nothing. `describeIngest`: "Filed N note(s) to the Inbox", then "<filename> is already filed as <title>" joined by "; ", then the skipped detail; "Nothing filed" only when nothing was filed or duplicated.
  - **Speakers** (`engine/transcripts.ts`, pure). `transcriptFacts(entry)` answers only for `ingest_format` vtt or srt; absent `speakers` reads not recorded (null) and `[]` reads none. `matchSpeakers(labels, schema, entries)`: candidates are pages of a people type (`peopleTypes`), outside knowledge/ and not Type docs. A label matches by title ignoring case, or by stem or declared `slug` equal to `slugify(label)`. One hit is matched, none is none, and several are ambiguous with a count; the code never guesses. A speaker the file already links (`relationships.speakers`, CV-09) counts as matched.
  - **Filing plan** (`engine/filing.ts`, pure). `filingPlan(proposal, entry, schema, entries)` gives `{type, title, patch, links, unfiled, transcript}`, with the title on one line.
    - A person field keeps only targets `personCandidates` resolves; a relation keeps pages of its `target` (untargeted: any page that is not a Type doc or under knowledge/); a derived two-way field is never written; an undeclared key keeps only links that resolve; `limit: 1` keeps the first. Dropped targets go to `unfiled`, with why: "no page", "not allowed here" or "over the limit".
    - Transcripts: `summary` is trimmed, and blank becomes null ("Nothing to summarize", no key written). Matched speakers join the one person field the proposal fills; with none or several, nothing joins and the card says why. Gates read `ingest_format`, `speakers` and field kinds only (CV-08).
  - **Card and prompt.** ProposalCard builds its rows from the plan: Type, Title, Summary, link fields as page titles, other properties, `proposal-unfiled` and `proposal-speakers-note`. `write()` keeps M53.18's order and patches `plan.patch`; nothing is written before Apply. `organizePrompt(path, transcript?)` is byte-identical without the second argument. With it, it opens "File the meeting transcript at <path> ("<title>")." and asks the agent to read it with get_note, then call propose_organize once with type, title, `properties.summary` (2–5 plain sentences from the transcript only, left out when there is nothing to summarize) and the attendees in the type's person field. Speakers are JSON-quoted and framed as data: matched ones with their `[[stem]]`, "has no page here: leave them out, never invent one", "matches N pages: leave them out", or "The file names no speakers." It says nothing is written until the person applies the card, and names only get_note, propose_organize and get_vault_context (CV-19). The M9.5 sentence and tools.v1 are untouched.
  - **Inbox.** `TranscriptSpeakers` sits under OrganizePanel's Type select: each `speaker-row` (`data-match`) opens its page, reads "no page" or "N pages match"; null speakers read "The file names no speakers"; a vault error is `section-unavailable`; "Add N to <Field>" writes the union when the type has exactly one person field. InboxPage sends the meeting ask for transcripts and the old ask otherwise; a duplicate paste toasts "Already filed as <title>". mockAgent gains a meeting branch before the knowledge script: one propose_organize with type Meeting (the demo's), "Meeting: <title>", one fixed summary and the prompt's matched links. Presets: all matched; partial (matched, none and ambiguous together); `[]`; no speakers key; a failed scan.
- **Comments to delete:** ProposalCard `write()`'s "Writes the whole filing: the frontmatter, then the title as the H1" (it now drops links that name no page) and its one-line title note (moves to filing.ts); lib/ingest.ts' "Everything that comes in from outside lands the same way" and `ingestOne`'s "return its path"; InboxPage takeFiles' "…arrive here as untyped working docs".
- **Tests:**
  - ingest (the hash on vtt, srt, markdown, text and paste; equal content, equal hash; `filedCopyOf` in any folder, skipping knowledge/, in path order, or null). lib ingest.test, on the real store over the mock: the same file twice files once and names the first copy's current title; twice in one drop; a paste twice; a renamed copy named by its new title; a vault still opening skips with words; `describeIngest`'s exact words.
  - transcripts (the gate; null vs `[]`; title, stem and slug matches; ambiguous counts; knowledge/ and Type docs never match; CV-09 fixtures). filing (each drop reason; plain names written as `[[stem]]`; relation targets; derived fields; dangling undeclared links; speakers join one field or say why; the summary rules; a non-transcript plan writes what M53.18 wrote).
  - ProposalCard (rows; Apply writes `plan.patch` and the H1; unfiled targets listed, never written; the mock fs unchanged until Apply; M53.18's cases pass). TranscriptSpeakers (each preset; a row opens its page; Add N only with one person field). prompts (byte-identical without the argument; the three speaker kinds quoted as data). promptGrant (both meeting variants). productBrief (every branch). InboxPage. mockAgent ("Help me clear the Inbox" keeps its script).
  - e2e `pipeline.spec.ts`: the ingest test asserts `source_sha256`; dropping the Scanner slip VTT twice toasts "… is already filed as Scanner slip", and no `inbox/scanner-slip-2.md` exists; on `inbox/phoenix-cutover-standup.md`, Marcus Webb, Priya Nair and Tom Keller match, the card shows Summary and Attendees, the file is unchanged before Apply, and Apply writes type Meeting, the summary, three links and the new H1.
- **Acceptance:**
  - Roadmap: dropping the same VTT twice says "already filed as X" and writes nothing the second time, within one drop too.
  - Roadmap: speakers match people deterministically: exactly one people page by title (ignoring case) or slug, never knowledge/, and ambiguity is named, never guessed.
  - Roadmap: the CLI proposal suggests title, summary and attendees. Nothing is written before Apply, and nothing applies it automatically.
  - Apply writes only links that resolve to a page the field allows, and the rest are listed on the card. A file with no speaker labels reads "not recorded", never empty. No gate reads a type name; tools.v1 and the M9.5 sentence are unchanged.
  - The Speakers block has five presets.
- **Live check (owner):** file the demo standup with the real CLI and see a summary and three attendees on the card.
- **Wave** 2 · **Depends** M64.1; M53.18; M54.7, .8; M55.6; M58.2; M60.9 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(inbox): transcripts become meeting records with matched speakers, and a repeat drop names its filed copy (M64.7)`.

### M64.8 Starter kit, offered once per empty vault

- **What:** nothing seeds a vault outside the demo (PRODUCT-5), so a new vault opens blank. Macro creates its first database once per user, never overwrites it and never brings it back after removal. Cerebro offers the kit explicitly instead of creating it in the background.
- **Files:** `shared/starter/{README.md, vault/getting-started.md, vault/types/tasks.md, vault/tasks/{read-getting-started,capture-an-idea,hand-a-task-to-the-helper}.md, vault/records/agents/{task-helper,weekly-notes}.md}` (all new), `.prettierignore`, `src-tauri/src/{starter.rs (new), lib.rs, connectors.rs}`, `src-tauri/fixtures/write-doors.json`, `src/lib/{ipc, ipc.test, mockIpc, mockIpc.test, starterKit.test (new)}.ts`, `src/app/StarterOffer{.tsx, .test.tsx}` (new), `src/pages/HomePage{,.test}.tsx`, `src/lab/sections/starterOffer.tsx` (new), `e2e/{boot.ts, starter.spec.ts (new)}`, `AGENTS.md`, `SECURITY.md`.
- **Approach:**
  - **Content** (byte-exact; each file installs at the same path in the vault; no retired term, no knowledge/ path, no raw control bytes).
    - getting-started.md: untyped, `icon: sparkles`, H1 "Getting started". It covers pages and databases, the Inbox, agents and Resume, and the Assistant, linking [[tasks]], [[task-helper]] and [[weekly-notes]].
    - types/tasks.md: `type: Type`, H1 "Tasks", `icon: list-checks`, `folder: tasks`; createDatabase's STARTER_STATUSES (todo, progress, done); `deadline: due` (M61.3b); fields status, priority (high, medium, low), due (date) and agent (relation, `target: Agent`, `limit: 1`); views `all` (a table of status, priority, due and agent, by due) then `board` (by status).
    - Three undated Tasks records: read Getting started (done, low), capture an idea (todo, medium), and hand a task to the helper (todo, low), which says to press Resume first, then set Agent.
    - Two agents, both `paused: true` and `tools: safe`: task-helper (`scope: [tasks]`, `when: [{event: assigned, field: agent}]` in M63.3's spelling, read tools plus append_to_note; it appends a short Context section and never changes status, dates or priority) and weekly-notes (`scope: [weekly]`, `schedule: weekly fri 17:00`; get_vault_context, list_notes, list_agenda, read_activity, get_note and create_note; one `weekly/<date>.md` with `if_exists: refuse`, touching nothing else).
    - The README states the rules: create-only, one batch, never knowledge/, agents born paused, offered once per empty vault, the marker at `.cerebro/starter.json`, no digest (one set of bytes). `.prettierignore` gains `shared/starter/` with its reason.
  - **Rust** (`starter.rs`). `STARTER_FILES` pairs each vault path with its `include_str!` bytes, the Type doc first and Getting started last; `MARKER_PATH`, `KIT_VERSION = 1`, `StarterMarker {kit, outcome: added | declined, offered_at}`.
    - `read_marker` refuses a symlinked `.cerebro` or marker. Not found is None; unreadable or unparsable is an error, never None. `write_marker` writes through connectors.rs' `write_owner_only`, now pub(crate).
    - `install(vault, by)` runs under a static lock: a marker refuses ("This vault was already offered the starter kit."); a marker read error refuses; any scanned page refuses ("The starter kit goes only into an empty vault, and this one has pages."); then one M60.6 create batch, then the marker. If the marker write fails after the batch, it logs and returns `marker_saved: false`; nothing rolls back. `decline` writes a declined marker only when none exists.
  - **Commands and mock.** lib.rs: `starter_marker`, `install_starter_kit` (guard_human_write over every kit path and one Human receipt, as `apply_batch`'s command does, so the receipt mint scan holds) and `decline_starter_kit`. The kit is compiled in, so there is no tauri.conf.json resource. ipc.ts adapters sit behind `inTauri()`, with `faulted` on the marker read and the install. mockIpc loads the kit through `import.meta.glob('/shared/starter/vault/**/*.md')` and mirrors Rust's order and words, all or nothing, logging one `human:me` vault.create per file. `write-doors.json`, M58.1's one list of doors, gains three `install_starter_kit` rows, replayed by lib.rs and mockIpc.test: an empty vault records one `human:me` vault.create per kit path, and a marked vault and a vault with a page are refused in starter.rs' exact words. `window.__cerebroEmptyVault` at init leaves the mock vault empty (`emptyMockVault()` for vitest).
  - **Offer.** `StarterOffer.tsx` (`starter-offer`) renders only when the vault is ready and scanned, holds no entries, and has no marker: "Add the starter kit", "No thanks", and one sentence naming what it adds and that nothing is overwritten. Add installs, rescans, toasts "Added the starter kit" (plus the marker sentence when it wasn't saved) and opens getting-started.md; No thanks declines and hides the card. Buttons disable in flight, failures toast and never throw (CV-03), and a failed marker read is `section-unavailable` with Retry. HomePage mounts it first, above .4's lanes. Presets: ready (empty, no marker); empty (the vault has pages); not recorded (a marker without `offered_at` still counts, so the card stays hidden); partial (failNext the install: the card stays, with the toast); unavailable (failNext the marker read).
  - **e2e and docs.** `boot(page, {vault: 'empty'})` sets `__cerebroEmptyVault` and waits for the sidebar's navigation; the default path is unchanged. AGENTS.md names `shared/starter/` in the repo map. SECURITY.md: shipped agents are born paused and scoped, and installing writes nothing outside the kit's paths.
- **Comments to delete:** boot.ts' "Booting the app into the demo vault, the same way in every spec"; any .4 Home docblock saying an empty vault's Home shows nothing.
- **Tests:**
  - starter.rs: the kit is every file under `shared/starter/vault`, byte for byte, with no hidden, climbing, non-.md or knowledge/ path; an empty vault gets every file and an added marker; a vault with a page and a marked vault refuse and stay byte-identical; a second install writes nothing; decline writes only the marker, and after an install changes nothing; a corrupt marker is an error; symlinks are refused; the marker stays outside the scan; each file records one `human:me` vault.create row (the sink armed as batch.rs' tests do).
  - lib.rs and mockIpc.test replay the three write-doors rows.
  - vitest: mockIpc (byte for byte; refusals verbatim from starter.rs; decline; `emptyMockVault`); ipc.test (names and keys); starterKit.test (installed and scanned, Tasks has its folder, statuses, fields and deadline, and both views pass `checkView`; three Tasks under tasks/; every Agent paused; links resolve inside the kit; each body names only tools its allowed-tools hold, each a manifest row); StarterOffer (the gate, marker states, add, refused add, unsaved marker, decline, in flight, no throw); HomePage (an empty vault shows the offer; the demo never reads the marker).
  - e2e `starter.spec.ts`: an empty vault's Home offers the kit; Add writes Getting started, the Type doc, three tasks and two paused agents, nothing under knowledge/, and opens Getting started; Home stops offering; No thanks hides the offer; the demo vault is never offered.
- **Acceptance:**
  - Roadmap: an empty vault is offered the kit once: Getting started, a Tasks database with Table and Board views and three records, and agents born paused. Create-only, with a marker in `.cerebro/`, never touching knowledge/.
  - Add writes the kit in one batch and opens Getting started; No thanks writes only the marker; after either, the vault is never offered again.
  - A marked vault or one with any page refuses in the same words in Rust and the mock, held by `write-doors.json`'s rows, and nothing is written.
  - Every kit write records `human:me`, and the marker never enters the scan. The views pass checkView, links resolve, and no retired term appears.
  - A failed marker read shows `section-unavailable`, never the offer and never nothing. The offer has five presets.
- **Dev-build check (owner):** open an empty folder, add the kit, and see the files and `.cerebro/starter.json`. Reopen the vault: no offer.
- **Wave** 8 · **Depends** M64.1, .2c, .4; M55.11; M58.1; M59.5; M60.2b, .6; M61.3b, .6b; M62.3; M63.3 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(home): an empty vault is offered a starter kit once: Getting started, a Tasks database and paused agents, create-only (M64.8)`.

### M64.9 Recipes as editable skill files: Catch me up and What I did

- **What:** no recipe ships; the demo's weekly-review skill is the closest. Macro defines its system skills in code. Cerebro ships them as vault files the person owns, which keeps M17's rule against an in-app catalogue.
- **Files:** `shared/starter/vault/records/skills/{catch-me-up,what-i-did}.md` (new), `shared/starter/{vault/getting-started.md, README.md}`, `src-tauri/src/starter.rs`, `src/lib/recipes{,.test}.ts` (new), `src/library/RecipesOffer{.tsx, .test.tsx}` (new), `src/lab/sections/recipesOffer.tsx` (new), `src/library/LibraryIndex.tsx`, `src/engine/skills{,.test}.ts`, `src/agent/{AiPanel.tsx, mockAgent.ts, mockAgent.test.ts, promptGrant.test.ts}`, `src/lib/productBrief.test.ts`, `e2e/recipes.spec.ts` (new).
- **Approach:**
  - **Catch me up** (new words): `type: Skill`, `slug: catch-me-up`, an argument `since` (default: the last 24 hours), allowed-tools get_vault_context, list_agenda, query_records, list_inbox, read_activity and get_note. The body sets the window from `since` and the stated local time, then reads Home's lanes in HOME_LANES order that its tools can see: deadlines and tasks (list_agenda, plus query_records on databases with a status field), runs ended and your edits (read_activity), captures (list_inbox), coming up (list_agenda). One short section per non-empty lane: counts first, newest first, each item a [[link]], never ranked. It ends with "## What this can't see": proposals waiting, reminders due or missed, what changed since the last convergence run, and what you marked Done. It writes nothing.
  - **What I did:** `slug: what-i-did`, an argument `day` (default: yesterday), allowed-tools read_activity, list_notes and get_note. The body computes the day's local bounds from the stated time and offset, keeps your writes and the Assistant's in turns you started, and groups them by morning, afternoon and evening, one line each with a time and a [[link]], then two or three sentences on the day. It keys on read_activity's open line: a day that line says Cerebro was not open, or whose open times are not recorded, reads "not recorded", never "nothing". A cut-short answer says so. It ends with "## What this can't see": edits outside Cerebro, days Cerebro was closed, pages you only read. Both files: no retired term, no missing link, only their own tools; prohibitions name no tool (CV-19); a closing tip names `schedule:`, but neither ships scheduled.
  - **Install.** `STARTER_FILES` gains both rows, so new vaults get them and the walk test passes again; the README gains a recipes paragraph, and Getting started gains "type /catch-me-up or /what-i-did to the Assistant". `src/lib/recipes.ts`: `SHIPPED_RECIPES` (a glob of the two files with path, bytes and slug), `missingRecipes(entries)` (present by path or declared slug) and `addRecipes` (one M60.6 create batch through `vaultStore.applyBatch`; never throws). `RecipesOffer` (`recipes-offer`) on the Library's Skills tab: while one is missing, one line names it and one button adds it; it disappears once both exist. It only copies files; nothing runs from code. It reads entries only when `entriesVault === vaultPath`, so it shows nothing before the scan lands, and a failed scan renders `section-unavailable`, never an offer of both. Presets (`src/lab/sections/recipesOffer.tsx`): ready (one missing); empty (both present); not recorded (a copy at the shipped path with no `slug:` still counts, so only the other is offered); partial (a refused batch: the offer stays, with the toast); unavailable (a failed scan, seeded as .7's preset is).
  - **Clock line and mock.** engine/skills.ts `localTimeLine(now, offsetMinutes)` gives "The user's local time is YYYY-MM-DD HH:MM (UTC±HH:MM)."; `skillPrompt(skill, raw, request, clock?)` appends it, and the panel's /skill expansion (AiPanel, or wherever M57 moved it) passes the clock. mockAgent gains a skill-invocation branch after APPEND, anchored on `^The user invoked the skill "`: it replies with the skill's title and shows its read tools, proposing nothing, so a recipe that mentions the Inbox never reaches the filing script.
- **Comments to delete:** `skillPrompt`'s docblock ("The message actually sent for an invocation") gains the time line; any .8 README line saying the kit ships no skills; mockAgent's header list of branches, if it enumerates them.
- **Tests:**
  - recipes.test: both files parse through `listSkills` with slugs, arguments and descriptions; every allowed tool is a read_only manifest row a run can hold; `mentionedTools(body)` stays within `grantedTools(allowed-tools)`; no retired term. Catch me up's can't-see bullets equal the HOME_LANES no allowed tool reads, and the lanes it reads keep Home's order. What I did names its three gaps and keys "not recorded" on read_activity's open line ("Cerebro was not open in this window"). Both say they never rank and write nothing. `missingRecipes` by path and slug; `addRecipes` sends one batch with the exact bytes and writes nothing when a path exists.
  - RecipesOffer (shows and names the missing; adds; disappears; a refused batch keeps it; disables in flight; nothing before the scan lands; a failed scan is `section-unavailable`; every preset); skills.test (`localTimeLine` at offsets 240, 0 and −330 gives UTC-04:00, UTC+00:00 and UTC+05:30; no clock, no change); promptGrant (the clock line names no tool); productBrief (no retired term); mockAgent (a skill that mentions the Inbox proposes nothing); starter.rs' walk test covers both rows.
  - e2e `recipes.spec.ts`: the Skills tab adds both recipes; their cards appear, the files carry their slugs, and the button is gone; `/catch-me-up` in the panel leaves no proposal card; an empty vault's kit includes both.
- **Acceptance:**
  - Roadmap: Catch me up and What I did ship as editable skill files with read-only tools, each naming the lanes it can't see.
  - Every allowed tool is read_only in tools.v1, each body names only tools it holds, and nothing persists a summary.
  - Catch me up keeps Home's lane order and never ranks. What I did reads "not recorded" for a day read_activity says Cerebro was not open, and names edits outside Cerebro as unseen.
  - New vaults get both through the kit, and existing vaults through one Library button that adds only missing files. Each copy is then the person's to edit or delete. The offer has five presets, waits for the scan and says when it failed. A panel skill turn states the local time and offset, naming no tool.
- **Live check (owner):** run /catch-me-up and /what-i-did on a test vault. Both only read, name their gaps, and say "not recorded" for a day the app was closed.
- **Wave** 9 · **Depends** M64.7, .8, .2c, .4; M62.2, .3; M59.5; M60.6; M54.7 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(skills): Catch me up and What I did ship as editable read-only recipes that name what they can't see (M64.9)`.

## Done or dropped

- **Done:** none. **Dropped:** none; all 9 roadmap parts build.
- **Split,** each by its own roadmap bullets: .2 → .2b (a page's History) and .2c (`read_activity`); .3 → .3b (the type-level reminder and the labels); .4 → .4b (event lanes with Done) and .4c (your recent edits).
- **Relabelled:** .3's CALENDAR-4 → CALENDAR-6; .4's CALENDAR-11 → CALENDAR-12.
- **Beyond the roadmap, on purpose:**
  - .2: commits sit in History's day groups as their own rows; the heatmap counts sessions, agents' included, never commits.
  - .3: the session window learns its cause (app or vault), and a vault reopened in the same process is open again.
  - .3b: checked lines and finished records stop reminding.
  - .4: `ReviewCard.submitted_at`; useDocTasks names its unreadable notes.
  - .4b: What changed covers since your Done; `ChangesView.changed_at`.
  - .6: a Reminders row in Settings, with Allow.
  - .7: every organize card writes only links that resolve.
  - .9: every panel skill turn states the local time and offset.
- **Not built unless asked or measured:**
  - a changed-keys column for History (Q6);
  - banner click-through, and banners while Cerebro is frontmost (both need a UN delegate; Q31);
  - minute and hour offsets for timed reminders (Q20);
  - repeating records remind once, at the stored date, until CALENDAR-7b;
  - retention for `vault_writes`, `reminder_fires` and `done_marks`;
  - re-offering the kit (Q34); moving a filed meeting out of inbox/ (Q11);
  - ⌘Z and `e` for Home's Done (M65).

## Owner questions

Each default applies if unanswered. Ask a wave's questions before it starts.

| # | Part | Question | Default taken |
| --- | --- | --- | --- |
| Q1 | .1 | Make "a section that reads ships five lab presets" a numbered convention in AGENTS.md, at the next free CV id? | Yes, enforced by presets.test and the e2e loop. |
| Q2 | .1 | Offer the lab from Settings in dev builds, as Macro's Developer tools does? | No; the URL is enough, and nothing in the app links to it. |
| Q3 | .2 | The heatmap counts editing sessions per day, agents' included, never commits, with no totals or streaks. OK? | Yes. |
| Q4 | .2 | Checkpoints share History's day groups as their own rows, rather than a separate tab (PRODUCT-3 suggested a tab)? | Same day groups. |
| Q5 | .2 | The feed covers the heatmap's year, revealed 14 days at a time? | Yes. |
| Q6 | .2 | Add a changed-keys column (a schema step) so History names the properties that changed (COMMS-1)? | No. History says "edited", and M58.4's lens shows what changed. |
| Q7 | .2 | Fold an assistant conversation's turns (one session id) into one row per day? | Yes. |
| Q8 | .7 | Write matched speakers to disk at drop time? | No. Only Apply or the explicit Add button writes them. |
| Q9 | .7 | The summary as a `summary:` property or a body section? | The property: a frontmatter write leaves the open editor alone. A body write waits for M65.7's guard. |
| Q10 | .7 | Give pasted text the repeat check too? | Yes; every inlet carries `source_sha256`. |
| Q11 | .7 | Should Apply move a filed meeting out of inbox/? | No; that is M60.10's link-keeping rename, a later part. |
| Q12 | .2b | On knowledge pages, list ledger events instead of the concept file's write rows? | Yes; the ledger carries their meaning. |
| Q13 | .2b | Fold a page's History to its newest 8 rows, with the oldest pinned and "Show N more"? | Yes. |
| Q14 | .2c | Include agent runs as rows beside page writes? | Yes; "what changed" includes what agents did. |
| Q15 | .2c | Keep read_activity deferred, outside the always-loaded read core? | Deferred; the core stays small and history questions are rare. |
| Q16 | .2c | UTC instants with the machine's zone named, rather than local times? | UTC. |
| Q17 | .3 | When runtime.db can't be read, should reminders still fire (once per session, with one toast saying so), or wait? | Fire and say so once; a missed reminder costs more than a repeat. |
| Q18 | .3 | Insight dismissals keep M8.3's "forever", or hide only the revision seen, like Home's event rows? | Forever; the imported entries carry no revision, and M8.3 promised it. |
| Q19 | .3b | A daterange field reminds before its start, or before its end when it is the type's deadline? | Its start, as body chips do. |
| Q20 | .3b | Add minute and hour offsets (10 minutes, 1 hour before) for timed values now? | No; the roadmap bullet doesn't name them. |
| Q21 | .4 | Lanes live on Home, led by the My work lane, with the My work page unchanged? | Yes. |
| Q22 | .4 | Keep the Collections grid at Home's foot? | Keep it; dropping it is its own call. |
| Q23 | .4 | The My work lane lists record deadlines through this week plus every open checklist task, and renders nothing when empty, so the "No open tasks…" coaching line goes? | Yes. |
| Q24 | .4 | Coming up covers the next 7 days and skips each type's deadline field, which the My work lane shows? | Yes. |
| Q25 | .4b | Runs that count: this vault's unattended agent runs, not panel turns and not the three background constructs? | Yes. |
| Q26 | .4b | Before your first Done, What changed covers the last convergence run's window onward, and the runs lane the last 7 days? | Yes, and both lines name that window, never "since you looked"; the whole ledger or 200 runs would flood a first look. |
| Q27 | .4b | Should ⌘Z undo a Home Done? | No: the toast's Undo only, until M65's registry (D11). |
| Q28 | .4c | Your recent edits: the last 7 days, only edits Cerebro recorded as yours, one row per page? | Yes. |
| Q29 | .6 | Ask for permission only from the Allow button in Settings, or also at the first reminder, as the web path did? | Settings only. |
| Q30 | .6 | Reminder chips an agent wrote raise banners like any other? | No (D9 b): banners go to type-level reminders and to chips on pages whose last recorded content writer is you (M58.1b); the rest toast only. |
| Q31 | .6 | Clicking a banner opens the reminder's page? | Not in M64; it needs a UN delegate. A click brings Cerebro forward. |
| Q32 | .8 | Which agents ship? | task-helper (wakes on assignment, writes only in tasks/) and weekly-notes (Fridays 17:00, writes only in weekly/), both paused. |
| Q33 | .8 | Name the database Tasks (`type: Tasks`) or Task? | Tasks, as the roadmap says. |
| Q34 | .8 | Offer the kit again from Settings, after No thanks or in a vault with pages? | No. |
| Q35 | .9 | Offer the recipes to existing vaults from the Library? | Yes: one button on the Skills tab while one is missing. |
| Q36 | .9 | State the local time and UTC offset on every panel skill turn? | Yes. |

Ask Q1–Q2 before wave 1, Q3–Q11 before wave 2, Q12–Q16 before wave 3, Q17–Q18 before wave 4, Q19–Q24 before wave 5, Q25–Q27 before wave 6, Q28–Q31 before wave 7, Q32–Q34 before wave 8 and Q35–Q36 before wave 9.

## Risks

- **Size:** 7 L + 4 M + 3 S ≈ 9.8 L, about twice the roadmap. Seams if a part outgrows L: .2's feed as .2d, .4's Coming up lane as .4d, .7's Speakers block as .7b, .8's offer as .8b.
- **D9** (roadmap risk): Home opens at launch, so its lanes are seen without being asked for. Silence when empty, no count, bell or push, Done only on events, and the recorded M43 amendment bound it. The starter offer is the one explicit, one-time exception.
- **Outside writes** (roadmap risk): they are unattributed. History, a page's History, Home's edits lane and read_activity each say so.
- **Notification grants** (roadmap risk): ad-hoc rebuilds reset them, so .6 is proven on a packaged build, and README says so. A UN call in an unbundled process aborts the app: the bundle guard runs first, and a cargo test proves the unbundled path never reaches macOS. No banner shows while Cerebro is frontmost; the toast covers it.
- **Recipes** (roadmap risk): files, not a catalogue (M17). The Library button copies two files once, and the copy that runs is always the vault file.
- **Crash wedge:** .3's step runs inside the migration kill-point children. Mac cargo keeps the skip list, and CI Linux runs the full crash suite after the wave-4 push.
- **Platform (.5):** wry 0.55 → 0.57, muda 0.20 and a newer tao can change drag, navigation and menus where neither jsdom nor the mock can see. The owner's smoke test is the proof. CI Linux may need new apt packages. Macs on macOS 13 or older can't open new builds.
- **Volume and time:** a heavy year ships up to 20,000 write rows in one IPC call; past a cap, older days read "not read", never 0. Text order isn't time order at a seconds boundary, and a test pins the margin. vitest has no TZ pin, so every local-day case sets and restores `process.env.TZ`.
- **Unrecorded history:** `app_sessions` exists only since M49.9, and only for vaults with a ledger store. Days before the first `vault_writes` row read not recorded even when Cerebro was open, and the seam line says when recording began. A vault without a ledger store has no session window, so its reminders fall back to the 24 h grace and never read "missed".
- **Identity drift** (stated, not fixed):
  - a moved vault folder gets a new `vault_id`, so its marks and claims stop matching: rows come back, and a reminder inside its window may fire once more;
  - a rename while the app was closed gives a reminder a new identity;
  - the one-time localStorage import is global, so it can mute a same-path reminder or hide a same-path insight in a second vault, as today.
- **New exposure:** operational write and run records and open times reach agents and other apps holding a read token (.2c), bounded by read scope and stated in SECURITY.md. Speaker labels are untrusted: the prompt JSON-quotes them as data, and the card writes only links that resolve.
- **Names from unbuilt plans:** M62's and M63's plans name `query_records`, `list_agenda`, the read toolset's token default, `RunGrant::for_client`, the `assigned` event, M63.7's check rows and their schema steps; none is built yet. .8's and .9's tests fail loudly on a missing tool name, .4b leaves M63.7's rows out by lane or cause, and .3 reads `USER_VERSION` at build time.
- **Mock-only proofs:** the browser keeps no ledger, no real session window and no notification center, and its vault id is `demo`. The concept lane (.2b), a real restart and webview wipe (.3), the derived vault id (.4b) and permission and delivery (.6) are proven only by the packaged checks.
- **Hot files** (the waves serialize them):

  | File | Parts |
  | --- | --- |
  | lib.rs | .2, .2b, .3, .5, .4b, .6, .8 |
  | ipc.ts | .1, .2, .2b, .3, .4, .4b, .6, .8 |
  | mockIpc.ts, mockIpc.test.ts | .2, .2b, .3, .4, .4b, .6, .8 |
  | e2e/boot.ts | .1, .2, .2b, .3, .6, .8 |
  | AGENTS.md | .1, .2, .4, .6, .8 |
  | demoOperational.ts | .2, .2b, .4, .4b |
  | engine/reminders.ts, useReminders.ts, e2e/reminders.spec.ts | .3, .3b, .6 |
  | homeLanes.ts, HomeLanes.tsx, home.presets.ts, e2e/home.spec.ts | .4, .4b, .4c |
  | engine/activity.ts | .2, .2b |
  | Cargo.toml, Cargo.lock, shell/mod.rs | .5, .6 |
  | DatePicker.tsx | .3b, .6 |
  | LearnedCard.tsx, useDocTasks.ts | .3, .4 |
  | HomePage.tsx | .4, .8 |
  | BaseItself.tsx, Lane.tsx | .4, .4b |
  | fleet.rs | .2 (visibility), .4b |
  | uiStore.ts | .2b (if), .3 |
  | README.md | .5, .6 |
  | SECURITY.md | .2c, .8 |
  | shared/policy/README.md | .3, .5 |
  | mockAgent.ts, promptGrant.test.ts, productBrief.test.ts | .7, .9 |
  | starter.rs, shared/starter/ | .8, .9 |

- **Changes the owner will see:**
  - a dev-only state lab at `/state-lab.html` (.1);
  - History with a year heatmap, sessions per day, runs and checkpoints in day groups, "not recorded" days and an outside-edits line (.2); a page's History tab that adds edits, runs and Knowledge events (.2b); agents that can read activity (.2c);
  - reminders that fire once per claim, missed ones said once (.3); type-level reminders and honest labels, with checked lines going quiet (.3b); Settings → Reminders and Notification Center banners (.6);
  - Home's lanes under the greeting, led by My work, with the "No open tasks" line gone (.4); runs, reminders and changes with Done and Undo (.4b); your recent edits (.4c);
  - macOS 14 required (.5);
  - "already filed as", meeting cards with summary and attendees, and a link check on every organize card (.7);
  - the starter offer on an empty vault (.8), and two recipes in the Library (.9).
- **Left open on purpose:**
  - no retention for `vault_writes`, `reminder_fires` or `done_marks`;
  - Home is pull-only: a run that ends while Home is open shows on the next visit;
  - captures ingested before .7 carry no `source_sha256`, and a re-export with other line endings counts as new;
  - `.cerebro/` is gitignored, so a fresh clone of a still-empty vault is offered the kit again;
  - no UN delegate: no banner while Cerebro is frontmost, and no click-through.

## Gate

- **Each part,** before its commit:
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test:run`;
  - parts that touch Rust (.2, .2b, .2c, .3, .3b, .4, .4b, .5, .6, .8, .9) add `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the skip-listed `cargo test`;
  - `PORT=<free> pnpm e2e <specs>`, once `lsof -iTCP:<port> -sTCP:LISTEN` shows the port free. Parts that change `boot()` (.1, .8) and .5 run the full suite:

    | Part | Specs |
    | --- | --- |
    | .1 | the full suite (`state-lab` new) |
    | .2 | `history`, `attribution`, `state-lab`, `fleet`, `smoke` |
    | .2b | `page-activity`, `page-history`, `comments`, `attribution`, `state-lab` |
    | .2c | `agent`, `agents`, `agent-writes`, `client-access` |
    | .3 | `reminders`, `pipeline` |
    | .3b | `reminders`, `deadlines`, `collections` |
    | .4 | `home`, `state-lab`, `deadlines`, `destinations`, `workspace`, `smoke` |
    | .4b | `home`, `state-lab`, `fleet`, `base-itself` |
    | .4c | `home`, `state-lab` |
    | .5 | the full suite |
    | .6 | `reminders`, `state-lab` |
    | .7 | `pipeline`, `inbox`, `state-lab` |
    | .8 | the full suite (`starter` new) |
    | .9 | `recipes`, `starter`, `agent`, `state-lab` |

  - .1 also runs `pnpm build` once and checks dist/ holds no state-lab.html and no lab chunk. .5 also builds with `scripts/mac-build.sh --no-install` and reads the plist.
- **Each wave tip:** the same gate on the branch, with `pnpm test:coverage` and the full e2e suite.
- **M64 closes when:**
  - the full gate passes on the tip, with every coverage floor held or raised;
  - CI is green on the push, the Linux crash suite included;
  - every roadmap M64 acceptance bullet holds;
  - the owner has run the packaged checks (.2, .2b, .3, .4b, .5's smoke test, .6) on a `./scripts/mac-build.sh` build, the live checks (.2c, .7, .9) on CLI 2.1.250 with an isolated login, and .8's dev-build check, and has looked at the built app;
  - the D9 amendment is in the M43 spec, and the roadmap's M64 status records the splits and the relabels.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```
