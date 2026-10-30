# ContextMenu

The right-click menu: fixed at the pointer, clamped inside the window, closed by any press away from it.

- Use it for a row's or tab's right-click (file tree, sidebar collections, view and record tabs, dashboard widgets). For a menu opened from a button, use `Popover` with `MenuSurface`.
- Props: `x`, `y` (the pointer's client position), `items` and `onClose`. Each item is `{ icon, label, danger?, onSelect }`; the icon is required.
- The menu is 200px wide, clamped 4px inside the viewport, `n-0` on an `n-200` border, `r-lg`, 4px vertical padding, with its own `0 8px 24px` shadow at 14% ink.
- Items: 13px icon, `text-sm` label in `n-700` with 5px x 10px padding and an `n-50` wash on `--motion-hover`; `danger` items in `danger-600` on a `danger-50` wash.
- Choosing an item closes the menu first, then runs `onSelect`.
- A transparent full-window backdrop under it closes it on a press, the wheel or a second right-click. Escape closes it from inside the menu (it handles its own key and registers no layer); arrows, Home and End move focus.
- Focus moves to the first item on open and returns to the row it was summoned from on close.
- It arrives on `cb-menu-in` (`--motion-pop`) and leaves as a fading copy (`cb-popover-leave`, `--motion-exit`).
- Order items create, edit, move, then the destructive one last ("Move to Trash", "Delete view"). End an item that opens a further step with an ellipsis.
