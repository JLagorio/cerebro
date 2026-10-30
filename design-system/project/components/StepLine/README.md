# StepLine

A step's line in one of the transcript's states, said in words as well as ink: the head every Tool, Task, Subagent and Reasoning draws.

- Use `StepHead` wherever a call, group or subagent needs a line; it is a span, so place it in a trigger, a button or a `cb-ai-step` div.
- Props: `status` (`running`, `done`, `failed`, `denied`, `interrupted`, `waiting`, `cancelled`, `not_run`, `paused`), `title` (one sentence in the state's tense: "Running git status", "Ran git status", "Failed to edit a note", "Denied: Bash"), `statusText`, `icon` (a Lucide name, else the state's), `after` (a server chip, a type badge), `description` (a count or duration), `progress` (what a running subagent is doing now).
- Words come from `STEP_STATUS_WORDS`. They are read before the title unless the title already starts with them; `done` needs none. The five unfinished states also draw their sentence under the title: "Interrupted, may have completed", "Waiting for your answer", "Cancelled: it did not run", "Not run: it waited for an answer that never came", "Paused by a hook outside Cerebro; your next message refuses it".
- State icons (`STEP_STATUS_ICONS`): `loader-circle` (turns while running, still under reduced motion), `circle-check`, `circle-x`, `ban`, `circle-alert`, `clock`, `circle-x`, `circle-minus`, `circle-pause`.
- Ink by state (`stepTraceStatus`): running lit, failed `danger-600`, waiting, cancelled, not run and paused fainter (`n-500`); interrupted and denied draw as done work.
- Notes and progress hang past the icon (`sp-6`) in `text-meta` at `fs-meta`/`lh-meta`; the head stacks with `sp-05`. Title and facts sit in one row that wraps the facts under the title in narrow panels, so the title is never cut for its facts.
- `StepExtra` hangs a caller's own lines (an "Open to review" button) under the title, shown while closed too.
- Helpers: `formatDuration` ("417ms", "1.4s", "2m 5s", "1h 3m"; a bad reading is "0ms", never negative), `plural`, `useStepOpen` (open while working; the reader's click wins), `vaultPathOf` (only a relative vault path may open, CV-16).
- Pass only recorded durations and counts; leave an unrecorded one out, never `0` (CV-05). Presentation only (CV-64).
