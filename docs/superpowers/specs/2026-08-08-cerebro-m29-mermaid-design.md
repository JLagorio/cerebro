# M29 — Full Mermaid Support: Design

**Status:** Accepted 2026-08-08 (brainstormed with the user; approach and scope
confirmed). Implementation plan: `../plans/2026-08-08-cerebro-m29-mermaid.md`.

## What exists today (M2.x)

The doc editor already has a `MermaidBlock`: ` ```mermaid ` fences round-trip
through `src/editor/markdown.ts` (promote/demote) into a custom BlockNote block
(`src/editor/blocks.tsx`). The block lazy-imports mermaid 11.16, renders with
`securityLevel: 'strict'` and a **hardcoded `neutral` theme**, and edits through
a bare textarea behind an Edit/Done toggle — no preview while typing, error
message truncated to its first line. Record notes share the same editor, so they
get the same block. Everywhere else, mermaid is dead text:
`src/knowledge/ConceptBody.tsx` renders mermaid fences as plain `<pre><code>`.
The demo vault contains zero mermaid. The AI panel chat renders no markdown at
all.

## Goal

Full mermaid support, in four confirmed dimensions:

1. **Render everywhere** — every surface that renders markdown renders
   diagrams (docs, record notes, knowledge concepts).
2. **Authoring** — live side-by-side editing with real errors, syntax
   highlighting, per-type templates.
3. **Viewing ergonomics** — fit-to-width, lightbox with zoom/pan, copy/export
   SVG and PNG.
4. **Diagram capabilities** — all mermaid 11 diagram types, ELK layout option,
   theme wired to Cerebro tokens.

Plus the headline, chosen explicitly over a freeform canvas: a **structural
visual editor** for flowcharts — edit the diagram by clicking it (rename,
connect, add, delete, reshape), mermaid re-lays-out after each change, with a
code toggle to see the source. Files stay 100% ordinary ` ```mermaid ` fences.

## The constraint that shaped the design

Mermaid is auto-layout by design: code declares nodes and edges; the engine
places them. There is no hand-positioning in the file format, so a true
Lucidchart (freeform canvas) cannot round-trip to pure mermaid. The user chose
the structural editor over (a) a freeform canvas that would abandon the
` ```mermaid ` format for canvas JSON, and (b) a text-only editor with AI
assist. Structural editing keeps the files-first story intact: every visual
operation is a text edit to the fence body.

## Architecture

New module `src/mermaid/` owns everything diagram-shaped. Surfaces are thin
callers. The existing `MermaidView` moves out of `src/editor/blocks.tsx`
(which keeps callout + AI blocks); only thin BlockNote glue stays in `editor/`.
The markdown round-trip in `src/editor/markdown.ts` is already correct and does
not change.

| Unit                  | Job                                                                      |
| --------------------- | ------------------------------------------------------------------------ |
| `render.ts`           | The one render service. Lazy-loads mermaid once; `securityLevel:         |
|                       | 'strict'`; registers ELK layout loaders (lazy chunk); returns typed      |
|                       | `{ ok, svg } \| { ok: false, message, line? }` — **never throws**;       |
|                       | small LRU cache (code+theme → svg) so re-mounts are instant.             |
| `theme.ts`            | Builds mermaid `themeVariables` from Cerebro CSS tokens read at render   |
|                       | time via `getComputedStyle` (fills `--n-25`/`--cortex-50`, borders       |
|                       | `--n-200`, text `--n-800`, font `--font-ui`). No more hardcoded          |
|                       | `neutral`. Dark mode exists (M16.39, `<html data-theme>`): live token    |
|                       | reads follow a flip; the render cache keys on the resolved palette and a |
|                       | theme-epoch hook re-renders mounted diagrams.                            |
| `MermaidDiagram.tsx`  | Universal read-only renderer: fit-to-width, max-height with expand       |
|                       | affordance, error state showing message + source.                        |
| `MermaidLightbox.tsx` | Fullscreen overlay on the M16 layers system: zoom 25–400% (wheel +       |
|                       | buttons), drag-to-pan, Copy SVG / Copy PNG / Save PNG… (svg→canvas;      |
|                       | save via dialog plugin + existing Rust file commands).                   |
| `flowchart/`          | Stage C: line-oriented model (`model.ts`), structural ops (`ops.ts`),    |
|                       | interaction overlay (`StructuralEditor.tsx`).                            |

## Stage A — Render everywhere + viewing

- `ConceptBody.tsx`: when a fence's language is `mermaid`, render
  `<MermaidDiagram>`; every other language keeps the existing `<pre>`.
- Doc/note blocks gain fit-to-width + lightbox entry.
- All mermaid 11 diagram types render through the core: flowchart, sequence,
  class, state, ER, gantt, pie, mindmap, timeline, quadrant, sankey, xychart,
  block, packet, kanban, architecture, radar, C4.

## Stage B — Authoring

- Edit mode becomes **side-by-side source + live preview**, stacking
  vertically in narrow contexts (detail panel). Re-render debounced ~250 ms.
- While code is invalid, the **last good render stays visible** with an error
  banner carrying the parse line. The diagram never blanks out mid-edit.
- Mermaid **syntax highlighting** in the source pane via shiki (already in the
  tree through `@blocknote/code-block`), transparent-textarea-over-highlight.
  If shiki's mermaid grammar is unavailable, v1 ships plain mono (verify
  during planning; not a blocker).
- The empty block becomes a **template picker** — a card grid (Flowchart,
  Sequence, Gantt, State, ER, Class, Mindmap, Timeline, Pie, Architecture)
  inserting starter source — instead of ten slash-menu entries. The block
  header shows the detected diagram type instead of generic "MERMAID".
- Undo/redo rides BlockNote history: every change flows through the block's
  `code` prop.

## Stage C — Structural visual editor (flowcharts)

Scoped to `flowchart`/`graph` (the dominant type); other types get Stages A+B.
Block states: **view** (clean render) → **edit** (visual editing + toolbar) →
**code toggle** inside edit flips to the Stage B side-by-side view.

**Round-trip model — surgical text edits, never regeneration.** Source parses
into a line-oriented model; every line is either *understood* (header/
direction, node definition, edge — including chains `A --> B --> C` and `&`
groups — `subgraph`/`end`, comment, blank) or *opaque* (`classDef`, `style`,
`click`, anything not fully recognized). Operations apply minimal edits to only
the lines they touch; opaque lines are preserved byte-for-byte by construction.
Node ids never change — rename edits the label token only — so
`style`/`class`/`click` bindings cannot break. New nodes get generated ids.
Editing a chain line rewrites that one line into expanded simple edges
(formatting-lossy on that line, never semantically lossy).

**Property-tested guarantee:** `parse(serialize(edit(parse(text))))` ≡ the
edited model, and untouched lines are byte-identical.

**Interactions** — an overlay on mermaid's own SVG output (node groups carry
their ids in the DOM). No second rendering engine; no reactflow.

- double-click node → inline rename; click an edge → edit its label or
  delete it (the path is the reliable hit target, not the floating label)
- click selects → mini-toolbar: shape (rect/rounded/diamond/circle/cylinder…),
  delete, add-connected-node
- drag from node → ghost line → drop on node = new edge; drop on empty = new
  node + edge, immediately in rename state
- block toolbar: add node, direction (TD/LR/BT/RL), layout (dagre/ELK), code
  toggle
- every op = text edit → debounced re-render → overlay re-attaches. Full
  re-layout per op is mermaid's nature — honest, not fought.

**Safety valve:** a half-understood line is opaque; its nodes render but are
not visually editable. If nothing parses, the diagram still renders and the
toolbar disables with an "edit as code" hint. Visual editing degrades;
rendering never does.

## Errors & testing

- Render errors are typed values; parse line extracted from mermaid's message.
- **Unit** (vitest, mermaid mocked at the module boundary — jsdom cannot lay
  out SVG): theme builder, flowchart model round-trip properties, every
  structural op on fixtures, chain splitting, opaque preservation, error-line
  extraction. The model layer needs no mermaid at all.
- **e2e** (Playwright, real Chromium): demo-vault gains a `Diagrams` doc
  (flowchart + sequence + gantt) — a test change per repo convention. Specs:
  render-in-doc, concept rendering, lightbox zoom, dblclick-rename
  round-tripping into the code view, add-edge.
- Coverage ratchet only tightens.

## Dependencies

Add `@mermaid-js/layout-elk` (lazy chunk). Possibly an explicit `shiki` entry.
**No** reactflow, no CodeMirror, no zenuml, no new editor stack.

## Non-goals (defend these)

- **No zenuml** — its package embeds a Vue runtime; not shipping that inside a
  React app for one niche diagram type.
- **No AI-panel chat rendering** — chat renders no markdown at all today;
  making it render markdown (and hence diagrams) is a separate feature.
- **No freeform positioning / hand-routed edges** — cannot round-trip to
  mermaid; the structural editor is the chosen shape.
- **No visual editing of non-flowchart types** — they render, template, and
  text-edit (Stages A+B) only.
- **No mermaid-specific dark palette** — dark mode exists (M16.39) and
  diagrams follow it automatically because `theme.ts` reads tokens live;
  nothing beyond that token pass-through is designed here.

## Milestone framing

M29 (M21–M28 are claimed by the convergent-intelligence overhaul), branch
`m29-mermaid` off `main`, commits `feat(mermaid): … (M29.n)`, one stage per
phase-group: A = render core + surfaces + viewer, B = authoring, C =
structural editor. Each stage lands value independently; C is the riskiest and
lands last by design.
