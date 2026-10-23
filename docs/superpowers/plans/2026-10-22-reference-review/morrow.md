# Morrow reference review — 2026-10-22

Morrow's most useful contribution is a tightly connected personal-note workflow:
capture, write, retrieve the precise passage, follow its context, and recover a
mistake. Cerebro already has the more substantial architecture for agents,
provenance, guarded knowledge, transactional changes, and interaction state. The
opportunity is to finish several everyday journeys around that architecture,
with save recovery ahead of adding another destination or visualization.

## Scope, evidence, and provenance

This is a source review of the supplied local `docs/examples/Morrow-main`
snapshot against Cerebro's **current working tree**, including staged work, on
2026-10-22. The reference was inspected only; it was not installed, tested,
linted, modified, or treated as Cerebro code. Neither application's native UI was
executed for this dossier. Implementation observations therefore differ from
runtime verification; proposed acceptance tests below remain work to do.

Morrow's `package.json:1–31` declares version 1.0.0, Apache-2.0, the upstream
`Aarav2709/Morrow` repository, and typecheck/lint/test/build scripts. `LICENSE:1–3`
contains Apache License 2.0; its appendix retains template copyright text,
whereas `package.json:87–90` names the 2026 contributors. There is no `.git`
directory in this supplied reference root, so **no upstream revision is
asserted**. The following SHA-256 values identify three inspected local files,
not the entire repository:

| File under `docs/examples/Morrow-main/` | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `package.json`                          | `73cc70705cd1ca5b4aabbff4e9f0d3fb75fc09feb1417d4cc87273600b02d845` |
| `src/storage/saveQueue.ts`              | `6689c10cf6f4d53c01f165bb2d9e54ef8799dc36a64d23db22002e0ec173b788` |
| `src/core/search.ts`                    | `e1d482b1d37a9fec87967ec85a5246b142f1987c52fffbe79d819ab0409e1686` |

Evidence paths below are repository-relative. `M/` abbreviates
`docs/examples/Morrow-main/`; unprefixed paths are Cerebro. Line ranges describe
the inspected working-tree files and can move with later changes. Reuse should
follow Cerebro's existing guided-rebuild decision; these findings do not require
a license approval gate or copying a reference subsystem.

## Five-topic assessment

| Topic                 | Evidence and comparative conclusion                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engineering practices | Morrow's save fault tests are unusually useful (`M/src/storage/storage.test.ts:89–147`). Its three-OS CI runs typecheck, lint, unit tests and build (`M/.github/workflows/ci.yml:11–28`). Cerebro already exceeds this in shared-contract tests, coverage gates, Rust checks and browser journeys (`.github/workflows/mac-app.yml:42–151`). Native acceptance remains a real gap, not a reason to replace the gate. |
| Architecture          | Morrow separates domain functions, a workspace session, a save queue, a repository and an Electron bridge (`M/src/storage/saveQueue.ts:24–47`; `M/src/storage/vaultRepository.ts:70–100`). Cerebro already separates its pure engine, adapters and Rust guarded writers. Keep that separation and introduce typed save outcomes at the existing seam; do not port a second workspace model.                         |
| UX/UI                 | The strongest details are context-bearing backlinks, direct search-hit landing, a source escape hatch, and capture from another app. Most database, canvas, theme, outline, command-palette and page-chrome features already have counterparts. Morrow's visual theme is not an argument to replace Cerebro's new shell or type system.                                                                             |
| Agentic workflows     | Morrow explicitly excludes AI (`M/README.md:3–6,27`). There is no agent scheduler, tool approval, retrieval agent, or knowledge-verification workflow to borrow. Its deterministic operations can inform tools, but Cerebro's own CLI, grants, receipts, review and runs remain the architecture.                                                                                                                   |
| Knowledge/retrieval   | Morrow implements lexical search, links, unlinked mentions, a page graph and flashcard scheduling. Cerebro has stronger semantic meaning around concepts, source authority and inbound replacement/conflict edges (`src/engine/okf.ts:1117–1160`; `src-tauri/src/knowledge.rs:1233–1326`). Improve discoverability without equating an ordinary link, a remembered answer and verified knowledge.                   |

## Ranked findings and implementation slices

Effort assumes one engineer familiar with Cerebro: S is roughly 1–3 focused days,
M is 4–10, and L is 2–4 weeks. These are planning bands, not commitments; native
or unfamiliar carrier work can enlarge them. P0 means investigate before new
feature work, P1 strengthens a central journey, P2 is a useful extension, and P3
needs evidence of demand. Each slice includes its own targeted tests; unchanged
features do not need duplicate tests merely to match another repository.

### MR-01 — Recover a failed autosave without requiring another edit

**P0 · Source-confirmed missing retry/retention path; runtime loss unproven · M.** Journey:
write a paragraph, encounter a transient disk failure, restore the disk, then
press Save or quit. The exact unsaved paragraph must remain recoverable.

Morrow restores failed IDs to its dirty sets, retries with capped exponential
backoff, and reads the latest document for the next attempt
(`M/src/storage/saveQueue.ts:97–154`). Its disk-full test changes the pending
content before retry and asserts the newer content lands
(`M/src/storage/storage.test.ts:89–117`).

In Cerebro, `MarkdownEditor.tsx:671–677` assigns `lastSaved` before the save
settles; `:715–720` flushes only a pending timer. `NoteBodyEditor.tsx:299–331`
catches failure and displays it, but this path does not retain an explicit retry
payload. Its failed-save test asserts the toast, not recovery
(`src/editor/NoteBodyEditor.test.tsx:227–240`). Quit checks failures occurring
since the quit began (`src/app/quit.ts:173–186`), so a previous failed attempt
deserves a specific regression test. This is not a claim of reproduced data loss.

First add a fault test that fails a settled autosave, restores the writer, and
flushes without typing. Then represent attempted versus acknowledged content at
the editor save seam, retain the latest failed draft, and expose Retry. Keep
human actions nonthrowing, but return/read a typed save outcome internally.
Distinguish retryable I/O from policy refusal, missing files and malformed data;
never retry permanent refusals indefinitely. Prevent agent launch, rename or
quit from treating a known unsaved draft as durable.

**Acceptance:** a settled failed autosave followed by Ctrl/Cmd+S without another
edit saves the exact latest text; quit also detects a preexisting unresolved failure;
permanent refusal stays visible; two attempts cannot reorder; pane close and
vault switch preserve or explicitly resolve the draft; an agent cannot start on
older disk content while the UI claims its edit was saved. Depends on the shared
flush/hold contract in `src/editor/openPages.ts:19–88` and native quit validation.

### MR-02 — Carry a search result through to its passage

**P1 · UX depth gap · M.** Journey: search for a fact in a long document, open the
result, and immediately see the matched passage rather than search again.

Morrow passes `firstMatch` from the palette into navigation
(`M/src/app/components/CommandPalette.tsx:81–89`), selects and reveals its first
text occurrence after the editor loads, then consumes that request
(`M/src/app/editor/PageEditor.tsx:230–248`). Cerebro already supplies ranked,
highlighted excerpts and honest partial/unavailable states. However,
`src/app/QuickOpen.tsx:353–371` opens only `hit.path`, discarding the excerpt's
location. The Rust ranker already knows body line versus frontmatter field
(`src-tauri/src/search.rs:160–187`).

Extend the search result contract with a bounded location descriptor and source
version, then deliver a one-shot reveal request through the existing editor
request pattern (`src/editor/sectionLinks.ts:1–70`). A field match should reveal
the property, not fabricate an editor location. Use passive highlighting rather
than stealing a live editor selection. Preserve pane ownership and Back history.

**Acceptance:** repeated words land on the scored excerpt; nested blocks,
collapsed containers and metadata hits reveal correctly; a stale result opens
the document with a clear fallback; lazy loading consumes the request once;
opening a held file focuses its existing pane. Depends on extending the IPC
contract and on the common location primitive also used by MR-04.

### MR-03 — Preserve overwritten outside content as a recoverable version

**P2 · Recovery depth gap, design decision required · M/L.** Journey: an external editor changes a file
while Cerebro holds an unresolved conflicting edit; the person leaves the page,
then wants the outside version back.

Morrow keeps the external version before retrying a conflicting write
(`M/src/storage/vaultRepository.ts:370–401`), with a test proving both the user's
landed document and the outside history entry
(`M/src/storage/vault.test.ts:240–251`). Caveat: its snapshot is a parsed document,
not byte-exact original content (`:572–586`), and that helper does not inspect
the returned apply result. Copy the recovery intent, not these weaknesses.

Cerebro already merges outside changes, holds saves and presents choices
(`src/editor/NoteBodyEditor.tsx:278–291,371–438,479–501`); leaving a held choice
deliberately writes the person's version (`:531–545`). Rust likewise deliberately
preserves human last-write-wins (`src-tauri/src/vault/write.rs:1502–1525`). Page
history contains recorded activity and Git versions, with explicit Git-off
states (`src/history/PageHistory.tsx:101–145`). That is not a guarantee that an
uncommitted outside preimage was saved.

Add a narrow recovery journal for bytes about to be displaced by the human save
door, under its existing lock. Keep exact bytes, original path, hash and truthful
unknown attribution; retain a bounded local recovery history separate from
knowledge and Git. Define exclusion/retention behavior for mail and other
restricted material before implementation. Do not change who wins or add a new
merge subsystem.

**Acceptance:** Git-disabled external overwrite, unresolved-choice navigation,
restart, failed journal write, quota exhaustion and renamed paths each have
specified outcomes; restore is an explicit guarded human write; history never
claims an agent authored unknown outside content. Depends on MR-01 and a clear
retention/storage design. First characterize whether existing checkpoints cover
each case; narrow the implementation to uncovered cases.

### MR-04 — Make backlinks explain themselves and offer unlinked mentions

**P1 · Existing backlink parity, contextual depth gap, missing mention discovery · M.**
Journey: open a project page, see why another note links to it, then find a note
that mentions the project without linking.

Morrow extracts backlink contexts (`M/src/core/links.ts:22–64`) and on demand
finds title mentions with Unicode word boundaries, excluding self and already
linked pages (`:85–110`). Its page exposes excerpts and opens mention text in
context (`M/src/app/components/PageView.tsx:373–435`). Cerebro's efficient memoized
backlink index already exists (`src/engine/links.ts:42–81`), but rows contain
title and relationship label only (`src/detail/DocSidePanel.tsx:35–49,87–110`).

Keep the existing six-row fold and Details panel. Fetch bounded snippets for
expanded backlinks and add an explicit Find mentions action using the corpus
cache. Explain title ambiguity; suggestions must not become automatic links or
knowledge evidence. A Link action, if later added, uses one reviewed human batch
and existing filename-stem link grammar. An agent can consume the same bounded
read result under its scope without receiving a second write path.

**Acceptance:** Unicode boundaries, duplicate titles, existing links, aliases,
code fences, renamed targets and source read failures are distinct cases;
truncated results say so; restricted pages never leak; keyboard navigation opens
the exact context. Depends on MR-02, scope-aware corpus access and five lab
states. Do not scan every full body on each render as Morrow does.

### MR-05 — Offer a byte-preserving source escape hatch

**P1 · Missing capability at an existing guarded boundary · M/L.** Journey: an
imported Markdown page opens read-only because the rich editor cannot preserve
part of it; the person changes one sentence without accepting content loss.

Morrow offers a source editor and validates parsed output before replacing its
document (`M/src/app/components/SourceEditor.tsx:13–24,48–66,76–103`). Its source
starts from serialized editor data, so it is not evidence of exact source-byte
preservation. Cerebro currently explains HTML loss, removed content, inserted
text and reordering and offers explicit Edit anyway
(`src/editor/NoteBodyEditor.tsx:50–77`). This protects files; the missing part is
a productive alternative within the app.

Offer Edit Markdown alongside the loss warning, seeded from actual file body
bytes. Switch presentations within the same file owner and save lifecycle;
frontmatter remains under its existing writer. An unsupported rich preview is
acceptable; silent normalization is not. Preserve the title projection's single
owner. Concepts remain on guarded concept paths, never generic source writing.

**Acceptance:** unusual HTML, unknown fences, mixed newlines, leading blanks,
tables and Unicode survive an unrelated source edit; changing modes does not
duplicate saves or lose drafts; errors retain text; open source mode alone
writes nothing; external changes and quit reuse MR-01. Depends on the shared
editor ownership/flush contract and an explicit source-versus-rich undo design.

### MR-06 — Close the native acceptance gap using real task journeys

**P1 · Existing engineering parity plus validation gap · S/M for harness, ongoing execution.**
Morrow tests core/storage logic and builds on three platforms
(`M/.github/workflows/ci.yml:11–28`), yet candidly says its macOS/Linux builds have
not been tried on real machines (`M/README.md:82–88`). Do not confuse an OS build
matrix with usable native software.

Cerebro's automated gate is stronger (`.github/workflows/mac-app.yml:42–151`),
but the current implementation record explicitly leaves WKWebView input, IME,
VoiceOver, native dialogs, external-open policy and failed-save quit outstanding
(`docs/superpowers/plans/2026-10-17-m84-m90-implementation-record.md:125–132`).
The record also reports an unmet large-table target (`:18–24`); this review does
not convert that into a pass.

Prioritize a reproducible native acceptance fixture: capture, rich/source edit,
external update, failed save, search-to-passage, attachment and quit. Record the
app build identity, fixture vault, precise input and observable outcome; retain
failure evidence. Keep performance measurements separate from functional test
durations. Add platform matrices only when those platforms become supported.

**Acceptance:** run the full journey on the packaged target with keyboard,
VoiceOver, IME and Finder input; distinguish unavailable automation from product
failure; report p50/p95 interaction timings on declared fixtures and hardware.
Depends on reliable native inspection and MR-01 fault injection, not on adopting
Electron or expanding Cerebro's supported OS list.

### MR-07 — Make search tolerant of accents without corrupting locations

**P2 · Retrieval depth gap · S/M.** Morrow folds diacritics and case
(`M/src/core/search.ts:23–38`) and tests that CAFE finds Café
(`M/src/core/workspace.test.ts:72–93`). Cerebro's ranker tokenizes alphanumeric
runs and lowercases them (`src-tauri/src/search.rs:207–244`), so accent equivalence
is not part of that contract. Cerebro already has richer field weighting,
phrase matching and widened-result disclosure; retain those.

Design a shared normalization contract for discovery with a mapping back to
original byte/character spans. Treat composed/decomposed equivalents and optional
accent-insensitive matching deliberately; preserve exact-match ranking. Do not
copy Morrow's fallback that displays folded rather than original text when
lengths differ (`M/src/core/search.ts:113–125`), or reuse search folding for file
identity and wikilink resolution.

**Acceptance:** Café/cafe and decomposed characters retrieve correctly while
excerpts preserve original spelling; non-Latin text, emoji and multiple matched
terms retain valid ranges; human palette and scoped agent search agree; run
large-vault ranking fixtures before adding token caches. Depends on MR-02's
location contract and shared Rust/TS cases wherever behavior twins.

### MR-08 — Capture a thought while another application is active

**P2 · Missing native entry point, existing capture parity · M.** Morrow registers
an OS shortcut, restores/focuses its window, and opens a small capture dialog
(`M/electron/main.cts:119–125`; `M/src/app/components/CaptureDialog.tsx:7–48`).
Cerebro already creates untyped Inbox captures (`src/lib/capture.ts:5–38`) and
has an in-app command (`src/app/commands/app.commands.ts:30–38`), but no global
shortcut implementation was found in its shell/Cargo surface.

Add an optional configurable native shortcut that reaches the existing capture
action and shows the destination vault. Keep Inbox semantics rather than
automatically adopting Morrow's daily-note destination. A warm app can first
reuse the main window; a separate capture window is a later product choice with
its own lifecycle cost. A global shortcut is not an agent trigger or a mutation
encoded into a `cerebro://` navigation link.

**Acceptance:** shortcut collision is visible; minimized/no-vault/loading states
work; Escape preserves or explicitly discards a draft; repeated invocation does
not duplicate a capture; save completion precedes dismissal; focus returns as
documented. Depends on native command plumbing and MR-01, with no new vault
writer or automatic assistant run.

### MR-09 — Import a complete offline note archive with a preview

**P2 · Missing archive journey, existing import infrastructure parity · L.**
Morrow plans Markdown folders and Notion Markdown/CSV exports together, relinking
pages and referenced assets (`M/src/core/importer.ts:49–163`). Its tests cover
nested rows, duplicate CSV variants and attached images
(`M/src/core/features.test.ts:103–179`). Cerebro already has typed import identity,
preserved edited copies and explicit outcomes (`src/engine/importPlan.ts:14–37,
76–100`), plus a guarded connector-backed Notion door
(`src-tauri/src/import/notion_door.rs:1–27,60–97`). The missing journey is a local
archive the person owns, without needing a connector session.

Add a bounded Rust archive reader and dry-run planner, then reuse existing import
identity and batch writes. Preview counts, destination paths, unsupported
carriers, link rewrites and collisions before committing. Retain source-system
provenance; importing the owner's downloaded archive does not turn source claims
into owner-verified knowledge. Reuse existing CSV and file-kind tables rather
than Morrow's duplicated parsers/MIME table.

**Acceptance:** hostile paths, symlinks, inflated-size limits, duplicate names,
reimport after an edited/moved copy, unresolved links, attachments and mid-batch
failure all produce bounded explicit outcomes; choosing or previewing an archive
writes nothing; undo restores exact preimages. Depends on archive limits,
shared source identity decisions and the existing transactional batch writer.

### MR-10 — Explore a page's local relationship neighborhood

**P3 · Missing visual navigation surface; graph semantics already exist · M/L.**
Morrow separates a graph projection from a force-layout renderer
(`M/src/core/graph.ts:9–106`; `M/src/app/components/GraphView.tsx:60–95`). It offers
focus/depth, tag and hierarchy filters. Cerebro already has ordinary link indexes
(`src/engine/links.ts:21–81`) and typed concept edges
(`src/engine/okf.ts:1144–1160`); it does not need a new knowledge graph store.

If user research shows link lists are insufficient, add an optional local
neighborhood view from Details, with a synchronized accessible list and bounded
node budget. Keep link direction and relationship kind; make ordinary links,
typed relations and epistemic relations visibly distinct. Never infer truth
from network centrality. Keep the current shell and avoid a mandatory new rail
destination.

**Acceptance:** depth means exact breadth-first distance, independent of edge
order; multiple edge kinds survive; filtering preserves focus; keyboard/list
equivalence and reduced motion work; large graphs disclose caps. Morrow's
`graph.ts:95–102` mutates the visited set during each edge pass, so chains can
expand too far in one step; its `:51–56` deduplicates by endpoints without kind.
Do not copy either behavior. Depends on a demand checkpoint, MR-04, and a pure
projection outside the strict whiteboard scene core.

## Deliberate deferrals and patterns not to copy

- **Spaced repetition is not knowledge verification.** Morrow's card extraction
  and scheduling are real (`M/src/core/flashcards.ts:38–115`; tests in
  `M/src/core/organize.test.ts:418–454`). Learning cards could be a later optional
  capability, but an Easy grade must never call Verify or make a claim current.
  Require a separate personal learning use case before building it.
- **Streaks and rediscovery are not a mandate for Home.** Morrow's deterministic
  rediscovery is a useful explicit command idea (`M/src/core/insights.ts:44–70`).
  Keep Cerebro Home pull-only and avoid adding activity counts or habit pressure.
- **Do not add LAN sync, page encryption, static publishing or custom CSS merely
  for checkbox parity.** Each adds substantial lifecycle, security and support
  scope. Per-page encryption especially changes search, agents, history and
  backup semantics; it is not a small UI enhancement.
- **Do not weaken data guarantees.** Morrow's generic source flow converts a
  failed file-list read to `[]` (`M/src/app/components/SourceEditor.tsx:30–35`),
  contrary to Cerebro's unavailable-versus-empty rule. Its snapshot helper
  parses before preserving and ignores the returned write outcome. Its global
  search uses `Date.now()` inside ranking (`M/src/core/search.ts:83–84`); Cerebro
  should inject time for deterministic ranking tests if recency is ever added.
- **Keep deterministic actions deterministic.** Import planning, link discovery,
  capture and recovery do not need a model. Agents may call the same scoped,
  bounded read interfaces and guarded writes later; no provider keys, separate
  agent database, automatic Verify, or new unreviewed write door is justified.

## Recommended delivery order

1. Characterize and repair MR-01; execute MR-06's native failed-save journey.
   Decide the narrow preimage policy in MR-03 from observed uncovered cases.
2. Ship MR-02 and MR-04 as one coherent find-and-follow journey. Add MR-07 once
   original-span mapping is explicit. Measure successful passage landing and
   time to source, not just result count.
3. Ship MR-05 to make unsupported Markdown productive without sacrificing bytes.
   Validate source/rich transitions and recovery together.
4. Choose MR-08 or MR-09 based on whether capture friction or migration prevents
   adoption. Both reuse existing human write doors and require native proofs.
5. Hold MR-10 and learning features until user evidence shows that the simpler
   links, snippets, retrieval and review journeys no longer suffice.

The first release gate should be recoverable writing and reliable passage
retrieval. Those benefits strengthen every existing agent and knowledge feature
without broadening Cerebro's foundational architecture.
