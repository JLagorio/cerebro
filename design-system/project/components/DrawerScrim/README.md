# DrawerScrim

The transparent cover beside a drawer: a press on what the drawer covers, or Escape, closes it.

- Use it when a panel the layout has no room for opens as a drawer over the content beside it: a page's folded side or Pages panel, the sidebar behind its rail, the conversation's details rail.
- Mount it beside the drawer and under it. `className` positions it: the box it covers (`absolute inset-0` in a page body, `fixed inset-0` for the sidebar) and a `z-index` below the drawer's.
- Props: `onDismiss` (closes the drawer only, never the stored open flag of a folded panel), `label` (what a press closes, "Close the panel"), `className`, `testId`, `modal` (default `true`; `false` lets the page keep its letter keys while the drawer is open).
- It is transparent on purpose: no fill, no border, `cursor-default`. The drawer's own `shadow-lg` says it floats; a tint would say "modal", and nothing is waiting on an answer.
- Mark the drawer `data-overlay` with `tabIndex={-1}`, and call `useDrawerFocus(open)` on it so focus moves in on open, off the toggle and its tooltip.
- Escape closes it when it owns the key in `layers.ts` (CV-47). A typing field inside the drawer has it first: the field is blurred so its value commits, and the next Escape closes the drawer.
- Escape hands focus back to the toggle that opened it; a press does not, because the pointer went somewhere on purpose.
- A press on it while a menu or list is open over the drawer closes only that surface.
- It is out of the tab order: Escape is the keyboard's way out.
