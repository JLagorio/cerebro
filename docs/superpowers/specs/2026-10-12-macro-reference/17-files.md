# Macro reference — Files and format engines: DOCX/PPTX/PSD/FIG, viewers, drive, uploads

**Scope**: Macro's file domain, read 2026-10-12 from `docs/examples/macro-main/` (vendored, gitignored). Macro paths
are relative to that root; Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: root `LICENSE.txt` is AGPL-3.0 and covers the four `crates/*_engine` (no per-crate licence field).
`apps/web/LICENSE` reads "Copyright 2023 CoParse, Inc. All rights reserved." That covers the wasm wrappers, every
`block-*` UI, drive-view and heic. **No Macro code is reusable.** Use permissive upstreams only: pdfjs-dist
(Apache-2.0, upstream rather than Macro's fork), Tauri, and the `image`, `zip` and `quick-xml` crates. Avoid
libheif-js (LGPL-3.0) and `webp`/libwebp-sys (C).
**Evidence**: stages 1–2 read code. Stage 3 re-read both trees and the tauri 2.11.5, tauri-runtime-wry 2.11.4 and
wry 0.55.1 sources, and ran one live `qlmanage` spike. No packaged app was built, and no Macro code was run.
Stage 3 overrides stages 1–2.

---

## 1. What it is

- Macro's file domain has three layers.
  - Four pure-Rust format engines written from scratch: docx is built on pptx, and psd on fig. They parse files,
    render with tiny-skia, edit through JSON op batches and save losslessly. Each builds natively and as wasm.
  - SolidJS viewers and editors for PDF, PPTX, PSD, FIG, code, image, video and unknown files, plus a Drive view.
  - An AWS pipeline: presigned PUTs, an S3 finalizer, DOCX parts deduplicated by sha, LibreOfficeKit conversion, CDN
    resizing and an SSRF-hardened image proxy.
- For Cerebro, both the engines and the cloud pipeline are skip. The useful parts are the ideas, the simple viewers
  and the read tools for agents.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Drive / Files view | Tabs (My Files / Recent / Shared) or a folder tree. Scope default/all/attachments. Sort by modified/created/viewed. Type facets (database, form, markdown, canvas, spreadsheet, code, image, pdf, docx, video, snippet, skill, other) and tag facets. Multi-select toolbar, breadcrumbs, favorites. Shift opens a new split, Cmd/Ctrl a new tab. Mobile pills: Recent/My Files/Shared/Folders. `c f` creates a folder, `m` moves an item. An unavailable folder resets to the root with a toast. The tree tolerates missing parents and cycles and sorts with a numeric locale compare. | `apps/web/src/features/drive-view/drive-view.tsx`, `.../drive-view/filters/drive-facets.ts`, `.../drive-view/core/folder-tree.ts`, `.../drive-view/drive-host-actions.ts`, `apps/docs/product/folders.mdx` |
| Folder composer | Name, tags and initial files in one step: create the Project, bulk-update tags, then upload with allSettled. On partial failure the draft keeps `createdId` and only the failed files, with the message "Folder created, but some items could not be saved. Retry..." | `apps/web/src/features/drive-view/primitives/folder-composer.ts`, `.../queries/folder-creation.ts`, `.../views/create-folder.tsx` |
| Upload | File picker, folder picker and drag-and-drop ("Drop files here to add them to this location"). Folders are zipped client-side and extracted server-side. Dotfiles are filtered, the cap is 2 GB (`MAX_FILE_BYTE_SIZE`) and HEIC becomes PNG first. A 403 shows the FILE_LIMIT paywall. `DocumentNameTooLongError` carries maxLength. Toasts read "Uploaded X" / "Failed to upload X". | `apps/web/src/lib/core/util/upload.ts`, `apps/web/src/lib/service-clients/service-storage/util/upload.ts`, `.../drive-view/components/drive-file-dropzone.tsx`, `apps/web/src/lib/core/heic/service.ts` |
| PDF viewer | Fork of pdf.js 2.16.52. Find, highlights, anchored and free comments, placeables (text boxes, signatures), defined-term lookup, outline/TOC, page input, print. Edits are saved as JSON "modification data" beside the PDF, never baked into it. A DOCX shows as its converted PDF when the DOCX editor flag is off. Scripting sits behind `ENABLE_SCRIPTING`. | `apps/web/src/features/block-pdf/definition.ts`, `.../PdfViewer/InternalPDFViewer.ts`, `.../util/buildModificationData.ts`, `.../component/DefinitionLookup/index.tsx` |
| PPTX editor | Behind `enablePptxEditor`; when off, the block only offers download. Slide rail, ribbon, format/effects/animation panes, tables, charts, SmartArt, equations, masters, sections, find/replace, Hunspell spellcheck, comments, notes, slideshow and presenter view with morph. PDF export writes one JPEG per page. 80 EditOp variants, atomic batches, and typing coalesces into one undo step. | `apps/web/src/features/block-pptx/views/pptx-editor.tsx`, `crates/pptx_engine/src/edit/ops.rs`, `crates/pptx_engine/README.md` |
| PSD editor | Behind `enablePsdEditor`. Layers, adjustments/curves, pressure brushes, selections, transforms, filters, text layers, masks, PNG/JPEG export. 39 Op variants. An unedited file saves byte for byte, and unedited text shows Photoshop's stored pixels. | `apps/web/src/features/block-psd/views/psd-editor.tsx`, `crates/psd_engine/src/edit/ops.rs`, `crates/psd_engine/README.md` |
| FIG viewer/editor | Behind `enableFigViewer`. Pages, layers, design panel, components/variants, team libraries, variables, prototype mode, dev handoff (CSS and code snippets, PNG/JPG/SVG/PDF export), comments. Fonts come from Google Fonts (cached in Cache Storage) and local fonts (Chromium only). The embedded thumbnail shows while workers decode. 512px tiles render progressively, and moving layers are "lifted". | `apps/web/src/features/block-fig/views/fig-viewer.tsx`, `.../block-fig/queries/font-source.ts`, `apps/web/src/lib/core/fig-engine/thumbnail.ts` |
| Image viewer | png/jpg/jpeg/gif/svg/webp from a blob URL, object-contain, Share and Download. The object URL is revoked on cleanup. | `apps/web/src/features/block-image/component/ImageContent.tsx`, `apps/web/src/features/drive-view/views/ImageDetail.tsx` |
| Video player | Native `<video controls autoplay>` on a presigned URL, behind `ENABLE_VIDEO_BLOCK`. 12 extensions are marked playable (mp4, mkv, webm, avi, mov, wmv, mpg, mpeg, m4v, flv, f4v, 3gp) without any check. Other types toast "Video playback is not supported for this file type". | `apps/web/src/features/block-video/core/video.ts`, `.../component/VideoContent.tsx` |
| Code / text | CodeMirror 6 for about 300 extensions, with lazy language packs, a custom ⌘F panel (replace appears only when editable), autosave, markdown preview, and HTML preview in an iframe with `sandbox=allow-scripts` and `no-referrer`. Read-only mode keeps caret and selection (`EditorState.readOnly`, with `inputmode=none` on touch). | `apps/web/src/features/block-code/util/languageSupport.ts`, `.../component/CodeMirror.tsx`, `.../component/HtmlPreview.tsx` |
| Unknown file + legacy Office | "No preview available" with Share and Download. A freshly uploaded .doc/.ppt/.xls shows "Converting X to a PowerPoint presentation..." and switches to the native block when the upgrade lands. Polling runs every 3 s for up to 3 min, and only for documents under 10 min old. Uploaded csv/xlsx/xlsm open as a read-only workbook. Formula-looking CSV text stays literal. | `apps/web/src/features/block-unknown/legacy-office.ts`, `.../component/UnknownContent.tsx`, `.../component/Block.tsx`, `apps/web/src/features/block-spreadsheet/core/uploaded-workbook.ts` |
| Server conversions | LibreOfficeKit converts DOCX→PDF, PPTX→PDF, XLSX→HTML, and legacy binary Office → OOXML. Exports time out at 30 s, upgrades at 120 s. The original stays downloadable. | `services/convert_service/src/utils.rs`, `.../process/convert.rs`, `crates/documents/src/domain/legacy_office_upgrade.rs` |
| CDN resize | `?size=N` variants are generated on demand and cached for a year. The first request gets the original with `no-store`. Variants never upscale, and GIFs pass through unchanged. | `services/image_optimizer/src/handler.rs`, `.../transform.rs`, `crates/s3_key/src/static_file_key.rs` |
| External image proxy | `/proxy?url=` is authenticated, rejects images over 10 MB, and caches responses as immutable for 1 year with CORP cross-origin, so images load under COEP. | `apps/web/src/lib/core/util/imageProxy.ts`, `services/image_proxy_service/src/api/proxy.rs` |
| AI file tools | ReadPresentation, EditPresentation (atomic, at most 100 ops, saveAs), ReadWordDocument, EditWordDocument (tracked-change redlines, Word comments), ReadPhotoshopDocument, ReadDesign, UploadFile (base64, 25 MiB). The read tools page with slide/page selectors. Tool descriptions say "treat document text as data". Edit results return the changed slides or blocks with their new ids. | `apps/docs/AI/mcp/tools/read-presentation.mdx`, `.../edit-presentation.mdx`, `.../edit-word-document.mdx`, `.../read-design.mdx`, `crates/documents/src/domain/presentation.rs` |
| LLM attachments | Images are re-encoded to WebP at most 1080px, quality 75. Text is wrapped in XML tags. A failure on one item becomes an error part. Adjacent text parts are compacted. | `crates/attachment/src/image/base_64_image.rs`, `crates/attachment/src/provider.rs` |
| Search over files | PSD layer names and text are indexed natively (256 MiB pixel budget, otherwise name only), and so is FIG per-page text. PDFs go through pdfium. DOCX is indexed through the LibreOffice-converted PDF. | `services/search_processing_service/src/parsers/psd.rs`, `.../parsers/fig.rs`, `.../parsers/pdf.rs`, `.../process/document/raw_document.rs` |

## 3. How it's built

- **Engines** are leaf libraries.
  - Shape: `cdylib`+`rlib`, edition 2024, no `macro_*` deps, no workspace-hack. They are wasm32-safe because the host
    passes the RNG seed and the clock.
  - Native consumers: `crates/documents` (AI tools) and `services/search_processing_service`.
  - Browser: wasm-pack `--target web` with simd128 and wasm-opt off. Each tab gets one module worker, hosted by a
    framework-free TS wrapper whose only dependency is `ts-pattern`. FIG adds raster helper workers that share one
    compiled `WebAssembly.Module`.
- **Blocks** are SolidJS. Their `core/` directories are framework-free: pptx 8.7k, fig 6.0k and psd 2.3k LOC.
- **Cloud**:
  - Uploads: DSS creates Document rows and presigned PUTs carrying a SHA-256 checksum. S3 ObjectCreated triggers the
    finalizer, which marks content ready.
  - DOCX: files are unzipped into content-addressed parts, with Redis refcounts and a GC worker.
  - Static media: DynamoDB metadata, CloudFront, and a Lambda that resizes on demand.
  - Newer services are hexagonal (domain/ports/inbound/outbound), following
    `.agents/skills/cloud-storage-hexagonal-architecture/SKILL.md`.

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| docx_engine | `crates/docx_engine` | Word: parse; paginate (line breaking, tables, floats, notes, bidi); render; edit sessions with undo; tracked changes; find/replace; collab; lossless save. API: `wasm::DocxDocument`. | 34.8k |
| pptx_engine | `crates/pptx_engine` | PowerPoint plus the shared Office base. Own ZIP/XML/OPC, DrawingML, 187 preset geometries, EMF/WMF, charts, OMML, SmartArt, font DB with metric substitutes, 80-op EditOp with optional schemars schemas, fidelity scoring. | 93.8k |
| psd_engine | `crates/psd_engine` | Byte-exact split and join, 27 blend modes, 39-op History, 256px collab tiles, describe for AI and search | 40.3k |
| fig_engine | `crates/fig_engine` | Lazy kiwi decode, instance expansion, tile rendering, 46-op edit, export PNG/JPG/SVG/PDF, libraries, prototypes | 53.8k |
| engine wrappers | `apps/web/src/lib/core/{docx,pptx,psd,fig}-engine` | Lazy module worker, id-correlated messages, ImageBitmap transfer, trap replay | 1.3k / 2.9k / 1.8k / 2.8k |
| block-pdf | `apps/web/src/features/block-pdf` | Viewer on the pdf.js fork, with annotations and defined terms | 17.6k |
| block-pptx / -fig / -psd | `apps/web/src/features/block-{pptx,fig,psd}` | SolidJS editors | 50.6k / 39.0k / 15.6k |
| block-image / -video / -unknown | `apps/web/src/features/block-{image,video,unknown}` | Trivial viewers, plus the legacy-Office poll | 274 / 405 / 694 |
| block-code | `apps/web/src/features/block-code` | CodeMirror 6 wrapper | 1.8k |
| drive-view | `apps/web/src/features/drive-view` | Files over the soup query backend and the Project tree | 8.4k |
| convert_service | `services/convert_service` | LibreOfficeKit in a forked child, with timeout, SIGKILL and an SQS worker | 2.0k |
| docx_unzip_handler / sha_cleanup_worker / macro_sha_count_client | `services/docx_unzip_handler`, `services/sha_cleanup_worker`, `crates/macro_sha_count_client` | sha-addressed DOCX parts, Redis refcount, GC that recounts before deleting | 658 / 680 / 410 |
| document_upload_finalizer_handler | `services/document_upload_finalizer_handler` | ObjectCreated to ready; drives the legacy upgrade | 1.3k |
| static_file_service + image_optimizer | `services/static_file_service`, `services/image_optimizer` | DynamoDB metadata, presigned S3, on-demand resize | 2.0k / 550 |
| image_proxy_service | `services/image_proxy_service` | SSRF-hardened fetch with a connect-time private-IP resolver | 1.2k |
| attachment / static_file | `crates/attachment`, `crates/static_file` | Entity to LLM parts (XML tags, WebP), with per-item error parts | 897 / 194 |
| model_file_type | `crates/model_file_type` | Macro-generated table of about 440 FileType rows, plus TS codegen | 889 |
| heic | `apps/web/src/lib/core/heic` | WebCodecs worker pool with a libheif-js fallback | 919 |
| filesystem | `apps/web/src/lib/filesystem` | OPFS part store, File System Access, download helper (MIT-derived) | 1.1k |

Two units are unrelated to files despite their names. `services/user_link_cleanup_handler` is an account-link TTL
cleanup, and `apps/web/src/lib/core/media` holds call camera effects.

**Data model**

| Entity | Storage | Key fields |
| --- | --- | --- |
| Document | Postgres | id, owner, fileType, projectId, contentState (pending/ready/unknown), contentLocation (object_storage/sync_service/docx_bom_parts/converted_pdf) (`crates/macro_db_client/migrations/20260511223000_document_content_lifecycle.sql`) |
| DocumentInstance | Postgres | version id, documentId, whole-file sha; S3 key `{owner}/{doc}/{version}` (`crates/s3_key/src/document_key.rs`) |
| DocumentBom + BomPart | Postgres + S3 + Redis | part sha and path. Bytes at S3 `{sha}`. Redis `sha:{sha}` count and the `bucket:sha-delete` set (`crates/macro_sha_count_client/src/lib.rs`) |
| Project (folder) | Postgres | parentId self-FK with cascade, uploadPending, uploadRequestId (`crates/macro_db_client/migrations/0001_baseline.sql`) |
| Static file metadata | DynamoDB | file_id, owner, content_type, is_uploaded; variants at `file/{id}/size=N` (`services/static_file_service/src/service/dynamodb/model.rs`) |
| Bulk zip upload | DynamoDB + S3 `extract/{request_id}` | status pending→completed/partially_completed/failed (`crates/models_bulk_upload/src/lib.rs`) |
| Engine collab state | Loro maps | docx: paragraphs. pptx: flat part maps with fractional keys. psd: layer LWW plus 256px tiles. fig: nodes and blobs (`crates/docx_engine/src/collab.rs`) |
| OPFS cache | browser | `macro-documents-v0/{documentId}/{path}@{sha}` (`apps/web/src/lib/filesystem/opfs.ts`) |

**Key flows**

1. *Upload*
   1. Picker or drop: filter dotfiles, apply the 2 GB cap, convert HEIC to PNG.
   2. Compute SHA-256 and call `createDocument`.
   3. Presigned PUT with `x-amz-checksum-sha256`. If the PUT fails, the document is deleted.
   4. ObjectCreated: the finalizer sets the document ready and requests a legacy upgrade for doc/ppt/xls.
   5. The client waits for content-ready, then the Drive refetches.
2. *DOCX*
   1. Websocket job, then a PUT to the staging bucket.
   2. The unzip handler enqueues DOCX→PDF and sha256s each part.
   3. It uploads only the shas missing from Redis, inserts BomPart rows and INCRs the counts.
   4. convert_service forks LibreOfficeKit (`writer_pdf_Export`, 30 s).
   5. The finalizer marks the PDF ready.
3. *Legacy upgrade*
   1. The original stays ready.
   2. Convert to `upgraded.{docx,pptx,xlsx}` (120 s).
   3. Apply it as a new version, and the fileType switches.
   4. The client polls, then reopens in the native block.
4. *Part GC*
   1. On release, DECR the count. At ≤0, DEL the count and SADD the sha to the delete set. A re-upload rescues it.
   2. The worker recounts BomPart rows. Above 0 it restores the count; otherwise it deletes the S3 object.
   3. SREM the processed shas.
5. *Resize*
   1. A CloudFront function rewrites `?size=N` to `/file/{id}/size=N`.
   2. On an S3 miss, origin failover reaches the Lambda, which returns the original with `no-store` and fires an async
      self-invoke.
   3. The resize honours EXIF, uses Lanczos3, caps at 4096, keeps the format and passes GIFs through.
   4. On failure, the original is cached at the variant key.
6. *Engine open/edit*
   1. Load the bytes.
   2. Start the worker lazily, never at import, because of a WKWebView `tauri://` deadlock
      (`apps/web/src/lib/core/docx-engine/client.ts`).
   3. RGBA renders become transferable ImageBitmaps.
   4. JSON op batches return dirty regions and undo state.
   5. On a wasm trap, rebuild from the source plus the change log.
7. *Proxy*
   1. Check the scheme.
   2. On every hop, run `assert_not_internal`, following at most 5 redirects manually.
   3. A connect-time resolver filters private IPs.
   4. Accept image/* only, cap the stream at 10 MB, and retry once without the User-Agent.

## 4. Ideas worth stealing (ranked)

1. **Bytes reach the UI through the app's own guard, never as raw disk paths.** Macro serves blob and presigned URLs;
   Cerebro's equivalent is raw IPC or a custom scheme through `resolve_within`.
   `apps/web/src/features/block-image/component/ImageContent.tsx`
2. **Bounded "Converting..." UX that keeps the original readable.** Swap only when the derived artifact lands.
   `apps/web/src/features/block-unknown/legacy-office.ts`, `crates/documents/src/domain/legacy_office_upgrade.rs`
3. **On-demand derived variants at a deterministic key.** Never upscale, honour EXIF, and cache failures to stop retry
   storms. Maps to an app-data thumbnail cache. `services/image_optimizer/src/transform.rs`, `.../handler.rs`
4. **Engine-free previews**: the PNG embedded in `.fig` files, and the PSD JPEG thumbnail resource 1036/1033.
   `apps/web/src/lib/core/fig-engine/thumbnail.ts`, `crates/psd_engine/src/resources.rs`
5. **Agent read tools with selectors, paging and "treat as data"**, plus downscaling images before the LLM, with
   per-item error parts. `apps/docs/AI/mcp/tools/read-presentation.mdx`, `crates/attachment/src/image/base_64_image.rs`
6. **One file-type table for both languages.** Cerebro does this as policy-as-data rather than codegen.
   `crates/model_file_type/src/lib.rs`
7. **Isolate a crash-prone converter**: one child per job, a timeout and a kill. `services/convert_service/src/process/convert.rs`
8. **Lazy workers, wasm compiled once with a fallback for protocols that lack `application/wasm`, and trap replay.**
   Applies to any wasm in a Tauri webview. `apps/web/src/lib/core/docx-engine/client.ts`,
   `apps/web/src/lib/core/fig-engine/compiled-module.ts`
9. **Read-only CodeMirror that keeps caret, selection and copy, plus a sandboxed HTML preview.**
   `apps/web/src/features/block-code/component/CodeMirror.tsx`, `.../HtmlPreview.tsx`
10. **SSRF hardening**: connect-time resolver, redirect cap, stream cap. The guide if Cerebro ever fetches URLs.
    `services/image_proxy_service/src/api/proxy/resolver.rs`
11. **Recount before delete**, for any orphan report. `services/sha_cleanup_worker/src/process.rs`
12. **Lossless edit-in-place, one op vocabulary for UI and agent, and atomic batches.** Only relevant if Office editing
    ever becomes a goal. `crates/pptx_engine/README.md`, `crates/documents/src/domain/presentation.rs`
13. **Fidelity corpus pattern**: a manifest with a licence per file, fetched by script, with `#[ignore]`d tests.
    `crates/pptx_engine/tests/corpus/README.md`, `crates/docx_engine/tests/corpus/manifest.json`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Bytes reach the viewer | absent | high | CSP is `img-src 'self' data:` (`src-tauri/tauri.conf.json:24`) and tauri features are `[]`. Deferred on purpose in M16.13c. |
| Image viewer | absent | high | `src/workspace/FileViewer.tsx` shows only a "Not a text file" / "too large" placeholder. `read.rs:45` checks size before the binary sniff, so a 5 MB photo reports tooLarge. |
| PDF viewer | absent | high | Annotations and defined terms are not needed for v1 |
| Images in pages (paste/drop/upload) | partial (broken) | high | `/image` is embed-by-URL only, and there is no `uploadFile`/`resolveFileUrl`. Media blocks do not round-trip, so the page opens read-only (§8). |
| OS file drop | partial (inert when packaged) | high | The Inbox uses an HTML5 drop that Tauri's default handler swallows (§8) |
| `target=_blank` links | broken when packaged | medium | No `on_new_window` handler. 8 uses in `src/`, including DocViewer and FilesField URL chips. |
| AI file tools | partial | high | The CLI's `Read` covers PDFs and images in user runs inside the vault cwd. Nothing reads docx/pptx/xlsx. |
| Video / audio | absent | medium | Audio pairs with the vtt/srt transcripts already ingested |
| Unknown fallback | partial | medium | Typed placeholders exist, but there is no Open with, Reveal or Save a copy |
| In-file find | absent | medium | WKWebView has no find bar; CodeViewer and DocViewer cannot be searched |
| Code editor (CodeMirror) | different-by-design | medium | Read-only Shiki viewer (M30 decision 6); editing belongs to DOMAIN:coding |
| File-type table | partial | medium | Four TS maps (`fileIcons.ts`, `highlighter.tsx`, `engine/roots.ts`, `lib/ingest.ts`) plus `scan.rs:61-63` in Rust |
| CSV/XLSX table preview | absent | medium | CSV renders as monospace text |
| Resize variants | absent | medium | Becomes an app-data thumbnail cache |
| Engine-free previews | absent | medium | .fig thumbnail, PSD resource 1036/1033 |
| Remote images | absent | medium | The CSP blocks README badges |
| Search over file contents | absent | medium | `search.rs` indexes md/mmd only (DOMAIN:search) |
| Conversions (LibreOffice) | absent | low | Quick Look covers most of this on macOS |
| Drive view | different-by-design | low | RootTree and the Pages tree browse real folders. Destination names are locked (M37.2). |
| sha parts + GC | different-by-design | low | Whole files in `attachments/`; dropping a reference never deletes a file |
| Office/PSD/FIG engines | absent | low | AGPL, and Cerebro is markdown-first |
| Typed per-cause placeholders | already-better | low | Macro has one "No preview available". Keep Cerebro's typed states. |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FILES-1 | Bytes in the webview: custom URI scheme over `resolve_within`, typed probe, raw-IPC bytes | rebuild | adapt | M | high | `apps/web/tauri/src-tauri/tauri.conf.json`, `apps/web/tauri/src-tauri/Cargo.toml`, `apps/web/src/features/block-image/component/ImageContent.tsx` | `src-tauri/src/lib.rs`, `src-tauri/src/roots/tree.rs`, `src-tauri/src/roots/read.rs`, `src-tauri/src/roots_commands.rs`, `src-tauri/tauri.conf.json`, `src/lib/rootsIpc.ts`, `src/lib/ipc.ts`, `src/lib/mockRoots.ts`, `src/lib/mockIpc.ts`, `src/engine/roots.ts` | — |
| FILES-13 | Round-trip-safe media markdown | rebuild | adapt | S–M | high | — (Cerebro bug) | `src/editor/markdown.ts`, `src/editor/markdown.test.ts`, `src/editor/MarkdownEditor.tsx`, `src/editor/NoteBodyEditor.tsx` | coordinate with EDITOR-1 (owns KNOWN_LOSSY) |
| FILES-14 | Drop route: `dragDropEnabled:false` or `onDragDropEvent` paths | rebuild | adapt | S | high | `apps/web/src/features/drive-view/components/drive-file-dropzone.tsx` | `src-tauri/tauri.conf.json`, `src/hooks/useOsFileDrop.ts`, `src/pages/InboxPage.tsx`, `src/detail/FilesField.tsx`, `src/workspace/TabBar.tsx`, `src/components/FileTree.tsx` | — |
| FILES-8 | Shared file-kind table (policy-as-data) | rebuild | adapt | S | medium | `crates/model_file_type/src/lib.rs`, `crates/model_file_type/src/bin/generate_typescript_types.rs`, `apps/web/src/features/block-code/util/languageSupport.ts` | `shared/files/kinds.v1.json` (+ `.sha256`, README), `src-tauri/src/files/kinds.rs`, `src/lib/files/kinds.ts`, `src/workspace/fileIcons.ts`, `src/workspace/highlighter.tsx`, `src/engine/roots.ts`, `src/lib/ingest.ts`, `.prettierignore` | — |
| FILES-2 | Viewer registry: image, audio/video, unknown (Open with / Reveal / Save a copy), DocViewer images, gallery covers, guarded external open | rebuild | adapt | M | high | `apps/web/src/features/block-image/definition.ts`, `apps/web/src/features/block-video/core/video.ts`, `apps/web/src/features/block-unknown/component/UnknownContent.tsx`, `.../component/Block.tsx`, `apps/web/src/features/drive-view/views/ImageDetail.tsx` | `src/workspace/FileViewer.tsx`, `src/workspace/viewers/{registry.ts,ImageViewer.tsx,MediaViewer.tsx,UnknownViewer.tsx}`, `src/workspace/DocViewer.tsx`, `src/views/GalleryView.tsx`, `src/detail/FilesField.tsx`, `src-tauri/src/lib.rs`, `src/engine/roots.ts` | FILES-1, FILES-8 |
| FILES-4 | Images and files in pages: paste, drop, `/image` upload | rebuild | adapt | L | high | `apps/web/src/lib/core/util/upload.ts`, `apps/web/src/lib/service-clients/service-storage/util/upload.ts`, `apps/web/src/features/drive-view/drive-host-actions.ts`, `apps/web/src/lib/core/heic/service.ts` | `src/editor/MarkdownEditor.tsx`, `src/editor/markdown.ts`, `src-tauri/src/vault/write.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/pages/InboxPage.tsx` | FILES-1, FILES-2, FILES-13, FILES-14 |
| FILES-3 | PDF viewer on upstream pdf.js | adopt-upstream | adapt | M | high | `apps/web/src/features/block-pdf/definition.ts`, `.../PdfViewer/InternalPDFViewer.ts`, `.../component/PageNumberInput.tsx`, `.../util/TocUtils.ts` (behaviour only; derive code from upstream pdf.js `web/`) | `package.json`, `src/workspace/viewers/PdfViewer.tsx`, `src/workspace/viewers/pdf/{outline,find}.ts`, `src/workspace/viewers/registry.ts`, `eslint.config.js` | FILES-1, FILES-2, FILES-18 |
| FILES-18 | ⌘F find for CodeViewer and DocViewer (count, next/previous) | rebuild | inspire | S–M | medium | `apps/web/src/features/block-code/component/CodeMirror.tsx`, `apps/web/src/features/block-pdf/PdfViewer/FindController.ts` (behaviour only) | `src/workspace/CodeViewer.tsx`, `src/workspace/DocViewer.tsx`, `src/workspace/find.ts` | — |
| FILES-15 | Quick Look action (unknown viewer, FilesField chips), cfg(macos) | rebuild | inspire | S | medium | `apps/web/src/features/block-unknown/component/UnknownContent.tsx` | `src/workspace/viewers/UnknownViewer.tsx`, `src/detail/FilesField.tsx`, `src-tauri/src/lib.rs` | FILES-2 |
| FILES-5 | Text extraction (DOCX/PPTX/XLSX in Rust; PDF via pdf.js in the webview) feeding Inbox ingest | rebuild | adapt | L | high | `crates/pptx_engine/src/inspect.rs`, `services/search_processing_service/src/parsers/pdf.rs`, `apps/docs/AI/mcp/tools/read-word-document.mdx`, `crates/docx_engine/src/edit.rs` | `src-tauri/src/files/extract.rs`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/lib/ingest.ts`, `src/engine/ingest.ts`, `src/lib/mockIpc.ts`, `shared/files/kinds.v1.json` | FILES-8, FILES-4, FILES-3 (PDF) |
| FILES-6 | `read_document` MCP tool | rebuild | adapt | M | medium | `apps/docs/AI/mcp/tools/read-presentation.mdx`, `.../read-word-document.mdx`, `.../read-spreadsheet.mdx`, `crates/documents/src/domain/presentation.rs`, `crates/attachment/src/image/base_64_image.rs`, `crates/attachment/src/provider.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/files/extract.rs`, `src-tauri/src/ingest/prompt.rs`, `src-tauri/src/agent/mod.rs`, `src/engine/tools.ts`, `src/engine/tools.test.ts` | FILES-5 |
| FILES-7 | Thumbnail cache in app-data | rebuild | adapt | M | medium | `services/image_optimizer/src/transform.rs`, `.../handler.rs`, `apps/web/src/lib/core/fig-engine/thumbnail.ts`, `crates/psd_engine/src/resources.rs` | `src-tauri/src/files/thumbs.rs`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/views/GalleryView.tsx`, `src/detail/FilesField.tsx`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` | FILES-1, FILES-8 |
| FILES-16 | Read-only CSV/TSV table viewer (XLSX via FILES-5) | rebuild | adapt | S–M | medium | `apps/web/src/features/block-unknown/component/Block.tsx`, `apps/web/src/features/block-spreadsheet/core/uploaded-workbook.ts` | `src/workspace/viewers/TableViewer.tsx`, `src/workspace/viewers/registry.ts` | FILES-2 (XLSX: FILES-5) |
| FILES-10 | Remote images: click-to-load, https only, no proxy | rebuild | inspire | M | medium | `services/image_proxy_service/src/api/proxy.rs`, `.../proxy/resolver.rs`, `apps/web/src/lib/core/util/imageProxy.ts` | `src-tauri/tauri.conf.json`, `src/workspace/DocViewer.tsx`, `src/editor/MarkdownEditor.tsx` (custom image block render), `src/lib/remoteImages.ts`, `src/stores/uiStore.ts` | FILES-2, FILES-4 |
| FILES-17 | Orphaned-attachments report (recount, then move to OS Trash; never auto-delete) | rebuild | inspire | S | low | `services/sha_cleanup_worker/src/process.rs` | `src-tauri/src/vault/write.rs`, `src-tauri/src/lib.rs` | FILES-4 |
| FILES-9 | Office previews via a user-installed LibreOffice (optional) | rebuild | inspire | M | low | `services/convert_service/src/utils.rs`, `.../process/convert.rs`, `apps/web/src/features/block-unknown/legacy-office.ts` | `src-tauri/src/files/convert.rs`, `src-tauri/src/lib.rs`, `src/workspace/viewers/OfficeViewer.tsx`, `src/workspace/viewers/registry.ts` | FILES-1, FILES-2, FILES-3, FILES-15 |
| FILES-11 | DOCX/PPTX/PSD/FIG engines and editors | skip | — | XL | low | `crates/pptx_engine/README.md`, `crates/docx_engine/README.md`, `apps/web/src/lib/core/docx-engine/docx.worker.ts` | — | Revisit only if the owner names Office editing as a goal |
| FILES-12 | Cloud storage pipeline + Drive view | skip | — | L | low | `services/docx_unzip_handler/src/service/document/process_document.rs`, `services/sha_cleanup_worker/src/process.rs`, `apps/web/src/features/drive-view/drive-view.tsx` | — | — |

Notes on the other candidates:
- **FILES-2**
  - Unknown kinds get `confirm` under an allowlist; a deny-list misses macOS executable kinds, and cloned repos carry
    no quarantine xattr. The check runs in Rust.
  - Open with `/usr/bin/open` and `open -R`, or tauri-plugin-opener 2.5.5. Version 2.7.1 needs tauri 2.12.
  - Decide playability with `canPlayType` or `onError`, not a static list.
  - Fold in the `target=_blank` fix: the same guarded command opens allowlisted https and mailto links.
- **FILES-3**
  - Print is out of v1. Tauri routes `window.print` to `plugin:webview|print`, which needs the ungranted
    `core:webview:allow-print`, prints the whole webview, and works only on macOS 11+. Use "Open in Preview" instead.
  - Use the legacy build while the macOS floor is 10.15, give the wasm decoders a JS fallback, and load bytes over raw
    IPC.
  - Enforce `*.pdf.test.ts`-only imports with eslint.
- **FILES-4**
  - Settle the link form first, because `rename_note` moves files without rewriting bodies
    (`vault/write.rs:1122-1136`).
  - Reuse an identical attachment by sha2, hashing only candidates with the same stem and size.
  - Convert HEIC with `/usr/bin/sips`.
- **FILES-5**: typed outcomes: text | noTextLayer | encrypted | unsupported | tooLarge | corrupt. Set an
  uncompressed-size cap and turn off XML entity expansion. XLSX dates need the number formats in `styles.xml`. Use
  synthetic fixtures built in-test.
- **FILES-6**
  - Refusals are plain `error_result`. Resolve attachments with `safe_join`, not `scan_vault`.
  - Fence the text with `cerebro-source` (`ingest/prompt.rs`), or bump to taint-v3 on purpose.
  - Only user runs get the tool; internal runs would need it added to `declared_tools`.
  - Images are downscaled to at most 1080px.
- **FILES-7**
  - Use `image` with `default-features=false`, explicit formats and explicit `Limits`. Never upscale, honour EXIF,
    and cache failures as a typed negative.
  - The Quick Look tier (`qlmanage -t`, about 0.2 s per PDF or DOCX) is cfg-gated and probed. Plan a later
    QLThumbnailGenerator path.
- **FILES-10**: the `https:` widening of the CSP applies to every surface at once, so each renderer must gate images.
  Agent-written content never auto-loads.

**FILES-1: bytes in the webview.** This is the commit M16.13c deferred.
- Primary design: `register_asynchronous_uri_scheme_protocol` (tauri `app.rs:2198`), addressed as `(rootId, rel)` and
  served through `roots::tree::resolve_within`, with single-range 206. Follow the MIT/Apache pattern in tauri
  `protocol/asset.rs:88-200`. Not `protocol-asset`, because its scope is not the M30 §4.1 containment guard (§8).
- The vault is resolved as root #0 or from `app_config.last_vault`, never from a frontend argument. Dot paths are
  served the way `read_file_text` serves them, so README images under `.github/` work.
- html, svg and xml are served non-navigable (text/plain or attachment, plus nosniff). The scheme stays out of
  frame-src except for the PDF spike.
- Option: ship images, PDFs and thumbnails first over size-capped raw IPC into blob: URLs, which needs no protocol and
  no connect-src change. Add the scheme later, only for audio and video, which need Range.
- A new typed `probe_file` returns `{size, mime, sniff} | notFound` before the 2 MB text cap. The mock gets a bytes
  lane with the same `..` refusal.
- Kill the comments it falsifies:
  - `FilesField.tsx:25-29`, `GalleryView.tsx:26-33`, `ViewSettingsPanel.tsx:1157`, `DocViewer.tsx:110-112`,
    `engine/roots.ts:51-55`
  - `GalleryView.test.tsx:19-21`; also flip the assertion at `:125`
  - the "no efficient raw-bytes lane" comment at `ipc.ts:246`

**FILES-13: round-trip-safe media markdown.** A live bug that blocks FILES-4.
- BlockNote 0.46.2 exports the alt as `name || caption || 'BlockNote image'`. `isLossyImport` then fires, and the page
  mounts read-only (`NoteBodyEditor.tsx:96-99,226`).
- Fix: keep empty alt and titles, and map audio and file links back to their blocks by extension. The alternative is
  to remove those blocks from the slash menu.
- Acceptance: `![x](../attachments/a.png)` is byte-stable, and `KNOWN_LOSSY` in `markdown.test.ts:654-662` shrinks.

**FILES-14: drop route.** The Inbox drop zone is inert in the packaged app, and internal HTML5 drags (TabBar split,
FileTree move) probably are too.
- Option A: `dragDropEnabled:false`. WebKit then receives every drag, so the HTML5 drop gives File objects, and the
  bytes go over raw IPC.
- Option B: `getCurrentWebview().onDragDropEvent` paths with hit-testing, feeding `import_attachment`.
- Either way, give folder drops a typed refusal and verify the TabBar and FileTree drags in a packaged build. CI
  cannot see this, because `e2e/pipeline.spec.ts:45` dispatches a synthetic Chromium drop.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| Tauri shell with `csp: null` and a static asset scope | Strict CSP; any widening is a separately reasoned commit (M16.13c) | Keep the CSP. Use a custom scheme through `resolve_within`, or raw IPC to blob: URLs. Add the scheme to img-src and media-src only; frame-src only for the PDF spike. |
| sha parts with refcount GC that deletes blobs | The vault is the truth; dropping a reference never deletes (`write.rs:676-678`) | No blob store. sha-equality reuse on import only. The orphan report is read-only and moves files to the OS Trash (FILES-17). |
| Agent edit tools mutate Office files and save new versions | Writes are scope-bounded; proposals return typed applied/queued/rejected | Read-only `read_document` only. A future edit tool must pass `write_target` and return a typed proposal. |
| Remote images auto-load through a proxy | Agent markdown is untrusted (taint); Cerebro makes no network calls of its own apart from git | Click-to-load, https only, no proxy (FILES-10) |
| Legacy upgrade rewrites the stored file and its type | Derived artifacts never go into the vault | Conversions are cached in app-data and the original is untouched (FILES-9) |
| Macro-generated FileType enum with TS codegen | Policy is data: one hashed artifact, loaded by both Rust and TS | `shared/files/kinds.v1.json`. Rust enforces the `open` column; TS reads the same file only to disable UI (FILES-8). |
| One "No preview available" | Absent is never zero; unavailable is never empty | Typed states: no viewer / read failed / tool missing / conversion failed / no text layer / encrypted / password-protected |
| Silently dropping PDF pages that fail (`parsers/pdf.rs` filter_map) | Absent is never zero | Count and name skipped pages |
| Ingested files carry owner provenance | `ingest/source.rs` registers inbox/ as human:owner, and the split is irreversible | Extracted text becomes a SourceSnapshot by `ACTOR_SCANNER`, not an owner assertion. The owner makes the call; it does not block FILES-5. |
| Per-file toasts via allSettled | Human-UI actions never throw; one summary toast (`describeIngest`) | One summary per batch, naming each refusal |
| No mock backend (real services, Miniflare) | The mock mirrors every Rust guard, but the mock disk is text-only | Add a bytes lane to `mockIpc`/`mockRoots` before any viewer e2e |
| Heavy renderer imported anywhere | Only `*.mermaid.test.ts` may import mermaid | `pdfjs-dist` only in `*.pdf.test.ts`, enforced with eslint `no-restricted-imports` |
| Nothing writes inside a mounted root (M30 plan:3785) | — | Uploads and conversions write only to vault `attachments/` or app-data |
| AGPL / "All rights reserved" code | Apache-2.0 (M48 D2 precedent) | Rebuild from behaviour; use only permissive upstreams |

## 8. Verification notes (stage 3)

- **Refuted: HTML5 drop works in the packaged app.** `dragDropEnabled` defaults to true, and the tauri-runtime-wry
  handler always returns true (`src/lib.rs:4865-4895`). wry then never hands the drag to WebKit
  (`wkwebview/drag_drop.rs:35-93`). FILES-14 added; FILES-4 moved to L.
- **Refuted: BlockNote round-trips image markdown.** Alt falls back to "BlockNote image" (`@blocknote/core`
  `defaultBlocks-*.js:1628`). The working-tree test lists image, audio and file as KNOWN_LOSSY. FILES-13 added.
- **Refuted: Macro's DOCX search parser is a guide.** `parsers/docx.rs` is `#[allow(dead_code)]`, has no callers and
  misses `xml:space="preserve"`. It was removed from FILES-5.
- **Refuted: FILES-3 print.** In Tauri on macOS, `window.print` routes to `plugin:webview|print`, which is not granted,
  prints the whole webview and needs macOS 11+.
- **Refuted: FILES-6 grants itself to internal runs.** Internal runs pass explicit `declared_tools()` lists
  (`assembly/live.rs:156`, `ingest/spawn.rs:167`, `maintain/live.rs:126`).
- **Refuted: Rust computes the scope from the open vault.** The backend holds no open-vault state; 58 commands take
  `vault` from the frontend. Use `last_vault` or root #0.
- **Refuted: auto-seeding vault-as-root reverses M30.7.** M30 spec §1.5 and overview decision 8 call for it; plan:1477
  deferred it only because it is hard to test. The real cost is the vault appearing as a row in the Work section.
- **Partial: Tauri asset protocol.** Range support is confirmed. The scope is not containment: a relative symlink
  resolves against the cwd (`scope/fs.rs:471-482`), one path is checked and another opened (`asset.rs:46-53`), and
  dotfiles are refused. FILES-1 now uses a custom scheme.
- **Partial: Macro's Tauri shell as a model.** It enables `protocol-asset` only for `$APPCACHE/ios-*-staging/**`
  (mobile uploads), and desktop images use blob: URLs. There is no desktop precedent.
- **Partial: provenance blocks FILES-5.** The ingest pass records a SourceSnapshot by the scanner, and ambient ingest
  defaults off. Downgraded to an owner call.
- **Partial: CLI `Read`.** It is approval-free only inside the vault cwd. Mounted roots elsewhere need an approval
  that `-p` cannot grant.
- **Partial: FILES-6 bounding.** `scope_admits` is a folder prefix, so `attachments/` is admitted wholesale.
  `get_note`'s `scan_vault` skips `attachments/`. The fence lives in `ingest/prompt.rs`; `taint.rs` is a telemetry
  heuristic. `tools.test.ts:27` parses `mcp.rs`.
- **Partial: PSD preview guide.** `PsdFile.preview` needs the full engine; resource 1036/1033 is the route that needs
  no engine.
- **Partial: `image` crate.** Its default formats pull in avif/ravif, and the default `Limits` cap only allocation, not
  dimensions.
- **Partial: "no network".** There is no HTTP client on macOS, but git pull, push and clone use the network.
- **Corrected value**: FILES-9 lowered to low. Quick Look (FILES-15) renders DOCX and PDF in about 0.2 s, measured on
  macOS 15.7.9.
- **Confirmed**:
  - The CSP and missing-feature gaps.
  - Raw IPC: `InvokeBody::Raw`, `Request::body()`, `ipc::Response`.
  - Vault-as-root was never built.
  - The pdf.js `getDocument({data, isEvalSupported:false})` call; the fork is Apache-2.0.
  - The pptx `outline()` model.
  - The LibreOffice filter table, timeouts and fork isolation.
  - Open and Reveal are absent; tauri-plugin-opener 2.5.5 works with tauri 2.11.
  - Engine LOC and licences.
- **Unverifiable offline**: WKWebView PDF iframe, HEIC and codec support (floor 10.15). Quality and licences of lopdf,
  pdf-extract and calamine. Current upstream pdfjs-dist versions (pin ≥ 4.2.67 for CVE-2024-4367, from memory). No
  packaged app was run.

## 9. Where to read first

1. `apps/web/src/features/block-unknown/component/UnknownContent.tsx`, `.../legacy-office.ts`: fallback and converting UX
2. `apps/web/src/features/block-image/component/ImageContent.tsx`, `apps/web/src/features/block-video/core/video.ts`
3. `apps/web/src/features/block-pdf/definition.ts`, then `.../PdfViewer/InternalPDFViewer.ts` (behaviour only)
4. `services/image_optimizer/src/transform.rs`, `.../handler.rs`
5. `apps/web/src/lib/core/fig-engine/thumbnail.ts`, `crates/psd_engine/src/resources.rs`
6. `apps/docs/AI/mcp/tools/read-presentation.mdx`, `.../read-word-document.mdx`, `.../read-spreadsheet.mdx`
7. `crates/attachment/src/image/base_64_image.rs`, `crates/attachment/src/provider.rs`
8. `crates/pptx_engine/src/inspect.rs` (`outline`, around :860)
9. `crates/model_file_type/src/lib.rs`
10. `apps/web/src/features/block-spreadsheet/core/uploaded-workbook.ts`
11. `services/convert_service/src/utils.rs`, `.../process/convert.rs`
12. `apps/web/src/lib/core/docx-engine/client.ts`, `apps/web/src/lib/core/fig-engine/compiled-module.ts`
13. `services/image_proxy_service/src/api/proxy.rs`, `.../proxy/resolver.rs`
14. `crates/pptx_engine/README.md`: the engine model, if Office editing is ever on the table
