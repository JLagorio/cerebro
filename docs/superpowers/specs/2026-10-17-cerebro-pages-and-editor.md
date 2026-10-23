# M85–M86 — Pages, records and authoring

**Status: Design specification, 2026-10-17; implementation subsequently authorized.**
This contract is not a claim that every acceptance check has passed. Actual implementation and
evidence are recorded in the [implementation record](../plans/2026-10-17-m84-m90-implementation-record.md).
It follows the implemented [M71–M79 redesign](../plans/2026-10-16-m71-m74-visual-redesign.md)
and [M80–M83 polish](../plans/2026-10-16-m80-m83-ui-polish.md).

## 1. Problem and intended result

A record should have one recognizable page: its title first, essential properties next, then
its content. Today those parts change order between the full page and record peek. A stored H1
appears below the full page's properties; the peek supplies a separate title above them and can
show that H1 again. Related-content tabs can omit the body-owned title entirely.

The live audit reproduced both defects on **Launch email sequence (3 touches)**: duplicate title
in the peek and approximately 400px of expanded metadata before the full-page H1. The local
evidence is the [peek capture](2026-10-17-polish-audit/12-record-peek.png) and
[expanded record capture](2026-10-17-polish-audit/14-record-details.png). These are retained audit
observations, not approved visual-regression baselines.
Ordinary prose pages already have a more coherent hierarchy.

The editor experience is a primary deliverable. Cerebro already supports many of the reference
editors' block types, but that inventory does not establish comparable quality. Creating a page,
moving from its title into writing, discovering a block action, editing a table and continuing
after an embed must feel like one designed workflow. Review both the quiet reading state and
the controls, focus, selection and feedback that appear while working.

This work establishes one page anatomy and a consistent authoring surface. It retains Cerebro's
Instrument Sans, IBM Plex Mono, cortex/synapse palette, first-H1 title semantics, files, existing
editor, and governance. It does not require a new font system, a new document format, or replacing
BlockNote with Morrow's editor.

## 2. Evidence and reference choices

Paths in this table are repository-relative. Line references identify the audited snapshot.

| Finding                                                          | Evidence                                                                         | Consequence                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Full-page title depends on whether the body has H1               | `src/pages/DocPage.tsx:1045`; properties at `:1058` and `:1105`, body at `:1143` | Title ownership must be fixed before spacing polish          |
| Peek adds an independent title above the complete editor         | `src/detail/DetailPanel.tsx:465`, `:587`                                         | Both hosts must share the new anatomy                        |
| First top-level H1 is the existing title carrier                 | `src/editor/markdown.ts:2036`; `DocPage.tsx:581`                                 | No metadata-title migration or write on open                 |
| Reading styles are split across contexts                         | `src/pages/pages.css:185`; `src/editor/editor.css:34`                            | Define prose inheritance deliberately, including nested text |
| Icon/title/body offsets are independently assembled              | `src/detail/PageChrome.tsx:512`, `:528`; `DocPage.tsx:186`                       | Use a shared reading gutter contract                         |
| Grouped properties, hidden-field reveal and layout already exist | `src/detail/RecordProperties.tsx:52`; `src/detail/HeadingProperties.tsx:69`      | Refine presentation without discarding configuration         |
| Grip menu mostly offers Delete, with checklist Promote           | `src/editor/SelectionToolbar.tsx:150`                                            | Add useful carried block actions                             |
| Comments are complete but repeat controls on every thread        | `src/detail/CommentThread.tsx:80`, `:209`, `:215`                                | Reduce noise while preserving drafts and thread state        |

### What Morrow contributes

The vendored `docs/examples/Morrow-main` is a reference, not project code. Its local `LICENSE`
and `package.json` identify Apache-2.0. Any later source reuse must retain the applicable notices;
this specification proposes interaction and composition ideas rather than a runtime transplant.

- `src/app/components/PageView.tsx:147–245` establishes cover, icon, title, properties and body
  in one order. `src/app/styles/app.css:722` gives prose a deliberate measure; `:738` gives the
  title a distinct scale. Adopt the discipline, not its font alternatives or exact dimensions.
- `PageView.tsx:188–240` and `src/app/editor/PageEditor.tsx:131` connect title and body through
  Enter/ArrowDown/ArrowUp, including editor readiness. This is part of polish, not optional detail.
- `src/app/editor/EditorMenus.tsx:459` provides contextual conversion, Move up/down, Duplicate
  and Delete. Nontext blocks exclude invalid conversions.
- `PageView.tsx:373` shows useful backlink context and makes unlinked-mention discovery opt-in.
  Cerebro can improve its existing Links panel without adding another permanent page section.
- `EditorMenus.tsx:144–151` distinguishes selected text, a caret in a link and a caret in a table;
  `:389–455` provides explicit row/column operations. Adopt contextual control design while
  retaining only actions Cerebro can save faithfully.

### What Macro contributes to authoring

Macro is an editor reference as well as a shell reference. Its broader source study is recorded
in [the editor dossier](2026-10-12-macro-reference/03-editor.md). Relevant local paths under
`docs/examples/macro-main` include:

- `apps/web/src/features/block-md/component/TitleEditor.tsx`: explicit title/body keyboard
  transitions that yield to open inline menus. Cerebro needs equally deliberate transitions
  through its single document owner; Macro's separate title editor and rename timer are not
  the implementation to adopt.
- `apps/web/src/features/block-md/component/MarkdownPopup.tsx`: selected-range tracking and
  a visible selection highlight while an AI instruction input holds focus. The user must keep
  seeing what an action will affect as focus moves into contextual tools.
- `apps/web/src/lib/core/component/LexicalMarkdown/component/core/FocusClickTarget.tsx`:
  a deliberate continuation target below the document. Cerebro must make continuing after
  nontext blocks straightforward without appending empty blocks on passive layout events.

The comparison combines source inspection of both repositories with Morrow's supplied demo
video. Neither reference app was run interactively. These are specific design inputs; relative
typing latency and runtime reliability have not been measured. Macro remains design input
under the reuse restrictions recorded in its dossier.

### What must not be copied

Morrow stores a metadata title and projects it into Markdown (`src/core/markdown/serialize.ts:43`).
Cerebro's H1 already owns the title. Morrow replaces editor content for outside changes
(`PageEditor.tsx:219`); Cerebro already has stronger in-place, three-way reconciliation
(`src/editor/NoteBodyEditor.tsx:63`). Keep it.

Morrow exposes a table-header toggle (`EditorMenus.tsx:442`), but its serializer always emits the
first row as a Markdown header (`serialize.ts:173`). Cerebro deliberately hides this lossy action.
Morrow carries underline and colors with HTML and columns with HTML wrappers (`serialize.ts:13`,
`:115`); Cerebro has its own carriers and protects unsupported HTML. Those controls cannot be
enabled as a styling shortcut.

## 3. Proposed page grammar

The same ordered slots serve full page and peek; density changes with available pane width.

| Slot                   | Proposed rule                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Location and utilities | Compact breadcrumb, save state, favorite, Open with, overflow and inspector access; no second large title |
| Optional cover         | Full column bleed; existing image/color value and remote-image behavior retained                          |
| Identity               | Optional icon, one wrapping title, existing item key/type where useful                                    |
| Required context       | Concept review, agent duty, provenance or actionable status when relevant                                 |
| Key properties         | Existing configured heading fields, followed by the existing details disclosure                           |
| Expanded properties    | Existing grouped fields and visibility rules; above related-content tabs on every tab                     |
| Tabs                   | Existing saved tabs and fixed agent tabs; no artificial Overview tab on a simple page                     |
| Content                | The current body, related view or section content, with one active editing owner                          |

The title appears before metadata and remains visible on related tabs. A concept keeps its
frontmatter title; its H1s remain section headings. Agent grants retain their explicit Done/Cancel
behavior. Required review or failure states cannot disappear into a decorative overflow menu.

Proposed visual targets, to be ratified with a specimen during M85.1:

- Full-page title 32/40px, weight 600; narrow/peek title 24/32px, wrapping. Body 16/28px.
  Shared interface text is 14/20px; compact metadata is 12/18px.
  Use the existing type ramp where it expresses these roles; do not proliferate per-page sizes.
- Default prose measure approximately 720px, fitted to pane width with an accessible block gutter.
  Full-width preference remains available and retains its current stored meaning.
- Title, body text, icon and metadata content share an explicit left-edge contract. Align their
  measured text origins within 2 CSS px; controls may occupy the gutter without shifting prose.
- Regular metadata uses a 32–36px minimum row target and the existing 120px label-column starting
  point. Long values wrap; narrow layouts may stack labels rather than squeeze the value away.
- Nested ordinary prose inherits the body scale. Tables, code, formula controls and compact tool
  chrome keep their purposeful dense scale. No blanket `.ProseMirror *` size override.

These are proposed design values, not descriptions of current computed CSS. A small specimen
must establish the final values before they spread across the application.

## 4. M85 — Single page and record anatomy

### M85.1 — Title projection spike and specimen

This is the first implementation gate. Prove a shared title presentation controlled by the
existing document model. The first H1 remains in the editor's authoritative content and on disk;
the page must not create a separate title store, another live editor, or a competing debounce.

The spike must compare feasible mechanisms for projecting that H1 above metadata and displaying
it once. Document the selected mechanism, rejected alternatives, editor selection mapping,
save/undo ownership and behavior while the body is not mounted on a related tab. Do not conceal
all H1s, strip Markdown before saving, or move source bytes merely to match presentation.

Cases include a leading H1, no H1, a nonleading H1, multiple H1s, heading text in a fence, a long
title, concepts, agents and protected imports. Proposed nonleading-H1 rule: project the title
without moving its stored position; later H1s remain visible as authored sections. If this cannot
be made reliable, present the concrete alternative for review before continuing.

**Pass conditions:** opening, switching tabs and resizing write nothing; exactly one visible page
title precedes properties; the title remains editable where authorized. Enter/ArrowDown from its
end enters the body and ArrowUp at the first body caret returns. Escape cancels uncommitted title
input and restores committed model text; Undo handles an already committed edit.
IME composition does not commit prematurely. Title edits, body edits and external writes use the
existing save/reconcile path and undo correctly. Existing title comment anchors still resolve,
and newly selected title text can be commented without a separate anchor vocabulary.

A refused title save in page or peek retains the exact draft for correction, matching the
table/scalar contract in the [data specification](2026-10-17-cerebro-databases-and-views.md).
A table rename while that record has a dirty page body must not be overwritten by the next
body save. Exercise both orders of completion and reconcile through the existing file owner.

The specimen contains the reproduced record, ordinary prose, a concept, an agent, a page without
H1, and a long-title peek in both themes. Owner review judges the complete composition, not an
isolated title screenshot.

### M85.2 — Shared page/peek header and frame

Implement the proven anatomy through shared page parts used by `DocPage` and `DetailPanel`.
The peek's current single-line input becomes a wrapping title presentation. Remove obsolete
duplicate title rendering and the comments that justified it. Preserve breadcrumb identity,
window labels, favorites, history and rename behavior.

A view transition must retain draft ownership and obey CV-52: opening a page held elsewhere
focuses its holder. The title remains available on related tabs without creating an invisible
second editor. Choosing a different tab is not permission to discard an unfinished title edit.

**Pass conditions:** title order and count hold in full page, peek and every related tab; opening
from table, search, sidebar or deep link yields the same anatomy. Cover/icon/title spacing works
with all four combinations of cover/icon presence. Four panes, parked panes, inspector and
assistant coexist without clipped title or unreachable page actions.

### M85.3 — Metadata hierarchy and inspector

Preserve declared layout, heading fields, property groups and folded-empty counts. Existing users'
visibility preferences are authoritative. Make the essential strip easy to scan and the expanded
stack easy to edit; do not introduce a second “quick properties” selection behind the Type doc.
Do not silently reconfigure a large property stack to satisfy a screenshot.

Property names remain readable by keyboard as well as pointer tooltip; value editing and property
configuration have distinct affordances. Reorder hints continue to disclose that declaration
order affects the Type. Undeclared frontmatter stays visible and removable, never coerced away.
Agent grant rows never enter the generic autosaving field editor.

The inspector keeps Details (Info, Links, Knowledge where applicable), Comments and History
reachable. Since the owner's 2026-10-19 direction each is a panel of its own, opened by its own
toolbar button, one at a time, in a slot the page's full height under the toolbar's actions, and
the outline sits on the page as a floating table of contents rather than in the panel. At
constrained widths the panel folds and its buttons open it as a drawer over the page. Preserve
the stored selection, pane scope, drawer focus return and each section's own error state.

For ordinary document details, keep the existing `cerebro.docPanelOpen` preference home. An
absent value defaults closed; explicit true and false remain honored. Keep the separate concept
panel preference independent. Test missing/true/false values and vault changes; this preference
never writes vault files.

**Pass conditions:** configured folds survive tab and presentation changes; revealing fields
does not reorder or write them. Property edits follow the data specification's pending/refusal
contract: the exact failed draft remains available for correction, with one write per retry. Expanded
metadata follows the title. The inspector fits its minimum width, supports keyboard navigation
and returns focus to its opener. Unknown counts are never shown as zero.

## 5. M86 — Authoring, blocks and discussion

The review standard is a convincing writing session, including interaction states. Existing
feature availability is the starting point; each flow below needs an explicit retain, refine
or implement decision against the current editor. Do not count an already working capability
as new delivery, or assume that its presence means its presentation is finished.

### M86.1 — Prose and block presentation

Apply the agreed reading rhythm to paragraphs, nested lists, toggles, quotes and column prose.
Headings have consistent before/after spacing and a clear hierarchy. Preserve task-checkbox semantics and existing keyboard behavior. Page and concept title semantics determine heading size; do not identify
the title by “every H1 is large.” Narrow behavior uses the actual pane width.

Create a small common block presentation vocabulary: content, optional caption, identity/status
and contextual actions. Apply it to code, simple tables, page cards, media/files, Mermaid,
databases, sheets, whiteboards and AI blocks. A page card remains a pointer, not another editable
document. Database rows remain the original files. Sheet and whiteboard controls keep their own
selection and input ownership.

Callout type becomes a named choice instead of cycling an icon through six undisclosed outcomes.
It continues to use the existing kind carrier. Cover focal-position persistence, new marks and
new callout title/fold semantics are outside this phase.

**Pass conditions:** each block is reviewed ready, empty/unset, missing/unavailable and read-only
as applicable. Captions and long filenames fit; only the block's intended region scrolls
horizontally. Copy exports carrier content rather than action labels. Mount, hover, copy and drag
make no unapproved remote image request; existing exact-URL session permissions remain honored.
Existing media size/caption and import provenance survive saving.

### M86.2 — Selection, slash and block controls

One selection toolbar exposes essential formatting, links, Comment where supported and one
labelled Ask AI entry. Move writing presets into that entry's menu; retain their instructions,
per-hunk decisions and existing grants. This explicitly revisits the older AI-first multi-button
toolbar hierarchy while keeping the feature discoverable. Formatting, links and comments should
not require passing several AI controls to reach them.

The block grip offers appropriate Turn into, Duplicate, Move up/down and Delete, plus existing
contextual actions such as Promote. Conversions that would lose content are unavailable with an
explanation. The slash menu uses consistent groups for text, layout, media/data and templates,
retaining existing aliases and ranking. Table, Database and Sheet have distinct descriptions:
simple Markdown cells, a view of records, and calculated cells respectively.

Specify the editor's contextual states together:

| Context                            | Required experience                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty paragraph and slash search   | A quiet insertion hint; readable groups, current result and no-results state; dismissing preserves typed content and caret; reopening does not create a block                                        |
| Selected prose                     | One toolbar with clear active formatting states; selection remains visibly identified while a menu, link input, comment or AI instruction takes focus                                                |
| Link caret or selection            | Inspect, edit and remove the actual link without losing the target range; opening a link uses the existing open policy                                                                               |
| Markdown table cell                | Clearly discoverable add/remove row and column controls, current-cell feedback and keyboard travel; destructive structure changes are undoable; unsupported header toggles and merging remain absent |
| Hovered, focused or selected block | A stable gutter target and a keyboard route to the same block actions; moving to the menu does not make the target disappear; controls do not shift the text                                         |
| Block drag and nested content      | Visible source and insertion destination, including column/list boundaries; invalid drops are legible; Escape cancels; move and Undo preserve content and selection                                  |
| Last block or nontext embed        | A predictable caret route before/after the block and a usable continuation area; sheets and boards retain their own input scopes; no focus trap or incidental blank-block accumulation               |
| Read-only or protected content     | Readable content and permitted copy/navigation; unavailable mutation tools do not masquerade as working actions                                                                                      |

Table controls should attach to the table/cell context without stacking competing floating bars
over selected prose. Their exact placement is reviewed in the specimen. Block insertion, conversion,
link editing and menus must remain usable inside narrow panes and scrolled columns; viewport-wide
positioning alone is insufficient. Preserve existing working drag, keyboard and paste behavior
while refining feedback; additions must use the same editor transaction and persistence paths.

**Pass conditions:** pointer and keyboard can reach every offered action in a 320px content pane
and a 760×600 browser stress window; native acceptance uses the 900×600 minimum. Menus avoid
edges, restore selection/caret and cooperate with Escape layers.
Typing, arrows, Enter and IME remain predictable. One operation is one undo step. Duplication
mints unique block identifiers and honors sheet identifiers; moving preserves nested content.
No offered action becomes lossy: CV-24 tests classify the new items and `KNOWN_LOSSY` remains empty.

### M86.3 — Comments and reference context

Comments emphasize author, quote and content. An inactive thread shows a compact Reply affordance;
the active thread expands its composer. Move individual delete and secondary thread actions into
an accessible overflow, retaining deliberate deletion confirmation. Keep pending/failed agent
answers and resolve/reopen status legible. Drafts are owned by page/thread identity and survive
inspector switches and responsive presentation changes until explicitly cancelled or submitted.

Retain On the page, detached/unplaced, Discussion and Resolved distinctions. No speculative
reattachment of detached comments. The Links panel may add a bounded source excerpt when available;
an unavailable excerpt is not an empty backlink list. Do not add a new graph or always-visible
backlink wall to every page.

**Pass conditions:** selecting a thread reveals the correct quote; keyboard focus follows an
intentional control, not a clickable article with no keyboard equivalent. Presentation changes
neither post a comment nor start an agent. Only a person's explicit mention starts the existing
thread-turn path. Comment actions change sidecars only; a malformed sidecar remains unavailable
and cannot be overwritten. Existing anchor occurrence/context semantics stay unchanged.

### M86.4 — Complete authoring review

Deliver a short recorded walkthrough and an interactive implemented specimen. The page-composition
HTML in the overview is conceptual and cannot satisfy this gate. Use the same representative
content for before/after comparison, with a pointer pass and a keyboard pass:

1. Start a page, edit its title, enter the body and write nested prose.
2. Insert a block through search, convert it, duplicate it, move it into/out of a supported
   container and Undo. Show insertion feedback and cancellation during a drag.
3. Select text, format it, edit a link and open an AI instruction or comment while retaining
   visible selection context. Cancelling returns to the intended range.
4. Edit a Markdown table's cells and structure; insert media or a page card and continue
   writing below it. Demonstrate a database or sheet without confusing its input scope.
5. Open a comment, switch inspector sections and return to its draft. Save, reopen and verify
   the content; separately demonstrate a refused save and an outside edit while dirty.

Include a long page and a narrow pane in both themes. Review the reading surface, active tools,
selection, drag feedback and failure recovery separately. Record observed jank, caret jumps,
menu clipping and accidental focus transfers with a disposition. The milestone closes when
the owner accepts the authoring experience and the durability checks pass.

## 6. Durability and verification gates

All phases retain CV-23/24/25/31/36/47/51/52/56/61: existing human/agent write distinctions,
carriers, grant Done semantics, sidecars, explicit thread invocation, keymap ownership, contained
media, one editor per file, attachment imports and remote-image permission. No presentation
change grants agent access or changes concept verification.

| Gate                | Required proof                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Source preservation | No write on open, resize, panel/tab switch or clean outside update; save/reopen/save preserves every offered block                          |
| Editing             | Title/body/property actions, undo/redo, external merge/conflict, save failure and navigation with pending edits                             |
| Geometry            | Light/dark; wide desktop and 1440/1280/1024/900px; short window; measured narrow pane, peek, assistant and inspector together               |
| Input               | Real selection, keyboard, IME, long international text, zoom and reduced motion; no focus lost behind a drawer                              |
| Comments            | Title and body anchors, repeated quotes, detached thread, pending/failed answer, draft retention, sidecar-only writes                       |
| Native              | Packaged WKWebView typing/selection/clipboard, native picker/Finder drop, external links, immediate save-and-quit and failed-save stay-open |

Extend meaningful existing suites rather than replacing them: `editor-carriers`, `visual-pages`,
`home-document-polish`, `columns`, `block-drag`, `page-icons`, `page-attachments`, `page-cards`,
`comments`, `comment-anchors`, `agent-comments`, `project-pages`, `page-history` and relevant units.
Use `e2e/boot.ts`; new read sections register all five state-lab presets. Run focused tests for
each phase, then required repository checks and relevant Chromium/WebKit flows.

Use the `verify-ui` runbook and isolated acceptance data. Deliver inspected before/after specimens
and exact remaining failures. A built bundle is not proof of native interaction; M80–83's
unperformed interactive native checks remain distinct. No acceptance run should use the owner's
personal vault. The owner reviews this specification before implementation begins.
