# Popover

The one anchored surface: it portals, places itself against a trigger, flips when it must, and always dismisses.

- Use it for every menu, picker, listbox and small editor opened from a control. Never hand-roll a `fixed inset-0` scrim or a positioned wrapper instead.
- Required: `onClose` and `children`. Pass `anchorRef` (preferred); without it the popover anchors to the element it is rendered inside.
- Options: `role` (`menu`, `listbox`, `dialog`, default `group`), `ariaLabel` or `ariaLabelledBy`, `trapFocus` (default `false`: takes focus once placed and keeps Tab inside), `closeOnScroll` (default `true`), `matchAnchorWidth` (default `false`, for select-like lists), `onEscape` (step back in a multi-step surface instead of closing), `keyClaim` (`typing` or `editor`), `id`, `activeDescendant`, `className`.
- It draws no chrome. Menus bring `MenuSurface`; other panels draw `n-0` on an `n-200` border, `r-lg`, `shadow-lg`, 8 to 12px padding.
- Placement: 4px below the anchor, left edges aligned, kept 8px inside the window. It flips above only when it overflows below and fits above. It re-measures when its content or the window resizes, and on `cerebro:anchor-moved` (`ANCHOR_MOVED_EVENT`) from a panning canvas. The panel gets `--popover-available-width` and `--popover-available-height`.
- Layering: `z-index` 1050, over the Dialog scrim (1000) and under tooltips and toasts (1100).
- Dismissal: a press outside (the trigger's own press is left to its toggle; a press in a surface stacked above it is not outside), a scroll outside it, or Escape through `layers.ts`, one surface per keystroke, innermost first (CV-47). A field inside is blurred first, so its commit runs.
- Focus returns to the opener on close.
- Motion: arrives on `cb-pop-in` (`--motion-pop`), growing from the side it opened on (`data-side`); leaves as a fading copy (`cb-popover-leave`, `--motion-exit`).
- Don't register a second layer inside it; pass `onEscape`. `useDismiss` and `useEscapeLayer` give an unanchored surface the same click-away and Escape.
