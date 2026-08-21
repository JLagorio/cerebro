# M37 — Shell flattening: one sidebar, and the names the design locked

**Spec:** `docs/superpowers/specs/2026-08-17-agent-platform-design.md` §7 (M37 row);
naming locked in the cerebro-ds design work (2026-08-20): **Base** (was
Knowledge), **Work** (was Workspace), Studio.
**Branch:** `m34-agent-platform`. Written after recon on 2026-08-21.

## Shape

Today's shell is a two-column nav: a 72px icon RAIL (nine buttons) beside a
contextual SIDEBAR that changes per surface (Collections+Types on the item
world, KnowledgeNav on Knowledge, nothing on six SIDEBARLESS surfaces). The
design's end state is Notion's: ONE sidebar column that is the whole nav.

Two slices, deliberately unequal:

### M37.2 — the names, spent now (this session)

The rename is LABELS, not selection kinds: `selection.kind` strings
(`knowledge`, `workspace`) are internal vocabulary shared with the `navigate`
MCP tool and 89 call sites — renaming those buys nothing a user can see and
risks every one of them. The spec's own phrase is "naming locked now, spent
later"; the label is the part a person reads.

- `Rail.tsx`: Knowledge → **Base**, Workspace → **Work**.
- `Rail.test.tsx`'s asserted-by-name list; `boot.ts`'s `openKnowledgeTab`
  click; `knowledge.spec`'s aria-label; `workspace.spec`'s opener.
- AGENTS.md's documented nine-button list.

### M37.3 — the flattening — **DELIVERED 2026-08-21**

Rail + contextual sidebar → one column: vault header, search, then the
surfaces as SECTIONS (the item world's Collections/Types tree inline, Base's
nav rows inline, the Library and Settings at the foot). Blast radius the spec
already counted — `Rail.test.tsx` retires for a sidebar contract test, 7/13
e2e specs open surfaces through the rail testid, the six SIDEBARLESS
surfaces each need a decision (a one-column shell has no surface without a
sidebar), and the Knowledge-tab→agent-page relocation deferred from M35
lands here, where the geometry moves once. Not started in the same breath as
the rename: a half-flattened shell is the one state worse than either whole
one.

**As delivered.** One `app/Sidebar.tsx` column: vault-name header (which
vault, said nowhere before), a Search row sharing QuickOpen with the Topbar's
⌘K, the nine destinations as rows keeping the rail's a11y contract
(`aria-current`/`aria-pressed`, count-in-name), Collections + Types always
inline, chrome destinations at the foot. Decisions the plan owed:

- **The six SIDEBARLESS surfaces all get the one column.** Their objection
  was Collections-and-Types-as-irrelevant-width; a nav that IS the shell is
  not irrelevant to any surface. Collapse (the M11 hairline) stays as the
  escape hatch — the diagram canvas and a wide repo can take the width back.
  `WorkspacePage` keeps its own tree BESIDE the nav; `diagrams.spec`'s
  "sidebar gone" assertion inverted to "nav still standing".
- **Nested content sits OUTSIDE the `nav-surfaces` containers** (three
  groups + foot). The Docs tree's `inbox/` folder row shares an accessible
  name with the Inbox destination; a spec scoped to the destinations
  container must never catch a folder. Found by the first e2e run, not
  predicted — recorded because the next nested section will meet it again.
- **The M35 relocation is the Base rows nesting under the Base destination**
  — the agent's axes live in the one nav column; the identity link stays the
  M35.3 byline on the page. `KnowledgeNav` stopped being a scroll owner.
- **Two assertions inverted, not deleted**: knowledge.spec and
  base-itself.spec asserted Types ABSENT beside the bundle; what made the
  bundle's axes its own was never the absence, it was that they are not
  BORROWED — the nesting states that stronger. agent.spec's Library check
  became "no type row claims the page" via `aria-current` the type rows
  gained for it.
- Layout arithmetic: the rail's 56px left `SHELL_NARROW_MAX` (1120 → 1048)
  and `SHELL_TWO_PANEL_MIN`; a prettier sweep commit precedes the flattening
  because pre-commit lints but does not format-check and the branch has
  never pushed.
