# Trace

The line every agent step is drawn on: an icon and one sentence, optionally a row that opens onto its detail.

- Use it to build any AI step that is not already an element (a rail card's heading, a source, a fold). For calls, reasoning, subagents and plans, use their own elements, which are Trace underneath.
- Parts: `Trace` (the list, `sp-2` between lines), `TraceLine` (one line), `TraceIcon` (16px, `aria-hidden`; before the title it names the action, after it it is the indicator, pulled `sp-1` closer), `TraceTitle` (one line, truncates), `TraceDescription` (a count or a duration; never truncates, tabular figures), `TraceCollapsible`, `TraceCollapsibleTrigger` (adds the chevron), `TraceCollapsibleContent`.
- `TraceLine` takes `status`: `running`, `error` or `pending`; done work has none. Every status speaks words before the title (`Running`, `Failed`, `Not started`, or the caller's `statusText`); pass `statusText: null` only when the title already says it ("Searching notes", "Failed to read ops-12.md"). Never colour alone.
- Ink: lines in `n-600` at `fs-ui`/`lh-ui` (14/20), brought to `n-900` when a trigger or link is hovered; `pending` is `n-500`; `error` is `danger-600`, chevron included. Descriptions are `text-meta`.
- A running title carries the working light (`cb-ai-shimmer`, period ten times `dur-move`); reduced motion stills it and keeps the ink.
- The trigger is a native button with no fill, radius `r-lg` and the `ring` on focus; its chevron turns 90 degrees on `motion-turn`.
- Opened detail hangs from a 1px `border-subtle` rule down the icon's centre, `sp-4` in, `n-600` ink, line height 1.625. `keepMounted` keeps a closed row's content `hidden` so nested rows keep their state.
- To open a row while it streams and let the reader's click win, pass `open ?? running`.
- A line is a span, never a tab stop: wrap it in a trigger or a button to make it act. Vault paths never become an `href` (CV-16).
- An unrecorded number is words or left out, never `0` (CV-05). Presentation only: no stores, IPC or agent model (CV-64).
