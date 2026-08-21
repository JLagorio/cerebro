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

### M37.3 — the flattening (its own session, stated here)

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
