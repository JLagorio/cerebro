# M12 — The Notion model: pages, docs, and nothing special

**Branch:** `m12-notion-model` (off `main` @ ef1e520) · **Date:** 2026-07-30
**Trigger:** the user's epiphany from running Cerebro against a real work Obsidian vault.

## The direction (user's six points, verbatim intent)

1. Remove system types Project and Work item — everything is a *page* (record of a
   user-defined type) or a *doc*, like Notion.
2. An Obsidian migration feature: analyze frontmatter, map fields to kinds, bulk update.
   (Verified: Tolaria has nothing like it — its philosophy is "types as lenses, no
   validation". Its Repair Vault command — idempotent bulk pass, count reported — is the
   borrowed pattern.)
3. Type screens get the same saved-views strip Collections/Lists have.
4. Records NEVER open in the Docs page. Docs are purely docs; type is not overridable on
   a doc (custom properties allowed).
5. Relations are enforced: a data source, a limit, an optional two-way related property —
   Notion's New relation panel.
6. Clicking a column header shows property configuration + view options — Notion's menu.

Decisions made (recommended in the assessment, confirmed by full-send):
- My Tasks is capability-based: a record whose type declares a `status` field is a task.
- A relation's data source is a **Type** (Lists remain saved queries over types).
- Two-way relations are **derived**, not mirrored: the reciprocal is `from: {type, field}`,
  reads the reverse index, writes through to the owning side. One link, stored once.
- `display: doc` types (Meeting, Spec) became record types.

## What shipped, commit by commit

- **M12.1 `fa48cd3` — a doc is a doc, a record is a record.** `isDocEntry` = untyped,
  full stop; every surface uses it (Docs tab, sidebar tree, collection trees, doc pages).
  Routing inverted: typed records → detail panel; `type: Type` docs → their type screen;
  keyboard Enter matches mouse. Doc panel's type dropdown replaced by an explicit
  **Convert to record** action. `display: doc` and `TypeDef.display` deleted.
- **M12.2 `8c55823` — no type is special.** `SYSTEM_TYPES` = `Type` only. Status chain:
  own type → app defaults (project.md override still honored). Record creation scopes by
  context, not type name; Type docs can pin a `folder:`. `isRecordEntry`/`isTaskRecord`
  helpers; My Tasks excludes task-like records' body checklists (they're subtasks).
- **M12.3 `57b28e2` — a type keeps its views like a list does.** `views:` on the Type doc
  (same `ViewDefinition` shape as `.list.yml`), real `ViewTabs` on TypePage, per-tab
  filters/sort/group/columns persisted, open tab on the selection. Properties moved to a
  right-hand aside. `parseViewList`/`serializeViewList` shared with List serialization.
- **M12.4a `f365edc` — a relation names its data source.** Creating a relation demands a
  target type (+ limit 1/no-limit + optional reciprocal name) — the Notion New-relation
  step in AddPropertyPanel. `FieldDef.limit`, picker constrained & single-mode,
  `validateValue` enforces. Derived reciprocals resolve via `childrenOf` on the reverse
  index and write through (bracket-stripped/wikilink round-trip handled). Existing
  relations configure target/limit/reciprocal in the Properties aside.
- **M12.4b `5dcc5fc` — the column header is a menu.** Rename in place; **Change type**
  with `coerceValueToKind` (honest reading or cleared, never mangled; select options
  seeded from surviving values); Filter/Sort-with-direction/Group; **Wrap content** (the
  dead `ColumnSpec.wrap` finally renders; rows grow); Hide/Move/Insert left–right/
  Duplicate (values copied)/Delete. Property ops need the single source type; view ops
  work on mixed views.
- **M12.5 `96bcc1c` — a project is a folder, and a folder is a Collection.** ProjectPage,
  `{kind:'project'}`, and every Project special-case deleted (net −800 lines). Legacy
  project folders read as effective Collections named from project.md — nothing rewritten
  on disk; project.md opens as an ordinary record; project-scoped Lists are ordinary
  Lists. Home = Collections grid; panel breadcrumb → containing Collection; New =
  record / doc / collection; agent prompts updated.
- **M12.6 `cab850a` — open an old vault, get a schema.** `engine/adopt.ts` clusters
  records by `type:`, infers kinds by two-thirds majority (drift = kind + stragglers),
  infers relation targets by resolving links, and emits per-record conversions.
  AdoptSchemaDialog (wand in the Types section) reviews per field; `applyAdoption`
  writes Type docs first, then batched per-record patches. Idempotent; counts reported.

- **M12.7 `51974af` — the knowledge loop follows records.** The Playwright suite
  caught the orphan: Spec/Source records lost the doc side panel's Knowledge tab
  when `display: doc` died. The record panel gained the same commit state +
  related-concepts view (collapsed until asked); the entity dossier moved from
  the deleted project page to the Collection page (rendered even on "empty"
  legacy project collections). E2e specs rewritten to the new model.

## State

ALL GREEN at tip: 940 vitest / 79 files, 143 cargo, 27 Playwright, tsc + vite
build clean. Every phase was committed green. Real-vault (tauri dev) shakeout
pending. Not merged to main; no push.

## Known follow-ups

- Wizard v1 has include/exclude per field but no in-wizard kind override (the header
  menu's Change type covers it one click later).
- Freeze column deliberately skipped.
- `Entry.project` (Rust containment) retained as legacy metadata: statusSetFor override,
  breadcrumb, ListSource.project scoping still read it. Full Rust cleanup is future work.
- Record panel is the only record surface; a full-page record view is future work.
