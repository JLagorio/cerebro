# Tooltip

A short label for a control, with the command's keycaps when it has a shortcut.

- Use it instead of a native `title`: it shows on hover and keyboard focus, and on disabled controls ("Copying into the vault needs the desktop app"). Every `IconButton` gets one from its `label`; pass `tooltip={false}` to withhold it.
- Props: `label` (empty renders nothing), `children` (one element), `command` (a keymap catalog id such as `palette.open`; its `Keycaps` follow the label, and an unknown id throws), `side` (`top` default, or `bottom`; flips when it would leave the window), `delayMs` (default 400), `disabled` (suppresses it, keeping the trigger's node).
- It adds no wrapper node: its handlers are cloned onto the child, which must take `onPointerEnter`, `onPointerLeave`, `onPointerDown`, `onFocus` and `onBlur`. Wrap a disabled control in a `span` when the control cannot.
- The bubble is `n-900` with `n-0` text (so it inverts in dark), `text-xs` at 1.4 leading, 4px x 8px padding, `r-sm`, `shadow-lg`, at most 260px wide, centred 6px off its trigger, kept 8px inside the window, at `z-index` 1100. Keycaps sit in `n-200`.
- It describes, never names: the trigger gets `aria-describedby` while it shows, and keeps its own accessible name.
- Warm-up: once one has been read, the next one the pointer brings up within 700ms opens at once. Focus always waits its delay.
- It hides on pointer leave, pointer down and blur. Escape dismisses only the tooltip, through its own `tooltip` layer in `layers.ts` (CV-47).
- Motion: arrives on `cb-tooltip` (`--motion-pop`, a 2px drift out of its side, scale .97); leaves as a fading copy (`cb-tooltip-leave`, `--motion-exit`).
- Never put interactive content in it; use `HoverCard` or `Popover`.
