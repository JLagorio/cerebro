# Chat

The thread: the conversation's rows in a `MessageScroller`, a jump to the latest row, and the composer under it all, or the welcome in the thread's place while it is empty.

- Use it for the assistant's conversation in every presentation. Give its parent a height: it fills it.
- Props: `children` (one `MessageScrollerItem` per row: a `Message`, a `Checkpoint`, a `Confirmation`), `empty` (what shows while there are no rows), `composer` (the `PromptInput`, its chips and notes), `busy` (a turn streams; the log holds its news until it lands), `label` ("Conversation"), `autoScroll` (default true), `defaultScrollPosition` (default `last-anchor`), `contentClassName`, `jumpTestId`, `scrollerRef` (scroll commands for a host beside the thread, such as the rail).
- The composer keeps its place whether the thread is empty or not, so a field typed into before the first turn is the same field after it.
- Mark the person's rows `scrollAnchor`, so each new question settles near the top with its reply growing under it.
- A `false` or `null` child is not a row: a thread of those still shows `empty`.
- Layout only: a full-height column; the thread or the centred empty state takes the room, the composer keeps its own height. Spacing and ink come from `MessageScroller`, `Message` and `PromptInput`; the welcome's own styles are the caller's (its eyebrow icon in `text-ai`, the one synapse use).
- Presentation only (CV-64): the messages, the run's status and the starters come from the caller (`AiPanel`, `ChatTurn`); it reads no store, IPC or agent model.
