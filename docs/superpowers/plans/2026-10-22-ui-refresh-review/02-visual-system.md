# Visual-system review: finish the composition, preserve the identity

Reviewed 2026-10-22. This is an independent source and reference-image pass for the owner's requested UI refresh. It proposes design work; it changes no application code. Current-browser findings are maintained by the integrated review, and are not inferred from CSS alone here.

**Recommendation:** evolve the existing system into a more consistent, writing-centered product. Cerebro already has the right broad structure and most of the necessary primitives. Its next gain comes from choosing fewer compositions and applying them deliberately across pages, data views, assistant controls and overlays. A fresh font, another sidebar redesign, additional animation, or uniformly larger titles would spend effort without addressing that consistency.

## Evidence and what is already delivered

The [M71–M79 record](../2026-10-16-m71-m74-visual-redesign.md) establishes the 54px rail, accepted 240px default context sidebar, pane-aware layout and single assistant instance. The [M84–M90 implementation record](../2026-10-17-m84-m90-implementation-record.md) establishes semantic typography, title projection inside the real editor, preserved metadata ownership, table corrections, shared states and broad surface adoption. Its browser checks are historical evidence, not a new test pass. Native interaction and owner aesthetic acceptance remain explicitly open.

Current source additionally contains changes dated October 18–19: the full-height Details/Comments/History slot, quieter inspector, pill toolbar, floating assistant, enter/exit motion and card feedback. These must be part of the baseline, even when older plans describe them as future work.

| Existing system                                                                                        | Source evidence                                                                                                                                                                                                               | Consequence for the refresh                                                                  |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Instrument Sans / IBM Plex Mono; page 40/48, workspace 24/32, prose 16/28, UI 14/20, metadata 12/18    | [Typography](../../../../src/styles/tokens/typography.css)                                                                                                                                                                    | Keep these roles; document legitimate exceptions and remove accidental ones.                 |
| 4px spacing, 28/32/36px controls, 36px navigation rows, 880px readable and 1120px broad outer surfaces | [Spacing](../../../../src/styles/tokens/spacing.css)                                                                                                                                                                          | Existing tokens are sufficient for most changes. Outer width is not the actual text measure. |
| Light/dark neutral ramps, paired action colors, cortex selection and synapse AI identity               | [Colors](../../../../src/styles/tokens/colors.css)                                                                                                                                                                            | Preserve identity and contrast pairings; quieter presentation must not mean faint text.      |
| Keyboard-aware hidden table chrome and no extra inset inside cells                                     | [Table chrome](../../../../src/styles/table-chrome.css)                                                                                                                                                                       | Do not recommend this as a missing capability or reintroduce permanent cell glyphs.          |
| Tokenized hover, move, enter, pop and exit with reduced-motion handling                                | [Motion tokens](../../../../src/styles/tokens/spacing.css)                                                                                                                                                                    | Audit movement's purpose and interaction timing; do not add an animation layer by default.   |
| Shared page frame, toolbar, headers, states and AI primitives                                          | [Frame](../../../../src/components/pageFrame.css), [headers](../../../../src/components/pageHeader.css), [surfaces](../../../../src/styles/surface-system.css), [AI foundation](../../../../src/components/ai/foundation.css) | Composition and actual adoption matter more than another component inventory.                |

Reference images were opened and visually inspected: Tolaria's [light](../../../examples/tolaria-main/site/public/landing/tolaria-screenshot.png) and [dark](../../../examples/tolaria-main/site/public/landing/tolaria-screenshot-dark.png) workspace captures, Plane's [Pages onboarding image](../../../examples/plane-preview/apps/web/app/assets/onboarding/pages.webp), and AppFlowy's [workspace-switcher image](../../../examples/AppFlowy-main/doc/readme/desktop_guide_1.jpg). These supplied images have no established capture date and do not prove current interaction behavior. The Plane image is a promotional crop, not a complete application capture.

Tolaria's useful lesson is continuous content edges and a plainly structured property column; Cerebro now has that architecture. Plane's image gives writing priority over contextual controls. AppFlowy's switcher keeps identity, selection and creation visually distinct. Morrow's [actual CSS](../../../examples/Morrow-main/src/app/styles/app.css) supplies a 720px page measure, 40px title and compact 30px navigation; Thought Desk's [system CSS](../../../examples/thought-desk-main/src/app.css) supplies a 708px page measure and deliberately concentric nested corners. Those are evidence of coherent choices, not instructions to copy their dimensions, tiny text or brands. Macro's shell influence is already acknowledged in M71; redoing that shell would not be a new discovery.

## Ranked design work

The following are **source-confirmed differences and proposed design candidates**, not thirteen proven runtime defects. Priority reflects likely visual reach and dependency. Each needs an actual before/after capture and owner review; a source value alone cannot establish whether something looks wrong.

### VS01 — Specify three page compositions before touching tokens

**Priority P1; impact very high; medium effort.** Current pages use several legitimate but undocumented combinations: [generic headers](../../../../src/components/pageHeader.css) have 24/32 headings with 32px top and 24px horizontal padding; [Pages](../../../../src/pages/pagesBrowser.css) has 28/36 headings, 36px top and 24–64px responsive horizontal padding; [database pages](../../../../src/styles/surface-system.css) use 28/36 with 40px top and a 16–48px inset. [Library](../../../../src/pages/workspacePages.css) adds 48px top and 32px horizontal padding. This is visible drift risk, not proof that every difference is wrong.

Propose three named compositions: **document** (existing 40/48 title and content measure), **collection** (28/36 title, controls and data sharing one edge), and **utility** (24/32 title, compact task-oriented body). Start collection pages with 40px top and 32px inline inset, reducing to 24px and then 16px as the pane narrows. Declare intentional Home and tool exceptions. Keep document toolbar geometry independent from body composition. Acceptance: Pages, Library, Knowledge and a database share their chosen edge and title role at 1440 and 1024; opening an inspector does not introduce a fourth composition.

### VS02 — Make document geometry an explicit resolved contract

**P1; very high impact; medium effort.** [Page CSS](../../../../src/pages/pages.css) sets an 880px outer container and 32px padding; [editor CSS](../../../../src/editor/editor.css) separately accounts for BlockNote gutters and compact/narrow hosts. The 880px value must not be compared directly with Morrow's 720px text width. Measure the final title/prose/property edges after editor gutters, custom blocks and title projection.

Propose an approximately 700–760px ordinary prose measure at desktop, subject to actual font/content measurement; preserve the user's full-width preference and independently scroll wide data. Title, byline/properties, tabs, paragraph text and ordinary embeds should have one documented content start. Hover handles occupy a reserved gutter, not an extra shift on interaction. Acceptance: long title, titleless filename fallback, nonleading H1, concept review, agent tabs and related records align without a second editor, source reordering or metadata remount.

### VS03 — Give action groups a consistent hierarchy

**P1; high impact; medium effort.** [Page toolbar](../../../../src/components/pageToolbar.css) now has rounded breadcrumb and action groups; Pages has pill search/New/display controls; the [base Button](../../../../src/components/ui/Button.tsx) uses an 8px radius. These are established looks, but their roles need a rule.

Propose one dominant action per local decision area, quiet icon actions for routine page operations, and labelled destructive or consequential actions when the decision is open. Preserve individual Details, Comments and History buttons. Use pills for search, segmented shelf selection and the conversational composer; use rounded rectangles for ordinary form actions. Do not quietly demote unresolved save errors into an overflow menu. Acceptance: a page toolbar, creation dialog, connector setup and approval each have an unambiguous next action; no duplicated primary buttons compete within the same action area.

### VS04 — Reconcile typography exceptions instead of flattening them

**P1; high impact; small-to-medium effort.** Global typography already exists. [Pages rows](../../../../src/pages/pagesBrowser.css) use 15px titles/13px secondary text; [inspector](../../../../src/detail/inspector.css) deliberately overrides UI to 13/18; [AI conversation](../../../../src/components/ai/conversation.css) mixes existing 11–14px roles for small controls. These differences may be useful, but are not currently one easy-to-review role map.

Adopt a documented inventory: 14/20 operational text, 12/18 metadata, 13/18 compact inspector text as an explicit exception, 16/28 authored or assistant prose. Reserve 11px for redundant badges/shortcuts, never sole instructions or important execution status. Keep 600 for headings, 500 for selected/action labels and 400 for body; do not turn every page title bold to manufacture hierarchy. Acceptance: compare real dense content in both themes and 200% browser zoom; no loss of text or reliance on tooltip-only critical information.

### VS05 — Tune the existing rail/sidebar rhythm

**P1; high impact; medium effort.** [Shell](../../../../src/app/shell.css) already has 36px rail targets, 36px context rows, explicit selected fills, reveal animation and distinct nested-control hover. Keep the 54px rail and accepted 240px default sidebar.

Propose 16px contextual text-edge alignment, 8px icon/label gaps and a consistent trailing action/count slot; preserve actual tree depth and fold preferences. Selected global area, selected collection and open page should have distinct roles without three equally dark slabs. Do not imitate Morrow's 30px navigation simply to fit more rows. Acceptance: long names, nested folders, active search, collapsed context and empty sidebar remain legible; hover/focus does not shift labels or hide the only route to a command.

### VS06 — Standardize density by content, including cards

**P1; high impact; medium effort.** Home/work rows are generally 48px minimum; [Pages list rows](../../../../src/pages/pagesBrowser.css) are 56px, with 32×34px outlined file tiles; Pages cards are at least 210px with 22px padding and 20px gaps. These differences are concrete; whether they are too airy requires a dense corpus capture.

Propose a 48px ordinary navigation/list row, 56–64px only when a real second line is present, and preserve existing 32/44/56px database row roles. A 36px data-row comparison would be a new proposal; 36px is currently the table header height. Prototype Pages at 48px with a quieter 20–24px file identity mark, retaining the current version for comparison. Cards should earn height through preview content, not empty padding. Acceptance: show the same twelve records in list/grid/table, including long and empty previews; scanability improves without clipping, lost hit targets or unseen favorites controls.

### VS07 — Assign border, corner and elevation roles

**P1; high impact; small-to-medium effort.** Radius tokens already span 4/6/8/10/14px; live styles also use 12px toolbar groups, 16px canvas corner, 18px messages and 24px floating chat/composer. The problem is not missing tokens. It is determining which differences express nesting and which merely accumulated.

Propose 6–8px controls, 10–14px cards/popovers, and 20–24px only for freestanding conversation surfaces. Keep the canvas's sole rounded corner. Use hairlines for adjacent content, fill for grouping, and shadow only for something floating above another surface. For nested rounded surfaces, inspect inner corners against padding instead of assigning both the same radius. Acceptance: a screenshot montage of menus, field popovers, cards, dialog and chat reads as one family in both themes; body content is not unnecessarily boxed.

### VS08 — Treat the inspector as a property surface, not a second page

**P1; high impact; medium effort.** [Inspector CSS](../../../../src/detail/inspector.css) already intentionally implements a 100px label column, 30px rows, 13/18 text, quiet separators and subdued comment actions. Full-height side-panel behavior is delivered, not missing.

Refine within that design: align long values and multi-line relations to the same grid; use disclosure for low-frequency system facts; keep edits/status attached to the field. Preserve useful empty values in Details while table blanks remain quiet. Acceptance: a 300px panel with twenty properties, relation chips, a failed edit and a comment draft stays readable, independently scrollable and keyboard operable. At narrow widths the drawer has a visible close affordance and does not move the underlying editor to fake space.

### VS09 — Give chat the same visual grammar as the document

**P1; very high impact; medium-to-large effort.** [Chat CSS](../../../../src/agent/chat.css) defines a 760px reading width and existing floating/panel/canvas presentations. [AI primitives](../../../../src/components/ai/foundation.css) have tokenized badges, rows and disclosure. A polished component gallery does not establish integrated transcript quality.

Use prose as the primary layer, compact execution summaries as secondary, and detailed tools/subagents behind meaningful disclosure. Let synapse identify the assistant and active decisions without violet-tinting every card. Align composer, answer, source cards and artifact edges; use one style for the same action state across chat and agent pages. Acceptance: a long answer with six sources, three subagents, a pending approval and a failed action remains easy to read in each presentation. Changing presentation preserves thread, stream, draft and focus ownership.

### VS10 — Review dark theme as a composition

**P2; high impact; medium effort.** The dark palette is already deliberate neutral graphite with separate action pairings. No new dark-theme system is needed. Evaluate actual adjacent surfaces: rail, navigation, canvas, selected row, input and popover. Tolaria's supplied dark capture illustrates separation by subtle surface steps, not by bright outlines around every object.

Preserve readable secondary ink and meaningful selection/focus contrast. Adjust border strength or local fill before changing all text. Acceptance: identical light/dark scenes with selected, hovered, disabled, invalid and focused controls; selection remains distinct from hover and every essential state has more than a color cue. Existing contrast gates remain mandatory during future implementation.

### VS11 — Make icons quieter and targets dependable

**P2; medium impact; small-to-medium effort.** [Icon](../../../../src/components/ui/Icon.tsx) already defaults to 16px/1.75 stroke, while [IconButton](../../../../src/components/ui/IconButton.tsx) owns sizes and feedback. Avoid replacing the icon family.

Audit ad hoc file tiles, oversized header symbols and repeated decorative icons. Keep 16px for ordinary chrome and 18–20px for major rail/context marks where optically appropriate, with consistent target sizes independent of the visible glyph. Preserve meaning-bearing status/relationship marks and keyboard-revealed controls. Acceptance: icon-only actions have names, hover/focus feedback and usable targets; removing decoration does not remove type identity or action discoverability.

### VS12 — Refine movement by intent

**P2; medium impact; small-to-medium effort.** Current motion is rich: sidebar return, drawer travel, panel entry, page fade, section stagger and spring marks. The [page frame](../../../../src/components/pageFrame.css) already avoids moving parents that would disturb fixed editor menus and disables interaction during entry where necessary.

Keep short feedback for direct manipulation, reserve larger travel for actual spatial movement, and avoid repeated entrance on ordinary refresh. Run a full page→Details→Comments→chat journey to judge cumulative motion. Acceptance: reduced motion produces no travel/stagger; focus can never land in an exiting duplicate; opening an anchored menu during adjacent animation does not place it incorrectly. Do not add animation merely to make a screenshot look more modern.

### VS13 — Make polished states part of every composition

**P1; high impact; medium effort.** Shared [state messages](../../../../src/styles/surface-system.css), state-lab coverage and M84–90 browser evidence already exist. Extend their use to new AI/connector/workflow journeys instead of claiming a blank slate.

Each chosen composition must show populated, empty, loading, unavailable and partial/action-required states. Loading preserves approximate geometry; empty offers one relevant next action; failed reads cannot resemble an empty collection. Approval and recovery cards should name the target and consequence without exposing irrelevant implementation detail. Acceptance: the same five-state montage is reviewed for Pages, Knowledge, Agents, connectors and conversation; retries preserve the visible user's context and draft.

## Acceptance and implementation boundary

| Viewport or mode                         | Required visual judgment                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440×900                                 | Rail/context/page hierarchy; long document; dense collection; Details and assistant combinations; one clear content edge per composition.                 |
| 1024×768                                 | Actual drawer transition and narrower page budget; no squeezed desktop layout masquerading as responsive design; critical actions stay visible.           |
| Narrow pane and minimum supported window | Use the real pane width, not only window width; drawers close and return focus; labels wrap or deliberately truncate; wide data scrolls inside its owner. |
| 200% browser zoom                        | Test actual zoom, not screenshot enlargement; actions and menus remain usable, focus visible, titles wrap, persistent status remains readable.            |
| Both themes; keyboard; reduced motion    | Selection/hover/focus distinction; complete journeys; no animation-dependent understanding.                                                               |

Deliver three reviewed composition boards first: ordinary page with inspector, collection with list/table/grid, and conversation with a consequential action. Each board should show real Cerebro content, not invented marketing placeholders. Then apply VS01–09 and VS13 to a small representative slice, judge the result with the owner, and propagate approved decisions. This is aesthetic review of concrete output, not a requirement to stop before doing authorized design work.

Native WKWebView text, IME, VoiceOver, focus, clipboard/drop and save/quit acceptance remain separate from these browser design checks. Large-table latency is a product-quality issue explicitly still open in the M84–90 record; prettier rows cannot close it. No tests, app code, reference repositories or visual assets were modified by this review.
