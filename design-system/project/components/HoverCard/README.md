# HoverCard

A preview card that opens over a link while the pointer rests on it.

- Use it for previews: a page link's title, path, status and snippet, a citation's source, the context ring's breakdown. It is non-modal; never put the only way to do something in it.
- `children` is a render prop: put `ref` and `describedBy` (as `aria-describedby`) on your own trigger element. No wrapper node is added.
- `content({ close })` renders the body only while open; `label` is the card's accessible name.
- Options: `group` (default `hover-card`; one card per group is open at a time), `openDelay` (default 300ms, `HOVER_OPEN_MS`), `closeDelay` (default 150ms, `HOVER_CLOSE_MS`), `openOnFocus` (default `true`, keyboard `:focus-visible` only), `disabled`.
- Only a real pointer move opens it: no button pressed, not touch, and not a chip that scrolled or was typed under a still pointer.
- The card is 320px wide (at most the window less 16px), `n-0` on an `n-200` border, `r-lg`, `shadow-lg`, 6px below its trigger, flipped above when it does not fit, kept 8px inside the window, at `z-index` 1100. The body brings its own padding (10px x 12px in a page preview).
- It closes 150ms after the pointer leaves both trigger and card, on a press or scroll outside, when typing starts elsewhere, on a press on its trigger, and on Escape through its own `tooltip` layer in `layers.ts` (CV-47).
- A card opened from inside another holds its parent open; call `useHoldParentHoverCard(true)` while a menu portaled out of a card is up.
- The body sits in a compact `SectionBoundary` ("This card"), so a fault draws an unavailable message inside the card. Clicks and keys inside it stop there and never reach the chip or editor behind.
- Motion: arrives on `cb-hover-card` (`--motion-pop`, 4px drift, scale .98, from its trigger's side); leaves as a fading copy (`cb-popover-leave`, `--motion-exit`).
- A preview reads what is already loaded and writes nothing.
