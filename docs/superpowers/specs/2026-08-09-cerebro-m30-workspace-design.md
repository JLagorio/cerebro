# M30 sub-project 1 — Multi-root workspace, file explorer, doc viewer

Design accepted 2026-08-09. Covers **A** (multi-root workspace) and **D′** (file
explorer tree + doc viewer) from `docs/superpowers/plans/2026-08-09-cerebro-m30-overview.md`.
Base: `main` @ 81210b9.

**Goal.** Mount your vault plus N work repositories. Browse any of them in a
VS Code-style tree. Read their markdown in a viewer good enough that you stop
opening the repo elsewhere to find a README.

**Non-goal.** Writing anything. This spec ships a viewer; C′ ships an editor.

---

## 1. The roots model

### 1.1 Data

New Rust module `src-tauri/src/roots/`.

```rust
pub struct Root {
    id: String,             // stable, generated once at mount; never derived from path
    path: String,           // absolute, canonicalized
    label: String,          // display; defaults to the directory basename
    alias: String,          // short slug; namespaces `about:` anchors in later work
    color: Option<String>,
    caps: RootCaps,
}

pub struct RootCaps {
    knowledge: bool,   // carries `knowledge/` (and, later, a ledger)
    git: bool,         // is a git repository
    writable: bool,    // mutations permitted at all
}
```

`id` is generated, not derived from the path, so moving a repo on disk does not
orphan every reference to it.

### 1.2 Capabilities are probed, not declared

- `git` ← `git::workspace::resolve(path).is_repo()`
- `knowledge` ← `path.join("knowledge").is_dir()`
- `writable` ← filesystem metadata **and** the user's explicit choice at mount

This is what makes the model capability-gating rather than a `kind` field in a
costume. AGENTS.md: *"behavior is capability-gated… Do not route on type names."*
No code in this spec may branch on "is this the vault".

### 1.3 The one-knowledge-root invariant

**v1 permits exactly one root with `knowledge: true`.** Mounting a second
directory containing `knowledge/` is refused at the command layer with a typed
reason, not prevented by a disabled control — `knowledge.rs` states the
principle this follows: *"a disabled button is a suggestion, a rejected command
is a rule."*

The refusal names the existing knowledge root, so the message is actionable
rather than merely negative.

This is a **constraint, not an architecture**. Lifting it later means deleting
the check and building federation; it does not mean reshaping `Root`.

### 1.4 Persistence

Roots live in **app-data, not the vault**. AGENTS.md's two-records rule assigns
operational state to `<app-data>/runtime.db` and epistemic history to the vault
ledger; a list of which repos you happen to have mounted is plainly operational.

Storage is a JSON document beside the existing app config, read through the same
load-or-default path `app_config.rs` already uses — a corrupt file degrades to
"no roots mounted", never to a crash.

### 1.5 Migration

On first run, `AppConfig.last_vault` becomes root #0 with `knowledge: true`,
`label` from its basename, and `writable: true`. `last_vault` is retained and
kept in sync so a downgrade still opens. No user action, no files moved.

### 1.6 Qualified paths

Add `Entry.root: string` (a root id), defaulting to the vault's root id.

This mirrors `Entry.project` exactly — a scan-derived containment field — and is
the minimum-blast-radius change: `Entry.path` stays root-relative, so every
existing consumer keeps working untouched.

`alias` reserves the cross-root reference form `alias:relative/path.md` for
later work. **This spec does not implement it and does not touch
`normalize_anchor`** — v1 has one knowledge root and mounted repos emit nothing,
so there is no cross-root anchor to resolve yet. The field exists now so that
mounting a root does not later require re-aliasing it.

---

## 2. Rust — two data paths

The tree and the markdown index have different access patterns, different
filters, and different memory profiles. One path serving both is what makes the
naive designs fail (see §8).

### 2.1 `roots/tree.rs` — lazy directory listing

`list_dir(root_id, rel) -> Vec<DirEntry>` returns **one level**, directories
first then files, each entry carrying name, kind, size, mtime, and its
`.gitignore` status.

Constant memory regardless of repository size; a monorepo opens instantly
because nothing walks it.

Ignored entries are **returned and flagged**, not omitted — the UI decides
whether to show them (§3.3). A backend that silently drops them makes the
show-ignored toggle impossible without a second round trip.

### 2.2 `roots/index.rs` — markdown index

Per root, markdown only, built from `git ls-files -- '*.md'`.

Using git as the filter is the whole trick: tracked files exclude
`node_modules/`, build output, and `.git/` **for free and correctly**, with no
ignore-pattern list to maintain and drift. It is git, not GitHub, so it works
against any remote or none.

A root with `git: false` falls back to a filtered walk reusing `scan.rs`'s
existing skip rules.

Parsing reuses `vault::parse`, so title-from-first-H1 and the ~160-char snippet
come from the code that already computes them.

### 2.3 Commands

`mount_root` · `unmount_root` · `list_roots` · `list_dir` · `read_file_text` ·
`index_root_markdown`

### 2.4 `read_file_text` guards — required before the function exists

Unguarded, this is an arbitrary-file-read primitive, and `mcp.rs` exposes tools
to a CLI subprocess. All three guards are part of the initial implementation,
not a follow-up:

1. **Path containment** — canonicalize the resolved path and assert it is under
   the root's canonicalized path. Defeats `../` traversal and symlinks pointing
   outside the root.
2. **Size cap** — 2 MB. Larger files return a typed `too_large` refusal carrying
   the actual size, so the UI can say how big rather than just "no".
3. **Binary detection** — a NUL byte in the first 8 KB returns a typed `binary`
   refusal.

Refusals are typed values, not error strings: the viewer renders a different
placeholder for each, and a string would force it to pattern-match prose.

---

## 3. UI — the Workspace surface

### 3.1 Navigation

New Rail destination, and a new arm of the `Selection` union:

```ts
| { kind: 'workspace'; root?: string; path?: string }
```

The open file rides on the selection rather than in component state, so "the
README of cerebro" is a place Back returns to. This is the same rationale the
union already documents for `list.view` and `library.tab`.

### 3.2 Components

- `src/pages/WorkspacePage.tsx` — the surface
- `src/workspace/RootTree.tsx` — lazy tree rendered from a flat row list (§3.4)
- `src/workspace/FileViewer.tsx` — routes by file, in order: a typed refusal
  from `read_file_text` (§2.4) → the matching placeholder; `.md`/`.markdown` →
  `DocViewer`; an extension Shiki resolves to a language → `CodeViewer` with
  that language; any other text file → `CodeViewer` with highlighting off.
  Unknown extensions render as plain monospace rather than refusing — a
  `.env.example` or a `Dockerfile.dev` is still readable text.
- `src/workspace/DocViewer.tsx`, `src/workspace/CodeViewer.tsx`
- `src/workspace/RootMountDialog.tsx` — pick a directory, preview probed
  capabilities before confirming

The sidebar in workspace mode lists mounted roots as top-level collapsibles,
each showing its capability chips.

### 3.3 Ignored files

Honored for display by default, with a show-ignored toggle whose state persists
per root. Ignored entries render dimmed rather than hidden when shown, so the
toggle's effect is legible. (Tolaria's `gitignoredVisibility.ts` is the
precedent.)

### 3.4 Windowing — deferred, deliberately

A directory *can* hold thousands of entries, and Cerebro ships no virtualization
library. **Decision: ship without one, and revisit on evidence.**

The tree is already lazy, so only EXPANDED directories render, and in practice
those hold well under a few hundred entries. Windowing pays off only in the
pathological case.

What makes deferring safe rather than optimistic is the row model: the tree
renders from a flat, indexable array produced by a pure flatten. That array is
exactly the input `react-virtuoso` or `@tanstack/react-virtual` consumes, so
adding windowing later is a change to **one component**, with no API change
anywhere else. It is the cheapest decision in this spec to reverse, which is the
reason not to make it up front.

### 3.5 Unavailable roots

A root whose path has vanished — external drive unmounted, repo deleted —
renders as a **persistent unavailable node in the tree**, carrying the last
known path and a remove action.

This is one of the two deliberate exceptions to the store-layer invariant
catalogued in §6: a toast that disappears would leave a repo silently absent
from a list whose entire job is to tell you what is mounted.

---

## 4. The doc viewer

The reason this spec chose a bespoke surface over reusing the record views. It
has to be good, so its requirements are explicit rather than implied.

### 4.0 Rendering stack

Cerebro today has **no read-only markdown renderer and no syntax highlighter**.
Its only markdown path is BlockNote — an editor — whose round trip
`src/editor/markdown.ts` explicitly documents as lossy
(`blocksToMarkdownLossy` normalizes `-` bullets to `*`, loosens lists, repads
tables) and which only ever sees a note *body* with frontmatter pre-stripped.

That is correct for editing your own notes and wrong for displaying arbitrary
repository markdown: a README carries raw HTML badges, footnotes, nested tables
and reference links that a block-editor's importer degrades. **Rendering a file
must not route through a parser whose contract is lossy normalization**, even
read-only.

Decisions:

- **`react-markdown` + `remark-gfm`** for the doc viewer. Read-only, full GFM,
  and a renderer-component map — which is what makes §4's relative-link
  interception and the pluggable fence renderer clean rather than a DOM hack.
- **Shiki** for highlighting, used by *both* `CodeViewer` and markdown code
  fences, so one highlighter is configured once. Chosen over a CodeMirror
  read-only instance because this spec ships no editing: CodeMirror would drag
  in editor machinery for a surface that must not be editable, and C′ can adopt
  it later for the edit surface without disturbing the viewer.

**Dependency delta: one genuinely new package.**

Two of these are already in the tree. `@blocknote/code-block@0.46.2` — an
existing dependency — pulls `@shikijs/core`, `engine-javascript`, `langs`,
`langs-precompiled` and `themes` at 3.23.0; and `remark-gfm@4.0.1` is already in
the lockfile with the full micromark/mdast GFM extension set.

| Package | Status |
| --- | --- |
| `shiki` | already bundled via BlockNote — add at `^3.23.0` so pnpm keeps one copy |
| `remark-gfm` | already in the lockfile — add at `^4.0.1` to dedupe |
| `react-markdown` | the only real addition; `unified`, `remark-parse`, `mdast-util-to-hast`, `vfile` and `property-information` are already present, so it contributes the React glue and little else |

Reusing BlockNote's Shiki is a correctness win before it is a size one: a `rust`
fence in a vault note and a `rust` fence in a repo README then render through
the same grammars and themes, instead of drifting apart.

Note also that `mermaid@^11.16.0` is ALREADY a dependency — only the render
integration is absent on this base. Registering a mermaid fence renderer later
therefore needs no new package at all.

BlockNote stays exactly where it is: the editor for vault notes. This spec adds
a viewer beside it and changes nothing about the editing path.

### 4.1 Reading experience

- **Read-only render** at a controlled measure (~70ch) with a deliberate
  typographic scale — this is a reading surface, not a table cell.
- **Outline / TOC** reusing the existing `src/editor/DocOutline.tsx`.
- **Relative links resolve and navigate in-app.** `[see the guide](./docs/guide.md)`
  opens that file in the viewer. This is the single feature that turns a pile of
  markdown into browsable documentation, and it is why a generic row-renderer
  was not enough.
- **Images resolve relative to the file**, through the same containment guard as
  `read_file_text`.
- **Code fences** rendered through the same Shiki instance as `CodeViewer`
  (§4.0), so a fence and a file agree on how a language looks.
- **Mermaid is out of scope here** — the base predates `m29-mermaid`. The block
  renderer is a lookup from fence language to component **specifically so
  merging M29 registers a renderer** rather than requiring rework.

### 4.2 The Docs tab

Within the workspace surface, a tab listing every indexed markdown file across
all mounted roots, grouped by root, READMEs first, sorted by depth then title.

This is the "central place" the originating ask described, and it is the
component later promoted to a collections view kind (D″) — but only after real
use proves it. It is deliberately not wired into `ViewType` in this spec.

---

## 5. Data flow

```
mount → probe caps → persist → list_roots
                                   ↓
                    ┌──────────────┴──────────────┐
              RootTree                       Docs tab
                 ↓                                ↓
      list_dir(root, rel)              index_root_markdown(root)
      (lazy, one level, all types)     (git ls-files, markdown only)
                 ↓                                ↓
           FileViewer ←──── read_file_text ───────┘
                 ↓
     DocViewer | CodeViewer | typed placeholder
```

Indexing runs per root on mount and on demand; it is not on the boot path, so a
slow or huge root cannot delay app start.

---

## 6. Error handling

Human-UI actions follow the store-layer invariant: catch, `toast()`, return
`null`/`false`, never throw. Mount failures, unreadable files and vanished roots
all route through it.

Two documented exceptions:

- **Unavailable roots** render persistently in the tree (§3.5).
- **`read_file_text` refusals** are typed values the viewer reads and renders as
  distinct placeholders. Collapsing `too_large`, `binary` and `not_found` into
  `null` would make every one of them render as the same blank pane — the same
  reasoning AGENTS.md gives for exempting proposal channels.

---

## 7. Testing

**Rust** (`roots/`, over `vault::testutil::temp_vault`): capability probing for
each combination; the one-knowledge-root refusal; `list_dir` ordering and
gitignore flagging; `read_file_text` path-traversal refusal, symlink-escape
refusal, size cap, binary detection; index construction from `git ls-files` and
the non-repo fallback; corrupt-persistence degrades to empty.

**TypeScript** (engine): root resolution, `Entry.root` defaulting to the vault
root for single-root vaults, alias uniqueness on mount, Docs-tab grouping and
sort order (README-first, then depth, then title). Anchor normalization is
untouched by this spec (§1.6) and gets no new tests.

**Mock parity:** `src/lib/mockIpc.ts` mirrors every new command **and every
guard** — a mock that permits a traversal the Rust side refuses makes the
Playwright suite prove the opposite of the invariant. AGENTS.md makes this a
hard rule for `knowledge/`; the same reasoning applies here, and the parity is
itself tested.

**Playwright:** mount two fake roots via `__cerebroMockFs`, expand a tree, open a
README, assert the outline renders and a relative link navigates; toggle
show-ignored; render an unavailable root.

**Gates:** `pnpm lint` (zero warnings), `pnpm typecheck`, `pnpm test:run`,
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
Coverage thresholds ratchet up only.

---

## 8. Rejected alternatives

**Rows in the existing view engine** (each `.md` becomes an `Entry` with derived
columns, reusing Table/List/Gallery/filter/group/sort). Attractive because
`Entry` already fits a README unchanged and `ColumnDef.undeclared` was designed
for exactly this. **Rejected because the tree must show `.ts`, `.rs` and
`Cargo.toml`, and `scan.rs` only emits entries for `.md`.** Code files will never
be rows, so the tree cannot be built on `rows.ts` at all. Revisited as D″ for the
markdown half only, where it is a genuinely good fit.

**Extending the vault scan to all roots** — one unified data path, most
consistent with today's architecture. Rejected: `scan.rs` does not skip
`node_modules/`, `target/` or `dist/`, and making it emit every file type puts
100k+ entries in a Zustand store.

**Fully lazy, no index** — VS Code's model exactly, scales to anything. Rejected:
it cannot answer "every README across 8 repos" without walking every tree on
demand, which is the cost it was avoiding.

**Per-repo knowledge bundles** — federation, Tolaria's multi-vault shape.
Rejected: N seq spaces and N conformance surfaces force HLC back against an
accepted amendment, and it commits AI-written markdown into shared repos.

**Widening the `{ kind: 'docs' }` surface** — matches "one central place"
literally. Rejected: `DocsPage` filters on `isDocEntry` (untyped vault notes),
which a surface rendering `.ts` files cannot mean.

**Cerebro-managed clones** — cleanest onboarding. Rejected: two tools owning one
working copy, and repos are already on disk.

**Reusing BlockNote read-only for the doc viewer** — adds zero dependencies and
guarantees viewer and editor agree. Rejected: its markdown round trip is
documented as lossy normalization, and it is built to consume a note body with
frontmatter pre-stripped. Repository READMEs carry raw HTML, footnotes and
reference links that a block-editor importer degrades — and a *viewer* that
silently alters what the file says is worse than one that adds a dependency.

---

## 9. Out of scope

Editing any file · split panes and tabs · clone, credentials, connect wizard ·
any GitHub API surface · promoting the doc viewer to a `ViewType` · a second
knowledge root · emitting ledger events for repo activity.
