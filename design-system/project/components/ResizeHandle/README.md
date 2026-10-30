# ResizeHandle

The drag handle on a panel's edge: pointer drag, arrow keys, and Escape to back out.

- Use it on the edge of a resizable panel: the sidebar, the record and AI panels, a timeline's table divider. The panel must be `position: relative`.
- Props: `label` (the separator's name, "Resize sidebar"), `side` (`left` or `right`: the edge it sits on, which sets the drag's direction), `width` (the width the panel is drawn at; a drag starts there), `preferred` (the stored width when the panel is drawn narrower; defaults to `width`), `min`, `max`, `onResize(width)`.
- It is a 7px hit strip centred on the edge, full height, `z-index` 20, `cursor: col-resize`, holding a 2px line: transparent at rest, `cortex-300` on hover, `cortex-500` while dragging.
- `onResize` is called on every move with a rounded width clamped to `min` and `max`; the owner draws and stores it.
- Width comes from where the drag started, not summed per event, so a fast drag never drifts from the pointer. During a drag the body takes `cb-resizing`: a col-resize cursor everywhere and no text selection.
- Keyboard: it is a focusable `separator` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`; ArrowLeft and ArrowRight step 12px, 48px with Shift. A double-click re-clamps the width.
- Escape mid-drag abandons it and writes the preferred width back. The drag holds Escape as a `gesture` layer, so the surface behind never takes that key (CV-47).
- A gesture that leaves a capped panel at the width it was drawn keeps the stored preference rather than storing the cap.
