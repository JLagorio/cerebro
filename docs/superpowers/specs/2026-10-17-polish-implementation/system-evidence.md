# M84 / M89 implementation evidence — system agent

Implementation is authorized by the owner's all-M84–M90 instruction. No staging,
commit, branch switch, native installation, or owner-application launch by this
agent. The original specifications remain design-review records; the initial
pixel proposals were implemented and tested without a new authorization pause.
Owner aesthetic acceptance and packaged-native acceptance remain separate.

## Foundation contracts

- Instrument Sans and IBM Plex Mono retained. No global body-size change.
- Numeric font scale retained; explicit paired role utilities: page title32/40,
  workspace title24/32, section16/24, UI14/20, metadata12/18, prose16/28.
  `text-metadata` intentionally avoids the existing `--text-meta` ink namespace.
  `text-base` now produces real14/20CSS; theme guard detects unmapped size classes.
- Rail remains54px and context default240px. Unused contradictory layout constants
  removed; CSS rail consumes the54px token. No pane sizing/history/controller rewrite.
- Shared Button sm28/md32/lg36; default Button/Input/Select14px, explicit compact
  controls12px. Menu items14px/min32. IconButton dimensions retained and existing
  active state is exposed as aria-pressed. Existing focus/layer/key models retained.
- Filled primary/danger controls have independent fill/on-fill resting, hover,
  pressed roles. Link ink ramps no longer choose the Button fill. Utility aliases
  let specialized editor/data controls consume the same pairs; their owners
  migrated the corresponding sites. Shared Calendar selected-day ink fixed.
- Readable muted and placeholder ink uses n600. Warning/critical decision labels
  use readable700ink; actual disabled ink remains disabled. Static sRGB contract
  covers ordinary semantic ink on app/board/sunken/raised, three action states,
  and warning/danger/success ink-on-tint in light/dark. Browser measures primary
  rest/hover/press on the real Library action, not only token source strings.
- PageHeader has explicit workspace/compact/tool roles; removed child Button pill
  and minimum-size overrides. Library segmented control no longer picks a shape
  by its location. Settings no longer globally redefines descendant `.text-xs`.
- StateMessage is presentation-only with loading/empty/not-recorded/partial/
  unavailable vocabulary, readable title/reason and optional existing recovery.
  No new read state machine or write channel.
- Dialog/Switch/section-chevron movement now reaches reduced-motion tokens;
  decorative spinners stop under reduced motion, with textual running state.
  Dialog fits short viewport using bounded edge/max-height. Hover20ms retained.
- WebKit exposed a real focus bug: mouse-opening New left the previous control
  focused and restored it later. Rail New/Search now focus their explicit opener
  before showing the existing overlay. Shared focus restoration itself unchanged.
- Document Details missing preference now defaults closed; explicit persisted
  true/false and separate concept preference remain authoritative.

## M89 adoption map and adverse-state disposition

| Surface                              | Concrete adoption / retained specialty                                                                                                                                                                                                                                                                               | Adverse-state evidence                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell / context                      | 54px rail token,34px/14px nav rows, common section label ink, motion-aware chevrons, explicit New/Search focus target. Existing destinations/folds/widths/active-pane portal and drawers retained.                                                                                                                   | Foundation WebKit uncovered/fixed opener restoration. Existing Inbox/Settings/Work narrow drawer flows are rerun; root integrated zoom checks own parked panes.                                                                                                                                                                                                        |
| Home                                 | 24/32workspace heading, bounded960px content,48px useful rows,14px primary text,12px facts, round readable task checkbox, StateMessage failure. Silent empty lanes, order, pull-only reads/no sidebarcount retained.                                                                                                 | Home state-lab all five states in each theme; populated Home1440/900 geometry and creation/search entry flows. Intentional content max changes from840 to880innerpx; existing geometry assertion updated.                                                                                                                                                              |
| Inbox                                | 80px workspace header/72local compact, shared title/meta roles, readable queue source/time and organizing explanations. Reader/organize split, drafts, capture arrows/j-k, file doors unchanged.                                                                                                                     | Three existing browser flows prove narrow queue, same editor retained across Organize fold, and active-pane scope. Unit inherited data/error paths remain controllers' tests.                                                                                                                                                                                          |
| My work                              | 14/20title with two-line wrapping,48px minimum rows,12/18due facts, consistent groups and local560px grid adaptation. Capability-derived membership, unknown dates, cursor/peek/writes unchanged.                                                                                                                    | Home uses same underlying work facts and five state fixtures; engine/unit invalid dates and absent status remain preserved. Final surface-system browser cases in Chromium and WebKit check a seeded long title at600px, two-line40pxmaximum wrapping, minimum48pxrow, invalid-date wording, separate title/deadline bounds and no horizontal overflow in both themes. |
| Knowledge                            | Readable headline/summary/reasons; review cards16pxheadline/14pxreason/12pxrisk, semantic uncertainty ink, existing System fold retained. Actual bug repaired: unknown proposal count no longer becomes0; total withheld until both proposal/write reads known, loading/unavailable named.                           | New targeted Knowledge test fails review_queue and asserts proposals unavailable/no false nothing-to-review/absenttotal. Existing pending-write failure assertion strengthened; tests await settled reads before asserting complete totals.                                                                                                                            |
| Library / Agents                     | Library16pxtitles,14pxdescription, readable duty/risk tags, default segmented control; bounded Agents content with explicit Your agents and Recent runs headings,72px roster row, readable duty/unknown facts. Existing born-paused creation and grant writes untouched.                                             | Library real consumer light/dark control proof; agent-spend all five presets (including unmetered/unknown) in both themes; new snapshots retain partial-state words. Existing Agents unit suite passed.                                                                                                                                                                |
| Assistant                            | Semantic classes replace CSS dependent on conversation/action/run-option test IDs. Active tool groups36px, readable interrupted/waiting states, full wrapping permission targets, shared16pxpad/14pxdecision cards,12pxreasons/refusals. Existing one controller/thread/draft/Stop/Steer/Allow boundaries unchanged. | Existing chat-canvas suite exercises live docking, drafts, full queue/short window, context completion, and pending approval persisting through presentation changes; decision tests verify Allow/Deny and refused input semantics.                                                                                                                                    |
| Settings                             | Explicit14/20help roles and common label/control rows,12pxsection labels,34pxnav; permission copy uses readable semantic ink in General/Vault/Knowledge/Reminders/Shortcuts/History/Trash/Assistant/Mail/Other apps/About. Removed broad font override.                                                              | Existing Settings browser suite checks unsaved local drafts, sectiondrawer focus, theme reload, permission selection,900x600. Targeted Settings unit suite passed. Native-only CLI history remains explicit desktop-only and unchanged.                                                                                                                                |
| Work                                 | Tool identity16px, metadata12px, file-toolbar group explicitly named. TabBar/Breadcrumb/root identity and focused editor lifecycle retained.                                                                                                                                                                         | Existing browser suite mounts isolated fake root, switches README/image/CSV, preserves file viewer through narrow drawer and uses actual root/file actions.                                                                                                                                                                                                            |
| Studio                               | Explicit compact/workspace PageHeader variant, shared navigation and list text; visible loading and unavailable preview. Existing index/page/board reader and assistant Build entry retained.                                                                                                                        | Studio unit suite passed live preview, errors and creation. Final Studio e2e passed creation, live preview after external mock write, and Build handoff to the existing assistant. No iframe or publishing workflow added.                                                                                                                                             |
| History / git                        | History scoped container response, readable independent failures and attribution, actual loading labels for heatmap/feed; small technical timestamps stay compact. Existing day/session/run/checkpoint folds and undo/diff controls unchanged.                                                                       | History-feed five presets in each theme, independent unavailable vs unknown; ActivityFeed/Heatmap unit suites passed. Existing Work-surfaces History/whiteboard browser checks rerun.                                                                                                                                                                                  |
| Files / media / PDF                  | FilePage explicit tool header with wrap-capable identity/location; readable loading and bounded/unavailable modes for FileViewer, large image, media, PDF. Existing zoom/find/outline/type renderers and native allow/confirm/deny Open/Reveal/QuickLook/Save-copy doors unchanged.                                  | FileViewer/PdfViewer unit suites include missing, encrypted/corrupt, engine/text absence and read errors. Existing image/CSV browser controls rerun. Browser tests are not proof of native dialogs or navigation guards.                                                                                                                                               |
| Boards / diagrams                    | Whiteboard heading now reacts to local pane width, readable16pxtitle/12pxstatus, wrap-capable identity; diagram tool header wraps. Failed diagram read now says Diagram unavailable instead of falsely asserting deletion.                                                                                           | Diagram unit suite passed including unreadable diagram; existing browser History/whiteboard verifies opening and panning do not write, controls fit wide/narrow. Editing/persistence engines untouched.                                                                                                                                                                |
| Search / command palette             | 14pxresulttitle, readable no-results/failure and12pxgroup labels; existing in-pagepath/snippet/shortcut distinction and async highlight model retained.                                                                                                                                                              | QuickOpen unit suite passed (late result/failure/keyboard mechanics); foundation opens/closes actualNew keyboard/modal paths. All six final quick-open-content browser cases passed, including failed search, late arrivals retaining highlight, expansion, and Enter navigation.                                                                                      |
| Creation / import / rename           | CreateLauncher explicit16pxtitle/14pxdescription/landingexplanation; CSV/ICS/sheet import explanations readable. Every consumer inherits bounded Dialog and paired action roles. Rename host intentionally retained markup/controller; no fake preview or altered target.                                            | CreateLauncher unit suite passed. Final CSV tests passed quoted import/one Undo and malformed-row/no-write. All six rename-link browser cases passed, including cancellation, stale-citer refusal, exact-byte Undo and whiteboard citer preservation. Sheet/ICS controllers were not changed; native file-picker dialogs await native evidence.                        |
| Menus / tooltips / toasts / popovers | Menu14px/min32, existing roving/focus/placement/layer ownership retained; Toast14/20title,12/18description and viewport bound, no duplicate live-region. Tooltip/Popover specialized models retained.                                                                                                                | Menu/Input/StateMessage unit tests pass; New Escape restores explicit opener in both browsers. Existing root integrated flows cover menus, failed save and retries.                                                                                                                                                                                                    |

## Verification at report creation

- Foundation browser:2Chromium +2WebKit passed before final integration pass.
- First targeted behavior batch:206tests passed (11suites).
- Follow-up:62passed and one whole-tree radiusguard found editor's bare rounded;
  owner fixed it. Final focused run43passed, zerofailed (theme/Knowledge/Input/Menu).
- TypeScript app check passed after resolving an unused loading import; root owns
  final app/tools/engine/fullgate.
- Owned TS/TSX ESLint zero errors/warnings after omitting CSS from explicit list.
- Earlier broad browser acceptance and provisional screenshot baselines are retained at
  `/private/tmp/cerebro-m90/system-adoption-first`; results appended separately.
- Baselines: Library light +agent partial light, Chromium and WebKit, macOS-only,
  bundled fonts/pinnedclock,100pixelmaximumdifference. Must be visually inspected
  before acceptance; source images belong under e2e/spec-snapshots. This is agent
  verification, not owner aesthetic acceptance.

## Finalization update

Source is stable as of the final M89 cleanup. App, tools and engine TypeScript
checks passed. Owned-file ESLint passed with zero warnings. The cleanup unit
run passed 55 tests with no failures, including Mail settings, SyncBadge, fleet,
follow-up and wake states, theme utility guards, and semantic contrast pairs.
Two old assertions were updated to distinguish visible loading from measured
empty; the expanded color utility guard deliberately excludes directional
border widths while now checking semantic surface/action names and n-0.

The broad browser run passed 47 of 48 cases. The single failure was the Settings
centering assertion using the outer box instead of WebKit's scrollport: a 10px
native scrollbar shifts the outer center by 5px. The corrected assertion measures
clientWidth, matching Home's existing measurement. The focused rerun passed all
6 cases across Chromium and WebKit, including screenshot comparisons without
updating snapshots. Retained output:

- `/private/tmp/cerebro-m90/system-adoption-first`
- `/private/tmp/cerebro-m90/system-baseline-verify`

All four new macOS baseline images (Library foundation and partial Agent state,
Chromium and WebKit) were opened with view_image and inspected. No overlap or
cropping was found, and unknown/unmetered facts remain visible. This is
provisional agent review, not owner aesthetic acceptance. Native behavior is not
claimed by these browser results.

Last visual inspection found Mail's old raw select used the nonexistent
`bg-surface-base` utility and a compact font. Both Mail selects now consume the
shared native Select control, preserving options and changes. Sidebar styling
uses explicit classes rather than test-id selectors; SyncBadge has an explicit
quiet variant; sidebar New now focuses its opener before showing the launcher,
matching the proven rail behavior. Final browser assertions cover these changes
and a narrow My work long-title/invalid-date specimen.

A final operational pass corrected cancelled follow-up facts and hop billing
attribution that still used disabled ink. Follow-up text now uses UI typography,
due facts use metadata typography, and Fleet actor/outcome/usage facts adopt the
same roles. The targeted follow-up/run-history/fleet suite passed 30 tests.
The final browser state set now includes fleet-runs as well: twenty actual
presets per theme, with actor/outcome computed typography assertions.

Read-only peer review of the editor found four issues, all confirmed by the
editor agent: the Ask AI Writing actions summary was omitted from Popover's
focusable query; Space in the focused table insertion button was handled as
printable continuation; no-H1 fallback Enter ignored hidden body tabs; and the
projected title wrapper retained nested body children above metadata and on
related tabs. The editor agent owns corrections and their acceptance evidence.

## Contextual tool review and shared portal correction

A fifth editor peer finding scoped Shift+F10 to the actual native editor rather
than React-bubbled events from its portalled tool controls. The editor owns that
fix and its browser proof. Native WebKit skipped intermediate Ask buttons under
macOS's default keyboard preference; the editor added explicit tabIndex=0 to
those controls. Shared Button now forwards optional tabIndex for Retry/Apply,
without changing default focus semantics elsewhere.

The editor's 200% check exposed physical bounding rectangles being assigned as
zoomed fixed CSS coordinates. New `components/ui/portalGeometry.ts` reads the
body portal's cumulative html/body CSS zoom and converts viewport rectangles.
Popover, Tooltip and HoverCard consume the helper; Popover also exposes
--popover-available-width/height for viewport-bounded tool content. Lifecycle,
Escape, dismissal and write ownership are unchanged. Root is updating legacy
FieldPopover through the same helper. A mocked positioning/lifecycle suite
passed 20 tests; Tooltip/HoverCard lifecycle suites passed 32 tests. This mock
proof is deliberately separate from editor's live 200% measurements and the
final lane's real Tooltip/HoverCard anchor-gap assertions.

## Final M84/M89 browser disposition

**35 of 35 cases passed in 1.7 minutes**, one worker, on the owned Vite server at
port5383. There were no retries, no updated screenshots and no failures in this
run. Command:

```sh
PATH="/private/tmp/cerebro-toolchain/bin:$PATH" PORT=5383 CEREBRO_E2E_REUSE=1 pnpm exec playwright test e2e/surface-system.spec.ts e2e/surface-states.spec.ts e2e/settings-redesign.spec.ts e2e/studio.spec.ts e2e/quick-open-content.spec.ts e2e/csv-import.spec.ts e2e/rename-links.spec.ts e2e/hover-preview.spec.ts --workers=1 --output=/private/tmp/cerebro-m90/system-final-35-v1
```

Output `/private/tmp/cerebro-m90/system-final-35-v1`; full log
`/private/tmp/cerebro-m90/system-final-35-v1.log`.

| Suite              |            Final cases | What it establishes                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| surface-system     | 8:4 Chromium +4 WebKit | Both themes: real Library role/control sizes and rest/hover/press action contrast; sidebar and rail New focus return;900x600dialog and reduced motion; Mail32px/14pxnative Select plus actual retention change;600pxMy work long-title/invalid-date geometry;200%Tooltip gap/bounds. |
| surface-states     | 4:2 Chromium +2 WebKit | Each case traverses20presets: Agent spend, Fleet runs, History feed and Home work × ready/empty/not-recorded/partial/unavailable. Checks measured text, absent states, no horizontal overflow, actual Fleet14pxactor/12pxoutcome.                                                    |
| settings-redesign  |         6:3 per engine | Readable centered scrollport, unsaved local drafts, theme persistence, compact drawer/focus, real permissions controls.                                                                                                                                                              |
| hover-preview      |         2:1 per engine | Page/concept/record/missing preview, Escape preserves peek, actual200%card-to-link gap and viewport bounds.                                                                                                                                                                          |
| studio             |             1 Chromium | Create, source/live preview and assistant handoff.                                                                                                                                                                                                                                   |
| quick-open-content |             6 Chromium | Content/short query behavior, honest failure, expansion, stable asynchronous highlight, Enter navigation.                                                                                                                                                                            |
| csv-import         |             2 Chromium | Quoted data round-trip with one Undo; malformed input names record and writes nothing.                                                                                                                                                                                               |
| rename-links       |             6 Chromium | Linked rename/byte-exact Undo; cancellation; stale-citer all-or-nothing refusal; uncited rename; move preserving stem; whiteboard references preserved.                                                                                                                              |

The four macOS screenshot baselines compared successfully without update:
Library foundation and partial Agent state, one image per engine. In addition
to their earlier direct inspection, final Mail, long My work and partial Fleet
captures were opened with view_image in both themes across Chromium/WebKit.
No overlap or clipped facts was found. The compact rail retains its existing
scrolling behavior; screenshot framing varies when a lower rail control was
focused. My work intentionally clamps long names to two lines, keeps the full
accessible name and exposes the invalid date separately.

The source was not globally frozen for this run: editor and data agents were
still making their final isolated corrections. Root therefore owns the final
source fingerprint, whole-project gates and integrated source-frozen regression.
Coverage reports were directed outside the repository to prevent Vite reloads.
This run is correctness/geometry evidence, not a performance measurement.

M84 foundation and M89 adoption are implemented and browser-verified within this
lane. M90's owner aesthetic review and packaged/native acceptance remain
separate; no screenshot baseline or browser mock is labeled as either. No Git
staging, commits, branch switches or native-app interaction occurred in this lane.

## Complete final browser gate

**687 of 687 cases across 158 files passed in 14.8 minutes**, exit 0, with two
workers, no retries and no screenshot updates. This complete run supersedes the
earlier lane-only browser evidence for integration correctness. It used a fresh
Vite module graph at port 5384 after the application source freeze. Both owned
development servers (5383 and 5384) and this lane's browser jobs were stopped
after completion, before the separate production performance measurement.

```sh
PATH="/private/tmp/cerebro-toolchain/bin:$PATH" PORT=5384 CEREBRO_E2E_REUSE=1 pnpm e2e --workers=2 --output=/private/tmp/cerebro-m90/full-e2e-fresh-final
```

The durable [complete result](system/full-browser-result.txt),
[687-case inventory](system/full-browser-inventory.txt), and
[source/result metadata](system/full-browser-source.json) retain the evidence.
Original artifacts remain at `/private/tmp/cerebro-m90/full-e2e-fresh-final`.
This is browser correctness and geometry proof, not performance evidence,
packaged-native acceptance, or owner aesthetic approval.

### Diagnostic run and focused corrections

The first complete run was diagnostic: **665 passed and 22 failed out of 687**,
14.4 minutes, three workers, exit 1, on the warm port-5383 development server.
Its [complete log](system/diagnostic-browser-result.txt) remains distinct from
the final pass. Application and test files were held stable until that run
finished. The failures led to test-only corrections; no application behavior
was weakened or changed to satisfy this triage.

| Cause established from failing evidence                                                                                                                                                                                           | Correction and retained invariant                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The warm Vite graph loaded a timestamped `vaultStore` module while fixture code imported its bare URL, creating a second Zustand store. Two title-refusal retry cases and seven whiteboard fixture cases had stale mounted scans. | The new title fixture captures the actual module request before boot, imports that URL, rejects a null vault and waits for the mounted count to return to 45 before retry. Seven existing whiteboard cases remained unchanged and passed on the fresh graph. Refusal, exact bytes and one successful retry write remain asserted. |
| Two Organize cards were inside the existing collapsed reader panel when Assistant reduced available width.                                                                                                                        | Tests explicitly open Organize after the card exists; filing, approval and before/after byte assertions remain.                                                                                                                                                                                                                   |
| Settings tests assumed Assistant or Mail controls appeared immediately after opening Settings.                                                                                                                                    | Tests select the named existing subsection before acting; the mail pack remains in Mail.                                                                                                                                                                                                                                          |
| The unsupported OS-drop target was an inactive, hidden navigation subtree.                                                                                                                                                        | The gesture targets the visible application rail and still asserts refusal and no write.                                                                                                                                                                                                                                          |
| The pipeline test assumed the document inspector started open.                                                                                                                                                                    | It explicitly opens Show panel before choosing the Knowledge inspector section. Source and filing assertions remain.                                                                                                                                                                                                              |
| A record AI test clicked the entire editor around an H1-only fixture; the native title and metadata composition no longer placed a prose caret there.                                                                             | It uses the supported H1-to-body Enter gesture, asserts the exact paragraph and native selection, then checks Ask AI. A page-card test likewise asserts the chosen native heading instead of the retired title textbox.                                                                                                           |
| An ICS assertion compared a native select's complete option text instead of its selected value.                                                                                                                                   | It asserts `Meeting` with `toHaveValue`; the imported page's native heading assertion remains.                                                                                                                                                                                                                                    |
| A focused-input locator retried Enter after the committing input detached, although the value had saved.                                                                                                                          | The test scopes the Stake textbox, asserts focus before and after filling, sends the real focused keyboard gesture, then checks editor closure and existing bytes/migration invariants.                                                                                                                                           |
| A creation poll threw while the asynchronous file was still absent.                                                                                                                                                               | It first waits for file existence, then keeps strict company/person contents, relation, dismissal and restoration assertions.                                                                                                                                                                                                     |
| Two legacy Library checks expected a descendant header override to enlarge an explicitly compact button.                                                                                                                          | They assert the shared 28px compact role; layout, focus and no-write assertions remain. The foundation test independently checks the real control in both themes.                                                                                                                                                                 |

The first fresh focused rerun selected **23 cases**, including one additional
Library save-guard case: 21 passed and two failed in 35.5 seconds. The remaining
failures were the new fixture's attempted Resource Timing lookup, which did not
contain the module URL. Playwright request capture replaced that lookup; the
two retry cases then passed in 7.1 seconds. These are separate focused results,
not substitutes for the subsequent complete 687-case pass. Retained logs:
[23-case reproduction](system/focused-browser-result.txt) and
[two retry cases](system/title-retry-result.txt).

Future reproduction should start a fresh development server after fixture or
store edits, preserve one coherent run before changing files, and inspect the
failure artifact before changing a locator. A dynamic fixture that rescans
after boot must address the mounted store, prove mounted state refreshed, and
retain the original write/refusal invariant. Screenshot references must be
inspected before an intentional update; this final run updated none.

### Unit expectation cleanup

The separate stale-expectation cleanup passed **75 tests across three files**:
55 in `LayoutCanvas.test.tsx`, five in `MyWorkPage.test.tsx`, and 15 in
`workspace/viewers/viewers.test.tsx`. The changes assert the paired primary
action roles, readable warning-700 deadline ink, and the actual asynchronous
refusal text before checking its status region. The latter prevents a Loading
status from prematurely satisfying the error assertion. Application semantics
were unchanged. The [JSON result](system/stale-expectations.json) is retained;
focused formatting and `git diff --check` passed at that cleanup.

### Source and capture provenance

Launch base: `23479518c2827d361c9c970abfac8245f9d84600`; start:
`2026-10-17T18:56:57.377600+00:00`. For each of the `src` and `e2e` trees, the
fingerprint is SHA-256 over every regular file, without exclusions, sorted by
repository-relative POSIX path: UTF-8 path, NUL, exact file bytes, NUL. Thus the
`src` hash includes unit tests, and the `e2e` hash includes screenshot references.

| Tree  | Files | Launch SHA-256                                                     | Final SHA-256                                                      |
| ----- | ----: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `src` |  1580 | `e0212e5feef0d4f44d88134fdba0f01e22a80930fb9cb2b4dcaba6cdf52a1435` | `7e8164d494d693bed75d192a791363e0a7e8313e7e6dabd18228cb02032a5242` |
| `e2e` |   169 | `0d1da6e6126108e3583989d8157359e52cc3936d0035cf3c8b771ddc04e51974` | Same as launch                                                     |

The `src` difference is disclosed, not treated as an identical tree: after
launch, the editor agent added explicit `utf8` typing to existing test-only
filesystem audits in `src/app/renameActions.test.ts` and
`src/stores/undoStore.test.ts`. No application/runtime source changed during
the final run. Their final per-file hashes and modification times are in the
source/result metadata; the [unaltered launch metadata](system/full-browser-launch-source.json)
is also retained. Root's complete source manifest and whole-project gates are
the authoritative final build record.

Eleven selected system captures were copied from this successful complete run,
including refreshed [W02 Library](W02-library-light-webkit.png) and
[W02 partial Agent state](W02-agent-partial-light-webkit.png), both-engine light
specimens, and WebKit dark Library, Mail, narrow My work, partial Fleet and
unavailable Home states. The exact source-to-destination map and SHA-256 values
are in [system capture provenance](capture-provenance-system.json).

Final WebKit W02 images were opened directly and inspected: the Library's
heading, compact action and card hierarchy fit without overlap, and the Agent
state preserves “1 run unmetered” instead of inventing a measured total. Final
Chromium dark Library and light Agent images were also inspected. Earlier
both-theme Mail, My work and Fleet inspections are recorded above. These are
provisional agent visual checks; owner aesthetic approval remains separate.
No staging, commits, branch switches or native interaction were performed.
