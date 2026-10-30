# Collapsible

The disclosure under every AI row: a native button that shows and hides one region, with Cerebro's reveal and exit motion.

- Use it directly only for a fold the trace elements do not cover, such as a rail card's body; trace rows use `TraceCollapsible`, which is this.
- Props: `open`, `defaultOpen` (default closed), `onOpenChange(open)`, `disabled`. A controlled `open` hears the reader only through `onOpenChange`.
- Parts: `Collapsible` (state, `data-open` or `data-closed` on its div), `CollapsibleTrigger` (a native `button type="button"` with `aria-expanded`, `aria-controls` and `data-panel-open`), `CollapsibleContent` (the region; `keepMounted` keeps it in the document, `hidden`, while closed).
- It draws nothing of its own: the caller styles the trigger and region. The rail composes it as a raised card (`surface-raised`, 1px `border-subtle`, `r-lg`, `sp-2`/`sp-3` padding) with a `TraceCollapsibleTrigger` heading and a kept body.
- Opening drops the region in from 4px above on `motion-enter` (`cb-rise-in`), once per open; closing fades it on `motion-exit` (`cb-fade-out`) and holds it with `Presence` until the fade has played. Reduced motion closes it at once.
- Enter and Space work because the trigger is a button; it never handles Escape, since a collapsible is not a layer (CV-47).
- A trigger whose own `onClick` calls `preventDefault` changes nothing.
- Use `keepMounted` whenever the region holds rows with their own open state or scroll.
- Presentation only (CV-64).
