# BlockDrag

The chrome for moving a block among blocks: a faint copy that rides the pointer, and an insertion line on the block that would take the drop.

- Use it for block reorder (layout canvas sections and fields, dashboard widgets, board cards). Reordering rows within a list is the other grammar: the real row follows the pointer and siblings slide, with no ghost and no line.
- `DragGhostLayer`: mount it once inside the `DndContext`; it takes no props. Mark each draggable source with `data-drag-id` set to its draggable id; that is the whole wiring, and a surface that marks none simply gets no ghost.
- The ghost is a DOM copy of the source laid exactly over it and moved by the raw pointer delta, so the grabbed point stays under the pointer. It is 40% opaque with no scale, rotation, shadow, background or radius. The source stays where it was, at full strength.
- The ghost layer is fixed, inert and pointer-transparent, at `z-index` 1050 (above the Dialog scrim, below tooltips and toasts). The copy drops `id`, `data-testid`, `data-drag-id`, `data-line` and `data-slot`, and is re-measured every frame so auto-scroll never carries it off. Drop or cancel removes it.
- `InsertionLine`: `gap` (the droppable id it stands for) and `side` (`top`, `bottom`, `start` or `end`). Render it inside the target block, which must be positioned; it lights when that gap is the drop target.
- The line is 4px of `cortex-500` at 43%, square, `z-index` 88, pointer-transparent. `top` and `bottom` sit 4px outside the box across its full inline width, so an indented block gets an indented line; `start` and `end` are 4px wide, full height, on the edge.
- Every line stays mounted and lights by opacity on `--motion-move`, so leaving one target and entering the next cross-fade.
- `lineHosts(gaps)` hangs each gap on the block after it as its `top` line, and the last gap on the block before it as `bottom`: every gap is drawn once, and an empty container hosts none.
- `ghostLayout(rect, delta)` and `insertionLineClass(side, lit)` return the exact styles, for surfaces and tests that need them.
- Pair the source with a `Grip` of kind `block`.
