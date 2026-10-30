# AppRail

The persistent icon rail at the window's left edge: global navigation that stays when the context sidebar folds.

- Use it once per window, left of the context sidebar. It holds, top to bottom: the brand ("c." to Home), Search, New, a rule, the assistant, the six areas (Home, Pages, Databases, Knowledge, Agents, Work), then the footer (Show sidebar while the sidebar is hidden, Theme, Settings). The rail owns the global New launcher.
- Geometry: `rail-w` (54px) wide on `surface-frame`, a step darker than the sidebar's `surface-navigation`; 16px 8px 12px padding, 8px gaps, `z-index: 21`. Buttons are 36px squares on `r-lg` in `n-600`; area and assistant glyphs 20px, Search, Show sidebar and Settings 19px, Theme 18px.
- Resting buttons are transparent. Hover washes `n-200` at 55% with `n-900` ink on `motion-hover`; pressed gives to `scale: .92` on `motion-pop`. Focus is a 2px `cortex-500` outline, offset 2px.
- Selected: the current area's button carries `data-active` and `aria-pressed`, filled `n-200` in `text-primary`. Settings, while it is the page, takes the same fill through `aria-current="page"`, and no area is lit then or while the assistant fills the canvas.
- The assistant button is synapse (`text-ai`); while the floating conversation is expanded, or docked, it fills `surface-ai`. It never lights an area.
- Every button has a `Tooltip` naming it, with its command's keys where one exists (`palette.open`, `create.launcher`, `assistant.toggle`, `go.<destination>`, `go.settings`), and an explicit `tabIndex={0}` so WebKit keeps it in the Tab order.
- Show sidebar appears only while the sidebar is folded or stepped down to the rail, fading in on `motion-enter` (`m71-rail-arrive`); below 1048px it opens the sidebar as a drawer beside the rail, never over it.
- Theme cycles system, light, dark; its keyed glyph (`monitor`, `sun`, `moon`) turns into place, and the new palette spreads out from the button.
- This card is a composition of `src/app/AppRail.tsx`'s markup and `.m71-*` classes from `src/app/shell.css`, with live `Icon` and `Tooltip`, because the component reads app state.
