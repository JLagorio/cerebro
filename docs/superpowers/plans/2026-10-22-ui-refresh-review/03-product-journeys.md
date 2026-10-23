# Product journeys: make the existing workspace feel finished

Independent review pass 3, 2026-10-22. This is a source-based challenge of the
expansion plan and a proposed product acceptance specification. No application
code, tests, running services or reference repositories were changed by this
pass. Browser observations belong to the root review's separate capture record;
the findings below do not claim that the competitors were run.

The strongest direction is to polish complete journeys across Cerebro's existing
page, database and assistant surfaces. Its underlying feature set is already
close to the requested Notion-competitor experience. The unfinished parts are
transitions, recovery, vocabulary and the distinction between an attractive
control and a dependable outcome. Adding another dashboard or replacing the
sidebar would spend effort around those gaps.

## Correct the baseline before planning the refresh

The [M84–M90 implementation record](../2026-10-17-m84-m90-implementation-record.md)
already records a shared type system, title projection, writing tools, property
editing, ten view layouts, a state lab and substantial browser coverage. It also
explicitly leaves owner aesthetic acceptance and native interaction acceptance
open. Neither its browser passes nor this review closes those items.

These capabilities are present and should be refined, not scheduled as new:

- [Pages](../../../../src/pages/PagesPage.tsx) has All pages, Recently opened,
  Favorites, search, sorting and list/grid presentation, with visit state.
- [DocPage](../../../../src/pages/DocPage.tsx) combines the real body title,
  metadata, related tabs, outline and mutually exclusive inspection panels.
- [DatabaseBlockView](../../../../src/views/DatabaseBlockView.tsx) supports an
  embedded database, creation, saved-view resolution and opening the database
  full-page. [MarkdownEditor](../../../../src/editor/MarkdownEditor.tsx) already
  exposes this through the slash menu.
- [useOpenPath](../../../../src/app/useOpenPath.ts), the pane history and the
  existing command registry already implement deliberate navigation behavior.
- Agents already have Instructions, Runs and Memory tabs. Knowledge already has
  Concepts, Review and Activity; concepts already open as pages.

The refresh should establish a small set of reusable compositions: page frame,
collection/list frame, property editor, inspector, composer, and conversation/run
frame. Every destination uses one of these with appropriate content. This is a
design-consolidation proposal, not evidence that the current code lacks shared
components.

## Prioritized findings

| ID   | Priority | Classification                    | Concrete target                                                |
| ---- | -------- | --------------------------------- | -------------------------------------------------------------- |
| PJ01 | P0       | Existing correctness gap          | Recover a failed page save without further typing              |
| PJ02 | P0       | Measured performance gap          | Keep large database editing responsive and accessible          |
| PJ03 | P1       | Polish plus new recovery behavior | Create in an intelligible place and resume unfinished capture  |
| PJ04 | P1       | Interaction consistency           | Preserve origin and focus across peek, page and pane           |
| PJ05 | P1       | Vocabulary and density polish     | Give metadata one name and one dependable editing path         |
| PJ06 | P1       | Existing-feature discoverability  | Compose prose, related records and saved views clearly         |
| PJ07 | P1       | Navigation feature                | Open the passage that made a search result useful              |
| PJ08 | P1       | Command/menu polish               | Make actions available through the same contextual vocabulary  |
| PJ09 | P1       | Expansion feature and polish      | Connect an account, inspect usable actions and repair failures |
| PJ10 | P1       | M91 integration and expansion     | Turn chat output into useful, recoverable workspace work       |
| PJ11 | P1       | Knowledge journey polish          | Make review understandable without diluting verification       |
| PJ12 | P1       | Cross-surface acceptance          | Finish first-use, loading, failure and narrow-layout states    |

P0 here means a blocker to claiming a dependable polished workspace, not proof of
a newly introduced regression. PJ01 and PJ02 corroborate existing CP01/CP04 and
must remain single work items. Other rows intentionally distinguish a new
behavior from a polish pass over working infrastructure.

## PJ01 — Recovery must be part of the save indicator

[PageToolbar](../../../../src/components/PageToolbar.tsx), around lines 143–177,
already shows dirty/saving/saved/failed status. The remaining problem is behavior:
[MarkdownEditor](../../../../src/editor/MarkdownEditor.tsx), around lines 670–678,
updates `lastSaved` before awaiting the change callback;
[NoteBodyEditor](../../../../src/editor/NoteBodyEditor.tsx), around lines 299–329,
reports failure without retaining a retry obligation in that write path. A nicer
badge cannot finish this journey. Morrow's
[SaveQueue](../../../examples/Morrow-main/src/storage/saveQueue.ts), lines 24–85,
provides the useful contrasting ownership pattern: failed work remains pending.

**Target:** a failed save leaves a persistent, quiet “Unsaved changes” state with
Retry and recovery/export options. Retain the exact draft beyond the editor's
unmount, or refuse that transition until ownership transfers safely. This must
join the existing quit/flush contract rather than creating a separate UI-only
queue.

**Accept:** success is acknowledged only after persistence; a failed save followed
by Retry works without another keystroke; changing pages/vaults and quitting
cannot silently lose the draft. Keyboard save reaches the same retry path, and
screen readers receive a useful state announcement without an announcement for
every typed character. Recheck native quit separately.

## PJ02 — Responsiveness is a visual-quality requirement

The [implementation record's performance disposition](../2026-10-17-m84-m90-implementation-record.md#performance-disposition)
reports production p95 key-to-two-frame timings of 398.8 ms for 1,000×12 and
1,376.2 ms for 1,000×24; 5,000×12 navigation timed out. These are earlier headless
Chromium diagnostics, not fresh native measurements. They remain explicit
unclosed evidence, not an assertion that every view is slow today.

**Target:** profile representative database editing before committing to larger
cosmetic motion. Keep selection, cell editing and error placement steady while
data loads or groups change. Do not repeat the rejected `content-visibility`
optimization that removed offscreen records from the accessibility tree.

**Accept:** rerun a controlled benchmark on the delivered build against the
existing proposed budgets; disclose failures and native/browser differences.
Verify search/find, End navigation, variable-height rows, frozen columns and an
offscreen refused draft. A failed read has its own repair state; it never appears
as an empty fast table. Keyboard focus remains on the same record/field through
sorting or filtering, or receives an explicit fallback when it disappears.

## PJ03 — Creation should explain location and preserve effort

The global [creation catalog](../../../../src/app/createCatalog.ts), lines 32–112,
does explain landing locations and offers Sub-page separately. However,
[NewDocDialog](../../../../src/app/CreateMenu.tsx), lines 48–102, always creates an
ordinary page at the vault root; the Pages New menu opens that reduced dialog.
[RecordComposer](../../../../src/app/RecordComposer.tsx), lines 23–46, deliberately
keeps a local draft that is discarded on close. Those are current choices, not
missing creation infrastructure.

**Target:** carry a visible destination into every creation flow: “In …” for a
page and “Database …” plus the relevant host relation for records. Context may
suggest a location, but the person can change it. Preserve unfinished capture
under the originating vault with Resume and explicit Discard. Plane's
[draft issue layout](../../../examples/plane-preview/apps/web/components/issues/issue-modal/draft-issue-layout.tsx)
offers that distinction; its unawaited close path should not be copied.

**Accept:** a page created from a folder or host lands where the dialog says;
related-record creation retains its existing relationship semantics. In UI03's
first stage, closing and reopening in the same session recover the draft. Restart
recovery is a later persistence/retention slice, outside the first visual pass.
Failed draft persistence, once introduced, keeps the active text visible.
Escape does not silently mean Discard; Enter and modifier
Enter create once and retain current validation behavior.

## PJ04 — Peek and full-page views need one return contract

[PagesPage](../../../../src/pages/PagesPage.tsx), line 57, explicitly opens full
pages. [useOpenPath](../../../../src/app/useOpenPath.ts), lines 40–61 and 161–183,
deliberately gives ordinary records a peek, sometimes changing to their database
or collection backdrop. This is intentional, useful behavior; making everything
full-page would discard a working contextual interaction.

**Target:** make the difference predictable through consistent “Open page” and
“Open beside” affordances. Preserve the originating search/filter/scroll position
when promoting a peek to a page, navigating a relation, or following an AI source.
Show the page's identity consistently in peek and full-page headings. Avoid a
second editor owner when the page is already open elsewhere.

**Accept:** start at a filtered database row, peek, edit a property, open full-page,
follow a relation, then return to the same row and filter. Repeat from Pages and
Quick Open. A moved/deleted target produces an honest unavailable destination and
a way back. Escape closes the foremost layer; focus returns to a surviving opener
without stealing a deliberate pointer move. Narrow parked panes retain drafts.

## PJ05 — Resolve the three meanings of “details”

[RecordPageProperties](../../../../src/detail/RecordPageProperties.tsx) labels its
automatic summary expansion “Properties.”
[HeadingProperties](../../../../src/detail/HeadingProperties.tsx) labels the
equivalent authored-layout expansion “View details.”
[PageToolbar](../../../../src/components/PageToolbar.tsx) uses “Details” for the
separate inspection panel. These overlapping words make the same record feel
different depending on its Type configuration.

**Target:** use Properties consistently for editable record metadata; reserve
Details for page facts/evidence/links. Align label widths, row rhythm, empty-value
affordances and active-editor chrome between page, peek, table and composer.
Retain the existing [RecordProperties](../../../../src/detail/RecordProperties.tsx)
and FieldEditor machinery, schema blast-radius disclosure and stable metadata
portal. Automatic summaries should stay compact doors into the one editor, not
silently acquire independent drafts.

**Accept:** edit the same status/date/relation through each surface and receive the
same value, validation and refusal wording. An invalid draft remains exact and
focused appropriately. Expanding/folding and switching related tabs preserve the
draft; tabbing through fields does not unexpectedly enter a hidden editor. A
schema-changing action explicitly distinguishes changing this value from changing
the field for every record.

## PJ06 — Make existing document/database composition legible

Cerebro already supports embedded database blocks and related View tabs.
[DatabaseBlockView](../../../../src/views/DatabaseBlockView.tsx), lines 90–149,
describes the same database appearing inline and full-page; its missing-source
state correctly differs from an empty database. [RecordTabs](../../../../src/detail/RecordTabs.tsx)
also has source and related-scope configuration. The opportunity is reducing the
conceptual distance between those entry points.

**Target:** use the same source picker and summary language for inserting a view,
adding a related tab and opening a full database. Show database, saved view and
scope explicitly when choosing them. In a project page, make “related to this
page” distinguishable from “all records” without requiring people to understand
the storage schema. Keep view configuration distinct from database schema changes.

**Accept:** insert an existing view into prose, choose a layout, create a record,
then open full-page and see the expected data. A related tab files a record to its
host; a global embed does not imply that relation. Missing/deleted sources offer
repair without rewriting the body automatically. The insertion picker, view
options and full-page route are keyboard reachable; Escape returns to the saved
editor selection.

## PJ07 — Discovery should land where the answer is

[QuickOpen](../../../../src/app/QuickOpen.tsx), around lines 656–692, renders useful
highlighted excerpts, but the inspected navigation still resolves a page target,
not a passage target. [DocSidePanel](../../../../src/detail/DocSidePanel.tsx), lines
29–116, already presents links/backlinks, generally as titles and relation labels.
Do not propose backlinks or full-text search as absent.

**Target:** add a shared source-location contract used by search, backlinks where
a location is known, and chat citations. Offer a short contextual snippet, open
the matching passage and briefly mark it. Distinguish a historical citation from
today's live content; do not equate a mentioned link with supporting evidence.

**Accept:** search for text deep in a long page, open the result, inspect the
passage and return with the query/results intact. If the source changed, say the
exact passage could not be located and open the page with a useful fallback.
Keyboard result navigation and Open beside reach the same location. Loading and
failed content search remain distinct from “no matches.” This extends CP05 rather
than creating a competing search project.

## PJ08 — Menus and commands should share the product's vocabulary

Cerebro already derives creation commands from its catalog and has scoped key
handling. Plane's [Power K types](../../../examples/plane-preview/apps/web/components/power-k/core/types.ts),
lines 66–107, are useful evidence for contextual visibility and parameter
selection, not a reason to replace Cerebro's registry. Current
[ViewControlIcons](../../../../src/views/ViewControlIcons.tsx) also deliberately
consolidates settings where a View options panel exists.

**Target:** audit frequent actions across toolbar, right-click menu, overflow,
slash menu and command palette. Match names, grouping, icons and shortcuts; put
the current object before global utilities. Give potentially broad changes a
specific label. Use progressive disclosure for uncommon controls without hiding
the active filter, selection or unsaved state.

**Accept:** a person can find Rename, Move, Open beside, Properties and relevant
creation commands from the expected context with either keyboard or pointer.
Disabled actions explain a real blocker and cannot run through another entry
point. Search synonyms help discovery without adding duplicate commands. Nested
menus retain selection, use one Escape per layer and restore focus predictably.

## PJ09 — Connections need an outcome-oriented journey

[SettingsNavigation](../../../../src/pages/SettingsNavigation.tsx) already groups
Assistant, Mail and Other apps under Connections. The detailed connector editor
is nested within Assistant settings. [ConnectorSettings](../../../../src/app/ConnectorSettings.tsx)
already distinguishes unapproved, unobserved, failed and needs-sign-in states.
Calling this a missing connector UI would be inaccurate; calling it a finished
account/action experience would also be inaccurate.

**Target:** make Connections a coherent place to choose an account, inspect its
usable actions and repair access. Separate “Cerebro uses this service” from “this
app may access Cerebro.” Link account state into the proposed workflow inspector
and chat action card. Advanced MCP transport/configuration belongs below the
task-oriented setup, without concealing its authority.

**Accept:** connect, select an account for a draft workflow, preview the action and
inspect its outcome. Revocation, expiry and unavailable discovery each show the
appropriate repair path; configuration existence never becomes a green health
claim. Keyboard setup can complete without dragging nodes. Workflow actions must
wait for the expansion runtime's approval/recovery guarantees; UI polish does not
authorize or implement remote effects.

## PJ10 — Chat should end in an owned result

Use the [chat dossier](../2026-10-22-ai-expansion-review/chat-and-agent-experience.md)
and [M91 audit](../2026-10-22-ai-expansion-review/m91-current-state.md) as the
integration dependency. M91 components are not proof that their production
journeys work. The refresh must preserve one assistant instance across floating,
docked and canvas presentations.

**Target:** carry one visible progression: chosen context, work in progress,
decisions waiting, answer, sources and effects. Subagent details expand beneath
their task without overwhelming the answer. Add Save answer/Add to page with a
destination preview; selected-text AI produces a reviewable edit tied to the
original page/version/range. Reuse the workspace editor for saved results.

**Accept:** ask from a page, navigate away while work runs, inspect a child, approve
an action and save the answer without losing draft or scroll position. A stale
selection refuses blind replacement. Child failure preserves successful work;
unknown remote outcomes cannot masquerade as completed or safely retryable.
Keyboard users reach approvals and results while streaming leaves focus alone.
The longer-term restart guarantee depends on durable conversation/runtime work.

## PJ11 — Knowledge review should feel like reading with a decision

[KnowledgePage](../../../../src/pages/KnowledgePage.tsx) already has the right
three-part structure; [ConceptTable](../../../../src/knowledge/ConceptTable.tsx)
already names review reasons. [ConceptReviewBar](../../../../src/knowledge/ConceptReviewBar.tsx)
keeps Verify tied to the viewed text and handles queued proposals separately.
The refresh should protect this differentiation from ordinary workspace pages.

**Target:** make the review reason, evidence route and next meaningful action easy
to read in one hierarchy. Keep machinery in the existing folded System section.
Show whether the person is reviewing a claim, approving a proposed edit or asking
for a recheck; those are different acts. Use the same inspector, list row and
status patterns as the rest of the workspace.

**Accept:** enter Review, understand why an item is present, inspect evidence,
return, decide and advance without losing place. Changed source/body, failed
evidence reads and unavailable pending-proposal reads remain explicit. Verify
never implies that an overdue recheck occurred. Keyboard focus follows the
decision outcome to the next eligible item or an honest empty state, and every
evidence link can open beside the claim.

## PJ12 — Finish states and first-use without manufacturing activity

[PagesPage](../../../../src/pages/PagesPage.tsx) already distinguishes loading,
unavailable, unmatched search, empty favorites and an empty workspace.
[StarterOffer](../../../../src/app/StarterOffer.tsx) already offers a create-only
kit after an empty scan. Home is intentionally quiet and pull-only. The refresh
should extend these good patterns consistently rather than add a busy onboarding
dashboard or compulsory setup tour.

**Target:** give every surface a deliberate empty/loading/error/partial state,
with one relevant next action. An empty Home may guide New page, Find or the
existing kit; a populated Home should help resume actual work. Standardize state
spacing and action hierarchy across Pages, Library, Agents, Work, History and
Settings. A narrow sidebar or inspector should feel like the same product.

**Accept:** review each critical journey in light/dark, narrow/wide, 200% zoom and
keyboard-only conditions, including mixed successful/failed sections. Failure
messages preserve other usable data. Initial focus, dismissal and returned focus
are specified for each drawer/dialog. Respect reduced motion; do not animate
every streamed row or save transition for decoration. Native IME, VoiceOver,
clipboard/drop and quit remain explicit acceptance gates, not implied by browser
screenshots.

## Delivery shape

First close PJ01/PJ02 and reconcile M91 against the final implementation handoff.
Then prototype a representative page, database/peek, composer, settings connection
and conversation using the shared compositions. Review those exact screens with
realistic content and adverse states before spreading visual changes everywhere.

Deliver the refresh by journeys, with before/after captures and one acceptance
record per composition. Keep existing route names, saved preferences, one-editor
ownership and data authority intact unless a separately approved architecture
decision changes them. A polished release is ready when the owner accepts its
visuals and the named journeys work through success, failure and keyboard use;
component count and screenshot similarity to a competitor are insufficient.
