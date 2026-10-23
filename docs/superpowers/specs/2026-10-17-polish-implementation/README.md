# Implemented product polish: review evidence

The M84–M90 implementation follows checkpoint **`2347951`** and remains **unstaged and
uncommitted on `m53-macro-port`**. Start with the actual writing session, typed record and data
views below. The [implementation record](../../plans/2026-10-17-m84-m90-implementation-record.md)
is the authority for checks and remaining acceptance.

The earlier [reference audit](../2026-10-17-cerebro-polish-audit.md) studied Morrow's editor source
and supplied demonstration, and Macro's local source. Neither reference application was run
interactively. The [concept previews](../2026-10-17-cerebro-product-polish.md#proposed-page-composition)
are design proposals; the captures here show implemented Cerebro behavior.

## Start here

| Implemented surface      | Review material                                                                                                                                                                         | What changed                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Writing                  | [Light selection](editor/writing-selection-light-webkit.png), [dark document](editor/writing-document-dark-chromium.png), [200% tools](editor/writing-selection-200-percent-webkit.png) | One real title, consistent prose, retained selection, contextual formatting and Writing actions.              |
| Complete writing session | [Light Chromium recording](editor/writing-session-light-chromium.webm), [dark WebKit recording](editor/writing-session-dark-webkit.webm)                                                | Pointer selection, formatting, Ask AI open/cancel, table dimensions, block actions, comment, save and reopen. |
| Typed record             | [Full page](P02-record-fullpage-webkit.png), [light at 125%](P02-record-light-125-webkit.png), [dark at 125%](P02-record-dark-125-webkit.png)                                           | Title-first anatomy, stable properties, readable narrow content.                                              |
| Database table           | [Light](data/table-light-chromium.png), [refused draft at 200%](data/table-scalar-refusal-dark-200-chromium.png)                                                                        | Useful name allocation, readable cells and correction feedback that remains near the input.                   |
| Alternate displays       | See [data report](data-evidence.md) and the adjacent `data/` captures                                                                                                                   | Responsive cards/list, bounded Gantt split, quieter chart/dashboard presentation and preserved saved choices. |
| Workspace                | [Library](W02-library-light-webkit.png), [partial agent](W02-agent-partial-light-webkit.png), [surface report](system-evidence.md)                                                      | Shared type/action roles, clearer hierarchy and explicit unrecorded or unavailable facts.                     |

## Coverage registry

“Agent-reviewed” describes inspection of actual captures and related browser behavior; it does
not mean the owner accepted the aesthetics. The lane reports distinguish newly proved behavior
from preserved existing coverage. The full browser run and source manifest are recorded in the
implementation record. This registry is not a claim that every stress permutation has a screenshot.

| ID                                | Disposition and evidence                                                                                                                                    | Remaining limit                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| P01 Ordinary prose                | Agent-reviewed title/no-H1/nonleading-H1, nested and atomic-first pages; [title mechanism and evidence](editor-evidence.md).                                | Native VoiceOver order for the visually projected nonleading H1 remains unproved.                                      |
| P02 Typed full/peek               | Agent-reviewed record anatomy; integrated table→peek→full correction/save/reopen and narrow 125/150/200% cases.                                             | Native input acceptance remains separate.                                                                              |
| P03 Concept/agent                 | Guarded frontmatter title/Verify behavior and stable grants retained; owner/lifecycle and Knowledge units, existing agent browser cases.                    | No new end-to-end live-agent grant/execution or native acceptance claim.                                               |
| P04 Rich authoring                | Four recorded writing sessions; supported block conversion/move/duplicate/undo, real node/cell selection units, atomic image/database/sheet title fixtures. | Native clipboard/drop/IME, AI decision-stage walkthrough and exhaustive carrier combinations remain unproved.          |
| D01 Table                         | Agent-reviewed light/dark/error/zoom; exact drafts, edit leases, frozen cells, 400-row AX/keyboard/find and wrapped-row proof.                              | Production target missed at 1,000 rows; 5,000-row measurement stopped at navigation timeout.                           |
| D02 Board/gallery/list            | Agent-reviewed real populated cards, true 360px list/gallery hosts, saved-size/default distinction and no-write-on-open.                                    | Not every saved field/density/card combination was captured.                                                           |
| D03 Calendar/timeline/Gantt       | Agent-reviewed populated ranges/undated data and six-column axis; resize and independent horizontal/shared vertical scrolling.                              | Native wheel/trackpad behavior is not established by browser automation.                                               |
| D04 Chart/dashboard/sheet         | Agent-reviewed chart/count/dashboard; existing missing-measure/local-error/export/formula behavior retained and tested.                                     | No fresh calculated-sheet visual/native export acceptance; fixed saved dashboard rows intentionally scroll internally. |
| W01 Home/Inbox/My work            | Shared adoption; populated long-title/invalid-date specimen and independent ready/empty/unknown/partial/unavailable reads.                                  | Owner aesthetic review pending.                                                                                        |
| W02 Knowledge/Library/Agents      | Agent-reviewed Library and partial agent/fleet; guarded review, unknown totals and paused/decision states retain coverage.                                  | Live-service/native execution is not inferred from mocks.                                                              |
| W03 Assistant                     | Shared typography/contrast and existing streaming/question/permission/Stop/Steer/panel-canvas controller coverage.                                          | No new real-model or native pending-decision acceptance.                                                               |
| W04 Settings/History/git          | Settings drafts/sections/narrow drawer and theme tests; History partial/unavailable specimens and existing diff/read behavior.                              | Native git/OS interaction not newly accepted.                                                                          |
| W05 Work/Studio/files/boards      | Populated Studio create/preview/assistant handoff, Work file viewers and existing board/image/PDF/error coverage.                                           | Native open/QuickLook/dialog/drop/CSP acceptance outstanding.                                                          |
| W06 Search/create/import/overlays | Actual search navigation/failure, CSV import/Undo/malformed refusal, linked rename/conflict/Undo, bounded menus and focus recovery.                         | Native import/file-picker dialogs outstanding.                                                                         |

## Visual judgment

The inspected flagship page, table, card/time-view and workspace captures pass the agent's
hierarchy, alignment, readability, interaction, resilience and consistency review within their
recorded states. The full/native acceptance judgment is **incomplete**, not passed: owner visual
review, native operation and the table performance budget remain open. Earlier captures with
duplicate titles, transient transparent animation frames, clipped error text or discarded table
containment are not accepted references.

## Detailed reports and provenance

- [Pages and editor](editor-evidence.md)
- [Tables and all ten displays, including performance limits](data-evidence.md)
- [Shared system and workspace adoption](system-evidence.md)
- [Packaged native audit and outstanding cases](native-evidence.md)
- [Automated gate results](checks.json) and [coverage summary](coverage-result.txt)
- [Source fingerprint](source-manifest.json), [artifact hashes and dimensions](manifest.json),
  and [capture provenance](capture-provenance.json)

Captures use bundled Instrument Sans/IBM Plex Mono, the shared deterministic mock boot and UTC.
The artifact manifest records image dimensions; window and actual host geometry come from the
linked test fixtures and assertions. Cropped images and scaled videos do not establish window
or pane width. Videos are interaction evidence rather than pixel baselines.
macOS baselines are provisional agent-reviewed references, not owner-approved design artifacts.
