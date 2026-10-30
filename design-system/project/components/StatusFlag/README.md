# StatusFlag

A workflow-status chip: a filled flag glyph in the status colour, then the status's name.

- Use it to show where a record stands in its workflow, in a chip or, `bare`, beside a group header. A neutral label is a `Tag`.
- `status` picks a built-in: `idea` "New idea" (default), `planned` "Planned", `progress` "In progress", `validation` "Validation", `released` "Released", `wontdo` "Won't do", each coloured by its `status-*` token.
- A type's own statuses pass `label` and `color` (the status's hex from the Type doc); either overrides the built-in's.
- Chip: `md` 24px (default) or `sm` 20px, 8px side padding, 6px gap, `r-sm`, `n-200` border on `n-50`, `fs-xs` 12px weight 500 in `n-700`, no wrapping.
- The flag is a filled 14px glyph (12px at `sm`), drawn inline rather than from Lucide, and `aria-hidden`: the label carries the meaning and the colour only helps.
- `bare` draws the glyph alone with the label as its `title`, for group headers that print the name themselves.
- `style` and `className` pass through.
