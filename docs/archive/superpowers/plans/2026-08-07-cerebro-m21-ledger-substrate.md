# M21 — Write integrity and the tamper-evident ledger (substrate only)

**Brief for the agent picking this up cold.** Written 2026-08-07, immediately after
the master roadmap (`convergent-intelligence-overhaul.md`, Rev 2, same directory)
was accepted. `AGENTS.md` covers commands and conventions; the master doc covers
the architecture (D1–D12) — read D2, D3, D4 before touching anything. This file
adds only what M21 needs: exact formats, the acknowledgement rule, the crash
matrix, and the traps.

**M21 is boring on purpose. That is the point.** No intelligence features, no new
user-visible behavior, no schema for beliefs or claims. It proves the substrate —
atomic writes, an append-only hash-chained ledger, recovery, a rebuildable index —
before any epistemic behavior is entrusted to it. If a phase here feels like it
wants to be clever, it is wrong.

---

## Where things stand

- **Branch `m21-ledger-substrate` off `main` at `81210b9`** (M19+M20 merged via
  PR #10). `m20-table-integrity` is done; do not branch from it.
- Everything lands in `src-tauri/` (Rust) except M21.7 (a few lines in
  `src/git/useGit.ts`) and mock stubs for any new IPC command
  (`src/lib/mockIpc.ts` — parity is tested, see the trap below).
- The vault engine is stateless: every command re-scans disk. There is no
  existing DB, no version tokens, no atomicity anywhere. `write_file`
  (vault/write.rs:59-66) is a bare `std::fs::write`; the watcher's own-write
  suppression is a 4-second path+Instant window (vault/watcher.rs:14,59-73);
  `knowledge/log.md` is rewritten whole per insert (knowledge.rs:244-294).

## Non-goals (defend these)

- No belief/claim/observation semantics — that is M22. Shadow events here are
  plumbing traffic (see M21.8), versioned `v: 0`.
- No projection generation, no capture of human edits — M23.
- No proposals, no policy layer — M24.
- No UI besides a diagnostics IPC command. e2e suite must pass **untouched**.
- No change to what any existing command does from the caller's point of view.

## Two rules that must survive contact with implementation

**The acknowledgement rule (event commit).** An event is committed when and only
when:

    write frame → flush userspace buffers → fsync open segment
    → only then return committed {event_id, seq} to the caller

Sealing is a **separate** operation and is never the transaction boundary:

    finish segment → write seal record → fsync → rename open→sealed
    → fsync ledger directory

Tests must assert both halves independently. An implementation that quietly
treats sealing as the commit point is wrong even if every test passes by luck.

**Event identity ≠ entity identity.** A ledger frame carries an immutable
`event_id` and `seq`. Entity IDs (a belief, an observation) live in the event
*body*, and entity **versions are derived by the M22 reducer** — explicit version
state, never "the last seq that touched this thing." M21 does not implement
entity versions; it must also not accidentally imply them (no `version` field in
the frame envelope).

---

## Physical format (M21.2 — fixed here so every phase agrees)

Ledger directory: `<vault>/.cerebro/ledger/`. Not git-tracked (the `.cerebro/`
blanket ignore in git/commit.rs:21 and its `rm --cached` self-heal stand — do NOT
touch them). Invisible to the scanner (dot-dir) and the watcher
(`is_relevant_path` requires `.md`/`.yml`).

- `store.json` — `{ store_id, format: 1, created_at }`. Minted once per vault
  ledger. `store_id` and `writer_id` are 128-bit random hex via the existing
  `rand` crate — no uuid dependency (house rule: justify every crate;
  cf. the tiny_http comment in Cargo.toml).
- `writer_id` lives in **app-data**, not the vault — it identifies this machine's
  installation. Two Macs syncing one vault must present different writer_ids.
- Segments: `{writer_id}-{start_seq:016}.ndjsonl.open` while active; sealed by
  rename to `{writer_id}-{start_seq:016}.ndjsonl`. Write-once after seal — no
  code path may open a sealed segment for writing.
- One record per line (NDJSON). Envelope:

      { "v": 0, "seq": N, "event_id": "<hex128>",
        "prev": "<hash of previous record>", "hash": "<hash of this record>",
        "ingested_at": "<RFC3339 millis>", "wall_clock_anomaly": false,
        "kind": "vault.write", "body": { ... } }

  `hash` = SHA-256 (sha2 crate, already present) over the canonical JSON of the
  record with `hash` set to `""`. Canonical = serde_json with preserve_order and
  a fixed field order emitted by one Rust struct — the struct IS the canon; no
  separate canonicalization pass.
- `prev` of the first record of segment N+1 = `hash` of the last record of
  segment N (the chain crosses segment boundaries). `prev` of the very first
  record = the store_id (so an empty-prefix splice is detectable).
- Seal record: `{ "kind": "ledger.seal", "body": { "records": n,
  "segment_hash": "<hash over all record hashes in order>" } }` — the last line
  of every sealed segment.
- A torn tail is, by construction, a partial **last** line. The commit invariant
  (master doc D2): **only complete, hash-valid records before the first
  malformed trailing record are committed.** Recovery truncates the open segment
  to the last valid record; a malformed line anywhere *other* than the tail is
  corruption, not a torn write — fork/integrity state, never silent truncation.
- Durability calls: `File::sync_all` — on macOS Rust's std issues
  `F_FULLFSYNC` (with fsync fallback), which is exactly what the ledger wants.
  Verify this against the std source for the pinned toolchain during M21.2 and
  cite it in a code comment; if it turns out not to hold, issue
  `fcntl(F_FULLFSYNC)` directly.

## Phases

One commit per phase, `type(scope): sentence (M21.n)`.

### M21.1 — Atomic vault writes
`vault/write.rs::write_file` becomes: create parents → write content to
`.{filename}.cerebro-tmp-{hex}` in the **same directory** → set permissions from
existing destination if present → `sync_all` the temp file → `note_own_write`
(destination; the temp path is invisible to the watcher — non-`.md` dotfile) →
`rename` over destination → `sync_all` the **parent directory** (open the dir,
sync, close) → best-effort remove temp on any error path.

Orphan cleanup: `pub fn clean_orphan_temps(vault)` — remove `*.cerebro-tmp-*`
files **older than 60 seconds** (age guard: the engine is stateless and
concurrent commands re-scan constantly; an in-flight write's temp must never be
reaped; use `FileTimes` in tests to backdate). Wire it into the `scan_vault`
command path (lib.rs:60) — once per scan, cheap, no new command.

Known limitation, documented not solved: xattrs are not preserved across the
rename (same trade-off as every atomic-save editor); attachments imported via
copy (`import_attachment`) stay non-atomic — they do not flow through
`write_file` and are out of M21 scope.

Tests: existing write tests pass unchanged; permissions preserved (chmod 600 →
rewrite → still 600); no temp remains after success; stale orphan reaped, fresh
orphan spared; crash-point tests (see harness below) at `temp-written` (dest
untouched, orphan present) and `renamed-pre-dirsync` (dest has new bytes).

### M21.2 — Ledger physical format
Pure data layer, no policy: frame struct, canonical serialization, record hash,
chain verification, segment reader/writer, seal records, store.json. Property
tests: encode→decode round-trip; verify(chain) catches every single-bit flip in
any field; a torn tail (truncate at every byte offset of the last record — loop,
not spot checks) always recovers to the last valid record.

### M21.3 — Single writer + append API
Lockfile `<vault>/.cerebro/ledger/lock` via OS advisory lock (flock — auto-
released on kill -9; a pidfile is stale after one). New crate `fs4` (justify in
Cargo.toml). Sequence allocation, core-only stamping (`ingested_at`,
`wall_clock_anomaly` when now < prev's wall clock), the acknowledgement rule
verbatim. The module exposes `append(kind, body) -> Committed{event_id, seq}`
and **nothing else** — no update, no delete, no open-sealed-for-write. The
tripwire is the module's public surface: a code-review check, and a test that
the segment files' mtimes never change after seal across an append run.

### M21.4 — Recovery
On open, classify the ledger deterministically. The matrix, each its own test:
valid sealed segment · valid open segment · torn payload (partial JSON tail) ·
torn frame header (partial line start) · bad hash mid-segment (corruption →
integrity state, NOT truncation) · missing seq (gap) · duplicate seq (fork) ·
foreign writer_id segment (diagnosable, never merged) · foreign store_id
(adopt-and-reingest is a later milestone; v1 = refuse with a named state) ·
restored older head (head regression vs app-data latest-seen → divergence
state). Recovery's output is a typed verdict consumed by M21.8 — never a bool.

### M21.5 — Materialized index
SQLite via `rusqlite` (bundled feature — no system dependency; justify in
Cargo.toml) in **app-data**, keyed by store_id. Tables: events (replay cursor),
meta (latest-seen head, writer_id). Replay from segments; `rebuild-from-zero`
must produce a byte-identical index (test: rebuild twice, dump, compare); index
corruption (truncate the .db mid-file in a test) → delete and rebuild, never
trust. The index is a cache — nothing may exist in it that segments cannot
reproduce.

### M21.6 — Watcher self-write recognition (groundwork)
Content-hash own-write recognition: `note_own_write` records the SHA-256 of what
was written alongside the timestamp; a change event on a path whose current
content hashes to a recorded own-write is a no-op **regardless of timing**. The
4-second window survives only as the UI-refresh debounce heuristic
(watcher.rs:14 keeps its constant, loses its authority). This is groundwork for
M23's manifest — no capture behavior yet. Test: a foreign write landing inside
the 4s window after an app write is NOT suppressed (the exact hole the time
window has today, watcher.rs:68-73).

### M21.7 — Git cross-attestation
Checkpoint commit messages gain one trailer line: `Cerebro-Ledger-Head: <hash>`
(frontend, `src/git/useGit.ts` checkpoint message builder, ~:266-352). Rust
gains a command to read the current chain head. **Ledger correctness must not
depend on git in any way** — a vault with no repo, git missing from PATH, or a
failing checkpoint (useGit.ts:294-296 swallows failures by design) changes
nothing about ledger behavior. Language discipline: this is *periodic anchoring*
(master doc D2), and the diagnostics wording must say so.

### M21.8 — Shadow-mode observability
Shadow events start flowing: `vault.write` (rel path + content hash + actor
where the call site knows it), `vault.delete`, `vault.rename`,
`knowledge.write_concept`, `knowledge.verify` — emitted from the existing write
paths, `v: 0`, additive-only from here on. Startup runs verification (M21.4)
and records the verdict. One new IPC command `ledger_status` returning
`{ verdict, head, seq, segments, anomalies }` for diagnostics; **no UI**, no
event emission to the frontend, zero behavioral change. mockIpc stub returns a
fixed `{ verdict: "no-ledger" }` — the browser mock has no ledger and the
parity test asserts only the command exists on both sides.

## Crash-injection harness

A `crash_point(name)` seam in the Rust core: no-op unless env
`CEREBRO_CRASH_POINT=name`, then `std::process::abort()`. Tests spawn the
current test binary (`std::env::current_exe`) as a child running a scenario
`#[test]` (filtered by exact name) with the env var set, then assert
filesystem post-conditions in the parent. Deterministic state-construction
tests cover the same intermediate states directly (build the torn file, run
recovery) — the child-process tests exist to prove the states are *reachable*,
the construction tests to enumerate them exhaustively.

**Acceptance matrix — kill Cerebro at every ugly point.** M21 is done when each
of these leaves a state the system can deterministically explain (what
committed, what did not):

| Kill point | Must hold afterwards |
| --- | --- |
| midway through temp-file write | destination untouched; orphan reaped later |
| immediately after rename, before dir fsync | destination has new bytes; no orphan |
| halfway through a ledger frame | recovery truncates to last valid record; seq resumes correctly |
| after event fsync, before ack reaches caller | event IS committed; caller retry is idempotent-visible (documented, not hidden) |
| during segment sealing | open segment still valid; seal retried on next open |
| while rebuilding the index | index deleted and rebuilt from zero; verdict unchanged |

## Traps (learned elsewhere, paid for already)

- **The `.cerebro/` gitignore self-heal is armed**: commit.rs:44-50 runs
  `git rm -r --cached .cerebro` on every checkpoint. Never track ledger files.
- **mockIpc parity is tested** — every new IPC command needs a mock stub and a
  parity assertion, but keep guard logic OUT of the mock (M21 adds none).
- **demo-vault is a test fixture** — M21 must not add files to it or touch its
  mtimes (the distiller's `behind` heuristic keys on mtime, okf.ts:407; a
  stampede burns real quota). Shadow mode writes only under `.cerebro/`.
- **`pnpm test` is watch mode** — use `pnpm test:run`. Rust gate:
  `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`.
- **Never `--no-verify`.** Pre-push runs the full gate including e2e; a stale
  dev server on :5173 fails all of e2e at boot → `PORT=5273 pnpm e2e`.
- The watcher deliberately bypasses suppression for agent writes (mcp.rs:589
  forces rescans). M21.6 must not break that — content-hash recognition applies
  to the funnel's own writes, not to MCP-forced refreshes.

## Exit criteria

Full acceptance matrix green · recovery matrix green (every row its own test) ·
chain verifies over a demo-vault soak (open app, run existing unit suites
against a ledger-enabled vault, verify) · `cargo test`/fmt/clippy clean ·
`pnpm test:run` + e2e untouched and green · zero user-visible change anywhere.
