# M51 — Knowledge you can follow

The owner, 2026-09-29, after M50 in the demo vault: "Better. But the UI is still bad and hard to follow."

## What made it hard (measured on the owner's screenshots)

- Two navs for one thing:
  - The sidebar showed 17 Knowledge rows: 15 subjects, All concepts, and Needs review.
  - The page repeated the last two in an 8-tab strip, and half of those tabs were Status-hub bookkeeping.
- Lists didn't say why a concept was listed:
  - 13 of 15 rows wore the same "Unreviewed" pill.
  - A deprecated concept that a person had already reviewed sat in Needs review with nothing to say why. Nothing a reviewer could do would ever clear it.
- The subject view repeated itself: one concept appeared under Stale, Changed and Known, and every empty section still rendered.
- A concept page was four columns: sidebar, page, review panel and assistant. The review panel led with three amber axis chips.
- Raw syntax leaked:
  - `[^id]` citations in concept bodies;
  - `[[slug]]` inside bold in the assistant's replies;
  - a file path in the assistant's context chip.

## Owner decisions

| Question | Answer |
| --- | --- |
| How is Knowledge navigated? | Folders plus 3 tabs. The sidebar lists the bundle's folders and Review; the page has Concepts · Review · Activity. |
| Where does a concept's review live? | A bar under the title. The side panel starts closed and keeps Details, Outline and Links. |
| Delivery | Uncommitted, on top of M49/M50 (as M50). |

## Parts

- **M51.1 Three tabs.**
  - `KnowledgeNav` becomes three tabs: `all`, `review` and `activity`, plus `section`, `entity` and `runs` as deep links.
  - The sidebar rows are the bundle's folders, then Review.
  - Activity holds What changed, the attention lanes, the update log, and System (Background and Deferral gates), folded and not mounted until opened.
  - With no nav, the page lands on Concepts.
  - Place labels use titles and folder headings, never paths.
- **M51.2 The queue.**
  - `reviewQueue` / `queueReason` in `engine/okf.ts` give one reason per row and the order to work them: disputed, then changed, stale, deprecated, new, and agent-only last.
  - A concept page shows "Review 3 of 13 · Next".
  - Deprecated concepts leave the queue once a person has reviewed them.
- **M51.3 The review bar.**
  - `ConceptReviewBar` holds the status, flags, author, source count, Ask and Verify. Verify is still pinned to the viewed body (M49.3).
  - The Details tab keeps the evidence, plus "+ Create page" for an open subject (D7 moved here from the subject view).
- **M51.4 The subject view** becomes one list, with each concept on its most consequential line and a summary sentence that still says "nothing contested".
- **M51.5 No raw syntax.**
  - Citation chips in the editor (numbered by frontmatter `sources`).
  - Formatted assistant replies.
  - Title-based context chips.

## Out of scope

- Merging proposal cards into concept rows (Waiting on you stays its own section of Review).
- Removing the `entity` subject view: it survives as a deep link.
