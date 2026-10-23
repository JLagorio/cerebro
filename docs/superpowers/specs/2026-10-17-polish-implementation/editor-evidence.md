# M85–M86 implementation lane report

Implementation is in the shared worktree; this lane staged and committed no new changes. The retained title and writing runs pass focused browser acceptance after screenshot review prompted a title-ownership correction. App source is frozen; root owns integrated and native acceptance. The baseline was root's `2347951`.

## Title and page mechanism

`src/editor/pageTitleProjection.ts` projects the **first top-level H1** using ProseMirror node decorations. It is the real heading in the same document, editor instance, selection and undo history as the body. CSS moves its outer presentation above other top-level blocks; no Markdown node is reordered. A nonleading H1 therefore remains nonleading on disk. Later H1s remain sections.

The metadata widget is inserted at the node boundary **after the heading, before its optional child group**, inside the title's block container. The title wrapper keeps its own DOM box and block-grip geometry. Nested title children follow metadata, keep their source order, and hide with the other body blocks while related tabs are active. The document owner remains mounted on those tabs. Arrow keys cross the visual title/body boundary; Enter intentionally adds a writing paragraph before a first atomic image, database or sheet block, while ArrowDown selects that block without writing.

`NoteBodyEditor.tsx` owns a stable, noneditable chrome host and the React portal for properties/related views. The host is parked while the lazy editor loads, then moved by the view-only widget. Metadata is available before the editor chunk finishes and its components are not recreated on each editor render. ProseMirror clipboard serialization ignores widget labels and controls. Existing body reconciliation, save debounce, held writes, grants and page undo remain the durable paths.

For files without an H1, `PageTitleFallback.tsx` displays the filename without writing. The first real text edit adopts an H1 through the editor; Enter on the unchanged fallback also explicitly adopts it. On a related tab, Enter focuses page controls rather than the hidden body. Composition remains in its native input until settled. Save and quit settle it through the same owner; external reconciliation first moves a pending composition into that owner so the normal merge can preserve local and external text. Delayed focus restoration cannot steal focus from a property or control.

Rejected alternatives: a second title input/writer would race body saves and create two undo authorities; deleting/reinserting the H1 on open would alter file order and violate no-write-on-open; cloning an editable H1 would split native selection; `display:contents` on the title block would lose useful block-grip geometry. The final widget boundary avoids those problems.

Concept pages keep their guarded frontmatter title and review semantics. Direct concept peeks present the body and frontmatter as read-only and expose no generic writable properties. Agents retain grants and Instructions, Runs and Memory tabs; ordinary record tabs retain their existing source definitions and membership semantics.

## Authoring and related presentation

- Canonical 32/40 full title, 24/32 peek title, 16/28 prose, 14/20 UI and 12/18 metadata use existing role tokens. Later headings, simple tables, code, callouts and embedded frames receive consistent spacing and focus treatment. Existing Markdown carriers remain authoritative.
- The selection toolbar leads with carried formatting and one Ask AI action. Presets remain inside a keyboard-accessible Writing actions disclosure. Selection paint persists while contextual inputs own focus and never serializes. The toolbar captures ProseMirror's exact selection to withstand WebKit collapsing its browser range on a button click. AI per-hunk approval and original grants remain unchanged.
- `/Table` opens a bounded dimension picker: arrows choose dimensions, Enter or Space activates Insert, Escape cancels, and printable continuation returns to writing. Header-row meaning stays explicit. Database and spreadsheet insertion remain distinct.
- Carried block actions provide conversion, duplication with fresh recursive IDs, sibling move, deletion and checklist actions. Subtrees containing sheets explain why duplicate is unavailable instead of creating name collisions. Move preserves text, node and table selections by block identity and gives one undo step. Shift+F10 opens the same action family only from the native editor, never a popup or input.
- Callout kind choice uses a labelled menu and the existing carrier. Read-only surfaces disable mutation controls.
- Inspector sections use one labelled select instead of wrapping navigation pills. Comment Reply and destructive actions have clearer hierarchy; discussion/reply drafts survive inspector section changes. Existing sidecars, anchors, resolved threads and agent execution stay intact.

## Final review corrections

Screenshot review found two separate problems. Apparent body text through Ask AI was captured during the 140 ms `.cb-menu-in` opacity animation; both theme surfaces are opaque. Final screenshots disable animations and have been visually inspected. One historical dark Chromium document also showed a second title after Saved. Its precise trigger was not captured and was not reproduced in fresh diagnostic opens; it is not dismissed as an animation or attributed to HMR without evidence.

The title slot now reads `PageTitleProjection.titleId` through the live editor, rather than keeping independent `titlePresent` state that the file loader could reset. The projection initializes its store when the view mounts as well as on updates. The parent metadata portal remains stable; moving the whole portal into MarkdownEditor was rejected because it would remount field/grant drafts at readiness. The added lifecycle unit asserts the exact metadata input node and its unfinished draft survive lazy readiness, H1 conversion to paragraph, and Undo, with disk bytes unchanged. Final writing tests assert exactly one visible canonical heading, no filename fallback, and one canonical H1 in source at opened/formatted/selection/saved/reopened phases, attaching DOM/source diagnostics on failure.

Eight block-action regressions now include actual BlockNote image, database and sheet `NodeSelection`, a whole-container `NodeSelection`, rectangular `CellSelection`, undo, preceding-edit isolation and nested copy identity. Whole-container selections address `nodeAfter` rather than assuming an ancestor ID. Cell selections restore their serialized cell boundaries, not generic selection endpoints. BlockNote can select the sheet's unselectable inner grid; before moving, this is normalized to its selectable owning container so ProseMirror history can restore the same sheet on Undo. No sheet carrier or grid behavior changes.

## Evidence retained

- `/private/tmp/cerebro-editor-title-owner-units3.log`: 39/39 NoteBodyEditor and block-action tests, including unchanged metadata node/draft and real NodeSelection/CellSelection move/undo.
- `/private/tmp/cerebro-editor-selection-detail.log`: 72/72 block-action and DetailPanel tests. Because jsdom has no layout, a `document.elementsFromPoint` stub now mirrors the existing singular stub so the SideMenu hit test does not throw; browser pointer geometry remains real.
- `/private/tmp/cerebro-editor-knowledge-test.log`: 8/8 PageKnowledge tests. The lightweight editor double now renders its metadata slot; existing knowledge anatomy/guard assertions are unchanged.
- `/private/tmp/cerebro-editor-title-owner-types2.log`: final lane typecheck exited 0. `/private/tmp/cerebro-editor-lint-lifecycle.log`: focused lint exited 0. Final evidence-test lint and tools typecheck also exited 0 in `/private/tmp/cerebro-editor-evidence-lint.log` and `/private/tmp/cerebro-editor-evidence-types.log`.
- Earlier focused editor/owner/selection/AI tests: 93 passed, plus composition-versus-external-title and owner-retention cases. These are focused results; root owns the whole gate.

All 20 `page-title-polish` cases passed across Chromium and WebKit in `/private/tmp/cerebro-m90/editor-stable-final`. They cover leading and nonleading H1s, a later H1 section, filename fallback, atomic images/databases/sheets, Enter from an unchanged fallback, related-tab adoption, arrows within wrapped titles, nested body geometry and visibility, source order, and clipboard exclusion of chrome labels. Source bytes stay unchanged after opening, resizing and tab changes. Both 200% popup cases also passed in that run.

The overall run passed 24/26 cases: the two Chromium writing cases hit a redundant native-range reselection issue after Bold. Two complete WebKit writing sessions passed with stable captures. The subsequent final writing run passes all 6/6 cases in `/private/tmp/cerebro-m90/editor-writing-accepted` (`/private/tmp/cerebro-editor-writing-accepted.log`): Chromium/WebKit × light/dark complete sessions, plus both 200% popup checks. Initial and comment ranges are made with real pointer drags and asserted against the native selection; after Bold the same observed native range is reused for Ask AI. No DOM range is assigned to manufacture the writing-session selection.

Authoritative stable writing artifacts (all four session directories retain `video.webm`):

- `/private/tmp/cerebro-m90/editor-writing-accepted/editor-writing-polish-writ-793f7-ne-durable-session-in-light-chromium/writing-selection-light.png` and `writing-document-light.png`.
- `/private/tmp/cerebro-m90/editor-writing-accepted/editor-writing-polish-writ-2df9a-one-durable-session-in-dark-chromium/writing-selection-dark.png` and `writing-document-dark.png`.
- The same light/dark directories ending `webkit` contain the other two session videos and images.
- `/private/tmp/cerebro-m90/editor-writing-accepted/editor-writing-polish-sele-ee3f8-width-and-200-percent-scale-chromium/writing-selection-200-percent.png` and WebKit counterpart.

All 8 final writing PNGs (four selection and four saved-document captures) were visually inspected: one title, clear hierarchy, opaque popup, readable light/dark controls and no unexpected overlap. Both final 200% captures were also inspected: panel bounds fit the viewport and its content scrolls. Screenshots use `animations: 'disabled'`; saved-document captures wait for Saved and verify the canonical source and reopened content.

Authoritative stable title artifacts:

- `/private/tmp/cerebro-m90/editor-stable-final/page-title-polish-the-nonl-b876f-with-unchanged-source-order-chromium/title-nonleading.png` and WebKit counterpart.
- Same run's `title-image.png`, `title-database.png`, `title-sheet.png` in both engines.
- `/private/tmp/cerebro-m90/editor-stable-final/editor-writing-polish-sele-ee3f8-width-and-200-percent-scale-chromium/writing-selection-200-percent.png` and WebKit counterpart.

Durable review copies are available directly: [nonleading H1](editor/title-nonleading-webkit.png),
[image-first page](editor/title-image-webkit.png), [database-first page](editor/title-database-webkit.png),
[sheet-first page](editor/title-sheet-webkit.png), [light writing session](editor/writing-session-light-chromium.webm)
and [dark writing session](editor/writing-session-dark-webkit.webm). The neighboring `editor/`
directory also retains the corresponding engine/theme variants and 200% captures. These copies
were byte-compared with their accepted source runs; the temporary paths above preserve provenance.

The earlier `editor-writing-final` and `editor-webkit-zoom` directories are historical; do not use their animation/transient captures as final proof. Browser/mock-vault evidence is not packaged native evidence.

## Remaining acceptance limits

Root owns the whole lint/typecheck/test/build gate and packaged native acceptance. Playwright WebKit is useful cross-engine evidence but does not prove Tauri WKWebView, actual macOS IME behavior, native ⌘Q/window close, external-link guard, Finder dialogs, VoiceOver or native drag. Native composition and quit walkthrough remain explicit owner acceptance.

The nonleading H1 is visually projected but retains DOM/source order: VoiceOver reading order and heading navigation for that case have not been proven. The external-composition test is a model/lifecycle proof, not a claim to have exercised a native IME. Browser writing cancels AI rather than inventing a model result; per-hunk decision behavior retains its unit coverage. Native decision-stage keyboard focus is still an acceptance item even though Retry and Apply now explicitly expose `tabIndex={0}`.

Morrow and Macro influenced contextual hierarchy and writing controls through source review; neither reference application was run. Reference behavior is not represented as measured runtime evidence.

## Final root integration triage

The composed root suite passes **16/16 in 33.6 s**, Chromium and WebKit, in `/private/tmp/cerebro-m90/integration-accepted` with log `/private/tmp/cerebro-m90/integration-accepted.log`. It exercises table → peek → full page, retention and explicit retry of an invalid field draft, saving and reopening the corrected value, both themes at 900 × 600 and 125/150/200% scale, property-picker keyboard editing at 200%, and keyboard navigation from the rail into Settings. The picker test asserts its search input owns focus before ArrowDown/Enter and compares the complete source afterward, so accidentally editing the page body cannot pass.

This triage corrected two application defects:

- `src/detail/FieldPopover.tsx`: a searchable picker previously mounted its autofocus input while its positioning wrapper was hidden. Focus could remain in the page editor, where the picker's intended keystrokes edited prose. The wrapper now focuses the search input or no-search listbox only after placement makes it visible. It refuses to steal focus after the user moves elsewhere and refuses to focus hidden, inert or parked ancestry. Existing focus restoration remains intact. Placement still occurs on mount; this change does not claim that an already open picker tracks later window resizing or scrolling.
- `src/app/AppRail.tsx`: every native rail button now has an explicit `tabIndex={0}`. Observed WebKit sequential focus previously skipped those native controls under its macOS keyboard behavior. The accepted tests actually Tab from the brand to Settings, activate it with Enter, and assert both the selected rail destination and the General page heading.

`src/detail/FieldPopover.test.tsx` passes **23/23** in `/private/tmp/cerebro-m90/integration-focus-unit-final.log`, including simulated native refusal to focus hidden controls, listbox fallback, no focus theft after an outside control receives focus, and hidden parked ancestry. Focused lint on both application files and both changed test files exits zero. `e2e/polish-integration.spec.ts` also corrects the actual humanized Todo label and Settings' General heading assertion; it retains the real keyboard route rather than replacing it with a click.

Only the two intended `record-fullpage` Chromium/WebKit baselines changed. Their previous expected images contained stale validation toasts; the accepted workflow dismisses the real toast before the final capture. Both fresh full-page images in the accepted run were visually inspected: one canonical title, metadata above prose, the New control visible, and no residual validation toast or overlap. Captures disable animations. Their paths are `polish-integration-table-→-e08a4-commits-one-corrected-value-chromium/record-fullpage.png` and the corresponding `webkit` directory inside the accepted output. The 125% theme baselines were not changed.

This lane is source-frozen after those fixes. Root owns final whole-suite and packaged-native acceptance; the browser evidence retains the native limitations stated above. No changes were staged or committed by this lane.

## Complete browser gate and final copies

The final complete browser run passed **687/687 cases in 14.8 minutes**, with zero retries
and no snapshot updates, including every title, writing and integration case above. The
durable editor PNGs and videos were refreshed from that run. All editor and record PNGs
are byte-identical to the previously inspected accepted captures; the four recordings now
come from the final complete run. [Capture provenance](capture-provenance-root.json) records
each original path and digest. Earlier paths above retain the focused triage history;
[automated results](checks.json) identify the final acceptance run. Native limits remain open.
