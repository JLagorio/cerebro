# Queue

What waits, in order: the agent's todo list, Up next, review notes, follow-ups.

- Use `TodoQueue` for a run's plan; compose `Queue`, `QueueSection`, `QueueList` and `QueueItem` for any other ordered list a surface keeps (Up next, review notes, follow-ups).
- Provide `todos: TodoItem[]` to `TodoQueue`: `{ content, status: 'pending' | 'in_progress' | 'completed' | the CLI's own word, activeForm? }`, plus `isStreaming` while the run is live. It splits them into "N to do" (`list-todo`) and "N done" (`list-checks`).
- `Queue`: the sections, one under another; `render={<section aria-label="Up next" />}` draws it as a named section. `isStreaming` lights the item in progress.
- `QueueSection`: `label`, `count` (said first: "3 to do"), `icon`; a line that opens and starts open, or `collapsible={false}` with `headingLevel` for a plain heading. `actions` sit beside it (Resume), never inside its trigger.
- `QueueItem`: `title`, `status` or your own `statusText`, `icon`, quiet `description`, `actions` beside the line (Run now, Edit, Remove), and children hung under the title. `QueueItemAction` is its quiet 20px button; give an icon-only one an `aria-label`.
- Status always carries words, read before the title: "To do", "In progress", "Done". A status this build does not know reads as the CLI wrote it ("In review", `circle-dashed`).
- Only the item in progress while the run is live carries the working light (`cb-ai-shimmer`) and its present-tense `activeForm`; a stopped run reads its `content`.
- Tokens: lines in `n-600` at `fs-ui`/`lh-ui`, `sp-2` between items, the open rule in `border-subtle`; actions are `fs-2xs` on `n-0` with a `border-subtle` hairline and `r-md`, `n-400` border and `n-900` ink on hover, `ring` on focus; item detail in `text-meta` at `fs-meta`.
- An empty list draws nothing; no list at all is the caller's to leave out, never shown as "0 to do" (CV-05).
- Presentation only (CV-64): it reads no store. No item image: only the image components draw an `<img>` (CV-61).
