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
| F4 M29.38 canvas affordances | `0f2ab4f` + `3b04c2a` + `079da7c` | DONE, reviewed, gates green |
| F5 M29.39 insert palette + e2e | `80ad6b1` + `213d496` + `0b1b34d` + `68a0a19` | DONE, reviewed. **STAGE F COMPLETE** |
| G1 M29.40 spike | `1f98c1b` | **GATE PASSED — verdict PROCEED** (all 4 criteria YES) |
| G2 M29.41 position model | `bca6474` + `74939ee` | DONE, reviewed |
| G3 M29.42 render pipeline | `d6adea5` + `2a8dcf1` | DONE, reviewed |
| G4 M29.43 drag + toggle | `8d5dcfa` (+ `2a8dcf1`) | DONE, reviewed |
| G5 M29.44 e2e + gate | `6c29790` | DONE. **STAGE G COMPLETE** |
| H1 M29.45 ViewType plumbing | `22041af` | DONE, reviewed |
| H2 M29.46 view + useDiagramFile | `d8ea48a` `0eae807` `b8c476f` | DONE, reviewed |
| H3 M29.47 record cards | `ab1dd19` + `27bdd21` | DONE, reviewed |
| H4 M29.48 host wiring | `719faa6` | DONE, reviewed |
| H5 M29.49 fossil sweep | `d5648ab` | DONE, reviewed |
| H6 M29.50 e2e + gate | `d522f4b` | DONE, reviewed. **STAGE H COMPLETE** |

**FINAL, wave complete: 185 files / 3051 passed / 2 skipped; e2e 45; coverage
78.73 / 85.74 / 72.38 / 78.73 against floors 48/80/58/48; cargo 221 + clippy + fmt clean.** Lint, typecheck, format, build clean.
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
FALSE **24 times** (F1:1, F2:5, F3:6, F4:7 [one later retracted], F5:5). Several would have shipped silent
document corruption. Brief every implementer to treat plan claims about mermaid as
hypotheses. The app bundles **11.16.0**; the vendored source in the MAIN checkout
(`docs/examples/mermaid-develop/`) is **11.16.1** — verify version-sensitive claims
against the bundled build. Only `*.mermaid.test.ts` may `import mermaid`.

Corrections already written back into the F plan: lines 18, 23, 25, ~890, ~1740, ~2050.

**Measure the INTEGRATION, not just the unit.** M29.39's e2e caught that M29.35's icon
control was a one-way trapdoor: mermaid draws an icon node as `g.icon-shape`, not
`g.node`, so `bindFlowchartSvg` lost the node entirely — toolbar, rename, delete,
connect and link badge all gone, including the only control that removes the icon.
**Two thorough M29.35 reviews missed it**, both of which measured real mermaid: they
checked the model bytes and the render, but never the binding AFTER the op. When a task
adds a way to change what mermaid emits, test what the NEXT layer does with it.

**Breadth is not coverage.** A 500-input and a 140-input sweep both missed a real bug
because every document in both corpora linked the same node id. A 42-document sweep
missed a diagram-killing rename because every rename used the same two titles. Vary
STRUCTURE *and* SPELLING, and mutation-test the sweep itself.

## 4b. TWO DEFECTS A GREEN GATE DID NOT CATCH — read before trusting any suite

**1. The shipping code path had never been exercised.** `beginManualLayout` takes its
exact/CTM arm whenever `getScreenCTM` exists — always in a browser, never in jsdom. So
100% of the drag tests ran the fallback arm. M29.42/.43 passed unit, lint, typecheck,
coverage, e2e AND cargo while the feature was broken in every real browser: the module
composed a PINNED svg matrix with LIVE element matrices, and `growViewBox` invalidated
the pin, so every re-routed edge and label detached from its nodes mid-drag and the node
itself could vanish under the cursor. Found only by a reviewer planting a *live*
`getScreenCTM` harness. **If a branch is unreachable in jsdom, assume it is untested.**

**2. React 19 re-applies the raw-HTML prop when the PROP OBJECT differs, not when the
html string does.** A fresh `{{ __html: svg }}` literal per render rebuilt the whole svg
subtree on every re-render — wiping manual transforms and **restoring the link hrefs
M29.38 strips** (that effect is keyed on the svg string, so it did not re-run either).
Memoize the prop on the string. Found by accident while chasing an unrelated test.

## 5. STAGE G IS GATED — READ BEFORE STARTING IT

Task **G1 (M29.40)** is a time-boxed feasibility spike with written exit criteria, and
a risk ledger at plan lines ~18–33 that must be read before any code.

**If any exit criterion fails: commit the findings, STOP Stage G, and report.**
The nudge-offset fallback is **NOT pre-authorized**. The user accepted "full free-drag"
as the appetite; a fallback is a materially lesser product and is the user's call.
"Get all of M29 done" does **not** authorize pushing through this gate.

If G1 fails: finish Stage H in full, document G's findings, and report both. Stopping
at the gate is an **expected, reportable outcome — not a failure.**

## 5b. WAVE COMPLETE — what remains open

All three stages (F M29.35-.39, G M29.40-.44, H M29.45-.50) are implemented, reviewed
and gated. **Not merged, not pushed.** The branch is `m29-mermaid`.

Follow-ups recorded rather than silently taken:

- **The "no type special-casing" invariant is asserted NOWHERE in the repo.** Replacing
  a `f.kind === 'status'` capability check with `entry.type === 'Work item'` passes all
  37 tests in that file. Implementations are correct; the gap is that every status-kind
  field in `demo-vault/types/*` and `src/test/factories.ts` is literally named `status`.
  Closing it means adding a fixture type with a differently-named status field to the
  golden corpus — a corpus change, deliberately not made unreviewed at wave's end.
- **`demo-vault/` carries two prose edits** from the M29.49 sweep
  (`strategy/okr-tree.list.yml:19`, `delivery/how-we-schedule.md:28`). Verified
  unasserted by any spec, but it is a golden-corpus change made by a test commit.
- **A fresh whiteboard opens at 400% zoom** — the empty seed renders a 76x36 svg so
  `CanvasViewport`'s initialFit clamps to MAX_SCALE. Self-corrects once a node exists;
  nobody has looked at it on a real screen.
- **Whiteboard on a Type screen and on a root-level List are unit-covered only** — the
  e2e exercises the List-in-a-collection host.
- **A record node added from the host bar carries no manual-layout position** (the
  toolbar's placer lives on `FullScreenDiagramEditor`'s internal ref). It lands at its
  dagre position and the user drags it once. Deliberate; a feature-sized change to close.
- **One M29.28 exit criterion is still UNVERIFIED by design**: the packaged-app check
  that `Save PNG...` opens the native macOS dialog. Needs `./scripts/mac-build.sh`.

## 6. Open follow-ups (carried, not yet done)

- ~~LIVE BUG: anchor strip missing from read-only svg sinks~~ **FIXED in `3b04c2a`**
  (`src/mermaid/svgLinks.ts`, applied at FOUR sinks). Two things that fix found:
  **stateDiagram-v2 emits `xlink:href`**, which an `a[href]` selector does not match
  at all; and `pointer-events-none` is NOT sufficient (it blocks a mouse, but an SVG
  anchor is keyboard-focusable and activates on Enter). Historical note follows.
- (historical) the three sinks were: `MermaidDiagram.tsx:80`, `MermaidBlockView.tsx:391`,
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

## 7b. SHARED-WORKTREE HAZARD — run ONE implementer at a time

The husky **pre-commit hook runs `pnpm lint` over the WHOLE TREE**, so any agent
mid-edit blocks every other agent's commit. One agent waited ~20 minutes for a
clean tree (it correctly refused `--no-verify`). Concurrent implementers also make
`format:check` and the suite report each other's in-flight work as failures, which
costs real time to disambiguate.

**Reviewers may run concurrently** (read-only, or mutation-testing in their OWN
`git worktree add` under the scratchpad). **Implementers must be serialized.**

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
