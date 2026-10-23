# Cerebro UI refresh and four-pass plan recheck

**Proposed design and delivery plan · 2026-10-22 · documentation only.** This
responds to the owner's request to quadruple-check the AI expansion plan and
refresh the application until its everyday experience is as considered as the
supplied Notion competitors. No application source was changed. This plan adds
a first-class UI track alongside the [AI expansion roadmap](2026-10-22-ai-expansion-plan.md),
without reserving new milestone numbers or restarting completed M71–M90 work.

## The decision

Keep Cerebro's identity and accepted shell. Refine the way its existing components
compose into complete screens, then finish the interactions that make those
screens dependable. The target is a quiet, content-led workspace: a page feels
like a page, a database feels like a purposeful working view, and AI activity
helps the person understand and use a result.

The UI refresh should proceed **in parallel with Rust/action architecture work**.
Typography, alignment, density, menu consistency and page composition do not
require a new persistence format or workflow engine. Features that display new
capabilities—durable external effects, independent child jobs or permanent chat
history—still require their real producers and recovery contracts.

The earlier plan was strong on runtime architecture but did not give the visual
refresh enough independent scope. This document corrects that. It also updates
M91's moving implementation status: policy and request fields have advanced since
the first audit, while frontend child-event integration remains incomplete at
the recheck checkpoint. Read the [current architecture recheck](2026-10-22-ui-refresh-review/01-architecture-recheck.md)
before treating the earlier missing-feature inventory as current.

## What the four passes established

| Independent pass                                                                                   | Main conclusion                                                                                | Concrete change to the plan                                                                                |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Architecture and current implementation](2026-10-22-ui-refresh-review/01-architecture-recheck.md) | M91 policy data is landing; its loaders and consumers must be handed off as one coherent slice | Retire stale absence claims, retain the child-event gap, prove startup and broker-only execution           |
| [Visual system and references](2026-10-22-ui-refresh-review/02-visual-system.md)                   | The design system already exists; inconsistent composition is the larger opportunity           | Three page compositions, explicit geometry, action/density/corner roles and adoption across surfaces       |
| [Product journeys](2026-10-22-ui-refresh-review/03-product-journeys.md)                            | Creation, metadata, return paths and recovery determine whether the product feels finished     | Visible destinations, retained drafts, consistent Properties language and end-to-end navigation acceptance |
| [Acceptance challenge](2026-10-22-ui-refresh-review/04-acceptance-challenge.md)                    | Aesthetic, behavioral, performance and native acceptance are separate                          | Surface/state/viewport matrix; evidence-specific release gates; no screenshot or test-count substitute     |

The lead also inspected retained Cerebro page/table/board/editor/Library captures
and attempted the current browser demo. The fresh browser startup failed with
`shared/policy/tool-approval.v1.json: unknown field agent_types` during active M91
editing. That is a reproduced intermediate-tree startup failure, not a judgment
of a rendered interface or a completed release. See the [evidence record](../specs/2026-10-22-ui-refresh-evidence/README.md)
for the final retry disposition, exact environment and provenance.

Historical screenshots are not current pixel baselines: October 19 changes to
the toolbar, side panels, sidebar and assistant postdate the October 17 captures.
The reference apps were not installed or exercised. Supplied reference images
and source show design choices; they do not prove dynamic behavior or current
market superiority. Candidate refinements below need fresh before/after captures
once the working tree starts coherently.

## Keep the parts already working

Retain Instrument Sans and IBM Plex Mono; the cortex/synapse identity; light and
dark palettes; the 54px rail and 240px default resizable context sidebar; the
canvas meeting the right/bottom edges; the full-height Details/Comments/History
slot; pane-aware navigation; and one assistant across floating, docked and canvas
presentations. Preserve persisted widths, folds, display settings and all routes.

Keep the existing semantic type scale, shared controls, restrained table chrome,
motion/reduced-motion system, title projection inside the body editor, stable
metadata portal, field correction status and guarded writes. Pages/grid display,
record peeks, related records, embedded databases, saved views and history are
already implemented. They need coherent presentation and complete journeys, not
new parallel versions.

The [M84–M90 implementation record](2026-10-17-m84-m90-implementation-record.md)
is evidence of substantial delivered work. Its outstanding owner visual review,
native interaction acceptance and large-table performance remain outstanding;
this review does not convert them into passes.

## Visual direction: three compositions, one family

These are proposed implementation starting points, not measurements of a new
design or instructions to replace every existing value indiscriminately.

| Composition    | Surfaces                                                             | Hierarchy and geometry                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document**   | Ordinary page, full record, concept, Agent instructions              | Existing 40/48 title; properties/review/tabs where relevant; 16/28 prose; aligned title/body/property start; inspect actual readable width before changing outer containers |
| **Collection** | Pages, Library, Knowledge lists, databases, Agent lobby              | 28/36 heading; one compact description when useful; views/search/actions sharing the content edge; broad data region                                                        |
| **Utility**    | Settings, history inspection, connection repair, operational details | 24/32 heading; grouped tasks and fields; restrained summaries; clear local errors and next actions                                                                          |

Home may keep its deliberate welcome composition. Sheets, boards and timelines
retain geometry suited to their content. A collection header should not force a
wide table into a prose column; a full record should not acquire a dashboard header
merely because it contains a related table.

### Geometry and rhythm

For collection pages, prototype 40px top spacing and 32px inline inset, reducing
to 24px and then 16px as the **pane** narrows. Align heading, description, tabs,
search and content to the same chosen edge. Current generic headers, Pages,
database pages and Library use different combinations; decide which differences
are purposeful before consolidating them.

For ordinary prose, measure the resolved text width after outer padding,
BlockNote gutters and editor wrappers. The existing 880px outer readable surface
is not an 880px text measure. An approximately 700–760px desktop prose measure is
a starting comparison target, not an instruction to subtract width blindly.
Preserve full-width pages and wide embeds. Hover handles use their reserved
gutter without shifting the title or text.

Keep the current 64px page-toolbar frame until a measured comparison justifies
changing it; its panel alignment is already a coordinated contract. Opening
Details should leave the toolbar's actions in predictable positions and preserve
the document's identity. On a narrow pane, use the existing drawer behavior.

### Typography, color and controls

Keep 40/48 document titles, 28/36 collection headings, 24/32 utility headings,
16/28 prose, 14/20 working UI and 12/18 metadata. Record the current 13/18 compact
inspector as a deliberate exception. Use 11px only for redundant short badges or
shortcuts, never the sole description of a required action or failure. Preserve
readable secondary text rather than making it faint to imply sophistication.

Keep Button's existing 28/32/36px roles, IconButton's 24/28/32px targets, and
36px navigation targets. These are different component roles. Glyph size
and target size are different: a quiet 16px icon can retain a usable target.
Use cortex for selected/navigation/ordinary action states and synapse for AI
identity where it communicates meaning. User-defined status colors remain data.
Selection, hover, disabled, invalid and focus must remain distinguishable.

Use pills for existing search/segmented/composer surfaces and rounded rectangles
for ordinary form actions. Prototype 6–8px control corners, 10–14px cards/menus,
and 20–24px only for freestanding conversation surfaces. These ranges reconcile
roles, not a global radius replacement. Inspect nested corners against their
padding. Use separators between adjacent content, backgrounds for meaningful
groups, and shadows for overlays; avoid adding a border to every region.

### Density and action hierarchy

Offer useful density rather than making the entire interface smaller. Compare
48px one-line list rows with current 56px Pages rows; retain 56–64px where a real
second line needs the space. Preserve the database's current compact/default/tall
32/44/56px row roles; its 36px value is the header height. A 36px data-row option
would be a new comparison, not an existing baseline. Do not force multiline
records into a fixed height. Respect saved density and visible-field choices.

Cards should earn height through meaningful content. Test Pages/Library cards
with long and empty previews; reduce decorative file tiles, excess fixed height
or repeated metadata only when the comparison improves recognition. Titles and
useful preview text lead; controls appear on hover **and keyboard focus** without
moving content.

Use one dominant action per decision area. Global New remains available; a
collection's local New should make its destination clear. Page Details, Comments
and History remain separate controls. Pending approvals, failed saves and uncertain
effects remain conspicuous and reachable; they are not candidates for cosmetic
decluttering into overflow.

## Screen-by-screen refresh

### 1. Shell, Pages and finding your place

Refine the current rail/sidebar rhythm: shared text edge, consistent icon/label
gap and trailing action/count slot. Keep global section selection, current
collection and selected page visually related but distinguishable. Retain
Collections-versus-Folders mode rather than copying old screenshots that show
both trees. Do not remove destinations to make a cleaner demo.

Pages should be the flagship collection composition: title/description, shelves,
search/display controls and rows/cards aligned as one surface. Preserve search,
shelf, display, scroll and selected origin when opening and returning. Compare
list/grid with the same corpus rather than approving attractive sparse cards.

Quick Open may continue to preview a record while Pages opens it full-page; those
are different intents. Make preview versus open-beside versus full-page controls
clear and preserve a reliable path back. The same title appearing as a breadcrumb
and content title is not automatically unwanted duplication.

### 2. Pages, records and properties

Align title, metadata summary, tabs and ordinary body content. Preserve the
first-H1 projection and filename fallback without writes on open. Concepts keep
guarded titles/Verify semantics; Agent pages keep standing instructions and
deliberate grant commits. Never achieve alignment by creating another editor or
reordering stored Markdown.

Use **Properties** consistently for field metadata. An inline expansion can say
“Show all properties” / “Hide properties”; the toolbar's **Details** continues to
mean the broader inspection panel. Remove ambiguous “View details” labels where
they merely reveal inline properties. Preserve authored property configuration
and differentiate hiding presentation from deleting data.

The inspector should stay compact and readable: aligned labels/values, wrapping
relations, local field status and independently scrollable content. Review real
twenty-property records at its narrow supported width. Keep comment drafts and
focus when switching panels. Whole-page history should explain restore effects
without competing with ordinary property editing.

### 3. Authoring and embedded work

Refine the existing selection toolbar, block handle, slash menu, link picker,
table controls and writing actions as one family. Formatting remains immediately
usable; AI opens in context and returns to the same selection. Keep deterministic
formatting separate from a proposed AI edit. Compare/apply/cancel must preserve
the exact selected source and the current document version.

Embedded databases and related tabs already exist. Improve how their source,
view and scope are named and changed. A project-related Tasks tab must not look
like an unscoped database; filing a new record must preserve the stored project
relation and database home-folder rules. Use capability-based behavior, not hardcoded
Task/Project type routing. Wide embeds may use wider geometry than prose without
moving the ordinary paragraph edge.

Treat saving as part of the interface contract: dirty, saving, saved and failed
must describe acknowledged state. The existing failed-save ownership gap needs a
functional repair, not a more reassuring label. Preserve the draft through retry,
navigation and quit according to the established recovery plan.

### 4. Databases, tables, boards and galleries

Make the name column, status, relation and date cells read coherently at the
current density. Preserve frozen-column behavior, exact refused drafts and
`AnchoredFieldStatus`; never raise an editing cell above frozen columns to make
an error look convenient. Keep the logical distinction between spreadsheet cells
and database property edits.

Unify the saved-view toolbar, filter/sort indicators, search, display settings
and local New across layouts. Do not make compact icon controls discoverable only
by pointer hover. Group labels/counts and cards should use the same hierarchy;
status color supports text rather than replacing it. Boards may scroll horizontally
within their work area; page actions and dialogs must remain reachable.

The previous 1,000-row latency results remain a separate performance problem.
A denser screenshot does not solve expensive rendering. Preserve keyboard End,
range selection, browser find or its documented equivalent, wrapped rows and
accessibility when testing bounded rendering. The rejected containment experiment
must not return solely to improve a timing number.

### 5. Chat and agents

Adopt M91's components into the existing single assistant with one complete
transcript contract. Align composer, answer, evidence and artifacts to a readable
measure; keep prose primary and ordinary tool activity secondary. Child
contributions should answer who did what and what it produced. Consequential
failure, pending permission and outcome-unknown states stay directly visible.

```text
Conversation title                                     Options

User question
Context: Project · 3 sources                           Inspect

Assistant answer / current useful progress
  Researcher — checked release notes                   Complete
  Reviewer — source unavailable                        Needs attention

Proposed change · account and target                   Review
Answer with passage references
Saved output / preview distinction                     Open / Save

Attachments and selected context
Ask a follow-up…
Add     Capabilities / account     Model / effort       Send
```

This is an anatomy sketch, not a new dashboard. The floating, docked and canvas
views share state and ownership. Narrow layouts can collapse secondary controls
into labeled menus without hiding approvals or Stop. Empty chat should offer a
few useful task starts grounded in the current context, not a wall of feature
advertising. Save answer, sources and artifacts reuse existing page viewers and
writers as their data contracts become available.

Agent pages should look like the same page family with meaningful duty/grant/run
information. Completed researchers, independently scoped Agents and deterministic
workflow steps remain different concepts even if their rows share a component.
Do not display proposed runtime capabilities as functional controls before they
exist. Follow [the detailed chat plan](2026-10-22-ai-expansion-review/chat-and-agent-experience.md)
and the updated M91 handoff.

### 6. Knowledge, Home, Settings and connections

Keep Knowledge's Concepts/Review/Activity structure and human-only verification.
Improve evidence readability and passage navigation while distinguishing retrieved
content from verified knowledge. Use the same collection header, readable state
messages and inspectable details as elsewhere; do not invent another review hub.

Keep Home pull-only and quiet when lanes are empty. Refresh useful grouping and
spacing without adding arbitrary counts or decorative activity. A failed lane
must explain its own failure. Library, History and My work should share the
appropriate composition while retaining their distinct jobs.

Settings should provide compact, clearly grouped choices with local validation,
predictable Done/Cancel and retained unsaved inputs. Connection setup should
return to the originating draft after repair. A signed-in account, transport
health and a callable action are different states. The future workflow list/
inspector should use the same fields, menus, statuses and action previews as chat;
a graph remains a later view over that model.

### 7. Creation and recovery

Make the destination visible before creation. Current global New page creates at
the vault root; a new location-aware flow should show its proposed folder and
allow correction. Defaulting to context must respect the existing database home
folder, project membership and item-key contracts. A local New and global New
can share a composer without silently implying the same destination.

Current `RecordComposer` discards drafts on close. Define session-scoped recovery
or an explicit discard decision for meaningful drafts. Scope recovery by vault,
record kind and destination; reopening must not leak text into another context.
A persistent crash-draft archive is a separate retention decision. Preserve exact
failed input and field errors, with one clear next action and correct focus return.

This is the staged scope for PJ03 in the journey dossier: UI03 delivers session
recovery. Restart recovery requires a separately specified persistent store and
retention policy; it is outside the first visual slice.

## Delivery: a visual track with real acceptance

Use provisional **UI** IDs until milestone ownership is assigned. Effort is a
rough planning allowance for experienced contributors, not a delivery promise.

| Package                          | Deliverable                                                                                          | Depends on                                          | Review evidence                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| UI00 — coherent baseline         | Current M91 handoff; startup; acknowledged source identity; refresh of screenshots                   | Active implementation handoff                       | No policy-loader startup error; actual app frames captured                  |
| UI01 — composition sheet         | Three compositions, token exceptions, density/action/corner rules, six selected scenes               | Source/design review; can proceed while UI00 closes | Concrete before/proposed comparisons; current conventions credited          |
| UI02 — first visual slice        | One prose page, one record/inspector, Pages and one table using the refined compositions             | UI00/01                                             | Light/dark, 1440/1024, narrow pane and real zoom; no state loss             |
| UI03 — creation and return paths | Visible destination, draft recovery, metadata labels, peek/page/beside/Back behavior                 | Existing commands/writers; explicit recovery spec   | Complete create→edit→navigate→return journey including failure              |
| UI04 — data/display adoption     | Tables, cards, board, calendar/timeline/Gantt, sheet/dashboard controls                              | UI02; retained data contracts                       | Same records across views; keyboard and overflow; scale measured separately |
| UI05 — chat/Agent adoption       | Integrated M91 conversation, child/evidence/decision grammar and Agent page consistency              | M91 producers/reducer/consumers; AX00               | One real research turn live and restored; all presentations                 |
| UI06 — utility/state adoption    | Knowledge, Home, Library, History, Settings, search, dialogs and connection repair                   | UI01–03; runtime data only for new action features  | Common states and complete navigation/focus journeys                        |
| UI07 — release review            | Owner visual comparison, browser/native interaction, performance disposition and regression evidence | Relevant packages above                             | Explicit accepted/failed/unverified record, without blanket pass claims     |

Start with UI01/02 as a bounded **4–7 engineer-day visual slice** after the tree
is renderable. A complete cross-surface visual/interaction adoption is roughly
**4–7 engineer-weeks**, with uncertainty until the initial slice exposes shared
component effects. M91 completion, existing save/history repairs, large-table
optimization and unresolved native environment work have separate effort; those
ranges must not be hidden inside a cosmetic estimate or added twice to AX work.

The adoption allowance includes UI03's session behavior, not persistent restart
recovery or other new runtime capabilities. It describes engineering effort and
does not predict elapsed owner-review or native-environment availability.

Each package should change a small shared contract and prove its consumers. Avoid
a repository-wide CSS replacement followed by an enormous screenshot update.
Keep existing preferences until a deliberate migration is required. A change to
an old screenshot expectation needs an explanation of the improved behavior, not
just a new baseline.

## What “finished” requires

The [fourth-pass acceptance matrix](2026-10-22-ui-refresh-review/04-acceptance-challenge.md)
is the detailed gate. At minimum, use six representative scenes: long authored
document with rich blocks; record with many properties/related work; populated
table and board; long conversation with children and approval; Knowledge review;
and Settings/connection repair plus creation/search overlays.

Evaluate 1440×900 and 1024×768 windows, the native configured minimum **900×600**,
and a 360px content host inside a supported shell. A 360px browser window is an
optional stress case, not a claim that the native window supports that size.
Test real 200% browser zoom separately from image scaling, and inspect pane width
rather than only viewport width. Light/dark, reduced motion, long titles and
multiline values are part of the set.

This 200% product check is not a WCAG conformance claim. The fourth-pass review
separately identifies reflow, contrast and target-size criteria and links their
official guidance; conformance requires its own complete audit.

Review normal populated screens, empty, loading, unavailable, not-recorded,
partial, unsaved/failed, waiting, interrupted and outcome-unknown where applicable.
Keep the existing CV-44 five lab presets—ready, empty, not recorded, partial and
unavailable—and add transient/editing states in the appropriate journey fixtures.
Do not replace “not recorded” with loading to make a simpler design checklist.

Measure alignments, overlap, focus visibility and overflow. Evaluate text and
control contrast using the real rendered states. Exercise keyboard menus,
selection, modified clicks, Escape ownership, focus restoration, IME composition,
editor caret, drafts, scroll and assistant presentation changes. Verify packaged
WKWebView behavior, VoiceOver, Finder/clipboard/dialogs and quit separately.

Owner visual acceptance answers whether the result feels right; automated
geometry and contrast answer narrower questions. A startup failure, lost draft,
misleading Saved state, wrong-vault history, clipped primary decision or broken
focus is blocking. A proposed card density or radius is a comparison to resolve,
not a correctness defect merely because another app chose differently.

The result should feel more coherent because the same content and actions have
predictable hierarchy, geometry and behavior everywhere. The proof is completing
and recovering real work in the refined interface—not adding more polish terms
to a checklist.
