# Cerebro workspace redesign — M71–M79

**Status: implemented and browser-verified, 2026-10-16.** The owner explicitly authorizes replacing
the former one-sidebar design. This is the design contract for the
[implementation plan](../plans/2026-10-16-m71-m74-visual-redesign.md), not a claim
that every surface or packaged interaction has passed verification.

The subsequent [M80–M83 polish](../plans/2026-10-16-m80-m83-ui-polish.md)
centers the empty conversation's greeting and composer, quiets navigation,
improves Home/document reading, and bounds the Library shelf without changing
the architecture below.

## Direction and references

The supplied ChatGPT screenshots establish the desired proportions: a dark,
persistent icon rail around 54px wide; a quieter contextual sidebar around
280px; a broad primary canvas; and a centered conversation column around
760px. These are target proportions from the request, not measurements of a
running Cerebro build. The canvas should feel like the main place to work,
with less competing chrome and clearer separation between navigation,
content and secondary actions.

Macro is a behavior and composition reference. Targeted reads on 2026-10-16:

| Vendored reference, under `docs/examples/macro-main/` | Relevant observation | Cerebro decision |
| --- | --- | --- |
| `apps/web/src/components/app/sidebar-next/sidebar-rail.tsx` | A persistent 56px rail separates global navigation from content; icon controls have tooltips. | Use the owner's 54px target, Cerebro destinations and accessible names. |
| `apps/web/src/components/view-shell/ViewSidebar.tsx` | Context sidebars share header, content, selected-row and focus anatomy. | Give the existing trees and contextual controls a consistent frame. |
| `apps/web/src/components/app/split-layout/SplitLayout.tsx` | Stable pane identities and explicit focus ownership survive layout changes. | Preserve Cerebro's existing pane claims, histories and mounted editors. |
| `apps/web/src/features/block-chat/component/Chat.tsx` | Transcript and composer share a centered, bounded column. | One assistant instance can use a roomy canvas or the existing side panel. |

No Macro code, styles, identifiers, fixtures or brand assets are copied. Its
SolidJS/cloud architecture is not part of this redesign. The reference tree
remains outside project lint, tests and source inventories.

## Visual system

Keep **Instrument Sans** for interface and reading, **IBM Plex Mono** for
code and compact metadata. Keep the existing token vocabulary: cortex for
navigation and ordinary actions, synapse for assistant activity, and the
semantic success/warning/danger colors. Dark graphite framing follows the
screenshots while light and system themes remain first-class states.

Use surface levels, spacing and typography to establish hierarchy. Reserve
strong borders and accent fills for real selection, focus or action. Do not
replace every section with a card or repeat page titles in several toolbars.
Use the existing type and spacing scales; do not shrink all interface text
to make the new frame fit. Readable conversation text can use the existing
16px/24px scale while dense metadata remains secondary.

## Shell

- A **54px persistent rail** owns global wayfinding. Icon controls expose
  names and shortcuts through tooltips and accessibility labels. Selection
  and keyboard focus must remain distinguishable without color alone.
- A **contextual sidebar**, **240px by default**, holds the
  current workspace's trees and secondary navigation. It can resize or
  collapse without removing the rail. Preserve usable saved width/fold
  preferences and validate old persisted values. The 240px implementation
  default was accepted after a 1440px screenshot review on 2026-10-16; the
  reference is approximately 280px, and resizing remains available.
- The **canvas** takes the remaining space. Context navigation yields before
  the focused editor or primary action becomes unusable. A narrow context
  drawer restores focus to its opener when dismissed.
- Every existing destination and nested subject stays reachable: Inbox,
  Home, My work, Studio, History, Library, Settings, Work repositories,
  Knowledge, agents, collections, pages, databases and favorites. Context
  changes must not make a destination disappear from all navigation.
- Labels and internal selection kinds continue to come from the existing
  destination model. This is not a migration of files, history slots or MCP
  navigation words. Active destination and active nested page are separate
  levels, not contradictory selected siblings.
- Existing page panes, peek, page side panels and assistant presentation
  must share explicit width/focus rules. Hidden or parked regions are inert;
  mounted editors and streaming state are retained where their lifecycle
  requires it.
- Inbox, Settings, Work and an open Studio project lend their existing
  navigation controller to the context sidebar through `PageNavigation`.
  Only the active pane owns this portal; inactive panes retain local
  navigation, and Assistant canvas takes priority. Narrow drawers return
  focus to their explicit opener and preserve the owning page's key scope.

M37.3/M43 established the former single nav column. The owner's M71 decision
supersedes that geometry. Their destination naming, page model and interaction
contracts still apply.

## One assistant, two presentations

Panel and canvas are presentations of **one assistant instance**. A canvas
conversation uses a centered column near 760px with generous outer space;
the panel uses the space available beside work. Transcript and composer
align, tool results remain readable, and the composer remains reachable in
long conversations and short windows.

Switching presentation must preserve the current thread, draft, attachments,
streaming turn, scroll intention and pending approvals. It must neither send
a message nor spawn a second run. Returning to the panel restores the
underlying page and its editing state. Closing or hiding the surface retains
the existing detach semantics; Stop, Steer, vault switching and quit retain
their established meanings.

Keep model/effort choices, context attachment, tool and result folds,
permission prompts, ask-first review cards, failures, retries and thread
history. A cleaner layout must not conceal the fact that a run is waiting for
a person's decision. No approval is inferred from changing layout.

## Home and pages

Home gets a clearer title/action hierarchy, more deliberate whitespace and
quiet, scannable lanes. It keeps its pull-only semantics: empty lanes remain
quiet, failed reads remain unavailable, proposals retain their existing
decision doors, and only eligible event rows receive Done. Do not invent
counts, notifications or summary claims to fill the new layout.

Document and record pages share a more coherent reading frame: title,
optional icon/cover, properties, body, tabs and secondary details. Preserve
editing, save indicators, stale-content handling, links, comments, backlinks,
history, favorites, exports and embedded media/sheets/boards. Tables, code and
canvas content can use appropriate width; a reading-column limit must not
clip their controls or overwrite stored page-width preferences.

Shared surface headers use a quiet 24px heading with wrapping actions and
metadata; document and Inbox body titles use 32px. My work aligns dates and
statuses, Library cards prioritize title and purpose, and Knowledge summaries
wrap without crowding guarded decisions. Settings uses eleven contextual
sections with retained drafts. Work and Studio put their existing file/page
navigation in context; History, media and whiteboards share the quieter chrome.

## Responsive and accessible behavior

Verify 900px, 1024px, 1280px, 1440px and wide desktop windows, including
rail/context/canvas plus both secondary panels. The native minimum remains
900px unless separately changed. Browser checks at smaller widths and text
zoom should expose overflow and focus defects, not imply a new mobile app.

Rail controls need comfortable hit areas within the rail, keyboard access,
visible focus and labels independent of tooltips. Keep Escape ownership,
focus return, active-pane shortcuts, screen-reader landmarks, reduced motion
and readable contrast in both themes. No critical control may be reachable
only on hover. Resize/collapse/presentation changes do not steal an active
typing focus or make hidden content tabbable.

## Completion boundary

M71–M79 implement the shell, conversation presentation, page hierarchy and
the further surface work identified by the live audit. The plan records
actual light/dark screenshot coverage, focused interaction checks, broader
regression results and the regular macOS bundle's provenance.

Implementation and browser verification are complete. Interactive packaged
window/menu/focus and user-vault behavior remain separate acceptance work;
the app was not installed or launched against a real vault. Live Claude CLI
verification remains deferred by the owner. A successful build must not be
represented as proof of those interactions.
