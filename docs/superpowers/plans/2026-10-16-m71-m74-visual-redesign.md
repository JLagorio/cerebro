# M71–M79 — Cerebro visual redesign

**Status: M71–M79 implemented and browser-verified, 2026-10-16. Final regular macOS bundle built and locally signed; interactive native verification remains open.**
**Design:** [workspace redesign spec](../specs/2026-10-16-cerebro-workspace-redesign.md).
**Follow-up:** [M80–M83 polish](2026-10-16-m80-m83-ui-polish.md) records the owner's next refinement pass and newer package evidence.
**Authorization:** the owner requests a total visual redesign and explicitly
overturns the former one-sidebar requirement. Existing features and safety
contracts remain in scope for preservation.

The redesign changes the frame people see everywhere, gives the assistant a full canvas presentation, and carries the same hierarchy through the main pages. A live surface audit expanded the first M71–M74 delivery into M75–M79: contextual Inbox, Settings, Work and Studio navigation; shared page headers; and viewer/tool chrome. Native interactive verification remains a separate check from build and browser proof.

## Decisions

| Decision | Contract |
| --- | --- |
| Reference geometry | Persistent 54px icon rail, approximately 280px reference context, broad canvas, centered conversation near 760px. The 240px resizable implementation default was accepted after the 1440px screenshot review. |
| Cerebro identity | Instrument Sans, IBM Plex Mono, cortex/synapse and semantic tokens remain. Both dark and light themes are supported. |
| Previous shell | M71 supersedes M37.3/M43's single-column geometry. It preserves destinations, page-first navigation, pane ownership and keyboard semantics. |
| Assistant | Exactly one mounted assistant/controller owns the thread and run. Panel/canvas changes presentation, never authority or execution. |
| Data model | No file-format, runtime schema, tool grant, refusal-code or import-authority changes are planned. Visual controls reuse existing actions. |
| Repository | Preserve the existing index and HEAD. Do not stage, commit, push or rewrite history for this work. |
| References | Read Macro only as targeted design evidence; no copied code/assets and no project-wide lint/test traversal of the vendored tree. |

## Ownership and sequence

| Milestone | Owner/lane | Scope | Current status |
| --- | --- | --- | --- |
| M71 | Shell lane | Rail, contextual sidebar, shell sizing and navigation | Implemented; shell/browser checks passed |
| M72 | Assistant lane | One assistant in panel/canvas; transcript/composer hierarchy | Implemented; focused tests and both browser engines passed |
| M73 | Main lane | Home and document/record page polish | Implemented; rich-content, editing and responsive checks passed |
| M74 | Main + verification lanes | Integrated proof, surface audit and regular app bundle | Final lint/types/format and package verification passed; native interactive checks not performed |
| M75 | Shell lane | Inbox queue in context, collapsible organizing inspector, page-owned navigation seam | Implemented; units and both browser engines passed |
| M76 | Assistant lane | Settings section navigation and retained detail controllers | Implemented; units and both browser engines passed |
| M77 | Main lane | Shared headers, My work alignment, Library cards, Studio navigation | Implemented; focused unit/browser checks passed |
| M78 | Main lane | Database/list/Knowledge toolbar rhythm and readable summaries | Implemented; focused unit/browser checks passed |
| M79 | Package lane | Work explorer in context, History and viewer/tool chrome | Implemented; units, browser flows and visual audit passed |

M71 and M72 can proceed together after agreeing the shared `App.tsx` and UI
store seams. Each lane names its files before edits. The shell owns layout;
the assistant owns transcript/composer state. M73 can use shared tokens but
must coordinate token changes. Documentation owns this plan/spec and the
narrow AGENTS shell amendment. No lane edits the other's shared host or
stores without a handoff.

## M71 — Persistent rail and contextual navigation

**Read first:** `src/App.tsx`, `src/app/Sidebar.tsx`,
`src/app/shellLayout.ts`, `src/stores/uiStore.ts`,
`src/engine/destinations.ts`, existing shell/sidebar tests and
`e2e/shell-layout.spec.ts` if present. The spec lists the exact Macro files
reviewed as reference; its 56px upstream rail is not Cerebro's chosen width.

- [x] Introduce the persistent 54px rail using the existing destination and
      command vocabulary. Keep search, create, assistant, vault identity,
      settings/theme and actionable sync status reachable.
- [x] Move trees and secondary choices into the contextual sidebar. Record
      the actual destination-to-context mapping in the completion evidence.
      Preserve all collections, pages, repositories, Knowledge folders/review,
      agent roster, databases and favorites; do not silently discard sections.
- [x] Establish the accepted 240px default context width, resize limits,
      collapse/drawer behavior and migration/clamping of stored preferences.
- [x] Update shell arithmetic so the permanent rail is counted once. Preserve
      active page panes, peek ownership, parked panes and page-side details.
- [x] Replace comments and tests that require one nav column with assertions
      of the new explicit geometry and unchanged reachable destinations.

**Agreed implementation seams (2026-10-16):** `AppRail.tsx`,
`shellNavigation.ts` and `shell.css` supply the new shell, integrated by
`App.tsx`. Context areas are Home, Pages, Databases, Knowledge, Agents and
Work. Home retains Inbox/My work/Studio/History/Library plus Collections and
Favorites; each other area exposes its existing owned shelves. At widths below
1048px, context uses a drawer. Assistant opens the full canvas, and its
conversation list uses the sidebar portal target without creating a second
assistant. The shell checks and measured results are recorded below.

**Acceptance:** global navigation stays present when context collapses; the
active destination and page remain clear; every previous navigation action
still works; no control is clipped at the native minimum; sidebar resize and
drawer focus are usable with the keyboard. Destination identifiers, `g`
chords, command-palette navigation, Back/Forward and rename propagation retain
their behavior. Test targets distinguish global navigation from identically
named nested pages rather than selecting whichever appears first.

## M72 — Roomy assistant, one lifecycle

**Read first:** `src/agent/AiPanel.tsx`, the chat hook/store and transcript
components it uses, `src/App.tsx`, UI store/panel sizing, existing detach,
interaction and thread tests. Confirm actual file names before editing;
do not create a second controller to avoid a layout refactor.

- [x] Agree a panel/canvas presentation state with the shell lane and add
      clear enter/return controls with meaningful labels.
- [x] Render one assistant instance across both presentations. Preserve
      drafts, selected thread, attachments, live stream and pending decisions.
- [x] Center the canvas transcript and composer near 760px; use a readable
      message hierarchy and intentional tool/result disclosure.
- [x] Keep the composer usable with short windows, long drafts and multiline
      content. Preserve send/stop/steer and keyboard behavior.
- [x] Preserve thread selection/history, context attachment, model/effort,
      approval/review cards, retry and truthful unavailable/error states.
- [x] Prove presentation changes do not create a run, answer an approval,
      detach twice, duplicate transcript events or lose the underlying page.

**Acceptance:** switch panel → canvas → panel during a streaming turn and an
open approval; the same run/thread/draft survives, events appear once, and
only the person's existing action can approve. Closing the presentation
follows CV-30; vault switch and Stop retain their current cancellation rules.
Returning to work restores the page, scroll and editing context. Thread and
conversation controls remain keyboard and screen-reader accessible.

## M73 — Home and page hierarchy

**Read first:** `src/pages/HomePage.tsx` and its lane components,
`src/pages/DocPage.tsx`, record/full-page/detail hosts, page chrome, editor
styles and typography/surface tokens. Resolve the current paths before edits.

- [x] Rework Home's title, actions, spacing and lane hierarchy for the new
      broad canvas while retaining lane membership and existing actions.
- [x] Align document/record page title, icon/cover, properties, tabs, body and
      secondary information without duplicating page headers.
- [x] Keep read/edit/save states visible and preserve all current page tools,
      comments, backlinks, history, favorites and embedded content controls.
- [x] Review long titles, large property sets, narrow pages, wide tables/code,
      optional covers and empty/unavailable states in both themes.
- [x] Verify page editing and save/Undo still work after shell, pane and
      assistant presentation changes; review screenshots of actual content.

**Acceptance:** Home stays pull-only and never presents failed reads as empty.
Page-width preferences still work; title and property editing do not lose
drafts; toolbars remain discoverable; wide embeds scroll within their own
frame. Visual changes do not widen write permissions or reroute guarded
actions through new generic handlers.

## M74 — Integration, visual audit and package

Run focused checks while lanes work. Once shared sources are stable, run the
appropriate combined checks once, fixing actual regressions before widening
again. A docs-only or style-only repair does not justify repeating unrelated
native crash tests. Keep all existing thresholds and Mac crash-test exclusions.

- [x] Typecheck all three configurations, zero-warning lint, formatting and
      focused shell/assistant/Home/page tests.
- [x] Browser flows in Chromium and WebKit: rail/context navigation;
      collapse/resize/focus; assistant presentation with drafts/streaming and
      approval; document editing/save; pane/peek/Back/Forward behavior.
- [x] Review screenshots at 900px, 1024px, 1280px, 1440px and a wide desktop,
      in light and dark themes. Check keyboard focus, contrast, overflow and
      simultaneous page/detail/assistant states. Separate browser zoom and
      OS reduced-motion acceptance are not claimed by these screenshots.
- [x] Walk all existing destinations and verify navigation/commands remain
      reachable. Record each deeper surface's visual status below.
- [x] Build the ordinary **Cerebro.app** with the normal production resource
      map, without installing or launching against a user vault. Inspect
      identifier, minimum OS, resource inventory and local signature.
- [x] Record any interactive packaged checks separately. A browser screenshot,
      successful compile or signature check does not prove native focus,
      menu/shortcut behavior or a safe vault lifecycle.
- [x] Produce a final evidence note: files changed, checks/results, reviewed
      screenshots, artifact path, outstanding surfaces and exact limitations.

### Broader visual redesign audit

The live audit expanded the initial shell/chat work into M75–M79. The table
records actual review coverage; it does not imply exhaustive testing of every
possible data set or a fresh live connection to each external service.

| Surface group | Review scope | Status |
| --- | --- | --- |
| Inbox and My work | Capture/import flows, selection, row density, keyboard actions, unavailable states | Contextual Inbox and aligned My work implemented; both themes, editing/Undo and existing ingestion flows passed |
| Databases and views | Table/list/board/calendar/time-grid/chart chrome, filters, forms, empty states | Shared headers/tabs implemented; existing view flows and state-lab presets passed; light/dark database screenshots reviewed |
| Knowledge and Library | Concepts/review/activity; agents, skills and run detail; guarded decisions | Shared hierarchy/cards implemented; focused units, existing Knowledge flows and light/dark Library/Knowledge/Agents review passed |
| Work and History | Repository navigation, diffs, editors, activity attribution and conflicts | Contextual explorer and History header implemented; workspace/viewer flows, keyboard focus and both themes passed |
| Settings and services | Dense settings, connectors, access tokens, imports and correspondence | Eleven contextual sections implemented; retained drafts, existing settings flows, light/dark and compact focus passed; live services not reauthenticated |
| Media, sheets and whiteboards | Viewer headers, toolbars, overlays, selection and embedded controls | Viewer/whiteboard chrome implemented; browser viewer flows and both themes reviewed; calculated sheet inspected and retained |
| Shared overlays | Palette, menus, dialogs, toasts, tooltips, loading/error/empty states | Palette pointer-reflow defect fixed; sixteen final surface/overlay screenshots reviewed; existing overlay flows and all 115 state-lab presets passed |

## Verification and completion record

Checked items have the implementation evidence below. Historical M53–M70
results stay separate: they establish inherited behavior, not proof of the
new geometry. Interactive native checks remain explicitly unperformed.

| Date | Slice | Evidence | Outstanding |
| --- | --- | --- | --- |
| 2026-10-16 | Design/reference audit | Owner's screenshot direction recorded; four targeted Macro layout/chat files read; Cerebro shell/token/build seams inspected; 240px context reviewed at 1440px | Implemented; responsive browser proof below |

### Build-only command audit

From the repository root, the narrow ordinary release build is:

```sh
pnpm tauri build --ci --bundles app
```

With the current default target directory, it produces
`src-tauri/target/release/bundle/macos/Cerebro.app`. An explicit `--target`
changes that output path. On this Apple Silicon Mac,
`pnpm tauri build --ci --target aarch64-apple-darwin --bundles app` uses the
existing architecture-specific release cache and produces
`src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cerebro.app`. It runs the normal frontend build and
`src-tauri/build.rs`'s sanitized demo staging; it does not install or launch the
app. Use the repository's pinned toolchain and existing dependency install;
do not hide a toolchain mismatch behind a temporary PATH.

`scripts/mac-build.sh --no-install` also avoids install/launch, but first
installs dependencies and calls `mac-package.sh` to sign and create ZIP/DMG
artifacts. Its output includes the architecture directory. Omitting
`--no-install` is materially different: the script quits/replaces the app in
`/Applications` and launches it. `pnpm tauri dev` launches a real app and is
not a build-only verification command.

For a local test bundle, the repository's packaging flags can sign the exact
built app with `codesign --force --deep --sign -` and then verify with
`codesign --verify --deep --strict`. Ad hoc signing is not Developer ID signing
or notarization. Inspect the finished artifact before handing it over; do not
launch it as a side effect of verification.


### First-delivery verification, 2026-10-16

- Startup: normal `/opt/homebrew/bin/pnpm` 9.15.9 rejected a workspace file
  containing only `patchedDependencies`. Explicit root-only `packages: ['.']`
  fixes it without changing the IronCalc patch, lockfile or global toolchain.
  Normal `pnpm run tauri dev --help` and isolated frontend startup pass; the
  toolchain/IronCalc checks pass (32 tests).
- Shell: 144 focused tests and 27 browser scenarios pass, including the
  existing 23 panel geometry scenarios and four Chromium/WebKit rail/drawer
  scenarios. The exact 1048/1047px boundary is covered. Hidden pages remain
  mounted and inert; their keyboard scopes are excluded.
- Chat: 170 focused tests and ten new Chromium/WebKit checks pass. These
  cover the centered column, real context controls, active thread semantics,
  focus, one live turn/draft across docking, and the full ten-item queue plus
  multiline draft at 900×600. The auxiliary area scrolls so Stop stays reachable.
- Home/page/store/keymap: 157 focused tests pass; the application host's
  36 tests pass. All eight Home browser scenarios pass across a seven-test
  successful run and the one corrected icon-label assertion rerun. The
  editing scenario saves five real mock-file revisions and reopens the page.
- Document geometry: four checked-in Chromium/WebKit scenarios pass in both
  themes across 900, 1024, 1280, 1440 and 1920px widths, with no document-level
  horizontal overflow. Actual Home, chat, document and narrow-drawer images
  were inspected in light and dark.
- Full unit run: 721 files passed, with 14,190 tests passing and 15 skipped.
  Ten tests in the remaining recorder file failed because the sandbox refused
  `ps` (`EPERM`). That file then passed all 35 tests with process access; it
  uses stand-in subprocesses, not live Claude authentication.
- Browser navigation migration is complete for the formerly all-in-one
  sidebar assumptions. Existing assertions remain; helpers use actual rail,
  context and keyboard controls rather than mutating application stores.
- This first delivery produced an intermediate native bundle. Final source,
  build and acceptance status are recorded below. Live CLI verification stays
  deferred at the owner's request.


### Further visual slices from the live audit

Seven initial 1440×1000 screenshots of Inbox (empty and selected), My work,
Knowledge, Library, databases and Settings exposed the following additional
work. These slices are now implemented and verified below.

| Milestone | Concrete next change | Existing behavior to preserve | State |
| --- | --- | --- | --- |
| M75 | Inbox: put the capture queue/filter in context and make Organize collapsible. | Import/capture, selection, organization, checklist, Undo, keyboard actions, failed-read states | Implemented; verified |
| M76 | Settings: actual settings sections in context and readable detail pages. | Every setting, persisted values, security explanations, connector/token controls and truthful native availability | Implemented; verified |
| M77 | Shared title/subtitle/actions, aligned My work rows, clearer Library cards and contextual Studio navigation. | Full-width tables, list cursor/selection/peek, due-date facts, agent grants and operational state | Implemented; verified |
| M78 | Database and Knowledge header/toolbar polish with readable wrapping summaries. | Filters, all view types, property editing, guarded Verify/Allow, queue membership and unavailable states | Implemented; verified |

M79 covers Work/History and media/whiteboard chrome. The calculated-sheet grid
was reviewed and retained. Quick Open keeps its design, with a pointer-reflow
selection bug repaired during verification. Connected-service controls now
live in Settings sections; their permissions remain unchanged.


### Final implementation verification, 2026-10-16

- The full browser pass ran 563 checks: 552 passed and 11 failed. All failed
  scenarios subsequently passed targeted reruns. Repairs covered old
  all-visible-navigation assumptions, measured pane capacity, the Add context
  caret race and a real palette hover/reflow race. The unchanged 115-preset
  state-lab check passed in 57 seconds in isolation after its aggregate run
  timed out under load. No assertion, timeout or coverage threshold was weakened.
- M75: 134 focused units, a final 77-test focus replay, six Chromium/WebKit
  behavior scenarios and eight existing capture/document-ingestion checks
  passed. Fresh wide and narrow light/dark screenshots were inspected. Reader
  title scale is 32px; capture metadata is 15px. Editing and Undo retain the
  same editor through context and Organize changes.
- M76: 85 focused Settings/palette/Mail tests passed, alongside existing
  settings workflows and both browser engines. Section drafts survive
  navigation. Compact drawers restore focus to a usable detail control. The
  former intermittent palette flow passed three consecutive reruns after the
  pointer-movement fix; intentional pointer selection remains tested.
- M77/M78: 64 focused My work/Library/Knowledge/Type tests and 72
  List/Collection/Agents/Studio/ViewTabs tests passed. Sixteen existing
  Knowledge, Studio and saved-view browser flows passed. The final 14
  Chromium/WebKit visual-page scenarios cover light/dark document geometry at
  five widths, rich content/long titles/covers/tables/code, four main surfaces
  at 1440/900px, and Studio context focus with unchanged preview/file bytes.
  All 75 focused DocPage/Studio units passed after final typography changes.
- M79: 31 Work/viewer browser checks and 63 focused units passed, followed by
  two final compact-focus browser checks and 11 Workspace/Button units. The
  existing explorer controller moves into context; file selection and opening
  a mount dialog dismiss the narrow drawer. Whiteboard and media controls
  retain their existing actions and accessible pressed state.
- Additional final review inspected sixteen light/dark screenshots of
  Collections, Agents, Studio gallery/preview, palette, page menus, creation
  launcher and New page dialog. No clipping, document overflow or page errors
  were found. Actual calculated-sheet content was also inspected.
- The shared page-navigation seam lends navigation only from the active pane.
  Inbox, Settings, Work and open Studio projects use it; Assistant canvas
  takes priority. Explicit opener/focus handling works in WebKit as well as
  Chromium. Hidden/parked page key scopes remain excluded, while a page-owned
  navigation drawer retains its owning page's keys without bypassing modals.
- Final `pnpm lint`, `pnpm typecheck` (all three configurations),
  `pnpm format:check` and `git diff --check` passed. No Rust source changes
  were required for this redesign. The final regular bundle was rebuilt from
  frozen M71–M79 sources; earlier M71–M74 bundles are intermediate.

### Local evidence and remaining acceptance

Browser evidence is in `/private/tmp/cerebro-visual-pages-final`,
`/private/tmp/cerebro-m75-current-visuals`,
`/private/tmp/cerebro-m75-final-proof`,
`/private/tmp/cerebro-m76-final-ui`,
`/private/tmp/cerebro-m76-compact-final`,
`/private/tmp/cerebro-m79-browser` and
`/private/tmp/cerebro-final-surface-audit`.

The final build log is `/private/tmp/cerebro-m79-mac-build.log`; source
snapshot metadata is `/private/tmp/cerebro-m79-build-source.json`. The final
build and package checks completed on 2026-10-16:

- Artifact: `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Cerebro.app`.
- All 2,213 snapshotted production source/config files were unchanged across
  the build. Embedded assets are `index-xIj48RB0.js` and `index-ChRIBuEO.css`.
- All 141 demo files match source, sanitized stage and actual bundle byte for
  byte. The bundle has 142 resource files, no private/runtime mail paths and
  no symlinks.
- Metadata: arm64, `com.cerebro.app`, macOS minimum 14.0, expected `cerebro`
  URL scheme. Executable SHA-256:
  `9f8c6163d6f350f2b8e64a52287935bc82b5889bb170a4b5a37ec48626a835d9`.
- Ad hoc signed at 08:07:55 PDT and verified at 08:08:19 PDT with
  `codesign --verify --deep --strict --verbose=2`: valid on disk and satisfies
  its designated requirement. This is a local signature, not Developer ID or
  notarization.
- Detailed records: `/private/tmp/cerebro-m79-build-source-check.json`,
  `/private/tmp/cerebro-m79-bundle-inventory.json`,
  `/private/tmp/cerebro-m79-bundle-metadata.json` and
  `/private/tmp/cerebro-m79-codesign-verify.log`.

Task-owned verification servers were stopped; unrelated dev servers were left
alone. The demo-vault working diff is empty.

Interactive packaged behavior (native window/menu/focus, external-link/CSP
handling and real user-vault lifecycle) has not been reverified. Separate
browser zoom and OS reduced-motion acceptance are also not claimed. The app
is built without installing or launching it. Live Claude CLI verification
remains deferred by the owner, and no external service was reauthenticated.
The implementation does not depend on those deferred checks, but a build or
browser pass must not be represented as their completion.

HEAD remains `9196fe3`. No agent staged or committed changes. The index was
observed changing externally during this work and was preserved as found.
