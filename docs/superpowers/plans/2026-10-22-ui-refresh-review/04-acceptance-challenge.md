# Fourth pass: make “polished” a reviewable product outcome

Independent challenge pass, 2026-10-22. The expansion direction and the first
three refresh reviews are credible, but completion needs stricter boundaries.
An attractive component gallery, historical browser passes, a successful native
build and a finished everyday experience are different evidence. This pass
checked selected current source seams and the existing acceptance record; it
did not run application tests, native interactions, the CLI or providers.

The first release should make ordinary pages, records, collections and the
assistant feel composed and dependable. A Rust execution service or metadata
migration need not precede that work. They become dependencies only where the
interface promises new authority, persistence or execution behavior.

## Ranked corrections to the plan

### AC01 — Establish a coherent handoff before accepting new screenshots

**P0 handoff prerequisite; not a new architecture project.** The coordinating
review encountered a blank browser body twice with the policy error
`shared/policy/tool-approval.v1.json: unknown field agent_types`. The
[architecture recheck](01-architecture-recheck.md) locates the strict loader and
records policy/runtime changes since the earlier audit. Therefore no
current rendered-interface comparison was completed during that observation.

Close this at Claude's handoff by recording the exact source/build identity and
rechecking the policy artifact, both loaders, digests and real consumers
together. Then capture the actual application. Do not treat a temporary
inconsistent working tree as a shipped regression, change another contributor's
files to make screenshots possible, or use October 17 images as fresh evidence.
The older M91 audit should remain a historical snapshot with a dated amendment.

### AC02 — Separate blockers, visual decisions and expansion features

**P0 release-definition correction.** Use three acceptance classes:

| Class                | Examples                                                                                                                                           | Completion rule                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Blocking correctness | Launch failure; lost human draft; an approval showing the wrong target; a child failure replacing the parent's answer                              | Required for any release exposing that journey; no aesthetic sign-off can waive it silently.               |
| Refresh targets      | Aligned content edges; consistent density, property vocabulary, typography and overlays                                                            | Review actual before/after compositions and interactions, then propagate the accepted choice.              |
| Future capabilities  | App-owned conversation retention, recoverable creation across restart, Rust connector dispatch, workflow recovery, passage-level search navigation | Specify producers and persistence separately; do not count a styled mock or disabled control as delivered. |

The 1,000-row responsiveness failure is a blocker to claiming the agreed scale
target is complete. It need not prevent an independently reviewable typography
change from landing. Likewise, missing workflow recovery should not stall page
composition, but it must block a claim that a workflow is safely resumable.
Keep one work item for each existing CP finding instead of duplicating it under
new UI milestone names.

### AC03 — Treat draft ownership as part of the visual design

**P0 affected journeys.** [quit.ts](../../../../src/app/quit.ts) explicitly
acknowledges that a failure after `beginLeaving` cannot keep text owned by an
already unmounted page. Its failure comparison also starts at the beginning of
the quit attempt. The existing save indicator and error toast do not establish
recovery of an earlier failed write.

The refresh specification must show persistent unsaved state, an actionable
retry and retained exact content. Ownership must survive the relevant page,
pane and vault transitions, or the transition must wait for a safe transfer.
Test a failure that has already settled before quit, a failure during teardown,
and a successful retry without typing another character. Distinguish ordinary
close/keyboard quit from Dock Quit and shutdown: the current documented guard
does not cover all exit paths. Never claim broader protection from a browser
test of one button.

### AC04 — Use CSS pixels, actual pane width and explicit zoom

**P1 acceptance correction.** The current native minimum is 900×600 in
[tauri.conf.json](../../../../src-tauri/tauri.conf.json). A 900px window can
contain a much narrower page after navigation and panels. The
[shell layout](../../../../src/app/shellLayout.ts) already budgets the 54px
rail, contextual navigation, panels and parked panes. The
[page frame](../../../../src/components/pageFrame.css) already supports a
full-height docked inspector and a drawer. Preserve those behaviors rather than
adding another competing responsive system.

Record viewport CSS dimensions, device scale, actual pane width and browser or
webview zoom separately. A 2× screenshot is not a 200% zoom test. An 880px outer
surface is not an 880px text measure: gutters and padding matter. Treat the
visual review's proposed 700–760px prose measure and row sizes as prototypes,
not verified improvements or mandated universal dimensions.

Use these profiles across the acceptance matrix:

| Profile                              | Required observation                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| A: 1440×900, 100%                    | Real desktop hierarchy with context sidebar, document, inspector and each assistant presentation.                      |
| B: 1024×768, 100%                    | Transition to drawers/parked surfaces, visible critical actions, no outer horizontal scroll.                           |
| C: 900×600 plus a narrow active pane | Native minimum and pane-width pressure separately; long labels, open pickers, panel close and focus restoration.       |
| D: 200% zoom                         | Actual zoom at A and the highest-risk B/C scene; wrapping, menu placement, visible status and complete task execution. |

Run all base scenes in both light and dark themes. Add reduced motion to the
overlay/presentation transition scenes. For a web-accessibility conformance
claim, 200% alone is insufficient: WCAG reflow evaluates a 320 CSS pixel
equivalent width, with exceptions for content genuinely requiring two
dimensions. Keep that as a separate audit, not a claim that Cerebro supports
phone-sized native windows. [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)

### AC05 — Require human visual judgment and measured accessibility

**P1 independent gates.** The owner should judge whether three concrete
compositions feel finished: a document with properties/inspector, a collection
with list/table/grid, and a conversation with sources and a consequential
decision. Use the same real content for before/after views. Judge readable
hierarchy, intentional density, alignment, restraint and ease of finding the
next action. Passing a screenshot-diff threshold cannot make that aesthetic
decision.

Separately measure actual foreground/background combinations, including
selection, hover, focus, error and translucent overlays. WCAG's normal-text
minimum is 4.5:1 and its large-text minimum is 3:1, with specified exceptions;
do not label every muted label “decorative.” A passing palette pair does not
prove every rendered composition. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

[IconButton](../../../../src/components/ui/IconButton.tsx) already requires an
accessible label and uses 24/28/32px button sizes. Glyph size is not target size.
Check ad hoc controls too: WCAG's minimum target criterion uses 24×24 CSS pixels
or specified alternatives/exceptions. Larger targets may still be appropriate;
making every dense control 44px is not a necessary consequence of that minimum.
[W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

### AC06 — Preserve the existing focus, status and scroll contracts

**P1 interaction gate.** [AnchoredFieldStatus](../../../../src/detail/AnchoredFieldStatus.tsx)
already separates a persistent `role="status"` from an `aria-hidden`, passive
visual bubble and updates placement on viewport/scroll changes. A visual
redesign must not replace it with hover-only errors or elevate edited cells
over frozen columns. Keep refused text exact and associated with its field
even when the row scrolls away.

[Motion ownership](../../../../src/components/ui/motion.ts) already distinguishes
retained panels from exit ghosts and handles reduced motion. Verify the
complete consumer journey: closing a panel restores focus immediately to a
surviving opener, exiting duplicates cannot take focus, and interrupted
animations do not strand controls. Pointer-events rules alone do not prove
keyboard isolation. Inspector, table and conversation scrollports should each
own their intended content; wheel/trackpad gestures must not unexpectedly move
the underlying page. While reading earlier chat content, streaming must not
force the user back to the bottom.

## Compact acceptance matrix

Every row needs populated, loading, empty and unavailable states where those
states have meaning, plus the listed risky state. “Unknown/not recorded” is
distinct from measured empty. Use A/B/C/D above for the shared composition
review; execute the complete risky journey at its narrowest relevant profile
and again in the packaged app where native behavior matters.

| Surface             | Concrete journey and risky state                                                                             | Evidence required                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prose page          | Long title, filename fallback and nonleading H1; IME composition; selection toolbar; failed save and retry   | One editor/title owner; no reordered Markdown; stable metadata portal; exact retained draft; focus and text selection preserved.                            |
| Record page/peek    | Edit relation/date/status, reject one draft, promote to page, go Back                                        | Same record/field semantics; no second writer; preserved filter/scroll; useful validation and exact rejected text.                                          |
| Database            | Sort/filter/group, edit a frozen-column cell, scroll offscreen then recover                                  | All rows remain discoverable; keyboard End/find and variable-height rows work; stable active cell and status; measured latency.                             |
| Knowledge           | Open a queued concept, inspect evidence, review/verify, handle failed evidence read                          | Reasons and provenance remain clear; human verification stays distinct from agent work; unavailable is not empty.                                           |
| Agents              | Read instructions, inspect one successful/failed child, reopen scoped run history                            | Stable parent/child identity; correct originating vault/actor; missing usage is not zero; selected detail survives recoverable failure.                     |
| Chat                | Long answer, six sources, three children, pending approval and interrupted action; switch float/panel/canvas | Draft/stream/reading position survive; sources open meaningful context; failed child does not replace parent; decisions show real producer state.           |
| Settings/connectors | Dirty settings, rejected readiness check, invalid config and expired account                                 | Keep exact draft; Retry is distinct from Install; secrets stay concealed; action availability follows actual account state.                                 |
| Search              | Search, inspect useful excerpt, open beside, then return; target moved/deleted                               | Existing result navigation stays dependable; passage navigation is separately delivered; query, selection and origin survive.                               |
| Creation            | Start from folder/database/related tab, validate, cancel/reopen, fail creation                               | Destination is visible and correct; no duplicate create; existing relationship semantics preserved; restart recovery claimed only after persistence exists. |
| Shell/overlays      | Collapse sidebar, switch panes, open Details/Comments/History, layer menu over drawer                        | All destinations reachable; one active page side-panel slot; foremost Escape only; appropriate focus return; no clipped critical action.                    |

Do not mechanically multiply every possible control/state combination. Use this
matrix to select representative compositions, then add explicit regressions for
high-risk boundaries: save/quit, title/IME, field refusal, nested overlays,
stream/presentation change, and approval dispatch. Baseline updates require
review of the changed image and its reason, not automatic regeneration.

## Performance, native evidence and completion

The [M84–M90 record](../2026-10-17-m84-m90-implementation-record.md) still leaves
the proposed p95 input budget below 100ms and warmed-task budget below 50ms
unmet at 1,000 rows. Its production key-to-two-frame results were 398.8ms for
1,000×12 fields and 1,376.2ms for 1,000×24; 5,000×12 navigation timed out and
5,000×24 was unmeasured. These are historical headless Chromium diagnostics on
a shared machine, not native input-to-photon results or current measurements.

Future benchmarking should preserve build hash, corpus dimensions, field types,
machine/load, warm/cold conditions, method and raw samples. Reproduce before
changing the target. Use the same method for before/after comparisons; report
timeouts and unavailable samples honestly. A lower median cannot close a p95
failure, and screenshot polish cannot close either. Preserve accessibility and
browser find when optimizing large views.

Native acceptance remains a distinct work item: WKWebView text/IME, VoiceOver
reading and focus order, clipboard and Finder drop, native dialogs, links/CSP,
window activation and failed-save quit. Include Japanese or Chinese composition,
dead-key/accent input, undo and selection crossing the projected title. Prior
package signing proves packaging, and prior browser sessions prove their
recorded browser cases. Neither proves these native interactions.

Complete each refresh slice with a source/build identity, before/after captures,
the exercised matrix rows, recorded failures and owner aesthetic disposition.
Keep source-confirmed, browser-observed, native-observed and future-proposed
claims distinct. The resulting plan can be ambitious about beauty and AI while
remaining honest about what actually works.
