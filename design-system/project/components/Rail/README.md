# Rail

The conversation's details beside the transcript: a named column of cards, each a heading line that says what it holds and folds the rest.

- Use it for the canvas assistant's "Conversation details" rail, its cards in one order: Waiting on you, Plan, Subagents, Changes, Handed off, Context, Sources, Connectors, Environment.
- `Rail` props: `title` (its heading and the region's name), `headingRef` (the host focuses it as the rail opens; it is not a tab stop), `children` (the cards). Where it stands, docked at 300px or a drawer, and how wide, are the host's.
- `RailSection` props: `title`, `icon`, `count` (what the line says after the name: "2 of 5 done", "1 running · 1 done", "62%"), `state`, `none` (an empty card's words, default "None"), and `open`/`defaultOpen`/`onOpenChange` for its fold.
- `state` is `ready`, `empty`, `not-recorded`, `partial` or `unavailable` (CV-44's five). Only `empty` is quiet: one heading line, nothing opens. Every other state folds open to start and stays mounted while folded, so what is inside keeps its own state.
- Put a `StateMessage` (compact) in a card that read nothing, read part, or failed: "Sources not recorded", "Couldn't read this vault's history". Never show a failed read as "None" (CV-05).
- Rail: `sp-4` padding (`sp-6` at the foot), `sp-3` gap; heading `fs-ui` semibold with `track-tight`, `ring` on keyboard focus. Cards: `surface-raised`, `border-subtle`, `r-lg`, `sp-2` x `sp-3` padding, `sp-2` apart; the name in `text-primary` 500, the count quiet, "None" in `text-muted`, the body in `text-secondary`.
- Hand each card a memoized view model built by its adapter in `src/agent/elements/` (`railPlan`, `railSubagents`, `contextCard`, `railConnectors`), never the messages: a streamed word must draw no card, and a folded rail reads nothing.
- Presentation only (CV-64). Each card faults alone: its host wraps it in a compact `SectionBoundary`, outside `components/ai/`.
