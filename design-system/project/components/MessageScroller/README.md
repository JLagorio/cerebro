# MessageScroller

A transcript's scroll: it follows the reply while the reader is at the live edge, settles each new question near the top, and moves only when the reader asked.

- Use it through `Chat`, which composes every part; reach for the parts alone only for a transcript Chat cannot frame. Give its parent a height: the frame fills it.
- `MessageScrollerProvider` props: `autoScroll` (follow new content at the end), `defaultScrollPosition` (`start`, `end` or `last-anchor`, applied once), `scrollEdgeThreshold` (8px), `scrollPreviousItemPeek` (64px of the row before a new anchor), `scrollMargin`.
- Parts: `MessageScrollerProvider` (the state; draws nothing), `MessageScroller` (the frame), `MessageScrollerViewport` (a named, focusable `region`, so a keyboard can scroll), `MessageScrollerContent` (a `log` announcing new rows only; pass `aria-busy` while a turn streams), `MessageScrollerItem` (`messageId`, and `scrollAnchor` on the person's rows), `MessageScrollerButton` (`direction` `end`, "Jump to latest", or `start`, "Jump to start").
- A wheel, a touch, a scroll key or the scrollbar releases it; new content then arrives without moving anything. The jump button follows again, and is inert and faded while there is nowhere to go.
- `useMessageScroller()` gives `scrollToEnd`, `scrollToMessage(id)`, `scrollToStart` and `scrollToElement(el)`; a jump to a row not yet drawn queues. `useMessageScrollerScrollable()` says which way it can still scroll.
- Rows sit `sp-8` apart. The jump button: `n-0` pill, `n-200` border (`n-400` on hover), `r-full`, `shadow-lg`, `fs-2xs` in `n-600`; it arrives on `motion-pop` and leaves on `motion-exit`. Focus is a 2px `border-focus` outline.
- Presentation only (CV-64): position lives in one object per provider, mirrored to `data-*`, so a scroll or a streamed chunk re-renders no row.
