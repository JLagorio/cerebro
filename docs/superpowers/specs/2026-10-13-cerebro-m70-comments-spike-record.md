# M70.1 comments spike record — BlockNote 0.46.2

Written by M70.1 on 2026-10-14. It says what the spike measured about BlockNote's own comments
extension, which route Cerebro takes, where a page's threads live, which text an anchor quotes,
and the editor API M70.2b wires. Every fact cites a passing test.

## Setup

- **Library:** `@blocknote/core` 0.46.2. `CommentsExtension` (MPL-2.0) from
  `@blocknote/core/comments`, unused by the app before this spike.
- **Harness:** vitest in jsdom. The editor has the app's schema (`cerebroSchema`) and is mounted on
  a bare element with no React: a headless BlockNote editor holds no ProseMirror plugins until it
  mounts, so a plugin's state is only there once it does. The extension runs on
  `MemoryThreadStore`, a `ThreadStore` in memory with no Yjs and no `addThreadToDocument`, so the
  extension marks the selection itself; `resolveUsers` returns `[]`.
- **Machine:** macOS 15.7.9 on arm64, Node 26.3.1. Browser checks: Playwright Chromium on the mock
  backend (`e2e/comment-anchors.spec.ts`).

## Facts

| # | Claim | Test |
| --- | --- | --- |
| F1 | Upstream comment marks are `blocknoteIgnore`, so markdown export skips them | `src/editor/commentSpike.test.ts` › F1 |
| F2 | Creating a thread adds an undo step, and undo removes the mark | `commentSpike.test.ts` › F2 |
| F3 | Resolving flips `orphan` in a doc-changing transaction that adds an undo step and fires onChange | `commentSpike.test.ts` › F3 |
| F4 | A commented span's clipboard HTML carries `data-bn-thread-id` | `commentSpike.test.ts` › F4 |
| F5 | The extension runs on a ThreadStore with no Yjs | `commentSpike.test.ts` › F5 |

What the decorations route holds instead, each a test:

| Claim | Test |
| --- | --- |
| Drawing, restyling and clearing highlights keeps `state.doc` and the undo depth, and fires no onChange | `src/editor/commentHighlights.test.ts` › keeps the document and its undo depth… |
| No onChange or onDirty past the debounce; undo takes back typing, never a highlight; the unmount flush writes nothing | `src/editor/MarkdownEditor.test.tsx` › comment highlights stay out of the save (M70.1) |
| A `.cb-comment` span renders in BlockNote's view, so the app and BlockNote share one prosemirror-view | `MarkdownEditor.test.tsx` › draws a .cb-comment span… |
| In Chromium the bytes equal the seed 800 ms after drawing and after ⌘Z; occurrence 2 of a repeated phrase; a reopen redraws the same; a copy typed above keeps the highlight; a deleted quote reads gone within 1 s | `e2e/comment-anchors.spec.ts` |
| An outside write (M55.6) that rewrites the quote detaches after `RESOLVE_DELAY_MS`; one elsewhere keeps it | `MarkdownEditor.test.tsx` › detaches… / keeps… |

## Measurements (no assertion)

- **Built chunks.** `vite build`, with and without `extensions: [CommentHighlights()]` in
  `MarkdownEditor.tsx`. Both builds hold `Yjs was already imported` and `bn-thread-mark` in the
  editor chunk, and only there: `@blocknote/react`'s default UI imports the comments code whatever
  the app does. Before: `MarkdownEditor-*.js` 1,300,057 B (399,615 B gzip). After: 1,305,847 B
  (401,966 B gzip), +5,790 B (+2,351 B gzip). The route adds no Yjs and no y-prosemirror.
- **Dependencies.** `prosemirror-state ^1.4.4` and `prosemirror-view ^1.41.4`, BlockNote's own
  ranges, became direct dependencies. The lockfile still holds one copy of each (1.4.4 and 1.42.2).
  A second copy would make our `DecorationSet` foreign to BlockNote's view and the highlights would
  vanish with no error; the rendered-span test above fails first.
- **Resolution cost.** `resolveNow` on a 2,000-paragraph page with 50 anchors, jsdom, median of
  repeated runs: 3.7 ms with 50 distinct quotes; 10.4 ms when every quote is a phrase on all 2,000
  paragraphs and each anchor still holds its stored context; 27.6 ms in that page after an edit
  above every anchor, so each scores all 2,000 candidates. Reading the page's reader text: 1.1 ms.
  Contexts and scores read the page in place (no prefix copy per candidate); before that change the
  last case was 320 ms.

## Decision

The rule, fixed before measuring: adopt `CommentsExtension` only if F2, F3 and F4 are all false.
All three are true. **Cerebro draws comments as hand-built ProseMirror decorations**
(`src/editor/commentHighlights.ts`). No production file imports `@blocknote/core/comments`:
`eslint.config.js` bans it everywhere in `src/` but `commentSpike.test.ts`, and
`scripts/lint-rails.test.ts` proves the rail. A BlockNote bump that flips F1–F4 fails the spike
test; revisit this decision then. If a bump makes F2–F4 all false, M70.2b may swap
CommentHighlights for `CommentsExtension` plus a sidecar `ThreadStore`; the store, IPC and panel
stay.

## Where threads live

`<vault>/.comments/<page path>.json`, tracked by git (Q1's default): comments are content, a
delete is recoverable, and a pushed vault shares its comments. Rejected:

- `.cerebro/`: gitignored, because it holds credentials; comments would never travel.
- app data: leaves the vault, so a vault moved or cloned loses its threads.
- a sibling file beside each page: clutters the tree, Finder and every folder listing.

## Anchor space

Anchors quote the page's **reader text** (Q2's default): every textblock in document order, code
blocks left out, joined by `\n`; a hard break is `\n`; a chip is an atom spelled as the file spells
it (`chipText`), so a quote across a chip reads `[[kickoff]]`; atom blocks add nothing
(`src/editor/readerText.ts`). Agents quote plain words as get_note prints them, which reads the same
in both; M70.3 refuses an agent quote holding markdown syntax rather than building a Rust
reader-text projection held by goldens generated from `readerText`.

## Resolution rule and limits

An anchor is `{quote, occurrence, before, after}` (`src/engine/commentAnchor.ts`). The quote is at
most 1000 code points and each context at most 40, cut in code points, never inside a surrogate pair
or a chip. A valid match is one of M55.5's finder matches (`occurrencesOf`, exported from
`src/engine/quote.ts` unchanged) that lies inside one block and neither starts nor ends inside a
chip. `anchorAt` widens a range over any chip it splits, trims its edges, refuses `empty` and
`spans_blocks`, and numbers the occurrence among the valid matches. `resolveAnchor`, in order:

1. no valid match: detached, `gone`;
2. the stored occurrence, if its context is identical;
3. if the best context score (common suffix with `before` plus common prefix with `after`, in code
   points) is under half the code points of `before` and `after`, detached, `gone`;
4. the best score, if exactly one match holds it;
5. the stored occurrence, if it is among the best;
6. otherwise detached, `ambiguous`, with how many share the best.

`moved` is true when the match is not the stored occurrence. The result is deterministic.

Step 3 is the floor M70's review added: without it, deleting a quoted sentence moved the thread to
any other copy of the quote on the page (commenting on "the plan" in one sentence and deleting it
landed the thread on "Nobody liked the plan", with `moved: false`). A copy that shares a space or
two of context is not the quote.

**Limit.** Context cannot see past one case: when the quoted block is deleted and the block just
before it ends in another copy, that copy inherits the deleted quote's context after. If that side
is at least half the stored context, the thread attaches there (`moved: true` when the occurrence
shifted). `Owner: TBD.` / `Deadline: TBD.` / `Notes follow here.` with the deadline's TBD quoted and
its line deleted lands on the owner's TBD (pinned in `commentAnchor.test.ts` as a limit). On a short
page, where the context after is a period, it reads gone. Only a stored count of copies or a
position could tell the two apart, and an anchor holds neither.

## The API M70.2b wires

`CommentHighlights` (`createExtension`, key `cerebroCommentHighlights`), registered by
`MarkdownEditor` and read with `editor.getExtension(CommentHighlights)`:

- `setThreads([{id, anchor}])` draws them all (replacing what was drawn) and resolves them;
- `setActive(id | null)` restyles one as active (`cb-comment-active`);
- `setPending(anchor | null)` draws the text a comment is being written on (`cb-comment-pending`);
- `anchorSelection()` returns the selection as an anchor, or `empty`, `spans_blocks` or
  `outside_text` (a selection in code);
- `reveal(id)` scrolls a drawn thread into view;
- `onSelect(cb)` hands a click the narrowest thread under it and lets the click through;
- `resolveNow()`, and `store.state.resolutions`: a `Map` by thread id. An id not in the map is
  unknown, never detached.

Every dispatch is a transaction with no steps and only the plugin's meta. Between resolves the
decorations map through each edit; the plugin view resolves again `RESOLVE_DELAY_MS` (200 ms) after
the last doc change, never while composing. In browser mode only, the last mounted editor sets
`window.__cerebroCommentProbe {anchor(), show(threads), resolutions()}` and removes it on unmount
(M55.6's seam precedent; typed in `e2e/boot.ts`).

**Measured in the browser:** ProseMirror reads a keyboard selection from the DOM on
`selectionchange`, so a burst of Shift+Arrow keys can leave the editor's selection behind the
browser's. The spec waits a frame per key and polls the anchor; a Comment button clicked by a person
reads a settled selection.
