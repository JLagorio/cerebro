# IconPicker

A searchable grid of Lucide icons for a type, a view tab or a diagram node, showing at most 96 tiles at a time.

- Use it inside a dialog or popover that sets an icon; it draws no panel of its own. Type to narrow: the full set is over a thousand, and the cap keeps choosing from turning into scrolling.
- The consumer provides `value` (a kebab-case icon name, or `null` when nothing is chosen) and `onChange(name)`.
- `color` tints the selected tile's glyph with the thing's own colour (a type's); without it the selection is `cortex-600`.
- `clear` (`label`, `icon`, `onClear`) adds a first tile that clears the choice, drawn in `n-400`. Its label says what "none" falls back to ("Use the board icon"), because a view tab without an icon shows its layout's.
- `columns` (default 8) and `maxHeight` (default 180px, then the grid scrolls) fit it to its host.
- Parts: a full-width `Input` ("Search icons…"), then a grid with a 4px gap and 8px above it. Tiles are 36px, `r-md`, with a 16px `n-600` glyph and an `n-50` wash on hover; the selected tile has a `cortex-500` border on `n-50` and `aria-pressed`.
- A search with no match says `No icons match "…"` in `fs-xs` `n-400` across the grid, never an empty grid.
- It offers only names `Icon` can resolve, so a pick never writes a name that would draw the unknown-icon fallback.
