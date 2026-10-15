---
name: record-cli
description: Record Claude Code runs on the pinned CLI and sanitize them into src-tauri/fixtures/cli-stream/real/. Use when the CLI pin moves, when a sweep fails on a new stream kind, or when a part needs a real run it does not have yet.
---

# record-cli

A checklist only. The scripts' headers hold the detail; where this file and a
header disagree, the header wins and this file gets fixed.

## When to record

- The CLI pin (`CLI_VERSION` in `scripts/cli-record/reduce.ts`) moved:
  re-record everything, spike and real, on the new version first.
- `src-tauri/src/agent/recordings.rs` fails on a kind: the CLI sent something
  `src-tauri/src/agent/kinds.rs` has no row for. Classify it (translated, or
  ignored with its reason) in the same commit as any change to `translate`.
- A part needs a real run a derived recording only stands in for (a meta
  with `"recorded": "derived"`).

## The isolated login, once

- Never an API key, never your own config. The record folder is
  `$CEREBRO_RECORD_DIR`, else the system temp folder's `cerebro-cli-record`;
  the driver refuses one inside the repo or the Claude Code config home.
- `pnpm tsx scripts/cli-record/spike.ts setup`, then run `claude` with
  `CLAUDE_CONFIG_DIR` set to the folder's `claude-config`, type `/login`
  with your own account, and exit.

## Record

- Spike and scripted runs: `pnpm tsx scripts/cli-record/spike.ts run all`
  (or one name). The spike's facts reduce with `reduce all`; the scripted
  runs never reduce.
- App runs, through the tee: a debug build only. Start `pnpm tauri dev`
  with `CEREBRO_RECORD_DIR` set, open the folder's `vault`, and use the app.
  Each run leaves `runs/<stamp>-<run>.stream.jsonl`, `.argv.json` and
  `.end.json`, owner-only, and the child signs in from the same
  `claude-config`. A release build records nothing.
- For the scout's refused write, set `schedule:` on its record (the folder's
  `vault/records/agents/scout.md`) a few minutes ahead and wait.

## Sanitize

- The spike's corpus: `pnpm tsx scripts/cli-record/sanitize.ts corpus all`
  (the `CORPUS` table names each recording and what it proves).
- Anything else, one run at a time: `sanitize.ts --stream <file> --name
  <name> --source app --proves <one sentence>`, plus `--ends` when the run
  never reached a result. It finds the session file from the init.
- It refuses rather than guesses: an init key it does not know (add it to
  `INIT_KEEP` or `INIT_DROP` with a reason), a server other than the toys or an exact `--allow-server <name>`
  (one flag per reviewed connector, written into the recording meta), an
  API-key source, another CLI version, or any hit in the post-scan. Its report
  is counts only, so it is safe to paste.

## Commit

- Only `src-tauri/fixtures/cli-stream/real/`: the stream, its meta, and the
  session file where the run wrote one. Raw runs never leave the record
  folder.
- Run `pnpm vitest run scripts/fixtures.test.ts scripts/cli-record/` and the
  Rust sweep, `cargo test -- agent::recordings agent::kinds`, with the crash
  skip list from `.husky/pre-push` on a Mac.
- A recording that replaces a derived one keeps its name; its meta then says
  `"recorded": "live"`.
