# AppFlowy: AI conversation, Rust services, and storage authority

Reviewed 2026-10-22 against the supplied `docs/examples/AppFlowy-main` snapshot and
the **current, uncommitted Cerebro working tree**, including partial M91 work.
This is a source review and proposal, not a runtime verification or implementation.
No reference repository or application code was changed, installed, or executed.

AppFlowy's most useful lessons are a workspace-aware conversation, explicit source
selection, answer-to-document actions, Rust-owned AI services, and typed document
operations. It does **not** establish that Cerebro should rewrite its interface in
Rust, that its MCP client is shipped, or that changing YAML syntax provides the
benefits of a database-authoritative workspace.

## Evidence and baseline

The snapshot has no nested `.git` directory; its upstream commit is therefore not
established here. The root [LICENSE][a-license] contains AGPL version 3 text. That
is recorded as provenance, not treated as an approval requirement for this review.
The [Rust workspace manifest][a-cargo] pins AppFlowy-Cloud dependencies to
`592f644` and AppFlowy-Collab to `4dfccef`. Their complete implementations are
external to the reviewed repository; client contracts do not prove server behavior.

Cerebro HEAD was `23479518c2827d361c9c970abfac8245f9d84600`; HEAD alone does not
describe this review's baseline. M91 files already include AI presentation
components, source parsers, expanded stream types, Rust subagent folding, and
subagent policy data. At inspection, `src/agent/transcript.ts` and
`src/agent/conversations.ts` still have the earlier reducer/persistence shape;
`ContextChip` still lists place/record variants, and `CliSession` lacks M91's
proposed fork variant. These are **integration work in progress**, not evidence
that M91 was never implemented. The [M91 plan][c-m91] remains labeled PLANNED and
names recordings/native acceptance separately. Recheck these seams before opening
follow-up implementation work.

Status vocabulary below: **parity** means an equivalent mechanism is already
present; **gap** means an identified additional behavior; **planned/partial** means
M91 already owns some of the work; **decision** means the product contract changes.
Effort is a planning estimate for one experienced engineer including focused
verification, not a measured commitment. Packages overlap and should not be summed.

## AF-01 — Make context inspectable from selection through use

**Parity plus gap; P1; 1–2 engineer-weeks.** AppFlowy's source selector shows a
current-page label or selected-source count, traverses workspace pages, and makes
unsupported page kinds unavailable. Chat settings persist `ragIds`. This gives a
person a concrete answer to “what am I asking about?” See
[source selector, lines 38–62 and 159–178][a-selector] and
[chat settings manager, lines 21–48][a-settings].

Cerebro already solves invisible, moving context with removable, pinned
[context chips][c-chips] and bounded [snapshot construction][c-context]. Do not
replace that with a second context picker. Extend it into a per-turn context
receipt: attached pages, snapshot time/version, truncated portions, unavailable
files, connector results actually admitted, and content read later by tools.
Distinguish “you attached this,” “available to read,” and “read during this turn.”
An attachment is not proof that its contents reached the model.

Journey: select three project pages, attach a PDF, ask a question, then navigate
elsewhere. The original turn retains its scope and explains if a file changed,
was unreadable, or exceeded a cap. The answer's source list opens the same receipt.
The Rust grant/read boundary must still decide eligibility; UI selection is intent.

Acceptance: missing and denied sources never become empty context; restored turns
retain their historical receipt; live tool reads append provenance without
rewriting the initial selection; truncation is explicit. AppFlowy's optimistic
settings update only logs failures, so copy the clarity of selection while keeping
Cerebro's visible failure invariant. Build this after M91 attachment integration.

## AF-02 — Put durable conversation metadata behind a Rust service

**Gap and deliberate authority change; P1; 2–4 weeks.** AppFlowy models chat
messages with IDs, reply links, authors, metadata, and sync state, performs SQL
upserts in an immediate transaction, and queries messages with cursors. Its Rust
chat service loads local history before remote history. See
[message persistence, lines 14–35 and 80–155][a-chat-sql] and
[chat loading, lines 313–369][a-chat].

Cerebro's [conversation persistence, lines 326–349][c-conversations] serializes
retained conversations to `localStorage`, strips transient payloads, and catches
storage failure. The CLI session file is the transcript source, with explicit
[missing/retention handling][c-transcript-rs]. M91 adds bounded summaries and quota
recovery, so finish that work; a second mitigation should not compete with it.
For the longer investment, give Rust durable ownership of thread identity, titles,
turn references, branch ancestry, context receipts, and saved artifact references.
Use cursor-based reads and a versioned DTO; React retains drafts and viewport state.

This need not duplicate the CLI's complete raw transcript. Choose explicitly
whether normalized completed messages are retained independently of CLI retention;
that changes the current transcript-authority contract. A reference-only service
can ship first, but it cannot promise permanent conversation history.

Acceptance: reopening after renderer storage loss preserves thread navigation;
large histories load incrementally; interruption leaves an honest pending state;
duplicate replay events are idempotent; deleting a thread has documented retention
semantics. AppFlowy's `AutoSyncChatService` still calls remote question/answer
creation and contains background-sync TODOs ([lines 103–147][a-offline]); it is
not evidence of a complete offline message outbox. Do not advertise that property
based on the class name.

## AF-03 — Upgrade sources from a list to verifiable evidence

**Partial M91 plus gap; P1; 2–3 weeks before optional retrieval.** AppFlowy renders
reference-source metadata as expandable page links ([AI metadata widget][a-metadata])
and its local chunker carries source IDs, fragment indexes, and content-derived
fragment identifiers ([document indexer, lines 91–130][a-indexer]). This establishes
a useful separation between answer text and source records. It does not establish
that every generated statement is supported by a source.

Cerebro's new [source collector][c-sources] correctly tracks how URLs and vault
paths were encountered. Its [SourceRef shape, lines 128–136][c-ai-types] does not
include passage anchors, document versions, quotes, or claim relationships. URLs
parsed from an answer are especially weak evidence: the model mentioning a URL
does not prove it fetched that page. Preserve `via` in the UI and avoid turning
every encountered item into an implied supporting citation.

Add an evidence reference produced at the read boundary: source identity, version,
bounded excerpt, locator, read time, and origin tool. Let answers cite those IDs;
open the exact passage with an explicit stale-source fallback. Existing knowledge
verification remains a separate human decision. Imported or retrieved text must
never become verified knowledge merely because it appears beside an answer.

Acceptance: deleting or modifying a source produces a clear historical-reference
state; quoted excerpts match the recorded read; a denied page cannot appear through
retrieval; citations survive thread replay and page renames where identity exists.
Measure evidence precision using representative questions with expected passages.
M91's Sources/InlineCitation components can render this richer contract; do not
rebuild their visual primitives.

## AF-04 — Treat “use this answer” as a first-class journey

**Parity in editing tools, additional chat journey; P1; 1–2 weeks.** AppFlowy's
[message action bar, lines 116–149][a-actions] offers copy, regenerate, change
format, change model, and save to page. Its [document service][a-save] converts
selected messages into a new page or appends them through an editor transaction.
The valuable idea is the short route from useful answer to owned workspace content.

Cerebro already offers editor AI, agent write proposals and changesets; M91 adds
Copy/Retry/Edit/Branch. Add “Save answer” and “Add selected parts to page” after
those integrations settle. A user chooses destination, reviews the exact content
and evidence links, and creates one human write with one Undo. Preserve a reference
to the originating turn and selected source versions. A multi-message selection
must preserve speaker boundaries; AppFlowy's plain text join does not preserve
that distinction automatically.

Keep retry semantics explicit when a turn has external side effects: regenerating
an explanation and re-executing actions are different requests. A model change
should create a new answer attempt with recorded model identity, not silently
replace a prior answer or reuse its approval.

Acceptance: double-click/retry cannot duplicate a saved page; a stale target shows
a rebase/refresh choice; saving selected passages preserves code and tables;
branching leaves later file changes intact as M91 specifies. Existing
[guarded page writes][c-write] and [batch journaled writes][c-batch] remain the
implementation seams, even if storage syntax later changes.

## AF-05 — Finish attachment readiness before adding more attachment types

**Planned/partial M91; P0 acceptance, then 1–2 weeks of refinement.** AppFlowy
has separate uploading/finished/error states per file
([file input bloc, lines 34–49][a-files]) and Rust validates an indexing target
before embedding it ([chat, lines 566–599][a-chat]). Cerebro M91.17 already owns
file chips, import-on-send, guarded readers, and one Undo. Treat that as the active
implementation, not a missing feature to schedule again.

Add readiness and recovery to that plan: importing, imported, readable, partially
readable, unsupported, and failed are distinct facts. An attachment can be safely
stored but unsupported by the selected execution backend. Keep the file chip and
draft after a failure; offer retry/remove with a specific explanation. Show whether
the turn uses local extraction, image input, or connector retrieval only when that
helps the person resolve the problem.

Acceptance: a mixed PDF/image/text selection can send ready files without silently
dropping failed ones; cancellation during import has a defined outcome; restart
recovers an imported file without importing it again; grants and byte limits apply
equally when a subagent reads it. The current [context chip type][c-chips] is a
specific completion checkpoint. AppFlowy's “upload finished” state alone would not
prove model readiness; Cerebro should make the stronger distinction.

## AF-06 — Use a Rust execution interface to open model choice

**Decision; P2 after M91; 3–6 weeks for interface plus one additional backend.**
AppFlowy separates `ModelSelectionControl`, model sources/storage, a chat-service
trait, and local/cloud dispatch. Local setup includes an Ollama endpoint and
separate chat/embedding model settings. The [selection tests][a-model-tests]
exercise source aggregation, persistence, removal, and fallback. See
[model control][a-models], [service middleware, lines 115–143][a-middleware], and
[local AI settings, lines 31–47][a-local].

Cerebro's [run options][c-run-options] select Claude Code model/effort and report
the model that answered. This is already useful, but changing the model name does
not change the execution provider. Introduce a Rust `ExecutionBackend` boundary
with start/continue/cancel, normalized events, availability, and declared
capabilities: tools, images, resumability, structured results, delegation, and
approval pauses. Keep the current CLI adapter as the first implementation.

A local read-only research backend is a contained second implementation. Supporting
direct hosted APIs would additionally amend the present no-key/own-CLI contract;
design credential ownership and retention explicitly rather than smuggling it into
the model picker. Provider-neutral does not mean pretending all providers support
the same tools or resume token.

Acceptance: unsupported capabilities are visible before send; switching providers
preserves completed history while starting a compatible new session; context and
evidence remain scoped; cancellation has measured behavior; no fallback silently
changes privacy or billing expectations. AppFlowy's default-model fallback is not
the right behavior for every Cerebro failure state.

## AF-07 — Build on Cerebro's MCP foundation; do not copy an inactive module

**Parity/advantage plus expansion gap; P1; 2–4 weeks.** AppFlowy's
[MCP manager][a-mcp] can start stdio clients, initialize, stop, and list tools, but
[its module export is commented out, lines 9–11][a-ai-lib]. The manager keys clients
by command and turns list failures into `None`; the reviewed slice is not a
production connector catalog, OAuth lifecycle, or action authorization system.

Cerebro already has [connector validation/approval/fingerprinting][c-connectors],
[settings presets, status and sign-in guidance][c-connector-ui], and
[token-authenticated external client access][c-clients]. The opportunity is product
depth around those mechanisms: a connector detail page with installed identity,
available tools, input schemas, last successful verification, scope, account, and
callable status for the current run. “Configured,” “connected,” “discovered,” and
“granted here” should remain distinct states.

Introduce a Rust connector catalog and capability snapshot keyed by a stable
connector identity and configuration fingerprint. Decide whether discovery is
delegated to the CLI or owned by a Rust transport; do not operate two competing
credential/connection authorities by accident. A later native transport can
implement the same catalog contract without forcing a chat rewrite.

Acceptance: two accounts using one command are separate connectors; changing URL,
command, headers or relevant credentials invalidates the right approval; revoked
access is visible before a new call; failed discovery is unavailable, not zero
tools. Preview a harmless call with exact input/output and elapsed state. The UI
must not imply all discovered tools are safe or currently granted.

## AF-08 — Keep workflow actions and subagent execution separate from chat chrome

**Partial M91 plus expansion decision; P1 design, P2 runtime; 3–6 weeks for a
small action substrate.** AppFlowy's typed event dispatch
([document event map, lines 13–56][a-events]) illustrates a useful command seam,
but the reviewed AI slice does not demonstrate a durable workflow scheduler or
supervised subagent runtime. The `ai-tool` feature contains PDF/Markdown helpers;
it is not evidence of a general automation graph.

Cerebro is already further along in [durable wakes][c-wakes],
[dispatch][c-dispatch], [follow-ups][c-followups], and the evolving
[subagent fold][c-fold]. M91 Q2–Q5 deliberately define foreground research workers
sharing the parent's identity, narrow capability and bounded concurrency. First
prove UI/replay/persistence integration and live CLI recordings. Then consider
independently authorized actor runs as a separate contract, not a looser preset.

The reusable unit should be a versioned action with typed input/output, capability
requirements, retry classification, side-effect identity, cancellation semantics,
and an execution record. Chat, a saved recipe and a scheduled workflow invoke that
same unit. A subagent can plan or supply typed output; it does not receive an
implicit right to execute every downstream action.

Acceptance: a paused action survives restart; replay never repeats a side effect;
parent cancellation reaches children; one child failure is shown without inventing
failure for completed siblings; unavailable child steps remain “not recorded.”
Use the n8n comparison for concrete workflow mechanics. AppFlowy supports the
typed-command principle, not claims about workflow parity.

## AF-09 — Define “more Rust” by ownership, not language percentage

**Decision; P1 architecture trial; 2–3 weeks, then staged extraction.** AppFlowy's
Rust workspace owns document/AI/storage services; Flutter owns widgets, chat
presentation, editor transactions and some export conversion. It is a mixed stack.
[Typed document events][a-events] and [collab change notifications][a-document]
are stronger evidence for service boundaries than for an all-Rust interface.

Cerebro already puts enforcement, filesystem operations, runtime persistence and
the CLI bridge in Rust. Its [IPC contract test][c-ipc-test] and shared artifacts
protect cross-language agreement. A practical next step is extracting a headless
Rust core behind narrow application services, then making Tauri commands thin
adapters. Generate DTOs/schema where appropriate; keep policy artifacts as data.
Move persistent metadata, connector sessions, action execution and retrieval
ownership before considering UI logic.

Keep immediate editor interactions and presentation local unless measurements show
a benefit from moving them. A typed Rust authority can coexist with React and a
shared/WASM projection where synchronous UI computation requires it. Avoid adding
an IPC round trip to every keystroke merely to remove TypeScript.

Acceptance: one representative operation runs headlessly with the same receipts,
authorization and error codes as its Tauri path; generated contracts fail on drift;
large-result transfer and cancellation are measured. An all-Rust UI experiment is
a separate spike, with rich-text editing, IME, accessibility, tables, code rendering,
light/dark styling, and M91 chat parity as exit criteria. AppFlowy provides no
evidence that such a rewrite improves those outcomes.

## AF-10 — Decide metadata authority before replacing YAML

**Decision; P1 written ADR and read-only migration prototype; 2–3 weeks before
implementation estimates.** AppFlowy's builder opens typed collab documents,
enables undo/redo, and integrates native RocksDB/browser IndexedDB persistence
([builder, lines 19–27 and 170–207][a-collab]). Its documents expose block changes,
awareness, snapshots and sync state. Markdown is an export projection: the Flutter
[document exporter][a-export] opens a document and converts it to JSON, Markdown
or HTML; the text variant is unimplemented. This is materially different from
Markdown files being authoritative.

Cerebro currently parses YAML in [Rust][c-parse] and
[TypeScript][c-frontmatter], writes typed JSON patches through a YAML adapter, and
preserves page bodies through guarded writes. [Write serialization, lines
1191–1232][c-write] already documents that frontmatter comments/quoting are
normalized. Removing YAML can simplify syntax without solving identity, atomicity,
relations, external edits, or workflow state. Those need explicit choices:

| Option                                | Authority and benefit                                              | Cost that must be tested                                                                          |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Keep Markdown/YAML, hide syntax       | Existing portability; typed Rust API owns updates                  | Parser/serialization complexity remains                                                           |
| Markdown plus versioned JSON metadata | Removes YAML scalar ambiguity; retains text bodies                 | Rename/delete atomicity, orphan sidecars, merge conflicts, external editor behavior               |
| SQLite metadata plus Markdown bodies  | Typed queries, IDs, transactional metadata/actions                 | Split authority; reconciliation, backup/export and external edit policy                           |
| Typed database/CRDT documents         | Stable object/block identities, collaboration and structured edits | Markdown becomes export; import/export loss, migration, backup, recovery and compatibility change |

Choose based on intended product: personal files-first workspace, structured local
application, or collaborative document system. Rust alone does not choose between
them. Introduce a typed `RecordDocument`/metadata boundary first, keep legacy YAML
as an import/compatibility adapter, and measure representative corpora. A CRDT
should earn its complexity through concurrent-edit requirements.

Acceptance for the decision prototype: preserve unknown metadata, null/missing
distinctions, dates, relations, import stamps, agent grants, view definitions,
comments and content identity; produce a dry-run loss report; prove restartable
migration and rollback; export a vault readable without Cerebro. Never dual-write
two authoritative formats indefinitely. Changing the current files-first contract
is a legitimate owner decision, but it must be named rather than disguised as
“scrapping YAML.”

## Recommended sequencing and verification limits

1. Finish M91's reducer, persistence, attachments, branches and native/recorded
   acceptance; retain its presentation boundaries and subagent limits.
2. Deliver context receipts, evidence anchors and answer-to-page actions. These
   improve the daily AI experience without waiting for a storage rewrite.
3. Establish Rust services for thread metadata and connector capabilities, then
   define action execution and optional additional model backends.
4. Decide storage authority through the migration prototype; approve an all-Rust
   UI direction only after the independent editing/accessibility experiment.

Source inspection is the evidence here. No AppFlowy build, Cerebro tests, live AI
call, external connector, or visual acceptance was run. AppFlowy's
[chat bloc test][a-chat-test] contains a commented-out body; its
[desktop chat integration test][a-chat-e2e] injects messages to exercise rendering.
Those are useful UI seams but do not prove provider reliability, tool correctness,
or retrieval quality. The proposed acceptance work deliberately covers those gaps.

Selected SHA-256 fingerprints for reproducing the inspection:

```text
AppFlowy frontend/rust-lib/Cargo.toml
4cc217eeb51f8f7d537201774a54de5c185e7afb0193a7ec6c1cbd3b88b68edf
AppFlowy frontend/rust-lib/flowy-ai/src/lib.rs
f0abd1ab4ad00050dbea05789f1efce9c61a2b29def943bd43e4750adad65755
AppFlowy frontend/appflowy_flutter/lib/plugins/ai_chat/application/chat_edit_document_service.dart
c13587d9de9eeb23eb8c9a1aea910bc5d748747855e73a12061ad4a090dc0c89
Cerebro src/agent/conversations.ts
1a905972e7548fcdb6759a2f9554c4a14ff81f3495b0b4fb68c3fef6ab5a980f
Cerebro src-tauri/src/agent/fold.rs
34d297f4190ff9b86fe93dc519cbf14924bdf415516618dbf7658afc60d4884b
```

[a-license]: ../../../examples/AppFlowy-main/LICENSE
[a-cargo]: ../../../examples/AppFlowy-main/frontend/rust-lib/Cargo.toml
[a-selector]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/ai/widgets/prompt_input/select_sources_menu.dart
[a-settings]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/application/chat_settings_manager.dart
[a-chat-sql]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai-pub/src/persistence/chat_message_sql.rs
[a-chat]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/chat.rs
[a-offline]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/offline/offline_message_sync.rs
[a-metadata]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/presentation/message/ai_metadata.dart
[a-indexer]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/embeddings/document_indexer.rs
[a-actions]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/presentation/message/ai_message_action_bar.dart
[a-save]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/application/chat_edit_document_service.dart
[a-files]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/application/chat_input_file_bloc.dart
[a-model-tests]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/model_select_test.rs
[a-models]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/model_select.rs
[a-middleware]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/middleware/chat_service_mw.rs
[a-local]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/local_ai/controller.rs
[a-mcp]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/mcp/manager.rs
[a-ai-lib]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/lib.rs
[a-events]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-document/src/event_map.rs
[a-document]: ../../../examples/AppFlowy-main/frontend/rust-lib/flowy-document/src/document.rs
[a-collab]: ../../../examples/AppFlowy-main/frontend/rust-lib/collab-integrate/src/collab_builder.rs
[a-export]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/workspace/application/export/document_exporter.dart
[a-chat-test]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/test/bloc_test/chat_test/chat_load_message_test.dart
[a-chat-e2e]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/integration_test/desktop/chat/chat_page_test.dart
[c-m91]: ../2026-10-22-m91-ai-elements-and-subagents.md
[c-chips]: ../../../../src/agent/contextChips.ts
[c-context]: ../../../../src/agent/context.ts
[c-conversations]: ../../../../src/agent/conversations.ts
[c-transcript-rs]: ../../../../src-tauri/src/agent/transcript.rs
[c-sources]: ../../../../src/engine/ai/sources.ts
[c-ai-types]: ../../../../src/engine/ai/types.ts
[c-write]: ../../../../src-tauri/src/vault/write.rs
[c-batch]: ../../../../src-tauri/src/vault/batch.rs
[c-run-options]: ../../../../src/agent/RunOptionsPicker.tsx
[c-connectors]: ../../../../src-tauri/src/connectors.rs
[c-connector-ui]: ../../../../src/app/ConnectorSettings.tsx
[c-clients]: ../../../../src-tauri/src/client_access.rs
[c-wakes]: ../../../../src-tauri/src/runtime/wakes.rs
[c-dispatch]: ../../../../src-tauri/src/runtime/dispatch.rs
[c-followups]: ../../../../src-tauri/src/runtime/followups.rs
[c-fold]: ../../../../src-tauri/src/agent/fold.rs
[c-ipc-test]: ../../../../src/lib/ipcContract.test.ts
[c-parse]: ../../../../src-tauri/src/vault/parse.rs
[c-frontmatter]: ../../../../src/engine/frontmatter.ts
