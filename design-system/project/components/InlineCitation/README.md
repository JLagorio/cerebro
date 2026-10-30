# InlineCitation

A source in the sentence: the caller's own link or button, with a hover card that names what it rests on.

- Use it on a reply's link, a concept's footnote number and a wikilink pill, wherever cited words should say where they come from.
- Provide `sources: CitationSource[]`: a `SourceRef` plus an optional `description` (a footnote's definition, a summary). With no sources there is no card.
- `children` is the trigger: your focusable element, kept with its own name and role, and it stays the way in. A card that opens on hover is never the only route to a source.
- The card opens on hover after `openDelay` (300 ms) and on keyboard focus, closes on Escape, an outside press, scrolling or typing, and describes its trigger while open. One card per `group` is open at a time.
- Each source in the card: its title in `w-medium`, what it says (clamped to 3 lines), and where it is: a web host that links out in a new tab and says so, or a vault path that is a button through `onOpenPath`. Never an href to a vault page (CV-16).
- An untitled source is named once, by its address. A path outside the vault, or one `isVaultPath` rejects, stays words with nothing to open.
- `label` names the card for assistive tech; left out, "Source" or "3 sources".
- Tokens: the card is the DS HoverCard, 320px on `n-0` with an `n-200` hairline, `r-lg` and `shadow-lg`; its body pads `sp-3`, rules a second source off with `border-subtle`, sets descriptions and addresses in `text-meta` at `fs-meta`, links to `text-primary` with an underline on hover, and `ring` on focus.
