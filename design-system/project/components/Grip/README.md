# Grip

The drag handle, in three kinds: a list row's, a block's in the gutter, and a tab's.

- Pick the kind by the gesture: `row` (default) reorders an item within a list; `block` moves a block among blocks (the `BlockDrag` grammar: ghost and insertion line); `tab` is the row grip turned sideways for a tab strip.
- Props: `kind`, `className` (placement and reveal, from the call site), `ref`, and every span attribute, so a drag library's listeners and attributes pass straight through.
- `row` and `block` sit in an 18 x 24px slot; `tab` is 10px wide with `overflow: hidden`, its height set by the call site (`inset-y-1`).
- The glyph is Lucide `grip-vertical`: 16px for `row` and `tab`, 20px for `block` (`GRIP_GLYPH`).
- `row` and `tab` ink `n-400` with no background and no radius: the row's own highlight is the feedback. `block` inks a dimmer `n-300` on the page, with its own `r-xs` and an `n-100` wash and `n-500` ink on hover.
- It shows `cursor: grab` (never grabbing) and `touch-action: none`, and it appears on `--motion-move`: appearing is movement.
- A row grip takes the type icon's place in the row's leading slot; never append it beside the label, which would shove the row sideways on hover. A tab grip lives in the tab's own leading padding for the same reason.
- Reveal it with opacity (`opacity-0 group-hover:opacity-100 focus-visible:opacity-100`), never `hidden`, so arrow-key reordering keeps it in the tab order.
- Pair it with a `Tooltip` ("Drag to reorder") and an `aria-label` naming what moves ("Drag Status").
