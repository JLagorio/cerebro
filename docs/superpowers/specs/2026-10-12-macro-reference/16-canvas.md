# Macro reference — Canvas, graphics scene and spreadsheet (IronCalc)

**Scope**: Macro's Canvas Next whiteboard, the `@macro-inc/graphics` scene package, and the native spreadsheet with its
IronCalc engine and agent tools. Read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored).
**Paths**: Macro paths (`apps/`, `packages/`, `vendor/`, `crates/`, `services/`, `static_assets/`, Macro `docs/*.md`)
are relative to `docs/examples/macro-main/`. Cerebro paths (`src/`, `src-tauri/`, `shared/`, `e2e/`, `demo-vault/`,
`docs/superpowers/`) are relative to the repo root. Cerebro line numbers are **working-tree** numbers (uncommitted M53
work on `m49-knowledge-integrity`), so HEAD's line numbers differ.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: `packages/graphics` and `packages/spreadsheet` have no LICENSE file and no `license` field, so the root
AGPL-3.0 (`LICENSE.txt`) covers them. `apps/web/LICENSE` reads "All rights reserved" and covers `block-canvas` and
`block-spreadsheet`. Only `vendor/ironcalc` is permissive (MIT OR Apache-2.0, forked at `4deab8f`). Its 59 `MACRO:`
patches carry no header, so their licence is ambiguous. Depend on **upstream** IronCalc, never on Macro's fork.
**Evidence**: stages 1–2 read code and docs. Stage 3 traced code statically and checked npm, crates.io and MDN. Nothing
was built or run. Stage 3 overrides stages 1–2.

---

## 1. What it is

- **Canvas Next** (`apps/web/src/features/block-canvas/canvas-next`, 9,179 LOC, 2,497 of them tests) is a SolidJS
  host over `packages/graphics`. The scene is an immutable, normalized tree with one affine matrix per node, pure
  commands and per-item delta history. A board is saved as one whole-file JSON blob (`{version:2, document}`).
- **Spreadsheet**: a Loro document that stores source text only. A patched IronCalc computes values in web workers.
  Three bounded agent tools sit on top: read, scratch-calculate and atomic edit.
- These are two separate stacks. The graphics core really is framework-free. The spreadsheet depends on the cloud:
  sync-service Durable Objects and a Cloudflare worker. Macro has **no** canvas AI or canvas MCP tools.

## 2. What users get

### Canvas

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Board editing | Tools: V select, R rect, O ellipse, P pencil, T text, H hand, A arrow, L line, E eraser. Space or middle-drag pans. Marquee select; Cmd-click selects deep. Shift constrains to an axis or keeps proportions. Alt resizes from the centre. Option-drag previews a duplicate and can be cancelled. Resizing can pass through zero and flip. Shift snaps rotation to 30°. `]`/`[` send to front/back; Alt+`]`/`[` move forward/backward. Group/ungroup, nudge, duplicate. Ctrl/Meta-wheel zooms on the pointer (rate 0.002, capped at 0.2 per event). Every gesture previews, then commits ONE undo step. Escape, blur or pointercancel discards the preview. | `apps/web/src/features/block-canvas/canvas-next/hotkeys.ts`, `apps/web/src/features/block-canvas/canvas-next/README.md`, `packages/graphics/src/browser/index.ts` |
| Connectors | Straight, elbow and smooth routing. Heads: none, arrow, arrow-filled, circle, circle-small. Each end binds to one of 5 anchors (centre, top, right, bottom, left). Hovering a shape shows 5 screen-sized ports, with a halo on the active port. A centre binding meets the shape's outline. Shift snaps a free end to 45°. Dragging the connector body moves only its free ends. Deleting a target detaches the surviving connectors in the same transaction. Bound connectors paint above both ends. Labels are rich text. | `packages/graphics/src/core/connectors.ts`, `packages/graphics/src/core/shapes/connector-routing.ts`, `apps/web/src/features/block-canvas/canvas-next/views/connector-targets.tsx` |
| Text and labels | Lexical rich text on text shapes and on rect/ellipse/connector labels, with the @mention picker. Double-click or Enter starts editing; Escape or Cmd+Enter commits. A click places an auto-width box; a drag sets the wrap width. Side handles reflow the text; corner handles scale the font. An empty draft disappears without an undo entry. Only the shape being edited mounts Lexical. The editor is drawn under the camera matrix. | `apps/web/src/features/block-canvas/canvas-next/core/text-codec.ts`, `apps/web/src/features/block-canvas/canvas-next/views/text-editing-view.tsx:41-59`, `packages/graphics/src/core/shapes/label.ts` |
| Pencil and eraser | perfect-freehand ink. Mouse strokes simulate pressure; pens use hardware pressure. A tap makes a dot. A stroke holds at most 16,384 samples. Resizing regenerates the ink and keeps the brush width. Hit-testing uses the ink polygon. The eraser removes whole objects along its sweep. | `packages/graphics/src/core/shapes/pencil.ts`, `apps/web/src/features/block-canvas/canvas-next/core/eraser.ts` |
| Media | Image and video shapes with durable references (document id, static-file id, or a safe URL). Added by drop, paste or picker, fitted into 640×480, one undo step per batch. The toolbar button is hidden pending a redesign. | `packages/graphics/src/core/shapes/embedded.ts`, `apps/web/src/features/block-canvas/canvas-next/primitives/create-asset-state.ts` |
| Linked entities | A 340×136 preview card for a doc, task, email, channel, call or chat, created by a workspace drop or a pasted Macro link. md and canvas docs can switch to a live embedded editor (Interact/Done), which saves to its own file under its own permissions. Recursion guard: no self-embed, depth at most 8. Open document opens the doc in a split. | `apps/web/src/features/block-canvas/canvas-next/views/embedded-items.tsx`, `apps/web/src/features/block-canvas/canvas-next/block-embed-adapter.tsx:32`, `apps/web/src/features/block-canvas/canvas-next/context/canvas-ancestry.ts` |
| Inspector, layers, snapping | A floating inspector with sections in a fixed order: Position, Layout, Appearance, Fill, Stroke, Connection, Typography. Mixed values are supported. Scrubbing a number previews from the starting document and commits once on release. The last style used becomes the default for the next shape. Layers panel; align/distribute. Snapping is No/px/Auto and lasts only for the session. Dot grid at 1/4/16/64 px, fading in with zoom. | `apps/web/src/features/block-canvas/canvas-next/components/style-inspector.tsx`, `apps/web/src/features/block-canvas/canvas-next/core/selection-layout.ts`, `packages/graphics/src/core/snapping.ts`, `packages/graphics/src/core/dot-grid.ts` |
| Clipboard and import | Internal fragments use MIME `application/x-macro-graphics`, and each repeat paste offsets another 24 units. IDs are remapped; a reference survives only if its target was copied too. Text/HTML becomes a text shape, images upload, and Macro links become cards. Excalidraw import is one-way: diamonds become rects, images and frames are dropped, and flat groupIds are rebuilt as nested groups. | `apps/web/src/features/block-canvas/canvas-next/clipboard.ts`, `packages/graphics/src/core/fragments.ts`, `apps/web/src/features/block-canvas/canvas-next/core/excalidraw.ts` |
| Open and save | Viewing never migrates a file; the first edit writes v2. Unknown versions fail closed. Unsupported legacy content offers "Open in legacy editor". Autosave is debounced 500 ms. A failed save keeps the edits dirty, and save state is **not** shown. Pending saves flush on pagehide/beforeunload. The camera is saved per user; share links carry x/y/s. There is **no export**. | `apps/web/src/features/block-canvas/component/CanvasDocument.tsx`, `apps/web/src/features/block-canvas/canvas-next/canvas-next-document.tsx`, `apps/web/src/features/block-canvas/queries/canvas-document.ts`, `apps/web/src/features/block-canvas/canvas-next/README.md:103` |

### Spreadsheet

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Grid | Up to 100,000 rows × 16,384 cols and 300 sheets. New sheets start at 200×26. At most 10,000 chars per cell. Excel formulas, array spills, autocomplete with argument hints, point-select of ranges while typing. Virtualized DOM grid. Sheet tabs add, rename, duplicate, move and delete, all undoable. Inserting or deleting rows/cols rewrites references and works only online. Fill handle, Cmd+D/Cmd+R. Sorting translates formulas through IronCalc. | `apps/web/src/features/block-spreadsheet/README.md`, `apps/web/src/features/block-spreadsheet/components/SpreadsheetGrid.tsx`, `apps/web/src/features/block-spreadsheet/core/formula-completion.ts` |
| MVP caps | 10,000 chars per cell, 1 MB plain paste, 4 MB internal clipboard. Fill repeats values (no series). Filters and spill growth are deferred. | `apps/web/src/features/block-spreadsheet/README.md:293-338` |
| Formatting and rules | Cell styles and number formats. Conditional formats evaluated by IronCalc. List/number/date validation: a stop alert rejects the entry, warning and info alerts accept it, Alt+Down opens the dropdown, one rule per cell. Notes; comment threads anchored to ranges. | `packages/spreadsheet/src/sheet-rules.ts`, `packages/spreadsheet/src/conditional-formatting.ts`, `packages/spreadsheet/src/data-validation.ts` |
| XLSX/CSV | Streaming SAX reader and SpreadsheetML writer covering formulas, styles, merges, freezes, charts, images, SmartArt, EMF/WMF and pivots. Handles 50 MB / 2M cells. The import preview shows warnings. Cells commit in batches of 5,000 and the import is one undo step. CSV import; values-only CSV export. | `apps/web/src/features/block-spreadsheet/core/xlsx-reader.ts`, `apps/web/src/features/block-spreadsheet/core/xlsx-writer.ts` |
| Analysis | Goal Seek works on a copy, so Cancel leaves cells untouched. Charts built from a selection (column, bar, line, area, pie, scatter, radar, bubble, stock, contour) follow later edits. Find/replace and whitespace trimming. | `packages/spreadsheet/src/goal-seek.ts`, `apps/web/src/features/block-spreadsheet/core/chart-builder.ts` |
| Cell mentions | Inline user, doc and date pills (`<m-…-mention>{json}</m-…>`). A date pill calculates as a date. Formula cells are never parsed for mentions. | `packages/spreadsheet/src/cell-mentions.ts` |
| Collaboration | Live Loro sync, presence throttled to 10 updates/s, offline WAL. Undo refuses to overwrite a collaborator's later change and says why. | `apps/web/src/features/block-spreadsheet/queries/spreadsheet-session.ts`, `apps/web/src/features/block-spreadsheet/core/spreadsheet-history.ts` |
| Ask Macro and agent tools | The chat mention carries `{sheetId, sheetName, range}`. ReadSpreadsheet: at most 500 cells / 100 KB / 20 ranges, plus a revision. CalculateSpreadsheet: at most 20 scratch formulas with what-if overrides; results are scalar, INDIRECT is rejected, ROW() evaluates at A1; it never writes. EditSpreadsheet: at most 25 ops / 2,000 cells, with `expectedRevision` (409 when stale). The tool text says cell text is data, to reread after a stale revision, and to read the affected ranges after an edit. | `packages/spreadsheet/src/ai-workbook.ts:64-70,266-267`, `packages/spreadsheet/README.md:30-34`, `apps/web/src/features/block-spreadsheet/core/chat-context.ts`, `apps/docs/AI/mcp/tools/edit-spreadsheet.mdx` |

## 3. How it's built

**Canvas** has four layers:
- `core`: pure scene, editor, commands and history, with no DOM.
- `browser`: vanilla input adapters that attach and return a disposer.
- `solid`: renders HTML divs with a CSS translate/scale camera and a `cssMatrix` per item, plus a screen-space SVG
  overlay (`packages/graphics/src/solid/index.tsx:288-420`).
- `loro`: an experimental CRDT backend behind the `GraphicsBackend` port. It is not wired up.

Core imports only `fractional-indexing` and `perfect-freehand`. DOM-freedom is enforced by
`packages/graphics/tsconfig.core.json` (lib ES2022, `types: []`), which `packages/graphics/package.json:15` runs.
`tests/boundary.test.ts` (44 lines) checks import specifiers only.

**Spreadsheet**: the Loro doc lives in a sync-service Durable Object. `packages/spreadsheet` is shared by the Solid
editor and the Cloudflare `ai-editing-worker`. Agents go from a Rust MCP tool to the worker, then to a sync
compare-and-set.

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| Graphics core | `packages/graphics/src/core` | Scene, validation (`freezeDocument`), paint order, hit test, sessions, `GraphicsCommand`, 100-entry delta history, snapping, connectors, fragments | 5,695 (5,452 code, 3% comments) |
| Graphics browser | `packages/graphics/src/browser` | Pointer capture, tools, wheel pan/zoom, connector gestures, DOM text measurer | 731 |
| Graphics Solid | `packages/graphics/src/solid` | `GraphicsSurface`, projection, shape views, `DotGrid`; hosts can override renderers | 1,351 |
| Graphics Loro | `packages/graphics/src/loro` | LoroTree scene, presence; in-memory test transport only | 1,146 |
| Canvas Next host | `apps/web/src/features/block-canvas/canvas-next` | Tools, inspector, Lexical codec, assets, cards and embeds, clipboard, file format, migration, persistence | 9,179 |
| Canvas Next core | `apps/web/src/features/block-canvas/canvas-next/core` | Framework-free file format, load, eraser, layout, Excalidraw import, migration | 1,518 |
| Legacy canvas | `apps/web/src/features/block-canvas/component` (+ `model`, `store`, …) | Flat zod nodes/edges/groups; 40-step snapshot history | 14,851 |
| Spreadsheet model | `packages/spreadsheet/src` | Loro workbook (2,592) plus Loro-free IronCalc adapter and helpers (5,547) | 8,139 |
| Spreadsheet AI | `packages/spreadsheet/src/ai-workbook.ts` + `ai-types.ts` | Bounded read, scratch calc, fork → validate → delta | 785 |
| IronCalc fork | `vendor/ironcalc` | `ironcalc_base` 0.8.3 + patches + committed 2.2 MB wasm (`pkg/`) | 135,037 (+2,171 bindings) |
| Spreadsheet block | `apps/web/src/features/block-spreadsheet` | Solid editor (~12k), framework-free `core/` codecs and charts (~15.2k), workers | 49,454 |
| Worker (adjacent) | `services/ai-editing-worker/src/spreadsheet` | POST /spreadsheet, no LLM; 30 s deadline; commits with `expectedRevision` | 1,506 |
| Rust tools (adjacent) | `crates/documents/src/inbound/toolset/spreadsheet.rs` | Tool structs → `SpreadsheetService` → `editing_worker_client.rs` | 925 |
| Golden seed | `static_assets/spreadsheet-golden.1.bin` | 288-byte Loro snapshot holding only `formatVersion=1` | — |

**Data model**

- **GraphicsDocument** (`packages/graphics/src/core/model.ts`): `{rootId, items: Record<id, surface|group|shape>}`.
  Each spatial node has `placement {parentId, sortKey}` (fractional key, compared by code unit) and
  `transform [a,b,c,d,e,f]`. Shape types: connector, rectangle, ellipse, pencil, text, image, video, document.
  Appearance: `{fill, stroke, strokeWidth?, strokeStyle?, opacity?, cornerRadius?}`. Child lists, world matrices and
  indexes are derived (cached in a WeakMap) and never saved.
- **CanvasFile v2** (`apps/web/src/features/block-canvas/canvas-next/core/document-format.ts`):
  `{version:2, document, legacy?}`, MIME `application/x-macro-canvas`. An unknown version throws (`:21-35`); unknown
  fields in a known version are kept (`:49-50`). Text is a stringified Lexical tree (depth ≤64, ≤10,000 nodes, ≤100k
  chars). **Colours are saved as CSS variables** (`core/defaults.ts:5`, `'var(--color-ink)'`). Macro lists fixing this
  as an open priority (`docs/GRAPHICS_PARITY.md:28`).
- **Linked refs** (`packages/graphics/src/core/shapes/embedded.ts`): `DocumentGeometry {documentId, fileType,
  entityType?, subpath?, display preview|embed}` and `MediaSource {document | static id | safe URL}`.
- **Camera**: Postgres `UserDocumentViewLocation`, stored as `'#x=..&y=..&s=..'` and upserted with a 500 ms debounce
  (`crates/macro_db_client/migrations/0001_baseline.sql`).
- **Spreadsheet doc** (`packages/spreadsheet/src/spreadsheet-schema.ts`): `spreadsheetValues` maps `A1` or
  `sheetId!A1` to source text. There is one root map per style property, and a value equal to the default is removed.
  A sheet registry holds names, order, tombstones and revivals. Each sheet has a metadata JSON
  (`workbook-metadata.ts`: merges, freeze, validations, conditional formats, drawings, pivots). **Calculated values
  are never stored.**
- **Format gate**: `assertSpreadsheetDocument` refuses anything without `formatVersion=1`
  (`packages/spreadsheet/src/ai-workbook.ts:72-75`). New sheets start from the 288-byte golden seed.
- **AI contract** (`packages/spreadsheet/src/ai-types.ts`): each cell is `{address, source, formula?, type, value,
  display, error?, style?}`. An edit takes `{expectedRevision, operations[≤25]}` and returns `{revision, applied,
  changes[], sheets, warnings}`.

**Flows**

1. *Canvas open/save*: `definition.ts` fetches the blob → `CanvasDocument.tsx` samples the flag once → `load-document.ts`
   loads it (v1 through `migrate-legacy.ts`; v2 through `freezeDocument` plus text validation) → `createGraphicsEditor`
   → a gesture previews in the session → `commitDocument` records a delta → `create-document-persistence.ts` (75
   lines) debounces 500 ms, drains serially and calls `simpleSave`. The camera saves separately; pagehide flushes.
2. *Linked entity*: a drop or pasted link → `assets.document()` → `insertShapesCommand` at the front → a preview card,
   or `CanvasBlockEmbed` under the ancestry guard → Open document calls `openWithSplit`.
3. *Human cell edit*: `createSpreadsheetStore` makes one Loro commit per op → `create-calculation.ts` diffs the inputs →
   `calculation.worker.ts` runs an incremental `session.update` → only changed results come back → the grid patches
   its display. The budget is 3 s, scaled up by as much as +60 s for large workbooks. On timeout the worker is
   terminated and the calculation retried.
4. *Agent edit*: MCP tool → access receipt → scoped token → the worker GETs the snapshot and revision →
   `validateSpreadsheetDocument` → 409 if the revision differs → `prepareSpreadsheetEdit` forks, applies ≤25 ops,
   validates, recalculates and exports a delta → POST `/update` with `expectedRevision` → the DO compares, persists and
   broadcasts.
5. *Paste*: `parseFragment` handles the internal MIME; otherwise `importExcalidraw`; otherwise text or files →
   `pasteCommand` with `randomUUID` and an offset of 24·n → one undo step.

## 4. Ideas worth stealing

1. **Source-only sheets**: persist formulas and literals; values are a pure function of them, computed locally. A
   direct fit for files-first. `packages/spreadsheet/src/spreadsheet-schema.ts`.
2. **Three-tool agent contract**: a bounded read with a truncated flag; a scratch calculate that never writes; an
   atomic edit on a fork. The tool text carries prompt-injection and retry guidance.
   `packages/spreadsheet/src/ai-workbook.ts`, `crates/documents/src/inbound/toolset/spreadsheet.rs`.
3. **Strict format gate plus a canonical seed**: an unknown file is refused, never read as an empty sheet. This is
   Cerebro's "unavailable is never empty". `packages/spreadsheet/src/ai-workbook.ts:72-75`,
   `static_assets/spreadsheet-golden.1.bin`.
4. **One authoritative placement per node** (parent + fractional key + local matrix). Everything else is derived and
   never saved, so nothing drifts and reparenting keeps the world pose. `docs/GRAPHICS_SCENE_FOUNDATION.md`,
   `packages/graphics/src/core/scene.ts`.
5. **Preview, then one validated commit; per-item delta history** capped at 100 (`editor.ts:123-124`). Camera,
   selection and hover never enter history or the file. A remote commit cancels local previews (`editor.ts:147-149`).
   `packages/graphics/src/core/editor.ts`, `packages/graphics/src/core/history.ts`.
6. **Pure commands with injected ID factories**; a no-op returns the same reference. One vocabulary can serve the UI
   and agent tools, which Macro never built. `packages/graphics/src/core/commands.ts`.
7. **Versioned file boundary**: unknown versions fail closed, viewing never writes, the first edit writes, and
   unsupported content is never silently rewritten.
   `apps/web/src/features/block-canvas/canvas-next/core/load-document.ts`, `docs/CANVAS_LEGACY_BRIDGE.md`.
8. **Tolerant connector bindings**: a missing target falls back to the stored point instead of rejecting the file, so a
   board edited elsewhere still opens. `packages/graphics/src/core/scene.ts:354-363`,
   `packages/graphics/src/core/connectors.ts:101-109`.
9. **Opaque host text plus a host measurer**: in Cerebro, canvas text can be markdown with no change to the core.
   `packages/graphics/src/core/rich-text.ts`.
10. **The scene stores durable references only**; the host resolves them, and a dead pointer degrades to a
    placeholder. `packages/graphics/src/core/shapes/embedded.ts`.
11. **A pure core enforced by the compiler**: a no-DOM tsconfig in the typecheck. Cerebro's `src/engine` is pure only
    by convention (`runLog.ts:91` uses `window.localStorage`). `packages/graphics/tsconfig.core.json`.
12. **Excel adapters in front of IronCalc**: expand formula-defined names, bound whole-column lookups, read cross-sheet
    `@` through INDEX, rewrite `--x` to `(1*x)`, read results at 15 significant digits.
    `packages/spreadsheet/src/calculation.ts:214-987`.
13. **An xlsx fidelity corpus with a licence manifest**: engine upgrades become reviewable diffs.
    `apps/web/src/features/block-spreadsheet/core/xlsx-fixtures/README.md`,
    `apps/web/src/features/block-spreadsheet/core/xlsx-corpus-suite.ts`.

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Free-form whiteboard (shapes, transforms, groups, layers) | partial | high | Only the mermaid flowchart whiteboard in manual layout (`src/views/WhiteboardView.tsx`, `src/mermaid/flowchart/manualLayout.ts`) |
| Anchored connectors, routing, heads, labels | partial | medium | Mermaid edges. In manual mode they are straight lines with bounding-box anchors (M29G risk ledger) |
| Pencil ink and eraser | absent | medium | — |
| Text boxes and rich labels | partial | medium | Mermaid node labels only |
| Image/video on canvas | absent | medium | Blocked: assetProtocol is off and the CSP allows `img-src 'self' data:` only (`src-tauri/tauri.conf.json:24`, `src/detail/FilesField.tsx:26-30`) |
| Linked cards and embeds | partial | high | Record chips via click bindings (`src/views/RecordChipOverlay.tsx`); no page, file or link cards |
| Inspector, align, snap, dot grid | partial | medium | `NodeStyleMenu` and `ShapePalette` exist for mermaid only |
| Fragment clipboard, Excalidraw import | absent | low | No Excalidraw files in the owner's vaults |
| Versioned load/save, fail closed, reconcile | partial | medium | `src/mermaid/useDiagramFile.ts` has the save pipeline (`:91-115`, SAVE_LABEL `:31`) but no format gate, and live reload was deferred (`:69-73`) |
| Export SVG/PNG | **Cerebro ahead** | medium | `src/mermaid/export.ts:73-246`; Macro has no canvas export |
| Pan/zoom viewport | solid | — | `src/mermaid/CanvasViewport.tsx` (scale 0.1–4); `fit()` looks up the mermaid svg (`:281`, `:370`) |
| `.canvas` files in the vault | absent | low | The scanner sees `.md`/`.mmd` (`src-tauri/src/vault/scan.rs:62-63`); the watcher adds `.yml` (`watcher.rs:79-82`) |
| Native spreadsheet + IronCalc | absent | high | No IronCalc dependency in `src-tauri/Cargo.toml` or `package.json` |
| Formula field kind | absent | — | Deferred by M16 (`docs/superpowers/plans/2026-08-02-cerebro-m16-notion-parity.md:308,314`). M2:16 only anticipated a later "sheet note" |
| Styles, conditional formats, validation, comments | absent | low | Cerebro has no comments system |
| XLSX/CSV import and export | absent | low | 0 `.xlsx`/`.csv` files in the owner's vaults on this Mac |
| Goal Seek, charts from a range | absent | low | Charts work over records only (`src/engine/chart.ts`) |
| Cell mentions | absent | low | Wikilink chips already exist in pages |
| Loro sync, presence, WAL | different-by-design | low | Single user, files-first |
| Agent sheet tools | absent | high | — |
| Agent canvas tools | absent (Macro has none either) | medium | Cerebro can lead here |
| Note-write tools refuse non-note files | **built, uncommitted** | high | PLATFORM-API-1 in the working tree: `note_join`/`note_refusal` (`src-tauri/src/vault/write.rs:245-349`), `appended_body` refuses `.mmd` (`:562`), test `mcp.rs:4583`, mock `src/lib/mockIpc.ts:232-266` over `src-tauri/fixtures/note-targets.json` |
| Compiler-enforced pure core | partial | low | `pnpm typecheck` runs only `tsconfig.json` and `tsconfig.tools.json` (`package.json:13`); no boundary rule in `eslint.config.js` |
| Saved camera per document | absent | low | — |

## 6. Port candidates

CANVAS-1 (refuse non-note targets) is **dropped**: it is already built as PLATFORM-API-1 in the working tree. What
remains is running the gates and committing it under M53.4.

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CANVAS-2 | Scene core: normalized scene, pure commands, delta history | rebuild + adopt-upstream (`perfect-freehand` 1.2.3 MIT, `fractional-indexing` 4.0.0 CC0) | adapt | XL (affine); L (axis-aligned, D14b) | high | `docs/GRAPHICS_SCENE_FOUNDATION.md`, `packages/graphics/src/core/{model,scene,editor,history,commands,connectors}.ts`, `packages/graphics/tsconfig.core.json` | `src/engine/scene/`, `tsconfig.scene.json`, `package.json` (typecheck) | D14 model call |
| CANVAS-3 | Whiteboard file kind and vault plumbing | rebuild | adapt | L | high | `apps/web/src/features/block-canvas/canvas-next/core/{document-format,load-document}.ts`, `…/primitives/create-document-persistence.ts`, `docs/CANVAS_LEGACY_BRIDGE.md` | `src/engine/scene/jsonCanvas.ts`, `src/whiteboard/useCanvasFile.ts`, `src/pages/WhiteboardPage.tsx`, `src-tauri/src/vault/{scan,watcher,write}.rs`, `src-tauri/fixtures/note-targets.json`, `shared/canvas/goldens/`, `.gitattributes` | CANVAS-2, PLATFORM-API-1 commit, FILES-8 |
| CANVAS-4 | Whiteboard editor surface (React, SVG-first) | rebuild | adapt | XL | high | `packages/graphics/src/browser/index.ts`, `packages/graphics/src/solid/index.tsx`, `apps/web/src/features/block-canvas/canvas-next/{hotkeys.ts,README.md,components/style-inspector.tsx,views/text-editing-view.tsx}` | `src/whiteboard/`, `src/mermaid/CanvasViewport.tsx`, `src/hooks/useDragGesture.ts`, `e2e/whiteboard-canvas.spec.ts` | CANVAS-2, CANVAS-3 |
| CANVAS-5 | Linked cards, whiteboard tabs, `cerebro-whiteboard` page block | rebuild | adapt | L | high | `packages/graphics/src/core/shapes/embedded.ts`, `apps/web/src/features/block-canvas/canvas-next/{views/embedded-items.tsx,block-embed-adapter.tsx,context/canvas-ancestry.ts}` | `src/whiteboard/cards/`, `src/views/WhiteboardView.tsx`, `src/editor/{blocks.tsx,markdown.ts}`, `src/whiteboard/ancestry.ts`, `e2e/whiteboard.spec.ts` | CANVAS-4, DOMAIN:editor, DOMAIN:files (asset scheme for images) |
| CANVAS-6a | Mermaid whiteboard → canvas conversion | rebuild | adapt | M | low | `apps/web/src/features/block-canvas/canvas-next/core/migrate-legacy.ts`, `docs/CANVAS_LEGACY_BRIDGE.md` | `src/engine/scene/importMermaid.ts`, `src/mermaid/flowchart/parse.ts` | CANVAS-5 |
| CANVAS-6b | Excalidraw import (deferred) | rebuild | adapt | S–M | low | `apps/web/src/features/block-canvas/canvas-next/core/excalidraw.ts` (+ `.test.ts`) | `src/engine/scene/importExcalidraw.ts`, `src/whiteboard/clipboard.ts` | CANVAS-4 |
| CANVAS-7 | Agent tools `read_canvas` / `edit_canvas` / `create_canvas` | rebuild | inspire | M | medium | `packages/graphics/src/core/{commands,insert,connectors}.ts`, `packages/spreadsheet/src/ai-workbook.ts`, `crates/documents/src/inbound/toolset/spreadsheet.rs` | `src-tauri/src/whiteboard.rs`, `src-tauri/src/mcp.rs`, `src/engine/tools.ts`, `shared/canvas/` | CANVAS-3, DOMAIN:mcp, M17.1 call, D2 |
| CANVAS-8 | `cerebro-sheet` fence + IronCalc engine in Rust | adopt-upstream (`ironcalc_base` 0.8.3) + rebuild | adapt | L | high | `packages/spreadsheet/src/{spreadsheet-schema,calculation,ai-workbook}.ts`, `apps/web/src/features/block-spreadsheet/README.md`, `vendor/ironcalc/README.md` | `src-tauri/src/sheet/`, `src/engine/sheet/fence.ts`, `src/sheet/SheetView.tsx`, `src/editor/{blocks.tsx,markdown.ts}`, `src/knowledge/ConceptBody.tsx`, `shared/sheet/goldens/` | DOMAIN:editor, D12/D13, evaluator spike |
| CANVAS-9 | Agent tools `read_sheet` / `calculate_sheet` / `edit_sheet` | rebuild | mirror | M | high | `packages/spreadsheet/src/{ai-workbook,ai-types,scratch-formula}.ts`, `crates/documents/src/inbound/toolset/spreadsheet.rs`, `apps/docs/AI/mcp/tools/*-spreadsheet.mdx`, `services/ai-editing-worker/src/spreadsheet/runtime.ts` | `src-tauri/src/sheet/ai.rs`, `src-tauri/src/mcp.rs`, `src/engine/tools.ts` | CANVAS-8, DOMAIN:mcp, DOMAIN:agents, D2, M17.1 call |
| CANVAS-10 | Sheet grid editor block | rebuild | adapt | XL (L for a narrow v1) | high | `apps/web/src/features/block-spreadsheet/README.md`, `…/components/SpreadsheetGrid.tsx`, `packages/spreadsheet/src/{grid-selection,cell-copy,workbook-structure,number-display}.ts` | `src/sheet/{SheetGrid,FormulaBar}.tsx`, `src/sheet/{selection,clipboard,formulaComplete}.ts`, `e2e/sheets.spec.ts` | CANVAS-8 |
| CANVAS-11 | XLSX/CSV import and export via upstream `ironcalc` crate | adopt-upstream | — | M | low | `apps/web/src/features/block-spreadsheet/core/{xlsx-reader,xlsx-writer,csv-export}.ts`, `…/core/xlsx-fixtures/README.md` | `src-tauri/src/sheet/xlsx.rs`, `src/sheet/ImportSheetDialog.tsx`, `src-tauri/fixtures/sheets/` | CANVAS-8 |
| CANVAS-12 | Loro CRDT, presence, sync, WAL | skip | — | L (if pursued) | low | `packages/graphics/src/loro`, `packages/graphics/src/core/backend.ts` | — | — |
| CANVAS-13 | Embed Excalidraw/tldraw instead of CANVAS-2/4 | skip | — | M (if pursued) | low | `apps/web/src/features/block-canvas/canvas-next/core/excalidraw.ts` | — | — |

Rules for every candidate:
- Clean room: read Macro for behaviour, write tests from behaviour, never translate code.
- Files store durable colours (presets 1–6 or hex), never `var(`.
- The Rust and TS writers produce byte-identical output, checked by shared byte goldens. Otherwise alternating UI and
  agent writes churn git and trigger false M17.4 conflicts.
- Owner calls before code:
  - D14: whiteboard model and D8 reversal.
  - D12/D13: CSP, macOS floor and engine location.
  - D2: `expect_hash`.
  - M17.1: agent deletes.
  - DATA-4: one formula language or two (`04-data.md`).

**CANVAS-8 (the sheets track starts here; no prior decision is reversed).**
- **Fence**: `cerebro-sheet`, following the `cerebro-database` precedent (`src/engine/databaseBlock.ts:29`). An
  optional YAML header holds a **format-version key** (strict gate, Macro's `formatVersion` rule) plus presentation
  deviations. The body is RFC 4180 CSV of **source** text only. A page's fences form one workbook, so `Budget!B2`
  resolves across blocks.
- **Engine**: runs in Rust over IPC. npm `@ironcalc/wasm` 0.8.3 is used only in the browser mock, unless D12 raises the
  floor and adds `'wasm-unsafe-eval'` to the CSP. Pin both sides to 0.8.3, which shares gitHead `9bed9ec`.
- **Required states and rules**: an `engine-unavailable` state, never an empty grid. Excel adapters live in the host,
  one golden each. Determinism comes from the `mock_time` cargo feature and the clock in `boot.ts`. The settings
  timezone is the single timezone source.
- **ConceptBody**: its fence regex captures word characters only (`src/knowledge/ConceptBody.tsx:243`), so it needs a
  regex change and a renderer before sheets show in Studio and concepts.
- **Wasm test rule**: only `*.ironcalc.test.ts` may load the wasm, like the mermaid rule.
- **Wikilinks**: link extraction has no fence awareness (`src-tauri/src/vault/parse.rs:96-100`). Decide whether
  wikilinks in cells create backlinks.
- **Spike first**: time a capped page on 0.8.3's old evaluator and set the cell cap from the result.

**CANVAS-9 (the highest-value agent surface).**
- **Limits** (Macro's): 500 cells / 100 KB / 20 ranges; 20 scratch formulas with overrides, never writing; 25 ops /
  2,000 cells. Scratch rules: scalar results, INDIRECT refused, ROW() evaluates at A1.
- **Write path**: an edit runs on an in-memory copy, recalculates and validates, then makes ONE page write through
  `note_join` and the governed-note guards. It is the first agent tool that rewrites a page body in place. It returns
  the changed cells and warnings (`#REF!`, `#NAME?`, circular references).
- **Revision**: carry `expect_hash` if D2(c) passes, as the analogue of `expectedRevision`. Otherwise writes are
  last-write-wins and an open page reconciles through M17.4.
- **Deletes**: delete-sheet and clear ops need the M17.1 amendment (`src-tauri/src/mcp.rs:4722-4736`, `no_tool_deletes`).
- **Scopes**: add `read_sheet`/`calculate_sheet` to `read_target` and `edit_sheet` to `write_target`
  (`mcp.rs:1430-1437`, `1556-1559`).

**CANVAS-3 (gates the whole whiteboard track).**
- **One geometry authority**. Choose (b) JSON-Canvas-native axis-aligned, or (c) a native scene file plus a JSON Canvas
  bridge. Never a hybrid that stores geometry twice.
- **JSON Canvas limits** (`spec/1.0.md:22-31,66-86`): four node types (file, text, link, group); edges require
  `fromNode` and `toNode`; ends are none or arrow, and `toEnd` defaults to arrow; boxes are integers.
- **Write door**: `.canvas` gets its own write door, because the note doors now refuse it. Extend
  `note-targets.json`.
- **Persistence**: reuse `useDiagramFile`'s save pipeline, add M17.4 reconcile, and fail closed to a new testid
  (`whiteboard-unavailable` is taken, `WhiteboardView.tsx:180`).
- **Plumbing**: the camera goes in per-path `localStorage`. Add `*.canvas text` to `.gitattributes`.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| `expectedRevision` → 409 | D5: `expected_version` is ledger-only; vault files are last-write-wins | Cell- or node-addressed ops on the current bytes, plus a changed-cells report and M17.4 reconcile. Use `expect_hash` only if roadmap D2(c) passes. |
| Agent edit ops include deletes | M17.1 "agents do not delete"; the catalog test `mcp.rs:4722-4736` | Default ops: add, update, move, set. `delete_nodes`/`delete_edges`/delete-sheet/clear need an owner amendment. |
| `freezeDocument` in TS only, shared by UI and worker | Twin Rust and TS rules are a review-blocking defect | A Rust serde validator for agent tools and a TS reader for the UI, held together by `shared/canvas/goldens` and `shared/sheet/goldens`. Caps live in shared JSON. |
| One TS IronCalc adapter in browser and worker | Agent tools are in-process Rust; the mock mirrors Rust | `ironcalc_base` in Rust; wasm only in the mock; both pinned to 0.8.3; a version-equality test plus goldens. |
| Wasm in the client | Packaged CSP has no `script-src` / `'wasm-unsafe-eval'` (`tauri.conf.json:24`); floor is macOS 10.15 (`:47`); MDN lists the keyword from Safari 16 | Engine in Rust (D13 option i), or a CSP change plus a raised floor (D12). Add a mac-build smoke test that computes one sheet, because dev and e2e set no CSP. |
| Lexical JSON text in a cloud blob | The vault is the source of truth; files are greppable | Markdown text nodes; search indexes the text nodes, not raw JSON. |
| CSS-variable colours in the file | Files hold durable content | Presets 1–6 or hex. Acceptance: no written file contains `var(`. |
| Loro, sync-service, WAL, presence | Local, single user | Skip (CANVAS-12). M17.4 reconcile is the backend seam. |
| Camera in Postgres; share links carry x/y/s | A camera is a lens | Per-path `localStorage` behind try/catch; never in the file or the Selection. |
| Cards resolve by `entityType` | No type special-casing | A status chip only when the schema has a status field. The extension decides `.mmd` and image rendering. A dead pointer shows a placeholder. |
| Save failure stays dirty, with no indicator | Store error invariant plus the SAVE_LABEL trust signal | Show SAVE_LABEL as `src/pages/DiagramPage.tsx` does; human saves catch and toast. |
| Whiteboard is a standalone document type | M29 D8 (whiteboard = view tab on `.mmd`) **and** M29's explicit owner choice against canvas JSON (`2026-08-08-cerebro-m29-mermaid-design.md:39-44`) | **Owner call (D14).** If `.canvas` is accepted, either make it opt-in per tab or rewrite `e2e/whiteboard.spec.ts:69-97` and `src/views/WhiteboardView.test.tsx`. |
| Live embedded canvas editor in a doc | M29.48 refuses whiteboards inside blocks (`src/views/WhiteboardView.tsx:173-189`) | The page block is read-only with Open unless M29.48 is reversed. Allow one live editor per path. |
| Gestures own their own Escape and keys | M46.2 layer stack; `App.tsx:345-354` binds Cmd+[ / Cmd+] | Every gesture goes through `useDragGesture` (its "gesture" layer owns Escape). Single-letter keys are scoped to the board. |
| AGPL / "All rights reserved" code, forked engine | Apache-2.0; M48 refused a GPL dependency | Upstream IronCalc and upstream `functions.json` (MIT, attributed). Macro is a behaviour guide only. |
| Extension lists scattered | — | A shared file-kind table (FILES-8) before `.canvas` lands (`scan.rs:62-63`, `watcher.rs:79-82`, `write.rs:245-253,597`, `mockIpc.ts:182,212-216`). |
| Comments falsified by the move | Retired-workaround rule | Rewrite them in the same change: `src-tauri/src/vault/write.rs:280-283`, `src/views/WhiteboardView.tsx:20-64`, `src/mermaid/useDiagramFile.ts:69-73`, `src/views/GalleryView.tsx:26-33`. |

## 8. Verification notes

- **Dropped, CANVAS-1**: "note-write tools corrupt non-`.md` files" was true at HEAD `fb6822a` (`tool_append` → `read_note`
  → `save_note`, no extension check). It is already closed in the working tree as PLATFORM-API-1. The `.mmd` append is
  now **refused**, not kept. It still needs its gates run and a commit.
- **Refuted, owner accepted the D8 reversal**: no acceptance is on record. Reversing it also reverses M29's explicit
  owner choice against canvas JSON. Roadmap D14 (`docs/superpowers/plans/2026-10-12-macro-port-roadmap.md:23`, an
  untracked draft) is only a recommendation.
- **Refuted, owner's vaults hold `.canvas`/`.csv`/`.xlsx`**: `~/Documents/test` has 46 `.md` and 1 `.mmd`;
  `~/Documents/Personal` has 21 `.md`. Neither has any of those kinds, so the value of interop and XLSX import is
  speculative. CANVAS-6 and CANVAS-11 were dropped to low value.
- **Refuted, v1 scene core is 3–4k LOC (L)**: Macro's core is 5,452 code lines at 3% comments, against Cerebro's ~35%,
  so a like-for-like core is about 9k lines before tests. CANVAS-2 is XL with the affine model and L only when
  axis-aligned.
- **Refuted, Macro rejects dangling bindings**: `scene.ts:354-363` throws only for a self, non-shape or connector
  target. CANVAS-2 now degrades and reports instead.
- **Refuted, image cards from `attachments/`**: blocked by the CSP and assetProtocol; they wait on the files-domain
  asset scheme.
- **Refuted, `.canvas` seeding leaves `whiteboard.spec` unchanged**: 4 e2e tests assert `.mmd`, and
  `WhiteboardView.test.tsx` has 24 `.mmd` references.
- **Refuted, CANVAS-6 converts demo-vault boards**: demo-vault has only `diagrams/pipeline.mmd` (ELK layout, no
  `cerebro:pos`), and `%% cerebro:pos` stores centres only (`src/mermaid/flowchart/types.ts:101-111`). Use fixtures,
  with sizes from a render pass or defaults.
- **Partial, boundary enforcement**: the AST test checks imports only. DOM globals are caught by the no-DOM tsconfig,
  which Cerebro's typecheck would have to run.
- **Partial, Obsidian keeps unknown data**: `canvas.d.ts` allows arbitrary keys, but node types are limited to the
  four in the union. Store Cerebro shapes as an allowed type plus an extension key, and run an Obsidian round-trip
  before shipping.
- **Partial, wasm in WKWebView**: size and threading are fine (2,077,104 B unpacked; no SharedArrayBuffer), but the
  packaged CSP blocks it. Tolaria adds `'wasm-unsafe-eval'` (`tolaria-main/src-tauri/tauri.conf.json:37`).
- **Confirmed with caveat, IronCalc releases**: the crate and npm 0.8.3 share `9bed9ec` (npm 0.8.4 has no matching
  crate). They predate upstream's new evaluator (`vendor/ironcalc/README.md:29-35`: one model 8 min → <2 s).
  `setFixedTime` and `setRandomSeed` are Macro patches (`README.md:80-86`). This Mac has no wasm32 target.
- **Partial, the `ironcalc` xlsx crate**: it exists (MIT OR Apache-2.0, adds `zip` 0.6, `roxmltree` 0.19, `itertools`
  0.12, `thiserror` 1). Upstream tests load→save→reload (`compare.rs:336`). There are no drawings, charts or pivots.
  Fidelity on Cerebro's own fixtures is unmeasured.
- **Partial, `@ironcalc/workbook`**: 0.5.7 pulled in MUI and emotion; 0.8.3 does not. The rejection now rests on the
  lucide-react ^1.17 peer (Cerebro has ^0.525), the i18next peers and the missing licence field.
- **Partial, fences**: the fence is `cerebro-database`, not `database`. ConceptBody renders only mermaid, so sheets in
  Studio are not free.
- **Partial, agent reads**: user runs without shell can use Read/Glob; INTERNAL runs lose those too
  (`src-tauri/src/agent/mod.rs:628-640`). `get_note` cannot read `.canvas`.
- **Partial, formula kind**: the deferral comes from M16, not M2.
- **Unmeasured**: performance of a 200–500 KB block prop (the MermaidBlock precedent is in `src/editor/blocks.tsx:131-135`).
- **Stale Macro docs**: the README and MCP text say volatile functions are disabled; the code enables NOW/TODAY/RAND
  with the viewer's clock (`packages/spreadsheet/src/calculation.ts:101-123`). The canvas README cites an absent
  `large-scene.test.tsx`.
- **Confirmed**: delete-detach in one transaction, 100-entry history, remote commits cancel previews, fail-closed
  load, embed depth ≤8, the AI limits, tldraw's non-production licence, and that Macro has no canvas MCP tools.

## 9. Where to read first

1. `docs/GRAPHICS_SCENE_FOUNDATION.md`
2. `packages/graphics/src/core/model.ts`
3. `packages/graphics/src/core/scene.ts`
4. `packages/graphics/src/core/editor.ts`
5. `packages/graphics/src/core/history.ts`
6. `packages/graphics/src/core/commands.ts`
7. `packages/graphics/src/core/connectors.ts`
8. `packages/graphics/tsconfig.core.json`
9. `apps/web/src/features/block-canvas/canvas-next/README.md`
10. `apps/web/src/features/block-canvas/canvas-next/core/document-format.ts` and `core/load-document.ts`
11. `apps/web/src/features/block-canvas/canvas-next/primitives/create-document-persistence.ts`
12. `docs/GRAPHICS_PARITY.md`
13. `packages/spreadsheet/src/spreadsheet-schema.ts`
14. `packages/spreadsheet/src/ai-workbook.ts` and `packages/spreadsheet/src/ai-types.ts`
15. `packages/spreadsheet/README.md`
16. `crates/documents/src/inbound/toolset/spreadsheet.rs`
17. `apps/web/src/features/block-spreadsheet/README.md`
18. `packages/spreadsheet/src/calculation.ts`
19. `vendor/ironcalc/README.md`
