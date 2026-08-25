# M43 — Finish the shell: the sidebar becomes the whole chrome

The user reworked the product design in `docs/cerebro/CerebroApp.dc.html` (the
canvas prototype; gitignored reference, not code). This spec translates that
sidebar onto the app's real subjects. Decisions below were made explicitly by
the user on 2026-08-25: full shell (Topbar dissolves), Agents becomes a
section, footer is Theme + Settings only, and BOTH unbuilt subjects — My work
and Favorites — get built.

## 1. The Topbar dissolves

`src/app/Topbar.tsx` is deleted. Every tenant rehomes:

- **Wordmark** (`cerebro.` with the synapse dot) → sidebar header.
- **Ask-bar** → two header icon buttons: **zap** toggles the Assistant panel
  (`aiPanelOpen`, `aria-pressed`, synapse-500 ink — asking is the one AI act
  in the chrome), and **search** opens QuickOpen (⌘K). The palette's pinned
  Ask row (M42.5) is untouched.
- **SyncBadge** → sidebar footer. Still silent unless actionable (M9.4).
- **CreateMenu** → a bordered **New** button at the top of the nav scroll
  area, same create items, popover opens below the button.
- **Avatar** → a **vault-initial tile** in the sidebar header (first letter
  of the vault folder name, tooltip = full vault name). The design's avatar
  slot carries identity; ours answers "which vault", which the old sidebar
  header answered and must not stop answering.

The canvas (`bg-n-0`) starts at the window edge; each surface keeps or grows
its own header (the design's per-surface headers), but no surface header work
is in scope beyond what deleting the Topbar forces.

## 2. Sidebar anatomy

264px default (stored width preference and resize handle keep working).
Sunken surface, one scroll area, footer pinned.

**Header row**: vault tile · wordmark · spacer · zap · search · collapse
(26px icon buttons, `hover:bg-n-100`).

**Primary rows**, in order: Inbox (hot count: mono, cortex-600 when > 0) →
Home → **My work** (open-count) → Work → Studio → Base → History → **Library**
(moves up from the footer). Chevron groups for Work / Studio / Base keep the
M42.2 shape. **Agents leaves this list** (becomes a section, §4).

**Sections**, in design order: COLLECTIONS → PAGES → AGENTS → DATABASES →
FAVORITES. All five share one section-header anatomy (§4).

**Footer**: SyncBadge · Theme toggle (cycles system → light → dark, icon
matches the mode) · Settings. No notifications bell — there is no feed, and
a dot promising nothing is a lie.

**Collapsed**: the w-8 hairline is replaced by the design's floating cluster
at the window's top-left (expand · zap · search), absolutely positioned over
the canvas. Expand restores the stored width.

## 3. My work — a new surface

- **Membership is capability-gated, never type-routed**: an entry is "open
  work" iff its resolved status set has a status field AND its current status
  resolves to a `StatusDef` whose `group` is `'active'`. No assignee concept:
  single-user vault.
- A status VALUE that does not resolve against the status set (a typo, a
  retired status) is not "active" and not "done" — it is unresolvable, and
  the entry is EXCLUDED from My work rather than guessed at. The count counts
  what the page shows.
- New selection kind `mywork` in the nav store, plus the navigate MCP tool's
  kind vocabulary (kinds are shared internal vocabulary — the Rust side and
  the mock must both accept it).
- Page: open work grouped by database (type display name), DS list rows,
  status chip per row, opens the record. Empty state: words, not a zero.
- Nav count: quiet mono count of open work, same anatomy as Inbox's.

## 4. Sections — one header anatomy

A section header is: rotating chevron (13px, 120ms, toggles the section) ·
uppercase 2xs label · hover-revealed actions right-aligned (opacity 0 → 1 on
header hover, 20px hit targets). Open state persists as a closed-set in
localStorage (`cerebro.navClosed`, the M42.2 store — section ids join the
group keys). Open by default.

- **COLLECTIONS**: ＋ "New collection". Tree unchanged (CollectionTree).
- **PAGES**: hover reveals folder-plus "New folder" and ＋ "New doc"
  (wired to the FileTree's existing creation flows). Tree unchanged.
- **AGENTS**: ↗ "Open all agents" (navigates `{ kind: 'agents' }`, the fleet)
  and ＋ "New agent" (navigates to Library's agent tab, as today). One row per
  agent record: bot icon in synapse-500, paused agents render dimmed
  (`text-n-500`) with a `pause` tail icon. Active row = deepest-thing-lights
  rule, unchanged.
- **DATABASES**: quiet mono counts per row (already true); the adopt-schema
  wand and ＋ become hover reveals on the header.
- **FAVORITES**: rows are pinned paths (§5); empty state "No favorites yet"
  in words (`text-n-400`), which IS measured-at-zero — an empty favorites
  store is a real zero, not an unavailable read.

## 5. Favorites

- A **star** control in three headers: doc page, record detail panel, agent
  page. Starred = filled star (`--warn-500`, per the design's `agFavToggle`);
  unstarred = outline, hover reveal where the header is crowded.
- Persistence: `cerebro.favorites` in localStorage via the ui store —
  workspace state, not vault content, the same rule that placed
  `cerebro.navClosed`. Stored as ordered vault-relative paths.
- A favorite is a **pointer, not a record**: a path that no longer resolves
  to an entry is pruned at render (and lazily dropped from the store), never
  shown as a dead row. Deliberate exception to "absent is never zero"
  scoping: the favorites LIST is chrome state; pruning is the list staying
  truthful, and the star on a live page always shows its real state.
- Row anatomy: the target's icon (doc / type icon / bot), title, navigates on
  click.

## 6. Contracts churned deliberately

- `Sidebar.test.tsx`'s ten-destination-name assertion is rewritten to the new
  list: Home, Inbox, My work, Work, Studio, Base, History, Library, Settings
  as rows, Agents as a section. Every churned name is a conscious edit, not
  collateral.
- Agent rows keep `data-testid="nav-agent"` and live in
  `data-section="nav-agents"`, OUTSIDE `nav-surfaces` containers (the e2e
  scoping rule survives the move).
- `aria-current="page"` on destinations, `aria-pressed` on the zap toggle,
  count-in-accessible-name ("Inbox (2)") all keep.
- e2e specs that reach for Topbar testids (`SyncBadge`, create menu, ask-bar)
  re-target the new homes.
- Coverage thresholds only ratchet up; zero-warning lint; no `--no-verify`.

## Out of scope

- Notifications (feed and bell), avatars/identity, Spaces letter-tiles for
  Collections, per-surface header redesigns, the design's Docs drag ghost.
- Any change to selection KINDS beyond adding `mywork` — labels spend, kinds
  stay (M37.2 rule).
