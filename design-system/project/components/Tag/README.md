# Tag

A small neutral chip for a linked record, a person or an applied filter, removable when the consumer says so.

- Use it to name something compactly in a row of others: a project, a work item, a filter clause. A workflow status is a `StatusFlag`; a choice to make is a `Select`.
- The consumer provides `children` (the label), and optionally `color` or `icon` to lead it and `onRemove` to make it removable.
- Chip: 22px high, 8px side padding, 6px gap, `r-sm`, `n-200` border on `n-50`, `fs-xs` 12px weight 500 in `n-700`. It never wraps and truncates its label with an ellipsis inside a narrow parent.
- `color` draws an 8px swatch dot (radius 3px), usually a swatch token (`var(--swatch-teal)`). Otherwise `icon` draws a 12px Lucide glyph. Pass one, not both; `color` wins.
- `onRemove` adds a 12px `x` button labelled "Remove" in `n-500`, `n-800` on hover.
- `style` and `className` pass through.
- Don't: colour the chip's ground or ink by meaning; the dot carries the colour and the label carries the meaning.
