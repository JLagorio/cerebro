# Cerebro M2 — Markdown-First Realignment (Plan Draft)

> **Status: DRAFT.** Milestone-altitude plan. Before execution, expand each task to M1-style contracts (shared signatures, step-by-step TDD, exact commands) per superpowers:writing-plans — the same treatment `2026-07-24-cerebro-m1-foundation.md` received. Steps here are acceptance criteria, not execution steps.

**Goal:** Realign Cerebro to what it is — a markdown application first (notes, folders, YAML metadata), with PM surfaces on top. Concretely: spaces removed (projects are the top level), a project is a real folder the user can build structure inside, saved views are tabs across the project header, a BlockNote-based rich markdown editor replaces the body textarea and powers a new Docs surface, and grouping/sorting controls become custom DS dropdowns.

**Why:** M1 over-mirrored the `cerebro-with-teams` prototype's PM shell and under-delivered the markdown core. The M1 data layer is already files-first (`.md` + YAML frontmatter, `views/*.yml`, `type: Type` schema docs) — M2 changes the vault layout and the UI, not the storage philosophy.

**Context:** M1 complete on `m1-foundation`, PR #1 open. M2 branches from `main` after PR #1 merges. Branch: `m2-markdown-first`.

---

## Locked decisions (user, 2026-07-25)

1. **Work items live inside the project folder.** Project membership is containment-based (file lives under the project's directory), not wikilink-based.
2. **Table view = frontmatter data grid** (Airtable-like, rows = entries, cells = fields, inline edit writes YAML). Tolaria's IronCalc SheetEditor is a *per-note spreadsheet* — a different feature, possibly a later "sheet note" type. (Table view itself ships in M3; M2 must not preclude it.)
3. **BlockNote is the editor base** (proven in Tolaria 0.46.x, ProseMirror-based, markdown round-trip, matches the OKR-mock block editor).
4. **Status definitions live on the Work item Type doc** (vault default) with optional per-project override in `project.md` frontmatter.
5. **My Tasks ships with due dates in v1** (feature itself lands M4). Syntax: Obsidian-Tasks-compatible `📅 YYYY-MM-DD` after the checkbox text. The emoji lives in *files only*; the UI renders a date chip (DS no-emoji rule applies to chrome, not vault content).

## Milestone map (M2 → M4)

- **M2 (this plan):** structure + editor. Spaces removed, project-as-folder, saved-view tabs, custom dropdowns, BlockNote editor, Docs surfaces, M1.x fix pack.
- **M3 — views platform:** Table data grid, filter builder + view-controls popover (visible fields per view), Calendar, then Timeline/Gantt (need `daterange`; Gantt adds dependencies).
- **M4 — fields platform + tasks:** Settings editor for types/fields/values (editing the `type: Type` docs), new field kinds (`textarea`, `url`, `rollup` last), Home = My Tasks (checkbox aggregation with `📅` due dates, Overdue/Today groups, toggle-in-place writeback).

M2 must keep the door open for M3/M4 but implements none of them.

---

## Vault format v2

```
vault/
  projects/
    field-app-launch/
      project.md              # type: Project; icon/color/status; optional statuses: override
      views/
        delivery.yml           # per-project saved views (tab order via `order:`)
      items/
        lnc-1.md               # type: Work item (items/ is convention; any .md with
        lnc-2.md               #   type: Work item under the project folder counts)
      meetings/                # user-created structure — folders and docs, any nesting
        2026-07-25-kickoff.md
      launch-checklist.md      # a doc directly under the project
  people/
    priya-nair.md              # type: Person
  types/
    work-item.md               # type: Type docs; work-item.md now carries `statuses:` default
    project.md
    person.md
  views/
    all-open-items.yml         # vault-global views (sidebar), unchanged format
  inbox/                       # vault-level docs/folders outside any project — allowed
    scratch.md
```

**Rules:**

- **Project membership = containment.** An entry's project is the nearest ancestor directory containing a `project.md`. The M1 `project: "[[slug]]"` frontmatter field is no longer used for membership (scanner keeps it as an ordinary property if present; demo generator stops emitting it).
- **A "doc"** is any `.md` whose `type` is absent or not one of the structured types (Work item, Person, Project, Type). Folders are real directories. Docs can live in projects or loose in the vault.
- **Statuses:** `types/work-item.md` frontmatter gains `statuses:` (array of `{id, label, group, color?}` — same shape spaces carried in M1). `project.md` may carry a `statuses:` override; resolution order: project → Work item Type doc → `DEFAULT_STATUSES`.
- **Spaces are gone.** No `spaces/` folder, no `type: Space` handling, no space layer in schema/nav/UI.
- **Saved views:** per-project views live in `<project>/views/*.yml`; vault-global views stay in `vault/views/*.yml`. Same YAML schema as M1 (`name/icon/color/order/filters/presentation`); `presentation.type` stays `'list' | 'board'` in M2 (M3 widens it).

## Migration (spaces → projects)

No released users exist — **the demo-vault generator is the primary migration** (Task 4 regenerates `demo-vault/` in v2 layout). For dev vaults created during M1, ship a one-off script (`scripts/migrate-vault-v2.ts`, run manually):

1. For each `projects/<slug>.md`: create `projects/<slug>/`, move the file to `projects/<slug>/project.md`.
2. For each item with `project: "[[<slug>]]"`: move into `projects/<slug>/items/`, drop the `project:` line. Items with no/unresolvable project link → `inbox/` (report them).
3. Statuses: copy the first space's `statuses` array onto `types/work-item.md`; where spaces differed, write the differing set as `statuses:` overrides on each `project.md` of that space's projects.
4. Delete `spaces/` files; drop `space:` frontmatter from project docs.
5. Global `views/*.yml` whose filters pin a single project → move into that project's `views/` (else leave global).
6. Idempotent; prints a summary; refuses to run twice (detects v2 by presence of any `project.md`).

The app itself does **no** silent auto-migration: opening a v1 vault shows a notice pointing at the script (detection: `spaces/` exists or any entry has `type: Space`).

---

## Architecture delta (M1 → M2)

- **Rust scanner** (`scan.rs`/`entry.rs`): emits `Entry.project` (vault-relative path of owning `project.md`, nullable) resolved by containment, plus a `folder` field (vault-relative parent dir) so the UI can build trees. New command `list_folders` or tree derivation client-side from paths (decide in contract pass — prefer client-side derivation, zero new IPC).
- **Rust writes** (`write.rs`): `create_note` gains directory targeting (create under any folder); new `create_folder`, `rename_note` (file move within vault), `delete_note` (to OS trash via `trash` crate — never hard delete). All fenced by the existing vault-boundary checks.
- **Engine** (`schema.ts`): `spaceForEntry`/`statusSetForSpace` → `projectForEntry` (trivial now — read `Entry.project`) and `statusSetForProject` (project override → Work item Type doc → defaults). `Selection` drops `space`, gains `docs` and `{doc, path}`.
- **Views** (`views.ts`): view files carry a scope (derived from location — global vs project folder); `listViews` returns both; project tabs = that project's views sorted by `order`.
- **Editor:** new `src/editor/` — BlockNote wrapper: markdown in (`tryParseMarkdownToBlocks`), markdown out (`blocksToMarkdownLossy`), debounced `saveNote`, DS-themed. Used by DocPage (full page) and DetailPanel (body section).
- **DS primitives:** new `Dropdown` (styled listbox: keyboard nav, typeahead, sections, icons — the popover pattern from the mocks) replacing native `<select>` in ViewToolbar; `Select` primitive remains for forms where native is fine.
- **Rail:** `c.` + Home + **Docs** + Settings (Docs is functional day one — no dead chrome).

## New dependencies

`@blocknote/core` + `@blocknote/react` (+ the shadcn/Tailwind flavor package) pinned to Tolaria's proven line (~0.46) — confirm exact set against `docs/tolaria-main/package.json` during contract expansion. Rust: `trash = "5"` for safe delete. No other additions; everything else reuses M1's stack.

## Conventions

Inherit all M1 conventions (branch/commits/TDD/commands/styling) verbatim from `2026-07-24-cerebro-m1-foundation.md` §Conventions, with: working branch `m2-markdown-first` off `main` (post-PR-#1); docs/ is gitignored — plan/log edits need `git add -f`.

---

## Task index

| # | Task | Produces |
|---|---|---|
| 1 | M1.x fix pack — the (B) backlog from the M1 final review | stale-body refetch policy; quick-add `isSubmitting` + slug fallback; save-view try/catch + id dedupe; create flows keep typed capitalization; multiselect-board drag refuse+toast; scanner per-file degrade + `#[tauri::command(async)]`; CSP + bundle icon; @theme reset + text-white batch; fresh-vault empty states; number-editor `.nan` guard |
| 2 | `Dropdown` DS primitive + ViewToolbar swap | custom dropdowns for group-by/order-by (keyboard nav, DS-styled), native selects gone from toolbar |
| 3 | Rust: vault format v2 | containment-based `Entry.project`, `folder` field, `project.md` detection; `create_folder`/`rename_note`/`delete_note`(trash); tests on a v2 fixture vault |
| 4 | Demo vault v2 + migration script | regenerated `demo-vault/` (projects-as-folders, `types/work-item.md` statuses, docs + folders per project, no spaces); `scripts/migrate-vault-v2.ts` idempotent |
| 5 | Engine: schema v2 | `statusSetForProject` resolution chain (project → Type doc → defaults); space layer deleted; `Selection` v2 (`docs`, `doc`; no `space`) |
| 6 | Engine: per-project views | views discovered in project folders, scope derived from location; global views unchanged; create/update/delete view files under the project |
| 7 | Shell v2 | Rail + Docs item; Sidebar = projects list (top-level) + global views; HomePage v2 (projects overview); SpacePage deleted; v1-vault migration notice |
| 8 | Project header tabs + toolbar rework | saved-view tabs (icon + name, underline active, `order`-sorted) + "New view" + separator + page tabs (Overview = `project.md` body, docs in folder); toolbar loses "Save view" — tab edits auto-persist to the view's YAML |
| 9 | BlockNote editor component | `src/editor/MarkdownEditor.tsx`: md→blocks→md round-trip fidelity tests on fixture docs, debounced disk writes, DS theme, checkbox/callout/code/table blocks |
| 10 | Doc surface + project file tree | DocPage (full-page editor, H1-synced title); tree UI under project (create folder/note, rename, delete→trash, expand state persisted) |
| 11 | Docs rail surface | All-docs view: vault folder tree + recents ("pick up where you left off" per OKR mock); open → DocPage |
| 12 | DetailPanel body → BlockNote | textarea replaced by inline MarkdownEditor; rename+body refetch race (Task 1 policy) covered by test |
| 13 | Smoke v2 + regression sweep | Playwright: boot → project tabs → switch saved view → create doc in folder → edit in BlockNote → reload persists; full suites green |

**Sequencing notes:** 1–2 are independent warm-ups. 3→4→5 is the format chain; 6–8 sit on 5; 9 is independent after 2; 10–12 need 9; 13 last. Tasks 3+4 land together in one PR-sized unit if possible — scanner and demo vault must agree at every commit (M1 convention: repo always green).

## Definition of done (M2)

- `pnpm exec tsc --noEmit`, `pnpm vitest run`, `cargo test`, Playwright smoke: all green; full Tauri `cargo build` zero warnings.
- Demo vault opens with projects-as-folders; zero references to spaces in `src/`, `src-tauri/`, or the demo vault.
- A user can: create a folder and a doc under a project, write in a rich markdown editor, see the file on disk as clean markdown, toggle between saved-view tabs on a project, and change group/sort via DS dropdowns.
- First real `pnpm tauri dev` shakeout on a real (non-demo) vault performed and logged — carried over from M1 next-steps; M2 is the milestone where it must actually happen.

## Open items for contract expansion

1. Folder-tree derivation: client-side from entry paths vs. a `list_folders` IPC (leaning client-side; must handle empty folders — likely needs the IPC after all for those).
2. BlockNote round-trip fidelity: fixture corpus (nested lists, code fences, tables, frontmatter untouched) and the policy when import is lossy (block save? warn? Tolaria's approach — check their serialization path).
3. View auto-persist UX: debounce + toast on failure, or explicit dirty-dot + save? (Draft assumes auto-persist; validate against mock behavior.)
4. Whether `items/` quick-add targets `<project>/items/` always, or the currently-open folder.
5. Exact BlockNote package set + version pins from Tolaria's package.json.
