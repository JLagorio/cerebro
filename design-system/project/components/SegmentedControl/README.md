# SegmentedControl

An inline tab strip that switches between two to five views or modes of the same thing.

- Use it for a view mode, a calendar span, a theme or an Off / Ask / On setting. For a long or open-ended list of values, use `Select`.
- The consumer provides `options` (`value`, `label`, optional Lucide `icon`, optional `testId`), `value`, `onChange` and an `ariaLabel` naming the choice ("View mode", "Calendar span").
- `size`: `sm` (default) 28px overall with 24px segments in `fs-xs` 12px, or `md` 32px overall with 28px segments in `fs-sm` 13px and 12px side padding. Labels are weight 500; icons are 14px with a 6px gap.
- Track: `n-100`, `r-md`, 2px padding and 2px gap. Segments: `r-sm`, `n-600` ink, `n-800` on hover (colour on `motion-hover`).
- Selected: `n-0` ground, `n-900` ink and `shadow-xs`, drawn as one pill behind the segments that slides to the pick on `motion-turn`. The lift itself never fades.
- It is a `tablist` of `tab` buttons with `aria-selected`: one tab stop, and arrows, Home and End move and select at once. Focus shows `ring`.
- A `value` that matches nothing leaves no segment selected and the first one focusable.
- `style` and `className` pass through.
