# AFFiNE editor, blocks, data-view and edgeless - reference audit 2026-10-24

> **Scope:** slice AFN2. BlockSuite store/std/ext-loader, affine blocks/inlines/widgets/fragments/data-view/gfx and the frontend editor composition, judged against Cerebro's BlockNote carriers (CV-24), page-title projection (M85–M86), views, scene core (CV-45/CV-55) and M93–M99.
> **Read:** about 85 AFFiNE files, about 40 Cerebro files and 12 M93–M99 docs. Nothing was built, run or modified.
> **Path prefixes:** `BS/` = `docs/examples/AFFiNE-canary/blocksuite/`, `FE/` = `docs/examples/AFFiNE-canary/packages/frontend/`. Cerebro paths are repo-relative (`src/`, `shared/`).
> **Licence:** every AFFiNE path read is MIT (`docs/examples/AFFiNE-canary/LICENSE`, `LICENSE-MIT`). The EE-licensed `packages/backend/**` and `packages/common/native/**` were not opened. No verdict here ports code. MIT would allow a port with notice, but BlockSuite is built on Lit, Yjs and its own DI container, so the ideas have to be re-implemented. The `affine_preview` Rust crate is external and its licence was not checked.
> **Basis:** [read] = code read · [names] = inferred from file or directory names · [docs] = README or docs. "Cerebro has none" claims come from grep and say so.

## Top findings

1. **Pointer fences must round-trip verbatim (AFN2-01).**
   - AFFiNE keeps block props it does not know about, by construction: they live in a Yjs map, and `syncBlockProps` only fills in missing defaults.
   - Cerebro already does this in three places: the whiteboard and sheet fences, and the JSON Canvas codec (`FileFacts`).
   - It does not do it for `cerebro-database`, which is rebuilt from two parsed props on every save. A key or YAML comment that someone adds gets dropped, `lossyImportCause` reports `dropped`, and the whole page opens read-only. `src/engine/databaseBlock.test.ts:52` feeds exactly that kind of fence to the rename door.
   - Changes: a new carriers slice now, and a rule in M99.8.
2. **AFFiNE shows what happens when Markdown is not the source of truth (AFN2-03/04).**
   - Its Markdown adapters work one block type at a time, in one direction, and several are export-only:
     - The database exports as a flat GFM table, with `toBlockSnapshot: {}` (no import).
     - Synced docs expand on export and never import back.
     - Surface-ref and the query block have no adapter at all.
   - Its UI also offers colours and widths that Markdown drops.
   - Cerebro's CV-24 round-trip rule and its D7 pointer fences are the stronger design. Under M99's SQLite-metadata plus Markdown-body choice, keep both.
3. **In AFFiNE each block is one package, wired in through registries (AFN2-02).**
   - The store half (schema and adapters, no DOM) and the view half (view, keymap, slash items, toolbar) both register through DI. Adapters and menus collect them with `getAll()`.
   - Cerebro lists blocks centrally:
     - `cerebroSchema`
     - the promote/demote chains in `markdown.ts`
     - `slashMenuItems`
     - the CV-24 test fixtures
   - The master roadmap already limits these files to one editor at a time. A `FenceCarrier` table for the six fence blocks gets most of the benefit at low risk.
4. **Reveal uses one identity, is consumed once, and waits for readiness (AFN2-06/07).**
   - One `ReferenceParams` schema serves links, cards, URLs and a one-shot `HighlightSelection`. The anchoring widget waits for the block's `add` event before scrolling, or fits the canvas camera to the element.
   - Block ids only work because Yjs is the source of truth. AFFiNE's own Markdown import mints new nanoids, so M97.1's byte-range-plus-quote locator is right for Cerebro.
   - M97.2 should wait for editor readiness instead of `revealBlock`'s 10-frame poll.
   - Boards can get an exact `board_node` locator, because JSON Canvas node ids are stable in the file.
5. **A new record should land in the view that created it (AFN2-08).** `generateDefaultValues` seeds a new row from single top-level filter conditions. Cerebro's `createTarget` seeds only the band value, so a record created in a filtered view can vanish from it. Belongs in M94.6.
6. **AFFiNE ships its scale features switched off (AFN2-12/18).**
   - The virtual table and the turbo renderer both default to off behind canary-only flags.
   - The whiteboard (edgeless) relies on a 3000px grid index and viewport culling.
   - This confirms M93.7's measure-first approach. M93.6 needs a board workload, because `SceneSvg` draws every item and `pick.ts` scans every item.
7. **Small IME gaps (AFN2-13/14).** AFFiNE turns `【【` into its link trigger, and opens `/` only on a committed `compositionEnd`. Cerebro's menus use single-character BlockNote triggers. Belongs in M94.9's native IME cases.

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Block schema | BS/framework/store/src/model/block/zod.ts | `defineBlockSchema`: flavour, role, parent/children globs, `version`, props factory, `isFlatData` |
| Schema checks | BS/framework/store/src/schema/schema.ts | Parent/child flavour and `@role` matching; a `versions` map nothing reads |
| Store core | BS/framework/store/src/model/store/{crud,utils,store,query}.ts | `addBlock` stamps `sys:version`; default fill; `transact`/`withoutTransact`/`captureSync`; filtered store views |
| Undo | BS/framework/store/src/extension/history/history-extension.ts | `Y.UndoManager` on the block map, local origin only |
| Snapshots | BS/framework/store/src/transformer/{base,transformer}.ts | Snapshot ⇄ blocks, middleware slots; snapshot `version` ignored on import |
| Extension loader | BS/affine/ext-loader/src/{manager,base-provider,view-provider}.ts | Store/View providers per scope (page, edgeless, preview, mobile) with zod-checked options |
| App composition | FE/core/src/blocksuite/manager/view.ts | Fluent `configure().foundation().database().ai(enable)…`, gated by feature flags |
| Feature package | BS/affine/blocks/callout/src/{store,view}.ts | Schema plus adapter in one half; view, keymap, slash and toolbar in the other |
| Markdown adapter | BS/affine/shared/src/adapters/markdown/{markdown,block-adapter,delta-converter}.ts | Per-flavour enter/leave matchers over mdast; inline delta matchers; `<u>` and inline-HTML merge |
| Per-block adapters | BS/affine/blocks/*/src/adapters/{markdown,html,notion-html,plain-text}.ts | One direction each; some export-only |
| Adapter tests | BS/affine/all/src/__tests__/adapters/markdown.unit.spec.ts | Golden tests in one direction each, including currency and HTML → code cases |
| Database block | BS/affine/model/src/blocks/database/*; BS/affine/blocks/database/src/data-source.ts | Rows are child blocks, cells a map, views an array on the block |
| Data-view core | BS/affine/data-view/src/core/{data-source,filter,sort,group-by,statistics,logical}/ | `DataSource` contract; filter evaluation; group config; statistics |
| View presets | BS/affine/data-view/src/view-presets/{table,kanban,calendar}/ | Table (plus experimental `pc-virtual`), kanban, calendar |
| Query block | BS/affine/blocks/data-view/src/data-source.ts | Rows are blocks matched across every doc, plus columns stored locally |
| Slash menu | BS/affine/widgets/slash-menu/src/ | Config registry, group sort key, IME-safe trigger |
| Linked doc | BS/affine/widgets/linked-doc/src/{widget,config}.ts | `@` / `[[` / `【【` triggers, menu groups, create-new |
| Toolbar | BS/affine/shared/src/services/toolbar-service/ | Modules per flavour plus `custom:` overlays |
| Deep links | BS/affine/model/src/consts/doc.ts; BS/affine/shared/src/selection/hightlight.ts; BS/affine/widgets/scroll-anchoring/ | Params schema, one-shot highlight, wait-then-reveal |
| Title, outline | BS/affine/fragments/{doc-title,outline}/; FE/core/src/blocksuite/block-suite-editor/lit-adaper.tsx | Title editor; heading outline; page layout |
| Comments, meta | BS/affine/inlines/comment/; BS/affine/shared/src/services/block-meta-service.ts | Comment marks inside the content; per-block authorship |
| Edgeless core | BS/framework/std/src/gfx/{grid,viewport,layer}.ts; BS/affine/blocks/surface/src/renderer/ | Spatial grid, viewport, canvas plus DOM renderer |
| Elements | BS/affine/model/src/elements/{connector,mindmap}/; BS/affine/gfx/connector/ | Connectors (A* routing), mindmap tree |
| Frames, surface-ref | BS/affine/model/src/blocks/{frame,surface-ref}/ | Frame membership and presentation order; canvas region embedded in a doc |
| Previews | BS/affine/blocks/code/src/code-preview-extension.ts; FE/native/src/preview.rs | Previewer per fence language; native mermaid/typst |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AFN2-01 | Unknown data survives a round trip | Block props are `prop:*` keys in a Y.Map. Loading never deletes a key the schema doesn't know; `syncBlockProps` only fills defaults that are missing. Cerebro's own equivalents: JSON Canvas `FileFacts {extra,keyOrder}`; `whiteboard`/`sheet` blocks keep the fence body as `props.source` and write it back | Newer or hand-written data can neither shrink a file nor lock it | BS/framework/store/src/model/store/{crud,utils}.ts [read]; src/engine/scene/model.ts [read]; src/editor/markdown.ts:503,591 [read]; src/editor/markdown.test.ts:186-200 [read] | `cerebro-database`: on load, only `database`/`view` are read (markdown.ts:532, databaseBlock.ts:57); on save the fence is rewritten from them (markdown.ts:629, databaseBlock.ts:88). An extra key or `# comment` makes `lossyImportCause` return 'dropped', so the page opens read-only (NoteBodyEditor.tsx `LOSSY_COPY`). Quoted values are re-quoted on the next save. Tests cover only canonical fence bodies (markdown.test.ts:282-330) | adapt (idea) | NEW:carriers; M99.8; M93.1 |
| AFN2-02 | Each block is one package; registries assemble them | `CalloutStoreExtension` registers the schema and the Markdown matcher (store scope, no DOM). `CalloutViewExtension` registers the view, keymap, `SlashMenuConfigExtension('affine:callout')` and toolbar modules. `MarkdownAdapter` and `SlashMenuExtension` collect them with `provider.getAll()` | A new block touches one package; no central list to edit | BS/affine/blocks/callout/src/{store,view}.ts; BS/affine/shared/src/adapters/markdown/{block-adapter,markdown}.ts; BS/affine/widgets/slash-menu/src/extensions.ts [read] | Central lists: `cerebroSchema` (MarkdownEditor.tsx:145), promote/demote chains (markdown.ts:495-657), `slashMenuItems` (:205), the CV-24 `OURS` fixtures | adapt (MIT; re-implement) | NEW:carriers |
| AFN2-03 | One-direction adapters, some export-only | Database: `toBlockSnapshot: {}`, exports as a flat GFM table (`skipAllChildren`). Synced doc: `toMatch: () => false`, expands one level on export. Surface-ref and the query block: no adapter. Table background colour, width and alignment, and inline colour, are dropped. Underline becomes `<u>`. Callout children are filtered. A footnote reference without a definition becomes `[]`. Reference URLs are empty without `docLinkBaseUrl`. Tests are golden files in one direction each | Acceptable only when Markdown is an export, not the source of truth | BS/affine/blocks/{database,table}/src/adapters/markdown.ts; BS/affine/blocks/embed-doc/src/embed-synced-doc-block/adapters/markdown.ts; BS/affine/shared/src/adapters/markdown/delta-converter.ts; BS/affine/shared/src/adapters/utils/text.ts; BS/affine/all/src/__tests__/adapters/markdown.unit.spec.ts [read]; BS/affine/blocks/{surface-ref,data-view}/src has no `adapters/` [names] | CV-24: every `/` item and toolbar action survives a save or is not offered (`KNOWN_LOSSY` empty, `UNCARRIED_ACTIONS`). A lossy page opens read-only | already-have (stronger) | Confirm M99 CORE-10 |
| AFN2-04 | Database rows live inside the doc | `affine:database {views, title, cells: row→column→value, columns}`; rows are child paragraph/list blocks; role `hub` | One CRDT transaction edits rows and schema together | BS/affine/model/src/blocks/database/{database-model,types}.ts [read] | A pointer fence (D7, databaseBlock.ts header): rows are files and views live in the Type doc | already-have | Confirm M99.4–M99.6 |
| AFN2-05 | Schema versions stamped but never migrated | `addBlock` stamps `sys:version = schema.version` (crud.ts:84-85). Import ignores the snapshot's `version` and re-stamps it through `_insertBlockTree → addBlock`. Grep finds nothing that reads `Schema.versions`. The schema evolves by adding props with defaults; inline specs use zod `.catch(undefined)` | Cheap, but the stamp claims an upgrade that never ran | BS/framework/store/src/{model/store/crud.ts,transformer/transformer.ts,transformer/base.ts,schema/schema.ts}; BS/affine/inlines/preset/src/inline-spec.ts [read] | Shared artifacts are versioned and pinned by digest (CV-04); fences carry no version; M99.8 proposes a versioned sheet-header codec | avoid (stamp alone); adapt (version only with readers) | Amend M99.8 |
| AFN2-06 | Deep-link params feed a one-shot highlight | `ReferenceParams {mode, blockIds, elementIds, databaseId, databaseRowId, xywh, commentId}` is shared by inline refs, cards and URLs. Scroll-anchoring consumes the `HighlightSelection` with `selection.clear(['highlight'])`, waits for a `blockUpdated` 'add' event if the block isn't rendered yet, fits the camera with `getFitToScreenData` on the canvas, and clears on pointerdown | One identity and one reveal path; robust to lazy rendering | BS/affine/model/src/consts/doc.ts:38; BS/affine/shared/src/selection/hightlight.ts; BS/affine/widgets/scroll-anchoring/src/scroll-anchoring.ts [read] | `SourceLocator` kinds body/property (src/engine/sourceLocation.ts; shared/knowledge/source-location.v1.json). `revealBlock` polls for 10 animation frames (src/editor/sectionLinks.ts:159). Boards are unsupported in M97 v1 | adapt (idea) | Amend M97.2; NEW:M97 `board_node` |
| AFN2-07 | Block ids anchor everything | References, comments (`comment-<id>` text attributes plus a block-level `comments` prop), footnotes and highlights all key off nanoid block ids. Markdown import mints new ids (`nanoid()` in `MarkdownAdapter`) | Exact only while Yjs is the source of truth | BS/affine/shared/src/adapters/markdown/markdown.ts; BS/affine/inlines/comment/src/utils.ts [read] | Anchors are text quotes: comments (src/engine/commentAnchor.ts) and the locator's range + quote + prefix/suffix | already-have | Confirm M97.1, M99.3 |
| AFN2-08 | A new row satisfies the view's filter | `generateDefaultValues(filter)`: each property with exactly one top-level condition gets that filter function's `defaultValue(args)` | The created record stays where it was created | BS/affine/data-view/src/core/filter/generate-default-values.ts [read] | `createTarget` seeds only the band value (src/engine/createRecord.ts:18-60). Grep finds no filter-based seeding and no "hidden by this view" notice | adapt (idea) | M94.6 |
| AFN2-09 | Filter, sort, group and statistics engine | `FilterGroup{op,conditions}`; filter functions matched by logical type. `evalFilter` returns true for an unknown function, an invalid argument or a throw. `GroupByConfig.addToGroup/removeFromGroup`. Statistics are typed by data type; `percent-*` returns '' on an empty column | Generic over property types | BS/affine/data-view/src/core/{filter/eval.ts,group-by/types.ts,statistics/any.ts,logical/} [read] | Half-built rules are skipped (viewFilters.ts:505); `viewCheck` names `unknown_field`/`unknown_option`/`op_does_not_fit`; filter families in field-kinds.v1.json; aggregate.ts; `movedBandValue` refusal (BoardView.tsx) | already-have; avoid fail-open | Confirm M94.6 |
| AFN2-10 | Manual order lives in the view | `Sort.manuallySort: string[]`, plus `GroupProperty.manuallyCardSort` per group. Record files are not touched | Drag to rank without writing to records | BS/affine/data-view/src/core/{sort,group-by}/types.ts [read] | None, by decision: "no per-card index… a schema decision" (src/views/BoardView.tsx:440-457) | watch (owner) | NEW:views |
| AFN2-11 | Converting a property's kind | Multi-select → select keeps the first value; number → progress uses `clamp(v ?? 0, 0, 100)`, inventing a 0; select → multi-select wraps the value | Fast | BS/affine/data-view/src/property-presets/converts.ts [read] | `castRules.ts`: S/C/N table, dry run, convert into a new property, never empties a value | already-have; avoid invented zero | none |
| AFN2-12 | Virtual table ships switched off | `VirtualTableViewUILogic` runs only if `enable_table_virtual_scroll` is on; `defaultState:false`, configurable only on canary. Grep of `pc-virtual` finds 2 aria-labels and 1 role | The accessible DOM table stays the default until proven | BS/affine/data-view/src/view-presets/table/renderer.ts:14; FE/core/src/modules/feature-flag/constant.ts:241 [read] | REL-08: keep find, keyboard and screen-reader behaviour; paging fallback | already-have (plan) | Confirm M93.7 |
| AFN2-13 | Slash registry with an IME-safe trigger | Items `{name, group:'0_Basic@9', searchAlias, when(ctx), action, subMenu, tooltip}`, merged across configs and sorted by group index, name, item index. The menu opens on `compositionEnd` only if `data === '/'`; `beforeInput` skips `isComposing` | Blocks contribute their own items; IME input can't misfire the menu | BS/affine/widgets/slash-menu/src/{types,utils,widget}.ts; BS/affine/blocks/callout/src/configs/slash-menu.ts [read] | BlockNote items plus `ours` (MarkdownEditor.tsx:205); BlockNote owns trigger timing | adapt (with 02); test IME | NEW:carriers; M94.9 |
| AFN2-14 | CJK aliases for the link trigger | `triggerKeys ['@','[[','【【']`; `convertTriggerKey` rewrites the typed alias to the main trigger, then opens the menu; `ignoreBlockTypes ['affine:code']` | Full-width IME users can reach the picker | BS/affine/widgets/linked-doc/src/widget.ts:160-227 [read] | One `triggerCharacter` per menu: '@', '[', '/' (MarkdownEditor.tsx:1751,1772,1813) | adapt (idea) | M94.9 |
| AFN2-15 | Toolbar modules and overlays | Modules keyed by flavour; `custom:<flavour>` overlays add actions. Each action: `{id, score, placement, when, active, disabled, run/content/generate}` | The app extends core blocks without editing them | BS/affine/shared/src/services/toolbar-service/{action,registry}.ts [read] | `SelectionToolbar` items and the `UNCARRIED_ACTIONS` classification | watch | none |
| AFN2-16 | Title, outline and page layout | The title is the root's `title` Text, edited in its own rich-text that shares the doc's `undoManager`. Enter splits at the caret into a new first paragraph; formatting is off; the title is copied into workspace meta. Page layout: icon → title → properties → editor → blank click area → StarterBar → backlinks. Outline: h1–h6 per page-visible note | Title undo joins body undo | BS/affine/fragments/doc-title/src/doc-title.ts; FE/core/src/blocksuite/block-suite-editor/lit-adaper.tsx:256-296; BS/affine/fragments/outline/src/utils/query.ts [read] | The first H1 is projected as the title in the same editor, with the same undo and no second title store (src/editor/pageTitleProjection.ts). Enter goes to `enterPageBody` without splitting. Metadata portal; blank-page bar (src/pages/DocPage.tsx:129); backlinks (src/detail/DocSidePanel.tsx, grep); DocOutline lists H1–H3 | already-have; watch Enter-split | M94.3 |
| AFN2-17 | Anchors, authorship and citations stored in the content | Comment ids are text attributes. `BlockMetaService` writes created/updated by/at (30s throttle, behind a flag, outside undo) and fills a missing `createdBy` with whoever is updating now. Footnote definitions are URL-encoded JSON | One store for everything | BS/affine/inlines/comment/src/utils.ts; BS/affine/shared/src/services/block-meta-service.ts; BS/affine/inlines/footnote/src/adapters/markdown/inline-delta.ts [read] | Comments in the `.comments/` sidecar (CV-31); attribution recorded, never inferred (CV-35); readable `[^id]:` lines plus frontmatter sources (src/editor/citations.ts) | avoid | Confirm CV-31/35 |
| AFN2-18 | Whiteboard (edgeless) scale stack | `GridManager` buckets elements into 3000px cells for bound queries. CanvasRenderer skips elements outside the viewport, stacks canvases between DOM layers, coalesces refreshes per animation frame and caps DPR. The turbo renderer paints a bitmap in a worker (flag off) | Cost follows visible items, not total items | BS/framework/std/src/gfx/grid.ts; BS/affine/blocks/surface/src/renderer/canvas-renderer.ts; BS/affine/gfx/turbo-renderer/src/turbo-renderer.ts; FE/core/src/modules/feature-flag/constant.ts:215 [read] | `SceneSvg` draws every item; `pick.ts` checks `intersects` against every item; only agent reads are capped | watch | M93.6 → M93.7 |
| AFN2-19 | Connector and mindmap model | Endpoint `{id?, position?}`: bound to an element with a normalized anchor, or free. Modes: straight, orthogonal (A*), curve; labels. A mindmap keeps its tree in `children: Y.Map<NodeDetail>` and computes the layout. `@local` props are never saved | Rich diagramming | BS/affine/model/src/elements/{connector/connector.ts,mindmap/mindmap.ts}; BS/affine/gfx/connector/src/connector-manager.ts; BS/framework/std/src/gfx/model/surface/decorators/local.ts [read] | JSON Canvas edges join node sides (src/engine/scene/ports.ts); derived `z` is never saved (model.ts) | avoid format change; watch display-only routing | NEW:whiteboard (optional) |
| AFN2-20 | Canvas region shown in a doc | `affine:surface-ref {reference, refFlavour, caption}` renders one frame or group. Pasted into another doc, it becomes an embed-linked-doc with `params.blockIds`. No Markdown adapter | Board context inside prose | BS/affine/model/src/blocks/surface-ref/surface-ref-model.ts; BS/affine/shared/src/adapters/middlewares/surface-ref-to-embed.ts [read] | `cerebro-whiteboard {board, height}` embeds the whole board (src/engine/whiteboardRef.ts) | adapt: optional `group:` node id | NEW:whiteboard |
| AFN2-21 | Preview chosen by fence language | `CodeBlockPreviewExtension(lang, renderer)`. Model and Markdown stay a plain code fence. Desktop renders mermaid/typst natively in Rust (`affine_preview`) and sanitizes the SVG. HTML preview is posted into an iframe on `https://affine.run` | No risk to the stored format; the renderer can be swapped | BS/affine/blocks/code/src/code-preview-extension.ts; FE/core/src/blocksuite/view-extensions/code-block-preview/{mermaid-preview,iframe-container}.ts; FE/native/src/preview.rs [read] | The mermaid fence becomes a `mermaid` block and back (markdown.ts:497); CV-14 | already-have; avoid remote iframe; watch native render | none |
| AFN2-22 | Math syntax | `$…$` becomes `inlineMath`; `$$` becomes a latex block (remark-math). "Dollar currency" golden tests keep prices and escaped dollars as text | Same syntax as Obsidian and GitHub | BS/affine/inlines/latex/src/adapters/markdown/*.ts; BS/affine/all/src/__tests__/adapters/markdown.unit.spec.ts:5045 [read] | None (grep finds no katex/latex/math in src/editor, src/engine) | watch (owner); test cases are MIT | NEW:editor-blocks |
| AFN2-23 | Transactions and undo | Y.UndoManager tracks local changes only. `transact` catches errors and only logs them, so operations before the throw stay committed. `withoutTransact` skips history; `captureSync` starts a new undo group | Fine-grained undo | BS/framework/store/src/model/store/store.ts:371-424; BS/framework/store/src/extension/history/history-extension.ts [read] | Editor history, plus CV-38 journaled all-or-nothing batches and CV-39 undo; REL-02 typed outcomes | already-have; avoid swallowing errors | Confirm M93.1 |
| AFN2-24 | Carriers without a DOM; insert through the adapter | Store extensions "should be able to run in a none-dom environment". AI output enters through `insertFromMarkdown` → adapter → blocks, which drops what it can't carry without saying so | One carrier everywhere | BS/framework/store/src/extension/store-extension.ts; FE/core/src/blocksuite/utils/markdown-utils.ts:164 [read] | The carrier needs a BlockNote editor and `document` (markdown.ts:169, 1948). `saveAnswerPage` writes the raw answer text with no carrier check (src/agent/artifacts.ts) | adapt (check first; never drop silently) | M95.4; NEW:carriers |

### Key flows

#### AFN2-01: pointer fences keep their bytes

- AFFiNE gets this by construction. `DocCRUD.addBlock` writes each prop as `yBlock.set('prop:'+key, …)`. `syncBlockProps` assigns the given props and fills only the defaults whose key is missing. Nothing deletes a key the schema doesn't know.
- Cerebro today:

```text
load  markdownToBlocksNow → promoteRichBlocks (markdown.ts:532)
        codeBlock[cerebro-database] → parseDatabaseRef(text) → {type:'database', props:{database, view}}
save  blocksToMarkdownNow → demoteRichBlocks (markdown.ts:629) → serializeDatabaseRef({database, view})
open  lossyImportCause(markdown, roundTripped) === 'dropped' → read-only banner (NoteBodyEditor.tsx LOSSY_COPY.dropped)
```

- Contrast inside Cerebro: `sheet` and `whiteboard` keep `props.source` (markdown.ts:503-511, 591-605). Their test "keeps its raw source over two saves" includes an `extra: kept` key (markdown.test.ts:186-200).
- Change:
  1. Store the `database` block's fence body as `{source}`. Display reads `parseDatabaseRef(source)`; saving writes `source` back unchanged.
  2. A picker edit calls `editDatabaseRef(source, patch)`. It uses `parseDocument` and replaces the edited value by its text range, the method `renameDatabasePointers` already uses (databaseBlock.ts:136-175). `serializeDatabaseRef` is used only for an empty, unset fence.
  3. Add test cases for every fence: a `# comment`, an unknown key, a quoted value, a flow map, a CRLF page. Each must load as the block, stay byte-identical over two saves, and get a null `lossyImportCause`.

#### AFN2-02: a `FenceCarrier` table, not a plugin system

```text
AFFiNE  CalloutStoreExtension.setup(ctx) → ctx.register(CalloutBlockSchemaExtension, CalloutBlockMarkdownAdapterExtension)
        BlockMarkdownAdapterExtension(m)  → di.addImpl(BlockMarkdownAdapterMatcherIdentifier(m.flavour), m)
        new MarkdownAdapter(job, provider) → blockMatchers = provider.getAll(...); walker enter/leave runs every m.toMatch(o)
        CalloutViewExtension.setup(ctx)   → BlockViewExtension, keymap, SlashMenuConfigExtension('affine:callout', cfg), toolbar
        new SlashMenuExtension(std)       → mergeSlashMenuConfigs(provider.getAll(SlashMenuConfigIdentifier))
```

Proposed shape for Cerebro:

```ts
interface FenceCarrier {
  language: string; // 'cerebro-database'
  type: string; // BlockNote block type; props hold { source }, written back verbatim
  spec: BlockSpec; // createReactBlockSpec(...)
  claims(source: string): boolean; // false → stays a codeBlock (today's null rule)
  slash?: DefaultReactSuggestionItem[];
  cases: { name: string; markdown: string }[]; // CV-24 cases, hand-edited variants included
}
export const FENCE_CARRIERS = [mermaid, sheet, whiteboard, database, pageCard, subPages];
```

- `cerebroSchema`, the fence branches of promote/demote, `slashMenuItems` and the CV-24 test all read this table.
- Containers (`:::columns`/`ai`/`toggle`/`indent`), chips and media stay hand-written.
- Fewer edits land in the rationed `markdown.ts`/`MarkdownEditor.tsx` seam.

#### AFN2-06: deep link to reveal

```text
ReferenceInfo {pageId, params?: ReferenceParams}        model/src/consts/doc.ts:38-58
→ HighlightSelection(params)                             shared/src/selection/hightlight.ts
→ scroll-anchoring: highlighted$ → selection.clear(['highlight'])   (consumed once)
   page:  getBlock(id) ?? wait store.slots.blockUpdated{type:'add', id} → scrollIntoView({block:'center'})
   canvas: element.xywh ?? wait elementAdded → viewport.getFitToScreenData(bounds, [20,20,100,20])
   pointerdown on host → clear anchor
```

- **M97.2:** replace `revealBlock`'s 10-frame poll with the installed-document readiness that M97.2 already revalidates. Consume each request once. Pointer input ends the highlight; SectionFlash already fades it.
- **Board locator:** `kind: 'board_node' {path, sourceHash, nodeId}`.
  - Same hash and the node present: exact; fit the camera to the node's box.
  - Hash changed but the same id present: relocated.
  - Node gone: changed.
- **Shared artifact:** add `board_node`/`json_canvas` to the kinds and carriers in shared/knowledge/source-location.v1.json, with matching Rust and TS cases.

#### AFN2-08: new records stay in their view

- AFFiNE `generateDefaultValues`: group the top-level conditions by property. A property with exactly one condition gets `filterFn.defaultValue(args)`; a null result is skipped.
- Proposed `filterSeed(view.filters, schema, type)` for Cerebro:
  - Only an `all` group, or an `any` group with exactly one ready rule.
  - Only fields with exactly one ready rule.
  - `equals` seeds its value, and `any_of` seeds its value only when it has exactly one.
  - `is_not_empty`, text operators and range operators seed nothing (inventing a value would break CV-05).
- Apply the seed through `createTarget` after the band seed; a conflicting field gets no seed.
- After the record is created, if `evaluateFilters` is false, show "Created, but this view's filters hide it", with Open.

## Avoid / doesn't transfer

- **Yjs store, sync engine, presence:** the Yjs store, `DocSource` pull/push/subscribe and remote selection (BS/framework/sync/src/doc/source.ts [read]; BS/affine/widgets/remote-selection [names]) assume many writers merging. Cerebro has one writer per file (CV-21) and compares before an agent writes (CV-23).
- **One doc shown as both page and canvas:** `NoteDisplayMode` DocOnly/EdgelessOnly/DocAndEdgeless (BS/affine/fragments/outline/src/utils/query.ts [read]) puts page content inside canvas geometry. Cerebro's files-first version already exists: separate .md and .canvas files, with .md file cards on boards (src/whiteboard/cards/CardContent.tsx).
- **Embedded rows and foreign columns:** embedded database rows, and the query block's columns keyed by other docs' block ids (BS/affine/blocks/data-view/src/data-source.ts [read]), add a second writer for another file's data, keyed by ids that Markdown doesn't keep.
- **Offering what the format can't keep:** effects the carrier drops (colours, widths) and export-only adapters (AFN2-03).
- **Fail-open safety rules:** filters that fail open, invented zeros, authorship back-filled from the current editor, and transactions that swallow errors (AFN2-09/11/17/23). They break CV-05, CV-35 and CV-38.
- **JSON in footnotes:** machine-readable footnote definitions (AFN2-17) are unreadable in every other editor.
- **Remote HTML preview:** the HTML preview runs in an iframe on a remote site (AFN2-21), which conflicts with CV-16 and CV-61.
- **Turbo renderer:** it is experimental, off by default, and needs a worker painter per block type (AFN2-18). Don't build one before a measured board problem.
- **Editable live transclusion:** the synced doc (cycle and depth checks in BS/affine/blocks/embed-doc/src/embed-synced-doc-block/embed-synced-doc-block.ts [read]) puts a second live editor on one file, which breaks CV-52. Only a read-only version fits (owner question 5).
- **Porting modules:** BlockSuite is Lit web components plus Yjs plus its own DI container; Cerebro is React 19 plus BlockNote. Take the ideas, not the code.
- **Version stamps nothing reads:** they suggest a migration that never happened (AFN2-05).

## Implications for M93–M99

**M93**

- Confirm M93.7: AFFiNE keeps windowing switched off (AFN2-12). Measure first, and keep the paging fallback.
- Amend M93.6: add a board workload (cards plus edges; p95 for pan, zoom, select and drag). `SceneSvg` and `pick.ts` grow linearly with item count, and AFFiNE needed grid buckets plus culling (AFN2-18).
- Amend M93.1 (or NEW:carriers): add a regression test. Edit elsewhere on a page with a hand-edited `cerebro-database` fence; the fence bytes stay unchanged and the page stays editable (AFN2-01).
- Confirm REL-02 typed save outcomes, against AFFiNE's error-swallowing `transact` (AFN2-23).

**M94**

- Amend M94.6: seed new records from the view's filters, and show a notice when the new record is hidden by this view (AFN2-08).
- Amend M94.9: add IME cases (AFN2-13/14):
  - `/` committed through composition opens the menu once.
  - `【【` reaches the link picker.
  - Triggers stay inactive inside code.
- Watch M94.3: Enter in the middle of the title (AFFiNE splits it; Cerebro moves to the body). The owner decides; add a test either way (AFN2-16).

**M95**

- Amend M95.4: before `saveAnswerPage` writes, run the carrier round trip on the answer. If it would lose content, name the cause and let the person save as-is (the page opens read-only) or cancel. AFFiNE's equivalent drops the content silently (AFN2-24).

**M97**

- Confirm the M97.1 locator (AFN2-07).
- Amend M97.2: replace the frame poll with the editor readiness signal; consume each reveal once; pointer input ends the highlight (AFN2-06).
- Add M97.2b: a `board_node` locator plus a `json_canvas` carrier, with Rust and TS cases, and a reveal that fits the camera to the node (AFN2-06/20).

**M99**

- Confirm SQLite metadata plus Markdown bodies, and the D7 pointer fences (AFN2-03/04).
- Amend M99.8: inventory the Markdown pointer fences (`cerebro-database`, `-page`, `-whiteboard`, `-sheet`, `-subpages`). Rule: keep the source verbatim and edit by value range. Version a codec only together with an old-to-new reader and a test that a newer unknown version is refused (AFN2-01/05).
- Confirm M99.3: mint no block ids into page bodies (AFN2-07).

**Add: NEW:carriers (proposed M93.12 or M99.8a)**

- Build the `FenceCarrier` table, keep the database fence source verbatim, and add hand-edited variants to the CV-24 cases.
- Later, a carrier check that runs without the editor UI, usable by M95.4 and by agent writes.
- One owner holds `markdown.ts` and `MarkdownEditor.tsx` throughout.

**M96, M98:** no change from this slice.

## Owner questions

1. **Manual order:** allow drag-to-rank stored in the view (record stems, updated on rename through `renameActions`/`fieldRefs`), or keep boards and tables sort-only? (AFN2-10)
2. **Math:** add `$` / `$$` math syntax, with the currency-guard tests? (AFN2-22)
3. **Underline and highlight:** accept a small inline-HTML carrier (`<u>`, `<mark>`) so CV-24 can offer them, or keep them off? (AFN2-03/15)
4. **Block anchors:** write opt-in Obsidian-style `^id` markers into page bodies when a person links to or cites a block, or keep text-quote anchors only? (AFN2-07)
5. **Transclusion:** do you want a read-only live embed of another page's body? An editable one conflicts with CV-52.
