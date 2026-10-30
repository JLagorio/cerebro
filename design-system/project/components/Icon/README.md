# Icon

A Lucide line icon by kebab-case name, drawn at a 1.75 stroke in `currentColor`.

- Use it for every glyph in the app; `IconButton`, `Select`, `Tag` and the rest take an icon by name and draw it through this.
- The consumer provides `name` ("target", "layout-grid", a type's `icon:` frontmatter). `size` is in px, default 16; controls use 14 (small) or 16, headers 20.
- `strokeWidth` defaults to 1.75; keep it, so icons at every size read as one family.
- `color` takes any CSS colour and defaults to `currentColor`, so the icon follows its text. Pass a type's own colour to tint a type icon; pass a token (`var(--n-400)`) for muted chrome.
- It is decorative: `aria-hidden`, with `data-icon` carrying the name for styles and tests. The control around it carries the label.
- Old names still resolve through `ICON_ALIASES` (`check-square` draws `square-check`), so older vault files keep their icons.
- An unknown name draws `square-dashed`, visibly, with `data-unknown-icon` set and one dev warning per name. Never an empty svg.
- It never shrinks in a flex row (`flex: none`) and sits on the text's middle. `style` and `className` pass through.
