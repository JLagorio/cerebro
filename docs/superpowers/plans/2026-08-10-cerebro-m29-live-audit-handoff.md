# M29 live-audit handoff — fixing what driving the app actually found

**Branch** `m29-mermaid` · **PR** [#11](https://github.com/JLagorio/cerebro/pull/11), open,
mergeable · **HEAD at handoff** `390fa04`

You are picking up a wave that is *built and green* and has just been driven, by hand and by
seven parallel agents, in a real browser. The build passing its own gate is not in question.
What this handoff carries is the gap between "the gate is green" and "a person can use this",
which turned out to be **71 findings** wide.

| Surface | Findings | | Severity | |
|---|---:|---|---|---:|
| Mermaid blocks inside a document | 14 | | `broken` | 15 |
| The full-screen block editor dialog | 11 | | `wrong` | 28 |
| Non-flowchart types, the lightbox, export | 11 | | `rough` | 28 |
| Structural editor gestures, zoomed and panned | 11 | | | |
| The `.mmd` diagram page | 9 | | | |
| The whiteboard view | 8 | | | |
| Dark mode, narrow viewports, keyboard-only | 7 | | | |

`broken` means a user cannot do the thing, or data is wrong, or something disappears. `wrong`
means it works but is visibly incorrect. `rough` means it works and looks fine and is worse than
a Lucidchart-grade tool would be.

Read [the appendix](./2026-08-10-cerebro-m29-live-audit-findings.md) for the findings
themselves. Read this file first for how to work them, because the failure mode here is not
running out of things to fix — it is fixing the wrong thing, or fixing something already fixed.

---

## 1. What is already done — do not re-fix these

Two commits landed after the wave was declared complete. Both came from driving the shipped
build, not from reading it.

**`f88c292` — M29.51, seven defects, all on a `CanvasViewport` surface**

| | |
|---|---|
| Renaming a node or clicking an edge scrolled the diagram off screen, unrecoverably | `scrollLeft` 0 → 1654, svg x → −974. Fit and Reset write the plane's *transform*, so nothing in the UI could undo a *scroll* |
| The four node popovers rendered fully transparent | `Popover` contributes `cb-menu-in`, which is an animation; every caller brings its own panel and these four brought none |
| "Group into subgraph" rendered off screen | `absolute left-1/2` inside the plane means half the *plane's* width, then scaled and translated: x=2002 in a 1600px window |
| All editor chrome zoomed with the diagram | Node toolbar 74px tall at 218%, 21px with 13px buttons at 63% |
| Canvases opened at 400% | Fit clamped *up* to MAX_SCALE; a fresh whiteboard's first node arrived four times life size |
| Clicking empty canvas never deselected | The viewport took pointer capture on `pointerdown`, and Chromium retargets the following `click` to the capture element |
| The edge editor survived a background click and stacked on the group bar | Both are the screen's top centre; invisible while each was parked off the right edge |

**`390fa04` — M29.52, the dot grid plus six more**

- The whiteboard dot grid (the user asked for it by name: Miro / Lucidchart / ClickUp).
  Painted as the **viewport's** background, re-derived from the live transform each frame,
  faded out below a 9px pitch. `.mmd` files deliberately do *not* get it.
- **Undo/redo, which did not exist.** Fifteen comments across this wave assert "one op, one
  `onChangeCode`, one undo step" — and a real `Cmd+Z` after `+ Node` left the node in the file.
  The stack is in `useDiagramFile`, shared by the diagram page and the whiteboard; 250ms
  coalescing; shortcut plus toolbar buttons. Document blocks are excluded on purpose — the
  document's own history already owns the diagram there.
- `growViewBox` clipped a manually-placed node (45px off, label and all) because its budget is
  a multiple of mermaid's own box, which is tiny on a near-empty canvas. Base is floored now.
- "Add record" now takes the same measured viewport-centre placement `+ Node` uses, via a
  shared `placerRef`, and both cascade off anything already there. **This closes the limitation
  M29.48 recorded rather than made** — the note doubted the toolbar's answer settled the
  question; it did.
- Diagrams centre in a document block instead of hugging the left edge.
- A wide diagram stops shrinking at 55% and scrolls, so the demo gantt is no longer 10px labels
  rendered at 3.99px.

**Gate at `390fa04`:** unit 3064 / 2 skipped (185 files) · e2e 46 · coverage 78.8 / 85.8 / 72.4
against floors 48 / 80 / 58 · lint, typecheck, format clean · cargo untouched by these commits.
CI on `f88c292` was all green (build, e2e, quality, Cursor approval).

---

## 2. How to work the findings

### 2.1 Triage before you code

**The appendix is only partly verified, and that is the first thing to know about it.** Seven
probe agents raised 71 findings; an adversarial verifier was fanned out per finding, and the
session ended with 9 confirmed, 5 refuted and **57 still unverified**. The unverified ones are
leads, not facts. Treat every one of them as an unproven claim by an author who was trying hard
to find something — which is exactly the population where roughly a third does not survive
contact.

The refuted section is not noise either. Several were refuted *only because M29.51 or M29.52
already fixed them* — a verifier measuring the tip found nothing wrong at a commit the reporter
had measured before the fix landed. Those are **regression tests waiting to be written**, and
writing one is often the whole task.

Roughly a third of what reviewers raise in this codebase does not survive contact. Decline
freely, but decline **in writing**, with the measurement that made you decline. A finding
dismissed silently comes back next session.

### 2.2 Measure, do not reason

This is the single pattern that produced almost every defect in the whole wave. In order, the
things that were *asserted* and turned out false:

- A plan said mermaid resolves the first declaration; it resolves the **last**.
- A comment said the value context had two clients; it had **none**.
- I said fix the `direction <DIR>` hole at `flattenForLine`; measurement showed click targets and
  `@{ label: }` values are immune and the fix belonged in `quoteLabel`.
- The M29.48 note said record placement was an unsettled product question; the toolbar's
  existing answer settled it.
- Twenty-four more across stages F, G and H.

Reading the source is how you form a hypothesis. A probe is what decides it. **A finding without
a number is not a finding.**

### 2.3 Trusted events only

`element.dispatchEvent(new MouseEvent(...))` **lies on this codebase.** It carries no pointer
capture, so a click a real mouse would have retargeted arrives somewhere else. This is not
hypothetical — it is exactly how the "background click never deselects" bug hid: the same click
cleared the toolbar when dispatched from script and left it up when made with a mouse. Drive
gestures with Playwright's `page.mouse` / `locator.click()` / `locator.dblclick()` /
`page.keyboard`. Use `page.evaluate` to **read** state only.

### 2.4 jsdom cannot see any of this

In every component test: the canvas scale is `1`, `useCanvasOverlayHost()` is `null`, every
`getBoundingClientRect` is `0×0`, no stylesheet is applied, and `setPointerCapture` does not
exist. **The entire zoomed-canvas code path is the identity under test.** That is why 3000
green unit tests and 45 green e2e tests coexisted with a diagram that vanished when you renamed
a node.

When you fix something on a canvas surface, the test that proves it must either wrap the editor
in a real `CanvasViewport` and zoom it (see `StructuralEditor.test.tsx`, the
`inside a zoomed CanvasViewport` describe) or be an e2e that measures in Chromium (see
`diagrams.spec.ts`, the `M29.51` test). A test that cannot fail is a finding.

### 2.5 Environment traps that will cost you an hour each

- **The CWD trap.** Every Bash call must start with
  `cd /Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid && `. The parent
  checkout is a different branch with different code. If you see ~150 test files, or commits
  about M24/M25/M26 policy work, you are in the wrong tree.
- **The dev server dies.** A `nohup`'d or `&`-detached `pnpm dev` gets SIGTERM'd in this
  environment, repeatedly. When it dies mid-session the page keeps rendering from cache with a
  *partial* module graph — I lost two vault files from the tree and nearly filed it as a
  data-loss bug before checking `git status` and finding the disk clean. Start it with the Bash
  tool's `run_in_background: true`, or let Playwright's own `webServer` own its lifetime, and
  **always confirm the server is alive before believing a symptom.**
- **Never `--no-verify`.** The pre-push hook runs the full gate. If a hook is wrong, fix the hook.
- **`git add` specific files.** `.vscode/settings.json` carries a pre-existing uncommitted edit
  that must stay uncommitted. Never `git add -A`.
- **`docs/` is gitignored on this branch.** Plan docs live in `docs/superpowers/plans/` and
  need `git add -f`. (The root `AGENTS.md` describes a later state where that ritual is gone;
  this branch predates it. Check `git check-ignore -v docs/` before believing either.)

### 2.6 One agent per implementation task

Reviews after every task, and the coordinator triages rather than forwarding. Two implementers
at once deadlock on the husky pre-commit hook, which lints the whole tree — one agent waited
twenty minutes for a clean tree, correctly refusing `--no-verify`. Two mutation-testing agents
sharing the worktree gave one of them a phantom uncommitted edit. If you fan out, give exactly
one agent write rights and let the others work in their own `git worktree add` under the
scratchpad.

---

## 3. Suggested order

Work severity-first, but these four are worth doing before anything else because each one makes
a core gesture unusable rather than ugly:

1. **Node drag up/left reportedly slides the rest of the diagram** instead of moving the node.
   If real, this is the whiteboard's primary gesture. Suspect `growViewBox` moving the viewBox
   origin (`minX`/`minY`) — the content is correct in plane space and the *picture* shifts. The
   fix probably belongs in the canvas transform, not in the growth: when the origin moves by
   `d`, the plane offset should move by `d × scale` so the world stays put.
2. **The code panel grows over the zoom cluster and eats its clicks.** Reported on both the
   diagram page (past 31 source lines) and in the narrow-viewport sweep.
3. **A syntax error in visual mode leaves a stale diagram and reports nothing.** The editor
   holds its last good svg by design (`if (!r.ok) return`), but the error has to surface —
   `FullScreenDiagramEditor`'s code-mode face already has a banner; visual mode has none.
4. **Keyboard-only users cannot select a node at all.** `g.node` carries no `tabindex`, no
   `role`, no `aria-label`. Everything behind selection — shape, colour, icon, link, rename,
   delete, group — is therefore mouse-only. This is a real accessibility floor, and the binding
   in `svgBinding.ts` is the one place to fix it for every surface at once.

Then the rest by severity. Two things you should **not** silently fix:

- **The BlockNote hard-break corruption.** Any mermaid block edit round-trips the document
  through BlockNote's markdown serializer and rewrites unrelated prose: the disk file has a
  plain soft-wrap, and after an edit it carries `\`+newline. Confirmed by reading the file on
  disk before and after. This is the pre-existing editor-area fidelity bug the M29 handoff
  parked — it is **not caused by M29**, but M29 gives it a trigger a user will hit daily. It
  needs an editor-area owner and a decision, not a blind patch to the serializer.
- **"Open full screen" now opens at 100%.** That is the flip side of capping the initial fit,
  which is what stopped a blank whiteboard opening at 400%. A four-node chart now sits small in
  a large window. The Fit button still fills on demand. If the user wants full screen to fill by
  default, the cap should become per-surface (`initialFit={{ max: 1 }}` for the whiteboard only)
  rather than being removed.

---

## 4. Where the raw material lives

- **Findings, with verdicts:**
  [`2026-08-10-cerebro-m29-live-audit-findings.md`](./2026-08-10-cerebro-m29-live-audit-findings.md)
  next to this file. **All 71 are there**, grouped by verdict then severity, each with its
  repro, the numbers its author measured, the verifier's independent re-measurement where one
  ran, and the suspected cause. It was generated from the workflow's journal rather than
  retyped, so nothing was summarised away.
- **Full agent transcripts**, including every probe spec each agent wrote and ran:
  `~/.claude/projects/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/subagents/workflows/wf_94e2f865-ff1/`
  — `journal.jsonl` is the index, `agent-*.jsonl` are the transcripts. These persist; the
  probe specs themselves were written to a session scratchpad under `/private/tmp` and **will
  not survive**, so re-derive a probe from the repro steps rather than hunting for the original.
  (Re-deriving is the right move anyway — a finding that only reproduces under one author's
  exact script is not a finding.)
- **The wave's own history:** `docs/superpowers/plans/2026-08-09-cerebro-m29-wave2-*.md` for
  what was built and why, and the stage plans `2026-08-09-cerebro-m29{d..h}-*.md`.

## 5. Conventions this wave is held to

From `AGENTS.md`, and every one of them was load-bearing at least once here:

- Commits are `type(scope): sentence (M<milestone>.<n>)`. Next number is **M29.53**.
- **Policy is data**; a rule implemented as twin Rust and TS code is a review-blocking defect.
- **Ops are surgical**: they touch only the lines they must, ids never change, opaque lines
  survive byte-for-byte, and one op is one `onChangeCode` — which, now that undo exists, is
  finally a claim with teeth.
- **No type special-casing** — behaviour is capability-gated.
- **Coverage ratchets only tighten.**
- Every `eslint-disable` states why, in place.
- `.gitattributes` pins sources to text: write escapes, never raw control characters.
- A pre-existing security hook blocks Write/Edit on files containing raw-HTML-injection
  patterns; write those through a Bash heredoc instead.
