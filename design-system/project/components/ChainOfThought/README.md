# ChainOfThought

A turn's working folded into one line: "Working" while it goes on, then how many steps it took, opening onto its reasoning and folded reads.

- Use one per assistant turn, above the reply, when the turn did any work.
- Props: `summary` (`{ running, total, failed }` from `summarizeSteps` in `engine/ai/steps.ts`), `title` (the caller's sentence), `icon`, `open`, `defaultOpen`, `onOpenChange`, `children`.
- Titles from `chainTitle`: "Working", "5 steps", "5 steps, 1 failed". Once the turn settles and every run recorded its time, the caller leads with "Worked for 1m 5s · 6 steps", the sum of the runs' recorded `duration_ms`; with any run unrecorded it says only the counts (CV-05).
- State: running lights the line and turns `loader-circle`; any failure draws it `danger-600` with `circle-x`; otherwise `circle-check`. The counts are the status words.
- It opens while a step runs and when one failed; the caller opens the latest turn's with `defaultOpen`; the reader's click wins from then on. Steps stay mounted while closed.
- Put inside only reasoning (`Reasoning`) and folded runs of finished reads (`Task`). A change, concept, hand-off, commit, view, or any step that failed, waits, was interrupted, cancelled, not run or paused stays its own line beside the chain.
- Parts: `ChainOfThoughtHeader` (the trigger), `ChainOfThoughtContent` (a `Trace` under the `border-subtle` rule), `ChainOfThoughtStep` (a caller's own plain line, `complete`, `active` or `pending`), `ChainOfThoughtSearchResults` and `ChainOfThoughtSearchResult` (host chips: secondary Badge, `n-100` fill, `n-800` ink, `r-full`).
- Ink and motion are Trace's: `n-600` lines, `text-meta` facts, chevron on `motion-turn`. Presentation only (CV-64).
