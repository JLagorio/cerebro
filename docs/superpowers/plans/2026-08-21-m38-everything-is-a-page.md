# M38 — Everything is a page: the split becomes a default

**Spec:** `docs/superpowers/specs/2026-08-17-agent-platform-design.md` §7 (M38 row).
**Branch:** `m34-agent-platform`. Written after recon on 2026-08-21.

## The shape, corrected by recon

The spec row says "Delete the Docs surface. Nine enforcement points." Recon
enumerated the enforcement points of M12.1's docs↔records split as they stand
today — the spec's count survives, but the list is what matters, so it is
recorded here rather than cited:

1. `app/useOpenPath.ts` — THE routing rule: record → detail panel, doc →
   full page, "the two surfaces never blend".
2. `detail/DetailHeaderActions.tsx` — the deliberate absence of "Open in
   full page", with the comment that names M12.1 as the reason.
3. `engine/typeCatalog.ts` — `isDocEntry`/`isRecordEntry`, the partition
   itself.
4. `pages/DocsPage.tsx` — recents filter (`isDocEntry && !isTemplate`).
5. `components/FileTree` `docsOnly` — the tree hides records.
6. `engine/collections.ts:117` — a Collection's doc rows are
   `isDocEntry`-gated.
7. `engine/docPages.ts:46` — a multi-page doc gathers only doc entries.
8. `pages/DocPage.tsx` — the breadcrumb and post-delete navigation
   hard-target `{ kind: 'docs' }`, the surface.
9. The `docs` surface vocabulary: the `navigate` MCP tool's enum (mcp.rs +
   mock twin + parity tests), QuickOpen's `go:docs` row, and the
   `Selection` union member.

**The correction that scopes the milestone:** "everything is a page" does not
mean the peek dies — Notion itself peeks from lists and offers *Open in full
page* as the explicit act. What dies is the WALL (a record *cannot* be a full
page) and the redundant SURFACE (a "Docs" destination beside a tree that
already lists every page). The partition helpers (#3, #5–#7) survive as
descriptions of content — what changes is that they stop implying a routing
prohibition.

## Slices

### M38.2 — Open in full page

- `DetailHeaderActions` gains **Open in full page** (the absence and its
  M12.1 comment die — the falsified-comment rule). It navigates
  `{ kind: 'doc', path }` and closes the panel.
- `DocPage` renders a record: `RecordProperties` (the same component the
  panel uses — one property surface, two geometries) between title and body,
  behind `page-properties`; the first breadcrumb goes to the record's
  Collection when it has one, its type screen otherwise (the same backdrop
  rule `useOpenPath` already encodes), and to the docs tree for a doc.
- `useOpenPath` keeps peek-as-default; its "never blend" comment is rewritten
  to say *default*, not *law*.

### M38.3 — the Docs surface dies

- The always-visible **Pages** tree section replaces the Docs destination
  row: `FileTree docsOnly` sits as its own labelled section above
  Collections, on every surface — the sidebar contract drops to EIGHT
  destinations and 'Docs' joins the tombstone list.
- `DocsPage` (+ test) deleted. Its recents were six rows; Home already has
  recents and the tree is now always on screen.
- `{ kind: 'docs' }` leaves the `Selection` union: navStore's persisted
  fallback, `place.ts`, QuickOpen's `go:docs`, App's outlet, DocPage's two
  hard targets (#8) — a doc's crumb root becomes its top folder, delete
  lands home.
- The `navigate` MCP tool drops `docs` from its enum — a real MCP schema
  change: mcp.rs, the mock twin, the parity test, and the tools.test scrape
  all move in the same commit.
- e2e: smoke's Docs flows drive the always-visible tree; knowledge.spec's
  "not in Docs" asserts on the tree instead of recents.

### M38.4 — spec fold

Delivery notes + corrections into the M38 row.
