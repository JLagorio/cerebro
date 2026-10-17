# Cerebro surface system and quality

**Status: draft for owner review, 2026-10-17.** This is a proposed design contract,
not an implementation or a claim of visual acceptance. Proposed allocation:
**M84 — foundation and approved specimens; M89 — remaining surfaces;
M90 — integrated visual and native acceptance.** The [milestone plan](../plans/2026-10-17-m84-m90-product-polish.md) defines sequencing. M71–M79 and M80–M83 already have implementation plans and must
not be reused.

This specification covers the common visual system and the surfaces around the
document and database experience. The companion page/editor and data-view
specifications own those workflows in depth. Changes use existing controllers,
readers and write doors; they do not introduce another shell, editor or agent.

## 1. What the audit establishes

The existing redesign improved the frame, navigation and several headline
surfaces. The remaining issue is consistency inside that frame: individual
features still choose their own typography, headers, action shapes, metadata
density and state presentation. That is a design judgment supported by these
source observations:

Code paths in the following evidence table are relative to `src/`.

| Observation                                                         | Evidence and implication                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header geometry varies without a declared family contract.          | `components/pageHeader.css:1–41` supplies a 24px heading and 32/24/20px padding; `pages/inbox.css:1–16` uses an 86px header; `agent/chat.css:16–22` uses 58px; `pages/pages.css:177–181` gives document utilities 52px; `whiteboard/canvasChrome.css:1–11` uses 64px. Different tasks can justify differences, but they need intentional roles. |
| Surface location changes primitive appearance.                      | `components/pageHeader.css:62–66` turns child Buttons into pills; `pages/workspacePages.css:92–101` changes Library segmented controls; `pages/settings.css:104–107` changes every descendant `.text-xs` to 13/20px. These are migration seams for explicit variants.                                                                           |
| Some title utilities are absent from the theme.                     | `styles/index.css:28,124–132` resets the text scale and defines no `text-base`; it appears in `pages/FilePage.tsx:40`, `library/LibraryIndex.tsx:338`, `detail/TabSections.tsx:139` and `app/CreateLauncher.tsx:139`. No corresponding rule was found in the existing built CSS. Confirm computed styles during implementation.                 |
| Readable uncertainty and permission explanations use weak contrast. | Light `n-500` is 3.65:1 on white and 3.41:1 on the sunken surface. It appears in roster uncertainty, wake reasons, Settings permission explanations and History failures. `styles/tokens/colors.css:175–183` already provides `text-meta` for readable small text.                                                                              |
| Shared filled controls lose contrast in dark interaction states.    | `components/ui/Button.tsx:16–27` keeps white labels. Dark accent values at `styles/tokens/colors.css:361–363` produce 5.60:1 resting, 3.59:1 hover and 2.31:1 pressed. Dark danger values at lines 287–289 produce 3.46/2.63/1.89:1. These are calculated sRGB ratios, not browser measurements.                                                |
| Motion and local responsiveness have gaps.                          | Dialog's translating entrance (`components/ui/Dialog.tsx:8–17`) and Switch's thumb (`Switch.tsx:8–18`) are outside the existing movement reduction. Whiteboard heading responds to viewport width (`whiteboard/canvasChrome.css:104`), although a pane can be narrow inside a wide window.                                                      |

The audit also found stale layout tokens (`spacing.css:32–38` still declares
56px rail/264px sidebar) and a comment claiming there is no dark theme
(`colors.css:98–101`). Correct touched documentation under CV-11. Do not build
another abstraction on misleading names.

The recorded M71–M83 verification includes real browser flows, screenshots and
geometry assertions. It does not claim interactive native acceptance. Current
screenshots are primarily captured evidence: no `toHaveScreenshot` assertion
was found in the inspected e2e tree. This distinguishes an opportunity for a
durable visual contract from an assertion that prior testing did not happen.

## 2. Direction and retained decisions

Retain the **54px rail, 240px default resizable contextual sidebar, Instrument
Sans, IBM Plex Mono, cortex/synapse vocabulary, light/dark/system themes and
existing navigation model**. The next pass should feel like one professionally
composed workspace: clear titles, readable facts, aligned rows, restrained
surfaces and predictable controls. More cards, smaller text and more hidden
actions are not measures of polish.

Macro's useful reference is its composition discipline. Its
`components/view-shell/README.md`, `ViewSidebar.tsx:26–117,136–264` and
`apps/web/src/index.css:21–35`, under `docs/examples/macro-main/`, describe shared
header/content/row/icon/trailing-control slots and derive their alignment from
common tokens. Cerebro should adapt that principle using its own geometry and
React components. Its `ListSkeleton.tsx:4–17` also illustrates stable, labeled
loading geometry with decorative content hidden from assistive technology.
No reference code, assets, remote services or cloud data model is required.

The proposed sizes below are review targets. M84 must show them in actual
representative content before they become implementation constraints. Approval
of this specification does not mean every pixel value has already been seen.

## 3. M84 — foundation and approved specimens

### Typography, color and density

Use roles that pair size, line height and weight. Suggested starting scale:

| Role                        | Proposed default           | Use                                                                    |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| Document title              | 32/40px, 600               | Authored page title; long titles wrap.                                 |
| Workspace title             | 24/32px, 550–600           | Home, Library, Knowledge and other destination headings.               |
| Section title               | 16/24px, 600               | Major sections inside a workspace.                                     |
| Interface label / row title | 14/20px, 400–500           | Navigation, readable controls and primary list text.                   |
| Compact label / metadata    | 12/18px, 400–500           | Secondary facts, with sufficient contrast.                             |
| Ordinary prose              | 16/26–28px, 400            | Full-page reading; renderer-specific compact variants remain explicit. |
| Tertiary technical metadata | 11/16px, mono where useful | IDs/timestamps that are not essential to a decision.                   |

Do not place a failure explanation, permission scope, review reason or pending
decision at the tertiary level. Use tabular numerals for aligned counts and
dates. Avoid uppercase labels and mono text where they impair ordinary reading.
Existing document-width preferences remain authoritative.

Define semantic surface, ink, border, focus and **fill/on-fill pairs for every
interactive state**. Do not derive button hover fills from a link-ink ramp.
Require 4.5:1 for ordinary text and 3:1 for meaningful non-text controls and
focus indicators; inspect actual composited backgrounds and disabled exceptions
separately. Selection, focus, loading and errors need distinguishable shapes or
labels as well as color. Keep accent fills for meaningful action and selection.

Density belongs to a task family. Default controls are 32px high, compact
controls 28px, primary comfortable controls 36px; icon targets are at least
28px by default, 32px in main toolbars. Any 24px dense control needs explicit
spacing and usability review. Do not globally enlarge spreadsheet cells or
shrink prose to satisfy a shell measurement.

### Scoped composition contracts

These are proposed component responsibilities, not a requirement to create one
component per name. Extend an existing component when it already owns the seam.

| Composition            | Proposed anatomy and states                                                                                                                                                             | Adoption                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Page frame and header  | Shared horizontal inset, title/description/metadata/actions slots; 24px standard or 40–48px reading inset according to available width. Actions wrap before title becomes unusable.     | Extend `PageHeader`; map workspace, document utility and tool-canvas variants explicitly.                                         |
| Navigation row/section | 34–36px row, 20px icon slot/16px glyph, 8px label gap, aligned trailing controls, 24px section separation. Current, hover, keyboard focus, disabled, loading, expanded and drag states. | `sidebarChrome`, `SectionHeader`, Settings, Inbox, Studio, Work and conversation navigation.                                      |
| Toolbar                | 40–44px baseline with 32px controls; title/navigation, view controls and actions have separate groups. Explicit overflow priority and accessible group labels.                          | Lists, viewers, History filters, Inbox and canvas utilities; data-view specification controls database specifics.                 |
| Setting / control row  | Label, value/control, help and error slots; common baseline and gaps. Single-line minimum 40px, grows for help or multiline content.                                                    | Settings and inspectors; record properties use the page spec's 32–36px role, and specialized grant editors retain their behavior. |
| State message          | Compact inline, panel and page presentations; icon optional, readable title/reason, recovery action.                                                                                    | Existing section readers and file/viewer states; not a new reader or state machine.                                               |
| Decision card          | Actor/origin, proposed action, affected subject, consequence, status and explicit actions. Detail disclosure supplements a useful collapsed summary.                                    | Knowledge proposals, assistant approvals and related review surfaces.                                                             |
| Viewer chrome          | Identity/location, viewing status, format controls and file actions; one coherent frame around type-specific content.                                                                   | FilePage, Work viewers, PDF/media, diagrams and boards.                                                                           |

New styling must not depend on `data-testid`, incidental DOM position or
redefining a utility such as `.text-xs` for an entire subtree. Keep existing
Popover placement, layers/Escape ownership, keymap and controller lifecycles.
Do not replace specialized rows with generic Buttons if that loses selection,
editing, drag or semantic behavior.

### Approval specimens

Before broad migration, prepare reviewable specimens for a document with
properties/table/details, a populated database, a grouped work list, Knowledge
review, an active assistant with a pending decision, and Inbox/Settings.
Use current mock-backed content, plus isolated stress fixtures for long names,
missing values and dense content; do not churn `demo-vault` for aesthetics.
Show light/dark at 1440px and the native 900px minimum, plus one split-pane
case. A specimen must show hover, focus, open menu and error states, not only
an idle screenshot. Record accepted choices and unresolved alternatives.

**M84 exits when** the owner has reviewed complete representative compositions,
the token/component ownership map is explicit, known contrast/typography gaps
are repaired in the selected real consumers, and their states are browser-verified.
The main workflow specifications then use the same approved roles. M84 begins
only after this draft is reviewed; its internal specimen review precedes broad adoption.

## 4. M89 — remaining surfaces and adoption map

M89 applies the approved system after the flagship page and data workflows
establish it. It is not another independent visual direction.

| Surface and current seam                                                                                                  | Required result and preserved behavior                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell/context: `app/Sidebar`, `AppRail`, `PageNavigation`                                                                 | Consistent icon rails, row geometry, section actions and focus/current states. Keep every destination, saved folds/widths, navigation identity and active-pane ownership. Context collapse never removes global wayfinding.                                             |
| Home: `pages/HomePage`, `pages/home/*`                                                                                    | Clear entry and lane hierarchy, aligned task/event facts and quiet actions. Preserve `HOME_LANES`, pull-only reads, silent empty lanes, independent failures and no sidebar count. Review a populated Home, not just its greeting.                                      |
| Inbox: `pages/InboxPage`, `inbox.css`                                                                                     | Queue title/source/time hierarchy, readable selected capture, coherent reader and organize inspector. Keep queue keyboard flow, drafts, import/native drop paths and actual organizing decisions.                                                                       |
| My work: `pages/MyWorkPage`, `workspacePages.css`                                                                         | Shared work-row rhythm with due/status facts that remain readable at narrow widths. Preserve capability-derived membership, real date semantics and existing human writes/Undo.                                                                                         |
| Knowledge: `KnowledgePage`, `knowledge/*`, `status/*`                                                                     | Concepts, Review and Activity share edges and hierarchy. Preserve review reasons/order, visible pending decisions, guarded Verify, System fold, independent unavailable states and tab/run navigation identity.                                                         |
| Library and Agents: `library/LibraryIndex`, `pages/AgentsPage`                                                            | Stronger title than description, meaningful tags and duty controls; lobby distinguishes agents, waiting work, future work and recent runs. Preserve off-duty/paused/background-paused/unknown distinctions, grants on Done, born-paused creation and page-based agents. |
| Assistant: `agent/AiPanel`, `chat.css`, tool/result renderers                                                             | Refine active transcripts, rich results, errors and approvals as thoroughly as welcome. Preserve one input/controller/run, drafts, attachments, scroll intention, Stop/Steer and explicit approval through panel/canvas changes.                                        |
| Settings: `SettingsPage`, `SettingsNavigation`, settings sections                                                         | Consistent label/help/control/error anatomy across all eleven sections; pending and saved states clear. Permission explanations remain readable, and switching sections retains drafts.                                                                                 |
| Work: `WorkspacePage`, `EditorGroups`, `TabBar`, `Breadcrumb`                                                             | Intentional hierarchy across destination header, tabs, location and file controls. Preserve root identity, preview/pinned tabs, find/copy/wrap, split groups and focused-pane behavior.                                                                                 |
| Studio: `StudioPage`                                                                                                      | Project/page identity, build/edit actions and preview match common reading/chrome roles; loading and unreadable previews are visible. Keep file-backed markdown/board previews and existing assistant entry.                                                            |
| History/git: `PulsePage`, `history/*`, `git/*`                                                                            | Clear day/actor/change/run/checkpoint hierarchy and readable attribution. Keep quiet days distinct from unrecorded days, independent read failures, diff selection and truthful provenance.                                                                             |
| Files/media/PDF: `FilePage`, `workspace/viewers/*`, `FileLightbox`                                                        | Consistent identity/actions, long-name handling, media aspect ratios and readable controls. Design bounded/partial/unsupported/large/loading/error modes. Preserve Open allow/confirm/deny, containment, remote-image permission and native file actions.               |
| Boards/diagrams: `CanvasPage`, `DiagramPage`, `whiteboard/*`, `mermaid/*`                                                 | Coherent tools, inspector, zoom/status and selection at actual pane widths. Include read-only, held outside changes, malformed content and save failure. Opening/panning/zooming still writes nothing.                                                                  |
| Search/command palette: `app/QuickOpen`                                                                                   | Readable result title/location/snippet hierarchy, keyboard-selected result, query progress, no results and failure; distinguish navigation, commands and content matches. Keep existing ranking, scope, recent behavior and shortcuts.                                  |
| Creation/import/rename: `CreateLauncher`, `CreateMenu`, `RecordComposer`, import dialogs, `RenameLinksHost`, `MoveDialog` | Consistent field/action hierarchy, validation, busy/progress and outcome summaries; long destination names and loss reports remain legible. Preserve carrier capabilities, checked batches, conflicts, explicit choices and cancel behavior.                            |
| Overlays/transient UI: `components/ui/*`, `ToastHost`, destructive/Trash dialogs                                          | Common menu/dialog/popover/toast spacing and action priority, nested Escape/focus return, short-window scrolling and readable errors. No consequence exists only in a tooltip; no essential action exists only on hover.                                                |

Progressive disclosure removes repeated explanation from the primary scan path,
not facts necessary to decide. A collapsed decision still says who proposes
what, where, its state and how to inspect it. A failure is never folded into
an ordinary empty-state decoration. A compact row must provide a reachable
way to read truncated values. Simplify technical wording while retaining
authority, provenance, partial-result and loss facts.

**M89 exits when** every row has an explicit adopted variant or documented
exception, representative interactions and states have browser evidence, and
no functional contract was changed merely to make a screenshot cleaner.

## 5. M90 — integrated visual and native acceptance

### State, layout and accessibility matrix

Use the existing state lab's ready, empty, not recorded, partial and unavailable
presets. Add loading, saving/save-failed, stale, read-only, missing and busy
specimens only where those states actually exist. Stable loading geometry and
status announcements must not invent results or turn fast local reads into
unnecessary animated delays. Give failures a clear scope and recovery action
when one exists.

Responsive behavior is based on **available pane width**, not only viewport.
Check 900/1024/1280/1440/wide windows; one, two and four panes; details, peek and
assistant combinations; parked/inert surfaces; short windows; and
125/150/200% zoom. Define which controls wrap or move to overflow. Save, Cancel,
Stop and pending-decision actions remain reachable. Tables/code/media own
intentional horizontal scrolling; ordinary page chrome does not overflow.

Review keyboard-only use, visible focus, logical focus return, screen-reader
names and state announcements, text selection and drag affordances in both
themes. Reduced motion covers dialogs, drawers, switches, disclosures, loading
indicators and view changes. Removing motion must retain useful progress and
selection information. Preserve the existing keymap and layer ownership.

### Visual acceptance rubric

Every flagship specimen receives an explicit pass or revision-needed judgment:

1. **Hierarchy:** the title, content and primary next action are immediately
   distinguishable; required facts do not compete with decorative chrome.
2. **Alignment:** shared edges, baselines, icon lanes and action geometry hold
   across adjacent surfaces and across state changes.
3. **Readability:** typography, contrast, wrapping and density hold with real
   content, long values and both themes, including hover/pressed states.
4. **Interaction:** selection/focus/editing/busy states are clear; controls are
   discoverable, comfortable and reachable without a pointer.
5. **Resilience:** narrow panes, zoom, failures and partial content remain
   useful; no disappearing decisions, clipped controls or false empty claims.
6. **Consistency:** the surface uses approved roles; deviations have a task
   reason and remain coherent with the rest of Cerebro.

Keep a durable evidence index with specimen ID, state, viewport/pane geometry,
theme, font readiness, source revision, screenshot and reviewer outcome.
Introduce a small deterministic visual-regression set over approved specimens;
pin clock/content/fonts and retain focused geometry/interaction assertions.
Do not silently accept all regenerated screenshots. Test counts and successful
image capture are not owner design acceptance.

### Browser and native proof are separate

Follow `verify-ui` using isolated ports and Chromium/WebKit. Browser tests prove
layout, focus, gestures and mock-backed save/Undo behavior. A packaged build
proves packaging; it does not prove the native experience.

Native acceptance uses a disposable vault and separately records window/titlebar
behavior, menus, app-switch focus, close/quit save handling, file dialogs/drop,
Quick Look/external links/CSP, OS appearance and reduced motion. Do not install
over the owner's app or open their real vault as an incidental verification
step. Existing live CLI/service-account deferrals remain recorded; they are
neither silently approved nor prerequisites for reviewing this design.

**M90 exits when** the approved visual rubric passes, the relevant regression
gate is green, all touched workflows preserve their behavior, and the evidence
ledger distinguishes completed browser proof, completed native proof and any
explicitly outstanding acceptance. Remaining acceptance cannot be relabeled
complete by producing another signed bundle.
