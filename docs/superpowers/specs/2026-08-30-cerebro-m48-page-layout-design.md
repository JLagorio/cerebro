# M48 — Page layout: columns, and a drag that feels like Notion

**Status:** accepted 2026-08-30. Decisions D1–D6 below are the author's.

---

## 1. The complaint

> "we need more page layout controls like notion. thees are colus should also
> be able to drag and drop those blocks like notion to move things around on
> the page."

The screenshot is Notion's `/col` menu: **2 / 3 / 4 / 5 columns**, each with a
"Turn into" variant that reflows the current block, plus **Toggle list**.

Two asks, and they are one feature. A column is only worth having if you can
put things in it, and the way you put things in it is by dragging them there.
Columns without drag is a layout you can only build by typing into it in the
right order; drag without columns is what we already have.

---

## 2. What exists — measured, not assumed (2026-08-30)

- **Toggle lists already ship.** `toggleListItem` is one of BlockNote's
  `defaultBlockSpecs`, which `cerebroSchema` spreads
  (`src/editor/MarkdownEditor.tsx:46`). Half of the menu in the screenshot is
  already in the `/` menu. Nothing to build.
- **The drag handle is wired and it works, but it feels wrong** — the author's
  own verdict after trying it. `SideMenuController` mounts BlockNote's
  `DragHandleButton`, which renders `draggable="true"` on the "Open block menu"
  button (measured in a Playwright probe: 7 blocks, 2 side-menu buttons, the
  second draggable).
- **That drag is invisible to our tests.** Neither Playwright's `dragTo` nor a
  hand-stepped mouse drag moved a block or changed the file. Chromium's HTML5
  drag-and-drop cannot be driven from the harness, so **every behaviour we add
  on top of BlockNote's DnD is untestable by construction**. M46.2 already
  built a pointer-based, fully tested drag stack (`useDragGesture`,
  `sortableGeometry`, `dropPartition`, `BlockDrag`) for the record canvas,
  board, table and dashboard. It is not used in the editor.
- **Columns do not exist**, and the official package cannot be used.
  `@blocknote/xl-multi-column@0.46.2` is licensed **`GPL-3.0 OR PROPRIETARY`**
  (verified via `npm view`). Cerebro's `LICENSE` is Apache-2.0. Shipping the
  GPL build would relicense the whole distributed app; the alternative is a
  paid commercial licence. **So we build our own.**

### The spike that decides the shape

Run 2026-08-30 against `@blocknote/core@0.46.2`, headless in vitest:

- **A `content: 'none'` custom block CAN host editable children, two levels
  deep.** `columnList → column → paragraph` round-trips through
  `editor.document` with ids, props and content intact. This is the whole
  feature's foundation and it needs no PM node specs and no GPL package.
- **The markdown serializer FLATTENS the nest.** `before / left / right /
  after` — the structure is gone. So the round trip has to be ours, exactly
  like the `cerebro-database` fence in M47.2.
- **The parser splits `:::` marker lines into their own paragraphs when they
  are blank-line separated**, and **collapses them into ONE paragraph with soft
  breaks when they are tight.** Both measured. That is what fixes the format
  question below: loosen on the way in, tighten on the way out.

---

## 3. The model

```
columnList          content: 'none', no props        a row of columns
  └── column        content: 'none', props: { width } one column
        └── …       any blocks at all                 its contents
```

`columnList` renders nothing itself; BlockNote lays its children out as a
nested block group and CSS turns that group into a flex row. `column` renders
nothing either, and its own children group stacks vertically — which is what a
block group already does. **The layout is CSS over the nesting BlockNote
already has**, not a second document model.

`width` is a flex ratio, not a pixel count: a page that reflows keeps its
proportions, and a column dragged narrower on a laptop does not become
unreadable on a phone.

---

## 4. On disk (D1)

Directive containers. Marker depth grows with nesting so a column list inside
a column is unambiguous.

```markdown
Everything in flight, and the shape of the month.

:::columns
::::column
## Left
A paragraph, a [[wikilink]], anything.

```cerebro-database
database: Work item
view: at-risk-work
```
::::
::::column width=2
## Right
Twice as wide.
::::
:::

The prose continues.
```

Why this and not the alternatives:

- **The children stay real markdown.** A `cerebro-columns` fence would make
  everything inside it inert text — no wikilinks, no dates, no nested database
  views, no editing a column's contents as blocks. That is the whole point of
  columns.
- **It is legible in any other editor.** Obsidian, VS Code and GitHub all show
  the content; only the layout is lost, which is the correct failure. Raw
  `<div>` wrappers fail the same way while also reading as markup.
- **It has precedent.** remark-directive, Docusaurus admonitions and Quartz all
  spell container blocks `:::`.

**`width=` is written only when it deviates from 1** — the deviations-only
serializer rule this codebase already follows.

---

## 5. Decisions

| | |
| --- | --- |
| **D1** | **On disk: `:::` directive containers.** Author's call, from three options. |
| **D2** | **Build our own column blocks.** `@blocknote/xl-multi-column` is GPL-3.0-or-commercial against our Apache-2.0; the spike proves `createReactBlockSpec` is enough. |
| **D3** | **Drag is rebuilt on `useDragGesture`, not extended on BlockNote's DnD.** The author's verdict is "it moves, but feels wrong", and the harness cannot see HTML5 drag at all. Polishing something untestable buys a feel we can never regression-test. |
| **D4** | **`width` is a flex ratio.** Not pixels, not percentages. |
| **D5** | **Toggle lists are not built** — they already ship. |
| **D6** | **A column may not contain a `columnList`.** Notion allows it; it is where nested-layout editors become unusable, and every drop target doubles. Enforced where a layout is CREATED — the `/` menu simply does not offer one inside a column. (The plan said "at the drop layer"; M48.4 found the drop layer needs no rule about columns at all, so there was nowhere there to put it.) |

---

## 6. The round trip

Both directions are pure transforms in `src/editor/markdown.ts`, beside the
chip and database-fence passes that already live there.

**Reading.** Loosen the markdown string (blank lines around marker lines) →
`tryParseMarkdownToBlocks` → a flat list where each marker is its own paragraph
→ `promoteColumns` folds the flat list back into the nest.

**Writing.** `demoteColumns` flattens the nest into marker paragraphs →
`blocksToMarkdownLossy` → tighten the string (drop the blank lines the loosener
would re-add).

Tighten and loosen are exact inverses, which is what makes the round trip
byte-stable — the fidelity policy this module has held since M2.

**A malformed nest never eats content.** An unclosed `::::column`, a `:::` with
no opener, a marker inside a code fence: the promoter leaves the paragraphs
exactly as it found them and the page renders as the plain text it is. Vault
tolerance — the file is the source of truth and the app does not get to decide
it is wrong.

---

## 7. Slices

| | | |
| --- | --- | --- |
| **M48.1** | The `columnList`/`column` block specs, the CSS that lays them out, and the schema registration. Renders a hand-built nest; nothing creates one yet. | **done** `8977879` |
| **M48.2** | The markdown round trip: loosen/tighten, `promoteColumns`/`demoteColumns`, byte-stability tests, and the malformed-input tolerance. | **done** `536b478` |
| **M48.3** | The `/` menu: **2 / 3 / 4 / 5 columns**, and the "turn into" variants that wrap the current block. | **done** `aa43061` |
| **M48.4** | Drag rebuilt on `useDragGesture`: the grip, the insertion line, and drop targets that include the gaps between and inside columns. | **done** `1085054` |
| **M48.5** | Column resize by dragging the gutter, writing `width=`. | **done** |
| **M48.6** | Demo-vault content that uses a column layout. | **done** |

### What the built slices changed about the plan

- **M48.1 shipped a layout that did not work, and M48.2 is where that was
  found.** Two things were true in jsdom and false in a browser, and each was
  invisible to every unit test:
  - BlockNote wraps a custom React block in an extra `.react-renderer`
    element in the browser and **not** under test, so
    `:has(> .bn-block-content[…])` matched every unit test and nothing at all
    in the app. Every column stacked; nothing errored.
  - **ProseMirror owns `.bn-block-outer` and wipes foreign attributes off it.**
    The `syncColumnWidths` pass reported moving two columns and left nothing
    behind — not the inline style, not the marker attribute the probe went
    looking for. That whole module is deleted. A column now renders a scoped
    `<style>` inside its own node view keyed on the block's `data-id`, which
    is how a descendant styles an ancestor and the one place ProseMirror
    cannot reach.

  The lesson is narrower than "test in a browser": **jsdom builds a different
  DOM for a custom block than the browser does**, so any CSS keyed on that
  block's structure is unverified until a browser measures it.
- **A block that renders a stylesheet needs `toExternalHTML`.** Without it
  BlockNote derives text/plain from the rendered text, so copying a column
  would have put a CSS selector on the clipboard — the mermaid block's defect
  (M29.53) with a sharper edge.
- **M48.4 wraps BlockNote's handle rather than replacing it**, which the plan
  did not anticipate. `DragHandleButton` is a MENU trigger that also happens
  to be `draggable`; replacing it outright would have meant rebuilding its
  menu, and adding a second grip beside it would have put two controls in a
  six-pixel gutter. So the native drag is switched off in CSS
  (`-webkit-user-drag: none`) and a pointer drag runs in its place, while a
  press that never travels stays a click and opens the menu as before.
- **D6 needed no work in the drop layer.** The whole document is one list of
  horizontal insertion lines, columns included, and a spot wins by containing
  the pointer's x — so dropping into a column is the ordinary case at a
  greater depth rather than a rule about columns. The nesting ban is enforced
  where layouts are CREATED (the `/` menu), which is the only place it can be
  reached.
- **M48.5 found the gutter already occupied.** BlockNote draws its side menu
  24px to the LEFT of the block it is hovering, which for every column after
  the first is the gutter — MEASURED, a 28px column gap put the menu (x 549, 48
  wide) straight over the resize handle (x 553, 12 wide), and the handle became
  unclickable the moment the pointer arrived to use it. The gap is 48px now,
  which leaves a clear strip on the far side of the menu. It is also about what
  Notion uses, but that is a coincidence rather than the reason.
- **A React `onPointerDown` inside a custom block never fires.** ProseMirror
  stops the event on its way up, so it never reaches the React root where React
  19 dispatches from. MEASURED: a synthetic `dispatchEvent` on the element ran
  the handler and a real pointer did not. The gutter binds `pointerdown`
  natively on its own element instead. The block grip has no such trouble —
  the side menu is drawn OUTSIDE the ProseMirror content.
- **The column element could not stay `display: none`.** It hosts the gutter
  handle, so it is taken out of flow and stretched over the column instead. The
  first version of that rule was appended after the `display: none` one and set
  only `position`, so the hiding survived and the handle had no box at all.
- **`isNoOpDrop` cannot read document order alone**, and the case that proves
  it is this milestone's own: the block directly below a paragraph may be the
  first block of a column, so a drop that looks like "where it already was" by
  position actually changes the block's parent. It compares parents first.

M48.4 is the slice that pays for itself twice: it is the feel the author asked
for, and it is the first time block drag in the editor is covered by a test at
all.

---

## 8. Non-goals

- Nested column lists (D6).
- Notion's synced blocks, page-width toggle, or per-block colour.
- Columns inside table cells or inside a database row.
- Rewriting existing demo-vault pages into columns beyond the one M48.6 adds.

---

## 9. Risks

- **R1 — round-trip drift.** A tighten/loosen pair that is not exactly
  inverse grows blank lines on every save. Mitigated by the M48.2
  byte-stability test: save an unedited column page twice, compare bytes.
- **R2 — the drop-target surface doubles.** Every gap between blocks now has a
  sibling gap inside each column. `dropPartition` was written for one
  dimension. M48.4 may need to extend it rather than reuse it; that is
  expected, not a surprise.
- **R3 — BlockNote upgrades.** We now depend on `content: 'none'` blocks
  accepting children, which is observed behaviour rather than documented API.
  The M48.1 tests pin it, so an upgrade that breaks it fails loudly instead of
  silently flattening people's pages.
- **R5 (found in M48.2) — the app's DOM and the test's DOM are not the same.**
  Anything keyed on how BlockNote renders a custom block must be measured in a
  browser. `e2e/columns.spec.ts` asserts in geometry for exactly this reason,
  and `e2e/block-drag.spec.ts` exists at all only because the drag was rebuilt
  on pointer events — HTML5 drag-and-drop cannot be driven from the harness,
  so the drag it replaced was untestable by construction.
