# ListSelectionBar

The bar that floats over a list while rows are picked: how many, what can be done with them, and how to let go.

- Use it inside a keyboard-cursor list whose rows can be multi-selected: My work, the Inbox's captures, the Concepts table (each with Copy links) and Home's lanes (with `doneHint`).
- Props: `count` (the selected rows; `0` renders nothing), `onCopy` (optional: adds a ghost `sm` `Button` with the `link` icon, "Copy links", which copies each picked page's link), `doneHint` (boolean, default `false`: adds " · e marks done" for lists where `e` completes the selection).
- It reads "3 selected", then the action, then "Esc clears". The count line is `text-sm` medium `n-700`; "Esc clears" is `text-xs` `n-500`.
- Geometry: `w-fit`, centered (`mx-auto`), `mt-3`, sticky 12px above the bottom of the scrolling list at `z-index: 20`, so it stays in view as the list scrolls under it.
- Surface: `n-0` ground, an `n-200` border, `r-lg`, `shadow-lg`, 12px by 8px padding, items `sp-3` apart.
- It is a `role="status"` region, so the new count is announced as the selection changes.
