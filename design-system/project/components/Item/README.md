# Item

A row of media, content and actions in an AI surface: a connector, a source, a file, a recovery note, the asking card's frame.

- Use `ItemGroup` for a list of rows (it is the `list`; each `Item` in it is a `listitem`), and a single `Item` for a standalone card such as "This reply stopped."
- Parts: `ItemGroup`; `Item` (`variant` `default`, `outline` or `muted`; `size` `default`, `sm` or `xs`; `render` to draw as a link); `ItemMedia` (`variant` `icon` or `image`); `ItemContent`; `ItemTitle`; `ItemDescription` (two lines at most); `ItemActions`; `ItemHeader` and `ItemFooter` (full-width rows above and below); `ItemSeparator` (a drawn rule, hidden from assistive tech).
- Row: `r-xl`, 14px x `sp-4` padding, 14px gap, `fs-ui`/`lh-ui`; `sm` pads `sp-3` x 14px, `xs` `sp-2` x 10px with an `sp-2` gap. A group spaces rows `sp-4`, 10px for `sm`, `sp-2` for `xs`.
- Variants: `outline` adds a `border-subtle` hairline; `muted` fills `n-25`; a row drawn as a link washes `n-50` on hover. Focus is `border-focus` plus `ring`.
- Title is 500 weight; description is `text-meta`, clamped to two lines; with a description the media aligns to the first line.
- Image media is 40px (`sm` 32, `xs` 24) at `r-lg`, and only sizes a picture drawn by one of the app's image components (CV-61); it never draws an `<img>` itself.
- `Confirmation` is an `outline` `sm` Item; build asking cards on it rather than on a new card.
- Presentation only (CV-64): hand it words and icons; the rail's adapters (`railConnectors`) decide what each row says.
