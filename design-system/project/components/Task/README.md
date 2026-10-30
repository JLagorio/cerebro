# Task

A piece of work and the steps it took: "Reading 4 notes" while it runs, "Read 4 notes" once done, opening onto the calls inside.

- Use it for a run of consecutive reads the transcript folds into one row, or any titled group of steps.
- Props: `title` (in the state's tense), `status` (StepLine state, default `done`), `statusText` (`null` when the title already says it, as "Reading 4 notes" does), `icon` (the tool's when done; left out while running so `loader-circle` turns), `description`, `open`, `defaultOpen`, `onOpenChange`, `children` (the steps).
- It opens while it runs and closes once done unless the reader chose. Its steps stay mounted while closed, so each is still the row it was.
- Parts: the `StepHead` trigger; the steps in a `Trace` under the `border-subtle` rule; `TaskItem`, one plain step line ("Searched notes for staging"); `TaskItemFile`, a file named as an outline Badge in `font-mono`.
- Titles say failure in words: "Failed to read" plus the file; an item's state words follow StepLine's.
- Ink is Trace's: `n-600` lines, `danger-600` failures, `n-500` for steps that never ran; facts in `text-meta`.
- Presentation only (CV-64).
