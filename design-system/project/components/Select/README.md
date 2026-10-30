# Select

The design system's only select: a listbox button whose options open in a portalled `Popover`, never a native `<select>` (CV-63; lint refuses one).

- Use it for any fixed choice: a database, a repeat pattern, a saved view. Free text is an `Input`.
- The consumer provides `options` (`value`, `label`, optional `icon`, `color`, `hint`, `disabled`), `value` and `onChange`, which fires only when the pick differs from `value`.
- Name it with `ariaLabel`, `labelledBy` or an `id` for a `<label htmlFor>`; the trigger still announces its value.
- Trigger: `size` `md` (default, `control-h` 32px, `ui` 14/20) or `sm` (`control-h-sm` 28px, `meta` 12/18); `n-200` border on `n-0`, `r-md`, `n-800` value, `n-25` on hover, `n-50` while open, `border-focus` plus `ring` on focus. The 14px `n-400` chevron turns 180° on `motion-move`.
- `variant="ghost"` reads as text until the pointer finds it (`n-50` hover, `n-100` open), for property rows, inspectors and toolbars.
- `placeholder` shows in `n-400` while `value` matches no option. `invalid` sets the border to `danger-500`; `disabled` greys to `n-50` with `text-disabled`.
- List: the menu surface (`n-0`, `n-200` border, `r-lg`, `shadow-lg`, 4px padding), at least the trigger's width and at most 360px, 300px tall before it scrolls, flipped up near the window's foot. Rows are 30px (28px small), `r-sm`, `n-50` on the highlighted row, a `cortex-600` check on the picked one, a 13px icon in the option's `color` and an `n-400` right-aligned `hint`.
- `searchable` turns it into a combobox for long lists (a vault's types): a 36px search field (`searchPlaceholder`, default "Search…") sits flush over an `n-100` hairline, filters best match first, and shows "No matches" when nothing is left; the list is at least 240px wide.
- Keyboard is a native select's: arrows, Home/End, Page Up/Down, Enter or Space, typeahead. Typing on a closed trigger opens the list at the match and never changes the value.
- `width` (number or CSS length), `className`, `style` and `testId` pass through. The card shows triggers closed; click one to open its list.
