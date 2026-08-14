# M20 — Table integrity and polish

**Brief for the agent picking this up cold.** Written 2026-08-07 at the end of the
audit session that produced it. You have no context from that session; everything
you need is here or reachable from here.

`AGENTS.md` is loaded for you and covers commands, conventions and repo layout.
This file only adds what is *not* in there: the findings, the traps, and the one
decision you must get from the user before Phase 2.

---

## Where things stand

- **Start by cutting `m20-table-integrity` from `m19-table-parity` at `ba06f50`**
  (that branch is checked out; nothing has been branched for you). M19 is two
  commits on top of `main` (`ae9ab8b`) and is **not merged** — it fixed five
  Notion-parity defects in the table. Read `git show 4b3a4e0` and
  `git show ba06f50` before touching `TableView.tsx`; both commit bodies explain
  design calls you will otherwise undo by accident.
- Full gate was green at `ba06f50`: typecheck, lint, format, 2192 unit tests,
  34 e2e, coverage thresholds.
- The findings below came from a live audit of the running app plus a code audit.
  **All 57 raw findings were then put through an adversarial pass whose job was to
  refute them. 10 fell.** Those 10 are listed at the bottom under
  "Verified false" — do not re-file them, and do not re-derive them; the reasons
  are recorded.

The user has the same material as a defect register:
<https://claude.ai/code/artifact/d861c640-b738-4650-9f9a-bd06266d92be>

---

## The one thing you must ask before Phase 2

Phase 1 needs no decision. Phase 2 does, and three findings resolve differently
depending on the answer, so do not guess.

Cerebro's grouping chain can **descend a relation** (M10 nesting), which puts
records of *foreign types* in one grid: the demo vault's "OKR tree" holds
Objectives, with Key results and Work items nested beneath them. `buildRows`
builds rows from the source type **plus every relation the chain descends into**;
`columnUniverse` builds columns from the source type **alone**. Everything in
Phase 2 comes from that mismatch.

Notion and Plane were both checked directly during the audit: neither has this
problem because neither allows it — one database, one schema, grouping only
partitions rows, sub-items are rows of the same database. Cerebro is attempting
something they do not.

Put these two options to the user and let them pick:

- **(a) Child shows only what it declares.** A nested row renders blank and
  non-editable in any column its own type does not declare. ~15 lines in
  `TableCell`. Matches what `ListView` already does per row, and matches Notion
  and Plane. Cost: a Work item in the OKR tree can never show its own Due or
  Estimate, so nesting stays an outline rather than a table.
- **(b) Union column set across the chain.** `columnUniverse` takes the chain,
  not just the source, and each `ColumnDef` carries its owning type(s). A Work
  item row then gets its own Due and Estimate and the grid becomes genuinely
  multi-type. Roughly a milestone of work, and it needs `heterogeneous` to become
  real (see the note below). This is the more interesting product.

**Recommendation:** ship (a) now as part of Phase 1's safety work — it closes the
data-integrity hole immediately and is not wasted if (b) lands later, because (b)
still needs a per-row ownership check to decide what is editable. Treat (b) as its
own milestone.

---

## Reproducing any of this

`PORT=5273 pnpm dev`, then drive it with chrome-devtools MCP. The browser build
uses the in-memory mock, so you can click destructively and reload to reset.

Two things are worth knowing before you start, because both cost time to discover:

- **The demo vault's OKR tree is the nesting fixture.** Sidebar → expand
  **Strategy** (it is collapsed on boot, and its children are not in the DOM until
  you expand it) → **OKR tree**. Rows carry `data-depth`: `0` Objective,
  `1` Key result, `2` Work item.
- **`evaluate_script` beats clicking** for most of this. Cells are `role="gridcell"`
  with `aria-colindex`; rows are `[data-testid="table-row"]` with `data-path`.
  Dispatching `new MouseEvent('click', {bubbles: true})` on a *cell* exercises the
  M19 click-forwarding path, which is what several of these bugs live in. Note
  synthetic `WheelEvent` does not scroll and synthetic `blur` does not fire React
  `onBlur` — use real input via Playwright (`@playwright/test` is installed; import
  `webkit` from it to match the Tauri webview) when the behaviour is native.

## Phase 1 — stop the bad writes (no decision needed, do this first)

Four of these were reproduced by hand in the running app. Repro recipes are exact;
use them to confirm the bug before fixing and to confirm the fix after.

### 1.1 A nested row is editable in another type's columns, and the write lands

`src/views/TableView.tsx` — `TableCell` (~:119-240).

**Repro.** Dev server, open the demo vault, Strategy → OKR tree. Expand an
Objective to depth 2 (a Work item). Click the blank **Owner** cell on
`projects/guided-onboarding-ga/items/fld-1.md`. A full person picker opens and
offers all 12 people. Pick one. That Work item's detail panel now shows
`Owner ana-rios` beneath its real fields.

**Why it gets through — this is the load-bearing detail.** `validatePatch` looks
the field up on **the record's own type**, so grafting a parent's *select* value
onto a child's *number* field of the same name IS caught and refused. What passes
is the case where the child's type does not declare the field **at all**: there is
no def to validate against, and undeclared keys are legal by design (advisory
schema). So the hole is specifically *columns the row's type has never heard of*,
not *columns it types differently*. Do not "fix" the kind-mismatch path; it works.

**Fix.** In `TableCell`, resolve the column against `entry.type` before offering an
editor:

```ts
const owned =
  entry.type !== null &&
  schema.types.get(entry.type)?.fields.some((f) => f.name === def.name);
```

When not owned, render the resolved display read-only — no editor, no click
forward. `ListView.tsx:164-168` already does this per row; the table is the
surface that disagrees.

### 1.2 The gutter "+" on a nested row creates the wrong type

`src/views/TableView.tsx` ~:2712 (the `onInsert` wiring), `RowGutter` ~:431.

**Repro.** Same OKR tree. Hover the depth-2 Work item, click the gutter `+`
labelled "Insert a record after First-run walkthrough GA", type a title, Enter.
It creates `records/objectives/<slug>.md` — an **Objective**, at depth 0.

**Fix.** On a nested row (`row.depth > 0`) either suppress the affordance or create
into the type at that depth and link it back through the relation that produced
the level. The latter is the honest "insert a sibling" the gesture implies.

### 1.3 A person field offers the whole vault, and one pick poisons the vault

`src/engine/properties.ts` — `personCandidates` :513-526, `relationTargetFor`
:459-478, `peopleTypes` :492-503.

**This does NOT reproduce in the demo vault.** demo-vault has `types/person.md`
and eight `kind: person` fields, so `peopleTypes` is non-empty and the fallback
never fires. It only fires in a vault with no people — which is the user's. Build
a synthetic fixture (types Project/Tasks/Test/weird, a `person` field with no
`target`, no type named Person) or you will conclude there is no bug.

**Mechanism.** `personCandidates` resolves most-specific-first: declared target →
inferred target → `peopleTypes` → **every non-Type record**, which includes untyped
docs. Then, because `relationTargetFor` *infers* a target from the values a field
already holds, picking a Project into `Lead` makes the field decide it points at
Project — permanently. And `peopleTypes` collects those inferred targets, so
**Project becomes one of the vault's people types**, leaking into every other
untargeted person field and the editor's `@` menu. One mis-click retypes the vault.

**Fix.** Delete the fallback:

```ts
return people.size === 0 ? [] : records.filter((e) => people.has(e.type ?? ''));
```

Also exclude untyped docs (`e.type !== null`) and the entry being edited, for the
same reason `type: 'Type'` is already excluded. `peopleTypes`' own docblock
(:489-490) already states the correct rule — "an empty set … surfaces should drop
their People section, not list everything" — and `MarkdownEditor.tsx:195-196`
obeys it. This function is the one that does not.

The empty picker is only a dead end because of 1.4. Fix them together.

**Tests that pin the current behaviour and must flip:**
`src/engine/properties.test.ts:548-556`, `src/detail/PersonField.test.tsx:85-94`.

### 1.4 A person field can never create a person

`src/detail/FieldEditor.tsx` — the person branch :284-326.

**Repro.** Any person cell, type a name that does not exist → "No matches", zero
buttons. Contrast, in the same app: a *select* cell offers **"Create Blocker"**;
a *relation* cell offers **"Link or create a …"** and writes a real record.

**Why.** The person branch's `<FieldPopover>` (:316-322) passes no `onCreate`, so
`canCreate` is false. `RelationPicker` has the whole create path already
(`createTarget` + `createItem`, `data-testid="relation-create"`).

**Fix.** Wire `onCreate` the way `RelationPicker.create` does, creating into the
resolved people type. When there is no people type yet, creating the first person
is what should *establish* it — which is also what makes 1.3's empty list
acceptable.

### 1.5 Creating inside a group band writes the band key verbatim

`src/engine/createRecord.ts:50`.

Group by a relation or person column, use that band's "+ New": the record gets
`epic: Bonsai` instead of `epic: "[[Bonsai]]"`. The scanner files it under
`properties`, not `relationships`, so the link does not exist and the row does not
return to that band on reload. A checkbox band writes the string `"true"`.

**Fix.** Coerce the band value into the field's stored shape before seeding.
`createTarget` already takes `entries`, so it can reach the schema. `BoardView`
has a `bandValue` helper worth lifting rather than duplicating.

**Phase 1 done when:** each repro above no longer reproduces, the flipped tests
are updated with reasons in place, and the full gate is green.

---

## Phase 2 — the nesting model (blocked on the decision above)

Resolves together, whichever option is chosen:

- **Child fields have no column.** A Work item in the OKR tree carries Status,
  Priority, Assignee, Due, Window, Estimate — none can be shown. The header "+"
  lists only Objective's hidden properties, and declaring one there writes it onto
  *Objective*. `src/views/TableView.tsx:1153`.
- **Fabricated 0% progress bars.** The Progress column draws an empty grey track
  on every nested row, reading as "0% done" for records with no such field. The
  neighbouring rollup shows an em-dash on the same rows, so the two read-only
  branches contradict each other. `ProgressCell`, `TableView.tsx:89`. Guard on
  emptiness before calling `progressRatio`, and make `progressRatio` return null
  for a blank string rather than 0.
- **`heterogeneous` is decorative.** Set only in the *typeless* branch of
  `columnUniverse`, and read only by `TableView.tsx:1390` (`canEditSchema`) and
  the warning triangle at :2604. No cell reads it. Under option (b) it has to
  become real; under option (a) the per-row ownership check supersedes it. Note
  the adversarial pass established its *absence* is not corruption — validation
  catches the wrong-shape case — so this is a dead-end-UX fix, not a safety one.

---

## Phase 3 — dead ends (no decision needed)

| # | What | Where |
|---|---|---|
| 3.1 | A select value can never be cleared. Popover offers no Clear/None; clicking the active option re-writes it. Demo vault's Priority declares a literal "None" *option* which masks this — test with **Estimate** (XS/S/M/L/XL), where it is a one-way door. Fix: picking the active option clears it, plus a Clear row. | `src/detail/FieldEditor.tsx:276` |
| 3.2 | A URL cell rejects anything without a scheme and discards the draft. `example.com` → toast, cell reverts, text gone. The anchor already prepends `https://` to bare `www.` when rendering. Fix: normalise on commit; never discard the draft on refusal. | `src/engine/properties.ts:756` |
| 3.3 | A progress-formatted number is read-only in the grid but editable in the panel. Format should be a display, not a permission. | `src/views/TableView.tsx:151` |
| 3.4 | Emptying a multi-select/person cell writes `field: []` rather than dropping the key. Relation and files already use the right idiom. | `src/detail/FieldEditor.tsx:320` |
| 3.5 | Relation picker with zero candidates reports emptiness and offers no create. `canCreate` needs typed text first. | `src/detail/RelationPicker.tsx:301` |
| 3.6 | Person field ignores `limit: 1` in both picker and validation; relation enforces it in both. | `src/detail/FieldEditor.tsx:320` |
| 3.7 | Person picker rows are identical grey dots — a Project and a person look the same. Give them the type icon the relation chips already use. | `src/detail/FieldEditor.tsx:292` |
| 3.8 | Creating a person property from the Type/List page silently discards the target just picked. | `src/pages/TypePage.tsx:128` |
| 3.9 | `changeFieldKind` destroys target/limit/from/format/rollup wiring; the `KIND_KEYS` table it consults is dead code. | `src/app/typeActions.ts:210` |

---

## Phase 4 — keyboard and screen reader

**4.1 is the highest-value single line in this document.**

- **4.1 The grid's key handler runs on top of every focusable control inside it.**
  Symptom at `src/views/useRowKeyboard.ts:272` (`case 'Enter'`); the fix goes at
  the top of `onKeyDown`, **:217**. Reproduced: cursor on row 1, focus row 5's
  **Open** pill, press Enter → the panel opens record **1 of 45**. The handler
  calls `preventDefault`, so the button's own activation never happens. Space on a
  band header has the same shape. Fix: bail when the event did not originate on
  the container — `if (e.target !== e.currentTarget) return;` — the grid drives
  itself with `aria-activedescendant`, so a keystroke that started on a real
  control belongs to that control. Check the M19 tests around the Open pill still
  pass; they focus the pill directly.
- **4.2 ARIA geometry.** The gutter and the first data cell are both column 1;
  rows have one more cell than `aria-colcount`; `aria-rowcount` omits bands and
  the create row. `TableView.tsx:2458`.
- **4.3 Band headers.** A `<button role="row">` with no `aria-expanded` and no
  cells. `ListView` does this correctly — mirror it. `TableView.tsx:960`.
- **4.4** Home/End move the cursor without scrolling to it. `useRowKeyboard.ts:264`.
- **4.5** Enter on a checkbox cell focuses without toggling; Space is then needed.
  `useRowKeyboard.ts:181`.
- **4.6** Clicking a cell does not move the cell cursor. The hook exports `setCell`
  for exactly this and nothing has ever called it. `TableView.tsx:2704`.
- **4.7** Group/Sort toolbar chips are hand-rolled: Escape does nothing and tabbing
  out lands on an invisible full-screen button. The Filter chip beside them uses
  the shared `Popover` correctly. `src/views/ChainBuilder.tsx:120`.

---

## Phase 5 — polish

- **5.1** "Fit to content" measures the already-clipped cell, so it widens a clipped
  column by exactly 4px. Measure the text node. `TableView.tsx:2003`.
- **5.2** Keyboard column resize commits a width and rescans the vault on every
  arrow repeat — the exact failure the pointer path was rewritten to avoid. Give
  it the same two-phase treatment. `TableView.tsx:882`.
- **5.3** Selection double-counts a record appearing at two nesting positions:
  "2 selected", deletes once, reports a failure; Select-all never reads checked.
  De-duplicate by path. `TableView.tsx:2056`.
- **5.4** Empty state says "Create the first one below" and renders below the create
  row. `TableView.tsx:2799`.
- **5.5** Bands labelled with raw field names ("No due_date"); checkbox bands read
  "true"/"false". The label is built at `src/engine/grouping.ts:97`
  (`` label: `No ${field}` ``) — humanize it, and special-case booleans.
- **5.6** The name cell is the one cell M19.2's hit-target work missed — the indent,
  the gaps around the type icon, the strip beside the Open pill. `TableView.tsx:717`.
- **5.7** Clicking a link in a URL/email/phone cell also flips the cell into edit
  mode. Add `a[href]` to the guard selector in `openEditor` — **not** to
  `CELL_CONTROL`, which would change what Enter targets (same distinction the
  existing `label` comment draws). `TableView.tsx:179`.
- **5.8** Column menu offers "Group by" on kinds the toolbar refuses, which is what
  feeds 1.5's bad writes. Gate on `GROUPABLE_KINDS`. `TableView.tsx:1436`.
- **5.9** No drag between bands; bands have no menu. The board already has the
  dnd-kit setup. `TableView.tsx:950`.
- **5.10** Bulk bar: Escape does not clear selection, no Duplicate, floats over the
  last rows. `useRowKeyboard` already accepts an `onEscape` the table never passes.
- **5.11** Bands do not stick while scrolling, though ListView's do. `TableView.tsx:966`.
- **5.12** Memoisation is defeated (a header drag re-renders every cell, each doing a
  `schema.resolveField`) and row lookup in the render loop is linear — ~500k
  comparisons per render at 1,000 rows. `TableView.tsx:2685,2726`.
- **5.13** 34px reserved for a header "+" that is not rendered on read-only surfaces.

---

## Verified false — do not re-file these

Each was proposed during the audit and then refuted with evidence. Reasons are
condensed; if you think one is wrong, re-derive it before acting.

1. **Footer calculations aggregate across foreign rows.** `aggregate` filters to
   `display !== ''` *before* any arithmetic, so average/sum/min/max/range/count-unique
   are computed over the qualifying rows only and are correct. Only count-all,
   count-empty and percent-empty include foreign rows, and that is documented
   intent ("the footer reports the rows on screen"). Leave the arithmetic alone.
2. **`heterogeneous`'s absence corrupts data.** It does not — `validatePatch`
   catches the wrong-shape case on the record's own type. Dead-end UX only.
3. **Board/Gallery/Calendar silently drop nested rows.** Those rows were never the
   view's result; the source selects 3 Objectives and nesting pulls children from a
   separate whole-vault prop. Gallery says so in place. A notice would still be
   kind, but nothing is dropped.
4. **A refused write is indistinguishable from a saved one.** The refusal returns
   *before* the optimistic `set`, so the cell visibly keeps its old value and a
   field-named toast fires. (The draft-discard half is real and lives in 3.2.)
5. **The header menu's schema ops act on the wrong type.** For a typed source the
   columns *are* that type's fields by construction; there is no second candidate.
6. **Gantt/Timeline show nested rows as dashes.** Refuted as written; only a narrow
   already-covered residue survives.
7. **The row-insert label lies.** The visible tooltip says "Insert a record here";
   the "after <title>" string is the accessible name and the draft input really does
   open after that row. One-word copy nit at most.
8. **M19 widened the table/list gap.** M19.1 is engine-level and ListView consumes
   it; M19.3's Open pill was copied *from* ListView.
9. **The whole-vault fallback is unreachable to repair.** `RelationConfigEditor` is
   reachable from three call sites, not one.
10. **The select/status create row points at an unreachable menu.** The menu exists.

---

## Traps specific to this work

- **Do not kill the dev server on :5173.** It feeds the user's running Tauri app
  (`pnpm tauri dev`). Use `PORT=5273 pnpm dev` for your own.
- **The browser build uses an in-memory mock** seeded from `demo-vault`, so probing
  through chrome-devtools writes nothing to disk and a reload resets it. The Tauri
  app writes for real.
- **`closest(CELL_CONTROL)` walks up past the cell** and matches the scroll
  container's `tabIndex={0}`, so any guard using it needs a `contains` check or it
  suppresses every forward. This bit once already; the comment in `openEditor`
  records it.
- **`demo-vault` has a Person type**, so 1.3 cannot be reproduced there. See 1.3.
- **Neither `checkbox` nor `files` existed in any fixture before M19** — the two
  kinds whose cells hold a control that must not be what a cell-level gesture
  activates. There are now local fixtures in `TableView.test.tsx`; extend those
  rather than the shared `fixtureVault`, whose field list eight other tests assert
  exactly.
- Coverage thresholds ratchet up only. Land tests in the same commit.

## Working style the user expects

- Reproduce before fixing and after. Live repro beats a passing unit test here —
  several of these are invisible to jsdom (anything about `opacity` vs
  `visibility`, focusability, or real wheel/pointer behaviour).
- One phase per commit where the files allow it; M19's second commit explains why
  it could not be split further, and that reasoning is acceptable when true.
- Never `--no-verify`.
- Say plainly what you did not verify.
