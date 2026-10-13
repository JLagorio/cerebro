# M52 — Build it all

The owner, 2026-09-29, after M51: "build it all here uncommit so I can review."

M52 closes the gaps M51 left open, and fixes whatever a fresh audit still finds hard to follow. It sits in the main checkout on `m49-knowledge-integrity`, uncommitted and unstaged, on top of the staged M49 and M50 work.

## Parts

| Part | What | Status |
| --- | --- | --- |
| M52.1 | Editor: citations you can type, citations inside emphasis, a concept body you can read | built — emphasis case deferred (below) |
| M52.2 | Review cards a person can read; a proposal shown on the concept it would change | built |
| M52.3 | Fixes from the UI audit | built — 23 of 24 fixed in part or whole |
| M52.4 | Independent review of the M52 diff, then all test suites | built — 41 findings fixed; all gates green |

### M52.1 Editor (`src/editor/**` only)

- **Type a citation:**
  - Typing `[^` opens a menu of the page's sources, showing the number and title (the same numbering as the Sources list), plus any footnotes already in the document. Picking one inserts a numbered citation.
  - A hand-typed `[^id]` becomes a chip the moment `]` is typed, with no reload — at a line start too, where a following `:` turns it into a definition (M52.4). Never inside code, styled text, or an unclosed backtick or emphasis run on the line.
  - A pasted `[^id]` and its `[^id]: …` definition keep their bytes (M52.4: paste used to bypass the M50 footnote protection and write a `## Footnotes` list). Pasted markers stay text until the next load.
- **Citations inside bold or italic** render as the same number, and the file bytes don't change. The approach is chosen by measurement: either a chip that keeps the emphasis, or a visual-only decoration over the text. If neither survives a round trip unchanged, it stays as text and the measured reason goes in the code.
- **A concept body you can read:**
  - In concept pages only, headings get space above them; ordinary docs don't change.
  - Footnote definitions at the end render as a quiet, smaller sources list.
  - Both are checked in a real browser, not only in unit tests.
- **Nothing regresses:**
  - wikilink, assignee and due chips;
  - the unmount save;
  - tables and columns;
  - the M50 footnote protection;
  - byte-identical, stable round trips on real concepts.

### M52.2 Review (`NeedsYouSection`, `ConceptReviewBar`, `ReviewQueue`, the Review tab, their specs)

- **Readable cards:**
  - The title is in the app's words ("Revise *Offline guarantee*", "Retire *Webinar attendance*"), followed by who proposed it and the reason.
  - Risk is a small chip. Why it waits and what changed underneath are plain sentences.
  - The raw codes (`update_belief`, `high_stakes_verification_required`, `ReversibleWork`, `@3 → 4`) stay in a details disclosure or tooltip, because they are what the ledger recorded.
  - Existing wording from the policy table or Rust is used where it exists; otherwise these are UI labels, and `shared/policy/*` is not edited. Every card testid stays.
- **A proposal on its concept:**
  - When an agent's pending change targets a concept, its page says so in the review bar, with Approve and Reject (a reason is required) on the same card component as Review.
  - The concept's row in the Review queue says so too.
  - The data comes from `ipc.reviewQueue` through a hook with loading / unavailable / ready states. A failed read shows nothing on the concept page, and Review keeps its "could not be read" line.
- **Checks:**
  - `CardTarget.path` agrees between Rust and the mock (vault-relative vs knowledge-relative).
  - A new e2e test: open a concept the demo proposes to change, approve the change there, and see it leave Review.

### M52.3 Audit fixes

- A read-only walk in a real browser, light and dark, of:
  - Knowledge's three tabs;
  - five concept pages;
  - docs and records that Knowledge covers;
  - Agents and run details;
  - the AI panel on concepts and docs;
  - Home and Inbox, where they show knowledge.
- **What it looks for:**
  - competing navigation;
  - jargon, raw paths and ids;
  - dead ends;
  - the same thing under different names;
  - cramped or wasted layout;
  - classes outside the design tokens;
  - dark-mode contrast;
  - counts that disagree;
  - empty states that are wrong;
  - broken links between agents, concepts, docs and the AI panel.
- Each finding needs evidence (a screenshot or a file and line) and a concrete fix.
- A planner re-checks each finding against the code, drops the weak ones with a reason, and splits the rest into at most three groups that touch separate files. The groups are fixed in parallel, with tests and a screenshot check.
- **Outcome of M52.1 on the emphasis case:** measured, and deferred. A chip inside `*…*` loses its mark in the block data the saver reads (`*a claim*[^id]`); a drawn-over number needs `prosemirror-view` as a direct dependency. The citation stays raw text there, bytes untouched, reason written in `markdown.ts`. M52.4 found the same loss for EVERY chip (a pre-M52 bug: `**[[kickoff]]**` saved as `[[kickoff]]`), so no chip is read out of styled text any more.

#### Audit findings (24; screenshots in the session scratchpad)

| ID | Sev | Finding | Outcome |
| --- | --- | --- | --- |
| A01 | high | Every "ask about this concept" sent the stale-only recheck prompt ("its recheck date has passed"); the chat bubble showed the raw prompt | Fixed: `conceptAsk` picks recheck vs revise; bubble reads "Ask to revise · ‹title›" |
| A02 | high | Three stories of who wrote Knowledge (page byline, agent page "no runs", "Written by Assistant") | Fixed in the demo: two concepts and `run-ingest-2` are `process:knowledge` |
| A03 | high | Dark mode `cortex-600` links at 2.39:1 | Fixed: dark `--cortex-600: #7d93f0`; the two filled buttons use `bg-accent hover:bg-accent-hover` (M52.4 fixed their dark hover) |
| A04 | med | Fleet, filter and run detail showed raw actor ids | Fixed: `actorLabel` in `engine/authors.ts`, proposal cards included (M52.4) |
| A05 | med | Peek and page panel showed different Knowledge anatomies, two Learn buttons | Fixed: one `PageKnowledge` in both |
| A06 | med | Strip counted learned-from concepts; the AI snapshot did not | Fixed: `knowledgeOf` feeds both |
| A07 | med | Mock assistant claimed a write to a nonexistent `x.md` for any knowledge prompt | Fixed: intent branches, no fake writes |
| A08 | med | A stale concept a person verified could never leave the queue | Fixed: leaves once verified after `stale_after`; recheck is the primary button |
| A09 | med | A replaced concept offered Verify | Fixed: "Replaced" chip + "Open ‹newer›" |
| A10 | med | Sidebar never showed where you are in Knowledge | Partly: a concept lights its folder row. No "All concepts" row (contradicts the M51 decision) |
| A11 | med | Activity printed ids and paths | Fixed: concept titles as links. M52.4: Rust `ChangeLine` gained `path`, since real entity ids are hashes, not file names |
| A12 | med | Lane words differed between Rust and the mock, and said "base"/"beliefs" | Fixed in `status.rs` + `demoLanes`; change-section labels too (M52.4) |
| A13 | med | Same act, many labels | Fixed: each label defined once in `lib/prompts.ts` |
| A14 | med | Agent charter lists broke at continuation lines | Fixed in `ConceptBody` |
| A15 | med | People shown as slugs | Partly: names link to the person; the review chip still says "by a person" |
| A16 | low | Two context chips for the same page | Fixed |
| A17 | low | "Maintained by Knowledge" | Fixed: agent titled "Knowledge agent" |
| A18 | low | Stale/Replaced each had several names | Fixed: "Due a recheck", "Replaced" |
| A19 | low | Strip's "N to review" was a dead end | Fixed: opens the first in queue order |
| A20 | low | "Unreviewed" pill on every dossier row | Fixed: the M51 row rule |
| A21 | low | "A description, not a daemon" jargon | Partly: "Off duty — runs only when you ask". Pause kept: it still refuses addressed runs |
| A22 | low | System fold shows raw lane codes | Dropped: needs an IPC shape change for a folded section |
| A23 | low | Review bar left a dangling "·" | Fixed |
| A24 | low | BaseItself header described the retired tabs | Fixed |

The items carried into M52.4 are all fixed there.

### M52.4 Review and gates

- Independent reviewers look at the M52 diff (the owner staged M51 before this ran) for:
  - correctness, including data loss on save;
  - AGENTS.md conventions (absent is never zero, the store invariant, policy as data, stale comments);
  - UI consistency.
- A second pass verifies each finding before it is fixed.
- **Outcome:** 5 reviewers, 41 findings, none refuted by the skeptics. After merging duplicates, they were fixed in 3 parallel groups. The notable ones:
  - Paste bypassed the footnote protection.
  - Any chip inside emphasis lost the emphasis on save (pre-M52).
  - `]` inside an unclosed backtick or `**` made a chip.
  - Retry sent the label, not the prompt.
  - The stale-cleared rule compared a UTC day with a local one.
  - Decided cards stayed clickable until the re-read.
  - Refusals toasted a generic sentence.
  - The concept page kept the previous concept's cards (the bar is now keyed by path).
  - A concept was listed twice on a page's Knowledge.
  - "What changed" named no concept on the real wire.
  - Demo cards used values Rust cannot produce.
  - The run row and its detail showed two times.
  - A lane-cap line pointed at a setting that does not exist.
- **Dropped with reasons:** duplicates, merged ones, and three refuted parts: "No gaps." is a real Rust state; "gone stale" in a Settings hint is prose; "nothing can fire it" in the agent dossier is accurate.
- **Still open:**
  - A citation inside emphasis (needs a dependency).
  - The `[[` menu inserting a wikilink inside emphasis.
  - HTML-first clipboards still go through BlockNote's own markdown paste.
  - A22.
- Then the full gates run: `pnpm test:run`, lint, typecheck, format, and the full e2e suite. `src-tauri/src/attention/status.rs` changed (A12), so `cargo test` (with the crash skip list), `cargo fmt --check` and `cargo clippy` run too.

- **Gates, 2026-09-29:**
  - `pnpm test:run`: 5050 passed, 8 skipped. One `NoteBodyEditor` test timed out under load (average 59) and passes alone, 13/13.
  - lint, format and typecheck are clean.
  - e2e: 144/144 on port 5401.
  - `cargo test` with the crash skip list: 1837 passed. `cargo fmt --check` and `cargo clippy -D warnings` are clean.

### M52.5 The owner's second look (2026-09-29 → 30)

The owner, on the built M52: "when I expand the preview record it doesn't scale with the chat window… UI is still trash, look at this knowledge homepage."

- **Owner decision:** the Knowledge home is a **table, like collections**. It is chosen over an overview dashboard and a card gallery.
- **Knowledge home** (`src/knowledge/ConceptTable.tsx`, shared anatomy in `src/views/tableAnatomy.tsx`):
  - It uses Epic's table anatomy, grouped by folder. The columns are Concept, Summary, Status (dot plus word), Sources, Written by and Updated.
  - A header shows the counts, with Start review. A folder view is scoped to its folder.
  - The Review tab uses the same table. The proposal cards are in plain words.
  - Five build rounds, each followed by a design critique against the Epic table.
- **Shell** (`src/app/shellLayout.ts`, App, DocPage, DrawerScrim):
  - The Assistant is sized first. Other panels give way in this order: canvas, peek, sidebar, the icon rail, then the Assistant parks behind a visible tab.
  - The give-way is resolved by CSS in one layout pass (0 bad frames in resize sweeps).
  - A page side panel folds into a drawer that closes on Escape or an outside click, without losing typed text.
  - Three fix rounds, each followed by an adversarial browser check.
- **Rust wording:**
  - Lane, change-line and support words are plain now (`attention/status.rs`, `dynamics/*`), mirrored in the mock.
  - New wire fields: `ChangeLine.path`, `RevertableApplication.path` and `Lanes.facets`.
- **Gates (2026-09-30):** vitest 5187/5187, e2e 173/173, cargo 1840 (crash skip list), and lint, format, typecheck and clippy all clean.
- **Owed:** the crash-test suite, after a reboot clears 18 wedged test processes (2 of them from this milestone's builder).

## Out of scope

- Removing the subject view (`{tab:'entity'}`). It stays reachable by deep link; the record's dossier covers the same ground.
- Growing `shared/policy/*` with human-readable labels. If M52.2 shows it's needed, it's proposed here, not done.
