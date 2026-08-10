# M29 Wave 2 — RUNNING STATE (live; update after every task)

**Purpose:** this file is the resume point. The coordinator is running Stages F/G/H
overnight and self-compacting. If you are a fresh agent (or a compacted coordinator),
**read this file first, then `2026-08-09-cerebro-m29-wave2-handoff-FGH.md`** for the
deeper background. This file supersedes the handoff wherever they disagree.

**User instruction (2026-08-09, before sleeping):** "Get all of M29 done." Work
autonomously. **This does NOT override Stage G's stop-and-report gate** — see section 5.

---

## 1. Where the work is

Worktree `/Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid`,
branch `m29-mermaid`. **Do not merge to main. Do not push.**

**THE CWD TRAP — it has now caught five agents including the coordinator.**
Begin EVERY Bash call with
`cd /Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid && ...`.
The session cwd silently resets to the parent checkout, which is a DIFFERENT BRANCH
(`m22-m28-convergent-intelligence`, actively being committed to by another session)
with no `src/mermaid/flowchart/` at all. It reports plausible green numbers for the
wrong code. The coordinator lost a verification round to this.

`docs/` is gitignored, so plan/spec commits need `git add -f`.
Scratch files go in the session scratchpad, **never** in the repo (a scratch
`*.test.ts` has already broken another agent's `format:check` mid-glob).

## 2. Progress

| Task | Commits | Status |
|---|---|---|
| F1 M29.35 icons | `72e4cfc` + `d19e5ba` | DONE, 2 reviews, gates green |
| F2 M29.36 click lines | `8cc6a3d` + `114e24b` | DONE, 2 reviews, gates green |
| doc: picture not inert | `3e9d49e` | DONE |
| refactor: model.ts split | `7ea2a22` | DONE, counts identical |
| F3 M29.37 subgraph ops | `6fbb1b5` + `8030dc7` | DONE, 2 reviews, gates green |
| doc: anonymous subgraph | `32c2802` | DONE |
| refactor: EdgeEditor out | `3f5ffc1` | DONE, counts identical |
| F4 M29.38 canvas affordances | `0f2ab4f` | committed; **review pending** |
| F5 M29.39 | — | TODO |
| G1–G5 M29.40–.44 | — | TODO, **G1 is a GATE** |
| H1–H6 M29.45–.50 | — | TODO |

**Baseline now: 177 files / 2765 passed / 2 skipped.** Lint, typecheck, format, build clean.
(Wave started at 172 / 2584.)

## 3. Two structural decisions already taken (do not re-litigate)

- **`model.ts` was split** into `types.ts` / `parse.ts` / `emit.ts` / `views.ts`;
  `model.ts` is a 17-line barrel. `from './model'` works everywhere. DAG:
  views to parse to types. Don't create a cycle.
- **`EdgeEditor.tsx` was extracted** from `StructuralEditor.tsx`. Build new
  substantial surfaces as their own component files — F4 added `LinkPopover`,
  `SubgraphToolbar`, `GroupBar`, `LinkBadges` that way.

## 4. THE RULE THAT HAS DECIDED EVERY TASK

**Measure, don't reason.** The plan's account of mermaid behavior has now measured
FALSE **19 times** (F1:1, F2:5, F3:6, F4:7). Several would have shipped silent
document corruption. Brief every implementer to treat plan claims about mermaid as
hypotheses. The app bundles **11.16.0**; the vendored source in the MAIN checkout
(`docs/examples/mermaid-develop/`) is **11.16.1** — verify version-sensitive claims
against the bundled build. Only `*.mermaid.test.ts` may `import mermaid`.

Corrections already written back into the F plan: lines 18, 23, 25, ~890, ~1740, ~2050.

**Breadth is not coverage.** A 500-input and a 140-input sweep both missed a real bug
because every document in both corpora linked the same node id. A 42-document sweep
missed a diagram-killing rename because every rename used the same two titles. Vary
STRUCTURE *and* SPELLING, and mutation-test the sweep itself.

## 5. STAGE G IS GATED — READ BEFORE STARTING IT

Task **G1 (M29.40)** is a time-boxed feasibility spike with written exit criteria, and
a risk ledger at plan lines ~18–33 that must be read before any code.

**If any exit criterion fails: commit the findings, STOP Stage G, and report.**
The nudge-offset fallback is **NOT pre-authorized**. The user accepted "full free-drag"
as the appetite; a fallback is a materially lesser product and is the user's call.
"Get all of M29 done" does **not** authorize pushing through this gate.

If G1 fails: finish Stage H in full, document G's findings, and report both. Stopping
at the gate is an **expected, reportable outcome — not a failure.**

## 6. Open follow-ups (carried, not yet done)

- **LIVE BUG, not yet fixed — the anchor strip is missing from three read-only svg
  sinks.** `MermaidDiagram.tsx:80`, `MermaidBlockView.tsx:391`,
  `MermaidLightbox.tsx:139` all inject mermaid output via the React raw-HTML sink with
  no `pointer-events-none`. A doc containing a hand-authored `click A "notes/x.md"`
  navigates the Tauri webview **off the SPA on one click, losing unsaved editor state**.
  `bindFlowchartSvg` now strips `href`; these three never bind. Wants a shared exported
  helper plus a test per surface. **Schedule this.**
- Link badges recompute only on re-bind, so a failed `renderMermaid` leaves stale
  badges over the last-good svg. Matches existing last-good policy; documented.
- `validSelected !== null ? nodeStyle(...) : {}` at the `NodeStyleMenu` call site is
  unreachable dead code (pre-existing).
- `SHAPES`/`SHAPE_BRACKETS` are duplicate data in two files after the split; not
  safely derivable from each other (`SHAPES` carries load-bearing ordering).
- `edgeMetaLines` is recomputed per call and `nodeMeta`/`edgeMeta` both call it, so a
  new consumer that maps over it is O(N x lines). Hoist.
- `.vscode/settings.json` has an uncommitted `"docs": true` to `false` edit that
  **predates this wave**. It is the user's editor setting. Leave it uncommitted.

## 7. Process that is working

1. One implementer subagent per plan Task. **Point it at exact plan line ranges**, not
   pasted text (hundreds of lines of exact code; transcription risk beats read cost).
   Tell it explicitly not to read other tasks.
   **Re-derive line ranges with `grep -n '^### Task '` — doc edits have shifted them.**
   Current: F1 41 / F2 489 / F3 708 / F4 1296 / F5 1944, file is 2068 lines.
2. **Review after every task** — it has caught something real on every single one,
   including a critical bug on F3 that would have shipped. Two reviewers for big
   integration tasks, one for pure-logic tasks.
3. **Only ONE reviewer may hold mutation rights on the worktree at a time.** Two
   concurrent mutation-testers produced a phantom edit and nearly invalidated both
   reviews. Give the second its own throwaway `git worktree` in the scratchpad.
4. **Triage reviews yourself.** Reviewers over-produce; roughly a third gets declined.
   Send the accepted list back to the SAME implementer via `SendMessage` so it keeps context.
5. **Verify every claim yourself** — run the gates, in the worktree, with the `cd`.
6. Implementers have overruled the coordinator with measurement twice, correctly. Ask
   them to push back rather than comply silently.

## 8. Machine conditions

Load averages of **130–160** from other sessions. Roughly one random `waitFor`-based
test fails per full-suite run. **A real failure repeats; a load flake moves.** Re-run
before concluding, and confirm in isolation. `src/editor/NoteBodyEditor.test.tsx` is
the usual victim and is unrelated to this wave.

**IDE diagnostics arrive STALE** — five times they reported missing exports that
`pnpm typecheck` proved present. Trust the gate, not the diagnostic.

## 9. Gates

Per task: `pnpm test:run && pnpm lint && pnpm typecheck && pnpm format:check`.
Full gate at the end: add `pnpm test:coverage`, `PORT=5273 pnpm e2e`, and
`cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.
Coverage thresholds ratchet UP only; branches at 85.13% vs an 80 floor is the tightest margin.
e2e: **no `--` before a filename**, and kill a stale `:5273` dev server between runs
(`lsof -ti :5273 | xargs -r kill`).
Commits: `type(scope): sentence (M29.<n>)`, trailer
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`, **never `--no-verify`**,
`git add` specific files only.
