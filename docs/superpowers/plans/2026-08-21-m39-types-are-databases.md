# M39 — Types → databases: the word a person reads

**Spec:** `docs/superpowers/specs/2026-08-17-agent-platform-design.md` §7 (M39 row).
**Branch:** `m34-agent-platform`. Written after recon on 2026-08-21.

## The shape, corrected by recon

The spec row counts "89 occurrences of `type: 'Type'` across 42 files" as the
blast radius. Recon says that number measures the INTERNAL vocabulary — the
`type:` frontmatter key, the `Type` metamodel, `TypeListing`, the `type`
Selection kind — and none of it can move:

- `type:` frontmatter is the ON-DISK FORMAT. Renaming it breaks every
  existing vault and the files-first contract itself.
- The `type` selection kind and the engine vocabulary are the same class of
  internal name M37.2 ruled on: kinds are shared with tools and dozens of
  call sites; renaming them buys nothing a user can see.
- `libraryKind`'s type-NAME routing (the spec's own survival requirement)
  keeps working precisely because the names it routes on do not move.

So M39 is the SAME split M37.2 locked: the labels spend, the kinds stay. A
"Type" was always the database (the Sidebar's own M3 comment says "the
databases themselves"); M39 makes the UI say so.

## What changes (labels only)

- Sidebar: the **Databases** section (was Types); `New database` /
  `Delete database` affordances.
- TypeDialogs: **New database** dialog (was "Create new type"),
  `Database name` field, delete dialog's primary action and toasts.
- ViewSettingsPanel: the type surface's delete action says
  `Delete database`.
- Tests that assert those strings (Sidebar.test, TypePage.test) move in the
  same commit. `data-testid="sidebar-type"` and every internal identifier
  stay — testids are addresses, not labels.

## What deliberately does NOT change (recorded)

- The Inbox checklist's "Has a type" and the organize TYPE select: they name
  the literal `type:` key the fix writes. Renaming the sentence away from
  the key it edits helps nobody.
- "Adopt vault schema" and its dialog copy: "schema" is accurate and the
  dialog's subject is the `type:` key's values.
- `type: Type` docs, `SKILL_TYPE`/`AGENT_TYPE`, `libraryKind` — the survival
  requirement, satisfied by not touching it.

## Slices

- **M39.2** the label spend + test updates, one commit.
- **M39.3** spec fold.
