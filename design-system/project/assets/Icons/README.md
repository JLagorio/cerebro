# Icons

The 266 Lucide icons (lucide-react 0.525, ISC) that Cerebro's code names, drawn exactly as its `Icon` component draws them.

- Single ink: every stroke is `currentColor`. Inline the SVG and set CSS `color` (`text-secondary` for chrome, `n-500` in menus, `n-400` in empty states). As an `<img>` an icon draws black.
- 24px viewBox, 1.75 stroke, round caps and joins. Render at 16px by default, 14px in small controls, 12–13px in tags and menu rows.
- In React use `Cerebro.Icon` with the kebab-case name (`name="circle-alert"`); old Lucide names such as `alert-circle` are aliased, and an unknown name draws `square-dashed`.
- `square-dashed` is the fallback glyph, not a content icon.
- The workflow status flag is not here: it is `StatusFlag`'s own filled glyph.
