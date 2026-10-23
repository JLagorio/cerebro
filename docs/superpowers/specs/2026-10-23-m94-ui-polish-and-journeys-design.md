# M94 — UI polish and journeys design

**Milestone:** M94 · **Phases:** M94.1–M94.9 · **Requirements:** UX-01–UX-10.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

**DRAFT FOR OWNER REVIEW — 2026-10-23.** M94 translates UI00–UI07 and the
VS/PJ/AC review findings into reviewable compositions and complete journeys.
This is a proposal, not implementation approval. Only source and documents were
read; no browser, native application, suite or reference application was run.

## Intent, choices and evidence

Make existing work easier to read, find, create and recover through predictable
hierarchy, geometry and interaction. Preserve the accepted Cerebro identity and
architecture. Replacing the shell would put established navigation and ownership
at risk; changing global tokens alone would leave screen composition unresolved.
The recommended approach is a small composition contract, four representative
surfaces, owner comparison, then adoption by journey. This recommendation remains
open to owner review.

The source baseline includes shared [surface roles](../../../src/styles/surface-system.css),
[page frame](../../../src/components/pageFrame.css),
[spacing](../../../src/styles/tokens/spacing.css), first-H1 projection, stable
metadata portal, field correction status and pane navigation. Pages already has
shelves, search and list/grid; embedded databases, related tabs, record peeks,
Knowledge's three tabs and Agent Instructions/Runs/Memory already exist. These
are adoption targets, not proposed new capabilities.

The [October 22 refresh](../plans/2026-10-22-ui-refresh-plan.md) and
[VS](../plans/2026-10-22-ui-refresh-review/02-visual-system.md),
[PJ](../plans/2026-10-22-ui-refresh-review/03-product-journeys.md),
[AC](../plans/2026-10-22-ui-refresh-review/04-acceptance-challenge.md)
dossiers are dated evidence. Their temporary policy-loader startup failure is
not a current finding. Current [transcript](../../../src/agent/transcript.ts),
[context pull](../../../src/agent/useContextUse.ts), checked branching and AI
element adapters now exist. CHAT owns reconciliation and live/replay proof;
this package does not schedule another reducer or branch implementation.

Source values checked for this proposal:

| Contract             | Current baseline                                          | Proposed handling                                                        |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Shell                | 54px rail; 240px default context sidebar                  | Preserve resizing, folds, collapse and edge-to-edge canvas               |
| Native minimum       | 900×600 in `src-tauri/tauri.conf.json`                    | Test actual pane widths separately                                       |
| Document             | 40/48 title, 16/28 prose; 880px outer readable surface    | Measure resolved prose; compare 700–760px, not an automatic width change |
| Collection / utility | Existing collection 28/36; shared workspace 24/32         | Name collection 28/36 and utility 24/32 roles                            |
| Controls             | Button 28/32/36px; IconButton 24/28/32px; navigation 36px | Preserve distinct target roles; ordinary glyph 16px                      |
| Database density     | Compact/default/tall rows 32/44/56px; header 36px         | Preserve preferences; do not call 36px an existing data-row size         |
| Pages rows / frame   | 56px list minimum; toolbar 64px                           | Compare 48px single-line rows; retain coordinated toolbar frame          |

## Requirements and composition contracts

**UX-01 — Preserve identity and ownership.** Retain Instrument Sans/IBM Plex
Mono, cortex/synapse roles and both themes. Keep all destinations and persisted
widths, folds, page-tree mode, density and visible fields. Preserve the first
top-level H1 inside the sole body editor, filename fallback without writes,
guarded concept titles, stable metadata portal and single field writers. Keep
up to four panes with parked-pane editing state, one assistant instance across
floating/docked/canvas/minimized presentations, and one full-height page panel
slot for Details/Comments/History. The outline remains on-page. Opening UI writes
neither Markdown nor configuration merely to normalize appearance.

**UX-02 — Three compositions, explicit exceptions.** Propose pane-container
breakpoints at 600px and 960px for collection/utility inset: 16px below 600px,
24px from 600–959px, 32px at 960px and above; collection top inset 40px,
utility top inset 32px. These are comparison values pending owner acceptance.
Use container width, not window width. Document keeps its existing 64px toolbar
and readable/full-width choice. Align projected title, properties, tabs and prose
after editor gutters; wide embeds may overflow into their own work region.

| Composition | Concrete anatomy                                                                                            | First consumer and exception                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Document    | Toolbar → title → review/properties → tabs → authored body; optional full-height side panel                 | Long page and full record; first-H1 and Agent/concept semantics stay intact |
| Collection  | 28/36 heading → optional compact description → shelf/view controls → search/actions → broad rows/cards/data | Pages and table; no prose-width cap on data                                 |
| Utility     | 24/32 heading → grouped tasks → field-level state → Done/Cancel or repair                                   | Settings/connection repair; operational facts remain inspectable            |

Home's quiet welcome, whiteboard, sheet and time-axis work areas are intentional
exceptions. The conversation uses document reading hierarchy inside its existing
presentation; it is not a fourth global page composition.

**UX-03 — Consistent readable controls.** Keep operational text 14/20, metadata
12/18, authored/assistant prose 16/28 and compact inspector 13/18 as an explicit
exception. Reserve 11px for redundant badges/shortcuts. Use one dominant action
per decision area; keep approvals, Stop, failed saves and uncertain effects
directly reachable. Propose 6–8px ordinary control corners, 10–14px cards/menus,
20–24px freestanding conversation corners; preserve the sole canvas corner.
Use separators for adjacency, fills for grouping and shadows for overlays.
Keep icon names, keyboard focus reveal, selection versus hover and reduced
motion. A decorative icon reduction cannot remove record identity or an action.

**UX-04 — Four-surface first slice.** Compare one rich prose page, one record
with a twenty-property inspector, Pages list/grid and one populated table before
adopting across data layouts, chat or utilities. Use the same realistic content
before/after: long titles, blank values, multiline relations, rejected fields,
empty previews and selected/focused states. Owner acceptance chooses composition
values; screenshot diffs alone cannot decide whether a screen feels finished.

**UX-05 — Creation has an honest destination and session draft owner.** Show
“In …” for pages and database/home plus related host for records before Create.
Global page creation initially proposes vault root; a folder-local invocation
proposes that folder. The person can change it. Records use `createTarget` with
current schema, host and group; changing destination means choosing a database
or related context, never overriding its home folder silently. A host relation
wins over a group seed, and capability-based item-key allocation remains intact.

Closing meaningful input stores an in-memory session draft, with Resume and
Discard. Escape/Cancel close and retain; Discard is explicit. Empty unchanged
drafts need no recovery prompt. Meaningful means title or field values differ
from the opening snapshot; validation messages alone do not create a draft.
Scope by vault, kind, database/folder and related
host/group; no text appears in a different context. Changing destination offers
“Move draft here” explicitly or leaves it recoverable at its old destination.
Successful Create clears only the submitted revision; a failed request preserves
exact input and field errors. Same-tick Enter/click/modifier Enter share one
pending guard; IME Enter never submits. Session recovery ends when the app
process ends; restart/crash archives require a separate owner retention gate.

Pending submission ownership lives in `creationDraftStore`, outside the dialog.
Before any writer call, atomically allocate a stable submission ID and freeze its
context, destination, draft revision and exact input snapshot. Close/unmount and
vault switching do not release that pending ownership or cancel its completion
handler. Resume shows “Creating…” and blocks another Create for that key until
the original call is acknowledged or explicitly reconciled. A timeout alone
cannot enable retry. Delayed success clears only the exact submitted revision;
delayed failure attaches errors only to that revision, retaining a separately
inspectable submission result if a newer draft exists. Neither outcome navigates
another vault or unmounted composer. Discard/move cannot erase a pending snapshot.

**UX-06 — Predictable return and metadata.** Keep Pages full-page intent and
Quick Open/record peek intent; offer consistent Open page/Open beside. Preserve
query, shelf, display, filter, scroll and surviving opener across promotion,
relations and Back. Existing `navigate`, `navigateIn`, `openPane` and
`useOpenPath` remain the navigation API. Use Properties for editable metadata,
“Show all properties”/“Hide properties” for inline disclosure and Details for
broader inspection. Preserve exact refused drafts and `AnchoredFieldStatus`;
never raise edited cells above frozen columns. Menus and commands share labels
and availability from existing registries. Missing targets explain availability
and allow return; they do not reset the origin.

**UX-07 — Data and embedded work adoption.** Carry collection hierarchy into
tables, galleries, boards, calendar, timeline/Gantt and dashboard controls while
retaining each layout's work geometry. Name database, saved view and related
scope consistently in embedded/related/full-page views. Related New preserves
membership/home/key semantics; global embeds do not imply a host. Keep wide
content in its own scrollport. Bounded rendering/performance is REL-owned; no
CSS containment change may remove keyboard End, find, wrapped rows or refused
drafts merely to lower timings.

**UX-08 — AI grammar uses real producers.** Adopt existing AI Elements through
surface adapters; primitives remain presentation-only under CV-64. Answer prose
leads; tool/child work is secondary disclosure. Align answer, composer, sources
and artifact edges. Approval identifies account/target/consequence from ACT;
unknown effects stay `outcome_unknown`, never success or a generic safe Retry.
CHAT owns source/context receipts, live/replay identity, branch/recovery and saved
answer semantics. Only expose functioning actions with those contracts. Preserve
draft, stream, pending decision, scroll and focus across all presentations; while
reading earlier content, streaming never forces bottom scroll.

**UX-09 — Utilities preserve product meaning.** Adopt composition/state grammar
in Knowledge, Home, Library, Agents, My work, History, Settings, search and
dialogs. Knowledge keeps Concepts/Review/Activity and human-only Verify;
proposal approval is distinct. Home remains pull-only and empty lanes silent.
Connection repair distinguishes configured, authenticated, transport healthy and
action callable, and returns to the originating draft. Secrets remain concealed.
The [Agent grant editor](../../../src/library/AgentProperties.tsx) must represent
a failed connector-list read as unavailable with local Retry, preserving its
open grant draft and named tools. Execution failing closed does not justify
showing a successful empty connector inventory. KNOW separately owns accurate
scope-descriptor/missing-source classification in evidence rows; utility styling
cannot turn either into a vault file.
Passage navigation uses KNOW's source-location contract; UI styling does not
deliver that capability or invent a parallel locator.

**UX-10 — State, accessibility and evidence gates.** Preserve CV-44 ready,
empty, not recorded, partial and unavailable presets. Loading and transient dirty,
failed, waiting, interrupted and uncertain-effect states supplement them in
journey fixtures. Failed reads never become empty; absent usage never becomes
zero. Errors retain usable neighboring sections. Test focus, layer Escape,
independent scrollports, editor selection, IME and reduced motion. Record
source/build identity, actual pane CSS width, viewport, scale, zoom, content and
result for each capture; historical screenshots are reference only.

## Proposed interfaces and ownership

New paths below are proposals. `src/engine/creationDestination.ts` owns a pure
request identity; existing writer guards remain authoritative:

```ts
type PageCreationRecipe = { kind: 'blank' } | { kind: 'sheet'; sheetName: 'Sheet1' };
type CreationDestination =
  | { kind: 'page'; folder: string; recipe: PageCreationRecipe }
  | {
      kind: 'record';
      typeName: string;
      host: { path: string; field: string } | null;
      group: { field: string; value: string } | null;
    };
type CreationContext = {
  vault: string;
  pane: PaneId;
  destination: CreationDestination;
};
function creationDraftKey(context: CreationContext): string;
```

`creationDraftKey` serializes a canonical tuple of vault and destination fields;
pane is origin/focus information, excluded from the key so opening another pane
cannot create a second draft owner. Folder and vault identities come from existing
validated paths, never display labels. Record host paths must resolve again
before Create. Missing/moved destinations require explicit reselection.

The first recovery stage covers plain pages, sheet pages and ordinary records.
The [launcher](../../../src/app/CreateLauncher.tsx) currently opens plain and
sheet creation through the same [dialog](../../../src/app/CreateMenu.tsx), whose
`sheet` flag changes the written body. Therefore `recipe` is frozen at opening,
included in the canonical key and submitted snapshot, and never read from the
currently mounted dialog. Plain-page and sheet drafts at the same folder cannot
resume, clear, block or submit one another. Create more preserves the recipe.
Template, whiteboard, database/CSV, import, collection, capture and Studio flows
retain their current owners; they gain no recovery promise from this stage.
Any later template recipe must include its pinned identity/version and immutable
seed payload in the request before sharing this lifecycle.

Proposed `src/stores/creationDraftStore.ts` holds immutable snapshots:

```ts
type CreationDraft = {
  context: CreationContext; revision: number; title: string;
  values: Record<string, unknown>; createMore: boolean;
  fieldErrors: Record<string, string>; formError: string | null;
};
type CreationSubmission = {
  id: string; context: CreationContext; draftRevision: number;
  snapshot: CreationDraft;
  state: 'pending' | 'succeeded' | 'failed';
  path: string | null; error: string | null;
};
type CreationSubmitStart =
  | { kind: 'started'; submission: CreationSubmission }
  | { kind: 'pending'; submission: CreationSubmission }
  | { kind: 'stale' };
readCreationDraft(context: CreationContext): CreationDraft | null;
saveCreationDraft(draft: CreationDraft): void;
discardCreationDraft(context: CreationContext, revision: number): boolean;
clearCreationDraftsForVault(vault: string): void;
claimCreationDraft(context: CreationContext, ownerId: string): boolean;
releaseCreationDraft(context: CreationContext, ownerId: string): void;
moveCreationDraft(from: CreationContext, to: CreationContext,
  revision: number): boolean;
readCreationSubmission(context: CreationContext): CreationSubmission | null;
beginCreationSubmission(context: CreationContext,
  revision: number): CreationSubmitStart;
settleCreationSubmission(id: string,
  result: { kind: 'succeeded'; path: string } |
          { kind: 'failed'; error: string }): void;
```

`beginCreationSubmission` returns the pending operation regardless of a newer
draft revision; otherwise a mismatched revision is stale. Only `started` invokes
the writer. Proposed `src/app/creationSubmission.ts` exports
`submitCreationDraft(context: CreationContext, revision: number): CreationSubmitStart`;
it begins atomically, validates/re-resolves the frozen target, then runs the
existing guarded writer and settles its promise outside React component lifetime.
The submission ID is session correlation/deduplication, not a backend exactly-once
guarantee. Settlement is idempotent by ID and never starts another write. The
store retains pending snapshots even if their dialog claim is released; explicit
vault clearing removes ordinary drafts but retains pending snapshots until
settlement, suppressing later draft restoration for that cleared vault.

One active composer claims each key through the singleton launcher; a false
claim leaves its existing flow/dialog open and offers Resume after it closes.
Only the matching owner can release a claim. A move succeeds atomically only
for the current revision and an unoccupied destination key; otherwise it returns
false and retains both drafts. Revision-checked discard prevents an older
completion from erasing newer edits. Vault switching retains inaccessible drafts
until returning; `clearCreationDraftsForVault` is the clearing boundary for future
explicit vault removal and current test isolation, not an invented removal UI.
No draft bytes enter localStorage,
runtime.db, logs, analytics, assistant prompts or the vault before Create. This
store is not REL's editor save queue or CHAT's conversation draft/archive.
The later [M98.7 intake extension](../plans/2026-10-23-m98-workflows-and-automation.md)
must consume this same context/draft/revision/claim/submission identity and the
existing Resume/Discard owner. Any persistence adapter is separately opt-in and
owner-gated; the first UX stage remains session-only.

Navigation stays exactly `navigate(sel: Selection, options?: NavigateOptions):
NavOutcome`, `navigateIn(pane: PaneId, sel: Selection, options?: NavigateOptions):
NavOutcome` and `openPane(sel: Selection, options?: OpenPaneOptions): NavOutcome`.
No new source-location field is added here. KNOW owns that extension and its
fallback/version semantics; a dependent UI task waits for its reviewed interface.

KNOW's `openSource`/`returnToSourceOrigin` coordinator consumes these existing
navigation outcomes and binds reveal to the actual holder or peek. Its
session-only Quick Open origin snapshot owns query/category/level/expanded
results/active-row/scroll restoration; UI adoption does not promise that ordinary
Back reopens every closed dialog. M94.5 consumes that contract only after M97.2,
including reused editors, peek promotion and M92 canvas-safe source actions.

## Acceptance, compatibility and decisions

No document/schema/persistence migration is proposed. Preserve user preferences;
unaccepted visual comparisons cannot rewrite saved density or full-width values.
Keep existing selectors and destination vocabulary unless an approved change
includes its consumer migration. REL owns failed-save/quit recovery, scoped
history and scale targets; UX integrates their acknowledged status and records
unclosed dependencies rather than claiming cosmetic fixes.

Required evidence profiles are 1440×900 and 1024×768 at 100%, packaged native
900×600, a 360px content host inside the supported shell, and real 200% zoom at
desktop plus the highest-risk narrower scene. Record both themes and reduced
motion for transitions. A 360px browser stress case is not a supported native
window claim. Measure rendered contrast and target sizes separately from owner
judgment; no broad accessibility conformance is claimed by this slice.

The owner reviews: three compositions and comparison values; 48px Pages rows
versus current 56px; meaningful-draft Resume/Discard copy and destination transfer;
surface adoption order; final light/dark appearance. Restart recovery/retention
requires a separate proposal and explicit approval. No current observation closes
native IME/VoiceOver, clipboard/drop/dialogs, links/CSP, activation or failed-save
quit. A lost draft, wrong target/vault, clipped decision, false Saved, broken
focus or unavailable-as-empty blocks the exposed journey independently of visual
acceptance. The companion plan enumerates future evidence; none is claimed run.

## Research disposition

| Evidence               | Disposition and requirement                                                       | Plan task                 |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------- |
| UI00                   | Reconcile current source/build; historical startup failure is not current (UX-10) | M94.1                     |
| UI01                   | Three compositions and role comparisons (UX-01–03)                                | M94.2                     |
| UI02                   | Four concrete surfaces before adoption (UX-04)                                    | M94.3                     |
| UI03                   | Session creation recovery, properties and return (UX-05–06)                       | M94.4–M94.5               |
| UI04                   | Existing data/display adoption (UX-07)                                            | M94.6                     |
| UI05                   | Existing M91 adoption; new contracts owned CHAT (UX-08)                           | M94.7                     |
| UI06                   | Utility/state adoption (UX-09–10)                                                 | M94.8                     |
| UI07                   | Separate visual/browser/native/performance dispositions (UX-10)                   | M94.9                     |
| VS01, VS02             | Composition/resolved document geometry (UX-02)                                    | M94.2–M94.3               |
| VS03, VS04, VS07, VS11 | Action/type/corner/icon role inventory (UX-03)                                    | M94.2–M94.3               |
| VS05                   | Preserve shell, refine rhythm (UX-01–03)                                          | M94.3                     |
| VS06                   | Content-driven density/card comparison (UX-03–04, UX-07)                          | M94.3, M94.6              |
| VS08                   | Existing full-height inspector refinement (UX-01, UX-06)                          | M94.3, M94.5              |
| VS09                   | Conversation adoption with CHAT contracts (UX-08)                                 | M94.7                     |
| VS10, VS12, VS13       | Theme/motion/states across compositions (UX-03, UX-10)                            | M94.2–M94.3, M94.8–M94.9  |
| PJ01                   | Single REL save/quit work item; integrate acknowledged state (UX-06, UX-10)       | M94.3, M94.9              |
| PJ02                   | Single REL performance work item; preserve interactions (UX-07)                   | M94.6, M94.9              |
| PJ03                   | Visible destination/session draft; restart deferred owner gate (UX-05)            | M94.4                     |
| PJ04, PJ05             | Return ownership/properties vocabulary (UX-06)                                    | M94.5                     |
| PJ06                   | Existing embedded/related view clarity (UX-07)                                    | M94.6                     |
| PJ07                   | KNOW owns passage delivery; UX consumes after contract review (UX-09)             | M94.8                     |
| PJ08                   | Shared commands and menu vocabulary (UX-06)                                       | M94.5                     |
| PJ09                   | ACT owns readiness/action authority; UX repair journey (UX-09)                    | M94.8                     |
| PJ10                   | CHAT owns result/recovery producers; UX adoption (UX-08)                          | M94.7                     |
| PJ11, PJ12             | Knowledge semantics, quiet Home and state journeys (UX-09–10)                     | M94.8–M94.9               |
| AC01, AC02             | Source reconciliation and separate completion gates (UX-10)                       | M94.1, M94.9              |
| AC03                   | REL editor draft ownership; UX creation ownership distinct (UX-05–06)             | M94.4, M94.9              |
| AC04, AC05, AC06       | Actual widths/zoom; human/accessibility; focus/status/scroll (UX-10)              | M94.3, M94.5, M94.7–M94.9 |

## M91–M92 integration boundary

[M92 — The conversation rail](../plans/2026-10-23-m92-conversation-rail.md) remains the owner of the canvas-only Conversation details rail, its read-only cards, shared Context pull, Plan/Subagents/Changes/Sources/Handed off adapters, reach/thread-status facts and canvas-safe navigation. Reconcile the accepted M91→M92 handoff at its recorded revision before this milestone changes those shared files; preserve the single assistant instance and live state. Unfinished or unverified M91/M92 work stays assigned to its existing milestone, with dependent work waiting on that gate.

M95 source-context receipts record source delivery and evidence provenance; they do not persist context-token readings or add a second context poll. The read-only rail may link to the owning inspection/settings surface. New managed account/action controls need M96 ownership and must not silently replace M92 rail behavior.
