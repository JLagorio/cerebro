# M47 — Everything is a page

**Status:** design, awaiting review
**Date:** 2026-08-30
**Supersedes:** the M10 container model (`collection.yml`, `*.list.yml`)

---

## 1. The complaint

> "we force users to add a list to a view before they can do anything. and
> theres also no way to create data from here? for example lets say I want to
> track tasks I have to back out of this > go to databases > create a new type >
> come back here and slect said type."
>
> "I lik ehte notion database style but it feels very hard to use and mix
> concepts right now."
>
> "I need to be able to quikcly do one and log things and format my pages with
> notes so im kind of leannig more toward notions everything is a page with
> blocks arhcitecture"

The collection page's empty state says, in as many words, *"Add a list from the
sidebar's + to start"* — the page tells you to go somewhere else. That sentence
is the milestone.

## 2. Diagnosis: two lanes saying the same thing

Cerebro has **two parallel systems** for "a container of records and how to look
at them," and the user has to know which lane they are in before they can do
anything.

| Concept | Lane A (M10 containers) | Lane B (types) |
| --- | --- | --- |
| The container | a folder + `collection.yml` | a `type: Type` doc + its `folder:` |
| Saved views | `*.list.yml` files | the Type doc's `views:` |
| Where you make one | sidebar `+` → New list dialog | Databases → New database |
| Where new records land | nowhere — a List only queries | `createRecord` uses `folder:` |
| Can hold prose | no | yes (it is a markdown page) |

Lane B is the better system and **is already built**. This milestone deletes
lane A and opens two doors onto lane B.

### What already exists (verified in code, not assumed)

- `buildSchema` ([schema.ts:278](../../../src/engine/schema.ts#L278)) scans **all
  entries** for `type: Type`. The `types/` folder is a convention, not a
  constraint — a Type doc is already legal anywhere in the vault.
- A `TypeDef` already carries `fields`, `statuses`, `icon`, `color`, **`folder`**
  (a home for new records), **`views`**, `display`, `layout`, and `tabs`. It is
  already the database object this milestone needs.
- `createRecord` ([createRecord.ts:77](../../../src/engine/createRecord.ts#L77))
  already places a new record in its type's `folder:`.
- The folder-note convention already exists
  ([docPages.ts](../../../src/engine/docPages.ts)): `tasks/tasks.md` is the page
  *for* `tasks/`. A container that is a page is not a new idea here.
- `DashboardView` already resolves and renders a **saved view embedded by
  path**, with filters, from an arbitrary page. Inline database rendering is
  built; it is locked inside dashboards.
- BlockNote already carries custom block specs (`callout`, `mermaid`, `ai`) with
  markdown round-tripping. A `database` block is the same mechanism.

**Neither `folder:` nor `views:` is exercised by any Type doc in `demo-vault/`.**
The capability shipped without a caller. The migration in §7 is their first real
use, which means both need test coverage they do not currently have.

### What M47.1 found when it went looking (2026-08-30)

Three things the reading above did not show, each turned up by writing the tests
rather than by reading the code:

- **`TypeDef.folder` had no consumer at all.** `buildSchema` parsed it and
  stored it, and nothing ever read it. The only live reader of `folder:` was a
  private `declaredFolder` in `createRecord.ts` that re-found the Type doc in
  `entries` and re-implemented the trim-and-strip rule — a twin of a key M47 is
  about to make load-bearing. M47.1 collapsed them onto the schema field.
- **Nothing writes `folder:`.** It is a `RESERVED` key in `typeActions.ts`, so
  it is protected from becoming a user field, but no action sets it: it is
  hand-edit-only today. **M47.4 must add the writer** — creating a database
  inline is exactly the act of giving it a home.
- **`views:` does have a writer** (`setTypeViews`, driven from the type screen's
  tab row), so only its read path was unmeasured. The one test that had ever put
  `views:` on a Type doc asserts a *refusal* — the guard was measured and the
  feature was not.

The first of those changes D8's status: "a database page may be a folder note"
now rests on a test that fails when the title-lookup breaks, not on a reading of
`buildSchema`.

## 3. The model

Four sentences.

1. **A page is a markdown file.** Frontmatter is its properties, the body is its
   blocks. This is already true and needs no work.
2. **A database is a page whose frontmatter declares a schema** (`type: Type`).
   It has a home folder, its own views, and — because it is a page — prose above
   them.
3. **A row is a page whose `type:` names a database.** It lives in that
   database's home folder by default, but is not required to.
4. **A view is a way of looking at a database.** It belongs to the database, and
   can be *shown* on any other page by a block that points at it.

There is no shared field catalog and no local/global schema distinction. **A
schema always belongs to exactly one database.** What varies is only where a
database is *shown*, and a database can be shown in many places at once.

## 4. On disk: before → after

```
BEFORE                              AFTER
delivery/                           delivery/
  collection.yml   ← container        delivery.md    ← the page: frontmatter
  at-risk.list.yml ← a saved view                       + PROSE + view blocks
  this-month.list.yml                 …records
  …records
                                    types/task.md    ← a database:
types/task.md      ← a schema,                          schema + folder: + views:
                     unrelated to                       + prose
                     any container
```

`collection.yml`'s four keys (`name`, `icon`, `color`, `order`) are the
frontmatter of a folder note that was never written. `*.list.yml`'s payload
(`source`, `filters`, `presentation`) is a `ViewDefinition`, which
`TypeDef.views` already holds.

## 5. Decisions

Marked **[user]** where the call was the user's, **[author]** where I made it and
it is open to reversal.

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Membership is hybrid: home folder for placement, `type:` for belonging.** A database's `folder:` is where new rows land. A record elsewhere carrying that `type:` still belongs. **[user]** | Notion's strict ownership would orphan a file the moment you moved it, and would break "all my tasks everywhere." The home folder buys the ergonomics without the cage. |
| D2 | **Full convert: `collection.yml` and `*.list.yml` are both retired.** **[user]** | Two container systems is the defect. Leaving one in place leaves the lane-splitting the user is complaining about. |
| D3 | **A schema always belongs to one database. No shared catalog, no `shared:` flag.** **[user]** | The user's model, and Notion's. My earlier owned-vs-shared proposal was a distinction they did not want and it is dropped entirely. |
| D4 | **The Databases section is the one registry.** Reading lists, grocery lists, Risk — every database appears there, and the surface lets you look at them however you like. **[user]** | "a /database is all of the app's databases." |
| D5 | **New databases are stored in a database container** — the existing `types/` folder, keeping its on-disk name. **[author]** | The user said "it stores it in the database container." `types/` is that container today and every `type:` identifier already uses the old word (M39 changed the label only). Renaming the folder is a separate, cosmetic migration. |
| D6 | **Existing record files do not move.** `folder:` governs where *new* rows land; every current record keeps its path. **[author]** | "Full convert" in D2 was asked and answered about the two YAML formats. Relocating every record in a user's vault is a categorically larger act and was not what was agreed. |
| D7 | **The database block stores a pointer, never data.** The markdown fence names a database and a view id; rows stay files. **[author]** | The vault is the source of truth. A block that embedded row data would be a second copy that can disagree with disk. |
| D8 | **A database page can be a folder note.** `reading/reading.md` with a schema makes `reading/` a database. Both it and a flat `types/reading.md` are legal. **[author]** | `buildSchema` already imposes no path constraint; forbidding one shape would be new code that only removes freedom. |

## 6. The two doors

`/database` in any page body offers exactly two things, matching the user's
description:

**Door 1 — show an existing database.** "I want to show reading lists here now,
or there." Picks a database and one of its views; inserts a block. The same
database can be shown on any number of pages. This is `DashboardView`'s existing
embed, lifted out of dashboards.

**Door 2 — make a new one.** Names it, writes a Type doc into the database
container with a starter schema (Name + Status), sets its `folder:`, gives it a
first table view, and inserts a block pointing at it. **No dialog, no source-type
gate, no leaving the page.**

Then: **schema by use.** A `+` on the last column names a field and writes it
into the database's `fields:` on the spot. Adding a column is how a schema comes
to exist — not a prerequisite to be satisfied elsewhere first.

### The markdown a block round-trips to

````markdown
```cerebro-database
database: Reading list
view: table
```
````

Tolerant by the vault's usual rule: an unresolvable `database:` renders a block
that says *which* database is missing, never an empty table. A missing `view:`
falls back to the database's first view.

## 7. Migration

A one-shot, idempotent converter run on vault scan.

| From | To |
| --- | --- |
| `<folder>/collection.yml` | `<folder>/<folder>.md` frontmatter, merged into an existing folder note if there is one |
| `<folder>/*.list.yml` | a `ViewDefinition` appended to the `views:` of the type named by its `source.type` |
| a `*.list.yml` with `source.type: null` ("Everything") | **has no home database** — see risk R1 |

The demo vault is the golden corpus, so this churns e2e assertions by design.
Per AGENTS.md, that is a test change and is budgeted as one.

## 8. Slices

| Slice | Content |
| --- | --- |
| **M47.1** | Exercise what exists: tests for `TypeDef.folder` and `TypeDef.views` end-to-end, since no Type doc in the corpus uses either. Nothing ships on an untested foundation. |
| **M47.2** | The `database` block spec + markdown round-trip + the pointer resolver. Renders read-only first. |
| **M47.3** | Door 1 — embed an existing database. Lift `DashboardView`'s embed into a shared component both surfaces use. |
| **M47.4** | Door 2 — create a database inline, and schema-by-use (`+` a column writes a field). **Includes the first writer for `folder:`**, which has none today. |
| **M47.5** | The converter, the demo-vault migration, and the e2e churn. Retires `collection.yml` and `*.list.yml`. |
| **M47.6** | Retire the New-list dialog and the sidebar `+` → New list path; the collection page grows its own create affordance and its own prose. |

## 9. Non-goals

- Moving existing record files (D6).
- Renaming the `types/` folder on disk (D5).
- Notion's synced blocks, permissions, or comments.
- Retiring the Dashboard surface — it keeps its widget grid; only the embed
  component is shared.

## 10. Risks

- **R1 — the homeless view.** A `*.list.yml` with `source.type: null` queries
  *everything* and so belongs to no database. Two candidate resolutions: keep a
  view-only page kind for these, or refuse to convert them and leave them for the
  user to place. **This is unresolved and must be settled before M47.5.**
- **R2 — `folder:` and `views:` have no production callers.** Shipping the
  migration onto them without M47.1 would be building on unmeasured ground.
- **R3 — the corpus churn is wide.** Every e2e spec touching Delivery or
  Strategy will move. Sequencing the migration last (M47.5) keeps it from
  blocking the parts that can be verified independently.
- **R4 — two legal database shapes** (D8: flat file, or folder note). Nav,
  breadcrumbs, and the Databases registry must handle both, or one becomes a
  second-class citizen that looks broken.
