# M55 — Pages first

**Goal.** Every page has one anatomy (D18): icon, cover, sub-pages and page cards, and agents open as pages too. An agent revises a page in place by quoting it, and the open editor takes the change without losing the caret, undo or unsaved typing. Every block survives a save, and quitting keeps the last keystrokes.

Roadmap: `2026-10-12-macro-port-roadmap.md`, § M55. House style and rails: `2026-10-12-m53-safe-core-and-rails.md`, `2026-10-13-m54-one-tool-surface.md`.

**Read first (Macro, behaviour only), by part:** .1, .3 `services/sync-service/README.md` · .4 `packages/lexical-core/transformers/index.ts` · .5 `apps/docs/AI/mcp/tools/edit-document.mdx`, `services/ai-editing-worker/src/comment-mark/anchor{,.test}.ts`, `services/ai-editing-worker/AI_EDITING.md` · .6 `apps/web/src/lib/core/component/LexicalMarkdown/collaboration/{reconcile,undo}.ts`, `apps/web/src/features/block-md/ai-edit/applyAiOps.ts` · .7 `apps/web/src/lib/core/component/LexicalMarkdown/plugins/actions/actions.ts` · .9 `apps/web/src/features/block-md/component/DispatchAgentMenu.tsx` · .10 `apps/web/src/lib/tauri/native-update-preparation.ts` · .11 `apps/web/src/lib/core/component/EntityIcon.tsx` · .12 `apps/web/src/features/routines/views/routine-detail.tsx`, `apps/web/src/features/routines/primitives/{routine-detail,routine-autosave}.ts`.

## Status

- **Dependencies:** M53 and M54. Implementation is present; milestone closure still requires the outstanding acceptance below.
- **Implementation (2026-10-15):** The write funnel and hashes, quote edits and reconciliation, block carriers, page links, Open with, save-on-quit, page chrome, agent pages, sub-pages and page cards are implemented.
- **Integrated evidence:** see the [roadmap execution update](2026-10-12-macro-port-roadmap.md#execution-update--2026-10-15) for the final unit, coverage, browser, native and static gates, plus their limits. These results do not substitute for packaged or authenticated live acceptance.
- **Effort:** 8 M + 6 L ≈ 10 L; the roadmap said ≈5.5 L. Re-measured: .1, .2, .3, .7, .8 and .9 from S to M; .11 and .13 from S to L; .4, .5 and .12 from M to L.
- **Crash risk:** .1 (the write funnel and a crash child change) and .9 (two new spawn sites).
- **Packaged acceptance still outstanding:** .4, .5, .6, .7, .8, .9, .10, .11, .13. **Live acceptance still outstanding:** .1 (dev, optional), .5 (the real CLI). .12 gets the owner's WebKit look.

## Decisions

- **Owner decisions** (roadmap, 2026-10-12), as they bind M55:
  - D0: Macro is the behaviour guide. No copied code, comments, prompt text or fixtures.
  - D1: single user. The actor seam stays; recording each write's actor is M58.1's (Q1).
  - D2 (c): an agent's note write may carry `expect_hash`, the value of get_note's `Hash:` line. A mismatch is refused as `stale_content`, a new operational code, and nothing is written (.3, .5). Human saves never compare: the last write wins, merged in place from .6 on. The ledger's `expected_version` and `stale_target_version` are untouched. M60's batch writer and undo reuse .3's check.
  - D3 (a): Rust/TS twins are held by shared cases: `quote-cases.json` (.5), `wikilink-targets.json` (.8), and the scan golden, now with hashes (.2). `agent-links.v1.json` is Rust-only (.9) and the media extension table TS-only (.4), so neither is a twin.
  - D4: edit_note rides the per-turn `claude -p` and loopback MCP. No transport change. D5 (the transcript fold) and D6 (off, ask, on) bind M56 and M57, not M55.
  - D7: the agent page shows `recent` read-only and never writes it (.12).
  - D18: one anatomy (icon, cover, title, properties, body, tabs) on every page (.11–.14), agents included (.12).
  - **Governed types hold:** agents may not write Agent or Type pages. .1 and .5 judge the bytes under the write's lock; .12 changes no Rust.
- **Rules:**
  - One part, one commit: `type(scope): sentence (M55.n)`. Each commit deletes the comments it falsifies.
  - Parts start on M54's closed tip. Edits anchor by name or text, never line number.
  - The waves are fixed, and parts in a wave share no file. Waves 1, 2 and 4–7 build two parts in parallel worktrees, each with its own e2e `PORT`. cargo runs one at a time with a shared `CARGO_TARGET_DIR`. Parts cherry-pick in part order, then the wave tip is re-gated. The milestone branch stays in the main checkout.
  - New refusal codes: only `stale_content` (.3). Schema steps: none.
  - Artifacts regenerate by the README's ignored tests. policy.v3: .3, `artifact_version` 8 → 9. tools.v1: each edit (.3, .5) bumps `artifact_version`, sets `rule_version` to `tools/<commit date>` and regenerates the digest. Never run prettier over `shared/`.
  - Editor parts (.4, .6, .7, .8, .13, .14) read the BlockNote DOM traps first (`verify-ui`, M53.23). Serialization never depends on rendering. Custom-block CSS and geometry are asserted in a browser.
  - No `@blocknote/xl-*` package: they are GPL-or-commercial against our Apache-2.0 (M48 D2). Carriers are hand-built directives and fences.
  - With the owner's OK, push after waves 1 and 5, so CI's Linux crash suite meets .1 and .9.
- **Contracts between parts.** Whichever part lands second does the shared work:
  - .1's `rewrite_note` is the one note funnel. .3 adds its `expect` and `NoteWriteError`; .5's `edit_note` is `rewrite_note` plus a closure.
  - .1's `governed_bytes_refusal` is the one byte check. .5 runs it on the before and after bytes; path-only guards speak first.
  - .1 retires M54.6's `WRITE_SERIAL`. M54.6 kept it "until M55.1 and M55.3", and .3's hash check adds no ordering.
  - The hash is `Entry.hash` everywhere (.2, .3, .5, .6). get_note prints `Hash: <hex>` after `Type:`, and .5's report reuses that label.
  - .2 and .4 share wave 2, so .4 builds any new Entry fixture through `src/test/factories.ts`.
  - .3's `parse_expect_hash`, stale message and per-run recorder serve .5. .3 holds a hashed write to read scope; .5's `read_write` axis read-gates edit_note always.
  - .5 owns the mock edit path: `agentEdit` (mockIpc.ts), the mock agent's `edit "<old>" to "<new>" in <path>.md` script, and `onEdit` (agentIpc.ts). .6 adds only the `__cerebroAgentWriteGate` seam.
  - .6 pairs every carrier .4 adds. .13's `subPages` and .14's `pageCard` each add one `reconcile.test.ts` case: a write that misses the block keeps its id.
  - .6 → .10: quit is a leave, so a page holding a save (an open choice or a held save) writes yours at ⌘Q.
  - .6 → .11: a frontmatter-only write leaves the open buffer alone, so an icon patch no longer reloads the page.
  - .7 → .8: `creatableTitle` refuses `#`, so a section query offers no Create row; .8 extends `readLinkQuery`'s page branch.
  - .4 → .8: a heading inside a closed toggle is reached by opening each closed toggle around it, outermost first, through its own `.bn-toggle-button`. BlockNote 0.46.2 marks a closed one `data-show-children="false"`.
  - .8 → .14: the card resolves through .8's `resolveLink`, with no second `#` cut.
  - .11's `EntryIcon` and `PageIconGlyph` draw .13's crumbs and list rows and .14's cards. .11 lands after .12, so agent pages get the icon and cover too.
  - .12 → .13: `canHaveSubPages` refuses Agent and Skill records, so agent pages never grow.
  - .9 then .10 share lib.rs, `shell/mod.rs`, ipc.ts and AGENTS.md, in that order.
  - CV ids go in wave order: .1, .4, .3 and .12 (if Q23 stays (a)) each take the next free one. .8 extends CV-09, and .9 extends M53.12's webview CV.
- **Scout reconciliations** (no part changed wave):
  - .6 said `contentHash` and `agentEditNote` and re-specified the edit script. It now uses `hash` and .5's mock path, and `agentIpc.ts` leaves its files.
  - .5 planned a new `governed_content_refusal`, checked before the bundle guard. It now follows .1.
  - .4 and .8 disagreed on closed toggles. .8 opens them, depends on .4 and gains an e2e case.
  - .14 cut `#` itself in case it landed before .8; .8 lands first.
  - .13 and .14 each gain `src/editor/reconcile.test.ts`.
  - .10's acceptance named the banner .6 retires; .11's reload risk retires by order.
  - edit_note's description gains one sentence: keep `:::` lines and `cerebro-` fences whole. .4's risk asked for a product-brief line; the tool description carries it with no prompt-golden churn.
  - .3's CV text drops "until M55.6 merges in place", so .6 never touches AGENTS.md (wave 5 gives it to .9).

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M55.1, M55.7 | per-path write lock · create and link from `[[` and `@` |
| 2 | M55.2, M55.4 | content hash on every entry · every block has a carrier |
| 3 | M55.3 | `expect_hash` and `stale_content` |
| 4 | M55.5, M55.12 | `edit_note` · agents open as pages |
| 5 | M55.6, M55.9 | outside writes merge in place · Open with |
| 6 | M55.8, M55.11 | section links · page icon and cover |
| 7 | M55.10, M55.13 | quit flushes saves · sub-pages |
| 8 | M55.14 | page cards |

**Before wave 1.** Commit this plan on M54's closed tip. Ask Q3 before wave 2: carrier spellings are permanent once a file holds them. As everywhere, the default applies if unanswered.

## Parts

### M55.1 A per-path write lock inside `vault::write`

- **What:** no file lock exists.
  - A person's patch, an agent's append and a second run each read, compute and rename, so the last rename drops the other change.
  - `create_note`, `write_text_file` and `import_attachment` check that a name is free, then write, so two at once overwrite each other.
  - The agent compounds read the file several times before writing, so a governed check can judge bytes that are already gone.
  - M54.6's `WRITE_SERIAL` orders MCP writes only among themselves, never against human writes, and it serialises unrelated files.
- **Files:** `src-tauri/src/{vault/write.rs, mcp.rs}`, `AGENTS.md`, `SECURITY.md`.
- **Approach:**
  - **Keys and locks,** in a "Path locks (M55.1)" section after `landing_path`. One process-global `(Mutex<HashMap<String, ThreadId>>, Condvar)`, built like `watcher::own_writes`. `lock_key` resolves, folds with `disk_folded` (M53.28) and NFC-normalizes, so `./a.md`, `A.md`, a symlinked folder, HFS ignorables and NFD share one key. `lock_paths(vault, rels)` takes every key at once or waits, so two multi-path writers can't deadlock; a key this thread already holds refuses instead of hanging. `PathLock` is `#[must_use]`, and its Drop releases, notifies and recovers a poisoned table.
  - **One funnel.** `write_file` takes `&PathLock`, with `debug_assert!(lock.covers(abs))`. `rewrite_note(vault, rel, extensions, next)`: `note_join` (refuses before any lock), lock, read, `next(&current)`, `write_file`, `shadow_write` unless `.mmd`; it returns the written bytes' `sha256_hex`. The disk-reading helpers become pure over bytes (`patch_bytes`, `compose_saved`, `append_bytes`, `retitle_bytes`), with the `.mmd` refusals first and unchanged. The human writers keep their signatures and go through it.
  - **Every other writer.** `patch_note_checked` and `append_note_checked` run `check(before, after)` under the lock; an Err writes nothing. Name-picking writers walk `-2`, `-3`, …: judge, lock, re-check `exists()`, then write or release. Single-path writers lock their path, and `rename_note` locks `[from, to]` in one call. `note_type` becomes `#[cfg(test)]`. The crash child `crash_scenario_overwrite_note` takes `lock_paths` first.
  - **mcp.rs.** Path-only guards run first, outside the lock (`guard_agent_write`, then `governed_write_refusal(&patch)`). Then the `_checked` writer runs `governed_bytes_refusal` on before and after. That one helper replaces the three governed ones and keeps PR #17's reasoning (the mint by nulling the last key, the half-open fence an append closes). `WRITE_SERIAL` goes; M54.6's panic test stays.
  - **Lock order,** in the section doc: under a path lock, only leaf locks (the watcher map, the runtime sink); never `shadow::with_writer`, never a second `lock_paths`. knowledge/ projections belong to the ledger writer and take no path lock. Logs go through M53.24's macros, with no `#[allow]`.
  - **Docs.** AGENTS.md takes the next free CV, "One writer per file" (Appendix B). SECURITY.md and mcp.rs's Security paragraph change only if M54.6 said MCP writes run one at a time: writes to one file take turns, and writes to different files may overlap.
- **Comments to delete:** the "a guard has to read what LANDS ON DISK" docs on `patched_frontmatter` and `saved_note`; the `appended_body` and `note_type` docs; `note_join`'s writer list (name the new writers); the three governed-helper docs (folded into `governed_bytes_refusal`); `tool_append`'s inline comments; M54.6's `WRITE_SERIAL` doc. The module and `write_file` docs gain "every write runs under its path lock".
- **Tests:**
  - write.rs: `lock_keys_hear_one_file_however_it_is_spelled`, `two_writes_to_one_note_take_turns`, `writes_to_two_notes_overlap` (timeouts, so a global lock fails instead of hanging), `an_agent_append_and_a_person_patch_both_land`, `two_creates_of_one_slug_land_in_two_files` (also `import_attachment`), `rename_holds_both_ends`, `a_panic_inside_a_locked_write_releases_the_path`, `a_lock_taken_twice_by_one_write_refuses_instead_of_hanging`. Every existing writer test passes unchanged.
  - mcp.rs: `the_governed_check_judges_the_bytes_it_replaces` (a concurrent retype to Agent gives `AGENT_DOC_REFUSAL`, and the bytes stay). M54.6's ordering test becomes `writes_to_one_note_take_turns_and_writes_to_two_notes_overlap`, and reads never wait. The governed-type tests and the note-targets replay pass unchanged.
- **Acceptance:**
  - Two writes to one file never interleave, however the path is spelled; the second builds on the first.
  - Writes to different files overlap, and no global write lock remains.
  - Every check an agent write makes judges the bytes it replaces, under the write's lock.
  - Two creates or imports of one name land in two files.
  - A panic releases the lock, and a re-lock by the same write refuses instead of hanging.
  - Single-cause refusal messages are byte-identical, and the crash scenarios behave as before on CI Linux.
- **Live check** (dev, optional): ask the agent to append to the open page while you change one of its properties. Both land.
- **Wave** 1 · **Depends** M53.21, .24, .25, .28; M54.6, .10 · **Size** M (roadmap S) · **Crash risk** yes (funnel and crash child) · **Packaged check** no
- **Commit:** `fix(vault): one writer per file, and agent checks judge the bytes they replace (M55.1)`.

### M55.2 Every Entry carries a content hash; get_note prints it; triggers fire only on content changes

- **What:** Entry has no content identity. `diffEntries` fires `changed` whenever `modifiedAt` moves. So an in-app patch fires twice (the optimistic millisecond stamp, then Rust's second), a touch or an identical re-save fires, and a same-second rewrite fires nothing. get_note prints no hash, so D2 has nothing to name.
- **Files:** `src-tauri/src/{vault/entry.rs, vault/scan.rs, vault/write.rs, lib.rs, mcp.rs}`, `conformance/{scan/entries.json, README.md}`, `src/engine/{types,events,events.test,triggers.test}.ts`, `src/lib/{mockParse,mockIpc,mockIpc.test,ipc}.ts`, `src/stores/vaultStore{,.test}.ts`, `src/agent/useJobRunner.test.tsx`, `src/test/factories.ts`, `src/engine/testHelpers.ts`, `src/detail/LayoutEditorDialog.tsx`, and the 14 test files holding Entry literals: `src/app/Sidebar`, `src/status/ProposalCard`, `src/knowledge/{ConceptPage,ConceptProposals,RelatedKnowledge}`, `src/detail/DocProperties`, `src/pages/{HomePage,HomeTasks,KnowledgePage}`, `src/mermaid/flowchart/{LinkPopover,StructuralEditor}` (`.test.tsx`), and `src/lib/templates`, `src/engine/{docPages,links}` (`.test.ts`).
- **Approach:**
  - **Rust.** `Entry.hash: Option<String>`, the last field: lowercase-hex SHA-256 of the bytes as read. None means not recorded, never the hash of nothing. `build_entry` sets it for `.md` and `.mmd`; an unreadable file gets None. `read_note_hashed` returns the body and the hash of the same bytes. `update_frontmatter` returns the hash `rewrite_note` wrote. Its command answers `Option<String>`: None for a capture-valve (knowledge) write, whose projection is the ledger's.
  - **get_note** reads through `read_note_hashed` and prints `Hash: <hex>` after `Type:`. The manifest isn't edited here; .3 describes the line.
  - **Golden.** `UPDATE_CONFORMANCE=1 cargo test --lib vault::scan::tests::scan_golden`. conformance/README gains one sentence: any demo-vault byte edit now regenerates it.
  - **TS.** `hash: string | null`: null means unreadable, or an optimistic edit not yet answered. `parseNote` sets `sha256Hex(raw)`. `updateFrontmatter` (ipc and mock) answers `string | null`, null for a knowledge path. Its keys don't change, so M54.3's test holds.
  - **Events and store.** `changed` fires only when both hashes are known and differ. A null-hash entry isn't compared, and the baseline keeps the last known entry at that path, so the event fires once the bytes are known. `applyPatch` and `setTitle` set `hash: null`. `patchFrontmatter` swaps in the answered hash only while its optimistic object still stands: a scan that landed first wins. Every Entry literal gains `hash: null`; the events and job-runner edit helpers and triggers.test's `risk()` set `h:${modifiedAt}`, so their cases still see a change (`makeEntry` now gives null).
- **Comments to delete:** `applyPatch`'s "so the optimistic entry and the rescanned entry agree"; `patchFrontmatter`'s "In Tauri no reconcile pass runs at all … so the optimistic entry stands"; events.ts's `modifiedAt` comparison and any doc that treats a new mtime as a new version.
- **Tests:**
  - Rust: entry.rs `an_entry_carries_the_hash_of_its_bytes` (`.md`, `.mmd`); scan.rs `an_unreadable_file_has_no_hash`; the golden is current, and `scanGolden.test.ts` passes unchanged, so the mock's hashes equal Rust's; write.rs `update_frontmatter_returns_the_hash_of_what_it_wrote`; mcp.rs `get_note_prints_the_hash_of_the_bytes_it_returns`.
  - events.test: an mtime-only change fires nothing; a same-mtime byte change fires; a null hash defers, then fires once against the last known version; a failed write back to the old hash fires nothing. triggers.test passes with only `risk()` changed.
  - vaultStore.test: null, then the write's hash; a first-landed scan wins; a failed write leaves no hash; "an in-app patch is one changed event, not two" (HEAD gives two). mockIpc.test: the sha256, and null for a capture.
- **Acceptance:**
  - Every scanned entry carries its bytes' SHA-256, in Rust and the mock alike, held by the golden; an unreadable file's is null.
  - get_note returns the hash of the bytes it prints.
  - `changed` fires only on a content change: a touch or an identical re-save fires nothing, and a same-second rewrite fires.
  - An in-app property edit fires one event, and a failed write none.
  - The IPC answers the hash it wrote; a capture answers null.
- **Wave** 2 · **Depends** M55.1; M53.20, .22, .25, .30 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(vault): every entry carries its content hash, and triggers fire only when content changed (M55.2)`.

### M55.3 Write precondition (D2): `expect_hash`, refused as `stale_content`

- **What:** no agent write can say "only if unchanged", so a decision made on stale content lands without a word. edit_note (.5), `set_fields` (M60.4) and the batch writer (M60.6) need one compare-and-set, under .1's lock, against .2's hash. Macro's sync-service answers a stale revision with 409 and applies nothing; `stale_content` is that 409.
- **Files:** `shared/policy/{policy.v3.json, policy.v3.sha256, README.md, tools.v1.json, tools.v1.sha256}`, `src-tauri/src/{policy/table.rs, vault/write.rs, mcp.rs}`, `src/lib/policy/table.test.ts`, `src/lib/{mockIpc,mockIpc.test}.ts`, `AGENTS.md`, `SECURITY.md`.
- **Approach:**
  - **policy.v3.** `stale_content` joins `rejection_destinies` (operational) and `transport_rejections`, sorted; `artifact_version` 8 → 9; regenerate with `cd src-tauri && cargo test --lib policy::table::tests::write_policy_digest -- --ignored`. The README records why: it is a transport code (it fails at the write door before a byte, bounds one call and claims nothing, so `Rejection::new` keeps it out of the ledger). It is not `stale_target_version` (the ledger's) or `stale_view` (a person's verify), and it is not retryable in-session, because the agent must re-read.
  - **write.rs.** `rewrite_note` gains `expect: Option<&str>`, compared after the read and before `next`. A mismatch returns `NoteWriteError::Stale(StaleContent { path, expected, actual })` and writes nothing: no temp, no shadow row. `NoteWriteError` is `Stale | Refused(String)`. The `_checked` writers take `expect`; human writers pass None.
  - **mcp.rs.** `parse_expect_hash`: absent gives None, 64 hex in any case is lowercased, and anything else is a plain error with nothing written. If M54.10 left the handlers without the run, they become `tool_update_frontmatter_in` and `tool_append_in`, with run-less `#[cfg(test)]` wrappers (the `tool_write_concept_in` precedent). A stale write records one deduped `stale_content` row through M54.10's recorder and returns the Appendix B message. The message carries no current hash, and the result is isError, so nothing is announced.
  - **Read scope (Q2).** In call_tool's read axis, a write that carries `expect_hash` has read its target, so the target goes through M54.10's read-scope check, with its code and message.
  - **tools.v1.** An optional string `expect_hash` on update_frontmatter and append_to_note (Appendix B). Their descriptions and get_note's say how to use it and that a mismatch writes nothing, with no retired term (M54.8).
  - **Mock and docs.** `agentAppend(vault, path, content, expectHash?)` applies the same shape check and message after its guards. AGENTS.md takes the next free CV (Appendix B). SECURITY.md: a write that names `expect_hash` is also a read, held to read scope.
- **Comments to delete:** call_tool's "The targeted reader (get_note) refuses here" gains the hashed write; `agentAppend`'s "Refuses what Rust refuses, in Rust's order…" gains the stale check; .1's `rewrite_note` doc gains the expectation and says human writers never pass one.
- **Tests:**
  - write.rs: `a_stale_expectation_writes_nothing` (bytes, mtime and `vault_writes` rows unchanged, no temp), `a_matching_expectation_writes_and_answers_the_new_hash`, `a_human_save_never_compares`.
  - mcp.rs: `a_stale_expect_hash_is_refused_and_leaves_the_file_alone`, for both tools: the text starts `stale_content:` and never says `stale_target_version`; one operational row carries the run_id, and a repeat adds none; nothing is announced. Also `an_expect_hash_from_get_note_lets_the_write_through` (uppercase too), `a_malformed_expect_hash_writes_nothing`, `expect_hash_reads_its_target`.
  - table.rs `stale_content_is_an_operational_transport_code`; `table.test.ts`; `mockIpc.test.ts`; both tools.v1 digest tests; `every_served_tool_is_valid_api_input`.
- **Acceptance:**
  - cargo: a stale `expect_hash` returns `stale_content` and leaves the file alone (roadmap).
  - The code is operational, declared through the README ritual, and never `stale_target_version`.
  - A matching hash writes, a write without one behaves as before, and human saves never compare.
  - A hashed write outside read scope is refused before any byte is read.
  - The mock refuses a stale hash in Rust's words.
- **Wave** 3 · **Depends** M55.1, .2; M54.1, .2, .10; M53.6, .19 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(mcp): an agent write may name the hash it read, and a stale one writes nothing (M55.3)`.

### M55.4 Every `/` block has a disk carrier or leaves the menu

- **What:** M53.31 hides toggle list, the three toggle headings, audio and file. Table writes an extra empty header row. Image writes the alt "BlockNote image", which `isLossyImport` counts as lost letters, so a page with an image opens read-only. Captions, titles, resize width, relative video and audio, and every Tab-nested child are dropped or retyped on save.
- **Files:** `src/engine/pageMedia{,.test}.ts` (new), `src/editor/markdown{,.test}.ts`, `src/editor/{MarkdownEditor,MarkdownEditor.test,SelectionToolbar,SelectionToolbar.test}.tsx`, `e2e/editor-carriers.spec.ts` (new), `playwright.config.ts`, `.github/workflows/mac-app.yml`, `docs/superpowers/specs/2026-08-30-cerebro-m48-page-layout-design.md`, `AGENTS.md`.
- **Approach:**
  - **Measure first,** in jsdom and then Chromium through the new spec: the eight KNOWN_LOSSY reasons, whether a `headerRows: 1` table round-trips, and what BlockNote writes back for a relative image inside a list item.
  - **Media grammar,** `engine/pageMedia.ts` (pure, no URL class): `parseMediaLine`, `formatMediaLine`, `mediaKindOf`. One whole line, `![text](dest "title")`. A text ending `|N` is a width, for image and video only (Q5). The kind comes from the extension: BlockNote's video list, an audio list, a document list for file, else image. Link lines are never lifted, so a working `[x](y.pdf)` stays a link.
  - **Reading,** beside M53.9's `:::ai` machinery. The openers `:::toggle <summary>`, `:::toggle-heading` and `:::indent`, as strict as `parseColumnMarker`, are lifted with standalone media lines into one tagged `Lifted` union. A toggle summary parses alone and must be one paragraph or nothing. `promoteMedia` runs before `promoteContainers`, which closes toggle as `toggleListItem`, toggle-heading as a heading with `isToggleable`, and indent as children of the previous sibling. Malformed input keeps its raw lines and children in place, and an unclosed container abandons the fold.
  - **Writing.** `writeToggleSummaries`, then `demoteContainers` writes the three containers at `containerColons` depth (renamed from `aiMarkerDepth`). An empty-URL media block writes nothing and lifts its children. A list item keeps native children only for a pure list tree; otherwise its children go in an `:::indent`. `tightenAiMarkers` becomes `tightenOpeners`, and `isLossyImport` ignores only the container names (`withoutContainerNames`).
  - **Menu.** Empty M53.31's dropped set. `/table` inserts the 2×3 table with `headerRows: 1` through `insertOrUpdateBlockForSlashMenu`; if that still fails the test, table leaves the menu and KNOWN_LOSSY together, with the reason. `formattingToolbarItems()` drops `filePreviewButton`. If a browser writes a list-item image's url back absolute, swap unlifted image destinations for `cerebro-src:<n>` before the parse.
  - **Docs.** Correct the M48 spec's §2 first bullet and D5: toggles shipped with no carrier, M53.31 hid them, and M55.4 carries them. AGENTS.md takes the next free CV (Appendix B). With Q6 yes, a webkit Playwright project runs this spec, and CI's e2e job installs `chromium webkit`.
- **Comments to delete:** M53.31's "until M55.4 gives them carriers"; the KNOWN_LOSSY docblock and its eight reasons; the `BLOCKNOTE` list and `insertedBy` comments in markdown.test.ts (M53.31 renamed `MENU` to `BLOCKNOTE`; the test now walks the editor's builder, `slashMenuItems`, and M53.31's `DROPPED_SLASH_KEYS` set empties); in markdown.ts, the container header, "one stack for all three", "Swap two kinds of line", the AI-only wording in `Lifted`, `isMarkerLine` and `restorePlaceholders`, the `aiMarkerDepth` and `tightenAiMarkers` docblocks, and `isLossyImport`'s letters-and-digits claim; the M48 spec's "Toggle lists already ship … Nothing to build." and D5's "they already ship".
- **Tests:**
  - pageMedia.test: canonical lines byte for byte (`![](attachments/a.png)`, `![](../attachments/a.png)`, `![Plan](a.png "Caption")`, `![](<My Shot.png>)`). Other title quotes normalize to `"…"`, escapes survive, `<…>` appears only when needed, `name|300` reads and writes, partial lines are rejected, and kinds ignore query, fragment and case.
  - markdown.test, describes for `:::toggle`, `:::toggle-heading`, `:::indent` and media lines: rich summaries and children stay byte-stable over two saves; nesting in a toggle, a column and an AI answer; summaries starting `#`, `1.` or `>` are written escaped; lookalikes stay text; continuation paragraphs become `:::indent` and are not lossy; pure list trees stay native, with CORPUS unchanged; "BlockNote image" and "Add image/audio/video/file" are never written; fenced media lines stay code; a list-item image keeps a relative url. The describe `every / item survives a save or is not offered` walks the editor's own builder, and `KNOWN_LOSSY` is `{}` and can only stay empty.
  - MarkdownEditor.test: the six are back; `/table` inserts a header row; a page with an image, a toggle and an indented child reports `lossyImport` false; the unmount flush writes a toggle (its summary holding a `[[link]]`) and an image. SelectionToolbar.test: no `filePreviewButton`.
  - e2e `editor-carriers.spec.ts` (Chromium, plus WebKit with Q6): a page holding every carrier opens with no `lossy-import-banner`, and an unrelated edit keeps every carrier line byte-identical; `/` inserts each block, and it reopens as itself; a list-item image keeps a relative url.
- **Acceptance:**
  - vitest: every `/` item round-trips byte-stable or is not offered, walked from the editor's own list, with KNOWN_LOSSY empty (roadmap).
  - `![](attachments/a.png)` is byte-stable, and a page with an image opens editable (roadmap).
  - Toggles, toggle headings, nested children, audio, file, captions, titles, empty alt, and video or audio by extension all survive a save; M48 D5 is corrected (roadmap).
  - The six M53.31 blocks are back, "BlockNote image" never reaches disk, and the toolbar offers no preview toggle.
  - Carriers are checked in a real browser (roadmap risk), and the new CV's pointer resolves.
- **Packaged check:** in a mac-build app, add a toggle, a toggle heading, a captioned and resized image, audio, a file and a Tab-nested paragraph. The file holds their carriers, and the page reopens the same. A page holding `![](attachments/a.png)` opens editable.
- **Wave** 2 · **Depends** M53.6, .9, .10, .19, .20, .31 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(editor): every block the / menu offers saves as a carrier and reopens as itself (M55.4)`.

### M55.5 `edit_note`: quote-anchored body edits, all or nothing

- **What:** no in-place body edit exists. Agents can only create, patch properties and append, and the CLI's Edit is denied without the shell. EDITOR-2 and D2 call for an exact-quote tool that refuses rather than guesses, lands every edit or none, and can carry `expect_hash`.
- **Files:** `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`, `src-tauri/src/{policy/tools.rs, vault/quote.rs (new), vault/mod.rs, vault/write.rs, mcp.rs, knowledge.rs}`, `src-tauri/fixtures/{quote-cases.json (new), tool-cases.json, tool-grants.json, note-targets.json}`, `src/lib/policy/tools{,.test}.ts`, `src/engine/quote{,.test}.ts` (new), `src/engine/tools.test.ts`, `src/lib/{mockIpc,mockIpc.test}.ts`, `src/agent/{mockAgent,mockAgent.test,agentIpc}.ts`, `src/agent/{AiActionCard,AiPanel}.tsx`, `src/agent/AiActionCard.test.ts` → `.test.tsx` (git mv), `e2e/agent-writes.spec.ts`, `SECURITY.md`.
- **Approach:**
  - **Resolver twins** (D3): `vault/quote.rs` and `engine/quote.ts`, pure, both replaying `src-tauri/fixtures/quote-cases.json`. Limits: 100 edits; 40 code points of context and 80 of match; 20 listed. Matching is exact over the body as get_note prints it (Q8: raw markdown) and counts overlapping matches. Every failing edit is reported and intersecting spans are refused; otherwise one splice, giving each edit's new line. The messages are exact (Appendix B). The fixture is prettier-formatted, with non-ASCII and control characters as `\u` escapes.
  - **Write door.** write.rs `edit_note(vault, rel, edits, expect, check)` is `rewrite_note` (.1, .3) with a closure. It keeps the prefix (BOM, fences, YAML) byte for byte, plans the body and hands before and after to `check`, which mcp.rs fills with `governed_bytes_refusal` on both. It never goes through `saved_note` or `save_note`, which rewrite the fences and drop a BOM. It returns `EditedNote { content_hash, lines }`.
  - **Manifest.** Door `note` gains axis `read_write`, and row `edit_note` follows `append_to_note` (Appendix B); `format` stays 1, because one enum grows. Both loaders accept `read_write` only with a note target: one refusal, same words, one negative control each. `write_target` reads write and read_write, and `read_target` reads read and read_write. `tool-cases.json`, and the whole-catalog cases in `tool-grants.json`, gain the row. The README says why: its refusals quote the note back.
  - **Tool.** `tool_edit_note` parses `path`, `edits` and `expect_hash` (.3's parser). An `occurrence` that is absent or null gives None, a positive integer gives Some, and anything else gives Some(0), so the resolver says "counts from 1". `guard_agent_write` runs first, then the door. The report (Appendix B) names the path, each edit's new line and the new hash under get_note's label. It announces its landing as append_to_note does, pinned by the announce test. If M54.10 left the grant checks inline in call_tool, extract `dispatch_refusal` unchanged, so cargo can test the refusals.
  - **Mock.** `agentEdit(vault, path, edits, expectHash?)`, in Rust's order: bundle, note target, missing, stale, plan. The governed-type rule stays Rust-only (M53.6). mockAgent gains `edit "<old>" to "<new>" in <path>.md` (`\n` is a line break, and new may be empty), wired through `onEdit` in agentIpc.ts; without `onEdit` it refuses.
  - **UI and docs.** AiActionCard takes `history?: 'git' | 'none'` from `historyOf(ready, isRepo)`, which AiPanel reads from useGit. An expanded write card with no git history shows `action-no-revert` (Appendix B); unknown history shows nothing. SECURITY.md: edit_note needs read access as well as write. No new code, no schema step, no `propose_` name.
- **Comments to delete:** mcp.rs's module doc and knowledge.rs's "closes those three doors" now name four doors; `note_join`'s writer list gains `edit_note`; mockAgent's "the one script that changes the vault"; agent-writes.spec's header names both write scripts; AiActionCard's header says undo needs git history, and that the card says so without it; `announced_change`'s doc, if it lists the tools that name their file.
- **Tests:**
  - quote.rs and quote.test.ts replay the cases, check the limits against the fixture's, and refuse 101 edits. Cases: unique, multi-line, delete, out of order, adjacent, ambiguous, occurrence 2, 3 of 2 and 0, `aa` in `aaa`, not found, in the frontmatter, empty old, same new, overlap, two failures together, 25 matches, an emoji cut, CRLF (a `\r\n` quote lands, a bare `\n` one doesn't), a long match, a tab and a quote in context, a leading newline, zero edits.
  - write.rs: `an_edit_changes_only_the_quoted_bytes` (BOM, CRLF fence, trailing-space fence, CRLF body, no final newline), `an_ambiguous_edit_writes_nothing`, `a_stale_expect_hash_writes_nothing`, `a_current_expect_hash_lands`, `two_edits_racing_on_one_hash_land_once`, `the_check_sees_the_bytes_it_would_write` (an Err writes nothing). The note-targets replay gains the edit_note door.
  - mcp.rs: `edit_note_replaces_a_unique_quote_and_reports_it`, `an_unreadable_path_is_refused_before_any_match` (read_outside_scope, quoting no occurrence), `a_path_outside_the_write_scope_is_refused`, `edit_note_refuses_the_bundle`, `edit_note_refuses_type_docs_and_agent_records`, `an_edit_that_completes_a_byte_zero_fence_is_refused`, `edit_note_announces_its_landing`, `the_body_edit_note_matches_is_the_one_get_note_prints`. The scope, manifest and announce tripwires pass with the new row.
  - Loaders: `read_write` with a folder target, or on a door without it, is refused; both digests are pinned. tools.test: the write toolset is create_note, update_frontmatter, append_to_note, edit_note.
  - mockIpc.test (other bytes kept; refusals equal the fixture's text; stale and current hashes; the report; the note-targets door), mockAgent.test, and AiActionCard.test.tsx (`historyOf`; the line only with history none; never on a read card).
  - e2e agent-writes: "an agent edit replaces only the quoted text on the open page, and an ambiguous quote changes nothing". Editing "after the freeze" to "after the Wednesday freeze" lands; then "Thursdays" to "Fridays" replies "appears 2 times", and the disk is byte-identical.
- **Acceptance:**
  - The roadmap's cargo bullets: a unique quote is replaced and untouched bytes stay identical, BOM, CRLF and fence spellings included; an ambiguous quote is refused, listing both occurrences with line and context; an unreadable path is refused before any match, quoting nothing; a stale hash returns `stale_content`.
  - Non-git vaults have no revert for agent edits, and the card says so (roadmap risk).
  - The edit set is atomic. knowledge/, Type docs, Agent records (a completed fence included), dot-paths and non-notes are refused, and write and read scope both bind. Listings stop at 20, then give the exact rest.
  - Rust and TS replay one case file, and the mock refuses what Rust refuses. tools/list serves edit_note with its title and destructive hint.
- **Live check** (dev or packaged, real CLI): a one-sentence change on an open page shows an edit card, not an append. A phrase that appears twice gets the listing and a retry with `occurrence`. A non-git vault's card says it can't revert. A read-scoped agent can't edit outside its read scope.
- **Wave** 4 · **Depends** M55.1–.3; M54.1, .2, .4, .7, .10; M53.4–.6, .10 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(mcp): edit_note changes quoted text in place, all or nothing (M55.5)`.

### M55.6 Outside writes apply in place: content-paired blocks, their own undo step, a 3-way merge

- **What:** after M53.6 an announced write remounts a clean page, so the caret, scroll, undo history and node views are lost. A dirty page gets M17.4's Load/Keep banner: all or nothing, decided by a sticky dirty flag that stays set even after no-op edits. Nothing applies an outside write in place.
- **Files:** `package.json`, `pnpm-lock.yaml`, `src/engine/{hunks,hunks.test}.ts`, `src/engine/blockMerge{,.test}.ts` (new), `src/editor/{markdown,markdown.test,openPages}.ts`, `src/editor/reconcile{,.test}.ts` (new), `src/editor/{MarkdownEditor,MarkdownEditor.test,NoteBodyEditor,NoteBodyEditor.test}.tsx`, `src/editor/MergeChoices.tsx` (new), `src/agent/{mockAgent,mockAgent.test}.ts`, `src/agent/{AgentActions,ProposalCard,ProposalCard.test}.tsx`, `src/mermaid/useDiagramFile.ts`, `src/pages/DiagramPage.tsx`, `e2e/agent-edit.spec.ts` (new), `e2e/agent-writes.spec.ts`.
- **Approach:**
  - **Dependency (Q11):** `"prosemirror-history": "^1.5.0"`, the range @tiptap/pm declares. It must resolve to the one 1.5.0 copy BlockNote loads: `closeHistory`'s meta key is a PluginKey made in that module, so a second copy would close nothing, silently.
  - **Pure planning.** hunks.ts exports `lcsTable` and `lcsPairs`; `rewriteHunks` output doesn't change. `engine/blockMerge.ts` (imports only hunks):
    - `pairNodes`: an LCS on signature, then on text inside each gap; blanks are left out;
    - `planReplace(live, next)`, two-way: same-type nodes in a gap update in place, and blanks stay after a gap's inserts, so the trailing paragraph stays last;
    - `planMerge(base, mine, theirs)`, three-way: a one-sided cluster applies; equal changes keep mine; one same-type node per side merges own content and children recursively; anything else is a choice, and mine stays; two inserts at one gap keep both, mine first.
  - **Editor seam.** markdown.ts gains synchronous `markdownToBlocksNow` and `blocksToMarkdownNow` (BlockNote 0.46 parses and exports synchronously), and the async forms wrap them. `editor/reconcile.ts`:
    - `toNodes`: signature = type, non-default props, joined inline runs and children; text = a memoized serialization;
    - `planExternal`: same; unrepresentable when lossy; clean → `planReplace`; dirty → `planMerge` against the base, where dirty means the serialization differs from the base;
    - `applySteps`, and `inPlace` = `transact(closeHistory; fn)`, then `transact(closeHistory)`. The change is its own ⌘Z step, and the next keystroke starts its own.
  - **MarkdownEditor.** An `applying` ref, checked first in `scheduleEmit`. `EditorReadyInfo` gains `loadedAs`, `serialize()`, `markSaved(md)`, `applyExternal(next, base, {allowLoss})` and `choose(id, pick)`. After an apply, `lastSaved` is the next canonical text, so undoing the change gets saved. A new choice replaces an open one that shares a live block id. `MergeChoices.tsx` (`merge-choices`, copy in Appendix B) takes the banner's place.
  - **NoteBodyEditor.** The banner state goes: baseline, conflict, dirty, edits, discarded, ownSaveInFlight. In its place: a base `{raw, canon}`, a seen hash, and a reconcile loop (one running, one queued) triggered on settle and on any change of `entry.hash`. A locked lossy page re-reads. An unrepresentable write remounts a clean page, or offers a dirty one a whole-page choice. Saves are held while a write is pending, a reconcile runs or a choice is open; `release()` writes `serialize()` when it differs from the base. Leaving with a choice open writes yours (Q12).
  - **Mock agent.** Each write step first awaits `globalThis.__cerebroAgentWriteGate` when that is a promise, a browser-mode test seam. A run cancelled while held writes nothing.
- **Comments to delete:**
  - NoteBodyEditor: the M17.4/M53.6 reconcile docblock, and the gen, announcement, clean-buffer, ownSaveInFlight, re-baseline, conflictRef/edits/discarded, banner-copy, "theirs wins" leave and generation-key comments;
  - MarkdownEditor's "or the buffer is discarded" clause (the markdown prop doc gains the in-place sentence); hunks.ts's "the input is a selection a person made"; openPages.ts's stamp sentence;
  - AgentActions's and ProposalCard's reload-or-ask notes; useDiagramFile's and DiagramPage's "consciously deferred" (markdown pages merge in place; a `.mmd` still reads once per mount);
  - the matching test docblocks, and agent-writes.spec's "only the per-path announcement" sentence.
- **Tests:**
  - hunks.test (`lcsPairs`; `rewriteHunks` unchanged). blockMerge.test, two-way and three-way tables (a delete against a change is a choice either way; a parent and child changed by different sides merge; equal inputs give equal plans). markdown.test: the Now forms equal the async ones over the M2 corpus.
  - reconcile.test (headless): unchanged blocks, a same-type change, the other column, the trailing blank and untouched AI, database and toggle blocks keep their ids; a dirty non-overlap keeps both edits; an overlap gives one choice; `settleChoice` both ways; a lossy next changes nothing.
  - MarkdownEditor.test: `applyExternal` calls neither onChange nor onDirty; undo after it emits the pre-apply text; typing "X" and then an outside change to that paragraph undo as two steps (fails without the first `closeHistory`); typing "Y" right after an apply undoes alone (fails without the second).
  - NoteBodyEditor.test, reconcile describe rewritten: a clean apply in place with one onReady; a hash change with no announcement does the same; a frontmatter-only change reads once and changes nothing; an own save never re-applies; held typing merges; an overlap shows one choice, and the disk keeps the agent's text while it is open; Keep yours and Use new; leaving writes yours; lossy cases; no `external-change-banner`.
  - ProposalCard.test: the new H1 shows in place with one mount. mockAgent.test: the gate holds writes, and a run cancelled while held writes nothing.
  - e2e `agent-edit.spec.ts` (boot, mock agent, gate):
    1. With the caret at the end of paragraph 2, edit_note changes paragraph 1. The editor handle stays connected and the selection stays. ⌘Z restores only paragraph 1, and the disk then holds the old sentence plus the typing.
    2. Typing in paragraph 2 inside the debounce, plus an edit: both reach disk, with no choice.
    3. Typing in paragraph 1, plus an edit: one choice; the disk keeps the agent's text 800 ms later; Keep yours writes yours.

    agent-writes.spec passes with `merge-choices` at 0 where the banner was.
- **Acceptance:**
  - Roadmap e2e: edit_note on the open page changes the paragraph without a remount, the caret stays, and ⌘Z undoes only the agent's change. With unsaved typing elsewhere both edits survive, and an overlap shows per-hunk choices.
  - Blocks pair through hunks.ts's exported LCS, and `closeHistory` runs before and after every apply; vitest proves the 500 ms grouping. `rg 'external-change' src e2e` finds nothing.
  - No outside write remounts an open page, except a locked lossy page and an unrepresentable write on a clean page. Frontmatter-only writes and own-save echoes leave the buffer alone.
  - Nothing saves while a choice is open, leaving writes yours, and undoing an applied write is saved. Untouched custom blocks keep their ids.
- **Packaged check** (WKWebView): with the caret in one paragraph, ask the agent to edit another. It changes without a flash, the caret stays, and ⌘Z restores it and is saved. Typing in the paragraph the agent edits brings up the bar, and Keep yours and Use new both behave.
- **Wave** 5 · **Depends** M55.2, .4, .5; M53.6, .18 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(editor): outside writes land in the open page in place, merged with what you typed (M55.6)`.

### M55.7 Create and link from `[[` and `@`

- **What:** the `[` and `@` menus offer only pages that exist, and BlockNote closes a menu four characters past its last match, so `[[Launch notes` ends as plain text. No Rust, mock or IPC change is needed: `createItem` → `create_note` already uniquifies and rescans in both backends.
- **Files:** `src/engine/wikilink{,.test}.ts`, `src/app/listActions{,.test}.ts`, `src/editor/linkMenu.ts` (new), `src/editor/linkMenu.test.tsx` (new), `src/editor/MarkdownEditor.tsx`, `e2e/create-link.spec.ts` (new).
- **Approach:**
  - **wikilink.ts:** a private `stemOf` (the filename minus `.md` in any case, lowercased) used by `resolveTarget`, and `freshStem(title, entries)`: `slugify(title) || 'page'`, then `-2`, `-3`… until no entry's stem matches. The check is vault-wide, because `resolveTarget`'s stem pass is vault-wide and first-wins.
  - **listActions.ts:** `LINKED_PAGE_FOLDER = ''` (Q15) and `createLinkedPage(title)`, which calls `createItem({folder, slug: freshStem(…), frontmatter: {}, body: '# <title>\n'})`. A throw toasts "Couldn't create the page" and returns null.
  - **`editor/linkMenu.ts`** (no React, no BlockNote): `creatableTitle` (null for empty text, `[ ] | #` or a leading `^`), `charBeforeTrigger` (over a structural EditorState; never throws), `readLinkQuery` (cite, closed, or page with `double`), `mentionAtWordStart`, `stemOfPath`.
  - **`createAndLink`** in MarkdownEditor tracks the caret with BlockNote's `trackPosition`, awaits the create, then inserts the chip (`inlineContentToNodes`) with the stem the backend wrote, or puts the typed text back on null. It checks an `alive` ref and read-only first, wraps the transact in try/catch, and never calls `editor.focus()`.
  - **Rows.** `createRow` is null when the title is refused, there is no vault, or a page already answers to the name. `@` appends Create only at a word start, so `ana@example.com` gets none. `[` appends it only after `[[`, and `]` closes the menu so Enter starts a line. Every row runs `stripDanglingBracket` first.
- **Comments to delete:** the mention-menu header (it now creates too). Of the two conflicting `[[` comments ("the second bracket lands in the query" against "the menu triggers on the SECOND bracket"), keep whichever linkMenu.test measures. Delete the inline `query.replace(/^\[/, '')`.
- **Tests:**
  - wikilink.test `freshStem` (another folder, case, `-3`, emoji → `page`, a `.mmd` doesn't block). listActions.test (the arguments; a rejection toasts once and resolves null). linkMenu.test pure tables.
  - linkMenu.test, rendered (the citations.test harness, `vi.mock('@/app/listActions')`): `charBeforeTrigger` after ` [[Launch` is `[`; Create is last and inserts exactly one wikilink `launch-notes`, with no stray `[`; no row for an existing name, a single `[`, `|` or `#`; `]` closes; `@` creates at a word start only; a deferred create puts the chip before later typing; null restores `[[Launch notes`; unmounting mid-create throws nothing.
  - e2e create-link.spec: (1) `See [[Launch notes`, then Create: the chip shows, `launch-notes.md` is exactly `# Launch notes\n`, the page holds `See [[launch-notes]]`, and the chip opens the new page. (2) `@Retro memo` creates; `ana@example.com` plus Enter, and `[Draft`, create nothing.
- **Acceptance:**
  - Roadmap e2e: typing `[[Launch notes`, then Create, inserts the chip.
  - Create appears only after `[[`, under `@` only at a word start, and never for an existing name, `[ ] | #` or a leading `^`.
  - The page lands in `LINKED_PAGE_FOLDER` as `# <title>` with a vault-unique stem, and the chip carries the stem written.
  - A failed create inserts nothing, restores the typing and toasts once. `]` closes the menu.
  - D18: the page opens from its chip and is a plain file. No Rust, mock or IPC change.
- **Packaged check:** in WebKit, `[[Launch notes` plus Enter on Create: the chip resolves, `launch-notes.md` lands at the root, and the Pages tree lists it. `mail ana@example.com` plus Enter makes nothing.
- **Wave** 1 · **Depends** M53.6, .10, .20, .31 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(editor): [[ and @ make the page they name and link it (M55.7)`.

### M55.8 Section links: `[[page#Heading]]` resolves, keeps its fragment, and lands on the heading

- **What:** `[[page#Heading]]` dangles. `resolveTarget` and `TargetIndex::resolve` match the whole string against stems, folders and titles, so the chip says "No page named …", backlinks drop the link, and nothing scrolls. The bytes already survive, since the chip keeps `page#Heading`. demo-vault holds no section links, so the golden doesn't move.
- **Files:** `src-tauri/fixtures/wikilink-targets.json` (new), `src-tauri/src/{vault/link.rs, mcp.rs}`, `src/engine/{wikilink,wikilink.test,links.test}.ts`, `src/editor/{DocOutline,chips,MarkdownEditor}.tsx`, `src/editor/{linkMenu.ts, linkMenu.test.tsx}` (.7's), `src/editor/{sectionLinks.ts, SectionFlash.tsx, sectionLinks.test.tsx}` (new), `src/editor/{editor.css, markdown.test.ts}`, `AGENTS.md`, `e2e/section-links.spec.ts` (new).
- **Approach:**
  - **One rule, two replayers** (D3). Read the whole target first; only when it holds a `#`, resolve the page before the first `#`. So nothing that resolves today changes, and `C# notes` stays a title link. `wikilink-targets.json` (prettier-formatted, no digest; the `source-slugs.json` precedent) holds the entries and cases; `section` is checked by TS only. wikilink.ts: `parseLinkTarget` and `resolveLink` (returns `{entry, section}`); `resolveTarget` becomes `resolveLink(…)?.entry`, so backlinks, relations, okf and agent context all read section links. link.rs: `resolve_name`, then `split_once('#')`, with no section accessor.
  - **K37 holds.** mcp.rs `self_anchor` also checks the page before the first `#`, so `about: [[gcs-5#Why]]` still refuses.
  - **The jump.** `sectionLinks.ts` (no BlockNote): a request registry (`requestSection`, `watchSections`; 10 s TTL; newest wins); `findSectionBlock`, depth-first through children, reading heading text through DocOutline's now-exported `inlineText`, normalized; `revealBlock`, which opens the closed toggles around the heading first (the .4 contract), then calls `scrollIntoView`, retrying per frame until the block mounts. `SectionFlash.tsx` portals a fixed overlay over the heading's content box (`section-flash`, 2 s, re-measured each frame, the trap-1 selector). It is never written onto ProseMirror's DOM (trap 2). `.cb-section-flash` has a reduced-motion rule.
  - **Editor.** MarkdownEditor watches its note path, toasts a missing heading and flashes a found one. linkMenu.ts's `readLinkQuery` page branch splits a section query (the .7 contract): rows insert `<stem>#<section>`, and `[[#X` offers this page's own `Title › X`. chips.tsx labels the chip `Title › Heading` (the alias first) with the title `path#section`. A click calls `requestSection` first, and skips `open()` for the same note. `toExternalHTML` and `wikilinkText` don't change, so the fragment stays on disk.
  - **AGENTS.md:** CV-09 gains the section sentence and two `enforced:` pointers, `src-tauri/src/vault/link.rs::replays_the_shared_target_cases` and `src/engine/wikilink.test.ts::replays the shared target cases`. parse.rs and mockParse don't change.
- **Comments to delete:** link.rs's TargetIndex, `resolve` and module docs ("three ordered passes", "Mirrors `resolveTarget`") name the section step and the fixture; wikilink.ts's `resolveTarget` docblock; `self_anchor`'s doc adds `[[stem#section]]`; chips.tsx's header table adds `[[target#section]]`; `readLinkQuery`'s doc gains the section split.
- **Tests:**
  - link.rs `replays_the_shared_target_cases`, `a_section_link_resolves_the_page_before_its_first_hash`, `a_whole_target_that_names_a_page_wins_over_its_hash`. mcp.rs: the self-anchor test gains `[[gcs-5#Why]]` and `[[GCS-5#Why|why]]`.
  - wikilink.test (a `parseLinkTarget` table, `resolveLink`, `C# notes` whole, the replay); links.test (backlinks and outgoing links read a section link); a markdown.test CORPUS entry holding `[[systems-map#Rollback]]`, its alias form and `[[#Rollback]]`, byte-stable over two saves.
  - linkMenu.test: `readLinkQuery`'s pure table gains the section-split rows (`[[systems#Rollback`, `[[#Rollback`).
  - sectionLinks.test: the registry (consumed once, TTL, unsubscribe); `findSectionBlock` (inside a column, normalized, first of two, paragraph and chip text ignored); rendered (the label; a same-page jump scrolls and flashes without navigating; a request made before mount is taken after load; a missing heading toasts; a cross-page chip navigates; `[[systems#Rollback` inserts `systems-map#Rollback`; the dangling label; flash cleanup under fake timers).
  - e2e section-links.spec: a long `strategy/systems-map.md` ending in `## Rollback`. The chip reads `Systems map › Rollback`, and an edit keeps `[[systems-map#Rollback]]` on disk. A click brings Rollback into view, with `section-flash` over its centre (geometry, trap 1), gone within 5 s. A heading inside a closed toggle is opened and reached.
- **Acceptance:**
  - Roadmap e2e: `[[page#Heading]]` lands on the heading.
  - The fragment stays on disk, byte-stable, through the unmount flush too.
  - Rust and TS read the whole target first, then the page before the first `#`, replaying one fixture.
  - The chip reads `Title › Heading`, and Backlinks lists a note that links into a section.
  - A missing heading opens the page at the top with a toast; `[[#Heading]]` jumps without navigating; a heading in a closed toggle is reached.
  - K37 holds, and typing `[[page#Heading` in the menu inserts `[[stem#Heading]]`.
- **Packaged check:** in WKWebView, a section chip to a long page lands on the heading, with the highlight fading over 2 s, and `[[#Heading]]` scrolls without leaving the page.
- **Wave** 6 · **Depends** M55.4, .7; M53.19 · **Size** M (roadmap S) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(editor): [[page#Heading]] resolves its page and lands on the heading (M55.8)`.

### M55.9 Open with: copy as prompt, copy path, Reveal in Finder, default editor, agent links

- **What:** DocPage's Page options menu has no copy, reveal or hand-off, and docs can't copy a path at all. No Rust command opens a file or a custom-scheme URL, and M53.12's guard refuses `codex://`, `cursor://` and `zed://`. WebKit ties clipboard writes to a user gesture, but the prompt is built after two awaits, so the packaged app copies through `/usr/bin/pbcopy`. The code says "agent links", because `hand_to` and `start_handoff_run` already mean agent-to-agent hand-offs.
- **Files:** `shared/policy/{agent-links.v1.json (new), README.md}`, `src-tauri/src/{shell/open.rs (new), shell/mod.rs, lib.rs, vault/write.rs}`, `src/lib/{ipc,ipc.test,ipcContract.test}.ts`, `src/engine/pagePrompt{,.test}.ts` (new), `src/app/OpenWithMenu{,.test}.tsx` (new), `src/pages/DocPage{,.test}.tsx`, `e2e/open-with.spec.ts` (new), `SECURITY.md`, `AGENTS.md`.
- **Approach:**
  - **Artifact.** `agent-links.v1.json` (no digest, the links.v1 precedent): format 1, `max_url_bytes` 8192 for the whole URL, four targets in menu order (Appendix B), and cases. The cases cover one exact URL per target, reserved characters, a newline, non-ASCII, the kept set, and the 8192/8193 boundary. Rust builds every URL; TS reads only ids and labels, so no rule is twinned. The README gets a files row.
  - **One door.** write.rs `existing_note(vault, rel)`: `note_join`, canonicalize, `is_file()`. Both read-only actions use it, so M53.4's refusals hold.
  - **`shell/open.rs`:**
    - a strict loader; `encode_component` is encodeURIComponent's set, so a space is `%20`; `agent_link_url` returns a URL or TooLong;
    - a `Desktop` seam (`open`, `copy`). `SystemDesktop` runs `/usr/bin/open` and `/usr/bin/pbcopy` through `spawn::command` (M53.10, .21), bounded at 10 s and 5 s and killed on timeout. pbcopy gets piped stdin and `LANG`/`LC_ALL=en_US.UTF-8`, because a Finder launch has no locale, and it refuses text that opens with `{\rtf` or `%!PS-Adobe`;
    - pure functions over the seam: `reveal_with` (`-R`), `open_default_with` (then `-t`, then "No app is set to open Markdown files"), `agent_link_with` (opened, too_long or no_app; too_long never spawns) and `copy_with`;
    - four async commands, registered in lib.rs.
  - **ipc.ts.** `canOpenOutside()`; `revealInFinder`, `openInDefaultApp` and `openAgentLink`, each rejecting "Desktop app only" in the browser; `writeClipboard`, through pbcopy in Tauri and `navigator.clipboard` in the browser. Literal names and object payloads behind `inTauri()` (M54.3). If M54.3's scanner can't follow `shell::open::…`, extend its resolver.
  - **Menu.** `engine/pagePrompt.ts` (Appendix B): title, vault-relative path (Q16), properties and relationships, body. It holds no absolute path and no Cerebro tool name, since outside clients can't reach the loopback tools. `OpenWithMenu.tsx` sits after `FavoriteStar` in DocPage's header: Copy as prompt (flush, read, build), Copy path, Reveal in Finder, Open in default editor (not on knowledge/, Q17), then "Hand off to" and the four targets. Toasts fire only after their await resolves. In the browser the desktop items are disabled with "Desktop app only". Nothing throws.
  - **Docs.** SECURITY.md: Open with opens only a vault note or one of the four agent-link bases, each through `/usr/bin/open` as one argument with no shell, and writes the clipboard through pbcopy. AGENTS.md: the `shell/` entry names open.rs, and the webview CV gains "agent links are a command, not a navigation, and open only the artifact's bases".
- **Comments to delete:** DocPage's "The toolbar is now menu + panel toggle." (name the star, Open with, the overflow menu and the panel toggle); the webview bullet's "everything else is refused" gains the agent-link sentence.
- **Tests:**
  - open.rs: `replays_the_agent_link_cases`, `the_agent_link_table_is_closed`, `encoding_is_encode_uri_component`; with a recording Desktop, `a_too_long_link_never_reaches_open`, `an_unknown_target_is_refused_before_anything_runs` and `a_link_nothing_opens_is_no_app`.
  - open.rs: `reveal_and_open_take_only_a_note_inside_the_vault` (refuses `../x.md`, `/etc/hosts`, `.git/config`, `notes/a.txt`, a folder, a missing note, `views/x.md` and a symlink out), `reveal_passes_dash_r_and_the_canonical_path`, `the_default_editor_falls_back_to_dash_t`, `the_clipboard_child_speaks_utf8` (built, never spawned), `rich_text_headers_are_refused`.
  - pagePrompt.test (shape; no block when empty; no absolute path; no manifest tool name; deterministic). OpenWithMenu.test (flush before read; no toast while a copy is pending; each outcome's toast; disabled in the browser; artifact order; knowledge hides the default editor). ipc.test, DocPage.test, and ipcContract.test with the four commands.
  - e2e open-with.spec (clipboard permissions): type, then at once Copy as prompt: "Prompt copied" shows, and the clipboard holds the typed line and the path. Copy path copies the path. The desktop items are disabled.
- **Acceptance:**
  - Roadmap: Open with offers Copy as prompt, Copy path, Reveal in Finder, Open in default editor, and hand-offs to Claude Code on the web, Codex, Cursor and Zed, copying instead when a link is too long. "Copied" shows only after the write resolves.
  - Every page DocPage opens has it, agents included; concept pages lack the default editor.
  - Copy as prompt includes text typed a moment before.
  - A link over 8192 bytes never reaches `open`, and a target nothing opens also falls back to copying.
  - Rust opens only a vault note and the four bases, and a refusal changes nothing on disk.
- **Packaged check** (a Finder-launched build): `café — 🚀` pastes intact; Reveal selects the file in Finder; the default app opens the note; each installed agent app opens with the prompt; claude.ai/code opens in the browser; a page over 8 KiB copies with the too-long toast; the header fits at the 900 px floor with the assistant open.
- **Wave** 5 · **Depends** M53.4, .6, .10, .12, .19–.21; M54.1, .3; lands after M55.12 · **Size** M (roadmap S) · **Crash risk** yes (two spawn sites; tests inject the seam) · **Packaged check** yes
- **Commit:** `feat(pages): Open with copies a page as a prompt, reveals it, and hands it to an agent app (M55.9)`.

### M55.10 Quit and close flush pending saves

- **What:** lib.rs sets no menu, so Tauri's default Quit sends `terminate:`, and tao 0.35.3 implements only `applicationWillTerminate:`, so ⌘Q goes straight to `RunEvent::Exit`. The close button reaches `CloseRequested`, but nothing prevents the close. Either way a page's 500 ms save debounce, and any field that commits on blur, are lost. M53.6's flush registry has no caller at exit.
- **Files:** `src-tauri/src/{shell/quit.rs (new), shell/mod.rs, lib.rs}`, `src/lib/{ipc,ipc.test,mockIpc,mockIpc.test,ipcContract.test}.ts`, `src/app/quit{,.test}.ts` (new), `src/app/QuitScreen.tsx` (new), `src/{App,App.test}.tsx`, `e2e/{quit.spec.ts (new), boot.ts}`, `AGENTS.md`, `README.md`.
- **Approach:**
  - **Gate.** `shell/quit.rs`: a pure `QuitGate` (Idle → Preparing → Exiting, with an epoch; a second ⌘Q waits; `ready`, `cancel`, `deadline(epoch)`) that recovers a poisoned lock (M54.6's pattern). `request(app)` emits `cerebro://quit-requested` with `{deadlineMs}` and starts `cerebro-quit-deadline`, which exits after `QUIT_DEADLINE` (5 s) if that epoch is still preparing. If the thread can't spawn, the app exits at once. Logs go through M53.24's macros.
  - **The limit,** in the module doc: Dock Quit, the app switcher's Q, logout, restart, shutdown and quit Apple Events send `terminate:` and exit unflushed. Patching tao's private delegate at runtime was considered and rejected. No window-builder type names appear in this file (M53.12's scan).
  - **Menu and close.** `app_menu` is Tauri 2.11.5's macOS default as a `MENU` spec table, with one change: "Quit Cerebro" (`cerebro-quit`, CmdOrCtrl+Q) calls `request`. The Edit items stay, because WKWebView needs them for the clipboard and undo keys. `build_main_window` attaches `CloseRequested` → `prevent_close()` and `request`. The commands are `finish_quit` (exits if ready) and `cancel_quit`. lib.rs manages `QuitState` and adds `.menu` and `.on_menu_event`; the `.run` closure stays.
  - **Page writes.** ipc.ts `pageWrite` wraps `saveNote`, `updateFrontmatter` and `setNoteTitle` in both branches. It tracks in-flight writes and counts failures, while callers see the same result. Also `settlePageWrites(budget)`, `listenQuitRequested`, `finishQuit` and `cancelQuit`. The mock adds `window.__cerebroMockQuit(deadlineMs)` and `__cerebroMockQuitLog`.
  - **Prepare.** `app/quit.ts` `prepareQuit` never rejects. Its budgets come from `deadlineMs` (50% flush, 15% settle, 15% leave), so no TS constant twins Rust's deadline. It blurs the focused field, waits a macrotask, runs `flushOpenPages`, and settles. A new failure without quit-anyway cancels with a toast (Appendix B). Otherwise `beginLeaving` unmounts the shell, so every page runs its own leave: MarkdownEditor's unmount flush, NoteBodyEditor's held save or open choice (writing yours), useDiagramFile and CodeOverlay. Then it settles again and calls `finishQuit`. A second quit within `QUIT_ANYWAY_MS` (30 s) closes anyway (Q18).
  - **App.** `useQuitHost()` goes right after `useTheme()`, above every early return, and `if (quitting) return <QuitScreen />` goes before `if (!vaultPath)`. QuitScreen ("Saving…", `quit-screen`) calls `markLeft()` on mount. ipcContract's EVENTS gains the event, and boot.ts declares the mock globals. AGENTS.md's `shell/` entry and a README "Saving" paragraph write the limit down.
- **Comments to delete:** `shell/mod.rs`'s module doc says the window carries only the link hooks; add the close guard. Checked and left alone: openPages.ts's "A turn flushes them all", NoteBodyEditor's registerFlush comment, CodeOverlay's orphan-timer note, useDiagramFile's unmount-flush note.
- **Tests:**
  - quit.rs: `a_quit_request_prepares_once`, `ready_exits_only_while_preparing`, `a_cancel_returns_to_idle_and_its_deadline_is_void`, `the_deadline_exits_only_its_own_attempt`, `the_request_names_its_deadline`, `the_menu_is_tauris_macos_default_with_our_quit`, `the_edit_menu_keeps_the_clipboard_keys`, `no_predefined_quit_is_built`, `the_quit_is_wired`. shell/mod.rs: `the_close_button_runs_the_quit_prepare`.
  - quit.test: the order blur → flush → settle → leave → settle → finish; budgets of 2500, 750 and 750 ms; a hung flush or write is cut off, and finish runs before 5000; a failure cancels; quit-anyway finishes; it never rejects; useQuitHost.
  - ipc.test (settle waits for in-flight and new writes; a rejection still reaches its caller and counts; a hung write returns false; the Tauri commands), mockIpc.test, App.test (`beginLeaving` shows `quit-screen`, unmounts the sidebar and resolves on mount), ipcContract.test.
  - e2e quit.spec: a line typed inside the debounce is absent at the evaluate's read; then the log reaches `finished`, `quit-screen` shows, and the file holds the line. An untitled heading typed without Enter or blur is on disk after quit.
- **Acceptance:**
  - Roadmap: ⌘Q 300 ms after typing keeps the edit (packaged), because a custom ⌘Q and `CloseRequested` run a bounded prepare before exit. Dock Quit and logout can't be intercepted, and that is written in quit.rs, AGENTS.md and README.
  - The close button and ⌘W keep the edit too, and a field still being typed is committed.
  - A page holding a save (an open choice or a held save) writes yours on quit, as leaving does.
  - A failed save keeps the app open with a toast, and a second quit within 30 s closes it.
  - No quit takes longer than the deadline plus M53.10's shutdown, and a hung webview can't keep the app open.
  - ⌘C, ⌘V, ⌘X, ⌘Z and ⌘A still work.
- **Packaged check** (a Finder-launched build): type `quit-probe-1` and press ⌘Q at once, then relaunch; the line is in the file. Repeat with the close button (`quit-probe-2`), ⌘W (`quit-probe-3`) and an untitled heading typed without Enter. Record whether Dock Quit right after typing loses text (expected: it can). Press ⌘C, ⌘V and ⌘Z in a page. The results go in the commit body.
- **Wave** 7 · **Depends** M55.6, .9; M53.6, .10, .12, .20, .21, .24; M54.3 · **Size** M · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(shell): quit and close save every pending edit first (M55.10)`.

### M55.11 Page icon and cover

- **What:** only Type docs and Collection pages read `icon:`, as a lucide name; every other surface draws a type glyph or `file-text`. Nothing reads a page's `cover:` (the gallery's `cover` is a view setting naming a files field). D18 asks for one anatomy.
- **Files:** `src/engine/{pageChrome,pageChrome.test}.ts` (new), `src/engine/{properties,properties.test}.ts`, `src/app/typeActions{,.test}.ts`, `src/components/PageIcon{,.test}.tsx` (new), `src/detail/PageChrome{,.test}.tsx` (new), `src/pages/DocPage{,.test}.tsx`, `src/detail/{DetailPanel,DetailPanel.test,DocPagesPanel,DocPagesPanel.test}.tsx`, `src/components/FileTree{,.test}.tsx`, `src/app/{QuickOpen,QuickOpen.test,Sidebar,Sidebar.test,CollectionTree}.tsx`, `src/lib/{mockIpc,mockIpc.test}.ts`, `src-tauri/src/vault/write.rs` (a test only), `e2e/page-icons.spec.ts` (new).
- **Approach:**
  - **Macro's EntityIcon, translated:** one resolver and one glyph that every row, crumb and card calls. Unlike Macro, a page's own value beats its type's, and the fallback is drawn, never stored.
  - **`engine/pageChrome.ts`** (pure, inside M53.20's allowlist): `PAGE_CHROME_KEYS = ['icon', 'cover']`. `pageIconOf` gives emoji (one grapheme holding a pictographic, regional-indicator or keycap code point, judged by `Intl.Segmenter` with a code-point fallback), file (a path, an http(s) URL or an extension), lucide (with `color:`), or null. `pageCoverOf` gives file, color(raw) (validated only at render), or null. It holds no writer.
  - **Hidden as data.** `isSystemProperty` also covers the chrome keys, so property rows, columns and adoption skip them. `cover` joins the `RESERVED` field names (`icon` is already there).
  - **Components.**
    - `PageIconGlyph` draws an emoji as text with role img; a file as the lucide `image` glyph titled with its path, never an `<img>` before M66.2 (the GalleryView rule); lucide colours through `resolveOptionColor`; null as the fallback. `EntryIcon` resolves an entry or a path.
    - `PageCoverBand` and `PageIconHeader` (page and peek variants) draw nothing when unset, and an always-mounted hover row offers Add icon and Add cover.
    - Pickers: an Emoji field and about 40 emoji written as `\u{…}` escapes; Upload through `pickFiles` and `importAttachment` when `canPickFiles()`; a vault-path field that refuses `..` and a leading `/`; the nine `PICKABLE_OPTION_COLORS`; Remove, which writes null.
    - Every write awaits `flushOpenPages()`, then calls `patchFrontmatter`. Opening a picker writes nothing. Nothing is editable under knowledge/ or on a read-only page.
  - **Placement.** DocPage: the band full-bleed atop the scroll container, the icon header above the title and outside the diff ternary, and crumbs that draw `EntryIcon` when an icon is set; agent pages (.12) included. DetailPanel's peek twin (M45.6). FileTree file and doc rows; DocPagesPanel rows, which are "its tab" (Q22); Sidebar favourites and Collections doc rows; QuickOpen note targets.
  - **Bytes.** write.rs gets one byte-stability test. mockIpc's `writeFrontmatter` drops an emptied mapping, as Rust's `serialize_mapping` does; today it leaves `---\n{}\n---\n`. demo-vault and the golden don't change.
- **Comments to delete:** `isSystemProperty`'s "App-managed frontmatter keys are `_`-prefixed (Tolaria's convention: … `_icon`)"; `RESERVED`'s docblock gains the chrome keys; FileTree's "M3: typed files carry their type's icon/color in the tree." (a page's own icon now comes first).
- **Tests:**
  - pageChrome.test (🚀, a ZWJ astronaut, a flag, a keycap and a VS16 heart accepted; two emoji refused; blank, number and array values null; files; a lucide colour; covers); properties.test (`icon`, `cover` and `_x` are system; `iconic` and `covers` are not); typeActions.test (`cover` refused as a field).
  - PageIcon.test (no `img` for a file; a `url(...)` colour renders neutral; a live store); PageChrome.test (no write on render; the grid writes 🚀; two emoji write nothing; Escape; Remove writes null; a registered flush runs before the patch; a swatch; no Add row under knowledge/; Upload hidden without `canPickFiles`; the path refusals).
  - DocPage, DetailPanel, FileTree, DocPagesPanel, QuickOpen (🚀, and the Delivery page's lucide rocket) and Sidebar tests. write.rs: `a_page_icon_and_cover_survive_another_keys_patch_byte_for_byte`. mockIpc.test: removing the last key leaves only the body, as Rust does.
  - e2e page-icons.spec, built through the tree's New folder and "New page in X" only, never the page menu: 🚀 on Checklist shows on the header, the tree row, the Pages panel row, the crumb and ⌘K. The file reads exactly `---\nicon: 🚀\n---\n# Checklist\n`, and Remove gives back exactly `# Checklist\n`. With 🚀 set again, a body edit keeps the block, Add cover Blue writes `cover: blue`, and opening and closing a picker changes no byte.
- **Acceptance:**
  - Roadmap: a page with `icon: 🚀` shows it in the tree, its tab, the breadcrumb and ⌘K, and its bytes round-trip.
  - The icon and cover show on the page and in the peek; a cover is one of nine colours or an attachment.
  - With nothing set the page draws nothing, and no placeholder is ever written; Remove deletes the key, and removing the last key drops the block, in Rust and the mock alike.
  - `icon` and `cover` never show as property rows, columns or adoption proposals, and no field may be named `cover`.
  - Attachments load nothing, and the CSP is untouched; a vault colour reaches CSS only through `resolveOptionColor`.
  - Type docs and Collections keep their lucide icons, now in ⌘K too. Under knowledge/, an icon shows but can't be set.
- **Packaged check:** in WKWebView, set an emoji icon (a ZWJ one too) and a colour cover on a page; check the header, the tree, the crumb, ⌘K and the file's bytes.
- **Wave** 6 · **Depends** M53.20; lands after M55.6 and .12 · **Size** L (roadmap S) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(pages): every page can carry its own icon and cover (M55.11)`.

### M55.12 Agents open as pages: instructions as body, grants as properties, Runs and Memory as tabs

- **What:** `useOpenPath` routes every Agent record to the Library, where AgentEditor edits it behind one Save. AgentsPage keeps a second per-agent page whose Edit points back at the Library. An agent that reached DocPage today would get the Info tab's generic property editor, with free-text edits on `scope:`, `tools:` and `schedule:`: M18's named hazard.
- **Files:** `src/stores/navStore{,.test}.ts`, `src/engine/{libraryDraft,libraryDraft.test,types}.ts`, `src/detail/{RecordTabs,RecordTabs.test,DocSidePanel}.tsx`, `src/pages/{DocPage,DocPage.test,AgentsPage,AgentsPage.test}.tsx`, `src/library/{LibraryPage,LibraryPage.test,AgentDossier,AgentDossier.test}.tsx`, `src/library/AgentEditor.tsx` → `AgentProperties.tsx` (git mv) and its test, `src/library/{AgentMemoryTab,AgentPage}{,.test}.tsx` (new), `src/status/AgentRunHistory{,.test}.tsx` (moved), `src/app/{useOpenPath.ts, useOpenPath.test.tsx, Sidebar.tsx, Sidebar.test.tsx}`, `e2e/{agents,agent,fleet}.spec.ts`, `AGENTS.md`.
- **Approach:**
  - **TS only:** no Rust, mock, policy or schema change, and AGENT_DOC_REFUSAL is untouched. From Macro's routine detail, take three behaviours: a settings view beside a history tab, nothing half-built ever written, and next-run words. Not its 300 ms autosave (Q23).
  - **Plumbing.** `navigate(target, {replace})` overwrites the current history slot, so a forwarding selection is never a step Back returns to. libraryDraft: `AgentKey`, `AGENT_KEYS` and `agentPatch(draft, keys)`, with today's value rules; `recent` and the body are never keys. `RecordTabs` without `onChange` is a fixed strip: no grip, menu, caret, rename, delete or + Tab, while arrows and onSelect stay. `RunHistory` moves unchanged to `status/AgentRunHistory.tsx`, keeping its testids.
  - **`AgentProperties.tsx`,** git-moved from AgentEditor, takes `vaultOptions` and the connector read from LibraryPage. Description commits on blur or Enter when changed. Every other row is a boundary row: Identity, Schedule, Triggers, Writes in, Reads, Tools, Connectors (as M54.9 left them) and Shell. Pressing one opens an editor in place under the row, seeded at that moment. It holds a local draft and writes only its keys on Done, staying open with the draft when the write returns `false`. Cancel and Escape discard (`useEscapeLayer`), and outside clicks and rescans touch nothing. The closed-row words reuse GrantsSummary's and M52.4's static text (the M53.5 precedent).
  - **Duty, memory, tabs.** `AgentDossier` becomes the duty bar on every tab: Paused, On duty, or "Off duty — nothing can fire it"; Pause/Resume writes `paused: true` or null; it reads only `fleetActorSummary`. `AgentMemoryTab` holds preferences (human-only, committed on blur), `recent` read-only (D7), and the concepts the agent wrote. `AgentPage.tsx` holds `AGENT_TABS` (Instructions, Runs, Memory), `agentTabOf` and `AgentPageBody`.
  - **Routing.**
    - DocPage's agent branch: the crumb root Agents opens `{kind:'agents'}`, with a bot icon and no folder crumbs. No Add page, Save as template or BlankPageBar. The editor shows only on Instructions, and tabs navigate to `{kind:'doc', path, tab}`.
    - DocSidePanel's Info shows a read-only `agent-info`, never DocProperties.
    - useOpenPath, the Library card, New (born paused), Sidebar rows and favourites all open `{kind:'doc', path}`. `{kind:'agents', actor}` with a record, and a stale `{library, tab:'agent', path}`, forward with `replace`.
    - AgentsPage keeps the lobby (the roster opens the Runs tab), construct pages and the absent state, and loses GrantRow, GrantsSummary, AgentKnowledge and the record branch. LibraryEditor loses its agent arm.
  - **AGENTS.md:** "**An agent is a page** (M55.12)" goes after the Knowledge bullet, and the shell paragraph's Agents rows open the agent's page. With Q23 at (a), the next free CV (Appendix B).
- **Comments to delete:**
  - LibraryPage's "Two states…" docblock and "## Why editing is explicit here, and only here": rewritten for skills and templates, and the agent rule moves to AgentProperties;
  - AgentsPage's docblock, "One editor, one save path", "one creator, one editor" (now "one creator"), the roster sentence, and GrantsSummary's docblock and "whatever the vault enabled" copy;
  - useOpenPath's M18 comment; AgentDossier's HISTORY docblock and "no runs yet" sentence; types.ts's "the release scout's triggers" example; libraryDraft's "Null = whatever the vault enabled", if M54.9 left it;
  - don't carry over AgentEditor's "Rewritten at the end of every run" or "Nothing yet — it has not run.", both false until M56.10.
- **Tests:**
  - navStore.test (replace gives `[A, C]`, and back lands on A); libraryDraft.test (each key alone; `recent`, memory and the body never written); RecordTabs.test (the fixed strip); AgentRunHistory.test (moved: hop indent, billing line, unavailable against empty, run detail); AgentDossier.test (the statuses; `data-on-duty` false when paused; Pause and Resume; only `fleetActorSummary`).
  - AgentProperties.test: a trigger writes nothing until Done, then exactly `{when:[…]}`; Cancel and Escape write nothing; each Done writes only its keys; `[]` against null; folders with counts; a read-only toolset; an unknown tool kept and flagged; `weekly fri 17:30`; both Schedule "none" phrasings; a refused write keeps the draft; a rescan keeps an open draft; connectors per M54.9; `recent` never written.
  - AgentMemoryTab.test; AgentPage.test; DocPage.test "an agent is a page (M55.12)" on `records/agents/release-scout.md`; AgentsPage.test (the roster opens the Runs tab; a forward keeps the history length; the construct page; a dangling actor); LibraryPage.test (the editor tests move out; a card opens the page; born paused; a stale path forwards; skills unchanged); useOpenPath.test; Sidebar.test.
  - e2e: agents.spec's two tests and agent.spec's four library-agent tests become agent-page tests, and the schedule edit writes `weekly fri 17:30`. fleet.spec passes on the Runs tab.
- **Acceptance:**
  - Roadmap: an Agent record opens as a page; editing its schedule property updates the record; its Runs tab lists its runs.
  - The Library card, the Sidebar row, ⌘K, a wikilink and `open_note` all open its DocPage. Forwards replace, so Back never bounces.
  - The body is the instructions, and body and property saves keep each other's bytes.
  - A grant row writes nothing until Done, then only its keys. `[]` stays apart from null, unknown tools survive, and `recent` is never written.
  - Pause and Resume work. Memory edits preferences, shows `recent` read-only and lists the agent's concepts.
  - Agent pages offer no Add page, Save as template, template bar or generic property editor, and the strip is fixed. Construct actors keep their history page.
  - AgentEditor.tsx is gone, and the governed-type tests stay green.
- **Owner look:** WebKit, the time input inside an inline editor in particular; e2e runs Chromium only.
- **Wave** 4 · **Depends** M53.5, .20; M54.2, .9 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(agents): an agent opens as a page, its grants as properties, Runs and Memory as tabs (M55.12)`.

### M55.13 Sub-pages: Add sub-page, a child-page list block, drag-to-nest

- **What:** the folder-note model exists (`docPages.ts`, FileTree's `promoteDocs`, DocPage's Add page), but six things are missing or wrong:
  - Add page on a page inside a doc adds a sibling, not a child;
  - a child that grew its own folder drops out of its parent's list;
  - there is no child-page list block, and a page row takes only before and after drops;
  - Move on a sub-page moves the whole doc;
  - the grow step renames the open file without landing its pending save;
  - crumbs show ancestor pages as folder names.
- **Files:** `src/engine/docPages{,.test}.ts`, `src/app/pageActions{,.test}.ts` (new), `src/stores/vaultStore.ts`, `src/pages/DocPage{,.test}.tsx`, `src/detail/DocPagesPanel{,.test}.tsx`, `src/components/FileTree{,.test}.tsx`, `src/editor/SubPageList{,.test}.tsx` (new), `src/editor/{blocks,blocks.test,MarkdownEditor,MarkdownEditor.test}.tsx`, `src/editor/{markdown,markdown.test,reconcile.test}.ts`, `e2e/{sub-pages.spec.ts (new), shell-layout.spec.ts}`.
- **Approach:**
  - **Model.** A page's sub-pages live in its folder: `plan/plan.md` is the page, and every doc and doc-folder note directly in `plan/` is a child. A plain page moves to `plan/plan.md` by rename on its first sub-page, so its bytes and stem links survive. Adding a sub-page never rewrites the parent (Q26).
  - **docPages.ts:**
    - `SUBPAGES_FENCE = 'cerebro-subpages'`, `isFolderNote`, `subPageFolder`;
    - `canHaveSubPages`: docs and records, never knowledge/, templates, Agent or Skill records, Type docs, Collections, `project.md` or `.mmd`;
    - `childPagesOf`: direct docs plus grown children's folder notes; `docPagesFor` becomes the main page plus its children; `descendantPageCount`;
    - `growPlan` refuses an existing same-name folder (Q27), a name the scanner hides, templates and knowledge/; `nestPlan` grows, then moves, and refuses self, its own subtree, an existing name and an existing child; `crumbTrail`.
  - **`app/pageActions.ts`,** human actions that catch, toast and return null: `addSubPage(parent, title)` and `nestPage(src, target)`. Each refuses across vaults (vaultStore's `refusedAcrossVaults`, exported unchanged, M53.30) and through `canHaveSubPages`, and awaits `flushOpenPages()` before any move. Then it applies the plan (`createFolder`, `renameNote`, `replacePath`), creates the child as `# <title>`, and rescans. A failure toasts and rescans.
  - **Surfaces.** DocPage: "Add page" becomes "Add sub-page" (copy in Appendix B), and so does the Pages panel's button (DocPagesPanel). Crumbs come from `crumbTrail`, a page crumb being a button with `EntryIcon`. Move takes the folder only for a folder note, and the delete count uses `descendantPageCount`. FileTree: a file row's middle half nests (before below 0.25, after above 0.75), plus a `+` button and an "Add sub-page" context item; "No extra pages" becomes "No sub-pages". "New page", "New folder" and "New page in X" stay, since .11's e2e uses them.
  - **Block.** `SubPagesBlock` (`content: 'none'`, rendering `SubPageList`; `toExternalHTML` is the empty fence, trap 5). `SubPageList` lists `childPagesOf` live and read-only, with `contentEditable={false}` and onClick only (trap 9). markdown.ts promotes an empty `cerebro-subpages` fence and demotes it without rendering (trap 10); a fence holding text stays code. `/Sub-pages` joins M53.31's builder beside Database.
- **Comments to delete:** docPages.ts's header ("an extra page (a Google-Docs-style tab)", "only becomes a folder when a second page is added"); DocPage's breadcrumb comment, the grow comment (with `submitAddPage`), the "multi-page doc — its pages show as tabs" copy and the toolbar's "'Add page' and 'Move to folder'" comment, plus DocPage.test's twin; DocPagesPanel's "multi-page docs" docblock (now a page and its sub-pages); FileTree's "No extra pages"; blocks.tsx's header list and the cerebroSchema comment gain the block.
- **Tests:**
  - docPages.test: children, grown ones included and records left out; the growPlan refusals, replaying `note-targets.json`'s hidden-name cases; nestPlan; crumbTrail; canHaveSubPages; grandchildren counted.
  - pageActions.test, over the mock fs: a grown page keeps its bytes; a folder note only creates; a registered flush runs before the rename; a refusal writes nothing; cross-vault refuses; nesting; a failed rename toasts and rescans; neither action throws.
  - FileTree.test (`fireDnd` at 0.5 nests, 0 and 1 reorder; a drop onto its own sub-page is refused; `+` and the menu); DocPage.test; DocPagesPanel.test (its "offers Add page" asserts Add sub-page); markdown.test (an OURS `subPages` fixture; the fence byte-stable; a text fence stays code); MarkdownEditor.test (`/Sub-pages`; the unmount flush saves the fence); SubPageList.test; blocks.test (the fence on the clipboard); reconcile.test (a write that misses the block keeps its id).
  - e2e sub-pages.spec: Add sub-page "Rollout checklist" on How we schedule leaves `delivery/how-we-schedule/how-we-schedule.md` byte-identical, creates the child and removes the old path. The Pages panel and the tree list it. `/Sub-pages` lists and opens it, and the file holds the empty fence. Going Home and back shows the same text (a reload would reset the mock fs). A dispatched drag of Systems map onto the middle of the Rollout checklist row nests it. shell-layout.spec clicks "Add sub-page".
- **Acceptance:**
  - Roadmap: Add sub-page creates a child, the parent lists it, and both survive a reload (the packaged check; a reload resets the mock fs).
  - A growing page is moved, not rewritten, after its pending save lands.
  - A child that grows its own folder stays listed in the Pages panel, the tree and the list block.
  - The block saves as an empty `cerebro-subpages` fence and lists children live, read-only.
  - A middle drop nests. A drop into the page's own subtree, onto an existing name or beside a same-name folder is refused, and nothing moves.
  - Move on a sub-page moves only that page and its own sub-pages, and crumbs walk the page tree.
  - Agents, skills, Type docs, Collections, templates and knowledge/ never grow.
- **Packaged check:** a real pointer drag in WKWebView nests a page (Playwright can't drive HTML5 drag, trap 6), and Add sub-page on an open page keeps text typed a moment before. Then add a sub-page and relaunch the app (or reload under `pnpm tauri dev`): both files exist, and the Pages panel, the tree and a `/Sub-pages` block list the child.
- **Wave** 7 · **Depends** M55.4, .6, .11, .12; M53.6, .30, .31 · **Size** L (roadmap S) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(pages): any page can add sub-pages, list them, and take a dropped page as a child (M55.13)`.

### M55.14 Page cards

- **What:** a page link is only an inline chip. The only pointer blocks are the database fence and mermaid.
- **Files:** `src/engine/pageCard{,.test}.ts` (new), `src/components/PageCard{,.test}.tsx` (new), `src/editor/{blocks,blocks.test,MarkdownEditor,MarkdownEditor.test}.tsx`, `src/editor/{markdown,markdown.test,reconcile.test,citationInput}.ts`, `src/editor/{pageCardInput.ts, pageCardInput.test.tsx}` (new), `e2e/page-cards.spec.ts` (new).
- **Approach:**
  - **Carrier,** after M47.2's database fence: a `cerebro-page` fence holding one `[[target]]` or `[[target|alias]]`, and an unset card is the empty fence. Both scanners read wikilinks inside fences, so backlinks count the card.
  - **`engine/pageCard.ts`,** pure: `PAGE_CARD_FENCE`, `PageRef`, `parsePageRef` (UNSET, one link, or null), `serializePageRef`, `pageLinkOf`, `resolvePageRef` through .8's `resolveLink`, `isLinkablePage` (an `.md` that is neither a Type doc nor a template), `linkTargetOf` (the stem) and `statusFieldOf` (the type's first status-kind field: a capability, never a type name). The `[[` menu's `isLinkableDoc` and its stem use them, so the menu and the picker offer the same pages.
  - **`PageCard.tsx`:** `ConnectedPageCard` (live entries, schema, `useOpenPath`) over a props-only `PageCardView` with three faces:
    - unset: a "Find a page" picker (containment, 50 rows);
    - resolved: `EntryIcon`, title, path or type, a status `FieldChip` when set, and Open;
    - missing: "No page named …"; Choose a page rewrites the pointer only on a pick.

    The root is `contentEditable={false}`, `page-card`, with `data-state` on our own element (trap 4), and uses onClick only (trap 9). No body and no editor inside (M29.48).
  - **Block and input.** `PageCardBlock` has props `target` and `alias`, and its `toExternalHTML` is the fence. markdown.ts promotes the fence (unset, one link, or else a code block) and demotes it exactly as held, never re-resolved, without rendering. `pageLinkPasteHandler` turns a lone pasted link into a card only on an empty, childless paragraph with no selection; otherwise `citationPasteHandler` runs, so a link pasted into text stays inline (Q29). `/Page` joins M53.31's builder, and `focusAiPrompt` becomes `focusBlockField(id, type)`, keeping both depth selectors (trap 1).
- **Comments to delete:** `citationPasteHandler`'s "The editor's paste handler (M52.4)" (it is now the citation half); the pasteHandler's M52.4 comment; the cerebroSchema comment and blocks.tsx's header list name the card.
- **Tests:**
  - pageCard.test (round trips; extra text or two links give null; the fragment is kept, and stripped on resolve; dangling; `statusFieldOf` finds a status field named `state` and gives null for a doc; linkability).
  - PageCard.test (the picker writes the stem; the resolved face shows the `icon:` emoji, the title and a record's status, with no chip for a doc; Open; the missing face never rewrites on render; no picker without onChange; no editor inside; a live title).
  - markdown.test (OURS set and unset fixtures; byte-stable set, aliased, unset and dangling; extra text stays code); blocks.test (copying puts the fence on the clipboard, never "Open"); pageCardInput.test (a lone `[[x]]` on an empty line becomes a card and saves as the fence; inside text it stays inline; a citation paste keeps its markers; a paste into a code block is BlockNote's); MarkdownEditor.test (`/Page`; the search field takes focus; the unmount flush saves the fence); reconcile.test (a write that misses the card keeps its id).
  - e2e page-cards.spec: How we schedule gets 🚀 through .11's picker. On another page, `/page` shows 🚀 and the title, and Open lands. A Work item card shows its status chip. A pasted `[[how-we-schedule]]` on an empty line becomes a card. The mock fs holds the fences. A seeded `[[no-such-page]]` shows the missing face and keeps its pointer through an unrelated save.
- **Acceptance:**
  - Roadmap: a `/page` card shows its target's icon and title.
  - A lone page link pasted on an empty line becomes the same card; pasted anywhere else it stays inline.
  - The card is live and read-only, opens with Open, and never embeds an editor (M29.48).
  - A record whose type has a status field shows its chip.
  - A missing target shows "No page named …" and keeps its pointer byte for byte.
  - The card saves as a `cerebro-page` fence holding one wikilink, so backlinks count it, and copying it copies the fence.
- **Wave** 8 · **Depends** M55.4, .6, .8, .11, .13; M53.31 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(editor): a /page card shows a linked page live, and a pasted page link becomes one (M55.14)`.

## Done or dropped

- **Done:** none. **Dropped:** none; all 14 scouted parts are "build".
- **Relabelled:** .1 is DATA-5's per-path-lock prerequisite. The roadmap's DATA-18 (the run's actor in `vault_writes`) belongs to M58.1 (Q1).
- **Beyond the roadmap, on purpose:**
  - .1 retires M54.6's `WRITE_SERIAL`, and .3 makes a hashed write a read.
  - .4 keeps `/table`, now with its header row, and carries Tab-nested children (`:::indent`).
  - .5 adds the `read_write` axis and the no-revert line.
  - .7 lets `]` close the link menu; .8 adds `[[#Heading]]` and keeps K37.
  - .9 copies through pbcopy; .10 replaces Tauri's default app menu.
  - .11 hides `icon` and `cover` from property rows and reserves `cover`.
  - .12 adds Pause/Resume and a fixed tab strip. .13 makes crumbs walk the page tree and Move on a sub-page move only it. .14 turns a lone pasted link into a card.
- **Not built here:**
  - the toolbar and block-menu actions that still lack carriers, and the bare-fence lock (Q7: a follow-up part right after .4);
  - word-level merge inside one block (Q13);
  - section jumps from chat, ConceptBody and the mermaid popover (.8);
  - moving the older copies (DetailHeaderActions, recordActions, mermaid's PNG) to `writeClipboard` (.9);
  - retrying a save that failed before quit, since MarkdownEditor marks text saved before the write lands (.10);
  - model and effort rows (M56.5, Q24), skills as pages (Q25), and a `/page` that creates a sub-page (Q28);
  - the ledger's relation resolver reading `[[c#x]]` (.8).

## Owner questions

Each default applies if unanswered.

| # | Part | Question | Default |
| --- | --- | --- | --- |
| Q1 | M55.1 | The roadmap labels .1 DATA-18, but DATA-18 records the run's actor in `vault_writes`, which M58.1's receipts cover. | Build the lock here, leave the actor to M58.1, and relabel the cell "DATA-5 (per-path locks)". |
| Q2 | M55.3 | Must a write that carries `expect_hash` also have read access to its target, so a write-only run can't use the hash to probe a file? | Yes. |
| Q3 | M55.4 | Carrier spellings, permanent once files hold them (Appendix A). | These. For headings the alternative is one name, `:::toggle` plus the heading line, ambiguous only for an empty toggle whose first child is a heading. |
| Q4 | M55.4 | A hand-written list item's continuation paragraph (Obsidian style) becomes `:::indent` on its next save. Accept, or build native continuation later? | Accept now. |
| Q5 | M55.4 | Carry image and video width as Obsidian's `![alt\|300](url)`? | Yes. With no, a resize is lost on save, as today. |
| Q6 | M55.4 | Run the carrier spec on Playwright WebKit too, locally and in CI (about a minute)? | Yes, for that spec only. |
| Q7 | M55.4 | Still without a carrier: underline, text colour and alignment; block colours; table header row and column. A bare code fence reopens as `javascript` and locks the page, and the read-only banner blames "raw HTML" whatever the cause. | One follow-up part right after .4 applies the same rule (a carrier, or off the menu) and fixes the fence. |
| Q8 | M55.5 | Quotes match the body's raw markdown as get_note prints it (`**bold**` with its stars); Macro anchors in rendered text. | Raw markdown: exact, with no text-to-markdown map. M70 can feed rendered text through the same resolver. |
| Q9 | M55.5 | Agents with no `allowed-tools:`, scheduled ones included, gain edit_note, so they can delete body text within scope, unrecoverably without git. Fail closed for unattended runs? | No: treat it like append_to_note, narrowed by scope and `allowed-tools:`. Revisit with M58's receipts. |
| Q10 | M55.5 | Should edit_note also edit `.mmd` diagram sources? | No; a later diagram part can, with its own checks. |
| Q11 | M55.6 | Add `prosemirror-history` (^1.5.0) as a direct dependency, only to call `closeHistory`? It is already installed as BlockNote's copy. | Yes. |
| Q12 | M55.6 | Leaving or quitting with a choice still open writes your version, as M53 Q5 does for the banner? | Yes. A git vault keeps the other version in history; a non-git vault loses it. |
| Q13 | M55.6 | Two edits to one block are one choice, even when they touch different words? | Yes: the block is the unit for now, and hunks.ts already diffs words for a later part. |
| Q14 | M55.6 | When you and the agent both add a block at the same spot, keep both, yours first, with no choice? | Yes. |
| Q15 | M55.7 | Where does a page made from `[[` or `@` land? | The vault root (`LINKED_PAGE_FOLDER = ''`), as New page does. Beside the current page needs exceptions, and as a sub-page waits on .13; either changes one constant. |
| Q16 | M55.9 | Should Copy as prompt carry the absolute path? | No: the Claude Code on the web link would put your home folder's name in a URL sent to claude.ai. |
| Q17 | M55.9 | Should knowledge/ pages offer Open in default editor? | No: the bundle is agent-written and human-verified, and an outside edit lands as a reconciliation. |
| Q18 | M55.10 | When a save fails during quit, stay open or close anyway? | Stay open with a toast; a second quit within 30 s closes. |
| Q19 | M55.10 | Ask before quitting while an agent run is live (CLIENT-DESKTOP-4 (e))? | No: M53.10 stops the run's group and books it cancelled. |
| Q20 | M55.11 | Should the page picker also offer lucide icons (Notion's Icons tab)? | No: pages get emoji and attachments, and lucide stays editable through "Customize icon & color…". |
| Q21 | M55.11 | Ship the Upload door now, though attachments show as named placeholders until M66.2? | Yes: the value round-trips and lights up with M66.4. |
| Q22 | M55.11 | With no tab strip before M65, does "its tab" mean the page's row in the Pages panel? | Yes; the window title is M59.1's. |
| Q23 | M55.12 | How do agent grants commit on a page? (a) Each grant row writes its key on Done, Escape discards, and prose saves like any page. (b) Macro-style autosave after 300 ms. (c) One page-level Save. | (a). A bare `{event: changed}` trigger is valid and fires on every change, so validity can't make an autosave safe. |
| Q24 | M55.12 | The roadmap lists `model` as an agent property, but nothing reads it until M56.5. | M56.5 adds the Model and Effort rows; .12 ships no model control. |
| Q25 | M55.12 | Move skills and templates to pages too? | No; they stay in the Library editor for now. |
| Q26 | M55.13 | Should Add sub-page also write a link or list block into the parent, as Notion does? | No: the parent stays byte-stable, and the Pages panel, the tree and the opt-in `/Sub-pages` block list its children. |
| Q27 | M55.13 | A same-name folder already beside the page (`plan.md` next to `plan/`): refuse to grow, or adopt its pages? | Refuse, naming the folder. |
| Q28 | M55.14 | Should `/page` also create a new sub-page and drop in its card, as Notion's does? | No, link only: creating a child moves the open page into a folder mid-edit, which needs its own part. |
| Q29 | M55.14 | A lone page link pasted on an empty line becomes a card; pasted into text it stays inline. OK? | Yes; ⌘Z restores the empty line. |

## Risks

- **Crash wedge.** .1 changes the write funnel and a crash child; .9 adds two spawn sites, with the seam injected in tests. Mac cargo keeps the skip list, and CI's Linux crash suite meets them on the pushes after waves 1 and 5.
- **jsdom is not WebKit** (the DOM traps). Carriers (.4), merge, caret and undo (.6), the link menus (.7), the scroll and flash (.8), emoji segmentation (.11) and the tree drag (.13) need a real browser. e2e runs Chromium (and WebKit for .4 with Q6); the packaged checks cover WKWebView.
- **Undo grouping.** ProseMirror merges adjacent steps made within 500 ms. .6 closes history before and after each apply through BlockNote's own copy of prosemirror-history. A bump that splits the two copies breaks grouping, and the MarkdownEditor undo tests fail.
- **.6 sits at the top of L.** If it outgrows L, cut the child recursion: blocks with children then merge whole, which costs false choices inside columns and nested lists. Planning is synchronous, so a very long page may hitch once per outside write.
- **Concurrency.** After .1, writes to different files overlap for the first time since M54.6. Knowledge writes still take turns in `shadow::with_writer`, and the registries and the sink keep their own mutexes. External writers never take the lock; .3's hash and .6's merge cover them. Lock waits have no timeout, and writers are short.
- **New destructive power** (.5): an agent can delete body text within its scope, unrecoverably without git (Q9). The `read_write` axis closes the read oracle, and a retried call that carries the hash can't apply twice.
- **Twin rules** (D3): the quote resolver (.5) and the section step (.8), each held by one case file. Rust offsets are bytes and TS offsets UTF-16, so the fixtures pin lines and code-point contexts only. M60.3's README ruling should list both.
- **Permanent formats:** .4's spellings (Q3), `icon:` and `cover:` (.11), and the `cerebro-subpages` and `cerebro-page` fences (.13, .14).
- **Outside formats** (.9): the deep-link formats belong to Anthropic, OpenAI, Anysphere and Zed and can change. claude.ai may refuse a long query under 8192 bytes, and the app can't tell.
- **Hot files** (the waves serialize them):

  | File | Parts |
  | --- | --- |
  | `vault/write.rs` | .1, .2, .3, .5, .9, .11 (test) |
  | mcp.rs | .1, .2, .3, .5, .8 |
  | MarkdownEditor.tsx | .4, .6, .7, .8, .13, .14 |
  | `editor/markdown.ts` | .4, .6, .13, .14 (its test also .8) |
  | AGENTS.md | .1, .3, .4, .8, .9, .10, .12 |
  | DocPage.tsx | .9, .11, .12, .13 |
  | DocPagesPanel.tsx | .11, .13 |
  | mockIpc.ts | .2, .3, .5, .10, .11 |
  | lib.rs, ipc.ts | .2, .9, .10 |
  | `shared/policy/README.md` | .3, .5, .9 |
  | `tools.v1.json` | .3, .5 |
  | SECURITY.md | .1, .3, .5, .9 |
  | mockAgent.ts, `agent-writes.spec.ts` | .5, .6 |
  | Sidebar.tsx | .11, .12 |
  | FileTree.tsx | .11, .13 |
  | blocks.tsx | .13, .14 |
  | `reconcile.test.ts` | .6, .13, .14 |
  | wikilink.ts, linkMenu.ts | .7, .8 |

- **Changes the owner will see:**
  - triggers stop firing on a touch, an identical re-save or a same-bytes checkout, and every demo-vault byte edit regenerates the golden (.2);
  - on its next save, a hand-written list continuation becomes `:::indent`, a list-item image becomes an empty item plus `:::indent`, and titles take `"…"`; toggles reopen closed (.4);
  - agents can edit page text in place, and records that list write tools by name don't gain edit_note (.5);
  - the banner is gone: outside writes merge in place, and only overlaps raise a choice bar (.6);
  - `[[` and `@` offer Create, and Enter on a lone Create row makes a page (.7);
  - DocPage's header gains Open with (.9), and Cerebro's own app menu replaces Tauri's default (.10);
  - pages show an icon and cover row on hover (.11);
  - agents open as pages, and the Library's agent editor is gone (.12);
  - Add page becomes Add sub-page, and a first sub-page moves its parent into a folder: stem links survive, but path-keyed things (`scope:`, `folder:`, saved filters, git history) see a rename (.13).
- **Left open on purpose:**
  - Dock Quit, the app switcher, logout and shutdown skip the flush (.10);
  - D2 keeps human saves last-write-wins, so a save between an agent write and its announcement still wins (.6);
  - the mock's agent writers skip the governed-type rule (M53.6's choice); Rust refuses (.5, .12);
  - a folder move races a write into that folder (.1);
  - relative media and attachment icons show as placeholders until M66 (.4, .11);
  - after an `:::indent`, other editors restart a numbered list, and a `/file` pointing at an image reopens as an image (.4);
  - in Tauri, a knowledge-path patch keeps a null hash until the next rescan (.2);
  - a card made from Copy link's `[[Title]]` goes missing when the title changes, and a card in a template links every page made from it (.14);
  - a sub-page slug can repeat a stem used elsewhere, and the Collections section shows a grown page as a plain folder (.13);
  - `templateFillPrompt` still says append_to_note, a follow-up under M54.7's typed fragments (.5);
  - the no-revert line shows on panel cards only, not in Fleet or the run log (.5).

## Gate

- **Each part,** before its commit:
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test:run`;
  - Rust parts (.1, .2, .3, .5, .8, .9, .10, and .11's one test) add `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the skip-listed `cargo test`;
  - e2e parts add `PORT=<free> pnpm e2e <spec>` once `lsof -iTCP:<port> -sTCP:LISTEN` shows the port free: .4 `editor-carriers`, .5 `agent-writes`, .6 `agent-edit` and `agent-writes`, .7 `create-link`, .8 `section-links`, .9 `open-with`, .10 `quit`, .11 `page-icons`, .12 `agents`, `agent` and `fleet`, .13 `sub-pages` and `shell-layout`, .14 `page-cards`.
- **Each wave tip:** the same gate on the branch, with the full e2e suite.
- **M55 closes when:**
  - the full gate passes on the tip, with `pnpm test:coverage` holding or raising every floor;
  - CI is green on the push, the Linux crash suite included;
  - every roadmap M55 acceptance bullet holds;
  - the owner has run the packaged checks (.4, .5, .6, .7, .8, .9, .10, .11, .13) on a `./scripts/mac-build.sh` build and the live checks (.1 in dev, .5 on the real CLI), and has looked at the built app, .12 in WebKit;
  - the roadmap's M55 status is updated, the .1 cell is relabelled (Q1), and the M56.5, .9, .10 and M63.3 cells that name AgentEditor point at AgentProperties, the duty bar and the Runs tab.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

## Appendix A — disk carriers (Q3)

| Block | On disk | Part |
| --- | --- | --- |
| Toggle list | `:::toggle <summary>`, the children, then the close | .4 |
| Toggle heading | `:::toggle-heading`, the heading line, the children, then the close | .4 |
| Nested children | `:::indent` right after the parent block, the children, then the close | .4 |
| Image, video, audio, file | `![name](url "caption")` on its own line; width as `name\|300` (image and video); the kind comes from the extension | .4 |
| Section link | `[[page#Heading]]`, or `[[#Heading]]` for this page | .8 |
| Page icon | frontmatter `icon:`, an emoji or an attachment path (lucide names stay on Type and Collection pages) | .11 |
| Page cover | frontmatter `cover:`, an attachment path or a colour name | .11 |
| Sub-page list | an empty `cerebro-subpages` fence | .13 |
| Page card | a `cerebro-page` fence holding one `[[target]]` or `[[target\|alias]]`; empty when unset | .14 |

- Colons grow by one per level of nesting (`containerColons`, shared with `:::columns` and `:::ai`), and the close repeats its opener's colons.
- `isLossyImport` ignores only the container names; every word inside a carrier still counts.

## Appendix B — text the model or the owner reads

Review these before each part lands.

**M55.1, AGENTS.md (next free CV):**

> **One writer per file.** A write that reads its file first holds that file's path lock from the read to the rename (`rewrite_note`, or `lock_paths` for a create, copy or move). A check judges the bytes the lock holds, never an earlier read.
> `enforced: src-tauri/src/vault/write.rs::two_writes_to_one_note_take_turns`

**M55.3, the refusals:**

- Stale: "stale_content: <path> changed since you read it, so nothing was written. Read it again with get_note and decide whether your change still applies."
- Malformed: "expect_hash must be the 64-character hash from get_note's Hash line"
- The property's description (update_frontmatter, append_to_note, edit_note): "The hash from get_note's Hash line for this note. If the note has changed since, nothing is written."

**M55.3, AGENTS.md (next free CV):**

> **Agent writes compare; human saves win (D2).** An agent's note write may carry `expect_hash` (get_note's Hash line) and lands only on those exact bytes; otherwise it is refused as `stale_content` (operational) and nothing is written. Human saves never compare: the last write wins. The ledger's `expected_version` and `stale_target_version` guard a different record, and neither is borrowed for the other.
> `enforced: src-tauri/src/mcp.rs::a_stale_expect_hash_is_refused_and_leaves_the_file_alone`

**M55.4, AGENTS.md (next free CV):**

> **Every block the editor offers has a disk carrier, or it is not offered.**
> `enforced: src/editor/markdown.test.ts::every / item survives a save or is not offered`

**M55.5, the manifest row:** surface base · title "Edit text in a note" · summary "Replace quoted text in a note, in place" · toolset write · kind destructive · idempotent false · door note · axis read_write · target path → note · renderer change · icon `replace` · always_load false · search hint "replace quoted text in a note". Schema: `path` (string); `edits` (an array of objects with `old` and `new` strings and an `occurrence` integer; `old` and `new` required); `expect_hash` (string). Required: `path` and `edits`. If `every_served_tool_is_valid_api_input` rejects a keyword, drop the keyword: the code checks every limit anyway.

**M55.5, the description (exact):**

> Change text that is already in a note, in place. Each edit replaces one passage: put the passage in `old`, quoted exactly as get_note shows the note's body (same spacing, line breaks and markdown), and the markdown that replaces it in `new`; an empty `new` deletes the passage. If `old` appears more than once, nothing is written and the reply lists each appearance with its line: pass `occurrence` (counting from 1) or quote a longer passage. Every edit is matched against the note as it is now, they all land together or none do, and nothing you did not quote changes. Lines that start with `:::` and fences named `cerebro-…` hold page blocks; keep each one whole. The frontmatter is not edited here; use update_frontmatter. Pass the hash from get_note's `Hash:` line as `expect_hash`: if the note changed since you read it, nothing is written and you should read it again. knowledge/ concepts, `type: Type` docs and `type: Agent` records are refused, and the run needs read access to the note as well as write access.

**M55.5, the quote refusals** (exact, pinned by `quote-cases.json`). Lines join with a newline, and every refusal ends with a newline and "Nothing was written.":

- "edit_note needs at least one edit."
- "edit_note takes at most 100 edits in one call; this call has {n}."
- "Edit {i}: `old` is empty — quote the text to replace."
- "Edit {i}: `new` is the same as `old`, so it changes nothing."
- "Edit {i}: `occurrence` counts from 1."
- "Edit {i}: the quoted text is not in the note's body. Quote it exactly as get_note shows it, spacing, line breaks and markdown included, or read the note again if it may have changed."
- "Edit {i}: the quoted text is in the frontmatter, which edit_note never changes. Use update_frontmatter for properties."
- "Edit {i}: the quoted text appears {n} times. Pass `occurrence` (counting from 1) or quote a longer passage:"
- "Edit {i}: `occurrence` is {k}, but the quoted text appears {n} time(s):", with "time" for 1.
- "Edits {i} and {j} overlap at line {L}; each edit must replace a passage of its own."
- The listing: "  {k}. line {L}: {context}", at most 20, then "  … and {rest} more". The context runs from 40 code points before the match to 40 after it (the match itself capped at 80), with "…" at each cut end, JSON-escaped.
- The tool's own: "edit_note needs a path", "edit_note needs `edits`, a list of {old, new} replacements", "Edit {i}: `old` and `new` must both be strings", "no note at {path}".

**M55.5, the report:** "Edited {path}: {n} edit(s); nothing outside the quoted text changed.", then "  {i}. now at line {L}" per edit, then `Hash: <hex>`.

**M55.5, the UI:** `action-no-revert`: "Cerebro found no git history for this vault, so it can't revert this change." The mock agent: "I edited {path}." · "I could not edit {path}: {refusal}" · "edit_note is not available here".

**M55.6, the merge bar** (`merge-choices`, role group, aria-label "Choose a version"):

- Lead: "This page changed while you were editing. Where you both changed the same part, choose which to keep. Nothing saves until you do."
- Each row (`merge-choice`): "Yours" and "New" previews, cut at 200 characters, "(removed)" when empty. Buttons: "Keep yours" (`merge-keep-mine`), "Use new" (`merge-take-theirs`), "Show" (`merge-show`).
- A failed read: "Couldn't reload page".

**M55.7:** the row `Create "<title>"`, with subtext and group "New page". Toasts: "Couldn't create the page" and `Couldn't link "<title>"`.

**M55.8:** the chip `Title › Heading`; dangling, `No page named "<page>"`; the toast `No heading named "<section>" on this page`.

**M55.9, `agent-links.v1.json` targets,** in menu order, with `max_url_bytes` 8192 (Macro's shipped formats):

| id | Label | Base | Param |
| --- | --- | --- | --- |
| `claude-code-web` | Claude Code on the web | `https://claude.ai/code` | `q` |
| `codex` | Codex | `codex://new` | `prompt` |
| `cursor` | Cursor | `cursor://anysphere.cursor-deeplink/prompt` | `text` |
| `zed` | Zed | `zed://agent` | `prompt` |

**M55.9, the prompt.** The `<properties>` block is left out when there are neither properties nor relationships.

```text
Use this page from my Cerebro notes as context.

Title: <title>
Path: <vault-relative path>

<properties>
<the properties as YAML, then the relationships as [[target]] lists>
</properties>

<page>
<the trimmed body, or "(This page is empty.)">
</page>
```

**M55.9, toasts:** "Prompt copied" / "Couldn't copy the prompt" · "Path copied" / "Couldn't copy the path" · too long: "Too long for a link, so the prompt is copied. Paste it into {label}." · no app: "{label} didn't open, so the prompt is copied." · both failed: "Couldn't open {label} or copy the prompt." · disabled: "Desktop app only" · Rust: "No app is set to open Markdown files", "{rel} is not a file in the vault".

**M55.10:** the menu item "Quit Cerebro"; the screen "Saving…"; the stay toast "A page couldn't save, so Cerebro stayed open. Quit again to close anyway." README's "Saving" paragraph: ⌘Q, the close button and ⌘W save every pending edit first; Dock Quit, logout, restart and shutdown can't be intercepted, so give a page a moment after the last keystroke.

**M55.11:** "Add icon" (`page-add-icon`), "Add cover" (`page-add-cover`), the "Emoji" field and its ⌃⌘Space hint, "Choose an image…", "Vault path", "Remove".

**M55.12:**

- The duty bar: "Paused", "On duty", "Off duty — nothing can fire it".
- The Schedule row: "none — its triggers fire it", "none — off duty, runs only when you ask".
- Memory: "What the agent keeps between runs. Read-only here: saving over it would erase what a run learned." and "Nothing kept yet."
- The Info tab: "Answers to @<handle>; writes as process:<handle>" and "Its settings are this page's properties".
- AGENTS.md, with Q23 at (a), the next free CV: **Agent grants write on Done, never per keystroke.** `enforced: src/library/AgentProperties.test.tsx`

**M55.13:** the dialog "Add sub-page", placeholder "Page name", then either `"<title>" moves into a folder of its own. Its text does not change.` or `Adds a page inside "<title>".` The tree: "Add a sub-page to <label>", "No sub-pages". The block: "Sub-pages show on a saved page." and "No sub-pages yet — add one from the page menu." The toast: "Couldn't add sub-page".

**M55.14:** "Find a page", "N more — keep typing", "No page chosen", `No page named "<target>"`, "Choose a page", "Open".
