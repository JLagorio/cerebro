# Appendix — the live audit, finding by finding

Generated from the audit workflow's own journal. 71 findings raised across 7 surfaces; 9 survived an independent skeptic, 5 did not, 57 were never verified.

**Read the refuted section too.** Several were refuted only because M29.51/M29.52 already fixed them — a verifier measuring the tip found nothing wrong. Those are regression tests waiting to be written, not noise.


## Confirmed — an independent skeptic reproduced it

### [broken] Escape does not leave the block's visual editor (it does leave code mode) — the Done button is the only exit

- **Surface** — Mermaid blocks inside a document
- **Verifier confidence** — high
- **Repro** — 1. Systems map → first Flowchart block → Edit (opens visual). 2. Press Escape. 3. Click empty canvas inside the editor, press Escape. 4. Click a node, press Escape.
- **Measured** — All three: the block stays in edit mode — header still reads 'Flowchart | Show code | Done' and the toolbar (+ Node, + Shape, TD, LR…) is still mounted. A keydown listener shows the Escape's target is DIV.tiptap (insideBlock = false) and it is already defaultPrevented by the time it reaches document, so MermaidBlockView's `onKeyDown … if (e.key === 'Escape') setEditing(false)` wrapper (MermaidBlockView.tsx line 199) never fires. document.activeElement after pressing Edit is BODY. Contrast: in CODE mode Escape cancels correctly (textarea disappears, block returns to 'Sequence | Open full screen | Save as file… | Edit', disk unchanged). Re-verified after the concurrent edits: still stuck in edit mode.
- **Re-measured by the verifier** — All numbers from my own Chromium run, dev server :5429, worktree HEAD 390fa04 (f88c292 confirmed an ancestor; M29.52 is the only commit on top).

FIXED VIEWPORT 900 (set before boot), visual mode, Outline panel open:
- mermaid-block: x=314 w=236 right=550, clientWidth=234, scrollWidth=382
- structural-toolbar: x=327 w=210 right=537, clientWidth=210, scrollWidth=370 (160px of content with no scroll affordance)
- doc-side-panel left edge: x=628
- controls past the block's right border: "Direction RL" +16px (537->566), "Layout: Dagre" +83px (578->633), "Auto-layout: On" +147px (645->697)
- elementFromPoint(671.2, 491) = doc-side-panel (a DIV whose text is "Systems mapOrder flowRolloutCo..."), NOT the button
- three trusted page.mouse.click(671.2, 491): label before "Auto-layout: On", after "Auto-layout: On", changed=false
- locator.click() on the same control DOES toggle it (On->Off) — Playwright scroll+retry masking the defect

FIXED VIEWPORT 900, code mode (Sequence block):
- block: x=314 w=236 right=550, clientWidth=234, scrollWidth=260
- textarea: x=315 w=260 right=575 -> +25px past the border
- mermaid-live-preview: x=328 w=235 right=563 -> +13px past the border

FIXED VIEWPORT 1000 (set before boot), visual mode:
- block right=650; "Auto-layout: On" x=645.4 right=697.1 -> overhang +47.1px
- toolbar clientWidth=310 scrollWidth=370
- elementFromPoint at the control centre = the BUTTON; trusted page.mouse.click toggled On->Off (reachable, cosmetic only)
- code mode at 1000 fits: taOverhang -1, pvOverhang -13

RESIZE SWEEP (1440 -> 900), visual toolbar overhang vs block border:
1440: -167.3 | 1280: -35.3 | 1200: -13 | 1100: -13 | 1000: +47.1 | 900: +147.1
(matches the reporter's -13 at 1200 and +47.1 at 1000 exactly)

CONTROL 1 — right-hand panel CLOSED: 1000 -> overhang -111.3, 900 -> overhang -13. Fits. Defect requires panel open, which is the default.
CONTROL 2 — ordinary prose at 900: doc-content x=236 w=664 right=900, scrollWidth==clientWidth==664; first six <p> right-edge deltas -78, -319.6, -292.3, -319.4, -317.0, -310.9 (all inside). Not a global narrow-layout failure.
CONTROL 3 — no horizontal page scroll at any width: documentElement.scrollWidth == clientWidth (900/900, 1000/1000, 1200/1200, 1440/1440). The overflow paints into the gutter and under the panel rather than extending the page.
CONTROL 4 — src-tauri/tauri.conf.json: minWidth 900, minHeight 600, resizable true. 900 is a supported width; the reporter's 760px case is not.

Screenshots: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-9/{visual-1000.png, code-900.png, fixed-visual-900.png, fixed-code-900.png, f900-survey.png}
Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-9/probe.spec.ts
- **Suspected cause** — Same focus problem as the Backspace finding: nothing inside the visual pane ever holds focus, so a React onKeyDown handler on a wrapper div is unreachable. The comment at MermaidBlockView.tsx:193-203 assumes the key arrives there.
- **Verifier's reasoning** — I tried to refute this and could not; every refutation I attempted failed, and my own measurement makes it worse than filed.

Reproduces independently. My probe (/private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-9/probe.spec.ts) was written from the repro steps, not from their spec. Repro: Cmd+K "Systems map" -> right-hand panel open (default) on the Outline tab -> first (Flowchart) block -> Edit -> visual mode; then the Sequence block -> Edit for code mode.

Ruled out probe artefact: (a) not resize history — tests E900/E1000 call setViewportSize BEFORE boot, so the window is that size from first paint, and the numbers are identical to the resize path; (b) not a rect-only illusion — visual-1000.png and code-900.png show the "Auto-layout: On" pill sitting in the gutter outside the card's rounded border, and the code pane's grey background and preview svg spilling past it; (c) not mid-transition — two rAFs plus 1.4s settle before every read; (d) not a synthesised gesture — I used page.mouse.click at literal coordinates.

The gesture point cuts the OTHER way here, and is the most important thing I found. My first pass used locator.click() at 900 and the control toggled, which would have said "works fine, cosmetic only". A raw page.mouse.click at the same centre does nothing, three times running. Playwright's actionability machinery (scroll-into-view + retry) was papering over a dead control. The reporter never tested reachability at all.

Ruled out "unusual configuration": with the right-hand panel CLOSED the toolbar fits at 900 (overhang -13). But docPanelOpen defaults to true (src/stores/uiStore.ts:642, loadString(PANEL_OPEN_KEY, 'true') === 'true'), so panel-open is the shipped default, not a corner the user has to seek out.

Ruled out "the whole app is just cramped at that width": at 900 ordinary doc prose stays inside doc-content (six paragraphs, overflow -78 to -320px). Only this block's chrome escapes its own border.

Ruled out "documented on purpose": nothing in src/mermaid/ comments on narrow widths or minimum widths. The one comment adjacent to the button (StructuralEditor.tsx:1035-1043) explains the label wording ("Shows the CURRENT state and flips it on click"), not its layout. structural-toolbar is a bare `flex items-center gap-1` (line 959) with no wrap and no overflow handling, and the code pane pairs two `min-w-[260px] ... basis-[280px]` children (HighlightedTextarea.tsx:62, MermaidBlockView.tsx:387) in a `flex flex-wrap` that wraps but cannot shrink below 260px — the reporter's diagnosis of the mechanism is correct.

Ruled out "unreachable window size": src-tauri/tauri.conf.json sets minWidth 900, so 900 is exactly the narrowest window a user can make — the worst case is a supported case. Their 760px datapoint IS out of bounds and should be dropped, but it is not load-bearing.

Severity correction to "broken": they filed "wrong" (works but visibly incorrect). At 900 the Auto-layout control is not merely ugly, it is inoperable — it renders 147px past the card border, entirely beyond the Outline panel's left edge at x=628, and the panel eats the click. A user at the app's own minimum window size cannot toggle manual layout at all. At 1000 it is genuinely only cosmetic (still clickable), so the severity depends on width; the worst supported width is broken.

### [broken] The floating code panel swallows Escape and offers none of its own — the same key one pixel away destroys the dialog

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open a block full screen, click "Show code".
2. Click into the source textarea and press Escape — nothing happens at all.
3. Click the canvas and press Escape — the entire dialog closes (the code panel was the thing you meant to dismiss).
- **Measured** — Escape with focus in the code textarea: code-overlay count stays 1, fullscreen-diagram-editor stays 1 (no dismissal of either). Escape with focus on the canvas: editor 1 -> 0. Expected: Escape in the panel closes the panel (as it does for all four node popovers), and Escape elsewhere with the panel open closes the panel before the dialog.
- **Re-measured by the verifier** — All numbers from my run, probe at /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-8/probe.spec.ts (6 legs, all passed, 4 screenshots).

LEG 1 (the claim). demo-vault/strategy/systems-map.md in __cerebroMockFs = 842 bytes before. Block count 4; block[1] header "SEQUENCE". Textarea original = "sequenceDiagram\n  participant U as User\n  participant A as App\n  participant S as Store\n  U->>A: place order\n  A->>S: reserve stock\n  S-->>A: confirmed\n  A-->>U: receipt" (169 chars). Select-all + type → textarea value "sequenceDiagram\n  Z->>W: unsaved work"; mermaid-live-preview renders it (screenshot leg1-a-typed.png shows Z/W lifelines and the "unsaved work" arrow label). After 2500ms still on page: disk has-unsaved-work FALSE. Click rail → Home: dialogs fired = [] (page.on('dialog') array empty). Disk after leaving = 842 bytes, unchanged, has-unsaved-work FALSE, still contains the original "sequenceDiagram". Reopen doc: textarea count 0, block text contains "unsaved work" FALSE — screenshot leg1-c-on-return.png shows the original 3-participant sequence back in view mode with an "Edit" button. Expected for a surface with an unmount flush: disk contains "unsaved work", or at minimum a prompt.

LEG 2 (control, same typing + Done). doc-save-state 300ms after Done = "Unsaved", after 2500ms = "Saved"; disk has-committed-work TRUE; after navigating to Home and back, disk TRUE and block shows it. So the write path works and the block CAN persist — it just needs the button.

LEG 3 (status-chip semantics). Typed "PROSE MARKER ALPHA" into ordinary doc prose: status-changes = "No changes" before, during and after; doc-save-state = absent → "Unsaved" → "Saved"; disk has-marker TRUE. Conclusion: "No changes" is worth zero as evidence — it says that for saved edits too.

LEG 4 (other exits). After typing "clickaway work" and clicking a paragraph elsewhere in the doc: textarea count still 1, disk has-clickaway FALSE (draft alive, uncommitted). Opening block[2]'s editor: block[1]'s textarea count still 1, value still "sequenceDiagram\n  Z->>W: clickaway work".

LEG 5 (peer surface, the rebuttal I expected to win with and didn't). diagrams/pipeline.mmd → diagram-toolbar "Show code" → code-overlay count 1, Auto-update on by default. Typed "graph TD\n  P[mmd page marker] --> Q[end]", clicked rail → Home, waited 2500ms: pipeline.mmd on disk = 40 bytes, has-marker TRUE. Identical gesture, identical navigation, opposite outcome from the in-doc block.

LEG 6 (ordinary exit). Same draft, left the doc via the rail after the sidebar file rows didn't match my locator: disk 842 bytes, has-marker FALSE. Loss is route-change-general, not one button.
- **Suspected cause** — CodeOverlay.tsx:116 does a blanket `onKeyDown={(e) => e.stopPropagation()}` (needed to keep BlockNote/canvas hotkeys out) which also kills the native keydown before Dialog's document listener sees it, and CodeOverlay registers no layer and has no Escape of its own.
- **Verifier's reasoning** — Reproduced independently with my own spec, real keyboard/mouse only (locator.click + page.keyboard.type; no dispatchEvent anywhere), on my own server at :5428, worktree 390fa04 (one commit past the reporter's f88c292, same branch — the M29.52 legible-width commit, which does not touch the draft lifecycle).

Not a probe artefact: I waited for the DEBOUNCED live preview to actually render the typed source before asserting (so the app demonstrably had the draft, not just the DOM), then gave the editor's 500ms autosave debounce a 2500ms window before reading the mock disk, and read the disk again after navigation. A control leg on the identical typing committed with Done writes to disk in the same window, so the save path itself is healthy and the loss is specific to the uncommitted draft.

Not documented behaviour. The source has no comment defending it, and git shows the guard was DELETED: `onBlur={commit}` was on this textarea until 998890c "feat(mermaid): editing is side-by-side with a live preview that never blanks (M29.9)", whose message says nothing about dropping it. The codebase is elsewhere acutely aware of exactly this hazard — CodeOverlay.tsx:88-108 carries an unmount flush with the comment "A pending debounce must not die with the panel… useLayoutEffect, NOT useEffect, and the distinction is data loss", and useDiagramFile.ts:235 does the same for the .mmd page. Measured: the .mmd page's code overlay DOES survive the identical navigation. MermaidBlockView is the one code surface with no flush.

Two corrections to the reporter's account, neither of which rescues the app:
(1) Their status-bar evidence is misattributed. `status-changes` is the GIT working-tree counter (StatusBar.tsx:182), not a save indicator — I measured it reading "No changes" after a prose edit that genuinely reached disk. The real indicator is `doc-save-state` (DocPage.tsx:152-159, Unsaved/Saving…/Saved), and it behaves correctly for prose and for a committed mermaid edit; it is simply ABSENT (idle) during the draft. So "nothing tells the user" is true, but their proof of it is the wrong chip.
(2) The exposure is narrower than implied: clicking away inside the doc does NOT kill the draft (box stays open, text intact), and a second block's editor can be opened without disturbing it. Only a route change unmounts it.

Severity is understated at "wrong". Typed user content disappears with no dialog, no chip, and no undo entry (it never enters BlockNote history) — that is "something disappears", i.e. broken.

### [wrong] A popover opened inside the dialog stays put when the canvas is wheel-zoomed, detaching from the node it belongs to

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, "Open full screen" on the first block.
2. Click the "Idea" node, then "Change shape" — the shape palette opens under the mini toolbar.
3. Without clicking anything (a click would dismiss it), scroll/pinch-zoom the canvas somewhere clear of the palette.
4. The node and its mini toolbar move; the palette does not. It now floats over an unrelated part of the diagram, still open.
- **Measured** — Zoom 100% -> 110%. Node toolbar moved by (+42.7, -26.6)px (x 677.2 -> 719.9, y 333.8 -> 307.2). Shape palette moved by (+0.0, +1.3)px (x 677.2 -> 677.2). Gap between the anchor's bottom (340.7) and the palette's top (371.3) opened to 30.6px of bare canvas, and the palette now covers the "Build" node. Expected: the popover tracks its anchor or dismisses.
- **Re-measured by the verifier** — All from my own run, dev server :5420, Chromium 1440x900, worktree HEAD 390fa04.

BASELINE (strategy/systems-map.md via window.__cerebroMockFs): 4 [data-testid=mermaid-block] in the DOM, 842 bytes, 4 "```mermaid" fences, contains "flowchart TD" and "Idea[Idea]".

BACKSPACE (Edit on block 1 → real mouse click on the Idea g.node → mermaid-node-toolbar visible → page.keyboard.press('Backspace')):
  blocks 4 → 3, bytes 842 → 700, fences 4 → 3, hasFlowchartTD true → FALSE, hasIdea true → false.
  Expected: blocks 4, fences 4, flowchart present minus the Idea node.
  Focus at the moment of the keypress: activeElement = "DIV.tiptap.placeholder-selector-e1645e19-….ProseMirror", aeInStructural = false, .ProseMirror-selectednode count = 1 and it wraps the mermaid-block.
  Screenshot 02-after-backspace.png: the doc goes straight from the intro paragraph to the "Order flow" heading; status bar reads "Saved".

DELETE key: identical — blocks 4 → 3, fences 4 → 3, hasIdea false, same 700-byte body.

CONTRAST (focus forced into the structural root as SETUP, then Backspace): activeElement = "DIV.relative.px-3.py-2", aeInStructural = TRUE, and still blocks 4 → 3, fences 4 → 3. Focusing the pane does not save the block.

CONTROL (same selection, node-toolbar trash button, real click): blocks 4 → 4, fences 4 → 4, bytes 842 → 828, hasIdea true → false, fence body now "flowchart TD\n  Build[Build]\n  Build --> Review{Review}\n  Review -->|ship| Done[Done]\n  Review -->|rework| Build". Correct behaviour.

RECOVERY (one Cmd+Z after the Backspace): blocks 3 → 4, bytes 700 → 843, fences 3 → 4, hasIdea false → true. Recoverable. (843 vs the original 842 is the "\" hard-break round-trip artefact, which also occurs on the trash-button path.)

SCOPE (visual editor CLOSED, click the rendered diagram then Backspace): blocks 4 → 3, fences 4 → 3 — plain ProseMirror node-selection delete, which I consider defensible and did not file.
- **Suspected cause** — Popover re-measures on window `resize` and on its own ResizeObserver only (src/components/ui/Popover.tsx). A canvas zoom/pan moves the anchor via a CSS transform on canvas-plane, which fires neither — and CanvasViewport's wheel handler preventDefaults the native wheel, so `closeOnScroll` never sees a scroll event either.
- **Verifier's reasoning** — I tried to refute it and could not. My own probe (written from the repro steps, not theirs, port 5420, worktree HEAD 390fa04 — M29.52 landed on top of f88c292) reproduces it exactly, with trusted input only: page.mouse.move/down/up on the 'Idea' g.node, then page.keyboard.press.

Not a probe artefact. (a) Gestures were real Playwright mouse/keyboard, never dispatchEvent. (b) I waited for the async mermaid render (svg[id^="cerebro-mermaid-"] visible AND g.node count == 4) before clicking, and waited 1500ms after the key before reading disk; the status bar reads "Saved" in the post-Backspace screenshot, so the debounced write landed. (c) The evidence is DOM element counts and mock-disk bytes, not geometry, so no rect/transition timing is involved. (d) The app itself confirms the node was selected: mermaid-node-toolbar was visible and the screenshot shows it anchored under Idea.

Not documented behaviour. The opposite is documented: StructuralEditor.tsx:943 has an explicit onKeyDown that does `apply(deleteNode(model, validSelected))` for Delete/Backspace, and StructuralEditor.test.tsx:347 states the intent in prose — "a keystroke inside either popover reaches the editor's own onKeyDown — where Backspace deletes the selected node" — with three unit tests guarding against that firing in the WRONG place. So "Backspace = delete this node" is the designed contract; the document-level block delete is not written down anywhere I could find.

Control proves the two paths disagree: the node toolbar's trash button, same selection, same block, leaves the block alone and removes only the node.

Where I DISAGREE with the reporter: their suspected fix ("the visual pane needs to take focus") would not work, and I measured that. In my CONTRAST run I forced document.activeElement into the structural root before the keypress (aeInStructural: true, activeElement "DIV.relative.px-3.py-2") and Backspace STILL took the whole block: 4→3 blocks, 4→3 fences. Reason: the handler at :943 calls neither e.preventDefault() nor e.stopPropagation(), so ProseMirror's NodeSelection delete runs regardless of who saw the event first. The real fix is to stop the key at the block boundary (and/or clear the PM NodeSelection), not merely to move focus.

Scope note (arguably fair, not filed): with the visual editor CLOSED, clicking the rendered diagram and pressing Backspace also removes the block (4→3). That is ordinary ProseMirror node-selection behaviour, like deleting a selected image, and I would not call it a bug. The defect is that entering the visual editor does not change it, even though the app shows a node toolbar and defines its own meaning for the key. The 01-selected.png screenshot shows both states at once: the node toolbar under Idea AND the thick .ProseMirror-selectednode ring around the whole block.

One thing I checked and am NOT counting against the app: the stray "\" hard-break that appears in the paragraph above ("uses the\" + newline). It appears identically on the trash-button path, so it is a generic BlockNote markdown round-trip artefact of any first edit, not caused by this defect.

Severity "broken" is honest: a whole diagram disappears from the document and 142 bytes vanish from the file on disk. One Cmd+Z does restore it (I measured 4 blocks / 4 fences / Idea present again), so it is recoverable — but recoverable-if-noticed does not downgrade "the user's gesture meant delete-this-node and the result was delete-the-diagram".

Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-0/probe.spec.ts (6 tests: Backspace, Delete, RECOVERY, CONTRAST, SCOPE, CONTROL). Screenshots 01-selected.png, 02-after-backspace.png in the same directory.

### [wrong] With Auto-update off, closing the dialog silently throws away the buffered source — dirty dot and all

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, "Open full screen" on the first block, click "Show code".
2. Turn the panel's Auto-update switch OFF (an Apply button and a dirty dot appear).
3. Type a new line of mermaid, e.g. `  Idea --> Done`. The dirty dot is showing.
4. Click the canvas, press Escape. The dialog closes with no prompt and the typed line is gone.
- **Measured** — code-overlay-dirty count = 1 and Apply button count = 1 at the moment of closing. After close the block's own source box reads the original 5 lines — `Idea --> Done` absent (assertion `src.includes(...) === false` passes). Bytes typed and lost: 16. Expected: either flush on close like the Auto-update-on path does (that one is correct — a keystroke closed inside the 250ms debounce still reaches disk), or refuse/warn.
- **Re-measured by the verifier** — Chromium 1440x900, my own dev server :5423, worktree HEAD 390fa04. Metric = occurrences of 'New step' in window.__cerebroMockFs.get('strategy/systems-map.md'). Baseline before any edit: 0.

A (natural sequence): Edit on the first flowchart block -> '+ Node' -> file polls to 1; document.activeElement = BUTTON.rounded-md border border-n-200... | text='+ Node'. Cmd+Z, wait 2500ms -> STILL 1. Cmd+Z a second time, wait 2000ms -> STILL 1 (not 'one step behind' — a total no-op). structural-host innerText after undo: 'ship rework Idea Build Review Done New step'. Screenshots a1-after-addnode.png and a2-after-undo.png are visually identical, the New step node still drawn at roughly x756-870, y335-382. Capture-phase keydown log: ["Meta|meta=true|target=BUTTON...", "z|meta=true|target=BUTTON..."] — the keystroke goes to the button and never to the editor.

B (control): same up to '+ Node' (file=1), then page.mouse.click on empty canvas inside structural-host -> activeElement becomes DIV.tiptap -> Cmd+Z -> file=0. Undo works.

D (control 2): same up to '+ Node' (file=1), then locator.click on a real diagram node [id*="flowchart-Build-"] -> activeElement DIV (tiptap) -> Cmd+Z -> file=0. Works.

E (NEW, beyond the report): '+ Node' -> 1; Cmd+Z -> 1; Cmd+Z -> 1; then click the block's own 'Done' button -> activeElement = BODY -> Cmd+Z, wait 2000ms -> STILL 1. Pressing Done does not restore undo; only clicking into the prose or the diagram does.

C (NEW, beyond the report): dblclick node 'Idea' -> rename to 'Spark' -> Enter -> file polls to contain 'Idea[Spark]'; activeElement = BODY. Cmd+Z, wait 2500ms -> file still contains 'Idea[Spark]' (true). The rename path has the identical hole.

Expected in every row: one Cmd+Z after one visual op returns the file to 0 occurrences of 'New step' / drops 'Idea[Spark]'.

Probe files: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-3/probe.spec.ts and /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-3/probe2.spec.ts (configs pw.config.ts and pw2.config.ts in the same directory; screenshots a1-after-addnode.png, a2-after-undo.png, b-after-undo.png, e-after-done-undo.png). Worktree left unmodified — git status shows only the pre-existing .vscode/settings.json change that was there before I started.
- **Suspected cause** — CodeOverlay's unmount flush (CodeOverlay.tsx:103) is gated on `autoRef.current`, which is the panel's own "only Apply commits" contract. That contract is about the panel's X button; here the whole editor is being dismissed by a dialog-level Escape and the user gets no signal that the visible dirty dot is about to be discarded.
- **Verifier's reasoning** — I set out to refute it and could not. My own probe (trusted locator.click / page.mouse.click / keyboard.press only, no synthesised events) reproduces it deterministically at current HEAD 390fa04 — note the tree has moved one commit past the f88c292 the reporter used, and 390fa04 IS the undo commit (M29.52), which added an undo stack to the diagram page and whiteboard but explicitly not to document blocks. Artefact checks all come back clean: the 500ms doc autosave was polled to completion before each assertion and given 2500ms after each Cmd+Z, so it is not a timing race; scenarios B and D prove the op DID enter BlockNote history (the identical keystroke undoes it the moment focus is anywhere in the editor), so this is purely focus routing, not a missing history entry; before/after screenshots are pixel-identical with the 'New step' node still drawn, so it is not a save-path-only illusion; a second Cmd+Z is also a no-op, ruling out step coalescing. Not documented-as-intended either: src/mermaid/DiagramToolbar.tsx:78-82 and the M29.52 commit justify omitting block-level undo with 'the DOCUMENT's own history already covers the diagram', which my measurement shows is false whenever focus sits on the block chrome — and src/mermaid/useDiagramFile.ts:182-205 fixes this exact bug on the other surface with a window keydown listener, recording the same measurement ('measured: a real Cmd+Z after + Node left the node in the file'). e2e/diagrams.spec.ts:219-230 silently works around it by clicking a paragraph before Cmd+Z. I found the hole is WIDER than reported on two counts: (1) pressing the block's own Done button does NOT restore undo — focus goes to BODY and Cmd+Z is still a no-op, so the natural recovery gesture fails too; (2) the same hole swallows undo after a node RENAME committed with Enter (focus also lands on BODY), which is the most common visual op, not just '+ Node'. On severity: the reporter's 'wrong' is if anything conservative — this is functional, not visual, and by the letter of the rubric ('broken' = a user cannot do the thing) it leans broken. I am deliberately NOT inflating it, because undo is reachable with one extra click on the prose or on any node; the defect is that the click is undiscoverable. Hence severityCorrection 'none'.

### [wrong] Any block edit rewrites an unrelated prose line in the doc, adding a hard-break backslash (NOT caused by the dialog)

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map. Note line 3: `...The flowchart below uses the` (soft wrap).
2. Change anything in the first mermaid block — rename a node full screen, or just edit the source inline and press Done.
3. Wait for autosave and read the file: line 3 now ends with a literal `\`.
- **Measured** — strategy/systems-map.md 842 bytes at rest; open+close the full-screen dialog with NO edit -> 842 bytes, byte-identical. A full-screen node rename (Idea -> Spark, +1 char) -> 844 bytes. The extra byte is line 2 changing from "How the demo product's pieces talk to each other. The flowchart below uses the" to the same string with a trailing backslash. CONTROL, same probe: an inline (non-dialog) source edit produces the identical rewrite (842 -> 845 with a +2-char label change), so the dialog is not the cause — the doc's markdown round-trip is. Reported here only because it is the file-level consequence of using this surface.
- **Re-measured by the verifier** — My run, Chromium 1440x900, dev server :5426, HEAD 390fa04. Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-6/probe.spec.ts

EDIT-MODE BANNER (mermaid-edit-error) — the surviving defect, identical for 3 diagram types:
- sequence, typed 'sequenceDiagram\n  totally not valid @@@': innerText "Line 2: Parse error on line 2:", 30 chars, rect 306 x 26 at (757, 508.3)
- gantt, typed 'gantt\n  @@@ not a gantt': innerText "Line 2: Parse error on line 2:", 30 chars, rect 306 x 26 at (757, 468.5)
- flowchart, typed 'flowchart TD\n  A --> (((': innerText "Line 2: Parse error on line 2:", 30 chars, rect 306 x 26 at (757, 296)
- computed style: scrollW 306 = clientW 306, scrollH 26 = clientH 26, overflowX visible, whiteSpace normal, textOverflow clip → truncation is in code, not CSS.

WHAT THE BANNER THREW AWAY (renderMermaid called directly in-page):
- sequence: message 742 chars / 4 lines. Kept line 0 (22 chars). Dropped 720 chars: "...otally not valid @@@" | "-----------------------^" | "Expecting '()', 'SOLID_OPEN_ARROW', … 'DOTTED_POINT', got 'NEWLINE'" (670 chars).
- gantt: message 100 chars / 4 lines. Dropped "Expecting 'taskData', got 'NL'" — 30 chars, which fits the banner's own width.
- flowchart: message 232 chars / 4 lines. Dropped "Expecting 'AMP', 'COLON', … 'UNICODE_TEXT', got 'DOUBLECIRCLESTART'".

VIEW-MODE CARD (mermaid-error) after Done — reproduces numerically, but is intended:
- innerText 815 chars (reporter said 816), rect 638 x 258.5 at (425, 508.3) — rect matches the reporter exactly.
- message div alone: 742 chars, 612 x 180, 10 wrapped line boxes at line-height 18px / font-size 12px (reporter's "ten wrapped lines" confirmed).
- <pre> code echo: 39 chars, 612 x 36. Plus "Click to fix the diagram source…" — those two are the 73-char gap between 742 and 815.
- containing block 664 x 321.5 vs healthy diagram 0 at 638 x 445.3 → broken block is 123.8px SHORTER. Page scrollHeight 1009.
- __cerebroMockFs['strategy/systems-map.md'] contains the typed source only; the 742-char message is never persisted.
- mermaid-live-preview count = 1 while the banner is up → last-good svg is held as documented at MermaidBlockView.tsx:378.

Screenshots: verify-6/01-banner.png, 03-card-scrolled.png, banner-gantt.png, banner-flowchart.png
- **Suspected cause** — BlockNote -> markdown serialization turning the paragraph's soft line break into an escaped hard break on the first re-serialization of the doc. Belongs to the doc/editor surface, not to M29.
- **Verifier's reasoning** — I set out to refute this and could only refute HALF of it. Note first: the worktree has moved past the stated HEAD — it is now 390fa04 (M29.52), not f88c292. MermaidDiagram.tsx and MermaidBlockView.tsx each changed 5 lines in that commit, but only to add useLegibleWidth; the error-rendering code is untouched, so the claim is still testable at current HEAD.

REFUTED — the "816 characters dumped into the document" half. Three independent problems with it.
(1) It is deliberate and named as such. src/mermaid/MermaidBlockView.test.tsx:63 is titled `it('surfaces the full render error, not just its first line', ...)`. Printing `{result.message}` whole at MermaidDiagram.tsx:118 is that test's stated intent, not an oversight.
(2) "dumps into the document" is false. The 742-char message never reaches disk. I read window.__cerebroMockFs after Done: strategy/systems-map.md contains only the broken fence source the user typed. The card is a render-time affordance.
(3) "sitting in the middle of the prose" implies displacement, and there is none — I measured the broken block at 664 x 321.5 against the healthy first diagram at 638 x 445.3. The error card is 124px SHORTER than the diagram it replaced. It displaces nothing; it under-fills.

SURVIVES — the banner half, and it is worse than the reporter argued. I reproduced "Line 2: Parse error on line 2:" exactly (30 chars, 306 x 26). Then I checked the thing the reporter did not: is it a sequence-diagram quirk? It is not. I broke the gantt fence and the flowchart fence with different sources producing different underlying errors, and the banner printed the byte-identical string all three times. extractErrorLine() (render.ts:15) matches /error on line (\d+)/i, which only ever matches the first line the banner then prints, so for every mermaid parse error in every diagram type the banner is constant output: the line number twice, a dangling colon, zero diagnostic bytes.

Not a probe artefact. I drove real keyboard input (locator.click + keyboard.press + keyboard.type — no dispatchEvent), waited 1500ms past the 250ms debounce, and confirmed it is a code truncation rather than a layout one: scrollWidth 306 == clientWidth 306, scrollHeight 26 == clientHeight 26, whiteSpace normal, textOverflow clip. Nothing is being clipped by CSS — the 30-char string is what MermaidBlockView.tsx:394 built. Nor is it a space constraint: the gantt case's dropped payload is "Expecting 'taskData', got 'NL'" (30 chars) and the banner has visible empty room on that same line.

Not documented. I grepped src/mermaid/ and docs/superpowers/ — every other non-obvious choice in this file carries a comment (the last-good-svg hold at line 378, the debounce ownership, the forced code-mode demotion), but nothing explains `.split('\n')[0]`. The unit test at line 192 that guards this banner uses the fixture 'Parse error on line 2: bad', a single line with the useful part inline, so it never sees mermaid's real 4-line message and cannot notice the drop. Same one-line truncation exists at FullScreenDiagramEditor.tsx:193 (read, not measured).

Severity: the reporter filed "wrong" and "wrong" is right for the surviving half — the block still edits, the live preview still holds the last good svg, and Done reveals the full message, so nothing is broken; but a line number printed twice followed by a sentence that terminates in a colon is visibly incorrect text, not merely rougher than a better tool. I am passing "wrong" to be explicit rather than "none", since the headline half of the claim is refuted and I do not want that read as endorsing it.

### [rough] A link badge clicked inside the full-screen dialog destroys the dialog and navigates the whole app to another document

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, "Open full screen" on the first block.
2. Click a node, click "Node link" in the mini toolbar, search "Phoenix cutover standup", pick it.
3. A link badge appears on the node. Click the badge (16x16, at the node's top-right).
4. The full-screen editor vanishes and the app is now showing the linked note.
- **Measured** — Before the badge click: scrims=1, fullscreen-diagram-editor=1, doc-title="Systems map", mermaid-block count=4. After: scrims=0, fullscreen-diagram-editor=0, doc-title="Phoenix cutover standup", blocks=0. The user never asked to close anything. The edit itself is not lost (systems-map.md 842 -> 891 bytes, `click Idea "inbox/phoenix-cutover-standup.md"` present), so this is surface loss, not data loss. Same class via the other route: with the dialog open, Cmd+K -> "Pipeline" -> Enter navigates behind the modal and scrims goes 1 -> 0 while the editor is torn down mid-session.
- **Re-measured by the verifier** — Own run, :5422, HEAD 390fa04, Chromium 1440x900. Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-2/probe.spec.ts (+ probe2.spec.ts for the focus isolation).

State of block 0 (header text | Done btn count | structural-host count | Mermaid-source count | activeElement):
A after clicking Edit:            "FLOWCHART | Show code | Done" | 1 | 1 | 0 | BODY insideBlock=false
B after bare Escape:              "FLOWCHART | Show code | Done" | 1 | 1 | 0 | BODY insideBlock=false      <- UNCHANGED
C after click on empty canvas:    "FLOWCHART | Show code | Done" | 1 | 1 | 0 | DIV.tiptap insideBlock=false
D after Escape (canvas focus):    "FLOWCHART | Show code | Done" | 1 | 1 | 0 | DIV.tiptap insideBlock=false <- UNCHANGED
E after clicking a g.node:        "FLOWCHART | Show code | Done" | 1 | 1 | 0 | DIV.tiptap; mermaid-node-toolbar count 1
F after Escape (node selected):   "FLOWCHART | Show code | Done" | 1 | 1 | 0 | BODY; mermaid-node-toolbar STILL 1 (Escape does not even clear the node selection)
G after clicking a paragraph outside the block: still "…| Done" | 1 | 1 — a click-away does not close it either
H Escape from that paragraph:     "FLOWCHART | Show code | Done" | 1 | 1 | 0 <- UNCHANGED

CONTRAST, code mode, same block, same keypress:
I after "Show code":              "FLOWCHART | Show diagram | Done" | 1 | 0 | 1 | TEXTAREA.relative insideBlock=TRUE
J after Escape:                   "FLOWCHART | Open full screen | Save as file… | Edit" | 0 | 0 | 0, mermaid-diagram back to 1 <- EXITS CORRECTLY

Document-level keydown log (passive read listener, bubble phase), 4 Escapes: [{target:"BODY", insideBlock:false, defaultPrevented:false}, {target:"DIV.tiptap", insideBlock:false, defaultPrevented:true} x3]. Every Escape's target is OUTSIDE [data-testid="mermaid-block"], so the wrapper's React onKeyDown (MermaidBlockView.tsx:193-205, the Escape branch at line 200) is never on the dispatch path.

MECHANISM ISOLATION (probe2): from the freshly opened visual editor, 1 Tab press -> activeElement BUTTON[+ Node] insideBlock=TRUE. Escape then -> header "FLOWCHART | Open full screen | Save as file… | Edit", structural-host 1 -> 0. Handler works; focus is the only thing missing.

EXPECTED per the source comment and e2e/diagrams.spec.ts:223: B, D and F should all read "FLOWCHART | Open full screen | Save as file… | Edit" with Done=0, host=0, diagram=1 — i.e. what J actually produced.

Screenshot /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-2/b-after-bare-escape.png visually confirms it: after Escape, block 1 still shows the "Done" header plus the full editing toolbar (+ Node, + Shape, TD, LR, BT, RL, Layout: Dagre, Auto-layout: On), while block 2 (SEQUENCE) below it shows the normal "Open full screen | Save as file… | Edit" header.

Not measured / not claimed: whether the same gap exists on the .mmd full-page canvas or the fullscreen editor — I only drove the in-document block.
- **Suspected cause** — MermaidBlockView.tsx:69 passes `useOpenPath('in-place')` straight through to the full-screen editor. 'in-place' was chosen for the INLINE block ("this surface IS the backdrop"), but in the dialog the backdrop is what is being replaced, and the Dialog is rendered inside the block's own React subtree — so unmounting the doc unmounts the modal with no onClose, no focus restore, and no chance to say no. Either the badge should open a peek/detail panel from this host, or the dialog should close itself first.
- **Verifier's reasoning** — I tried to break the claim four ways and it survived all of them. (1) It reproduces under my own script, written from the repro steps, never running theirs. (2) It is not a probe artefact: every gesture is a trusted event (locator.click / page.mouse.click / page.keyboard.press); page.evaluate is used only to READ activeElement and to attach a passive read-only keydown logger; I waited 600ms after each Escape and after the async mermaid render (waited on the host svg) before asserting; the assertions are DOM counts and header innerText, not geometry, so no transition/rect race. (3) It is not documented behaviour — the opposite. The comment at MermaidBlockView.tsx:193-203 states the intent plainly: "Escape just exits — every visual op already committed through onChangeCode as it happened, so there is nothing left to revert", and e2e/diagrams.spec.ts:223 leans on it in prose ("the block's editing state survives the click (only Escape/Done close it)"). The intent is real and undelivered. No test covers it: the only Escape assertions in MermaidBlockView.test.tsx (lines 208, 224) type into the 'Mermaid source' textarea first, i.e. CODE mode, where focus is inside the block — which is exactly why the gap shipped. (4) The mechanism is confirmed, not inferred: the handler is not dead, only unreachable. In probe2 I pressed Tab ONCE from the freshly-opened editor; focus landed on BUTTON[+ Node] insideBlock=true, and the very next Escape exited correctly (header flipped to "FLOWCHART | Open full screen | Save as file… | Edit", structural-host count 1 -> 0). So the React onKeyDown on the wrapper div fires perfectly when focus is inside it; the mouse path never puts focus there (activeElement is BODY right after Edit, DIV.tiptap after any click in the pane), and neither is a descendant of the wrapper, so React's synthetic path from target to root skips it entirely. Where I do push back is severity. "wrong" in this rubric is the visual bucket (overlap, clipping, mis-size, mis-colour) and this is not a visual defect; "broken" needs the user to be unable to do the thing, and they can — Done exits, and even Tab-then-Escape exits. Nothing is destroyed: the block is not a trap and disk is untouched (visual ops commit through onChangeCode as they happen). A universal exit affordance that the source claims works and silently does nothing on the only path a mouse user takes is a genuine polish gap against a Lucidchart-grade tool, which is "rough".

### [rough] Escape with a node selected closes the entire full-screen editor instead of clearing the selection

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, "Open full screen" on the first block.
2. Click a node — the mini toolbar appears.
3. Press Escape expecting to deselect.
4. The whole full-screen editor closes.
- **Measured** — Before: mermaid-node-toolbar = 1, fullscreen-diagram-editor = 1. After one Escape: node toolbar = 0, editor = 0, scrims = 0, back on the doc. Expected in a diagram tool: first Escape clears the selection (toolbar 1 -> 0, editor still 1), second closes. Nothing is lost (visual ops commit as they happen) but the surface is.
- **Re-measured by the verifier** — MY RUN — worktree m29-mermaid @ 390fa04, dev server :5427, Chromium 1440x900, headless.
Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-7/probe.spec.ts

GEOMETRY (real boundingBox): intro paragraph {x:412,y:204,w:664,h:42}; first mermaid-block {x:412,y:256,w:664,h:494.3125}; "Order flow" h2 {x:412,y:760.3125,w:664,h:42}. Drag was (442,240) -> (472,781.3), 24 steps.

1) DOM SELECTION after the trusted drag — collapsed=false, anchor P.bn-inline-content, focus H2.bn-inline-content:
"ult layout; the last one uses ELK, which proves the optional engine loads.\n\nFLOWCHART\nOpen full screen\nSave as file…\nEdit\nship\n\nrework\n\nIdea\n\nBuild\n\nReview\n\nDone\n\nOrde"

2) THE COPY EVENT — defaultPrevented=true, types="blocknote/html,text/html,text/plain" (so the app's own handler wrote these). text/plain:
"ult layout; the last one uses ELK, which proves the optional engine loads.\n\nFlowchartOpen full screenSave as file…Edit\n\n## Orde\n"

3) OS CLIPBOARD via navigator.clipboard.readText() — byte-identical to (2):
"ult layout; the last one uses ELK, which proves the optional engine loads.\n\nFlowchartOpen full screenSave as file…Edit\n\n## Orde\n"
  contains "flowchart TD"      -> false   (expected true)
  contains "```mermaid"        -> false   (expected true)
  contains "Open full screen"  -> true    (expected false)
  contains "Save as file"      -> true    (expected false)

EXPECTED text/plain for that same span (this is what markdown.ts:215 already produces for the disk path):
"...engine loads.\n\n```mermaid\nflowchart TD\n  Idea[Idea] --> Build[Build]\n  Build --> Review{Review}\n  Review -->|ship| Done[Done]\n  Review -->|rework| Build\n```\n\n## Orde\n"

4) text/html DOES carry the source, but only as an attribute, never as text:
<div data-testid="mermaid-block" contenteditable="false" ... data-code="flowchart TD&#10;  Idea[Idea] --&gt; Build[Build]&#10;  Build --&gt; Review{Review}&#10;  Review --&gt;|ship| Done[Done]&#10;  Review --&gt;|rework| Build">
...followed by the header chrome: the waypoints <svg>, <span>Flowchart</span>, and the Open full screen / Save as file… / Edit <button>s. That chrome is what the text/plain conversion flattens.

5) BOUND ON SEVERITY — in-app paste is LOSSLESS. Same span copied, caret at end of the "Rollout" h2, Cmd+V: mermaid-block count 4 -> 5 (expected 5); __cerebroMockFs systems-map ```mermaid fence count 4 -> 5; disk contains "Open full screen" -> false; the pasted fence is byte-correct ("flowchart TD / Idea[Idea] --> Build[Build] / ..."). Vault bytes before any interaction: 842, with 4 fences containing flowchart TD, sequenceDiagram, gantt and layout: elk — all four present on disk, none of the four ever present in the clipboard.

6) CONTROL, mermaid-free doc inbox/welcome.md, same gestures: select-all DOM selection len=144 collapsed=false; clipboard 148 bytes = "# Welcome to Cerebro\n\nThis vault is plain markdown: projects are folders, work items and docs are files, and YAML frontmatter carries the metadata.\n"; an in-paragraph drag-copy gives the same 148 bytes. So prose copy is healthy and the mermaid block is the variable.

7) ADJACENT (not filed): select-all on systems-map -> clipboard 0 bytes; copy event selAtEvent="collapsed=true ranges=1 len=0", defaultPrevented=false, types="" — while screenshot 04-after-cmd-a.png shows the entire document, including the FLOWCHART chrome and the svg labels, painted in native selection blue. No .bn-block-selected / .ProseMirror-selectednode decorations exist (0 matches); the only selection-ish classes in the DOM are "select-none" and three placeholder-selector-<uuid>. Compare the 148 bytes the control doc yields for the identical gesture.

Screenshots: .../verify-7/01-before-select.png, 02-selected.png, 03-after-paste.png, 04-after-cmd-a.png
- **Suspected cause** — StructuralEditor registers no dismiss layer for its own selection state, so the dialog's document-level Escape (Dialog.tsx:111) is the only handler that answers. The popovers and the rename box both do the right thing here — selection is the gap.
- **Verifier's reasoning** — I tried to refute this and could not. It reproduces on my own probe, with trusted input, on a fresh server (:5427), and it is not an artefact, not documented, and not a stale-HEAD effect (my tree is m29-mermaid at 390fa04, one commit past the reported f88c292; f88c292 is an ancestor).

WHY IT IS NOT A PROBE ARTEFACT. The gesture was a real page.mouse drag with 24 intermediate moves and a real ControlOrMeta+c keypress — no dispatchEvent anywhere. I read the result three independent ways and all three agree: (a) window.getSelection().toString() after the drag, (b) clipboardData read from inside the genuine copy event by a passive bubble-phase listener that only reads what the app already wrote, and (c) navigator.clipboard.readText() against the real OS clipboard with clipboard-read granted. (c) is byte-identical to (b), so this is not an event-timing illusion. I waited for all four fences to render (mermaid-diagram count 4, both the first and the ELK svg visible, mermaid-error count 0) before touching anything, so no async-render race.

WHY IT IS NOT DOCUMENTED BEHAVIOUR. src/editor/blocks.tsx declares MermaidBlock with propSchema {code}, content:'none', and ONLY a render function — no toExternalHTML. The neighbouring inline specs in src/editor/chips.tsx each define one, under the comment "toExternalHTML emits exactly the plain-text form, so markdown export" (chips.tsx:28), so supplying a plain-text form for a custom node is this codebase's own stated convention and mermaid just skips it. BlockNote 0.46.2 derives text/plain from that external HTML (node_modules/@blocknote/core/dist/blocknote.js:1396 sets blocknote/html, text/html and text/plain from one serializer pass), so with no toExternalHTML it falls back to the rendered chrome. Nothing in src/mermaid/ or src/editor/ comments this as intentional. The closest thing to a defence actually cuts the other way: StructuralEditor.tsx:1069 applies select-none with the comment "a manual-mode drag across labels otherwise paints the whole diagram in selection highlight" — the team fixed exactly this painting problem on the EDIT surface and left the read-mode block untreated.

SEVERITY. I checked whether it deserves promotion to "broken" and decided no, so no correction. The loss is external-only: an in-app copy→paste round-trip is lossless (mermaid blocks 4 → 5 after pasting the same span back in; the mock disk gained a 5th ```mermaid fence with the source byte-correct and contains no "Open full screen"), because blocknote/html and the data-code attribute on text/html both carry the source. The vault on disk is never harmed. "wrong" is the honest call: it works, but what leaves the app is visibly the wrong content. If anything the reporter under-called rather than over-called it.

ONE CORRECTION TO THEIR SUSPECTED MECHANISM, which does not change the verdict: they wrote that "ProseMirror's text serializer falls back to the node's rendered text". It is BlockNote's own copyToClipboard extension, not ProseMirror's default — the copy event came back with defaultPrevented=true and types "blocknote/html,text/html,text/plain", i.e. the app's handler ran and deliberately wrote all three flavours. Their proposed fix (a toExternalHTML emitting the ```mermaid fence, plus select-none on the header) is still the right shape; markdown.ts:215 already demotes a mermaid block back to a fence for the disk path.

ADJACENT, NOT PART OF THIS CLAIM, REPORTED FOR CONTEXT ONLY: on the same doc, click into prose then Cmd+A then Cmd+C puts 0 bytes on the clipboard, while the identical gesture on mermaid-free inbox/welcome.md yields 148 bytes of correct markdown. A screenshot shows the whole document painted in native selection blue, yet getSelection() reports collapsed=true, ranges=1, len=0 at copy-event time, so BlockNote's handler bails (defaultPrevented=false, types empty). I could not attribute that to the mermaid block with the confidence I would want, so I am not filing it — it needs its own investigation.

### [rough] The dialog toolbar clips "Save PNG…" off the right edge below ~620px with no way to scroll to it

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — medium
- **Repro** — 1. Narrow the app window to ~600px or less.
2. Open a mermaid block full screen.
3. The right-hand toolbar group runs past the window edge; "Save PNG…" is unreachable and the toolbar does not scroll.
- **Measured** — diagram-toolbar scrollWidth vs clientWidth: 1440/1440 @1440px, 700/700 @700px, 657/620 @620px, 657/560 @560px; computed overflow-x = `visible` at every width. "Save PNG…" right edge overshoots the window by 37.5px @620 and 97.5px @560. Expected: an overflow-x:auto strip, a wrap, or an overflow menu.
- **Re-measured by the verifier** — Block 0 of demo-vault/strategy/systems-map.md, Chromium 1440x900, light theme, :5431.

BEFORE dblclick — buttons ['Open full screen','Save as file…','Edit','Expand diagram'], structural-host 0, textarea 0, mermaid-live-preview 0, mermaid-diagram 1, block innerHTML 18642 bytes, .ProseMirror-selectednode 0.
Diagram bounding box: x=425 y=296 w=638 h=445.3.

AFTER locator.dblclick() at the box centre (+1200ms) — buttons IDENTICAL, structural-host 0, textarea 0, live-preview 0, innerHTML 18642 bytes (byte-identical), dialogs 0, mermaid-lightbox 0. Changed only: .ProseMirror-selectednode 0 -> 1 and window.getSelection() = "\nFLOWCHART\nOpen full screen\nSave as file…\nEdit\nship\n\nrework\n\nIdea\n\nBuild\n\nReview\n\nDone\n". Expected: structural-host 1.
2nd dblclick: no delta. dblclick on .nodeLabel: no delta. dblclick on the header "FLOWCHART" label: structural-host 0, textarea 0. Single click: no delta.

POSITIVE CONTROL, same run — click header "Edit" (+1200ms): structural-host 0 -> 1, mermaid-diagram 1 -> 0, buttons become ['Show code','Done','+ Node','+ Shape','TD','LR','BT','RL','Layout: Dagre','Auto-layout: On'], innerHTML 18642 -> 19510 bytes. Detector works.

EDIT AFFORDANCE, mouse parked at (5,880) so nothing is hovered — 'Edit' rect x=1031 y=261 w=34 h=22, display block, visibility visible, opacity 1, font-size 12px, color rgb(126,134,153) on rgba(0,0,0,0); isVisible() true. ('Expand diagram' by contrast measures display:none, 0x0 — that one IS hover-gated.) So the entry point is permanently visible but is 34x22px of low-contrast grey 12px text at the far right of the header.

NO DATA LOSS — after dblclick (selectednode 1) then keyboard.type('x'), +1500ms: mermaid blocks 4, diagrams 4, selectednode still 1; +2500ms later window.__cerebroMockFs systems-map.md = 842 bytes, 4 '```mermaid' fences, head unchanged.

COMPARISON CONTROL — Cmd+K "Pipeline" -> diagram-page: structural-host 1, canvas-plane 1, diagram-toolbar 1 with zero gestures. PROSE CONTROL — dblclick a paragraph in the same doc: selection "the", document.activeElement contenteditable="true".

Page errors across all runs: []. Screenshots: verify-11/01-before.png, 02-after-dblclick.png, 03-after-node-dblclick.png, 04-after-edit-link.png, 10-no-hover.png, 11-after-type.png.
- **Verifier's reasoning** — I tried to refute it and could not. Own probe (/private/tmp/.../verify-11/probe.spec.ts), own dev server on :5431, worktree HEAD 390fa04 (one commit past f88c292; MermaidBlockView.tsx moved only 4 lines in that commit, none of them event wiring). Gestures driven with Playwright locator.dblclick() — trusted events, no dispatchEvent — with a 1.2s settle after each and a POSITIVE CONTROL in the same run: clicking the header "Edit" flips the same snapshot from structural-host 0 to 1 and rewrites the block from 18642 to 19510 bytes of innerHTML, so my detector demonstrably sees edit mode when it happens. It never sees it after a double-click.

Checked the three usual escapes and none applies. (a) Not a probe artefact: reproduces on the svg centre, on a .node/.nodeLabel, and on the header label; twice in a row; no page errors. (b) Not documented: I grepped src/mermaid/ and docs/superpowers/plans/ for double-click/dblclick decisions — the only hits are the OPPOSITE way, StructuralEditor.tsx:557 wires el.ondblclick for node rename and the M29g plan states "click-select and double-click-rename keep working unchanged". MermaidBlockView.tsx:78 enumerates the entry points as "(Edit, template pick, error click, Blank)" — an enumeration of what exists, not a reason dblclick is excluded. No comment defends the absence. (c) Severity "rough" is honest and I am not correcting it: the Edit affordance is NOT hover-hidden (measured below), and the gesture is not destructive.

One correction to their account, which is why this is "rough" and not more: the double-click is not literally inert. It is consumed by ProseMirror, which takes a NodeSelection on the block (.ProseMirror-selectednode 0 to 1, and the whole block's text lands in window.getSelection()). It just never reaches the app. I probed the obvious escalation — dblclick to select the node, then type a printable character — and the diagram survives: 4 mermaid blocks, 4 diagrams, and demo-vault/strategy/systems-map.md still 842 bytes with 4 ```mermaid fences on the mock disk. No data loss, so this stays a missing-affordance finding.

Confidence is medium, not high, because the measurement is certain but the verdict is a UX-convention call: nothing is broken and every function is reachable. What tips it over is the app's own inconsistency — dblclick edits inside the structural editor, the standalone .mmd page opens straight into a canvas editor with no gesture at all, and every other content type in the surrounding document takes a click to edit (I dblclicked prose: it selects the word "the" in a live contenteditable). The doc mermaid block is the one island in an editor that requires finding a 34x22px grey link.

### [rough] Closing the dialog drops focus into the doc body instead of the trigger, and the next keystrokes are swallowed

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, "Open full screen" on the first block, then close it with the X.
2. Type something. Nothing happens — no caret, no text, and the "Open full screen" button you came from is not focused either.
- **Measured** — activeElement after close = the `div.tiptap.ProseMirror` doc root (path `div < div < div[markdown-editor] < div < div[doc-content]`), not the trigger: of the 4 "Open full screen" buttons on the page, focused = false for all. Typing "hello" then waiting 2.5s leaves systems-map.md at 842 bytes and `includes("hello") === false`. Same landing spot after an Escape close in the same run. (Focus does return to the trigger in the simplest case — a fresh dialog closed with Escape before BlockNote has taken focus back — so it is inconsistent rather than always wrong.) Expected: focus back on the "Open full screen" button, per useFocusRestore's contract.
- **Re-measured by the verifier** — All from my run, Chromium 1440x900, dev server :5460, worktree HEAD 390fa04.

Cmd+K, count of [data-testid="quick-open-input"] after 600ms:
- CONTROL A, contentEditable paragraph in the same doc ("How the demo product…"): 1
- SUBJECT, sequence block source box (activeElement = TEXTAREA[Mermaid source], block header text = "SEQUENCE"): 0
- CONTROL B, Escape then click paragraph again: 1
- assistant composer (TEXTAREA[Message the assistant]): 1
- .mmd standalone canvas, code-overlay textarea (demo-vault/diagrams/pipeline.mmd): 0
Expected 1 in every row.

Keydown reach, passive listeners, [document capture] vs [window bubble] — window is the phase App.tsx:280 listens on:
- CONTROL paragraph, Cmd+K: capture ["Meta+meta","k+meta"] / window ["Meta+meta","k+meta"]
- SUBJECT source box, Cmd+K: capture ["Meta+meta","k+meta"] / window []
- SUBJECT source box, Cmd+J: capture ["Meta+meta","j+meta"] / window []
- SUBJECT source box, plain "x": capture ["x"] / window []  → every key, not just modified ones
- code-overlay textarea, Cmd+K: capture ["Meta+meta","k+meta"] / window []
- composer textarea, Cmd+K: capture ["Meta+meta","k+meta"] / window ["Meta+meta","k+meta"]

Cmd+Shift+L (theme flip), documentElement[data-theme]:
- CONTROL, from a paragraph: light -> dark (flips)
- SUBJECT, from the source box: dark -> dark (no flip)

Cmd+J with the source box focused: [data-testid="ai-panel"] count 0 -> 0 (panel never opens).

Screenshots: subject-cmdk.png shows the source box open, no Quick open dialog, and the header search box still advertising "⌘K"; control-cmdk.png shows the Quick open dialog present. Both under /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-12/.

Source sites: /Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid/src/mermaid/MermaidBlockView.tsx:229 and /Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid/src/mermaid/CodeOverlay.tsx:116; the listener they starve is window.addEventListener('keydown', onKey) at /Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid/src/App.tsx:280.
- **Suspected cause** — useFocusRestore captures the trigger at dialog render time, but BlockNote re-creates the mermaid block's node view when its props change (and reclaims focus on click), so the captured node is stale/detached by close time and the restore lands on <body>, after which ProseMirror grabs focus with a non-collapsed selection over the block that accepts no input.
- **Verifier's reasoning** — Confirmed with my own probe (/private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-12/probe.spec.ts), written from the repro steps, not theirs. I attacked it on all four refutation axes and it survived every one.

(1) Reproduces: yes, first run, and again on a second full run. All gestures were trusted input — locator.click() and page.keyboard.press('ControlOrMeta+k'); the only page.evaluate calls read state (activeElement, data-theme, and two passive keydown listeners used purely as instrumentation). I waited 600ms after the keystroke before counting, so a slow palette mount is ruled out.

(2) Probe artefact: no. The mechanism is directly measurable, not inferred. I attached a passive listener on document (capture) and on window (bubble, the exact phase App.tsx:280 uses). With the mermaid source box focused, the capture listener recorded ["Meta+meta","k+meta"] while the window listener recorded []. The event exists and is killed between the two — which is precisely what a React synthetic e.stopPropagation() at the React root container does to a window-level bubble listener. Controls in the same run and the same page proved the harness delivers the key: paragraph → count 1, and after Escape → count 1 again.

(3) Documented behaviour: no. The comment above MermaidBlockView.tsx:228 reads "// BlockNote hotkeys must not fire while typing in the source box." That justifies silencing BlockNote; it says nothing about app-level shortcuts, and the blanket stop is wider than its own stated reason. The sibling handler 40 lines up (the visual pane, line ~193) shows the authors know how to do this narrowly: it stops ONLY Escape and comments that it does so deliberately because there is "No Stage-B textarea here to swallow BlockNote hotkeys via e.stopPropagation on every keystroke". No unit test in MermaidBlockView.test.tsx asserts the swallow (grep for stopPropagation/hotkey/quick there returns nothing), so nothing pins it as intended. And the same blanket stop at CodeOverlay.tsx:116 (`onKeyDown={(e) => e.stopPropagation()}`, no comment at all) is on the standalone .mmd canvas, where BlockNote is not even mounted — so the stated justification cannot apply there, yet I measured the identical dead Cmd+K.

(4) Not app convention: two comparison surfaces keep their hotkeys. The BlockNote contentEditable paragraph (activeElement = DIV contentEditable=true) and the assistant composer (TEXTAREA[Message the assistant], ChatInput.tsx:310, which handles keys selectively and does not blanket-stop) both open quick-open, count = 1, event reaching window.

Severity "rough" is honest and I am not correcting it: nothing is lost or corrupted, and Escape/Done restores every shortcut. It is a lost affordance in one context — mildly aggravated by the header search box rendering a literal "⌘K" hint that is visible on screen while the shortcut is dead (see subject-cmdk.png).

One caveat on provenance: the worktree has advanced one commit past the claimed f88c292 — HEAD is now 390fa04 (M29.52). `git diff f88c292 390fa04 -- src/mermaid/MermaidBlockView.tsx` touches only LivePreview (useLegibleWidth + a mx-auto class); the keydown handler is byte-identical, so my measurement holds at both commits. Also: my assigned port 5432 is occupied by Postgres on this machine, so I ran my own server on 5460 (no other agent was on it).


## Unverified — the verifier never returned; treat as a lead

### [broken] Keyboard-only users cannot select a node, so the entire visual editor — toolbar, shapes, colours, icons, links, rename, delete, grouping — is unreachable without a mouse

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Open the Pipeline diagram (Cmd+K, "Pipeline", Enter). 2. Put the mouse away. 3. Press Tab repeatedly through the whole page. 4. Note that focus never enters the diagram. 5. With focus anywhere on the page press Enter, Space, ArrowRight, ArrowDown, Home, Delete. 6. Nothing selects; no node toolbar ever appears.
- **Measured** — Full tab ring of the diagram page = 29 stops (Skip to content, 8 rail buttons, Search, New, 11 diagram-toolbar buttons, 4 zoom-cluster buttons, 3 status-bar buttons) then BODY. Stops whose activeElement is inside `structural-host` or inside any `svg`: 0. All four `g.node` elements: tabindex=null, role=null, aria-label=null. Focusable descendants of `structural-host` (`[tabindex], a[href], button, input, select, textarea`): 0. The StructuralEditor root carries tabIndex={-1} (StructuralEditor.tsx:917), so it is not a Tab stop either. After pressing Enter/Space/ArrowRight/ArrowDown/Tab/Home/n/Escape, every selection-gated surface is still absent: mermaid-node-toolbar=0, mermaid-subgraph-toolbar=0, shape-palette=0, node-style-menu=0, mermaid-icon-picker=0, mermaid-link-popover=0, mermaid-edge-editor=0, mermaid-group-bar=0. Delete with no selection left demo-vault/diagrams/pipeline.mmd byte-identical in __cerebroMockFs. The svg itself has role="graphics-document document" but aria-label=null, no <title> and no <desc>, so a screen reader gets an unnamed graphic. Expected: at least one focus entry point into the diagram (roving tabindex on g.node, or a focusable host with arrow-key traversal) and an accessible name per node.
- **Suspected cause** — `bindFlowchartSvg` attaches raw onclick/onpointerdown handlers to mermaid's nodes but adds no tabindex/role/aria-label, and StructuralEditor's keydown handler (Delete/Backspace) is gated on `validSelected`, which only a mouse click can ever set. The svg subtree is written imperatively via innerHTML and never given a focus model.

### [broken] Below a 900px window the whiteboard's diagram toolbar overflows: "Save PNG…" is pushed entirely outside the document, the view title truncates to zero width, and "+ Node"/"+ Shape" wrap two lines out of a 40px bar

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Resize the window to 800x600. 2. Cmd+K -> "Delivery schedule". 3. + View -> Whiteboard -> Create. 4. Look at the toolbar row above the canvas.
- **Measured** — At 800x600 (sidebar open, content pane 564px): `diagram-toolbar` scrollWidth 664 vs clientWidth 564 = 100px of content overflow, with computed overflow-x: visible and flex-wrap: nowrap, so it neither scrolls nor wraps. "Save PNG…" rect x=805 right=900 against document.documentElement.clientWidth=800 — the whole button sits past the document edge (body.scrollWidth stays 800, so there is no page scrollbar to reach it). "Copy PNG" right=801, 1px clipped. The title span "Whiteboard" measures clientWidth 0 / scrollWidth 73 — truncated away completely, not even an ellipsis. "+ Node" and "+ Shape" each measure height 46px inside a bar whose own height is 40px (`h-10`), i.e. their text wrapped to two lines and they now protrude 6px below the toolbar's bottom border. Width sweep of scrollWidth-clientWidth: 1024->0, 1000->0, 960->0, 940->0, 920->0, 900->0, 880->20, 860->40, 800->100, 768->132. Expected: 0 overflow at every size, or a bar that wraps/scrolls/collapses into an overflow menu.
- **Suspected cause** — DiagramToolbar.tsx:111 is `flex h-10 flex-none items-center gap-1 ... px-2` with no `flex-wrap`, no `overflow-x-auto`, no `min-w-0`/`shrink-0` discipline and no responsive collapse. The `<span className="flex-1" />` spacer absorbs slack until it hits 0, after which the three DS Buttons (which do not shrink) simply run off the end while the shrinkable text buttons squash and wrap. The whiteboard is the only host that passes `title`, which is what pushes it over the edge ~100px earlier than the other hosts.

### [broken] Tabbing to that overflowed toolbar button scrolls the whole content pane 100px sideways, sliding the page title, tabs and canvas under the sidebar, with no snap-back

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Resize the window to 800x600. 2. Cmd+K -> "Delivery schedule". 3. + View -> Whiteboard -> Create. 4. Press Tab 17 times until "Save PNG…" takes focus. 5. The entire page content jumps 100px to the left and stays there.
- **Measured** — Before: `div.@container/canvas` scrollLeft 0 (scrollWidth 664 / clientWidth 564); whiteboard-view x=236, diagram-toolbar x=236, canvas-viewport x=236, list-title-edit x=256, rail x=0. After Tab #16 lands on "Save PNG…": that div's scrollLeft = 100 and every one of those moves left by exactly 100 — whiteboard-view x=136, diagram-toolbar x=136, canvas-viewport x=136, list-title-edit x=156 — while the rail stays at x=0, so the content slides underneath it (the page title now reads "y schedule", the Gantt tab is gone, "+ Node"/"+ Shape" and half the zoom cluster are hidden behind the sidebar). Recovery: a horizontal wheel over the canvas does NOT restore it (scrollLeft still 100 — the viewport's native wheel listener preventDefault()s unconditionally for zoom); only re-focusing a left-hand control does (clicking "+ Node" returned it to 0). The M29.51 snap-back guard is on `canvas-viewport`, a different element — its own scrollLeft correctly stayed 0 (scrollWidth 777 / clientWidth 564) while the ancestor did all the scrolling. Expected: scrollLeft stays 0, or the same onScroll snap-back applies to whatever ancestor can scroll.
- **Suspected cause** — Focusing an element that lies outside its scroll container makes Chromium scroll the nearest scrollable ancestor to reveal it — exactly the failure mode M29.51 documents and fixes for `canvas-viewport`. Here the overflowing child is the TOOLBAR, whose nearest scrollable ancestor is the page-level `@container/canvas` wrapper, which has no guard.

### [broken] One keystroke while the diagram lightbox is open deletes the whole mermaid block from the document

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Docs -> Strategy -> Systems map.
2. Hover the SEQUENCE diagram and click the Expand (maximize) button in its top-right corner. The lightbox opens; focus lands on its Close button.
3. Press any printable key — 'a', '=', or Backspace (Escape and Cmd+= are safe).
4. The lightbox vanishes and so does the diagram: the sequence block and the '## Rollout' heading after it are gone from the document.
- **Measured** — strategy/systems-map.md in __cerebroMockFs went 842 bytes / 4 ```mermaid fences -> 653 bytes / 3 fences; after('sequenceDiagram') === false. Repeating with 'a' then Backspace took it to 506 then 361 bytes — one whole block per keystroke. Diff of the saved doc: the entire sequenceDiagram fence and the '## Rollout' heading are removed and the surrounding headings merge into '## Order flowaRollout'. Re-verified at 20:36 against the live tree with key 'q': 842B/4 -> 653B/3, sequenceDiagram absent, 0 dialogs left open. Cmd+Z does bring it back (843B). CONTROLS, both measured safe: the full-screen dialog with focus on its Copy SVG button + key 'x' -> 842B -> 842B, gantt still present; clicking the diagram with no dialog + key 'z' -> 842B -> 842B. Expected: a modal viewer swallows keystrokes; measured: they reach the ProseMirror node selection behind it (the .cb-dlg-scrim is a DOM descendant of the contenteditable — scrimInsideEditable === true).
- **Suspected cause** — MermaidLightbox's Dialog renders in place inside MermaidBlockView, which is inside BlockNote's contenteditable. Clicking 'Expand diagram' leaves a ProseMirror NodeSelection on the mermaid node; the dialog does not portal out and does not stop keydown propagation, so the keypress is handled by the editor as 'type over the selected node'.

### [broken] Copy PNG and Save PNG… fail for every diagram type mermaid draws with HTML labels — including all flowcharts

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Docs -> Strategy -> Systems map.
2. Hover the first (flowchart) diagram, click Expand.
3. Click 'Copy PNG' -> toast 'Copy PNG failed', nothing on the clipboard.
4. Click 'Save PNG…' -> no file is produced.
5. Same on the ELK flowchart block, and on class / stateDiagram-v2 / erDiagram / journey / mindmap sources typed into a block.
6. Same on the diagram page (Cmd+K -> Pipeline): Copy SVG works, Copy PNG and Save PNG… do not.
- **Measured** — Clipboard seeded with a 'SENTINEL' text item before each attempt. FAILS (clipboard stays ['text/plain'], toast 'Copy PNG failed', no download event): flowchart (8 <foreignObject> inline / 14 in the .mmd), ELK flowchart, class (4), state (4), ER (3), journey (2), mindmap (3). WORKS (clipboard ['image/png']): sequence 60846B 1300x742, gantt 36806B 2880x296, pie 106674B 1150x900, timeline 54586B 1790x932, gitGraph 24770B 498x344, quadrantChart 35906B 1000x1000 — all with 0 <foreignObject>. The correlation is exact: 6 of the 12 types I tried cannot be exported as PNG at all, including the flagship flowchart. Root cause measured on the exact string Copy SVG puts on the clipboard: the <img> loads fine, drawImage succeeds, then canvas.toBlob throws "SecurityError: Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported."; stripping every <foreignObject> from that same string makes toBlob return 16030 bytes. Re-verified at 20:43: clipboard ['text/plain'], toast 'Copy PNG failed', Save PNG download NONE.
- **Suspected cause** — src/mermaid/export.ts svgToPngBytes rasterises through an <img> + canvas; an SVG image containing <foreignObject> taints the canvas in Chromium, so toBlob raises SecurityError and the promise rejects into the generic 'Copy PNG failed' / 'Save PNG failed' toast. Mermaid's htmlLabels default puts foreignObject in flowchart/class/state/ER/journey/mindmap output.

### [broken] Under the ELK layout engine the subgraph toolbar can never be opened — mermaid names the cluster group "[object Object]", so it is never bound and carries no click handler

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Cmd+K → "Pipeline" (demo-vault/diagrams/pipeline.mmd — it ships with `layout: elk`).
2. Click node Capture, shift-click Distill, shift-click Capture → group bar appears.
3. Type a title, press "Group into subgraph". The subgraph IS created in the file.
4. Click anywhere on the cluster's box (its border, its title band, its empty padding).
5. Nothing happens: no rename box, no direction buttons, no Ungroup. There is no other route to those controls.
6. Now open the Layout menu → Dagre. Click the same cluster: the toolbar opens and rename/direction/dissolve all work.
- **Measured** — ELK: cluster `<g class="cluster">` has id "[object Object]", el.style.cursor === "" (never set), el.onclick === null, rect 132.69×175.5 at (693.66, 351). Clicking its centre-top → mermaid-subgraph-toolbar count 0. A 21×21 elementFromPoint grid over the cluster shows 217/441 points DO land on the cluster's own rect, so it is hittable — nothing is listening.
Dagre (same document, same subgraph): id "cerebro-mermaid-3-Front_half", cursor "pointer", onclick attached, click → toolbar count 1 (308.27×38 at (693.66, 556)); rename → `subgraph Front_half[Second half]`, direction → `    direction LR`, dissolve → block removed. Expected: identical behaviour on both engines. svgBinding.ts:216 documents the id contract as MEASURED on dagre only.
- **Suspected cause** — bindFlowchartSvg's cluster lookup (svgBinding.ts ~line 225) does `stripRenderId(el.id)` and requires exact equality with the model's subgraph id. The bundled mermaid's ELK renderer writes the DOM id from an object rather than the subgraph id, so el.id is literally the string "[object Object]" and the find() never hits — clusterEls stays empty, so StructuralEditor's cluster loop attaches no onclick and no cursor. A fallback (e.g. index/title match, or reading the cluster-label text) would close it.

### [broken] Once the source passes 31 lines the code panel grows over the zoom cluster and every zoom control becomes unclickable

- **Surface** — The .mmd diagram page
- **Repro** — 1. Cmd+K → "Pipeline" to open diagrams/pipeline.mmd.
2. Click "Show code".
3. Type (or paste) a flowchart of ~31+ lines — e.g. `flowchart TD` followed by 30 `N0 --> N1` edges.
4. Try to click Zoom out / the 100% reset / Zoom in / Fit at the bottom-left of the canvas.
- **Measured** — The panel is `absolute left-3 top-3 max-h-[calc(100%-24px)]`, the zoom cluster is `absolute bottom-3 left-3`, and both sit in the same corner column. Threshold measured line by line at 1440×900: 29 lines → panel height 665, bottom 825, cluster top 830, elementFromPoint at the cluster centre = BUTTON[Reset zoom] (fine). 31 lines → panel hits its 700px cap, bottom 860 = cluster bottom 860, and elementFromPoint at ALL FOUR button centres returns TEXTAREA[Mermaid source]: Zoom out (85,845), Reset (119.4,845), Zoom in (153.8,845), Fit (179.8,845), hitIsTheButton=false for every one. A real page.mouse.click at Fit's own pixels (179.8,845) left the zoom at 100% (before 100%, after 100%) and moved document.activeElement to TEXTAREA[Mermaid source]; a real click at Zoom-in's pixels also left it at 100%. Overlay rect (68,160)-(408,860) vs cluster rect (68,830)-(196.8,860) = 128.8×30px overlap, i.e. 100% of the cluster. Expected: the cluster reachable, or the panel to stop above it. Screenshots 04-long-overlay.png and 40-long-fit-blocked.png show the cluster is not even visible. This compounds: a 41-node diagram renders 5435px tall at 100% and Fit is the only way to see it.
- **Suspected cause** — CodeOverlay.tsx:115 pins `left-3 top-3` + `max-h-[calc(100%-24px)]` into the same relative box where CanvasViewport draws its `bottom-3 left-3` cluster (CanvasViewport.tsx:371-397), with z-20 over z-10. Nothing reserves the cluster's 30px strip.

### [broken] A mermaid syntax error in visual mode leaves a stale diagram painted forever and reports nothing

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd, click "Show code".
2. Break one line — delete the closing brackets so the source reads `flowchart TD` / `  A[Capture --> B[Distill`.
3. Wait for the autosave. Look at the canvas.
4. Click "LR", then "+ Node", and look again.
- **Measured** — Source on disk after the edit: "---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Capture --> B[Distill\n" (69 bytes, only two node ids, one of them malformed). Nodes actually painted on the canvas: ["Capture","Distill","Verify","Publish"] — the four-node diagram that existed BEFORE the edit. fullscreen-render-error count = 0, toast count = 0, elements matching [class*="danger"] = 0, header type label still "Flowchart", save chip "Saved", structural-host still mounted (1) and readonly face 0 — so the demotion path and its error banner never run. Clicking "Direction LR" wrote `flowchart LR` to disk and the canvas still painted the same four TD nodes; "+ Node" appended `n1[New step]` to disk and the canvas still painted the same four nodes. Repairing the source to a valid 2-node flowchart immediately repainted 2 nodes, proving the earlier render was stale. Expected: an error banner (the read-only face has one) or at minimum a stale marker; got a canvas that silently disagrees with the file.
- **Suspected cause** — FullScreenDiagramEditor.tsx:169 gates the error banner on `mode === 'code'`, and the demotion effect (line 74) only fires when parseFlowchart returns null. `A[Capture --> B[Distill` still parses as a flowchart model, so mode stays 'visual', StructuralEditor keeps its last good svg, and mermaid's render failure has nowhere to surface.

### [broken] With Auto-update off, "Hide code" silently destroys the unapplied draft while the header still reads "Saved"

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd, click "Show code".
2. Turn the Auto-update switch OFF.
3. Type a new line into the source, e.g. `  Z --> Q[Quit]`. The dirty dot appears.
4. Click the X ("Hide code") instead of Apply.
5. Click "Show code" again.
- **Measured** — After typing with Auto-update off: file unchanged at 123 bytes, dirty dot count 1, page save chip "Saved". After clicking Hide code and waiting 1.5s: file still 123 bytes and `closed.includes('Q[Quit]') = false` — the typed text is gone from disk AND from memory. Reopening the panel: switch is back to checked=true and `reopened value has Quit = false`. The page's save chip read "Saved" the whole time. Expected: either a flush, a confirm, or at minimum the draft surviving a re-open; got silent destruction behind a button whose label is "Hide code", not "Discard".
- **Suspected cause** — CodeOverlay.tsx:103-109 — the unmount flush is gated on `autoRef.current`, so the Auto-update-off branch deliberately drops the draft; the panel is unmounted by `showCode` (FullScreenDiagramEditor.tsx:178) with no confirmation and no dirty signal reaching DiagramPage's chip.

### [broken] Dragging a node up or left does not move it — the rest of the diagram slides down-right instead, off the canvas

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Delivery > Delivery schedule > + View > Whiteboard > Create.
2. Add record twice (two nodes appear side by side).
3. Press the left-hand node and drag it up and to the left by ~600x420 px.
4. Watch the node you are dragging, and the other node.
- **Measured** — probe10 (viewport 320..1440 x 227..872). Before: node A left=880 top=550, node B left=1108 top=550, svg viewBox "0 0 479.45 65.5", svg client box pinned at (872,542).
During a (-600,-420) drag, sampled at 25/50/75/100 %: node A stayed at left=880, top=549 in EVERY sample and after the drop (expected: it follows the cursor, ending near left=280, top=130). Node B — untouched — moved 1108,550 -> 1709,969, i.e. +601,+419, exactly the negation of the gesture, which puts it and its chip (1713,1009) outside the canvas entirely. viewBox grew to "-600.2 -419.75 1079.66 485.25" while the svg's screen origin never moved.
probe7 single-node canvas: pointer (-200,-150) -> node moved (0,-52) (lag 200,98); the two following drags, rightward/downward and inside the existing box, tracked exactly (lag 0,0). probe11 confirms the node is still painted (fill rgb(238,241,254), opacity 1) — it simply did not move.
Screenshot: p10-far-drag.png — the node sits exactly where it started and the second node is gone.
- **Suspected cause** — manualLayout.growViewBox extends the viewBox's origin left/up by the drag amount, but nothing compensates the svg's screen mapping, so a leftward/upward move re-renders as a translation of everything else. The stored plane position is correct (`%% cerebro:pos n1 -503,-387`), which is why unit tests pass. Whiteboards seed `%% cerebro:layout manual`, so this is the default drag on this surface and hits the first node a user ever drags.

### [broken] "Add record" drops the 4th record and beyond entirely outside the visible canvas, with no feedback

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Delivery > Delivery schedule > + View > Whiteboard > Create.
2. Click "Add record" and pick the first offer. Repeat five times.
3. Records 1 and 2 appear; 3 is half cut off; 4 and 5 produce no visible change at all.
- **Measured** — probe5 P5-A, canvas viewport = x 320..1440, y 227..872 (1120x645), zoom stays 100 %. Node rects as added: #1 x=880 (viewport centre, fully visible), #2 x=1108, #3 x=1393 w=197 -> 150 px past the right edge, #4 x=1640 w=260 -> 460 px past, entirely invisible, #5 x=1761 -> 521 px past, entirely invisible. Their chips are off-screen too (chips inside viewport: true,true,true,false,false). All five ARE in the file. Clicking "Fit diagram" reveals them at 99 % (nodes then at x=343..1418). Re-verified 20:35 on the current tree with byte-identical numbers.
Screenshot: p5a-five-records.png (5 added, 2.5 visible).
- **Suspected cause** — whiteboardBindings.insertRecordNode calls addNode with no position (documented as a known limitation in WhiteboardView.tsx:265-276), so dagre places each new node in a row to the right of the last, starting from a plane origin that the one-shot initialFit parked at the viewport centre. Nothing re-fits or scrolls after an insert, so past ~3 records the primary action of the surface appears to do nothing.

### [wrong] When the OS theme flips at dusk, the full-page diagram editor's chrome goes dark but the diagram keeps the light palette — light-blue nodes with near-black text on a near-black canvas

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Settings -> Appearance -> System. 2. Cmd+K -> "Pipeline" to open the standalone diagram page. 3. Let macOS switch to Dark (or flip the OS appearance by hand). 4. The toolbar, canvas and status bar all go dark; the four nodes stay light blue with dark text. 5. Clicking empty canvas does not fix it; pressing a direction button (any real edit) does.
- **Measured** — themeMode='system', emulated colorScheme light -> dark with nothing else touched. data-theme went light -> dark; toolbar background rgb(255,255,255) -> rgb(21,24,31); canvas-viewport background rgb(251,251,253) -> rgb(25,29,37). But `g.node rect` fill stayed rgb(238,241,254) (light --cortex-50) and `.nodeLabel` colour stayed rgb(39,45,59) (light --n-800) for 4s and remained wrong after a real background click. Only a real edit re-rendered it: clicking "Direction LR" produced fill rgb(27,37,71) / label rgb(224,228,236). Resulting contrast while stuck: rgb(39,45,59) label on a rgb(25,29,37) canvas ground where the node has left = unreadable, and the node body is 15:1 brighter than everything around it. Control: all four doc-block fences on Systems map DID follow the same flip (fill 238,241,254 -> 27,37,71; labels 39,45,59 -> 224,228,236; 22,26,36 -> 244,246,250), so the block host is correct and only the canvas host is not.
- **Suspected cause** — MermaidDiagram.tsx and FullScreenDiagramEditor.tsx both subscribe to `useThemeEpoch()`, but FullScreenDiagramEditor only feeds it to its READ-ONLY face (`}, [code, mode, themeEpoch]`, FullScreenDiagramEditor.tsx:107). The visual face is StructuralEditor, whose renderMermaid effect deps are `[code, model, transformRef, manual, beginConnect, beginMove]` (StructuralEditor.tsx:450-695) — no theme epoch — so the cached light-palette svg stays in the DOM until `code` changes.

### [wrong] The code overlay grows down over the zoom cluster and swallows its clicks — zoom out / % / zoom in / Fit become invisible and unclickable, from 20 source lines at 1024x700

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Resize the window to 1024x700. 2. Cmd+K -> "Pipeline". 3. Click "Show code". 4. Type or paste a ~20-line flowchart into the panel. 5. The panel's bottom edge reaches the zoom cluster's row. 6. Click where the Zoom-in button is: nothing zooms, the caret lands in the source instead.
- **Measured** — At 1024x700 with a 23-line source: code-overlay rect y=160 h=500 bottom=660; canvas-zoom-controls rect y=630 h=30 bottom=660 — intersection 129 x 30 px, i.e. the ENTIRE 129x30 cluster. `document.elementFromPoint` at the Zoom-in button's own bounding-box centre (153.8, 645) returns TEXTAREA[aria-label="Mermaid source"] inside code-overlay. A real `page.mouse.click` at that exact pixel left the readout at "100%" (unchanged) and moved document.activeElement to that textarea. Same at 800x600 (overlay h=400 bottom=560, cluster y=530-560, same 129x30 overlap). Line count at which the cluster is first buried: 40 lines at 1440x900, 20 at 1024x700, 15 at 800x600. Cause is structural: code-overlay is `absolute left-3 top-3 z-20 max-h-[calc(100%-24px)]` and canvas-zoom-controls is `absolute bottom-3 left-3 z-10` — same corner, same 12px inset, overlay wins the stacking order, and the overlay grows to fill. Note Playwright's `click({trial:true})` actionability check says the button is fine, so a naive e2e assertion would not catch this; only elementFromPoint plus a real coordinate click does. The controls remain Tab-reachable and wheel-zoom still works, so it is a loss of the mouse path, not of the capability.
- **Suspected cause** — CodeOverlay.tsx:115 pins the panel to the same corner the zoom cluster occupies (CanvasViewport.tsx:374) with a higher z-index and an unbounded max-height. Nothing reserves the bottom-left 129x30 for the cluster, and nothing moves the cluster (or docks the panel) when they collide.

### [wrong] Cmd+Z immediately after a visual edit does nothing — undo only works once you click away from the button you just pressed

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → Flowchart block → Edit. 2. Press '+ Node'. 3. Press Cmd+Z to take it back.
- **Measured** — Occurrences of 'New step' in strategy/systems-map.md: 1 after '+ Node'; still 1 after Cmd+Z (focus is the '+ Node' button). Click the empty canvas first (activeElement becomes DIV.tiptap) then Cmd+Z → 0. Press Done, click a paragraph, Cmd+Z → 0. So the same keystroke is a silent no-op or a working undo depending on where focus happens to be, and the natural sequence (press the button, regret it, Cmd+Z) is the broken one.
- **Suspected cause** — History lives in BlockNote/ProseMirror, which only handles Mod-z when the editor has focus. A block-chrome <button> keeps focus after click, so the keydown goes nowhere. The block needs to route Mod-z/Mod-Shift-z to the editor while it is in edit mode (or return focus to the canvas after each op).

### [wrong] The gantt is illegible inline: a 1440-unit diagram is squeezed into a 638px block, rendering its labels at ~5px

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → scroll to 'Rollout'. 2. Try to read the date axis or the task names.
- **Measured** — Gantt svg: viewBox '0 0 1440 148', style 'max-width: 1440px', width attr '100%', rendered rect 638 x 65.6 → uniform scale 0.443. Declared text sizes 10px (date labels), 11px (task/section labels), 18px (title) render as bounding heights of 5px, 6px and 10px respectively — cap-height about 3px for the dates. The other three blocks are unaffected (they render at natural size). The lightbox is not a rescue: 'Expand diagram' shows it at 910 x 93.5 for the same 1440 viewBox (scale 0.632, date labels 8px tall) while the zoom readout claims '100%'.
- **Suspected cause** — MermaidDiagram's host applies `[&_svg]:max-w-full` unconditionally (MermaidDiagram.tsx line 134). Mermaid emits gantt charts at a fixed 1440 useMaxWidth canvas, so max-width forces a >2x downscale in a document column. Either let a wide diagram scroll horizontally in its overflow-auto host, or cap the downscale (e.g. min-scale 0.8) and scroll past it.

### [wrong] Rendered diagrams are left-aligned in the block, so a narrow flowchart sits against the left edge of 530px of empty white

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → look at the first Flowchart block, and at the ELK one at the bottom.
- **Measured** — Block 0 (flowchart TD): host rect x=425 w=638; svg rect x=425 w=108.6 → 529.4px of empty space to the right, 0 to the left. Block 3 (ELK): svg x=425 w=513.1 in the same 638 host → 124.9px right, 0 left. Computed style on the host is text-align: start, display: block, and the svg carries `style="max-width: 108.625px"`, so it is a left-flush block-level element. The sequence and gantt blocks happen to fill the width, so the four blocks in one document read as inconsistently aligned. Same in visual edit mode (host 638, svg 108.6 hard left, toolbar row above it).
- **Suspected cause** — MermaidDiagram.tsx line 132-138: the svg sink is a plain block div with no `mx-auto` / flex centering on the svg child.

### [wrong] A broken diagram dumps 816 characters of mermaid's raw parser token list into the document, while the in-editor banner shows only a useless truncated first line

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → Sequence block → Edit. 2. Select all, type 'sequenceDiagram\n  totally not valid @@@'. 3. Read the banner in the live-preview pane. 4. Press Done and read the error card that replaces the diagram in the document.
- **Measured** — View-mode error card: innerText length 816 chars, rect 638 x 258.5 inside a 307.5px-tall block — ten wrapped lines of "Expecting '()', 'SOLID_OPEN_ARROW', 'DOTTED_OPEN_ARROW', 'SOLID_ARROW', … 'DOTTED_POINT', got 'NEWLINE'" sitting in the middle of the prose. Edit-mode banner for the SAME error: text 'Line 2: Parse error on line 2:' (30 chars, 26px tall) — the line number is printed twice and every word about what is actually wrong has been cut, because it renders only `message.split('\n')[0]`.
- **Suspected cause** — MermaidDiagram.tsx line 118 prints `result.message` whole; MermaidBlockView.tsx line 391 prints `error.message.split('\n')[0]` after already prefixing 'Line N: '. The useful middle (the caret line and the offending token) is what neither shows.

### [wrong] Copying a passage that spans a mermaid block puts the block's button labels in the clipboard instead of the diagram source

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map. 2. Drag-select from the intro paragraph down to the 'Order flow' heading, crossing the first diagram. 3. Cmd+C. 4. Paste into any plain-text editor.
- **Measured** — Clipboard text/plain (read both from the real copy event's clipboardData and from navigator.clipboard.readText()): "ow the demo product's pieces talk to each other. The flowchart below uses the\\\ndefault layout; the last one uses ELK, which proves the optional engine loads.\n\nFlowchartOpen full screenSave as file…Edit\n\n## Order f\n". The diagram is represented by the string 'FlowchartOpen full screenSave as file…Edit' — the header chrome — and the mermaid source is nowhere in it. The DOM selection likewise highlights the header buttons and the SVG node labels (selection string contains 'FLOWCHART\nOpen full screen\nSave as file…\nEdit\nship\n\nrework\n\nIdea…').
- **Suspected cause** — The mermaid block spec has content:'none' but its chrome is ordinary selectable DOM, so ProseMirror's text serializer falls back to the node's rendered text. A `toExternalHTML`/text serializer emitting the ```mermaid fence (markdown.ts already knows how to demote it) plus `select-none` on the header would fix both halves.

### [wrong] An uncommitted code draft is thrown away without warning when you leave the doc, and the status bar says 'No changes' the whole time

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → Sequence block → Edit. 2. Select all in the source box and type a new diagram, e.g. 'sequenceDiagram\n  Z->>W: unsaved work'. 3. Watch the live preview render it. 4. Navigate away (Home in the rail, or any other doc). 5. Come back to Systems map.
- **Measured** — strategy/systems-map.md never contains 'unsaved work' (disk check after navigating: false), and on return the block is back in view mode showing the ORIGINAL sequence diagram with no textarea and no prompt. Status-bar text scraped before opening the editor and again after typing is identical both times: 'No changes'. Nothing at any point tells the user the block holds unsaved text. (Note Cmd+K is also swallowed while the box has focus, so quick-open is not even a way out — see the hotkey finding.)
- **Suspected cause** — `draft` is component state with no blur/unmount commit (MermaidBlockView.tsx line 72; only Done, Cmd+Enter or the Show diagram toggle call onChangeCode). Every other edit surface in this app autosaves, so the block silently opts out of the doc's own save contract.

### [wrong] In a narrower window the block's own chrome paints outside its border: the visual toolbar overhangs by 47px and the code panes overflow the card

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → Flowchart block → Edit (visual). 2. Narrow the window to about 1000px with the Docs sidebar and the Outline panel open. 3. Then try the same with a code-mode block (Sequence → Edit) at about 900px.
- **Measured** — Visual editor at viewport 1000: block rect right edge = 650, but the toolbar's last control 'Auto-layout: On' spans x 645.4 → 697.1, i.e. 47.1px past the block's rounded border and out over the page gutter; the toolbar row's scrollWidth 370 > clientWidth 310 with no scroll affordance. Code mode: at viewport 900 the block is 236px wide while the textarea is 260px (block.scrollWidth > clientWidth = true); at 760 the block is 96px wide with a 260px textarea and a 235px preview spilling out of it. At 1440 and 1200 everything fits (overflowPx = -13, i.e. inside).
- **Suspected cause** — structural-toolbar is a `flex items-center gap-1` row with no wrap and no overflow handling (StructuralEditor.tsx line 921); the code pane pairs two `min-w-[260px] basis-[280px]` children (HighlightedTextarea.tsx line 62 and LivePreview) inside a `flex flex-wrap` that wraps but cannot shrink below 260px.

### [wrong] Exported SVG and PNG carry no background, so a dark-theme export is invisible when pasted anywhere light

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Settings -> dark theme (or boot with cerebro.themeMode = 'dark').
2. Docs -> Strategy -> Systems map, expand the sequence diagram.
3. Copy PNG, then paste into any white-background surface (Slack, a doc, Preview).
4. The message labels and arrows are near-white on nothing.
- **Measured** — Dark-theme Copy PNG: 1300x742, 73.4% of all pixels have alpha < 8 (fully transparent), and the lightest opaque pixel is rgb(223,255,255) = 1.06:1 contrast against a white page. Light-theme Copy PNG has the same transparent ground (corner pixel [0,0,0,0]). The copied SVG confirms it: no background rect anywhere (/<rect[^>]*(width="100%"|class="…background)/ does not match), while the text fill is #e0e4ec and the actor boxes #191d25. theme.ts sets a `background` themeVariable from --n-0 but mermaid never paints it into the svg, so nothing carries it.
- **Suspected cause** — src/mermaid/theme.ts passes `background` to mermaid, which does not emit a background rect; src/mermaid/export.ts rasterises onto a fresh, transparent canvas without filling --n-0 first.

### [wrong] The lightbox never fits the diagram and its zoom readout lies: a gantt opens at '100%' filling 17% of the viewer, still illegible

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Docs -> Strategy -> Systems map, scroll to the Rollout gantt.
2. Hover it and click Expand.
3. The chart sits in a 93px strip across the top of a 540px-tall viewer, the date labels are unreadable, and the control says 100%.
4. There is no Fit control — you have to guess that ~158% is life size.
- **Measured** — Lightbox viewport 912x540; gantt svg renders 910x93.5 from a viewBox of 1440x148, i.e. 0.632 of natural size while the readout says '100%'. Area used: 17.3% of the viewer. Smallest label font: 10px CSS x 0.632 = 6.32px on screen. The sequence diagram in the same lightbox is at 1.000 natural (650px, capped by its own inline max-width: [&_svg]:max-w-none never wins against mermaid's inline style), so the same readout means different things per diagram. Control: the SAME gantt in the full-screen dialog renders 1408px wide = 0.978 of natural with 10px labels at zoom 99%. Lightbox controls are exactly [Close, Zoom out, Reset zoom, Zoom in, Copy SVG, Copy PNG, Save PNG…] — no Fit.
- **Suspected cause** — MermaidLightbox applies `scale` on top of the svg's CSS layout width (width=100% inside a 910px canvas) rather than measuring intrinsic size, and has no initial-fit pass like CanvasViewport's.

### [wrong] An inline gantt is squeezed to 44-55% of natural size, making its date axis unreadable, with no scroll alternative

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Docs -> Strategy -> Systems map.
2. Look at the '## Rollout' gantt block in the page body — the axis dates under the bars are a grey smear.
- **Measured** — Gantt viewBox is 1440x148; inside the 638px doc column it renders 638x65.6 = 0.443 of natural (0.550 in a second run at 792px column width). Smallest text is 10px CSS, i.e. 4.43px (5.5px) of actual glyph height. Container overflow is 0 in both axes, so the shrink is unconditional — [&_svg]:max-w-full forces scale-down instead of letting the already-`overflow-auto` holder scroll at legible size. For contrast the sequence block in the same column renders at 0.982 and the ELK flowchart at 1.000.
- **Suspected cause** — MermaidDiagram's holder uses [&_svg]:max-w-full, which scales any diagram wider than the column instead of scrolling it; mermaid's gantt always emits a 1440-wide viewBox.

### [wrong] Lightbox wheel zoom is not cursor-anchored — the thing you point at runs away from the pointer

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Expand any diagram to the lightbox.
2. Put the pointer on a specific box and scroll up to zoom in.
3. That box slides down and to the right, out from under the cursor.
- **Measured** — With the cursor parked on the first actor rect at (790.0, 494.5), four wheel-up steps (100% -> 146%) moved that same rect's centre to (1033.7, 646.5) — 287.2px of drift inside a 912x540 viewport. Expected for a cursor-anchored zoom: ~0px. The canvas keeps transform-origin 0 0 and its top-left stayed pinned at x=265 through the zoom.
- **Suspected cause** — MermaidLightbox's wheel handler only multiplies `scale`; it never adjusts `offset` to keep the cursor point fixed (transformOrigin is '0 0').

### [wrong] Lightbox panning is unclamped: one drag can push the diagram completely off screen, leaving an empty grey box

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Expand any diagram to the lightbox.
2. Press and drag up-and-left across the viewer a couple of times.
3. The diagram leaves the viewport entirely; the viewer shows nothing and no scrollbar or edge hint says where it went. The only way back is the small '146%' button (accessible name 'Reset zoom').
- **Measured** — After one continuous drag the canvas rect sat at (-2135, -1633) against a viewport at (264, 166, 912x540): intersection area 0 px². No clamp, no rubber-band, no 'centre' control. The recovery affordance is labelled by its zoom percentage, not by anything that says 'bring the diagram back'.
- **Suspected cause** — MermaidLightbox's pointermove writes `offset` straight from the pointer delta with no bounds against the content rect.

### [wrong] The Expand-to-lightbox button cannot be reached by keyboard at all

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Docs -> Strategy -> Systems map.
2. Without touching the mouse, Tab through the page.
3. You can reach 'Open full screen', 'Save as file…' and 'Edit' on every block, but never the Expand button — the diagram viewer is mouse-only.
- **Measured** — With the pointer away, the Expand button exists in the DOM but getComputedStyle(btn).display === 'none' and btn.offsetParent === null (it is `hidden group-hover:block`), so it is not focusable despite tabIndex 0. Twelve consecutive Tab presses starting from a block's 'Open full screen' button visited: Save as file…, Edit, Open full screen, Save as file…, Edit, Open full screen, Save as file…, Edit, then Outline / Info / Links / Knowledge — 'Expand diagram' never once received focus.
- **Suspected cause** — MermaidDiagram renders the expand affordance as `hidden group-hover:block`, which removes it from the tab order instead of hiding it visually (e.g. opacity/focus-visible).

### [wrong] Below 100% zoom the node toolbar covers the node beneath it — at ≤47% that node's centre is unclickable, so shift-click multi-select on it silently does nothing

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline. Zoom out (wheel down ~10 ticks) to ~39%.
2. Click the top node (Capture). Its toolbar renders 6 screen px below it, at its true 34px height.
3. Look at the canvas: the "Distill" node has vanished — the toolbar is drawn over it.
4. Shift-click where Distill is, to add it to the selection. Nothing happens; no group bar appears.
- **Measured** — Overlap of the toolbar's box with the next node, by zoom: 100% → 0.0px (they exactly touch); 91% → 3.63px; 83% → 6.93px; 75% → 9.95px; 62% → 15.16px; 47% → 21.34px; 39% → 24.57px (Distill's whole height is 19.08px, so it is 100% covered). document.elementFromPoint at Distill's centre returns the mermaid-node-toolbar from 47% down ("NODE" at 62% and above). Shift-clicking Distill at 39% → mermaid-group-bar count 0 (expected 1). The toolbar is 153×34 screen px at every zoom while the node-to-node gap is 40 plane px, i.e. 40·scale screen px — so overlap starts the instant scale < 1.
- **Suspected cause** — A consequence of the M29.51 counter-scale: the toolbar is now a fixed 34px of SCREEN while the gap it is placed into shrinks with the zoom. StructuralEditor.tsx:514-517 only chooses above-vs-below by headroom against the host's top edge; it never asks whether the chosen side is occupied. Below ~50% a screen-sized toolbar simply does not fit between two nodes.

### [wrong] The link badge and the node toolbar detach from their node when the zoom changes after they were placed — at 400% the badge floats 20px up-left of the corner it is supposed to sit on

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline, click Capture, Node link → type https://example.com → "Link to URL". A badge appears on the node's top-right corner.
2. Click the node to select it (toolbar appears 6px under it).
3. Change nothing else — just wheel-zoom in to 400%.
4. The badge is now well away from the corner, hanging in space up and to the left; the toolbar has drifted away from the node.
5. Make any edit (e.g. press Direction LR). Everything snaps back into place — proof the placement is stale, not wrong.
- **Measured** — Badge centre relative to the node's top-right corner: (+1.0, +1.0) px at 100% → (−20.0, −20.0) px at 400% (28px diagonal drift; badge is 16×16 the whole time). After one code edit at 400% it returns to (+1.0, +1.0).
Node toolbar gap below its node: 6.0px at 100% → 24.0px at 400%. For a node whose toolbar flips ABOVE, the gap goes 0.0px at 100% → 46.17px at 236% (= 34·(2.358−1), exactly the baked-in 34px height).
The drift is 7·(s−s₀) for the badge and 34·(s−s₀) / 6·(s/s₀) for the toolbar, where s₀ is the scale in force when the anchor was computed.
- **Suspected cause** — StructuralEditor.tsx:514-517 and :647-651 subtract SCREEN-pixel constants (34, 6, 7) before dividing by the live scale, converting them into plane units at that instant — exactly what the M29.51 comment says it must do. But the result is stored in state (toolbarPos, badges) and only recomputed on a click (toolbar) or on a code change (badges). A wheel-zoom changes the scale without either, so the frozen plane offset is re-multiplied by the NEW scale. The counter-scale needs the constant applied at render time (e.g. via the useCanvasScale() the component already subscribes to) rather than baked into the stored coordinate.

### [wrong] Only a quarter of the visible canvas (a fifteenth at 39%) belongs to the editor: clicking, or dropping a connect drag, on the rest of the canvas silently does nothing

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline. Click a node — its toolbar appears.
2. Click on obviously empty canvas near the bottom-left of the viewport.
3. The selection does NOT clear; the toolbar stays up. (The same click 100px to the right of the diagram does clear it.)
4. Same for the edge editor: click an edge to open it, then click empty canvas on the left half — it stays open.
5. Drag from a node to empty canvas 40px below the diagram: no node is created (the same gesture 40px above the bottom of the diagram creates one).
- **Measured** — canvas-viewport is 1384×724 at (56,148) = 1,002,016 px². structural-host is 1360×334 at (685.66,343); visible intersection 754.34×334 = 251,951 px² = 25.14% of the canvas. At 39% zoom the host is 524.34×128.77 = 67,520 px² = 6.74%.
Selection clear, 5 probe points: only 1 of 5 cleared (the one inside the host box); toolbar count before/after = 1/1 for "left of the plane", "below the diagram", "bottom-right", "above the diagram".
Edge editor after a click outside the host: count 1 (expected 0).
Connect drop 40px below the host's bottom edge (elementFromPoint → canvas-viewport): file bytes unchanged, no "New step" minted — at both 100% and 39%.
- **Suspected cause** — The clear-selection onClick lives on StructuralEditor's own <div> and the connect-drop test is `host.contains(target)` (StructuralEditor.tsx:812). Both are bounded by the host element, which is only as big as mermaid's svg plus padding — a small, translated island inside a full-bleed viewport. M29.51's pointer-capture fix made the click REACH the editor; it did not make the editor cover the canvas. The viewport is the thing the user reads as "the canvas", so the background handler (and the drop test) belongs there.

### [wrong] A shift-click — or any click that follows a keystroke — paints Chrome's blue focus ring around the entire 1384×350 editor area

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline. Click a node (no ring — correct).
2. Hold Shift and click a second node to multi-select.
3. A 1px blue rectangle is now drawn around the whole editor region, spanning the canvas.
4. Same result via: press Delete (or any key), then plainly click a node.
5. It stays until focus moves elsewhere.
- **Measured** — document.activeElement after a plain click: div."relative px-3 py-2", :focus-visible false, computed outline "rgb(22, 26, 36) none 3px" (no ring). After a shift-click: same element, :focus-visible TRUE, computed outline "rgb(0, 95, 204) auto 1px", element rect 1384×350 at (673.66, 335). After Delete-then-click: identical. Visible in the screenshots as a full-width blue box over the canvas.
- **Suspected cause** — StructuralEditor's outer div carries tabIndex={-1} (needed so Delete/Backspace reach its onKeyDown) with no outline-none. Chromium's :focus-visible heuristic marks a focus as keyboard-initiated whenever the preceding interaction involved a key — which shift-click and delete-then-click both are — so the UA ring is painted on a 1384×350 container. `outline-none` on that div (the repo already does this on <main class="flex flex-1 outline-none">) removes it without touching the key handling.

### [wrong] Only 26.8% of the visible canvas clears a node selection, and Escape never does

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd.
2. Click the "Capture" node — the node toolbar appears.
3. Click empty canvas well below the diagram (e.g. near the bottom edge), or above it, or off to the left.
4. Press Escape. Click the same node again.
- **Measured** — StructuralEditor's clear-selection onClick lives on its own root div, whose box is (673.7,335)-(2057.7,685) while the viewport is (56,148)-(1440,872) — their intersection is 26.8% of the visible canvas at the default view. Point-by-point with real page.mouse.click: (1100,500) hit=DIV#structural-host → node toolbar 1→0 DESELECTED; (1100,780) hit=DIV#canvas-viewport → 1→1; (1100,250) hit=DIV#canvas-viewport → 1→1; (300,500) hit=DIV#canvas-viewport → 1→1. Escape after a node click → toolbar still 1. Re-clicking the same node → still 1. Two consecutive bare-canvas clicks → still 1. So on ~73% of the canvas a user sees, there is no way to dismiss the floating node toolbar at all. (After Fit the live region grows to 61.1%, so the dead zone moves with the zoom.)
- **Suspected cause** — StructuralEditor.tsx:891-905 attaches the clear handler to `<div className="relative px-3 py-2">`, which shrink-wraps the diagram. On the block host that div IS the surface; on the full-page canvas the surface is canvas-viewport, which has no such handler. The onKeyDown beside it handles Delete/Backspace but has no Escape case (and needs focus via tabIndex=-1).

### [wrong] Cmd+K and Cmd+J do nothing while the code panel's textarea has focus

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd, click "Show code".
2. Click into the Mermaid source textarea.
3. Press Cmd+K (quick open) — nothing happens. Press Cmd+J (assistant) — nothing happens.
4. Click the canvas and press Cmd+K — it opens.
- **Measured** — Quick-open input count after Cmd+K with focus in the code textarea = 0; the same key with focus on the canvas = 1 (same page, same run, control measured immediately after). Cmd+J from the textarea also produced 0 panels. Three earlier navigation probes failed outright at `locator.fill` on the quick-open input for exactly this reason (20s timeouts). Expected: modified keys reach the app's window-level handler; got every global shortcut swallowed because a synthetic stopPropagation also stops the native event.
- **Suspected cause** — CodeOverlay.tsx:116 `onKeyDown={(e) => e.stopPropagation()}` is unconditional; React's SyntheticEvent.stopPropagation also stops the native event, so App.tsx:218's `window.addEventListener('keydown', …)` (Cmd+K/J/Shift+N/[/]) never runs. The guard only needs to block the canvas's un-modified Delete/Backspace hotkeys.

### [wrong] Fit ignores the code panel — a quarter of a wide diagram lands underneath it

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd, click "Show code".
2. Replace the source with a wide LR chain, e.g. `flowchart LR` plus 14 `N0[Stage 0] --> N1[Stage 1]` edges.
3. Click "Fit diagram".
- **Measured** — After Fit (zoom 99%): svg rect x 72 → 1424 (1352px wide) inside viewport (56,148)-(1440,872); code panel rect (68,160)-(408,629.5). Overlap = 336.0px of the 1352px-wide diagram, i.e. 24.9% of what the user just asked to have fitted is invisible — Stages 0 through 3 are fully behind the panel. Expected: fit into the free area, or offset the centring by the panel's 340px. fitRef in CanvasViewport measures only viewport width/height and a 32px pad.
- **Suspected cause** — CanvasViewport.tsx:213-240 fits against `viewport.getBoundingClientRect()` with a fixed PAD of 32; it has no notion of the overlay CodeOverlay draws on top of the same box.

### [wrong] Clicking a record chip opens the detail panel over the canvas and leaves the drawing completely off-screen

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Create a whiteboard tab on Delivery schedule and add two records.
2. Click one of the record chips.
3. The record opens in the detail panel — and the canvas beside it is blank, including the node whose chip you just clicked.
- **Measured** — probe6 P6-A. Before the click: canvas-viewport 320..1440 (w=1120), nodes at x=880 and x=1108, 2/2 inside. After the panel opens: canvas-viewport w=560 (320..880) and 0/2 nodes intersect it; node screen positions are unchanged (drift dx=0, dy=0) and no re-fit runs. Chips stay glued (dx=4, dy=-11) — they are just as invisible. Closing the panel restores nothing on its own. Re-verified 20:35 on the current tree: occupancy {inside:0,total:2,vp w:560}.
Same screenshot shows the diagram toolbar wrapping onto two lines at that width with "Copy PNG" clipped and "Save PNG…" pushed out of the bar.
Screenshot: p6a-panel-open.png.
- **Suspected cause** — The panel takes half the width from the same flex row as the canvas; CanvasViewport only fits once (initialFit ResizeObserver disconnects after the first successful fit), so a width change never re-fits. Compounded by the record placement above, which puts the first node at the pre-panel viewport centre — i.e. exactly on the edge the panel cuts.

### [wrong] Escape does not close the record panel you just opened from a chip — the chip swallows the key

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Create a whiteboard tab, add a record, click its chip — the detail panel opens.
2. Press Escape. Nothing happens.
3. Press Tab (or click anywhere else) and press Escape again — now it closes.
- **Measured** — probe9 P9-A / probe7 P7-A. activeElement after the chip click = BUTTON[data-testid=whiteboard-record-chip]. Escape with that focus -> detail-panel count 1 (still open) — measured twice, in two separate runs. Controls in the same run: Tab, then Escape -> count 0; click empty canvas (activeElement becomes MAIN), then Escape -> count 0. So it is the focused chip, not the panel, that eats the key.
- **Suspected cause** — RecordChipOverlay.tsx:187 `onKeyDown={(e) => e.stopPropagation()}` on the chip button. It is there to keep keys off the structural editor, but the chip keeps DOM focus after its own click, so the app's Escape layer never sees the keystroke.

### [rough] In dark mode the selection ring is the same hue as the resting node border and its contrast against the node body halves, falling under the 3:1 non-text floor

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Settings -> Appearance -> Dark. 2. Cmd+K -> "Pipeline". 3. Click the "Capture" node. 4. Compare it to the three unselected nodes — only the border thickness differs, and the ring reads as part of the node rather than on top of it.
- **Measured** — Selected node shape: stroke rgb(61,91,222), stroke-width 2.5px. The other three nodes: stroke rgb(61,91,222), stroke-width 1px — identical colour, so the ONLY selection cue is 1.5px of extra width. Contrast of the ring against the surface it is drawn on: light theme #3d5bde on #eef1fe = 4.97:1; dark theme #3d5bde on #1b2547 = 2.67:1, i.e. a 46% drop and below the 3:1 WCAG non-text floor the repo's own colors.css cites (line 9-13 explicitly darkened --n-400 for exactly this reason). Against the canvas ground: 5.42:1 light vs 3.01:1 dark — clearing 3:1 by 0.01. For contrast, the same measurement on healthy dark pairs: node label rgb(224,228,236) on rgb(27,37,71) = 11.75:1, edge stroke rgb(110,118,136) on rgb(25,29,37) = 3.71:1. Expected: a selection cue that does not depend on the viewer resolving a 2.67:1 edge — a lighter ring step in dark (--cortex-300/400) or a second channel such as an offset halo.
- **Suspected cause** — StructuralEditor.tsx:850 hard-codes `shapeEl.style.stroke = 'var(--cortex-500)'`, and theme.ts:19 uses the SAME token (--cortex-500) as mermaid's `nodeBorder`. The dark palette deliberately leaves --cortex-500 unchanged (colors.css:210-212 documents keeping it for filled accent buttons) while --cortex-50 goes from #eef1fe to #1b2547, so the ring's ground moves under it and the ring does not.

### [rough] The diagram toolbar and zoom cluster wear two different focus rings across adjacent controls — eight use the app ring, seven fall back to the browser default

- **Surface** — Dark mode, narrow viewports (1024x700 / 800x600), and keyboa
- **Repro** — 1. Cmd+K -> "Pipeline". 2. Tab from the top of the page into the toolbar. 3. Watch the ring change shape as you cross from "Layout engine" to "Copy SVG", and again inside the zoom cluster as you cross from "Zoom out" to the "100%" readout.
- **Measured** — Measured on real Tab focus (not programmatic .focus(), which produces no :focus-visible). App ring — outline: none, box-shadow rgba(61,91,222,0.25) 0 0 0 3px in light / rgba(101,128,236,0.45) 0 0 0 3px in dark: Copy SVG, Copy PNG, Save PNG…, Zoom out, Zoom in, Fit diagram. UA default ring — box-shadow: none, outline `auto 1px rgb(0,95,204)` in light / `auto 1px rgb(153,200,255)` in dark: Add node, + Shape, Direction TD, Direction LR, Direction BT, Direction RL, Layout engine, Show code, and the "Reset zoom" percentage readout (which sits between two IconButtons that DO get the app ring). Both are visible in both themes — :root carries color-scheme: dark so the UA ring adapts — so this is consistency, not legibility. Expected: one ring vocabulary across the 15 controls of one toolbar strip.
- **Suspected cause** — The TEXT_BTN class in DiagramToolbar.tsx:23-24 (`rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50`) declares no focus-visible ring, and neither does the zoom readout button in CanvasViewport.tsx:385. The DS `Button`/`IconButton` components carry `--ring`; these hand-rolled ones do not.

### [rough] Clicking a rendered diagram — just to look at it — throws the Ask AI / formatting toolbar over the paragraph above it

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map, no edit mode. 2. Single-click anywhere on the first diagram, the way you would click a picture.
- **Measured** — The block gains a ProseMirror NodeSelection (blue ring around the whole card) and the selection toolbar mounts at rect x=412 y=203 w=196.4 h=36 — entirely inside the intro paragraph's rect (x=412 y=201 w=664 h=48), covering the first ~196px of its first line and the top of the second. Same rects whether the block is in view mode or in visual edit mode. Nothing dismisses it except clicking elsewhere, and while it is up a stray Backspace destroys the block (see the first finding).
- **Suspected cause** — A void block taking a NodeSelection is normal BlockNote, but the AI/formatting toolbar has nothing to offer for a diagram, and its 'above the selection' placement lands it on the previous block's text.

### [rough] Double-clicking a diagram does nothing — the only way into the editor is the small 'Edit' text link in the header

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map. 2. Double-click the first diagram (the universal gesture for 'let me edit this').
- **Measured** — After dblclick the block is unchanged: no structural-host, no textarea, buttons still ['Open full screen', 'Save as file…', 'Edit']. Repeated double-clicks do nothing either. For comparison the standalone .mmd file page opens straight into an editor, so the doc block is the odd one out.
- **Suspected cause** — No dblclick handler on the view-mode host in MermaidBlockView.tsx (only onExpand and onErrorClick are wired).

### [rough] App hotkeys are dead while the block's source box has focus — Cmd+K cannot open quick-open

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → Sequence block → Edit. 2. Click into the source box. 3. Press Cmd+K.
- **Measured** — quick-open-input element count = 0 (nothing opens). Control in the same run: press Escape, click a paragraph, press Cmd+K → count = 1. Every key is affected, not just editing keys.
- **Suspected cause** — MermaidBlockView.tsx line 228 calls `e.stopPropagation()` on EVERY keydown in the textarea to keep BlockNote hotkeys quiet; that also kills app-level shortcuts. It should stop only the keys BlockNote would claim, or stop them at the block boundary rather than at document level.

### [rough] Double-clicking 'Save as file…' silently writes two identical .mmd files

- **Surface** — Mermaid blocks inside a document
- **Repro** — 1. Systems map → Gantt block. 2. Double-click 'Save as file…' (or click it twice, as you would if the first click seemed not to register).
- **Measured** — diagrams/ goes from ['pipeline.mmd'] to ['pipeline.mmd', 'gantt.mmd', 'gantt-2.mmd'] with byte-identical contents, two toasts ('Saved to diagrams/gantt.mmd', 'Saved to diagrams/gantt-2.mmd'), and the Inbox badge climbs 11 → 13. There is no content-level dedupe and the button is not disabled while the write is in flight.
- **Suspected cause** — saveAsFile (MermaidBlockView.tsx line 33) is fire-and-forget with no in-flight guard; the backend's -2 dedupe is by path, not by content.

### [rough] Export refuses while a perfectly good diagram is on screen, if the source being edited is broken

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Open a doc block with a pie chart, click 'Open full screen'.
2. In the code overlay, type a syntax error at the end (the canvas keeps showing the last good render, as designed).
3. Click 'Copy SVG'.
4. Toast: 'Copy SVG failed'. Nothing is copied — even though a valid diagram is visibly on the canvas.
- **Measured** — State at the moment of the click: fullscreen-readonly-diagram still contained an svg with aria-roledescription='pie', and the error banner read 'Line 3: Parsing failed: Lexer error on line 3, column 3: unexpected character…'. Clipboard was pre-seeded with 'SENTINEL'; after Copy SVG the clipboard still read 'SENTINEL' and toast-host read 'Copy SVG failed'. Expected: export the picture the user can see (the toolbar has a last-good svg in view), or say why.
- **Suspected cause** — DiagramToolbar's `act` calls renderMermaid(code) fresh at click time and throws on !r.ok, ignoring the last-good svg that FullScreenDiagramEditor is still displaying.

### [rough] Exports name a bundled webfont they do not embed, so every exported diagram is set in a different typeface than the app shows

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Put a sequence diagram with a long participant name in a doc block.
2. Expand it, click Copy PNG, and paste the result next to a screenshot of the app.
3. The letterforms differ — the export falls back to the system sans, because 'Instrument Sans' is a bundled .ttf that neither the rasteriser nor any external SVG consumer can load.
- **Measured** — Copied SVG: font-family is "'Instrument Sans',-apple-system,'Segoe UI',sans-serif" and @font-face is absent (0 occurrences in 25337 chars). document.fonts.check("16px 'Instrument Sans'") === true in the app, so the two really differ: the string 'Authorization Microservice' measures 197.58px in Instrument Sans vs 187.63px in the fallback stack — 5.3% narrower in every export, i.e. mermaid's box geometry was computed against metrics the PNG never uses. Visibly confirmed by comparing font-app-render.png with font-exported.png. Also worth noting from the same string: the exported <svg> carries width="100%" and NO height attribute, which many consumers scale badly.
- **Suspected cause** — src/mermaid/export.ts copies/rasterises mermaid's svg as-is; the <img> rasterisation path runs in secure static mode where the app's @font-face is unavailable, and no @font-face/data: URI is injected into the exported markup.

### [rough] Text size is inconsistent across diagram types — the theme's 13px is only honoured by some of them

- **Surface** — Non-flowchart diagram types (sequence, gantt, class, state, 
- **Repro** — 1. Docs -> Strategy -> Systems map.
2. Compare the label size in the flowchart, the sequence diagram and the gantt in the same column: three different text sizes for the same document.
- **Measured** — Computed font-size of the smallest text run per block, all in the same 638px column: flowchart 13px (the value theme.ts sets), sequence 16px, gantt 10px. theme.ts passes fontSize: '13px' but mermaid's per-diagram variables (actorFontSize, messageFontSize, ganttFontSize…) are not set, so only some renderers obey it.
- **Suspected cause** — src/mermaid/buildThemeVariables sets only the generic `fontSize`; mermaid's sequence/gantt renderers read their own font-size config keys.

### [rough] The manual-mode connect handle does not counter-scale: it is a 3.9px dot at 39% and a 23.6px blob at 236%

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline, Layout menu → Auto-layout (turn it off).
2. Zoom out to ~39% and hover a node — the connect dot appears on its right border.
3. Try to grab it: it is under 4px across, and half of it lies over the node, where a press starts a MOVE instead of a connect.
4. Zoom to 236% and hover: the same dot is now nearly as tall as a toolbar button.
- **Measured** — `.cerebro-connect-handle` screen size: 10.00×10.00 px at 100%, 23.58×23.58 px at 236%, 3.86×3.86 px at 39% — it is an SVG circle with r=5 in PLANE units, so it scales with the diagram while every other piece of chrome (toolbar 153×34, badge 16×16) now stays screen-sized. A pixel-perfect press at its centre does connect at 39% (verified: `A --> D` written), so this is reach, not function.
- **Suspected cause** — StructuralEditor.tsx:553-558 creates the handle as an SVG <circle r=5> inside mermaid's transformed node group, so it is the one interactive affordance M29.51 did not reach. It needs r divided by the live canvas scale (the same 1/scale the DOM overlays use), refreshed on zoom.

### [rough] Escape does not cancel an in-flight connect drag — releasing after Escape still mints an unwanted node and edge

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline. Press on a node and drag out toward empty canvas (the dashed ghost line follows).
2. Change your mind and press Escape while still holding the button. The ghost line stays.
3. Release. A "New step" node and an edge to it are written to the file.
- **Measured** — Ghost <line> count during the drag after Escape: 1 (unchanged). File before: `…C --> D[Publish]\n`; after release: `…C --> D[Publish]\n\n  n1[New step]\n  A --> n1` — an edit the user cancelled. Expected: Escape clears dragFrom/ghost and the pointerup becomes a no-op.
- **Suspected cause** — The window pointermove/pointerup pair registered in StructuralEditor.tsx:701-829 has no keydown counterpart; nothing in the component watches for Escape while dragFrom.current or moveGesture.current is live. Every other surface here (rename box, subgraph toolbar, popovers) honours Escape, so the gesture is the odd one out.

### [rough] The node rename box and the group bar's title box swallow the app's global shortcuts — ⌘K does nothing while either is focused

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline. Double-click a node to rename it.
2. Press ⌘K to jump somewhere else. Nothing happens.
3. Same with the group bar's "New subgraph title" box.
4. For contrast, the link popover's target box (also a text input in this editor) passes ⌘K through fine, as does the canvas itself.
- **Measured** — quick-open-input count after ⌘K: 1 from the canvas (control), 1 from the link popover's box, 0 from the node rename box, 0 from the group bar's title box. App.tsx:219 binds ⌘K on `window` and deliberately gates only ⌘[ / ⌘] on "am I typing", so the block is unintended.
- **Suspected cause** — Both boxes call e.stopPropagation() unconditionally in onKeyDown (StructuralEditor.tsx:1245, GroupBar.tsx:66/77) to keep Backspace away from the editor's delete handler. React's synthetic stopPropagation also stops the NATIVE event at the React root, so window-level listeners never see it. The link popover escapes this only because Popover portals outside the React root container. Narrowing the guard to the keys that actually leak (Backspace/Delete/Escape/Enter) restores the shortcuts.

### [rough] Adding a node or an edge appends past the end of the file without a trailing newline (and inserts a blank line first)

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline (the file on disk ends with a newline).
2. Select a node and press the toolbar's "Add connected node" — or drag from a node onto empty canvas.
3. Inspect the saved bytes: a blank line has been inserted and the file no longer ends in a newline. Every later edit inherits the missing newline.
- **Measured** — Before: `---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Capture] --> B[Distill]\n  B --> C[Verify]\n  C --> D[Publish]\n` (endsWith('\n') === true).
After one "Add connected node": `…  C --> D[Publish]\n\n  n1[New step]\n  A --> n1` (endsWith('\n') === false). Same for a connect-drag onto empty canvas and for a plain node→node connect (`\n\n  A --> D`). A rename alone preserves the trailing newline, so it is the append path.
- **Suspected cause** — The append in ops.ts (addNode/addEdge) joins onto the line array without re-terminating the final line — the parse/serialize round-trip drops the terminator the source had. In a files-first app with git in the status bar this shows up as a "\ No newline at end of file" diff on every diagram the user touches.

### [rough] Switching the layout engine from ELK to Dagre leaves an empty `config:` mapping in the frontmatter

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline (frontmatter is `---\nconfig:\n  layout: elk\n---`).
2. Toolbar → Layout: ELK → pick Dagre.
3. The header is now `---\nconfig:\n---` — a config key with nothing under it.
- **Measured** — Before: `---\nconfig:\n  layout: elk\n---\nflowchart TD…` (44 bytes of header). After: `---\nconfig:\n---\nflowchart TD…`. The diagram still renders, so this is bytes-only — but the correct result is either no frontmatter at all or `config:` removed along with its last child.
- **Suspected cause** — setLayoutEngine (ops.ts) deletes the `layout:` line but does not collapse a `config:` mapping that has become empty, nor the `---` fences that then wrap nothing.

### [rough] The selection outline is drawn in plane units, so it is a sub-pixel hairline at 39% and twice its intended weight at 236%

- **Surface** — Structural editor gestures on a zoomed, panned canvas
- **Repro** — 1. Open Pipeline, zoom out to ~39%, click a node. The "selected" ring is barely distinguishable from the node's ordinary border.
2. Zoom to 236% and click a node: the ring is now visibly heavier than the design weight, and at 400% it reads as a thick slab.
- **Measured** — Computed strokeWidth stays "2.5px" (plane units) at every zoom; multiplied by the element's screen CTM that is 2.50px at 100%, 5.89px at 236%, 0.96px at 39% — i.e. thinner than the node's own 1px border at low zoom. Every other selection affordance (toolbar, badges) is now screen-sized, so the ring is inconsistent with them.
- **Suspected cause** — The selection-sync effect (StructuralEditor.tsx:836-858) writes shapeEl.style.strokeWidth = '2.5px' onto SVG shapes inside the scaled plane. Dividing by the live canvas scale — or using vector-effect: non-scaling-stroke, which the SVG spec provides exactly for this — keeps it 2.5px everywhere.

### [rough] The diagram toolbar overflows its own row and drops a button at narrow window widths

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd.
2. Narrow the window to ~760px wide, then to ~620px.
3. Look at the toolbar row and the right-hand export buttons.
- **Measured** — At 760px viewport: toolbar row height 40px, but `+ Node`, `+ Shape`, `Layout: ELK` and `Show code` measure 46px tall each — their labels wrap to two lines and the buttons spill 6px below the row's bottom border into the canvas. At 620px: toolbar scrollWidth 656 vs clientWidth 564, and "Save PNG…" has right edge past the row's right edge — the row has no overflow handling, so the button is simply unreachable. Expected: labels that do not wrap in an h-10 row, and no control falling off the end. Screenshot 62-toolbar-620.png also shows the diagram entirely off-screen after the resize, since nothing re-fits on a viewport change (initialFit fires once).
- **Suspected cause** — DiagramToolbar.tsx:111 is `flex h-10 flex-none items-center gap-1` with no `whitespace-nowrap`, no `min-w-0`/`shrink-0` discipline and no overflow strategy.

### [rough] "Reset zoom" also teleports the diagram into the viewport's top-left corner

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd — it opens centred at 100%.
2. Zoom in a few times, pan somewhere.
3. Click the "100%" chip in the zoom cluster.
- **Measured** — Initial (fitted) view: transform translate(617.656px, 187px) scale(1), svg rect (685.7,343) 124.7×334, centred in viewport (56,148)-(1440,872) — svg centre 748,510 vs viewport centre 748,510. After clicking Reset: transform translate(0px, 0px) scale(1) and the svg jumps to (68,156), i.e. jammed against the top-left corner, 680px left and 187px above where it was. Expected of a percentage chip: restore 100% zoom about the current view centre (what Lucidchart/Figma do), not reset the pan as well.
- **Suspected cause** — CanvasViewport.tsx:386 `onClick={() => setT({ scale: 1, offset: { x: 0, y: 0 } })}` throws the pan away with the zoom.

### [rough] An empty .mmd shows mermaid's raw internal error string as the user-facing banner

- **Surface** — The .mmd diagram page
- **Repro** — 1. Open diagrams/pipeline.mmd, click "Show code".
2. Select all in the source textarea and delete it.
3. Read the red banner over the canvas.
- **Measured** — File on disk becomes "" (0 bytes) and the banner reads verbatim: "No diagram type detected matching given configuration for text: " — trailing colon with nothing after it, because the text it is quoting is empty. The header type label shows "MERMAID", the toolbar loses every structural button, and the save chip reads "Saved". Expected: a human empty state (the textarea already carries the placeholder `graph TD / A[Idea] --> B[Shipped]`), not a library diagnostic. Typing a fresh diagram does recover the page.
- **Suspected cause** — FullScreenDiagramEditor.tsx:169-177 renders `view.error.message.split('\n')[0]` straight from renderMermaid with no empty-source special case.

### [rough] Deleting a whiteboard view orphans its .mmd, and re-creating a view with the same name mints a second file

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Create a whiteboard tab named "Zoomy", add a couple of records.
2. Click the active tab > Delete view > Delete view.
3. Create a new whiteboard tab, name it "Zoomy" again.
4. Look in delivery/whiteboards/ (sidebar: Delivery > Whiteboards).
- **Measured** — probe6 P6-B / probe2 P2-A. After deleting the view: the YAML has no whiteboard pointer and no view named "Doomed", but `delivery/whiteboards/doomed.mmd` (40 bytes) is still on disk. After delete + re-create with the same name: files = ["delivery/whiteboards/zoomy-2.mmd", "delivery/whiteboards/zoomy.mmd"], the tab points at zoomy-2.mmd, and the orphan zoomy.mmd still contains the two record nodes the user drew. Each delete/create cycle adds another file. The confirm dialog reads: "This removes the tab and everything it holds — its whiteboard layout, filters, sort, grouping and column arrangement." — the whiteboard layout is the one thing it does NOT remove.
- **Suspected cause** — onDelete drops the view from the YAML only; nothing reclaims or re-adopts the .mmd, and writeTextFile's stem dedupe then avoids the orphan's name. Keeping the file is defensible, but either the dialog copy or the create path should acknowledge it (the orphan is at least still browsable in the sidebar's Whiteboards folder).

### [rough] Record chips repeat the node's own label, cover the node's bottom edge, overhang it, and can't be grabbed to move the node

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Create a whiteboard tab, add five records, click "Fit diagram".
2. Compare each chip with the node it belongs to and with the node next door.
3. Try to move a node by dragging its chip.
- **Measured** — probe6/probe7. Every chip repeats its node's label verbatim (node text and chip text identical for all 5). Chip overlaps its own node by 174x11 px — 22 % of a 50 px node's height. Chip widths exceed node widths by 30/37/32/39/37 px (maxWidth = nodeW + 80), which after Fit puts the "Detect write conflicts" chip 2x2 px over the neighbouring node and leaves the last chip clipped 19 px by the viewport's right edge. Dragging by the chip (press at chip centre, move -200,-150, release): node unchanged at 1045,549 before and after, no `%% cerebro:pos` written, and no detail panel opened — the gesture is simply swallowed.
- **Suspected cause** — RecordChipOverlay pins the chip at rect.x+4 / rect.y+rect.h-10 with maxWidth = rect.w·scale + 80 and pointer-events-auto; the chip is a button, so a press on it never reaches the node's pointerdown handler.

### [rough] The Add-record picker has no keyboard navigation and never shows which offer Enter will take

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Create a whiteboard tab, click "Add record".
2. Type a few letters, press ArrowDown a few times, then Enter.
- **Measured** — probe2 P2-C. With an empty query the list shows 25 options (MAX_OFFERED). After ArrowDown, document.activeElement is still the INPUT and every option's computed background-color is rgba(0, 0, 0, 0) — no roving focus, no highlighted row, no aria-activedescendant. Enter does place the top scorer (typing "LNC" then Enter wrote `n1[Campaign brief]` + `click n1 "projects/field-app-launch-campaign/items/lnc-1.md"`), but nothing on screen says that Campaign brief was the one selected. ⌘K, whose scorer this reuses, does highlight its rows.
- **Suspected cause** — AddRecordPopover renders plain buttons and handles only Enter on the input (WhiteboardView.tsx:466-476); there is no selected-index state.

### [rough] There is no undo on the whiteboard canvas — Cmd+Z after placing a record does nothing

- **Surface** — The whiteboard view (tenth view kind) on the "Delivery sched
- **Repro** — 1. Create a whiteboard tab and place a record you did not mean to place.
2. Click the canvas and press Cmd+Z.
- **Measured** — probe8 P8-C. File before and after Cmd+Z byte-identical (`flowchart TD / %% cerebro:layout manual / n1[Rack layout sign-off] / click n1 "projects/phoenix-warehouse-rollout/items/ops-1.md"`); node count on screen still 1. The only way back is selecting the node and deleting it, or hand-editing in the code overlay (where the textarea's native undo does work).
- **Suspected cause** — No history stack behind onChangeCode; the "one undo step" the ops are careful to produce has no consumer on this surface.


## Refuted — do not fix these without re-measuring first

### [broken] Backspace or Delete with a diagram node selected in the block's visual editor deletes the ENTIRE mermaid block from the document

- **Surface** — Mermaid blocks inside a document
- **Verifier confidence** — high
- **Repro** — 1. Docs → Strategy → Systems map. 2. On the first (Flowchart) block press Edit — it opens the visual editor. 3. Click the 'Idea' node; the node toolbar appears, so the node is selected. 4. Press Backspace (or Delete) to delete that node.
- **Measured** — Before: 4 mermaid-block elements, 4 ```mermaid fences on disk. After one Backspace: 3 blocks, 3 fences — the whole flowchart fence is gone from strategy/systems-map.md (verified in window.__cerebroMockFs). Identical with Delete (4→3, fences 4→3). The mouse path is correct by contrast: the node toolbar's trash button leaves the block alone and removes only the node (fence becomes 'flowchart TD\n  Build[Build]\n  Build --> Review{Review}…', i.e. Idea gone). Cmd+Z restores the block (back to 4/4), so it is recoverable — but the user's gesture means 'delete this node' and the result is 'delete the diagram'. Re-verified after the concurrent M29.52 edits: still 4→3.
- **Re-measured by the verifier** — Tree: /Users/joseflagorio/Development/cerebro/.claude/worktrees/m29-mermaid, HEAD 390fa04 (M29.52) — one commit PAST the reporter's f88c292; that commit touched MermaidBlockView.tsx by 4 lines (useLegibleWidth in LivePreview) and nothing in src/editor/, so it does not bear on this claim. Chromium 1440x900, dev server :5430, trusted page.mouse gestures only. Probes: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-10/probe.spec.ts and probe2.spec.ts.

REPRODUCED (claim): click at (744, 518.7), the centre of diagram 1's svg (rect 689.7,296,108.6x445.3). .ProseMirror-selectednode count 0 -> 1, rect 412,249,664x508.3, outline "rgb(22,26,36) none 3px". Toolbar mounts position:absolute z-index:40 at x=412 y=203 w=196.4 h=36 — reporter said x=412 y=203 w=196.4 h=36, identical to the decimal. Intro paragraph 412,204,664x42 (reporter: 412,201,664x48). Overlap 196.4 x 35 = 6874 px². elementFromPoint at the toolbar centre returns the toolbar's own <svg> icon, so it paints on top. Screenshot 02-after-click-svg.png: "How the demo product's piece..." and "default layout; the last one uses" are hidden behind a white bar. Same result clicking the card header (x=cardRight-300, y=cardTop+12) and the card's left padding — not gesture-specific.

CONTROL THAT REFUTES IT: drag-select (mouse.down -> move 300px in 12 steps -> up) across the intro paragraph's second line. Toolbar x=412 y=181 w=675.8 h=36, 16 buttons [Ask AI, Improve writing, Make it shorter, More AI actions, Paragraph, Bold, Italic, Underline, Strike, Align left/center/right, Colors, Nest, Unnest, Create link]. Overlap with the H1 above = 664 x 17 = 11288 px²; overlap with its own paragraph = 664 x 13 = 8632 px². Same rule (bar sits ~8-10px above the selection rect), same z=40, 64% MORE prose obscured than the diagram case.

CLAIM DETAILS THAT FAILED: Escape -> selection-ask-ai count 1 -> 0 (report: "Nothing dismisses it except clicking elsewhere"). Re-click -> 1. Node-selection bar = 4 buttons vs 16 for text. Clicking Ask AI opens data-testid="ask-ai" at 412,765 w=420 h=90 (below the block, over no prose) with skill chips /create-an-agent, /risk-sweep, /weekly-review; fences on the mock disk 4 before and 4 after. Wheel-scroll 200px with the node selected leaves the bar at 412,203,196.4x36 (does not track), the only unflattering number I found and not what was filed. Caret click into a paragraph -> selection-ask-ai count 0, so the bar is not simply always up.

SIDE MEASUREMENT (the reporter's "first finding", not adjudicated here): with the node selection up, one Backspace took mermaid-block count 4 -> 3 and ```mermaid fences in window.__cerebroMockFs['strategy/systems-map.md'] 4 -> 3.
- **Suspected cause** — Clicking inside the structural host leaves document.activeElement as the ProseMirror root (measured: 'DIV.tiptap placeholder-selector-…', and a keydown listener shows the Escape/Backspace event target is that div with insideBlock=false) and puts a ProseMirror NodeSelection on the whole block (.ProseMirror-selectednode wraps the mermaid-block). StructuralEditor's own Delete/Backspace handler (StructuralEditor.tsx ~line 906, `apply(deleteNode(model, validSelected))`) is on an element the event never reaches, so PM's node-selection delete wins. The visual pane needs to take focus (its root already has tabIndex={-1}) or stop the key at the block boundary.
- **Verifier's reasoning** — The geometry reproduces bit-for-bit, but it is not a mermaid defect — it is this editor's universal, pre-M29 floating-toolbar placement, and the diagram case is the MILDER instance of it. My control: a plain drag-select of text in the very same paragraph raises the SAME bar (`AiFormattingToolbar`, M18, src/editor/SelectionToolbar.tsx, mounted unconditionally in MarkdownEditor.tsx:732 for any non-readOnly doc) at x=412 y=181 w=675.8 h=36 — which slices horizontally through the H1 "Systems map" (rect 412,135,664x63), overlapping it by 664x17 = 11288 px², AND covers 664x13 = 8632 px² of its own paragraph's first line. Screenshot 10-textsel-toolbar.png shows the title cut in half. The diagram click produces the same rule applied to a taller selection rect and overlaps only 196.4x35 = 6874 px² — 39% LESS obscured text than the shipped, intended text-selection behaviour nobody is filing. The reporter's stated mechanism ("its 'above the selection' placement lands it on the previous block's text") is therefore true of every selection in every Cerebro doc, mermaid or not; nothing in src/mermaid/ or src/editor/blocks.tsx positions this bar. The NodeSelection itself the reporter already concedes is normal BlockNote (a `content: 'none'` spec + `contentEditable={false}` host = a ProseMirror atom; clicking an image in Notion does the same). Two of the report's three distinguishing details are false under measurement: (1) "Nothing dismisses it except clicking elsewhere" — Escape clears it outright, selection-ask-ai count 1 -> 0, and re-clicking brings it back 0 -> 1; (2) "the toolbar has nothing to offer" — Ask AI is live and its rewrite popover mounts at 412,765 w=420 h=90, BELOW the block, overlapping no prose, and opening it left the file at 4 fences. What is genuinely diagram-specific is only that the bar carries 4 buttons instead of 16 and arrives on a bare click rather than a drag — a nit, not the "toolbar thrown over your prose" the title describes, and strictly less obscuring than the behaviour that ships for text. I read MermaidBlockView.tsx, blocks.tsx, SelectionToolbar.tsx and MarkdownEditor.tsx 590-760 in full; no code in the M29 wave chose this placement.

### [broken] One Escape closes Quick Open AND the full-screen dialog underneath it

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, click "Open full screen" on the first mermaid block.
2. Press Cmd+K (quick open appears over the dialog).
3. Change your mind and press Escape once.
4. Quick open closes — and so does the full-screen diagram editor.
- **Measured** — 3/3 runs: before Escape `.cb-dlg-scrim` count = 2, fullscreen-diagram-editor = 1; after ONE Escape quick-open-input = 0, scrims = 0, fullscreen-diagram-editor = 0. Expected: scrims 2 -> 1, editor still 1. Contrast measured in the same test: dismissing quick open with the MOUSE (its Close X) leaves scrims = 1, editor = 1 — so it is specifically the keystroke that takes two layers. This is the exact class of defect layers.ts was built to prevent ("one keystroke closes one thing").
- **Re-measured by the verifier** — At HEAD 390fa04, host rect x=425 w=638 for all four blocks (identical to the reporter's host, so same layout under measurement). READ MODE, gap left vs gap right measured from the host content box: block 0 (flowchart TD) svg x=689.7 w=108.6 -> gapLeft 264.7, gapRight 264.7 (reporter: x=425, gapLeft 0, gapRight 529.4). Block 1 (sequence) svg x=425 w=638 -> 0 / 0. Block 2 (gantt) svg x=425 w=792, min-width:792px, host scrollWidth 792 vs clientWidth 638 -> 0 / -154, i.e. deliberate bounded overflow. Block 3 (ELK) svg x=487.4 w=513.1 -> gapLeft 62.4, gapRight 62.4 (reporter: x=425, gapLeft 0, gapRight 124.9). Numbers identical on a second pass 1.5s later. VISUAL EDIT MODE (real click on the block's Edit button, no synthesised events): host structural-host x=425 w=638, class "select-none [&_svg]:h-auto [&>svg]:mx-auto [&_svg]:max-w-full", svg x=689.7 w=108.6 -> gapLeft 264.7, gapRight 264.7. CODE MODE side preview: host x=757 w=306, svg x=855.7 w=108.6 -> gapLeft 98.7, gapRight 98.7. Computed styles on block 0's svg: display block, marginLeft 264.688px, marginRight 264.688px, max-width 108.625px, isDirectChild true; host textAlign start, display block. Document overflow: documentElement scrollWidth 1440 vs clientWidth 1440, body 1440 vs 1440 — the gantt's 792px stays inside its own overflow-x:auto sink. Expected for a centred diagram: gapLeft == gapRight; observed equality to within 0.02px on every block.
- **Suspected cause** — src/app/QuickOpen.tsx:248 — the Input's React `onKeyDown` calls `close()` on Escape without `stopPropagation`/`preventDefault`. React flushes that discrete-event state update synchronously, so QuickOpen's Dialog unmounts and pops its layer BEFORE the same native keydown reaches the document-level bubble listeners; by then `ownsEscape(layerId)` in src/components/ui/Dialog.tsx:121 answers true for the full-screen dialog, which closes too. QuickOpen's Dialog already has a correct Escape handler — the inline one is redundant and is what breaks precedence.
- **Verifier's reasoning** — STALE, NOT WRONG. The claim was accurate at the commit the reporter measured (f88c292) and is already fixed at the worktree tip. The task brief said HEAD is f88c292; the tree has actually advanced one commit to 390fa04 "feat(mermaid): a whiteboard you can arrange on, and an undo for when you don't like it (M29.52)".

Source check: `git show f88c292:src/mermaid/MermaidDiagram.tsx` confirms the reporter's diagnosis exactly — the sink div read `className="overflow-auto [&_svg]:h-auto [&_svg]:max-w-full"`, with no centering, so a 108.6px svg was left-flush in a 638px column. `git log -S'mx-auto' -- src/mermaid/MermaidDiagram.tsx` returns exactly one commit: 390fa04, which changes that line to `className="overflow-auto [&>svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"`. Its commit message names this defect with the reporter's own numbers: "A 109px diagram sat against the left edge of a 638px column with 529px of dead space beside it, which reads as a layout bug rather than as a small diagram... Diagrams centre now". I did not take the commit message's word for it and measured independently.

Live measurement at 390fa04 (my own probe, my own dev server on :5425, real Chromium 1440x900, light theme, autoLearn off): every diagram is symmetrically centred, to within a tenth of a pixel, on all three surfaces the claim covers — read mode, visual edit mode (structural-host carries the same class), and the code-mode side preview. The host geometry I measured (x=425, w=638) is identical to the reporter's, so we were looking at the same layout; only the svg position differs. Numbers stable across two passes 1.5s apart, so this is not a mid-render or mid-transition read. Screenshots of the full page, block 0 and block 3 confirm it visually: the flowchart sits in the middle of its card.

The svg is a direct child of the sink (isDirectChild: true) and Tailwind preflight gives it display:block, so `mx-auto` resolves to real auto margins (computed marginLeft 264.688px / marginRight 264.688px on a fresh layout pass) rather than being inert on an inline element — which is the one way this fix could have looked applied but not worked.

Adjacent check, so I am not certifying a fix that merely relocated the problem: the same commit added `useLegibleWidth`, which now puts `min-width: 792px` on the gantt so it overflows its 638px sink instead of shrinking its 10px labels to 3.99px. That is deliberate and documented in src/mermaid/legibleWidth.ts (MIN_SCALE 0.55, MAX_OVERFLOW 1.6; 1440 x 0.55 = 792), and it is contained: the overflow stays inside the sink's own `overflow-x: auto`, and document.documentElement.scrollWidth is 1440 against clientWidth 1440, so the document did not become a horizontal scroller.

Coverage: read mode all 4 blocks, visual edit mode on block 0, code-mode preview on block 0, document-level horizontal overflow chain. Not covered (out of scope for this claim): the .mmd full-page canvas, the lightbox, whiteboards. Probe at /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-5/probe.spec.ts; screenshots read-full.png, read-block3.png, edit-block0.png in the same directory. No repo files were modified.

### [wrong] A document that ends in a mermaid block has no trailing paragraph — clicking below the last diagram gives you nowhere to type

- **Surface** — Mermaid blocks inside a document
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map (its last block is the ELK flowchart). 2. Scroll to the bottom and click in the empty area just below the last diagram. 3. Type anything.
- **Measured** — .bn-editor contains 9 .bn-block-outer elements typed [heading, paragraph, mermaid, heading, mermaid, heading, mermaid, heading, mermaid] — the LAST one is the mermaid block, there is no trailing paragraph. The editor's bottom (1675px) equals the last block's bottom (1675px): zero clickable space below it. Clicking the bottom edge and typing 'AAA' left strategy/systems-map.md byte-identical (changed? false). The keyboard route does work: ArrowDown onto the block (ProseMirror-selectednode = true, wraps the mermaid-block) then Enter then typing appends a paragraph ('…D --> E[Serve]\n```\n\nBBB\n').
- **Re-measured by the verifier** — Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-13/probe.spec.ts (6 tests, all passed), Chromium 1440x900, my own dev server on :5433. Tree HEAD is 390fa04 (one commit past the reported f88c292); `git diff f88c292 390fa04 -- src/mermaid/MermaidBlockView.tsx` touches only LivePreview's `useLegibleWidth`/`mx-auto` — saveAsFile, write_text_file and mockIpc.writeTextFile are byte-identical to the reported commit.

RAW FACTS — REPRODUCE. Probe A, trusted `locator.dblclick()` on the GANTT block's "Save as file…" (button rect x=939.48 y=1292.45 w=85.67 h=22): diagrams/ went {pipeline.mmd:108} -> {pipeline.mmd:108, gantt.mmd:126, gantt-2.mmd:126}. Contents compared string-for-string: IDENTICAL=true, both exactly "gantt\n  title Rollout\n  dateFormat YYYY-MM-DD\n  section Phase 1\n    Pilot     :a1, 2026-08-01, 7d\n    Expand    :after a1, 14d". Probe E: rail-badge "11" -> "13". Probe B control: one click = exactly one file. So the reporter's numbers are accurate.

BUT THE FINDING IS WRONG ON THREE COUNTS.

(1) "SILENTLY" IS FALSE. Probe E screenshotted the viewport at +700ms after the dblclick (e-toasts.png, read with the Read tool): TWO toasts are simultaneously on screen, stacked, each naming its own distinct destination — "Saved to diagrams/gantt.mmd" and "Saved to diagrams/gantt-2.mmd". DOM read of leaf nodes starting "Saved to diagrams/" returned ["Saved to diagrams/gantt.mmd","Saved to diagrams/gantt-2.mmd"]. The user is told, twice, exactly what landed where. Nothing about this is silent.

(2) THE DIAGNOSIS ("fire-and-forget with no in-flight guard") IS REFUTED BY MEASUREMENT. Probe F: click once, wait for "Saved to diagrams/gantt.mmd" to become visible, confirm diagrams/ = {pipeline.mmd, gantt.mmd} (write fully landed), wait 6000ms, assert the toast has expired (`getByText('Saved to diagrams/gantt.mmd').count()` = 0, i.e. nothing in flight), THEN click again. Result: gantt-2.mmd, identical bytes. Probe C, two clicks 2500ms apart with the button state read 300ms after the first ({disabled:false, text:"Save as file…", aria-busy:null}): same duplicate. There is no race and no concurrency — an in-flight guard or a disabled state would change nothing. Two sequential, seconds-apart, unambiguously-intentional clicks produce the same two files. The double-click in the repro is not special; it is merely the fastest way to issue two clicks.

(3) IT IS THE DOCUMENTED, DELIBERATE, TEST-LOCKED SEMANTIC. src-tauri/src/vault/write.rs:259 — "Write a raw text file at `rel`, deduping the STEM (`-2`, `-3`, …) when the path is taken. Returns the vault-relative path actually written." Never overwrites, by design; overwriting would silently destroy a diagrams/gantt.mmd the user had hand-edited. Given never-overwrite, N activations = N files, necessarily. MermaidBlockView.tsx:27-33 — "Auto-named from the detected diagram type — the backend dedupes with `-2` and returns where it actually landed, and the toast says so; no prompt dialog on purpose." And src/mermaid/MermaidBlockView.test.tsx:334-344 is a checked-in unit test literally named "dedupes against an existing file and toasts where it actually landed" that clicks "Save as file…" TWICE on the SAME block and asserts flowchart.mmd then flowchart-2.mmd with identical content. The behaviour filed as a bug is the behaviour a test guards.

COVERED BUT CLEAN: single-click control (1 file), inter-click button state, toast text and simultaneity, byte-level content comparison, rail-badge count, and the block-type label ("GANTT", so the right block was driven).
- **Suspected cause** — No trailing-block plugin is active for this editor. Note the repo's own e2e comment in e2e/diagrams.spec.ts (~line 105) asserts the opposite — 'BlockNote's trailing-block plugin keeps an empty paragraph after it' — and the spec then clicks `[data-content-type="paragraph"].last()`, which is actually the INTRO paragraph, so that test inserts its new block in the middle of the doc, not at the end.
- **Verifier's reasoning** — The mechanical facts reproduce exactly (two byte-identical .mmd files, rail-badge 11->13), but the finding fails on all three refutation tests. "Silently" is factually false — I screenshotted two simultaneous toasts, each naming its own distinct path. The causal diagnosis is refuted by direct measurement: probe F clicked a second time 6s after the first write had fully landed and its toast had expired, and still got gantt-2.mmd, so there is no in-flight race and an in-flight guard would fix nothing. And the behaviour is the deliberately-designed semantic of write_text_file, which never overwrites ("deduping the STEM (`-2`, `-3`, …) when the path is taken") because overwriting a hand-edited diagrams/gantt.mmd would destroy data; saveAsFile's own comment says "the backend dedupes with `-2` and returns where it actually landed, and the toast says so; no prompt dialog on purpose"; and MermaidBlockView.test.tsx:334 is a checked-in test that clicks the button twice on one block and asserts exactly this outcome. What remains is at most a wishlist item (content-level dedupe on a "Save as" action), loudly announced when it happens, and below the bar for "rough".

### [rough] Resizing the window while the dialog is open strands the diagram outside the canvas — at 560px wide it is 100% invisible

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, "Open full screen" on the first block (it fits, centred, at 100%).
2. Resize the app window smaller (e.g. drag from 1440x900 to 700x500).
3. The canvas is blank apart from a sliver of two node boxes at the right edge; nothing indicates where the diagram went. Only clicking Fit brings it back.
- **Measured** — Plane transform is identical before and after the resize: `matrix(1, 0, 0, 1, 653.688, 176.344)` at 1440x900, at 700x500 and at 560x800 — the fit is never recomputed and the content is never re-centred. Fraction of the diagram's bbox inside canvas-viewport: 1.000 @1440x900, 0.163 @700x500, 0.000 @560x800 (svg box stays at x=665.7 w=108.6 while the viewport shrinks to 560/700 wide). Clicking "Fit diagram" restores 1.000 (transform becomes matrix(1.53,0,0,1.53,178.4,3.7)). Expected: content stays at least partly visible, e.g. re-centre on resize or clamp the pan so the diagram cannot leave the viewport.
- **Re-measured by the verifier** — Dev server :5424, real Chromium, 1440x900, worktree HEAD 390fa04.

INLINE, all four fences (host = the overflow-auto div in MermaidDiagram.tsx, clientWidth 638 for every block):
- [0] flowchart-v2: viewBox "0 0 108.625 445.3125", max-width 108.625px, min-width "" (none), rect 108.63 x 445.31, scale 1.000, scrollWidth 638. Unaffected.
- [1] sequence: viewBox "-50 -10 650 371", max-width 650px, min-width "" , rect 638 x 364.14, scale 0.982, scrollWidth 638. Text declared 16px -> rendered height 19px. Unaffected.
- [2] gantt: viewBox "0 0 1440 148", width attr "100%", style max-width "1440px", style min-width "792px" (computed 792px), rect 792 x 81.39, scale 0.550. Host clientWidth 638, scrollWidth 792, overflow-x auto, maxScrollLeft 154 (hidden 154px). Text: dates declared 10px -> rendered height 6px; "Pilot"/"Expand"/"Phase 1" declared 11px -> 8px; "Rollout" declared 18px -> 12px.
- [3] flowchart-v2 (ELK): viewBox "4 4 513.140625 155", max-width 513.141px, min-width "", rect 513.14 x 155, scale 1.000, scrollWidth 638. Unaffected.

CLAIMED vs MINE for the gantt: rect 638 x 65.6 -> 792 x 81.39. Scale 0.443 -> 0.550. Date label height 5px -> 6px. Task/section 6px -> 8px. Title 10px -> 12px. min-width absent -> "792px". Host non-scrolling -> scrollWidth 792 vs clientWidth 638, 154px of horizontal scroll. 792 = 1440 x MIN_SCALE 0.55 exactly; the alternative clamp was column 638 x MAX_OVERFLOW 1.6 = 1020.8, and min(792, 1020.8) = 792, so the floor provably comes from useLegibleWidth.

LIGHTBOX (gantt, Expand clicked via locator.click, Zoom in via locator.click x5):
- at open: readout "100%", svg rect 910 x 93.52, viewport clientWidth 910, canvas clientWidth 910, effective scale 0.632, date label height 8px, svg style max-width "1440px" / computed "1440px" (the canvas class is [&_svg]:max-w-none but inline style wins).
- after 5 zoom-ins: readout "161%", svg rect width 1465.56, effective scale 1.018 (past natural size), date label height 13px. MermaidLightbox.tsx MIN_SCALE 0.25 / MAX_SCALE 4.

HIGH-DPI (deviceScaleFactor 3, dpr confirmed 3 in-page): gantt rect unchanged at 792 x 81.39, min-width "792px"; B-gantt-3x.png legible end to end.

NARROW (1024x800): host clientWidth 334, min-width "534px" (= 334 x 1.6, the MAX_OVERFLOW clamp), rect 534, scale 0.371, scrollWidth 534; document.body.scrollWidth 1024 == clientWidth 1024 (no page-level horizontal scroll).
- **Suspected cause** — CanvasViewport's `initialFit` runs at mount only; there is no ResizeObserver on the viewport re-running the fit (or clamping the translate) when the box changes size. The full-screen dialog is 100vw/100vh so every window resize changes that box.
- **Verifier's reasoning** — Stale — already fixed, by exactly the remedy the reporter proposed. The claim was driven at f88c292; the worktree HEAD is now 390fa04 ("feat(mermaid): a whiteboard you can arrange on, and an undo for when you don't like it (M29.52)"), which added src/mermaid/legibleWidth.ts and wired `useLegibleWidth` into MermaidDiagram.tsx (line 45: "A wide diagram scrolls rather than shrinking into illegibility (M29.52)"). `git log -- src/mermaid/legibleWidth.ts` returns only 390fa04, so it did not exist when the reporter measured.

The file's own comment quotes the same finding and names the tradeoff: "Mermaid renders with `useMaxWidth`, so its svg carries `max-width: <natural>px` and our hosts add `max-w-full` — the two together fit any diagram to its container, however small that makes it. For a flowchart that is fine; for a wide one it is not. MEASURED on `demo-vault/strategy/systems-map.md` ... That is not a small diagram, it is an unreadable one ... Below MIN_SCALE the svg stops shrinking and the host scrolls instead." `MIN_SCALE = 0.55`, `MAX_OVERFLOW = 1.6`. The reporter suggested "let a wide diagram scroll horizontally in its overflow-auto host, or cap the downscale (e.g. min-scale 0.8) and scroll past it" — the code now does BOTH, at 0.55 rather than 0.8.

Three findings from my own run, none of which depend on their spec:

1. The headline numbers do not reproduce. The gantt is no longer squeezed to the 638px column; it is floored at 792px (= 1440 x 0.55, exact) and the host scrolls 154px to reveal the rest. Scale 0.550, not 0.443. Smallest rendered text height 6px, not 5px.

2. "The lightbox is not a rescue" is false by measurement. I drove the real Zoom-in button (locator.click(), not dispatchEvent) five times: readout goes 100% -> 161%, svg width 910 -> 1465.56px, effective scale 0.632 -> 1.018, i.e. past 1:1 with the 1440-unit viewBox, and date labels reach 13px tall. MermaidLightbox.tsx caps at MAX_SCALE 4, and the viewport pans by pointer drag. Screenshot A-lightbox-zoomed.png shows the axis fully legible. The "100%" readout does mean "zoom transform = 1", not "1:1 with natural size" — that naming is at most a nit, not the filed defect.

3. The residual is not "wrong" severity. A 3x device-pixel crop (B-gantt-3x.png, dpr 3) of the inline gantt is completely legible — every date tick, "Phase 1", "Pilot", "Expand", "Rollout" all read cleanly, which is what a Retina user actually sees. At 1x it is small but scrollable, and both "Open full screen" and the Expand button sit in the block header as visible affordances to the 1:1 view.

One thing I measured that the reporter did not, and that I am explicitly NOT filing as a defect because it is the documented tradeoff: at a 1024x800 window the doc column narrows to 334px and the MAX_OVERFLOW=1.6 clamp caps min-width at 534px, giving scale 0.371 — worse than the reporter's number. That is the commented intent ("past that it goes back to shrinking, because an unreachable diagram is worse than a small one"), and it holds its promise: document.body.scrollWidth stayed 1024 == clientWidth, so the page never becomes a horizontal scroller. Different viewport from the claim, and behaving as written.

Coverage: all four fences' geometry and text metrics at 1440x900; host scroll reachability; the lightbox at open and after five trusted zoom clicks; a 3x-DPI legibility crop of the gantt with the sequence diagram as control; and a 1024-wide re-measure. Probe: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-4/probe.spec.ts (my own, written from the repro steps; I never executed theirs). Screenshots in the same directory. Repo unmodified.

### [rough] There is no route to full screen from a block that is already being edited

- **Surface** — The full-screen block editor dialog
- **Verifier confidence** — high
- **Repro** — 1. Open Systems map, click "Edit" on the first mermaid block.
2. Look for "Open full screen" — it is gone. You must click Done first, then Open full screen.
- **Measured** — Block header buttons while idle: ["Open full screen","Save as file…","Edit"]. While editing: ["Show code","Done","+ Node","+ Shape","TD","LR","BT","RL","Layout: Dagre","Auto-layout: On"] — "Open full screen" count = 0. Expected: the button that says "give me more room" is available exactly when the user has run out of room, i.e. mid-edit.
- **Re-measured by the verifier** — All figures from my own Chromium run at 1440x900 against my own dev server on :5421, worktree HEAD 390fa04 (M29.52 — the tree has advanced past the f88c292 named in the brief). Probes: /private/tmp/claude-501/-Users-joseflagorio-Development-cerebro/c548aead-1b21-4c18-aec5-5432840edc42/scratchpad/verify-1/probe.spec.ts, probe2.spec.ts, probe3.spec.ts.

REPLICATED (reporter was right on these):
- Systems map fresh load: 9 .bn-block-outer = [heading, paragraph, mermaid, heading, mermaid, heading, mermaid, heading, mermaid]. Last block is mermaid. paragraphCount = 1.
- Block rects (unscrolled): heading 132-201, paragraph 201-249, mermaid 249-757, heading 757-805, mermaid 805-1232, heading 1232-1280, mermaid 1280-1425, heading 1425-1473, mermaid 1473-1691. .bn-editor rect top 132 bottom 1691 height 1559 -> editor bottom == last block bottom, zero slack. Scrolled to bottom: last mermaid 614-832, editorBottom 832, same equality.
- elementFromPoint(744, 844) (12px below the last block) = DIV.h-full.overflow-y-auto.pb-10.pt-6, closest [data-content-type] = null.
- Trusted page.mouse.click(744, 844) then type "ZZZ", waited 2500ms (debounceMs is 500): __cerebroMockFs['strategy/systems-map.md'] before === after, changed = false. Tail both: "...D --> E[Serve]\n```\n". Zero page errors.

REFUTING MEASUREMENTS (mine, not the reporter's):
- Scope: PRD fresh load = ["heading","heading","paragraph","heading","paragraph","heading","paragraph","heading","paragraph","heading","bulletListItem","bulletListItem"] - no trailing paragraph. Kickoff fresh load = ["heading","paragraph","checkListItem","checkListItem","checkListItem"] - no trailing paragraph. Neither doc contains a mermaid block.
- Plugin alive: after a trusted click on the intro paragraph + type "QQQ", file changed = true (head "...proves QQQthe optional engine loads.") and the block list became ["heading","paragraph","mermaid","heading","mermaid","heading","mermaid","heading","mermaid","paragraph"] - 10 blocks, trailing paragraph present.
- Trailing paragraph does NOT fix the click: with lastType "paragraph", lastBottom 832, editorBottom 832, trusted click at (744, 846) + type "WWW" -> changed = false, tail still "...D --> E[Serve]\n```\n".
- Click 8px INSIDE the editor bottom edge on a fresh load: selection anchor contentType = null, .ProseMirror-selectednode = true (the mermaid block node-selects, blue ring visible in 20-fresh-bottom-click.png). Typing "AAA" -> changed = false.
- Mouse route 1: click the last mermaid-diagram at (5,5) -> selectedNode = true; Enter; type "EEE" -> changed = TRUE, tail "...D --> E[Serve]\n```\n\nEEE\n".
- Mouse route 2: hover last block -> side menu exposes buttons aria-label "Add block" and "Open block menu", both visible; click "Add block", Escape, type "PPP" -> changed = TRUE, tail "...D --> E[Serve]\n```\n\nPPP\n", blocks now [...,"mermaid","paragraph","paragraph"] (screenshot 11-after-plus.png).
- e2e spec target on fresh load: paragraphCount 1, lastParagraphText "How the demo product's pieces talk to each other. The flowchart below ", lastParagraphIndexAmongBlocks 1, totalBlocks 9 -> the repo spec's `.last()` paragraph is the intro, confirmed.
- No spurious disk write from the trailing block in any run: every file tail ended exactly "```\n" with no added blank line.

NOT COVERED: I did not test docs outside demo-vault, non-Chromium browsers, or the .mmd full-page canvas (not in scope for this claim).
- **Suspected cause** — MermaidBlockView.tsx:153 gates both "Open full screen" and "Save as file…" on `!editing`.
- **Verifier's reasoning** — The reporter's raw numbers replicate exactly, but every causal and scoping claim in the finding is wrong, and the user is not blocked by any mouse-only route.

(a) NOT MERMAID-SPECIFIC. On a fresh load NO document in this vault gets a trailing paragraph, whatever its last block is. demo-vault/templates/prd.md ends [.., "bulletListItem","bulletListItem"]; .../meetings/kickoff.md ends ["heading","paragraph","checkListItem","checkListItem","checkListItem"]. Both lack a trailing paragraph identically. Nothing about the mermaid block causes this, and nothing in M29 introduced it.

(b) "No trailing-block plugin is active for this editor" is FALSE. The plugin is registered (blocknote 0.46.2 defaults trailingBlock on: `...e.trailingBlock !== !1 ? [gt()] : []`) and demonstrably fires — it just does not fire for the initial replaceBlocks. I typed QQQ into the intro paragraph of Systems map and the block list became [...,"mermaid","paragraph"]: the trailing paragraph appeared on the first real doc change. The plugin's `apply` gates on `n.docChanged` and `init` returns undefined, so the mount-time load is the one transaction it misses.

(c) THE MISSING PARAGRAPH IS NOT THE CAUSE OF THE DEAD CLICK. This is the decisive refutation. With the trailing paragraph PRESENT (lastType "paragraph", lastBottom 832 == editorBottom 832), I repeated the exact same gesture — trusted page.mouse.click 14px below the last block, then type WWW — and the file was still byte-identical. The dead zone is the scroll container's own bottom padding (`div.h-full.overflow-y-auto.pb-10.pt-6`), which is not a click-to-focus target for ANY document. The finding's headline welds two independent facts together and gets the mechanism wrong.

(d) "NOWHERE TO TYPE" IS FALSE, AND NOT ONLY VIA THE KEYBOARD. Two mouse-only routes work on a fresh load: (1) click the last diagram — the block node-selects with a visible blue ring (screenshot 20-fresh-bottom-click.png) — then Enter, then type: the file gained "```\n\nEEE\n"; (2) hover the last block, click the side menu's "Add block" (+) button, type: the file gained "```\n\nPPP\n" (screenshot 11-after-plus.png). The reporter only tried ArrowDown+Enter and concluded it was a keyboard-only escape hatch.

(e) THE DELIBERATE PART HOLDS. src/editor/MarkdownEditor.tsx:271-273 — "Serialized baseline: change events only emit when they diverge from it, so mounting (and the trailing-block plugin) never writes back." The intent is that a trailing block must never dirty the file, and my runs confirm it: the trailing paragraph that appears after the first edit was never serialized (file tail stayed "...D --> E[Serve]\n```\n", no extra blank line).

(f) SEVERITY. "wrong" means visibly incorrect — overlap, clipping, mis-size, mis-colour. Nothing here is visibly incorrect; the page renders correctly and the block gives clear selection feedback. The residual truth is a small polish gap shared by lists, checklists and diagrams alike: ~40px of inviting whitespace below the editor is not a click-to-append target the way Notion's is. That is "rough" at most, and it belongs to the editor shell, not to M29.

ONE TRUE RESIDUE, AND IT IS A TEST DEFECT NOT A UI DEFECT: the reporter's side observation about e2e/diagrams.spec.ts is correct. On a fresh load paragraphCount is 1 and `.bn-editor [data-content-type="paragraph"]` .last() resolves to the INTRO paragraph at block index 1 of 9 — so that spec's comment ("BlockNote's trailing-block plugin keeps an empty paragraph after it — click that to get a caret at the end of the doc") is factually wrong and the spec inserts its new mermaid block mid-document rather than at the end. That is worth fixing in the spec, but it is test hygiene, not a live UI defect, and it is not what was filed.

