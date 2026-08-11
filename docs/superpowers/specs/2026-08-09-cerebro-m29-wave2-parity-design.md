# M29 Wave 2 — Mermaid Chart Parity: Full-Screen Editor, Full Model, Manual Layout, Whiteboard Views

**Status:** DRAFT — for review before any implementation.
**Prerequisite:** M29.1–M29.23 (branch `m29-mermaid`, all merged into this branch's history).
**Reference product:** mermaid.ai (Mermaid Chart) editor + ClickUp whiteboard views. Screenshots reviewed 2026-08-09.
**Ground truth:** vendored mermaid **v11.16.1** at `docs/examples/mermaid-develop` (main checkout). Every syntax claim below was verified against that source; file:line citations live in the stage plans.

---

## 1. What the reference products have that we don't

| Capability | mermaid.ai | Us today | OSS mermaid support? |
|---|---|---|---|
| Full-screen canvas editor (pan/zoom infinite canvas) | ✅ | ❌ (DiagramPage is a static column) | n/a — app chrome |
| Floating code panel w/ Auto-Update toggle | ✅ | ❌ (side-by-side pane only) | n/a — app chrome |
| ~50 node shapes | ✅ | 8 bracket shapes | ✅ `@{ shape: … }`, 49-entry registry (v11.3+) |
| Node fill/stroke/text-color pickers | ✅ | ❌ | ✅ `style id fill:…,stroke:…,color:…` |
| Icons in nodes | ✅ | ❌ | ✅ `@{ icon: "pack:name", form, pos }` + `registerIconPacks` (v11.3+) |
| Subgraph create/edit from canvas | ✅ | render-only (opaque) | ✅ syntax exists; ops are ours to build |
| Edge arrowheads/thickness/animation | ✅ | 4 arrow forms | ✅ full grammar + `e1@{ animate }` edge ids |
| Layout algorithms (hierarchical/adaptive…) | ✅ | dagre + one ELK toggle | ✅ elk.layered/stress/force/mrtree/sporeOverlap + config.elk.* |
| Auto-layout OFF → drag anywhere | ✅ (`layout: fixed`) | ❌ | ❌ **Mermaid Chart proprietary. Confirmed absent from OSS** — zero fixed-position support in v11.16.1. We must build it. |
| Whiteboard as a view on a list (ClickUp) | ✅ | ❌ | n/a — app feature |
| Record/task cards on the canvas (ClickUp) | ✅ | ❌ | partially — `click` directive + our overlay |
| Themes (redux, neo, handDrawn look) | ✅ | token-derived base theme | ✅ `theme: redux/neo/…`, `look: handDrawn/neo` exist in OSS |

**Non-goals for wave 2** (explicitly out, revisit later): collaborative cursors, comments, version history UI, mermaid.ai's AI actions, image `img:` nodes (CORS/asset story unsolved), collapsible subgraphs (`@{ view: collapsed }` — too new/unstable), swimlanes, kanban-diagram type, per-diagram theme picker UI (we stay token-themed), and the `look: handDrawn` toggle (**cut at review 2026-08-09** — hand-authored `look:` frontmatter still renders; we just don't build UI for it).

---

## 2. Architecture decisions (settled unless review overturns)

### D1. One shared full-screen editor component
`src/mermaid/FullScreenDiagramEditor.tsx` — a full-viewport editor composed of: `CanvasViewport` (pan/zoom host), the structural editor or code mode (latched, same rules as today), the floating `CodeOverlay` panel, and the top `DiagramToolbar`. **Pinned contract (all stages code against this):** props `{ code: string; onChangeCode: (code: string) => void; title?: string; embedded?: boolean; overlay?: React.ReactNode }` — `embedded` means "fill the container you were given, assume no page chrome" (Stage H mounts it inside a view canvas); `overlay` is rendered INSIDE the CanvasViewport plane so hosts (Stage H's record chips) can position against `useCanvasTransform`. Stage D may implement `embedded`/`overlay` as thin pass-throughs, but the props exist from day one. It has exactly three hosts:
- **DiagramPage** (a `.mmd` file) renders it as the page body (sidebar hidden via the `SIDEBARLESS` set — 1-line precedent in `Sidebar.tsx:56`).
- **Block full-screen**: the mermaid block header gains "Open full screen", which mounts it in a full-viewport `Dialog`-layer overlay editing the block's code via the same `onChangeCode` channel. No new Selection kind, no file required.

### D2. `CanvasViewport` is a new dumb primitive
`src/mermaid/CanvasViewport.tsx`: pan (space/middle/background drag), zoom (native non-passive wheel — React onWheel is passive, the lightbox already learned this), zoom controls (out/readout-reset/in, fit-to-content), and a `transform` context consumers read for overlay positioning. The structural editor's host, ghost line, toolbars, and record-chip overlays all render INSIDE the transformed plane so coordinates stay honest. MermaidLightbox stays as-is (read-only viewer); it does NOT migrate to CanvasViewport in this wave.

### D3. The model grows four understood line kinds — the opacity invariant stands
`src/mermaid/flowchart/model.ts` `ParsedLine` gains:
- `{ kind: 'node-meta'; id: string; meta: NodeMeta; }` — a `id@{ … }` line. `NodeMeta` = `{ entries: [string, string][] }` — ALL keys in source order (ordering is a guarantee, not a JS-object accident) — with typed read accessors for the understood keys (shape/icon/form/pos/label). **Unknown keys are preserved verbatim** and re-emitted in original order; a meta line we can't fully own goes opaque exactly like any other line. Single-line YAML flow-mapping quirks (values with `,` or `:` must be quoted; `^`/`"` illegal in bare values) are respected by the emitter. (Stage E's plan is authoritative on the exact field mechanics; other stages import, never redefine.)
- `{ kind: 'style'; id: string; decls: [string,string][] }` — a `style <id> k:v,…` line.
- `{ kind: 'click'; id: string; target: string }` — a `click <id> "…"` line (today opaque). Used for record binding (D8) and URL links.
- `{ kind: 'pos-comment'; positions: Map<string,{x,y}> }` — OUR position store, a mermaid comment: `%% cerebro:pos id1 120,40 id2 300,200`. Mermaid ignores comments; our model owns them. (`classDef`/`class`/`linkStyle` stay opaque this wave — `:::` on a node token also keeps the whole token opaque as today.)

### D4. Shape strategy: brackets for the classic 8, `@{ shape }` for the rest
`setNodeShape(model, id, shape)`: if the target shape is one of the 8 bracket shapes AND the node has no meta line, rewrite brackets (today's behavior). Otherwise ensure/patch a `node-meta` line (`id@{ shape: x }`). The palette exposes **the full 49-entry registry** (resolved at review 2026-08-09 — was curated-30), grouped Basic / Process / Technical / Annotation (categories are OUR editorial grouping — OSS has none; mermaid.ai's grouping is their UI invention too). Full registry list + the alias/validation gotchas (lowercase-only guard, `doublecircle` exception, broken `ellipse`) are in the Stage E plan.

### D5. Colors write `style` lines; theme stays token-derived
Node fill/stroke/text-color pickers emit/patch `style <id> fill:#…,stroke:#…,color:#…` (surgical: only the touched declarations change; unknown declarations on the line are preserved in order). A small fixed swatch palette (12 swatches derived from the app's token ramps + "clear"). No classDef authoring UI this wave.

### D6. Icons: lazy lucide pack
`render.ts`'s `loadMermaid()` additionally calls `registerIconPacks([{ name: 'lucide', loader: () => import('@iconify-json/lucide').then(m => m.icons) }])` (new dep, lazy chunk ~1MB — loads only when mermaid loads). Icon picker writes `id@{ icon: "lucide:name", form: rounded, pos: t|b }`. Unregistered/unknown icons render mermaid's blue "?" box — acceptable, never an error. FontAwesome pack NOT bundled (mermaid.ai uses fa; we standardize on lucide to match the app's icon language).

### D7. Manual layout ("Auto-layout OFF") — built by us, spike-gated
OSS mermaid cannot do fixed positions, so: positions live in the `%% cerebro:pos` comment (D3). When the diagram contains `%% cerebro:layout manual`, the editor post-processes mermaid's render: each node group gets `transform: translate(dx,dy)` from its stored offset, and **edges are re-routed by us** as straight lines with arrowheads between node border anchor points (replacing each edge path's `d`; labels move to the midpoint). Dragging a node in manual mode writes its position (debounced one commit per drag-end). Toggling manual OFF preserves the comment (positions are remembered) but stops applying it. **Stage G opens with a time-boxed feasibility spike** whose exit criteria (listed in the plan) gate the rest of the stage. **Resolved at review 2026-08-09: the appetite is full free-drag** — the spike stays as a technical gate only; if a criterion fails, the implementer stops and reports per the plan's protocol (the nudge-offset fallback is a coordinator decision at that point, not pre-authorized scope).

### D8. Whiteboard = ViewType #10, backed by a `.mmd` file — on Lists (not Collections)
**The user asked for "whiteboard view on any collection." Collections deliberately carry no views** (M10 invariant: a Collection is a container; queries/views live on Lists). Recommended resolution, matching ClickUp's actual model (their whiteboard is a view on a *list*):
- `whiteboard` joins `VIEW_TYPES` (10th kind). Its capability record is `{}` plus one new capability `canvas` gating one new Presentation key: `whiteboard: { file: string | null }` — a vault-relative path to a `.mmd` living in the collection folder, created on first open via the existing `write_text_file` (extension allowlist already covers `.mmd`).
- `WhiteboardView` renders the shared `FullScreenDiagramEditor` (embedded, not sidebarless) bound to that file — the same keyed-autosave discipline DiagramPage uses.
- **Record cards:** an "Add record" toolbar action lists the view's entries; picking one inserts a node labeled with the record title plus an understood `click <id> "<record path>"` binding. Bound nodes render an HTML record-chip overlay (title + status chip via `FieldChip`, positioned over the node's bbox inside the viewport plane); clicking opens the record **in-place** (detail panel), matching M9.3. Records stay source-of-truth; the whiteboard stores only the reference.
- Since every Collection can hold Lists and every List can hold a whiteboard tab, this delivers "whiteboard on any collection" without breaking the M10 invariant. (Rejected alternatives: views on CollectionDefinition — violates M10 and `serializeCollection`'s allowlist; a new `.canvas` file format — needless second format when `.mmd` already round-trips.)
- Docs embedding is already done (mermaid blocks); block "Open full screen" (D1) completes the ClickUp-embed story.

### D9. Layout controls
The toolbar's layout menu grows: direction (TD/LR/BT/RL — exists), engine (Dagre / ELK-layered / ELK-force / ELK-mrtree — via `config.layout` + `config.elk.*` frontmatter, all OSS-supported), and Auto-layout ON/OFF (D7). (The `look: handDrawn` toggle was cut at review 2026-08-09.) "Adaptive vs Hierarchical" in mermaid.ai maps to ELK-layered vs force-family — our menu names the real engines.

### D10. What stays surgical
Every new op obeys the M29.14 invariant: touch exactly the lines you must, ids never change, opaque lines survive byte-for-byte, and every op = one `onChangeCode` = one undo step. New understood kinds ship with byte-identical round-trip proofs like the originals.

---

## 3. Stage map (each has its own plan document)

| Stage | Plan file | Phases | Scope |
|---|---|---|---|
| **D** | `2026-08-09-cerebro-m29d-fullscreen-canvas.md` | M29.24–.28 | CanvasViewport, FullScreenDiagramEditor, floating CodeOverlay, DiagramPage goes canvas + sidebarless, block "Open full screen", DiagramToolbar w/ export actions, e2e |
| **E** | `2026-08-09-cerebro-m29e-shapes-styles.md` | M29.29–.34 | node-meta + style line kinds in the model, full shape registry + palette UI, color pickers, extended edge grammar (full arrow/stroke set) + edge style/animate controls, e2e |
| **F** | `2026-08-09-cerebro-m29f-icons-subgraphs-links.md` | M29.35–.39 | lucide iconify pack + icon picker, subgraph ops (create-from-selection, rename, dissolve, membership) + canvas affordances, click-line kind + URL/record links, insert-shape palette, e2e |
| **G** | `2026-08-09-cerebro-m29g-manual-layout.md` | M29.40–.44 | feasibility spike (gate), pos-comment kind, manual-mode render pipeline (transforms + our edge re-routing), drag-to-place, layout menu integration, e2e |
| **H** | `2026-08-09-cerebro-m29h-whiteboard-view.md` | M29.45–.50 | ViewType `whiteboard` (full compiler-forced touch-list), Presentation.whiteboard + parse/serialize/clone, WhiteboardView on the shared editor, record binding + chip overlays + Add-record, stale-comment/test sweep, e2e |

Order is dependency-true: E and F build on D's editor shell; G builds on E's model extensions; H builds on D (editor) + F (click lines). D→E→F can ship value each on its own; G and H are independent of each other.

## 4. Open questions — ALL RESOLVED at review 2026-08-09

1. **Stage G ambition** — **RESOLVED: full free-drag** (our own edge re-routing) when Auto-layout is OFF. The spike remains as a technical feasibility gate only; a failed criterion means stop-and-report, with the nudge-offset fallback as a coordinator decision, not pre-authorized scope.
2. **Whiteboard home** — **RESOLVED: view tab on Lists** (D8 as written). Collections stay pure containers per M10; every collection gets whiteboards through its Lists, matching ClickUp's model.
3. **Icon pack choice** — **RESOLVED: lucide only** (D6 as written). No FontAwesome pack; mermaid.ai-pasted `fa:` icons render the blue "?" box, which is acceptable.
4. **Shape palette size** — **RESOLVED: all 49.** The palette shows the full registry (grouped Basic / Process / Technical / Annotation), not a curated 30. `ellipse` stays excluded — broken upstream (mermaid#5976).
5. **`look: handDrawn` toggle** — **RESOLVED: cut.** No toggle UI anywhere in the wave; hand-authored `look:` frontmatter still renders (and Stage G's degradation notes for handDrawn-look edges stay valid for that case).

## 5. Verified-fact appendix (what the plans rely on)

- Shape metadata: `@{ … }` parsed via lexer state `shapeData` → YAML (`JSON_SCHEMA`); single-line = YAML *flow mapping* (quote values w/ `,`/`:`); `^` and bare `"` illegal; unknown keys silently ignored by mermaid (safe for round-trip; WE preserve them); shape names must be lowercase (uppercase/underscore → throw), `isValidShape` against a 49-entry registry; `doublecircle` works though undocumented; `ellipse` is broken upstream (#5976).
- Icons: `registerIconPacks([{name, loader}])`, lazy + cached; unregistered pack → blue “?” box, not an error; icon names REQUIRE a `pack:` prefix; keys `icon/form/pos/h/w`; `h` default 48.
- Styles: `style id k:v,…` grammar; text color key is `color`; label-vs-node style split is upstream's `isLabelStyle`; `linkStyle` with out-of-range index THROWS (we avoid emitting linkStyle this wave); classDef comma-escaping `\,`.
- Edges: full arrow surface = `--> --- --o --x <--> o--o x--x` × `normal/thick(=)/dotted(.)` + `~~~` invisible; length via extra dashes (capped 10 upstream); edge ids `A e1@--> B` + `e1@{ animate: true|animation: fast|slow|curve: … }` (v11.10+); mismatched start/end stroke → INVALID type (parse-safe, renders broken).
- Layout: engines dagre (default), elk.layered/stress/force/mrtree/sporeOverlap (via `@mermaid-js/layout-elk`, already registered in our `render.ts`); unregistered layout falls back to dagre with a warn; `config.elk.*` keys exist for placement/cycle strategies. **No fixed positions anywhere in OSS.**
- Themes/look: `theme: redux/neo/…` and `look: classic|handDrawn|neo` are real OSS config; per-diagram via frontmatter.
- View system: `VIEW_TYPES` (9 today) drives everything; adding a kind breaks compilation at `CAPABILITIES`, `LAYOUT_LABEL`, and the `ViewCanvas` switch until described — the registry pattern means tabs/pickers/settings come free. New Presentation keys must be declared in `KEY_NEEDS` and added to `parsePresentation`/`serializePresentation` (allowlist!)/`clonePresentation`.
- Chrome: no full-screen mode exists; `SIDEBARLESS` set is the precedent; autosaving full-viewport pages must stay keyed on their path (M29.23's corruption fix).
