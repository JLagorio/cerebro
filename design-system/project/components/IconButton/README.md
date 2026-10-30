# IconButton

An icon-only button that always carries a label, shown as its tooltip and used as its accessible name.

- Use it for toolbar, row and panel actions that need no visible word; anything with a word is a `Button`.
- `icon` (Lucide kebab-case name) and `label` are required. The label is the tooltip and the `aria-label`; write the action or its unavailability ("Close", "No previous record").
- Sizes: `sm` 24px with a 14px icon, `md` 28px (default) with 16px, `lg` 32px with 16px. Radius `r-sm`, no padding.
- Variants: `ghost` (default: transparent, `n-600` glyph; hover `n-100` wash with `n-800` glyph; pressed `n-200`) and `outline` (`n-300` border on `n-0`, `n-50` on hover).
- `active` marks a toggled-on state and sets `aria-pressed`: `surface-selected` ground with a `cortex-600` glyph, `cortex-100` / `cortex-700` on hover.
- `disabled` is 45% opacity with a not-allowed cursor; the tooltip still shows, so the label can say why.
- `tooltip={false}` withholds the tooltip (the label stays the name), only for a toggle whose open drawer the tooltip would cover.
- `ref` anchors a `Popover` to the button; `onClick`, `style` and `className` pass through.
- Focus is `border-focus` plus `ring`. Hover colour runs on `motion-hover` (colour only, never `all`); pressed it gives to `scale: .92` on `motion-pop`.
- Don't: an icon button without a label, or a native `title` for its tooltip (a disabled button never shows one).
